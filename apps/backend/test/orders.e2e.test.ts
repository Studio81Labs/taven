import { randomUUID } from "node:crypto";
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

async function advanceThroughQc(
  fixture: FulfilmentFixture,
  index: number,
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
    { omissionReason: "v0 operator visual inspection" },
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
  kind: "TRANSIT_SCAN" | "DELIVERY_SCAN" | "LOST" | "RETURNED",
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

    const failure = await orders.failJob(
      orderId,
      sourceJobId,
      {
        stage: "GCODE",
        reason: "production package could not be prepared",
        recovery: "REPLACE",
      },
      "replacement-failure",
    );
    const replacement = await orders.createReplacement(
      orderId,
      sourceJobId,
      {},
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
      orderBy: { createdAt: "asc" },
    });
    expect(reservations).toHaveLength(2);
    expect(reservations[0]?.status).toBe("RELEASED");
    expect(reservations[1]?.status).toBe("HELD");
    expect(reservations[1]?.id).not.toBe(reservations[0]?.id);
  });

  it("enforces parcel barriers and completes a delivered order once", async () => {
    const fixture = await preparePaidOrder("delivery");
    await advanceThroughQc(fixture, 0);
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
        allocation: { component: "express", reason: "deadline missed" },
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

  it("records and refunds a manual post-delivery Claim without rewinding completion", async () => {
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
});
