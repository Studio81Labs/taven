import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { OrdersService } from "../src/modules/orders/orders.service";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PersistenceFactory,
  testTimes,
  type PersistenceFoundation,
  type ProductionReservationFixture,
} from "./support/persistence-factory";

const databaseUrl = process.env.DATABASE_URL;
const testScope = `orders-${randomUUID()}`;
let pool: Pool;
let prisma: PrismaService;
let orders: OrdersService;

type FulfilmentFixture = {
  foundation: PersistenceFoundation;
  productions: ProductionReservationFixture[];
};

async function preparePaidOrder(
  name: string,
  parcelCount = 1,
  paymentScheduleKind: "FULL" | "DEPOSIT_BALANCE" = "FULL",
  parcelQuantities?: number[],
): Promise<FulfilmentFixture> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    const fixtures = new PersistenceFactory(client, `${testScope}:${name}`);
    const foundation = await fixtures.createFoundation(
      name,
      {},
      undefined,
      undefined,
      undefined,
      parcelQuantities?.length ?? parcelCount,
      parcelQuantities?.map((quantity) => ({ quantity })),
      "QUOTED",
      undefined,
      {},
      paymentScheduleKind === "DEPOSIT_BALANCE" ? "INDIVIDUAL" : "AUTOMATIC",
      true,
      true,
      true,
      paymentScheduleKind,
    );
    const productions: ProductionReservationFixture[] = [];
    for (const [index] of foundation.fulfilmentSlotIds.entries()) {
      productions.push(
        await fixtures.planProduction(
          foundation,
          `${name}:production:${index}`,
          {
            startsAt: new Date(
              testTimes.capacityStart.getTime() + index * 7_200_000,
            ),
            endsAt: new Date(
              testTimes.capacityEnd.getTime() + index * 7_200_000,
            ),
          },
          60,
          60,
          1,
          index,
        ),
      );
    }
    await fixtures.createResourcePlan(
      foundation,
      productions,
      new Date(Date.now() + 60 * 60 * 1_000),
      new Date(),
    );
    await client.query(
      "UPDATE inventories SET remaining_milligrams = 1000 WHERE id = $1",
      [foundation.inventoryId],
    );
    const reserved = await client.query<{
      phase_reservation_set_id: string;
    }>("SELECT * FROM taven_create_phase_reservation($1, $2, $3)", [
      foundation.nodeId,
      foundation.phaseResourcePlanId,
      `fulfilment-${testScope}-${name}`,
    ]);
    const reservationSetId = reserved.rows[0]?.phase_reservation_set_id;
    if (!reservationSetId)
      throw new Error("fixture reservation was not created");
    for (const production of productions) {
      const row = await client.query<{ id: string }>(
        `SELECT id FROM production_reservations
         WHERE phase_reservation_set_id = $1
           AND phase_resource_plan_job_id = $2`,
        [reservationSetId, production.phaseResourcePlanJobId],
      );
      const productionReservationId = row.rows[0]?.id;
      if (!productionReservationId) {
        throw new Error("fixture production reservation was not created");
      }
      await client.query(
        "UPDATE inventory_reservations SET status = 'HELD' WHERE production_reservation_id = $1",
        [productionReservationId],
      );
      await client.query(
        "UPDATE capacity_reservations SET status = 'HELD' WHERE production_reservation_id = $1",
        [productionReservationId],
      );
      await fixtures.createJob(foundation, production);
      await client.query(
        `UPDATE production_reservations
         SET status = 'HELD', job_id = $2
         WHERE id = $1`,
        [productionReservationId, production.jobId],
      );
    }
    await client.query(
      "UPDATE phase_reservation_sets SET status = 'HELD' WHERE id = $1",
      [reservationSetId],
    );
    await fixtures.activatePayment(foundation);
    await client.query("COMMIT");
    return { foundation, productions };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function makeGcodeReady(jobId: string): Promise<void> {
  await pool.query(
    `INSERT INTO slice_results
       (id, kind, cache_key, model_geometry_id, print_config_revision_id,
        machine_profile_id, machine_calibration_id, arrangement_revision_id,
        package_quantity, package_plate_count, parts_per_plate,
        artifact_object_key, artifact_hash, estimated_print_seconds,
        estimated_material_milligrams, slicer_engine, slicer_version)
     SELECT gen_random_uuid(), 'PRODUCTION', 'fulfilment-gcode:' || job.id::text,
            candidate.model_geometry_id, production.print_config_revision_id,
            production.machine_profile_id, production.machine_calibration_id,
            candidate.arrangement_revision_id, candidate.quantity,
            ceil(candidate.quantity::numeric / candidate.parts_per_plate::numeric)::integer,
            occupancy.parts_per_plate,
            'gcode/' || job.id::text || '/toolpaths.gcode.3mf', repeat('f', 64),
            production.required_machine_seconds,
            production.required_material_milligrams,
            occupancy.slicer_engine, occupancy.slicer_version
     FROM jobs job
     JOIN production_reservations production ON production.job_id = job.id
     JOIN phase_resource_plan_jobs plan_job
       ON plan_job.id = production.phase_resource_plan_job_id
      AND plan_job.node_id = production.node_id
     JOIN candidate_resource_estimates candidate
       ON candidate.id = plan_job.candidate_resource_estimate_id
      AND candidate.node_id = plan_job.node_id
     JOIN slice_results occupancy
       ON occupancy.id = production.occupancy_slice_result_id
     WHERE job.id = $1 AND job.status = 'ACCEPTED'
     ON CONFLICT (cache_key) DO NOTHING`,
    [jobId],
  );
  await pool.query(
    `UPDATE production_reservations production
     SET slice_result_id = slice.id
     FROM slice_results slice
     WHERE production.job_id = $1
       AND slice.cache_key = 'fulfilment-gcode:' || $1::text`,
    [jobId],
  );
  await pool.query(
    `UPDATE jobs job
     SET status = 'GCODE_READY', gcode_ready_at = clock_timestamp(),
         production_slice_result_id = production.slice_result_id,
         production_artifact_hash = slice.artifact_hash,
         updated_at = clock_timestamp()
     FROM production_reservations production
     JOIN slice_results slice ON slice.id = production.slice_result_id
     WHERE job.id = $1 AND production.job_id = job.id`,
    [jobId],
  );
}

async function createFreshReplacementCandidate(
  fixture: FulfilmentFixture,
  index: number,
): Promise<string> {
  const source = await prisma.candidateResourceEstimate.findUniqueOrThrow({
    where: { id: fixture.productions[index]!.candidateResourceEstimateId },
    include: { capacityIntervals: { orderBy: { intervalIndex: "asc" } } },
  });
  const observed = await pool.query<{ observed_at: Date }>(
    "SELECT clock_timestamp() AS observed_at",
  );
  const calculatedAt = observed.rows[0]?.observed_at;
  if (!calculatedAt) throw new Error("database clock is unavailable");
  const candidateId = randomUUID();
  const startsAt = new Date(calculatedAt.getTime() + 60 * 60 * 1_000);
  const intervals = source.capacityIntervals.map((interval, intervalIndex) => {
    const duration = interval.endsAt.getTime() - interval.startsAt.getTime();
    const intervalStartsAt = new Date(
      startsAt.getTime() + intervalIndex * (duration + 60_000),
    );
    return {
      id: randomUUID(),
      intervalIndex,
      startsAt: intervalStartsAt,
      endsAt: new Date(intervalStartsAt.getTime() + duration),
    };
  });
  await prisma.candidateResourceEstimate.create({
    data: {
      id: candidateId,
      nodeId: source.nodeId,
      estimateKey: `replacement-candidate:${candidateId}`,
      modelGeometryId: source.modelGeometryId,
      primarySliceResultId: source.primarySliceResultId,
      tailSliceResultId: source.tailSliceResultId,
      printConfigRevisionId: source.printConfigRevisionId,
      machineProfileId: source.machineProfileId,
      machineCalibrationId: source.machineCalibrationId,
      machineId: source.machineId,
      inventoryId: source.inventoryId,
      shipmentPlanId: source.shipmentPlanId,
      arrangementRevisionId: source.arrangementRevisionId,
      quantity: source.quantity,
      partsPerPlate: source.partsPerPlate,
      requiredMaterialMilligrams: source.requiredMaterialMilligrams,
      requiredMachineSeconds: source.requiredMachineSeconds,
      resourceSnapshot: source.resourceSnapshot as Prisma.InputJsonObject,
      calculatedAt,
      expiresAt: new Date(calculatedAt.getTime() + 4 * 60 * 60 * 1_000),
      capacityIntervals: { create: intervals },
    },
  });
  return candidateId;
}

async function advanceThroughQc(
  fixture: FulfilmentFixture,
  index: number,
  photoAssetId?: string,
): Promise<void> {
  const jobId = fixture.productions[index]!.jobId;
  const orderId = fixture.foundation.orderId;
  await orders.acceptJob(orderId, jobId, `accept-${index}-key`);
  await makeGcodeReady(jobId);
  await orders.startPrinting(orderId, jobId, `printing-${index}-key`);
  await orders.finishPrinting(
    orderId,
    jobId,
    { actualMaterialMilligrams: "50" },
    `printed-${index}-key`,
  );
  await orders.submitQc(
    orderId,
    jobId,
    photoAssetId
      ? { photoAssetId }
      : { omissionReason: "v0 operator visual inspection" },
    `qc-submit-${index}-key`,
  );
  await orders.approveQc(orderId, jobId, `qc-approve-${index}-key`);
}

async function labelAndPack(
  fixture: FulfilmentFixture,
  index: number,
): Promise<void> {
  const orderId = fixture.foundation.orderId;
  const shipmentId = fixture.foundation.shipmentIds[index]!;
  const jobId = fixture.productions[index]!.jobId;
  await orders.labelShipment(
    orderId,
    shipmentId,
    {
      carrier: "test-carrier",
      providerShipmentId: `provider-shipment-${shipmentId}`,
      carrierLabelId: `label-${shipmentId}`,
      trackingCode: `tracking-${shipmentId}`,
    },
    `label-${index}-key`,
  );
  await orders.packJob(orderId, jobId, { shipmentId }, `pack-${index}-key`);
}

async function handoff(
  fixture: FulfilmentFixture,
  index: number,
): Promise<void> {
  const shipmentId = fixture.foundation.shipmentIds[index]!;
  await orders.handoffShipment(
    fixture.foundation.orderId,
    shipmentId,
    {
      providerEventId: `handoff-${shipmentId}`,
      providerTransactionId: `handoff-tx-${shipmentId}`,
      occurredAt: new Date().toISOString(),
    },
    `handoff-${index}-key`,
  );
}

async function handoffReplacement(
  orderId: string,
  jobId: string,
  shipmentId: string,
  prefix: string,
): Promise<void> {
  await orders.acceptJob(orderId, jobId, `${prefix}-accept`);
  await makeGcodeReady(jobId);
  await orders.startPrinting(orderId, jobId, `${prefix}-printing`);
  await orders.finishPrinting(
    orderId,
    jobId,
    { actualMaterialMilligrams: "50" },
    `${prefix}-printed`,
  );
  await orders.submitQc(
    orderId,
    jobId,
    { omissionReason: "v0 replacement inspection" },
    `${prefix}-qc`,
  );
  await orders.approveQc(orderId, jobId, `${prefix}-approved`);
  await orders.labelShipment(
    orderId,
    shipmentId,
    {
      carrier: "test-carrier",
      providerShipmentId: `provider-shipment-${shipmentId}`,
      carrierLabelId: `label-${shipmentId}`,
      trackingCode: `tracking-${shipmentId}`,
    },
    `${prefix}-label`,
  );
  await orders.packJob(orderId, jobId, { shipmentId }, `${prefix}-pack`);
  await orders.handoffShipment(
    orderId,
    shipmentId,
    {
      providerEventId: `handoff-${shipmentId}`,
      providerTransactionId: `handoff-tx-${shipmentId}`,
      occurredAt: new Date().toISOString(),
    },
    `${prefix}-handoff`,
  );
  await orders.applyShipmentEvent(
    orderId,
    shipmentId,
    {
      kind: "TRANSIT_SCAN",
      providerEventId: `transit-${shipmentId}`,
      providerTransactionId: `transit-tx-${shipmentId}`,
      occurredAt: new Date().toISOString(),
    },
    `${prefix}-transit`,
  );
}

async function carrierEvent(
  fixture: FulfilmentFixture,
  index: number,
  kind: "TRANSIT_SCAN" | "DELIVERY_SCAN" | "LOST" | "RETURNED" | "RECOVERED",
  suffix = kind.toLowerCase(),
) {
  const shipmentId = fixture.foundation.shipmentIds[index]!;
  return orders.applyShipmentEvent(
    fixture.foundation.orderId,
    shipmentId,
    {
      kind,
      providerEventId: `${suffix}-${shipmentId}`,
      providerTransactionId: `${suffix}-tx-${shipmentId}`,
      occurredAt: new Date().toISOString(),
    },
    `${suffix}-${index}-key`,
  );
}

async function succeedRefund(
  refundId: string,
  providerEventSuffix = "",
): Promise<void> {
  await pool.query(
    `SELECT taven_apply_checkout_refund_success(
       $1::uuid, $2, $3, clock_timestamp(), '{}'::jsonb
     )`,
    [
      refundId,
      `provider-refund-${refundId}`,
      `refund-success${providerEventSuffix}-${refundId}`,
    ],
  );
}

async function failRefund(refundId: string): Promise<void> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    const fixtures = new PersistenceFactory(
      client,
      `${testScope}:refund-failure:${refundId}`,
    );
    await client.query("SELECT taven_claim_refund_dispatch($1)", [refundId]);
    const failedAt = new Date();
    const providerRefundId = `provider-refund-failed-${refundId}`;
    const providerEventId = `refund-failed-${refundId}`;
    await fixtures.persistRefundProviderEvent(
      refundId,
      "REFUND_FAILED",
      providerRefundId,
      failedAt,
      providerEventId,
    );
    const providerEvent = await client.query<{ id: string }>(
      `SELECT id FROM payment_provider_events
       WHERE provider_event_id = $1`,
      [providerEventId],
    );
    if (!providerEvent.rows[0]?.id) {
      throw new Error("refund failure provider event was not created");
    }
    await client.query(
      `UPDATE refund_transactions
       SET status = 'FAILED', provider_refund_id = $2,
           provider_result_event_id = $3, updated_at = $4
       WHERE id = $1`,
      [refundId, providerRefundId, providerEvent.rows[0].id, failedAt],
    );
    await client.query(
      `UPDATE payments
       SET status = 'CAPTURED', updated_at = $2
       WHERE id = (
         SELECT payment_id FROM refund_transactions WHERE id = $1
       )`,
      [refundId, failedAt],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function reverseSucceededRefund(refundId: string): Promise<void> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    const fixtures = new PersistenceFactory(
      client,
      `${testScope}:refund-reversal:${refundId}`,
    );
    const refund = await client.query<{ provider_refund_id: string | null }>(
      `SELECT provider_refund_id
       FROM refund_transactions
       WHERE id = $1 AND status = 'SUCCEEDED'`,
      [refundId],
    );
    const providerRefundId = refund.rows[0]?.provider_refund_id;
    if (!providerRefundId) {
      throw new Error("successful refund has no provider identity");
    }
    const failedAt = new Date();
    const providerEventId = `refund-reversed-${refundId}`;
    await fixtures.persistRefundProviderEvent(
      refundId,
      "REFUND_FAILED",
      providerRefundId,
      failedAt,
      providerEventId,
    );
    const providerEvent = await client.query<{ id: string }>(
      `SELECT id FROM payment_provider_events
       WHERE provider_event_id = $1`,
      [providerEventId],
    );
    if (!providerEvent.rows[0]?.id) {
      throw new Error("refund reversal provider event was not created");
    }
    await client.query(
      `UPDATE refund_transactions
       SET status = 'FAILED', provider_result_event_id = $2,
           completed_at = NULL, updated_at = $3
       WHERE id = $1`,
      [refundId, providerEvent.rows[0].id, failedAt],
    );
    await client.query(
      `UPDATE payments payment
       SET status = CASE
             WHEN totals.succeeded_minor = 0 THEN 'CAPTURED'::payment_status
             WHEN totals.succeeded_minor = payment.captured_amount_minor
               THEN 'REFUNDED'::payment_status
             ELSE 'PARTIALLY_REFUNDED'::payment_status
           END,
           updated_at = $2
       FROM (
         SELECT candidate.payment_id,
                coalesce(sum(candidate.amount_minor) FILTER (
                  WHERE candidate.status = 'SUCCEEDED'
                ), 0) AS succeeded_minor
         FROM refund_transactions candidate
         WHERE candidate.payment_id = (
           SELECT payment_id FROM refund_transactions WHERE id = $1
         )
         GROUP BY candidate.payment_id
       ) totals
       WHERE payment.id = totals.payment_id`,
      [refundId, failedAt],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function markSlotPriceComponentExpress(slotId: string): Promise<void> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const updated = await client.query(
      `WITH target_snapshot AS (
         SELECT component.price_snapshot_id
         FROM price_snapshot_components component
         JOIN price_component_fulfilment_allocations allocation
           ON allocation.price_snapshot_component_id = component.id
         WHERE allocation.fulfilment_slot_id = $1
         LIMIT 1
       ), selected AS (
         SELECT component.id
         FROM price_snapshot_components component
         JOIN target_snapshot
           ON target_snapshot.price_snapshot_id = component.price_snapshot_id
         WHERE component.kind = 'ORDER_MIN_PRINT'
         LIMIT 1
       ), moved AS (
         UPDATE price_component_fulfilment_allocations allocation
         SET fulfilment_slot_id = $1
         FROM selected
         WHERE allocation.price_snapshot_component_id = selected.id
         RETURNING allocation.price_snapshot_component_id
       )
       UPDATE price_snapshot_components component
       SET kind = 'EXPRESS'
       FROM moved
       WHERE component.id = moved.price_snapshot_component_id`,
      [slotId],
    );
    if (updated.rowCount !== 1) {
      throw new Error("fixture express component was not configured");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!databaseUrl)("v0 fulfilment operator commands", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    prisma = new PrismaService();
    await prisma.onModuleInit();
    orders = new OrdersService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await pool.end();
  });

  it("freezes the platform-owned payout tuple and replays acceptance", async () => {
    const fixture = await preparePaidOrder("acceptance");
    const { orderId } = fixture.foundation;
    const jobId = fixture.productions[0]!.jobId;

    const first = await orders.acceptJob(orderId, jobId, "stable-acceptance");
    const replay = await orders.acceptJob(orderId, jobId, "stable-acceptance");

    expect(replay).toEqual(first);
    expect(first.result).toMatchObject({
      id: jobId,
      payoutAmount: "0",
    });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.payoutAmount).toBe(0n);
    expect(job.payoutCurrency).toMatch(/^[A-Z]{3}$/);
    await expect(
      prisma.auditEvent.count({
        where: {
          orderId,
          actorKind: "OPERATOR",
          idempotencyKey: "stable-acceptance",
          eventType: "fulfilment.command_completed",
        },
      }),
    ).resolves.toBe(1);
  });

  it("creates a replacement only after acquiring a fresh reservation", async () => {
    const fixture = await preparePaidOrder("replacement");
    const { orderId } = fixture.foundation;
    const sourceJobId = fixture.productions[0]!.jobId;
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    const sourceAssignment =
      await prisma.jobShipmentAssignment.findUniqueOrThrow({
        where: { jobId: sourceJobId },
      });

    const failure = await orders.failJob(
      orderId,
      sourceJobId,
      {
        stage: "PACKING",
        reason: "packed part failed final dimensional inspection",
        recovery: "REPLACE",
      },
      "replacement-failure",
    );
    await expect(
      orders.createReplacement(
        orderId,
        sourceJobId,
        {
          candidateResourceEstimateId:
            fixture.productions[0]!.candidateResourceEstimateId,
        },
        "replacement-stale-candidate",
      ),
    ).rejects.toThrow(
      "Replacement requires a freshly calculated compatible candidate",
    );
    const candidateResourceEstimateId = await createFreshReplacementCandidate(
      fixture,
      0,
    );
    const replacement = await orders.createReplacement(
      orderId,
      sourceJobId,
      { candidateResourceEstimateId },
      "replacement-create",
    );

    expect(failure.status).toBe("FAILED");
    expect(replacement.status).toBe("REPLACEMENT_CREATED");
    const jobs = await prisma.job.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
    });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.status).toBe("FAILED");
    expect(jobs[1]).toMatchObject({
      status: "CREATED",
      replacesJobId: sourceJobId,
    });
    const reservations = await prisma.productionReservation.findMany({
      where: { jobId: { in: jobs.map(({ id }) => id) } },
      include: {
        phaseResourcePlanJob: {
          select: { candidateResourceEstimateId: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(reservations).toHaveLength(2);
    expect(reservations[0]?.status).toBe("CONSUMED");
    expect(reservations[1]?.status).toBe("HELD");
    expect(reservations[1]?.id).not.toBe(reservations[0]?.id);
    expect(
      reservations[1]?.phaseResourcePlanJob.candidateResourceEstimateId,
    ).toBe(candidateResourceEstimateId);

    const replacementJobId = jobs[1]!.id;
    await orders.acceptJob(orderId, replacementJobId, "replacement-job-accept");
    await makeGcodeReady(replacementJobId);
    await orders.startPrinting(
      orderId,
      replacementJobId,
      "replacement-job-printing",
    );
    await orders.finishPrinting(
      orderId,
      replacementJobId,
      { actualMaterialMilligrams: "50" },
      "replacement-job-printed",
    );
    await orders.submitQc(
      orderId,
      replacementJobId,
      { omissionReason: "replacement passed v0 visual inspection" },
      "replacement-job-qc-submit",
    );
    await orders.approveQc(
      orderId,
      replacementJobId,
      "replacement-job-qc-approve",
    );
    await orders.packJob(
      orderId,
      replacementJobId,
      { shipmentId: fixture.foundation.shipmentId },
      "replacement-job-pack",
    );
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    await carrierEvent(fixture, 0, "DELIVERY_SCAN");
    await orders.completeOrder(orderId, "replacement-order-complete");

    await expect(
      prisma.job.findUniqueOrThrow({ where: { id: replacementJobId } }),
    ).resolves.toMatchObject({ status: "SETTLED" });
    await expect(
      prisma.job.findUniqueOrThrow({ where: { id: sourceJobId } }),
    ).resolves.toMatchObject({ status: "FAILED" });
    await expect(
      prisma.jobShipmentAssignment.findUniqueOrThrow({
        where: { jobId: sourceJobId },
      }),
    ).resolves.toEqual(sourceAssignment);
    await expect(
      prisma.productionReservation.findFirstOrThrow({
        where: { jobId: replacementJobId },
        include: { phaseReservationSet: true },
      }),
    ).resolves.toMatchObject({
      status: "CONSUMED",
      phaseReservationSet: { status: "SETTLED" },
    });
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    ).resolves.toMatchObject({ status: "COMPLETED" });
  }, 10_000);

  it("closes an expired replacement request into refund recovery", async () => {
    const fixture = await preparePaidOrder("replacement-expired");
    const { orderId } = fixture.foundation;
    const sourceJobId = fixture.productions[0]!.jobId;
    await orders.acceptJob(orderId, sourceJobId, "replacement-expired-accept");
    await orders.failJob(
      orderId,
      sourceJobId,
      {
        stage: "PREPARATION",
        reason: "source material cannot be prepared",
        recovery: "REPLACE",
      },
      "replacement-expired-failure",
    );
    await expect(
      orders.expireReplacement(
        orderId,
        sourceJobId,
        {},
        "replacement-not-expired",
      ),
    ).rejects.toThrow("Replacement request has not expired");
    await prisma.replacementRequest.update({
      where: { sourceJobId },
      data: { deadlineAt: new Date(0) },
    });

    const expired = await orders.createReplacement(
      orderId,
      sourceJobId,
      {
        candidateResourceEstimateId:
          fixture.productions[0]!.candidateResourceEstimateId,
      },
      "replacement-expired-refund",
    );
    const replay = await orders.createReplacement(
      orderId,
      sourceJobId,
      {
        candidateResourceEstimateId:
          fixture.productions[0]!.candidateResourceEstimateId,
      },
      "replacement-expired-refund",
    );
    expect(replay).toEqual(expired);
    expect(expired.status).toBe("REPLACEMENT_EXPIRED_REFUND_PENDING");
    expect(expired.result.refundIds).toHaveLength(1);
    await expect(
      prisma.replacementRequest.findUniqueOrThrow({ where: { sourceJobId } }),
    ).resolves.toMatchObject({
      status: "RESOLVED",
      replacementJobId: null,
      phaseReservationSetId: null,
    });
    await expect(prisma.job.count({ where: { orderId } })).resolves.toBe(1);
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("waits for provider void before refunding an expired labelled replacement scope", async () => {
    const fixture = await preparePaidOrder("replacement-expired-labelled");
    const { orderId, shipmentId } = fixture.foundation;
    const sourceJobId = fixture.productions[0]!.jobId;
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await orders.failJob(
      orderId,
      sourceJobId,
      {
        stage: "PACKING",
        reason: "packed part failed final dimensional inspection",
        recovery: "REPLACE",
      },
      "replacement-expired-labelled-failure",
    );
    await prisma.replacementRequest.update({
      where: { sourceJobId },
      data: { deadlineAt: new Date(0) },
    });

    const expired = await orders.createReplacement(
      orderId,
      sourceJobId,
      {
        candidateResourceEstimateId:
          fixture.productions[0]!.candidateResourceEstimateId,
      },
      "replacement-expired-labelled-refund",
    );
    expect(expired.status).toBe(
      "REPLACEMENT_EXPIRY_LABEL_CANCELLATION_PENDING",
    );
    await expect(
      prisma.replacementRequest.findUniqueOrThrow({ where: { sourceJobId } }),
    ).resolves.toMatchObject({ status: "REFUND_REQUIRED" });

    const voided = await orders.confirmLabelVoid(
      orderId,
      shipmentId,
      {
        providerEventId: `expired-replacement-void-${shipmentId}`,
        providerTransactionId: `expired-replacement-void-tx-${shipmentId}`,
        occurredAt: new Date().toISOString(),
      },
      "replacement-expired-labelled-void",
    );
    expect(voided.status).toBe("LABEL_VOID_CONFIRMED_AND_ORDER_CANCELLED");
    expect(voided.result.refundIds).toHaveLength(1);
    await expect(
      prisma.replacementRequest.findUniqueOrThrow({ where: { sourceJobId } }),
    ).resolves.toMatchObject({ status: "RESOLVED" });
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("records a QC rejection without invalid failure metadata", async () => {
    const fixture = await preparePaidOrder("qc-rejection");
    const { orderId } = fixture.foundation;
    const jobId = fixture.productions[0]!.jobId;
    await orders.acceptJob(orderId, jobId, "qc-rejection-accept");
    await makeGcodeReady(jobId);
    await orders.startPrinting(orderId, jobId, "qc-rejection-printing");
    await orders.finishPrinting(
      orderId,
      jobId,
      { actualMaterialMilligrams: "50" },
      "qc-rejection-printed",
    );
    await orders.submitQc(
      orderId,
      jobId,
      { omissionReason: "dimensional inspection evidence" },
      "qc-rejection-submit",
    );

    const rejected = await orders.failJob(
      orderId,
      jobId,
      {
        stage: "POST_PRINT",
        reason: "dimensional inspection failed",
        recovery: "REPLACE",
      },
      "qc-rejection-fail",
    );

    expect(rejected.status).toBe("QC_REJECTED");
    await expect(
      prisma.job.findUniqueOrThrow({ where: { id: jobId } }),
    ).resolves.toMatchObject({
      status: "QC_REJECTED",
      failureStage: null,
      failureReason: null,
    });
  });

  it("enforces parcel barriers and completes a delivered order once", async () => {
    const fixture = await preparePaidOrder("delivery");
    const photoAssetId = randomUUID();
    const originalPhotoDeadline = new Date(Date.now() + 60 * 60 * 1_000);
    await prisma.photoAsset.create({
      data: {
        id: photoAssetId,
        kind: "QC",
        scopeKind: "JOB",
        scopeId: fixture.productions[0]!.jobId,
        storageObjectKey: `qc/${photoAssetId}`,
        contentHash: "b".repeat(64),
        mediaType: "image/jpeg",
        sizeBytes: 1n,
        uploadedAt: new Date(),
        photoDeleteAfter: originalPhotoDeadline,
        retentionHold: "ACTIVE_ORDER",
      },
    });
    await advanceThroughQc(fixture, 0, photoAssetId);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    const deliveredAt = new Date().toISOString();
    const delivered = await orders.applyShipmentEvent(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      {
        kind: "DELIVERY_SCAN",
        providerEventId: `delivery_scan-${fixture.foundation.shipmentId}`,
        providerTransactionId: `delivery_scan-tx-${fixture.foundation.shipmentId}`,
        occurredAt: deliveredAt,
      },
      "delivery-first-key",
    );
    const duplicate = await orders.applyShipmentEvent(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      {
        kind: "DELIVERY_SCAN",
        providerEventId: `delivery_scan-${fixture.foundation.shipmentId}`,
        providerTransactionId: `delivery_scan-tx-${fixture.foundation.shipmentId}`,
        occurredAt: deliveredAt,
      },
      "delivery-duplicate-key",
    );
    await orders.completeOrder(
      fixture.foundation.orderId,
      "complete-delivery-key",
    );

    expect(delivered.status).toBe("SHIPMENT_EVENT_APPLIED");
    expect(duplicate.status).toBe("SHIPMENT_EVENT_ALREADY_APPLIED");
    const projection = await orders.getFulfilment(fixture.foundation.orderId);
    expect(projection.orderStatus).toBe("COMPLETED");
    expect(projection.phase).toMatchObject({ status: "COMPLETED" });
    expect(projection.jobs).toEqual([
      expect.objectContaining({ status: "SETTLED" }),
    ]);
    await expect(
      prisma.photoAsset.findUniqueOrThrow({ where: { id: photoAssetId } }),
    ).resolves.toMatchObject({ retentionHold: "NONE" });
    const releasedPhoto = await prisma.photoAsset.findUniqueOrThrow({
      where: { id: photoAssetId },
    });
    expect(releasedPhoto.photoDeleteAfter.getTime()).toBeGreaterThan(
      originalPhotoDeadline.getTime(),
    );
  });

  it("rejects a clean quality Claim atomically and releases its evidence", async () => {
    const fixture = await preparePaidOrder("post-delivery-claim-retention");
    const photoAssetId = randomUUID();
    await prisma.photoAsset.create({
      data: {
        id: photoAssetId,
        kind: "QC",
        scopeKind: "JOB",
        scopeId: fixture.productions[0]!.jobId,
        storageObjectKey: `qc/${photoAssetId}`,
        contentHash: "c".repeat(64),
        mediaType: "image/jpeg",
        sizeBytes: 1n,
        uploadedAt: new Date(),
        photoDeleteAfter: new Date(Date.now() + 60 * 60 * 1_000),
        retentionHold: "ACTIVE_ORDER",
      },
    });
    await advanceThroughQc(fixture, 0, photoAssetId);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    await carrierEvent(fixture, 0, "DELIVERY_SCAN");
    await orders.completeOrder(
      fixture.foundation.orderId,
      "post-delivery-claim-retention-complete",
    );
    await expect(
      prisma.modelFile.findUniqueOrThrow({
        where: { id: fixture.foundation.modelFileId },
      }),
    ).resolves.toMatchObject({ retentionHold: "NONE" });
    await expect(
      prisma.photoAsset.findUniqueOrThrow({ where: { id: photoAssetId } }),
    ).resolves.toMatchObject({ retentionHold: "NONE" });

    const opened = await orders.createClaim(
      fixture.foundation.orderId,
      {
        origin: "POST_DELIVERY_QUALITY",
        reason: "retain the exact production evidence during investigation",
        fulfilmentSlotIds: [fixture.foundation.fulfilmentSlotIds[0]!],
        incidentShipmentId: fixture.foundation.shipmentId,
      },
      "post-delivery-claim-retention-open",
    );
    const claimId = opened.result.claimId as string;
    await expect(
      prisma.modelFile.findUniqueOrThrow({
        where: { id: fixture.foundation.modelFileId },
      }),
    ).resolves.toMatchObject({ retentionHold: "ACTIVE_CLAIM" });
    await expect(
      prisma.photoAsset.findUniqueOrThrow({ where: { id: photoAssetId } }),
    ).resolves.toMatchObject({ retentionHold: "ACTIVE_CLAIM" });
    await expect(
      prisma.modelFile.update({
        where: { id: fixture.foundation.modelFileId },
        data: { retentionHold: "NONE" },
      }),
    ).rejects.toThrow("must remain retained while its Claim is active");
    await expect(
      prisma.photoAsset.update({
        where: { id: photoAssetId },
        data: { retentionHold: "NONE" },
      }),
    ).rejects.toThrow("must remain retained while its Claim is active");

    await expect(
      prisma.claim.update({
        where: { id: claimId },
        data: { status: "RESOLVED_REJECTED", resolvedAt: new Date() },
      }),
    ).rejects.toThrow(
      "Claim rejection must atomically close one clean quality Claim",
    );

    const rejected = await orders.rejectClaim(
      fixture.foundation.orderId,
      claimId,
      { reason: "inspection found no reproducible manufacturing defect" },
      "post-delivery-claim-rejection",
    );
    const replay = await orders.rejectClaim(
      fixture.foundation.orderId,
      claimId,
      { reason: "inspection found no reproducible manufacturing defect" },
      "post-delivery-claim-rejection",
    );
    expect(replay).toEqual(rejected);
    expect(rejected.status).toBe("CLAIM_REJECTED");
    await expect(
      prisma.claim.findUniqueOrThrow({
        where: { id: claimId },
        include: { resolutions: true },
      }),
    ).resolves.toMatchObject({
      status: "RESOLVED_REJECTED",
      resolutions: [expect.objectContaining({ status: "REJECTED" })],
    });
    await expect(
      prisma.modelFile.findUniqueOrThrow({
        where: { id: fixture.foundation.modelFileId },
      }),
    ).resolves.toMatchObject({ retentionHold: "NONE" });
    await expect(
      prisma.photoAsset.findUniqueOrThrow({ where: { id: photoAssetId } }),
    ).resolves.toMatchObject({ retentionHold: "NONE" });
    await expect(
      prisma.claimSlotResolution.update({
        where: {
          claimId_fulfilmentSlotId: {
            claimId,
            fulfilmentSlotId: fixture.foundation.fulfilmentSlotIds[0]!,
          },
        },
        data: { status: "PENDING", resolvedAt: null },
      }),
    ).rejects.toThrow("rejected Claim resolution history is immutable");
  }, 10_000);

  it("withdraws a clean quality Claim atomically and releases its evidence", async () => {
    const fixture = await preparePaidOrder("post-delivery-claim-withdrawal");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    await carrierEvent(fixture, 0, "DELIVERY_SCAN");
    await orders.completeOrder(
      fixture.foundation.orderId,
      "post-delivery-claim-withdrawal-complete",
    );
    const opened = await orders.createClaim(
      fixture.foundation.orderId,
      {
        origin: "POST_DELIVERY_QUALITY",
        reason: "customer reported a surface defect",
        fulfilmentSlotIds: [fixture.foundation.fulfilmentSlotIds[0]!],
      },
      "post-delivery-claim-withdrawal-open",
    );
    const claimId = opened.result.claimId as string;
    await expect(
      prisma.claim.update({
        where: { id: claimId },
        data: { status: "WITHDRAWN", resolvedAt: new Date() },
      }),
    ).rejects.toThrow(
      "Claim withdrawal must atomically close one clean quality Claim",
    );

    const withdrawn = await orders.withdrawClaim(
      fixture.foundation.orderId,
      claimId,
      { reason: "customer confirmed that no remedy is required" },
      "post-delivery-claim-withdrawal",
    );
    const replay = await orders.withdrawClaim(
      fixture.foundation.orderId,
      claimId,
      { reason: "customer confirmed that no remedy is required" },
      "post-delivery-claim-withdrawal",
    );
    expect(replay).toEqual(withdrawn);
    expect(withdrawn.status).toBe("CLAIM_WITHDRAWN");
    await expect(
      prisma.claim.findUniqueOrThrow({
        where: { id: claimId },
        include: { resolutions: true },
      }),
    ).resolves.toMatchObject({
      status: "WITHDRAWN",
      resolutions: [expect.objectContaining({ status: "WITHDRAWN" })],
    });
    await expect(
      prisma.modelFile.findUniqueOrThrow({
        where: { id: fixture.foundation.modelFileId },
      }),
    ).resolves.toMatchObject({ retentionHold: "NONE" });
    await expect(
      prisma.claimSlotResolution.update({
        where: {
          claimId_fulfilmentSlotId: {
            claimId,
            fulfilmentSlotId: fixture.foundation.fulfilmentSlotIds[0]!,
          },
        },
        data: { status: "PENDING", resolvedAt: null },
      }),
    ).rejects.toThrow("withdrawn Claim resolution history is immutable");
  }, 10_000);

  it("settles a later-parcel loss as partial fulfilment without moving the first parcel", async () => {
    const fixture = await preparePaidOrder("partial", 2);
    await advanceThroughQc(fixture, 0);
    await advanceThroughQc(fixture, 1);
    await labelAndPack(fixture, 0);
    await labelAndPack(fixture, 1);
    await handoff(fixture, 0);
    await handoff(fixture, 1);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    await carrierEvent(fixture, 1, "TRANSIT_SCAN");
    await carrierEvent(fixture, 0, "DELIVERY_SCAN");
    await carrierEvent(fixture, 1, "LOST");

    const claim = await prisma.claim.findUniqueOrThrow({
      where: { incidentShipmentId: fixture.foundation.shipmentIds[1]! },
    });
    const pending = await orders.refundClaim(
      fixture.foundation.orderId,
      claim.id,
      "partial-refund-key",
    );
    const refundId = (pending.result.refundIds as string[])[0];
    if (!refundId) throw new Error("claim refund was not created");
    await succeedRefund(refundId);

    const projection = await orders.getFulfilment(fixture.foundation.orderId);
    expect(projection.orderStatus).toBe("PARTIALLY_FULFILLED");
    expect(projection.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "DELIVERED" }),
        expect.objectContaining({ outcome: "CANCELLED_REFUNDED" }),
      ]),
    );
    const shipments = projection.shipments as Array<{ status: string }>;
    expect(shipments.map(({ status }) => status).sort()).toEqual([
      "DELIVERED",
      "LOST",
    ]);
  });

  it("settles a later production failure without cancelling the parcel already in custody", async () => {
    const fixture = await preparePaidOrder("post-handoff-production-refund", 2);
    await advanceThroughQc(fixture, 0);
    await advanceThroughQc(fixture, 1);
    await labelAndPack(fixture, 0);
    await labelAndPack(fixture, 1);
    await handoff(fixture, 0);

    const failed = await orders.failJob(
      fixture.foundation.orderId,
      fixture.productions[1]!.jobId,
      {
        stage: "PACKING",
        reason: "the later parcel failed during packing",
        recovery: "REFUND",
      },
      "post-handoff-production-refund-failure",
    );
    expect(failed.status).toBe("PRODUCTION_FAILURE_LABEL_CANCELLATION_PENDING");
    const shipmentId = fixture.foundation.shipmentIds[1]!;
    const confirmed = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      shipmentId,
      {
        providerEventId: `production-failure-void-${shipmentId}`,
        providerTransactionId: `production-failure-void-tx-${shipmentId}`,
        occurredAt: new Date().toISOString(),
      },
      "post-handoff-production-refund-void",
    );
    const refundId = (confirmed.result.refundIds as string[])[0];
    if (!refundId) throw new Error("production failure refund was not created");
    expect(confirmed.status).toBe(
      "LABEL_VOID_CONFIRMED_PRODUCTION_FAILURE_REFUND",
    );
    await carrierEvent(
      fixture,
      0,
      "TRANSIT_SCAN",
      "post-handoff-production-transit",
    );
    await carrierEvent(
      fixture,
      0,
      "DELIVERY_SCAN",
      "post-handoff-production-delivery",
    );
    await succeedRefund(refundId);

    await expect(
      orders.getFulfilment(fixture.foundation.orderId),
    ).resolves.toMatchObject({
      orderStatus: "PARTIALLY_FULFILLED",
      phase: { status: "PARTIALLY_FULFILLED" },
      jobs: expect.arrayContaining([
        expect.objectContaining({ status: "HANDED_OVER" }),
        expect.objectContaining({ status: "FAILED" }),
      ]),
      shipments: expect.arrayContaining([
        expect.objectContaining({ status: "DELIVERED" }),
        expect.objectContaining({ status: "CANCELLED" }),
      ]),
      slots: expect.arrayContaining([
        expect.objectContaining({ outcome: "DELIVERED" }),
        expect.objectContaining({ outcome: "CANCELLED_REFUNDED" }),
      ]),
    });
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({
      reason: "PRODUCTION_FAILURE",
      status: "SUCCEEDED",
    });
    await expect(
      prisma.replacementRequest.findUniqueOrThrow({
        where: { sourceJobId: fixture.productions[1]!.jobId },
      }),
    ).resolves.toMatchObject({ status: "RESOLVED" });

    await reverseSucceededRefund(refundId);
    await expect(
      orders.getFulfilment(fixture.foundation.orderId),
    ).resolves.toMatchObject({
      orderStatus: "SHIPPED",
      phase: { status: "SHIPPED" },
      slots: expect.arrayContaining([
        expect.objectContaining({ outcome: "DELIVERED" }),
        expect.objectContaining({ outcome: "CANCELLED" }),
      ]),
    });
  });

  it("settles every Job in a failed later parcel without disturbing prior custody", async () => {
    const fixture = await preparePaidOrder(
      "post-handoff-multi-job-refund",
      2,
      "FULL",
      [1, 2],
    );
    await advanceThroughQc(fixture, 0);
    await advanceThroughQc(fixture, 1);
    await advanceThroughQc(fixture, 2);
    await labelAndPack(fixture, 0);
    const laterShipmentId = fixture.foundation.shipmentIds[1]!;
    await orders.labelShipment(
      fixture.foundation.orderId,
      laterShipmentId,
      {
        carrier: "test-carrier",
        providerShipmentId: `provider-shipment-${laterShipmentId}`,
        carrierLabelId: `label-${laterShipmentId}`,
      },
      "multi-job-label",
    );
    for (const index of [1, 2]) {
      await orders.packJob(
        fixture.foundation.orderId,
        fixture.productions[index]!.jobId,
        { shipmentId: laterShipmentId },
        `multi-job-pack-${index}`,
      );
    }
    await handoff(fixture, 0);

    const supersededJobId = fixture.productions[2]!.jobId;
    await orders.failJob(
      fixture.foundation.orderId,
      supersededJobId,
      {
        stage: "PACKING",
        reason: "the second part needs a fresh production attempt",
        recovery: "REPLACE",
      },
      "multi-job-sibling-replace",
    );
    const replacementCandidateId = await createFreshReplacementCandidate(
      fixture,
      2,
    );
    const replacement = await orders.createReplacement(
      fixture.foundation.orderId,
      supersededJobId,
      { candidateResourceEstimateId: replacementCandidateId },
      "multi-job-sibling-create",
    );
    const replacementJobId = replacement.result.replacementJobId as string;
    await orders.acceptJob(
      fixture.foundation.orderId,
      replacementJobId,
      "multi-job-sibling-accept",
    );
    await makeGcodeReady(replacementJobId);
    await orders.startPrinting(
      fixture.foundation.orderId,
      replacementJobId,
      "multi-job-sibling-printing",
    );

    await expect(
      orders.failJob(
        fixture.foundation.orderId,
        fixture.productions[1]!.jobId,
        {
          stage: "PACKING",
          reason: "one part invalidates the complete later parcel",
          recovery: "REFUND",
        },
        "multi-job-failure-missing-consumption",
      ),
    ).rejects.toThrow(
      "printingConsumptions must cover every actively printing Job",
    );
    await expect(
      prisma.job.findUniqueOrThrow({
        where: { id: fixture.productions[1]!.jobId },
      }),
    ).resolves.toMatchObject({ status: "PACKED" });

    await orders.failJob(
      fixture.foundation.orderId,
      fixture.productions[1]!.jobId,
      {
        stage: "PACKING",
        reason: "one part invalidates the complete later parcel",
        recovery: "REFUND",
        printingConsumptions: [
          {
            jobId: replacementJobId,
            actualMaterialMilligrams: "25",
          },
        ],
      },
      "multi-job-failure",
    );
    const confirmed = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      laterShipmentId,
      {
        providerEventId: `multi-job-void-${laterShipmentId}`,
        providerTransactionId: `multi-job-void-tx-${laterShipmentId}`,
        occurredAt: new Date().toISOString(),
      },
      "multi-job-void",
    );
    const refundId = (confirmed.result.refundIds as string[])[0];
    if (!refundId) throw new Error("multi-Job parcel refund was not created");

    await expect(
      prisma.job.findUniqueOrThrow({
        where: { id: replacementJobId },
      }),
    ).resolves.toMatchObject({
      status: "CANCELLED",
      cancellationReason: "PRODUCTION_FAILURE",
    });
    await expect(
      prisma.productionReservation.findFirstOrThrow({
        where: { jobId: replacementJobId },
      }),
    ).resolves.toMatchObject({ status: "CONSUMED" });
    const adjustment = await prisma.priceAdjustment.findFirstOrThrow({
      where: {
        orderId: fixture.foundation.orderId,
        reason: "PRODUCTION_FAILURE",
      },
    });
    const credits = (
      adjustment.allocation as {
        slotCredits: Array<{
          fulfilmentSlotId: string;
          amountMinor: string;
        }>;
      }
    ).slotCredits;
    const laterSlots = await prisma.fulfilmentSlot.findMany({
      where: {
        id: { in: fixture.foundation.fulfilmentSlotIds.slice(1) },
      },
      select: { id: true, outcome: true, settlementAmountMinor: true },
      orderBy: { id: "asc" },
    });
    expect(
      credits.map(({ fulfilmentSlotId }) => fulfilmentSlotId).sort(),
    ).toEqual(
      laterSlots
        .filter(({ settlementAmountMinor }) => settlementAmountMinor > 0n)
        .map(({ id }) => id)
        .sort(),
    );
    expect(laterSlots.map(({ outcome }) => outcome)).toEqual([
      "CANCELLED",
      "CANCELLED",
    ]);
    await expect(
      prisma.shipment.findUniqueOrThrow({
        where: { id: fixture.foundation.shipmentIds[0]! },
      }),
    ).resolves.toMatchObject({ status: "HANDED_OVER" });

    await carrierEvent(fixture, 0, "TRANSIT_SCAN", "multi-job-transit");
    await carrierEvent(fixture, 0, "DELIVERY_SCAN", "multi-job-delivery");
    await succeedRefund(refundId);
    await expect(
      orders.getFulfilment(fixture.foundation.orderId),
    ).resolves.toMatchObject({
      orderStatus: "PARTIALLY_FULFILLED",
      slots: expect.arrayContaining([
        expect.objectContaining({ outcome: "DELIVERED" }),
        expect.objectContaining({ outcome: "CANCELLED_REFUNDED" }),
        expect.objectContaining({ outcome: "CANCELLED_REFUNDED" }),
      ]),
    });
  }, 10_000);

  it("routes a failed Claim reprint back into its Claim refund remedy", async () => {
    const fixture = await preparePaidOrder("failed-claim-reprint-refund");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN", "failed-reprint-transit");
    await carrierEvent(fixture, 0, "LOST", "failed-reprint-loss");
    const claim = await prisma.claim.findUniqueOrThrow({
      where: { incidentShipmentId: fixture.foundation.shipmentId },
    });
    const candidateResourceEstimateId = await createFreshReplacementCandidate(
      fixture,
      0,
    );
    const created = await orders.createClaimReprint(
      fixture.foundation.orderId,
      claim.id,
      {
        replacements: [
          {
            sourceJobId: fixture.productions[0]!.jobId,
            candidateResourceEstimateId,
          },
        ],
      },
      "failed-reprint-create",
    );
    const replacementJobId = (
      created.result.replacementJobs as Array<{ replacementJobId: string }>
    )[0]!.replacementJobId;
    await orders.acceptJob(
      fixture.foundation.orderId,
      replacementJobId,
      "failed-reprint-accept",
    );
    const failed = await orders.failJob(
      fixture.foundation.orderId,
      replacementJobId,
      {
        stage: "PREPARATION",
        reason: "replacement cannot be produced",
        recovery: "REFUND",
      },
      "failed-reprint-failure",
    );
    expect(failed.status).toBe("CLAIM_REPRINT_REFUND_REQUIRED");
    const pending = await orders.refundClaim(
      fixture.foundation.orderId,
      claim.id,
      "failed-reprint-refund",
    );
    const refundId = (pending.result.refundIds as string[])[0];
    if (!refundId) throw new Error("failed reprint refund was not created");
    await succeedRefund(refundId);

    await expect(
      prisma.claim.findUniqueOrThrow({ where: { id: claim.id } }),
    ).resolves.toMatchObject({ status: "RESOLVED_REFUND" });
    await expect(
      prisma.claim.count({ where: { orderId: fixture.foundation.orderId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.shipment.findUniqueOrThrow({
        where: { id: created.result.replacementShipmentId as string },
      }),
    ).resolves.toMatchObject({
      status: "CANCELLED",
      reprintClaimId: claim.id,
    });
  }, 10_000);

  it("reprints a whole LOST parcel with fresh resources and preserves its history", async () => {
    const fixture = await preparePaidOrder("lost-parcel-reprint");
    const sourceJobId = fixture.productions[0]!.jobId;
    const originalShipmentId = fixture.foundation.shipmentId;
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN", "reprint-transit");
    await carrierEvent(fixture, 0, "LOST", "reprint-loss");
    const claim = await prisma.claim.findUniqueOrThrow({
      where: { incidentShipmentId: originalShipmentId },
    });
    const sourceAssignment =
      await prisma.jobShipmentAssignment.findUniqueOrThrow({
        where: { jobId: sourceJobId },
      });
    const candidateResourceEstimateId = await createFreshReplacementCandidate(
      fixture,
      0,
    );

    const created = await orders.createClaimReprint(
      fixture.foundation.orderId,
      claim.id,
      {
        replacements: [{ sourceJobId, candidateResourceEstimateId }],
      },
      "lost-parcel-reprint-create",
    );
    const replacementShipmentId = created.result
      .replacementShipmentId as string;
    const replacementJobs = created.result.replacementJobs as Array<{
      replacementJobId: string;
      phaseReservationSetId: string;
    }>;
    const replacementJobId = replacementJobs[0]?.replacementJobId;
    if (!replacementJobId) throw new Error("replacement Job was not created");
    expect(created.status).toBe("CLAIM_REPRINT_CREATED");
    await expect(
      prisma.jobShipmentAssignment.findUniqueOrThrow({
        where: { jobId: sourceJobId },
      }),
    ).resolves.toEqual(sourceAssignment);
    await expect(
      prisma.shipment.findUniqueOrThrow({ where: { id: originalShipmentId } }),
    ).resolves.toMatchObject({ status: "LOST" });
    await expect(
      prisma.shipment.findUniqueOrThrow({
        where: { id: replacementShipmentId },
      }),
    ).resolves.toMatchObject({
      status: "PLANNED",
      replacesShipmentId: originalShipmentId,
    });
    await expect(
      prisma.phaseReservationSet.findUniqueOrThrow({
        where: { id: replacementJobs[0]!.phaseReservationSetId },
      }),
    ).resolves.toMatchObject({ status: "HELD" });
    await expect(
      prisma.claimSlotResolution.findMany({ where: { claimId: claim.id } }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "REPLACEMENT_PENDING",
        replacementShipmentId,
      }),
    ]);

    await orders.acceptJob(
      fixture.foundation.orderId,
      replacementJobId,
      "lost-parcel-reprint-accept",
    );
    await makeGcodeReady(replacementJobId);
    await orders.startPrinting(
      fixture.foundation.orderId,
      replacementJobId,
      "lost-parcel-reprint-printing",
    );
    await orders.finishPrinting(
      fixture.foundation.orderId,
      replacementJobId,
      { actualMaterialMilligrams: "50" },
      "lost-parcel-reprint-printed",
    );
    await orders.submitQc(
      fixture.foundation.orderId,
      replacementJobId,
      { omissionReason: "v0 operator reprint inspection" },
      "lost-parcel-reprint-qc",
    );
    await orders.approveQc(
      fixture.foundation.orderId,
      replacementJobId,
      "lost-parcel-reprint-approved",
    );
    await orders.labelShipment(
      fixture.foundation.orderId,
      replacementShipmentId,
      {
        carrier: "test-carrier",
        providerShipmentId: `provider-shipment-${replacementShipmentId}`,
        carrierLabelId: `label-${replacementShipmentId}`,
        trackingCode: `tracking-${replacementShipmentId}`,
      },
      "lost-parcel-reprint-label",
    );
    await orders.packJob(
      fixture.foundation.orderId,
      replacementJobId,
      { shipmentId: replacementShipmentId },
      "lost-parcel-reprint-pack",
    );
    await orders.handoffShipment(
      fixture.foundation.orderId,
      replacementShipmentId,
      {
        providerEventId: `handoff-${replacementShipmentId}`,
        providerTransactionId: `handoff-tx-${replacementShipmentId}`,
        occurredAt: new Date().toISOString(),
      },
      "lost-parcel-reprint-handoff",
    );
    await orders.applyShipmentEvent(
      fixture.foundation.orderId,
      replacementShipmentId,
      {
        kind: "TRANSIT_SCAN",
        providerEventId: `transit-${replacementShipmentId}`,
        providerTransactionId: `transit-tx-${replacementShipmentId}`,
        occurredAt: new Date().toISOString(),
      },
      "lost-parcel-reprint-transit",
    );
    await orders.applyShipmentEvent(
      fixture.foundation.orderId,
      replacementShipmentId,
      {
        kind: "DELIVERY_SCAN",
        providerEventId: `delivery-${replacementShipmentId}`,
        providerTransactionId: `delivery-tx-${replacementShipmentId}`,
        occurredAt: new Date().toISOString(),
      },
      "lost-parcel-reprint-delivery",
    );

    await expect(
      prisma.claim.findUniqueOrThrow({ where: { id: claim.id } }),
    ).resolves.toMatchObject({ status: "RESOLVED_REPLACEMENT" });
    await expect(
      orders.getFulfilment(fixture.foundation.orderId),
    ).resolves.toMatchObject({
      orderStatus: "DELIVERED",
      phase: { status: "DELIVERED" },
      slots: [expect.objectContaining({ outcome: "DELIVERED" })],
    });
  }, 20_000);

  it("creates a second reprint from the LOST leaf of the same Claim", async () => {
    const fixture = await preparePaidOrder("repeat-lost-reprint");
    const orderId = fixture.foundation.orderId;
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN", "repeat-root-transit");
    await carrierEvent(fixture, 0, "LOST", "repeat-root-loss");
    const claim = await prisma.claim.findUniqueOrThrow({
      where: { incidentShipmentId: fixture.foundation.shipmentId },
    });
    const firstCandidate = await createFreshReplacementCandidate(fixture, 0);
    const first = await orders.createClaimReprint(
      orderId,
      claim.id,
      {
        replacements: [
          {
            sourceJobId: fixture.productions[0]!.jobId,
            candidateResourceEstimateId: firstCandidate,
          },
        ],
      },
      "repeat-first-create",
    );
    const firstShipmentId = first.result.replacementShipmentId as string;
    const firstJobId = (
      first.result.replacementJobs as Array<{ replacementJobId: string }>
    )[0]!.replacementJobId;
    await handoffReplacement(
      orderId,
      firstJobId,
      firstShipmentId,
      "repeat-first",
    );
    await orders.applyShipmentEvent(
      orderId,
      firstShipmentId,
      {
        kind: "LOST",
        providerEventId: `lost-${firstShipmentId}`,
        providerTransactionId: `lost-tx-${firstShipmentId}`,
        occurredAt: new Date().toISOString(),
      },
      "repeat-first-loss",
    );

    const secondCandidate = await createFreshReplacementCandidate(fixture, 0);
    const second = await orders.createClaimReprint(
      orderId,
      claim.id,
      {
        replacements: [
          {
            sourceJobId: firstJobId,
            candidateResourceEstimateId: secondCandidate,
          },
        ],
      },
      "repeat-second-create",
    );
    const secondShipmentId = second.result.replacementShipmentId as string;
    await expect(
      prisma.shipment.findUniqueOrThrow({ where: { id: secondShipmentId } }),
    ).resolves.toMatchObject({
      status: "PLANNED",
      replacesShipmentId: firstShipmentId,
      reprintClaimId: claim.id,
    });
    await expect(prisma.claim.count({ where: { orderId } })).resolves.toBe(1);
    await expect(
      prisma.claimSlotResolution.findMany({ where: { claimId: claim.id } }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "REPLACEMENT_PENDING",
        replacementShipmentId: secondShipmentId,
      }),
    ]);
  }, 20_000);

  it("reships a returned reprint leaf under the same Claim", async () => {
    const fixture = await preparePaidOrder("returned-reprint-reship");
    const orderId = fixture.foundation.orderId;
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN", "reship-root-transit");
    await carrierEvent(fixture, 0, "LOST", "reship-root-loss");
    const claim = await prisma.claim.findUniqueOrThrow({
      where: { incidentShipmentId: fixture.foundation.shipmentId },
    });
    const candidate = await createFreshReplacementCandidate(fixture, 0);
    const reprint = await orders.createClaimReprint(
      orderId,
      claim.id,
      {
        replacements: [
          {
            sourceJobId: fixture.productions[0]!.jobId,
            candidateResourceEstimateId: candidate,
          },
        ],
      },
      "returned-reprint-create",
    );
    const reprintShipmentId = reprint.result.replacementShipmentId as string;
    const reprintJobId = (
      reprint.result.replacementJobs as Array<{ replacementJobId: string }>
    )[0]!.replacementJobId;
    await handoffReplacement(
      orderId,
      reprintJobId,
      reprintShipmentId,
      "returned-reprint",
    );
    await orders.applyShipmentEvent(
      orderId,
      reprintShipmentId,
      {
        kind: "RETURNED",
        providerEventId: `returned-${reprintShipmentId}`,
        providerTransactionId: `returned-tx-${reprintShipmentId}`,
        occurredAt: new Date().toISOString(),
      },
      "returned-reprint-event",
    );
    const occurredAt = new Date();
    const reshipped = await orders.handoffReshipment(
      orderId,
      claim.id,
      {
        carrier: "test-carrier",
        providerShipmentId: `provider-reship-${reprintShipmentId}`,
        carrierLabelId: `label-reship-${reprintShipmentId}`,
        providerEventId: `accept-reship-${reprintShipmentId}`,
        providerTransactionId: `accept-reship-tx-${reprintShipmentId}`,
        custodyConfirmedAt: new Date(
          occurredAt.getTime() - 2_000,
        ).toISOString(),
        reQcPassedAt: new Date(occurredAt.getTime() - 1_000).toISOString(),
        reQcEvidence: "returned reprint inspected after custody recovery",
        occurredAt: occurredAt.toISOString(),
      },
      "returned-reprint-reship",
    );
    await expect(
      prisma.shipment.findUniqueOrThrow({
        where: { id: reshipped.result.reshipmentShipmentId as string },
      }),
    ).resolves.toMatchObject({
      status: "HANDED_OVER",
      replacesShipmentId: reprintShipmentId,
    });
    await expect(prisma.claim.count({ where: { orderId } })).resolves.toBe(1);
  }, 20_000);

  it("fully refunds a returned order when no slot was delivered", async () => {
    const fixture = await preparePaidOrder("returned");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    await carrierEvent(fixture, 0, "RETURNED");
    const claim = await prisma.claim.findUniqueOrThrow({
      where: { incidentShipmentId: fixture.foundation.shipmentId },
    });
    const pending = await orders.refundClaim(
      fixture.foundation.orderId,
      claim.id,
      "returned-refund-key",
    );
    const refundId = (pending.result.refundIds as string[])[0];
    if (!refundId) throw new Error("claim refund was not created");
    await succeedRefund(refundId);

    const projection = await orders.getFulfilment(fixture.foundation.orderId);
    expect(projection.orderStatus).toBe("REFUNDED");
    expect(projection.phase).toMatchObject({ status: "CANCELLED_REFUNDED" });
    expect(projection.slots).toEqual([
      expect.objectContaining({ outcome: "CANCELLED_REFUNDED" }),
    ]);
  });

  it("enforces incident chronology and atomic consumption through recovery", async () => {
    const fixture = await preparePaidOrder("incident-recovery");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    const shipment = await prisma.shipment.findUniqueOrThrow({
      where: { id: fixture.foundation.shipmentId },
    });
    if (!shipment.handedOverAt) throw new Error("handoff was not recorded");

    await expect(
      prisma.shipmentProviderEvent.create({
        data: {
          shipmentId: shipment.id,
          carrier: shipment.carrier!,
          carrierLabelId: shipment.carrierLabelId!,
          providerEventId: `orphan-loss-${shipment.id}`,
          providerTransactionId: `orphan-loss-tx-${shipment.id}`,
          kind: "LOST",
          occurredAt: new Date(),
          authenticatedAt: new Date(),
          verifiedAt: new Date(),
        },
      }),
    ).rejects.toThrow("must commit atomically");
    await expect(
      orders.applyShipmentEvent(
        fixture.foundation.orderId,
        shipment.id,
        {
          kind: "LOST",
          providerEventId: `stale-loss-${shipment.id}`,
          providerTransactionId: `stale-loss-tx-${shipment.id}`,
          occurredAt: new Date(
            shipment.handedOverAt.getTime() - 60_000,
          ).toISOString(),
        },
        "stale-loss-key",
      ),
    ).rejects.toThrow("chronology");

    await carrierEvent(fixture, 0, "LOST");
    const claimCount = await prisma.claim.count({
      where: { incidentShipmentId: shipment.id },
    });
    await carrierEvent(fixture, 0, "RECOVERED");

    await expect(
      prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } }),
    ).resolves.toMatchObject({ status: "RECOVERED" });
    await expect(
      prisma.claim.count({ where: { incidentShipmentId: shipment.id } }),
    ).resolves.toBe(claimCount);
  });

  it("reships a returned parcel from confirmed custody and resolves its Claim on delivery", async () => {
    const fixture = await preparePaidOrder("returned-custody-reship");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    await carrierEvent(fixture, 0, "RETURNED");
    const claim = await prisma.claim.findUniqueOrThrow({
      where: { incidentShipmentId: fixture.foundation.shipmentId },
    });
    const originalJob = await prisma.job.findUniqueOrThrow({
      where: { id: fixture.productions[0]!.jobId },
      include: { shipmentAssignment: true },
    });
    const evidenceAt = Date.now();
    const reshipmentEvidence = {
      carrier: "test-carrier",
      providerShipmentId: `reship-provider-${claim.id}`,
      carrierLabelId: `reship-label-${claim.id}`,
      trackingCode: `reship-tracking-${claim.id}`,
      providerEventId: `reship-acceptance-${claim.id}`,
      providerTransactionId: `reship-acceptance-tx-${claim.id}`,
      custodyConfirmedAt: new Date(evidenceAt - 3_000).toISOString(),
      reQcPassedAt: new Date(evidenceAt - 2_000).toISOString(),
      occurredAt: new Date(evidenceAt - 1_000).toISOString(),
      reQcEvidence: "operator repeated the final visual and dimensional QC",
    };

    expect(() =>
      orders.handoffReshipment(
        fixture.foundation.orderId,
        claim.id,
        {
          ...reshipmentEvidence,
          reQcPassedAt: reshipmentEvidence.custodyConfirmedAt,
        },
        "returned-custody-reship-equal-qc-time",
      ),
    ).toThrow(
      "custodyConfirmedAt, reQcPassedAt, and occurredAt must be chronological",
    );

    const handedOver = await orders.handoffReshipment(
      fixture.foundation.orderId,
      claim.id,
      reshipmentEvidence,
      "returned-custody-reship-handoff",
    );
    const replay = await orders.handoffReshipment(
      fixture.foundation.orderId,
      claim.id,
      reshipmentEvidence,
      "returned-custody-reship-handoff",
    );
    const reshipmentShipmentId = handedOver.result
      .reshipmentShipmentId as string;
    expect(replay).toEqual(handedOver);
    await expect(
      prisma.reshipmentAuthorization.findFirstOrThrow({
        where: { claimId: claim.id },
      }),
    ).resolves.toMatchObject({
      originalShipmentId: fixture.foundation.shipmentId,
      reshipmentShipmentId,
    });
    await expect(
      prisma.claim.findUniqueOrThrow({
        where: { id: claim.id },
        include: { resolutions: true },
      }),
    ).resolves.toMatchObject({
      status: "ACTIVE",
      resolutions: [
        expect.objectContaining({
          status: "RESHIP_PENDING",
          replacementShipmentId: reshipmentShipmentId,
        }),
      ],
    });
    await expect(
      prisma.job.findUniqueOrThrow({
        where: { id: fixture.productions[0]!.jobId },
        include: { shipmentAssignment: true },
      }),
    ).resolves.toMatchObject({
      status: originalJob.status,
      shipmentAssignment: {
        shipmentId: fixture.foundation.shipmentId,
      },
    });

    await orders.applyShipmentEvent(
      fixture.foundation.orderId,
      reshipmentShipmentId,
      {
        kind: "TRANSIT_SCAN",
        providerEventId: `reship-transit-${claim.id}`,
        providerTransactionId: `reship-transit-tx-${claim.id}`,
        occurredAt: new Date().toISOString(),
      },
      "returned-custody-reship-transit",
    );
    await orders.applyShipmentEvent(
      fixture.foundation.orderId,
      reshipmentShipmentId,
      {
        kind: "DELIVERY_SCAN",
        providerEventId: `reship-delivery-${claim.id}`,
        providerTransactionId: `reship-delivery-tx-${claim.id}`,
        occurredAt: new Date().toISOString(),
      },
      "returned-custody-reship-delivery",
    );

    await expect(
      prisma.claim.findUniqueOrThrow({
        where: { id: claim.id },
        include: { resolutions: true },
      }),
    ).resolves.toMatchObject({
      status: "RESOLVED_RESHIP",
      resolutions: [expect.objectContaining({ status: "DELIVERED_RESHIP" })],
    });
    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: fixture.foundation.orderId },
      }),
    ).resolves.toMatchObject({ status: "DELIVERED" });
  });

  it("creates another custody reshipment after the prior reshipment is returned", async () => {
    const fixture = await preparePaidOrder("repeated-custody-reship");
    const orderId = fixture.foundation.orderId;
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN", "repeat-reship-transit");
    await carrierEvent(fixture, 0, "RETURNED", "repeat-reship-returned");
    const claim = await prisma.claim.findUniqueOrThrow({
      where: { incidentShipmentId: fixture.foundation.shipmentId },
    });
    const firstEvidenceAt = Date.now();
    const first = await orders.handoffReshipment(
      orderId,
      claim.id,
      {
        carrier: "test-carrier",
        providerShipmentId: `first-repeat-reship-${claim.id}`,
        carrierLabelId: `first-repeat-label-${claim.id}`,
        providerEventId: `first-repeat-acceptance-${claim.id}`,
        providerTransactionId: `first-repeat-acceptance-tx-${claim.id}`,
        custodyConfirmedAt: new Date(firstEvidenceAt - 3_000).toISOString(),
        reQcPassedAt: new Date(firstEvidenceAt - 2_000).toISOString(),
        occurredAt: new Date(firstEvidenceAt - 1_000).toISOString(),
        reQcEvidence: "first returned parcel inspection passed",
      },
      "first-repeated-reshipment",
    );
    const firstShipmentId = first.result.reshipmentShipmentId as string;
    await orders.applyShipmentEvent(
      orderId,
      firstShipmentId,
      {
        kind: "TRANSIT_SCAN",
        providerEventId: `first-repeat-transit-${claim.id}`,
        providerTransactionId: `first-repeat-transit-tx-${claim.id}`,
        occurredAt: new Date().toISOString(),
      },
      "first-repeated-reshipment-transit",
    );
    await orders.applyShipmentEvent(
      orderId,
      firstShipmentId,
      {
        kind: "RETURNED",
        providerEventId: `first-repeat-return-${claim.id}`,
        providerTransactionId: `first-repeat-return-tx-${claim.id}`,
        occurredAt: new Date().toISOString(),
      },
      "first-repeated-reshipment-return",
    );

    const secondEvidenceAt = Date.now();
    const second = await orders.handoffReshipment(
      orderId,
      claim.id,
      {
        carrier: "test-carrier",
        providerShipmentId: `second-repeat-reship-${claim.id}`,
        carrierLabelId: `second-repeat-label-${claim.id}`,
        providerEventId: `second-repeat-acceptance-${claim.id}`,
        providerTransactionId: `second-repeat-acceptance-tx-${claim.id}`,
        custodyConfirmedAt: new Date(secondEvidenceAt - 3_000).toISOString(),
        reQcPassedAt: new Date(secondEvidenceAt - 2_000).toISOString(),
        occurredAt: new Date(secondEvidenceAt - 1_000).toISOString(),
        reQcEvidence: "second returned parcel inspection passed",
      },
      "second-repeated-reshipment",
    );
    const secondShipmentId = second.result.reshipmentShipmentId as string;
    await expect(
      prisma.reshipmentAuthorization.findMany({
        where: { claimId: claim.id },
        orderBy: { consumedAt: "asc" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        originalShipmentId: fixture.foundation.shipmentId,
        reshipmentShipmentId: firstShipmentId,
      }),
      expect.objectContaining({
        originalShipmentId: firstShipmentId,
        reshipmentShipmentId: secondShipmentId,
      }),
    ]);
    await expect(
      prisma.claimSlotResolution.findMany({ where: { claimId: claim.id } }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "RESHIP_PENDING",
        replacementShipmentId: secondShipmentId,
      }),
    ]);
    await expect(prisma.claim.count({ where: { orderId } })).resolves.toBe(1);
  }, 20_000);

  it("requires recovered custody and refunds the original Claim after a reshipment incident", async () => {
    const fixture = await preparePaidOrder("recovered-custody-reship-refund");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    await carrierEvent(fixture, 0, "LOST");
    const claim = await prisma.claim.findUniqueOrThrow({
      where: { incidentShipmentId: fixture.foundation.shipmentId },
    });
    const evidenceAt = Date.now();
    const reshipmentEvidence = {
      carrier: "test-carrier",
      providerShipmentId: `recovered-reship-provider-${claim.id}`,
      carrierLabelId: `recovered-reship-label-${claim.id}`,
      providerEventId: `recovered-reship-acceptance-${claim.id}`,
      providerTransactionId: `recovered-reship-acceptance-tx-${claim.id}`,
      custodyConfirmedAt: new Date(evidenceAt - 3_000).toISOString(),
      reQcPassedAt: new Date(evidenceAt - 2_000).toISOString(),
      occurredAt: new Date(evidenceAt - 1_000).toISOString(),
      reQcEvidence: "recovered parcel passed repeat operator QC",
    };

    await expect(
      orders.handoffReshipment(
        fixture.foundation.orderId,
        claim.id,
        reshipmentEvidence,
        "lost-custody-reship-rejected",
      ),
    ).rejects.toThrow("custody-confirmed reshipment scope");
    await carrierEvent(fixture, 0, "RECOVERED");
    const handedOver = await orders.handoffReshipment(
      fixture.foundation.orderId,
      claim.id,
      reshipmentEvidence,
      "recovered-custody-reship-handoff",
    );
    const reshipmentShipmentId = handedOver.result
      .reshipmentShipmentId as string;
    await orders.applyShipmentEvent(
      fixture.foundation.orderId,
      reshipmentShipmentId,
      {
        kind: "TRANSIT_SCAN",
        providerEventId: `recovered-reship-transit-${claim.id}`,
        providerTransactionId: `recovered-reship-transit-tx-${claim.id}`,
        occurredAt: new Date().toISOString(),
      },
      "recovered-custody-reship-transit",
    );
    await orders.applyShipmentEvent(
      fixture.foundation.orderId,
      reshipmentShipmentId,
      {
        kind: "LOST",
        providerEventId: `recovered-reship-loss-${claim.id}`,
        providerTransactionId: `recovered-reship-loss-tx-${claim.id}`,
        occurredAt: new Date().toISOString(),
      },
      "recovered-custody-reship-loss",
    );

    await expect(
      prisma.claim.count({ where: { orderId: fixture.foundation.orderId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.claim.findUniqueOrThrow({
        where: { id: claim.id },
        include: { resolutions: true },
      }),
    ).resolves.toMatchObject({
      status: "ACTIVE",
      resolutions: [expect.objectContaining({ status: "PENDING" })],
    });
    const pending = await orders.refundClaim(
      fixture.foundation.orderId,
      claim.id,
      "recovered-custody-reship-refund",
    );
    const refundId = (pending.result.refundIds as string[])[0];
    if (!refundId)
      throw new Error("reshipment incident refund was not created");
    await succeedRefund(refundId, "-reshipment-incident");
    await expect(
      prisma.claim.findUniqueOrThrow({ where: { id: claim.id } }),
    ).resolves.toMatchObject({ status: "RESOLVED_REFUND" });
    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: fixture.foundation.orderId },
      }),
    ).resolves.toMatchObject({ status: "REFUNDED" });
  });

  it("does not bypass incident remedy authorization with a parcel successor", async () => {
    const fixture = await preparePaidOrder("lost-parcel-replacement");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    await carrierEvent(fixture, 0, "LOST");

    await expect(
      orders.createShipment(
        fixture.foundation.orderId,
        {
          shipmentPlanId: fixture.foundation.shipmentPlanId,
          replacesShipmentId: fixture.foundation.shipmentId,
        },
        "lost-parcel-replacement-key",
      ),
    ).rejects.toThrow("Shipment is not replaceable");
  });

  it("resolves a Claim when a failed refund is replaced by a successful retry", async () => {
    const fixture = await preparePaidOrder("returned-refund-retry", 2);
    await advanceThroughQc(fixture, 0);
    await advanceThroughQc(fixture, 1);
    await labelAndPack(fixture, 0);
    await labelAndPack(fixture, 1);
    await handoff(fixture, 0);
    await handoff(fixture, 1);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    await carrierEvent(fixture, 1, "TRANSIT_SCAN");
    await carrierEvent(fixture, 0, "DELIVERY_SCAN");
    await carrierEvent(fixture, 1, "RETURNED");
    const claim = await prisma.claim.findUniqueOrThrow({
      where: { incidentShipmentId: fixture.foundation.shipmentIds[1]! },
    });
    const pending = await orders.refundClaim(
      fixture.foundation.orderId,
      claim.id,
      "returned-refund-retry-key",
    );
    const failedRefundId = (pending.result.refundIds as string[])[0];
    if (!failedRefundId) throw new Error("claim refund was not created");

    const retryRefundId = randomUUID();
    const failedAt = new Date();
    const failureProviderEventId = `refund-failed-${failedRefundId}`;
    const failureProviderRefundId = `provider-refund-failed-${failedRefundId}`;
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const fixtures = new PersistenceFactory(
        client,
        `${testScope}:returned-refund-retry`,
      );
      await client.query("SELECT taven_claim_refund_dispatch($1)", [
        failedRefundId,
      ]);
      await fixtures.persistRefundProviderEvent(
        failedRefundId,
        "REFUND_FAILED",
        failureProviderRefundId,
        failedAt,
        failureProviderEventId,
      );
      const failureEvent = await client.query<{ id: string }>(
        `SELECT id FROM payment_provider_events
         WHERE provider_event_id = $1`,
        [failureProviderEventId],
      );
      const failureEventId = failureEvent.rows[0]?.id;
      if (!failureEventId)
        throw new Error("refund failure event was not created");
      await client.query(
        `UPDATE refund_transactions
         SET status = 'FAILED', provider_refund_id = $2,
             provider_result_event_id = $3, updated_at = $4
         WHERE id = $1`,
        [failedRefundId, failureProviderRefundId, failureEventId, failedAt],
      );

      await client.query("SAVEPOINT invalid_retry_scope");
      await expect(
        client.query(
          `INSERT INTO refund_transactions
             (id, payment_id, claim_id, price_adjustment_id,
              replaces_refund_transaction_id,
              replaces_failure_provider_event_id, idempotency_key, provider,
              amount_minor, reason, status, requested_at, created_at, updated_at)
           SELECT gen_random_uuid(), source.payment_id, NULL,
                  source.price_adjustment_id, source.id, $2,
                  $3, source.provider, source.amount_minor, source.reason,
                  'PENDING', $4, $4, $4
           FROM refund_transactions source
           WHERE source.id = $1`,
          [
            failedRefundId,
            failureEventId,
            `invalid-retry-scope-${failedRefundId}`,
            new Date(failedAt.getTime() + 1),
          ],
        ),
      ).rejects.toThrow(
        "refund retry must preserve claim and adjustment scope",
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_retry_scope");

      const retryRequestedAt = new Date(failedAt.getTime() + 2);
      await client.query(
        `INSERT INTO refund_transactions
           (id, payment_id, claim_id, price_adjustment_id,
            replaces_refund_transaction_id,
            replaces_failure_provider_event_id, idempotency_key, provider,
            amount_minor, reason, status, requested_at, created_at, updated_at)
         SELECT $1, source.payment_id, source.claim_id,
                source.price_adjustment_id, source.id, $2,
                $3, source.provider, source.amount_minor, source.reason,
                'PENDING', $4, $4, $4
         FROM refund_transactions source
         WHERE source.id = $5`,
        [
          retryRefundId,
          failureEventId,
          `retry-${failedRefundId}`,
          retryRequestedAt,
          failedRefundId,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    await succeedRefund(retryRefundId);

    await expect(
      prisma.refundTransaction.findMany({
        where: { id: { in: [failedRefundId, retryRefundId] } },
        orderBy: { requestedAt: "asc" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: failedRefundId,
        status: "FAILED",
        claimId: claim.id,
      }),
      expect.objectContaining({
        id: retryRefundId,
        status: "SUCCEEDED",
        claimId: claim.id,
        replacesRefundTransactionId: failedRefundId,
      }),
    ]);
    await expect(
      prisma.claim.findUniqueOrThrow({ where: { id: claim.id } }),
    ).resolves.toMatchObject({ status: "RESOLVED_REFUND" });
    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: fixture.foundation.orderId },
      }),
    ).resolves.toMatchObject({ status: "PARTIALLY_FULFILLED" });
  });

  it("keeps cancellation pending until the exact carrier label void is confirmed", async () => {
    const fixture = await preparePaidOrder("label-void");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);

    const pending = await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "customer cancelled before physical handoff" },
      "label-void-cancel-key",
    );
    expect(pending.status).toBe("LABEL_CANCELLATION_PENDING");
    await expect(
      prisma.refundTransaction.count({
        where: { payment: { orderId: fixture.foundation.orderId } },
      }),
    ).resolves.toBe(0);

    const occurredAt = new Date().toISOString();
    const confirmed = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      {
        providerEventId: `void-${fixture.foundation.shipmentId}`,
        providerTransactionId: `void-tx-${fixture.foundation.shipmentId}`,
        occurredAt,
      },
      "label-void-confirm-key",
    );
    expect(confirmed.status).toBe("LABEL_VOID_CONFIRMED_AND_ORDER_CANCELLED");
    expect(confirmed.result.refundIds).toHaveLength(1);
    await expect(
      prisma.shipment.findUniqueOrThrow({
        where: { id: fixture.foundation.shipmentId },
      }),
    ).resolves.toMatchObject({
      status: "CANCELLED",
      providerVoidId: `void-${fixture.foundation.shipmentId}`,
    });
    await expect(
      prisma.outboxMessage.findUniqueOrThrow({
        where: {
          deduplicationKey: `void_carrier_label:${fixture.foundation.shipmentId}:label-${fixture.foundation.shipmentId}`,
        },
      }),
    ).resolves.toMatchObject({ status: "DELIVERED" });
  });

  it("preserves dispatcher evidence when confirming a delivered label void", async () => {
    const fixture = await preparePaidOrder("delivered-label-void");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "customer cancelled before physical handoff" },
      "delivered-label-void-cancel",
    );
    const deduplicationKey = `void_carrier_label:${fixture.foundation.shipmentId}:label-${fixture.foundation.shipmentId}`;
    const deliveredAt = new Date();
    const delivered = await prisma.outboxMessage.update({
      where: { deduplicationKey },
      data: { status: "DELIVERED", deliveredAt, lockedAt: null },
    });

    const confirmed = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      {
        providerEventId: `delivered-void-${fixture.foundation.shipmentId}`,
        providerTransactionId: `delivered-void-tx-${fixture.foundation.shipmentId}`,
        occurredAt: deliveredAt.toISOString(),
      },
      "delivered-label-void-confirm",
    );

    expect(confirmed.status).toBe("LABEL_VOID_CONFIRMED_AND_ORDER_CANCELLED");
    await expect(
      prisma.outboxMessage.findUniqueOrThrow({
        where: { deduplicationKey },
      }),
    ).resolves.toMatchObject({
      status: "DELIVERED",
      deliveredAt: delivered.deliveredAt,
    });
    await expect(
      prisma.shipmentProviderEvent.findFirstOrThrow({
        where: {
          shipmentId: fixture.foundation.shipmentId,
          kind: "LABEL_VOIDED",
        },
      }),
    ).resolves.toMatchObject({ outboxMessageId: delivered.id });
  });

  it("cancels and refunds only the parcel whose final void follows a sibling handoff", async () => {
    const fixture = await preparePaidOrder("partial-label-void", 2);
    await advanceThroughQc(fixture, 0);
    await advanceThroughQc(fixture, 1);
    await labelAndPack(fixture, 0);
    await labelAndPack(fixture, 1);
    const cancelledSlotId = fixture.foundation.fulfilmentSlotIds[1]!;
    await markSlotPriceComponentExpress(cancelledSlotId);
    const priorAdjustment = await orders.createPriceAdjustment(
      fixture.foundation.orderId,
      {
        reason: "EXPRESS_BREACH",
        amountMinor: "1",
        paymentId: fixture.foundation.paymentId,
        allocation: {
          reason: "express credit before cancellation",
          slotCredits: [
            { fulfilmentSlotId: cancelledSlotId, amountMinor: "1" },
          ],
        },
      },
      "partial-label-void-prior-adjustment",
    );
    const priorRefund = await orders.refundAdjustment(
      fixture.foundation.orderId,
      priorAdjustment.result.priceAdjustmentId as string,
      "partial-label-void-prior-refund",
    );
    const priorRefundId = (priorRefund.result.refundIds as string[])[0];
    if (!priorRefundId) throw new Error("prior express refund was not created");
    await succeedRefund(priorRefundId);
    await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "customer cancelled while the first parcel was handed over" },
      "partial-label-void-cancel",
    );
    await handoff(fixture, 0);

    const shipmentId = fixture.foundation.shipmentIds[1]!;
    const voidOccurredAt = new Date();
    const confirmed = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      shipmentId,
      {
        providerEventId: `partial-void-${shipmentId}`,
        providerTransactionId: `partial-void-tx-${shipmentId}`,
        occurredAt: voidOccurredAt.toISOString(),
      },
      "partial-label-void-confirm",
    );
    const refundId = (confirmed.result.refundIds as string[])[0];
    expect(confirmed.status).toBe("LABEL_VOID_CONFIRMED_PARTIAL_CANCELLATION");
    if (!refundId)
      throw new Error("partial cancellation refund was not created");
    await expect(
      orders.handoffShipment(
        fixture.foundation.orderId,
        shipmentId,
        {
          providerEventId: `late-partial-acceptance-${shipmentId}`,
          providerTransactionId: `late-partial-acceptance-tx-${shipmentId}`,
          occurredAt: new Date(voidOccurredAt.getTime() - 1).toISOString(),
        },
        "partial-label-void-late-acceptance",
      ),
    ).rejects.toThrow(
      "Partially cancelled Shipment requires exact manual financial reconciliation before handoff",
    );
    await expect(
      prisma.shipmentProviderEvent.count({
        where: {
          shipmentId,
          kind: "ACCEPTANCE_SCAN",
        },
      }),
    ).resolves.toBe(0);

    await carrierEvent(fixture, 0, "DELIVERY_SCAN", "partial-delivery");
    await succeedRefund(refundId);

    const projection = await orders.getFulfilment(fixture.foundation.orderId);
    expect(projection.orderStatus).toBe("PARTIALLY_FULFILLED");
    expect(projection.shipments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "DELIVERED" }),
        expect.objectContaining({ status: "CANCELLED" }),
      ]),
    );
    expect(projection.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "HANDED_OVER" }),
        expect.objectContaining({ status: "CANCELLED" }),
      ]),
    );
    expect(projection.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "DELIVERED" }),
        expect.objectContaining({ outcome: "CANCELLED_REFUNDED" }),
      ]),
    );
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({
      reason: "PARTIAL_CANCELLATION",
      status: "SUCCEEDED",
    });

    await reverseSucceededRefund(refundId);

    const reversed = await orders.getFulfilment(fixture.foundation.orderId);
    expect(reversed.orderStatus).toBe("SHIPPED");
    expect(reversed.phase.status).toBe("SHIPPED");
    expect(reversed.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "DELIVERED" }),
        expect.objectContaining({ outcome: "CANCELLED" }),
      ]),
    );
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({ status: "FAILED" });

    await succeedRefund(refundId, "-after-reversal");
    await expect(
      orders.getFulfilment(fixture.foundation.orderId),
    ).resolves.toMatchObject({ orderStatus: "PARTIALLY_FULFILLED" });
    await expect(
      prisma.order.update({
        where: { id: fixture.foundation.orderId },
        data: { status: "SHIPPED" },
      }),
    ).rejects.toThrow("order status transition is not allowed");
  }, 10_000);

  it("retains a scoped partial cancellation when its refund attempt fails", async () => {
    const fixture = await preparePaidOrder("partial-label-void-failed", 2);
    await advanceThroughQc(fixture, 0);
    await advanceThroughQc(fixture, 1);
    await labelAndPack(fixture, 0);
    await labelAndPack(fixture, 1);
    await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "customer cancelled while the first parcel was handed over" },
      "partial-label-void-failed-cancel",
    );
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN", "partial-failed-transit");
    await carrierEvent(fixture, 0, "LOST", "partial-failed-lost");

    const shipmentId = fixture.foundation.shipmentIds[1]!;
    const confirmed = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      shipmentId,
      {
        providerEventId: `partial-failed-void-${shipmentId}`,
        providerTransactionId: `partial-failed-void-tx-${shipmentId}`,
        occurredAt: new Date().toISOString(),
      },
      "partial-label-void-failed-confirm",
    );
    const refundId = (confirmed.result.refundIds as string[])[0];
    if (!refundId)
      throw new Error("partial cancellation refund was not created");

    await failRefund(refundId);

    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({
      reason: "PARTIAL_CANCELLATION",
      status: "FAILED",
    });
    const projection = await orders.getFulfilment(fixture.foundation.orderId);
    expect(projection.orderStatus).toBe("SHIPPED");
    expect(projection.shipments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "LOST" }),
        expect.objectContaining({ status: "CANCELLED" }),
      ]),
    );
    expect(projection.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "PENDING" }),
        expect.objectContaining({ outcome: "CANCELLED" }),
      ]),
    );
  });

  it("retains pre-void custody evidence when the cancelled parcel lacks packing proof", async () => {
    const fixture = await preparePaidOrder("post-void-incomplete-packing");
    await advanceThroughQc(fixture, 0);
    const shipmentId = fixture.foundation.shipmentId;
    await orders.labelShipment(
      fixture.foundation.orderId,
      shipmentId,
      {
        carrier: "test-carrier",
        providerShipmentId: `provider-shipment-${shipmentId}`,
        carrierLabelId: `label-${shipmentId}`,
      },
      "incomplete-packing-label",
    );
    await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "cancelled before packing completed" },
      "incomplete-packing-cancel",
    );
    const voidOccurredAt = new Date();
    const confirmed = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      shipmentId,
      {
        providerEventId: `incomplete-packing-void-${shipmentId}`,
        providerTransactionId: `incomplete-packing-void-tx-${shipmentId}`,
        occurredAt: voidOccurredAt.toISOString(),
      },
      "incomplete-packing-void",
    );
    const refundId = (confirmed.result.refundIds as string[])[0];
    if (!refundId) throw new Error("cancellation refund was not created");
    const evidence = {
      providerEventId: `incomplete-packing-acceptance-${shipmentId}`,
      providerTransactionId: `incomplete-packing-acceptance-tx-${shipmentId}`,
      occurredAt: new Date(voidOccurredAt.getTime() - 1).toISOString(),
    };
    const blocked = await orders.handoffShipment(
      fixture.foundation.orderId,
      shipmentId,
      evidence,
      "incomplete-packing-acceptance",
    );
    const replay = await orders.handoffShipment(
      fixture.foundation.orderId,
      shipmentId,
      evidence,
      "incomplete-packing-acceptance-replay",
    );

    expect(blocked.status).toBe("SHIPMENT_HANDOFF_RECONCILIATION_REQUIRED");
    expect(replay.status).toBe("SHIPMENT_HANDOFF_RECONCILIATION_REQUIRED");
    await expect(
      prisma.shipmentProviderEvent.count({
        where: { shipmentId, kind: "ACCEPTANCE_SCAN" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } }),
    ).resolves.toMatchObject({
      status: "CANCELLED",
      providerAcceptanceScanId: null,
      handedOverAt: null,
    });
    await expect(
      prisma.job.findUniqueOrThrow({
        where: { id: fixture.productions[0]!.jobId },
      }),
    ).resolves.toMatchObject({ status: "CANCELLED", packedAt: null });
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({ status: "PENDING", dispatchClaimedAt: null });
    await expect(
      prisma.payment.findUniqueOrThrow({
        where: { id: fixture.foundation.paymentId },
      }),
    ).resolves.toMatchObject({ status: "REFUND_PENDING" });
    await expect(
      pool.query("SELECT taven_claim_refund_dispatch($1)", [refundId]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "refund_dispatch_incomplete_custody_check",
    });
  }, 10_000);

  it("reconciles a pre-void acceptance scan after an undispatched cancellation refund", async () => {
    const fixture = await preparePaidOrder("post-void-handoff-pending");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "carrier acceptance was delayed" },
      "post-void-handoff-pending-cancel",
    );
    const voidOccurredAt = new Date();
    const confirmed = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      {
        providerEventId: `post-void-${fixture.foundation.shipmentId}`,
        providerTransactionId: `post-void-tx-${fixture.foundation.shipmentId}`,
        occurredAt: voidOccurredAt.toISOString(),
      },
      "post-void-handoff-pending-confirm",
    );
    const refundId = (confirmed.result.refundIds as string[])[0];
    if (!refundId) throw new Error("cancellation refund was not created");
    await expect(
      prisma.refundTransaction.update({
        where: { id: refundId },
        data: { status: "SUPERSEDED" },
      }),
    ).rejects.toThrow("exact post-void handoff evidence");

    const evidence = {
      providerEventId: `post-void-acceptance-${fixture.foundation.shipmentId}`,
      providerTransactionId: `post-void-acceptance-tx-${fixture.foundation.shipmentId}`,
      occurredAt: new Date(voidOccurredAt.getTime() - 1).toISOString(),
    };
    const reconciled = await orders.handoffShipment(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      evidence,
      "post-void-handoff-pending-acceptance",
    );
    const replay = await orders.handoffShipment(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      evidence,
      "post-void-handoff-pending-replay",
    );

    expect(reconciled.status).toBe("SHIPMENT_HANDOFF_RECONCILED");
    expect(replay.status).toBe("SHIPMENT_HANDOFF_ALREADY_APPLIED");
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({ status: "SUPERSEDED" });
    await expect(
      prisma.payment.findUniqueOrThrow({
        where: { id: fixture.foundation.paymentId },
      }),
    ).resolves.toMatchObject({ status: "CAPTURED" });
    const projection = await orders.getFulfilment(fixture.foundation.orderId);
    expect(projection).toMatchObject({
      orderStatus: "SHIPPED",
      phase: { status: "SHIPPED" },
      jobs: [expect.objectContaining({ status: "HANDED_OVER" })],
      shipments: [expect.objectContaining({ status: "HANDED_OVER" })],
      slots: [expect.objectContaining({ outcome: "PENDING" })],
    });
  });

  it("records aggregate settlement when a pre-void acceptance arrives after refunds", async () => {
    const fixture = await preparePaidOrder("post-void-handoff-refunded");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await markSlotPriceComponentExpress(
      fixture.foundation.fulfilmentSlotIds[0]!,
    );
    const priorAdjustment = await orders.createPriceAdjustment(
      fixture.foundation.orderId,
      {
        reason: "EXPRESS_BREACH",
        amountMinor: "1",
        paymentId: fixture.foundation.paymentId,
        allocation: {
          component: "express",
          reason: "deadline missed before cancellation",
          slotCredits: [
            {
              fulfilmentSlotId: fixture.foundation.fulfilmentSlotIds[0]!,
              amountMinor: "1",
            },
          ],
        },
      },
      "post-void-handoff-prior-adjustment",
    );
    const priorRefund = await orders.refundAdjustment(
      fixture.foundation.orderId,
      priorAdjustment.result.priceAdjustmentId as string,
      "post-void-handoff-prior-refund",
    );
    const priorRefundId = (priorRefund.result.refundIds as string[])[0];
    if (!priorRefundId) throw new Error("prior refund was not created");
    await succeedRefund(priorRefundId, "-prior-adjustment");
    await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "carrier acceptance was delayed past the refund" },
      "post-void-handoff-refunded-cancel",
    );
    const voidOccurredAt = new Date();
    const confirmed = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      {
        providerEventId: `refunded-post-void-${fixture.foundation.shipmentId}`,
        providerTransactionId: `refunded-post-void-tx-${fixture.foundation.shipmentId}`,
        occurredAt: voidOccurredAt.toISOString(),
      },
      "post-void-handoff-refunded-confirm",
    );
    const refundId = (confirmed.result.refundIds as string[])[0];
    if (!refundId) throw new Error("cancellation refund was not created");
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: fixture.foundation.paymentId },
    });
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({
      amountMinor: payment.capturedAmountMinor! - 1n,
    });
    await succeedRefund(refundId);

    const reconciled = await orders.handoffShipment(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      {
        providerEventId: `refunded-post-void-acceptance-${fixture.foundation.shipmentId}`,
        providerTransactionId: `refunded-post-void-acceptance-tx-${fixture.foundation.shipmentId}`,
        occurredAt: new Date(voidOccurredAt.getTime() - 1).toISOString(),
      },
      "post-void-handoff-refunded-acceptance",
    );

    expect(reconciled.status).toBe("SHIPMENT_HANDOFF_RECONCILED");
    await expect(
      prisma.orderSettlement.findFirstOrThrow({
        where: { orderId: fixture.foundation.orderId },
      }),
    ).resolves.toMatchObject({
      kind: "UNAUTHORIZED_HANDOFF",
      refundTransactionId: refundId,
      refundAmountMinor: payment.capturedAmountMinor,
    });
    await expect(
      prisma.handoffReconciliation.findUniqueOrThrow({
        where: { shipmentId: fixture.foundation.shipmentId },
      }),
    ).resolves.toMatchObject({
      status: "COMPLETED",
      refundTransactionId: refundId,
    });
    const projection = await orders.getFulfilment(fixture.foundation.orderId);
    expect(projection).toMatchObject({
      orderStatus: "SHIPPED",
      phase: { status: "SHIPPED" },
      jobs: [expect.objectContaining({ status: "HANDED_OVER" })],
      shipments: [expect.objectContaining({ status: "HANDED_OVER" })],
      slots: [expect.objectContaining({ outcome: "PENDING" })],
    });
  });

  it("blocks post-void handoff for every production-failure refund history", async () => {
    const fixture = await preparePaidOrder(
      "post-void-production-failure-refund",
      2,
    );
    const shipmentId = fixture.foundation.shipmentIds[0]!;
    await advanceThroughQc(fixture, 0);
    await advanceThroughQc(fixture, 1);
    await labelAndPack(fixture, 0);
    await orders.failJob(
      fixture.foundation.orderId,
      fixture.productions[1]!.jobId,
      {
        stage: "POST_QC",
        reason: "second parcel cannot be produced",
        recovery: "REFUND",
      },
      "post-void-production-failure-fail",
    );
    await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "cancel the remaining physical parcel" },
      "post-void-production-failure-cancel",
    );
    const voidOccurredAt = new Date();
    const confirmed = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      shipmentId,
      {
        providerEventId: `production-failure-void-${shipmentId}`,
        providerTransactionId: `production-failure-void-tx-${shipmentId}`,
        occurredAt: voidOccurredAt.toISOString(),
      },
      "post-void-production-failure-confirm",
    );
    const refundId = (confirmed.result.refundIds as string[])[0];
    if (!refundId) throw new Error("production-failure refund was not created");

    await expect(
      orders.handoffShipment(
        fixture.foundation.orderId,
        shipmentId,
        {
          providerEventId: `production-failure-acceptance-${shipmentId}`,
          providerTransactionId: `production-failure-acceptance-tx-${shipmentId}`,
          occurredAt: new Date(voidOccurredAt.getTime() - 1).toISOString(),
        },
        "post-void-production-failure-handoff",
      ),
    ).rejects.toThrow(
      "Production failure refund requires exact manual financial reconciliation before handoff",
    );
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({
      reason: "PRODUCTION_FAILURE",
      status: "PENDING",
    });
    await expect(
      prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
    await expect(
      prisma.shipmentProviderEvent.count({
        where: { shipmentId, kind: "ACCEPTANCE_SCAN" },
      }),
    ).resolves.toBe(0);

    await failRefund(refundId);
    await expect(
      orders.handoffShipment(
        fixture.foundation.orderId,
        shipmentId,
        {
          providerEventId: `failed-production-refund-acceptance-${shipmentId}`,
          providerTransactionId: `failed-production-refund-acceptance-tx-${shipmentId}`,
          occurredAt: new Date(voidOccurredAt.getTime() - 1).toISOString(),
        },
        "post-void-failed-production-refund-handoff",
      ),
    ).rejects.toThrow(
      "Production failure refund requires exact manual financial reconciliation before handoff",
    );
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({
      reason: "PRODUCTION_FAILURE",
      status: "FAILED",
    });
    await expect(
      prisma.shipmentProviderEvent.count({
        where: { shipmentId, kind: "ACCEPTANCE_SCAN" },
      }),
    ).resolves.toBe(0);
  });

  it("lets a verified acceptance scan supersede pending label cancellation", async () => {
    const fixture = await preparePaidOrder("label-void-acceptance-wins");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "customer cancelled while carrier acceptance was racing" },
      "acceptance-wins-cancel-key",
    );

    const evidence = {
      providerEventId: `acceptance-${fixture.foundation.shipmentId}`,
      providerTransactionId: `acceptance-tx-${fixture.foundation.shipmentId}`,
      occurredAt: new Date().toISOString(),
    };
    const accepted = await orders.handoffShipment(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      evidence,
      "acceptance-wins-handoff-key",
    );
    const replay = await orders.handoffShipment(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      evidence,
      "acceptance-wins-handoff-replay-key",
    );

    expect(accepted.status).toBe("SHIPMENT_HANDED_OVER");
    expect(replay.status).toBe("SHIPMENT_HANDOFF_ALREADY_APPLIED");
    await expect(
      orders.confirmLabelVoid(
        fixture.foundation.orderId,
        fixture.foundation.shipmentId,
        {
          providerEventId: `late-void-${fixture.foundation.shipmentId}`,
          providerTransactionId: `late-void-tx-${fixture.foundation.shipmentId}`,
          occurredAt: new Date().toISOString(),
        },
        "acceptance-wins-late-void-key",
      ),
    ).rejects.toThrow("Carrier label void command was superseded");
    await expect(
      prisma.outboxMessage.findUniqueOrThrow({
        where: {
          deduplicationKey: `void_carrier_label:${fixture.foundation.shipmentId}:label-${fixture.foundation.shipmentId}`,
        },
      }),
    ).resolves.toMatchObject({ status: "SUPERSEDED" });
    await expect(
      prisma.outboxMessage.update({
        where: {
          deduplicationKey: `void_carrier_label:${fixture.foundation.shipmentId}:label-${fixture.foundation.shipmentId}`,
        },
        data: { status: "PENDING" },
      }),
    ).rejects.toThrow("terminal outbox message");
    await expect(
      prisma.refundTransaction.count({
        where: { payment: { orderId: fixture.foundation.orderId } },
      }),
    ).resolves.toBe(0);
    const projection = await orders.getFulfilment(fixture.foundation.orderId);
    expect(projection).toMatchObject({
      orderStatus: "SHIPPED",
      phase: { status: "SHIPPED" },
      jobs: [expect.objectContaining({ status: "HANDED_OVER" })],
      shipments: [expect.objectContaining({ status: "HANDED_OVER" })],
    });
  });

  it("records a late provider void after dispatched cancellation loses to handoff", async () => {
    const fixture = await preparePaidOrder("delivered-void-acceptance-wins");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "carrier acceptance raced with dispatched cancellation" },
      "delivered-void-acceptance-cancel",
    );
    const deduplicationKey = `void_carrier_label:${fixture.foundation.shipmentId}:label-${fixture.foundation.shipmentId}`;
    const deliveredAt = new Date();
    const delivered = await prisma.outboxMessage.update({
      where: { deduplicationKey },
      data: { status: "DELIVERED", deliveredAt, lockedAt: null },
    });
    const acceptanceOccurredAt = new Date(deliveredAt.getTime() + 1);

    const accepted = await orders.handoffShipment(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      {
        providerEventId: `delivered-void-acceptance-${fixture.foundation.shipmentId}`,
        providerTransactionId: `delivered-void-acceptance-tx-${fixture.foundation.shipmentId}`,
        occurredAt: acceptanceOccurredAt.toISOString(),
      },
      "delivered-void-acceptance-handoff",
    );

    expect(accepted.status).toBe("SHIPMENT_HANDED_OVER");
    await expect(
      prisma.outboxMessage.findUniqueOrThrow({
        where: { deduplicationKey },
      }),
    ).resolves.toMatchObject({
      status: "DELIVERED",
      deliveredAt: delivered.deliveredAt,
    });
    await expect(
      orders.confirmLabelVoid(
        fixture.foundation.orderId,
        fixture.foundation.shipmentId,
        {
          providerEventId: `predating-void-${fixture.foundation.shipmentId}`,
          providerTransactionId: `predating-void-tx-${fixture.foundation.shipmentId}`,
          occurredAt: new Date(
            acceptanceOccurredAt.getTime() - 1_000,
          ).toISOString(),
        },
        "delivered-void-predating-confirm",
      ),
    ).rejects.toThrow(
      "Post-handoff provider void is a no-op only when the exact acceptance scan physically won",
    );

    const voidEvidence = {
      providerEventId: `late-delivered-void-${fixture.foundation.shipmentId}`,
      providerTransactionId: `late-delivered-void-tx-${fixture.foundation.shipmentId}`,
      occurredAt: new Date().toISOString(),
    };
    const recorded = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      voidEvidence,
      "delivered-void-late-confirm",
    );
    const replay = await orders.confirmLabelVoid(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      voidEvidence,
      "delivered-void-late-replay",
    );

    expect(recorded.status).toBe("LABEL_VOID_RECORDED_AFTER_HANDOFF");
    expect(replay.status).toBe("LABEL_VOID_ALREADY_RECORDED_AFTER_HANDOFF");
    await expect(
      prisma.shipmentProviderEvent.findFirstOrThrow({
        where: {
          shipmentId: fixture.foundation.shipmentId,
          kind: "LABEL_VOIDED",
        },
      }),
    ).resolves.toMatchObject({ outboxMessageId: delivered.id });
    await expect(
      prisma.refundTransaction.count({
        where: { payment: { orderId: fixture.foundation.orderId } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.shipment.findUniqueOrThrow({
        where: { id: fixture.foundation.shipmentId },
      }),
    ).resolves.toMatchObject({
      status: "HANDED_OVER",
      providerVoidId: null,
      providerVoidedAt: null,
    });
  });

  for (const scenario of [
    { suffix: "lost", events: ["LOST"], status: "LOST" },
    { suffix: "returned", events: ["RETURNED"], status: "RETURNED" },
    {
      suffix: "recovered",
      events: ["LOST", "RECOVERED"],
      status: "RECOVERED",
    },
  ] as const) {
    it(`records and replays a late provider void after a parcel becomes ${scenario.status}`, async () => {
      const fixture = await preparePaidOrder(
        `late-void-${scenario.suffix}-incident`,
      );
      await advanceThroughQc(fixture, 0);
      await labelAndPack(fixture, 0);
      await orders.cancelOrder(
        fixture.foundation.orderId,
        { reason: "carrier acceptance won before a later incident" },
        `late-void-${scenario.suffix}-cancel`,
      );
      const deduplicationKey = `void_carrier_label:${fixture.foundation.shipmentId}:label-${fixture.foundation.shipmentId}`;
      const deliveredAt = new Date();
      const delivered = await prisma.outboxMessage.update({
        where: { deduplicationKey },
        data: { status: "DELIVERED", deliveredAt, lockedAt: null },
      });
      await orders.handoffShipment(
        fixture.foundation.orderId,
        fixture.foundation.shipmentId,
        {
          providerEventId: `late-void-${scenario.suffix}-acceptance-${fixture.foundation.shipmentId}`,
          providerTransactionId: `late-void-${scenario.suffix}-acceptance-tx-${fixture.foundation.shipmentId}`,
          occurredAt: new Date(deliveredAt.getTime() + 1).toISOString(),
        },
        `late-void-${scenario.suffix}-handoff`,
      );
      await carrierEvent(
        fixture,
        0,
        "TRANSIT_SCAN",
        `late-void-${scenario.suffix}-transit`,
      );
      for (const event of scenario.events) {
        await carrierEvent(
          fixture,
          0,
          event,
          `late-void-${scenario.suffix}-${event.toLowerCase()}`,
        );
      }

      const voidEvidence = {
        providerEventId: `late-void-${scenario.suffix}-${fixture.foundation.shipmentId}`,
        providerTransactionId: `late-void-${scenario.suffix}-tx-${fixture.foundation.shipmentId}`,
        occurredAt: new Date().toISOString(),
      };
      const recorded = await orders.confirmLabelVoid(
        fixture.foundation.orderId,
        fixture.foundation.shipmentId,
        voidEvidence,
        `late-void-${scenario.suffix}-confirm`,
      );
      const replay = await orders.confirmLabelVoid(
        fixture.foundation.orderId,
        fixture.foundation.shipmentId,
        voidEvidence,
        `late-void-${scenario.suffix}-replay`,
      );

      expect(recorded.status).toBe("LABEL_VOID_RECORDED_AFTER_HANDOFF");
      expect(replay.status).toBe("LABEL_VOID_ALREADY_RECORDED_AFTER_HANDOFF");
      await expect(
        prisma.shipmentProviderEvent.findFirstOrThrow({
          where: {
            shipmentId: fixture.foundation.shipmentId,
            kind: "LABEL_VOIDED",
          },
        }),
      ).resolves.toMatchObject({ outboxMessageId: delivered.id });
      await expect(
        prisma.refundTransaction.count({
          where: { payment: { orderId: fixture.foundation.orderId } },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.shipment.findUniqueOrThrow({
          where: { id: fixture.foundation.shipmentId },
        }),
      ).resolves.toMatchObject({
        status: scenario.status,
        providerVoidId: null,
        providerVoidedAt: null,
      });
    });
  }

  it("records cancellation-race handoff while an adjustment refund is pending", async () => {
    const fixture = await preparePaidOrder("acceptance-pending-adjustment");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await markSlotPriceComponentExpress(
      fixture.foundation.fulfilmentSlotIds[0]!,
    );
    const adjustment = await orders.createPriceAdjustment(
      fixture.foundation.orderId,
      {
        reason: "EXPRESS_BREACH",
        amountMinor: "1",
        paymentId: fixture.foundation.paymentId,
        allocation: {
          component: "express",
          reason: "deadline missed",
          slotCredits: [
            {
              fulfilmentSlotId: fixture.foundation.fulfilmentSlotIds[0]!,
              amountMinor: "1",
            },
          ],
        },
      },
      "acceptance-pending-adjustment-create",
    );
    const pending = await orders.refundAdjustment(
      fixture.foundation.orderId,
      adjustment.result.priceAdjustmentId as string,
      "acceptance-pending-adjustment-refund",
    );
    const refundId = (pending.result.refundIds as string[])[0];
    if (!refundId) throw new Error("adjustment refund was not created");
    await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "carrier acceptance raced with cancellation" },
      "acceptance-pending-adjustment-cancel",
    );

    const accepted = await orders.handoffShipment(
      fixture.foundation.orderId,
      fixture.foundation.shipmentId,
      {
        providerEventId: `acceptance-pending-${fixture.foundation.shipmentId}`,
        providerTransactionId: `acceptance-pending-tx-${fixture.foundation.shipmentId}`,
        occurredAt: new Date().toISOString(),
      },
      "acceptance-pending-adjustment-handoff",
    );

    expect(accepted.status).toBe("SHIPMENT_HANDED_OVER");
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({ status: "PENDING" });
    await expect(
      prisma.outboxMessage.findUniqueOrThrow({
        where: {
          deduplicationKey: `void_carrier_label:${fixture.foundation.shipmentId}:label-${fixture.foundation.shipmentId}`,
        },
      }),
    ).resolves.toMatchObject({ status: "SUPERSEDED" });
  });

  it("blocks handoff until an express PriceAdjustment refund succeeds", async () => {
    const fixture = await preparePaidOrder("express-adjustment");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await markSlotPriceComponentExpress(
      fixture.foundation.fulfilmentSlotIds[0]!,
    );
    const adjustment = await orders.createPriceAdjustment(
      fixture.foundation.orderId,
      {
        reason: "EXPRESS_BREACH",
        amountMinor: "1",
        paymentId: fixture.foundation.paymentId,
        allocation: {
          component: "express",
          reason: "deadline missed",
          slotCredits: [
            {
              fulfilmentSlotId: fixture.foundation.fulfilmentSlotIds[0]!,
              amountMinor: "1",
            },
          ],
        },
      },
      "express-adjustment-key",
    );
    await expect(handoff(fixture, 0)).rejects.toThrow(
      "Shipment packing or financial handoff barriers are not satisfied",
    );

    const pending = await orders.refundAdjustment(
      fixture.foundation.orderId,
      adjustment.result.priceAdjustmentId as string,
      "express-adjustment-refund-key",
    );
    const refundId = (pending.result.refundIds as string[])[0];
    if (!refundId) throw new Error("express refund was not created");
    await succeedRefund(refundId);
    await handoff(fixture, 0);

    await expect(
      prisma.payment.findUniqueOrThrow({
        where: { id: fixture.foundation.paymentId },
      }),
    ).resolves.toMatchObject({ status: "PARTIALLY_REFUNDED" });
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({ where: { id: refundId } }),
    ).resolves.toMatchObject({ reason: "EXPRESS_BREACH" });
  });

  it("reserves explicit payment balances without stranding split-payment adjustments", async () => {
    const fixture = await preparePaidOrder(
      "split-payment-adjustment",
      1,
      "DEPOSIT_BALANCE",
    );
    await advanceThroughQc(fixture, 0);
    const deposit = await prisma.payment.findUniqueOrThrow({
      where: { id: fixture.foundation.paymentId },
    });
    const balance = await prisma.payment.findFirstOrThrow({
      where: {
        orderId: fixture.foundation.orderId,
        role: "BALANCE",
      },
    });

    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `UPDATE payments
         SET status = 'CAPTURED', captured_amount_minor = requested_amount_minor,
             provider_intent_id = $3,
             provider_capture_id = $2, captured_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [
          balance.id,
          `split-capture-${balance.id}`,
          `split-intent-${balance.id}`,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const exhausted = await orders.createPriceAdjustment(
      fixture.foundation.orderId,
      {
        reason: "POST_DELIVERY_ISSUE",
        amountMinor: deposit.capturedAmountMinor!.toString(),
        paymentId: deposit.id,
        allocation: {
          component: "deposit",
          reason: "full deposit credit",
          slotCredits: [
            {
              fulfilmentSlotId: fixture.foundation.fulfilmentSlotIds[0]!,
              amountMinor: deposit.capturedAmountMinor!.toString(),
            },
          ],
        },
      },
      "split-exhaust-deposit-key",
    );
    const exhaustedRefund = await orders.refundAdjustment(
      fixture.foundation.orderId,
      exhausted.result.priceAdjustmentId as string,
      "split-exhaust-deposit-refund-key",
    );
    const exhaustedRefundId = (exhaustedRefund.result.refundIds as string[])[0];
    if (!exhaustedRefundId) {
      throw new Error("deposit refund was not created");
    }
    await succeedRefund(exhaustedRefundId);

    await expect(
      orders.createPriceAdjustment(
        fixture.foundation.orderId,
        {
          reason: "POST_DELIVERY_ISSUE",
          amountMinor: "1",
          paymentId: deposit.id,
          allocation: {
            component: "deposit",
            reason: "already exhausted",
            slotCredits: [
              {
                fulfilmentSlotId: fixture.foundation.fulfilmentSlotIds[0]!,
                amountMinor: "1",
              },
            ],
          },
        },
        "split-explicit-exhausted-key",
      ),
    ).rejects.toThrow(
      "Price adjustment exceeds the selected Payment refundable balance",
    );

    const unbound = await orders.createPriceAdjustment(
      fixture.foundation.orderId,
      {
        reason: "POST_DELIVERY_ISSUE",
        amountMinor: "1",
        allocation: {
          component: "order",
          reason: "use remaining balance",
          slotCredits: [
            {
              fulfilmentSlotId: fixture.foundation.fulfilmentSlotIds[0]!,
              amountMinor: "1",
            },
          ],
        },
      },
      "split-unbound-adjustment-key",
    );
    const unboundRefund = await orders.refundAdjustment(
      fixture.foundation.orderId,
      unbound.result.priceAdjustmentId as string,
      "split-unbound-refund-key",
    );
    const unboundRefundId = (unboundRefund.result.refundIds as string[])[0];
    if (!unboundRefundId) {
      throw new Error("unbound split-payment refund was not created");
    }
    await expect(
      prisma.refundTransaction.findUniqueOrThrow({
        where: { id: unboundRefundId },
      }),
    ).resolves.toMatchObject({ paymentId: balance.id, amountMinor: 1n });
  });

  it("caps cumulative manual credits at each fulfilment Slot settlement", async () => {
    const fixture = await preparePaidOrder("slot-credit-cap", 2);
    const slot = await prisma.fulfilmentSlot.findUniqueOrThrow({
      where: { id: fixture.foundation.fulfilmentSlotIds[0]! },
    });
    const first = await orders.createPriceAdjustment(
      fixture.foundation.orderId,
      {
        reason: "POST_DELIVERY_ISSUE",
        amountMinor: slot.settlementAmountMinor.toString(),
        allocation: {
          slotCredits: [
            {
              fulfilmentSlotId: slot.id,
              amountMinor: slot.settlementAmountMinor.toString(),
            },
          ],
        },
      },
      "slot-credit-cap-first",
    );
    const pending = await orders.refundAdjustment(
      fixture.foundation.orderId,
      first.result.priceAdjustmentId as string,
      "slot-credit-cap-refund",
    );
    const refundId = (pending.result.refundIds as string[])[0];
    if (!refundId) throw new Error("slot credit refund was not created");
    await succeedRefund(refundId);

    await expect(
      orders.createPriceAdjustment(
        fixture.foundation.orderId,
        {
          reason: "POST_DELIVERY_ISSUE",
          amountMinor: "1",
          allocation: {
            slotCredits: [{ fulfilmentSlotId: slot.id, amountMinor: "1" }],
          },
        },
        "slot-credit-cap-second",
      ),
    ).rejects.toThrow(
      "Price adjustment exceeds a fulfilment Slot settlement amount",
    );
  });

  it("caps express credits at each Slot's remaining active surcharge", async () => {
    const fixture = await preparePaidOrder("express-credit-cap", 2);
    const expressSlotId = fixture.foundation.fulfilmentSlotIds[0]!;
    const nonExpressSlotId = fixture.foundation.fulfilmentSlotIds[1]!;
    await markSlotPriceComponentExpress(expressSlotId);
    const expressRows = await pool.query<{
      fulfilment_slot_id: string;
      amount_minor: string;
      currency: string;
    }>(
      `SELECT allocation.fulfilment_slot_id,
              sum(allocation.amount_minor)::text AS amount_minor,
              snapshot.currency
       FROM order_active_price_bindings active_binding
       JOIN order_price_bindings binding
         ON binding.id = active_binding.order_price_binding_id
       JOIN price_snapshots snapshot ON snapshot.id = binding.price_snapshot_id
       JOIN price_snapshot_components component
         ON component.price_snapshot_id = snapshot.id
        AND component.kind = 'EXPRESS'
       JOIN price_component_fulfilment_allocations allocation
         ON allocation.price_snapshot_component_id = component.id
       WHERE active_binding.order_id = $1
       GROUP BY allocation.fulfilment_slot_id, snapshot.currency`,
      [fixture.foundation.orderId],
    );
    expect(expressRows.rows).toHaveLength(1);
    expect(expressRows.rows[0]?.fulfilment_slot_id).toBe(expressSlotId);
    const expressAmount = BigInt(expressRows.rows[0]!.amount_minor);

    await expect(
      orders.createPriceAdjustment(
        fixture.foundation.orderId,
        {
          reason: "EXPRESS_BREACH",
          amountMinor: "1",
          allocation: {
            slotCredits: [
              { fulfilmentSlotId: nonExpressSlotId, amountMinor: "1" },
            ],
          },
        },
        "express-credit-cap-non-express-slot",
      ),
    ).rejects.toThrow(
      "Price adjustment exceeds the remaining allocated express surcharge",
    );

    const first = await orders.createPriceAdjustment(
      fixture.foundation.orderId,
      {
        reason: "EXPRESS_BREACH",
        amountMinor: "1",
        allocation: { reason: "partial express deadline credit" },
      },
      "express-credit-cap-first",
    );
    await expect(
      prisma.priceAdjustment.findUniqueOrThrow({
        where: { id: first.result.priceAdjustmentId as string },
      }),
    ).resolves.toMatchObject({
      allocation: {
        slotCredits: [{ fulfilmentSlotId: expressSlotId, amountMinor: "1" }],
      },
    });

    await expect(
      orders.createPriceAdjustment(
        fixture.foundation.orderId,
        {
          reason: "EXPRESS_BREACH",
          amountMinor: expressAmount.toString(),
          allocation: { reason: "credit beyond remaining express surcharge" },
        },
        "express-credit-cap-second",
      ),
    ).rejects.toThrow(
      "Price adjustment exceeds the remaining allocated express surcharge",
    );

    await expect(
      pool.query(
        `INSERT INTO price_adjustments
           (id, order_id, idempotency_key, reason, amount_minor, currency, allocation)
         VALUES ($1, $2, $3, 'EXPRESS_BREACH', $4, $5, $6::jsonb)`,
        [
          randomUUID(),
          fixture.foundation.orderId,
          `direct-express-over-cap-${randomUUID()}`,
          expressAmount.toString(),
          expressRows.rows[0]!.currency,
          JSON.stringify({
            slotCredits: [
              {
                fulfilmentSlotId: expressSlotId,
                amountMinor: expressAmount.toString(),
              },
            ],
          }),
        ],
      ),
    ).rejects.toMatchObject({
      constraint: "price_adjustment_express_credit_cap_check",
    });
  });

  it("deducts a derived express slot credit from a post-delivery Claim", async () => {
    const fixture = await preparePaidOrder("post-delivery-claim");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
    await handoff(fixture, 0);
    await carrierEvent(fixture, 0, "TRANSIT_SCAN");
    await carrierEvent(fixture, 0, "DELIVERY_SCAN");
    await orders.completeOrder(
      fixture.foundation.orderId,
      "post-delivery-complete-key",
    );
    const slot = await prisma.fulfilmentSlot.findUniqueOrThrow({
      where: { id: fixture.foundation.fulfilmentSlotIds[0]! },
    });
    await markSlotPriceComponentExpress(slot.id);
    const priorCredit = await orders.createPriceAdjustment(
      fixture.foundation.orderId,
      {
        reason: "EXPRESS_BREACH",
        amountMinor: "1",
        allocation: { component: "express", reason: "deadline missed" },
      },
      "post-delivery-express-credit-key",
    );
    await expect(
      prisma.priceAdjustment.findUniqueOrThrow({
        where: { id: priorCredit.result.priceAdjustmentId as string },
      }),
    ).resolves.toMatchObject({
      allocation: {
        component: "express",
        slotCredits: [{ fulfilmentSlotId: slot.id, amountMinor: "1" }],
      },
    });
    const priorCreditRefund = await orders.refundAdjustment(
      fixture.foundation.orderId,
      priorCredit.result.priceAdjustmentId as string,
      "post-delivery-express-credit-refund-key",
    );
    const priorCreditRefundId = (
      priorCreditRefund.result.refundIds as string[]
    )[0];
    if (!priorCreditRefundId) {
      throw new Error("prior post-delivery refund was not created");
    }
    await succeedRefund(priorCreditRefundId);

    const opened = await orders.createClaim(
      fixture.foundation.orderId,
      {
        origin: "POST_DELIVERY_QUALITY",
        reason: "customer supplied verified evidence of a quality defect",
        fulfilmentSlotIds: [fixture.foundation.fulfilmentSlotIds[0]!],
        incidentShipmentId: fixture.foundation.shipmentId,
      },
      "post-delivery-claim-key",
    );
    const claimId = opened.result.claimId as string;
    const pending = await orders.refundClaim(
      fixture.foundation.orderId,
      claimId,
      "post-delivery-refund-key",
    );
    expect(pending.result.amountMinor).toBe(
      (slot.settlementAmountMinor - 1n).toString(),
    );
    await expect(
      prisma.priceAdjustment.findUniqueOrThrow({
        where: { id: pending.result.priceAdjustmentId as string },
      }),
    ).resolves.toMatchObject({
      allocation: {
        claimId,
        slotCredits: [
          {
            fulfilmentSlotId: slot.id,
            amountMinor: (slot.settlementAmountMinor - 1n).toString(),
          },
        ],
      },
    });
    const refundId = (pending.result.refundIds as string[])[0];
    if (!refundId) throw new Error("post-delivery refund was not created");
    await succeedRefund(refundId);

    await expect(
      prisma.order.findUniqueOrThrow({
        where: { id: fixture.foundation.orderId },
      }),
    ).resolves.toMatchObject({ status: "COMPLETED" });
    await expect(
      prisma.claim.findUniqueOrThrow({ where: { id: claimId } }),
    ).resolves.toMatchObject({
      status: "RESOLVED_REFUND",
      origin: "POST_DELIVERY_QUALITY",
    });
    await expect(
      prisma.fulfilmentSlot.findUniqueOrThrow({
        where: { id: fixture.foundation.fulfilmentSlotIds[0]! },
      }),
    ).resolves.toMatchObject({ outcome: "DELIVERED" });
  });

  it("subtracts pending refund commitments from a cancellation refund", async () => {
    const fixture = await preparePaidOrder("cancel-pending-refund");
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: fixture.foundation.paymentId },
    });
    const adjustment = await orders.createPriceAdjustment(
      fixture.foundation.orderId,
      {
        reason: "POST_DELIVERY_ISSUE",
        amountMinor: "1",
        paymentId: payment.id,
        allocation: {
          component: "express",
          reason: "deadline missed",
          slotCredits: [
            {
              fulfilmentSlotId: fixture.foundation.fulfilmentSlotIds[0]!,
              amountMinor: "1",
            },
          ],
        },
      },
      "cancel-pending-refund-adjustment",
    );
    const adjustmentRefund = await orders.refundAdjustment(
      fixture.foundation.orderId,
      adjustment.result.priceAdjustmentId as string,
      "cancel-pending-refund-dispatch",
    );
    const adjustmentRefundId = (
      adjustmentRefund.result.refundIds as string[]
    )[0];
    if (!adjustmentRefundId) {
      throw new Error("pending adjustment refund was not created");
    }

    const cancelled = await orders.cancelOrder(
      fixture.foundation.orderId,
      { reason: "cancel with an existing refund commitment" },
      "cancel-pending-refund-order",
    );
    const cancellationRefundId = (cancelled.result.refundIds as string[])[0];
    if (!cancellationRefundId) {
      throw new Error("remaining cancellation refund was not created");
    }

    await expect(
      prisma.refundTransaction.findUniqueOrThrow({
        where: { id: cancellationRefundId },
      }),
    ).resolves.toMatchObject({
      status: "PENDING",
      amountMinor: payment.capturedAmountMinor! - 1n,
    });
    const committed = await prisma.refundTransaction.findMany({
      where: {
        paymentId: payment.id,
        status: { in: ["PENDING", "SUSPENDED", "SUCCEEDED"] },
      },
      select: { amountMinor: true },
    });
    expect(
      committed.reduce((total, refund) => total + refund.amountMinor, 0n),
    ).toBe(payment.capturedAmountMinor);
  });

  it.each(["pre-print", "post-print", "post-QC"])(
    "cancels and requests a full refund %s",
    async (stage) => {
      const fixture = await preparePaidOrder(`cancel-${stage}`);
      const jobId = fixture.productions[0]!.jobId;
      const orderId = fixture.foundation.orderId;
      await orders.acceptJob(orderId, jobId, `${stage}-accept-key`);
      if (stage !== "pre-print") {
        await makeGcodeReady(jobId);
        await orders.startPrinting(orderId, jobId, `${stage}-printing-key`);
        await orders.finishPrinting(
          orderId,
          jobId,
          { actualMaterialMilligrams: "40" },
          `${stage}-printed-key`,
        );
      }
      if (stage === "post-QC") {
        await orders.submitQc(
          orderId,
          jobId,
          { omissionReason: "v0 QC" },
          `${stage}-qc-submit-key`,
        );
        await orders.approveQc(orderId, jobId, `${stage}-qc-approve-key`);
      }

      const cancelled = await orders.cancelOrder(
        orderId,
        { reason: `operator cancellation at ${stage}` },
        `${stage}-cancel-key`,
      );
      expect(cancelled.status).toBe("ORDER_CANCELLED");
      expect(cancelled.result.refundIds).toHaveLength(1);
      expect(
        await prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
      ).toMatchObject({ status: "CANCELLED" });
    },
  );

  it("settles active printing consumption before cancellation", async () => {
    const fixture = await preparePaidOrder("cancel-printing");
    const { orderId } = fixture.foundation;
    const jobId = fixture.productions[0]!.jobId;
    await orders.acceptJob(orderId, jobId, "cancel-printing-accept");
    await makeGcodeReady(jobId);
    await orders.startPrinting(orderId, jobId, "cancel-printing-start");

    await expect(
      orders.cancelOrder(
        orderId,
        { reason: "stop the active print" },
        "cancel-printing-missing-consumption",
      ),
    ).rejects.toThrow(
      "printingConsumptions must cover every actively printing Job",
    );
    const cancelled = await orders.cancelOrder(
      orderId,
      {
        reason: "stop the active print",
        printingConsumptions: [{ jobId, actualMaterialMilligrams: "25" }],
      },
      "cancel-printing-with-consumption",
    );

    expect(cancelled.status).toBe("ORDER_CANCELLED");
    await expect(
      prisma.productionReservation.findFirstOrThrow({ where: { jobId } }),
    ).resolves.toMatchObject({ status: "CONSUMED" });
    await expect(
      prisma.job.findUniqueOrThrow({ where: { id: jobId } }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
  });
});
