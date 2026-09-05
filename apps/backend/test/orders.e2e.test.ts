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
      parcelCount,
      undefined,
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

async function succeedRefund(refundId: string): Promise<void> {
  await pool.query(
    `SELECT taven_apply_checkout_refund_success(
       $1::uuid, $2, $3, clock_timestamp(), '{}'::jsonb
     )`,
    [refundId, `provider-refund-${refundId}`, `refund-success-${refundId}`],
  );
}

async function markSlotPriceComponentExpress(slotId: string): Promise<void> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const updated = await client.query(
      `UPDATE price_snapshot_components component
       SET kind = 'EXPRESS'
       FROM price_component_fulfilment_allocations allocation
       WHERE allocation.price_snapshot_component_id = component.id
         AND allocation.fulfilment_slot_id = $1
         AND component.kind = 'ORDER_MIN_PRINT'`,
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
    await orders.acceptJob(orderId, sourceJobId, "replacement-accept");
    await makeGcodeReady(sourceJobId);
    await orders.startPrinting(orderId, sourceJobId, "replacement-printing");
    await orders.finishPrinting(
      orderId,
      sourceJobId,
      { actualMaterialMilligrams: "50" },
      "replacement-printed",
    );

    const failure = await orders.failJob(
      orderId,
      sourceJobId,
      {
        stage: "POST_PRINT",
        reason: "printed part failed dimensional inspection",
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

    await expect(
      prisma.job.findUniqueOrThrow({ where: { id: replacementJobId } }),
    ).resolves.toMatchObject({ status: "QC_APPROVED" });
    await expect(
      prisma.productionReservation.findFirstOrThrow({
        where: { jobId: replacementJobId },
        include: { phaseReservationSet: true },
      }),
    ).resolves.toMatchObject({
      status: "CONSUMED",
      phaseReservationSet: { status: "SETTLED" },
    });
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
    ).rejects.toThrow("Shipment is not awaiting provider label cancellation");
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

  it("records cancellation-race handoff while an adjustment refund is pending", async () => {
    const fixture = await preparePaidOrder("acceptance-pending-adjustment");
    await advanceThroughQc(fixture, 0);
    await labelAndPack(fixture, 0);
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
        reason: "EXPRESS_BREACH",
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
          reason: "EXPRESS_BREACH",
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
        reason: "EXPRESS_BREACH",
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
        reason: "EXPRESS_BREACH",
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
          reason: "EXPRESS_BREACH",
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
        reason: "EXPRESS_BREACH",
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
