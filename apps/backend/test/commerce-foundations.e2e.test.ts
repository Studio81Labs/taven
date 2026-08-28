import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  PersistenceFactory,
  testTimes,
  type PersistenceFoundation,
  type ProductionReservationFixture,
} from "./support/persistence-factory";

const databaseUrl = process.env.DATABASE_URL;
const scope = `commerce-foundations-${randomUUID()}`;
let pool: Pool;

async function rollback<T>(
  name: string,
  work: (c: PoolClient, f: PersistenceFactory) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    return await work(
      client,
      new PersistenceFactory(client, `${scope}:${name}`),
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function expectQueryError(
  client: PoolClient,
  savepoint: string,
  work: () => Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(savepoint)) {
    throw new Error(`invalid savepoint name: ${savepoint}`);
  }
  await client.query(`SAVEPOINT "${savepoint}"`);
  try {
    await expect(work()).rejects.toMatchObject(expected);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT "${savepoint}"`);
    await client.query(`RELEASE SAVEPOINT "${savepoint}"`);
  }
}

async function advanceQuoteRequestToQuoted(
  client: PoolClient,
  quoteRequestId: string,
  updatedAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE quote_requests
     SET status = 'IN_REVIEW', updated_at = $2
     WHERE id = $1`,
    [quoteRequestId, updatedAt],
  );
  await client.query(
    `UPDATE quote_requests
     SET status = 'QUOTED', updated_at = $2
     WHERE id = $1`,
    [quoteRequestId, updatedAt],
  );
}

async function forceQuoteIssuanceConstraints(
  client: PoolClient,
): Promise<void> {
  await client.query(
    `SET CONSTRAINTS
       "quote_requests_issuance_reconciled",
       "quotes_request_issuance_reconciled",
       "quote_price_bindings_request_issuance_reconciled",
       "price_snapshots_total_reconciled",
       "price_snapshot_components_total_reconciled",
       "payment_schedules_total_reconciled" IMMEDIATE`,
  );
  await client.query(
    `SET CONSTRAINTS
       "quote_requests_issuance_reconciled",
       "quotes_request_issuance_reconciled",
       "quote_price_bindings_request_issuance_reconciled",
       "price_snapshots_total_reconciled",
       "price_snapshot_components_total_reconciled",
       "payment_schedules_total_reconciled" DEFERRED`,
  );
}

async function createCurrentPlan(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
  reservationExpiresAt = testTimes.expiresAt,
): Promise<
  Array<
    ProductionReservationFixture & {
      endsAt: Date;
      startsAt: Date;
    }
  >
> {
  const productions: Array<
    ProductionReservationFixture & {
      endsAt: Date;
      startsAt: Date;
    }
  > = [];
  for (const [index] of foundation.fulfilmentSlotIds.entries()) {
    const startsAt = new Date(
      testTimes.capacityStart.getTime() + index * 2 * 60 * 60 * 1_000,
    );
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1_000);
    const production = await fixtures.planProduction(
      foundation,
      `payment-plan-${foundation.orderId}-${index}`,
      { startsAt, endsAt },
      60,
      60,
      1,
      index,
    );
    productions.push({ ...production, startsAt, endsAt });
  }
  await fixtures.createResourcePlan(
    foundation,
    productions,
    reservationExpiresAt,
  );
  await client.query(
    `UPDATE inventories SET remaining_milligrams = 1000 WHERE id = $1`,
    [foundation.inventoryId],
  );
  await fixtures.createPhaseReservationSet(foundation, reservationExpiresAt);
  for (const [index, production] of productions.entries()) {
    await fixtures.createProductionReservation(
      foundation,
      production,
      "RESERVED",
      {},
      null,
      reservationExpiresAt,
    );
    await client.query(
      `INSERT INTO inventory_reservations (id, node_id, production_reservation_id,
                                          inventory_id, reserved_milligrams, expires_at,
                                          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [
        production.inventoryReservationId,
        foundation.nodeId,
        production.productionReservationId,
        foundation.inventoryId,
        production.requiredMaterialMilligrams,
        reservationExpiresAt,
        testTimes.createdAt,
      ],
    );
    await client.query(
      `INSERT INTO capacity_reservations (id, node_id, production_reservation_id,
                                         candidate_capacity_interval_id, machine_id,
                                         starts_at, ends_at, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        fixtures.id(`payment-capacity-${foundation.orderId}-${index}`),
        foundation.nodeId,
        production.productionReservationId,
        production.candidateCapacityIntervalId,
        foundation.machineId,
        production.startsAt,
        production.endsAt,
        reservationExpiresAt,
        testTimes.createdAt,
      ],
    );
  }
  await client.query(
    `UPDATE phase_reservation_sets SET status = 'RESERVED' WHERE id = $1`,
    [foundation.phaseReservationSetId],
  );
  return productions;
}

async function createCurrentPlanAndPayment(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
): Promise<
  Array<
    ProductionReservationFixture & {
      endsAt: Date;
      startsAt: Date;
    }
  >
> {
  const productions = await createCurrentPlan(client, fixtures, foundation);
  await fixtures.finalizePayment(foundation);
  return productions;
}

async function activateCurrentPlan(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
  productions: ProductionReservationFixture[],
): Promise<void> {
  for (const production of productions) {
    await client.query(
      `UPDATE inventory_reservations SET status = 'HELD'
       WHERE production_reservation_id = $1`,
      [production.productionReservationId],
    );
    await client.query(
      `UPDATE capacity_reservations SET status = 'HELD'
       WHERE production_reservation_id = $1`,
      [production.productionReservationId],
    );
    await fixtures.createJob(foundation, production);
    await client.query(
      `UPDATE production_reservations
       SET status = 'HELD', job_id = $2 WHERE id = $1`,
      [production.productionReservationId, production.jobId],
    );
  }
  await client.query(
    `UPDATE phase_reservation_sets SET status = 'HELD' WHERE id = $1`,
    [foundation.phaseReservationSetId],
  );
  await fixtures.activatePayment(foundation);
  await client.query(
    `SET CONSTRAINTS
       "payments_capture_activation_reconciled",
       "orders_capture_activation_reconciled",
       "order_phases_capture_activation_reconciled",
       "phase_reservation_sets_capture_activation_reconciled",
       "jobs_captured_reservation_reconciled" IMMEDIATE`,
  );
  await client.query(
    `SET CONSTRAINTS
       "payments_capture_activation_reconciled",
       "orders_capture_activation_reconciled",
       "order_phases_capture_activation_reconciled",
       "phase_reservation_sets_capture_activation_reconciled",
       "jobs_captured_reservation_reconciled" DEFERRED`,
  );
}

async function advanceOrderToCompleted(
  client: PoolClient,
  orderId: string,
): Promise<void> {
  for (const status of [
    "IN_PRODUCTION",
    "QC_PASSED",
    "READY_TO_SHIP",
    "SHIPPED",
    "DELIVERED",
    "COMPLETED",
  ] as const) {
    await advanceOrderLifecycleStep(client, orderId, status);
  }
}

async function forceOrderLifecycleConstraints(
  client: PoolClient,
): Promise<void> {
  await client.query(
    `SET CONSTRAINTS
       "orders_post_confirmation_lifecycle_reconciled",
       "orders_production_resource_start_reconciled",
       "orders_cancelled_reservations_reconciled",
       "phase_reservation_sets_cancelled_order_reconciled",
       "orders_quoted_cancellation_payments_reconciled",
       "orders_customer_cancellation_refund_reconciled",
       "payments_customer_cancellation_refund_reconciled",
       "refunds_customer_cancellation_order_reconciled",
       "orders_production_failure_reconciled",
       "jobs_production_failure_reconciled",
       "payments_production_failure_reconciled",
       "refunds_production_failure_reconciled",
       "order_phases_parent_lifecycle_reconciled",
       "jobs_parent_lifecycle_reconciled",
       "jobs_printing_reservation_group_reconciled",
       "production_reservations_job_printing_reconciled",
       "inventory_reservations_job_printing_reconciled",
       "capacity_reservations_job_printing_reconciled",
       "shipments_parent_lifecycle_reconciled",
       "fulfilment_slots_parent_lifecycle_reconciled",
       "fulfilment_slots_shipment_plan_terminal_reconciled",
       "shipments_fulfilment_slots_terminal_reconciled" IMMEDIATE`,
  );
  await client.query(
    `SET CONSTRAINTS
       "orders_post_confirmation_lifecycle_reconciled",
       "orders_production_resource_start_reconciled",
       "orders_cancelled_reservations_reconciled",
       "phase_reservation_sets_cancelled_order_reconciled",
       "orders_quoted_cancellation_payments_reconciled",
       "orders_customer_cancellation_refund_reconciled",
       "payments_customer_cancellation_refund_reconciled",
       "refunds_customer_cancellation_order_reconciled",
       "orders_production_failure_reconciled",
       "jobs_production_failure_reconciled",
       "payments_production_failure_reconciled",
       "refunds_production_failure_reconciled",
       "order_phases_parent_lifecycle_reconciled",
       "jobs_parent_lifecycle_reconciled",
       "jobs_printing_reservation_group_reconciled",
       "production_reservations_job_printing_reconciled",
       "inventory_reservations_job_printing_reconciled",
       "capacity_reservations_job_printing_reconciled",
       "shipments_parent_lifecycle_reconciled",
       "fulfilment_slots_parent_lifecycle_reconciled",
       "fulfilment_slots_shipment_plan_terminal_reconciled",
       "shipments_fulfilment_slots_terminal_reconciled" DEFERRED`,
  );
}

async function advanceAcceptedJobToGcodeReady(
  client: PoolClient,
  jobId: string,
  transitionedAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE jobs job
     SET status = 'GCODE_READY', gcode_ready_at = $2,
         production_slice_result_id = production.slice_result_id,
         production_artifact_hash = slice.artifact_hash,
         updated_at = $2
     FROM production_reservations production
     JOIN slice_results slice ON slice.id = production.slice_result_id
     WHERE job.id = $1
       AND production.job_id = job.id
       AND production.node_id = job.node_id
       AND production.phase_resource_plan_job_id = job.phase_resource_plan_job_id`,
    [jobId, transitionedAt],
  );
}

async function advanceOrderLifecycleStep(
  client: PoolClient,
  orderId: string,
  status:
    | "IN_PRODUCTION"
    | "QC_PASSED"
    | "READY_TO_SHIP"
    | "SHIPPED"
    | "DELIVERED"
    | "COMPLETED",
): Promise<void> {
  const transitionedAt = new Date();
  if (status === "IN_PRODUCTION") {
    await client.query(
      `UPDATE inventory_reservations inventory_reservation
       SET status = 'ALLOCATED'
       FROM production_reservations production
       JOIN jobs job ON job.id = production.job_id
       WHERE inventory_reservation.production_reservation_id = production.id
         AND job.order_id = $1
         AND inventory_reservation.status = 'HELD'`,
      [orderId],
    );
    await client.query(
      `UPDATE capacity_reservations capacity_reservation
       SET status = 'SCHEDULED'
       FROM production_reservations production
       JOIN jobs job ON job.id = production.job_id
       WHERE capacity_reservation.production_reservation_id = production.id
         AND job.order_id = $1
         AND capacity_reservation.status = 'HELD'`,
      [orderId],
    );
    await client.query(
      `UPDATE production_reservations production
       SET status = 'SCHEDULED'
       FROM jobs job
       WHERE job.id = production.job_id
         AND job.order_id = $1
         AND production.status = 'HELD'`,
      [orderId],
    );
    await client.query(
      `UPDATE capacity_reservations capacity_reservation
       SET status = 'PRINTING'
       FROM production_reservations production
       JOIN jobs job ON job.id = production.job_id
       WHERE capacity_reservation.production_reservation_id = production.id
         AND job.order_id = $1
         AND capacity_reservation.status = 'SCHEDULED'`,
      [orderId],
    );
    await client.query(
      `UPDATE production_reservations production
       SET status = 'PRINTING'
       FROM jobs job
       WHERE job.id = production.job_id
         AND job.order_id = $1
         AND production.status = 'SCHEDULED'`,
      [orderId],
    );
    await client.query(
      `UPDATE jobs
       SET status = 'ACCEPTED', accepted_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE jobs job
       SET status = 'GCODE_READY', gcode_ready_at = $2,
           production_slice_result_id = production.slice_result_id,
           production_artifact_hash = slice.artifact_hash,
           updated_at = $2
       FROM production_reservations production
       JOIN slice_results slice ON slice.id = production.slice_result_id
       WHERE job.order_id = $1
         AND production.job_id = job.id
         AND production.node_id = job.node_id
         AND production.phase_resource_plan_job_id = job.phase_resource_plan_job_id`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE jobs
       SET status = 'PRINTING', printing_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE order_phases
       SET status = 'IN_PRODUCTION', updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
  } else if (status === "QC_PASSED") {
    await client.query(
      `UPDATE inventory_reservations inventory_reservation
       SET status = 'CONSUMED',
           consumed_milligrams = inventory_reservation.reserved_milligrams,
           updated_at = $2
       FROM production_reservations production
       JOIN jobs job ON job.id = production.job_id
       WHERE inventory_reservation.production_reservation_id = production.id
         AND job.order_id = $1
         AND inventory_reservation.status = 'ALLOCATED'`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE capacity_reservations capacity_reservation
       SET status = 'COMPLETED', updated_at = $2
       FROM production_reservations production
       JOIN jobs job ON job.id = production.job_id
       WHERE capacity_reservation.production_reservation_id = production.id
         AND job.order_id = $1
         AND capacity_reservation.status = 'PRINTING'`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE production_reservations production
       SET status = 'CONSUMED', updated_at = $2
       FROM jobs job
       WHERE job.id = production.job_id
         AND job.order_id = $1
         AND production.status = 'PRINTING'`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE jobs
       SET status = 'PRINTED', printed_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
    await client.query(
      `INSERT INTO photo_assets (
           id, kind, scope_kind, scope_id, storage_object_key, content_hash,
           media_type, size_bytes, uploaded_at, photo_delete_after,
           retention_hold, created_at
       )
       SELECT job.id, 'QC', 'JOB', job.id, 'qc/' || job.id::text,
              repeat('b', 64), 'image/jpeg', 1, $2::timestamptz,
              $2::timestamptz + interval '90 days',
              'ACTIVE_ORDER', $2::timestamptz
       FROM jobs job
       WHERE job.order_id = $1`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE jobs
       SET status = 'PHOTO_SUBMITTED', photo_submitted_at = $2,
           qc_photo_asset_id = id, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE jobs
       SET status = 'QC_APPROVED', qc_approved_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE order_phases
       SET status = 'QC_PASSED', qc_passed_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
  } else if (status === "READY_TO_SHIP") {
    await client.query(
      `UPDATE jobs
       SET status = 'PACKED', packed_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE shipments
       SET status = 'LABEL_CREATED', carrier = 'test-carrier',
           provider_shipment_id = coalesce(provider_shipment_id, 'provider-' || id::text),
           tracking_code = coalesce(tracking_code, 'tracking-' || id::text),
           label_created_at = $2, updated_at = $2
       WHERE order_id = $1 AND status = 'PLANNED'`,
      [orderId, transitionedAt],
    );
  } else if (status === "SHIPPED") {
    await client.query(
      `UPDATE jobs
       SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE shipments
       SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
       WHERE order_id = $1 AND status = 'LABEL_CREATED'`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE order_phases
       SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
  } else if (status === "DELIVERED") {
    await client.query(
      `UPDATE shipments
       SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
       WHERE order_id = $1 AND status IN ('HANDED_OVER', 'IN_TRANSIT')`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE fulfilment_slots
       SET outcome = 'DELIVERED', updated_at = $2
       WHERE order_id = $1 AND outcome = 'PENDING'`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE order_phases
       SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
  } else {
    await client.query(
      `UPDATE phase_reservation_sets reservation_set
       SET status = 'SETTLED', updated_at = $2
       FROM phase_resource_plans resource_plan,
            order_phases phase
       WHERE reservation_set.phase_resource_plan_id = resource_plan.id
         AND reservation_set.node_id = resource_plan.node_id
         AND resource_plan.order_phase_id = phase.id
         AND phase.order_id = $1
         AND reservation_set.status = 'HELD'`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE jobs
       SET status = 'SETTLED', settled_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
    await client.query(
      `UPDATE order_phases
       SET status = 'COMPLETED', completed_at = $2, updated_at = $2
       WHERE order_id = $1`,
      [orderId, transitionedAt],
    );
  }

  await client.query(
    `UPDATE orders SET status = $2::order_status, updated_at = $3 WHERE id = $1`,
    [orderId, status, transitionedAt],
  );
  await forceOrderLifecycleConstraints(client);
}

async function cancelOrderBeforeHandoff(
  client: PoolClient,
  orderId: string,
  closePayments = true,
  closeSlots = true,
  orderStatus: "CANCELLED" | "EXPIRED" = "CANCELLED",
): Promise<void> {
  const cancelledAt = new Date();
  if (closePayments) {
    await client.query(
      `UPDATE payments
       SET status = CASE
             WHEN status IN ('CREATED', 'PENDING') THEN 'VOIDED'::payment_status
             ELSE status
           END,
           capture_authorized = false,
           capture_cutoff_at = coalesce(
             capture_cutoff_at,
             CASE WHEN $3::order_status = 'EXPIRED'
                  THEN checkout_capture_expires_at ELSE $2 END
           ),
           updated_at = $2
       WHERE order_id = $1
         AND captured_amount_minor IS NULL
         AND status IN ('CREATED', 'PENDING', 'FAILED', 'VOIDED')`,
      [orderId, cancelledAt, orderStatus],
    );
  }
  await client.query(
    `UPDATE inventory_reservations inventory_reservation
     SET status = 'RELEASED', updated_at = $2
     FROM production_reservations production,
          phase_resource_plans resource_plan,
          order_phases phase
     WHERE inventory_reservation.production_reservation_id = production.id
       AND inventory_reservation.node_id = production.node_id
       AND production.phase_resource_plan_id = resource_plan.id
       AND production.node_id = resource_plan.node_id
       AND resource_plan.order_phase_id = phase.id
       AND phase.order_id = $1
       AND inventory_reservation.status IN ('RESERVED', 'HELD', 'ALLOCATED')`,
    [orderId, cancelledAt],
  );
  await client.query(
    `UPDATE capacity_reservations capacity_reservation
     SET status = 'RELEASED', updated_at = $2
     FROM production_reservations production,
          phase_resource_plans resource_plan,
          order_phases phase
     WHERE capacity_reservation.production_reservation_id = production.id
       AND capacity_reservation.node_id = production.node_id
       AND production.phase_resource_plan_id = resource_plan.id
       AND production.node_id = resource_plan.node_id
       AND resource_plan.order_phase_id = phase.id
       AND phase.order_id = $1
       AND capacity_reservation.status IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')`,
    [orderId, cancelledAt],
  );
  await client.query(
    `UPDATE production_reservations production
     SET status = 'RELEASED', updated_at = $2
     FROM phase_resource_plans resource_plan,
          order_phases phase
     WHERE production.phase_resource_plan_id = resource_plan.id
       AND production.node_id = resource_plan.node_id
       AND resource_plan.order_phase_id = phase.id
       AND phase.order_id = $1
       AND production.status IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')`,
    [orderId, cancelledAt],
  );
  await client.query(
    `UPDATE phase_reservation_sets reservation_set
     SET status = 'RELEASED', updated_at = $2
     FROM phase_resource_plans resource_plan,
          order_phases phase
     WHERE reservation_set.phase_resource_plan_id = resource_plan.id
       AND reservation_set.node_id = resource_plan.node_id
       AND resource_plan.order_phase_id = phase.id
       AND phase.order_id = $1
       AND reservation_set.status IN ('BUILDING', 'RESERVED', 'HELD')`,
    [orderId, cancelledAt],
  );
  await client.query(
    `UPDATE jobs
     SET status = 'CANCELLED', cancelled_at = $2,
         cancellation_reason = 'ORDER_CANCELLED', updated_at = $2
     WHERE order_id = $1
       AND status NOT IN ('FAILED', 'QC_REJECTED')`,
    [orderId, cancelledAt],
  );
  await client.query(
    `UPDATE shipments
     SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2
     WHERE order_id = $1`,
    [orderId, cancelledAt],
  );
  if (closeSlots) {
    await client.query(
      `UPDATE fulfilment_slots
       SET outcome = 'CANCELLED', updated_at = $2
       WHERE order_id = $1 AND outcome = 'PENDING'`,
      [orderId, cancelledAt],
    );
  }
  await client.query(
    `UPDATE order_phases
     SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2
     WHERE order_id = $1`,
    [orderId, cancelledAt],
  );
  await client.query(
    `UPDATE orders
     SET status = $3::order_status, updated_at = $2 WHERE id = $1`,
    [orderId, cancelledAt, orderStatus],
  );
  await forceOrderLifecycleConstraints(client);
}

describe("commerce persistence foundations", () => {
  beforeAll(() => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for commerce E2E tests");
    }
    pool = new Pool({ connectionString: databaseUrl });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("builds a quoted automatic order with stable slots, binding-scoped plans, and a complete plan before payment", async () => {
    await rollback("automatic-multi-item", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "automatic-multi-item",
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        [
          { color: "red", quantity: 1 },
          {
            color: "red",
            quantity: 2,
            geometryBounds: {
              xMicrometers: 2,
              yMicrometers: 3,
              zMicrometers: 4,
            },
          },
        ],
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);

      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count
             FROM automatic_order_origins
             WHERE order_id = $1 AND quote_session_id = $2`,
            [foundation.orderId, foundation.quoteSessionId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count
             FROM individual_order_origins WHERE order_id = $1`,
            [foundation.orderId],
          )
        ).rows[0]?.count,
      ).toBe("0");
      const items = await client.query<{
        quantity: number;
        source_model_file_id: string;
      }>(
        `SELECT quantity, source_model_file_id
         FROM order_items WHERE order_id = $1 ORDER BY ordinal`,
        [foundation.orderId],
      );
      expect(items.rows).toEqual([
        { quantity: 1, source_model_file_id: foundation.modelFileId },
        { quantity: 2, source_model_file_id: foundation.modelFileId },
      ]);
      const itemTopology = await client.query<{
        geometries: string;
        configurations: string;
      }>(
        `SELECT count(DISTINCT model_geometry_id)::text AS geometries,
                count(DISTINCT print_config_revision_id)::text AS configurations
         FROM order_items WHERE order_id = $1`,
        [foundation.orderId],
      );
      expect(itemTopology.rows).toEqual([
        { geometries: "2", configurations: "2" },
      ]);
      expect(
        (
          await client.query(
            `SELECT quantity_ordinal
             FROM fulfilment_slots slot
             JOIN order_items item ON item.id = slot.order_item_id
             WHERE slot.order_phase_id = $1 ORDER BY item.ordinal, quantity_ordinal`,
            [foundation.orderPhaseId],
          )
        ).rows.map((row) => row.quantity_ordinal),
      ).toEqual([1, 1, 2]);
      expect(
        (
          await client.query<{
            order_item_id: string;
            phase_kind: string;
            quantity_ordinal: number;
            shipment_plan_id: string;
          }>(
            `SELECT slot.order_item_id, phase.kind::text AS phase_kind,
                    slot.quantity_ordinal, allocation.shipment_plan_id
             FROM fulfilment_slots slot
             JOIN order_items item ON item.id = slot.order_item_id
             JOIN order_phases phase ON phase.id = slot.order_phase_id
             JOIN shipment_plan_fulfilment_slots allocation
               ON allocation.fulfilment_slot_id = slot.id
              AND allocation.order_price_binding_id = $2
             WHERE slot.order_phase_id = $1
             ORDER BY item.ordinal, slot.quantity_ordinal`,
            [foundation.orderPhaseId, foundation.orderPriceBindingId],
          )
        ).rows,
      ).toEqual([
        {
          order_item_id: foundation.orderItemIds[0],
          phase_kind: "SINGLE",
          quantity_ordinal: 1,
          shipment_plan_id: foundation.shipmentPlanIds[0],
        },
        {
          order_item_id: foundation.orderItemIds[1],
          phase_kind: "SINGLE",
          quantity_ordinal: 1,
          shipment_plan_id: foundation.shipmentPlanIds[1],
        },
        {
          order_item_id: foundation.orderItemIds[1],
          phase_kind: "SINGLE",
          quantity_ordinal: 2,
          shipment_plan_id: foundation.shipmentPlanIds[1],
        },
      ]);
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count
             FROM shipment_plan_fulfilment_slots
             WHERE order_price_binding_id = $1`,
            [foundation.orderPriceBindingId],
          )
        ).rows[0]?.count,
      ).toBe("3");
      expect(
        (
          await client.query(
            `SELECT count(DISTINCT delivery_destination_id)::text AS count
             FROM shipment_plans WHERE order_id = $1`,
            [foundation.orderId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query<{
            address_snapshot: { country: string };
            capability_snapshot: { service: string };
            endpoint_type: string;
            provider_endpoint_id: string;
          }>(
            `SELECT provider_endpoint_id, endpoint_type,
                    address_snapshot, capability_snapshot
             FROM delivery_destinations WHERE id = $1`,
            [foundation.deliveryDestinationId],
          )
        ).rows,
      ).toEqual([
        {
          provider_endpoint_id: expect.stringMatching(/^endpoint-/),
          endpoint_type: "address",
          address_snapshot: { country: "CZ" },
          capability_snapshot: { service: "standard" },
        },
      ]);
      expect(
        (
          await client.query(
            `SELECT count(DISTINCT delivery_destination_id)::text AS count
             FROM shipments WHERE order_id = $1`,
            [foundation.orderId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      await expectQueryError(
        client,
        "delete_persisted_shipment",
        () =>
          client.query(`DELETE FROM shipments WHERE id = $1`, [
            foundation.shipmentIds[0],
          ]),
        { code: "23514", constraint: "shipment_topology_immutable_check" },
      );
      await expectQueryError(
        client,
        "rekey_persisted_shipment",
        () =>
          client.query(`UPDATE shipments SET id = $2 WHERE id = $1`, [
            foundation.shipmentIds[0],
            fixtures.id("rekeyed-shipment"),
          ]),
        { code: "23514", constraint: "shipment_topology_immutable_check" },
      );
      await expectQueryError(
        client,
        "rewrite_shipment_creation_time",
        () =>
          client.query(
            `UPDATE shipments
             SET created_at = created_at + interval '1 millisecond'
             WHERE id = $1`,
            [foundation.shipmentIds[0]],
          ),
        { code: "23514", constraint: "shipment_topology_immutable_check" },
      );
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count
             FROM price_snapshot_components
             WHERE price_snapshot_id = $1 AND kind = 'ORDER_MIN_PRINT'`,
            [foundation.priceSnapshotId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count
             FROM price_snapshot_components
             WHERE price_snapshot_id = $1 AND kind = 'ORDER_SMALL_SURCHARGE'`,
            [foundation.priceSnapshotId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count FROM payments WHERE order_id = $1`,
            [foundation.orderId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(
        (
          await client.query(
            `SELECT count(*)::text AS count FROM jobs WHERE order_id = $1`,
            [foundation.orderId],
          )
        ).rows[0]?.count,
      ).toBe("0");
    });
  });

  it("freezes order ownership after initial anonymous draft attachment", async () => {
    await rollback("order-ownership", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("ownership-source");
      const createdAt = new Date();
      const otherCustomerId = fixtures.id("ownership-other-customer");
      await client.query(
        `INSERT INTO customers
           (id, email, display_name, first_seen_at, created_at, updated_at)
         VALUES ($1,$2,'Other owner',$3,$3,$3)`,
        [otherCustomerId, `other-${randomUUID()}@example.test`, createdAt],
      );

      const anonymousSessionId = fixtures.id("anonymous-owner-session");
      const anonymousOrderId = fixtures.id("anonymous-owner-order");
      await client.query(
        `INSERT INTO quote_sessions
           (id, public_token_hash, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$4)`,
        [
          anonymousSessionId,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          new Date(Date.now() + 60 * 60 * 1_000),
          createdAt,
        ],
      );
      await client.query(
        `INSERT INTO orders (id, public_reference, status, created_at, updated_at)
         VALUES ($1,$2,'DRAFT',$3,$3)`,
        [anonymousOrderId, `T-${randomUUID()}`, createdAt],
      );
      await client.query(
        `INSERT INTO automatic_order_origins (order_id, quote_session_id)
         VALUES ($1,$2)`,
        [anonymousOrderId, anonymousSessionId],
      );
      await client.query(`UPDATE orders SET customer_id = $2 WHERE id = $1`, [
        anonymousOrderId,
        foundation.customerId,
      ]);
      await client.query(
        `SET CONSTRAINTS "orders_require_exactly_one_origin",
                         "automatic_order_origins_require_exactly_one_origin" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "orders_require_exactly_one_origin",
                         "automatic_order_origins_require_exactly_one_origin" DEFERRED`,
      );

      for (const [name, nextCustomerId] of [
        ["reassign_owned_order", otherCustomerId],
        ["orphan_owned_order", null],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            client.query(`UPDATE orders SET customer_id = $2 WHERE id = $1`, [
              anonymousOrderId,
              nextCustomerId,
            ]),
          {
            code: "23514",
            constraint: "order_customer_ownership_immutable_check",
          },
        );
      }

      const topologySessionId = fixtures.id("anonymous-topology-session");
      const topologyOrderId = fixtures.id("anonymous-topology-order");
      await client.query(
        `INSERT INTO quote_sessions
           (id, public_token_hash, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$4)`,
        [
          topologySessionId,
          randomUUID().replaceAll("-", "").padEnd(64, "1"),
          new Date(Date.now() + 60 * 60 * 1_000),
          createdAt,
        ],
      );
      await client.query(
        `INSERT INTO orders (id, public_reference, status, created_at, updated_at)
         VALUES ($1,$2,'DRAFT',$3,$3)`,
        [topologyOrderId, `T-${randomUUID()}`, createdAt],
      );
      await client.query(
        `INSERT INTO automatic_order_origins (order_id, quote_session_id)
         VALUES ($1,$2)`,
        [topologyOrderId, topologySessionId],
      );
      await client.query(
        `INSERT INTO order_items
           (id, order_id, ordinal, source_model_file_id, model_geometry_id,
            print_config_revision_id, material, color, quantity, created_at)
         VALUES ($1,$2,0,$3,$4,$5,'PLA','red',1,$6)`,
        [
          fixtures.id("anonymous-topology-item"),
          topologyOrderId,
          foundation.modelFileId,
          foundation.modelGeometryId,
          foundation.printConfigRevisionId,
          createdAt,
        ],
      );
      await expectQueryError(
        client,
        "attach_owner_after_item_topology",
        () =>
          client.query(`UPDATE orders SET customer_id = $2 WHERE id = $1`, [
            topologyOrderId,
            foundation.customerId,
          ]),
        {
          code: "23514",
          constraint: "order_customer_ownership_immutable_check",
        },
      );

      for (const topology of ["delivery-destination", "order-phase"] as const) {
        const sessionId = fixtures.id(`${topology}-ownership-session`);
        const orderId = fixtures.id(`${topology}-ownership-order`);
        await client.query(
          `INSERT INTO quote_sessions
             (id, public_token_hash, expires_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$4)`,
          [
            sessionId,
            randomUUID().replaceAll("-", "").padEnd(64, "3"),
            new Date(Date.now() + 60 * 60 * 1_000),
            createdAt,
          ],
        );
        await client.query(
          `INSERT INTO orders (id, public_reference, status, created_at, updated_at)
           VALUES ($1,$2,'DRAFT',$3,$3)`,
          [orderId, `T-${randomUUID()}`, createdAt],
        );
        await client.query(
          `INSERT INTO automatic_order_origins (order_id, quote_session_id)
           VALUES ($1,$2)`,
          [orderId, sessionId],
        );
        if (topology === "delivery-destination") {
          await client.query(
            `INSERT INTO delivery_destinations
               (id, order_id, provider_endpoint_id, endpoint_type,
                address_snapshot, capability_snapshot, created_at)
             VALUES ($1,$2,'endpoint','HOME','{}'::jsonb,'{}'::jsonb,$3)`,
            [fixtures.id("ownership-destination"), orderId, createdAt],
          );
        } else {
          await client.query(
            `INSERT INTO order_phases
               (id, order_id, kind, status, created_at, updated_at)
             VALUES ($1,$2,'SINGLE','QUOTED',$3,$3)`,
            [fixtures.id("ownership-phase"), orderId, createdAt],
          );
        }
        await expectQueryError(
          client,
          `attach_owner_after_${topology.replaceAll("-", "_")}`,
          () =>
            client.query(`UPDATE orders SET customer_id = $2 WHERE id = $1`, [
              orderId,
              foundation.customerId,
            ]),
          {
            code: "23514",
            constraint: "order_customer_ownership_immutable_check",
          },
        );
      }

      const ownedSessionId = fixtures.id("owned-session");
      await client.query(
        `INSERT INTO quote_sessions
           (id, customer_id, public_token_hash, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          ownedSessionId,
          foundation.customerId,
          randomUUID().replaceAll("-", "").padEnd(64, "2"),
          new Date(Date.now() + 60 * 60 * 1_000),
          createdAt,
        ],
      );
      await expectQueryError(
        client,
        "owned_session_anonymous_order",
        async () => {
          const mismatchedOrderId = fixtures.id(
            "owned-session-anonymous-order",
          );
          await client.query(
            `INSERT INTO orders
               (id, public_reference, status, created_at, updated_at)
             VALUES ($1,$2,'DRAFT',$3,$3)`,
            [mismatchedOrderId, `T-${randomUUID()}`, createdAt],
          );
          await client.query(
            `INSERT INTO automatic_order_origins (order_id, quote_session_id)
             VALUES ($1,$2)`,
            [mismatchedOrderId, ownedSessionId],
          );
        },
        {
          code: "23514",
          constraint: "automatic_order_origin_owner_check",
        },
      );
    });
  });

  it("reconciles immutable price components and freezes automatic commerce after payment intent creation", async () => {
    await rollback("immutable-pricing", async (client, fixtures) => {
      const boundDraft = await fixtures.createFoundation(
        "bound-draft-pricing",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      const boundDraftMutationError = {
        code: "23514",
        constraint: "order_item_price_binding_immutable_check",
      };
      await expectQueryError(
        client,
        "bound_draft_order_item_insert",
        () =>
          client.query(
            `INSERT INTO order_items (id, order_id, ordinal, source_model_file_id,
                                     model_geometry_id, print_config_revision_id,
                                     material, color, quantity, created_at)
             VALUES ($1,$2,99,$3,$4,$5,'PLA','green',1,$6)`,
            [
              fixtures.id("bound-draft-late-item"),
              boundDraft.orderId,
              boundDraft.modelFileId,
              boundDraft.modelGeometryId,
              boundDraft.printConfigRevisionId,
              new Date(),
            ],
          ),
        boundDraftMutationError,
      );
      await expectQueryError(
        client,
        "bound_draft_order_item_update",
        () =>
          client.query(`UPDATE order_items SET color = 'green' WHERE id = $1`, [
            boundDraft.orderItemId,
          ]),
        boundDraftMutationError,
      );
      await expectQueryError(
        client,
        "bound_draft_order_item_delete",
        () =>
          client.query(`DELETE FROM order_items WHERE id = $1`, [
            boundDraft.orderItemId,
          ]),
        boundDraftMutationError,
      );

      const foundation = await fixtures.createFoundation("immutable-pricing");
      await expectQueryError(
        client,
        "quoted_order_item_insert",
        () =>
          client.query(
            `INSERT INTO order_items (id, order_id, ordinal, source_model_file_id,
                                     model_geometry_id, print_config_revision_id,
                                     material, color, quantity, created_at)
             VALUES ($1,$2,99,$3,$4,$5,'PLA','green',1,$6)`,
            [
              fixtures.id("late-order-item"),
              foundation.orderId,
              foundation.modelFileId,
              foundation.modelGeometryId,
              foundation.printConfigRevisionId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "order_item_price_binding_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "quoted_fulfilment_slot_insert",
        () =>
          client.query(
            `INSERT INTO fulfilment_slots (id, order_id, order_phase_id, order_item_id,
                                           quantity_ordinal, settlement_amount_minor,
                                           created_at, updated_at)
             VALUES ($1,$2,$3,$4,2,0,$5,$5)`,
            [
              fixtures.id("late-quoted-slot"),
              foundation.orderId,
              foundation.orderPhaseId,
              foundation.orderItemId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "fulfilment_slot_topology_immutable_check",
        },
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);
      await expectQueryError(
        client,
        "paid_fulfilment_slot_insert",
        () =>
          client.query(
            `INSERT INTO fulfilment_slots (id, order_id, order_phase_id, order_item_id,
                                           quantity_ordinal, settlement_amount_minor,
                                           created_at, updated_at)
             VALUES ($1,$2,$3,$4,2,0,$5,$5)`,
            [
              fixtures.id("late-paid-slot"),
              foundation.orderId,
              foundation.orderPhaseId,
              foundation.orderItemId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "fulfilment_slot_topology_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "paid_shipment_plan_insert",
        () =>
          client.query(
            `INSERT INTO shipment_plans (id, order_id, order_phase_id,
                                        price_snapshot_id, order_price_binding_id,
                                        delivery_destination_id, ordinal, category,
                                        planned_volume_cubic_mm,
                                        planned_weight_milligrams,
                                        shipping_amount_minor, packaging_amount_minor,
                                        handling_amount_minor, allocation_snapshot, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,99,'standard',1,1,0,0,0,'{}'::jsonb,$7)`,
            [
              fixtures.id("late-paid-shipment-plan"),
              foundation.orderId,
              foundation.orderPhaseId,
              foundation.priceSnapshotId,
              foundation.orderPriceBindingId,
              foundation.deliveryDestinationId,
              new Date(),
            ],
          ),
        { code: "23514", constraint: "shipment_plan_payment_guard" },
      );
      await expectQueryError(
        client,
        "restore_paid_order_draft",
        () =>
          client.query(`UPDATE orders SET status = 'DRAFT' WHERE id = $1`, [
            foundation.orderId,
          ]),
        { code: "23514", constraint: "order_status_transition_check" },
      );
      expect(
        (
          await client.query<{ kind: string; scope: string }>(
            `SELECT kind::text, scope::text
             FROM price_snapshot_components
             WHERE price_snapshot_id = $1 ORDER BY kind`,
            [foundation.priceSnapshotId],
          )
        ).rows,
      ).toEqual([
        { kind: "ITEM_POSTPROCESSING", scope: "ORDER_ITEM" },
        { kind: "ITEM_PRODUCTION", scope: "ORDER_ITEM" },
        { kind: "ITEM_QUANTITY", scope: "ORDER_ITEM" },
        { kind: "ORDER_MIN_PRINT", scope: "ORDER" },
        { kind: "ORDER_SMALL_SURCHARGE", scope: "ORDER" },
        { kind: "SHIPMENT", scope: "SHIPMENT_PLAN" },
      ]);
      await expectQueryError(
        client,
        "immutable_snapshot",
        () =>
          client.query(
            `UPDATE price_snapshots SET contract_total_minor = 999 WHERE id = $1`,
            [foundation.priceSnapshotId],
          ),
        { code: "23514" },
      );
      await expectQueryError(
        client,
        "immutable_schedule",
        () =>
          client.query(
            `UPDATE payment_schedules SET gross_amount_minor = 999 WHERE id = $1`,
            [foundation.paymentScheduleId],
          ),
        { code: "23514" },
      );
      await expectQueryError(
        client,
        "immutable_audit",
        () =>
          client.query(`DELETE FROM audit_events WHERE order_id = $1`, [
            foundation.orderId,
          ]),
        { code: "23514" },
      );
      await expectQueryError(
        client,
        "immutable_destination",
        () =>
          client.query(
            `UPDATE delivery_destinations
             SET capability_snapshot = '{"service":"express"}'::jsonb
             WHERE id = $1`,
            [foundation.deliveryDestinationId],
          ),
        { code: "23514" },
      );
      await expectQueryError(
        client,
        "immutable_order_item",
        () =>
          client.query(`UPDATE order_items SET color = 'green' WHERE id = $1`, [
            foundation.orderItemId,
          ]),
        {
          code: "23514",
          constraint: "order_item_price_binding_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "stable_slot",
        () =>
          client.query(
            `UPDATE fulfilment_slots SET settlement_amount_minor = 1 WHERE id = $1`,
            [foundation.fulfilmentSlotId],
          ),
        {
          code: "23514",
          constraint: "fulfilment_slot_settlement_payment_guard",
        },
      );
    });
  });

  it("requires allocated item-level price components for every order item", async () => {
    await rollback("item-price-coverage", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "item-price-coverage",
        {},
        undefined,
        undefined,
        undefined,
        2,
        [{}, { priced: false }],
      );
      await createCurrentPlan(client, fixtures, foundation);

      await expectQueryError(
        client,
        "unpriced_order_item_payment",
        () => fixtures.finalizePayment(foundation),
        {
          code: "23514",
          constraint: "order_item_price_component_coverage_check",
        },
      );
    });
  });

  it("serializes binding invalidation and active moves with payment insertion", async () => {
    const setup = await pool.connect();
    const paying = await pool.connect();
    const mutating = await pool.connect();
    try {
      const fixtures = new PersistenceFactory(
        setup,
        `${scope}:binding-payment-concurrency`,
      );
      await setup.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "binding-payment-concurrency",
      );
      await createCurrentPlan(setup, fixtures, foundation);
      const replacementSnapshotId = fixtures.id(
        "binding-payment-concurrency:replacement-snapshot",
      );
      const replacementBindingId = fixtures.id(
        "binding-payment-concurrency:replacement-binding",
      );
      const replacementSnapshotHash = randomUUID()
        .replaceAll("-", "")
        .repeat(2);
      await setup.query(
        `INSERT INTO price_snapshots
           (id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,'EUR',0,'concurrency-v0','{}'::jsonb,$2,$3)`,
        [replacementSnapshotId, replacementSnapshotHash, new Date()],
      );
      await setup.query(
        `INSERT INTO payment_schedules
           (id, price_snapshot_id, sequence, role, gross_amount_minor,
            fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
         VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
        [
          fixtures.id("binding-payment-concurrency:replacement-schedule"),
          replacementSnapshotId,
          new Date(),
        ],
      );
      await setup.query(
        `INSERT INTO order_price_bindings
           (id, order_id, price_snapshot_id, delivery_destination_id, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          replacementBindingId,
          foundation.orderId,
          replacementSnapshotId,
          foundation.deliveryDestinationId,
          new Date(),
        ],
      );
      await setup.query("COMMIT");

      const payingFixtures = new PersistenceFactory(
        paying,
        `${scope}:binding-payment-concurrency`,
      );
      await paying.query("BEGIN");
      await payingFixtures.finalizePayment(foundation);

      await mutating.query("BEGIN");
      await mutating.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        mutating.query(
          `UPDATE order_price_bindings SET invalidated_at = $2 WHERE id = $1`,
          [foundation.orderPriceBindingId, new Date()],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await mutating.query("ROLLBACK");

      await mutating.query("BEGIN");
      await mutating.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        mutating.query(
          `UPDATE order_active_price_bindings
           SET order_price_binding_id = $2 WHERE order_id = $1`,
          [foundation.orderId, replacementBindingId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await mutating.query("ROLLBACK");
      await paying.query("COMMIT");

      await setup.query("BEGIN");
      await expect(
        setup.query(
          `UPDATE order_price_bindings SET invalidated_at = $2 WHERE id = $1`,
          [foundation.orderPriceBindingId, new Date()],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "order_price_binding_payment_guard",
      });
      await setup.query("ROLLBACK");

      await setup.query("BEGIN");
      await expect(
        setup.query(
          `UPDATE order_active_price_bindings
           SET order_price_binding_id = $2 WHERE order_id = $1`,
          [foundation.orderId, replacementBindingId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "active_order_price_binding_payment_guard",
      });
      await setup.query("ROLLBACK");
    } finally {
      await setup.query("ROLLBACK").catch(() => undefined);
      await paying.query("ROLLBACK").catch(() => undefined);
      await mutating.query("ROLLBACK").catch(() => undefined);
      setup.release();
      paying.release();
      mutating.release();
    }
  });

  it("binds item reference slices to their exact geometry and print configuration", async () => {
    await rollback("reference-slice-inputs", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "reference-slice-inputs",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [
          {
            geometryBounds: {
              xMicrometers: 1,
              yMicrometers: 2,
              zMicrometers: 3,
            },
          },
          {
            geometryBounds: {
              xMicrometers: 4,
              yMicrometers: 5,
              zMicrometers: 6,
            },
          },
        ],
        "DRAFT",
      );
      const matchingReferenceId = fixtures.id("matching-reference");
      const wrongGeometryReferenceId = fixtures.id("wrong-geometry-reference");
      const wrongConfigReferenceId = fixtures.id("wrong-config-reference");
      const referenceInputs = [
        {
          id: matchingReferenceId,
          geometryId: foundation.modelGeometryIds[0]!,
          configId: foundation.printConfigRevisionIds[0]!,
          name: "matching",
        },
        {
          id: wrongGeometryReferenceId,
          geometryId: foundation.modelGeometryIds[1]!,
          configId: foundation.printConfigRevisionIds[0]!,
          name: "wrong-geometry",
        },
        {
          id: wrongConfigReferenceId,
          geometryId: foundation.modelGeometryIds[0]!,
          configId: foundation.printConfigRevisionIds[1]!,
          name: "wrong-config",
        },
      ];
      for (const reference of referenceInputs) {
        await client.query(
          `INSERT INTO slice_results (id, kind, cache_key, model_geometry_id,
                                     print_config_revision_id, reference_profile_id,
                                     parts_per_plate, artifact_object_key, artifact_hash,
                                     estimated_print_seconds, estimated_material_milligrams,
                                     slicer_engine, slicer_version, created_at)
           SELECT $1, 'REFERENCE', $2, $3, $4, profile.reference_profile_id,
                  production.parts_per_plate, $5, production.artifact_hash,
                  production.estimated_print_seconds,
                  production.estimated_material_milligrams,
                  reference_profile.slicer_engine,
                  reference_profile.slicer_version, $6
           FROM slice_results production
           JOIN machine_profiles profile ON profile.id = production.machine_profile_id
           JOIN reference_profiles reference_profile
             ON reference_profile.id = profile.reference_profile_id
           WHERE production.id = $7`,
          [
            reference.id,
            `reference-${reference.name}-${reference.id}`,
            reference.geometryId,
            reference.configId,
            `reference/${reference.name}/${reference.id}`,
            new Date(),
            foundation.sliceResultId,
          ],
        );
      }

      const mutableQuoteRequestId = fixtures.id(
        "reference-inputs:quote-request",
      );
      const mutableQuoteId = fixtures.id("reference-inputs:quote");
      const quoteCreatedAt = new Date();
      await client.query(
        `INSERT INTO quote_requests
           (id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,'NEW',$3,$3)`,
        [mutableQuoteRequestId, foundation.customerId, quoteCreatedAt],
      );
      await advanceQuoteRequestToQuoted(
        client,
        mutableQuoteRequestId,
        quoteCreatedAt,
      );
      await client.query(
        `INSERT INTO quotes
           (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          mutableQuoteId,
          mutableQuoteRequestId,
          foundation.customerId,
          new Date(quoteCreatedAt.getTime() + 60 * 60 * 1_000),
          quoteCreatedAt,
        ],
      );
      const mutableOrderId = fixtures.id("reference-inputs:order");
      const mutableQuoteSessionId = fixtures.id(
        "reference-inputs:quote-session",
      );
      await client.query(
        `INSERT INTO quote_sessions
           (id, customer_id, public_token_hash, expires_at,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          mutableQuoteSessionId,
          foundation.customerId,
          "e".repeat(64),
          new Date(quoteCreatedAt.getTime() + 60 * 60 * 1_000),
          quoteCreatedAt,
        ],
      );
      await client.query(
        `INSERT INTO orders
           (id, customer_id, public_reference, status, created_at, updated_at)
         VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
        [
          mutableOrderId,
          foundation.customerId,
          `R-${randomUUID()}`,
          quoteCreatedAt,
        ],
      );
      await client.query(
        `INSERT INTO automatic_order_origins (order_id, quote_session_id)
         VALUES ($1,$2)`,
        [mutableOrderId, mutableQuoteSessionId],
      );

      for (const table of ["quote_items", "order_items"] as const) {
        const parentColumn = table === "quote_items" ? "quote_id" : "order_id";
        const parentId =
          table === "quote_items" ? mutableQuoteId : mutableOrderId;
        const constraint =
          table === "quote_items"
            ? "quote_item_reference_slice_input_check"
            : "order_item_reference_slice_input_check";
        const insertItem = (
          id: string,
          ordinal: number,
          referenceSliceId: string,
          geometryId = foundation.modelGeometryIds[0]!,
          configId = foundation.printConfigRevisionIds[0]!,
        ) =>
          client.query(
            `INSERT INTO ${table} (id, ${parentColumn}, ordinal,
                                  source_model_file_id, model_geometry_id,
                                  print_config_revision_id, reference_slice_result_id,
                                  material, color, quantity, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'PLA','black',1,$8)`,
            [
              id,
              parentId,
              ordinal,
              foundation.modelFileId,
              geometryId,
              configId,
              referenceSliceId,
              new Date(),
            ],
          );

        await expect(
          insertItem(
            fixtures.id(`${table}:matching-reference-item`),
            2,
            matchingReferenceId,
          ),
        ).resolves.toBeDefined();
        await expectQueryError(
          client,
          `${table}_production_reference`,
          () =>
            insertItem(
              fixtures.id(`${table}:production-reference-item`),
              3,
              foundation.sliceResultId,
            ),
          { code: "23514", constraint },
        );
        await expectQueryError(
          client,
          `${table}_wrong_geometry_reference`,
          () =>
            insertItem(
              fixtures.id(`${table}:wrong-geometry-reference-item`),
              4,
              wrongGeometryReferenceId,
            ),
          { code: "23514", constraint },
        );
        await expectQueryError(
          client,
          `${table}_wrong_config_reference`,
          () =>
            insertItem(
              fixtures.id(`${table}:wrong-config-reference-item`),
              5,
              wrongConfigReferenceId,
            ),
          { code: "23514", constraint },
        );
        if (table === "order_items") {
          await expectQueryError(
            client,
            "order_item_reference_update_bypass",
            () =>
              client.query(
                `UPDATE order_items
                 SET reference_slice_result_id = $2
                 WHERE id = $1`,
                [
                  fixtures.id(`${table}:matching-reference-item`),
                  foundation.sliceResultId,
                ],
              ),
            { code: "23514", constraint },
          );
        }
      }

      const mutableSnapshotId = fixtures.id("reference-inputs:price-snapshot");
      await client.query(
        `INSERT INTO price_snapshots
           (id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,'EUR',0,'reference-inputs-v0','{}'::jsonb,$2,$3)`,
        [mutableSnapshotId, "6".repeat(64), quoteCreatedAt],
      );
      await client.query(
        `INSERT INTO payment_schedules
           (id, price_snapshot_id, sequence, role, gross_amount_minor,
            fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
         VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
        [
          fixtures.id("reference-inputs:payment-schedule"),
          mutableSnapshotId,
          quoteCreatedAt,
        ],
      );
      await client.query(
        `INSERT INTO quote_price_bindings (quote_id, price_snapshot_id)
         VALUES ($1,$2)`,
        [mutableQuoteId, mutableSnapshotId],
      );
      await forceQuoteIssuanceConstraints(client);
    });
  });

  it("revalidates source availability when a draft item selects another geometry", async () => {
    await rollback("draft-item-source-update", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "draft-item-source-update",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      const mutableSessionId = fixtures.id("source-update:quote-session");
      const mutableOrderId = fixtures.id("source-update:order");
      const mutableItemId = fixtures.id("source-update:item");
      const mutableCreatedAt = new Date();
      await client.query(
        `INSERT INTO quote_sessions
           (id, customer_id, public_token_hash, expires_at,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          mutableSessionId,
          foundation.customerId,
          "a".repeat(64),
          new Date(mutableCreatedAt.getTime() + 60 * 60 * 1_000),
          mutableCreatedAt,
        ],
      );
      await client.query(
        `INSERT INTO orders
           (id, customer_id, public_reference, status, created_at, updated_at)
         VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
        [
          mutableOrderId,
          foundation.customerId,
          `S-${randomUUID()}`,
          mutableCreatedAt,
        ],
      );
      await client.query(
        `INSERT INTO automatic_order_origins (order_id, quote_session_id)
         VALUES ($1,$2)`,
        [mutableOrderId, mutableSessionId],
      );
      await client.query(
        `INSERT INTO order_items
           (id, order_id, ordinal, source_model_file_id, model_geometry_id,
            print_config_revision_id, material, color, quantity, created_at)
         VALUES ($1,$2,0,$3,$4,$5,'PLA','red',1,$6)`,
        [
          mutableItemId,
          mutableOrderId,
          foundation.modelFileId,
          foundation.modelGeometryId,
          foundation.printConfigRevisionId,
          mutableCreatedAt,
        ],
      );
      const expiredSourceId = fixtures.id("expired-update-source");
      const expiredGeometryId = fixtures.id("expired-update-geometry");
      const uploadedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
      const deleteAfter = new Date(Date.now() - 24 * 60 * 60 * 1_000);
      await client.query(
        `INSERT INTO model_files (id, format, original_filename,
                                 storage_object_key, content_hash, size_bytes,
                                 uploaded_at, source_delete_after, retention_hold)
         VALUES ($1,'STL','expired.stl',$2,$3,1,$4,$5,'ACTIVE_ORDER')`,
        [
          expiredSourceId,
          `models/${expiredSourceId}.stl`,
          "f".repeat(64),
          uploadedAt,
          deleteAfter,
        ],
      );
      await client.query(
        `INSERT INTO model_geometries
           (id, source_model_file_id, canonical_object_key, geometry_hash,
            canonicalizer_revision, volume_cubic_micrometers,
            bounds_x_micrometers, bounds_y_micrometers,
            bounds_z_micrometers, triangle_count)
         VALUES ($1,$2,$3,$4,'test',1,1,1,1,1)`,
        [
          expiredGeometryId,
          expiredSourceId,
          `canonical/${expiredGeometryId}`,
          "e".repeat(64),
        ],
      );
      await client.query(
        `UPDATE model_files SET retention_hold = 'NONE' WHERE id = $1`,
        [expiredSourceId],
      );
      const selectExpiredSource = () =>
        client.query(
          `UPDATE order_items
           SET source_model_file_id = $2, model_geometry_id = $3
           WHERE id = $1`,
          [mutableItemId, expiredSourceId, expiredGeometryId],
        );
      await expectQueryError(
        client,
        "expired_geometry_update_bypass",
        selectExpiredSource,
        {
          code: "23514",
          constraint: "model_geometry_source_available_check",
        },
      );
      await client.query(
        `UPDATE model_files SET deleted_at = now() WHERE id = $1`,
        [expiredSourceId],
      );
      await expectQueryError(
        client,
        "deleted_geometry_update_bypass",
        selectExpiredSource,
        {
          code: "23514",
          constraint: "model_geometry_source_available_check",
        },
      );
    });
  });

  it("binds every planned slot to compatible candidate inputs and quantity", async () => {
    await rollback("planned-slot-inputs", async (client, fixtures) => {
      const crossItem = await fixtures.createFoundation(
        "cross-item-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [
          {
            geometryBounds: {
              xMicrometers: 1,
              yMicrometers: 1,
              zMicrometers: 1,
            },
          },
          {
            geometryBounds: {
              xMicrometers: 2,
              yMicrometers: 2,
              zMicrometers: 2,
            },
          },
        ],
      );
      const crossItemProduction = await fixtures.planProduction(
        crossItem,
        "cross-item-candidate",
      );
      await expectQueryError(
        client,
        "cross_item_candidate_slot",
        () =>
          fixtures.createResourcePlan(crossItem, [
            {
              ...crossItemProduction,
              fulfilmentSlotId: crossItem.fulfilmentSlotIds[1]!,
            },
          ]),
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_input_check",
        },
      );

      const wrongColor = await fixtures.createFoundation(
        "wrong-color-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{ color: "white" }],
      );
      await client.query(
        `UPDATE inventories SET color = 'black' WHERE id = $1`,
        [wrongColor.inventoryId],
      );
      const wrongColorProduction = await fixtures.planProduction(
        wrongColor,
        "wrong-color-candidate",
      );
      await expectQueryError(
        client,
        "wrong_color_candidate_slot",
        () => fixtures.createResourcePlan(wrongColor, [wrongColorProduction]),
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_input_check",
        },
      );

      const missingInventoryColor = await fixtures.createFoundation(
        "missing-inventory-color-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{ color: "white" }],
      );
      await client.query(`UPDATE inventories SET color = NULL WHERE id = $1`, [
        missingInventoryColor.inventoryId,
      ]);
      const missingInventoryColorProduction = await fixtures.planProduction(
        missingInventoryColor,
        "missing-inventory-color-candidate",
      );
      await expectQueryError(
        client,
        "missing_inventory_color_candidate_slot",
        () =>
          fixtures.createResourcePlan(missingInventoryColor, [
            missingInventoryColorProduction,
          ]),
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_input_check",
        },
      );

      const underfilled = await fixtures.createFoundation(
        "underfilled-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{ quantity: 2 }],
      );
      const underfilledProduction = await fixtures.planProduction(
        underfilled,
        "underfilled-candidate",
        undefined,
        120,
        120,
        2,
      );
      await expectQueryError(
        client,
        "underfilled_candidate_quantity",
        async () => {
          await fixtures.createResourcePlan(underfilled, [
            underfilledProduction,
          ]);
          await client.query(
            `SET CONSTRAINTS "phase_resource_plan_jobs_candidate_quantity_reconciled",
                             "phase_resource_plan_slots_candidate_quantity_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_quantity_check",
        },
      );

      const overfilled = await fixtures.createFoundation(
        "overfilled-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{ quantity: 2 }],
      );
      const overfilledProduction = await fixtures.planProduction(
        overfilled,
        "overfilled-candidate",
      );
      await expectQueryError(
        client,
        "overfilled_candidate_quantity",
        async () => {
          await fixtures.createResourcePlan(overfilled, [overfilledProduction]);
          await client.query(
            `INSERT INTO phase_resource_plan_slots
               (id, node_id, phase_resource_plan_id,
                phase_resource_plan_job_id, fulfilment_slot_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              fixtures.id("overfilled-candidate:extra-plan-slot"),
              overfilled.nodeId,
              overfilled.phaseResourcePlanId,
              overfilledProduction.phaseResourcePlanJobId,
              overfilled.fulfilmentSlotIds[1],
            ],
          );
          await client.query(
            `SET CONSTRAINTS "phase_resource_plan_jobs_candidate_quantity_reconciled",
                             "phase_resource_plan_slots_candidate_quantity_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_quantity_check",
        },
      );

      const mixedItems = await fixtures.createFoundation(
        "mixed-item-candidate",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{}, {}],
        "DRAFT",
        async (draftFoundation) => {
          await client.query(
            `UPDATE order_items
             SET source_model_file_id = $2, model_geometry_id = $3,
                 print_config_revision_id = $4
             WHERE id = $1`,
            [
              draftFoundation.orderItemIds[1],
              draftFoundation.modelFileId,
              draftFoundation.modelGeometryId,
              draftFoundation.printConfigRevisionId,
            ],
          );
        },
      );
      const secondItemId = mixedItems.orderItemIds[1];
      if (!secondItemId) {
        throw new Error("mixed-item fixture is missing its second item");
      }
      const secondSlotId = fixtures.id("mixed-item-candidate:second-slot");
      await client.query(
        `INSERT INTO fulfilment_slots
           (id, order_id, order_phase_id, order_item_id, quantity_ordinal,
            settlement_amount_minor, created_at, updated_at)
         VALUES ($1,$2,$3,$4,2,0,$5,$5)`,
        [
          secondSlotId,
          mixedItems.orderId,
          mixedItems.orderPhaseId,
          secondItemId,
          new Date(),
        ],
      );
      await client.query(
        `INSERT INTO shipment_plan_fulfilment_slots
           (shipment_plan_id, order_price_binding_id, fulfilment_slot_id)
         VALUES ($1,$2,$3)`,
        [
          mixedItems.shipmentPlanId,
          mixedItems.orderPriceBindingId,
          secondSlotId,
        ],
      );
      const mixedItemProduction = await fixtures.planProduction(
        mixedItems,
        "mixed-item-candidate",
        undefined,
        120,
        120,
        2,
      );
      await expectQueryError(
        client,
        "mixed_item_candidate_membership",
        async () => {
          await fixtures.createResourcePlan(mixedItems, [mixedItemProduction]);
          await client.query(
            `INSERT INTO phase_resource_plan_slots
               (id, node_id, phase_resource_plan_id,
                phase_resource_plan_job_id, fulfilment_slot_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              fixtures.id("mixed-item-candidate:second-plan-slot"),
              mixedItems.nodeId,
              mixedItems.phaseResourcePlanId,
              mixedItemProduction.phaseResourcePlanJobId,
              secondSlotId,
            ],
          );
          await client.query(
            `SET CONSTRAINTS "phase_resource_plan_jobs_candidate_quantity_reconciled",
                             "phase_resource_plan_slots_candidate_quantity_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "phase_resource_plan_slot_candidate_item_check",
        },
      );
    });
  });

  it("keeps pre-confirmation fulfilment facts in their initial states", async () => {
    await rollback("pre-confirmation-fulfilment", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "pre-confirmation-fulfilment",
      );
      const changedAt = new Date();

      for (const [name, providerShipmentId] of [
        ["empty_provider_shipment", ""],
        ["blank_provider_shipment", "   "],
        ["control_whitespace_provider_shipment", "\t\n"],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            client.query(
              `UPDATE shipments
               SET status = 'LABEL_CREATED', carrier = 'test-carrier',
                   provider_shipment_id = $2, label_created_at = $3,
                   updated_at = $3
               WHERE order_id = $1`,
              [foundation.orderId, providerShipmentId, changedAt],
            ),
          {
            code: "23514",
            constraint: "shipment_lifecycle_evidence_check",
          },
        );
      }

      await expectQueryError(
        client,
        "quoted_shipment_label",
        async () => {
          await client.query(
            `UPDATE shipments
             SET status = 'LABEL_CREATED', carrier = 'test-carrier',
                 provider_shipment_id = $2, label_created_at = $3,
                 updated_at = $3
             WHERE order_id = $1`,
            [foundation.orderId, "premature-shipment-label", changedAt],
          );
          await client.query(
            `SET CONSTRAINTS "shipments_parent_lifecycle_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "pre_confirmation_fulfilment_state_check",
        },
      );

      await expectQueryError(
        client,
        "quoted_slot_delivery",
        async () => {
          await client.query(
            `UPDATE fulfilment_slots
             SET outcome = 'DELIVERED', updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, changedAt],
          );
          await client.query(
            `SET CONSTRAINTS "fulfilment_slots_parent_lifecycle_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "pre_confirmation_fulfilment_state_check",
        },
      );

      await expectQueryError(
        client,
        "capture_with_premature_shipment_fact",
        async () => {
          const productions = await createCurrentPlanAndPayment(
            client,
            fixtures,
            foundation,
          );
          await client.query(
            `UPDATE shipments
             SET status = 'LABEL_CREATED', carrier = 'test-carrier',
                 provider_shipment_id = $2, label_created_at = $3,
                 updated_at = $3
             WHERE order_id = $1`,
            [foundation.orderId, "pre-capture-shipment-label", changedAt],
          );
          await activateCurrentPlan(client, fixtures, foundation, productions);
          await forceOrderLifecycleConstraints(client);
        },
        {
          code: "23514",
          constraint: "order_post_confirmation_lifecycle_check",
        },
      );
    });
  });

  it("closes every checkout payment before cancelling a quoted order", async () => {
    await rollback("quoted-payment-cancellation", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "quoted-payment-cancellation",
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);

      await expectQueryError(
        client,
        "cancel_with_open_payment",
        () => cancelOrderBeforeHandoff(client, foundation.orderId, false),
        {
          code: "23514",
          constraint: "quoted_order_payment_cancellation_check",
        },
      );

      await expectQueryError(
        client,
        "fail_without_capture_cutoff",
        () =>
          client.query(
            `UPDATE payments
             SET status = 'FAILED', capture_authorized = false
             WHERE id = $1`,
            [foundation.paymentId],
          ),
        {
          code: "23514",
          constraint: "payment_capture_window_check",
        },
      );

      await expectQueryError(
        client,
        "cancel_with_pending_fulfilment_slots",
        async () => {
          await client.query(
            `UPDATE payments
             SET status = 'VOIDED', capture_authorized = false,
                 capture_cutoff_at = $2
             WHERE id = $1`,
            [foundation.paymentId, new Date()],
          );
          await cancelOrderBeforeHandoff(
            client,
            foundation.orderId,
            false,
            false,
          );
        },
        {
          code: "23514",
          constraint: "shipment_plan_slot_terminal_reconciliation_check",
        },
      );

      await cancelOrderBeforeHandoff(client, foundation.orderId);
      expect(
        (
          await client.query<{
            capture_authorized: boolean;
            capture_cutoff_at: Date;
            status: string;
          }>(
            `SELECT status::text, capture_authorized, capture_cutoff_at
             FROM payments WHERE id = $1`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "VOIDED",
          capture_authorized: false,
          capture_cutoff_at: expect.any(Date),
        },
      ]);
      expect(
        (
          await client.query<{ outcome: string }>(
            `SELECT outcome::text FROM fulfilment_slots
             WHERE order_id = $1 ORDER BY id`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([{ outcome: "CANCELLED" }]);
    });
  });

  it("expires a quoted order only after closing its checkout window and fulfilment graph", async () => {
    await rollback("quoted-order-expiry", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("quoted-order-expiry");
      await createCurrentPlan(client, fixtures, foundation);
      const checkoutExpiresAt = new Date(Date.now() + 300);
      await fixtures.finalizePayment(foundation, checkoutExpiresAt);

      await expectQueryError(
        client,
        "expire_before_checkout_deadline",
        () =>
          cancelOrderBeforeHandoff(
            client,
            foundation.orderId,
            true,
            true,
            "EXPIRED",
          ),
        {
          code: "23514",
          constraint: "quoted_order_expiry_deadline_check",
        },
      );

      await client.query("SELECT pg_sleep(0.35)");

      await expectQueryError(
        client,
        "expire_with_open_payment",
        () =>
          cancelOrderBeforeHandoff(
            client,
            foundation.orderId,
            false,
            true,
            "EXPIRED",
          ),
        {
          code: "23514",
          constraint: "quoted_order_payment_cancellation_check",
        },
      );

      await cancelOrderBeforeHandoff(
        client,
        foundation.orderId,
        true,
        true,
        "EXPIRED",
      );

      expect(
        (
          await client.query<{
            order_status: string;
            payment_status: string;
            phase_status: string;
            reservation_status: string;
            retention_hold: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                    payment.status::text AS payment_status,
                    phase.status::text AS phase_status,
                    reservation_set.status::text AS reservation_status,
                    source.retention_hold::text AS retention_hold
             FROM orders target_order
             JOIN payments payment ON payment.order_id = target_order.id
             JOIN order_phases phase ON phase.order_id = target_order.id
             JOIN phase_resource_plans resource_plan
               ON resource_plan.order_phase_id = phase.id
             JOIN phase_reservation_sets reservation_set
               ON reservation_set.phase_resource_plan_id = resource_plan.id
              AND reservation_set.node_id = resource_plan.node_id
             JOIN order_items item ON item.order_id = target_order.id
             JOIN model_files source ON source.id = item.source_model_file_id
             WHERE target_order.id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "EXPIRED",
          payment_status: "VOIDED",
          phase_status: "CANCELLED",
          reservation_status: "RELEASED",
          retention_hold: "NONE",
        },
      ]);

      await expectQueryError(
        client,
        "reopen_expired_order",
        () =>
          client.query(`UPDATE orders SET status = 'CONFIRMED' WHERE id = $1`, [
            foundation.orderId,
          ]),
        { code: "23514", constraint: "order_status_transition_check" },
      );
    });
  });

  it("cancels failed production atomically without rewriting the failed Job", async () => {
    await rollback(
      "failed-production-cancellation",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "failed-production-cancellation",
        );
        const productions = await createCurrentPlanAndPayment(
          client,
          fixtures,
          foundation,
        );
        await activateCurrentPlan(client, fixtures, foundation, productions);

        const jobId = productions[0]?.jobId;
        if (!jobId) {
          throw new Error("failed production fixture Job is missing");
        }
        const failedAt = new Date();
        await expectQueryError(
          client,
          "fail_unaccepted_job",
          () =>
            client.query(
              `UPDATE jobs
               SET status = 'FAILED', failed_at = $2,
                   failure_stage = 'PREPARATION',
                   failure_reason = 'test production failure', updated_at = $2
               WHERE id = $1`,
              [jobId, failedAt],
            ),
          { code: "23514", constraint: "job_status_transition_check" },
        );
        await client.query(
          `UPDATE jobs
         SET status = 'ACCEPTED', accepted_at = $2, updated_at = $2
         WHERE id = $1`,
          [jobId, failedAt],
        );

        await expectQueryError(
          client,
          "leave_failed_job_active",
          async () => {
            await client.query(
              `UPDATE jobs
               SET status = 'FAILED', failed_at = $2,
                   failure_stage = 'PREPARATION',
                   failure_reason = 'test production failure', updated_at = $2
               WHERE id = $1`,
              [jobId, failedAt],
            );
            await client.query(
              `SET CONSTRAINTS "jobs_production_failure_reconciled" IMMEDIATE`,
            );
          },
          { code: "23514", constraint: "job_failure_cancellation_check" },
        );

        const capturedAmount = (
          await client.query<{ captured_amount_minor: string }>(
            `SELECT captured_amount_minor::text
           FROM payments WHERE id = $1`,
            [foundation.paymentId],
          )
        ).rows[0]?.captured_amount_minor;
        if (!capturedAmount) {
          throw new Error("failed production fixture capture is missing");
        }
        await expectQueryError(
          client,
          "orphan_production_failure_refund",
          async () => {
            await client.query(
              `INSERT INTO refund_transactions
             (id, payment_id, idempotency_key, amount_minor, reason, status,
              requested_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,'PRODUCTION_FAILURE','FAILED',$5,$5,$5)`,
              [
                fixtures.id("orphan-production-failure-refund"),
                foundation.paymentId,
                "orphan-production-failure-refund",
                capturedAmount,
                failedAt,
              ],
            );
            await client.query(
              `SET CONSTRAINTS "refunds_production_failure_reconciled" IMMEDIATE`,
            );
          },
          { code: "23514", constraint: "job_failure_cancellation_check" },
        );
        await expectQueryError(
          client,
          "misattribute_failed_job_refund",
          async () => {
            await client.query(
              `UPDATE jobs
               SET status = 'FAILED', failed_at = $2,
                   failure_stage = 'PREPARATION',
                   failure_reason = 'test production failure', updated_at = $2
               WHERE id = $1`,
              [jobId, failedAt],
            );
            await client.query(
              `INSERT INTO refund_transactions
             (id, payment_id, idempotency_key, amount_minor, reason, status,
              requested_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,'CUSTOMER_CANCELLATION','PENDING',$5,$5,$5)`,
              [
                fixtures.id("misattributed-production-refund"),
                foundation.paymentId,
                "misattributed-production-refund",
                capturedAmount,
                failedAt,
              ],
            );
            await client.query(
              `UPDATE payments SET status = 'REFUND_PENDING', updated_at = $2
             WHERE id = $1`,
              [foundation.paymentId, failedAt],
            );
            await cancelOrderBeforeHandoff(client, foundation.orderId);
          },
          { code: "23514", constraint: "job_failure_cancellation_check" },
        );

        const refundId = fixtures.id("production-failure-refund");
        await client.query(
          `UPDATE jobs
           SET status = 'FAILED', failed_at = $2,
               failure_stage = 'PREPARATION',
               failure_reason = 'test production failure', updated_at = $2
           WHERE id = $1`,
          [jobId, failedAt],
        );
        await client.query(
          `INSERT INTO refund_transactions
         (id, payment_id, idempotency_key, amount_minor, reason, status,
          requested_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'PRODUCTION_FAILURE','PENDING',$5,$5,$5)`,
          [
            refundId,
            foundation.paymentId,
            "production-failure-refund",
            capturedAmount,
            failedAt,
          ],
        );
        await client.query(
          `UPDATE payments SET status = 'REFUND_PENDING', updated_at = $2
         WHERE id = $1`,
          [foundation.paymentId, failedAt],
        );
        await cancelOrderBeforeHandoff(client, foundation.orderId);
        await client.query(
          `SET CONSTRAINTS
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled" DEFERRED`,
        );

        expect(
          (
            await client.query<{
              job_status: string;
              order_status: string;
              payment_status: string;
              refund_reason: string;
              refund_status: string;
            }>(
              `SELECT job.status::text AS job_status,
                    target_order.status::text AS order_status,
                    payment.status::text AS payment_status,
                    refund.reason::text AS refund_reason,
                    refund.status::text AS refund_status
             FROM jobs job
             JOIN orders target_order ON target_order.id = job.order_id
             JOIN payments payment ON payment.order_id = target_order.id
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE job.id = $1 AND refund.id = $2`,
              [jobId, refundId],
            )
          ).rows,
        ).toEqual([
          {
            job_status: "FAILED",
            order_status: "CANCELLED",
            payment_status: "REFUND_PENDING",
            refund_reason: "PRODUCTION_FAILURE",
            refund_status: "PENDING",
          },
        ]);
        expect(
          (
            await client.query<{ status: string }>(
              `SELECT status::text
             FROM phase_reservation_sets WHERE id = $1
             UNION ALL
             SELECT status::text
             FROM production_reservations WHERE job_id = $2
             UNION ALL
             SELECT status::text
             FROM inventory_reservations
             WHERE production_reservation_id = $3
             UNION ALL
             SELECT status::text
             FROM capacity_reservations
             WHERE production_reservation_id = $3`,
              [
                foundation.phaseReservationSetId,
                jobId,
                productions[0]?.productionReservationId,
              ],
            )
          ).rows,
        ).toEqual([
          { status: "RELEASED" },
          { status: "RELEASED" },
          { status: "RELEASED" },
          { status: "RELEASED" },
        ]);

        const refundFailedAt = new Date(failedAt.getTime() + 500);
        await client.query(
          `UPDATE refund_transactions
           SET status = 'FAILED', updated_at = $2 WHERE id = $1`,
          [refundId, refundFailedAt],
        );
        await client.query(
          `UPDATE payments SET status = 'CAPTURED', updated_at = $2 WHERE id = $1`,
          [foundation.paymentId, refundFailedAt],
        );
        await client.query(
          `SET CONSTRAINTS
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled" DEFERRED`,
        );
        await forceOrderLifecycleConstraints(client);
        expect(
          (
            await client.query<{
              job_status: string;
              payment_status: string;
              refund_status: string;
            }>(
              `SELECT job.status::text AS job_status,
                      payment.status::text AS payment_status,
                      refund.status::text AS refund_status
               FROM jobs job
               JOIN payments payment ON payment.order_id = job.order_id
               JOIN refund_transactions refund ON refund.payment_id = payment.id
               WHERE job.id = $1 AND refund.id = $2`,
              [jobId, refundId],
            )
          ).rows,
        ).toEqual([
          {
            job_status: "FAILED",
            payment_status: "CAPTURED",
            refund_status: "FAILED",
          },
        ]);

        const wrongRetryAmount = Number(capturedAmount) - 1;
        if (wrongRetryAmount <= 0) {
          throw new Error("production failure retry fixture is too small");
        }
        await expectQueryError(
          client,
          "retain_only_latest_failed_refund_attempt",
          async () => {
            const wrongRetryAt = new Date(refundFailedAt.getTime() + 1);
            await client.query(
              `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                requested_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,'PRODUCTION_FAILURE','FAILED',$5,$5,$5)`,
              [
                fixtures.id("wrong-production-failure-refund-retry"),
                foundation.paymentId,
                "wrong-production-failure-refund-retry",
                wrongRetryAmount,
                wrongRetryAt,
              ],
            );
            await client.query(
              `SET CONSTRAINTS "refunds_production_failure_reconciled" IMMEDIATE`,
            );
          },
          { code: "23514", constraint: "job_failure_cancellation_check" },
        );

        const retryRefundId = fixtures.id("production-failure-refund-retry");
        await client.query(
          `INSERT INTO refund_transactions
           (id, payment_id, idempotency_key, amount_minor, reason, status,
            requested_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'PRODUCTION_FAILURE','PENDING',$5,$5,$5)`,
          [
            retryRefundId,
            foundation.paymentId,
            "production-failure-refund-retry",
            capturedAmount,
            refundFailedAt,
          ],
        );
        await client.query(
          `UPDATE payments SET status = 'REFUND_PENDING', updated_at = $2
           WHERE id = $1`,
          [foundation.paymentId, refundFailedAt],
        );
        await client.query(
          `SET CONSTRAINTS
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled" DEFERRED`,
        );
        await forceOrderLifecycleConstraints(client);

        const refundedAt = new Date(failedAt.getTime() + 1_000);
        await client.query(
          `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_refund_id = $2,
             completed_at = $3, updated_at = $3
         WHERE id = $1`,
          [retryRefundId, "production-failure-refund-retry", refundedAt],
        );
        await client.query(
          `UPDATE payments SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
          [foundation.paymentId, refundedAt],
        );
        await client.query(
          `UPDATE order_phases
         SET status = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
          [foundation.orderId, refundedAt],
        );
        await client.query(
          `UPDATE fulfilment_slots
         SET outcome = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
          [foundation.orderId, refundedAt],
        );
        await client.query(
          `UPDATE orders SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
          [foundation.orderId, refundedAt],
        );
        await forceOrderLifecycleConstraints(client);
        await client.query(
          `SET CONSTRAINTS
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "orders_refund_completion_reconciled" IMMEDIATE`,
        );
        expect(
          (
            await client.query<{
              job_status: string;
              order_status: string;
              payment_status: string;
              refund_status: string;
            }>(
              `SELECT job.status::text AS job_status,
                    target_order.status::text AS order_status,
                    payment.status::text AS payment_status,
                    refund.status::text AS refund_status
             FROM jobs job
             JOIN orders target_order ON target_order.id = job.order_id
             JOIN payments payment ON payment.order_id = target_order.id
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE job.id = $1 AND refund.id = $2`,
              [jobId, retryRefundId],
            )
          ).rows,
        ).toEqual([
          {
            job_status: "FAILED",
            order_status: "REFUNDED",
            payment_status: "REFUNDED",
            refund_status: "SUCCEEDED",
          },
        ]);
      },
    );
  });

  it("allows a payment schedule retry only after a failed attempt", async () => {
    await rollback("payment-schedule-retry", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "payment-schedule-retry",
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);

      const insertRetry = (id: string, providerIntentId: string) => {
        const retryCreatedAt = new Date();
        const retryExpiresAt = new Date(
          retryCreatedAt.getTime() + 60 * 60 * 1_000,
        );
        return client.query(
          `INSERT INTO payments
             (id, order_id, price_snapshot_id, order_price_binding_id,
              payment_schedule_id, role, provider, provider_intent_id,
              requested_amount_minor, currency, status,
              checkout_capture_expires_at, created_at, updated_at)
           SELECT $1, order_id, price_snapshot_id, order_price_binding_id,
                  payment_schedule_id, role, provider, $2,
                  requested_amount_minor, currency, 'PENDING', $3, $4, $4
           FROM payments WHERE id = $5`,
          [
            id,
            providerIntentId,
            retryExpiresAt,
            retryCreatedAt,
            foundation.paymentId,
          ],
        );
      };

      await expectQueryError(
        client,
        "concurrent_payment_schedule_attempt",
        () =>
          insertRetry(
            fixtures.id("concurrent-payment-attempt"),
            "concurrent-provider-intent",
          ),
        {
          code: "23505",
          constraint: "payments_one_nonfailed_attempt_per_schedule_key",
        },
      );

      await expectQueryError(
        client,
        "fail_with_open_authorization",
        () =>
          client.query(`UPDATE payments SET status = 'FAILED' WHERE id = $1`, [
            foundation.paymentId,
          ]),
        { code: "23514", constraint: "payment_capture_window_check" },
      );
      const failedAt = new Date();
      await client.query(
        `UPDATE payments
         SET status = 'FAILED', capture_authorized = false,
             capture_cutoff_at = $2, updated_at = $2
         WHERE id = $1`,
        [foundation.paymentId, failedAt],
      );
      expect(
        (
          await client.query<{
            capture_authorized: boolean;
            capture_cutoff_at: Date;
            status: string;
          }>(
            `SELECT status::text, capture_authorized, capture_cutoff_at
             FROM payments WHERE id = $1`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "FAILED",
          capture_authorized: false,
          capture_cutoff_at: failedAt,
        },
      ]);
      const retryPaymentId = fixtures.id("failed-payment-retry");
      await expect(
        insertRetry(retryPaymentId, "failed-provider-intent-retry"),
      ).resolves.toBeDefined();

      await client.query(
        `UPDATE payments
         SET status = 'VOIDED', capture_authorized = false,
             capture_cutoff_at = $2
         WHERE id = $1`,
        [retryPaymentId, new Date()],
      );
      await expectQueryError(
        client,
        "voided_payment_schedule_attempt",
        () =>
          insertRetry(
            fixtures.id("voided-payment-retry"),
            "voided-provider-intent-retry",
          ),
        {
          code: "23505",
          constraint: "payments_one_nonfailed_attempt_per_schedule_key",
        },
      );
    });
  });

  it("requires a stable provider intent before a payment becomes pending", async () => {
    await rollback("payment-provider-intent", async (client, fixtures) => {
      const createdFoundation = await fixtures.createFoundation(
        "created-payment-without-intent",
      );
      await createCurrentPlan(client, fixtures, createdFoundation);
      const createdAt = new Date();
      const checkoutCaptureExpiresAt = new Date(
        createdAt.getTime() + 60 * 60 * 1_000,
      );
      await client.query(
        `INSERT INTO payments
           (id, order_id, price_snapshot_id, order_price_binding_id,
            payment_schedule_id, role, provider, requested_amount_minor,
            currency, status, checkout_capture_expires_at, created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,'FULL','test',gross_amount_minor,
                'EUR','CREATED',$6,$7,$7
         FROM payment_schedules WHERE id = $5`,
        [
          createdFoundation.paymentId,
          createdFoundation.orderId,
          createdFoundation.priceSnapshotId,
          createdFoundation.orderPriceBindingId,
          createdFoundation.paymentScheduleId,
          checkoutCaptureExpiresAt,
          createdAt,
        ],
      );
      await expectQueryError(
        client,
        "pending_without_provider_intent",
        () =>
          client.query(`UPDATE payments SET status = 'PENDING' WHERE id = $1`, [
            createdFoundation.paymentId,
          ]),
        {
          code: "23514",
          constraint: "payments_provider_intent_identity_check",
        },
      );
      await client.query(
        `UPDATE payments
         SET status = 'VOIDED', capture_authorized = false,
             capture_cutoff_at = $2, updated_at = $2
         WHERE id = $1`,
        [createdFoundation.paymentId, new Date()],
      );

      const pendingFoundation = await fixtures.createFoundation(
        "pending-payment-provider-intent",
      );
      await createCurrentPlan(client, fixtures, pendingFoundation);
      for (const [name, providerIntentId] of [
        ["null_provider_intent", null],
        ["blank_provider_intent", "   "],
        ["control_whitespace_provider_intent", "\t\n"],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            fixtures.finalizePayment(
              pendingFoundation,
              checkoutCaptureExpiresAt,
              providerIntentId,
            ),
          {
            code: "23514",
            constraint: "payments_provider_intent_identity_check",
          },
        );
      }
      await fixtures.finalizePayment(
        pendingFoundation,
        checkoutCaptureExpiresAt,
        "stable-provider-intent",
      );
    });
  });

  it("persists a pending compensation capture directly as refund pending", async () => {
    await rollback("pending-capture-compensation", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "pending-capture-compensation",
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);
      await cancelOrderBeforeHandoff(client, foundation.orderId);
      const capturedAt = new Date();
      for (const [name, providerCaptureId] of [
        ["empty_compensation_capture_id", ""],
        ["blank_compensation_capture_id", "   "],
        ["control_whitespace_compensation_capture_id", "\t\n"],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            client.query(
              `UPDATE payments
               SET status = 'REFUND_PENDING',
                   captured_amount_minor = requested_amount_minor,
                   provider_capture_id = $2, captured_at = $3
               WHERE id = $1`,
              [foundation.paymentId, providerCaptureId, capturedAt],
            ),
          {
            code: "23514",
            constraint: "payments_provider_capture_identity_check",
          },
        );
      }
      await client.query(
        `UPDATE payments
         SET status = 'REFUND_PENDING',
             captured_amount_minor = requested_amount_minor,
             provider_capture_id = $2, captured_at = $3
         WHERE id = $1`,
        [foundation.paymentId, "late-provider-capture", capturedAt],
      );
      await client.query(
        `INSERT INTO refund_transactions
         (id, payment_id, idempotency_key, amount_minor, reason, status,
          requested_at, created_at, updated_at)
         SELECT $1, id, $2, requested_amount_minor,
                'CUSTOMER_CANCELLATION', 'PENDING', $3, $3, $3
         FROM payments WHERE id = $4`,
        [
          fixtures.id("late-capture-refund"),
          "late-capture-refund",
          capturedAt,
          foundation.paymentId,
        ],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled",
                         "payments_customer_cancellation_refund_reconciled",
                         "refunds_customer_cancellation_order_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{
            capture_matches_request: boolean;
            captured_at: Date;
            provider_capture_id: string;
            status: string;
          }>(
            `SELECT status::text,
                    captured_amount_minor = requested_amount_minor
                      AS capture_matches_request,
                    provider_capture_id, captured_at
             FROM payments WHERE id = $1`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "REFUND_PENDING",
          capture_matches_request: true,
          provider_capture_id: "late-provider-capture",
          captured_at: capturedAt,
        },
      ]);
    });
  });

  it("persists refund-pending status and refund work atomically", async () => {
    await rollback("refund-pending-atomicity", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "refund-pending-atomicity",
      );
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(client, fixtures, foundation, productions);

      await expectQueryError(
        client,
        "refund_pending_without_work",
        async () => {
          await client.query(
            `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `SET CONSTRAINTS "payments_refund_status_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_refund_status_reconciliation_check",
        },
      );

      await expectQueryError(
        client,
        "refund_work_without_pending_status",
        async () => {
          await client.query(
            `INSERT INTO refund_transactions
             (id, payment_id, idempotency_key, amount_minor, reason, status,
              created_at, updated_at)
             VALUES ($1,$2,$3,1,'CUSTOMER_CANCELLATION','PENDING',$4,$4)`,
            [
              fixtures.id("orphan-pending-refund"),
              foundation.paymentId,
              "orphan-pending-refund",
              new Date(),
            ],
          );
          await client.query(
            `SET CONSTRAINTS "refund_transactions_payment_status_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_refund_status_reconciliation_check",
        },
      );

      const refundId = fixtures.id("atomic-pending-refund");
      await client.query(
        `INSERT INTO refund_transactions
         (id, payment_id, idempotency_key, amount_minor, reason, status,
          created_at, updated_at)
         VALUES ($1,$2,$3,1,'CUSTOMER_CANCELLATION','PENDING',$4,$4)`,
        [refundId, foundation.paymentId, "atomic-pending-refund", new Date()],
      );
      await client.query(
        `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
        [foundation.paymentId],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{ payment_status: string; refund_status: string }>(
            `SELECT payment.status::text AS payment_status,
                    refund.status::text AS refund_status
             FROM payments payment
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE payment.id = $1 AND refund.id = $2`,
            [foundation.paymentId, refundId],
          )
        ).rows,
      ).toEqual([
        { payment_status: "REFUND_PENDING", refund_status: "PENDING" },
      ]);

      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" DEFERRED`,
      );
      await expectQueryError(
        client,
        "fail_refund_without_payment_restore",
        async () => {
          await client.query(
            `UPDATE refund_transactions
             SET status = 'FAILED', updated_at = $2 WHERE id = $1`,
            [refundId, new Date()],
          );
          await client.query(
            `SET CONSTRAINTS "refund_transactions_payment_status_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_refund_status_reconciliation_check",
        },
      );

      const failedAt = new Date();
      await client.query(
        `UPDATE refund_transactions
         SET status = 'FAILED', updated_at = $2 WHERE id = $1`,
        [refundId, failedAt],
      );
      await client.query(
        `UPDATE payments SET status = 'CAPTURED', updated_at = $2 WHERE id = $1`,
        [foundation.paymentId, failedAt],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{ payment_status: string; refund_status: string }>(
            `SELECT payment.status::text AS payment_status,
                    refund.status::text AS refund_status
             FROM payments payment
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE payment.id = $1 AND refund.id = $2`,
            [foundation.paymentId, refundId],
          )
        ).rows,
      ).toEqual([{ payment_status: "CAPTURED", refund_status: "FAILED" }]);

      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" DEFERRED`,
      );
      const retryRefundId = fixtures.id("retry-pending-refund");
      await client.query(
        `INSERT INTO refund_transactions
         (id, payment_id, idempotency_key, amount_minor, reason, status,
          created_at, updated_at)
         VALUES ($1,$2,$3,1,'CUSTOMER_CANCELLATION','PENDING',$4,$4)`,
        [
          retryRefundId,
          foundation.paymentId,
          "retry-pending-refund",
          new Date(),
        ],
      );
      await client.query(
        `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
        [foundation.paymentId],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{ payment_status: string; refund_status: string }>(
            `SELECT payment.status::text AS payment_status,
                    refund.status::text AS refund_status
             FROM payments payment
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE payment.id = $1 AND refund.id = $2`,
            [foundation.paymentId, retryRefundId],
          )
        ).rows,
      ).toEqual([
        { payment_status: "REFUND_PENDING", refund_status: "PENDING" },
      ]);
    });
  });

  it("rejects ordinary capture after its authorization or immutable checkout window closes", async () => {
    await rollback("closed-capture-window", async (client, fixtures) => {
      const capturePayment = async (
        foundation: PersistenceFoundation,
        providerCaptureId: string,
      ): Promise<void> => {
        await client.query(
          `UPDATE payments
           SET status = 'CAPTURED',
               captured_amount_minor = requested_amount_minor,
               provider_capture_id = $2, captured_at = $3
           WHERE id = $1`,
          [foundation.paymentId, providerCaptureId, new Date()],
        );
      };

      const blankCapture = await fixtures.createFoundation(
        "blank-provider-capture",
      );
      await createCurrentPlanAndPayment(client, fixtures, blankCapture);
      for (const [name, providerCaptureId] of [
        ["empty_provider_capture", ""],
        ["blank_provider_capture", "   "],
        ["control_whitespace_provider_capture", "\t\n"],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () => capturePayment(blankCapture, providerCaptureId),
          {
            code: "23514",
            constraint: "payments_provider_capture_identity_check",
          },
        );
      }

      const unauthorized = await fixtures.createFoundation(
        "unauthorized-capture",
      );
      await createCurrentPlanAndPayment(client, fixtures, unauthorized);
      await expectQueryError(
        client,
        "cutoff_without_closing_authorization",
        () =>
          client.query(
            `UPDATE payments SET capture_cutoff_at = $2 WHERE id = $1`,
            [unauthorized.paymentId, new Date()],
          ),
        { code: "23514", constraint: "payment_capture_window_check" },
      );
      await client.query(
        `UPDATE payments SET capture_authorized = false WHERE id = $1`,
        [unauthorized.paymentId],
      );
      await expectQueryError(
        client,
        "capture_without_authorization",
        () => capturePayment(unauthorized, "unauthorized-capture"),
        { code: "23514", constraint: "payment_capture_window_check" },
      );

      const expired = await fixtures.createFoundation("expired-capture");
      await createCurrentPlanAndPayment(client, fixtures, expired);
      await client.query(
        `UPDATE payments
         SET capture_authorized = false, capture_cutoff_at = $2
         WHERE id = $1`,
        [expired.paymentId, new Date(Date.now() - 1_000)],
      );
      await expectQueryError(
        client,
        "capture_after_cutoff",
        () => capturePayment(expired, "expired-capture"),
        { code: "23514", constraint: "payment_capture_window_check" },
      );

      const immutable = await fixtures.createFoundation(
        "immutable-capture-expiry",
      );
      await createCurrentPlanAndPayment(client, fixtures, immutable);
      const immutableExpiry = (
        await client.query<{ checkout_capture_expires_at: Date }>(
          `SELECT checkout_capture_expires_at
           FROM payments WHERE id = $1`,
          [immutable.paymentId],
        )
      ).rows[0]?.checkout_capture_expires_at;
      if (!immutableExpiry) {
        throw new Error("checkout capture expiry was not persisted");
      }
      await expectQueryError(
        client,
        "extend_checkout_capture_expiry",
        () =>
          client.query(
            `UPDATE payments
             SET checkout_capture_expires_at = $2 WHERE id = $1`,
            [immutable.paymentId, new Date(immutableExpiry.getTime() + 1_000)],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );

      const stale = await fixtures.createFoundation("stale-capture-expiry");
      await createCurrentPlan(client, fixtures, stale);
      await expectQueryError(
        client,
        "create_expired_checkout_capture",
        () => fixtures.finalizePayment(stale, new Date(Date.now() - 1_000)),
        { code: "23514", constraint: "payment_capture_window_check" },
      );

      const missing = await fixtures.createFoundation("missing-capture-expiry");
      await createCurrentPlan(client, fixtures, missing);
      await expectQueryError(
        client,
        "create_missing_checkout_capture_expiry",
        () => fixtures.finalizePayment(missing, null),
        { code: "23514", constraint: "payment_capture_window_check" },
      );

      const delayed = await fixtures.createFoundation(
        "wall-clock-capture-expiry",
      );
      await createCurrentPlan(client, fixtures, delayed);
      const checkoutCaptureExpiresAt = new Date(Date.now() + 2_000);
      await fixtures.finalizePayment(delayed, checkoutCaptureExpiresAt);
      await client.query(
        `SELECT pg_sleep(
           greatest(extract(epoch FROM $1::timestamptz - clock_timestamp()), 0)
           + 0.05
         )`,
        [checkoutCaptureExpiresAt],
      );
      expect(
        (
          await client.query<{
            transaction_time_accepts: boolean;
            wall_clock_expired: boolean;
          }>(
            `SELECT $1::timestamptz > CURRENT_TIMESTAMP AS transaction_time_accepts,
                    $1::timestamptz <= clock_timestamp() AS wall_clock_expired`,
            [checkoutCaptureExpiresAt],
          )
        ).rows,
      ).toEqual([{ transaction_time_accepts: true, wall_clock_expired: true }]);
      await expectQueryError(
        client,
        "capture_after_checkout_expiry",
        () => capturePayment(delayed, "delayed-checkout-capture"),
        { code: "23514", constraint: "payment_capture_window_check" },
      );
    });
  });

  it("requires a captured held production reservation for every job", async () => {
    await rollback("uncaptured-production-job", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "uncaptured-production-job",
      );
      const production = await fixtures.planProduction(
        foundation,
        "uncaptured-production-job",
      );
      await fixtures.createResourcePlan(foundation, [production]);
      await fixtures.createPhaseReservationSet(foundation);
      await fixtures.createProductionReservation(foundation, production);
      await client.query(
        `INSERT INTO inventory_reservations
           (id, node_id, production_reservation_id, inventory_id,
            reserved_milligrams, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
        [
          production.inventoryReservationId,
          foundation.nodeId,
          production.productionReservationId,
          foundation.inventoryId,
          production.requiredMaterialMilligrams,
          testTimes.expiresAt,
          testTimes.createdAt,
        ],
      );
      const capacityReservationId = fixtures.id(
        "uncaptured-production-job:capacity",
      );
      await client.query(
        `INSERT INTO capacity_reservations
           (id, node_id, production_reservation_id,
            candidate_capacity_interval_id, machine_id,
            starts_at, ends_at, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [
          capacityReservationId,
          foundation.nodeId,
          production.productionReservationId,
          production.candidateCapacityIntervalId,
          foundation.machineId,
          testTimes.capacityStart,
          testTimes.capacityEnd,
          testTimes.expiresAt,
          testTimes.createdAt,
        ],
      );
      await client.query(
        `UPDATE phase_reservation_sets SET status = 'RESERVED' WHERE id = $1`,
        [foundation.phaseReservationSetId],
      );
      await fixtures.finalizePayment(foundation);
      await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
      await client.query(`SET CONSTRAINTS ALL DEFERRED`);

      await expectQueryError(
        client,
        "capture_without_activation",
        async () => {
          await fixtures.capturePayment(foundation);
          await client.query(
            `SET CONSTRAINTS "payments_capture_activation_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_capture_activation_check",
        },
      );

      const holdReservationAndCreateJob = async (): Promise<void> => {
        await client.query(
          `UPDATE inventory_reservations SET status = 'HELD' WHERE id = $1`,
          [production.inventoryReservationId],
        );
        await client.query(
          `UPDATE capacity_reservations SET status = 'HELD' WHERE id = $1`,
          [capacityReservationId],
        );
        await fixtures.createJob(foundation, production);
        await client.query(
          `UPDATE production_reservations
           SET status = 'HELD', job_id = $2 WHERE id = $1`,
          [production.productionReservationId, production.jobId],
        );
        await client.query(
          `UPDATE phase_reservation_sets SET status = 'HELD' WHERE id = $1`,
          [foundation.phaseReservationSetId],
        );
      };

      await expectQueryError(
        client,
        "uncaptured_production_job",
        async () => {
          await holdReservationAndCreateJob();
          await client.query(
            `SET CONSTRAINTS "jobs_captured_reservation_reconciled" IMMEDIATE`,
          );
        },
        { code: "23514", constraint: "job_capture_reconciliation_check" },
      );

      await holdReservationAndCreateJob();
      await fixtures.activatePayment(foundation);
      await expect(
        client.query(
          `SET CONSTRAINTS
             "payments_capture_activation_reconciled",
             "orders_capture_activation_reconciled",
             "order_phases_capture_activation_reconciled",
             "phase_reservation_sets_capture_activation_reconciled",
             "jobs_captured_reservation_reconciled" IMMEDIATE`,
        ),
      ).resolves.toBeDefined();
    });
  });

  it("checks payment resource expiry against wall-clock time", async () => {
    await rollback("wall-clock-payment-expiry", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "wall-clock-payment-expiry",
      );
      const reservationExpiresAt = new Date(Date.now() + 2_000);
      await createCurrentPlan(
        client,
        fixtures,
        foundation,
        reservationExpiresAt,
      );
      await client.query(
        `SELECT pg_sleep(
           greatest(extract(epoch FROM $1::timestamptz - clock_timestamp()), 0)
           + 0.05
         )`,
        [reservationExpiresAt],
      );
      expect(
        (
          await client.query<{
            transaction_time_accepts: boolean;
            wall_clock_expired: boolean;
          }>(
            `SELECT $1::timestamptz > CURRENT_TIMESTAMP AS transaction_time_accepts,
                    $1::timestamptz <= clock_timestamp() AS wall_clock_expired`,
            [reservationExpiresAt],
          )
        ).rows,
      ).toEqual([{ transaction_time_accepts: true, wall_clock_expired: true }]);
      await expectQueryError(
        client,
        "expired_plan_payment",
        () => fixtures.finalizePayment(foundation),
        { code: "23514", constraint: "payment_fulfilment_topology_check" },
      );
    });
  });

  it("keeps confirmed orders bound to their captured held reservations", async () => {
    await rollback("confirmed-reservation-hold", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "confirmed-reservation-hold",
      );
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(client, fixtures, foundation, productions);
      const production = productions[0];
      if (!production) {
        throw new Error("confirmed reservation fixture has no production");
      }
      const capacityReservationId = fixtures.id(
        `payment-capacity-${foundation.orderId}-0`,
      );
      const departures = [
        {
          name: "confirmed_set_release",
          query: `UPDATE phase_reservation_sets
                  SET status = 'RELEASED' WHERE id = $1`,
          id: foundation.phaseReservationSetId,
          trigger: "phase_reservation_sets_confirmed_order_hold_reconciled",
        },
        {
          name: "confirmed_set_expiry",
          query: `UPDATE phase_reservation_sets
                  SET status = 'EXPIRED' WHERE id = $1`,
          id: foundation.phaseReservationSetId,
          trigger: "phase_reservation_sets_confirmed_order_hold_reconciled",
        },
        {
          name: "confirmed_production_schedule",
          query: `UPDATE production_reservations
                  SET status = 'SCHEDULED' WHERE id = $1`,
          id: production.productionReservationId,
          trigger: "production_reservations_confirmed_order_hold_reconciled",
        },
        {
          name: "confirmed_production_release",
          query: `UPDATE production_reservations
                  SET status = 'RELEASED' WHERE id = $1`,
          id: production.productionReservationId,
          trigger: "production_reservations_confirmed_order_hold_reconciled",
        },
        {
          name: "confirmed_production_expiry",
          query: `UPDATE production_reservations
                  SET status = 'EXPIRED' WHERE id = $1`,
          id: production.productionReservationId,
          trigger: "production_reservations_confirmed_order_hold_reconciled",
        },
        {
          name: "confirmed_inventory_allocate",
          query: `UPDATE inventory_reservations
                  SET status = 'ALLOCATED' WHERE id = $1`,
          id: production.inventoryReservationId,
          trigger: "inventory_reservations_confirmed_order_hold_reconciled",
        },
        {
          name: "confirmed_inventory_release",
          query: `UPDATE inventory_reservations
                  SET status = 'RELEASED' WHERE id = $1`,
          id: production.inventoryReservationId,
          trigger: "inventory_reservations_confirmed_order_hold_reconciled",
        },
        {
          name: "confirmed_inventory_expiry",
          query: `UPDATE inventory_reservations
                  SET status = 'EXPIRED' WHERE id = $1`,
          id: production.inventoryReservationId,
          trigger: "inventory_reservations_confirmed_order_hold_reconciled",
        },
        {
          name: "confirmed_capacity_schedule",
          query: `UPDATE capacity_reservations
                  SET status = 'SCHEDULED' WHERE id = $1`,
          id: capacityReservationId,
          trigger: "capacity_reservations_confirmed_order_hold_reconciled",
        },
        {
          name: "confirmed_capacity_release",
          query: `UPDATE capacity_reservations
                  SET status = 'RELEASED' WHERE id = $1`,
          id: capacityReservationId,
          trigger: "capacity_reservations_confirmed_order_hold_reconciled",
        },
        {
          name: "confirmed_capacity_expiry",
          query: `UPDATE capacity_reservations
                  SET status = 'EXPIRED' WHERE id = $1`,
          id: capacityReservationId,
          trigger: "capacity_reservations_confirmed_order_hold_reconciled",
        },
      ] as const;

      for (const departure of departures) {
        await expectQueryError(
          client,
          departure.name,
          async () => {
            await client.query(departure.query, [departure.id]);
            await client.query(
              `SET CONSTRAINTS "${departure.trigger}" IMMEDIATE`,
            );
          },
          {
            code: "23514",
            constraint: "confirmed_order_reservation_hold_check",
          },
        );
      }

      await expectQueryError(
        client,
        "confirmed_complete_graph_release",
        async () => {
          await client.query(
            `UPDATE inventory_reservations SET status = 'RELEASED' WHERE id = $1`,
            [production.inventoryReservationId],
          );
          await client.query(
            `UPDATE capacity_reservations SET status = 'RELEASED' WHERE id = $1`,
            [capacityReservationId],
          );
          await client.query(
            `UPDATE production_reservations SET status = 'RELEASED' WHERE id = $1`,
            [production.productionReservationId],
          );
          await client.query(
            `UPDATE phase_reservation_sets SET status = 'RELEASED' WHERE id = $1`,
            [foundation.phaseReservationSetId],
          );
          await client.query(
            `SET CONSTRAINTS
               "phase_reservation_sets_confirmed_order_hold_reconciled",
               "production_reservations_confirmed_order_hold_reconciled",
               "inventory_reservations_confirmed_order_hold_reconciled",
               "capacity_reservations_confirmed_order_hold_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "confirmed_order_reservation_hold_check",
        },
      );

      await expectQueryError(
        client,
        "production_parent_before_resources",
        async () => {
          const printingAt = new Date();
          await client.query(
            `UPDATE jobs
             SET status = 'ACCEPTED', accepted_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, printingAt],
          );
          await advanceAcceptedJobToGcodeReady(
            client,
            production.jobId,
            printingAt,
          );
          await client.query(
            `UPDATE jobs
             SET status = 'PRINTING', printing_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, printingAt],
          );
          await client.query(
            `UPDATE order_phases
             SET status = 'IN_PRODUCTION', updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, printingAt],
          );
          await client.query(
            `UPDATE orders
             SET status = 'IN_PRODUCTION', updated_at = $2 WHERE id = $1`,
            [foundation.orderId, printingAt],
          );
          await client.query(
            `SET CONSTRAINTS "orders_production_resource_start_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "order_production_resource_start_check",
        },
      );

      await expectQueryError(
        client,
        "confirmed_cancel_without_resource_release",
        async () => {
          const cancelledAt = new Date();
          await client.query(
            `UPDATE jobs
             SET status = 'CANCELLED', cancelled_at = $2,
                 cancellation_reason = 'ORDER_CANCELLED', updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, cancelledAt],
          );
          await client.query(
            `UPDATE shipments
             SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, cancelledAt],
          );
          await client.query(
            `UPDATE order_phases
             SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, cancelledAt],
          );
          await client.query(
            `UPDATE orders
             SET status = 'CANCELLED', updated_at = $2 WHERE id = $1`,
            [foundation.orderId, cancelledAt],
          );
          await client.query(
            `SET CONSTRAINTS "orders_cancelled_reservations_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "cancelled_order_reservation_terminal_check",
        },
      );

      await client.query(
        `UPDATE inventory_reservations SET status = 'ALLOCATED' WHERE id = $1`,
        [production.inventoryReservationId],
      );
      await client.query(
        `UPDATE capacity_reservations SET status = 'SCHEDULED' WHERE id = $1`,
        [capacityReservationId],
      );
      await client.query(
        `UPDATE capacity_reservations SET status = 'PRINTING' WHERE id = $1`,
        [capacityReservationId],
      );
      await client.query(
        `UPDATE production_reservations SET status = 'SCHEDULED' WHERE id = $1`,
        [production.productionReservationId],
      );
      await client.query(
        `UPDATE production_reservations SET status = 'PRINTING' WHERE id = $1`,
        [production.productionReservationId],
      );
      await advanceOrderLifecycleStep(
        client,
        foundation.orderId,
        "IN_PRODUCTION",
      );
      await client.query(
        `SET CONSTRAINTS
           "phase_reservation_sets_confirmed_order_hold_reconciled",
           "production_reservations_confirmed_order_hold_reconciled",
           "inventory_reservations_confirmed_order_hold_reconciled",
           "capacity_reservations_confirmed_order_hold_reconciled",
           "phase_reservation_sets_complete",
           "production_reservations_complete_set",
           "inventory_reservations_complete_set",
           "capacity_reservations_complete_set" IMMEDIATE`,
      );
      await client.query(`SET CONSTRAINTS ALL DEFERRED`);

      await client.query(
        `UPDATE inventory_reservations SET status = 'RELEASED' WHERE id = $1`,
        [production.inventoryReservationId],
      );
      await client.query(
        `UPDATE capacity_reservations SET status = 'RELEASED' WHERE id = $1`,
        [capacityReservationId],
      );
      await client.query(
        `UPDATE production_reservations SET status = 'RELEASED' WHERE id = $1`,
        [production.productionReservationId],
      );
      await client.query(
        `UPDATE phase_reservation_sets SET status = 'RELEASED' WHERE id = $1`,
        [foundation.phaseReservationSetId],
      );
      await cancelOrderBeforeHandoff(client, foundation.orderId);
      await expect(
        client.query(`SET CONSTRAINTS ALL IMMEDIATE`),
      ).resolves.toBeDefined();
    });
  });

  it("couples every printing Job to its exact reservation group", async () => {
    await rollback("job-printing-reservations", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "job-printing-reservations",
        {},
        undefined,
        undefined,
        undefined,
        2,
        [{}, {}],
      );
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(client, fixtures, foundation, productions);
      const first = productions[0];
      const second = productions[1];
      if (!first || !second) {
        throw new Error("multi-Job reservation fixture is incomplete");
      }

      const startReservationGroup = async (
        production: ProductionReservationFixture,
      ): Promise<void> => {
        await client.query(
          `UPDATE inventory_reservations
           SET status = 'ALLOCATED'
           WHERE production_reservation_id = $1`,
          [production.productionReservationId],
        );
        await client.query(
          `UPDATE capacity_reservations
           SET status = 'SCHEDULED'
           WHERE production_reservation_id = $1`,
          [production.productionReservationId],
        );
        await client.query(
          `UPDATE production_reservations
           SET status = 'SCHEDULED' WHERE id = $1`,
          [production.productionReservationId],
        );
        await client.query(
          `UPDATE capacity_reservations
           SET status = 'PRINTING'
           WHERE production_reservation_id = $1`,
          [production.productionReservationId],
        );
        await client.query(
          `UPDATE production_reservations
           SET status = 'PRINTING' WHERE id = $1`,
          [production.productionReservationId],
        );
      };
      const completeReservationGroup = async (
        production: ProductionReservationFixture,
      ): Promise<void> => {
        await client.query(
          `UPDATE inventory_reservations
           SET status = 'CONSUMED', consumed_milligrams = reserved_milligrams
           WHERE production_reservation_id = $1`,
          [production.productionReservationId],
        );
        await client.query(
          `UPDATE capacity_reservations
           SET status = 'COMPLETED'
           WHERE production_reservation_id = $1`,
          [production.productionReservationId],
        );
        await client.query(
          `UPDATE production_reservations
           SET status = 'CONSUMED' WHERE id = $1`,
          [production.productionReservationId],
        );
      };

      const printingAt = new Date();
      await startReservationGroup(first);
      await client.query(
        `UPDATE jobs SET status = 'ACCEPTED', accepted_at = $2, updated_at = $2
         WHERE id = $1`,
        [first.jobId, printingAt],
      );
      await advanceAcceptedJobToGcodeReady(client, first.jobId, printingAt);
      await client.query(
        `UPDATE jobs SET status = 'PRINTING', printing_at = $2, updated_at = $2
         WHERE id = $1`,
        [first.jobId, printingAt],
      );
      await client.query(
        `UPDATE order_phases SET status = 'IN_PRODUCTION', updated_at = $2
         WHERE id = $1`,
        [foundation.orderPhaseId, printingAt],
      );
      await client.query(
        `UPDATE orders SET status = 'IN_PRODUCTION', updated_at = $2
         WHERE id = $1`,
        [foundation.orderId, printingAt],
      );
      await forceOrderLifecycleConstraints(client);

      await expectQueryError(
        client,
        "second_job_without_resources",
        async () => {
          await client.query(
            `UPDATE jobs
             SET status = 'ACCEPTED', accepted_at = $2, updated_at = $2
             WHERE id = $1`,
            [second.jobId, printingAt],
          );
          await advanceAcceptedJobToGcodeReady(
            client,
            second.jobId,
            printingAt,
          );
          await client.query(
            `UPDATE jobs
             SET status = 'PRINTING', printing_at = $2, updated_at = $2
             WHERE id = $1`,
            [second.jobId, printingAt],
          );
          await client.query(
            `SET CONSTRAINTS "jobs_printing_reservation_group_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "job_printing_reservation_group_check",
        },
      );

      await expectQueryError(
        client,
        "second_resources_without_job",
        async () => {
          await startReservationGroup(second);
          await client.query(
            `SET CONSTRAINTS
               "production_reservations_job_printing_reconciled",
               "capacity_reservations_job_printing_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "job_printing_reservation_group_check",
        },
      );

      await expectQueryError(
        client,
        "second_consumed_resources_without_job",
        async () => {
          await startReservationGroup(second);
          await completeReservationGroup(second);
          await client.query(
            `SET CONSTRAINTS
               "production_reservations_job_printing_reconciled",
               "inventory_reservations_job_printing_reconciled",
               "capacity_reservations_job_printing_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "job_printing_reservation_group_check",
        },
      );

      await expectQueryError(
        client,
        "second_job_with_completed_resources",
        async () => {
          await startReservationGroup(second);
          await completeReservationGroup(second);
          await client.query(
            `UPDATE jobs
             SET status = 'ACCEPTED', accepted_at = $2, updated_at = $2
             WHERE id = $1`,
            [second.jobId, printingAt],
          );
          await advanceAcceptedJobToGcodeReady(
            client,
            second.jobId,
            printingAt,
          );
          await client.query(
            `UPDATE jobs
             SET status = 'PRINTING', printing_at = $2, updated_at = $2
             WHERE id = $1`,
            [second.jobId, printingAt],
          );
          await client.query(
            `SET CONSTRAINTS "jobs_printing_reservation_group_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "job_printing_reservation_group_check",
        },
      );

      await expectQueryError(
        client,
        "terminal_job_with_live_resources",
        async () => {
          await client.query(
            `UPDATE jobs
             SET status = 'CANCELLED', cancelled_at = $2,
                 cancellation_reason = 'ORDER_CANCELLED', updated_at = $2
             WHERE id = $1`,
            [second.jobId, printingAt],
          );
          await startReservationGroup(second);
          await client.query(
            `SET CONSTRAINTS
               "production_reservations_job_printing_reconciled",
               "inventory_reservations_job_printing_reconciled",
               "capacity_reservations_job_printing_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "job_printing_reservation_group_check",
        },
      );

      await startReservationGroup(second);
      await client.query(
        `UPDATE jobs SET status = 'ACCEPTED', accepted_at = $2, updated_at = $2
         WHERE id = $1`,
        [second.jobId, printingAt],
      );
      await advanceAcceptedJobToGcodeReady(client, second.jobId, printingAt);
      await client.query(
        `UPDATE jobs SET status = 'PRINTING', printing_at = $2, updated_at = $2
         WHERE id = $1`,
        [second.jobId, printingAt],
      );
      await client.query(
        `SET CONSTRAINTS
           "jobs_printing_reservation_group_reconciled",
           "production_reservations_job_printing_reconciled",
           "inventory_reservations_job_printing_reconciled",
           "capacity_reservations_job_printing_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS
           "jobs_printing_reservation_group_reconciled",
           "production_reservations_job_printing_reconciled",
           "inventory_reservations_job_printing_reconciled",
           "capacity_reservations_job_printing_reconciled" DEFERRED`,
      );
    });
  });

  it("matches every handed-over Job to its Shipment plan", async () => {
    await rollback("shipment-job-handoff", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "shipment-job-handoff",
        {},
        undefined,
        undefined,
        undefined,
        2,
        [{}, {}],
      );
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(client, fixtures, foundation, productions);
      for (const status of [
        "IN_PRODUCTION",
        "QC_PASSED",
        "READY_TO_SHIP",
      ] as const) {
        await advanceOrderLifecycleStep(client, foundation.orderId, status);
      }
      const first = productions[0];
      const second = productions[1];
      const firstShipmentId = foundation.shipmentIds[0];
      if (!first || !second || !firstShipmentId) {
        throw new Error("multi-Shipment handoff fixture is incomplete");
      }
      const handedOverAt = new Date();

      await expectQueryError(
        client,
        "cross_plan_handoff",
        async () => {
          await client.query(
            `UPDATE shipments
             SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
             WHERE id = $1`,
            [firstShipmentId, handedOverAt],
          );
          await client.query(
            `UPDATE jobs
             SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
             WHERE id = $1`,
            [first.jobId, handedOverAt],
          );
          await client.query(
            `UPDATE jobs
             SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
             WHERE id = $1`,
            [second.jobId, handedOverAt],
          );
          await client.query(
            `UPDATE order_phases
             SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
             WHERE id = $1`,
            [foundation.orderPhaseId, handedOverAt],
          );
          await client.query(
            `UPDATE orders SET status = 'SHIPPED', updated_at = $2 WHERE id = $1`,
            [foundation.orderId, handedOverAt],
          );
          await forceOrderLifecycleConstraints(client);
        },
        {
          code: "23514",
          constraint: "order_post_confirmation_lifecycle_check",
        },
      );

      await client.query(
        `UPDATE shipments
         SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
         WHERE id = $1`,
        [firstShipmentId, handedOverAt],
      );
      await client.query(
        `UPDATE jobs
         SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
         WHERE id = $1`,
        [first.jobId, handedOverAt],
      );
      await client.query(
        `UPDATE order_phases
         SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
         WHERE id = $1`,
        [foundation.orderPhaseId, handedOverAt],
      );
      await client.query(
        `UPDATE orders SET status = 'SHIPPED', updated_at = $2 WHERE id = $1`,
        [foundation.orderId, handedOverAt],
      );
      await forceOrderLifecycleConstraints(client);
    });
  });

  it("hands over every Job assigned to a handed-over Shipment plan", async () => {
    await rollback("multi-job-shipment-handoff", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "multi-job-shipment-handoff",
        {},
        undefined,
        undefined,
        undefined,
        2,
        [{ quantity: 2 }],
      );
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(client, fixtures, foundation, productions);
      for (const status of [
        "IN_PRODUCTION",
        "QC_PASSED",
        "READY_TO_SHIP",
      ] as const) {
        await advanceOrderLifecycleStep(client, foundation.orderId, status);
      }
      const first = productions[0];
      const shipmentId = foundation.shipmentIds[0];
      if (!first || !productions[1] || !shipmentId) {
        throw new Error("multi-Job Shipment fixture is incomplete");
      }
      const handedOverAt = new Date();

      await expectQueryError(
        client,
        "partial_plan_handoff",
        async () => {
          await client.query(
            `UPDATE shipments
             SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
             WHERE id = $1`,
            [shipmentId, handedOverAt],
          );
          await client.query(
            `UPDATE jobs
             SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
             WHERE id = $1`,
            [first.jobId, handedOverAt],
          );
          await client.query(
            `UPDATE order_phases
             SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
             WHERE id = $1`,
            [foundation.orderPhaseId, handedOverAt],
          );
          await client.query(
            `UPDATE orders SET status = 'SHIPPED', updated_at = $2 WHERE id = $1`,
            [foundation.orderId, handedOverAt],
          );
          await forceOrderLifecycleConstraints(client);
        },
        {
          code: "23514",
          constraint: "order_post_confirmation_lifecycle_check",
        },
      );

      await advanceOrderLifecycleStep(client, foundation.orderId, "SHIPPED");
    });
  });

  it("transitions each Shipment and its exact fulfilment slots atomically", async () => {
    await rollback("shipment-slot-delivery", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "shipment-slot-delivery",
        {},
        undefined,
        undefined,
        undefined,
        2,
        [{ quantity: 2 }, { quantity: 1 }],
      );
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      const firstPlanId = foundation.shipmentPlanIds[0];
      const secondPlanId = foundation.shipmentPlanIds[1];
      const replacedShipmentId = foundation.shipmentIds[0];
      const firstShipmentId = fixtures.id("replacement-shipment");
      if (!firstPlanId || !secondPlanId || !replacedShipmentId) {
        throw new Error("multi-parcel delivery fixture is incomplete");
      }
      await activateCurrentPlan(client, fixtures, foundation, productions);
      for (const status of [
        "IN_PRODUCTION",
        "QC_PASSED",
        "READY_TO_SHIP",
      ] as const) {
        await advanceOrderLifecycleStep(client, foundation.orderId, status);
      }
      await expectQueryError(
        client,
        "replace_live_shipment",
        async () => {
          const attemptedAt = new Date();
          await client.query(
            `INSERT INTO shipments
               (id, order_id, order_phase_id, shipment_plan_id,
                delivery_destination_id, replaces_shipment_id, created_at, updated_at)
             SELECT $1, order_id, order_phase_id, shipment_plan_id,
                    delivery_destination_id, id, $3, $3
             FROM shipments
             WHERE id = $2`,
            [
              fixtures.id("invalid-live-replacement"),
              replacedShipmentId,
              attemptedAt,
            ],
          );
          await client.query(
            `SET CONSTRAINTS
               "shipments_fulfilment_slots_terminal_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "shipment_replacement_predecessor_terminal_check",
        },
      );
      const cancelledAt = new Date();
      await client.query(
        `UPDATE shipments
         SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2
         WHERE id = $1`,
        [replacedShipmentId, cancelledAt],
      );
      await client.query(
        `INSERT INTO shipments
           (id, order_id, order_phase_id, shipment_plan_id,
            delivery_destination_id, replaces_shipment_id, created_at, updated_at)
         SELECT $1, order_id, order_phase_id, shipment_plan_id,
                delivery_destination_id, id, $3, $3
         FROM shipments
         WHERE id = $2`,
        [firstShipmentId, replacedShipmentId, cancelledAt],
      );
      await client.query(
        `UPDATE shipments
         SET status = 'LABEL_CREATED', carrier = 'test-carrier',
             provider_shipment_id = 'provider-' || id::text,
             tracking_code = 'tracking-' || id::text,
             label_created_at = $2, updated_at = $2
         WHERE id = $1`,
        [firstShipmentId, cancelledAt],
      );
      await forceOrderLifecycleConstraints(client);
      await advanceOrderLifecycleStep(client, foundation.orderId, "SHIPPED");

      await expectQueryError(
        client,
        "deliver_slot_from_live_other_parcel",
        async () => {
          await client.query(
            `UPDATE fulfilment_slots
             SET outcome = 'DELIVERED', updated_at = $2
             WHERE id = (
               SELECT allocation.fulfilment_slot_id
               FROM shipment_plan_fulfilment_slots allocation
               WHERE allocation.shipment_plan_id = $1
               ORDER BY allocation.fulfilment_slot_id
               LIMIT 1
             )`,
            [secondPlanId, new Date()],
          );
          await client.query(
            `SET CONSTRAINTS
               "fulfilment_slots_shipment_plan_terminal_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "shipment_plan_slot_terminal_reconciliation_check",
        },
      );

      await expectQueryError(
        client,
        "cancel_refund_slot_from_live_parcel",
        async () => {
          await client.query(
            `UPDATE fulfilment_slots
             SET outcome = 'CANCELLED_REFUNDED', updated_at = $2
             WHERE id = (
               SELECT allocation.fulfilment_slot_id
               FROM shipment_plan_fulfilment_slots allocation
               WHERE allocation.shipment_plan_id = $1
               ORDER BY allocation.fulfilment_slot_id
               LIMIT 1
             )`,
            [secondPlanId, new Date()],
          );
          await client.query(
            `SET CONSTRAINTS
               "fulfilment_slots_shipment_plan_terminal_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "shipment_plan_slot_terminal_reconciliation_check",
        },
      );

      await expectQueryError(
        client,
        "deliver_only_part_of_parcel",
        async () => {
          const deliveredAt = new Date();
          await client.query(
            `UPDATE shipments
             SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
             WHERE id = $1`,
            [firstShipmentId, deliveredAt],
          );
          await client.query(
            `UPDATE fulfilment_slots
             SET outcome = 'DELIVERED', updated_at = $2
             WHERE id = (
               SELECT allocation.fulfilment_slot_id
               FROM shipment_plan_fulfilment_slots allocation
               WHERE allocation.shipment_plan_id = $1
               ORDER BY allocation.fulfilment_slot_id
               LIMIT 1
             )`,
            [firstPlanId, deliveredAt],
          );
          await client.query(
            `SET CONSTRAINTS
               "fulfilment_slots_shipment_plan_terminal_reconciled",
               "shipments_fulfilment_slots_terminal_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "shipment_plan_slot_terminal_reconciliation_check",
        },
      );

      const deliveredAt = new Date();
      await client.query(
        `UPDATE shipments
         SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
         WHERE id = $1`,
        [firstShipmentId, deliveredAt],
      );
      await client.query(
        `UPDATE fulfilment_slots slot
         SET outcome = 'DELIVERED', updated_at = $2
         FROM shipment_plan_fulfilment_slots allocation
         WHERE allocation.fulfilment_slot_id = slot.id
           AND allocation.shipment_plan_id = $1`,
        [firstPlanId, deliveredAt],
      );
      await client.query(
        `SET CONSTRAINTS
           "fulfilment_slots_shipment_plan_terminal_reconciled",
           "shipments_fulfilment_slots_terminal_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS
           "fulfilment_slots_shipment_plan_terminal_reconciled",
           "shipments_fulfilment_slots_terminal_reconciled" DEFERRED`,
      );
      expect(
        (
          await client.query<{ status: string }>(
            `SELECT status::text FROM orders WHERE id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([{ status: "SHIPPED" }]);
      expect(
        (
          await client.query<{ id: string; status: string }>(
            `SELECT id::text, status::text
             FROM shipments
             WHERE id IN ($1, $2)
             ORDER BY id`,
            [replacedShipmentId, firstShipmentId],
          )
        ).rows,
      ).toEqual(
        [
          { id: replacedShipmentId, status: "CANCELLED" },
          { id: firstShipmentId, status: "DELIVERED" },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );

      await expectQueryError(
        client,
        "finish_delivery_without_parent_transition",
        async () => {
          const finalDeliveredAt = new Date();
          await client.query(
            `UPDATE shipments
             SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
             WHERE order_id = $1 AND status IN ('HANDED_OVER', 'IN_TRANSIT')`,
            [foundation.orderId, finalDeliveredAt],
          );
          await client.query(
            `UPDATE fulfilment_slots
             SET outcome = 'DELIVERED', updated_at = $2
             WHERE order_id = $1 AND outcome = 'PENDING'`,
            [foundation.orderId, finalDeliveredAt],
          );
          await forceOrderLifecycleConstraints(client);
        },
        {
          code: "23514",
          constraint: "order_post_confirmation_lifecycle_check",
        },
      );

      await advanceOrderLifecycleStep(client, foundation.orderId, "DELIVERED");
    });
  });

  it("settles exact reservation groups before completing an order", async () => {
    await rollback("completed-reservations", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "completed-reservations",
      );
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(client, fixtures, foundation, productions);
      for (const status of [
        "IN_PRODUCTION",
        "QC_PASSED",
        "READY_TO_SHIP",
        "SHIPPED",
        "DELIVERED",
      ] as const) {
        await advanceOrderLifecycleStep(client, foundation.orderId, status);
      }

      await expectQueryError(
        client,
        "complete_with_held_reservation_set",
        async () => {
          const completedAt = new Date();
          await client.query(
            `UPDATE jobs
             SET status = 'SETTLED', settled_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, completedAt],
          );
          await client.query(
            `UPDATE order_phases
             SET status = 'COMPLETED', completed_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, completedAt],
          );
          await client.query(
            `UPDATE orders SET status = 'COMPLETED', updated_at = $2 WHERE id = $1`,
            [foundation.orderId, completedAt],
          );
          await client.query(
            `SET CONSTRAINTS "orders_cancelled_reservations_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "completed_order_reservation_settlement_check",
        },
      );

      await advanceOrderLifecycleStep(client, foundation.orderId, "COMPLETED");
      expect(
        (
          await client.query<{
            capacity_status: string;
            inventory_status: string;
            production_status: string;
            set_status: string;
          }>(
            `SELECT reservation_set.status::text AS set_status,
                    production.status::text AS production_status,
                    inventory_reservation.status::text AS inventory_status,
                    capacity_reservation.status::text AS capacity_status
             FROM phase_reservation_sets reservation_set
             JOIN production_reservations production
               ON production.phase_reservation_set_id = reservation_set.id
             JOIN inventory_reservations inventory_reservation
               ON inventory_reservation.production_reservation_id = production.id
             JOIN capacity_reservations capacity_reservation
               ON capacity_reservation.production_reservation_id = production.id
             WHERE reservation_set.id = $1`,
            [foundation.phaseReservationSetId],
          )
        ).rows,
      ).toEqual([
        {
          set_status: "SETTLED",
          production_status: "CONSUMED",
          inventory_status: "CONSUMED",
          capacity_status: "COMPLETED",
        },
      ]);
    });
  });

  it("requires aggregate evidence for every post-confirmation order edge", async () => {
    await rollback("order-lifecycle-evidence", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "order-lifecycle-evidence",
      );
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(client, fixtures, foundation, productions);

      await expectQueryError(
        client,
        "skip_phase_lifecycle",
        () =>
          client.query(
            `UPDATE order_phases SET status = 'COMPLETED' WHERE order_id = $1`,
            [foundation.orderId],
          ),
        { code: "23514", constraint: "order_phase_status_transition_check" },
      );
      await expectQueryError(
        client,
        "skip_job_lifecycle",
        () =>
          client.query(
            `UPDATE jobs SET status = 'SETTLED' WHERE order_id = $1`,
            [foundation.orderId],
          ),
        { code: "23514", constraint: "job_status_transition_check" },
      );
      await expectQueryError(
        client,
        "skip_gcode_ready",
        async () => {
          const transitionedAt = new Date();
          await client.query(
            `UPDATE jobs
             SET status = 'ACCEPTED', accepted_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, transitionedAt],
          );
          await client.query(
            `UPDATE jobs
             SET status = 'PRINTING', printing_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, transitionedAt],
          );
        },
        { code: "23514", constraint: "job_status_transition_check" },
      );
      await expectQueryError(
        client,
        "gcode_ready_with_wrong_artifact_hash",
        async () => {
          const transitionedAt = new Date();
          await client.query(
            `UPDATE jobs
             SET status = 'ACCEPTED', accepted_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, transitionedAt],
          );
          await client.query(
            `UPDATE jobs job
             SET status = 'GCODE_READY', gcode_ready_at = $2,
                 production_slice_result_id = production.slice_result_id,
                 production_artifact_hash = repeat('f', 64), updated_at = $2
             FROM production_reservations production
             WHERE job.order_id = $1 AND production.job_id = job.id`,
            [foundation.orderId, transitionedAt],
          );
        },
        { code: "23514", constraint: "job_gcode_artifact_check" },
      );
      await expectQueryError(
        client,
        "skip_shipment_lifecycle",
        () =>
          client.query(
            `UPDATE shipments SET status = 'DELIVERED' WHERE order_id = $1`,
            [foundation.orderId],
          ),
        { code: "23514", constraint: "shipment_status_transition_check" },
      );
      const prematureEvidenceAt = new Date();
      await expectQueryError(
        client,
        "premature_phase_evidence",
        () =>
          client.query(
            `UPDATE order_phases
             SET status = 'IN_PRODUCTION', qc_passed_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, prematureEvidenceAt],
          ),
        {
          code: "23514",
          constraint: "order_phase_lifecycle_evidence_check",
        },
      );
      await expectQueryError(
        client,
        "phase_cancellation_before_activation",
        () =>
          client.query(
            `UPDATE order_phases
             SET status = 'CANCELLED',
                 cancelled_at = activated_at - interval '1 millisecond'
             WHERE order_id = $1`,
            [foundation.orderId],
          ),
        {
          code: "23514",
          constraint: "order_phase_lifecycle_evidence_check",
        },
      );
      await expectQueryError(
        client,
        "premature_job_evidence",
        () =>
          client.query(
            `UPDATE jobs
             SET status = 'ACCEPTED', accepted_at = $2, printing_at = $2,
                 qc_approved_at = $2, packed_at = $2, handed_over_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, prematureEvidenceAt],
          ),
        { code: "23514", constraint: "job_lifecycle_evidence_check" },
      );
      await expectQueryError(
        client,
        "premature_shipment_evidence",
        () =>
          client.query(
            `UPDATE shipments
             SET status = 'LABEL_CREATED', carrier = 'test-carrier',
                 provider_shipment_id = 'premature-provider',
                 label_created_at = $2, handed_over_at = $2, delivered_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, prematureEvidenceAt],
          ),
        { code: "23514", constraint: "shipment_lifecycle_evidence_check" },
      );

      for (const status of [
        "IN_PRODUCTION",
        "QC_PASSED",
        "READY_TO_SHIP",
        "SHIPPED",
        "DELIVERED",
        "COMPLETED",
      ] as const) {
        await expectQueryError(
          client,
          `order_${status.toLowerCase()}_without_evidence`,
          async () => {
            await client.query(
              `UPDATE orders SET status = $2::order_status WHERE id = $1`,
              [foundation.orderId, status],
            );
            await forceOrderLifecycleConstraints(client);
          },
          {
            code: "23514",
            constraint:
              status === "COMPLETED"
                ? "completed_order_reservation_settlement_check"
                : "order_post_confirmation_lifecycle_check",
          },
        );
        await advanceOrderLifecycleStep(client, foundation.orderId, status);
        if (status === "IN_PRODUCTION") {
          await expectQueryError(
            client,
            "deliver_while_order_in_production",
            async () => {
              const deliveredAt = new Date();
              await client.query(
                `UPDATE shipments
                 SET status = 'LABEL_CREATED', carrier = 'test-carrier',
                     provider_shipment_id = 'provider-premature-delivery',
                     tracking_code = 'tracking-premature-delivery',
                     label_created_at = $2, updated_at = $2
                 WHERE order_id = $1`,
                [foundation.orderId, deliveredAt],
              );
              await client.query(
                `UPDATE shipments
                 SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
                 WHERE order_id = $1`,
                [foundation.orderId, deliveredAt],
              );
              await client.query(
                `UPDATE shipments
                 SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
                 WHERE order_id = $1`,
                [foundation.orderId, deliveredAt],
              );
              await client.query(
                `UPDATE fulfilment_slots
                 SET outcome = 'DELIVERED', updated_at = $2
                 WHERE order_id = $1`,
                [foundation.orderId, deliveredAt],
              );
              await forceOrderLifecycleConstraints(client);
            },
            {
              code: "23514",
              constraint: "order_post_confirmation_lifecycle_check",
            },
          );
        }
        if (status === "QC_PASSED") {
          await expectQueryError(
            client,
            "release_active_order_qc_photo",
            () =>
              client.query(
                `UPDATE photo_assets photo
                 SET retention_hold = 'NONE'
                 FROM jobs job
                 WHERE job.order_id = $1
                   AND job.qc_photo_asset_id = photo.id`,
                [foundation.orderId],
              ),
            {
              code: "23514",
              constraint: "job_qc_photo_active_order_check",
            },
          );
        }
        if (status === "READY_TO_SHIP") {
          await expectQueryError(
            client,
            "shipment_cancellation_before_label",
            () =>
              client.query(
                `UPDATE shipments
                 SET status = 'CANCELLED',
                     cancelled_at = label_created_at - interval '1 millisecond'
                 WHERE order_id = $1`,
                [foundation.orderId],
              ),
            {
              code: "23514",
              constraint: "shipment_lifecycle_evidence_check",
            },
          );
        }
      }

      expect(
        (
          await client.query<{ status: string }>(
            `SELECT status::text FROM orders WHERE id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([{ status: "COMPLETED" }]);

      await expectQueryError(
        client,
        "erase_job_lifecycle_evidence",
        () =>
          client.query(
            `UPDATE jobs SET printing_at = NULL WHERE order_id = $1`,
            [foundation.orderId],
          ),
        { code: "23514", constraint: "job_lifecycle_immutable_check" },
      );
      await expectQueryError(
        client,
        "erase_shipment_lifecycle_evidence",
        () =>
          client.query(
            `UPDATE shipments SET delivered_at = NULL WHERE order_id = $1`,
            [foundation.orderId],
          ),
        { code: "23514", constraint: "shipment_lifecycle_immutable_check" },
      );
      await expectQueryError(
        client,
        "erase_phase_lifecycle_evidence",
        () =>
          client.query(
            `UPDATE order_phases SET qc_passed_at = NULL WHERE order_id = $1`,
            [foundation.orderId],
          ),
        {
          code: "23514",
          constraint: "order_phase_lifecycle_immutable_check",
        },
      );
    });
  });

  it("requires scoped payment topology and retains provider/refund identities", async () => {
    await rollback("scoped-identities", async (client, fixtures) => {
      await expectQueryError(
        client,
        "terminal_order_insert",
        () =>
          client.query(
            `INSERT INTO orders
             (id, public_reference, status, created_at, updated_at)
             VALUES ($1,$2,'COMPLETED',$3,$3)`,
            [
              fixtures.id("terminal-order-insert"),
              "terminal-order-insert",
              new Date(),
            ],
          ),
        { code: "23514", constraint: "order_status_transition_check" },
      );
      const foundation = await fixtures.createFoundation(
        "scoped-identities",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      await expectQueryError(
        client,
        "change_order_public_reference",
        () =>
          client.query(
            `UPDATE orders SET public_reference = public_reference || '-changed'
             WHERE id = $1`,
            [foundation.orderId],
          ),
        { code: "23514", constraint: "order_identity_immutable_check" },
      );
      await expectQueryError(
        client,
        "change_order_id",
        () =>
          client.query(`UPDATE orders SET id = $2 WHERE id = $1`, [
            foundation.orderId,
            fixtures.id("changed-order-id"),
          ]),
        { code: "23514", constraint: "order_identity_immutable_check" },
      );
      await client.query(
        `UPDATE reference_profiles
         SET state = 'RETIRED', retired_at = $1
         WHERE material = 'PLA' AND quality = 'STANDARD' AND state = 'ACTIVE'`,
        [new Date()],
      );
      const other = await fixtures.createFoundation("other");
      const ownedSessionId = fixtures.id("owned-session-without-request");
      const ownedRequestId = fixtures.id("owned-session-request");
      const otherOwnedSessionId = fixtures.id(
        "other-owned-session-without-request",
      );
      const ownershipCreatedAt = new Date();
      await client.query(
        `INSERT INTO quote_sessions
         (id, customer_id, public_token_hash, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5), ($6,$7,$8,$4,$5,$5)`,
        [
          ownedSessionId,
          foundation.customerId,
          "d".repeat(64),
          new Date(ownershipCreatedAt.getTime() + 60 * 60 * 1_000),
          ownershipCreatedAt,
          otherOwnedSessionId,
          other.customerId,
          "e".repeat(64),
        ],
      );
      const closedSessionCases = [
        {
          name: "expired_state",
          status: "EXPIRED",
          createdAt: ownershipCreatedAt,
          expiresAt: new Date(ownershipCreatedAt.getTime() + 60 * 60 * 1_000),
        },
        {
          name: "cancelled_state",
          status: "CANCELLED",
          createdAt: ownershipCreatedAt,
          expiresAt: new Date(ownershipCreatedAt.getTime() + 60 * 60 * 1_000),
        },
        {
          name: "elapsed_open",
          status: "OPEN",
          createdAt: new Date(
            ownershipCreatedAt.getTime() - 2 * 60 * 60 * 1_000,
          ),
          expiresAt: new Date(ownershipCreatedAt.getTime() - 60 * 60 * 1_000),
        },
      ] as const;
      for (const closedSession of closedSessionCases) {
        const sessionId = fixtures.id(`closed-commerce-${closedSession.name}`);
        await client.query(
          `INSERT INTO quote_sessions
           (id, customer_id, public_token_hash, status, expires_at,
            created_at, updated_at)
           VALUES ($1,$2,$3,$4::quote_session_status,$5,$6,$6)`,
          [
            sessionId,
            foundation.customerId,
            randomUUID().replaceAll("-", "").padEnd(64, "f"),
            closedSession.status,
            closedSession.expiresAt,
            closedSession.createdAt,
          ],
        );
        await expectQueryError(
          client,
          `attach_request_${closedSession.name}`,
          () =>
            client.query(
              `INSERT INTO quote_requests
               (id, quote_session_id, customer_id, status, created_at, updated_at)
               VALUES ($1,$2,$3,'NEW',$4,$4)`,
              [
                fixtures.id(`closed-request-${closedSession.name}`),
                sessionId,
                foundation.customerId,
                ownershipCreatedAt,
              ],
            ),
          { code: "23514", constraint: "quote_session_commerce_open_check" },
        );
        await expectQueryError(
          client,
          `attach_order_${closedSession.name}`,
          async () => {
            const orderId = fixtures.id(`closed-order-${closedSession.name}`);
            await client.query(
              `INSERT INTO orders
               (id, customer_id, public_reference, status, created_at, updated_at)
               VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
              [
                orderId,
                foundation.customerId,
                `T-${closedSession.name}`,
                ownershipCreatedAt,
              ],
            );
            await client.query(
              `INSERT INTO automatic_order_origins (order_id, quote_session_id)
               VALUES ($1,$2)`,
              [orderId, sessionId],
            );
          },
          { code: "23514", constraint: "quote_session_commerce_open_check" },
        );
      }
      await expectQueryError(
        client,
        "cross_customer_quote_request_insert",
        () =>
          client.query(
            `INSERT INTO quote_requests
             (id, quote_session_id, customer_id, status, created_at, updated_at)
             VALUES ($1,$2,$3,'NEW',$4,$4)`,
            [
              ownedRequestId,
              ownedSessionId,
              other.customerId,
              ownershipCreatedAt,
            ],
          ),
        { code: "23514", constraint: "quote_request_session_owner_check" },
      );
      await client.query(
        `INSERT INTO quote_requests
         (id, quote_session_id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,'NEW',$4,$4)`,
        [
          ownedRequestId,
          ownedSessionId,
          foundation.customerId,
          ownershipCreatedAt,
        ],
      );
      await expectQueryError(
        client,
        "cross_customer_quote_request_update",
        () =>
          client.query(
            `UPDATE quote_requests SET customer_id = $2 WHERE id = $1`,
            [ownedRequestId, other.customerId],
          ),
        { code: "23514", constraint: "quote_request_session_owner_check" },
      );
      await expectQueryError(
        client,
        "cross_customer_quote_session_move",
        () =>
          client.query(
            `UPDATE quote_requests SET quote_session_id = $2 WHERE id = $1`,
            [ownedRequestId, otherOwnedSessionId],
          ),
        { code: "23514", constraint: "quote_request_session_owner_check" },
      );
      await expectQueryError(
        client,
        "cross_customer_quote_session_owner_update",
        () =>
          client.query(
            `UPDATE quote_sessions SET customer_id = $2 WHERE id = $1`,
            [ownedSessionId, other.customerId],
          ),
        { code: "23514", constraint: "quote_request_session_owner_check" },
      );
      await expectQueryError(
        client,
        "skip_draft_lifecycle",
        () =>
          client.query(`UPDATE orders SET status = 'COMPLETED' WHERE id = $1`, [
            foundation.orderId,
          ]),
        { code: "23514", constraint: "order_status_transition_check" },
      );
      await expectQueryError(
        client,
        "draft_order_payment",
        () => createCurrentPlanAndPayment(client, fixtures, foundation),
        { code: "23514", constraint: "payment_fulfilment_topology_check" },
      );
      await expectQueryError(
        client,
        "quote_without_timestamp",
        () =>
          client.query(`UPDATE orders SET status = 'QUOTED' WHERE id = $1`, [
            foundation.orderId,
          ]),
        {
          code: "23514",
          constraint: "order_lifecycle_timestamp_check",
        },
      );
      await expectQueryError(
        client,
        "preassign_quoted_timestamp",
        () =>
          client.query(`UPDATE orders SET quoted_at = $2 WHERE id = $1`, [
            foundation.orderId,
            new Date(),
          ]),
        {
          code: "23514",
          constraint: "order_lifecycle_timestamp_check",
        },
      );
      await client.query(
        `UPDATE orders SET status = 'QUOTED', quoted_at = $2 WHERE id = $1`,
        [foundation.orderId, new Date()],
      );
      expect(
        (
          await client.query<{
            confirmed_is_null: boolean;
            quoted_is_recorded: boolean;
          }>(
            `SELECT quoted_at IS NOT NULL AS quoted_is_recorded,
                    confirmed_at IS NULL AS confirmed_is_null
             FROM orders WHERE id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([{ quoted_is_recorded: true, confirmed_is_null: true }]);
      await expectQueryError(
        client,
        "rewrite_quoted_timestamp",
        () =>
          client.query(
            `UPDATE orders SET quoted_at = quoted_at + interval '1 millisecond'
             WHERE id = $1`,
            [foundation.orderId],
          ),
        {
          code: "23514",
          constraint: "order_lifecycle_timestamp_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "preassign_confirmed_timestamp",
        () =>
          client.query(`UPDATE orders SET confirmed_at = $2 WHERE id = $1`, [
            foundation.orderId,
            new Date(),
          ]),
        {
          code: "23514",
          constraint: "order_lifecycle_timestamp_check",
        },
      );
      await expectQueryError(
        client,
        "confirm_without_timestamp",
        () =>
          client.query(`UPDATE orders SET status = 'CONFIRMED' WHERE id = $1`, [
            foundation.orderId,
          ]),
        {
          code: "23514",
          constraint: "order_lifecycle_timestamp_check",
        },
      );
      await expectQueryError(
        client,
        "skip_quoted_lifecycle",
        () =>
          client.query(`UPDATE orders SET status = 'SHIPPED' WHERE id = $1`, [
            foundation.orderId,
          ]),
        { code: "23514", constraint: "order_status_transition_check" },
      );
      const foundationProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await createCurrentPlanAndPayment(client, fixtures, other);
      await expectQueryError(
        client,
        "captured_payment_insert",
        () =>
          client.query(
            `INSERT INTO payments (id, order_id, price_snapshot_id, order_price_binding_id,
                                  payment_schedule_id, role, provider, provider_intent_id,
                                  provider_capture_id, requested_amount_minor,
                                  captured_amount_minor, currency, status,
                                  checkout_capture_expires_at, captured_at,
                                  created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'FULL','test',$6,$7,950,950,'EUR','CAPTURED',$9,$8,$8,$8)`,
            [
              fixtures.id("direct-captured-payment"),
              foundation.orderId,
              foundation.priceSnapshotId,
              foundation.orderPriceBindingId,
              foundation.paymentScheduleId,
              "direct-captured-intent",
              "direct-captured-capture",
              new Date(),
              new Date(Date.now() + 60 * 60 * 1_000),
            ],
          ),
        { code: "23514", constraint: "payment_initial_status_check" },
      );
      await expectQueryError(
        client,
        "audit_order_payment_scope",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, order_id, payment_id, event_type, payload, created_at)
             VALUES ($1,$2,$3,'payment.scope_mismatch','{}'::jsonb,$4)`,
            [
              fixtures.id("audit-order-payment-mismatch"),
              foundation.orderId,
              other.paymentId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_scope_reconciliation_check",
        },
      );
      await expectQueryError(
        client,
        "audit_quote_order_scope",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, quote_id, order_id, event_type, payload, created_at)
             VALUES ($1,$2,$3,'quote.order_scope_mismatch','{}'::jsonb,$4)`,
            [
              fixtures.id("audit-quote-order-mismatch"),
              other.quoteId,
              foundation.orderId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_scope_reconciliation_check",
        },
      );
      await expectQueryError(
        client,
        "audit_quote_payment_scope",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, quote_id, payment_id, event_type, payload, created_at)
             VALUES ($1,$2,$3,'quote.payment_scope_mismatch','{}'::jsonb,$4)`,
            [
              fixtures.id("audit-quote-payment-mismatch"),
              other.quoteId,
              foundation.paymentId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_scope_reconciliation_check",
        },
      );
      await client.query(
        `INSERT INTO audit_events
         (id, quote_id, order_id, payment_id, event_type, payload, created_at)
         VALUES ($1,$2,$3,$4,'quote.payment_scope_consistent','{}'::jsonb,$5)`,
        [
          fixtures.id("audit-quote-payment-consistent"),
          foundation.quoteId,
          foundation.orderId,
          foundation.paymentId,
          new Date(),
        ],
      );
      await expectQueryError(
        client,
        "move_issued_request_quote_session",
        () =>
          client.query(
            `UPDATE quote_requests SET quote_session_id = $2 WHERE id = $1`,
            [foundation.quoteRequestId, other.quoteSessionId],
          ),
        {
          code: "23514",
          constraint: "quote_request_issued_quote_identity_check",
        },
      );
      await expectQueryError(
        client,
        "cross_order_shipment",
        () =>
          client.query(
            `INSERT INTO shipments (id, order_id, order_phase_id, shipment_plan_id,
                                   delivery_destination_id, replaces_shipment_id,
                                   created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
            [
              fixtures.id("bad-shipment"),
              foundation.orderId,
              foundation.orderPhaseId,
              other.shipmentPlanId,
              foundation.deliveryDestinationId,
              other.shipmentId,
              new Date(),
            ],
          ),
        { code: "23503" },
      );
      await expectQueryError(
        client,
        "cross_order_payment",
        () =>
          client.query(
            `INSERT INTO payments (id, order_id, price_snapshot_id, order_price_binding_id,
                                  payment_schedule_id, role, provider, requested_amount_minor,
                                  currency, checkout_capture_expires_at,
                                  created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'FULL','test',950,'EUR',$6,$7,$7)`,
            [
              fixtures.id("cross-order-payment"),
              foundation.orderId,
              other.priceSnapshotId,
              other.orderPriceBindingId,
              other.paymentScheduleId,
              new Date(Date.now() + 60 * 60 * 1_000),
              new Date(),
            ],
          ),
        { code: "23514", constraint: "payment_fulfilment_topology_check" },
      );
      await expectQueryError(
        client,
        "zero_refund",
        () =>
          client.query(
            `INSERT INTO refund_transactions (id, payment_id, idempotency_key,
                                               amount_minor, reason, created_at, updated_at)
             VALUES ($1,$2,$3,0,'CUSTOMER_CANCELLATION',$4,$4)`,
            [
              fixtures.id("refund-zero"),
              foundation.paymentId,
              "r1",
              new Date(),
            ],
          ),
        { code: "23514" },
      );
      const payment = await client.query<{
        provider_intent_id: string;
        requested_amount_minor: string;
      }>(
        `SELECT provider_intent_id, requested_amount_minor::text
         FROM payments WHERE id = $1`,
        [foundation.paymentId],
      );
      const capturedAmount = payment.rows[0]?.requested_amount_minor;
      const providerIntentId = payment.rows[0]?.provider_intent_id;
      if (!capturedAmount || !providerIntentId) {
        throw new Error("fixture payment is missing");
      }
      await expectQueryError(
        client,
        "duplicate_provider",
        () =>
          client.query(
            `INSERT INTO payments (id, order_id, price_snapshot_id, order_price_binding_id,
                                  payment_schedule_id, role, provider, provider_intent_id,
                                  requested_amount_minor, currency,
                                  checkout_capture_expires_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'FULL','test',$6,$7,'EUR',$8,$9,$9)`,
            [
              fixtures.id("duplicate-payment"),
              foundation.orderId,
              foundation.priceSnapshotId,
              foundation.orderPriceBindingId,
              foundation.paymentScheduleId,
              providerIntentId,
              capturedAmount,
              new Date(Date.now() + 60 * 60 * 1_000),
              new Date(),
            ],
          ),
        { code: "23505" },
      );
      const remainingRefundAmount = Number(capturedAmount) - 600;
      if (remainingRefundAmount <= 0) {
        throw new Error("fixture payment cannot support a partial refund");
      }
      await expectQueryError(
        client,
        "capture_without_provider_facts",
        () =>
          client.query(
            `UPDATE payments SET status = 'CAPTURED' WHERE id = $1`,
            [foundation.paymentId],
          ),
        { code: "23514", constraint: "payments_capture_facts_check" },
      );
      await activateCurrentPlan(
        client,
        fixtures,
        foundation,
        foundationProductions,
      );
      expect(
        (
          await client.query<{ lifecycle_timestamps_ordered: boolean }>(
            `SELECT confirmed_at >= quoted_at AS lifecycle_timestamps_ordered
             FROM orders WHERE id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([{ lifecycle_timestamps_ordered: true }]);
      for (const [name, timestampExpression] of [
        ["clear_confirmed_timestamp", "NULL"],
        [
          "rewrite_confirmed_timestamp",
          "confirmed_at + interval '1 millisecond'",
        ],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            client.query(
              `UPDATE orders SET confirmed_at = ${timestampExpression}
               WHERE id = $1`,
              [foundation.orderId],
            ),
          {
            code: "23514",
            constraint: "order_lifecycle_timestamp_immutable_check",
          },
        );
      }
      await expectQueryError(
        client,
        "active_order_pending_customer_cancellation_refund",
        async () => {
          const requestedAt = new Date();
          await client.query(
            `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                requested_at, created_at, updated_at)
             VALUES ($1,$2,$3,1,'CUSTOMER_CANCELLATION','PENDING',$4,$4,$4)`,
            [
              fixtures.id("active-order-pending-refund"),
              foundation.paymentId,
              "active-order-pending-refund",
              requestedAt,
            ],
          );
          await client.query(
            `SET CONSTRAINTS
               "payments_refund_status_reconciled",
               "refund_transactions_payment_status_reconciled",
               "payments_customer_cancellation_refund_reconciled",
               "refunds_customer_cancellation_order_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "order_customer_cancellation_refund_lifecycle_check",
        },
      );
      await expectQueryError(
        client,
        "active_order_partial_customer_cancellation_refund",
        async () => {
          const completedAt = new Date();
          await client.query(
            `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                provider_refund_id, requested_at, completed_at, created_at, updated_at)
             VALUES ($1,$2,$3,1,'CUSTOMER_CANCELLATION','SUCCEEDED',$4,$5,$5,$5,$5)`,
            [
              fixtures.id("active-order-partial-refund"),
              foundation.paymentId,
              "active-order-partial-refund",
              "provider-active-order-partial-refund",
              completedAt,
            ],
          );
          await client.query(
            `UPDATE payments SET status = 'PARTIALLY_REFUNDED' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `SET CONSTRAINTS
               "payments_refund_status_reconciled",
               "refund_transactions_payment_status_reconciled",
               "payments_customer_cancellation_refund_reconciled",
               "refunds_customer_cancellation_order_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "order_customer_cancellation_refund_lifecycle_check",
        },
      );
      await expectQueryError(
        client,
        "active_order_full_customer_cancellation_refund",
        async () => {
          const completedAt = new Date();
          await client.query(
            `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                provider_refund_id, requested_at, completed_at, created_at, updated_at)
             SELECT $1,id,$2,captured_amount_minor,'CUSTOMER_CANCELLATION',
                    'SUCCEEDED',$3,$4,$4,$4,$4
             FROM payments WHERE id = $5`,
            [
              fixtures.id("active-order-full-refund"),
              "active-order-full-refund",
              "provider-active-order-full-refund",
              completedAt,
              foundation.paymentId,
            ],
          );
          await client.query(
            `UPDATE payments SET status = 'REFUNDED' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `SET CONSTRAINTS
               "payments_refund_status_reconciled",
               "refund_transactions_payment_status_reconciled",
               "payments_customer_cancellation_refund_reconciled",
               "refunds_customer_cancellation_order_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "order_customer_cancellation_refund_lifecycle_check",
        },
      );
      await cancelOrderBeforeHandoff(client, foundation.orderId);
      await client.query(
        `INSERT INTO refund_transactions (id, payment_id, idempotency_key,
                                         amount_minor, reason, status, created_at, updated_at)
         VALUES ($1,$2,$3,600,'CUSTOMER_CANCELLATION','PENDING',$4,$4)`,
        [
          fixtures.id("refund-first"),
          foundation.paymentId,
          "refund-first",
          new Date(),
        ],
      );
      await expectQueryError(
        client,
        "audit_refund_payment_scope",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, payment_id, refund_transaction_id, event_type, payload, created_at)
             VALUES ($1,$2,$3,'refund.scope_mismatch','{}'::jsonb,$4)`,
            [
              fixtures.id("audit-refund-payment-mismatch"),
              other.paymentId,
              fixtures.id("refund-first"),
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_scope_reconciliation_check",
        },
      );
      await expectQueryError(
        client,
        "audit_refund_order_scope",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, order_id, refund_transaction_id, event_type, payload, created_at)
             VALUES ($1,$2,$3,'refund.scope_mismatch','{}'::jsonb,$4)`,
            [
              fixtures.id("audit-refund-order-mismatch"),
              other.orderId,
              fixtures.id("refund-first"),
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_scope_reconciliation_check",
        },
      );
      await expectQueryError(
        client,
        "audit_quote_refund_scope",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, quote_id, refund_transaction_id, event_type, payload, created_at)
             VALUES ($1,$2,$3,'quote.refund_scope_mismatch','{}'::jsonb,$4)`,
            [
              fixtures.id("audit-quote-refund-mismatch"),
              other.quoteId,
              fixtures.id("refund-first"),
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_scope_reconciliation_check",
        },
      );
      await client.query(
        `INSERT INTO audit_events
         (id, quote_id, order_id, payment_id, refund_transaction_id,
          event_type, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,'refund.scope_consistent','{}'::jsonb,$6)`,
        [
          fixtures.id("audit-refund-scope-consistent"),
          foundation.quoteId,
          foundation.orderId,
          foundation.paymentId,
          fixtures.id("refund-first"),
          new Date(),
        ],
      );
      await expectQueryError(
        client,
        "over_refund",
        () =>
          client.query(
            `INSERT INTO refund_transactions (id, payment_id, idempotency_key,
                                             amount_minor, reason, status, created_at, updated_at)
             VALUES ($1,$2,$3,500,'CUSTOMER_CANCELLATION','PENDING',$4,$4)`,
            [
              fixtures.id("refund-over-cap"),
              foundation.paymentId,
              "refund-over-cap",
              new Date(),
            ],
          ),
        { code: "23514", constraint: "refund_captured_payment_check" },
      );
      for (const [name, providerRefundId] of [
        ["empty_provider_refund", ""],
        ["blank_provider_refund", "   "],
        ["control_whitespace_provider_refund", "\t\n"],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            client.query(
              `UPDATE refund_transactions
               SET provider_refund_id = $2
               WHERE id = $1`,
              [fixtures.id("refund-first"), providerRefundId],
            ),
          {
            code: "23514",
            constraint: "refund_transactions_provider_refund_identity_check",
          },
        );
        await expectQueryError(
          client,
          `${name}_on_success`,
          () =>
            client.query(
              `UPDATE refund_transactions
               SET status = 'SUCCEEDED', provider_refund_id = $2,
                   completed_at = $3, updated_at = $3
               WHERE id = $1`,
              [fixtures.id("refund-first"), providerRefundId, new Date()],
            ),
          {
            code: "23514",
            constraint: "refund_transactions_provider_refund_identity_check",
          },
        );
      }
      await expectQueryError(
        client,
        "succeed_refund_without_provider_facts",
        () =>
          client.query(
            `UPDATE refund_transactions SET status = 'SUCCEEDED' WHERE id = $1`,
            [fixtures.id("refund-first")],
          ),
        {
          code: "23514",
          constraint: "refund_transactions_success_facts_check",
        },
      );
      const refundCompletedAt = new Date();
      await expectQueryError(
        client,
        "succeed_refund_without_payment_status",
        async () => {
          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', provider_refund_id = $2,
                 completed_at = $3, updated_at = $3
             WHERE id = $1`,
            [
              fixtures.id("refund-first"),
              "provider-refund-first",
              refundCompletedAt,
            ],
          );
          await client.query(
            `SET CONSTRAINTS "refund_transactions_payment_status_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_refund_status_reconciliation_check",
        },
      );
      await client.query(
        `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
        [foundation.paymentId],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" DEFERRED`,
      );
      await expectQueryError(
        client,
        "partial_status_without_successful_refund",
        async () => {
          await client.query(
            `UPDATE payments SET status = 'PARTIALLY_REFUNDED' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `SET CONSTRAINTS "payments_refund_status_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_refund_status_reconciliation_check",
        },
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_refund_id = $2,
             completed_at = $3, updated_at = $3
         WHERE id = $1`,
        [
          fixtures.id("refund-first"),
          "provider-refund-first",
          refundCompletedAt,
        ],
      );
      await expectQueryError(
        client,
        "replace_successful_provider_refund_with_blank",
        () =>
          client.query(
            `UPDATE refund_transactions SET provider_refund_id = '   '
             WHERE id = $1`,
            [fixtures.id("refund-first")],
          ),
        {
          code: "23514",
          constraint: "refund_transaction_identity_immutable_check",
        },
      );
      await client.query(
        `UPDATE payments SET status = 'PARTIALLY_REFUNDED' WHERE id = $1`,
        [foundation.paymentId],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" DEFERRED`,
      );
      for (const status of ["PENDING", "FAILED"]) {
        await expectQueryError(
          client,
          `reopen_succeeded_refund_${status.toLowerCase()}`,
          () =>
            client.query(
              `UPDATE refund_transactions SET status = $2 WHERE id = $1`,
              [fixtures.id("refund-first"), status],
            ),
          {
            code: "23514",
            constraint: "refund_transaction_succeeded_immutable_check",
          },
        );
      }
      await expectQueryError(
        client,
        "claim_full_refund_before_reconciliation",
        async () => {
          await client.query(
            `UPDATE payments SET status = 'REFUNDED' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `SET CONSTRAINTS "payments_refund_status_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_refund_status_reconciliation_check",
        },
      );
      await client.query(
        `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
        [foundation.paymentId],
      );
      await client.query(
        `INSERT INTO refund_transactions (id, payment_id, idempotency_key,
                                         amount_minor, reason, status,
                                         provider_refund_id, requested_at,
                                         completed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'CUSTOMER_CANCELLATION','SUCCEEDED',$5,$6,$6,$6,$6)`,
        [
          fixtures.id("refund-remainder"),
          foundation.paymentId,
          "refund-remainder",
          remainingRefundAmount,
          "provider-refund-remainder",
          new Date(),
        ],
      );
      await client.query(
        `UPDATE payments SET status = 'REFUNDED' WHERE id = $1`,
        [foundation.paymentId],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      await expectQueryError(
        client,
        "rewind_captured_payment",
        () =>
          client.query(`UPDATE payments SET status = 'FAILED' WHERE id = $1`, [
            foundation.paymentId,
          ]),
        { code: "23514", constraint: "payment_status_transition_check" },
      );
      await expectQueryError(
        client,
        "mutate_provider_intent",
        () =>
          client.query(
            `UPDATE payments SET provider_intent_id = $2 WHERE id = $1`,
            [foundation.paymentId, "replacement-provider-intent"],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
      await expectQueryError(
        client,
        "mutate_provider_capture",
        () =>
          client.query(
            `UPDATE payments SET provider_capture_id = $2 WHERE id = $1`,
            [foundation.paymentId, "replacement-provider-capture"],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
      await expectQueryError(
        client,
        "rewrite_captured_at",
        () =>
          client.query(
            `UPDATE payments
             SET captured_at = captured_at + interval '1 second'
             WHERE id = $1`,
            [foundation.paymentId],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
      await client.query(
        `UPDATE payments
         SET capture_authorized = false, capture_cutoff_at = $2
         WHERE id = $1`,
        [foundation.paymentId, new Date()],
      );
      await expectQueryError(
        client,
        "reopen_capture_window",
        () =>
          client.query(
            `UPDATE payments SET capture_authorized = true WHERE id = $1`,
            [foundation.paymentId],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
      await expectQueryError(
        client,
        "mutate_payment_contract",
        () =>
          client.query(
            `UPDATE payments SET requested_amount_minor = requested_amount_minor - 1
             WHERE id = $1`,
            [foundation.paymentId],
          ),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
      await expectQueryError(
        client,
        "delete_payment",
        () =>
          client.query(`DELETE FROM payments WHERE id = $1`, [
            foundation.paymentId,
          ]),
        { code: "23514", constraint: "payment_identity_immutable_check" },
      );
    });
  });

  it("releases terminal order source holds without clearing financial or legal blockers", async () => {
    await rollback("terminal-source-retention", async (client, fixtures) => {
      const completed = await fixtures.createFoundation("completed-order", {
        deleteAfter: testTimes.capacityEnd,
        quoteExpiresAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000),
      });
      const completedProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        completed,
      );
      await activateCurrentPlan(
        client,
        fixtures,
        completed,
        completedProductions,
      );
      expect(
        (
          await client.query<{ retention_hold: string }>(
            `SELECT retention_hold::text FROM model_files WHERE id = $1`,
            [completed.modelFileId],
          )
        ).rows,
      ).toEqual([{ retention_hold: "ACTIVE_ORDER" }]);
      const completedAt = (
        await client.query<{ completed_at: Date }>(
          `SELECT clock_timestamp() AS completed_at`,
        )
      ).rows[0]?.completed_at;
      if (!completedAt) {
        throw new Error("database completion clock is unavailable");
      }
      await advanceOrderToCompleted(client, completed.orderId);
      const releasedSource = await client.query<{
        retention_hold: string;
        source_delete_after: Date;
      }>(
        `SELECT retention_hold::text, source_delete_after
         FROM model_files WHERE id = $1`,
        [completed.modelFileId],
      );
      expect(releasedSource.rows[0]?.retention_hold).toBe("NONE");
      expect(
        releasedSource.rows[0]?.source_delete_after.getTime(),
      ).toBeGreaterThanOrEqual(
        completedAt.getTime() + 90 * 24 * 60 * 60 * 1_000,
      );
      const releasedPhoto = await client.query<{
        retention_hold: string;
        photo_delete_after: Date;
      }>(
        `SELECT photo.retention_hold::text, photo.photo_delete_after
         FROM photo_assets photo
         JOIN jobs job ON job.qc_photo_asset_id = photo.id
         WHERE job.order_id = $1`,
        [completed.orderId],
      );
      expect(releasedPhoto.rows[0]?.retention_hold).toBe("NONE");
      expect(
        releasedPhoto.rows[0]?.photo_delete_after.getTime(),
      ).toBeGreaterThanOrEqual(
        completedAt.getTime() + 90 * 24 * 60 * 60 * 1_000,
      );
      await expectQueryError(
        client,
        "reopen_terminal_order",
        () =>
          client.query(`UPDATE orders SET status = 'CONFIRMED' WHERE id = $1`, [
            completed.orderId,
          ]),
        { code: "23514", constraint: "order_status_transition_check" },
      );

      const captured = await fixtures.createFoundation("captured-cancelled");
      const capturedProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        captured,
      );
      const capturedAmount = (
        await client.query<{ requested_amount_minor: string }>(
          `SELECT requested_amount_minor::text FROM payments WHERE id = $1`,
          [captured.paymentId],
        )
      ).rows[0]?.requested_amount_minor;
      if (!capturedAmount) {
        throw new Error("captured retention fixture payment is missing");
      }
      await activateCurrentPlan(
        client,
        fixtures,
        captured,
        capturedProductions,
      );
      await cancelOrderBeforeHandoff(client, captured.orderId);
      expect(
        (
          await client.query<{ retention_hold: string }>(
            `SELECT retention_hold::text FROM model_files WHERE id = $1`,
            [captured.modelFileId],
          )
        ).rows,
      ).toEqual([{ retention_hold: "ACTIVE_ORDER" }]);
      await expectQueryError(
        client,
        "close_unrefunded_order",
        async () => {
          await client.query(
            `UPDATE orders SET status = 'REFUNDED' WHERE id = $1`,
            [captured.orderId],
          );
          await client.query(
            `SET CONSTRAINTS "orders_refund_completion_reconciled" IMMEDIATE`,
          );
        },
        { code: "23514", constraint: "order_refund_completion_check" },
      );
      await client.query(
        `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
        [captured.paymentId],
      );
      await client.query(
        `INSERT INTO refund_transactions
         (id, payment_id, idempotency_key, provider_refund_id,
          amount_minor, reason, status, requested_at, completed_at,
          created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'CUSTOMER_CANCELLATION','SUCCEEDED',$6,$6,$6,$6)`,
        [
          fixtures.id("retention-full-refund"),
          captured.paymentId,
          "retention-full-refund",
          "retention-full-refund",
          capturedAmount,
          new Date(),
        ],
      );
      await client.query(
        `UPDATE payments SET status = 'REFUNDED' WHERE id = $1`,
        [captured.paymentId],
      );
      await client.query(
        `UPDATE order_phases
         SET status = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [captured.orderId, new Date()],
      );
      await client.query(
        `UPDATE fulfilment_slots
         SET outcome = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [captured.orderId, new Date()],
      );
      await client.query(
        `UPDATE orders SET status = 'REFUNDED' WHERE id = $1`,
        [captured.orderId],
      );
      await client.query(
        `SET CONSTRAINTS
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "orders_customer_cancellation_refund_reconciled",
           "payments_customer_cancellation_refund_reconciled",
           "refunds_customer_cancellation_order_reconciled",
           "orders_refund_completion_reconciled",
           "orders_post_confirmation_lifecycle_reconciled",
           "order_phases_parent_lifecycle_reconciled",
           "fulfilment_slots_parent_lifecycle_reconciled",
           "fulfilment_slots_shipment_plan_terminal_reconciled",
           "shipments_fulfilment_slots_terminal_reconciled" IMMEDIATE`,
      );
      await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      expect(
        (
          await client.query<{ retention_hold: string }>(
            `SELECT retention_hold::text FROM model_files WHERE id = $1`,
            [captured.modelFileId],
          )
        ).rows,
      ).toEqual([{ retention_hold: "NONE" }]);

      const legal = await fixtures.createFoundation("legal-order");
      const legalProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        legal,
      );
      await activateCurrentPlan(client, fixtures, legal, legalProductions);
      for (const status of ["IN_PRODUCTION", "QC_PASSED"] as const) {
        await advanceOrderLifecycleStep(client, legal.orderId, status);
      }
      await client.query(
        `UPDATE model_files SET retention_hold = 'LEGAL' WHERE id = $1`,
        [legal.modelFileId],
      );
      await client.query(
        `UPDATE photo_assets photo
         SET retention_hold = 'LEGAL'
         FROM jobs job
         WHERE job.order_id = $1
           AND job.qc_photo_asset_id = photo.id`,
        [legal.orderId],
      );
      for (const status of [
        "READY_TO_SHIP",
        "SHIPPED",
        "DELIVERED",
        "COMPLETED",
      ] as const) {
        await advanceOrderLifecycleStep(client, legal.orderId, status);
      }
      expect(
        (
          await client.query<{ retention_hold: string }>(
            `SELECT retention_hold::text FROM model_files WHERE id = $1`,
            [legal.modelFileId],
          )
        ).rows,
      ).toEqual([{ retention_hold: "LEGAL" }]);
      expect(
        (
          await client.query<{ retention_hold: string }>(
            `SELECT photo.retention_hold::text
             FROM photo_assets photo
             JOIN jobs job ON job.qc_photo_asset_id = photo.id
             WHERE job.order_id = $1`,
            [legal.orderId],
          )
        ).rows,
      ).toEqual([{ retention_hold: "LEGAL" }]);
    });
  });

  it("enforces atomic quote issuance and terminal rejection", async () => {
    await rollback("quote-request-issuance", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "quote-request-issuance",
      );
      const now = new Date();
      const requestId = fixtures.id("quote-issuance-request");
      const quoteId = fixtures.id("quote-issuance-quote");
      const snapshotId = fixtures.id("quote-issuance-snapshot");

      await expectQueryError(
        client,
        "insert_quoted_request",
        () =>
          client.query(
            `INSERT INTO quote_requests
               (id, customer_id, status, created_at, updated_at)
             VALUES ($1,$2,'QUOTED',$3,$3)`,
            [fixtures.id("direct-quoted-request"), foundation.customerId, now],
          ),
        {
          code: "23514",
          constraint: "quote_request_initial_status_check",
        },
      );

      await client.query(
        `INSERT INTO quote_requests
           (id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,'NEW',$3,$3)`,
        [requestId, foundation.customerId, now],
      );
      await expectQueryError(
        client,
        "skip_quote_review",
        () =>
          client.query(
            `UPDATE quote_requests
             SET status = 'QUOTED', updated_at = $2
             WHERE id = $1`,
            [requestId, now],
          ),
        {
          code: "23514",
          constraint: "quote_request_status_transition_check",
        },
      );
      await client.query(
        `UPDATE quote_requests
         SET status = 'IN_REVIEW', updated_at = $2
         WHERE id = $1`,
        [requestId, now],
      );

      await expectQueryError(
        client,
        "quote_without_offer",
        async () => {
          await client.query(
            `UPDATE quote_requests
             SET status = 'QUOTED', updated_at = $2
             WHERE id = $1`,
            [requestId, now],
          );
          await forceQuoteIssuanceConstraints(client);
        },
        {
          code: "23514",
          constraint: "quote_request_issuance_atomic_check",
        },
      );

      await expectQueryError(
        client,
        "quote_without_price_binding",
        async () => {
          await client.query(
            `UPDATE quote_requests
             SET status = 'QUOTED', updated_at = $2
             WHERE id = $1`,
            [requestId, now],
          );
          await client.query(
            `INSERT INTO quotes
               (id, quote_request_id, customer_id, expires_at,
                issued_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$5)`,
            [
              quoteId,
              requestId,
              foundation.customerId,
              new Date(now.getTime() + 60 * 60 * 1_000),
              now,
            ],
          );
          await forceQuoteIssuanceConstraints(client);
        },
        {
          code: "23514",
          constraint: "quote_request_issuance_atomic_check",
        },
      );

      await client.query(
        `UPDATE quote_requests
         SET status = 'QUOTED', updated_at = $2
         WHERE id = $1`,
        [requestId, now],
      );
      await client.query(
        `INSERT INTO quotes
           (id, quote_request_id, customer_id, expires_at,
            issued_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          quoteId,
          requestId,
          foundation.customerId,
          new Date(now.getTime() + 60 * 60 * 1_000),
          now,
        ],
      );
      await client.query(
        `INSERT INTO price_snapshots
           (id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,'EUR',0,'quote-issuance-v0','{}'::jsonb,$2,$3)`,
        [snapshotId, "7".repeat(64), now],
      );
      await client.query(
        `INSERT INTO payment_schedules
           (id, price_snapshot_id, sequence, role, gross_amount_minor,
            fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
         VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
        [fixtures.id("quote-issuance-schedule"), snapshotId, now],
      );
      await client.query(
        `INSERT INTO quote_price_bindings (quote_id, price_snapshot_id)
         VALUES ($1,$2)`,
        [quoteId, snapshotId],
      );
      await forceQuoteIssuanceConstraints(client);

      await expectQueryError(
        client,
        "expire_current_quote",
        () =>
          client.query(
            `UPDATE quote_requests
             SET status = 'EXPIRED', updated_at = $2
             WHERE id = $1`,
            [requestId, new Date()],
          ),
        {
          code: "23514",
          constraint: "quote_request_expiration_check",
        },
      );
      await client.query(
        `UPDATE quote_requests
         SET status = 'REJECTED', updated_at = $2
         WHERE id = $1`,
        [requestId, new Date()],
      );
      await forceQuoteIssuanceConstraints(client);
      expect(
        (
          await client.query<{ status: string }>(
            `SELECT status::text FROM quote_requests WHERE id = $1`,
            [requestId],
          )
        ).rows,
      ).toEqual([{ status: "REJECTED" }]);

      for (const status of ["QUOTED", "ACCEPTED", "EXPIRED"] as const) {
        await expectQueryError(
          client,
          `leave_rejected_for_${status.toLowerCase()}`,
          () =>
            client.query(
              `UPDATE quote_requests
               SET status = $2::quote_request_status, updated_at = $3
               WHERE id = $1`,
              [requestId, status, new Date()],
            ),
          {
            code: "23514",
            constraint: "quote_request_status_transition_check",
          },
        );
      }
    });
  });

  it("accepts only currently quoted and unexpired individual offers", async () => {
    await rollback(
      "individual-offer-availability",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "individual-offer-availability",
        );
        const createPricedOffer = async (
          name: string,
          issuedAt: Date,
          expiresAt: Date,
          snapshotHash: string,
        ): Promise<string> => {
          const requestId = fixtures.id(`${name}:request`);
          const quoteId = fixtures.id(`${name}:quote`);
          const snapshotId = fixtures.id(`${name}:snapshot`);
          await client.query(
            `INSERT INTO quote_requests
             (id, customer_id, status, created_at, updated_at)
           VALUES ($1,$2,'NEW',$3,$3)`,
            [requestId, foundation.customerId, issuedAt],
          );
          await advanceQuoteRequestToQuoted(client, requestId, issuedAt);
          await client.query(
            `INSERT INTO quotes
             (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$5)`,
            [quoteId, requestId, foundation.customerId, expiresAt, issuedAt],
          );
          await client.query(
            `INSERT INTO price_snapshots
             (id, currency, contract_total_minor, pricing_revision,
              input_snapshot, snapshot_hash, created_at)
           VALUES ($1,'EUR',0,'offer-v0','{}'::jsonb,$2,$3)`,
            [snapshotId, snapshotHash, issuedAt],
          );
          await client.query(
            `INSERT INTO payment_schedules
             (id, price_snapshot_id, sequence, role, gross_amount_minor,
              fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
           VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
            [fixtures.id(`${name}:schedule`), snapshotId, issuedAt],
          );
          await client.query(
            `INSERT INTO quote_price_bindings (quote_id, price_snapshot_id)
           VALUES ($1,$2)`,
            [quoteId, snapshotId],
          );
          return requestId;
        };

        const now = new Date();
        const closedIssuedAt = new Date(now.getTime() - 2 * 60 * 60 * 1_000);
        const closedRequestId = await createPricedOffer(
          "closed-offer",
          closedIssuedAt,
          new Date(now.getTime() - 60 * 60 * 1_000),
          "1".repeat(64),
        );
        await client.query(
          `UPDATE quote_requests SET status = 'EXPIRED', updated_at = $2
         WHERE id = $1`,
          [closedRequestId, now],
        );
        await expectQueryError(
          client,
          "accept_closed_offer",
          () =>
            client.query(
              `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2
             WHERE id = $1`,
              [closedRequestId, now],
            ),
          {
            code: "23514",
            constraint: "quote_request_status_transition_check",
          },
        );

        const staleIssuedAt = new Date(now.getTime() - 2 * 60 * 60 * 1_000);
        const staleRequestId = await createPricedOffer(
          "stale-offer",
          staleIssuedAt,
          new Date(now.getTime() - 60 * 60 * 1_000),
          "2".repeat(64),
        );
        await expectQueryError(
          client,
          "accept_stale_offer",
          () =>
            client.query(
              `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2
             WHERE id = $1`,
              [staleRequestId, now],
            ),
          {
            code: "23514",
            constraint: "quote_price_binding_acceptance_check",
          },
        );

        const futureIssuedAt = new Date(now.getTime() + 60 * 60 * 1_000);
        const futureRequestId = await createPricedOffer(
          "future-offer",
          futureIssuedAt,
          new Date(now.getTime() + 2 * 60 * 60 * 1_000),
          "3".repeat(64),
        );
        await expectQueryError(
          client,
          "accept_future_offer",
          () =>
            client.query(
              `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2
               WHERE id = $1`,
              [futureRequestId, now],
            ),
          {
            code: "23514",
            constraint: "quote_price_binding_acceptance_check",
          },
        );
      },
    );
  });

  it("quotes an individual order only after copying every accepted quote item exactly", async () => {
    await rollback("individual-copy", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("individual-copy");
      const quoteRequestId = fixtures.id("custom-request");
      const quoteId = fixtures.id("custom-quote");
      const quoteItemId = fixtures.id("custom-quote-item");
      const secondQuoteItemId = fixtures.id("custom-quote-item-2");
      const snapshotId = fixtures.id("custom-snapshot");
      const scheduleId = fixtures.id("custom-schedule");
      const orderId = fixtures.id("custom-order");
      const orderItemId = fixtures.id("custom-order-item");
      const secondOrderItemId = fixtures.id("custom-order-item-2");
      const now = new Date();
      await client.query(
        `INSERT INTO quote_requests (id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,'NEW',$3,$3)`,
        [quoteRequestId, foundation.customerId, now],
      );
      await advanceQuoteRequestToQuoted(client, quoteRequestId, now);
      await client.query(
        `INSERT INTO quotes (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          quoteId,
          quoteRequestId,
          foundation.customerId,
          new Date(now.getTime() + 60 * 60 * 1_000),
          now,
        ],
      );
      await client.query(
        `INSERT INTO quote_items (id, quote_id, ordinal, source_model_file_id,
                                 model_geometry_id, print_config_revision_id, material,
                                 color, quantity, created_at)
         VALUES ($1,$2,0,$3,$4,$5,'PLA','black',2,$6)`,
        [
          quoteItemId,
          quoteId,
          foundation.modelFileId,
          foundation.modelGeometryId,
          foundation.printConfigRevisionId,
          now,
        ],
      );
      await client.query(
        `INSERT INTO quote_items (id, quote_id, ordinal, source_model_file_id,
                                 model_geometry_id, print_config_revision_id, material,
                                 color, quantity, created_at)
         VALUES ($1,$2,1,$3,$4,$5,'PLA','white',1,$6)`,
        [
          secondQuoteItemId,
          quoteId,
          foundation.modelFileId,
          foundation.modelGeometryId,
          foundation.printConfigRevisionId,
          now,
        ],
      );
      await client.query(
        `INSERT INTO price_snapshots (id, currency, contract_total_minor, pricing_revision,
                                     input_snapshot, snapshot_hash, created_at)
         VALUES ($1,'EUR',0,'custom-v0','{}'::jsonb,$2,$3)`,
        [snapshotId, "b".repeat(64), now],
      );
      await client.query(
        `INSERT INTO payment_schedules (id, price_snapshot_id, sequence, role,
                                       gross_amount_minor, fee_rate_basis_points, fee_fixed_minor,
                                       provider_config, created_at)
         VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
        [scheduleId, snapshotId, now],
      );
      await expectQueryError(
        client,
        "accept_quote_without_price_binding",
        () =>
          client.query(
            `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2 WHERE id = $1`,
            [quoteRequestId, now],
          ),
        {
          code: "23514",
          constraint: "quote_price_binding_acceptance_check",
        },
      );
      await client.query(
        `INSERT INTO quote_price_bindings (quote_id, price_snapshot_id) VALUES ($1,$2)`,
        [quoteId, snapshotId],
      );
      await expectQueryError(
        client,
        "price_bound_quote_item_insert",
        () =>
          client.query(
            `INSERT INTO quote_items (id, quote_id, ordinal, source_model_file_id,
                                     model_geometry_id, print_config_revision_id, material,
                                     color, quantity, created_at)
             VALUES ($1,$2,2,$3,$4,$5,'PLA','white',1,$6)`,
            [
              fixtures.id("price-bound-quote-item"),
              quoteId,
              foundation.modelFileId,
              foundation.modelGeometryId,
              foundation.printConfigRevisionId,
              now,
            ],
          ),
        {
          code: "23514",
          constraint: "quote_item_price_binding_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "accept_quote_without_order",
        async () => {
          await client.query(
            `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2
             WHERE id = $1`,
            [quoteRequestId, now],
          );
          await client.query(
            `SET CONSTRAINTS "quote_requests_individual_order_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "quote_request_individual_order_atomic_check",
        },
      );
      await client.query(
        `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2 WHERE id = $1`,
        [quoteRequestId, now],
      );
      const closedRequestId = fixtures.id("closed-custom-request");
      const closedQuoteId = fixtures.id("closed-custom-quote");
      const closedSnapshotId = fixtures.id("closed-custom-snapshot");
      await client.query(
        `INSERT INTO quote_requests (id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,'NEW',$3,$3)`,
        [closedRequestId, foundation.customerId, now],
      );
      await advanceQuoteRequestToQuoted(client, closedRequestId, now);
      await client.query(
        `INSERT INTO quotes (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          closedQuoteId,
          closedRequestId,
          foundation.customerId,
          new Date(now.getTime() + 60 * 60 * 1_000),
          now,
        ],
      );
      await client.query(
        `INSERT INTO price_snapshots (id, currency, contract_total_minor,
                                     pricing_revision, input_snapshot,
                                     snapshot_hash, created_at)
         VALUES ($1,'EUR',0,'closed-v0','{}'::jsonb,$2,$3)`,
        [closedSnapshotId, "c".repeat(64), now],
      );
      await client.query(
        `INSERT INTO payment_schedules (id, price_snapshot_id, sequence, role,
                                       gross_amount_minor, fee_rate_basis_points,
                                       fee_fixed_minor, provider_config, created_at)
         VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
        [fixtures.id("closed-custom-schedule"), closedSnapshotId, now],
      );
      await client.query(
        `UPDATE quote_requests SET status = 'REJECTED', updated_at = $2 WHERE id = $1`,
        [closedRequestId, now],
      );
      await expectQueryError(
        client,
        "bind_closed_quote",
        () =>
          client.query(
            `INSERT INTO quote_price_bindings (quote_id, price_snapshot_id) VALUES ($1,$2)`,
            [closedQuoteId, closedSnapshotId],
          ),
        {
          code: "23514",
          constraint: "quote_price_binding_acceptance_check",
        },
      );
      await expectQueryError(
        client,
        "accepted_quote_item_insert",
        () =>
          client.query(
            `INSERT INTO quote_items (id, quote_id, ordinal, source_model_file_id,
                                     model_geometry_id, print_config_revision_id, material,
                                     color, quantity, created_at)
             VALUES ($1,$2,1,$3,$4,$5,'PLA','white',1,$6)`,
            [
              fixtures.id("late-accepted-quote-item"),
              quoteId,
              foundation.modelFileId,
              foundation.modelGeometryId,
              foundation.printConfigRevisionId,
              now,
            ],
          ),
        {
          code: "23514",
          constraint: "quote_item_accepted_immutable_check",
        },
      );

      await expectQueryError(
        client,
        "binding_before_individual_origin",
        async () => {
          const mismatchedOrderId = fixtures.id("mismatched-custom-order");
          const mismatchedDestinationId = fixtures.id(
            "mismatched-custom-destination",
          );
          await client.query(
            `INSERT INTO orders
               (id, customer_id, public_reference, status, created_at, updated_at)
             VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
            [
              mismatchedOrderId,
              foundation.customerId,
              `I-${randomUUID()}`,
              now,
            ],
          );
          await client.query(
            `INSERT INTO delivery_destinations
               (id, order_id, provider_endpoint_id, endpoint_type,
                address_snapshot, capability_snapshot, created_at)
             VALUES ($1,$2,$3,'address','{}'::jsonb,'{}'::jsonb,$4)`,
            [
              mismatchedDestinationId,
              mismatchedOrderId,
              `endpoint-${randomUUID()}`,
              now,
            ],
          );
          await client.query(
            `INSERT INTO order_price_bindings
               (id, order_id, price_snapshot_id,
                delivery_destination_id, created_at)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              fixtures.id("mismatched-custom-binding"),
              mismatchedOrderId,
              closedSnapshotId,
              mismatchedDestinationId,
              now,
            ],
          );
          await client.query(
            `INSERT INTO individual_order_origins (order_id, quote_id)
             VALUES ($1,$2)`,
            [mismatchedOrderId, quoteId],
          );
          await client.query(
            `SET CONSTRAINTS
               "individual_order_origins_quote_snapshot_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "individual_order_price_binding_check",
        },
      );

      await client.query(
        `INSERT INTO orders (id, customer_id, public_reference, status, created_at, updated_at)
         VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
        [orderId, foundation.customerId, `I-${randomUUID()}`, now],
      );
      const destinationId = fixtures.id("custom-destination");
      await client.query(
        `INSERT INTO delivery_destinations
           (id, order_id, provider_endpoint_id, endpoint_type,
            address_snapshot, capability_snapshot, created_at)
         VALUES ($1,$2,$3,'address','{}'::jsonb,'{}'::jsonb,$4)`,
        [destinationId, orderId, `endpoint-${randomUUID()}`, now],
      );
      await client.query(
        `INSERT INTO individual_order_origins (order_id, quote_id) VALUES ($1,$2)`,
        [orderId, quoteId],
      );
      await client.query(
        `SET CONSTRAINTS
           "quote_requests_individual_order_reconciled",
           "individual_order_origins_request_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS
           "quote_requests_individual_order_reconciled",
           "individual_order_origins_request_reconciled" DEFERRED`,
      );
      await client.query(
        `INSERT INTO order_items (id, order_id, ordinal, source_model_file_id,
                                 model_geometry_id, print_config_revision_id, material,
                                 color, quantity, created_at)
         VALUES ($1,$2,0,$3,$4,$5,'PLA','black',2,$6)`,
        [
          orderItemId,
          orderId,
          foundation.modelFileId,
          foundation.modelGeometryId,
          foundation.printConfigRevisionId,
          now,
        ],
      );
      await client.query(
        `INSERT INTO individual_order_item_sources (order_item_id, quote_item_id)
         VALUES ($1,$2)`,
        [orderItemId, quoteItemId],
      );
      const bindingId = fixtures.id("custom-order-price-binding");
      const phaseId = fixtures.id("custom-order-phase");
      const createQuotedTopology = async (): Promise<void> => {
        await client.query(
          `INSERT INTO order_price_bindings
             (id, order_id, price_snapshot_id, delivery_destination_id, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [bindingId, orderId, snapshotId, destinationId, now],
        );
        await client.query(
          `INSERT INTO order_active_price_bindings
             (order_id, order_price_binding_id)
           VALUES ($1,$2)`,
          [orderId, bindingId],
        );
        await client.query(
          `INSERT INTO order_phases
             (id, order_id, kind, status, created_at, updated_at)
           VALUES ($1,$2,'SINGLE','QUOTED',$3,$3)`,
          [phaseId, orderId, now],
        );
      };

      await expectQueryError(
        client,
        "quoted_individual_order_missing_quote_item",
        async () => {
          await createQuotedTopology();
          await client.query(
            `UPDATE orders
             SET status = 'QUOTED', quoted_at = $2, updated_at = $2
             WHERE id = $1`,
            [orderId, now],
          );
          await client.query(
            `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "individual_order_item_completion_check",
        },
      );

      await client.query(
        `INSERT INTO order_items (id, order_id, ordinal, source_model_file_id,
                                 model_geometry_id, print_config_revision_id, material,
                                 color, quantity, created_at)
         VALUES ($1,$2,1,$3,$4,$5,'PLA','white',1,$6)`,
        [
          secondOrderItemId,
          orderId,
          foundation.modelFileId,
          foundation.modelGeometryId,
          foundation.printConfigRevisionId,
          now,
        ],
      );
      await client.query(
        `INSERT INTO individual_order_item_sources (order_item_id, quote_item_id)
         VALUES ($1,$2)`,
        [secondOrderItemId, secondQuoteItemId],
      );
      await createQuotedTopology();
      await client.query(
        `SET CONSTRAINTS
           "order_price_bindings_individual_quote_snapshot_reconciled",
           "individual_order_origins_quote_snapshot_reconciled" IMMEDIATE`,
      );
      await client.query(
        `UPDATE orders
         SET status = 'QUOTED', quoted_at = $2, updated_at = $2
         WHERE id = $1`,
        [orderId, now],
      );
      await client.query(
        `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" IMMEDIATE`,
      );
      await client.query(
        `INSERT INTO audit_events
         (id, quote_id, order_id, event_type, payload, created_at)
         VALUES ($1,$2,$3,'individual_quote.order_scope_consistent','{}'::jsonb,$4)`,
        [fixtures.id("individual-quote-order-audit"), quoteId, orderId, now],
      );
      expect(
        (
          await client.query<{ request_status: string; order_status: string }>(
            `SELECT request.status::text AS request_status,
                    target_order.status::text AS order_status
             FROM quote_requests request
             JOIN quotes quote ON quote.quote_request_id = request.id
             JOIN individual_order_origins origin ON origin.quote_id = quote.id
             JOIN orders target_order ON target_order.id = origin.order_id
             WHERE request.id = $1`,
            [quoteRequestId],
          )
        ).rows,
      ).toEqual([{ request_status: "ACCEPTED", order_status: "QUOTED" }]);
      expect(
        (
          await client.query<{
            color: string;
            material: string;
            model_geometry_id: string;
            print_config_revision_id: string;
            quantity: number;
            source_model_file_id: string;
          }>(
            `SELECT item.source_model_file_id, item.model_geometry_id,
                    item.print_config_revision_id, item.material::text,
                    item.color, item.quantity
             FROM order_items item
             JOIN individual_order_item_sources source
               ON source.order_item_id = item.id
             WHERE item.id = $1 AND source.quote_item_id = $2`,
            [orderItemId, quoteItemId],
          )
        ).rows,
      ).toEqual([
        {
          source_model_file_id: foundation.modelFileId,
          model_geometry_id: foundation.modelGeometryId,
          print_config_revision_id: foundation.printConfigRevisionId,
          material: "PLA",
          color: "black",
          quantity: 2,
        },
      ]);
      expect(
        (
          await client.query<{ automatic_origins: string; payments: string }>(
            `SELECT
               (SELECT count(*)::text FROM automatic_order_origins
                WHERE order_id = $1) AS automatic_origins,
               (SELECT count(*)::text FROM payments
                WHERE order_id = $1) AS payments`,
            [orderId],
          )
        ).rows,
      ).toEqual([{ automatic_origins: "0", payments: "0" }]);
    });
  });
});
