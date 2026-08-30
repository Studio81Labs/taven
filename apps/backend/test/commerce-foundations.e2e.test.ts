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
       "payment_schedules_total_reconciled",
       "quote_price_bindings_snapshot_sealed",
       "order_price_bindings_snapshot_sealed" IMMEDIATE`,
  );
  await client.query(
    `SET CONSTRAINTS
       "quote_requests_issuance_reconciled",
       "quotes_request_issuance_reconciled",
       "quote_price_bindings_request_issuance_reconciled",
       "price_snapshots_total_reconciled",
       "price_snapshot_components_total_reconciled",
       "payment_schedules_total_reconciled",
       "quote_price_bindings_snapshot_sealed",
       "order_price_bindings_snapshot_sealed" DEFERRED`,
  );
}

async function createAlternateProfileReferenceSlice(
  client: PoolClient,
  fixtures: PersistenceFactory,
  sourceSliceResultId: string,
  name: string,
): Promise<string> {
  const referenceProfileId = fixtures.id(`${name}:reference-profile`);
  const sliceResultId = fixtures.id(`${name}:reference-slice`);
  await fixtures.createRevisionIdentity(
    referenceProfileId,
    "REFERENCE_PROFILE",
  );
  const activatedAt = new Date();
  await client.query(
    `UPDATE reference_profiles
     SET state = 'RETIRED', retired_at = $2
     WHERE id = (
       SELECT reference_profile_id FROM slice_results WHERE id = $1
     )`,
    [sourceSliceResultId, activatedAt],
  );
  await client.query(
    `INSERT INTO reference_profiles
       (id, material, quality, slicer_engine, slicer_version, settings,
        state, activated_at, created_at)
     SELECT $1, profile.material, profile.quality, profile.slicer_engine,
            profile.slicer_version, profile.settings, 'ACTIVE', $2, $2
     FROM slice_results source
     JOIN reference_profiles profile ON profile.id = source.reference_profile_id
     WHERE source.id = $3`,
    [referenceProfileId, activatedAt, sourceSliceResultId],
  );
  await client.query(
    `INSERT INTO slice_results
       (id, kind, cache_key, model_geometry_id, print_config_revision_id,
        reference_profile_id, parts_per_plate, artifact_object_key,
        artifact_hash, estimated_print_seconds,
        estimated_material_milligrams, slicer_engine, slicer_version,
        created_at)
     SELECT $1, 'REFERENCE', $2, source.model_geometry_id,
            source.print_config_revision_id, $3, source.parts_per_plate, $4,
            source.artifact_hash, source.estimated_print_seconds,
            source.estimated_material_milligrams, profile.slicer_engine,
            profile.slicer_version, $5
     FROM slice_results source
     JOIN reference_profiles profile ON profile.id = $3
     WHERE source.id = $6`,
    [
      sliceResultId,
      `alternate-profile-${name}-${sliceResultId}`,
      referenceProfileId,
      `reference/alternate-profile/${name}/${sliceResultId}`,
      new Date(),
      sourceSliceResultId,
    ],
  );
  return sliceResultId;
}

async function createCurrentPlan(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
  reservationExpiresAt = new Date(Date.now() + 15 * 60 * 1_000),
  planScope = foundation.orderId,
  capacityOffsetHours = 0,
  reservationCreatedAt = new Date(
    reservationExpiresAt.getTime() - 15 * 60 * 1_000,
  ),
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
      testTimes.capacityStart.getTime() +
        (capacityOffsetHours + index * 2) * 60 * 60 * 1_000,
    );
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1_000);
    const production = await fixtures.planProduction(
      foundation,
      `payment-plan-${planScope}-${index}`,
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
  await fixtures.createPhaseReservationSet(
    foundation,
    reservationExpiresAt,
    "BUILDING",
    reservationCreatedAt,
  );
  for (const [index, production] of productions.entries()) {
    await fixtures.createProductionReservation(
      foundation,
      production,
      "RESERVED",
      {},
      null,
      reservationExpiresAt,
      reservationCreatedAt,
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
        reservationCreatedAt,
      ],
    );
    await client.query(
      `INSERT INTO capacity_reservations (id, node_id, production_reservation_id,
                                         candidate_capacity_interval_id, machine_id,
                                         starts_at, ends_at, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        fixtures.id(`payment-capacity-${planScope}-${index}`),
        foundation.nodeId,
        production.productionReservationId,
        production.candidateCapacityIntervalId,
        foundation.machineId,
        production.startsAt,
        production.endsAt,
        reservationExpiresAt,
        reservationCreatedAt,
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

async function holdCurrentPlan(
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
}

async function forceCaptureActivationConstraints(
  client: PoolClient,
): Promise<void> {
  await client.query(
    `SET CONSTRAINTS
       "payment_provider_events_consumed",
       "payments_capture_activation_reconciled",
       "orders_capture_activation_reconciled",
       "order_phases_capture_activation_reconciled",
       "phase_reservation_sets_capture_activation_reconciled",
       "jobs_captured_reservation_reconciled" IMMEDIATE`,
  );
  await client.query(
    `SET CONSTRAINTS
       "payment_provider_events_consumed",
       "payments_capture_activation_reconciled",
       "orders_capture_activation_reconciled",
       "order_phases_capture_activation_reconciled",
       "phase_reservation_sets_capture_activation_reconciled",
       "jobs_captured_reservation_reconciled" DEFERRED`,
  );
}

async function activateCurrentPlan(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
  productions: ProductionReservationFixture[],
  providerCaptureId?: string,
): Promise<void> {
  await holdCurrentPlan(client, fixtures, foundation, productions);
  await fixtures.activatePayment(foundation, providerCaptureId);
  await forceCaptureActivationConstraints(client);
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
       "payments_quoted_void_closure_reconciled",
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
       "payment_provider_events_consumed",
       "shipment_provider_events_consumed",
       "shipments_label_void_outbox_reconciled",
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
       "payments_quoted_void_closure_reconciled",
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
       "payment_provider_events_consumed",
       "shipment_provider_events_consumed",
       "shipments_label_void_outbox_reconciled",
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

async function persistVerifiedShipmentOutcome(
  client: PoolClient,
  shipmentId: string,
  kind: "TRANSIT_SCAN" | "DELIVERY_SCAN",
  verifiedAt = new Date(),
  providerTransactionId?: string,
  advanceLifecycle = true,
  occurredAt = verifiedAt,
): Promise<void> {
  const evidence = (
    await client.query<{ carrier: string; carrier_label_id: string }>(
      `SELECT carrier, carrier_label_id
       FROM shipments
       WHERE id = $1`,
      [shipmentId],
    )
  ).rows[0];
  if (!evidence) {
    throw new Error("shipment carrier outcome scope is unavailable");
  }
  const providerEventId = `${kind.toLowerCase()}:${randomUUID()}`;
  await client.query(
    `INSERT INTO shipment_provider_events
       (id, shipment_id, carrier, carrier_label_id, provider_event_id,
        provider_transaction_id, kind, occurred_at, authenticated_at,
        verified_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::shipment_provider_event_kind,
             $8,$9,$9,$9)`,
    [
      randomUUID(),
      shipmentId,
      evidence.carrier,
      evidence.carrier_label_id,
      providerEventId,
      providerTransactionId ?? `${providerEventId}:transaction`,
      kind,
      occurredAt,
      verifiedAt,
    ],
  );
  if (advanceLifecycle && kind === "TRANSIT_SCAN") {
    await client.query(
      `UPDATE shipments
       SET status = 'IN_TRANSIT', updated_at = $2
       WHERE id = $1`,
      [shipmentId, verifiedAt],
    );
  } else if (advanceLifecycle) {
    await client.query(
      `UPDATE shipments
       SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
       WHERE id = $1`,
      [shipmentId, verifiedAt],
    );
  }
  await client.query(
    `SET CONSTRAINTS "shipment_provider_events_consumed" IMMEDIATE`,
  );
  await client.query(
    `SET CONSTRAINTS "shipment_provider_events_consumed" DEFERRED`,
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
  transitionedAt = new Date(),
): Promise<void> {
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
       SET status = 'ACCEPTED', accepted_at = $2,
           payout_amount = 0, payout_currency = 'EUR', updated_at = $2
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
           carrier_label_id = coalesce(carrier_label_id, 'label-' || id::text),
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
    const shipmentIds = (
      await client.query<{ id: string }>(
        `SELECT id FROM shipments
         WHERE order_id = $1 AND status = 'HANDED_OVER'
         ORDER BY id`,
        [orderId],
      )
    ).rows.map(({ id }) => id);
    for (const shipmentId of shipmentIds) {
      await persistVerifiedShipmentOutcome(
        client,
        shipmentId,
        "TRANSIT_SCAN",
        transitionedAt,
      );
      await persistVerifiedShipmentOutcome(
        client,
        shipmentId,
        "DELIVERY_SCAN",
        transitionedAt,
      );
    }
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

type CustomerCancellationRefundWork =
  | false
  | ReadonlyArray<{
      id: string;
      idempotencyKey: string;
      amountMinor: number;
      requestedAt?: Date;
    }>;

async function confirmCarrierLabelVoid(
  client: PoolClient,
  shipmentId: string,
  providerEventId: string,
  negativeSkewMilliseconds = 0,
  deliverAtCancellationRequest = false,
): Promise<void> {
  const evidence = (
    await client.query<{
      carrier: string;
      carrier_label_id: string;
      cancellation_requested_at: Date;
      outbox_message_id: string;
    }>(
      `SELECT shipment.carrier, shipment.carrier_label_id,
              shipment.cancellation_requested_at,
              message.id AS outbox_message_id
       FROM shipments shipment
       JOIN outbox_messages message
         ON message.deduplication_key =
            'void_carrier_label:' || shipment.id::text || ':' || shipment.carrier_label_id
       WHERE shipment.id = $1`,
      [shipmentId],
    )
  ).rows[0];
  if (!evidence) {
    throw new Error("shipment carrier-void evidence scope is unavailable");
  }
  const deliveredAt = (
    await client.query<{ delivered_at: Date }>(
      `UPDATE outbox_messages
       SET status = 'DELIVERED',
           delivered_at = coalesce($2::timestamptz, clock_timestamp()),
           updated_at = coalesce($2::timestamptz, clock_timestamp())
       WHERE id = $1
       RETURNING delivered_at`,
      [
        evidence.outbox_message_id,
        deliverAtCancellationRequest
          ? evidence.cancellation_requested_at
          : null,
      ],
    )
  ).rows[0]?.delivered_at;
  if (!deliveredAt) {
    throw new Error("shipment carrier-void delivery evidence is unavailable");
  }
  const providerOccurredAt = new Date(
    deliveredAt.getTime() - negativeSkewMilliseconds,
  );
  await client.query(
    `INSERT INTO shipment_provider_events
       (id, shipment_id, outbox_message_id, carrier, carrier_label_id,
        provider_event_id, provider_transaction_id, kind, occurred_at,
        authenticated_at, verified_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'LABEL_VOIDED',$8,$9,$9,
             statement_timestamp())`,
    [
      randomUUID(),
      shipmentId,
      evidence.outbox_message_id,
      evidence.carrier,
      evidence.carrier_label_id,
      providerEventId,
      `${providerEventId}:transaction`,
      providerOccurredAt,
      deliveredAt,
    ],
  );
  await client.query(
    `UPDATE shipments shipment
     SET status = 'CANCELLED', provider_void_id = event.provider_event_id,
         provider_voided_at = event.verified_at,
         cancelled_at = event.verified_at, updated_at = event.verified_at
     FROM shipment_provider_events event
     WHERE shipment.id = $1
       AND event.shipment_id = shipment.id
       AND event.provider_event_id = $2`,
    [shipmentId, providerEventId],
  );
}

async function persistVerifiedAcceptanceScan(
  client: PoolClient,
  shipmentId: string,
  providerEventId: string,
  occurredAt?: Date,
): Promise<Date> {
  const verifiedAt = (
    await client.query<{ verified_at: Date }>(
      `INSERT INTO shipment_provider_events
       (id, shipment_id, carrier, carrier_label_id, provider_event_id,
        provider_transaction_id, kind, occurred_at, authenticated_at,
        verified_at, created_at)
     SELECT $1, shipment.id, shipment.carrier, shipment.carrier_label_id,
            $3, $4, 'ACCEPTANCE_SCAN',
            coalesce($5::timestamptz, statement_timestamp()), statement_timestamp(),
            statement_timestamp() + interval '2 seconds', statement_timestamp()
     FROM shipments shipment
     WHERE shipment.id = $2
     RETURNING verified_at`,
      [
        randomUUID(),
        shipmentId,
        providerEventId,
        `${providerEventId}:transaction`,
        occurredAt ?? null,
      ],
    )
  ).rows[0]?.verified_at;
  if (!verifiedAt) {
    throw new Error("verified carrier acceptance scan was not persisted");
  }
  return verifiedAt;
}

async function cancelOrderBeforeHandoff(
  client: PoolClient,
  orderId: string,
  closePayments = true,
  closeSlots = true,
  orderStatus: "CANCELLED" | "EXPIRED" = "CANCELLED",
  customerCancellationRefundWork:
    CustomerCancellationRefundWork | undefined = undefined,
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
  if (orderStatus === "CANCELLED" && customerCancellationRefundWork !== false) {
    const capturedPayments = await client.query<{
      id: string;
      remaining_amount_minor: string;
    }>(
      `SELECT payment.id,
              (payment.captured_amount_minor
               - coalesce(sum(refund.amount_minor) FILTER (
                   WHERE refund.status = 'SUCCEEDED'
                 ), 0))::text AS remaining_amount_minor
       FROM payments payment
       LEFT JOIN refund_transactions refund ON refund.payment_id = payment.id
       WHERE payment.order_id = $1
         AND payment.captured_amount_minor IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM jobs job
           WHERE job.order_id = payment.order_id
             AND job.status IN ('FAILED', 'QC_REJECTED')
         )
         AND NOT (
           NOT payment.capture_authorized
           AND payment.capture_cutoff_at IS NOT NULL
           AND payment.captured_at IS NOT NULL
           AND payment.captured_at >= payment.capture_cutoff_at
         )
       GROUP BY payment.id, payment.captured_amount_minor
       ORDER BY payment.id`,
      [orderId],
    );
    const refunds =
      customerCancellationRefundWork === undefined
        ? capturedPayments.rows
            .filter(
              ({ remaining_amount_minor }) => remaining_amount_minor !== "0",
            )
            .map(({ id, remaining_amount_minor }) => ({
              id: randomUUID(),
              idempotencyKey: `customer-cancellation:${randomUUID()}`,
              amountMinor: Number(remaining_amount_minor),
              paymentId: id,
            }))
        : customerCancellationRefundWork.map((refund) => ({
            ...refund,
            paymentId: capturedPayments.rows[0]?.id,
          }));
    if (
      customerCancellationRefundWork !== undefined &&
      capturedPayments.rows.length !== 1
    ) {
      throw new Error(
        "custom cancellation refund work requires one captured payment",
      );
    }
    for (const refund of refunds) {
      if (!refund.paymentId) {
        throw new Error("customer cancellation refund is missing its payment");
      }
      await client.query(
        `INSERT INTO refund_transactions
           (id, payment_id, idempotency_key, amount_minor, reason, status,
            requested_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'CUSTOMER_CANCELLATION','PENDING',$5,$5,$5)`,
        [
          refund.id,
          refund.paymentId,
          refund.idempotencyKey,
          refund.amountMinor,
          "requestedAt" in refund
            ? (refund.requestedAt ?? cancelledAt)
            : cancelledAt,
        ],
      );
    }
    for (const payment of capturedPayments.rows) {
      if (payment.remaining_amount_minor !== "0") {
        await client.query(
          `UPDATE payments SET status = 'REFUND_PENDING', updated_at = $2
           WHERE id = $1`,
          [payment.id, cancelledAt],
        );
      }
    }
  }
  await client.query(
    `UPDATE shipments
     SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2
     WHERE order_id = $1 AND status = 'PLANNED'`,
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
      await forceQuoteIssuanceConstraints(client);
      expect(
        (
          await client.query<{ sealed_at: Date | null }>(
            `SELECT sealed_at FROM price_snapshots WHERE id = $1`,
            [foundation.priceSnapshotId],
          )
        ).rows[0]?.sealed_at,
      ).not.toBeNull();

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

  it("rejects quoting an incomplete fulfilment topology", async () => {
    await rollback("incomplete-quote-topology", async (client, fixtures) => {
      await expectQueryError(
        client,
        "quote_with_missing_quantity_slot",
        async () => {
          await fixtures.createFoundation(
            "incomplete-quote-topology",
            {},
            undefined,
            undefined,
            undefined,
            1,
            [{ quantity: 1 }],
            "QUOTED",
            async (draft) => {
              await client.query(
                `UPDATE order_items SET quantity = 2 WHERE id = $1`,
                [draft.orderItemId],
              );
            },
          );
          await client.query(
            `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "quoted_order_fulfilment_topology_check",
        },
      );
    });
  });

  it("freezes order ownership after initial anonymous draft attachment", async () => {
    await rollback("order-ownership", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("ownership-source");
      const createdAt = new Date();
      const otherCustomerId = fixtures.id("ownership-other-customer");
      for (const [name, email] of [
        ["empty_customer_email", ""],
        ["blank_customer_email", "   "],
        ["control_whitespace_customer_email", "\t\n"],
        ["leading_whitespace_customer_email", " owner@example.test"],
        ["trailing_whitespace_customer_email", "owner@example.test "],
        ["embedded_whitespace_customer_email", "owner @example.test"],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            client.query(
              `INSERT INTO customers
                 (id, email, first_seen_at, created_at, updated_at)
               VALUES ($1,$2,$3,$3,$3)`,
              [fixtures.id(name), email, createdAt],
            ),
          {
            code: "23514",
            constraint: "customers_email_normalized_check",
          },
        );
      }
      await client.query(
        `INSERT INTO customers
           (id, email, display_name, first_seen_at, created_at, updated_at)
         VALUES ($1,$2,'Other owner',$3,$3,$3)`,
        [otherCustomerId, `other-${randomUUID()}@example.test`, createdAt],
      );

      const anonymousSessionId = fixtures.id("anonymous-owner-session");
      const anonymousOrderId = fixtures.id("anonymous-owner-order");
      for (const [name, publicReference] of [
        ["empty_order_reference", ""],
        ["blank_order_reference", "   "],
        ["control_whitespace_order_reference", "\t\n"],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            client.query(
              `INSERT INTO orders
                 (id, customer_id, public_reference, status, created_at, updated_at)
               VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
              [
                fixtures.id(name),
                foundation.customerId,
                publicReference,
                createdAt,
              ],
            ),
          {
            code: "23514",
            constraint: "orders_public_reference_identity_check",
          },
        );
      }
      for (const [name, publicTokenHash] of [
        ["empty_public_token_hash", ""],
        ["blank_public_token_hash", "   "],
        ["non_hex_public_token_hash", "g".repeat(64)],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            client.query(
              `INSERT INTO quote_sessions
                 (id, public_token_hash, expires_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$4)`,
              [
                fixtures.id(name),
                publicTokenHash,
                new Date(createdAt.getTime() + 60 * 60 * 1_000),
                createdAt,
              ],
            ),
          {
            code: "23514",
            constraint: "quote_sessions_public_token_hash_check",
          },
        );
      }
      const anonymousPublicTokenHash = randomUUID()
        .replaceAll("-", "")
        .padEnd(64, "0");
      await client.query(
        `INSERT INTO quote_sessions
           (id, public_token_hash, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$4)`,
        [
          anonymousSessionId,
          anonymousPublicTokenHash,
          new Date(Date.now() + 60 * 60 * 1_000),
          createdAt,
        ],
      );
      await expectQueryError(
        client,
        "future_customer_first_seen",
        () =>
          client.query(
            `INSERT INTO customers
               (id, email, first_seen_at, created_at, updated_at)
             VALUES ($1,$2,clock_timestamp() + interval '60 seconds',
                     clock_timestamp(),clock_timestamp())`,
            [
              fixtures.id("future-customer-first-seen"),
              `future-${randomUUID()}@example.test`,
            ],
          ),
        { code: "23514", constraint: "customer_first_seen_evidence_check" },
      );
      for (const column of ["created_at", "first_seen_at"] as const) {
        await expectQueryError(
          client,
          `rewrite_customer_${column}`,
          () =>
            client.query(
              `UPDATE customers
               SET "${column}" = "${column}" + interval '1 millisecond'
               WHERE id = $1`,
              [foundation.customerId],
            ),
          { code: "23514", constraint: "customer_chronology_immutable_check" },
        );
      }
      await expectQueryError(
        client,
        "rewrite_public_token_hash",
        () =>
          client.query(
            `UPDATE quote_sessions SET public_token_hash = $2 WHERE id = $1`,
            [
              anonymousSessionId,
              randomUUID().replaceAll("-", "").padEnd(64, "1"),
            ],
          ),
        {
          code: "23514",
          constraint: "quote_session_public_token_hash_immutable_check",
        },
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
      await client.query(
        `UPDATE quote_sessions SET customer_id = $2 WHERE id = $1`,
        [anonymousSessionId, foundation.customerId],
      );
      expect(
        (
          await client.query<{ customer_id: string | null }>(
            `SELECT customer_id FROM orders WHERE id = $1`,
            [anonymousOrderId],
          )
        ).rows[0]?.customer_id,
      ).toBe(foundation.customerId);
      expect(
        (
          await client.query<{ customer_id: string | null }>(
            `SELECT customer_id FROM quote_sessions WHERE id = $1`,
            [anonymousSessionId],
          )
        ).rows[0]?.customer_id,
      ).toBe(foundation.customerId);
      await expectQueryError(
        client,
        "conflicting_request_after_order_claim",
        () =>
          client.query(
            `INSERT INTO quote_requests
               (id, quote_session_id, customer_id, status, created_at, updated_at)
             VALUES ($1,$2,$3,'NEW',$4,$4)`,
            [
              fixtures.id("conflicting-request-after-order-claim"),
              anonymousSessionId,
              otherCustomerId,
              createdAt,
            ],
          ),
        {
          code: "23514",
          constraint: "quote_request_session_owner_check",
        },
      );
      await client.query(
        `SET CONSTRAINTS "orders_require_exactly_one_origin",
                         "automatic_order_origins_require_exactly_one_origin" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "orders_require_exactly_one_origin",
                         "automatic_order_origins_require_exactly_one_origin" DEFERRED`,
      );

      const requestFirstSessionId = fixtures.id("request-first-session");
      await client.query(
        `INSERT INTO quote_sessions
           (id, public_token_hash, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$4)`,
        [
          requestFirstSessionId,
          randomUUID().replaceAll("-", "").padEnd(64, "4"),
          new Date(Date.now() + 60 * 60 * 1_000),
          createdAt,
        ],
      );
      await client.query(
        `INSERT INTO quote_requests
           (id, quote_session_id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,'NEW',$4,$4)`,
        [
          fixtures.id("request-first-request"),
          requestFirstSessionId,
          otherCustomerId,
          createdAt,
        ],
      );
      expect(
        (
          await client.query<{ customer_id: string | null }>(
            `SELECT customer_id FROM quote_sessions WHERE id = $1`,
            [requestFirstSessionId],
          )
        ).rows[0]?.customer_id,
      ).toBe(otherCustomerId);
      await expectQueryError(
        client,
        "conflicting_order_after_request_claim",
        async () => {
          const conflictingOrderId = fixtures.id(
            "conflicting-order-after-request-claim",
          );
          await client.query(
            `INSERT INTO orders
               (id, customer_id, public_reference, status, created_at, updated_at)
             VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
            [
              conflictingOrderId,
              foundation.customerId,
              `T-${randomUUID()}`,
              createdAt,
            ],
          );
          await client.query(
            `INSERT INTO automatic_order_origins (order_id, quote_session_id)
             VALUES ($1,$2)`,
            [conflictingOrderId, requestFirstSessionId],
          );
        },
        {
          code: "23514",
          constraint: "automatic_order_origin_owner_check",
        },
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

      const claimAutomaticSession = async (
        name: string,
        sessionId: string,
        orderId: string,
      ) => {
        await client.query(
          `INSERT INTO quote_requests
             (id, quote_session_id, customer_id, status, created_at, updated_at)
           VALUES ($1,$2,$3,'NEW',$4,$4)`,
          [
            fixtures.id(`${name}-request`),
            sessionId,
            foundation.customerId,
            createdAt,
          ],
        );
        expect(
          (
            await client.query<{ customer_id: string }>(
              `SELECT customer_id FROM quote_sessions WHERE id = $1
               UNION ALL
               SELECT customer_id FROM orders WHERE id = $2`,
              [sessionId, orderId],
            )
          ).rows,
        ).toEqual([
          { customer_id: foundation.customerId },
          { customer_id: foundation.customerId },
        ]);
      };

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
      await claimAutomaticSession(
        "item-topology-claim",
        topologySessionId,
        topologyOrderId,
      );

      for (const topology of [
        "delivery-destination",
        "order-phase",
        "price-binding",
      ] as const) {
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
        } else if (topology === "order-phase") {
          await client.query(
            `INSERT INTO order_phases
               (id, order_id, kind, status, created_at, updated_at)
             VALUES ($1,$2,'SINGLE','QUOTED',$3,$3)`,
            [fixtures.id("ownership-phase"), orderId, createdAt],
          );
        } else {
          const destinationId = fixtures.id(
            "price-binding-ownership-destination",
          );
          const snapshotId = fixtures.id("price-binding-ownership-snapshot");
          await client.query(
            `INSERT INTO delivery_destinations
               (id, order_id, provider_endpoint_id, endpoint_type,
                address_snapshot, capability_snapshot, created_at)
             VALUES ($1,$2,'endpoint','HOME','{}'::jsonb,'{}'::jsonb,$3)`,
            [destinationId, orderId, createdAt],
          );
          await client.query(
            `INSERT INTO price_snapshots
               (id, price_list_id, currency, contract_total_minor, pricing_revision,
                input_snapshot, snapshot_hash, created_at)
             VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                     'EUR',0,'legacy-v0-eur','{}'::jsonb,$2,$3)`,
            [
              snapshotId,
              randomUUID().replaceAll("-", "").padEnd(64, "a"),
              createdAt,
            ],
          );
          await client.query(
            `INSERT INTO order_price_bindings
               (id, order_id, price_snapshot_id, delivery_destination_id,
                created_at)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              fixtures.id("price-binding-ownership-binding"),
              orderId,
              snapshotId,
              destinationId,
              createdAt,
            ],
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
        await claimAutomaticSession(
          `${topology}-topology-claim`,
          sessionId,
          orderId,
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

  it("allows a matching session ownership claim after anonymous automatic quoting", async () => {
    await rollback("anonymous-quoted-claim", async (client, fixtures) => {
      const anonymousQuoted = await fixtures.createFoundation(
        "anonymous-quoted-claim",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "QUOTED",
        undefined,
        {},
        "AUTOMATIC",
        true,
        false,
      );

      expect(
        (
          await client.query<{
            order_customer_id: string | null;
            session_customer_id: string | null;
            session_status: string;
          }>(
            `SELECT target_order.customer_id AS order_customer_id,
                    session.customer_id AS session_customer_id,
                    session.status::text AS session_status
             FROM orders target_order
             JOIN automatic_order_origins origin
               ON origin.order_id = target_order.id
             JOIN quote_sessions session ON session.id = origin.quote_session_id
             WHERE target_order.id = $1`,
            [anonymousQuoted.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_customer_id: null,
          session_customer_id: null,
          session_status: "CONVERTED",
        },
      ]);

      await expectQueryError(
        client,
        "claim_quoted_order_without_session",
        () =>
          client.query(`UPDATE orders SET customer_id = $2 WHERE id = $1`, [
            anonymousQuoted.orderId,
            anonymousQuoted.customerId,
          ]),
        {
          code: "23514",
          constraint: "order_customer_ownership_immutable_check",
        },
      );

      await client.query(
        `UPDATE quote_sessions
         SET customer_id = $2, updated_at = clock_timestamp()
         WHERE id = $1`,
        [anonymousQuoted.quoteSessionId, anonymousQuoted.customerId],
      );
      expect(
        (
          await client.query<{ customer_id: string }>(
            `SELECT customer_id FROM quote_sessions WHERE id = $1
             UNION ALL
             SELECT customer_id FROM orders WHERE id = $2`,
            [anonymousQuoted.quoteSessionId, anonymousQuoted.orderId],
          )
        ).rows,
      ).toEqual([
        { customer_id: anonymousQuoted.customerId },
        { customer_id: anonymousQuoted.customerId },
      ]);

      await createCurrentPlan(client, fixtures, anonymousQuoted);
      await fixtures.finalizePayment(anonymousQuoted);
      expect(
        (
          await client.query<{ status: string }>(
            `SELECT status::text FROM payments WHERE id = $1`,
            [anonymousQuoted.paymentId],
          )
        ).rows,
      ).toEqual([{ status: "PENDING" }]);
    });
  });

  it("reconciles immutable price components and freezes automatic commerce after payment intent creation", async () => {
    await rollback("immutable-pricing", async (client, fixtures) => {
      const zeroContract = await fixtures.createFoundation(
        "zero-contract-pricing",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [{ priced: false }],
        "DRAFT",
        undefined,
        { orderMinimum: 0, smallSurcharge: 0 },
      );
      await expectQueryError(
        client,
        "quote_zero_value_contract",
        async () => {
          const quotedAt = new Date();
          await client.query(
            `UPDATE orders
             SET status = 'QUOTED', quoted_at = $2, updated_at = $2
             WHERE id = $1`,
            [zeroContract.orderId, quotedAt],
          );
          await client.query(
            `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "quoted_order_positive_payment_check",
        },
      );

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
      const insertLateShipmentPlan = (id: string) =>
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
            id,
            foundation.orderId,
            foundation.orderPhaseId,
            foundation.priceSnapshotId,
            foundation.orderPriceBindingId,
            foundation.deliveryDestinationId,
            new Date(),
          ],
        );
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
      await expectQueryError(
        client,
        "quoted_shipment_plan_insert",
        () => insertLateShipmentPlan(fixtures.id("late-quoted-shipment-plan")),
        { code: "23514", constraint: "shipment_plan_order_status_guard" },
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);
      await forceQuoteIssuanceConstraints(client);
      await expectQueryError(
        client,
        "sealed_snapshot_component_insert",
        () =>
          client.query(
            `INSERT INTO price_snapshot_components
               (id, price_snapshot_id, kind, scope, amount_minor,
                allocation, created_at)
             VALUES ($1,$2,'PAYMENT_FEE','ORDER',0,'{}'::jsonb,$3)`,
            [
              fixtures.id("late-zero-price-component"),
              foundation.priceSnapshotId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "price_snapshot_binding_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "sealed_snapshot_schedule_insert",
        () =>
          client.query(
            `INSERT INTO payment_schedules
               (id, price_snapshot_id, sequence, role, gross_amount_minor,
                fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
             VALUES ($1,$2,1,'FULL',0,0,0,'{}'::jsonb,$3)`,
            [
              fixtures.id("late-zero-payment-schedule"),
              foundation.priceSnapshotId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "price_snapshot_binding_immutable_check",
        },
      );
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
        () => insertLateShipmentPlan(fixtures.id("late-paid-shipment-plan")),
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

  it("reconciles the exact per-capture gateway fee before sealing a price snapshot", async () => {
    await rollback("payment-schedule-fee", async (client, fixtures) => {
      const insertSnapshot = async (
        name: string,
        feeComponents: readonly number[],
        rateBasisPoints = 1,
        fixedMinor = 2,
      ) => {
        const snapshotId = fixtures.id(`${name}:snapshot`);
        const grossAmountMinor = 10_001;
        const expectedFee = 4;
        const now = new Date();
        await client.query(
          `INSERT INTO price_snapshots
             (id, price_list_id, currency, contract_total_minor, pricing_revision,
              input_snapshot, snapshot_hash, created_at)
           VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                   'EUR',$2,'legacy-v0-eur','{}'::jsonb,$3,$4)`,
          [
            snapshotId,
            grossAmountMinor,
            randomUUID().replaceAll("-", "").repeat(2),
            now,
          ],
        );
        await client.query(
          `INSERT INTO payment_schedules
             (id, price_snapshot_id, sequence, role, gross_amount_minor,
              fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
           VALUES ($1,$2,0,'FULL',$3,$4,$5,'{}'::jsonb,$6)`,
          [
            fixtures.id(`${name}:schedule`),
            snapshotId,
            grossAmountMinor,
            rateBasisPoints,
            fixedMinor,
            now,
          ],
        );
        await client.query(
          `INSERT INTO price_snapshot_components
             (id, price_snapshot_id, kind, scope, amount_minor,
              allocation, created_at)
           VALUES ($1,$2,'ORDER_MIN_PRINT','ORDER',$3,'{}'::jsonb,$4)`,
          [
            fixtures.id(`${name}:base`),
            snapshotId,
            grossAmountMinor - expectedFee,
            now,
          ],
        );
        for (const [index, amount] of feeComponents.entries()) {
          await client.query(
            `INSERT INTO price_snapshot_components
               (id, price_snapshot_id, kind, scope, amount_minor,
                allocation, created_at)
             VALUES ($1,$2,'PAYMENT_FEE','ORDER',$3,'{}'::jsonb,$4)`,
            [fixtures.id(`${name}:fee:${index}`), snapshotId, amount, now],
          );
        }
        await client.query(
          `SET CONSTRAINTS
             "price_snapshots_total_reconciled",
             "price_snapshot_components_total_reconciled",
             "payment_schedules_total_reconciled" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS
             "price_snapshots_total_reconciled",
             "price_snapshot_components_total_reconciled",
             "payment_schedules_total_reconciled" DEFERRED`,
        );
      };

      await insertSnapshot("valid-fractional-fee", [4]);
      for (const [name, components] of [
        ["missing_fee", []],
        ["wrong_fee", [3]],
        ["split_fee", [2, 2]],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () => insertSnapshot(name, components),
          {
            code: "23514",
            constraint: "payment_schedule_fee_component_reconciliation_check",
          },
        );
      }

      await expectQueryError(
        client,
        "non_finite_fee_rate",
        () => insertSnapshot("non_finite_fee_rate", [4], 10_000),
        { code: "23514", constraint: "payment_schedules_values_check" },
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

  it("reconciles exactly one shipment price component with each plan", async () => {
    await rollback(
      "shipment-plan-price-components",
      async (client, fixtures) => {
        const reconciliationError = {
          code: "23514",
          constraint: "shipment_plan_price_component_reconciliation_check",
        };
        const forceReconciliation = () =>
          client.query(
            `SET CONSTRAINTS "shipment_plans_price_reconciled" IMMEDIATE`,
          );
        const quoteForReconciliation = (foundation: PersistenceFoundation) =>
          client.query(
            `UPDATE orders
             SET status = 'QUOTED', quoted_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [foundation.orderId],
          );

        const mismatched = await fixtures.createFoundation(
          "mismatched-shipment-price",
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
          "mismatched_shipment_price",
          async () => {
            await client.query(
              `SET LOCAL session_replication_role = 'replica'`,
            );
            await client.query(
              `UPDATE shipment_plans
             SET packaging_amount_minor = packaging_amount_minor + 1
             WHERE id = $1`,
              [mismatched.shipmentPlanId],
            );
            await client.query(`SET LOCAL session_replication_role = 'origin'`);
            await quoteForReconciliation(mismatched);
            await forceReconciliation();
          },
          reconciliationError,
        );

        const missing = await fixtures.createFoundation(
          "missing-shipment-price",
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
          "missing_shipment_price",
          async () => {
            await client.query(
              `SET LOCAL session_replication_role = 'replica'`,
            );
            await client.query(
              `DELETE FROM price_component_fulfilment_allocations
             WHERE price_snapshot_component_id = $1`,
              [missing.priceSnapshotComponentIds[3]],
            );
            await client.query(
              `DELETE FROM price_snapshot_components WHERE id = $1`,
              [missing.priceSnapshotComponentIds[3]],
            );
            await client.query(`SET LOCAL session_replication_role = 'origin'`);
            await quoteForReconciliation(missing);
            await forceReconciliation();
          },
          reconciliationError,
        );

        const duplicated = await fixtures.createFoundation(
          "duplicate-shipment-price",
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
          "duplicate_shipment_price",
          async () => {
            await client.query(
              `SET LOCAL session_replication_role = 'replica'`,
            );
            await client.query(
              `INSERT INTO price_snapshot_components
               (id, price_snapshot_id, kind, scope, shipment_plan_id,
                amount_minor, allocation, created_at)
             VALUES ($1,$2,'SHIPMENT','SHIPMENT_PLAN',$3,0,'{}'::jsonb,$4)`,
              [
                fixtures.id("duplicate-shipment-component"),
                duplicated.priceSnapshotId,
                duplicated.shipmentPlanId,
                new Date(),
              ],
            );
            await client.query(`SET LOCAL session_replication_role = 'origin'`);
            await quoteForReconciliation(duplicated);
            await forceReconciliation();
          },
          reconciliationError,
        );

        const netted = await fixtures.createFoundation(
          "netted-shipment-prices",
          {},
          undefined,
          undefined,
          undefined,
          2,
          [{}, {}],
          "DRAFT",
        );
        await expectQueryError(
          client,
          "cross_plan_shipment_price_netting",
          async () => {
            await client.query(
              `SET LOCAL session_replication_role = 'replica'`,
            );
            await client.query(
              `UPDATE shipment_plans
             SET shipping_amount_minor = CASE ordinal
                   WHEN 0 THEN shipping_amount_minor - 10
                   ELSE shipping_amount_minor + 10
                 END
             WHERE order_id = $1`,
              [netted.orderId],
            );
            await client.query(`SET LOCAL session_replication_role = 'origin'`);
            await quoteForReconciliation(netted);
            await forceReconciliation();
          },
          reconciliationError,
        );

        const splitCharges = await fixtures.createFoundation(
          "split-shipment-charges",
          {},
          undefined,
          undefined,
          undefined,
          1,
          undefined,
          "DRAFT",
        );
        await client.query(`SET LOCAL session_replication_role = 'replica'`);
        await client.query(
          `UPDATE shipment_plans
         SET shipping_amount_minor = 20,
             packaging_amount_minor = 15,
             handling_amount_minor = 15
         WHERE id = $1`,
          [splitCharges.shipmentPlanId],
        );
        await client.query(`SET LOCAL session_replication_role = 'origin'`);
        await quoteForReconciliation(splitCharges);
        await expect(forceReconciliation()).resolves.toBeDefined();
      },
    );
  });

  it("requires quote-ready shipment topology when moving an active binding", async () => {
    await rollback(
      "active-binding-quote-topology",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "active-binding-quote-topology",
          {},
          undefined,
          undefined,
          undefined,
          1,
          undefined,
          "DRAFT",
          undefined,
          {},
          "AUTOMATIC",
          true,
          true,
          false,
        );
        const alternateDestinationId = fixtures.id(
          "active-binding-alternate-destination",
        );
        await client.query(
          `INSERT INTO delivery_destinations
             (id, order_id, provider_endpoint_id, endpoint_type,
              address_snapshot, capability_snapshot, created_at)
           VALUES ($1,$2,'alternate-endpoint','HOME','{}'::jsonb,
                   '{}'::jsonb,clock_timestamp())`,
          [alternateDestinationId, foundation.orderId],
        );
        const sourceComponents = (
          await client.query<{
            allocation: unknown;
            amount_minor: string;
            kind: string;
            order_item_id: string | null;
            quote_item_id: string | null;
            scope: string;
          }>(
            `SELECT kind::text, scope::text, quote_item_id, order_item_id,
                  amount_minor::text, allocation
           FROM price_snapshot_components
           WHERE price_snapshot_id = $1
           ORDER BY kind::text`,
            [foundation.priceSnapshotId],
          )
        ).rows;
        const shipmentAmount = sourceComponents
          .filter((component) => component.kind === "SHIPMENT")
          .reduce(
            (total, component) => total + BigInt(component.amount_minor),
            0n,
          );

        const createReplacement = async (
          name: string,
          includeShipmentPlan: boolean,
        ): Promise<{
          bindingId: string;
          paymentScheduleId: string;
          planId: string | null;
          snapshotId: string;
        }> => {
          const snapshotId = fixtures.id(`${name}:snapshot`);
          const bindingId = fixtures.id(`${name}:binding`);
          const paymentScheduleId = fixtures.id(`${name}:payment-schedule`);
          const planId = includeShipmentPlan
            ? fixtures.id(`${name}:shipment-plan`)
            : null;
          const createdAt = new Date();
          await client.query(
            `INSERT INTO price_snapshots
             (id, price_list_id, currency, contract_total_minor, pricing_revision,
              input_snapshot, snapshot_hash, created_at)
           SELECT $1, price_list_id, currency, contract_total_minor,
                  pricing_revision, input_snapshot, $2, $3
           FROM price_snapshots WHERE id = $4`,
            [
              snapshotId,
              randomUUID().replaceAll("-", "").repeat(2),
              createdAt,
              foundation.priceSnapshotId,
            ],
          );
          await client.query(
            `INSERT INTO payment_schedules
             (id, price_snapshot_id, sequence, role, gross_amount_minor,
              fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
           SELECT $1, $2, sequence, role, gross_amount_minor,
                  fee_rate_basis_points, fee_fixed_minor, provider_config, $3
           FROM payment_schedules WHERE id = $4`,
            [
              paymentScheduleId,
              snapshotId,
              createdAt,
              foundation.paymentScheduleId,
            ],
          );
          await client.query(
            `INSERT INTO order_price_bindings
             (id, order_id, price_snapshot_id, delivery_destination_id, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
            [
              bindingId,
              foundation.orderId,
              snapshotId,
              foundation.deliveryDestinationId,
              createdAt,
            ],
          );

          if (planId) {
            await client.query(
              `INSERT INTO shipment_plans
               (id, order_id, order_phase_id, price_snapshot_id,
                order_price_binding_id, delivery_destination_id, ordinal,
                category, planned_volume_cubic_mm, planned_weight_milligrams,
                shipping_amount_minor, packaging_amount_minor,
                handling_amount_minor, allocation_snapshot, created_at)
             SELECT $1, order_id, order_phase_id, $2, $3,
                    delivery_destination_id, ordinal, category,
                    planned_volume_cubic_mm, planned_weight_milligrams,
                    shipping_amount_minor, packaging_amount_minor,
                    handling_amount_minor, allocation_snapshot, $4
             FROM shipment_plans WHERE id = $5`,
              [
                planId,
                snapshotId,
                bindingId,
                createdAt,
                foundation.shipmentPlanId,
              ],
            );
            await client.query(
              `INSERT INTO shipment_plan_fulfilment_slots
               (shipment_plan_id, order_price_binding_id, fulfilment_slot_id)
             VALUES ($1,$2,$3)`,
              [planId, bindingId, foundation.fulfilmentSlotId],
            );
          }

          const replacementComponents = includeShipmentPlan
            ? sourceComponents
            : sourceComponents
                .filter((component) => component.kind !== "SHIPMENT")
                .map((component) => ({
                  ...component,
                  amount_minor:
                    component.kind === "ORDER_MIN_PRINT"
                      ? (
                          BigInt(component.amount_minor) + shipmentAmount
                        ).toString()
                      : component.amount_minor,
                }));
          for (const [index, component] of replacementComponents.entries()) {
            const componentId = fixtures.id(`${name}:component:${index}`);
            const mappedPlanId = component.kind === "SHIPMENT" ? planId : null;
            await client.query(
              `INSERT INTO price_snapshot_components
               (id, price_snapshot_id, kind, scope, quote_item_id,
                order_item_id, shipment_plan_id, amount_minor,
                allocation, created_at)
             VALUES ($1,$2,$3::price_component_kind,$4::price_component_scope,
                     $5,$6,$7,$8,$9::jsonb,$10)`,
              [
                componentId,
                snapshotId,
                component.kind,
                component.scope,
                component.quote_item_id,
                component.order_item_id,
                mappedPlanId,
                component.amount_minor,
                JSON.stringify(component.allocation),
                createdAt,
              ],
            );
            await client.query(
              `INSERT INTO price_component_fulfilment_allocations
               (price_snapshot_component_id, fulfilment_slot_id, amount_minor)
             VALUES ($1,$2,$3)`,
              [
                componentId,
                foundation.fulfilmentSlotId,
                component.amount_minor,
              ],
            );
          }
          return { bindingId, paymentScheduleId, planId, snapshotId };
        };

        const incomplete = await createReplacement("incomplete", false);
        const complete = await createReplacement("complete", true);
        const guarded = await createReplacement("guarded", true);
        await client.query(
          `SET CONSTRAINTS
           "price_snapshots_total_reconciled",
           "price_snapshot_components_total_reconciled",
           "payment_schedules_total_reconciled",
           "order_price_bindings_snapshot_sealed",
           "price_component_fulfilment_allocations_reconciled" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS
           "price_snapshots_total_reconciled",
           "price_snapshot_components_total_reconciled",
           "payment_schedules_total_reconciled",
           "order_price_bindings_snapshot_sealed",
           "price_component_fulfilment_allocations_reconciled" DEFERRED`,
        );
        const staleProductions = await createCurrentPlan(
          client,
          fixtures,
          foundation,
        );
        await client.query(
          `UPDATE orders
         SET status = 'QUOTED', quoted_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1`,
          [foundation.orderId],
        );
        await client.query(
          `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" DEFERRED`,
        );

        await expectQueryError(
          client,
          "invalidate_active_binding_in_place",
          () =>
            client.query(
              `UPDATE order_price_bindings
             SET invalidated_at = clock_timestamp()
             WHERE id = $1`,
              [foundation.orderPriceBindingId],
            ),
          {
            code: "23514",
            constraint: "active_order_price_binding_invalidation_check",
          },
        );
        await expectQueryError(
          client,
          "move_without_shipment_topology",
          () =>
            client.query(
              `UPDATE order_active_price_bindings
             SET order_price_binding_id = $2 WHERE order_id = $1`,
              [foundation.orderId, incomplete.bindingId],
            ),
          {
            code: "23514",
            constraint: "active_order_price_binding_quote_topology_check",
          },
        );
        expect(
          (
            await client.query<{
              active_binding_id: string;
              original_invalidated_at: Date | null;
            }>(
              `SELECT active.order_price_binding_id AS active_binding_id,
                    binding.invalidated_at AS original_invalidated_at
             FROM order_active_price_bindings active
             JOIN order_price_bindings binding
               ON binding.id = $2
             WHERE active.order_id = $1`,
              [foundation.orderId, foundation.orderPriceBindingId],
            )
          ).rows,
        ).toEqual([
          {
            active_binding_id: foundation.orderPriceBindingId,
            original_invalidated_at: null,
          },
        ]);

        await client.query(
          `UPDATE order_active_price_bindings
         SET order_price_binding_id = $2 WHERE order_id = $1`,
          [foundation.orderId, complete.bindingId],
        );
        await client.query(
          `SET CONSTRAINTS "order_active_price_bindings_quoted_reconciled" IMMEDIATE`,
        );
        expect(
          (
            await client.query<{
              active_binding_id: string;
              original_invalidated: boolean;
              plan_id: string;
            }>(
              `SELECT active.order_price_binding_id AS active_binding_id,
                    binding.invalidated_at IS NOT NULL AS original_invalidated,
                    plan.id AS plan_id
             FROM order_active_price_bindings active
             JOIN order_price_bindings binding ON binding.id = $2
             JOIN shipment_plans plan
               ON plan.order_price_binding_id = active.order_price_binding_id
             WHERE active.order_id = $1`,
              [foundation.orderId, foundation.orderPriceBindingId],
            )
          ).rows,
        ).toEqual([
          {
            active_binding_id: complete.bindingId,
            original_invalidated: true,
            plan_id: complete.planId,
          },
        ]);

        await expectQueryError(
          client,
          "insert_shipment_for_inactive_binding",
          () =>
            client.query(
              `INSERT INTO shipments
                 (id, order_id, order_phase_id, shipment_plan_id,
                  delivery_destination_id, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp())`,
              [
                fixtures.id("inactive-binding-shipment"),
                foundation.orderId,
                foundation.orderPhaseId,
                foundation.shipmentPlanId,
                foundation.deliveryDestinationId,
              ],
            ),
          {
            code: "23514",
            constraint: "active_order_price_binding_shipment_guard",
          },
        );
        await expectQueryError(
          client,
          "insert_inactive_shipment_with_wrong_plan_scope",
          () =>
            client.query(
              `INSERT INTO shipments
                 (id, order_id, order_phase_id, shipment_plan_id,
                  delivery_destination_id, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp())`,
              [
                fixtures.id("inactive-binding-wrong-scope-shipment"),
                foundation.orderId,
                foundation.orderPhaseId,
                foundation.shipmentPlanId,
                alternateDestinationId,
              ],
            ),
          {
            code: "23503",
            constraint:
              "shipments_shipment_plan_id_order_id_order_phase_id_deliver_fkey",
          },
        );
        if (!complete.planId) {
          throw new Error("complete replacement requires a ShipmentPlan");
        }
        await client.query(
          `INSERT INTO shipments
             (id, order_id, order_phase_id, shipment_plan_id,
              delivery_destination_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp())`,
          [
            fixtures.id("active-binding-shipment"),
            foundation.orderId,
            foundation.orderPhaseId,
            complete.planId,
            foundation.deliveryDestinationId,
          ],
        );
        await expectQueryError(
          client,
          "move_after_shipment_creation",
          () =>
            client.query(
              `UPDATE order_active_price_bindings
               SET order_price_binding_id = $2 WHERE order_id = $1`,
              [foundation.orderId, guarded.bindingId],
            ),
          {
            code: "23514",
            constraint: "active_order_price_binding_shipment_guard",
          },
        );
        expect(
          (
            await client.query<{
              active_binding_id: string;
              active_invalidated_at: Date | null;
            }>(
              `SELECT active.order_price_binding_id AS active_binding_id,
                      binding.invalidated_at AS active_invalidated_at
               FROM order_active_price_bindings active
               JOIN order_price_bindings binding
                 ON binding.id = active.order_price_binding_id
               WHERE active.order_id = $1`,
              [foundation.orderId],
            )
          ).rows,
        ).toEqual([
          {
            active_binding_id: complete.bindingId,
            active_invalidated_at: null,
          },
        ]);

        const currentFoundation: PersistenceFoundation = {
          ...foundation,
          eligibilitySnapshotId: fixtures.id(
            "active-binding-current-eligibility",
          ),
          phaseResourcePlanId: fixtures.id(
            "active-binding-current-resource-plan",
          ),
          phaseReservationSetId: fixtures.id(
            "active-binding-current-reservation-set",
          ),
          priceSnapshotId: complete.snapshotId,
          paymentScheduleId: complete.paymentScheduleId,
          orderPriceBindingId: complete.bindingId,
          shipmentPlanId: complete.planId,
          shipmentPlanIds: [complete.planId],
          fulfilmentSlotShipmentPlanIds: [complete.planId],
        };
        const currentProductions = await createCurrentPlan(
          client,
          fixtures,
          currentFoundation,
          undefined,
          complete.bindingId,
          4,
        );
        await fixtures.finalizePayment(currentFoundation);
        const releaseReservedPlan = async (
          reservationSetId: string,
          productions: ProductionReservationFixture[],
        ): Promise<void> => {
          for (const production of productions) {
            await client.query(
              `UPDATE inventory_reservations SET status = 'RELEASED'
               WHERE production_reservation_id = $1`,
              [production.productionReservationId],
            );
            await client.query(
              `UPDATE capacity_reservations SET status = 'RELEASED'
               WHERE production_reservation_id = $1`,
              [production.productionReservationId],
            );
            await client.query(
              `UPDATE production_reservations SET status = 'RELEASED'
               WHERE id = $1`,
              [production.productionReservationId],
            );
          }
          await client.query(
            `UPDATE phase_reservation_sets SET status = 'RELEASED'
             WHERE id = $1`,
            [reservationSetId],
          );
        };

        await expectQueryError(
          client,
          "capture_stale_binding_reservation",
          async () => {
            await releaseReservedPlan(
              currentFoundation.phaseReservationSetId,
              currentProductions,
            );
            await activateCurrentPlan(
              client,
              fixtures,
              foundation,
              staleProductions,
            );
          },
          {
            code: "23514",
            constraint: "payment_capture_activation_check",
          },
        );
        await expectQueryError(
          client,
          "capture_with_unreleased_stale_reservation",
          () =>
            activateCurrentPlan(
              client,
              fixtures,
              currentFoundation,
              currentProductions,
            ),
          {
            code: "23514",
            constraint: "payment_capture_activation_check",
          },
        );
        await expectQueryError(
          client,
          "capture_before_stale_binding_hold",
          async () => {
            await releaseReservedPlan(
              currentFoundation.phaseReservationSetId,
              currentProductions,
            );
            await fixtures.activatePayment(currentFoundation);
            await holdCurrentPlan(
              client,
              fixtures,
              foundation,
              staleProductions,
            );
            await forceCaptureActivationConstraints(client);
          },
          {
            code: "23514",
            constraint: "payment_capture_activation_check",
          },
        );
        expect(
          (
            await client.query<{
              current_reservation_status: string;
              order_status: string;
              payment_status: string;
              phase_status: string;
              stale_reservation_status: string;
            }>(
              `SELECT target_order.status::text AS order_status,
                      phase.status::text AS phase_status,
                      payment.status::text AS payment_status,
                      stale_set.status::text AS stale_reservation_status,
                      current_set.status::text AS current_reservation_status
               FROM orders target_order
               JOIN order_phases phase ON phase.order_id = target_order.id
               JOIN payments payment ON payment.order_id = target_order.id
               JOIN phase_reservation_sets stale_set ON stale_set.id = $2
               JOIN phase_reservation_sets current_set ON current_set.id = $3
               WHERE target_order.id = $1`,
              [
                foundation.orderId,
                foundation.phaseReservationSetId,
                currentFoundation.phaseReservationSetId,
              ],
            )
          ).rows,
        ).toEqual([
          {
            current_reservation_status: "RESERVED",
            order_status: "QUOTED",
            payment_status: "PENDING",
            phase_status: "QUOTED",
            stale_reservation_status: "RESERVED",
          },
        ]);

        await releaseReservedPlan(
          foundation.phaseReservationSetId,
          staleProductions,
        );
        await activateCurrentPlan(
          client,
          fixtures,
          currentFoundation,
          currentProductions,
        );
        expect(
          (
            await client.query<{
              job_binding_id: string;
              stale_reservation_status: string;
            }>(
              `SELECT plan.order_price_binding_id AS job_binding_id,
                      stale_set.status::text AS stale_reservation_status
               FROM jobs job
               JOIN shipment_plans plan ON plan.id = job.shipment_plan_id
               JOIN phase_reservation_sets stale_set ON stale_set.id = $2
               WHERE job.order_id = $1`,
              [foundation.orderId, foundation.phaseReservationSetId],
            )
          ).rows,
        ).toEqual([
          {
            job_binding_id: complete.bindingId,
            stale_reservation_status: "RELEASED",
          },
        ]);
      },
    );
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
           (id, price_list_id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                 'EUR',0,'legacy-v0-eur','{}'::jsonb,$2,$3)`,
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
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "active_order_price_binding_invalidation_check",
      });
      await mutating.query("ROLLBACK");

      await mutating.query("BEGIN");
      await expect(
        mutating.query(
          `UPDATE order_price_bindings SET invalidated_at = $2 WHERE id = $1`,
          [replacementBindingId, new Date()],
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
        constraint: "active_order_price_binding_invalidation_check",
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

  it.each([
    ["UPDATE", "READ COMMITTED", "update-read-committed", true, "23514"],
    ["UPDATE", "REPEATABLE READ", "update-repeatable-read", true, "40001"],
    ["INSERT", "READ COMMITTED", "insert-read-committed", false, "23514"],
    ["INSERT", "REPEATABLE READ", "insert-repeatable-read", false, "40001"],
  ] as const)(
    "prevents candidate invalidation after a concurrent active-binding %s at %s",
    async (
      operation,
      isolationLevel,
      caseScope,
      includeActivePriceBinding,
      expectedCode,
    ) => {
      const setup = await pool.connect();
      const moving = await pool.connect();
      const invalidating = await pool.connect();
      try {
        const fixtures = new PersistenceFactory(
          setup,
          `${scope}:binding-invalidation-concurrency:${caseScope}`,
        );
        await setup.query("BEGIN");
        const foundation = await fixtures.createFoundation(
          "binding-invalidation-concurrency",
          {},
          undefined,
          undefined,
          undefined,
          1,
          undefined,
          "DRAFT",
          undefined,
          {},
          "AUTOMATIC",
          includeActivePriceBinding,
          true,
          false,
        );
        const replacementSnapshotId = fixtures.id(
          "binding-invalidation-concurrency:replacement-snapshot",
        );
        const replacementBindingId = fixtures.id(
          "binding-invalidation-concurrency:replacement-binding",
        );
        const createdAt = new Date();
        await setup.query(
          `INSERT INTO price_snapshots
           (id, price_list_id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                 'EUR',0,'legacy-v0-eur','{}'::jsonb,$2,$3)`,
          [
            replacementSnapshotId,
            randomUUID().replaceAll("-", "").repeat(2),
            createdAt,
          ],
        );
        await setup.query(
          `INSERT INTO payment_schedules
           (id, price_snapshot_id, sequence, role, gross_amount_minor,
            fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
         VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
          [
            fixtures.id(
              "binding-invalidation-concurrency:replacement-schedule",
            ),
            replacementSnapshotId,
            createdAt,
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
            createdAt,
          ],
        );
        await setup.query("COMMIT");

        await moving.query("BEGIN");
        await moving.query("SET LOCAL lock_timeout = '1s'");
        await moving.query(
          operation === "UPDATE"
            ? `UPDATE order_active_price_bindings
               SET order_price_binding_id = $2 WHERE order_id = $1`
            : `INSERT INTO order_active_price_bindings
                 (order_id, order_price_binding_id) VALUES ($1,$2)`,
          [foundation.orderId, replacementBindingId],
        );

        await invalidating.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
        await invalidating.query("SET LOCAL statement_timeout = '2s'");
        const invalidatingPid = (
          await invalidating.query<{ pid: number }>(
            `SELECT pg_backend_pid() AS pid`,
          )
        ).rows[0]?.pid;
        if (!invalidatingPid) {
          throw new Error("binding invalidation backend pid is unavailable");
        }
        const blockedInvalidation = invalidating
          .query(
            `UPDATE order_price_bindings
             SET invalidated_at = clock_timestamp()
             WHERE id = $1`,
            [replacementBindingId],
          )
          .then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          );

        let invalidationIsWaitingForActivatedBinding = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const activity = await setup.query<{
            wait_event_type: string | null;
          }>(
            `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE pid = $1`,
            [invalidatingPid],
          );
          if (activity.rows[0]?.wait_event_type === "Lock") {
            invalidationIsWaitingForActivatedBinding = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(invalidationIsWaitingForActivatedBinding).toBe(true);

        await moving.query("COMMIT");
        const invalidationOutcome = await blockedInvalidation;
        expect(invalidationOutcome.error).toMatchObject({
          code: expectedCode,
          ...(expectedCode === "23514"
            ? { constraint: "active_order_price_binding_invalidation_check" }
            : {}),
        });
        await invalidating.query("ROLLBACK");

        expect(
          (
            await setup.query<{
              active_binding_id: string;
              original_invalidated: boolean;
              replacement_invalidated_at: Date | null;
            }>(
              `SELECT active.order_price_binding_id AS active_binding_id,
                    original.invalidated_at IS NOT NULL AS original_invalidated,
                    replacement.invalidated_at AS replacement_invalidated_at
             FROM order_active_price_bindings active
             JOIN order_price_bindings original ON original.id = $2
             JOIN order_price_bindings replacement ON replacement.id = $3
             WHERE active.order_id = $1`,
              [
                foundation.orderId,
                foundation.orderPriceBindingId,
                replacementBindingId,
              ],
            )
          ).rows,
        ).toEqual([
          {
            active_binding_id: replacementBindingId,
            original_invalidated: operation === "UPDATE",
            replacement_invalidated_at: null,
          },
        ]);
      } finally {
        await setup.query("ROLLBACK").catch(() => undefined);
        await moving.query("ROLLBACK").catch(() => undefined);
        await invalidating.query("ROLLBACK").catch(() => undefined);
        setup.release();
        moving.release();
        invalidating.release();
      }
    },
  );

  it("binds item reference slices to their exact geometry, print configuration, and material", async () => {
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
      const createReferenceOccupancy = async (
        name: string,
        partsPerPlate: number,
      ) => {
        const id = fixtures.id(`reference-inputs:${name}`);
        await client.query(
          `INSERT INTO slice_results
             (id, kind, cache_key, model_geometry_id,
              print_config_revision_id, reference_profile_id,
              parts_per_plate, artifact_object_key, artifact_hash,
              estimated_print_seconds, estimated_material_milligrams,
              slicer_engine, slicer_version, created_at)
           SELECT $1, 'REFERENCE', $2, source.model_geometry_id,
                  source.print_config_revision_id, source.reference_profile_id,
                  $3, $4, source.artifact_hash,
                  source.estimated_print_seconds,
                  source.estimated_material_milligrams,
                  source.slicer_engine, source.slicer_version, $5
           FROM slice_results source
           WHERE source.id = $6`,
          [
            id,
            `reference-${name}-${id}`,
            partsPerPlate,
            `reference/${name}/${id}`,
            new Date(),
            matchingReferenceId,
          ],
        );
        return id;
      };
      const fullReferenceId = await createReferenceOccupancy("full", 4);
      const shortReferenceId = await createReferenceOccupancy("short", 2);
      const alternateProfileTailReferenceId =
        await createAlternateProfileReferenceSlice(
          client,
          fixtures,
          matchingReferenceId,
          "reference-inputs-tail",
        );

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
          material: "PLA" | "PETG" = "PLA",
          referencePartsPerPlate = 1,
          tailReferenceSliceId: string | null = null,
          quantity = 1,
        ) =>
          client.query(
            `INSERT INTO ${table} (id, ${parentColumn}, ordinal,
                                  source_model_file_id, model_geometry_id,
                                  print_config_revision_id, reference_slice_result_id,
                                  tail_reference_slice_result_id,
                                  reference_parts_per_plate,
                                  material, color, quantity, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::material,'black',$11,$12)`,
            [
              id,
              parentId,
              ordinal,
              foundation.modelFileId,
              geometryId,
              configId,
              referenceSliceId,
              tailReferenceSliceId,
              referencePartsPerPlate,
              material,
              quantity,
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
        const fullTailItemId = fixtures.id(`${table}:full-tail-reference-item`);
        await expect(
          insertItem(
            fullTailItemId,
            7,
            fullReferenceId,
            foundation.modelGeometryIds[0]!,
            foundation.printConfigRevisionIds[0]!,
            "PLA",
            4,
            matchingReferenceId,
            5,
          ),
        ).resolves.toBeDefined();
        await expect(
          client.query(
            `SELECT reference_slice_result_id,
                    tail_reference_slice_result_id,
                    reference_parts_per_plate
             FROM ${table} WHERE id = $1`,
            [fullTailItemId],
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              reference_slice_result_id: fullReferenceId,
              tail_reference_slice_result_id: matchingReferenceId,
              reference_parts_per_plate: 4,
            },
          ],
        });
        await expect(
          insertItem(
            fixtures.id(`${table}:exact-reference-item`),
            8,
            fullReferenceId,
            foundation.modelGeometryIds[0]!,
            foundation.printConfigRevisionIds[0]!,
            "PLA",
            4,
            null,
            4,
          ),
        ).resolves.toBeDefined();
        await expect(
          insertItem(
            fixtures.id(`${table}:below-capacity-reference-item`),
            9,
            shortReferenceId,
            foundation.modelGeometryIds[0]!,
            foundation.printConfigRevisionIds[0]!,
            "PLA",
            4,
            null,
            2,
          ),
        ).resolves.toBeDefined();
        await expectQueryError(
          client,
          `${table}_missing_tail_reference`,
          () =>
            insertItem(
              fixtures.id(`${table}:missing-tail-reference-item`),
              10,
              fullReferenceId,
              foundation.modelGeometryIds[0]!,
              foundation.printConfigRevisionIds[0]!,
              "PLA",
              4,
              null,
              5,
            ),
          { code: "23514", constraint },
        );
        await expectQueryError(
          client,
          `${table}_wrong_tail_reference`,
          () =>
            insertItem(
              fixtures.id(`${table}:wrong-tail-reference-item`),
              11,
              fullReferenceId,
              foundation.modelGeometryIds[0]!,
              foundation.printConfigRevisionIds[0]!,
              "PLA",
              4,
              shortReferenceId,
              5,
            ),
          { code: "23514", constraint },
        );
        await expectQueryError(
          client,
          `${table}_cross_profile_tail_reference`,
          () =>
            insertItem(
              fixtures.id(`${table}:cross-profile-tail-reference-item`),
              12,
              fullReferenceId,
              foundation.modelGeometryIds[0]!,
              foundation.printConfigRevisionIds[0]!,
              "PLA",
              4,
              alternateProfileTailReferenceId,
              5,
            ),
          { code: "23514", constraint },
        );
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
        await expectQueryError(
          client,
          `${table}_wrong_material_reference`,
          () =>
            insertItem(
              fixtures.id(`${table}:wrong-material-reference-item`),
              6,
              matchingReferenceId,
              foundation.modelGeometryIds[0]!,
              foundation.printConfigRevisionIds[0]!,
              "PETG",
            ),
          { code: "23514", constraint },
        );
        if (table === "order_items") {
          await expectQueryError(
            client,
            "order_item_reference_quantity_update_bypass",
            () =>
              client.query(
                `UPDATE order_items
                 SET quantity = 4
                 WHERE id = $1`,
                [fullTailItemId],
              ),
            { code: "23514", constraint },
          );
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
          await expectQueryError(
            client,
            "order_item_reference_material_update_bypass",
            () =>
              client.query(
                `UPDATE order_items
                 SET material = 'PETG'
                 WHERE id = $1`,
                [fixtures.id(`${table}:matching-reference-item`)],
              ),
            { code: "23514", constraint },
          );
        }
      }

      const mutableSnapshotId = fixtures.id("reference-inputs:price-snapshot");
      await client.query(
        `INSERT INTO price_snapshots
           (id, price_list_id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                 'EUR',0,'legacy-v0-eur','{}'::jsonb,$2,$3)`,
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

  it("requires a reference slice before sealing or quoting an automatic order", async () => {
    await rollback("automatic-reference-slice", async (client, fixtures) => {
      await expectQueryError(
        client,
        "seal_automatic_price_without_reference",
        async () => {
          await fixtures.createFoundation(
            "seal-automatic-price-without-reference",
            {},
            undefined,
            undefined,
            undefined,
            1,
            undefined,
            "DRAFT",
            async (foundation) => {
              await client.query(
                `UPDATE order_items
                 SET reference_slice_result_id = NULL,
                     reference_parts_per_plate = NULL
                 WHERE id = $1`,
                [foundation.orderItemId],
              );
            },
          );
          await forceQuoteIssuanceConstraints(client);
        },
        {
          code: "23514",
          constraint: "automatic_order_reference_slice_check",
        },
      );
      await expectQueryError(
        client,
        "seal_automatic_price_without_reference_tail",
        async () => {
          await fixtures.createFoundation(
            "missing-reference-tail",
            {},
            undefined,
            undefined,
            undefined,
            1,
            [
              {
                quantity: 5,
                sliceMetrics: {
                  partsPerPlate: 4,
                  estimatedPrintSeconds: 120,
                  estimatedMaterialMilligrams: 40,
                },
              },
            ],
            "DRAFT",
            async (foundation) => {
              await client.query(
                `SET LOCAL session_replication_role = 'replica'`,
              );
              await client.query(
                `UPDATE order_items
                 SET tail_reference_slice_result_id = NULL
                 WHERE id = $1`,
                [foundation.orderItemId],
              );
              await client.query(
                `SET LOCAL session_replication_role = 'origin'`,
              );
            },
          );
          await forceQuoteIssuanceConstraints(client);
        },
        {
          code: "23514",
          constraint: "automatic_order_reference_slice_check",
        },
      );
      await expectQueryError(
        client,
        "seal_automatic_price_with_cross_profile_tail",
        async () => {
          await fixtures.createFoundation(
            "cross-profile-reference-tail",
            {},
            undefined,
            undefined,
            undefined,
            1,
            [
              {
                quantity: 5,
                sliceMetrics: {
                  partsPerPlate: 4,
                  estimatedPrintSeconds: 120,
                  estimatedMaterialMilligrams: 40,
                },
              },
            ],
            "DRAFT",
            async (foundation) => {
              if (!foundation.referenceTailSliceResultId) {
                throw new Error("reference tail slice is missing");
              }
              const alternateTailReferenceId =
                await createAlternateProfileReferenceSlice(
                  client,
                  fixtures,
                  foundation.referenceTailSliceResultId,
                  "automatic-cross-profile-tail",
                );
              await client.query(
                `SET LOCAL session_replication_role = 'replica'`,
              );
              await client.query(
                `UPDATE order_items
                 SET tail_reference_slice_result_id = $2
                 WHERE id = $1`,
                [foundation.orderItemId, alternateTailReferenceId],
              );
              await client.query(
                `SET LOCAL session_replication_role = 'origin'`,
              );
            },
          );
          await forceQuoteIssuanceConstraints(client);
        },
        {
          code: "23514",
          constraint: "automatic_order_reference_slice_check",
        },
      );

      const corrupted = await fixtures.createFoundation(
        "quote-automatic-price-without-reference",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE order_items
         SET reference_slice_result_id = NULL,
             reference_parts_per_plate = NULL
         WHERE id = $1`,
        [corrupted.orderItemId],
      );
      await client.query(`SET LOCAL session_replication_role = 'origin'`);
      await expectQueryError(
        client,
        "quote_automatic_order_without_reference",
        async () => {
          await client.query(
            `UPDATE orders
             SET status = 'QUOTED', quoted_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [corrupted.orderId],
          );
          await client.query(
            `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "automatic_order_reference_slice_check",
        },
      );

      const belowCapacity = await fixtures.createFoundation(
        "automatic-below-reference-capacity",
        {},
        undefined,
        undefined,
        undefined,
        1,
        [
          {
            quantity: 2,
            sliceMetrics: {
              partsPerPlate: 4,
              estimatedPrintSeconds: 120,
              estimatedMaterialMilligrams: 40,
            },
          },
        ],
        "DRAFT",
      );
      expect(
        (
          await client.query<{
            primary_occupancy: number;
            reference_capacity: number;
            tail_reference_slice_result_id: string | null;
          }>(
            `SELECT reference.parts_per_plate AS primary_occupancy,
                    item.reference_parts_per_plate AS reference_capacity,
                    item.tail_reference_slice_result_id
             FROM order_items item
             JOIN slice_results reference
               ON reference.id = item.reference_slice_result_id
             WHERE item.id = $1`,
            [belowCapacity.orderItemId],
          )
        ).rows,
      ).toEqual([
        {
          primary_occupancy: 2,
          reference_capacity: 4,
          tail_reference_slice_result_id: null,
        },
      ]);

      const individual = await fixtures.createFoundation(
        "individual-order-without-reference",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "QUOTED",
        undefined,
        {},
        "INDIVIDUAL",
      );
      expect(
        (
          await client.query<{ reference_slice_result_id: string | null }>(
            `SELECT reference_slice_result_id
             FROM order_items WHERE id = $1`,
            [individual.orderItemId],
          )
        ).rows,
      ).toEqual([{ reference_slice_result_id: null }]);
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
      await expectQueryError(
        client,
        "rewrite_mutable_order_item_created_at",
        () =>
          client.query(
            `UPDATE order_items
             SET created_at = created_at + interval '1 millisecond'
             WHERE id = $1`,
            [mutableItemId],
          ),
        { code: "23514", constraint: "order_item_created_at_immutable_check" },
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
                 print_config_revision_id = $4,
                 reference_slice_result_id = $5
             WHERE id = $1`,
            [
              draftFoundation.orderItemIds[1],
              draftFoundation.modelFileId,
              draftFoundation.modelGeometryId,
              draftFoundation.printConfigRevisionId,
              draftFoundation.referenceSliceResultId,
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
                   provider_shipment_id = $2,
                   carrier_label_id = 'label-' || id::text, label_created_at = $3,
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
                 provider_shipment_id = $2,
                 carrier_label_id = 'label-' || id::text, label_created_at = $3,
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
                 provider_shipment_id = $2,
                 carrier_label_id = 'label-' || id::text, label_created_at = $3,
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

  it("cancels quoted checkout without fabricating Shipments", async () => {
    await rollback("pre-shipment-cancellation", async (client, fixtures) => {
      const createWithoutShipments = (name: string, slotCount = 1) =>
        fixtures.createFoundation(
          name,
          {},
          undefined,
          undefined,
          undefined,
          slotCount,
          undefined,
          "QUOTED",
          undefined,
          {},
          "AUTOMATIC",
          true,
          true,
          false,
        );

      const uninstantiated = await createWithoutShipments("no-shipment");
      const existingAllocation = (
        await client.query<{
          fulfilment_slot_id: string;
          order_price_binding_id: string;
          shipment_plan_id: string;
        }>(
          `SELECT shipment_plan_id, order_price_binding_id, fulfilment_slot_id
           FROM shipment_plan_fulfilment_slots
           WHERE shipment_plan_id = $1`,
          [uninstantiated.shipmentPlanId],
        )
      ).rows[0];
      if (!existingAllocation) {
        throw new Error("quoted ShipmentPlan allocation fixture is missing");
      }
      await expectQueryError(
        client,
        "reinsert_allocation_after_draft",
        async () => {
          await client.query(`SET LOCAL session_replication_role = 'replica'`);
          await client.query(
            `DELETE FROM shipment_plan_fulfilment_slots
             WHERE shipment_plan_id = $1 AND fulfilment_slot_id = $2`,
            [
              existingAllocation.shipment_plan_id,
              existingAllocation.fulfilment_slot_id,
            ],
          );
          await client.query(`SET LOCAL session_replication_role = 'origin'`);
          await client.query(
            `INSERT INTO shipment_plan_fulfilment_slots
               (shipment_plan_id, order_price_binding_id, fulfilment_slot_id)
             VALUES ($1,$2,$3)`,
            [
              existingAllocation.shipment_plan_id,
              existingAllocation.order_price_binding_id,
              existingAllocation.fulfilment_slot_id,
            ],
          );
        },
        {
          code: "23514",
          constraint: "shipment_plan_slot_order_status_guard",
        },
      );
      await createCurrentPlanAndPayment(client, fixtures, uninstantiated);
      await cancelOrderBeforeHandoff(client, uninstantiated.orderId);

      expect(
        (
          await client.query<{
            order_status: string;
            payment_status: string;
            phase_status: string;
            shipment_count: string;
            slot_outcome: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                    phase.status::text AS phase_status,
                    slot.outcome::text AS slot_outcome,
                    payment.status::text AS payment_status,
                    (SELECT count(*)::text
                     FROM shipments shipment
                     WHERE shipment.order_id = target_order.id) AS shipment_count
             FROM orders target_order
             JOIN order_phases phase ON phase.order_id = target_order.id
             JOIN fulfilment_slots slot ON slot.order_id = target_order.id
             JOIN payments payment ON payment.order_id = target_order.id
             WHERE target_order.id = $1`,
            [uninstantiated.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "CANCELLED",
          phase_status: "CANCELLED",
          slot_outcome: "CANCELLED",
          payment_status: "VOIDED",
          shipment_count: "0",
        },
      ]);

      const mixed = await createWithoutShipments("mixed-plans", 2);
      const instantiatedPlanId = mixed.shipmentPlanIds[0];
      const uninstantiatedPlanId = mixed.shipmentPlanIds[1];
      const instantiatedShipmentId = mixed.shipmentIds[0];
      if (
        !instantiatedPlanId ||
        !uninstantiatedPlanId ||
        !instantiatedShipmentId
      ) {
        throw new Error(
          "mixed pre-shipment cancellation fixture is incomplete",
        );
      }
      const shipmentCreatedAt = new Date();
      await client.query(
        `INSERT INTO shipments
           (id, order_id, order_phase_id, shipment_plan_id,
            delivery_destination_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [
          instantiatedShipmentId,
          mixed.orderId,
          mixed.orderPhaseId,
          instantiatedPlanId,
          mixed.deliveryDestinationId,
          shipmentCreatedAt,
        ],
      );
      await createCurrentPlanAndPayment(client, fixtures, mixed);

      await expectQueryError(
        client,
        "cancel_slot_from_instantiated_live_plan",
        async () => {
          await client.query(
            `UPDATE fulfilment_slots slot
             SET outcome = 'CANCELLED', updated_at = clock_timestamp()
             FROM shipment_plan_fulfilment_slots allocation
             WHERE allocation.fulfilment_slot_id = slot.id
               AND allocation.shipment_plan_id = $1`,
            [instantiatedPlanId],
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

      await client.query(`SAVEPOINT "cancel_uninstantiated_plan_slot"`);
      try {
        await client.query(
          `UPDATE fulfilment_slots slot
           SET outcome = 'CANCELLED', updated_at = clock_timestamp()
           FROM shipment_plan_fulfilment_slots allocation
           WHERE allocation.fulfilment_slot_id = slot.id
             AND allocation.shipment_plan_id = $1`,
          [uninstantiatedPlanId],
        );
        await client.query(
          `SET CONSTRAINTS
             "fulfilment_slots_shipment_plan_terminal_reconciled" IMMEDIATE`,
        );
      } finally {
        await client.query(
          `ROLLBACK TO SAVEPOINT "cancel_uninstantiated_plan_slot"`,
        );
        await client.query(
          `RELEASE SAVEPOINT "cancel_uninstantiated_plan_slot"`,
        );
        await client.query(
          `SET CONSTRAINTS
             "fulfilment_slots_shipment_plan_terminal_reconciled" DEFERRED`,
        );
      }

      await cancelOrderBeforeHandoff(client, mixed.orderId);
      expect(
        (
          await client.query<{
            cancelled_slot_count: string;
            shipment_status: string;
          }>(
            `SELECT shipment.status::text AS shipment_status,
                    count(*) FILTER (WHERE slot.outcome = 'CANCELLED')::text
                      AS cancelled_slot_count
             FROM shipments shipment
             JOIN orders target_order ON target_order.id = shipment.order_id
             JOIN fulfilment_slots slot ON slot.order_id = target_order.id
             WHERE target_order.id = $1
             GROUP BY shipment.id`,
            [mixed.orderId],
          )
        ).rows,
      ).toEqual([
        {
          shipment_status: "CANCELLED",
          cancelled_slot_count: "2",
        },
      ]);
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
        "void_pending_payment_without_order_closure",
        async () => {
          await client.query(
            `UPDATE payments
             SET status = 'VOIDED', capture_authorized = false,
                 capture_cutoff_at = $2, updated_at = $2
             WHERE id = $1`,
            [foundation.paymentId, new Date()],
          );
          await client.query(
            `SET CONSTRAINTS "payments_quoted_void_closure_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "quoted_payment_void_closure_check",
        },
      );

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

      expect(
        (
          await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM outbox_messages
             WHERE aggregate_type = 'Payment'
               AND aggregate_id = $1
               AND message_type = 'void_payment'`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([{ count: "0" }]);

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
      expect(
        (
          await client.query<{
            aggregate_id: string;
            aggregate_type: string;
            attempts: number;
            available_at: Date;
            deduplication_key: string;
            message_type: string;
            payload: Record<string, string>;
            schema_version: number;
            status: string;
          }>(
            `SELECT deduplication_key, aggregate_type, aggregate_id,
                    message_type, schema_version, payload, status::text,
                    attempts, available_at
             FROM outbox_messages
             WHERE aggregate_type = 'Payment'
               AND aggregate_id = $1
               AND message_type = 'void_payment'`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          deduplication_key: `void_payment:v1:${foundation.paymentId}`,
          aggregate_type: "Payment",
          aggregate_id: foundation.paymentId,
          message_type: "void_payment",
          schema_version: 1,
          payload: {
            action: "void_payment",
            paymentId: foundation.paymentId,
            provider: "test",
            providerIntentId: expect.stringMatching(/^intent-/),
          },
          status: "PENDING",
          attempts: 0,
          available_at: expect.any(Date),
        },
      ]);

      await fixtures.persistPaymentFailureEvent(
        foundation.paymentId,
        new Date(),
        "delayed-void-payment-failure",
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            failure_event_count: string;
            status: string;
            void_outbox_count: string;
          }>(
            `SELECT payment.status::text,
                    count(DISTINCT event.id)::text AS failure_event_count,
                    count(DISTINCT message.id)::text AS void_outbox_count
             FROM payments payment
             LEFT JOIN payment_provider_events event
               ON event.payment_id = payment.id
              AND event.provider_event_id = 'delayed-void-payment-failure'
             LEFT JOIN outbox_messages message
               ON message.aggregate_type = 'Payment'
              AND message.aggregate_id = payment.id
              AND message.message_type = 'void_payment'
             WHERE payment.id = $1
             GROUP BY payment.status`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "VOIDED",
          failure_event_count: "1",
          void_outbox_count: "1",
        },
      ]);
    });
  });

  it("expires a quoted order only after closing its checkout window and fulfilment graph", async () => {
    await rollback("quoted-order-expiry", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("quoted-order-expiry");
      await createCurrentPlan(client, fixtures, foundation);
      const noPayment = await fixtures.createFoundation(
        "quoted-session-expiry-without-payment",
      );
      const failedPayment = await fixtures.createFoundation(
        "quoted-session-expiry-after-failed-payment",
      );
      await createCurrentPlanAndPayment(client, fixtures, failedPayment);
      const failedAt = new Date();
      await fixtures.persistPaymentFailureEvent(
        failedPayment.paymentId,
        failedAt,
      );
      await client.query(
        `UPDATE payments
         SET status = 'FAILED', capture_authorized = false,
             capture_cutoff_at = $2, updated_at = $2
         WHERE id = $1`,
        [failedPayment.paymentId, failedAt],
      );
      const individualNoPayment = await fixtures.createFoundation(
        "individual-expiry-without-payment",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "QUOTED",
        undefined,
        {},
        "INDIVIDUAL",
      );
      const checkoutExpiresAt = (
        await client.query<{ checkout_expires_at: Date }>(
          `SELECT clock_timestamp() + interval '2 seconds' AS checkout_expires_at`,
        )
      ).rows[0]?.checkout_expires_at;
      if (!checkoutExpiresAt) {
        throw new Error("database checkout deadline is missing");
      }
      await fixtures.finalizePayment(foundation, checkoutExpiresAt);
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE quote_sessions
         SET expires_at = $1
         WHERE id = ANY($2::uuid[])`,
        [
          checkoutExpiresAt,
          [
            foundation.quoteSessionId,
            noPayment.quoteSessionId,
            failedPayment.quoteSessionId,
          ],
        ],
      );
      await client.query(`SET LOCAL session_replication_role = 'origin'`);

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
      await expectQueryError(
        client,
        "expire_without_payment_before_session_deadline",
        () =>
          cancelOrderBeforeHandoff(
            client,
            noPayment.orderId,
            true,
            true,
            "EXPIRED",
          ),
        {
          code: "23514",
          constraint: "quoted_order_expiry_deadline_check",
        },
      );
      await expectQueryError(
        client,
        "expire_failed_payment_before_session_deadline",
        () =>
          cancelOrderBeforeHandoff(
            client,
            failedPayment.orderId,
            true,
            true,
            "EXPIRED",
          ),
        {
          code: "23514",
          constraint: "quoted_order_expiry_deadline_check",
        },
      );

      await client.query(
        `SELECT pg_sleep(
           greatest(extract(epoch FROM $1::timestamptz - clock_timestamp()), 0)
           + 0.05
         )`,
        [checkoutExpiresAt],
      );

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
      await cancelOrderBeforeHandoff(
        client,
        noPayment.orderId,
        true,
        true,
        "EXPIRED",
      );
      await cancelOrderBeforeHandoff(
        client,
        failedPayment.orderId,
        true,
        true,
        "EXPIRED",
      );
      await expectQueryError(
        client,
        "expire_individual_without_payment",
        () =>
          cancelOrderBeforeHandoff(
            client,
            individualNoPayment.orderId,
            true,
            true,
            "EXPIRED",
          ),
        {
          code: "23514",
          constraint: "quoted_order_expiry_deadline_check",
        },
      );

      expect(
        (
          await client.query<{
            expired_order_count: string;
            failed_payment_status: string;
            no_payment_count: string;
          }>(
            `SELECT
               (SELECT count(*)::text FROM orders
                WHERE id = ANY($1::uuid[]) AND status = 'EXPIRED')
                  AS expired_order_count,
               (SELECT count(*)::text FROM payments WHERE order_id = $2)
                  AS no_payment_count,
               (SELECT status::text FROM payments WHERE order_id = $3 LIMIT 1)
                  AS failed_payment_status`,
            [
              [foundation.orderId, noPayment.orderId, failedPayment.orderId],
              noPayment.orderId,
              failedPayment.orderId,
            ],
          )
        ).rows,
      ).toEqual([
        {
          expired_order_count: "3",
          failed_payment_status: "FAILED",
          no_payment_count: "0",
        },
      ]);

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

      const failedCaptureBeforeCutoff = new Date(failedAt.getTime() - 1);
      await expectQueryError(
        client,
        "capture_before_failed_payment_cutoff",
        async () => {
          await fixtures.persistPaymentProviderEvent(
            failedPayment.paymentId,
            "PAYMENT_CAPTURED",
            "failed-payment-capture-before-cutoff",
            failedCaptureBeforeCutoff,
          );
          await client.query(
            `UPDATE payments
             SET status = 'REFUND_PENDING',
                 captured_amount_minor = requested_amount_minor,
                 provider_capture_id = $2, captured_at = $3, updated_at = $3
             WHERE id = $1`,
            [
              failedPayment.paymentId,
              "failed-payment-capture-before-cutoff",
              failedCaptureBeforeCutoff,
            ],
          );
        },
        {
          code: "23514",
          constraint: "payment_failed_late_capture_check",
        },
      );

      const failedLateCapturedAt = (
        await client.query<{ captured_at: Date }>(
          `SELECT clock_timestamp() + interval '5 seconds' AS captured_at`,
        )
      ).rows[0]?.captured_at;
      if (!failedLateCapturedAt) {
        throw new Error("failed late-capture database anchor is unavailable");
      }
      const failedProviderCaptureId = "failed-payment-late-capture";
      await fixtures.persistPaymentProviderEvent(
        failedPayment.paymentId,
        "PAYMENT_CAPTURED",
        failedProviderCaptureId,
        failedLateCapturedAt,
      );
      await client.query(
        `UPDATE payments
         SET status = 'REFUND_PENDING',
             captured_amount_minor = requested_amount_minor,
             provider_capture_id = $2, captured_at = $3, updated_at = $3
         WHERE id = $1`,
        [
          failedPayment.paymentId,
          failedProviderCaptureId,
          failedLateCapturedAt,
        ],
      );
      await expectQueryError(
        client,
        "failed_late_capture_without_compensation",
        () =>
          client.query(
            `SET CONSTRAINTS "payments_refund_status_reconciled" IMMEDIATE`,
          ),
        {
          code: "23514",
          constraint: "payment_refund_status_reconciliation_check",
        },
      );
      await expectQueryError(
        client,
        "failed_late_refund_beyond_negative_skew",
        () =>
          client.query(
            `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                requested_at, created_at, updated_at)
             SELECT $1, id, $2, requested_amount_minor,
                    'LATE_CAPTURE_COMPENSATION', 'PENDING', $3, $3, $3
             FROM payments WHERE id = $4`,
            [
              fixtures.id("failed-late-refund-beyond-negative-skew"),
              "late_initial_capture:failed-late-refund-beyond-negative-skew",
              new Date(failedLateCapturedAt.getTime() - 5_001),
              failedPayment.paymentId,
            ],
          ),
        {
          code: "23514",
          constraint: "refund_capture_timestamp_order_check",
        },
      );
      const failedLateRefundId = fixtures.id("failed-late-capture-refund");
      const failedLateRefundRequestedAt = (
        await client.query<{ requested_at: Date }>(
          `INSERT INTO refund_transactions
             (id, payment_id, idempotency_key, amount_minor, reason, status,
              updated_at)
           SELECT $1, id, $2, requested_amount_minor,
                  'LATE_CAPTURE_COMPENSATION', 'PENDING', clock_timestamp()
           FROM payments WHERE id = $3
           RETURNING requested_at`,
          [
            failedLateRefundId,
            `late_initial_capture:${failedProviderCaptureId}`,
            failedPayment.paymentId,
          ],
        )
      ).rows[0]?.requested_at;
      if (!failedLateRefundRequestedAt) {
        throw new Error("failed late-capture refund evidence is unavailable");
      }
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            capture_event_count: string;
            capture_matches_refund: boolean;
            captured_at: Date;
            job_count: string;
            order_status: string;
            payment_status: string;
            phase_status: string;
            provider_capture_id: string;
            refund_requested_before_capture: boolean;
            refund_requested_within_skew: boolean;
            refund_status: string;
            reservation_status: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                    phase.status::text AS phase_status,
                    reservation_set.status::text AS reservation_status,
                    payment.status::text AS payment_status,
                    payment.provider_capture_id, payment.captured_at,
                    refund.status::text AS refund_status,
                    payment.captured_amount_minor = refund.amount_minor
                      AS capture_matches_refund,
                    refund.requested_at < payment.captured_at
                      AS refund_requested_before_capture,
                    refund.requested_at >=
                      payment.captured_at - interval '5 seconds'
                      AS refund_requested_within_skew,
                    (SELECT count(*)::text
                     FROM payment_provider_events event
                     WHERE event.payment_id = payment.id
                       AND event.kind = 'PAYMENT_CAPTURED'
                       AND event.provider_transaction_id = $3)
                      AS capture_event_count,
                    (SELECT count(*)::text FROM jobs
                     WHERE order_id = target_order.id) AS job_count
             FROM orders target_order
             JOIN order_phases phase ON phase.order_id = target_order.id
             JOIN phase_resource_plans resource_plan
               ON resource_plan.order_phase_id = phase.id
             JOIN phase_reservation_sets reservation_set
               ON reservation_set.phase_resource_plan_id = resource_plan.id
              AND reservation_set.node_id = resource_plan.node_id
             JOIN payments payment ON payment.order_id = target_order.id
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE target_order.id = $1 AND refund.id = $2`,
            [
              failedPayment.orderId,
              failedLateRefundId,
              failedProviderCaptureId,
            ],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "EXPIRED",
          phase_status: "CANCELLED",
          reservation_status: "RELEASED",
          payment_status: "REFUND_PENDING",
          provider_capture_id: failedProviderCaptureId,
          captured_at: failedLateCapturedAt,
          refund_status: "PENDING",
          capture_matches_refund: true,
          refund_requested_before_capture: true,
          refund_requested_within_skew: true,
          capture_event_count: "1",
          job_count: "0",
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

      const captureCutoffAt = (
        await client.query<{ capture_cutoff_at: Date }>(
          `SELECT capture_cutoff_at FROM payments WHERE id = $1`,
          [foundation.paymentId],
        )
      ).rows[0]?.capture_cutoff_at;
      expect(captureCutoffAt).toBeInstanceOf(Date);
      const lateCapturedAt = new Date(captureCutoffAt!.getTime() + 1);
      await expectQueryError(
        client,
        "partially_compensate_expired_late_capture",
        async () => {
          await fixtures.persistPaymentProviderEvent(
            foundation.paymentId,
            "PAYMENT_CAPTURED",
            "partial-expired-late-capture",
            lateCapturedAt,
          );
          await client.query(
            `UPDATE payments
             SET status = 'REFUND_PENDING',
                 captured_amount_minor = requested_amount_minor,
                 provider_capture_id = $2, captured_at = $3,
                 updated_at = $3
             WHERE id = $1`,
            [
              foundation.paymentId,
              "partial-expired-late-capture",
              lateCapturedAt,
            ],
          );
          await client.query(
            `INSERT INTO refund_transactions
             (id, payment_id, idempotency_key, amount_minor, reason, status,
              requested_at, created_at, updated_at)
             SELECT $1, id, $2, requested_amount_minor - 1,
                    'LATE_CAPTURE_COMPENSATION', 'PENDING', $3, $3, $3
             FROM payments WHERE id = $4`,
            [
              fixtures.id("partial-expired-late-capture-refund"),
              "late_initial_capture:partial-expired-late-capture",
              lateCapturedAt,
              foundation.paymentId,
            ],
          );
        },
        { code: "23514", constraint: "late_capture_compensation_check" },
      );

      const refundId = fixtures.id("expired-late-capture-refund");
      await fixtures.persistPaymentProviderEvent(
        foundation.paymentId,
        "PAYMENT_CAPTURED",
        "expired-late-capture",
        lateCapturedAt,
      );
      await client.query(
        `UPDATE payments
         SET status = 'REFUND_PENDING',
             captured_amount_minor = requested_amount_minor,
             provider_capture_id = $2, captured_at = $3,
             updated_at = $3
         WHERE id = $1`,
        [foundation.paymentId, "expired-late-capture", lateCapturedAt],
      );
      await client.query(
        `INSERT INTO refund_transactions
         (id, payment_id, idempotency_key, amount_minor, reason, status,
          requested_at, created_at, updated_at)
         SELECT $1, id, $2, requested_amount_minor,
                'LATE_CAPTURE_COMPENSATION', 'PENDING', $3, $3, $3
         FROM payments WHERE id = $4`,
        [
          refundId,
          "late_initial_capture:expired-late-capture",
          lateCapturedAt,
          foundation.paymentId,
        ],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );

      expect(
        (
          await client.query<{
            capture_matches_refund: boolean;
            job_count: string;
            order_status: string;
            payment_status: string;
            refund_reason: string;
            refund_status: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                    payment.status::text AS payment_status,
                    refund.status::text AS refund_status,
                    refund.reason::text AS refund_reason,
                    payment.captured_amount_minor = refund.amount_minor
                      AS capture_matches_refund,
                    (SELECT count(*)::text FROM jobs
                     WHERE order_id = target_order.id) AS job_count
             FROM orders target_order
             JOIN payments payment ON payment.order_id = target_order.id
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE target_order.id = $1 AND refund.id = $2`,
            [foundation.orderId, refundId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "EXPIRED",
          payment_status: "REFUND_PENDING",
          refund_status: "PENDING",
          refund_reason: "LATE_CAPTURE_COMPENSATION",
          capture_matches_refund: true,
          job_count: "0",
        },
      ]);

      const refundedAt = new Date();
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" DEFERRED`,
      );
      await fixtures.persistRefundProviderEvent(
        refundId,
        "REFUND_SUCCEEDED",
        "expired-late-capture-refund",
        refundedAt,
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_refund_id = $2,
             completed_at = $3, updated_at = $3
         WHERE id = $1`,
        [refundId, "expired-late-capture-refund", refundedAt],
      );
      await client.query(
        `UPDATE payments SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [foundation.paymentId, refundedAt],
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{
            order_status: string;
            payment_status: string;
            refund_status: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                    payment.status::text AS payment_status,
                    refund.status::text AS refund_status
             FROM orders target_order
             JOIN payments payment ON payment.order_id = target_order.id
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE target_order.id = $1 AND refund.id = $2`,
            [foundation.orderId, refundId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "EXPIRED",
          payment_status: "REFUNDED",
          refund_status: "SUCCEEDED",
        },
      ]);
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
         SET status = 'ACCEPTED', accepted_at = $2,
             payout_amount = 0, payout_currency = 'EUR', updated_at = $2
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
            const orphanRefundId = fixtures.id(
              "orphan-production-failure-refund",
            );
            const orphanProviderRefundId = "orphan-production-failure-refund";
            await client.query(
              `INSERT INTO refund_transactions
             (id, payment_id, idempotency_key, amount_minor, reason, status,
              requested_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,'PRODUCTION_FAILURE','PENDING',$5,$5,$5)`,
              [
                orphanRefundId,
                foundation.paymentId,
                "orphan-production-failure-refund",
                capturedAmount,
                failedAt,
              ],
            );
            await fixtures.persistRefundProviderEvent(
              orphanRefundId,
              "REFUND_FAILED",
              orphanProviderRefundId,
              failedAt,
            );
            await client.query(
              `UPDATE refund_transactions
               SET status = 'FAILED', provider_refund_id = $2, updated_at = $3
               WHERE id = $1`,
              [orphanRefundId, orphanProviderRefundId, failedAt],
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
        const failedProviderRefundId = "production-failure-refund-failed";
        await fixtures.persistRefundProviderEvent(
          refundId,
          "REFUND_FAILED",
          failedProviderRefundId,
          refundFailedAt,
        );
        await client.query(
          `UPDATE refund_transactions
           SET status = 'FAILED', provider_refund_id = $2,
               updated_at = $3 WHERE id = $1`,
          [refundId, failedProviderRefundId, refundFailedAt],
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
            const wrongRetryId = fixtures.id(
              "wrong-production-failure-refund-retry",
            );
            const wrongRetryProviderId =
              "wrong-production-failure-refund-retry";
            await client.query(
              `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                requested_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,'PRODUCTION_FAILURE','PENDING',$5,$5,$5)`,
              [
                wrongRetryId,
                foundation.paymentId,
                "wrong-production-failure-refund-retry",
                wrongRetryAmount,
                wrongRetryAt,
              ],
            );
            await fixtures.persistRefundProviderEvent(
              wrongRetryId,
              "REFUND_FAILED",
              wrongRetryProviderId,
              wrongRetryAt,
            );
            await client.query(
              `UPDATE refund_transactions
               SET status = 'FAILED', provider_refund_id = $2, updated_at = $3
               WHERE id = $1`,
              [wrongRetryId, wrongRetryProviderId, wrongRetryAt],
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
        await fixtures.persistRefundProviderEvent(
          retryRefundId,
          "REFUND_SUCCEEDED",
          "production-failure-refund-retry",
          refundedAt,
        );
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

  it("reconciles a late provider success for the same failed refund attempt", async () => {
    await rollback("late-refund-success", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("late-refund-success");
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(client, fixtures, foundation, productions);
      const capturedAmount = Number(
        (
          await client.query<{ captured_amount_minor: string }>(
            `SELECT captured_amount_minor::text
             FROM payments WHERE id = $1`,
            [foundation.paymentId],
          )
        ).rows[0]?.captured_amount_minor,
      );
      if (!Number.isSafeInteger(capturedAmount) || capturedAmount <= 0) {
        throw new Error("late refund success fixture has no captured amount");
      }
      const refundId = fixtures.id("late-refund-success-attempt");
      await cancelOrderBeforeHandoff(
        client,
        foundation.orderId,
        true,
        true,
        "CANCELLED",
        [
          {
            id: refundId,
            idempotencyKey: "late-refund-success-attempt",
            amountMinor: capturedAmount,
          },
        ],
      );
      const requestedAt = (
        await client.query<{ requested_at: Date }>(
          `SELECT requested_at FROM refund_transactions WHERE id = $1`,
          [refundId],
        )
      ).rows[0]?.requested_at;
      if (!requestedAt) {
        throw new Error("late refund success attempt was not persisted");
      }

      const providerRefundId = "late-refund-success-provider-attempt";
      const failedAt = new Date();
      await fixtures.persistRefundProviderEvent(
        refundId,
        "REFUND_FAILED",
        providerRefundId,
        failedAt,
        "late-refund-failure-receipt",
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'FAILED', provider_refund_id = $2, updated_at = $3
         WHERE id = $1`,
        [refundId, providerRefundId, failedAt],
      );
      await client.query(
        `UPDATE payments SET status = 'CAPTURED', updated_at = $2 WHERE id = $1`,
        [foundation.paymentId, failedAt],
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

      const successAt = new Date(Math.max(Date.now(), failedAt.getTime() + 1));
      await expectQueryError(
        client,
        "late_refund_success_wrong_provider_transaction",
        () =>
          fixtures.persistRefundProviderEvent(
            refundId,
            "REFUND_SUCCEEDED",
            "foreign-provider-refund-attempt",
            successAt,
            "late-refund-success-wrong-provider-transaction",
          ),
        {
          code: "23514",
          constraint: "payment_provider_event_scope_check",
        },
      );
      await expectQueryError(
        client,
        "late_refund_success_must_follow_failure",
        async () => {
          await fixtures.persistRefundProviderEvent(
            refundId,
            "REFUND_SUCCEEDED",
            providerRefundId,
            failedAt,
            "non-late-refund-success-receipt",
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', completed_at = $2, updated_at = $2
             WHERE id = $1`,
            [refundId, failedAt],
          );
        },
        {
          code: "23514",
          constraint: "refund_result_event_order_check",
        },
      );
      await expectQueryError(
        client,
        "late_refund_success_receipt_without_reconciliation",
        async () => {
          await fixtures.persistRefundProviderEvent(
            refundId,
            "REFUND_SUCCEEDED",
            providerRefundId,
            successAt,
            "orphaned-late-refund-success-receipt",
          );
          await client.query(
            `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_provider_event_consumption_check",
        },
      );
      await expectQueryError(
        client,
        "late_refund_success_without_receipt",
        () =>
          client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', completed_at = $2, updated_at = $2
             WHERE id = $1`,
            [refundId, successAt],
          ),
        {
          code: "23514",
          constraint: "refund_success_provider_receipt_check",
        },
      );
      await expectQueryError(
        client,
        "late_refund_success_rejects_overcommitted_independent_refund",
        async () => {
          const retryId = fixtures.id("late-refund-success-independent-refund");
          await client.query(
            `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                requested_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,'CUSTOMER_CANCELLATION','PENDING',$5,$5,$5)`,
            [
              retryId,
              foundation.paymentId,
              "late-refund-success-independent-refund",
              capturedAmount,
              successAt,
            ],
          );
          await client.query(
            `UPDATE payments
             SET status = 'REFUND_PENDING', updated_at = $2 WHERE id = $1`,
            [foundation.paymentId, successAt],
          );
          await fixtures.persistRefundProviderEvent(
            refundId,
            "REFUND_SUCCEEDED",
            providerRefundId,
            successAt,
            "late-refund-success-with-overcommitted-refund",
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', completed_at = $2, updated_at = $2
             WHERE id = $1`,
            [refundId, successAt],
          );
        },
        { code: "23514", constraint: "refund_captured_payment_check" },
      );

      await fixtures.persistRefundProviderEvent(
        refundId,
        "REFUND_SUCCEEDED",
        providerRefundId,
        successAt,
        "late-refund-success-receipt",
      );
      await client.query(
        `UPDATE payments
         SET status = 'REFUND_PENDING', updated_at = $2 WHERE id = $1`,
        [foundation.paymentId, successAt],
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', completed_at = $2, updated_at = $2
         WHERE id = $1`,
        [refundId, successAt],
      );
      await client.query(
        `UPDATE payments SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [foundation.paymentId, successAt],
      );
      await client.query(
        `UPDATE order_phases
         SET status = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, successAt],
      );
      await client.query(
        `UPDATE fulfilment_slots
         SET outcome = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, successAt],
      );
      await client.query(
        `UPDATE orders SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [foundation.orderId, successAt],
      );
      await forceOrderLifecycleConstraints(client);
      await client.query(
        `SET CONSTRAINTS
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "orders_refund_completion_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "orders_refund_completion_reconciled" DEFERRED`,
      );

      const replayedAt = new Date(successAt.getTime() + 1);
      await fixtures.persistRefundProviderEvent(
        refundId,
        "REFUND_SUCCEEDED",
        providerRefundId,
        replayedAt,
        "late-refund-success-replayed-receipt",
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );

      expect(
        (
          await client.query<{
            completed_at: Date;
            failed_receipts: string;
            payment_status: string;
            provider_refund_id: string;
            refund_count: string;
            refund_status: string;
            refunded_amount: string;
            requested_at: Date;
            success_receipts: string;
          }>(
            `SELECT payment.status::text AS payment_status,
                    refund.status::text AS refund_status,
                    refund.provider_refund_id, refund.requested_at,
                    refund.completed_at,
                    count(DISTINCT refund.id)::text AS refund_count,
                    sum(DISTINCT refund.amount_minor)::text AS refunded_amount,
                    count(DISTINCT event.id) FILTER (
                      WHERE event.kind = 'REFUND_FAILED'
                    )::text AS failed_receipts,
                    count(DISTINCT event.id) FILTER (
                      WHERE event.kind = 'REFUND_SUCCEEDED'
                    )::text AS success_receipts
             FROM payments payment
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             JOIN payment_provider_events event
               ON event.refund_transaction_id = refund.id
             WHERE payment.id = $1
             GROUP BY payment.id, payment.status, refund.id, refund.status,
                      refund.provider_refund_id, refund.requested_at,
                      refund.completed_at`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          payment_status: "REFUNDED",
          refund_status: "SUCCEEDED",
          provider_refund_id: providerRefundId,
          requested_at: requestedAt,
          completed_at: successAt,
          refund_count: "1",
          refunded_amount: capturedAmount.toString(),
          failed_receipts: "1",
          success_receipts: "2",
        },
      ]);
    });
  });

  it("retains failed customer-cancellation refund attempts for later retry", async () => {
    await rollback("cancel-refund-retry", async (client, fixtures) => {
      const captured = await fixtures.createFoundation("retry-captured");
      const capturedProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        captured,
      );
      await activateCurrentPlan(
        client,
        fixtures,
        captured,
        capturedProductions,
      );
      await cancelOrderBeforeHandoff(client, captured.orderId);

      const failedRefund = (
        await client.query<{ amount_minor: string; id: string }>(
          `SELECT refund.id, refund.amount_minor::text
             FROM refund_transactions refund
             WHERE refund.payment_id = $1
               AND refund.reason = 'CUSTOMER_CANCELLATION'
               AND refund.status = 'PENDING'`,
          [captured.paymentId],
        )
      ).rows[0];
      if (!failedRefund) {
        throw new Error("customer cancellation refund fixture is missing");
      }

      const failedAt = new Date();
      const failedProviderRefundId = "provider-cancellation-refund-failed";
      await fixtures.persistRefundProviderEvent(
        failedRefund.id,
        "REFUND_FAILED",
        failedProviderRefundId,
        failedAt,
      );
      await client.query(
        `UPDATE refund_transactions
           SET status = 'FAILED', provider_refund_id = $2, updated_at = $3
           WHERE id = $1`,
        [failedRefund.id, failedProviderRefundId, failedAt],
      );
      await client.query(
        `UPDATE payments
           SET status = 'CAPTURED', updated_at = $2
           WHERE id = $1`,
        [captured.paymentId, failedAt],
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
            order_status: string;
            payment_status: string;
            refund_status: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                      payment.status::text AS payment_status,
                      refund.status::text AS refund_status
               FROM orders target_order
               JOIN payments payment ON payment.order_id = target_order.id
               JOIN refund_transactions refund ON refund.payment_id = payment.id
               WHERE target_order.id = $1 AND refund.id = $2`,
            [captured.orderId, failedRefund.id],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "CANCELLED",
          payment_status: "CAPTURED",
          refund_status: "FAILED",
        },
      ]);

      const wrongRetryAmount = Number(failedRefund.amount_minor) - 1;
      if (wrongRetryAmount <= 0) {
        throw new Error("customer cancellation refund fixture is too small");
      }
      await expectQueryError(
        client,
        "latest_failed_customer_refund_must_cover_balance",
        async () => {
          const wrongRetryId = fixtures.id(
            "wrong-customer-cancellation-refund-retry",
          );
          const wrongRetryProviderId =
            "wrong-customer-cancellation-refund-retry";
          const wrongRetryAt = new Date();
          await client.query(
            `INSERT INTO refund_transactions
                 (id, payment_id, idempotency_key, amount_minor, reason, status,
                  requested_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,'CUSTOMER_CANCELLATION','PENDING',$5,$5,$5)`,
            [
              wrongRetryId,
              captured.paymentId,
              "wrong-customer-cancellation-refund-retry",
              wrongRetryAmount,
              wrongRetryAt,
            ],
          );
          await fixtures.persistRefundProviderEvent(
            wrongRetryId,
            "REFUND_FAILED",
            wrongRetryProviderId,
            wrongRetryAt,
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'FAILED', provider_refund_id = $2, updated_at = $3
             WHERE id = $1`,
            [wrongRetryId, wrongRetryProviderId, wrongRetryAt],
          );
          await forceOrderLifecycleConstraints(client);
        },
        {
          code: "23514",
          constraint: "order_customer_cancellation_refund_obligation_check",
        },
      );

      const retryRefundId = fixtures.id("customer-cancellation-refund-retry");
      await client.query(
        `INSERT INTO refund_transactions
             (id, payment_id, idempotency_key, amount_minor, reason, status,
              requested_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'CUSTOMER_CANCELLATION','PENDING',
                   clock_timestamp(),clock_timestamp(),clock_timestamp())`,
        [
          retryRefundId,
          captured.paymentId,
          "customer-cancellation-refund-retry",
          failedRefund.amount_minor,
        ],
      );
      await client.query(
        `UPDATE payments
           SET status = 'REFUND_PENDING', updated_at = clock_timestamp()
           WHERE id = $1`,
        [captured.paymentId],
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
            failed_count: string;
            payment_status: string;
            pending_count: string;
          }>(
            `SELECT payment.status::text AS payment_status,
                      count(*) FILTER (WHERE refund.status = 'FAILED')::text
                        AS failed_count,
                      count(*) FILTER (WHERE refund.status = 'PENDING')::text
                        AS pending_count
               FROM payments payment
               JOIN refund_transactions refund ON refund.payment_id = payment.id
               WHERE payment.id = $1
               GROUP BY payment.id`,
            [captured.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          payment_status: "REFUND_PENDING",
          failed_count: "1",
          pending_count: "1",
        },
      ]);

      const partial = await fixtures.createFoundation("retry-partial");
      const partialProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        partial,
      );
      await activateCurrentPlan(client, fixtures, partial, partialProductions);
      const partialCapture = Number(
        (
          await client.query<{ captured_amount_minor: string }>(
            `SELECT captured_amount_minor::text
               FROM payments WHERE id = $1`,
            [partial.paymentId],
          )
        ).rows[0]?.captured_amount_minor,
      );
      if (!Number.isSafeInteger(partialCapture) || partialCapture < 2) {
        throw new Error("partial cancellation refund fixture is too small");
      }
      const firstPartialAmount = Math.floor(partialCapture / 2);
      await cancelOrderBeforeHandoff(
        client,
        partial.orderId,
        true,
        true,
        "CANCELLED",
        [
          {
            id: fixtures.id("partial-cancellation-refund-first"),
            idempotencyKey: "partial-cancellation-refund-first",
            amountMinor: firstPartialAmount,
          },
          {
            id: fixtures.id("partial-cancellation-refund-second"),
            idempotencyKey: "partial-cancellation-refund-second",
            amountMinor: partialCapture - firstPartialAmount,
          },
        ],
      );
      const partialRefunds = (
        await client.query<{ amount_minor: string; id: string }>(
          `SELECT refund.id, refund.amount_minor::text
             FROM refund_transactions refund
             WHERE refund.payment_id = $1
               AND refund.reason = 'CUSTOMER_CANCELLATION'
             ORDER BY refund.requested_at DESC,
                      refund.created_at DESC,
                      refund.id DESC`,
          [partial.paymentId],
        )
      ).rows;
      const latestPartialRefund = partialRefunds[0];
      const succeededPartialRefund = partialRefunds[1];
      if (!latestPartialRefund || !succeededPartialRefund) {
        throw new Error("split cancellation refund fixture is incomplete");
      }
      const partialRefundedAt = new Date();
      await fixtures.persistRefundProviderEvent(
        succeededPartialRefund.id,
        "REFUND_SUCCEEDED",
        "provider-partial-cancellation-refund",
        partialRefundedAt,
      );
      await client.query(
        `UPDATE refund_transactions
           SET status = 'SUCCEEDED', provider_refund_id = $2,
               completed_at = $3, updated_at = $3
           WHERE id = $1`,
        [
          succeededPartialRefund.id,
          "provider-partial-cancellation-refund",
          partialRefundedAt,
        ],
      );
      const partialFailureAt = new Date();
      const partialFailedProviderRefundId =
        "provider-partial-cancellation-refund-failed";
      await fixtures.persistRefundProviderEvent(
        latestPartialRefund.id,
        "REFUND_FAILED",
        partialFailedProviderRefundId,
        partialFailureAt,
      );
      await client.query(
        `UPDATE refund_transactions
           SET status = 'FAILED', provider_refund_id = $2, updated_at = $3
           WHERE id = $1`,
        [
          latestPartialRefund.id,
          partialFailedProviderRefundId,
          partialFailureAt,
        ],
      );
      await client.query(
        `UPDATE payments
           SET status = 'PARTIALLY_REFUNDED', updated_at = clock_timestamp()
           WHERE id = $1`,
        [partial.paymentId],
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
            failed_amount: string;
            order_status: string;
            payment_status: string;
            succeeded_amount: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                      payment.status::text AS payment_status,
                      sum(refund.amount_minor) FILTER (
                        WHERE refund.status = 'SUCCEEDED'
                      )::text AS succeeded_amount,
                      sum(refund.amount_minor) FILTER (
                        WHERE refund.status = 'FAILED'
                      )::text AS failed_amount
               FROM orders target_order
               JOIN payments payment ON payment.order_id = target_order.id
               JOIN refund_transactions refund ON refund.payment_id = payment.id
               WHERE target_order.id = $1
               GROUP BY target_order.id, payment.id`,
            [partial.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "CANCELLED",
          payment_status: "PARTIALLY_REFUNDED",
          succeeded_amount: succeededPartialRefund.amount_minor,
          failed_amount: latestPartialRefund.amount_minor,
        },
      ]);
    });
  });

  it("allows a payment schedule retry only after a failed attempt", async () => {
    await rollback("payment-schedule-retry", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "payment-schedule-retry",
      );
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );

      const insertRetry = async (id: string, providerIntentId: string) => {
        const retryCreatedAt = new Date();
        const retryExpiresAt = new Date(
          retryCreatedAt.getTime() + 60 * 60 * 1_000,
        );
        await client.query(
          `INSERT INTO payments
             (id, order_id, price_snapshot_id, order_price_binding_id,
              payment_schedule_id, role, provider,
              requested_amount_minor, currency, status,
              checkout_capture_expires_at, created_at, updated_at)
           SELECT $1, order_id, price_snapshot_id, order_price_binding_id,
                  payment_schedule_id, role, provider,
                  requested_amount_minor, currency, 'CREATED', $2, $3, $3
           FROM payments WHERE id = $4`,
          [id, retryExpiresAt, retryCreatedAt, foundation.paymentId],
        );
        return client.query(
          `UPDATE payments
           SET status = 'PENDING', provider_intent_id = $2, updated_at = $3
           WHERE id = $1`,
          [id, providerIntentId, retryCreatedAt],
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
          constraint: "payments_one_active_attempt_per_schedule_key",
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
      await fixtures.persistPaymentFailureEvent(foundation.paymentId, failedAt);
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

      const lateCapturedAt = (
        await client.query<{ captured_at: Date }>(
          `SELECT clock_timestamp() + interval '2 seconds' AS captured_at`,
        )
      ).rows[0]?.captured_at;
      if (!lateCapturedAt) {
        throw new Error("failed retry late-capture anchor is unavailable");
      }
      const lateProviderCaptureId = "failed-attempt-late-capture-with-retry";
      await fixtures.persistPaymentProviderEvent(
        foundation.paymentId,
        "PAYMENT_CAPTURED",
        lateProviderCaptureId,
        lateCapturedAt,
      );
      await client.query(
        `UPDATE payments
         SET status = 'REFUND_PENDING',
             captured_amount_minor = requested_amount_minor,
             provider_capture_id = $2, captured_at = $3, updated_at = $3
         WHERE id = $1`,
        [foundation.paymentId, lateProviderCaptureId, lateCapturedAt],
      );
      const lateRefundId = fixtures.id("failed-attempt-late-refund-with-retry");
      await client.query(
        `INSERT INTO refund_transactions
           (id, payment_id, idempotency_key, amount_minor, reason, status,
            requested_at, created_at, updated_at)
         SELECT $1, id, $2, requested_amount_minor,
                'LATE_CAPTURE_COMPENSATION', 'PENDING', $3, $3, $3
         FROM payments WHERE id = $4`,
        [
          lateRefundId,
          `late_initial_capture:${lateProviderCaptureId}`,
          lateCapturedAt,
          foundation.paymentId,
        ],
      );
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled" DEFERRED`,
      );

      expect(
        (
          await client.query<{
            active_attempt_count: string;
            job_count: string;
            original_status: string;
            order_status: string;
            phase_status: string;
            refund_status: string;
            reservation_status: string;
            retry_status: string;
          }>(
            `SELECT original.status::text AS original_status,
                    retry.status::text AS retry_status,
                    target_order.status::text AS order_status,
                    phase.status::text AS phase_status,
                    reservation_set.status::text AS reservation_status,
                    refund.status::text AS refund_status,
                    (SELECT count(*)::text FROM payments active
                     WHERE active.payment_schedule_id = original.payment_schedule_id
                       AND active.status IN ('CREATED', 'PENDING', 'CAPTURED'))
                      AS active_attempt_count,
                    (SELECT count(*)::text FROM jobs
                     WHERE order_id = target_order.id) AS job_count
             FROM payments original
             JOIN payments retry ON retry.id = $2
             JOIN orders target_order ON target_order.id = original.order_id
             JOIN order_phases phase ON phase.order_id = target_order.id
             JOIN phase_resource_plans resource_plan
               ON resource_plan.order_phase_id = phase.id
             JOIN phase_reservation_sets reservation_set
               ON reservation_set.phase_resource_plan_id = resource_plan.id
              AND reservation_set.node_id = resource_plan.node_id
             JOIN refund_transactions refund ON refund.id = $3
             WHERE original.id = $1`,
            [foundation.paymentId, retryPaymentId, lateRefundId],
          )
        ).rows,
      ).toEqual([
        {
          original_status: "REFUND_PENDING",
          retry_status: "PENDING",
          order_status: "QUOTED",
          phase_status: "QUOTED",
          reservation_status: "RESERVED",
          refund_status: "PENDING",
          active_attempt_count: "1",
          job_count: "0",
        },
      ]);

      await expectQueryError(
        client,
        "second_active_payment_after_failed_late_capture",
        () =>
          insertRetry(
            fixtures.id("second-active-payment-after-late-capture"),
            "second-active-provider-intent-after-late-capture",
          ),
        {
          code: "23505",
          constraint: "payments_one_active_attempt_per_schedule_key",
        },
      );

      const failedRefundAt = new Date();
      await expectQueryError(
        client,
        "failed_late_capture_refund_cannot_restore_capture",
        async () => {
          await fixtures.persistRefundProviderEvent(
            lateRefundId,
            "REFUND_FAILED",
            "failed-late-capture-provider-refund",
            failedRefundAt,
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'FAILED',
                 provider_refund_id = 'failed-late-capture-provider-refund',
                 updated_at = $2
             WHERE id = $1`,
            [lateRefundId, failedRefundAt],
          );
          await client.query(
            `UPDATE payments SET status = 'CAPTURED', updated_at = $2
             WHERE id = $1`,
            [foundation.paymentId, failedRefundAt],
          );
        },
        {
          code: "23514",
          constraint: "payment_failed_late_capture_refund_retry_check",
        },
      );

      await fixtures.persistRefundProviderEvent(
        lateRefundId,
        "REFUND_FAILED",
        "failed-late-capture-provider-refund",
        failedRefundAt,
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'FAILED',
             provider_refund_id = 'failed-late-capture-provider-refund',
             updated_at = $2
         WHERE id = $1`,
        [lateRefundId, failedRefundAt],
      );
      const replacementLateRefundId = fixtures.id(
        "failed-attempt-late-refund-replacement",
      );
      await client.query(
        `INSERT INTO refund_transactions
           (id, payment_id, idempotency_key, amount_minor, reason, status,
            requested_at, created_at, updated_at)
         SELECT $1, id, $2, requested_amount_minor,
                'LATE_CAPTURE_COMPENSATION', 'PENDING', $3, $3, $3
         FROM payments WHERE id = $4`,
        [
          replacementLateRefundId,
          `late_initial_capture:${lateProviderCaptureId}:retry:1`,
          failedRefundAt,
          foundation.paymentId,
        ],
      );
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            failed_refund_count: string;
            original_status: string;
            pending_refund_count: string;
            retry_status: string;
          }>(
            `SELECT original.status::text AS original_status,
                    retry.status::text AS retry_status,
                    count(refund.id) FILTER (
                      WHERE refund.status = 'FAILED'
                    )::text AS failed_refund_count,
                    count(refund.id) FILTER (
                      WHERE refund.status = 'PENDING'
                    )::text AS pending_refund_count
             FROM payments original
             JOIN payments retry ON retry.id = $2
             JOIN refund_transactions refund ON refund.payment_id = original.id
             WHERE original.id = $1
             GROUP BY original.status, retry.status`,
            [foundation.paymentId, retryPaymentId],
          )
        ).rows,
      ).toEqual([
        {
          original_status: "REFUND_PENDING",
          retry_status: "PENDING",
          failed_refund_count: "1",
          pending_refund_count: "1",
        },
      ]);

      await activateCurrentPlan(
        client,
        fixtures,
        { ...foundation, paymentId: retryPaymentId },
        productions,
        "retry-provider-capture-after-old-compensation",
      );
      expect(
        (
          await client.query<{
            job_count: string;
            original_status: string;
            order_status: string;
            pending_refund_count: string;
            phase_status: string;
            retry_status: string;
          }>(
            `SELECT original.status::text AS original_status,
                    retry.status::text AS retry_status,
                    target_order.status::text AS order_status,
                    phase.status::text AS phase_status,
                    (SELECT count(*)::text FROM refund_transactions refund
                     WHERE refund.payment_id = original.id
                       AND refund.status = 'PENDING') AS pending_refund_count,
                    (SELECT count(*)::text FROM jobs
                     WHERE order_id = target_order.id) AS job_count
             FROM payments original
             JOIN payments retry ON retry.id = $2
             JOIN orders target_order ON target_order.id = original.order_id
             JOIN order_phases phase ON phase.order_id = target_order.id
             WHERE original.id = $1`,
            [foundation.paymentId, retryPaymentId],
          )
        ).rows,
      ).toEqual([
        {
          original_status: "REFUND_PENDING",
          retry_status: "CAPTURED",
          order_status: "CONFIRMED",
          phase_status: "ACTIVE",
          pending_refund_count: "1",
          job_count: String(productions.length),
        },
      ]);
    });
  });

  it("requires a stable provider intent before a payment becomes pending", async () => {
    await rollback("payment-provider-intent", async (client, fixtures) => {
      const createdFoundation = await fixtures.createFoundation(
        "created-payment-without-intent",
      );
      await createCurrentPlan(client, fixtures, createdFoundation);
      const insertCreatedPayment = (providerIntentId: string | null) =>
        client.query<{ created_at: Date }>(
          `INSERT INTO payments
             (id, order_id, price_snapshot_id, order_price_binding_id,
              payment_schedule_id, role, provider, provider_intent_id,
              requested_amount_minor, currency, status,
              checkout_capture_expires_at, updated_at)
           SELECT $1,$2,$3,$4,$5,'FULL','test',$6,gross_amount_minor,
                  'EUR','CREATED',CURRENT_TIMESTAMP + interval '60 minutes',
                  CURRENT_TIMESTAMP
           FROM payment_schedules WHERE id = $5
           RETURNING created_at`,
          [
            createdFoundation.paymentId,
            createdFoundation.orderId,
            createdFoundation.priceSnapshotId,
            createdFoundation.orderPriceBindingId,
            createdFoundation.paymentScheduleId,
            providerIntentId,
          ],
        );
      await expectQueryError(
        client,
        "create_created_payment_with_provider_intent",
        () => insertCreatedPayment("stranded-created-provider-intent"),
        {
          code: "23514",
          constraint: "payments_provider_intent_identity_check",
        },
      );
      const persistedCreatedAt = (await insertCreatedPayment(null)).rows[0]
        ?.created_at;
      if (!persistedCreatedAt) {
        throw new Error("database-created Payment timestamp is unavailable");
      }
      await expectQueryError(
        client,
        "intent_failure_beyond_negative_skew",
        () =>
          fixtures.persistPaymentIntentCreationFailure(
            createdFoundation.paymentId,
            new Date(persistedCreatedAt.getTime() - 5_001),
            "excessive-negative-skew-intent-attempt",
          ),
        {
          code: "23514",
          constraint: "payment_intent_creation_failure_scope_check",
        },
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
      await expectQueryError(
        client,
        "void_created_payment_with_provider_intent",
        () =>
          client.query(
            `UPDATE payments
             SET status = 'VOIDED', provider_intent_id = $2,
                 capture_authorized = false, capture_cutoff_at = $3,
                 updated_at = $3
             WHERE id = $1`,
            [
              createdFoundation.paymentId,
              "stranded-created-void-intent",
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "payments_provider_intent_identity_check",
        },
      );
      await expectQueryError(
        client,
        "void_created_payment_without_order_closure",
        async () => {
          await client.query(
            `UPDATE payments
             SET status = 'VOIDED', capture_authorized = false,
                 capture_cutoff_at = $2, updated_at = $2
             WHERE id = $1`,
            [createdFoundation.paymentId, new Date()],
          );
          await client.query(
            `SET CONSTRAINTS "payments_quoted_void_closure_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "quoted_payment_void_closure_check",
        },
      );
      await expectQueryError(
        client,
        "fail_created_payment_with_open_authorization",
        () =>
          client.query(`UPDATE payments SET status = 'FAILED' WHERE id = $1`, [
            createdFoundation.paymentId,
          ]),
        { code: "23514", constraint: "payment_capture_window_check" },
      );
      const intentFailureAt = new Date(persistedCreatedAt.getTime() - 5_000);
      await expectQueryError(
        client,
        "fail_created_payment_without_attempt_evidence",
        () =>
          client.query(
            `UPDATE payments
             SET status = 'FAILED', capture_authorized = false,
                 capture_cutoff_at = $2, updated_at = clock_timestamp()
             WHERE id = $1`,
            [createdFoundation.paymentId, intentFailureAt],
          ),
        {
          code: "23514",
          constraint: "payment_intent_creation_failure_evidence_check",
        },
      );
      await expectQueryError(
        client,
        "leave_intent_failure_attempt_unconsumed",
        async () => {
          await fixtures.persistPaymentIntentCreationFailure(
            createdFoundation.paymentId,
            intentFailureAt,
            "unconsumed-intent-attempt",
          );
          await client.query(
            `SET CONSTRAINTS "payment_intent_creation_failures_consumed" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_intent_creation_failure_consumption_check",
        },
      );
      const intentFailureResultId =
        await fixtures.persistPaymentIntentCreationFailure(
          createdFoundation.paymentId,
          intentFailureAt,
          "created-payment-intent-attempt",
        );
      await expectQueryError(
        client,
        "fail_created_payment_with_foreign_attempt_result",
        () =>
          client.query(
            `UPDATE payments
             SET status = 'FAILED', capture_authorized = false,
                 capture_cutoff_at = $2,
                 intent_creation_failure_result_id = $3,
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [createdFoundation.paymentId, intentFailureAt, randomUUID()],
          ),
        {
          code: "23514",
          constraint: "payment_intent_creation_failure_evidence_check",
        },
      );
      await expectQueryError(
        client,
        "fail_created_payment_with_mismatched_attempt_time",
        () =>
          client.query(
            `UPDATE payments
             SET status = 'FAILED', capture_authorized = false,
                 capture_cutoff_at = $2,
                 intent_creation_failure_result_id = $3,
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [
              createdFoundation.paymentId,
              new Date(intentFailureAt.getTime() + 1),
              intentFailureResultId,
            ],
          ),
        {
          code: "23514",
          constraint: "payment_intent_creation_failure_evidence_check",
        },
      );
      await client.query(
        `UPDATE payments
         SET status = 'FAILED', capture_authorized = false,
             capture_cutoff_at = $2,
             intent_creation_failure_result_id = $3,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [createdFoundation.paymentId, intentFailureAt, intentFailureResultId],
      );
      await client.query(
        `SET CONSTRAINTS
           "payment_intent_creation_failures_consumed",
           "payments_intent_creation_failure_reconciled",
           "payments_intent_creation_failure_result_fkey",
           "payment_intent_creation_failures_payment_id_fkey"
         IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS
           "payment_intent_creation_failures_consumed",
           "payments_intent_creation_failure_reconciled",
           "payments_intent_creation_failure_result_fkey",
           "payment_intent_creation_failures_payment_id_fkey"
         DEFERRED`,
      );
      expect(
        (
          await client.query<{
            attempt_key: string;
            capture_authorized: boolean;
            capture_cutoff_at: Date;
            intent_creation_failure_result_id: string;
            outcome: string;
            provider_intent_id: string | null;
            status: string;
          }>(
            `SELECT payment.status::text, payment.provider_intent_id,
                    payment.capture_authorized, payment.capture_cutoff_at,
                    payment.intent_creation_failure_result_id,
                    failure.attempt_key, failure.outcome::text
             FROM payments payment
             JOIN payment_intent_creation_failures failure
               ON failure.id = payment.intent_creation_failure_result_id
              AND failure.payment_id = payment.id
              AND failure.provider = payment.provider
             WHERE payment.id = $1`,
            [createdFoundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          attempt_key: "created-payment-intent-attempt",
          status: "FAILED",
          provider_intent_id: null,
          capture_authorized: false,
          capture_cutoff_at: intentFailureAt,
          intent_creation_failure_result_id: intentFailureResultId,
          outcome: "FAILED",
        },
      ]);
      await expectQueryError(
        client,
        "mutate_intent_failure_evidence",
        () =>
          client.query(
            `UPDATE payment_intent_creation_failures
             SET attempt_key = 'rewritten-attempt'
             WHERE id = $1`,
            [intentFailureResultId],
          ),
        {
          code: "23514",
          constraint: "payment_intent_creation_failure_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "delete_intent_failure_evidence",
        () =>
          client.query(
            `DELETE FROM payment_intent_creation_failures WHERE id = $1`,
            [intentFailureResultId],
          ),
        {
          code: "23514",
          constraint: "payment_intent_creation_failure_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "assign_provider_intent_after_created_failure",
        () =>
          client.query(
            `UPDATE payments SET provider_intent_id = $2 WHERE id = $1`,
            [createdFoundation.paymentId, "late-provider-intent"],
          ),
        {
          code: "23514",
          constraint: "payments_provider_intent_identity_check",
        },
      );
      await expectQueryError(
        client,
        "capture_after_intent_creation_failure",
        () =>
          fixtures.persistPaymentProviderEvent(
            createdFoundation.paymentId,
            "PAYMENT_CAPTURED",
            "capture-without-issued-intent",
            new Date(),
          ),
        {
          code: "23514",
          constraint: "payment_provider_event_scope_check",
        },
      );

      const noIntentVoid = await fixtures.createFoundation(
        "created-payment-no-intent-void",
      );
      await createCurrentPlan(client, fixtures, noIntentVoid);
      const noIntentCreatedAt = new Date();
      await client.query(
        `INSERT INTO payments
           (id, order_id, price_snapshot_id, order_price_binding_id,
            payment_schedule_id, role, provider, requested_amount_minor,
            currency, status, checkout_capture_expires_at, created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,'FULL','test',gross_amount_minor,
                'EUR','CREATED',$6,$7,$7
         FROM payment_schedules WHERE id = $5`,
        [
          noIntentVoid.paymentId,
          noIntentVoid.orderId,
          noIntentVoid.priceSnapshotId,
          noIntentVoid.orderPriceBindingId,
          noIntentVoid.paymentScheduleId,
          new Date(noIntentCreatedAt.getTime() + 60 * 60 * 1_000),
          noIntentCreatedAt,
        ],
      );
      await cancelOrderBeforeHandoff(client, noIntentVoid.orderId);
      expect(
        (
          await client.query<{ outbox_count: string; status: string }>(
            `SELECT payment.status::text,
                    (SELECT count(*)::text FROM outbox_messages message
                     WHERE message.aggregate_type = 'Payment'
                       AND message.aggregate_id = payment.id
                       AND message.message_type = 'void_payment') AS outbox_count
             FROM payments payment WHERE payment.id = $1`,
            [noIntentVoid.paymentId],
          )
        ).rows,
      ).toEqual([{ status: "VOIDED", outbox_count: "0" }]);
      await expectQueryError(
        client,
        "failure_receipt_for_void_without_provider_intent",
        () =>
          fixtures.persistPaymentProviderEvent(
            noIntentVoid.paymentId,
            "PAYMENT_FAILED",
            "missing-provider-intent",
            new Date(),
            null,
            "failure-receipt-for-void-without-provider-intent",
          ),
        {
          code: "23514",
          constraint: "payment_provider_event_scope_check",
        },
      );

      const replacementPaymentId = fixtures.id(
        "created-payment-provider-retry",
      );
      const replacementCreatedAt = new Date();
      const replacementExpiresAt = new Date(
        replacementCreatedAt.getTime() + 60 * 60 * 1_000,
      );
      await client.query(
        `INSERT INTO payments
           (id, order_id, price_snapshot_id, order_price_binding_id,
            payment_schedule_id, role, provider,
            requested_amount_minor, currency, status, capture_authorized,
            capture_cutoff_at, checkout_capture_expires_at, created_at, updated_at)
         SELECT $1,order_id,price_snapshot_id,order_price_binding_id,
                payment_schedule_id,role,provider,requested_amount_minor,
                currency,'CREATED',true,NULL,$2,$3,$3
         FROM payments WHERE id = $4`,
        [
          replacementPaymentId,
          replacementExpiresAt,
          replacementCreatedAt,
          createdFoundation.paymentId,
        ],
      );
      await client.query(
        `UPDATE payments
         SET status = 'PENDING', provider_intent_id = $2, updated_at = $3
         WHERE id = $1`,
        [
          replacementPaymentId,
          "created-payment-provider-retry-intent",
          replacementCreatedAt,
        ],
      );
      expect(
        (
          await client.query<{ status: string }>(
            `SELECT status::text FROM payments WHERE id = $1`,
            [replacementPaymentId],
          )
        ).rows,
      ).toEqual([{ status: "PENDING" }]);

      const pendingFoundation = await fixtures.createFoundation(
        "pending-payment-provider-intent",
      );
      await createCurrentPlan(client, fixtures, pendingFoundation);
      const checkoutCaptureExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
      for (const [name, provider] of [
        ["empty_payment_provider", ""],
        ["blank_payment_provider", "   "],
        ["control_whitespace_payment_provider", "\t\n"],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            fixtures.finalizePayment(
              pendingFoundation,
              checkoutCaptureExpiresAt,
              `intent-${name}`,
              provider,
            ),
          {
            code: "23514",
            constraint: "payments_provider_identity_check",
          },
        );
      }
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

  it("requires immutable provider receipts before terminal payment outcomes", async () => {
    await rollback("payment-provider-receipts", async (client, fixtures) => {
      const captured = await fixtures.createFoundation(
        "receipt-backed-capture",
      );
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        captured,
      );
      await holdCurrentPlan(client, fixtures, captured, productions);
      await client.query(
        `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" DEFERRED`,
      );
      const activatedAt = new Date();
      await client.query(
        `UPDATE orders
         SET status = 'CONFIRMED', confirmed_at = $2, updated_at = $2
         WHERE id = $1`,
        [captured.orderId, activatedAt],
      );
      await client.query(
        `UPDATE order_phases
         SET status = 'ACTIVE', activated_at = $2, updated_at = $2
         WHERE id = $1`,
        [captured.orderPhaseId, activatedAt],
      );

      const capturedPayment = (
        await client.query<{
          created_at: Date;
          provider_intent_id: string;
          requested_amount_minor: string;
        }>(
          `SELECT created_at, provider_intent_id,
                  requested_amount_minor::text
           FROM payments WHERE id = $1`,
          [captured.paymentId],
        )
      ).rows[0];
      if (!capturedPayment?.provider_intent_id) {
        throw new Error(
          "receipt-backed Payment intent evidence is unavailable",
        );
      }
      const capturedAmount = Number(capturedPayment.requested_amount_minor);
      if (!Number.isSafeInteger(capturedAmount) || capturedAmount < 2) {
        throw new Error("receipt-backed Payment amount cannot be split");
      }
      const capturedAt = new Date(capturedPayment.created_at.getTime() - 5_000);
      const providerCaptureId = "receipt-backed-provider-capture";
      const capturePayment = () =>
        client.query(
          `UPDATE payments
           SET status = 'CAPTURED',
               captured_amount_minor = requested_amount_minor,
               provider_capture_id = $2, captured_at = $3, updated_at = $3
           WHERE id = $1`,
          [captured.paymentId, providerCaptureId, capturedAt],
        );
      await expectQueryError(
        client,
        "capture_without_provider_receipt",
        capturePayment,
        {
          code: "23514",
          constraint: "payment_capture_provider_receipt_check",
        },
      );
      await expectQueryError(
        client,
        "capture_with_mismatched_provider_receipt",
        async () => {
          await fixtures.persistPaymentProviderEvent(
            captured.paymentId,
            "PAYMENT_CAPTURED",
            "different-provider-capture",
            capturedAt,
          );
          await capturePayment();
        },
        {
          code: "23514",
          constraint: "payment_capture_provider_receipt_check",
        },
      );

      const providerEventId = "receipt-backed-capture-event";
      await fixtures.persistPaymentProviderEvent(
        captured.paymentId,
        "PAYMENT_CAPTURED",
        providerCaptureId,
        capturedAt,
        null,
        providerEventId,
      );
      await capturePayment();
      await forceCaptureActivationConstraints(client);
      expect(
        (
          await client.query<{
            kind: string;
            payload_matches_hash: boolean;
            provider_event_id: string;
            provider_transaction_id: string;
          }>(
            `SELECT kind::text, provider_event_id, provider_transaction_id,
                    payload_hash = encode(
                      sha256(convert_to(payload::text, 'UTF8')), 'hex'
                    ) AS payload_matches_hash
             FROM payment_provider_events
             WHERE payment_id = $1`,
            [captured.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          kind: "PAYMENT_CAPTURED",
          provider_event_id: providerEventId,
          provider_transaction_id: providerCaptureId,
          payload_matches_hash: true,
        },
      ]);

      const repeatedCaptureVerifiedAt = new Date(capturedAt.getTime() + 1);
      expect(repeatedCaptureVerifiedAt).not.toEqual(capturedAt);
      await fixtures.persistPaymentProviderEvent(
        captured.paymentId,
        "PAYMENT_CAPTURED",
        providerCaptureId,
        repeatedCaptureVerifiedAt,
        null,
        "receipt-backed-capture-event-repeat",
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            captured_at: Date;
            event_count: string;
          }>(
            `SELECT payment.captured_at,
                    count(event.id)::text AS event_count
             FROM payments payment
             JOIN payment_provider_events event
               ON event.payment_id = payment.id
              AND event.kind = 'PAYMENT_CAPTURED'
             WHERE payment.id = $1
             GROUP BY payment.captured_at`,
            [captured.paymentId],
          )
        ).rows,
      ).toEqual([{ captured_at: capturedAt, event_count: "2" }]);

      const paymentClockSkewAnchor = (
        await client.query<{ authenticated_at: Date }>(
          `SELECT clock_timestamp() - interval '1 second' AS authenticated_at`,
        )
      ).rows[0]?.authenticated_at;
      if (!paymentClockSkewAnchor) {
        throw new Error("payment provider clock-skew anchor is unavailable");
      }
      await expectQueryError(
        client,
        "payment_provider_occurrence_beyond_authentication_skew",
        () =>
          fixtures.persistPaymentProviderEvent(
            captured.paymentId,
            "PAYMENT_CAPTURED",
            providerCaptureId,
            paymentClockSkewAnchor,
            null,
            "payment-provider-occurrence-beyond-authentication-skew",
            new Date(paymentClockSkewAnchor.getTime() + 5_001),
          ),
        {
          code: "23514",
          constraint: "payment_provider_events_values_check",
        },
      );
      const paymentOccurrenceAtSkewBoundary = new Date(
        paymentClockSkewAnchor.getTime() + 5_000,
      );
      await fixtures.persistPaymentProviderEvent(
        captured.paymentId,
        "PAYMENT_CAPTURED",
        providerCaptureId,
        paymentClockSkewAnchor,
        null,
        "payment-provider-occurrence-at-authentication-skew-boundary",
        paymentOccurrenceAtSkewBoundary,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            authenticated_at: Date;
            captured_at: Date;
            occurred_at: Date;
            verified_at: Date;
          }>(
            `SELECT event.occurred_at, event.authenticated_at,
                    event.verified_at, payment.captured_at
             FROM payment_provider_events event
             JOIN payments payment ON payment.id = event.payment_id
             WHERE event.payment_id = $1
               AND event.provider_event_id =
                   'payment-provider-occurrence-at-authentication-skew-boundary'`,
            [captured.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          occurred_at: paymentOccurrenceAtSkewBoundary,
          authenticated_at: paymentClockSkewAnchor,
          verified_at: paymentClockSkewAnchor,
          captured_at: capturedAt,
        },
      ]);

      const delayedFailureAt = new Date();
      await expectQueryError(
        client,
        "delayed_capture_failure_wrong_intent",
        () =>
          fixtures.persistPaymentProviderEvent(
            captured.paymentId,
            "PAYMENT_FAILED",
            "wrong-delayed-failure-intent",
            delayedFailureAt,
            null,
            "wrong-delayed-capture-failure",
          ),
        {
          code: "23514",
          constraint: "payment_provider_event_scope_check",
        },
      );
      await fixtures.persistPaymentProviderEvent(
        captured.paymentId,
        "PAYMENT_FAILED",
        capturedPayment.provider_intent_id,
        delayedFailureAt,
        null,
        "delayed-capture-failure",
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            captured_at: Date;
            delayed_failure_count: string;
            provider_capture_id: string;
            status: string;
          }>(
            `SELECT payment.status::text, payment.provider_capture_id,
                    payment.captured_at,
                    count(event.id)::text AS delayed_failure_count
             FROM payments payment
             LEFT JOIN payment_provider_events event
               ON event.payment_id = payment.id
              AND event.kind = 'PAYMENT_FAILED'
              AND event.provider_event_id = 'delayed-capture-failure'
             WHERE payment.id = $1
             GROUP BY payment.status, payment.provider_capture_id,
                      payment.captured_at`,
            [captured.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "CAPTURED",
          provider_capture_id: providerCaptureId,
          captured_at: capturedAt,
          delayed_failure_count: "1",
        },
      ]);

      const firstDelayedFailureRefundId = fixtures.id(
        "delayed-failure-refund-first",
      );
      const secondDelayedFailureRefundId = fixtures.id(
        "delayed-failure-refund-second",
      );
      const firstDelayedFailureRefundAmount = Math.floor(capturedAmount / 2);
      const secondRefundRequestedAt = new Date();
      const firstRefundRequestedAt = new Date(
        secondRefundRequestedAt.getTime() - 1,
      );
      await cancelOrderBeforeHandoff(
        client,
        captured.orderId,
        true,
        true,
        "CANCELLED",
        [
          {
            id: firstDelayedFailureRefundId,
            idempotencyKey: "delayed-failure-refund-first",
            amountMinor: firstDelayedFailureRefundAmount,
            requestedAt: firstRefundRequestedAt,
          },
          {
            id: secondDelayedFailureRefundId,
            idempotencyKey: "delayed-failure-refund-second",
            amountMinor: capturedAmount - firstDelayedFailureRefundAmount,
            requestedAt: secondRefundRequestedAt,
          },
        ],
      );
      await fixtures.persistPaymentProviderEvent(
        captured.paymentId,
        "PAYMENT_FAILED",
        capturedPayment.provider_intent_id,
        new Date(),
        null,
        "delayed-refund-pending-failure",
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            captured_at: Date;
            delayed_failure_count: string;
            order_status: string;
            pending_refund_count: string;
            provider_capture_id: string;
            status: string;
          }>(
            `SELECT payment.status::text, payment.provider_capture_id,
                    payment.captured_at,
                    target_order.status::text AS order_status,
                    count(DISTINCT refund.id) FILTER (
                      WHERE refund.status = 'PENDING'
                    )::text AS pending_refund_count,
                    count(DISTINCT event.id)::text AS delayed_failure_count
             FROM payments payment
             JOIN orders target_order ON target_order.id = payment.order_id
             LEFT JOIN refund_transactions refund
               ON refund.payment_id = payment.id
             LEFT JOIN payment_provider_events event
               ON event.payment_id = payment.id
              AND event.kind = 'PAYMENT_FAILED'
              AND event.provider_event_id = 'delayed-refund-pending-failure'
             WHERE payment.id = $1
             GROUP BY payment.status, payment.provider_capture_id,
                      payment.captured_at, target_order.status`,
            [captured.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "REFUND_PENDING",
          provider_capture_id: providerCaptureId,
          captured_at: capturedAt,
          order_status: "CANCELLED",
          pending_refund_count: "2",
          delayed_failure_count: "1",
        },
      ]);

      const completeRefund = async (
        refundId: string,
        providerRefundId: string,
        completedAt: Date,
      ) => {
        await fixtures.persistRefundProviderEvent(
          refundId,
          "REFUND_SUCCEEDED",
          providerRefundId,
          completedAt,
        );
        await client.query(
          `UPDATE refund_transactions
           SET status = 'SUCCEEDED', provider_refund_id = $2,
               completed_at = $3, updated_at = $3
           WHERE id = $1`,
          [refundId, providerRefundId, completedAt],
        );
      };

      const firstRefundCompletedAt = new Date();
      await completeRefund(
        firstDelayedFailureRefundId,
        "delayed-failure-provider-refund-first",
        firstRefundCompletedAt,
      );
      await expectQueryError(
        client,
        "delayed_refund_failure_wrong_provider_transaction",
        () =>
          fixtures.persistRefundProviderEvent(
            firstDelayedFailureRefundId,
            "REFUND_FAILED",
            "wrong-delayed-failure-provider-refund",
            new Date(),
            "wrong-delayed-refund-failure",
          ),
        {
          code: "23514",
          constraint: "payment_provider_event_scope_check",
        },
      );
      const delayedRefundFailureAt = new Date(
        Math.max(Date.now(), firstRefundCompletedAt.getTime() + 1),
      );
      await fixtures.persistRefundProviderEvent(
        firstDelayedFailureRefundId,
        "REFUND_FAILED",
        "delayed-failure-provider-refund-first",
        delayedRefundFailureAt,
        "delayed-refund-failure-after-success",
        new Date(firstRefundCompletedAt.getTime() - 1),
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            completed_at: Date;
            delayed_failure_count: string;
            order_status: string;
            payment_status: string;
            pending_refund_count: string;
            provider_refund_id: string;
            status: string;
          }>(
            `SELECT refund.status::text, refund.provider_refund_id,
                    refund.completed_at,
                    payment.status::text AS payment_status,
                    target_order.status::text AS order_status,
                    (SELECT count(*)::text
                     FROM refund_transactions pending_refund
                     WHERE pending_refund.payment_id = payment.id
                       AND pending_refund.status = 'PENDING')
                      AS pending_refund_count,
                    count(event.id)::text AS delayed_failure_count
             FROM refund_transactions refund
             JOIN payments payment ON payment.id = refund.payment_id
             JOIN orders target_order ON target_order.id = payment.order_id
             LEFT JOIN payment_provider_events event
               ON event.refund_transaction_id = refund.id
              AND event.kind = 'REFUND_FAILED'
              AND event.provider_event_id =
                  'delayed-refund-failure-after-success'
             WHERE refund.id = $1
             GROUP BY refund.status, refund.provider_refund_id,
                      refund.completed_at, payment.id, payment.status,
                      target_order.status`,
            [firstDelayedFailureRefundId],
          )
        ).rows,
      ).toEqual([
        {
          status: "SUCCEEDED",
          provider_refund_id: "delayed-failure-provider-refund-first",
          completed_at: firstRefundCompletedAt,
          delayed_failure_count: "1",
          payment_status: "REFUND_PENDING",
          order_status: "CANCELLED",
          pending_refund_count: "1",
        },
      ]);
      const secondRefundFailedAt = new Date();
      await fixtures.persistRefundProviderEvent(
        secondDelayedFailureRefundId,
        "REFUND_FAILED",
        "delayed-failure-provider-refund-second-failed",
        secondRefundFailedAt,
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'FAILED', provider_refund_id = $2, updated_at = $3
         WHERE id = $1`,
        [
          secondDelayedFailureRefundId,
          "delayed-failure-provider-refund-second-failed",
          secondRefundFailedAt,
        ],
      );
      await client.query(
        `UPDATE payments
         SET status = 'PARTIALLY_REFUNDED', updated_at = $2
         WHERE id = $1`,
        [captured.paymentId, firstRefundCompletedAt],
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
      await fixtures.persistPaymentProviderEvent(
        captured.paymentId,
        "PAYMENT_FAILED",
        capturedPayment.provider_intent_id,
        new Date(),
        null,
        "delayed-partial-refund-failure",
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            captured_at: Date;
            delayed_failure_count: string;
            failed_refund_count: string;
            order_status: string;
            pending_refund_count: string;
            provider_capture_id: string;
            status: string;
            succeeded_refund_count: string;
          }>(
            `SELECT payment.status::text, payment.provider_capture_id,
                    payment.captured_at,
                    target_order.status::text AS order_status,
                    count(DISTINCT refund.id) FILTER (
                      WHERE refund.status = 'PENDING'
                    )::text AS pending_refund_count,
                    count(DISTINCT refund.id) FILTER (
                      WHERE refund.status = 'SUCCEEDED'
                    )::text AS succeeded_refund_count,
                    count(DISTINCT refund.id) FILTER (
                      WHERE refund.status = 'FAILED'
                    )::text AS failed_refund_count,
                    count(DISTINCT event.id)::text AS delayed_failure_count
             FROM payments payment
             JOIN orders target_order ON target_order.id = payment.order_id
             LEFT JOIN refund_transactions refund
               ON refund.payment_id = payment.id
             LEFT JOIN payment_provider_events event
               ON event.payment_id = payment.id
              AND event.kind = 'PAYMENT_FAILED'
              AND event.provider_event_id = 'delayed-partial-refund-failure'
             WHERE payment.id = $1
             GROUP BY payment.status, payment.provider_capture_id,
                      payment.captured_at, target_order.status`,
            [captured.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "PARTIALLY_REFUNDED",
          provider_capture_id: providerCaptureId,
          captured_at: capturedAt,
          order_status: "CANCELLED",
          pending_refund_count: "0",
          succeeded_refund_count: "1",
          failed_refund_count: "1",
          delayed_failure_count: "1",
        },
      ]);

      const retryDelayedFailureRefundId = fixtures.id(
        "delayed-failure-refund-retry",
      );
      const retryRefundRequestedAt = new Date();
      await client.query(
        `INSERT INTO refund_transactions
           (id, payment_id, idempotency_key, amount_minor, reason, status,
            requested_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'CUSTOMER_CANCELLATION','PENDING',$5,$5,$5)`,
        [
          retryDelayedFailureRefundId,
          captured.paymentId,
          "delayed-failure-refund-retry",
          capturedAmount - firstDelayedFailureRefundAmount,
          retryRefundRequestedAt,
        ],
      );
      await client.query(
        `UPDATE payments SET status = 'REFUND_PENDING', updated_at = $2
         WHERE id = $1`,
        [captured.paymentId, retryRefundRequestedAt],
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

      const secondRefundCompletedAt = new Date();
      await completeRefund(
        retryDelayedFailureRefundId,
        "delayed-failure-provider-refund-retry",
        secondRefundCompletedAt,
      );
      await client.query(
        `UPDATE payments SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [captured.paymentId, secondRefundCompletedAt],
      );
      await client.query(
        `UPDATE order_phases
         SET status = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [captured.orderId, secondRefundCompletedAt],
      );
      await client.query(
        `UPDATE fulfilment_slots
         SET outcome = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [captured.orderId, secondRefundCompletedAt],
      );
      await client.query(
        `UPDATE orders SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [captured.orderId, secondRefundCompletedAt],
      );
      await forceOrderLifecycleConstraints(client);
      await client.query(
        `SET CONSTRAINTS
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "orders_refund_completion_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "orders_refund_completion_reconciled" DEFERRED`,
      );
      await fixtures.persistPaymentProviderEvent(
        captured.paymentId,
        "PAYMENT_FAILED",
        capturedPayment.provider_intent_id,
        new Date(),
        null,
        "delayed-complete-refund-failure",
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            captured_at: Date;
            delayed_failure_count: string;
            order_status: string;
            pending_refund_count: string;
            provider_capture_id: string;
            status: string;
            succeeded_refund_count: string;
          }>(
            `SELECT payment.status::text, payment.provider_capture_id,
                    payment.captured_at,
                    target_order.status::text AS order_status,
                    count(DISTINCT refund.id) FILTER (
                      WHERE refund.status = 'PENDING'
                    )::text AS pending_refund_count,
                    count(DISTINCT refund.id) FILTER (
                      WHERE refund.status = 'SUCCEEDED'
                    )::text AS succeeded_refund_count,
                    count(DISTINCT event.id)::text AS delayed_failure_count
             FROM payments payment
             JOIN orders target_order ON target_order.id = payment.order_id
             LEFT JOIN refund_transactions refund
               ON refund.payment_id = payment.id
             LEFT JOIN payment_provider_events event
               ON event.payment_id = payment.id
              AND event.kind = 'PAYMENT_FAILED'
              AND event.provider_event_id = 'delayed-complete-refund-failure'
             WHERE payment.id = $1
             GROUP BY payment.status, payment.provider_capture_id,
                      payment.captured_at, target_order.status`,
            [captured.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "REFUNDED",
          provider_capture_id: providerCaptureId,
          captured_at: capturedAt,
          order_status: "REFUNDED",
          pending_refund_count: "0",
          succeeded_refund_count: "2",
          delayed_failure_count: "1",
        },
      ]);

      const replayedSuccessOccurredAt = new Date(
        firstRefundCompletedAt.getTime() + 2,
      );
      const replayedSuccessVerifiedAt = new Date(
        Math.max(Date.now(), replayedSuccessOccurredAt.getTime()),
      );
      await fixtures.persistRefundProviderEvent(
        firstDelayedFailureRefundId,
        "REFUND_SUCCEEDED",
        "delayed-failure-provider-refund-first",
        replayedSuccessVerifiedAt,
        "newer-same-outcome-refund-success-replay",
        replayedSuccessOccurredAt,
      );
      await fixtures.persistRefundProviderEvent(
        firstDelayedFailureRefundId,
        "REFUND_FAILED",
        "delayed-failure-provider-refund-first",
        new Date(replayedSuccessVerifiedAt.getTime() + 1),
        "intermediate-refund-failure-after-success-replay",
        new Date(firstRefundCompletedAt.getTime() + 1),
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );

      const refundFailureReconciledAt = new Date(
        Math.max(Date.now(), firstRefundCompletedAt.getTime() + 4),
      );
      const refundFailureProviderEventId = "newer-refund-failure-after-success";
      await fixtures.persistRefundProviderEvent(
        firstDelayedFailureRefundId,
        "REFUND_FAILED",
        "delayed-failure-provider-refund-first",
        refundFailureReconciledAt,
        refundFailureProviderEventId,
        refundFailureReconciledAt,
      );
      const refundFailureResultEventId = fixtures.id(
        `provider-event:${refundFailureProviderEventId}`,
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'FAILED', provider_result_event_id = $2,
             completed_at = NULL, updated_at = $3
         WHERE id = $1`,
        [
          firstDelayedFailureRefundId,
          refundFailureResultEventId,
          refundFailureReconciledAt,
        ],
      );
      await client.query(
        `UPDATE payments
         SET status = 'PARTIALLY_REFUNDED', updated_at = $2
         WHERE id = $1`,
        [captured.paymentId, refundFailureReconciledAt],
      );
      await client.query(
        `UPDATE order_phases
         SET status = 'CANCELLED', updated_at = $2
         WHERE order_id = $1`,
        [captured.orderId, refundFailureReconciledAt],
      );
      await client.query(
        `UPDATE fulfilment_slots
         SET outcome = 'CANCELLED', updated_at = $2
         WHERE order_id = $1`,
        [captured.orderId, refundFailureReconciledAt],
      );
      await client.query(
        `UPDATE orders SET status = 'CANCELLED', updated_at = $2 WHERE id = $1`,
        [captured.orderId, refundFailureReconciledAt],
      );
      await forceOrderLifecycleConstraints(client);
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "payments_refunded_order_reconciled",
           "refund_transactions_refunded_order_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "payments_refunded_order_reconciled",
           "refund_transactions_refunded_order_reconciled" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            completed_at: Date | null;
            order_status: string;
            payment_status: string;
            provider_result_event_id: string;
            refund_status: string;
          }>(
            `SELECT refund.status::text AS refund_status,
                    refund.completed_at, refund.provider_result_event_id,
                    payment.status::text AS payment_status,
                    target_order.status::text AS order_status
             FROM refund_transactions refund
             JOIN payments payment ON payment.id = refund.payment_id
             JOIN orders target_order ON target_order.id = payment.order_id
             WHERE refund.id = $1`,
            [firstDelayedFailureRefundId],
          )
        ).rows,
      ).toEqual([
        {
          refund_status: "FAILED",
          completed_at: null,
          provider_result_event_id: refundFailureResultEventId,
          payment_status: "PARTIALLY_REFUNDED",
          order_status: "CANCELLED",
        },
      ]);

      await fixtures.persistRefundProviderEvent(
        firstDelayedFailureRefundId,
        "REFUND_SUCCEEDED",
        "delayed-failure-provider-refund-first",
        new Date(refundFailureReconciledAt.getTime() + 1),
        "older-refund-success-after-failure",
        new Date(refundFailureReconciledAt.getTime() - 1),
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      await fixtures.persistRefundProviderEvent(
        firstDelayedFailureRefundId,
        "REFUND_SUCCEEDED",
        "delayed-failure-provider-refund-first",
        new Date(refundFailureReconciledAt.getTime() + 2),
        "equal-refund-success-after-failure",
        refundFailureReconciledAt,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            equal_receipt_count: string;
            payment_status: string;
            provider_result_event_id: string;
            refund_status: string;
          }>(
            `SELECT refund.status::text AS refund_status,
                    refund.provider_result_event_id,
                    payment.status::text AS payment_status,
                    count(event.id)::text AS equal_receipt_count
             FROM refund_transactions refund
             JOIN payments payment ON payment.id = refund.payment_id
             LEFT JOIN payment_provider_events event
               ON event.refund_transaction_id = refund.id
              AND event.provider_event_id =
                  'equal-refund-success-after-failure'
             WHERE refund.id = $1
             GROUP BY refund.status, refund.provider_result_event_id,
                      payment.status`,
            [firstDelayedFailureRefundId],
          )
        ).rows,
      ).toEqual([
        {
          refund_status: "FAILED",
          provider_result_event_id: refundFailureResultEventId,
          payment_status: "PARTIALLY_REFUNDED",
          equal_receipt_count: "1",
        },
      ]);

      const tiedLatestOccurredAt = new Date(
        refundFailureReconciledAt.getTime() + 1,
      );
      await fixtures.persistRefundProviderEvent(
        firstDelayedFailureRefundId,
        "REFUND_FAILED",
        "delayed-failure-provider-refund-first",
        tiedLatestOccurredAt,
        "unselected-later-refund-failure",
        tiedLatestOccurredAt,
      );
      await fixtures.persistRefundProviderEvent(
        firstDelayedFailureRefundId,
        "REFUND_SUCCEEDED",
        "delayed-failure-provider-refund-first",
        new Date(tiedLatestOccurredAt.getTime() + 1),
        "success-tied-with-unselected-later-failure",
        tiedLatestOccurredAt,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            audit_receipt_count: string;
            provider_result_event_id: string;
            refund_status: string;
          }>(
            `SELECT refund.status::text AS refund_status,
                    refund.provider_result_event_id,
                    count(event.id)::text AS audit_receipt_count
             FROM refund_transactions refund
             LEFT JOIN payment_provider_events event
               ON event.refund_transaction_id = refund.id
              AND event.provider_event_id IN (
                  'unselected-later-refund-failure',
                  'success-tied-with-unselected-later-failure'
              )
             WHERE refund.id = $1
             GROUP BY refund.status, refund.provider_result_event_id`,
            [firstDelayedFailureRefundId],
          )
        ).rows,
      ).toEqual([
        {
          refund_status: "FAILED",
          provider_result_event_id: refundFailureResultEventId,
          audit_receipt_count: "2",
        },
      ]);

      const refundRecoveredAt = new Date(
        refundFailureReconciledAt.getTime() + 3,
      );
      const refundRecoveryProviderEventId =
        "newer-refund-success-after-failure";
      await fixtures.persistRefundProviderEvent(
        firstDelayedFailureRefundId,
        "REFUND_SUCCEEDED",
        "delayed-failure-provider-refund-first",
        refundRecoveredAt,
        refundRecoveryProviderEventId,
        refundRecoveredAt,
      );
      const refundRecoveryResultEventId = fixtures.id(
        `provider-event:${refundRecoveryProviderEventId}`,
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_result_event_id = $2,
             completed_at = $3, updated_at = $3
         WHERE id = $1`,
        [
          firstDelayedFailureRefundId,
          refundRecoveryResultEventId,
          refundRecoveredAt,
        ],
      );
      await client.query(
        `UPDATE payments SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [captured.paymentId, refundRecoveredAt],
      );
      await client.query(
        `UPDATE order_phases
         SET status = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [captured.orderId, refundRecoveredAt],
      );
      await client.query(
        `UPDATE fulfilment_slots
         SET outcome = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [captured.orderId, refundRecoveredAt],
      );
      await client.query(
        `UPDATE orders SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [captured.orderId, refundRecoveredAt],
      );
      await forceOrderLifecycleConstraints(client);
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "payments_refunded_order_reconciled",
           "refund_transactions_refunded_order_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{
            order_status: string;
            payment_status: string;
            refund_status: string;
          }>(
            `SELECT refund.status::text AS refund_status,
                    payment.status::text AS payment_status,
                    target_order.status::text AS order_status
             FROM refund_transactions refund
             JOIN payments payment ON payment.id = refund.payment_id
             JOIN orders target_order ON target_order.id = payment.order_id
             WHERE refund.id = $1`,
            [firstDelayedFailureRefundId],
          )
        ).rows,
      ).toEqual([
        {
          refund_status: "SUCCEEDED",
          payment_status: "REFUNDED",
          order_status: "REFUNDED",
        },
      ]);
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "payments_refunded_order_reconciled",
           "refund_transactions_refunded_order_reconciled" DEFERRED`,
      );

      await fixtures.persistRefundProviderEvent(
        firstDelayedFailureRefundId,
        "REFUND_FAILED",
        "delayed-failure-provider-refund-first",
        new Date(refundRecoveredAt.getTime() + 1),
        "equal-refund-failure-after-recovery",
        refundRecoveredAt,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            equal_receipt_count: string;
            order_status: string;
            payment_status: string;
            provider_result_event_id: string;
            refund_status: string;
          }>(
            `SELECT refund.status::text AS refund_status,
                    refund.provider_result_event_id,
                    payment.status::text AS payment_status,
                    target_order.status::text AS order_status,
                    count(event.id)::text AS equal_receipt_count
             FROM refund_transactions refund
             JOIN payments payment ON payment.id = refund.payment_id
             JOIN orders target_order ON target_order.id = payment.order_id
             LEFT JOIN payment_provider_events event
               ON event.refund_transaction_id = refund.id
              AND event.provider_event_id =
                  'equal-refund-failure-after-recovery'
             WHERE refund.id = $1
             GROUP BY refund.status, refund.provider_result_event_id,
                      payment.status, target_order.status`,
            [firstDelayedFailureRefundId],
          )
        ).rows,
      ).toEqual([
        {
          refund_status: "SUCCEEDED",
          provider_result_event_id: refundRecoveryResultEventId,
          payment_status: "REFUNDED",
          order_status: "REFUNDED",
          equal_receipt_count: "1",
        },
      ]);

      await expectQueryError(
        client,
        "mutate_payment_provider_receipt",
        () =>
          client.query(
            `UPDATE payment_provider_events
             SET payload = payload || '{"tampered":true}'::jsonb
             WHERE payment_id = $1`,
            [captured.paymentId],
          ),
        {
          code: "23514",
          constraint: "payment_provider_event_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "delete_payment_provider_receipt",
        () =>
          client.query(
            `DELETE FROM payment_provider_events WHERE payment_id = $1`,
            [captured.paymentId],
          ),
        {
          code: "23514",
          constraint: "payment_provider_event_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "duplicate_payment_provider_event",
        () =>
          client.query(
            `INSERT INTO payment_provider_events
             SELECT gen_random_uuid(), payment_id, refund_transaction_id,
                    provider, provider_event_id, provider_transaction_id, kind,
                    amount_minor, currency, payload, payload_hash, occurred_at,
                    authenticated_at, verified_at, created_at
             FROM payment_provider_events
             WHERE payment_id = $1`,
            [captured.paymentId],
          ),
        {
          code: "23505",
          constraint: "payment_provider_events_provider_provider_event_id_key",
        },
      );

      const orphan = await fixtures.createFoundation("orphan-capture-event");
      await createCurrentPlanAndPayment(client, fixtures, orphan);
      await expectQueryError(
        client,
        "orphan_payment_provider_event",
        async () => {
          await fixtures.persistPaymentProviderEvent(
            orphan.paymentId,
            "PAYMENT_CAPTURED",
            "orphan-provider-capture",
            new Date(),
          );
          await client.query(
            `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_provider_event_consumption_check",
        },
      );

      const failed = await fixtures.createFoundation("receipt-backed-failure");
      await createCurrentPlanAndPayment(client, fixtures, failed);
      const failedPayment = (
        await client.query<{
          created_at: Date;
          provider_intent_id: string;
        }>(
          `SELECT created_at, provider_intent_id
           FROM payments WHERE id = $1`,
          [failed.paymentId],
        )
      ).rows[0];
      if (!failedPayment?.provider_intent_id) {
        throw new Error("failed Payment fixture is missing provider evidence");
      }
      const failedAt = new Date();
      await expectQueryError(
        client,
        "payment_event_beyond_negative_skew",
        () =>
          fixtures.persistPaymentProviderEvent(
            failed.paymentId,
            "PAYMENT_FAILED",
            failedPayment.provider_intent_id,
            failedAt,
            null,
            "payment-failure-beyond-negative-skew",
            new Date(failedPayment.created_at.getTime() - 5_001),
          ),
        {
          code: "23514",
          constraint: "payment_provider_event_scope_check",
        },
      );
      const failPayment = () =>
        client.query(
          `UPDATE payments
           SET status = 'FAILED', capture_authorized = false,
               capture_cutoff_at = $2, updated_at = $2
           WHERE id = $1`,
          [failed.paymentId, failedAt],
        );
      await expectQueryError(
        client,
        "pending_failure_receipt_without_atomic_transition",
        async () => {
          await fixtures.persistPaymentProviderEvent(
            failed.paymentId,
            "PAYMENT_FAILED",
            failedPayment.provider_intent_id,
            failedAt,
            null,
            "pending-failure-without-transition",
          );
          await client.query(
            `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "payment_provider_event_consumption_check",
        },
      );
      await expectQueryError(
        client,
        "failure_without_provider_receipt",
        failPayment,
        {
          code: "23514",
          constraint: "payment_failure_provider_receipt_check",
        },
      );
      const failureOccurredAt = new Date(
        failedPayment.created_at.getTime() - 5_000,
      );
      await fixtures.persistPaymentProviderEvent(
        failed.paymentId,
        "PAYMENT_FAILED",
        failedPayment.provider_intent_id,
        failedAt,
        null,
        "payment-failure-at-negative-skew-boundary",
        failureOccurredAt,
      );
      await expectQueryError(
        client,
        "failure_receipt_cutoff_mismatch",
        () =>
          client.query(
            `UPDATE payments
             SET status = 'FAILED', capture_authorized = false,
                 capture_cutoff_at = $2, updated_at = $2
             WHERE id = $1`,
            [failed.paymentId, new Date(failedAt.getTime() + 1)],
          ),
        {
          code: "23514",
          constraint: "payment_failure_provider_receipt_check",
        },
      );
      await failPayment();
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            capture_cutoff_at: Date;
            occurred_at: Date;
            status: string;
            verified_at: Date;
          }>(
            `SELECT payment.status::text, payment.capture_cutoff_at,
                    event.occurred_at, event.verified_at
             FROM payments payment
             JOIN payment_provider_events event
               ON event.payment_id = payment.id
              AND event.provider_event_id =
                  'payment-failure-at-negative-skew-boundary'
             WHERE payment.id = $1`,
            [failed.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "FAILED",
          capture_cutoff_at: failedAt,
          occurred_at: failureOccurredAt,
          verified_at: failedAt,
        },
      ]);

      await fixtures.persistPaymentProviderEvent(
        failed.paymentId,
        "PAYMENT_FAILED",
        failedPayment.provider_intent_id,
        new Date(),
        null,
        "delayed-failure-after-failed",
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{ event_count: string; status: string }>(
            `SELECT payment.status::text, count(event.id)::text AS event_count
             FROM payments payment
             JOIN payment_provider_events event
               ON event.payment_id = payment.id
              AND event.kind = 'PAYMENT_FAILED'
             WHERE payment.id = $1
             GROUP BY payment.status`,
            [failed.paymentId],
          )
        ).rows,
      ).toEqual([{ status: "FAILED", event_count: "2" }]);
    });
  });

  it("reconciles a newer refund failure while sibling refund work remains pending", async () => {
    await rollback(
      "stable-refund-pending-reconciliation",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "stable-refund-pending-reconciliation",
        );
        const productions = await createCurrentPlanAndPayment(
          client,
          fixtures,
          foundation,
        );
        await activateCurrentPlan(client, fixtures, foundation, productions);
        const capturedAmount = Number(
          (
            await client.query<{ captured_amount_minor: string }>(
              `SELECT captured_amount_minor::text
               FROM payments WHERE id = $1`,
              [foundation.paymentId],
            )
          ).rows[0]?.captured_amount_minor,
        );
        if (!Number.isSafeInteger(capturedAmount) || capturedAmount < 2) {
          throw new Error("stable refund-pending amount cannot be split");
        }
        const affectedRefundId = fixtures.id("stable-refund-pending-affected");
        const siblingRefundId = fixtures.id("stable-refund-pending-sibling");
        const affectedAmount = Math.floor(capturedAmount / 2);
        const siblingAmount = capturedAmount - affectedAmount;
        const siblingRequestedAt = new Date();
        const affectedRequestedAt = new Date(siblingRequestedAt.getTime() - 1);
        await cancelOrderBeforeHandoff(
          client,
          foundation.orderId,
          true,
          true,
          "CANCELLED",
          [
            {
              id: affectedRefundId,
              idempotencyKey: "stable-refund-pending-affected",
              amountMinor: affectedAmount,
              requestedAt: affectedRequestedAt,
            },
            {
              id: siblingRefundId,
              idempotencyKey: "stable-refund-pending-sibling",
              amountMinor: siblingAmount,
              requestedAt: siblingRequestedAt,
            },
          ],
        );

        const providerRefundId = "stable-refund-pending-provider-transaction";
        const succeededAt = new Date();
        const successProviderEventId = "stable-refund-pending-success-event";
        await fixtures.persistRefundProviderEvent(
          affectedRefundId,
          "REFUND_SUCCEEDED",
          providerRefundId,
          succeededAt,
          successProviderEventId,
          succeededAt,
        );
        const successResultEventId = fixtures.id(
          `provider-event:${successProviderEventId}`,
        );
        await client.query(
          `UPDATE refund_transactions
           SET status = 'SUCCEEDED', provider_refund_id = $2,
               provider_result_event_id = $3, completed_at = $4,
               updated_at = $4
           WHERE id = $1`,
          [
            affectedRefundId,
            providerRefundId,
            successResultEventId,
            succeededAt,
          ],
        );
        await client.query(
          `SET CONSTRAINTS
             "payment_provider_events_consumed",
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS
             "payment_provider_events_consumed",
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled" DEFERRED`,
        );

        const failedAt = new Date(
          Math.max(Date.now() + 4_000, succeededAt.getTime() + 1),
        );
        const failureProviderEventId = "stable-refund-pending-failure-event";
        await fixtures.persistRefundProviderEvent(
          affectedRefundId,
          "REFUND_FAILED",
          providerRefundId,
          failedAt,
          failureProviderEventId,
          failedAt,
        );
        const failureResultEventId = fixtures.id(
          `provider-event:${failureProviderEventId}`,
        );
        const retryRefundId = fixtures.id("stable-refund-pending-retry");
        await client.query(
          `UPDATE refund_transactions
           SET status = 'FAILED', provider_result_event_id = $2,
               completed_at = NULL, updated_at = $3
           WHERE id = $1`,
          [affectedRefundId, failureResultEventId, failedAt],
        );
        await expectQueryError(
          client,
          "reject_mismatched_refund_retry_lineage",
          async () => {
            await client.query(
              `INSERT INTO refund_transactions
                 (id, payment_id, replaces_refund_transaction_id,
                  replaces_failure_provider_event_id, idempotency_key,
                  amount_minor, reason, status,
                  requested_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,'PRODUCTION_FAILURE','PENDING',
                       $7,$7,$7)`,
              [
                fixtures.id("stable-refund-pending-invalid-retry"),
                foundation.paymentId,
                affectedRefundId,
                failureResultEventId,
                "stable-refund-pending-invalid-retry",
                affectedAmount,
                failedAt,
              ],
            );
            await client.query(
              `SET CONSTRAINTS
                 "refund_transactions_retry_lineage_reconciled" IMMEDIATE`,
            );
          },
          { code: "23514", constraint: "refund_retry_lineage_check" },
        );
        await expectQueryError(
          client,
          "reject_stale_refund_retry_lineage",
          async () => {
            const staleRequestedAt = new Date(failedAt.getTime() - 6_000);
            await client.query(
              `INSERT INTO refund_transactions
                 (id, payment_id, replaces_refund_transaction_id,
                  replaces_failure_provider_event_id, idempotency_key,
                  amount_minor, reason, status,
                  requested_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,'CUSTOMER_CANCELLATION','PENDING',
                       $7,$7,$7)`,
              [
                fixtures.id("stable-refund-pending-stale-retry"),
                foundation.paymentId,
                affectedRefundId,
                failureResultEventId,
                "stable-refund-pending-stale-retry",
                affectedAmount,
                staleRequestedAt,
              ],
            );
            await client.query(
              `SET CONSTRAINTS
                 "refund_transactions_retry_lineage_reconciled" IMMEDIATE`,
            );
          },
          { code: "23514", constraint: "refund_retry_lineage_check" },
        );
        await expectQueryError(
          client,
          "reject_unlinked_refund_retry",
          async () => {
            await client.query(
              `INSERT INTO refund_transactions
                 (id, payment_id, idempotency_key, amount_minor, reason,
                  status, requested_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,'CUSTOMER_CANCELLATION','PENDING',
                       $5,$5,$5)`,
              [
                fixtures.id("stable-refund-pending-unlinked-retry"),
                foundation.paymentId,
                "stable-refund-pending-unlinked-retry",
                affectedAmount,
                failedAt,
              ],
            );
            await client.query(
              `SET CONSTRAINTS
                 "refund_transactions_failure_retry_obligation_reconciled"
                 IMMEDIATE`,
            );
          },
          {
            code: "23514",
            constraint: "refund_failure_retry_obligation_check",
          },
        );
        await client.query(`SAVEPOINT "allow_partial_independent_refund"`);
        try {
          const siblingFailureAt = new Date(failedAt.getTime() + 1);
          const siblingFailureProviderEventId =
            "stable-refund-pending-sibling-failure-event";
          const siblingFailureProviderRefundId =
            "stable-refund-pending-sibling-provider-transaction";
          await fixtures.persistRefundProviderEvent(
            siblingRefundId,
            "REFUND_FAILED",
            siblingFailureProviderRefundId,
            siblingFailureAt,
            siblingFailureProviderEventId,
            siblingFailureAt,
          );
          await client.query(
            `UPDATE refund_transactions
               SET status = 'FAILED', provider_refund_id = $2,
                   provider_result_event_id = $3, updated_at = $4
               WHERE id = $1`,
            [
              siblingRefundId,
              siblingFailureProviderRefundId,
              fixtures.id(`provider-event:${siblingFailureProviderEventId}`),
              siblingFailureAt,
            ],
          );
          await client.query(
            `INSERT INTO refund_transactions
                 (id, payment_id, idempotency_key, amount_minor, reason,
                  status, requested_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,'CUSTOMER_CANCELLATION','PENDING',
                       $5,$5,$5)`,
            [
              fixtures.id("stable-refund-pending-partial-unlinked-retry"),
              foundation.paymentId,
              "stable-refund-pending-partial-unlinked-retry",
              affectedAmount,
              failedAt,
            ],
          );
          await client.query(
            `SET CONSTRAINTS
                 "refund_transactions_failure_retry_obligation_reconciled"
                 IMMEDIATE`,
          );
          expect(
            (
              await client.query<{ linked_retry_count: string }>(
                `SELECT count(*)::text AS linked_retry_count
                   FROM refund_transactions
                   WHERE replaces_refund_transaction_id = $1`,
                [affectedRefundId],
              )
            ).rows,
          ).toEqual([{ linked_retry_count: "0" }]);
        } finally {
          await client.query(
            `ROLLBACK TO SAVEPOINT "allow_partial_independent_refund"`,
          );
          await client.query(
            `RELEASE SAVEPOINT "allow_partial_independent_refund"`,
          );
          await client.query(
            `SET CONSTRAINTS
               "refund_transactions_failure_retry_obligation_reconciled"
               DEFERRED`,
          );
        }
        await client.query(
          `INSERT INTO refund_transactions
             (id, payment_id, replaces_refund_transaction_id,
              replaces_failure_provider_event_id, idempotency_key,
              amount_minor, reason, status, requested_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'CUSTOMER_CANCELLATION','PENDING',
                   $7,$7,$7)`,
          [
            retryRefundId,
            foundation.paymentId,
            affectedRefundId,
            failureResultEventId,
            "stable-refund-pending-retry",
            affectedAmount,
            failedAt,
          ],
        );
        await forceOrderLifecycleConstraints(client);
        await client.query(
          `SET CONSTRAINTS
             "payment_provider_events_consumed",
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled",
             "refund_transactions_retry_lineage_reconciled",
             "refund_transactions_failure_retry_obligation_reconciled",
             "refund_transactions_source_reconciliation_reconciled"
             IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS
             "payment_provider_events_consumed",
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled",
             "refund_transactions_retry_lineage_reconciled",
             "refund_transactions_failure_retry_obligation_reconciled"
             DEFERRED`,
        );

        expect(
          (
            await client.query<{
              affected_status: string;
              cancelled_slots: string;
              order_status: string;
              payment_status: string;
              phase_status: string;
              provider_result_event_id: string;
              replaces_failure_provider_event_id: string;
              replaces_refund_transaction_id: string;
              retry_status: string;
              sibling_status: string;
            }>(
              `SELECT affected.status::text AS affected_status,
                      affected.provider_result_event_id,
                      retry.replaces_failure_provider_event_id,
                      retry.replaces_refund_transaction_id,
                      sibling.status::text AS sibling_status,
                      retry.status::text AS retry_status,
                      payment.status::text AS payment_status,
                      target_order.status::text AS order_status,
                      phase.status::text AS phase_status,
                      (SELECT count(*)::text
                       FROM fulfilment_slots slot
                       WHERE slot.order_id = target_order.id
                         AND slot.outcome = 'CANCELLED') AS cancelled_slots
               FROM refund_transactions affected
               JOIN refund_transactions sibling ON sibling.id = $3
               JOIN refund_transactions retry ON retry.id = $4
               JOIN payments payment ON payment.id = affected.payment_id
               JOIN orders target_order ON target_order.id = payment.order_id
               JOIN order_phases phase ON phase.order_id = target_order.id
               WHERE affected.id = $1 AND payment.id = $2`,
              [
                affectedRefundId,
                foundation.paymentId,
                siblingRefundId,
                retryRefundId,
              ],
            )
          ).rows,
        ).toEqual([
          {
            affected_status: "FAILED",
            provider_result_event_id: failureResultEventId,
            replaces_failure_provider_event_id: failureResultEventId,
            replaces_refund_transaction_id: affectedRefundId,
            sibling_status: "PENDING",
            retry_status: "PENDING",
            payment_status: "REFUND_PENDING",
            order_status: "CANCELLED",
            phase_status: "CANCELLED",
            cancelled_slots: "1",
          },
        ]);

        const lateRecoveryAt = new Date(failedAt.getTime() + 1);
        const lateRecoveryProviderEventId =
          "stable-refund-pending-late-recovery-event";
        const lateRecoveryResultEventId = fixtures.id(
          `provider-event:${lateRecoveryProviderEventId}`,
        );

        await expectQueryError(
          client,
          "reject_unreconciled_late_success_receipt",
          async () => {
            await fixtures.persistRefundProviderEvent(
              affectedRefundId,
              "REFUND_SUCCEEDED",
              providerRefundId,
              lateRecoveryAt,
              lateRecoveryProviderEventId,
              lateRecoveryAt,
            );
            await client.query(
              `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
            );
          },
          {
            code: "23514",
            constraint: "payment_provider_event_consumption_check",
          },
        );

        await client.query(`SAVEPOINT "retry_success_before_source_success"`);
        try {
          const siblingFailureAt = new Date(failedAt.getTime() + 2);
          const siblingFailureProviderRefundId =
            "stable-refund-pending-sibling-failure-transaction";
          const siblingFailureProviderEventId =
            "stable-refund-pending-sibling-failure-event";
          await fixtures.persistRefundProviderEvent(
            siblingRefundId,
            "REFUND_FAILED",
            siblingFailureProviderRefundId,
            siblingFailureAt,
            siblingFailureProviderEventId,
            siblingFailureAt,
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'FAILED', provider_refund_id = $2,
                 provider_result_event_id = $3, updated_at = $4
             WHERE id = $1`,
            [
              siblingRefundId,
              siblingFailureProviderRefundId,
              fixtures.id(`provider-event:${siblingFailureProviderEventId}`),
              siblingFailureAt,
            ],
          );

          expect(
            (
              await client.query<{ claimed_at: Date | null }>(
                `SELECT taven_claim_refund_dispatch($1) AS claimed_at`,
                [retryRefundId],
              )
            ).rows[0]?.claimed_at,
          ).toBeInstanceOf(Date);
          const retryFirstSuccessAt = new Date(failedAt.getTime() + 1);
          const retryFirstSuccessProviderRefundId =
            "stable-refund-pending-retry-first-success-transaction";
          const retryFirstSuccessProviderEventId =
            "stable-refund-pending-retry-first-success-event";
          const retryFirstSuccessResultEventId = fixtures.id(
            `provider-event:${retryFirstSuccessProviderEventId}`,
          );
          await fixtures.persistRefundProviderEvent(
            retryRefundId,
            "REFUND_SUCCEEDED",
            retryFirstSuccessProviderRefundId,
            retryFirstSuccessAt,
            retryFirstSuccessProviderEventId,
            retryFirstSuccessAt,
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', provider_refund_id = $2,
                 provider_result_event_id = $3, completed_at = $4,
                 updated_at = $4
             WHERE id = $1`,
            [
              retryRefundId,
              retryFirstSuccessProviderRefundId,
              retryFirstSuccessResultEventId,
              retryFirstSuccessAt,
            ],
          );
          await client.query(
            `UPDATE payments
             SET status = 'PARTIALLY_REFUNDED', updated_at = $2
             WHERE id = $1`,
            [foundation.paymentId, retryFirstSuccessAt],
          );
          await client.query(
            `SET CONSTRAINTS
               "payment_provider_events_consumed",
               "payments_refund_status_reconciled",
               "refund_transactions_payment_status_reconciled"
               IMMEDIATE`,
          );
          await client.query(
            `SET CONSTRAINTS
               "payment_provider_events_consumed",
               "payments_refund_status_reconciled",
               "refund_transactions_payment_status_reconciled"
               DEFERRED`,
          );

          await fixtures.persistRefundProviderEvent(
            affectedRefundId,
            "REFUND_SUCCEEDED",
            providerRefundId,
            lateRecoveryAt,
            lateRecoveryProviderEventId,
            lateRecoveryAt,
          );
          const directSuccessPaymentStatus =
            affectedAmount * 2 === capturedAmount
              ? "REFUNDED"
              : "PARTIALLY_REFUNDED";
          await expectQueryError(
            client,
            "reject_source_success_after_retry_success",
            async () => {
              await client.query(
                `UPDATE refund_transactions
                 SET status = 'SUCCEEDED', provider_result_event_id = $2,
                     completed_at = $3, updated_at = $3
                 WHERE id = $1`,
                [affectedRefundId, lateRecoveryResultEventId, lateRecoveryAt],
              );
              await client.query(
                `UPDATE payments SET status = $2::payment_status,
                     updated_at = $3 WHERE id = $1`,
                [
                  foundation.paymentId,
                  directSuccessPaymentStatus,
                  lateRecoveryAt,
                ],
              );
              await client.query(
                `SET CONSTRAINTS
                   "refund_transactions_source_reconciliation_reconciled"
                   IMMEDIATE`,
              );
            },
            {
              code: "23514",
              constraint: "refund_retry_source_reconciliation_check",
            },
          );

          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUSPENDED',
                 source_success_provider_event_id = $2,
                 reconciliation_started_at = $3,
                 completed_at = NULL, updated_at = $3
             WHERE id = $1`,
            [retryRefundId, lateRecoveryResultEventId, lateRecoveryAt],
          );
          await client.query(
            `UPDATE payments SET status = 'REFUND_PENDING', updated_at = $2
             WHERE id = $1`,
            [foundation.paymentId, lateRecoveryAt],
          );
          await client.query(
            `SET CONSTRAINTS
               "payment_provider_events_consumed",
               "payments_refund_status_reconciled",
               "refund_transactions_payment_status_reconciled",
               "refund_transactions_source_reconciliation_reconciled"
               IMMEDIATE`,
          );
          expect(
            (
              await client.query<{
                completed_at: Date | null;
                payment_status: string;
                retry_result_event_id: string;
                retry_status: string;
                source_status: string;
              }>(
                `SELECT payment.status::text AS payment_status,
                        source.status::text AS source_status,
                        retry.status::text AS retry_status,
                        retry.completed_at,
                        retry.provider_result_event_id AS retry_result_event_id
                 FROM refund_transactions source
                 JOIN refund_transactions retry ON retry.id = $2
                 JOIN payments payment ON payment.id = source.payment_id
                 WHERE source.id = $1`,
                [affectedRefundId, retryRefundId],
              )
            ).rows,
          ).toEqual([
            {
              completed_at: null,
              payment_status: "REFUND_PENDING",
              retry_result_event_id: retryFirstSuccessResultEventId,
              retry_status: "SUSPENDED",
              source_status: "FAILED",
            },
          ]);
        } finally {
          await client.query(
            `ROLLBACK TO SAVEPOINT "retry_success_before_source_success"`,
          );
          await client.query(
            `RELEASE SAVEPOINT "retry_success_before_source_success"`,
          );
          await client.query(
            `SET CONSTRAINTS
               "payment_provider_events_consumed",
               "payments_refund_status_reconciled",
               "refund_transactions_payment_status_reconciled",
               "refund_transactions_source_reconciliation_reconciled"
               DEFERRED`,
          );
        }

        await client.query(`SAVEPOINT "suspend_claimed_refund_retry"`);
        try {
          await expectQueryError(
            client,
            "reject_direct_refund_dispatch_claim",
            async () => {
              await client.query(
                `SELECT set_config(
                   'taven.refund_dispatch_claim_id', $1, true
                 )`,
                [retryRefundId],
              );
              await client.query(
                `UPDATE refund_transactions
                 SET dispatch_claimed_at = $2, updated_at = $2
                 WHERE id = $1`,
                [retryRefundId, lateRecoveryAt],
              );
            },
            {
              code: "23514",
              constraint: "refund_dispatch_claim_protocol_check",
            },
          );
          expect(
            (
              await client.query<{ claimed_at: Date | null }>(
                `SELECT taven_claim_refund_dispatch($1) AS claimed_at`,
                [retryRefundId],
              )
            ).rows[0]?.claimed_at,
          ).toBeInstanceOf(Date);
          expect(
            (
              await client.query<{ claimed_at: Date | null }>(
                `SELECT taven_claim_refund_dispatch($1) AS claimed_at`,
                [retryRefundId],
              )
            ).rows,
          ).toEqual([{ claimed_at: null }]);
          await fixtures.persistRefundProviderEvent(
            affectedRefundId,
            "REFUND_SUCCEEDED",
            providerRefundId,
            lateRecoveryAt,
            lateRecoveryProviderEventId,
            lateRecoveryAt,
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUSPENDED',
                 source_success_provider_event_id = $2,
                 reconciliation_started_at = $3,
                 updated_at = $3
             WHERE id = $1`,
            [retryRefundId, lateRecoveryResultEventId, lateRecoveryAt],
          );
          await forceOrderLifecycleConstraints(client);
          await client.query(
            `SET CONSTRAINTS
               "payment_provider_events_consumed",
               "payments_refund_status_reconciled",
               "refund_transactions_payment_status_reconciled",
               "refund_transactions_source_reconciliation_reconciled"
               IMMEDIATE`,
          );
          expect(
            (
              await client.query<{
                payment_status: string;
                retry_status: string;
                source_status: string;
                source_success_provider_event_id: string;
              }>(
                `SELECT payment.status::text AS payment_status,
                        retry.status::text AS retry_status,
                        source.status::text AS source_status,
                        retry.source_success_provider_event_id
                 FROM refund_transactions source
                 JOIN refund_transactions retry ON retry.id = $2
                 JOIN payments payment ON payment.id = source.payment_id
                 WHERE source.id = $1`,
                [affectedRefundId, retryRefundId],
              )
            ).rows,
          ).toEqual([
            {
              payment_status: "REFUND_PENDING",
              retry_status: "SUSPENDED",
              source_status: "FAILED",
              source_success_provider_event_id: lateRecoveryResultEventId,
            },
          ]);
          await client.query(
            `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
          );
          const suspendedRetrySuccessAt = new Date(
            lateRecoveryAt.getTime() + 1,
          );
          const suspendedRetrySuccessProviderRefundId =
            "stable-refund-pending-suspended-success-transaction";
          const suspendedRetrySuccessProviderEventId =
            "stable-refund-pending-suspended-success-event";
          await fixtures.persistRefundProviderEvent(
            retryRefundId,
            "REFUND_SUCCEEDED",
            suspendedRetrySuccessProviderRefundId,
            suspendedRetrySuccessAt,
            suspendedRetrySuccessProviderEventId,
            suspendedRetrySuccessAt,
          );
          await client.query(
            `UPDATE refund_transactions
             SET provider_refund_id = $2,
                 provider_result_event_id = $3,
                 updated_at = $4
             WHERE id = $1`,
            [
              retryRefundId,
              suspendedRetrySuccessProviderRefundId,
              fixtures.id(
                `provider-event:${suspendedRetrySuccessProviderEventId}`,
              ),
              suspendedRetrySuccessAt,
            ],
          );
          await client.query(
            `SET CONSTRAINTS
               "payment_provider_events_consumed",
               "refund_transactions_source_reconciliation_reconciled"
               IMMEDIATE`,
          );
          expect(
            (
              await client.query<{
                provider_result_event_id: string;
                retry_status: string;
              }>(
                `SELECT status::text AS retry_status,
                        provider_result_event_id
                 FROM refund_transactions
                 WHERE id = $1`,
                [retryRefundId],
              )
            ).rows,
          ).toEqual([
            {
              retry_status: "SUSPENDED",
              provider_result_event_id: fixtures.id(
                `provider-event:${suspendedRetrySuccessProviderEventId}`,
              ),
            },
          ]);
          await client.query(
            `SET CONSTRAINTS
               "payment_provider_events_consumed",
               "refund_transactions_source_reconciliation_reconciled"
               DEFERRED`,
          );

          const suspendedRetryFailureAt = new Date(
            lateRecoveryAt.getTime() + 2,
          );
          const suspendedRetryFailureProviderEventId =
            "stable-refund-pending-suspended-failure-event";
          const suspendedRetryFailureResultEventId = fixtures.id(
            `provider-event:${suspendedRetryFailureProviderEventId}`,
          );
          await fixtures.persistRefundProviderEvent(
            retryRefundId,
            "REFUND_FAILED",
            suspendedRetrySuccessProviderRefundId,
            suspendedRetryFailureAt,
            suspendedRetryFailureProviderEventId,
            suspendedRetryFailureAt,
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'FAILED', provider_refund_id = $2,
                 provider_result_event_id = $3, updated_at = $4
             WHERE id = $1`,
            [
              retryRefundId,
              suspendedRetrySuccessProviderRefundId,
              suspendedRetryFailureResultEventId,
              suspendedRetryFailureAt,
            ],
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', provider_result_event_id = $2,
                 completed_at = $3, updated_at = $3
             WHERE id = $1`,
            [affectedRefundId, lateRecoveryResultEventId, lateRecoveryAt],
          );
          await forceOrderLifecycleConstraints(client);
          await client.query(
            `SET CONSTRAINTS
               "payment_provider_events_consumed",
               "payments_refund_status_reconciled",
               "refund_transactions_payment_status_reconciled",
               "refund_transactions_source_reconciliation_reconciled"
               IMMEDIATE`,
          );
          expect(
            (
              await client.query<{
                payment_status: string;
                provider_result_event_id: string;
                retry_status: string;
                source_status: string;
              }>(
                `SELECT payment.status::text AS payment_status,
                        retry.status::text AS retry_status,
                        retry.provider_result_event_id,
                        source.status::text AS source_status
                 FROM refund_transactions source
                 JOIN refund_transactions retry ON retry.id = $2
                 JOIN payments payment ON payment.id = source.payment_id
                 WHERE source.id = $1`,
                [affectedRefundId, retryRefundId],
              )
            ).rows,
          ).toEqual([
            {
              payment_status: "REFUND_PENDING",
              provider_result_event_id: suspendedRetryFailureResultEventId,
              retry_status: "FAILED",
              source_status: "SUCCEEDED",
            },
          ]);
        } finally {
          await client.query(
            `ROLLBACK TO SAVEPOINT "suspend_claimed_refund_retry"`,
          );
          await client.query(
            `RELEASE SAVEPOINT "suspend_claimed_refund_retry"`,
          );
          await client.query(
            `SET CONSTRAINTS
               "payment_provider_events_consumed",
               "payments_refund_status_reconciled",
               "refund_transactions_payment_status_reconciled",
               "refund_transactions_source_reconciliation_reconciled"
               DEFERRED`,
          );
        }

        await fixtures.persistRefundProviderEvent(
          affectedRefundId,
          "REFUND_SUCCEEDED",
          providerRefundId,
          lateRecoveryAt,
          lateRecoveryProviderEventId,
          lateRecoveryAt,
        );
        await client.query(
          `UPDATE refund_transactions
           SET status = 'SUPERSEDED',
               source_success_provider_event_id = $2,
               reconciliation_started_at = $3,
               updated_at = $3
           WHERE id = $1`,
          [retryRefundId, lateRecoveryResultEventId, lateRecoveryAt],
        );
        await client.query(
          `UPDATE refund_transactions
           SET status = 'SUCCEEDED', provider_result_event_id = $2,
               completed_at = $3, updated_at = $3
           WHERE id = $1`,
          [affectedRefundId, lateRecoveryResultEventId, lateRecoveryAt],
        );
        await forceOrderLifecycleConstraints(client);
        await client.query(
          `SET CONSTRAINTS
             "payment_provider_events_consumed",
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled",
             "refund_transactions_source_reconciliation_reconciled"
             IMMEDIATE`,
        );
        expect(
          (
            await client.query<{
              payment_status: string;
              receipt_count: string;
              retry_status: string;
              sibling_status: string;
              source_status: string;
            }>(
              `SELECT payment.status::text AS payment_status,
                      source.status::text AS source_status,
                      retry.status::text AS retry_status,
                      sibling.status::text AS sibling_status,
                      (SELECT count(*)::text
                       FROM payment_provider_events event
                       WHERE event.id = $5
                         AND event.refund_transaction_id = source.id)
                        AS receipt_count
               FROM refund_transactions source
               JOIN refund_transactions retry ON retry.id = $2
               JOIN refund_transactions sibling ON sibling.id = $3
               JOIN payments payment ON payment.id = $4
               WHERE source.id = $1`,
              [
                affectedRefundId,
                retryRefundId,
                siblingRefundId,
                foundation.paymentId,
                lateRecoveryResultEventId,
              ],
            )
          ).rows,
        ).toEqual([
          {
            payment_status: "REFUND_PENDING",
            receipt_count: "1",
            retry_status: "SUPERSEDED",
            sibling_status: "PENDING",
            source_status: "SUCCEEDED",
          },
        ]);
        await client.query(
          `SET CONSTRAINTS
             "payment_provider_events_consumed",
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled",
             "refund_transactions_source_reconciliation_reconciled"
             DEFERRED`,
        );

        const failedAgainAt = new Date(failedAt.getTime() + 2);
        const failedAgainProviderEventId =
          "stable-refund-pending-second-failure-event";
        await fixtures.persistRefundProviderEvent(
          affectedRefundId,
          "REFUND_FAILED",
          providerRefundId,
          failedAgainAt,
          failedAgainProviderEventId,
          failedAgainAt,
        );
        const failedAgainResultEventId = fixtures.id(
          `provider-event:${failedAgainProviderEventId}`,
        );
        await client.query(
          `UPDATE refund_transactions
           SET status = 'FAILED', provider_result_event_id = $2,
               completed_at = NULL, updated_at = $3
           WHERE id = $1`,
          [affectedRefundId, failedAgainResultEventId, failedAgainAt],
        );
        const secondRetryRefundId = fixtures.id(
          "stable-refund-pending-second-retry",
        );
        await client.query(
          `INSERT INTO refund_transactions
             (id, payment_id, replaces_refund_transaction_id,
              replaces_failure_provider_event_id, idempotency_key,
              amount_minor, reason, status, requested_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'CUSTOMER_CANCELLATION','PENDING',
                   $7,$7,$7)`,
          [
            secondRetryRefundId,
            foundation.paymentId,
            affectedRefundId,
            failedAgainResultEventId,
            "stable-refund-pending-second-retry",
            affectedAmount,
            failedAgainAt,
          ],
        );
        await forceOrderLifecycleConstraints(client);
        await client.query(
          `SET CONSTRAINTS
             "payment_provider_events_consumed",
             "payments_refund_status_reconciled",
             "refund_transactions_payment_status_reconciled",
             "refund_transactions_retry_lineage_reconciled",
             "refund_transactions_failure_retry_obligation_reconciled",
             "refund_transactions_source_reconciliation_reconciled"
             IMMEDIATE`,
        );
        expect(
          (
            await client.query<{
              replaces_failure_provider_event_id: string;
              retry_status: string;
            }>(
              `SELECT status::text AS retry_status,
                      replaces_failure_provider_event_id
               FROM refund_transactions
               WHERE replaces_refund_transaction_id = $1
               ORDER BY requested_at, id`,
              [affectedRefundId],
            )
          ).rows,
        ).toEqual([
          {
            retry_status: "SUPERSEDED",
            replaces_failure_provider_event_id: failureResultEventId,
          },
          {
            retry_status: "PENDING",
            replaces_failure_provider_event_id: failedAgainResultEventId,
          },
        ]);
      },
    );
  });

  it("reopens a committed refunded order after a newer refund failure", async () => {
    let foundation: PersistenceFoundation | undefined;
    let refundId: string | undefined;
    let refundFailedAt: Date | undefined;
    let refundSucceededAt: Date | undefined;
    let providerRefundId: string | undefined;

    const refunding = await pool.connect();
    await refunding.query("BEGIN");
    try {
      const fixtures = new PersistenceFactory(
        refunding,
        `${scope}:committed-refund-failure`,
      );
      foundation = await fixtures.createFoundation("committed-refund-failure");
      const productions = await createCurrentPlanAndPayment(
        refunding,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(refunding, fixtures, foundation, productions);
      await cancelOrderBeforeHandoff(refunding, foundation.orderId);

      const refund = (
        await refunding.query<{ id: string }>(
          `SELECT id
           FROM refund_transactions
           WHERE payment_id = $1
             AND reason = 'CUSTOMER_CANCELLATION'
             AND status = 'PENDING'`,
          [foundation.paymentId],
        )
      ).rows[0];
      if (!refund) {
        throw new Error("committed refund failure fixture has no refund");
      }
      refundId = refund.id;
      refundSucceededAt = new Date();
      providerRefundId = `${scope}:committed-refund-provider-id`;
      const successProviderEventId = await fixtures.persistRefundProviderEvent(
        refundId,
        "REFUND_SUCCEEDED",
        providerRefundId,
        refundSucceededAt,
        `${scope}:committed-refund-success`,
        refundSucceededAt,
      );
      const successResultEventId = (
        await refunding.query<{ id: string }>(
          `SELECT id
           FROM payment_provider_events
           WHERE payment_id = $1
             AND refund_transaction_id = $2
             AND provider_event_id = $3`,
          [foundation.paymentId, refundId, successProviderEventId],
        )
      ).rows[0]?.id;
      if (!successResultEventId) {
        throw new Error("committed refund success receipt is unavailable");
      }
      await refunding.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_refund_id = $2,
             provider_result_event_id = $3, completed_at = $4, updated_at = $4
         WHERE id = $1`,
        [refundId, providerRefundId, successResultEventId, refundSucceededAt],
      );
      await refunding.query(
        `UPDATE payments SET status = 'REFUNDED', updated_at = $2
         WHERE id = $1`,
        [foundation.paymentId, refundSucceededAt],
      );
      await refunding.query(
        `UPDATE order_phases
         SET status = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, refundSucceededAt],
      );
      await refunding.query(
        `UPDATE fulfilment_slots
         SET outcome = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, refundSucceededAt],
      );
      await refunding.query(
        `UPDATE orders SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [foundation.orderId, refundSucceededAt],
      );
      await forceOrderLifecycleConstraints(refunding);
      await refunding.query("COMMIT");
    } catch (error) {
      await refunding.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      refunding.release();
    }

    if (!foundation || !refundId || !refundSucceededAt || !providerRefundId) {
      throw new Error("committed refund failure fixture is incomplete");
    }
    expect(
      (
        await pool.query<{
          order_status: string;
          payment_status: string;
          phase_status: string;
          refund_status: string;
          refunded_slots: string;
        }>(
          `SELECT target_order.status::text AS order_status,
                  payment.status::text AS payment_status,
                  phase.status::text AS phase_status,
                  refund.status::text AS refund_status,
                  (SELECT count(*)::text
                   FROM fulfilment_slots slot
                   WHERE slot.order_id = target_order.id
                     AND slot.outcome = 'CANCELLED_REFUNDED') AS refunded_slots
           FROM orders target_order
           JOIN order_phases phase ON phase.order_id = target_order.id
           JOIN payments payment ON payment.order_id = target_order.id
           JOIN refund_transactions refund ON refund.id = $2
           WHERE target_order.id = $1`,
          [foundation.orderId, refundId],
        )
      ).rows,
    ).toEqual([
      {
        order_status: "REFUNDED",
        payment_status: "REFUNDED",
        phase_status: "CANCELLED_REFUNDED",
        refund_status: "SUCCEEDED",
        refunded_slots: "1",
      },
    ]);

    const reconciling = await pool.connect();
    await reconciling.query("BEGIN");
    let failureResultEventId: string | undefined;
    try {
      const fixtures = new PersistenceFactory(
        reconciling,
        `${scope}:committed-refund-failure`,
      );
      refundFailedAt = new Date(
        Math.max(Date.now(), refundSucceededAt.getTime() + 1),
      );
      const failureProviderEventId = `${scope}:committed-refund-failure`;
      await fixtures.persistRefundProviderEvent(
        refundId,
        "REFUND_FAILED",
        providerRefundId,
        refundFailedAt,
        failureProviderEventId,
        refundFailedAt,
      );
      failureResultEventId = (
        await reconciling.query<{ id: string }>(
          `SELECT id
           FROM payment_provider_events
           WHERE payment_id = $1
             AND refund_transaction_id = $2
             AND provider_event_id = $3`,
          [foundation.paymentId, refundId, failureProviderEventId],
        )
      ).rows[0]?.id;
      if (!failureResultEventId) {
        throw new Error("committed refund failure receipt is unavailable");
      }

      await expectQueryError(
        reconciling,
        "duplicate_committed_refund_failure_receipt",
        () =>
          reconciling.query(
            `INSERT INTO payment_provider_events
             SELECT gen_random_uuid(), payment_id, refund_transaction_id,
                    provider, provider_event_id, provider_transaction_id, kind,
                    amount_minor, currency, payload, payload_hash, occurred_at,
                    authenticated_at, verified_at, created_at
             FROM payment_provider_events
             WHERE id = $1`,
            [failureResultEventId],
          ),
        {
          code: "23505",
          constraint: "payment_provider_events_provider_provider_event_id_key",
        },
      );
      await reconciling.query(
        `UPDATE refund_transactions
         SET status = 'FAILED', provider_result_event_id = $2,
             completed_at = NULL, updated_at = $3
         WHERE id = $1`,
        [refundId, failureResultEventId, refundFailedAt],
      );
      await reconciling.query(
        `UPDATE payments SET status = 'CAPTURED', updated_at = $2
         WHERE id = $1`,
        [foundation.paymentId, refundFailedAt],
      );
      await reconciling.query(
        `UPDATE order_phases SET status = 'CANCELLED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, refundFailedAt],
      );
      await reconciling.query(
        `UPDATE fulfilment_slots SET outcome = 'CANCELLED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, refundFailedAt],
      );
      await reconciling.query(
        `UPDATE orders SET status = 'CANCELLED', updated_at = $2 WHERE id = $1`,
        [foundation.orderId, refundFailedAt],
      );
      await forceOrderLifecycleConstraints(reconciling);
      await reconciling.query("COMMIT");
    } catch (error) {
      await reconciling.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      reconciling.release();
    }

    expect(failureResultEventId).toBeDefined();
    expect(
      (
        await pool.query<{
          cancelled_slots: string;
          completed_at: Date | null;
          order_status: string;
          payment_status: string;
          phase_status: string;
          provider_result_event_id: string;
          refund_status: string;
        }>(
          `SELECT target_order.status::text AS order_status,
                  payment.status::text AS payment_status,
                  phase.status::text AS phase_status,
                  refund.status::text AS refund_status,
                  refund.completed_at, refund.provider_result_event_id,
                  (SELECT count(*)::text
                   FROM fulfilment_slots slot
                   WHERE slot.order_id = target_order.id
                     AND slot.outcome = 'CANCELLED') AS cancelled_slots
           FROM orders target_order
           JOIN order_phases phase ON phase.order_id = target_order.id
           JOIN payments payment ON payment.order_id = target_order.id
           JOIN refund_transactions refund ON refund.id = $2
           WHERE target_order.id = $1`,
          [foundation.orderId, refundId],
        )
      ).rows,
    ).toEqual([
      {
        order_status: "CANCELLED",
        payment_status: "CAPTURED",
        phase_status: "CANCELLED",
        refund_status: "FAILED",
        completed_at: null,
        provider_result_event_id: failureResultEventId,
        cancelled_slots: "1",
      },
    ]);

    if (!refundFailedAt) {
      throw new Error("committed refund failure time is unavailable");
    }
    const retryRefundId = randomUUID();
    const retryProviderRefundId = `${scope}:committed-refund-retry-provider-id`;
    const retrySuccessProviderEventId = `${scope}:committed-refund-retry-success`;
    let retrySuccessResultEventId: string | undefined;
    let retrySucceededAt: Date | undefined;
    const retrying = await pool.connect();
    await retrying.query("BEGIN");
    try {
      const fixtures = new PersistenceFactory(
        retrying,
        `${scope}:committed-refund-retry`,
      );
      const retryRequestedAt = new Date(refundFailedAt.getTime() + 1);
      await retrying.query(
        `INSERT INTO refund_transactions
           (id, payment_id, replaces_refund_transaction_id,
            replaces_failure_provider_event_id, idempotency_key,
            amount_minor, reason, status, requested_at, created_at, updated_at)
         SELECT $1, source.payment_id, source.id, $2, $3,
                source.amount_minor, source.reason, 'PENDING', $4, $4, $4
         FROM refund_transactions source
         WHERE source.id = $5`,
        [
          retryRefundId,
          failureResultEventId,
          `${scope}:committed-refund-retry`,
          retryRequestedAt,
          refundId,
        ],
      );
      await retrying.query(
        `UPDATE payments SET status = 'REFUND_PENDING', updated_at = $2
         WHERE id = $1`,
        [foundation.paymentId, retryRequestedAt],
      );
      expect(
        (
          await retrying.query<{ claimed_at: Date | null }>(
            `SELECT taven_claim_refund_dispatch($1) AS claimed_at`,
            [retryRefundId],
          )
        ).rows[0]?.claimed_at,
      ).toBeInstanceOf(Date);
      retrySucceededAt = new Date(
        Math.max(Date.now(), retryRequestedAt.getTime() + 1),
      );
      await fixtures.persistRefundProviderEvent(
        retryRefundId,
        "REFUND_SUCCEEDED",
        retryProviderRefundId,
        retrySucceededAt,
        retrySuccessProviderEventId,
        retrySucceededAt,
      );
      retrySuccessResultEventId = fixtures.id(
        `provider-event:${retrySuccessProviderEventId}`,
      );
      await retrying.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_refund_id = $2,
             provider_result_event_id = $3, completed_at = $4, updated_at = $4
         WHERE id = $1`,
        [
          retryRefundId,
          retryProviderRefundId,
          retrySuccessResultEventId,
          retrySucceededAt,
        ],
      );
      await retrying.query(
        `UPDATE payments SET status = 'REFUNDED', updated_at = $2
         WHERE id = $1`,
        [foundation.paymentId, retrySucceededAt],
      );
      await retrying.query(
        `UPDATE order_phases
         SET status = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, retrySucceededAt],
      );
      await retrying.query(
        `UPDATE fulfilment_slots
         SET outcome = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, retrySucceededAt],
      );
      await retrying.query(
        `UPDATE orders SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [foundation.orderId, retrySucceededAt],
      );
      await forceOrderLifecycleConstraints(retrying);
      await retrying.query("COMMIT");
    } catch (error) {
      await retrying.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      retrying.release();
    }

    if (!retrySucceededAt || !retrySuccessResultEventId) {
      throw new Error("committed refund retry success time is unavailable");
    }
    const lateSource = await pool.connect();
    await lateSource.query("BEGIN");
    let lateSourceSuccessResultEventId: string | undefined;
    try {
      const fixtures = new PersistenceFactory(
        lateSource,
        `${scope}:committed-refund-retry`,
      );
      const lateSourceSuccessAt = new Date(
        Math.max(
          Date.now(),
          refundFailedAt.getTime() + 2,
          retrySucceededAt.getTime() + 1,
        ),
      );
      const lateSourceSuccessProviderEventId = `${scope}:committed-refund-source-late-success`;
      await fixtures.persistRefundProviderEvent(
        refundId,
        "REFUND_SUCCEEDED",
        providerRefundId,
        lateSourceSuccessAt,
        lateSourceSuccessProviderEventId,
        lateSourceSuccessAt,
      );
      lateSourceSuccessResultEventId = fixtures.id(
        `provider-event:${lateSourceSuccessProviderEventId}`,
      );
      await lateSource.query(
        `UPDATE refund_transactions
         SET status = 'SUSPENDED', source_success_provider_event_id = $2,
             reconciliation_started_at = $3, completed_at = NULL,
             updated_at = $3
         WHERE id = $1`,
        [retryRefundId, lateSourceSuccessResultEventId, lateSourceSuccessAt],
      );
      await lateSource.query(
        `UPDATE payments SET status = 'REFUND_PENDING', updated_at = $2
         WHERE id = $1`,
        [foundation.paymentId, lateSourceSuccessAt],
      );
      await lateSource.query(
        `UPDATE order_phases SET status = 'CANCELLED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, lateSourceSuccessAt],
      );
      await lateSource.query(
        `UPDATE fulfilment_slots SET outcome = 'CANCELLED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, lateSourceSuccessAt],
      );
      await lateSource.query(
        `UPDATE orders SET status = 'CANCELLED', updated_at = $2 WHERE id = $1`,
        [foundation.orderId, lateSourceSuccessAt],
      );
      await forceOrderLifecycleConstraints(lateSource);
      await lateSource.query("COMMIT");
    } catch (error) {
      await lateSource.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      lateSource.release();
    }

    expect(lateSourceSuccessResultEventId).toBeDefined();
    expect(
      (
        await pool.query<{
          cancelled_slots: string;
          completed_at: Date | null;
          order_status: string;
          payment_status: string;
          phase_status: string;
          provider_result_event_id: string;
          retry_status: string;
          source_receipt_count: string;
          source_status: string;
        }>(
          `SELECT target_order.status::text AS order_status,
                  payment.status::text AS payment_status,
                  phase.status::text AS phase_status,
                  source.status::text AS source_status,
                  retry.status::text AS retry_status,
                  retry.completed_at, retry.provider_result_event_id,
                  (SELECT count(*)::text
                   FROM fulfilment_slots slot
                   WHERE slot.order_id = target_order.id
                     AND slot.outcome = 'CANCELLED') AS cancelled_slots,
                  (SELECT count(*)::text
                   FROM payment_provider_events event
                   WHERE event.id = $4
                     AND event.refund_transaction_id = source.id)
                    AS source_receipt_count
           FROM orders target_order
           JOIN order_phases phase ON phase.order_id = target_order.id
           JOIN payments payment ON payment.order_id = target_order.id
           JOIN refund_transactions source ON source.id = $2
           JOIN refund_transactions retry ON retry.id = $3
           WHERE target_order.id = $1`,
          [
            foundation.orderId,
            refundId,
            retryRefundId,
            lateSourceSuccessResultEventId,
          ],
        )
      ).rows,
    ).toEqual([
      {
        cancelled_slots: "1",
        completed_at: null,
        order_status: "CANCELLED",
        payment_status: "REFUND_PENDING",
        phase_status: "CANCELLED",
        provider_result_event_id: retrySuccessResultEventId,
        retry_status: "SUSPENDED",
        source_receipt_count: "1",
        source_status: "FAILED",
      },
    ]);
  });

  it("scopes external payment identities to their provider", async () => {
    await rollback(
      "provider-scoped-payment-identities",
      async (client, fixtures) => {
        const sharedProviderIntentId = "shared-provider-intent";
        const sharedProviderCaptureId = "shared-provider-capture";
        const checkoutCaptureExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);

        const first = await fixtures.createFoundation("provider-scoped-first");
        const firstProductions = await createCurrentPlan(
          client,
          fixtures,
          first,
        );
        await fixtures.finalizePayment(
          first,
          checkoutCaptureExpiresAt,
          sharedProviderIntentId,
          "provider-a",
        );

        const second = await fixtures.createFoundation(
          "provider-scoped-second",
        );
        const secondProductions = await createCurrentPlan(
          client,
          fixtures,
          second,
        );
        await fixtures.finalizePayment(
          second,
          checkoutCaptureExpiresAt,
          sharedProviderIntentId,
          "provider-b",
        );

        await activateCurrentPlan(
          client,
          fixtures,
          first,
          firstProductions,
          sharedProviderCaptureId,
        );
        await activateCurrentPlan(
          client,
          fixtures,
          second,
          secondProductions,
          sharedProviderCaptureId,
        );

        expect(
          (
            await client.query<{
              provider: string;
              provider_capture_id: string;
              provider_intent_id: string;
            }>(
              `SELECT provider, provider_intent_id, provider_capture_id
             FROM payments WHERE id IN ($1, $2) ORDER BY provider`,
              [first.paymentId, second.paymentId],
            )
          ).rows,
        ).toEqual([
          {
            provider: "provider-a",
            provider_intent_id: sharedProviderIntentId,
            provider_capture_id: sharedProviderCaptureId,
          },
          {
            provider: "provider-b",
            provider_intent_id: sharedProviderIntentId,
            provider_capture_id: sharedProviderCaptureId,
          },
        ]);

        const duplicateIntent = await fixtures.createFoundation(
          "provider-scoped-duplicate-intent",
        );
        await createCurrentPlan(client, fixtures, duplicateIntent);
        await expectQueryError(
          client,
          "duplicate_provider_intent_same_provider",
          () =>
            fixtures.finalizePayment(
              duplicateIntent,
              checkoutCaptureExpiresAt,
              sharedProviderIntentId,
              "provider-a",
            ),
          {
            code: "23505",
            constraint: "payments_provider_provider_intent_id_key",
          },
        );

        const duplicateCapture = await fixtures.createFoundation(
          "provider-scoped-duplicate-capture",
        );
        const duplicateCaptureProductions = await createCurrentPlan(
          client,
          fixtures,
          duplicateCapture,
        );
        await fixtures.finalizePayment(
          duplicateCapture,
          checkoutCaptureExpiresAt,
          "different-provider-intent",
          "provider-a",
        );
        await expectQueryError(
          client,
          "duplicate_provider_capture_same_provider",
          () =>
            activateCurrentPlan(
              client,
              fixtures,
              duplicateCapture,
              duplicateCaptureProductions,
              sharedProviderCaptureId,
            ),
          {
            code: "23505",
            constraint: "payments_provider_provider_capture_id_key",
          },
        );
      },
    );
  });

  it("scopes external refund and shipment identities to their provider", async () => {
    await rollback(
      "provider-scoped-refund-and-shipment-identities",
      async (client, fixtures) => {
        const shipmentFoundation = await fixtures.createFoundation(
          "provider-scoped-shipments",
          {},
          undefined,
          undefined,
          undefined,
          3,
        );
        const shipmentIds = shipmentFoundation.shipmentIds;
        const labelledAt = new Date();
        const labelShipment = (shipmentId: string, carrier: string) =>
          client.query(
            `UPDATE shipments
             SET status = 'LABEL_CREATED', carrier = $2,
                 provider_shipment_id = 'shared-provider-shipment',
                 carrier_label_id = 'label-' || id::text,
                 label_created_at = $3, updated_at = $3
             WHERE id = $1`,
            [shipmentId, carrier, labelledAt],
          );

        const firstShipmentId = shipmentIds[0];
        const secondShipmentId = shipmentIds[1];
        const duplicateShipmentId = shipmentIds[2];
        if (!firstShipmentId || !secondShipmentId || !duplicateShipmentId) {
          throw new Error("provider-scoped shipment fixture is incomplete");
        }
        await labelShipment(firstShipmentId, "carrier-a");
        await expect(
          labelShipment(secondShipmentId, "carrier-b"),
        ).resolves.toBeDefined();
        await expectQueryError(
          client,
          "duplicate_provider_shipment_same_carrier",
          () => labelShipment(duplicateShipmentId, "carrier-a"),
          {
            code: "23505",
            constraint: "shipments_carrier_provider_shipment_id_key",
          },
        );

        const createCapturedPayment = async (
          name: string,
          provider: string,
        ): Promise<PersistenceFoundation> => {
          const foundation = await fixtures.createFoundation(name);
          const productions = await createCurrentPlan(
            client,
            fixtures,
            foundation,
          );
          await fixtures.finalizePayment(
            foundation,
            new Date(Date.now() + 60 * 60 * 1_000),
            `intent-${name}`,
            provider,
          );
          await activateCurrentPlan(
            client,
            fixtures,
            foundation,
            productions,
            `capture-${name}`,
          );
          return foundation;
        };
        const firstPayment = await createCapturedPayment(
          "provider-scoped-refund-first",
          "provider-a",
        );
        const secondPayment = await createCapturedPayment(
          "provider-scoped-refund-second",
          "provider-b",
        );
        const duplicatePayment = await createCapturedPayment(
          "provider-scoped-refund-duplicate",
          "provider-a",
        );
        const providerRefundId = "shared-provider-refund";
        const insertRefund = (foundation: PersistenceFoundation, id: string) =>
          client.query(
            `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                provider_refund_id, requested_at, created_at, updated_at)
             VALUES ($1, $2, $3, 1, 'CUSTOMER_CANCELLATION', 'PENDING',
                     $4, $5, $5, $5)`,
            [
              id,
              foundation.paymentId,
              `idempotency-${id}`,
              providerRefundId,
              new Date(),
            ],
          );

        await insertRefund(
          firstPayment,
          fixtures.id("provider-scoped-refund-first"),
        );
        await expect(
          insertRefund(
            secondPayment,
            fixtures.id("provider-scoped-refund-second"),
          ),
        ).resolves.toBeDefined();
        expect(
          (
            await client.query<{
              provider: string;
              provider_refund_id: string;
            }>(
              `SELECT refund.provider, refund.provider_refund_id
               FROM refund_transactions refund
               WHERE refund.provider_refund_id = $1
               ORDER BY refund.provider`,
              [providerRefundId],
            )
          ).rows,
        ).toEqual([
          { provider: "provider-a", provider_refund_id: providerRefundId },
          { provider: "provider-b", provider_refund_id: providerRefundId },
        ]);
        await expectQueryError(
          client,
          "duplicate_provider_refund_same_provider",
          () =>
            insertRefund(
              duplicatePayment,
              fixtures.id("provider-scoped-refund-duplicate"),
            ),
          {
            code: "23505",
            constraint: "refund_transactions_provider_provider_refund_id_key",
          },
        );
      },
    );
  });

  it("persists a pending compensation capture directly as refund pending", async () => {
    await rollback("pending-capture-compensation", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "pending-capture-compensation",
      );
      await createCurrentPlanAndPayment(client, fixtures, foundation);
      await cancelOrderBeforeHandoff(client, foundation.orderId);
      const captureCutoffAt = (
        await client.query<{ capture_cutoff_at: Date }>(
          `SELECT capture_cutoff_at FROM payments WHERE id = $1`,
          [foundation.paymentId],
        )
      ).rows[0]?.capture_cutoff_at;
      expect(captureCutoffAt).toBeInstanceOf(Date);
      const capturedAt = new Date(captureCutoffAt!.getTime() + 1);
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
      await expectQueryError(
        client,
        "misclassify_late_capture_as_customer_cancellation",
        async () => {
          await fixtures.persistPaymentProviderEvent(
            foundation.paymentId,
            "PAYMENT_CAPTURED",
            "misclassified-late-provider-capture",
            capturedAt,
          );
          await client.query(
            `UPDATE payments
             SET status = 'REFUND_PENDING',
                 captured_amount_minor = requested_amount_minor,
                 provider_capture_id = $2, captured_at = $3
             WHERE id = $1`,
            [
              foundation.paymentId,
              "misclassified-late-provider-capture",
              capturedAt,
            ],
          );
          await client.query(
            `INSERT INTO refund_transactions
             (id, payment_id, idempotency_key, amount_minor, reason, status,
              requested_at, created_at, updated_at)
             SELECT $1, id, $2, requested_amount_minor,
                    'CUSTOMER_CANCELLATION', 'PENDING', $3, $3, $3
             FROM payments WHERE id = $4`,
            [
              fixtures.id("misclassified-late-capture-refund"),
              "misclassified-late-capture-refund",
              capturedAt,
              foundation.paymentId,
            ],
          );
        },
        {
          code: "23514",
          constraint: "late_capture_compensation_reason_check",
        },
      );
      await fixtures.persistPaymentProviderEvent(
        foundation.paymentId,
        "PAYMENT_CAPTURED",
        "late-provider-capture",
        capturedAt,
      );
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
                'LATE_CAPTURE_COMPENSATION', 'PENDING', $3, $3, $3
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
                         "refund_transactions_payment_status_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{
            capture_matches_request: boolean;
            captured_at: Date;
            provider_capture_id: string;
            refund_reason: string;
            status: string;
          }>(
            `SELECT payment.status::text,
                    payment.captured_amount_minor = payment.requested_amount_minor
                      AS capture_matches_request,
                    payment.provider_capture_id, payment.captured_at,
                    refund.reason::text AS refund_reason
             FROM payments payment
             JOIN refund_transactions refund ON refund.payment_id = payment.id
             WHERE payment.id = $1`,
            [foundation.paymentId],
          )
        ).rows,
      ).toEqual([
        {
          status: "REFUND_PENDING",
          capture_matches_request: true,
          provider_capture_id: "late-provider-capture",
          captured_at: capturedAt,
          refund_reason: "LATE_CAPTURE_COMPENSATION",
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
      const failedAt = new Date();
      const failedProviderRefundId = "atomic-pending-refund-failed";
      await expectQueryError(
        client,
        "fail_refund_without_provider_receipt",
        () =>
          client.query(
            `UPDATE refund_transactions
             SET status = 'FAILED', provider_refund_id = $2,
                 updated_at = $3 WHERE id = $1`,
            [refundId, failedProviderRefundId, failedAt],
          ),
        {
          code: "23514",
          constraint: "refund_failure_provider_receipt_check",
        },
      );
      await expectQueryError(
        client,
        "fail_refund_without_payment_restore",
        async () => {
          await fixtures.persistRefundProviderEvent(
            refundId,
            "REFUND_FAILED",
            failedProviderRefundId,
            failedAt,
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'FAILED', provider_refund_id = $2,
                 updated_at = $3 WHERE id = $1`,
            [refundId, failedProviderRefundId, failedAt],
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

      await fixtures.persistRefundProviderEvent(
        refundId,
        "REFUND_FAILED",
        failedProviderRefundId,
        failedAt,
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'FAILED', provider_refund_id = $2,
             updated_at = $3 WHERE id = $1`,
        [refundId, failedProviderRefundId, failedAt],
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

      await expectQueryError(
        client,
        "reopen_failed_refund_pending",
        () =>
          client.query(
            `UPDATE refund_transactions SET status = 'PENDING' WHERE id = $1`,
            [refundId],
          ),
        {
          code: "23514",
          constraint: "refund_transaction_failed_immutable_check",
        },
      );
      await expectQueryError(
        client,
        "reconcile_failed_refund_without_success_receipt",
        () =>
          client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', completed_at = $2, updated_at = $2
             WHERE id = $1`,
            [refundId, new Date()],
          ),
        {
          code: "23514",
          constraint: "refund_success_provider_receipt_check",
        },
      );

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
      await expectQueryError(
        client,
        "disable_capture_without_cutoff",
        () =>
          client.query(
            `UPDATE payments SET capture_authorized = false WHERE id = $1`,
            [unauthorized.paymentId],
          ),
        { code: "23514", constraint: "payment_capture_window_check" },
      );
      await expectQueryError(
        client,
        "future_capture_cutoff",
        () =>
          client.query(
            `UPDATE payments
             SET status = 'VOIDED', capture_authorized = false,
                 capture_cutoff_at = clock_timestamp() + interval '1 hour'
             WHERE id = $1`,
            [unauthorized.paymentId],
          ),
        {
          code: "23514",
          constraint: "payment_capture_cutoff_evidence_check",
        },
      );
      await client.query(
        `UPDATE payments
         SET capture_authorized = false, capture_cutoff_at = $2
         WHERE id = $1`,
        [unauthorized.paymentId, new Date()],
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
        [expired.paymentId, new Date()],
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

      const extended = await fixtures.createFoundation(
        "extended-capture-expiry",
      );
      await createCurrentPlan(client, fixtures, extended);
      const extendedCreatedAt = new Date();
      await expectQueryError(
        client,
        "create_extended_checkout_capture",
        () =>
          fixtures.finalizePayment(
            extended,
            new Date(extendedCreatedAt.getTime() + 61 * 60 * 1_000),
            "extended-capture-intent",
            "test",
            extendedCreatedAt,
          ),
        { code: "23514", constraint: "payment_capture_window_check" },
      );

      const overlongReservation = await fixtures.createFoundation(
        "overlong-payment-reservation",
      );
      const reservationCreatedAt = new Date();
      await createCurrentPlan(
        client,
        fixtures,
        overlongReservation,
        new Date(reservationCreatedAt.getTime() + 16 * 60 * 1_000),
        overlongReservation.orderId,
        0,
        reservationCreatedAt,
      );
      await expectQueryError(
        client,
        "create_payment_with_overlong_reservation",
        () => fixtures.finalizePayment(overlongReservation),
        {
          code: "23514",
          constraint: "payment_fulfilment_topology_check",
        },
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
      const reservationCreatedAt = new Date();
      const reservationExpiresAt = new Date(
        reservationCreatedAt.getTime() + 15 * 60 * 1_000,
      );
      await fixtures.createResourcePlan(foundation, [production]);
      await fixtures.createPhaseReservationSet(
        foundation,
        reservationExpiresAt,
        "BUILDING",
        reservationCreatedAt,
      );
      await fixtures.createProductionReservation(
        foundation,
        production,
        "RESERVED",
        {},
        null,
        reservationExpiresAt,
        reservationCreatedAt,
      );
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
          reservationExpiresAt,
          reservationCreatedAt,
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
          reservationExpiresAt,
          reservationCreatedAt,
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

  it("binds confirmation and phase activation evidence to payment capture time", async () => {
    await rollback(
      "capture-activation-chronology",
      async (client, fixtures) => {
        for (const [name, staleOrder, stalePhase] of [
          ["stale-order-confirmation", true, false],
          ["stale-phase-activation", false, true],
        ] as const) {
          await expectQueryError(
            client,
            `capture_after_${name.replaceAll("-", "_")}`,
            async () => {
              const foundation = await fixtures.createFoundation(name);
              const productions = await createCurrentPlanAndPayment(
                client,
                fixtures,
                foundation,
              );
              await holdCurrentPlan(client, fixtures, foundation, productions);
              const capturedAt = new Date();
              const staleAt = new Date(capturedAt.getTime() - 60_000);
              await client.query(
                `UPDATE orders
                 SET status = 'CONFIRMED', confirmed_at = $2, updated_at = $2
                 WHERE id = $1`,
                [foundation.orderId, staleOrder ? staleAt : capturedAt],
              );
              await client.query(
                `UPDATE order_phases
                 SET status = 'ACTIVE', activated_at = $2, updated_at = $2
                 WHERE id = $1`,
                [foundation.orderPhaseId, stalePhase ? staleAt : capturedAt],
              );
              await fixtures.capturePayment(foundation, undefined, capturedAt);
              await forceCaptureActivationConstraints(client);
            },
            { code: "23514", constraint: "payment_capture_activation_check" },
          );
        }

        const tolerated = await fixtures.createFoundation(
          "tolerated-capture-activation-skew",
        );
        const toleratedProductions = await createCurrentPlanAndPayment(
          client,
          fixtures,
          tolerated,
        );
        await holdCurrentPlan(
          client,
          fixtures,
          tolerated,
          toleratedProductions,
        );
        const capturedAt = new Date();
        const toleratedActivationAt = new Date(capturedAt.getTime() - 2_000);
        await client.query(
          `UPDATE orders
           SET status = 'CONFIRMED', confirmed_at = $2, updated_at = $2
           WHERE id = $1`,
          [tolerated.orderId, toleratedActivationAt],
        );
        await client.query(
          `UPDATE order_phases
           SET status = 'ACTIVE', activated_at = $2, updated_at = $2
           WHERE id = $1`,
          [tolerated.orderPhaseId, toleratedActivationAt],
        );
        await fixtures.capturePayment(tolerated, undefined, capturedAt);
        await expect(
          forceCaptureActivationConstraints(client),
        ).resolves.toBeUndefined();
      },
    );
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

      const staleResourceQuote = await fixtures.createFoundation(
        "stale-resource-quote",
      );
      const stalePaymentQuote = await fixtures.createFoundation(
        "stale-payment-quote",
      );
      await createCurrentPlan(client, fixtures, stalePaymentQuote);
      const activeCheckout = await fixtures.createFoundation(
        "active-checkout-after-quote-expiry",
      );
      await createCurrentPlanAndPayment(client, fixtures, activeCheckout);
      const failedCheckout = await fixtures.createFoundation(
        "failed-checkout-before-quote-expiry",
      );
      await createCurrentPlanAndPayment(client, fixtures, failedCheckout);
      const failedAt = new Date();
      await fixtures.persistPaymentFailureEvent(
        failedCheckout.paymentId,
        failedAt,
      );
      await client.query(
        `UPDATE payments
         SET status = 'FAILED', capture_authorized = false,
             capture_cutoff_at = $2, updated_at = $2
         WHERE id = $1`,
        [failedCheckout.paymentId, failedAt],
      );
      const sessionExpiry = (
        await client.query<{ expires_at: Date }>(
          `SELECT clock_timestamp() + interval '1 second' AS expires_at`,
        )
      ).rows[0]?.expires_at;
      if (!sessionExpiry) {
        throw new Error("quote session expiry fixture is missing");
      }
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE quote_sessions
         SET expires_at = $1
         WHERE id = ANY($2::uuid[])`,
        [
          sessionExpiry,
          [
            staleResourceQuote.quoteSessionId,
            stalePaymentQuote.quoteSessionId,
            activeCheckout.quoteSessionId,
            failedCheckout.quoteSessionId,
          ],
        ],
      );
      await client.query(`SET LOCAL session_replication_role = 'origin'`);
      await client.query(
        `SELECT pg_sleep(
           greatest(extract(epoch FROM $1::timestamptz - clock_timestamp()), 0)
           + 0.05
         )`,
        [sessionExpiry],
      );
      expect(
        (
          await client.query<{
            transaction_time_accepts: boolean;
            wall_clock_expired: boolean;
          }>(
            `SELECT $1::timestamptz > CURRENT_TIMESTAMP AS transaction_time_accepts,
                    $1::timestamptz <= clock_timestamp() AS wall_clock_expired`,
            [sessionExpiry],
          )
        ).rows,
      ).toEqual([{ transaction_time_accepts: true, wall_clock_expired: true }]);
      await expectQueryError(
        client,
        "expired_quote_resource_plan",
        () => createCurrentPlan(client, fixtures, staleResourceQuote),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
      await expectQueryError(
        client,
        "expired_quote_payment",
        () => fixtures.finalizePayment(stalePaymentQuote),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
      const retryCreatedAt = new Date();
      const retryExpiresAt = new Date(
        retryCreatedAt.getTime() + 60 * 60 * 1_000,
      );
      await expectQueryError(
        client,
        "expired_quote_failed_payment_retry",
        () =>
          client.query(
            `INSERT INTO payments
               (id, order_id, price_snapshot_id, order_price_binding_id,
                payment_schedule_id, role, provider,
                requested_amount_minor, currency, status,
                checkout_capture_expires_at, created_at, updated_at)
             SELECT $1, order_id, price_snapshot_id, order_price_binding_id,
                    payment_schedule_id, role, provider,
                    requested_amount_minor, currency, 'CREATED', $2, $3, $3
             FROM payments WHERE id = $4`,
            [
              fixtures.id("expired-quote-payment-retry"),
              retryExpiresAt,
              retryCreatedAt,
              failedCheckout.paymentId,
            ],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
      await expect(
        client.query(`SELECT taven_lock_automatic_order_session($1)`, [
          activeCheckout.orderId,
        ]),
      ).resolves.toBeDefined();
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
             SET status = 'ACCEPTED', accepted_at = $2,
                 payout_amount = 0, payout_currency = 'EUR', updated_at = $2
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
        `UPDATE jobs SET status = 'ACCEPTED', accepted_at = $2,
                         payout_amount = 0, payout_currency = 'EUR', updated_at = $2
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
             SET status = 'ACCEPTED', accepted_at = $2,
                 payout_amount = 0, payout_currency = 'EUR', updated_at = $2
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
             SET status = 'ACCEPTED', accepted_at = $2,
                 payout_amount = 0, payout_currency = 'EUR', updated_at = $2
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
        `UPDATE jobs SET status = 'ACCEPTED', accepted_at = $2,
                         payout_amount = 0, payout_currency = 'EUR', updated_at = $2
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
      const secondShipmentId = foundation.shipmentIds[1];
      if (!first || !second || !firstShipmentId || !secondShipmentId) {
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

      await expectQueryError(
        client,
        "deliver_with_packed_plan_job",
        async () => {
          const deliveredAt = new Date();
          await client.query(
            `UPDATE shipments
             SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
             WHERE id = $1`,
            [secondShipmentId, deliveredAt],
          );
          for (const targetShipmentId of [firstShipmentId, secondShipmentId]) {
            await persistVerifiedShipmentOutcome(
              client,
              targetShipmentId,
              "TRANSIT_SCAN",
              deliveredAt,
            );
            await persistVerifiedShipmentOutcome(
              client,
              targetShipmentId,
              "DELIVERY_SCAN",
              deliveredAt,
            );
          }
          await client.query(
            `UPDATE fulfilment_slots
             SET outcome = 'DELIVERED', updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, deliveredAt],
          );
          await client.query(
            `UPDATE order_phases
             SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
             WHERE id = $1`,
            [foundation.orderPhaseId, deliveredAt],
          );
          await client.query(
            `UPDATE orders
             SET status = 'DELIVERED', updated_at = $2 WHERE id = $1`,
            [foundation.orderId, deliveredAt],
          );
          await forceOrderLifecycleConstraints(client);
        },
        {
          code: "23514",
          constraint: "order_post_confirmation_lifecycle_check",
        },
      );
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

      await expectQueryError(
        client,
        "skip_transit_before_delivery",
        () =>
          client.query(
            `UPDATE shipments
             SET status = 'DELIVERED', delivered_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [shipmentId],
          ),
        {
          code: "23514",
          constraint: "shipment_delivery_scan_confirmation_check",
        },
      );
      await expectQueryError(
        client,
        "transit_without_provider_scan",
        () =>
          client.query(
            `UPDATE shipments
             SET status = 'IN_TRANSIT', updated_at = clock_timestamp()
             WHERE id = $1`,
            [shipmentId],
          ),
        {
          code: "23514",
          constraint: "shipment_transit_scan_confirmation_check",
        },
      );
      await expectQueryError(
        client,
        "delivery_without_provider_scan",
        async () => {
          await persistVerifiedShipmentOutcome(
            client,
            shipmentId,
            "TRANSIT_SCAN",
          );
          await client.query(
            `UPDATE shipments
             SET status = 'DELIVERED', delivered_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [shipmentId],
          );
        },
        {
          code: "23514",
          constraint: "shipment_delivery_scan_confirmation_check",
        },
      );
    });
  });

  it("reconciles a delivery scan directly from handed-over custody", async () => {
    await rollback("delivery-before-transit", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "delivery-before-transit",
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
      const shipmentId = foundation.shipmentIds[0];
      if (!shipmentId || foundation.shipmentIds.length !== 1) {
        throw new Error("direct-delivery fixture requires one Shipment");
      }
      const acceptanceEventId = "delivery-before-transit-acceptance";
      const handedOverAt = await persistVerifiedAcceptanceScan(
        client,
        shipmentId,
        acceptanceEventId,
      );
      await client.query(
        `UPDATE jobs
         SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, handedOverAt],
      );
      await client.query(
        `UPDATE shipments
         SET status = 'HANDED_OVER', provider_acceptance_scan_id = $2,
             handed_over_at = $3, updated_at = $3
         WHERE id = $1`,
        [shipmentId, acceptanceEventId, handedOverAt],
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
      const before = (
        await client.query<{
          handed_over_at: Date;
          provider_acceptance_scan_id: string;
        }>(
          `SELECT handed_over_at, provider_acceptance_scan_id
           FROM shipments
           WHERE id = $1`,
          [shipmentId],
        )
      ).rows[0];
      if (!before) throw new Error("handed-over Shipment is unavailable");
      const deliveredAt = new Date(before.handed_over_at.getTime() + 1_000);

      await persistVerifiedShipmentOutcome(
        client,
        shipmentId,
        "DELIVERY_SCAN",
        deliveredAt,
      );
      await advanceOrderLifecycleStep(
        client,
        foundation.orderId,
        "DELIVERED",
        deliveredAt,
      );

      const outcome = (
        await client.query<{
          status: string;
          handed_over_at: Date;
          delivered_at: Date;
          provider_acceptance_scan_id: string;
          transit_count: string;
          delivery_count: string;
        }>(
          `SELECT shipment.status, shipment.handed_over_at,
                  shipment.delivered_at, shipment.provider_acceptance_scan_id,
                  count(*) FILTER (WHERE event.kind = 'TRANSIT_SCAN')::text AS transit_count,
                  count(*) FILTER (WHERE event.kind = 'DELIVERY_SCAN')::text AS delivery_count
           FROM shipments shipment
           LEFT JOIN shipment_provider_events event
             ON event.shipment_id = shipment.id
           WHERE shipment.id = $1
           GROUP BY shipment.id`,
          [shipmentId],
        )
      ).rows[0];
      expect(outcome).toMatchObject({
        status: "DELIVERED",
        provider_acceptance_scan_id: before.provider_acceptance_scan_id,
        transit_count: "0",
        delivery_count: "1",
      });
      expect(outcome?.handed_over_at.toISOString()).toBe(
        before.handed_over_at.toISOString(),
      );
      expect(outcome?.delivered_at.toISOString()).toBe(
        deliveredAt.toISOString(),
      );
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
      const cancelledAt = (
        await client.query<{ cancellation_requested_at: Date }>(
          `UPDATE shipments
         SET status = 'CANCELLATION_PENDING',
             cancellation_requested_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING cancellation_requested_at`,
          [replacedShipmentId],
        )
      ).rows[0]?.cancellation_requested_at;
      if (!cancelledAt) {
        throw new Error("replacement cancellation timestamp is unavailable");
      }
      await confirmCarrierLabelVoid(
        client,
        replacedShipmentId,
        "replacement-provider-void",
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
             carrier_label_id = 'label-' || id::text,
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
          await persistVerifiedShipmentOutcome(
            client,
            firstShipmentId,
            "TRANSIT_SCAN",
            deliveredAt,
          );
          await persistVerifiedShipmentOutcome(
            client,
            firstShipmentId,
            "DELIVERY_SCAN",
            deliveredAt,
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
      const duplicateProviderEventId = `duplicate-provider-event:${randomUUID()}`;
      await expectQueryError(
        client,
        "duplicate_carrier_provider_event",
        async () => {
          for (const transactionId of ["first", "second"]) {
            await client.query(
              `INSERT INTO shipment_provider_events
                 (id, shipment_id, carrier, carrier_label_id,
                  provider_event_id, provider_transaction_id, kind,
                  occurred_at, authenticated_at, verified_at, created_at)
               SELECT $1, shipment.id, shipment.carrier,
                      shipment.carrier_label_id, $3, $4, 'TRANSIT_SCAN',
                      $5, $5, $5, $5
               FROM shipments shipment WHERE shipment.id = $2`,
              [
                randomUUID(),
                firstShipmentId,
                duplicateProviderEventId,
                `duplicate-event:${transactionId}`,
                deliveredAt,
              ],
            );
          }
        },
        {
          code: "23505",
          constraint: "shipment_provider_events_carrier_provider_event_id_key",
        },
      );
      const sharedProviderTransactionId = `shipment-delivery:${randomUUID()}`;
      const repeatedTransitAt = new Date(deliveredAt.getTime() + 1);
      const mismatchedDeliveryScanAt = new Date(deliveredAt.getTime() + 2);
      const mismatchedDeliveredAt = new Date(deliveredAt.getTime() + 3);
      const firstDeliveryAt = new Date(deliveredAt.getTime() + 4);
      const repeatedDeliveryAt = new Date(deliveredAt.getTime() + 5);
      await persistVerifiedShipmentOutcome(
        client,
        firstShipmentId,
        "TRANSIT_SCAN",
        deliveredAt,
        sharedProviderTransactionId,
      );
      await persistVerifiedShipmentOutcome(
        client,
        firstShipmentId,
        "TRANSIT_SCAN",
        repeatedTransitAt,
        sharedProviderTransactionId,
        false,
      );
      await expectQueryError(
        client,
        "delivery_timestamp_mismatch",
        async () => {
          await client.query(
            `INSERT INTO shipment_provider_events
               (id, shipment_id, carrier, carrier_label_id,
                provider_event_id, provider_transaction_id, kind,
                occurred_at, authenticated_at, verified_at, created_at)
             SELECT $1, shipment.id, shipment.carrier,
                    shipment.carrier_label_id, $3, $4, 'DELIVERY_SCAN',
                    $5, $5, $5, $5
             FROM shipments shipment WHERE shipment.id = $2`,
            [
              randomUUID(),
              firstShipmentId,
              `mismatched-delivery:${randomUUID()}`,
              sharedProviderTransactionId,
              mismatchedDeliveryScanAt,
            ],
          );
          await client.query(
            `UPDATE shipments
             SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
             WHERE id = $1`,
            [firstShipmentId, mismatchedDeliveredAt],
          );
        },
        {
          code: "23514",
          constraint: "shipment_delivery_scan_confirmation_check",
        },
      );
      await persistVerifiedShipmentOutcome(
        client,
        firstShipmentId,
        "DELIVERY_SCAN",
        firstDeliveryAt,
        sharedProviderTransactionId,
      );
      await persistVerifiedShipmentOutcome(
        client,
        firstShipmentId,
        "DELIVERY_SCAN",
        repeatedDeliveryAt,
        sharedProviderTransactionId,
        false,
      );
      expect(
        (
          await client.query<{
            event_count: string;
            status: string;
            delivery_timestamp_preserved: boolean;
          }>(
            `SELECT count(event.id)::text AS event_count,
                    shipment.status::text AS status,
                    shipment.delivered_at = $3 AS delivery_timestamp_preserved
             FROM shipments shipment
             JOIN shipment_provider_events event
               ON event.shipment_id = shipment.id
             WHERE shipment.id = $1 AND event.provider_transaction_id = $2
             GROUP BY shipment.status, shipment.delivered_at`,
            [firstShipmentId, sharedProviderTransactionId, firstDeliveryAt],
          )
        ).rows,
      ).toEqual([
        {
          event_count: "4",
          status: "DELIVERED",
          delivery_timestamp_preserved: true,
        },
      ]);
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
          const remainingShipmentIds = (
            await client.query<{ id: string }>(
              `SELECT id FROM shipments
               WHERE order_id = $1 AND status = 'HANDED_OVER'`,
              [foundation.orderId],
            )
          ).rows.map(({ id }) => id);
          for (const shipmentId of remainingShipmentIds) {
            await persistVerifiedShipmentOutcome(
              client,
              shipmentId,
              "TRANSIT_SCAN",
              finalDeliveredAt,
            );
            await persistVerifiedShipmentOutcome(
              client,
              shipmentId,
              "DELIVERY_SCAN",
              finalDeliveredAt,
            );
          }
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
        "accept_job_without_payout_snapshot",
        () =>
          client.query(
            `UPDATE jobs
             SET status = 'ACCEPTED', accepted_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, new Date()],
          ),
        { code: "23514", constraint: "job_lifecycle_evidence_check" },
      );
      await expectQueryError(
        client,
        "accept_job_with_invalid_payout_snapshot",
        () =>
          client.query(
            `UPDATE jobs
             SET status = 'ACCEPTED', accepted_at = $2,
                 payout_amount = -1, payout_currency = 'eur', updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, new Date()],
          ),
        { code: "23514", constraint: "jobs_payout_acceptance_check" },
      );
      await expectQueryError(
        client,
        "skip_gcode_ready",
        async () => {
          const transitionedAt = new Date();
          await client.query(
            `UPDATE jobs
             SET status = 'ACCEPTED', accepted_at = $2,
                 payout_amount = 0, payout_currency = 'EUR', updated_at = $2
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
             SET status = 'ACCEPTED', accepted_at = $2,
                 payout_amount = 0, payout_currency = 'EUR', updated_at = $2
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
             SET status = 'ACCEPTED', accepted_at = $2,
                 payout_amount = 0, payout_currency = 'EUR', printing_at = $2,
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
                 carrier_label_id = 'premature-label',
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
          expect(
            (
              await client.query<{
                payout_amount: string;
                payout_currency: string;
              }>(
                `SELECT payout_amount::text, payout_currency
                 FROM jobs WHERE order_id = $1`,
                [foundation.orderId],
              )
            ).rows,
          ).toEqual([{ payout_amount: "0", payout_currency: "EUR" }]);
          await expectQueryError(
            client,
            "mutate_accepted_job_payout",
            () =>
              client.query(
                `UPDATE jobs SET payout_amount = 1 WHERE order_id = $1`,
                [foundation.orderId],
              ),
            { code: "23514", constraint: "job_lifecycle_immutable_check" },
          );
          await expectQueryError(
            client,
            "deliver_while_order_in_production",
            async () => {
              const deliveredAt = new Date();
              await client.query(
                `UPDATE shipments
                 SET status = 'LABEL_CREATED', carrier = 'test-carrier',
                     provider_shipment_id = 'provider-premature-delivery',
                     carrier_label_id = 'label-premature-delivery',
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
              for (const shipmentId of foundation.shipmentIds) {
                await persistVerifiedShipmentOutcome(
                  client,
                  shipmentId,
                  "TRANSIT_SCAN",
                  deliveredAt,
                );
                await persistVerifiedShipmentOutcome(
                  client,
                  shipmentId,
                  "DELIVERY_SCAN",
                  deliveredAt,
                );
              }
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
            "handoff_job_before_shipment",
            async () => {
              const handedOverAt = new Date();
              await client.query(
                `UPDATE jobs
                 SET status = 'PACKED', packed_at = $2, updated_at = $2
                 WHERE order_id = $1`,
                [foundation.orderId, handedOverAt],
              );
              await client.query(
                `UPDATE jobs
                 SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
                 WHERE order_id = $1`,
                [foundation.orderId, handedOverAt],
              );
              await forceOrderLifecycleConstraints(client);
            },
            {
              code: "23514",
              constraint: "order_post_confirmation_lifecycle_check",
            },
          );
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
            "issued_label_direct_cancellation",
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
              constraint: "shipment_status_transition_check",
            },
          );
        }
        if (status === "SHIPPED") {
          await expectQueryError(
            client,
            "settle_job_before_delivery",
            async () => {
              const settledAt = new Date();
              await client.query(
                `UPDATE jobs
                 SET status = 'SETTLED', settled_at = $2, updated_at = $2
                 WHERE order_id = $1`,
                [foundation.orderId, settledAt],
              );
              await forceOrderLifecycleConstraints(client);
            },
            {
              code: "23514",
              constraint: "order_post_confirmation_lifecycle_check",
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

  it("keeps issued-label cancellation pending until the carrier void is confirmed", async () => {
    await rollback("shipment-label-void", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("shipment-label-void");
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(client, fixtures, foundation, productions);
      await expectQueryError(
        client,
        "planned_shipment_cancellation_before_creation",
        () =>
          client.query(
            `UPDATE shipments
             SET status = 'CANCELLED',
                 cancelled_at = created_at - interval '1 millisecond',
                 updated_at = created_at
             WHERE id = $1`,
            [foundation.shipmentId],
          ),
        {
          code: "23514",
          constraint: "shipments_timestamps_check",
        },
      );
      await advanceOrderLifecycleStep(
        client,
        foundation.orderId,
        "IN_PRODUCTION",
      );
      await advanceOrderLifecycleStep(client, foundation.orderId, "QC_PASSED");
      await advanceOrderLifecycleStep(
        client,
        foundation.orderId,
        "READY_TO_SHIP",
      );

      await expectQueryError(
        client,
        "cancel_issued_label_directly",
        () =>
          client.query(
            `UPDATE shipments
             SET status = 'CANCELLED', cancelled_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [foundation.shipmentId],
          ),
        { code: "23514", constraint: "shipment_status_transition_check" },
      );

      await expectQueryError(
        client,
        "future_label_void_request",
        () =>
          client.query(
            `UPDATE shipments
             SET status = 'CANCELLATION_PENDING',
                 cancellation_requested_at = clock_timestamp() + interval '1 minute',
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [foundation.shipmentId],
          ),
        { code: "23514", constraint: "shipment_lifecycle_evidence_check" },
      );

      await client.query(
        `UPDATE shipments
         SET status = 'CANCELLATION_PENDING',
             cancellation_requested_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [foundation.shipmentId],
      );
      await forceOrderLifecycleConstraints(client);

      expect(
        (
          await client.query<{
            job_status: string;
            order_status: string;
            outbox_key: string;
            outbox_payload: Record<string, string>;
            outbox_status: string;
            payment_status: string;
            phase_status: string;
            refund_count: string;
            reservation_status: string;
            shipment_status: string;
            slot_outcome: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                    phase.status::text AS phase_status,
                    job.status::text AS job_status,
                    reservation_set.status::text AS reservation_status,
                    shipment.status::text AS shipment_status,
                    slot.outcome::text AS slot_outcome,
                    message.deduplication_key AS outbox_key,
                    message.payload AS outbox_payload,
                    message.status::text AS outbox_status,
                    payment.status::text AS payment_status,
                    (SELECT count(*)::text
                     FROM refund_transactions refund
                     WHERE refund.payment_id = payment.id) AS refund_count
             FROM orders target_order
             JOIN order_phases phase ON phase.order_id = target_order.id
             JOIN jobs job ON job.order_phase_id = phase.id
             JOIN phase_resource_plans resource_plan
               ON resource_plan.order_phase_id = phase.id
             JOIN phase_reservation_sets reservation_set
               ON reservation_set.phase_resource_plan_id = resource_plan.id
              AND reservation_set.node_id = resource_plan.node_id
             JOIN shipments shipment ON shipment.order_id = target_order.id
             JOIN fulfilment_slots slot ON slot.order_id = target_order.id
             JOIN outbox_messages message
               ON message.deduplication_key =
                  'void_carrier_label:' || shipment.id::text || ':' || shipment.carrier_label_id
             JOIN payments payment ON payment.order_id = target_order.id
             WHERE target_order.id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "READY_TO_SHIP",
          phase_status: "QC_PASSED",
          job_status: "PACKED",
          reservation_status: "HELD",
          shipment_status: "CANCELLATION_PENDING",
          slot_outcome: "PENDING",
          outbox_key: `void_carrier_label:${foundation.shipmentId}:label-${foundation.shipmentId}`,
          outbox_payload: {
            shipmentId: foundation.shipmentId,
            carrierLabelId: `label-${foundation.shipmentId}`,
            action: "void_carrier_label",
          },
          outbox_status: "PENDING",
          payment_status: "CAPTURED",
          refund_count: "0",
        },
      ]);

      await expectQueryError(
        client,
        "finish_parent_cancellation_before_label_void",
        () => cancelOrderBeforeHandoff(client, foundation.orderId),
        {
          code: "23514",
          constraint: "order_post_confirmation_lifecycle_check",
        },
      );
      await expectQueryError(
        client,
        "cancel_without_provider_void",
        () =>
          client.query(
            `UPDATE shipments
             SET status = 'CANCELLED', cancelled_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [foundation.shipmentId],
          ),
        { code: "23514", constraint: "shipment_lifecycle_evidence_check" },
      );
      await expectQueryError(
        client,
        "cancel_with_blank_provider_void",
        () =>
          client.query(
            `UPDATE shipments
             SET status = 'CANCELLED', provider_void_id = '   ',
                 provider_voided_at = clock_timestamp(),
                 cancelled_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1`,
            [foundation.shipmentId],
          ),
        { code: "23514", constraint: "shipment_lifecycle_evidence_check" },
      );
      await expectQueryError(
        client,
        "cancel_with_future_provider_void",
        () =>
          client.query(
            `UPDATE shipments
             SET status = 'CANCELLED', provider_void_id = 'future-void',
                 provider_voided_at = clock_timestamp() + interval '1 minute',
                 cancelled_at = clock_timestamp() + interval '1 minute',
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [foundation.shipmentId],
          ),
        { code: "23514", constraint: "shipment_lifecycle_evidence_check" },
      );

      await expectQueryError(
        client,
        "confirm_void_while_outbox_pending",
        () =>
          client.query(
            `INSERT INTO shipment_provider_events
               (id, shipment_id, outbox_message_id, carrier, carrier_label_id,
                provider_event_id, provider_transaction_id, kind, occurred_at,
                authenticated_at, verified_at, created_at)
             SELECT $1, shipment.id, message.id, shipment.carrier,
                    shipment.carrier_label_id, 'premature-provider-void',
                    'premature-provider-void:transaction', 'LABEL_VOIDED',
                    statement_timestamp(), statement_timestamp(),
                    statement_timestamp(), statement_timestamp()
             FROM shipments shipment
             JOIN outbox_messages message
               ON message.deduplication_key =
                  'void_carrier_label:' || shipment.id::text || ':' || shipment.carrier_label_id
             WHERE shipment.id = $2`,
            [randomUUID(), foundation.shipmentId],
          ),
        {
          code: "23514",
          constraint: "shipment_provider_event_outbox_check",
        },
      );
      await expectQueryError(
        client,
        "future_provider_event_creation",
        async () => {
          await client.query(
            `UPDATE outbox_messages
             SET status = 'DELIVERED', delivered_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE deduplication_key =
                   'void_carrier_label:' || $1::text || ':label-' || $1::text`,
            [foundation.shipmentId],
          );
          await client.query(
            `INSERT INTO shipment_provider_events
               (id, shipment_id, outbox_message_id, carrier, carrier_label_id,
                provider_event_id, provider_transaction_id, kind, occurred_at,
                authenticated_at, verified_at, created_at)
             SELECT $1, shipment.id, message.id, shipment.carrier,
                    shipment.carrier_label_id, 'future-created-provider-void',
                    'future-created-provider-void:transaction', 'LABEL_VOIDED',
                    statement_timestamp(), statement_timestamp(),
                    statement_timestamp(),
                    statement_timestamp() + interval '60 seconds'
             FROM shipments shipment
             JOIN outbox_messages message
               ON message.deduplication_key =
                  'void_carrier_label:' || shipment.id::text || ':' || shipment.carrier_label_id
             WHERE shipment.id = $2`,
            [randomUUID(), foundation.shipmentId],
          );
        },
        {
          code: "23514",
          constraint: "shipment_provider_events_creation_evidence_check",
        },
      );
      await expectQueryError(
        client,
        "confirm_void_beyond_clock_skew_tolerance",
        async () => {
          await client.query(
            `UPDATE outbox_messages
             SET status = 'DELIVERED', delivered_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE deduplication_key =
                   'void_carrier_label:' || $1::text || ':label-' || $1::text`,
            [foundation.shipmentId],
          );
          await client.query(
            `INSERT INTO shipment_provider_events
               (id, shipment_id, outbox_message_id, carrier, carrier_label_id,
                provider_event_id, provider_transaction_id, kind, occurred_at,
                authenticated_at, verified_at, created_at)
             SELECT $1, shipment.id, message.id, shipment.carrier,
                    shipment.carrier_label_id, 'future-verification-void',
                    'future-verification-void:transaction', 'LABEL_VOIDED',
                    statement_timestamp(),
                    statement_timestamp() + interval '60 seconds',
                    statement_timestamp() + interval '60 seconds',
                    statement_timestamp()
             FROM shipments shipment
             JOIN outbox_messages message
               ON message.deduplication_key =
                  'void_carrier_label:' || shipment.id::text || ':' || shipment.carrier_label_id
             WHERE shipment.id = $2`,
            [randomUUID(), foundation.shipmentId],
          );
        },
        {
          code: "23514",
          constraint: "shipment_provider_event_evidence_check",
        },
      );
      await expectQueryError(
        client,
        "cancel_with_unlinked_provider_void",
        () =>
          client.query(
            `UPDATE shipments
             SET status = 'CANCELLED', provider_void_id = 'unlinked-void',
                 provider_voided_at = clock_timestamp(),
                 cancelled_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1`,
            [foundation.shipmentId],
          ),
        {
          code: "23514",
          constraint: "shipment_provider_void_confirmation_check",
        },
      );

      await expectQueryError(
        client,
        "confirm_void_beyond_negative_clock_skew_tolerance",
        () =>
          confirmCarrierLabelVoid(
            client,
            foundation.shipmentId,
            "provider-void-beyond-negative-skew",
            5_001,
            true,
          ),
        {
          code: "23514",
          constraint: "shipment_provider_event_outbox_check",
        },
      );
      await confirmCarrierLabelVoid(
        client,
        foundation.shipmentId,
        "provider-void-confirmed",
        5_000,
        true,
      );
      const originalVoid = (
        await client.query<{
          cancelled_at: Date;
          provider_void_id: string;
          provider_voided_at: Date;
        }>(
          `SELECT provider_void_id, provider_voided_at, cancelled_at
           FROM shipments
           WHERE id = $1`,
          [foundation.shipmentId],
        )
      ).rows[0];
      if (!originalVoid?.provider_voided_at || !originalVoid.cancelled_at) {
        throw new Error("confirmed carrier-void evidence is unavailable");
      }
      expect(
        (
          await client.query<{
            exact_outbox_link: boolean;
            exact_verified_timestamp: boolean;
            negative_cancellation_skew_at_boundary: boolean;
            negative_skew_at_boundary: boolean;
          }>(
            `SELECT event.outbox_message_id = message.id AS exact_outbox_link,
                    event.verified_at = shipment.provider_voided_at
                      AS exact_verified_timestamp,
                    event.occurred_at =
                      shipment.cancellation_requested_at - interval '5 seconds'
                      AS negative_cancellation_skew_at_boundary,
                    event.occurred_at = message.delivered_at - interval '5 seconds'
                      AS negative_skew_at_boundary
             FROM shipment_provider_events event
             JOIN shipments shipment ON shipment.id = event.shipment_id
             JOIN outbox_messages message ON message.id = event.outbox_message_id
             WHERE event.shipment_id = $1
               AND event.kind = 'LABEL_VOIDED'
               AND event.provider_event_id = 'provider-void-confirmed'`,
            [foundation.shipmentId],
          )
        ).rows,
      ).toEqual([
        {
          exact_outbox_link: true,
          exact_verified_timestamp: true,
          negative_cancellation_skew_at_boundary: true,
          negative_skew_at_boundary: true,
        },
      ]);
      await client.query(
        `INSERT INTO shipment_provider_events
           (id, shipment_id, outbox_message_id, carrier, carrier_label_id,
            provider_event_id, provider_transaction_id, kind, occurred_at,
            authenticated_at, verified_at, created_at)
         SELECT $1, event.shipment_id, event.outbox_message_id, event.carrier,
                event.carrier_label_id, $2, event.provider_transaction_id,
                'LABEL_VOIDED', event.verified_at + interval '1 millisecond',
                event.verified_at + interval '1 millisecond',
                event.verified_at + interval '1 millisecond',
                statement_timestamp()
         FROM shipment_provider_events event
         WHERE event.shipment_id = $3
           AND event.kind = 'LABEL_VOIDED'
           AND event.provider_event_id = $4`,
        [
          randomUUID(),
          "provider-void-confirmed-repeat",
          foundation.shipmentId,
          "provider-void-confirmed",
        ],
      );
      await client.query(
        `SET CONSTRAINTS "shipment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "shipment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            cancelled_at: Date;
            event_count: string;
            outbox_count: string;
            provider_void_id: string;
            provider_voided_at: Date;
            status: string;
          }>(
            `SELECT shipment.status::text AS status,
                    shipment.provider_void_id,
                    shipment.provider_voided_at,
                    shipment.cancelled_at,
                    count(event.id)::text AS event_count,
                    count(DISTINCT event.outbox_message_id)::text AS outbox_count
             FROM shipments shipment
             JOIN shipment_provider_events event
               ON event.shipment_id = shipment.id
              AND event.kind = 'LABEL_VOIDED'
             WHERE shipment.id = $1
             GROUP BY shipment.status, shipment.provider_void_id,
                      shipment.provider_voided_at, shipment.cancelled_at`,
            [foundation.shipmentId],
          )
        ).rows,
      ).toEqual([
        {
          cancelled_at: originalVoid.cancelled_at,
          event_count: "2",
          outbox_count: "1",
          provider_void_id: originalVoid.provider_void_id,
          provider_voided_at: originalVoid.provider_voided_at,
          status: "CANCELLED",
        },
      ]);
      await cancelOrderBeforeHandoff(client, foundation.orderId);

      expect(
        (
          await client.query<{
            job_status: string;
            order_status: string;
            provider_void_id: string;
            reservation_status: string;
            shipment_status: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                    job.status::text AS job_status,
                    reservation_set.status::text AS reservation_status,
                    shipment.status::text AS shipment_status,
                    shipment.provider_void_id
             FROM orders target_order
             JOIN order_phases phase ON phase.order_id = target_order.id
             JOIN jobs job ON job.order_phase_id = phase.id
             JOIN phase_resource_plans resource_plan
               ON resource_plan.order_phase_id = phase.id
             JOIN phase_reservation_sets reservation_set
               ON reservation_set.phase_resource_plan_id = resource_plan.id
              AND reservation_set.node_id = resource_plan.node_id
             JOIN shipments shipment ON shipment.order_id = target_order.id
             WHERE target_order.id = $1`,
            [foundation.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "CANCELLED",
          job_status: "CANCELLED",
          reservation_status: "RELEASED",
          shipment_status: "CANCELLED",
          provider_void_id: "provider-void-confirmed",
        },
      ]);
    });
  });

  it("lets a verified carrier acceptance scan win the pending-cancellation race atomically", async () => {
    await rollback(
      "shipment-cancellation-scan-race",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "shipment-cancellation-scan-race",
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
        await client.query(
          `UPDATE shipments
         SET status = 'CANCELLATION_PENDING',
             cancellation_requested_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1`,
          [foundation.shipmentId],
        );

        await expectQueryError(
          client,
          "handoff_pending_without_verified_scan",
          () =>
            client.query(
              `UPDATE shipments
             SET status = 'HANDED_OVER',
                 provider_acceptance_scan_id = 'unverified-scan',
                 handed_over_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
              [foundation.shipmentId],
            ),
          {
            code: "23514",
            constraint: "shipment_acceptance_scan_confirmation_check",
          },
        );
        await expectQueryError(
          client,
          "persist_scan_without_atomic_handoff",
          async () => {
            await persistVerifiedAcceptanceScan(
              client,
              foundation.shipmentId,
              "orphaned-acceptance-scan",
            );
            await client.query(
              `SET CONSTRAINTS "shipment_provider_events_consumed" IMMEDIATE`,
            );
          },
          {
            code: "23514",
            constraint: "shipment_provider_event_consumption_check",
          },
        );
        await expectQueryError(
          client,
          "handoff_beyond_clock_skew_tolerance",
          () =>
            client.query(
              `INSERT INTO shipment_provider_events
               (id, shipment_id, carrier, carrier_label_id, provider_event_id,
                provider_transaction_id, kind, occurred_at, authenticated_at,
                verified_at, created_at)
             SELECT $1, shipment.id, shipment.carrier,
                    shipment.carrier_label_id, 'future-verification-scan',
                    'future-verification-scan:transaction', 'ACCEPTANCE_SCAN',
                    statement_timestamp(), statement_timestamp(),
                    statement_timestamp() + interval '60 seconds',
                    statement_timestamp()
             FROM shipments shipment
             WHERE shipment.id = $2`,
              [randomUUID(), foundation.shipmentId],
            ),
          {
            code: "23514",
            constraint: "shipment_provider_event_evidence_check",
          },
        );

        const providerScanId = "provider-acceptance-scan";
        const handedOverAt = await persistVerifiedAcceptanceScan(
          client,
          foundation.shipmentId,
          providerScanId,
        );
        await client.query(
          `UPDATE jobs
         SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
         WHERE order_id = $1`,
          [foundation.orderId, handedOverAt],
        );
        await client.query(
          `UPDATE shipments
         SET status = 'HANDED_OVER', provider_acceptance_scan_id = $2,
             handed_over_at = $3, updated_at = $3
         WHERE id = $1`,
          [foundation.shipmentId, providerScanId, handedOverAt],
        );
        await client.query(
          `UPDATE order_phases
         SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
         WHERE order_id = $1`,
          [foundation.orderId, handedOverAt],
        );
        await client.query(
          `UPDATE orders SET status = 'SHIPPED', updated_at = $2 WHERE id = $1`,
          [foundation.orderId, handedOverAt],
        );
        await forceOrderLifecycleConstraints(client);

        expect(
          (
            await client.query<{
              cancellation_requested_at: Date;
              job_status: string;
              order_status: string;
              provider_acceptance_scan_id: string;
              shipment_status: string;
            }>(
              `SELECT target_order.status::text AS order_status,
                    job.status::text AS job_status,
                    shipment.status::text AS shipment_status,
                    shipment.cancellation_requested_at,
                    shipment.provider_acceptance_scan_id
             FROM orders target_order
             JOIN jobs job ON job.order_id = target_order.id
             JOIN shipments shipment ON shipment.order_id = target_order.id
             WHERE target_order.id = $1`,
              [foundation.orderId],
            )
          ).rows,
        ).toEqual([
          {
            order_status: "SHIPPED",
            job_status: "HANDED_OVER",
            shipment_status: "HANDED_OVER",
            cancellation_requested_at: expect.any(Date),
            provider_acceptance_scan_id: providerScanId,
          },
        ]);

        const acceptanceOccurredAt = (
          await client.query<{ occurred_at: Date }>(
            `SELECT occurred_at
             FROM shipment_provider_events
             WHERE shipment_id = $1
               AND kind = 'ACCEPTANCE_SCAN'
               AND provider_event_id = $2`,
            [foundation.shipmentId, providerScanId],
          )
        ).rows[0]?.occurred_at;
        if (!acceptanceOccurredAt) {
          throw new Error("cancellation-race acceptance occurrence is missing");
        }
        const persistDelayedVoid = async (
          eventId: string,
          occurredAt: Date,
        ) => {
          const outboxMessageId = (
            await client.query<{ id: string }>(
              `UPDATE outbox_messages
               SET status = 'DELIVERED', delivered_at = clock_timestamp(),
                   updated_at = clock_timestamp()
               WHERE deduplication_key =
                     'void_carrier_label:' || $1::text || ':label-' || $1::text
               RETURNING id`,
              [foundation.shipmentId],
            )
          ).rows[0]?.id;
          if (!outboxMessageId) {
            throw new Error("cancellation-race void outbox is missing");
          }
          await client.query(
            `INSERT INTO shipment_provider_events
               (id, shipment_id, outbox_message_id, carrier,
                carrier_label_id, provider_event_id, provider_transaction_id,
                kind, occurred_at, authenticated_at, verified_at, created_at)
             SELECT $1, shipment.id, $3, shipment.carrier,
                    shipment.carrier_label_id, $4, $5, 'LABEL_VOIDED', $6,
                    clock_timestamp(), clock_timestamp(), statement_timestamp()
             FROM shipments shipment
             WHERE shipment.id = $2`,
            [
              randomUUID(),
              foundation.shipmentId,
              outboxMessageId,
              eventId,
              `${eventId}:transaction`,
              occurredAt,
            ],
          );
        };
        await expectQueryError(
          client,
          "delayed_void_equal_to_acceptance",
          () =>
            persistDelayedVoid(
              "delayed-void-equal-to-acceptance",
              acceptanceOccurredAt,
            ),
          {
            code: "23514",
            constraint: "shipment_provider_event_scope_check",
          },
        );
        const delayedVoidId = "delayed-void-after-acceptance";
        await persistDelayedVoid(
          delayedVoidId,
          new Date(acceptanceOccurredAt.getTime() + 1),
        );
        await client.query(
          `SET CONSTRAINTS "shipment_provider_events_consumed" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS "shipment_provider_events_consumed" DEFERRED`,
        );
        expect(
          (
            await client.query<{
              job_status: string;
              order_status: string;
              provider_acceptance_scan_id: string;
              provider_void_id: string | null;
              shipment_status: string;
              void_event_count: string;
            }>(
              `SELECT target_order.status::text AS order_status,
                      job.status::text AS job_status,
                      shipment.status::text AS shipment_status,
                      shipment.provider_acceptance_scan_id,
                      shipment.provider_void_id,
                      count(void_event.id)::text AS void_event_count
               FROM orders target_order
               JOIN jobs job ON job.order_id = target_order.id
               JOIN shipments shipment ON shipment.order_id = target_order.id
               JOIN shipment_provider_events void_event
                 ON void_event.shipment_id = shipment.id
                AND void_event.kind = 'LABEL_VOIDED'
                AND void_event.provider_event_id = $2
               WHERE target_order.id = $1
               GROUP BY target_order.status, job.status, shipment.status,
                        shipment.provider_acceptance_scan_id,
                        shipment.provider_void_id`,
              [foundation.orderId, delayedVoidId],
            )
          ).rows,
        ).toEqual([
          {
            order_status: "SHIPPED",
            job_status: "HANDED_OVER",
            shipment_status: "HANDED_OVER",
            provider_acceptance_scan_id: providerScanId,
            provider_void_id: null,
            void_event_count: "1",
          },
        ]);
        const delayedProviderScanId = "delayed-provider-acceptance-scan";
        await persistVerifiedAcceptanceScan(
          client,
          foundation.shipmentId,
          delayedProviderScanId,
        );
        await client.query(
          `SET CONSTRAINTS "shipment_provider_events_consumed" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS "shipment_provider_events_consumed" DEFERRED`,
        );
        expect(
          (
            await client.query<{
              acceptance_event_count: string;
              handed_over_at: Date;
              provider_acceptance_scan_id: string;
            }>(
              `SELECT count(event.id)::text AS acceptance_event_count,
                      shipment.handed_over_at,
                      shipment.provider_acceptance_scan_id
               FROM shipments shipment
               JOIN shipment_provider_events event
                 ON event.shipment_id = shipment.id
                AND event.kind = 'ACCEPTANCE_SCAN'
               WHERE shipment.id = $1
               GROUP BY shipment.handed_over_at,
                        shipment.provider_acceptance_scan_id`,
              [foundation.shipmentId],
            )
          ).rows,
        ).toEqual([
          {
            acceptance_event_count: "2",
            handed_over_at: handedOverAt,
            provider_acceptance_scan_id: providerScanId,
          },
        ]);
        expect(
          (
            await client.query<{ count: string }>(
              `SELECT count(*)::text
             FROM refund_transactions refund
             JOIN payments payment ON payment.id = refund.payment_id
             WHERE payment.order_id = $1`,
              [foundation.orderId],
            )
          ).rows,
        ).toEqual([{ count: "0" }]);
        await expectQueryError(
          client,
          "cancel_after_verified_handoff",
          () =>
            client.query(
              `UPDATE shipments
             SET status = 'CANCELLED', cancelled_at = clock_timestamp()
             WHERE id = $1`,
              [foundation.shipmentId],
            ),
          { code: "23514", constraint: "shipment_status_transition_check" },
        );
      },
    );
  });

  it("reconciles a pre-void acceptance scan delivered after the label void", async () => {
    await rollback(
      "shipment-cancellation-delayed-scan-race",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "shipment-cancellation-delayed-scan-race",
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
        await client.query(
          `UPDATE shipments
           SET status = 'CANCELLATION_PENDING',
               cancellation_requested_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE id = $1`,
          [foundation.shipmentId],
        );
        const providerVoidId = "delayed-scan-race-provider-void";
        await confirmCarrierLabelVoid(
          client,
          foundation.shipmentId,
          providerVoidId,
        );
        const providerVoidOccurredAt = (
          await client.query<{ occurred_at: Date }>(
            `SELECT occurred_at
             FROM shipment_provider_events
             WHERE shipment_id = $1
               AND kind = 'LABEL_VOIDED'
               AND provider_event_id = $2`,
            [foundation.shipmentId, providerVoidId],
          )
        ).rows[0]?.occurred_at;
        if (!providerVoidOccurredAt) {
          throw new Error("delayed scan race has no exact provider void");
        }

        for (const [name, offset] of [
          ["equal", 0],
          ["later", 1],
        ] as const) {
          await expectQueryError(
            client,
            `cancelled_acceptance_scan_${name}_to_void`,
            () =>
              persistVerifiedAcceptanceScan(
                client,
                foundation.shipmentId,
                `cancelled-acceptance-scan-${name}`,
                new Date(providerVoidOccurredAt.getTime() + offset),
              ),
            {
              code: "23514",
              constraint: "shipment_provider_event_scope_check",
            },
          );
        }

        const winningScanOccurredAt = new Date(
          providerVoidOccurredAt.getTime() - 1,
        );
        await expectQueryError(
          client,
          "cancelled_pre_void_scan_without_atomic_handoff",
          async () => {
            await persistVerifiedAcceptanceScan(
              client,
              foundation.shipmentId,
              "orphaned-cancelled-pre-void-scan",
              winningScanOccurredAt,
            );
            await client.query(
              `SET CONSTRAINTS "shipment_provider_events_consumed" IMMEDIATE`,
            );
          },
          {
            code: "23514",
            constraint: "shipment_provider_event_consumption_check",
          },
        );

        const providerScanId = "delayed-pre-void-acceptance-scan";
        const handedOverAt = await persistVerifiedAcceptanceScan(
          client,
          foundation.shipmentId,
          providerScanId,
          winningScanOccurredAt,
        );
        await client.query(
          `UPDATE jobs
           SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
           WHERE order_id = $1`,
          [foundation.orderId, handedOverAt],
        );
        await client.query(
          `UPDATE shipments
           SET status = 'HANDED_OVER', provider_acceptance_scan_id = $2,
               handed_over_at = $3, updated_at = $3
           WHERE id = $1`,
          [foundation.shipmentId, providerScanId, handedOverAt],
        );
        await client.query(
          `UPDATE order_phases
           SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
           WHERE order_id = $1`,
          [foundation.orderId, handedOverAt],
        );
        await client.query(
          `UPDATE orders SET status = 'SHIPPED', updated_at = $2 WHERE id = $1`,
          [foundation.orderId, handedOverAt],
        );
        await client.query(
          `SET CONSTRAINTS "shipment_provider_events_consumed" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS "shipment_provider_events_consumed" DEFERRED`,
        );
        await forceOrderLifecycleConstraints(client);

        expect(
          (
            await client.query<{
              cancelled_at: Date;
              cancellation_requested_at: Date;
              job_status: string;
              order_status: string;
              payment_status: string;
              phase_status: string;
              provider_acceptance_scan_id: string;
              provider_void_id: string;
              refund_count: string;
              shipment_status: string;
              source_shipment_status: string;
            }>(
              `SELECT target_order.status::text AS order_status,
                      phase.status::text AS phase_status,
                      job.status::text AS job_status,
                      shipment.status::text AS shipment_status,
                      shipment.cancellation_requested_at,
                      shipment.provider_void_id, shipment.cancelled_at,
                      shipment.provider_acceptance_scan_id,
                      payment.status::text AS payment_status,
                      scan.source_shipment_status::text,
                      (SELECT count(*)::text
                       FROM refund_transactions refund
                       WHERE refund.payment_id = payment.id) AS refund_count
               FROM orders target_order
               JOIN order_phases phase ON phase.order_id = target_order.id
               JOIN jobs job ON job.order_id = target_order.id
               JOIN shipments shipment ON shipment.order_id = target_order.id
               JOIN payments payment ON payment.order_id = target_order.id
               JOIN shipment_provider_events scan
                 ON scan.shipment_id = shipment.id
                AND scan.kind = 'ACCEPTANCE_SCAN'
                AND scan.provider_event_id = $2
               WHERE target_order.id = $1`,
              [foundation.orderId, providerScanId],
            )
          ).rows,
        ).toEqual([
          {
            order_status: "SHIPPED",
            phase_status: "SHIPPED",
            job_status: "HANDED_OVER",
            shipment_status: "HANDED_OVER",
            cancellation_requested_at: expect.any(Date),
            provider_void_id: providerVoidId,
            cancelled_at: expect.any(Date),
            provider_acceptance_scan_id: providerScanId,
            payment_status: "CAPTURED",
            source_shipment_status: "CANCELLED",
            refund_count: "0",
          },
        ]);

        await client.query(
          `INSERT INTO shipment_provider_events
             (id, shipment_id, outbox_message_id, carrier, carrier_label_id,
              provider_event_id, provider_transaction_id, kind, occurred_at,
              authenticated_at, verified_at, created_at)
           SELECT $1, event.shipment_id, event.outbox_message_id,
                  event.carrier, event.carrier_label_id, $2,
                  event.provider_transaction_id, 'LABEL_VOIDED',
                  clock_timestamp(), clock_timestamp(), clock_timestamp(),
                  statement_timestamp()
           FROM shipment_provider_events event
           WHERE event.shipment_id = $3
             AND event.kind = 'LABEL_VOIDED'
             AND event.provider_event_id = $4`,
          [
            randomUUID(),
            "delayed-scan-race-provider-void-repeat",
            foundation.shipmentId,
            providerVoidId,
          ],
        );
        await client.query(
          `SET CONSTRAINTS "shipment_provider_events_consumed" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS "shipment_provider_events_consumed" DEFERRED`,
        );
        expect(
          (
            await client.query<{
              provider_void_id: string;
              shipment_status: string;
              void_event_count: string;
            }>(
              `SELECT shipment.status::text AS shipment_status,
                      shipment.provider_void_id,
                      count(event.id)::text AS void_event_count
               FROM shipments shipment
               JOIN shipment_provider_events event
                 ON event.shipment_id = shipment.id
                AND event.kind = 'LABEL_VOIDED'
               WHERE shipment.id = $1
               GROUP BY shipment.status, shipment.provider_void_id`,
              [foundation.shipmentId],
            )
          ).rows,
        ).toEqual([
          {
            shipment_status: "HANDED_OVER",
            provider_void_id: providerVoidId,
            void_event_count: "2",
          },
        ]);
      },
    );
  });

  it("reconciles a pre-void acceptance scan after the cancellation commits", async () => {
    let foundation: PersistenceFoundation | undefined;
    let providerVoidOccurredAt: Date | undefined;

    const cancellationClient = await pool.connect();
    await cancellationClient.query("BEGIN");
    try {
      const fixtures = new PersistenceFactory(
        cancellationClient,
        `${scope}:committed-scan`,
      );
      foundation = await fixtures.createFoundation("committed-scan");
      const productions = await createCurrentPlanAndPayment(
        cancellationClient,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(
        cancellationClient,
        fixtures,
        foundation,
        productions,
      );
      for (const status of [
        "IN_PRODUCTION",
        "QC_PASSED",
        "READY_TO_SHIP",
      ] as const) {
        await advanceOrderLifecycleStep(
          cancellationClient,
          foundation.orderId,
          status,
        );
      }
      await cancellationClient.query(
        `UPDATE shipments
         SET status = 'CANCELLATION_PENDING',
             cancellation_requested_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [foundation.shipmentId],
      );
      const providerVoidId = "committed-delayed-scan-provider-void";
      await confirmCarrierLabelVoid(
        cancellationClient,
        foundation.shipmentId,
        providerVoidId,
      );
      providerVoidOccurredAt = (
        await cancellationClient.query<{ occurred_at: Date }>(
          `SELECT occurred_at
           FROM shipment_provider_events
           WHERE shipment_id = $1
             AND kind = 'LABEL_VOIDED'
             AND provider_event_id = $2`,
          [foundation.shipmentId, providerVoidId],
        )
      ).rows[0]?.occurred_at;
      if (!providerVoidOccurredAt) {
        throw new Error("committed cancellation has no provider void event");
      }

      await cancelOrderBeforeHandoff(cancellationClient, foundation.orderId);
      const failedRefund = (
        await cancellationClient.query<{ id: string }>(
          `SELECT refund.id
           FROM refund_transactions refund
           WHERE refund.payment_id = $1
             AND refund.reason = 'CUSTOMER_CANCELLATION'
             AND refund.status = 'PENDING'`,
          [foundation.paymentId],
        )
      ).rows[0];
      if (!failedRefund) {
        throw new Error("committed cancellation has no refund attempt");
      }
      const refundFailedAt = new Date();
      await fixtures.persistRefundProviderEvent(
        failedRefund.id,
        "REFUND_FAILED",
        "committed-delayed-scan-refund-failed",
        refundFailedAt,
      );
      await cancellationClient.query(
        `UPDATE refund_transactions
         SET status = 'FAILED', provider_refund_id = $2, updated_at = $3
         WHERE id = $1`,
        [
          failedRefund.id,
          "committed-delayed-scan-refund-failed",
          refundFailedAt,
        ],
      );
      await cancellationClient.query(
        `UPDATE payments
         SET status = 'CAPTURED', updated_at = $2
         WHERE id = $1`,
        [foundation.paymentId, refundFailedAt],
      );
      await forceOrderLifecycleConstraints(cancellationClient);
      await cancellationClient.query("COMMIT");
    } catch (error) {
      await cancellationClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      cancellationClient.release();
    }

    if (!foundation || !providerVoidOccurredAt) {
      throw new Error("committed cancellation fixture is incomplete");
    }

    expect(
      (
        await pool.query<{
          job_status: string;
          order_status: string;
          phase_status: string;
          shipment_status: string;
          slot_outcome: string;
        }>(
          `SELECT target_order.status::text AS order_status,
                  phase.status::text AS phase_status,
                  job.status::text AS job_status,
                  shipment.status::text AS shipment_status,
                  slot.outcome::text AS slot_outcome
           FROM orders target_order
           JOIN order_phases phase ON phase.order_id = target_order.id
           JOIN jobs job ON job.order_id = target_order.id
           JOIN shipments shipment ON shipment.order_id = target_order.id
           JOIN fulfilment_slots slot ON slot.order_id = target_order.id
           WHERE target_order.id = $1`,
          [foundation.orderId],
        )
      ).rows,
    ).toEqual([
      {
        order_status: "CANCELLED",
        phase_status: "CANCELLED",
        job_status: "CANCELLED",
        shipment_status: "CANCELLED",
        slot_outcome: "CANCELLED",
      },
    ]);

    const recoveryClient = await pool.connect();
    await recoveryClient.query("BEGIN");
    try {
      for (const [name, offset] of [
        ["equal", 0],
        ["later", 1],
      ] as const) {
        await expectQueryError(
          recoveryClient,
          `committed_cancelled_acceptance_scan_${name}_to_void`,
          () =>
            persistVerifiedAcceptanceScan(
              recoveryClient,
              foundation.shipmentId,
              `committed-cancelled-acceptance-scan-${name}`,
              new Date(providerVoidOccurredAt.getTime() + offset),
            ),
          {
            code: "23514",
            constraint: "shipment_provider_event_scope_check",
          },
        );
      }

      const winningScanOccurredAt = new Date(
        providerVoidOccurredAt.getTime() - 1,
      );
      await expectQueryError(
        recoveryClient,
        "committed_cancelled_pre_void_scan_without_recovery",
        async () => {
          await persistVerifiedAcceptanceScan(
            recoveryClient,
            foundation.shipmentId,
            "orphaned-committed-cancelled-pre-void-scan",
            winningScanOccurredAt,
          );
          await recoveryClient.query(
            `SET CONSTRAINTS "shipment_provider_events_consumed" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "shipment_provider_event_consumption_check",
        },
      );

      const providerScanId = "committed-delayed-pre-void-acceptance-scan";
      const handedOverAt = await persistVerifiedAcceptanceScan(
        recoveryClient,
        foundation.shipmentId,
        providerScanId,
        winningScanOccurredAt,
      );
      await recoveryClient.query(
        `UPDATE shipments
         SET status = 'HANDED_OVER', provider_acceptance_scan_id = $2,
             handed_over_at = $3, updated_at = $3
         WHERE id = $1`,
        [foundation.shipmentId, providerScanId, handedOverAt],
      );
      await recoveryClient.query(
        `UPDATE fulfilment_slots
         SET outcome = 'PENDING', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, handedOverAt],
      );
      const shipmentCancelledAt = (
        await recoveryClient.query<{ cancelled_at: Date }>(
          `SELECT cancelled_at
           FROM shipments
           WHERE id = $1`,
          [foundation.shipmentId],
        )
      ).rows[0]?.cancelled_at;
      if (!shipmentCancelledAt) {
        throw new Error("committed recovery Shipment has no cancellation time");
      }
      // Suppress the ordinary mutation guards only while seeding invalid
      // retained evidence so each assertion isolates the recovery predicate.
      for (const [name, corruption] of [
        [
          "wrong_reason",
          `UPDATE jobs
           SET cancellation_reason = 'CLAIM_WITHDRAWN'
           WHERE order_id = $1`,
        ],
        [
          "predating_cancellation",
          `UPDATE jobs
           SET cancelled_at = $2
           WHERE order_id = $1`,
        ],
      ] as const) {
        await expectQueryError(
          recoveryClient,
          `committed_cancelled_job_${name}`,
          async () => {
            await recoveryClient.query(
              `SET LOCAL session_replication_role = 'replica'`,
            );
            await recoveryClient.query(
              corruption,
              name === "wrong_reason"
                ? [foundation.orderId]
                : [
                    foundation.orderId,
                    new Date(shipmentCancelledAt.getTime() - 1),
                  ],
            );
            await recoveryClient.query(
              `SET LOCAL session_replication_role = 'origin'`,
            );
            await recoveryClient.query(
              `UPDATE jobs
               SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
               WHERE order_id = $1`,
              [foundation.orderId, handedOverAt],
            );
          },
          {
            code: "23514",
            constraint: "job_status_transition_check",
          },
        );
      }
      await recoveryClient.query(
        `UPDATE jobs
         SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, handedOverAt],
      );
      await expectQueryError(
        recoveryClient,
        "committed_cancelled_phase_requires_exact_handoff_time",
        () =>
          recoveryClient.query(
            `UPDATE order_phases
             SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
             WHERE order_id = $1`,
            [foundation.orderId, new Date(handedOverAt.getTime() + 1)],
          ),
        {
          code: "23514",
          constraint: "order_phase_status_transition_check",
        },
      );
      await recoveryClient.query(
        `UPDATE order_phases
         SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, handedOverAt],
      );
      await recoveryClient.query(
        `UPDATE orders
         SET status = 'SHIPPED', updated_at = $2
         WHERE id = $1`,
        [foundation.orderId, handedOverAt],
      );
      await forceOrderLifecycleConstraints(recoveryClient);
      await recoveryClient.query("COMMIT");
    } catch (error) {
      await recoveryClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      recoveryClient.release();
    }

    expect(
      (
        await pool.query<{
          job_cancelled_at: Date;
          job_cancellation_reason: string;
          job_status: string;
          order_status: string;
          phase_cancelled_at: Date;
          phase_status: string;
          refund_status: string;
          shipment_cancelled_at: Date;
          shipment_status: string;
          slot_outcome: string;
        }>(
          `SELECT target_order.status::text AS order_status,
                  phase.status::text AS phase_status,
                  phase.cancelled_at AS phase_cancelled_at,
                  job.status::text AS job_status,
                  job.cancelled_at AS job_cancelled_at,
                  job.cancellation_reason::text AS job_cancellation_reason,
                  shipment.status::text AS shipment_status,
                  shipment.cancelled_at AS shipment_cancelled_at,
                  slot.outcome::text AS slot_outcome,
                  refund.status::text AS refund_status
           FROM orders target_order
           JOIN order_phases phase ON phase.order_id = target_order.id
           JOIN jobs job ON job.order_id = target_order.id
           JOIN shipments shipment ON shipment.order_id = target_order.id
           JOIN fulfilment_slots slot ON slot.order_id = target_order.id
           JOIN payments payment ON payment.order_id = target_order.id
           JOIN refund_transactions refund ON refund.payment_id = payment.id
           WHERE target_order.id = $1`,
          [foundation.orderId],
        )
      ).rows,
    ).toEqual([
      {
        order_status: "SHIPPED",
        phase_status: "SHIPPED",
        phase_cancelled_at: expect.any(Date),
        job_status: "HANDED_OVER",
        job_cancelled_at: expect.any(Date),
        job_cancellation_reason: "ORDER_CANCELLED",
        shipment_status: "HANDED_OVER",
        shipment_cancelled_at: expect.any(Date),
        slot_outcome: "PENDING",
        refund_status: "FAILED",
      },
    ]);
  });

  it("reconciles a pre-void acceptance scan after its cancellation refund commits", async () => {
    let foundation: PersistenceFoundation | undefined;
    let providerVoidOccurredAts: Date[] | undefined;
    let refundId: string | undefined;
    let refundProviderEventRowId: string | undefined;
    let reconciledAts: Date[] | undefined;
    let settlementId: string | undefined;

    const cancellationClient = await pool.connect();
    await cancellationClient.query("BEGIN");
    try {
      const fixtures = new PersistenceFactory(
        cancellationClient,
        `${scope}:refunded-committed-scan`,
      );
      foundation = await fixtures.createFoundation(
        "refunded-committed-scan",
        {},
        undefined,
        undefined,
        undefined,
        2,
      );
      const productions = await createCurrentPlanAndPayment(
        cancellationClient,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(
        cancellationClient,
        fixtures,
        foundation,
        productions,
      );
      for (const status of [
        "IN_PRODUCTION",
        "QC_PASSED",
        "READY_TO_SHIP",
      ] as const) {
        await advanceOrderLifecycleStep(
          cancellationClient,
          foundation.orderId,
          status,
        );
      }
      await cancellationClient.query(
        `UPDATE shipments
         SET status = 'CANCELLATION_PENDING',
             cancellation_requested_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE order_id = $1`,
        [foundation.orderId],
      );
      providerVoidOccurredAts = [];
      for (const [index, shipmentId] of foundation.shipmentIds.entries()) {
        const providerVoidId = `${scope}:refunded-committed-delayed-scan-provider-void-${index}`;
        await confirmCarrierLabelVoid(
          cancellationClient,
          shipmentId,
          providerVoidId,
        );
        const voidEvent = (
          await cancellationClient.query<{ occurred_at: Date }>(
            `SELECT occurred_at
             FROM shipment_provider_events
             WHERE shipment_id = $1
               AND kind = 'LABEL_VOIDED'
               AND provider_event_id = $2`,
            [shipmentId, providerVoidId],
          )
        ).rows[0];
        if (!voidEvent) {
          throw new Error("refunded committed cancellation has no void event");
        }
        providerVoidOccurredAts.push(voidEvent.occurred_at);
      }

      await cancelOrderBeforeHandoff(cancellationClient, foundation.orderId);
      const refund = (
        await cancellationClient.query<{ id: string }>(
          `SELECT refund.id
           FROM refund_transactions refund
           WHERE refund.payment_id = $1
             AND refund.reason = 'CUSTOMER_CANCELLATION'
             AND refund.status = 'PENDING'`,
          [foundation.paymentId],
        )
      ).rows[0];
      if (!refund) {
        throw new Error("refunded committed cancellation has no refund");
      }
      refundId = refund.id;
      const refundedAt = new Date();
      const refundProviderId = `${scope}:refunded-committed-delayed-scan-refund`;
      const refundProviderEventId = await fixtures.persistRefundProviderEvent(
        refund.id,
        "REFUND_SUCCEEDED",
        refundProviderId,
        refundedAt,
      );
      refundProviderEventRowId = (
        await cancellationClient.query<{ id: string }>(
          `SELECT id
           FROM payment_provider_events
           WHERE payment_id = $1
             AND refund_transaction_id = $2
             AND kind = 'REFUND_SUCCEEDED'
             AND provider_event_id = $3`,
          [foundation.paymentId, refund.id, refundProviderEventId],
        )
      ).rows[0]?.id;
      if (!refundProviderEventRowId) {
        throw new Error("refunded cancellation has no provider refund receipt");
      }
      await cancellationClient.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_refund_id = $2,
             completed_at = $3, updated_at = $3
         WHERE id = $1`,
        [refund.id, refundProviderId, refundedAt],
      );
      await cancellationClient.query(
        `UPDATE payments
         SET status = 'REFUNDED', updated_at = $2
         WHERE id = $1`,
        [foundation.paymentId, refundedAt],
      );
      await cancellationClient.query(
        `UPDATE order_phases
         SET status = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, refundedAt],
      );
      await cancellationClient.query(
        `UPDATE fulfilment_slots
         SET outcome = 'CANCELLED_REFUNDED', updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, refundedAt],
      );
      await cancellationClient.query(
        `UPDATE orders SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [foundation.orderId, refundedAt],
      );
      await forceOrderLifecycleConstraints(cancellationClient);
      await cancellationClient.query("COMMIT");
    } catch (error) {
      await cancellationClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      cancellationClient.release();
    }

    if (
      !foundation ||
      !providerVoidOccurredAts ||
      providerVoidOccurredAts.length !== foundation.shipmentIds.length ||
      !refundId ||
      !refundProviderEventRowId
    ) {
      throw new Error("refunded committed cancellation fixture is incomplete");
    }

    const recoveryClient = await pool.connect();
    await recoveryClient.query("BEGIN");
    try {
      const firstWinningScanOccurredAt = new Date(
        providerVoidOccurredAts[0]!.getTime() - 1,
      );
      await expectQueryError(
        recoveryClient,
        "refunded_committed_scan_without_settlement",
        async () => {
          const verifiedAt = await persistVerifiedAcceptanceScan(
            recoveryClient,
            foundation.shipmentId,
            `${scope}:orphaned-refunded-committed-scan`,
            firstWinningScanOccurredAt,
          );
          await recoveryClient.query(
            `UPDATE shipments
             SET status = 'HANDED_OVER',
                 provider_acceptance_scan_id = $2,
                 handed_over_at = $3, updated_at = $3
             WHERE id = $1`,
            [
              foundation.shipmentId,
              `${scope}:orphaned-refunded-committed-scan`,
              verifiedAt,
            ],
          );
          await forceOrderLifecycleConstraints(recoveryClient);
        },
        {
          code: "23514",
          constraint: "shipment_plan_slot_terminal_reconciliation_check",
        },
      );

      const recoveryEvidence: Array<{
        acceptanceEventId: string;
        handedOverAt: Date;
        providerScanId: string;
        shipmentId: string;
        shipmentPlanId: string;
      }> = [];
      for (const [index, shipmentId] of foundation.shipmentIds
        .slice(0, 1)
        .entries()) {
        const providerScanId = `${scope}:refunded-committed-delayed-pre-void-scan-${index}`;
        const handedOverAt = await persistVerifiedAcceptanceScan(
          recoveryClient,
          shipmentId,
          providerScanId,
          new Date(providerVoidOccurredAts[index]!.getTime() - 1),
        );
        const acceptanceEventId = (
          await recoveryClient.query<{ id: string }>(
            `SELECT id
             FROM shipment_provider_events
             WHERE shipment_id = $1
               AND kind = 'ACCEPTANCE_SCAN'
               AND provider_event_id = $2`,
            [shipmentId, providerScanId],
          )
        ).rows[0]?.id;
        if (!acceptanceEventId) {
          throw new Error("refunded recovery has no acceptance receipt");
        }
        recoveryEvidence.push({
          acceptanceEventId,
          handedOverAt,
          providerScanId,
          shipmentId,
          shipmentPlanId: foundation.shipmentPlanIds[index]!,
        });
      }
      reconciledAts = recoveryEvidence.map(({ handedOverAt }) => handedOverAt);
      const settlementAt = recoveryEvidence[0]!.handedOverAt;

      await recoveryClient.query(
        `UPDATE payments
         SET capture_authorized = false, capture_cutoff_at = $2,
             updated_at = $2
         WHERE id = $1`,
        [foundation.paymentId, settlementAt],
      );
      settlementId = randomUUID();
      await recoveryClient.query(
        `INSERT INTO order_settlements (
             id, order_id, order_phase_id, order_price_binding_id,
             price_snapshot_id, payment_id, refund_transaction_id, kind,
             currency, contract_total_minor, captured_total_minor,
             earned_amount_minor, retained_amount_minor, refund_amount_minor,
             written_off_amount_minor, unearned_cancelled_amount_minor,
             amount_due_minor, refundable_balance_minor, cutoff_at, settled_at
         )
         SELECT $1, target_order.id, phase.id,
                payment.order_price_binding_id, payment.price_snapshot_id,
                payment.id, refund.id, 'UNAUTHORIZED_HANDOFF',
                payment.currency, price.contract_total_minor,
                payment.captured_amount_minor, 0, 0,
                payment.captured_amount_minor, 0,
                price.contract_total_minor, 0, 0, $4, $4
         FROM orders target_order
         JOIN order_phases phase ON phase.order_id = target_order.id
         JOIN payments payment ON payment.order_id = target_order.id
         JOIN price_snapshots price ON price.id = payment.price_snapshot_id
         JOIN refund_transactions refund
           ON refund.id = $3 AND refund.payment_id = payment.id
         WHERE target_order.id = $2`,
        [settlementId, foundation.orderId, refundId, settlementAt],
      );

      await expectQueryError(
        recoveryClient,
        "refunded_reconciliation_wrong_shipment",
        () =>
          recoveryClient.query(
            `INSERT INTO handoff_reconciliations (
                 id, order_id, order_phase_id, shipment_id, shipment_plan_id,
                 delivery_destination_id, acceptance_event_id, void_event_id,
                 payment_id, refund_transaction_id, refund_provider_event_id,
                 order_settlement_id, status, cancellation_requested_at,
                 reconciled_at
             )
             SELECT $1, shipment.order_id, shipment.order_phase_id, shipment.id,
                    shipment.shipment_plan_id,
                    shipment.delivery_destination_id, $2, void_event.id,
                    payment.id, refund.id, $3, $4, 'COMPLETED',
                    shipment.cancellation_requested_at, $5
             FROM shipments shipment
             JOIN shipment_provider_events void_event
               ON void_event.shipment_id = shipment.id
              AND void_event.kind = 'LABEL_VOIDED'
              AND void_event.provider_event_id = shipment.provider_void_id
             JOIN payments payment ON payment.order_id = shipment.order_id
             JOIN refund_transactions refund
               ON refund.id = $6 AND refund.payment_id = payment.id
             WHERE shipment.id = $7`,
            [
              randomUUID(),
              recoveryEvidence[0]!.acceptanceEventId,
              refundProviderEventRowId,
              settlementId,
              recoveryEvidence[0]!.handedOverAt,
              refundId,
              foundation.shipmentIds[1],
            ],
          ),
        {
          code: "23514",
          constraint: "refunded_handoff_source_state_check",
        },
      );

      for (const evidence of recoveryEvidence) {
        await recoveryClient.query(
          `INSERT INTO handoff_reconciliations (
               id, order_id, order_phase_id, shipment_id, shipment_plan_id,
               delivery_destination_id, acceptance_event_id, void_event_id,
               payment_id, refund_transaction_id, refund_provider_event_id,
               order_settlement_id, status, cancellation_requested_at,
               reconciled_at
           )
           SELECT $1, shipment.order_id, shipment.order_phase_id, shipment.id,
                  shipment.shipment_plan_id, shipment.delivery_destination_id,
                  $2, void_event.id, payment.id, refund.id, $3, $4,
                  'COMPLETED', shipment.cancellation_requested_at, $5
           FROM shipments shipment
           JOIN shipment_provider_events void_event
             ON void_event.shipment_id = shipment.id
            AND void_event.kind = 'LABEL_VOIDED'
            AND void_event.provider_event_id = shipment.provider_void_id
           JOIN payments payment ON payment.order_id = shipment.order_id
           JOIN refund_transactions refund
             ON refund.id = $6 AND refund.payment_id = payment.id
           WHERE shipment.id = $7`,
          [
            randomUUID(),
            evidence.acceptanceEventId,
            refundProviderEventRowId,
            settlementId,
            evidence.handedOverAt,
            refundId,
            evidence.shipmentId,
          ],
        );
        await recoveryClient.query(
          `UPDATE shipments
           SET status = 'HANDED_OVER', provider_acceptance_scan_id = $2,
               handed_over_at = $3, updated_at = $3
           WHERE id = $1`,
          [evidence.shipmentId, evidence.providerScanId, evidence.handedOverAt],
        );
        await recoveryClient.query(
          `UPDATE fulfilment_slots slot
           SET outcome = 'PENDING', updated_at = $2
           FROM shipment_plan_fulfilment_slots allocation
           WHERE allocation.fulfilment_slot_id = slot.id
             AND allocation.shipment_plan_id = $1`,
          [evidence.shipmentPlanId, evidence.handedOverAt],
        );
        expect(
          (
            await recoveryClient.query<{ job_proof: boolean }>(
              `SELECT taven_has_refunded_post_void_handoff_reconciliation(
                        job.order_id, job.order_phase_id,
                        job.shipment_plan_id, NULL, job.id, $2
                      ) AS job_proof
               FROM jobs job
               WHERE job.shipment_plan_id = $1`,
              [evidence.shipmentPlanId, evidence.handedOverAt],
            )
          ).rows,
        ).toEqual([{ job_proof: true }]);
        await recoveryClient.query(
          `UPDATE jobs
           SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
           WHERE shipment_plan_id = $1`,
          [evidence.shipmentPlanId, evidence.handedOverAt],
        );
      }
      expect(
        (
          await recoveryClient.query<{ aggregate_proof: boolean }>(
            `SELECT taven_has_refunded_post_void_handoff_reconciliation($1)
                      AS aggregate_proof`,
            [foundation.orderId],
          )
        ).rows[0],
      ).toEqual({ aggregate_proof: true });
      const shippedAt = new Date(
        Math.max(
          ...recoveryEvidence.map(({ handedOverAt }) => handedOverAt.getTime()),
        ),
      );
      await recoveryClient.query(
        `UPDATE order_phases
         SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, shippedAt],
      );
      await recoveryClient.query(
        `UPDATE orders SET status = 'SHIPPED', updated_at = $2 WHERE id = $1`,
        [foundation.orderId, shippedAt],
      );
      await forceOrderLifecycleConstraints(recoveryClient);
      await recoveryClient.query("COMMIT");
    } catch (error) {
      await recoveryClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      recoveryClient.release();
    }

    if (!settlementId || !reconciledAts) {
      throw new Error("refunded handoff has no shared settlement");
    }
    expect(
      (
        await pool.query<{
          cancelled_jobs: string;
          cancelled_shipments: string;
          cancelled_slots: string;
          handed_over_jobs: string;
          handed_over_shipments: string;
          order_status: string;
          pending_slots: string;
        }>(
          `SELECT target_order.status::text AS order_status,
                  count(*) FILTER (WHERE shipment.status = 'HANDED_OVER')::text
                    AS handed_over_shipments,
                  count(*) FILTER (WHERE shipment.status = 'CANCELLED')::text
                    AS cancelled_shipments,
                  (SELECT count(*)::text FROM jobs
                   WHERE order_id = target_order.id
                     AND status = 'HANDED_OVER') AS handed_over_jobs,
                  (SELECT count(*)::text FROM jobs
                   WHERE order_id = target_order.id
                     AND status = 'CANCELLED') AS cancelled_jobs,
                  (SELECT count(*)::text FROM fulfilment_slots
                   WHERE order_id = target_order.id
                     AND outcome = 'PENDING') AS pending_slots,
                  (SELECT count(*)::text FROM fulfilment_slots
                   WHERE order_id = target_order.id
                     AND outcome = 'CANCELLED_REFUNDED') AS cancelled_slots
           FROM orders target_order
           JOIN shipments shipment ON shipment.order_id = target_order.id
           WHERE target_order.id = $1
           GROUP BY target_order.id`,
          [foundation.orderId],
        )
      ).rows[0],
    ).toEqual({
      order_status: "SHIPPED",
      handed_over_shipments: "1",
      cancelled_shipments: "1",
      handed_over_jobs: "1",
      cancelled_jobs: "1",
      pending_slots: "1",
      cancelled_slots: "1",
    });
    const secondRecoveryClient = await pool.connect();
    await secondRecoveryClient.query("BEGIN");
    try {
      const shipmentId = foundation.shipmentIds[1]!;
      const shipmentPlanId = foundation.shipmentPlanIds[1]!;
      const providerScanId = `${scope}:refunded-committed-delayed-pre-void-scan-1`;
      const handedOverAt = await persistVerifiedAcceptanceScan(
        secondRecoveryClient,
        shipmentId,
        providerScanId,
        new Date(providerVoidOccurredAts[1]!.getTime() - 1),
      );
      const acceptanceEventId = (
        await secondRecoveryClient.query<{ id: string }>(
          `SELECT id
           FROM shipment_provider_events
           WHERE shipment_id = $1
             AND kind = 'ACCEPTANCE_SCAN'
             AND provider_event_id = $2`,
          [shipmentId, providerScanId],
        )
      ).rows[0]?.id;
      if (!acceptanceEventId) {
        throw new Error("second refunded recovery has no acceptance receipt");
      }
      await secondRecoveryClient.query(
        `INSERT INTO handoff_reconciliations (
             id, order_id, order_phase_id, shipment_id, shipment_plan_id,
             delivery_destination_id, acceptance_event_id, void_event_id,
             payment_id, refund_transaction_id, refund_provider_event_id,
             order_settlement_id, status, cancellation_requested_at,
             reconciled_at
         )
         SELECT $1, shipment.order_id, shipment.order_phase_id, shipment.id,
                shipment.shipment_plan_id, shipment.delivery_destination_id,
                $2, void_event.id, payment.id, refund.id, $3, $4,
                'COMPLETED', shipment.cancellation_requested_at, $5
         FROM shipments shipment
         JOIN shipment_provider_events void_event
           ON void_event.shipment_id = shipment.id
          AND void_event.kind = 'LABEL_VOIDED'
          AND void_event.provider_event_id = shipment.provider_void_id
         JOIN payments payment ON payment.order_id = shipment.order_id
         JOIN refund_transactions refund
           ON refund.id = $6 AND refund.payment_id = payment.id
         WHERE shipment.id = $7`,
        [
          randomUUID(),
          acceptanceEventId,
          refundProviderEventRowId,
          settlementId,
          handedOverAt,
          refundId,
          shipmentId,
        ],
      );
      await secondRecoveryClient.query(
        `UPDATE shipments
         SET status = 'HANDED_OVER', provider_acceptance_scan_id = $2,
             handed_over_at = $3, updated_at = $3
         WHERE id = $1`,
        [shipmentId, providerScanId, handedOverAt],
      );
      await secondRecoveryClient.query(
        `UPDATE fulfilment_slots slot
         SET outcome = 'PENDING', updated_at = $2
         FROM shipment_plan_fulfilment_slots allocation
         WHERE allocation.fulfilment_slot_id = slot.id
           AND allocation.shipment_plan_id = $1`,
        [shipmentPlanId, handedOverAt],
      );
      expect(
        (
          await secondRecoveryClient.query<{ job_proof: boolean }>(
            `SELECT taven_has_refunded_post_void_handoff_reconciliation(
                      job.order_id, job.order_phase_id,
                      job.shipment_plan_id, NULL, job.id, $2
                    ) AS job_proof
             FROM jobs job
             WHERE job.shipment_plan_id = $1`,
            [shipmentPlanId, handedOverAt],
          )
        ).rows,
      ).toEqual([{ job_proof: true }]);
      await secondRecoveryClient.query(
        `UPDATE jobs
         SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
         WHERE shipment_plan_id = $1`,
        [shipmentPlanId, handedOverAt],
      );
      await forceOrderLifecycleConstraints(secondRecoveryClient);
      await secondRecoveryClient.query("COMMIT");
      reconciledAts.push(handedOverAt);
    } catch (error) {
      await secondRecoveryClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      secondRecoveryClient.release();
    }

    const replayClient = await pool.connect();
    await replayClient.query("BEGIN");
    try {
      const replay = await replayClient.query(
        `INSERT INTO shipment_provider_events (
             id, shipment_id, carrier, carrier_label_id, provider_event_id,
             provider_transaction_id, kind, occurred_at, authenticated_at,
             verified_at, created_at
         )
         SELECT $1, event.shipment_id, event.carrier, event.carrier_label_id,
                event.provider_event_id, event.provider_transaction_id,
                event.kind, event.occurred_at, event.authenticated_at,
                event.verified_at, event.created_at
         FROM shipment_provider_events event
         WHERE event.shipment_id = $2
           AND event.provider_event_id = $3
         ON CONFLICT (carrier, provider_event_id) DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          foundation.shipmentIds[0],
          `${scope}:refunded-committed-delayed-pre-void-scan-0`,
        ],
      );
      expect(replay.rows).toEqual([]);
      expect(
        (
          await replayClient.query<{
            reconciliation_count: string;
            settlement_count: string;
          }>(
            `SELECT
                 (SELECT count(*)::text
                  FROM handoff_reconciliations
                  WHERE order_id = $1) AS reconciliation_count,
                 (SELECT count(*)::text
                  FROM order_settlements
                  WHERE order_id = $1) AS settlement_count`,
            [foundation.orderId],
          )
        ).rows[0],
      ).toEqual({ reconciliation_count: "2", settlement_count: "1" });
      await replayClient.query("COMMIT");
    } catch (error) {
      await replayClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      replayClient.release();
    }

    const completionClient = await pool.connect();
    await completionClient.query("BEGIN");
    try {
      if (!reconciledAts || reconciledAts.length === 0) {
        throw new Error("refunded handoff has no reconciliation time");
      }
      const lastReconciledAt = new Date(
        Math.max(...reconciledAts.map((value) => value.getTime())),
      );
      await advanceOrderLifecycleStep(
        completionClient,
        foundation.orderId,
        "DELIVERED",
        new Date(lastReconciledAt.getTime() + 1),
      );
      await advanceOrderLifecycleStep(
        completionClient,
        foundation.orderId,
        "COMPLETED",
        new Date(lastReconciledAt.getTime() + 2),
      );
      await completionClient.query("COMMIT");
    } catch (error) {
      await completionClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      completionClient.release();
    }

    const completedRecovery = (
      await pool.query<{
        captured_total_minor: string;
        order_status: string;
        payment_status: string;
        reconciliation_status: string;
        refund_amount_minor: string;
        refund_status: string;
        retained_amount_minor: string;
      }>(
        `SELECT target_order.status::text AS order_status,
                  payment.status::text AS payment_status,
                  refund.status::text AS refund_status,
                  reconciliation.status::text AS reconciliation_status,
                  settlement.captured_total_minor::text,
                  settlement.refund_amount_minor::text,
                  settlement.retained_amount_minor::text
           FROM orders target_order
           JOIN payments payment ON payment.order_id = target_order.id
           JOIN refund_transactions refund ON refund.id = $2
           JOIN handoff_reconciliations reconciliation
             ON reconciliation.order_id = target_order.id
           JOIN order_settlements settlement
             ON settlement.id = reconciliation.order_settlement_id
           WHERE target_order.id = $1`,
        [foundation.orderId, refundId],
      )
    ).rows;
    expect(completedRecovery).toHaveLength(2);
    expect(completedRecovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          order_status: "COMPLETED",
          payment_status: "REFUNDED",
          refund_status: "SUCCEEDED",
          reconciliation_status: "COMPLETED",
          retained_amount_minor: "0",
        }),
        expect.objectContaining({
          order_status: "COMPLETED",
          payment_status: "REFUNDED",
          refund_status: "SUCCEEDED",
          reconciliation_status: "COMPLETED",
          retained_amount_minor: "0",
        }),
      ]),
    );
    expect(
      completedRecovery.every(
        ({ captured_total_minor, refund_amount_minor }) =>
          captured_total_minor === refund_amount_minor &&
          BigInt(captured_total_minor) > 0n,
      ),
    ).toBe(true);
  });

  it("accepts a carrier scan before handoff and records later scans as no-ops", async () => {
    await rollback("delayed-acceptance-scan", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "delayed-acceptance-scan",
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
      const labelCreatedAt = (
        await client.query<{ label_created_at: Date }>(
          `SELECT label_created_at
           FROM shipments
           WHERE id = $1`,
          [foundation.shipmentId],
        )
      ).rows[0]?.label_created_at;
      if (!labelCreatedAt) {
        throw new Error("carrier skew fixture has no label timestamp");
      }
      await expectQueryError(
        client,
        "pre_handoff_scan_cannot_become_noop",
        async () => {
          await persistVerifiedAcceptanceScan(
            client,
            foundation.shipmentId,
            "orphaned-pre-handoff-acceptance-scan",
          );
          await advanceOrderLifecycleStep(
            client,
            foundation.orderId,
            "SHIPPED",
          );
        },
        {
          code: "23514",
          constraint: "shipment_provider_event_consumption_check",
        },
      );
      await expectQueryError(
        client,
        "acceptance_scan_beyond_negative_skew",
        () =>
          persistVerifiedAcceptanceScan(
            client,
            foundation.shipmentId,
            "acceptance-scan-beyond-negative-skew",
            new Date(labelCreatedAt.getTime() - 5_001),
          ),
        {
          code: "23514",
          constraint: "shipment_provider_event_evidence_check",
        },
      );
      const acceptanceOccurredAt = new Date(labelCreatedAt.getTime() - 5_000);
      const acceptedAt = await persistVerifiedAcceptanceScan(
        client,
        foundation.shipmentId,
        "pre-handoff-acceptance-scan",
        acceptanceOccurredAt,
      );
      await client.query(
        `UPDATE jobs
         SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, acceptedAt],
      );
      await client.query(
        `UPDATE shipments
         SET status = 'HANDED_OVER',
             provider_acceptance_scan_id = 'pre-handoff-acceptance-scan',
             handed_over_at = $2, updated_at = $2
         WHERE id = $1`,
        [foundation.shipmentId, acceptedAt],
      );
      await client.query(
        `UPDATE order_phases
         SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
         WHERE order_id = $1`,
        [foundation.orderId, acceptedAt],
      );
      await client.query(
        `UPDATE orders
         SET status = 'SHIPPED', updated_at = $2
         WHERE id = $1`,
        [foundation.orderId, acceptedAt],
      );
      await forceOrderLifecycleConstraints(client);

      const original = (
        await client.query<{
          handed_over_at: Date;
          provider_acceptance_scan_id: string | null;
        }>(
          `SELECT handed_over_at, provider_acceptance_scan_id
           FROM shipments
           WHERE id = $1`,
          [foundation.shipmentId],
        )
      ).rows[0];
      if (!original?.handed_over_at) {
        throw new Error("ordinary handoff evidence is unavailable");
      }
      expect(original.provider_acceptance_scan_id).toBe(
        "pre-handoff-acceptance-scan",
      );
      const transitAt = new Date(original.handed_over_at.getTime() + 100);
      const deliveredAt = new Date(original.handed_over_at.getTime() + 200);
      const scanOccurredAt = new Date(
        original.handed_over_at.getTime() - 5_000,
      );
      const scanBeyondSkew = new Date(
        original.handed_over_at.getTime() - 5_001,
      );

      for (const status of [
        "HANDED_OVER",
        "IN_TRANSIT",
        "DELIVERED",
      ] as const) {
        const providerEventId = `delayed-${status.toLowerCase()}-acceptance`;
        await persistVerifiedAcceptanceScan(
          client,
          foundation.shipmentId,
          providerEventId,
        );
        await client.query(
          `SET CONSTRAINTS "shipment_provider_events_consumed" IMMEDIATE`,
        );
        await client.query(
          `SET CONSTRAINTS "shipment_provider_events_consumed" DEFERRED`,
        );
        expect(
          (
            await client.query<{
              event_count: string;
              handed_over_at: Date;
              provider_acceptance_scan_id: string | null;
              status: string;
            }>(
              `SELECT shipment.status::text AS status,
                      shipment.handed_over_at,
                      shipment.provider_acceptance_scan_id,
                      count(event.id)::text AS event_count
               FROM shipments shipment
               JOIN shipment_provider_events event
                 ON event.shipment_id = shipment.id
                AND event.kind = 'ACCEPTANCE_SCAN'
               WHERE shipment.id = $1
               GROUP BY shipment.status, shipment.handed_over_at,
                        shipment.provider_acceptance_scan_id`,
              [foundation.shipmentId],
            )
          ).rows,
        ).toEqual([
          {
            event_count:
              status === "HANDED_OVER"
                ? "2"
                : status === "IN_TRANSIT"
                  ? "3"
                  : "4",
            handed_over_at: original.handed_over_at,
            provider_acceptance_scan_id: "pre-handoff-acceptance-scan",
            status,
          },
        ]);

        if (status === "HANDED_OVER") {
          await expectQueryError(
            client,
            "transit_scan_beyond_negative_skew",
            () =>
              persistVerifiedShipmentOutcome(
                client,
                foundation.shipmentId,
                "TRANSIT_SCAN",
                transitAt,
                "transit-beyond-negative-skew",
                true,
                scanBeyondSkew,
              ),
            {
              code: "23514",
              constraint: "shipment_provider_event_evidence_check",
            },
          );
          await persistVerifiedShipmentOutcome(
            client,
            foundation.shipmentId,
            "TRANSIT_SCAN",
            transitAt,
            "transit-at-negative-skew-boundary",
            true,
            scanOccurredAt,
          );
        } else if (status === "IN_TRANSIT") {
          await expectQueryError(
            client,
            "delivery_scan_beyond_negative_skew",
            () =>
              persistVerifiedShipmentOutcome(
                client,
                foundation.shipmentId,
                "DELIVERY_SCAN",
                deliveredAt,
                "delivery-beyond-negative-skew",
                true,
                scanBeyondSkew,
              ),
            {
              code: "23514",
              constraint: "shipment_provider_event_evidence_check",
            },
          );
          await persistVerifiedShipmentOutcome(
            client,
            foundation.shipmentId,
            "DELIVERY_SCAN",
            deliveredAt,
            "delivery-at-negative-skew-boundary",
            true,
            scanOccurredAt,
          );
        }
      }

      expect(
        (
          await client.query<{ kind: string; occurred_at: Date }>(
            `SELECT kind::text, occurred_at
             FROM shipment_provider_events
             WHERE shipment_id = $1
               AND (
                 provider_event_id = 'pre-handoff-acceptance-scan'
                 OR provider_transaction_id IN (
                   'transit-at-negative-skew-boundary',
                   'delivery-at-negative-skew-boundary'
                 )
               )
             ORDER BY CASE kind
               WHEN 'ACCEPTANCE_SCAN' THEN 1
               WHEN 'TRANSIT_SCAN' THEN 2
               ELSE 3
             END`,
            [foundation.shipmentId],
          )
        ).rows,
      ).toEqual([
        { kind: "ACCEPTANCE_SCAN", occurred_at: acceptanceOccurredAt },
        { kind: "TRANSIT_SCAN", occurred_at: scanOccurredAt },
        { kind: "DELIVERY_SCAN", occurred_at: scanOccurredAt },
      ]);

      const delivered = (
        await client.query<{
          delivered_at: Date;
          handed_over_at: Date;
          provider_acceptance_scan_id: string | null;
          status: string;
        }>(
          `SELECT status::text, handed_over_at, delivered_at,
                  provider_acceptance_scan_id
           FROM shipments
           WHERE id = $1`,
          [foundation.shipmentId],
        )
      ).rows[0];
      if (!delivered?.delivered_at) {
        throw new Error("delivered shipment evidence is unavailable");
      }
      await persistVerifiedShipmentOutcome(
        client,
        foundation.shipmentId,
        "TRANSIT_SCAN",
        new Date(original.handed_over_at.getTime() + 300),
        "delayed-post-delivery-transit",
        false,
      );
      expect(
        (
          await client.query<{
            delivered_at: Date;
            handed_over_at: Date;
            provider_acceptance_scan_id: string | null;
            status: string;
            transit_event_count: string;
          }>(
            `SELECT shipment.status::text AS status,
                    shipment.handed_over_at,
                    shipment.delivered_at,
                    shipment.provider_acceptance_scan_id,
                    count(event.id)::text AS transit_event_count
             FROM shipments shipment
             JOIN shipment_provider_events event
               ON event.shipment_id = shipment.id
              AND event.kind = 'TRANSIT_SCAN'
             WHERE shipment.id = $1
             GROUP BY shipment.status, shipment.handed_over_at,
                      shipment.delivered_at,
                      shipment.provider_acceptance_scan_id`,
            [foundation.shipmentId],
          )
        ).rows,
      ).toEqual([
        {
          delivered_at: delivered.delivered_at,
          handed_over_at: delivered.handed_over_at,
          provider_acceptance_scan_id: delivered.provider_acceptance_scan_id,
          status: "DELIVERED",
          transit_event_count: "2",
        },
      ]);

      const shipmentClockSkewAnchor = (
        await client.query<{ authenticated_at: Date }>(
          `SELECT clock_timestamp() - interval '1 second' AS authenticated_at`,
        )
      ).rows[0]?.authenticated_at;
      if (!shipmentClockSkewAnchor) {
        throw new Error("shipment provider clock-skew anchor is unavailable");
      }
      await expectQueryError(
        client,
        "shipment_provider_occurrence_beyond_authentication_skew",
        () =>
          persistVerifiedShipmentOutcome(
            client,
            foundation.shipmentId,
            "TRANSIT_SCAN",
            shipmentClockSkewAnchor,
            "transit-beyond-authentication-skew",
            false,
            new Date(shipmentClockSkewAnchor.getTime() + 5_001),
          ),
        {
          code: "23514",
          constraint: "shipment_provider_event_evidence_check",
        },
      );
      const shipmentOccurrenceAtSkewBoundary = new Date(
        shipmentClockSkewAnchor.getTime() + 5_000,
      );
      await persistVerifiedShipmentOutcome(
        client,
        foundation.shipmentId,
        "TRANSIT_SCAN",
        shipmentClockSkewAnchor,
        "transit-at-authentication-skew-boundary",
        false,
        shipmentOccurrenceAtSkewBoundary,
      );
      expect(
        (
          await client.query<{
            authenticated_at: Date;
            delivered_at: Date;
            occurred_at: Date;
            verified_at: Date;
          }>(
            `SELECT event.occurred_at, event.authenticated_at,
                    event.verified_at, shipment.delivered_at
             FROM shipment_provider_events event
             JOIN shipments shipment ON shipment.id = event.shipment_id
             WHERE event.shipment_id = $1
               AND event.provider_transaction_id =
                   'transit-at-authentication-skew-boundary'`,
            [foundation.shipmentId],
          )
        ).rows,
      ).toEqual([
        {
          occurred_at: shipmentOccurrenceAtSkewBoundary,
          authenticated_at: shipmentClockSkewAnchor,
          verified_at: shipmentClockSkewAnchor,
          delivered_at: delivered.delivered_at,
        },
      ]);
    });
  });

  it("composes Shipment receipt and lifecycle clock-skew bounds", async () => {
    await rollback(
      "shipment-lifecycle-clock-skew",
      async (client, fixtures) => {
        const prepareLabelledShipment = async (name: string) => {
          const foundation = await fixtures.createFoundation(name);
          const productions = await createCurrentPlanAndPayment(
            client,
            fixtures,
            foundation,
          );
          await activateCurrentPlan(client, fixtures, foundation, productions);
          const productionAt = new Date();
          await advanceOrderLifecycleStep(
            client,
            foundation.orderId,
            "IN_PRODUCTION",
            productionAt,
          );
          await advanceOrderLifecycleStep(
            client,
            foundation.orderId,
            "QC_PASSED",
            productionAt,
          );
          const packedAt = productionAt;
          const labelCreatedAt = new Date(packedAt.getTime() + 5_000);
          await client.query(
            `UPDATE jobs
           SET status = 'PACKED', packed_at = $2, updated_at = $2
           WHERE order_id = $1`,
            [foundation.orderId, packedAt],
          );
          await client.query(
            `UPDATE shipments
           SET status = 'LABEL_CREATED', carrier = 'skew-carrier',
               provider_shipment_id = 'skew-provider-' || id::text,
               carrier_label_id = 'skew-label-' || id::text,
               tracking_code = 'skew-tracking-' || id::text,
               label_created_at = $2, updated_at = $2
           WHERE id = $1`,
            [foundation.shipmentId, labelCreatedAt],
          );
          await client.query(
            `UPDATE orders
           SET status = 'READY_TO_SHIP', updated_at = $2 WHERE id = $1`,
            [foundation.orderId, packedAt],
          );
          await forceOrderLifecycleConstraints(client);
          return { foundation, labelCreatedAt, packedAt };
        };

        const persistAcceptance = async (
          shipmentId: string,
          providerEventId: string,
          occurredAt: Date,
          verifiedAt: Date,
        ) => {
          await client.query(
            `INSERT INTO shipment_provider_events
             (id, shipment_id, carrier, carrier_label_id, provider_event_id,
              provider_transaction_id, kind, occurred_at, authenticated_at,
              verified_at, created_at)
           SELECT $1, shipment.id, shipment.carrier,
                  shipment.carrier_label_id, $3, $4, 'ACCEPTANCE_SCAN',
                  $5, $6, $6, statement_timestamp()
           FROM shipments shipment
           WHERE shipment.id = $2`,
            [
              randomUUID(),
              shipmentId,
              providerEventId,
              `${providerEventId}:transaction`,
              occurredAt,
              verifiedAt,
            ],
          );
        };

        const boundary = await prepareLabelledShipment("handoff-skew-boundary");
        const beyond = await prepareLabelledShipment("handoff-skew-beyond");
        const cancellation = await prepareLabelledShipment(
          "cancellation-skew-boundary",
        );
        const cancellationRequestedAt = new Date(
          cancellation.labelCreatedAt.getTime() - 5_000,
        );
        const voidOccurredAt = cancellationRequestedAt;
        const voidVerifiedAt = new Date(voidOccurredAt.getTime() - 5_000);
        const cancelledAt = new Date(voidVerifiedAt.getTime() - 5_000);
        await client.query(
          `UPDATE shipments
           SET status = 'CANCELLATION_PENDING',
               cancellation_requested_at = $2, updated_at = $2
           WHERE id = $1`,
          [cancellation.foundation.shipmentId, cancellationRequestedAt],
        );
        const voidCommandId = (
          await client.query<{ id: string }>(
            `UPDATE outbox_messages message
             SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
             FROM shipments shipment
             WHERE shipment.id = $1
               AND message.deduplication_key =
                   'void_carrier_label:' || shipment.id::text || ':' ||
                   shipment.carrier_label_id
             RETURNING message.id`,
            [cancellation.foundation.shipmentId, voidOccurredAt],
          )
        ).rows[0]?.id;
        if (!voidCommandId) {
          throw new Error("clock-skew void command was not persisted");
        }
        await client.query(
          `INSERT INTO shipment_provider_events
             (id, shipment_id, outbox_message_id, carrier, carrier_label_id,
              provider_event_id, provider_transaction_id, kind, occurred_at,
              authenticated_at, verified_at, created_at)
           SELECT $1, shipment.id, $3, shipment.carrier,
                  shipment.carrier_label_id, $4, $5, 'LABEL_VOIDED',
                  $6, $7, $7, statement_timestamp()
           FROM shipments shipment
           WHERE shipment.id = $2`,
          [
            randomUUID(),
            cancellation.foundation.shipmentId,
            voidCommandId,
            "cancellation-skew-boundary-void",
            "cancellation-skew-boundary-void:transaction",
            voidOccurredAt,
            voidVerifiedAt,
          ],
        );
        await client.query(
          `UPDATE shipments
           SET status = 'CANCELLED',
               provider_void_id = 'cancellation-skew-boundary-void',
               provider_voided_at = $2, cancelled_at = $3, updated_at = $3
           WHERE id = $1`,
          [cancellation.foundation.shipmentId, voidVerifiedAt, cancelledAt],
        );
        await cancelOrderBeforeHandoff(client, cancellation.foundation.orderId);
        expect(
          (
            await client.query<{
              cancelled_at: Date;
              label_created_at: Date;
              provider_voided_at: Date;
            }>(
              `SELECT label_created_at, provider_voided_at, cancelled_at
               FROM shipments WHERE id = $1`,
              [cancellation.foundation.shipmentId],
            )
          ).rows,
        ).toEqual([
          {
            label_created_at: cancellation.labelCreatedAt,
            provider_voided_at: voidVerifiedAt,
            cancelled_at: cancelledAt,
          },
        ]);
        const boundaryOccurredAt = new Date(
          boundary.labelCreatedAt.getTime() - 5_000,
        );
        const boundaryHandoffAt = new Date(
          boundaryOccurredAt.getTime() - 5_000,
        );
        await persistAcceptance(
          boundary.foundation.shipmentId,
          "handoff-skew-boundary-acceptance",
          boundaryOccurredAt,
          boundaryHandoffAt,
        );
        await client.query(
          `UPDATE jobs
           SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
           WHERE order_id = $1`,
          [boundary.foundation.orderId, boundaryHandoffAt],
        );
        await client.query(
          `UPDATE shipments
         SET status = 'HANDED_OVER',
             provider_acceptance_scan_id = 'handoff-skew-boundary-acceptance',
             handed_over_at = $2, updated_at = $2
         WHERE id = $1`,
          [boundary.foundation.shipmentId, boundaryHandoffAt],
        );
        await client.query(
          `UPDATE order_phases
           SET status = 'SHIPPED', shipped_at = $2, updated_at = $2
           WHERE id = $1`,
          [boundary.foundation.orderPhaseId, boundaryHandoffAt],
        );
        await client.query(
          `UPDATE orders
           SET status = 'SHIPPED', updated_at = $2 WHERE id = $1`,
          [boundary.foundation.orderId, boundaryHandoffAt],
        );
        await forceOrderLifecycleConstraints(client);
        expect(
          (
            await client.query<{
              acceptance_verified_at: Date;
              acceptance_occurred_at: Date;
              handed_over_at: Date;
              label_created_at: Date;
            }>(
              `SELECT shipment.label_created_at, shipment.handed_over_at,
                    event.occurred_at AS acceptance_occurred_at,
                    event.verified_at AS acceptance_verified_at
             FROM shipments shipment
             JOIN shipment_provider_events event
               ON event.shipment_id = shipment.id
              AND event.provider_event_id =
                  shipment.provider_acceptance_scan_id
             WHERE shipment.id = $1`,
              [boundary.foundation.shipmentId],
            )
          ).rows,
        ).toEqual([
          {
            label_created_at: boundary.labelCreatedAt,
            handed_over_at: boundaryHandoffAt,
            acceptance_occurred_at: boundaryOccurredAt,
            acceptance_verified_at: boundaryHandoffAt,
          },
        ]);

        const beyondOccurredAt = new Date(
          beyond.labelCreatedAt.getTime() - 5_001,
        );
        await expectQueryError(
          client,
          "shipment_acceptance_beyond_clock_skew",
          () =>
            persistAcceptance(
              beyond.foundation.shipmentId,
              "handoff-skew-beyond-acceptance",
              beyondOccurredAt,
              beyondOccurredAt,
            ),
          {
            code: "23514",
            constraint: "shipment_provider_event_evidence_check",
          },
        );
      },
    );
  });

  it("rejects future evidence for every Shipment lifecycle timestamp", async () => {
    await rollback("future-shipment-evidence", async (client, fixtures) => {
      const toleratedFoundation = await fixtures.createFoundation(
        "tolerated-future-shipment-evidence",
      );
      await client.query(
        `UPDATE shipments
         SET status = 'LABEL_CREATED', carrier = 'tolerated-carrier',
             provider_shipment_id = 'tolerated-provider',
             carrier_label_id = 'tolerated-label',
             tracking_code = 'tolerated-tracking',
             label_created_at = clock_timestamp() + interval '2 seconds',
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [toleratedFoundation.shipmentId],
      );
      expect(
        (
          await client.query<{ status: string }>(
            `SELECT status::text FROM shipments WHERE id = $1`,
            [toleratedFoundation.shipmentId],
          )
        ).rows,
      ).toEqual([{ status: "LABEL_CREATED" }]);

      const foundation = await fixtures.createFoundation(
        "future-shipment-evidence",
      );
      const shipmentId = foundation.shipmentId;
      const futureEvidenceColumns = [
        "label_created_at",
        "handed_over_at",
        "delivered_at",
        "cancelled_at",
      ] as const;

      for (const column of futureEvidenceColumns) {
        await expectQueryError(
          client,
          `future_${column}`,
          async () => {
            const past = new Date(Date.now() - 60_000);
            const future = new Date(Date.now() + 60_000);
            if (column === "label_created_at") {
              await client.query(
                `UPDATE shipments
                 SET status = 'LABEL_CREATED', carrier = 'future-carrier',
                     provider_shipment_id = 'future-provider',
                     carrier_label_id = 'future-label',
                     tracking_code = 'future-tracking',
                     label_created_at = $2, updated_at = $2
                 WHERE id = $1`,
                [shipmentId, future],
              );
            } else if (column === "handed_over_at") {
              await client.query(
                `UPDATE shipments
                 SET status = 'LABEL_CREATED', carrier = 'past-carrier',
                     provider_shipment_id = 'past-provider',
                     carrier_label_id = 'past-label',
                     tracking_code = 'past-tracking',
                     label_created_at = $2, updated_at = $2
                 WHERE id = $1`,
                [shipmentId, past],
              );
              await client.query(
                `UPDATE shipments
                 SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
                 WHERE id = $1`,
                [shipmentId, future],
              );
            } else if (column === "delivered_at") {
              await client.query(
                `UPDATE shipments
                 SET status = 'LABEL_CREATED', carrier = 'delivered-carrier',
                     provider_shipment_id = 'delivered-provider',
                     carrier_label_id = 'delivered-label',
                     tracking_code = 'delivered-tracking',
                     label_created_at = $2, updated_at = $2
                 WHERE id = $1`,
                [shipmentId, past],
              );
              await client.query(
                `UPDATE shipments
                 SET status = 'HANDED_OVER', handed_over_at = $2, updated_at = $2
                 WHERE id = $1`,
                [shipmentId, past],
              );
              await persistVerifiedShipmentOutcome(
                client,
                shipmentId,
                "TRANSIT_SCAN",
                past,
              );
              await client.query(
                `UPDATE shipments
                 SET status = 'DELIVERED', delivered_at = $2, updated_at = $2
                 WHERE id = $1`,
                [shipmentId, future],
              );
            } else {
              await client.query(
                `UPDATE shipments
                 SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2
                 WHERE id = $1`,
                [shipmentId, future],
              );
            }
          },
          {
            code: "23514",
            constraint: "shipment_lifecycle_evidence_check",
          },
        );
      }
    });
  });

  it("bounds financial, audit, and Job lifecycle evidence by the database clock", async () => {
    await rollback("future-commerce-evidence", async (client, fixtures) => {
      const financial = await fixtures.createFoundation(
        "future-financial-evidence",
      );
      await createCurrentPlanAndPayment(client, fixtures, financial);

      expect(
        (
          await client.query<{ table_name: string }>(
            `SELECT target.relname AS table_name
             FROM pg_trigger trigger_definition
             JOIN pg_class target ON target.oid = trigger_definition.tgrelid
             WHERE trigger_definition.tgname = 'commerce_creation_evidence_bounded'
               AND NOT trigger_definition.tgisinternal
             ORDER BY target.relname`,
          )
        ).rows.map(({ table_name }) => table_name),
      ).toEqual([
        "customers",
        "delivery_destinations",
        "fulfilment_slots",
        "handoff_reconciliations",
        "jobs",
        "order_items",
        "order_phases",
        "order_price_bindings",
        "order_settlements",
        "orders",
        "payment_schedules",
        "payments",
        "price_snapshot_components",
        "price_snapshots",
        "quote_items",
        "quote_requests",
        "quote_sessions",
        "quotes",
        "refund_transactions",
        "shipment_plans",
        "shipment_provider_events",
        "shipments",
      ]);

      await client.query(
        `INSERT INTO quote_sessions
           (id, public_token_hash, expires_at, created_at, updated_at)
         VALUES ($1,$2,clock_timestamp() + interval '1 hour',
                    clock_timestamp() + interval '2 seconds',clock_timestamp()),
                ($3,$4,clock_timestamp() + interval '1 hour',
                    clock_timestamp() - interval '30 days',clock_timestamp())`,
        [
          fixtures.id("tolerated-creation-evidence"),
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          fixtures.id("historical-creation-evidence"),
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
        ],
      );
      await expectQueryError(
        client,
        "future_price_snapshot_creation",
        () =>
          client.query(
            `INSERT INTO price_snapshots
               (id, price_list_id, currency, contract_total_minor, pricing_revision,
                input_snapshot, snapshot_hash, created_at)
             VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                     'EUR',0,'legacy-v0-eur','{}'::jsonb,$2,
                     clock_timestamp() + interval '60 seconds')`,
            [
              fixtures.id("future-price-snapshot-creation"),
              randomUUID().replaceAll("-", "").padEnd(64, "0"),
            ],
          ),
        {
          code: "23514",
          constraint: "price_snapshots_creation_evidence_check",
        },
      );

      await expectQueryError(
        client,
        "future_audit_event",
        () =>
          client.query(
            `INSERT INTO audit_events
               (id, order_id, event_type, payload, created_at)
             VALUES ($1,$2,'audit.future','{}'::jsonb,
                     clock_timestamp() + interval '60 seconds')`,
            [fixtures.id("future-audit-event"), financial.orderId],
          ),
        { code: "23514", constraint: "audit_event_created_at_check" },
      );
      await client.query(
        `INSERT INTO audit_events
           (id, order_id, event_type, payload, created_at)
         VALUES ($1,$2,'audit.tolerated_skew','{}'::jsonb,
                 clock_timestamp() + interval '2 seconds'),
                ($3,$2,'audit.historical','{}'::jsonb,
                 clock_timestamp() - interval '30 days')`,
        [
          fixtures.id("tolerated-future-audit-event"),
          financial.orderId,
          fixtures.id("historical-audit-event"),
        ],
      );
      await client.query(
        `INSERT INTO audit_events (id, order_id, event_type, payload)
         VALUES ($1,$2,'audit.default_timestamp','{}'::jsonb)`,
        [fixtures.id("default-timestamp-audit-event"), financial.orderId],
      );

      const jobs = await fixtures.createFoundation("future-job-evidence");
      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        jobs,
      );
      const futureJobProduction = productions[0];
      if (!futureJobProduction) {
        throw new Error(
          "expected a planned production for future Job evidence",
        );
      }
      await expectQueryError(
        client,
        "future_job_creation",
        () =>
          client.query(
            `INSERT INTO jobs
               (id, node_id, order_id, order_phase_id, shipment_plan_id,
                phase_resource_plan_job_id, status, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,'CREATED',
                     clock_timestamp() + interval '60 seconds',clock_timestamp())`,
            [
              fixtures.id("future-job-creation"),
              jobs.nodeId,
              jobs.orderId,
              jobs.orderPhaseId,
              futureJobProduction.shipmentPlanId,
              futureJobProduction.phaseResourcePlanJobId,
            ],
          ),
        { code: "23514", constraint: "jobs_creation_evidence_check" },
      );
      await activateCurrentPlan(client, fixtures, jobs, productions);
      await client.query(
        `UPDATE jobs
         SET status = 'ACCEPTED',
             accepted_at = clock_timestamp() + interval '2 seconds',
             payout_amount = 0, payout_currency = 'EUR',
             updated_at = clock_timestamp()
         WHERE order_id = $1`,
        [jobs.orderId],
      );

      const futureJobEvidenceColumns = [
        "accepted_at",
        "gcode_ready_at",
        "printing_at",
        "printed_at",
        "photo_submitted_at",
        "qc_approved_at",
        "qc_rejected_at",
        "packed_at",
        "handed_over_at",
        "settled_at",
        "failed_at",
        "cancelled_at",
      ] as const;
      for (const column of futureJobEvidenceColumns) {
        await expectQueryError(
          client,
          `future_job_${column}`,
          () =>
            client.query(
              `UPDATE jobs
               SET "${column}" = clock_timestamp() + interval '60 seconds',
                   updated_at = clock_timestamp()
               WHERE order_id = $1`,
              [jobs.orderId],
            ),
          {
            code: "23514",
            constraint: "job_lifecycle_evidence_check",
            message: "Job lifecycle evidence cannot be in the future",
          },
        );
      }

      await expectQueryError(
        client,
        "future_payment_capture",
        () =>
          client.query(
            `UPDATE payments
             SET status = 'CAPTURED',
                 captured_amount_minor = requested_amount_minor,
                 provider_capture_id = 'future-payment-capture',
                 captured_at = clock_timestamp() + interval '60 seconds',
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [financial.paymentId],
          ),
        {
          code: "23514",
          constraint: "payment_capture_evidence_check",
        },
      );
      const toleratedPaymentCapturedAt = new Date(Date.now() + 2_000);
      await fixtures.persistPaymentProviderEvent(
        financial.paymentId,
        "PAYMENT_CAPTURED",
        "tolerated-payment-capture",
        toleratedPaymentCapturedAt,
      );
      await client.query(
        `UPDATE payments
         SET status = 'CAPTURED',
             captured_amount_minor = requested_amount_minor,
             provider_capture_id = 'tolerated-payment-capture',
             captured_at = $2,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [financial.paymentId, toleratedPaymentCapturedAt],
      );

      await expectQueryError(
        client,
        "future_refund_request",
        () =>
          client.query(
            `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                requested_at, created_at, updated_at)
             VALUES ($1,$2,$3,1,'PRODUCTION_FAILURE','PENDING',
                     clock_timestamp() + interval '60 seconds',
                     clock_timestamp(), clock_timestamp())`,
            [
              fixtures.id("future-refund-request"),
              financial.paymentId,
              "future-refund-request",
            ],
          ),
        {
          code: "23514",
          constraint: "refund_request_evidence_check",
        },
      );

      await expectQueryError(
        client,
        "refund_request_beyond_negative_skew",
        () =>
          client.query(
            `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                requested_at, created_at, updated_at)
             SELECT $1,$2,$3,1,'PRODUCTION_FAILURE','PENDING',
                    captured_at - interval '5 seconds 1 millisecond',
                    clock_timestamp(),clock_timestamp()
             FROM payments WHERE id = $2`,
            [
              fixtures.id("refund-request-beyond-negative-skew"),
              financial.paymentId,
              "refund-request-beyond-negative-skew",
            ],
          ),
        {
          code: "23514",
          constraint: "refund_capture_timestamp_order_check",
        },
      );
      for (const status of ["SUCCEEDED", "FAILED"] as const) {
        await expectQueryError(
          client,
          `insert_terminal_${status.toLowerCase()}_refund`,
          () =>
            client.query(
              `INSERT INTO refund_transactions
                 (id, payment_id, idempotency_key, provider_refund_id,
                  amount_minor, reason, status, requested_at, completed_at,
                  created_at, updated_at)
               SELECT $1,$2,$3::text,
                      CASE WHEN $4::refund_status = 'SUCCEEDED'::refund_status
                           THEN $3::text ELSE NULL END,
                      1,'CUSTOMER_CANCELLATION',$4::refund_status,captured_at,
                      CASE WHEN $4::refund_status = 'SUCCEEDED'::refund_status
                           THEN captured_at ELSE NULL END,
                      clock_timestamp(),clock_timestamp()
               FROM payments WHERE id = $2`,
              [
                fixtures.id(`terminal-${status.toLowerCase()}-refund`),
                financial.paymentId,
                `terminal-${status.toLowerCase()}-refund`,
                status,
              ],
            ),
          {
            code: "23514",
            constraint: "refund_transaction_initial_status_check",
          },
        );
      }
      await client.query(
        `INSERT INTO refund_transactions
           (id, payment_id, idempotency_key, amount_minor, reason, status,
            requested_at, created_at, updated_at)
         VALUES ($1,$2,$3,1,'PRODUCTION_FAILURE','PENDING',
                 (SELECT captured_at - interval '5 seconds'
                  FROM payments WHERE id = $2),
                 clock_timestamp(), clock_timestamp())`,
        [
          fixtures.id("pending-refund-completion"),
          financial.paymentId,
          "pending-refund-completion",
        ],
      );
      await expectQueryError(
        client,
        "complete_pending_refund",
        () =>
          client.query(
            `UPDATE refund_transactions
             SET completed_at = (
                   SELECT captured_at FROM payments WHERE id = payment_id
                 ),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [fixtures.id("pending-refund-completion")],
          ),
        {
          code: "23514",
          constraint: "refund_transactions_completion_status_check",
        },
      );
      await expectQueryError(
        client,
        "insert_completed_pending_refund",
        () =>
          client.query(
            `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                requested_at, completed_at, created_at, updated_at)
             SELECT $1,$2,$3,1,'PRODUCTION_FAILURE','PENDING',
                    captured_at,captured_at,
                    clock_timestamp(),clock_timestamp()
             FROM payments WHERE id = $2`,
            [
              fixtures.id("completed-pending-refund"),
              financial.paymentId,
              "completed-pending-refund",
            ],
          ),
        {
          code: "23514",
          constraint: "refund_transactions_completion_status_check",
        },
      );
      await expectQueryError(
        client,
        "future_refund_update",
        () =>
          client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED',
                 provider_refund_id = 'future-refund-update',
                 completed_at = clock_timestamp() + interval '60 seconds',
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [fixtures.id("pending-refund-completion")],
          ),
        {
          code: "23514",
          constraint: "refund_completion_evidence_check",
        },
      );
      const refundCompletionBeyondNegativeSkew = new Date(
        toleratedPaymentCapturedAt.getTime() - 5_001,
      );
      await expectQueryError(
        client,
        "refund_completion_beyond_negative_skew",
        async () => {
          await fixtures.persistRefundProviderEvent(
            fixtures.id("pending-refund-completion"),
            "REFUND_SUCCEEDED",
            "refund-completion-beyond-negative-skew",
            refundCompletionBeyondNegativeSkew,
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED',
                 provider_refund_id = 'refund-completion-beyond-negative-skew',
                 completed_at = $2,
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [
              fixtures.id("pending-refund-completion"),
              refundCompletionBeyondNegativeSkew,
            ],
          );
        },
        {
          code: "23514",
          constraint: "refund_capture_timestamp_order_check",
        },
      );
      const refundCompletionAtNegativeSkewBoundary = new Date(
        toleratedPaymentCapturedAt.getTime() - 5_000,
      );
      await fixtures.persistRefundProviderEvent(
        fixtures.id("pending-refund-completion"),
        "REFUND_SUCCEEDED",
        "refund-completion-at-negative-skew-boundary",
        refundCompletionAtNegativeSkewBoundary,
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED',
             provider_refund_id = 'refund-completion-at-negative-skew-boundary',
             completed_at = $2,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [
          fixtures.id("pending-refund-completion"),
          refundCompletionAtNegativeSkewBoundary,
        ],
      );
      expect(
        (
          await client.query<{
            completed_at: Date;
            requested_at: Date;
          }>(
            `SELECT requested_at, completed_at
             FROM refund_transactions WHERE id = $1`,
            [fixtures.id("pending-refund-completion")],
          )
        ).rows,
      ).toEqual([
        {
          requested_at: refundCompletionAtNegativeSkewBoundary,
          completed_at: refundCompletionAtNegativeSkewBoundary,
        },
      ]);
    });
  });

  it("records immutable checkout acceptance before payment and confirmation", async () => {
    await rollback("checkout-acceptance", async (client, fixtures) => {
      const checkout = await fixtures.createFoundation(
        "checkout-acceptance",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      const quotedAt = new Date();
      await client.query(
        `UPDATE orders
         SET status = 'QUOTED', quoted_at = $2, updated_at = $2
         WHERE id = $1`,
        [checkout.orderId, quotedAt],
      );
      const replacementSnapshotId = fixtures.id(
        "checkout-acceptance:replacement-snapshot",
      );
      const replacementBindingId = fixtures.id(
        "checkout-acceptance:replacement-binding",
      );
      await client.query(
        `INSERT INTO price_snapshots
           (id, price_list_id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         SELECT $1, price_list_id, currency, contract_total_minor,
                pricing_revision, input_snapshot, $2, clock_timestamp()
         FROM price_snapshots WHERE id = $3`,
        [
          replacementSnapshotId,
          randomUUID().replaceAll("-", "").repeat(2),
          checkout.priceSnapshotId,
        ],
      );
      await client.query(
        `INSERT INTO order_price_bindings
           (id, order_id, price_snapshot_id, delivery_destination_id, created_at)
         VALUES ($1,$2,$3,$4,clock_timestamp())`,
        [
          replacementBindingId,
          checkout.orderId,
          replacementSnapshotId,
          checkout.deliveryDestinationId,
        ],
      );

      await expectQueryError(
        client,
        "accept_inactive_price_binding",
        () =>
          client.query(
            `UPDATE orders
             SET accepted_order_price_binding_id = $2,
                 accepted_terms_revision = 'terms-v1',
                 accepted_claim_policy_revision = 'claim-policy-v1',
                 withdrawal_exception_acknowledged_at = clock_timestamp()
             WHERE id = $1`,
            [checkout.orderId, replacementBindingId],
          ),
        {
          code: "23514",
          constraint: "order_checkout_acceptance_binding_check",
        },
      );

      await expectQueryError(
        client,
        "partial_checkout_acceptance",
        () =>
          client.query(
            `UPDATE orders SET accepted_terms_revision = 'terms-partial'
             WHERE id = $1`,
            [checkout.orderId],
          ),
        {
          code: "23514",
          constraint: "order_checkout_acceptance_immutable_check",
        },
      );
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await expectQueryError(
        client,
        "partial_checkout_acceptance_shape",
        () =>
          client.query(
            `UPDATE orders
             SET accepted_claim_policy_revision = 'claim-policy-partial',
                 withdrawal_exception_acknowledged_at = clock_timestamp()
             WHERE id = $1`,
            [checkout.orderId],
          ),
        {
          code: "23514",
          constraint: "orders_checkout_acceptance_shape_check",
        },
      );
      await client.query(`SET LOCAL session_replication_role = 'origin'`);
      await expectQueryError(
        client,
        "mismatched_checkout_terms_revision",
        () =>
          client.query(
            `UPDATE orders
             SET accepted_order_price_binding_id = $2,
                 accepted_terms_revision = 'terms-v2',
                 accepted_claim_policy_revision = 'claim-policy-v1',
                 withdrawal_exception_acknowledged_at = clock_timestamp()
             WHERE id = $1`,
            [checkout.orderId, checkout.orderPriceBindingId],
          ),
        {
          code: "23514",
          constraint: "order_checkout_acceptance_terms_revision_check",
        },
      );
      await expectQueryError(
        client,
        "future_checkout_acceptance",
        () =>
          client.query(
            `UPDATE orders
             SET accepted_order_price_binding_id = $2,
                 accepted_terms_revision = 'terms-v1',
                 accepted_claim_policy_revision = 'claim-policy-v1',
                 withdrawal_exception_acknowledged_at =
                   clock_timestamp() + interval '60 seconds'
             WHERE id = $1`,
            [checkout.orderId, checkout.orderPriceBindingId],
          ),
        {
          code: "23514",
          constraint: "order_checkout_acceptance_evidence_check",
        },
      );

      await fixtures.acceptCheckoutTerms(checkout);
      expect(
        (
          await client.query<{
            accepted_claim_policy_revision: string;
            accepted_order_price_binding_id: string;
            accepted_terms_revision: string;
            withdrawal_exception_acknowledged_at: Date;
          }>(
            `SELECT accepted_order_price_binding_id,
                    accepted_terms_revision,
                    accepted_claim_policy_revision,
                    withdrawal_exception_acknowledged_at
             FROM orders WHERE id = $1`,
            [checkout.orderId],
          )
        ).rows,
      ).toEqual([
        {
          accepted_claim_policy_revision: "claim-policy-v1",
          accepted_order_price_binding_id: checkout.orderPriceBindingId,
          accepted_terms_revision: "terms-v1",
          withdrawal_exception_acknowledged_at: expect.any(Date),
        },
      ]);
      await client.query(
        `UPDATE order_active_price_bindings
         SET order_price_binding_id = order_price_binding_id
         WHERE order_id = $1`,
        [checkout.orderId],
      );
      await expectQueryError(
        client,
        "move_active_binding_after_checkout_acceptance",
        () =>
          client.query(
            `UPDATE order_active_price_bindings
             SET order_price_binding_id = $2 WHERE order_id = $1`,
            [checkout.orderId, replacementBindingId],
          ),
        {
          code: "23514",
          constraint: "active_order_price_binding_acceptance_guard",
        },
      );

      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE orders SET accepted_order_price_binding_id = $2 WHERE id = $1`,
        [checkout.orderId, replacementBindingId],
      );
      await client.query(`SET LOCAL session_replication_role = 'origin'`);
      await expectQueryError(
        client,
        "payment_for_unaccepted_active_binding",
        () =>
          fixtures.finalizePayment(
            checkout,
            undefined,
            undefined,
            undefined,
            undefined,
            false,
          ),
        { code: "23514", constraint: "payment_terms_acceptance_check" },
      );
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE orders SET accepted_order_price_binding_id = $2 WHERE id = $1`,
        [checkout.orderId, checkout.orderPriceBindingId],
      );
      await client.query(`SET LOCAL session_replication_role = 'origin'`);
      for (const [name, assignment] of [
        [
          "rewrite_accepted_price_binding",
          `accepted_order_price_binding_id = '${fixtures.id("foreign-binding")}'`,
        ],
        ["rewrite_terms_revision", "accepted_terms_revision = 'terms-v2'"],
        [
          "rewrite_claim_policy_revision",
          "accepted_claim_policy_revision = 'claim-policy-v2'",
        ],
        [
          "clear_withdrawal_acknowledgement",
          "withdrawal_exception_acknowledged_at = NULL",
        ],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            client.query(`UPDATE orders SET ${assignment} WHERE id = $1`, [
              checkout.orderId,
            ]),
          {
            code: "23514",
            constraint: "order_checkout_acceptance_immutable_check",
          },
        );
      }

      const missingPaymentAcceptance = await fixtures.createFoundation(
        "missing-payment-acceptance",
      );
      await createCurrentPlan(client, fixtures, missingPaymentAcceptance);
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE orders
         SET accepted_order_price_binding_id = NULL,
             accepted_terms_revision = NULL,
             accepted_claim_policy_revision = NULL,
             withdrawal_exception_acknowledged_at = NULL
         WHERE id = $1`,
        [missingPaymentAcceptance.orderId],
      );
      await client.query(`SET LOCAL session_replication_role = 'origin'`);
      await expectQueryError(
        client,
        "payment_without_checkout_acceptance",
        () =>
          fixtures.finalizePayment(
            missingPaymentAcceptance,
            undefined,
            undefined,
            undefined,
            undefined,
            false,
          ),
        { code: "23514", constraint: "payment_terms_acceptance_check" },
      );

      const missingConfirmationAcceptance = await fixtures.createFoundation(
        "missing-confirmation-acceptance",
      );
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE orders
         SET accepted_order_price_binding_id = NULL,
             accepted_terms_revision = NULL,
             accepted_claim_policy_revision = NULL,
             withdrawal_exception_acknowledged_at = NULL
         WHERE id = $1`,
        [missingConfirmationAcceptance.orderId],
      );
      await client.query(`SET LOCAL session_replication_role = 'origin'`);
      await expectQueryError(
        client,
        "confirmation_without_checkout_acceptance",
        () =>
          client.query(
            `UPDATE orders
             SET status = 'CONFIRMED', confirmed_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [missingConfirmationAcceptance.orderId],
          ),
        { code: "23514", constraint: "order_checkout_acceptance_check" },
      );

      const missingActivationAcceptance = await fixtures.createFoundation(
        "missing-activation-acceptance",
      );
      const missingActivationProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        missingActivationAcceptance,
      );
      await holdCurrentPlan(
        client,
        fixtures,
        missingActivationAcceptance,
        missingActivationProductions,
      );
      const activationAt = new Date();
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `UPDATE orders
         SET status = 'CONFIRMED', confirmed_at = $2,
             accepted_order_price_binding_id = NULL,
             accepted_terms_revision = NULL,
             accepted_claim_policy_revision = NULL,
             withdrawal_exception_acknowledged_at = NULL,
             updated_at = $2
         WHERE id = $1`,
        [missingActivationAcceptance.orderId, activationAt],
      );
      await client.query(
        `UPDATE order_phases
         SET status = 'ACTIVE', activated_at = $2, updated_at = $2
         WHERE id = $1`,
        [missingActivationAcceptance.orderPhaseId, activationAt],
      );
      await client.query(`SET LOCAL session_replication_role = 'origin'`);
      await expectQueryError(
        client,
        "activation_without_checkout_acceptance",
        async () => {
          await fixtures.capturePayment(
            missingActivationAcceptance,
            undefined,
            activationAt,
          );
          await forceCaptureActivationConstraints(client);
        },
        { code: "23514", constraint: "payment_capture_activation_check" },
      );
    });
  });

  it("bounds Order and OrderPhase lifecycle evidence by the database clock", async () => {
    await rollback("future-order-evidence", async (client, fixtures) => {
      const quotedWithinCreatedAtSkewId = fixtures.id(
        "quoted-within-created-at-skew",
      );
      const quotedBeyondCreatedAtSkewId = fixtures.id(
        "quoted-beyond-created-at-skew",
      );
      const defaultedCreatedAtOrders = (
        await client.query<{ created_at: Date; id: string }>(
          `INSERT INTO orders (id, public_reference, updated_at)
           VALUES ($1, $2, clock_timestamp()),
                  ($3, $4, clock_timestamp())
           RETURNING id, created_at`,
          [
            quotedWithinCreatedAtSkewId,
            `T-${fixtures.id("quoted-within-created-at-skew-reference")}`,
            quotedBeyondCreatedAtSkewId,
            `T-${fixtures.id("quoted-beyond-created-at-skew-reference")}`,
          ],
        )
      ).rows;
      const createdAtByOrderId = new Map(
        defaultedCreatedAtOrders.map((defaultedOrder) => [
          defaultedOrder.id,
          defaultedOrder.created_at,
        ]),
      );
      const withinSkewCreatedAt = createdAtByOrderId.get(
        quotedWithinCreatedAtSkewId,
      );
      const beyondSkewCreatedAt = createdAtByOrderId.get(
        quotedBeyondCreatedAtSkewId,
      );
      if (!withinSkewCreatedAt || !beyondSkewCreatedAt) {
        throw new Error("defaulted Order creation evidence is missing");
      }
      const quotedAtSkewBoundary = new Date(
        withinSkewCreatedAt.getTime() - 5_000,
      );
      await client.query(
        `UPDATE orders
         SET status = 'QUOTED', quoted_at = $2, updated_at = clock_timestamp()
         WHERE id = $1`,
        [quotedWithinCreatedAtSkewId, quotedAtSkewBoundary],
      );
      await expectQueryError(
        client,
        "quoted_before_created_beyond_skew",
        () =>
          client.query(
            `UPDATE orders
             SET status = 'QUOTED', quoted_at = $2,
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [
              quotedBeyondCreatedAtSkewId,
              new Date(beyondSkewCreatedAt.getTime() - 5_001),
            ],
          ),
        { code: "23514", constraint: "orders_timestamps_check" },
      );
      expect(
        (
          await client.query<{ quoted_at: Date }>(
            `SELECT quoted_at FROM orders WHERE id = $1`,
            [quotedWithinCreatedAtSkewId],
          )
        ).rows,
      ).toEqual([{ quoted_at: quotedAtSkewBoundary }]);

      const order = await fixtures.createFoundation(
        "future-order-evidence",
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
        "future_order_quoted",
        () =>
          client.query(
            `UPDATE orders
             SET status = 'QUOTED',
                 quoted_at = clock_timestamp() + interval '60 seconds',
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [order.orderId],
          ),
        {
          code: "23514",
          constraint: "order_lifecycle_timestamp_check",
        },
      );
      await client.query(
        `UPDATE orders
         SET status = 'QUOTED',
             quoted_at = clock_timestamp() + interval '2 seconds',
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [order.orderId],
      );
      const quotedAt = (
        await client.query<{ quoted_at: Date }>(
          `SELECT quoted_at FROM orders WHERE id = $1`,
          [order.orderId],
        )
      ).rows[0]?.quoted_at;
      if (!quotedAt) {
        throw new Error("quoted lifecycle evidence fixture is missing");
      }
      await fixtures.acceptCheckoutTerms(order, quotedAt);
      await expectQueryError(
        client,
        "future_order_confirmed",
        () =>
          client.query(
            `UPDATE orders
             SET status = 'CONFIRMED',
                 confirmed_at = clock_timestamp() + interval '60 seconds',
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [order.orderId],
          ),
        {
          code: "23514",
          constraint: "order_lifecycle_timestamp_check",
        },
      );
      await client.query(
        `UPDATE orders
         SET status = 'CONFIRMED',
             confirmed_at = clock_timestamp() + interval '2 seconds',
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [order.orderId],
      );

      const phase = await fixtures.createFoundation(
        "future-order-phase-evidence",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      await client.query(
        `UPDATE order_phases
         SET status = 'ACTIVE',
             activated_at = clock_timestamp() + interval '2 seconds',
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [phase.orderPhaseId],
      );
      const futurePhaseEvidenceColumns = [
        "activated_at",
        "qc_passed_at",
        "shipped_at",
        "delivered_at",
        "completed_at",
        "cancelled_at",
      ] as const;
      for (const column of futurePhaseEvidenceColumns) {
        await expectQueryError(
          client,
          `future_phase_${column}`,
          () =>
            client.query(
              `UPDATE order_phases
               SET "${column}" = clock_timestamp() + interval '60 seconds',
                   updated_at = clock_timestamp()
               WHERE id = $1`,
              [phase.orderPhaseId],
            ),
          {
            code: "23514",
            constraint: "order_phase_lifecycle_evidence_check",
            message: "OrderPhase lifecycle evidence cannot be in the future",
          },
        );
      }

      expect(
        (
          await client.query<{
            confirmed_at: Date;
            order_status: string;
            phase_status: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                    target_order.confirmed_at,
                    phase.status::text AS phase_status
             FROM orders target_order
             JOIN order_phases phase ON phase.id = $2
             WHERE target_order.id = $1`,
            [order.orderId, phase.orderPhaseId],
          )
        ).rows,
      ).toEqual([
        {
          confirmed_at: expect.any(Date),
          order_status: "CONFIRMED",
          phase_status: "ACTIVE",
        },
      ]);
    });
  });

  it("requires a current Shipment for every active ShipmentPlan before ready-to-ship", async () => {
    await rollback(
      "ready-to-ship-shipment-coverage",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "ready-to-ship-shipment-coverage",
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
        await advanceOrderLifecycleStep(
          client,
          foundation.orderId,
          "IN_PRODUCTION",
        );
        await advanceOrderLifecycleStep(
          client,
          foundation.orderId,
          "QC_PASSED",
        );
        await forceOrderLifecycleConstraints(client);

        const missingShipmentId = foundation.shipmentIds[1];
        const retainedShipmentId = foundation.shipmentIds[0];
        if (!missingShipmentId || !retainedShipmentId) {
          throw new Error("two-plan shipment fixture is incomplete");
        }
        await client.query(
          `ALTER TABLE shipments DISABLE TRIGGER "shipments_topology_protected"`,
        );
        await client.query(`DELETE FROM shipments WHERE id = $1`, [
          missingShipmentId,
        ]);
        await client.query(
          `ALTER TABLE shipments ENABLE TRIGGER "shipments_topology_protected"`,
        );

        const transitionedAt = new Date();
        await client.query(
          `UPDATE jobs
         SET status = 'PACKED', packed_at = $2, updated_at = $2
         WHERE order_id = $1`,
          [foundation.orderId, transitionedAt],
        );
        await client.query(
          `UPDATE shipments
         SET status = 'LABEL_CREATED', carrier = 'coverage-carrier',
             provider_shipment_id = 'coverage-provider',
             carrier_label_id = 'coverage-label',
             tracking_code = 'coverage-tracking',
             label_created_at = $2, updated_at = $2
         WHERE id = $1`,
          [retainedShipmentId, transitionedAt],
        );

        await expectQueryError(
          client,
          "ready_without_every_plan_shipment",
          async () => {
            await client.query(
              `UPDATE orders SET status = 'READY_TO_SHIP', updated_at = $2
             WHERE id = $1`,
              [foundation.orderId, transitionedAt],
            );
            await forceOrderLifecycleConstraints(client);
          },
          {
            code: "23514",
            constraint: "order_post_confirmation_lifecycle_check",
          },
        );

        await client.query(`SET LOCAL session_replication_role = 'replica'`);
        await client.query(
          `UPDATE order_price_bindings
           SET invalidated_at = $2
           WHERE id = $1`,
          [foundation.orderPriceBindingId, transitionedAt],
        );
        await client.query(`SET LOCAL session_replication_role = 'origin'`);
        await expectQueryError(
          client,
          "ready_without_active_shipment_plan",
          async () => {
            await client.query(
              `UPDATE orders SET status = 'READY_TO_SHIP', updated_at = $2
               WHERE id = $1`,
              [foundation.orderId, transitionedAt],
            );
            await client.query(
              `SET CONSTRAINTS
                 "orders_post_confirmation_lifecycle_reconciled" IMMEDIATE`,
            );
          },
          {
            code: "23514",
            constraint: "order_post_confirmation_lifecycle_check",
          },
        );
      },
    );
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
          createdAt: new Date(
            ownershipCreatedAt.getTime() - 2 * 60 * 60 * 1_000,
          ),
          expiresAt: new Date(ownershipCreatedAt.getTime() - 60 * 60 * 1_000),
        },
        {
          name: "cancelled_state",
          status: "CANCELLED",
          createdAt: ownershipCreatedAt,
          expiresAt: new Date(ownershipCreatedAt.getTime() + 60 * 60 * 1_000),
        },
        {
          name: "converted_state",
          status: "CONVERTED",
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
      await expectQueryError(
        client,
        "insert_closed_quote_session",
        () =>
          client.query(
            `INSERT INTO quote_sessions
             (id, customer_id, public_token_hash, status, expires_at,
              created_at, updated_at)
             VALUES ($1,$2,$3,'CANCELLED',$4,$5,$5)`,
            [
              fixtures.id("initially-closed-session"),
              foundation.customerId,
              randomUUID().replaceAll("-", "").padEnd(64, "a"),
              new Date(ownershipCreatedAt.getTime() + 60 * 60 * 1_000),
              ownershipCreatedAt,
            ],
          ),
        { code: "23514", constraint: "quote_session_initial_status_check" },
      );
      const prematureExpirySessionId = fixtures.id("premature-expiry-session");
      await client.query(
        `INSERT INTO quote_sessions
         (id, customer_id, public_token_hash, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          prematureExpirySessionId,
          foundation.customerId,
          randomUUID().replaceAll("-", "").padEnd(64, "b"),
          new Date(ownershipCreatedAt.getTime() + 60 * 60 * 1_000),
          ownershipCreatedAt,
        ],
      );
      await expectQueryError(
        client,
        "expire_quote_session_before_deadline",
        () =>
          client.query(
            `UPDATE quote_sessions SET status = 'EXPIRED', updated_at = $2
             WHERE id = $1`,
            [prematureExpirySessionId, ownershipCreatedAt],
          ),
        { code: "23514", constraint: "quote_session_expiration_check" },
      );
      for (const closedSession of closedSessionCases) {
        const sessionId = fixtures.id(`closed-commerce-${closedSession.name}`);
        await client.query(
          `INSERT INTO quote_sessions
           (id, customer_id, public_token_hash, expires_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$5)`,
          [
            sessionId,
            foundation.customerId,
            randomUUID().replaceAll("-", "").padEnd(64, "f"),
            closedSession.expiresAt,
            closedSession.createdAt,
          ],
        );
        if (closedSession.status !== "OPEN") {
          await client.query(
            `UPDATE quote_sessions
             SET status = $2::quote_session_status, updated_at = $3
             WHERE id = $1`,
            [sessionId, closedSession.status, ownershipCreatedAt],
          );
          await expectQueryError(
            client,
            `reopen_session_${closedSession.name}`,
            () =>
              client.query(
                `UPDATE quote_sessions SET status = 'OPEN', updated_at = $2
                 WHERE id = $1`,
                [sessionId, ownershipCreatedAt],
              ),
            {
              code: "23514",
              constraint: "quote_session_status_transition_check",
            },
          );
          await expectQueryError(
            client,
            `extend_session_${closedSession.name}`,
            () =>
              client.query(
                `UPDATE quote_sessions
                 SET expires_at = expires_at + interval '1 hour', updated_at = $2
                 WHERE id = $1`,
                [sessionId, ownershipCreatedAt],
              ),
            {
              code: "23514",
              constraint: "quote_session_expiry_immutable_check",
            },
          );
        }
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
        "clear_attached_request_session_owner",
        () =>
          client.query(
            `UPDATE quote_sessions SET customer_id = NULL WHERE id = $1`,
            [ownedSessionId],
          ),
        { code: "23514", constraint: "quote_session_owner_removal_check" },
      );
      await expectQueryError(
        client,
        "clear_attached_automatic_session_owner",
        () =>
          client.query(
            `UPDATE quote_sessions SET customer_id = NULL WHERE id = $1`,
            [foundation.quoteSessionId],
          ),
        { code: "23514", constraint: "quote_session_owner_removal_check" },
      );
      await client.query(
        `UPDATE quote_sessions SET customer_id = NULL WHERE id = $1`,
        [otherOwnedSessionId],
      );
      expect(
        (
          await client.query<{ customer_id: string | null }>(
            `SELECT customer_id FROM quote_sessions WHERE id = $1`,
            [otherOwnedSessionId],
          )
        ).rows,
      ).toEqual([{ customer_id: null }]);
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
        "customer_audit_without_actor",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, order_id, event_type, actor_kind, payload, created_at)
             VALUES ($1,$2,'audit.customer_missing_actor','CUSTOMER','{}'::jsonb,$3)`,
            [
              fixtures.id("audit-customer-missing-actor"),
              foundation.orderId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_events_actor_identity_check",
        },
      );
      await expectQueryError(
        client,
        "operator_audit_without_actor",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, order_id, event_type, actor_kind, payload, created_at)
             VALUES ($1,$2,'audit.operator_missing_actor','OPERATOR','{}'::jsonb,$3)`,
            [
              fixtures.id("audit-operator-missing-actor"),
              foundation.orderId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_events_actor_identity_check",
        },
      );
      await expectQueryError(
        client,
        "system_audit_with_actor",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, order_id, event_type, actor_kind, actor_id, payload, created_at)
             VALUES ($1,$2,'audit.system_with_actor','SYSTEM',$3,'{}'::jsonb,$4)`,
            [
              fixtures.id("audit-system-with-actor"),
              foundation.orderId,
              foundation.customerId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_events_actor_identity_check",
        },
      );
      await client.query(
        `INSERT INTO audit_events
         (id, order_id, event_type, actor_kind, actor_id, payload, created_at)
         VALUES ($1,$2,'audit.customer_with_actor','CUSTOMER',$3,'{}'::jsonb,$4),
                ($5,$2,'audit.operator_with_actor','OPERATOR',$6,'{}'::jsonb,$4)`,
        [
          fixtures.id("audit-customer-with-actor"),
          foundation.orderId,
          foundation.customerId,
          new Date(),
          fixtures.id("audit-operator-with-actor"),
          fixtures.id("audit-operator-id"),
        ],
      );
      await expectQueryError(
        client,
        "customer_audit_with_wrong_owner",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, order_id, event_type, actor_kind, actor_id, payload, created_at)
             VALUES ($1,$2,'audit.customer_wrong_owner','CUSTOMER',$3,'{}'::jsonb,$4)`,
            [
              fixtures.id("audit-customer-wrong-owner"),
              foundation.orderId,
              other.customerId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_customer_owner_check",
        },
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
        () => {
          const crossOrderPaymentCreatedAt = new Date();
          return client.query(
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
              new Date(crossOrderPaymentCreatedAt.getTime() + 60 * 60 * 1_000),
              crossOrderPaymentCreatedAt,
            ],
          );
        },
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
        "direct_pending_payment",
        () => {
          const duplicatePaymentCreatedAt = new Date();
          return client.query(
            `INSERT INTO payments (id, order_id, price_snapshot_id, order_price_binding_id,
                                  payment_schedule_id, role, provider, provider_intent_id,
                                  requested_amount_minor, currency, status,
                                  checkout_capture_expires_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'FULL','test',$6,$7,'EUR','PENDING',$8,$9,$9)`,
            [
              fixtures.id("duplicate-payment"),
              foundation.orderId,
              foundation.priceSnapshotId,
              foundation.orderPriceBindingId,
              foundation.paymentScheduleId,
              providerIntentId,
              capturedAmount,
              new Date(duplicatePaymentCreatedAt.getTime() + 60 * 60 * 1_000),
              duplicatePaymentCreatedAt,
            ],
          );
        },
        {
          code: "23514",
          constraint: "payment_initial_status_check",
        },
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
          const refundId = fixtures.id("active-order-partial-refund");
          const providerRefundId = "provider-active-order-partial-refund";
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
              refundId,
              foundation.paymentId,
              "active-order-partial-refund",
              completedAt,
            ],
          );
          await fixtures.persistRefundProviderEvent(
            refundId,
            "REFUND_SUCCEEDED",
            providerRefundId,
            completedAt,
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', provider_refund_id = $2,
                 completed_at = $3, updated_at = $3
             WHERE id = $1`,
            [refundId, providerRefundId, completedAt],
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
          const refundId = fixtures.id("active-order-full-refund");
          const providerRefundId = "provider-active-order-full-refund";
          await client.query(
            `UPDATE payments SET status = 'REFUND_PENDING' WHERE id = $1`,
            [foundation.paymentId],
          );
          await client.query(
            `INSERT INTO refund_transactions
               (id, payment_id, idempotency_key, amount_minor, reason, status,
                requested_at, created_at, updated_at)
             SELECT $1,id,$2,captured_amount_minor,'CUSTOMER_CANCELLATION',
                    'PENDING',$3,$3,$3
             FROM payments WHERE id = $4`,
            [
              refundId,
              "active-order-full-refund",
              completedAt,
              foundation.paymentId,
            ],
          );
          await fixtures.persistRefundProviderEvent(
            refundId,
            "REFUND_SUCCEEDED",
            providerRefundId,
            completedAt,
          );
          await client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', provider_refund_id = $2,
                 completed_at = $3, updated_at = $3
             WHERE id = $1`,
            [refundId, providerRefundId, completedAt],
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
      await expectQueryError(
        client,
        "cancel_captured_without_customer_refund_work",
        () =>
          cancelOrderBeforeHandoff(
            client,
            foundation.orderId,
            true,
            true,
            "CANCELLED",
            false,
          ),
        {
          code: "23514",
          constraint: "order_customer_cancellation_refund_obligation_check",
        },
      );
      for (const [name, idempotencyKey] of [
        ["empty_refund_idempotency_key", ""],
        ["blank_refund_idempotency_key", "   "],
        ["control_whitespace_refund_idempotency_key", "\t\n"],
      ] as const) {
        await expectQueryError(
          client,
          name,
          () =>
            client.query(
              `INSERT INTO refund_transactions
                 (id, payment_id, idempotency_key, amount_minor, reason,
                  status, created_at, updated_at)
               VALUES ($1,$2,$3,1,'CUSTOMER_CANCELLATION','PENDING',$4,$4)`,
              [
                fixtures.id("invalid-refund-idempotency-key"),
                foundation.paymentId,
                idempotencyKey,
                new Date(),
              ],
            ),
          {
            code: "23514",
            constraint: "refund_transactions_idempotency_key_identity_check",
          },
        );
      }
      const paymentCapturedAt = (
        await client.query<{ captured_at: Date }>(
          `SELECT captured_at FROM payments WHERE id = $1`,
          [foundation.paymentId],
        )
      ).rows[0]?.captured_at;
      if (!paymentCapturedAt) {
        throw new Error("fixture Payment capture time is unavailable");
      }
      const boundaryRefundRequestedAt = new Date(
        paymentCapturedAt.getTime() + 5_000,
      );
      await cancelOrderBeforeHandoff(
        client,
        foundation.orderId,
        true,
        true,
        "CANCELLED",
        [
          {
            id: fixtures.id("refund-first"),
            idempotencyKey: "refund-first",
            amountMinor: 600,
            requestedAt: boundaryRefundRequestedAt,
          },
          {
            id: fixtures.id("refund-remainder"),
            idempotencyKey: "refund-remainder",
            amountMinor: remainingRefundAmount,
          },
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
          event_type, actor_kind, actor_id, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,'refund.scope_consistent','CUSTOMER',$6,
                 '{}'::jsonb,$7)`,
        [
          fixtures.id("audit-refund-scope-consistent"),
          foundation.quoteId,
          foundation.orderId,
          foundation.paymentId,
          fixtures.id("refund-first"),
          foundation.customerId,
          new Date(),
        ],
      );
      await expectQueryError(
        client,
        "audit_refund_scope_wrong_customer",
        () =>
          client.query(
            `INSERT INTO audit_events
             (id, quote_id, order_id, payment_id, refund_transaction_id,
              event_type, actor_kind, actor_id, payload, created_at)
             VALUES ($1,$2,$3,$4,$5,'refund.scope_wrong_customer','CUSTOMER',$6,
                     '{}'::jsonb,$7)`,
            [
              fixtures.id("audit-refund-scope-wrong-customer"),
              foundation.quoteId,
              foundation.orderId,
              foundation.paymentId,
              fixtures.id("refund-first"),
              other.customerId,
              new Date(),
            ],
          ),
        {
          code: "23514",
          constraint: "audit_event_customer_owner_check",
        },
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
      const refundRequestedAt = (
        await client.query<{ requested_at: Date }>(
          `SELECT requested_at
           FROM refund_transactions WHERE id = $1`,
          [fixtures.id("refund-first")],
        )
      ).rows[0]?.requested_at;
      if (!refundRequestedAt) {
        throw new Error("refund request timestamp is unavailable");
      }
      const refundCompletedAt = new Date(refundRequestedAt.getTime() - 5_000);
      await expectQueryError(
        client,
        "refund_event_beyond_negative_skew",
        () =>
          fixtures.persistRefundProviderEvent(
            fixtures.id("refund-first"),
            "REFUND_SUCCEEDED",
            "provider-refund-first",
            refundCompletedAt,
            "refund-beyond-negative-skew",
            new Date(refundRequestedAt.getTime() - 5_001),
          ),
        {
          code: "23514",
          constraint: "payment_provider_event_scope_check",
        },
      );
      await expectQueryError(
        client,
        "succeed_refund_without_provider_receipt",
        () =>
          client.query(
            `UPDATE refund_transactions
             SET status = 'SUCCEEDED', provider_refund_id = $2,
                 completed_at = $3, updated_at = $3
             WHERE id = $1`,
            [
              fixtures.id("refund-first"),
              "provider-refund-first",
              refundCompletedAt,
            ],
          ),
        {
          code: "23514",
          constraint: "refund_success_provider_receipt_check",
        },
      );
      await fixtures.persistRefundProviderEvent(
        fixtures.id("refund-first"),
        "REFUND_SUCCEEDED",
        "provider-refund-first",
        refundCompletedAt,
        "refund-at-negative-skew-boundary",
        new Date(refundRequestedAt.getTime() - 5_000),
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
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled",
                         "refunds_customer_cancellation_order_reconciled" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payments_refund_status_reconciled",
                         "refund_transactions_payment_status_reconciled",
                         "refunds_customer_cancellation_order_reconciled" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            completed_at: Date;
            occurred_at: Date;
            status: string;
            verified_at: Date;
          }>(
            `SELECT refund.status::text, refund.completed_at,
                    event.occurred_at, event.verified_at
             FROM refund_transactions refund
             JOIN payment_provider_events event
               ON event.refund_transaction_id = refund.id
              AND event.provider_event_id =
                  'refund-at-negative-skew-boundary'
             WHERE refund.id = $1`,
            [fixtures.id("refund-first")],
          )
        ).rows,
      ).toEqual([
        {
          status: "SUCCEEDED",
          completed_at: refundCompletedAt,
          occurred_at: new Date(refundRequestedAt.getTime() - 5_000),
          verified_at: refundCompletedAt,
        },
      ]);
      const repeatedRefundVerifiedAt = new Date(
        refundCompletedAt.getTime() + 1,
      );
      expect(repeatedRefundVerifiedAt).not.toEqual(refundCompletedAt);
      await fixtures.persistRefundProviderEvent(
        fixtures.id("refund-first"),
        "REFUND_SUCCEEDED",
        "provider-refund-first",
        repeatedRefundVerifiedAt,
        "provider-refund-first-event-repeat",
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" IMMEDIATE`,
      );
      await client.query(
        `SET CONSTRAINTS "payment_provider_events_consumed" DEFERRED`,
      );
      expect(
        (
          await client.query<{
            completed_at: Date;
            event_count: string;
          }>(
            `SELECT refund.completed_at,
                    count(event.id)::text AS event_count
             FROM refund_transactions refund
             JOIN payment_provider_events event
               ON event.refund_transaction_id = refund.id
              AND event.kind = 'REFUND_SUCCEEDED'
             WHERE refund.id = $1
             GROUP BY refund.completed_at`,
            [fixtures.id("refund-first")],
          )
        ).rows,
      ).toEqual([{ completed_at: refundCompletedAt, event_count: "2" }]);
      await expectQueryError(
        client,
        "partial_status_while_cancellation_work_pending",
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
            constraint:
              status === "PENDING"
                ? "refund_transaction_succeeded_immutable_check"
                : "refund_failure_provider_receipt_check",
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
      const remainderRefundedAt = new Date();
      await fixtures.persistRefundProviderEvent(
        fixtures.id("refund-remainder"),
        "REFUND_SUCCEEDED",
        "provider-refund-remainder",
        remainderRefundedAt,
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_refund_id = $2,
             completed_at = $3, updated_at = $3
         WHERE id = $1`,
        [
          fixtures.id("refund-remainder"),
          "provider-refund-remainder",
          remainderRefundedAt,
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
            `UPDATE payments
             SET capture_authorized = true, capture_cutoff_at = NULL
             WHERE id = $1`,
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

  it("stops automatic commerce after its session ends without closing the manual handoff", async () => {
    await rollback("terminal-automatic-session", async (client, fixtures) => {
      const cancelledDraft = await fixtures.createFoundation(
        "cancelled-automatic-draft",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      const replacementSnapshotId = fixtures.id(
        "cancelled-replacement-snapshot",
      );
      const replacementBindingId = fixtures.id("cancelled-replacement-binding");
      await client.query(
        `INSERT INTO price_snapshots
           (id, price_list_id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         SELECT $1,price_list_id,currency,contract_total_minor,
                pricing_revision,input_snapshot,$2,
                clock_timestamp()
         FROM price_snapshots WHERE id = $3`,
        [
          replacementSnapshotId,
          randomUUID().replaceAll("-", "").repeat(2),
          cancelledDraft.priceSnapshotId,
        ],
      );
      await client.query(
        `INSERT INTO payment_schedules
           (id, price_snapshot_id, sequence, role, gross_amount_minor,
            fee_rate_basis_points, fee_fixed_minor, provider_config,
            created_at)
         SELECT $1,$2,sequence,role,gross_amount_minor,
                fee_rate_basis_points,fee_fixed_minor,provider_config,
                clock_timestamp()
         FROM payment_schedules WHERE id = $3`,
        [
          fixtures.id("cancelled-replacement-schedule"),
          replacementSnapshotId,
          cancelledDraft.paymentScheduleId,
        ],
      );
      await client.query(
        `INSERT INTO order_price_bindings
           (id, order_id, price_snapshot_id, delivery_destination_id,
            created_at)
         VALUES ($1,$2,$3,$4,clock_timestamp())`,
        [
          replacementBindingId,
          cancelledDraft.orderId,
          replacementSnapshotId,
          cancelledDraft.deliveryDestinationId,
        ],
      );
      const replacementComponentId = fixtures.id(
        "cancelled-replacement-component",
      );
      await client.query(
        `INSERT INTO price_snapshot_components
           (id, price_snapshot_id, kind, scope, amount_minor, allocation,
            created_at)
         VALUES ($1,$2,'ORDER_MIN_PRINT','ORDER',0,'{}'::jsonb,
                 clock_timestamp())`,
        [replacementComponentId, replacementSnapshotId],
      );
      await client.query(
        `UPDATE quote_sessions
         SET status = 'CANCELLED', updated_at = clock_timestamp()
         WHERE id = $1`,
        [cancelledDraft.quoteSessionId],
      );

      await expectQueryError(
        client,
        "mutate_cancelled_automatic_draft",
        () =>
          client.query(
            `UPDATE order_items SET quantity = quantity + 1 WHERE id = $1`,
            [cancelledDraft.orderItemId],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
      await expectQueryError(
        client,
        "quote_cancelled_automatic_draft",
        () =>
          client.query(
            `UPDATE orders
             SET status = 'QUOTED', quoted_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [cancelledDraft.orderId],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
      await expectQueryError(
        client,
        "move_cancelled_automatic_binding",
        () =>
          client.query(
            `UPDATE order_active_price_bindings
             SET order_price_binding_id = $2
             WHERE order_id = $1`,
            [cancelledDraft.orderId, replacementBindingId],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
      await expectQueryError(
        client,
        "add_cancelled_automatic_shipment_plan",
        () =>
          client.query(
            `INSERT INTO shipment_plans
               (id, order_id, order_phase_id, price_snapshot_id,
                order_price_binding_id, delivery_destination_id, ordinal,
                category, planned_volume_cubic_mm,
                planned_weight_milligrams, shipping_amount_minor,
                packaging_amount_minor, handling_amount_minor,
                allocation_snapshot, created_at)
             SELECT $1,order_id,order_phase_id,price_snapshot_id,
                    order_price_binding_id,delivery_destination_id,99,
                    category,planned_volume_cubic_mm,
                    planned_weight_milligrams,shipping_amount_minor,
                    packaging_amount_minor,handling_amount_minor,
                    allocation_snapshot,clock_timestamp()
             FROM shipment_plans WHERE id = $2`,
            [
              fixtures.id("cancelled-extra-shipment-plan"),
              cancelledDraft.shipmentPlanId,
            ],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
      await expectQueryError(
        client,
        "add_cancelled_automatic_fulfilment_slot",
        () =>
          client.query(
            `INSERT INTO fulfilment_slots
               (id, order_id, order_phase_id, order_item_id,
                quantity_ordinal, settlement_amount_minor, outcome,
                created_at, updated_at)
             SELECT $1,order_id,order_phase_id,order_item_id,99,
                    settlement_amount_minor,'PENDING',clock_timestamp(),
                    clock_timestamp()
             FROM fulfilment_slots WHERE id = $2`,
            [
              fixtures.id("cancelled-extra-fulfilment-slot"),
              cancelledDraft.fulfilmentSlotId,
            ],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
      await expectQueryError(
        client,
        "allocate_cancelled_automatic_shipment_plan",
        () =>
          client.query(
            `INSERT INTO shipment_plan_fulfilment_slots
               (shipment_plan_id, order_price_binding_id, fulfilment_slot_id)
             VALUES ($1,$2,$3)`,
            [
              cancelledDraft.shipmentPlanId,
              cancelledDraft.orderPriceBindingId,
              cancelledDraft.fulfilmentSlotId,
            ],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
      await expectQueryError(
        client,
        "allocate_cancelled_automatic_price_component",
        () =>
          client.query(
            `INSERT INTO price_component_fulfilment_allocations
               (price_snapshot_component_id, fulfilment_slot_id, amount_minor)
             VALUES ($1,$2,0)`,
            [replacementComponentId, cancelledDraft.fulfilmentSlotId],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
      await expectQueryError(
        client,
        "plan_cancelled_automatic_resources",
        () => createCurrentPlan(client, fixtures, cancelledDraft),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );

      await client.query(
        `UPDATE quote_requests
         SET status = 'REJECTED', updated_at = clock_timestamp()
         WHERE id = $1`,
        [cancelledDraft.quoteRequestId],
      );
      expect(
        (
          await client.query<{ status: string }>(
            `SELECT status::text FROM quote_requests WHERE id = $1`,
            [cancelledDraft.quoteRequestId],
          )
        ).rows,
      ).toEqual([{ status: "REJECTED" }]);

      const cancelledReservationDraft = await fixtures.createFoundation(
        "cancelled-automatic-reservations",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      const cancelledProductions = await createCurrentPlan(
        client,
        fixtures,
        cancelledReservationDraft,
      );
      await client.query(
        `UPDATE quote_sessions
         SET status = 'CANCELLED', updated_at = clock_timestamp()
         WHERE id = $1`,
        [cancelledReservationDraft.quoteSessionId],
      );
      const firstCancelledProduction = cancelledProductions[0]!;
      for (const [label, query] of [
        [
          "hold_cancelled_phase_reservation",
          () =>
            client.query(
              `UPDATE phase_reservation_sets SET status = 'HELD' WHERE id = $1`,
              [cancelledReservationDraft.phaseReservationSetId],
            ),
        ],
        [
          "hold_cancelled_production_reservation",
          () =>
            client.query(
              `UPDATE production_reservations SET status = 'HELD' WHERE id = $1`,
              [firstCancelledProduction.productionReservationId],
            ),
        ],
        [
          "hold_cancelled_inventory_reservation",
          () =>
            client.query(
              `UPDATE inventory_reservations SET status = 'HELD'
               WHERE production_reservation_id = $1`,
              [firstCancelledProduction.productionReservationId],
            ),
        ],
        [
          "hold_cancelled_capacity_reservation",
          () =>
            client.query(
              `UPDATE capacity_reservations SET status = 'HELD'
               WHERE production_reservation_id = $1`,
              [firstCancelledProduction.productionReservationId],
            ),
        ],
      ] as const) {
        await expectQueryError(client, label, query, {
          code: "23514",
          constraint: "quote_session_commerce_open_check",
        });
      }

      for (const production of cancelledProductions) {
        await client.query(
          `UPDATE inventory_reservations SET status = 'RELEASED'
           WHERE production_reservation_id = $1`,
          [production.productionReservationId],
        );
        await client.query(
          `UPDATE capacity_reservations SET status = 'RELEASED'
           WHERE production_reservation_id = $1`,
          [production.productionReservationId],
        );
        await client.query(
          `UPDATE production_reservations SET status = 'RELEASED' WHERE id = $1`,
          [production.productionReservationId],
        );
      }
      await client.query(
        `UPDATE phase_reservation_sets SET status = 'RELEASED' WHERE id = $1`,
        [cancelledReservationDraft.phaseReservationSetId],
      );
      expect(
        (
          await client.query<{ status: string }>(
            `SELECT status::text FROM phase_reservation_sets WHERE id = $1`,
            [cancelledReservationDraft.phaseReservationSetId],
          )
        ).rows,
      ).toEqual([{ status: "RELEASED" }]);

      const anonymousSessionId = fixtures.id(
        "cancelled-anonymous-automatic-session",
      );
      const anonymousOrderId = fixtures.id(
        "cancelled-anonymous-automatic-order",
      );
      await client.query(
        `INSERT INTO quote_sessions
           (id, public_token_hash, expires_at, created_at, updated_at)
         VALUES ($1,$2,clock_timestamp() + interval '1 hour',
                 clock_timestamp(),clock_timestamp())`,
        [anonymousSessionId, randomUUID().replaceAll("-", "").padEnd(64, "d")],
      );
      await client.query(
        `INSERT INTO orders
           (id, public_reference, status, created_at, updated_at)
         VALUES ($1,$2,'DRAFT',clock_timestamp(),clock_timestamp())`,
        [anonymousOrderId, `T-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO automatic_order_origins (order_id, quote_session_id)
         VALUES ($1,$2)`,
        [anonymousOrderId, anonymousSessionId],
      );
      await client.query(
        `UPDATE quote_sessions
         SET status = 'CANCELLED', updated_at = clock_timestamp()
         WHERE id = $1`,
        [anonymousSessionId],
      );
      await expectQueryError(
        client,
        "claim_cancelled_automatic_owner",
        () =>
          client.query(
            `UPDATE quote_sessions
             SET customer_id = $2, updated_at = clock_timestamp()
             WHERE id = $1`,
            [anonymousSessionId, cancelledDraft.customerId],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );

      const convertedDraft = await fixtures.createFoundation(
        "unbound-converted-draft",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      await client.query(
        `UPDATE quote_sessions
         SET status = 'CONVERTED', updated_at = clock_timestamp()
         WHERE id = $1`,
        [convertedDraft.quoteSessionId],
      );
      await expectQueryError(
        client,
        "quote_unbound_converted_draft",
        () =>
          client.query(
            `UPDATE orders
             SET status = 'QUOTED', quoted_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [convertedDraft.orderId],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );

      const convertedBinding =
        await fixtures.createFoundation("converted-binding");
      expect(
        (
          await client.query<{ status: string }>(
            `SELECT status::text FROM quote_sessions WHERE id = $1`,
            [convertedBinding.quoteSessionId],
          )
        ).rows,
      ).toEqual([{ status: "CONVERTED" }]);
      await expectQueryError(
        client,
        "cancel_converted_binding_session",
        () =>
          client.query(
            `UPDATE quote_sessions
             SET status = 'CANCELLED', updated_at = clock_timestamp()
             WHERE id = $1`,
            [convertedBinding.quoteSessionId],
          ),
        {
          code: "23514",
          constraint: "quote_session_status_transition_check",
        },
      );
      const convertedProductions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        convertedBinding,
      );
      await activateCurrentPlan(
        client,
        fixtures,
        convertedBinding,
        convertedProductions,
      );

      const expiringSessionId = fixtures.id("expiring-automatic-session");
      const expiringRequestId = fixtures.id("expiring-manual-request");
      const expiringOrderId = fixtures.id("expiring-automatic-order");
      await client.query(
        `INSERT INTO quote_sessions
           (id, customer_id, public_token_hash, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,clock_timestamp() + interval '250 milliseconds',
                 clock_timestamp() - interval '1 second',clock_timestamp())`,
        [
          expiringSessionId,
          cancelledDraft.customerId,
          randomUUID().replaceAll("-", "").padEnd(64, "c"),
        ],
      );
      await client.query(
        `INSERT INTO quote_requests
           (id, quote_session_id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,'NEW',clock_timestamp(),clock_timestamp())`,
        [expiringRequestId, expiringSessionId, cancelledDraft.customerId],
      );
      await client.query(
        `INSERT INTO orders
           (id, customer_id, public_reference, status, created_at, updated_at)
         VALUES ($1,$2,$3,'DRAFT',clock_timestamp(),clock_timestamp())`,
        [expiringOrderId, cancelledDraft.customerId, `T-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO automatic_order_origins (order_id, quote_session_id)
         VALUES ($1,$2)`,
        [expiringOrderId, expiringSessionId],
      );
      await client.query(`SELECT pg_sleep(0.3)`);
      await client.query(
        `UPDATE quote_sessions
         SET status = 'EXPIRED', updated_at = clock_timestamp()
         WHERE id = $1`,
        [expiringSessionId],
      );

      await client.query(
        `UPDATE quote_requests
         SET status = 'IN_REVIEW', updated_at = clock_timestamp()
         WHERE id = $1`,
        [expiringRequestId],
      );
      await expectQueryError(
        client,
        "quote_expired_automatic_draft",
        () =>
          client.query(
            `UPDATE orders
             SET status = 'QUOTED', quoted_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [expiringOrderId],
          ),
        { code: "23514", constraint: "quote_session_commerce_open_check" },
      );
    });
  });

  it("fails automatic session lock-order conflicts promptly instead of deadlocking", async () => {
    const setup = await pool.connect();
    const holdingSession = await pool.connect();
    const mutatingOrder = await pool.connect();
    try {
      const fixtureScope = `${scope}:automatic-session-lock-order`;
      const fixtures = new PersistenceFactory(setup, fixtureScope);
      await setup.query("BEGIN");
      const draft = await fixtures.createFoundation(
        "locked-session-draft",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
      );
      const beforePayment = await fixtures.createFoundation(
        "locked-session-before-payment",
      );
      await createCurrentPlan(setup, fixtures, beforePayment);
      const beforeCapture = await fixtures.createFoundation(
        "locked-session-before-capture",
      );
      await createCurrentPlanAndPayment(setup, fixtures, beforeCapture);
      await setup.query("COMMIT");

      const contenders = new PersistenceFactory(mutatingOrder, fixtureScope);
      const cases: ReadonlyArray<{
        foundation: PersistenceFoundation;
        expectsLockConflict: boolean;
        mutate: () => Promise<unknown>;
      }> = [
        {
          foundation: draft,
          expectsLockConflict: true,
          mutate: () =>
            mutatingOrder.query(
              `UPDATE orders
               SET status = 'QUOTED', quoted_at = clock_timestamp(),
                   updated_at = clock_timestamp()
               WHERE id = $1`,
              [draft.orderId],
            ),
        },
        {
          foundation: beforePayment,
          expectsLockConflict: true,
          mutate: () => contenders.finalizePayment(beforePayment),
        },
        {
          foundation: beforeCapture,
          expectsLockConflict: false,
          mutate: () => contenders.capturePayment(beforeCapture),
        },
      ];

      for (const testCase of cases) {
        await holdingSession.query("BEGIN");
        await holdingSession.query(
          `SELECT 1 FROM quote_sessions WHERE id = $1 FOR UPDATE`,
          [testCase.foundation.quoteSessionId],
        );
        await mutatingOrder.query("BEGIN");
        if (testCase.expectsLockConflict) {
          await expect(testCase.mutate()).rejects.toMatchObject({
            code: "55P03",
          });
        } else {
          await expect(testCase.mutate()).resolves.toBeUndefined();
        }
        await mutatingOrder.query("ROLLBACK");
        await holdingSession.query("ROLLBACK");
      }
    } finally {
      await setup.query("ROLLBACK").catch(() => undefined);
      await holdingSession.query("ROLLBACK").catch(() => undefined);
      await mutatingOrder.query("ROLLBACK").catch(() => undefined);
      setup.release();
      holdingSession.release();
      mutatingOrder.release();
    }
  });

  it("reserves shipment receipts before locking their order envelope", async () => {
    const setup = await pool.connect();
    const orderHolder = await pool.connect();
    const receiptWriter = await pool.connect();
    let receiptInsert: Promise<Date> | undefined;
    try {
      const fixtureScope = `${scope}:shipment-receipt-lock-order`;
      const fixtures = new PersistenceFactory(setup, fixtureScope);
      await setup.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "shipment-receipt-lock-order",
      );
      const productions = await createCurrentPlanAndPayment(
        setup,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(setup, fixtures, foundation, productions);
      for (const status of [
        "IN_PRODUCTION",
        "QC_PASSED",
        "READY_TO_SHIP",
      ] as const) {
        await advanceOrderLifecycleStep(setup, foundation.orderId, status);
      }
      await setup.query(
        `UPDATE shipments
         SET status = 'CANCELLATION_PENDING',
             cancellation_requested_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [foundation.shipmentId],
      );
      await setup.query(
        `UPDATE phase_reservation_sets
         SET status = 'SETTLED', updated_at = clock_timestamp()
         WHERE id = $1`,
        [foundation.phaseReservationSetId],
      );
      await setup.query("COMMIT");

      await orderHolder.query("BEGIN");
      await orderHolder.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [
        foundation.orderId,
      ]);

      await receiptWriter.query("BEGIN");
      await receiptWriter.query("SET LOCAL statement_timeout = '3s'");
      const receiptWriterPid = (
        await receiptWriter.query<{ pid: number }>(
          `SELECT pg_backend_pid() AS pid`,
        )
      ).rows[0]?.pid;
      if (!receiptWriterPid) {
        throw new Error("shipment receipt backend pid is unavailable");
      }
      receiptInsert = persistVerifiedAcceptanceScan(
        receiptWriter,
        foundation.shipmentId,
        "lock-ordered-acceptance-scan",
      );

      let receiptWaitsForOrder = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const activity = await orderHolder.query<{
          wait_event_type: string | null;
        }>(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE pid = $1`,
          [receiptWriterPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          receiptWaitsForOrder = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(receiptWaitsForOrder).toBe(true);

      for (const table of [
        "order_phases",
        "fulfilment_slots",
        "shipment_plans",
        "jobs",
        "shipments",
      ] as const) {
        await expect(
          orderHolder.query(
            `SELECT 1 FROM ${table} WHERE order_id = $1 FOR UPDATE NOWAIT`,
            [foundation.orderId],
          ),
        ).resolves.toBeDefined();
      }

      await orderHolder.query("ROLLBACK");
      await expect(receiptInsert).resolves.toBeInstanceOf(Date);
      await receiptWriter.query("ROLLBACK");
    } finally {
      await setup.query("ROLLBACK").catch(() => undefined);
      await orderHolder.query("ROLLBACK").catch(() => undefined);
      await receiptWriter.query("ROLLBACK").catch(() => undefined);
      await receiptInsert?.catch(() => undefined);
      setup.release();
      orderHolder.release();
      receiptWriter.release();
    }
  });

  it("reserves payment receipts before locking their parents in rank order", async () => {
    const setup = await pool.connect();
    const orderHolder = await pool.connect();
    const receiptWriter = await pool.connect();
    let receiptInsert: Promise<string> | undefined;
    try {
      const fixtureScope = `${scope}:payment-receipt-lock-order`;
      const fixtures = new PersistenceFactory(setup, fixtureScope);
      await setup.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "payment-receipt-lock-order",
      );
      await createCurrentPlanAndPayment(setup, fixtures, foundation);
      await setup.query("COMMIT");

      await orderHolder.query("BEGIN");
      await orderHolder.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [
        foundation.orderId,
      ]);

      await receiptWriter.query("BEGIN");
      await receiptWriter.query("SET LOCAL statement_timeout = '3s'");
      const receiptWriterPid = (
        await receiptWriter.query<{ pid: number }>(
          `SELECT pg_backend_pid() AS pid`,
        )
      ).rows[0]?.pid;
      if (!receiptWriterPid) {
        throw new Error("payment receipt backend pid is unavailable");
      }
      const writerFixtures = new PersistenceFactory(
        receiptWriter,
        fixtureScope,
      );
      receiptInsert = writerFixtures.persistPaymentProviderEvent(
        foundation.paymentId,
        "PAYMENT_CAPTURED",
        "lock-ordered-provider-capture",
        new Date(),
      );

      let receiptWaitsForOrder = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const activity = await orderHolder.query<{
          wait_event_type: string | null;
        }>(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE pid = $1`,
          [receiptWriterPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          receiptWaitsForOrder = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(receiptWaitsForOrder).toBe(true);

      await expect(
        orderHolder.query(
          `SELECT 1 FROM payments WHERE id = $1 FOR UPDATE NOWAIT`,
          [foundation.paymentId],
        ),
      ).resolves.toBeDefined();

      await orderHolder.query("ROLLBACK");
      await expect(receiptInsert).resolves.toBeDefined();
      await receiptWriter.query("ROLLBACK");
    } finally {
      await setup.query("ROLLBACK").catch(() => undefined);
      await orderHolder.query("ROLLBACK").catch(() => undefined);
      await receiptWriter.query("ROLLBACK").catch(() => undefined);
      await receiptInsert?.catch(() => undefined);
      setup.release();
      orderHolder.release();
      receiptWriter.release();
    }
  });

  it("reserves intent-failure attempts before locking their order envelope", async () => {
    const setup = await pool.connect();
    const orderHolder = await pool.connect();
    const receiptWriter = await pool.connect();
    let receiptInsert: Promise<string> | undefined;
    try {
      const fixtureScope = `${scope}:intent-failure-receipt-lock-order`;
      const fixtures = new PersistenceFactory(setup, fixtureScope);
      await setup.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "intent-failure-receipt-lock-order",
      );
      await createCurrentPlan(setup, fixtures, foundation);
      const paymentCreatedAt = new Date();
      await setup.query(
        `INSERT INTO payments
           (id, order_id, price_snapshot_id, order_price_binding_id,
            payment_schedule_id, role, provider, requested_amount_minor,
            currency, status, checkout_capture_expires_at,
            created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,'FULL','test',gross_amount_minor,
                'EUR','CREATED',$6,$7,$7
         FROM payment_schedules WHERE id = $5`,
        [
          foundation.paymentId,
          foundation.orderId,
          foundation.priceSnapshotId,
          foundation.orderPriceBindingId,
          foundation.paymentScheduleId,
          new Date(paymentCreatedAt.getTime() + 60 * 60 * 1_000),
          paymentCreatedAt,
        ],
      );
      await setup.query("COMMIT");

      await orderHolder.query("BEGIN");
      await orderHolder.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [
        foundation.orderId,
      ]);

      await receiptWriter.query("BEGIN");
      await receiptWriter.query("SET LOCAL statement_timeout = '3s'");
      const receiptWriterPid = (
        await receiptWriter.query<{ pid: number }>(
          `SELECT pg_backend_pid() AS pid`,
        )
      ).rows[0]?.pid;
      if (!receiptWriterPid) {
        throw new Error("intent-failure receipt backend pid is unavailable");
      }
      const writerFixtures = new PersistenceFactory(
        receiptWriter,
        fixtureScope,
      );
      receiptInsert = writerFixtures.persistPaymentIntentCreationFailure(
        foundation.paymentId,
        new Date(),
        "lock-ordered-intent-attempt",
      );

      let receiptWaitsForOrder = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const activity = await orderHolder.query<{
          wait_event_type: string | null;
        }>(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE pid = $1`,
          [receiptWriterPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          receiptWaitsForOrder = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(receiptWaitsForOrder).toBe(true);

      await expect(
        orderHolder.query(
          `SELECT 1 FROM order_phases WHERE order_id = $1 FOR UPDATE NOWAIT`,
          [foundation.orderId],
        ),
      ).resolves.toBeDefined();
      await expect(
        orderHolder.query(
          `SELECT 1 FROM payments WHERE id = $1 FOR UPDATE NOWAIT`,
          [foundation.paymentId],
        ),
      ).resolves.toBeDefined();

      await orderHolder.query("ROLLBACK");
      await expect(receiptInsert).resolves.toBeDefined();
      await receiptWriter.query("ROLLBACK");
    } finally {
      await setup.query("ROLLBACK").catch(() => undefined);
      await orderHolder.query("ROLLBACK").catch(() => undefined);
      await receiptWriter.query("ROLLBACK").catch(() => undefined);
      await receiptInsert?.catch(() => undefined);
      setup.release();
      orderHolder.release();
      receiptWriter.release();
    }
  });

  it("orders refund creation and receipt locks without a Payment-to-Order cycle", async () => {
    const setup = await pool.connect();
    const refundHolder = await pool.connect();
    const receiptWriter = await pool.connect();
    let refundInsert: Promise<unknown> | undefined;
    let receiptInsert: Promise<string> | undefined;
    try {
      const fixtureScope = `${scope}:refund-receipt-lock-order`;
      const fixtures = new PersistenceFactory(setup, fixtureScope);
      await setup.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "refund-receipt-lock-order",
      );
      const productions = await createCurrentPlanAndPayment(
        setup,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(setup, fixtures, foundation, productions);
      await cancelOrderBeforeHandoff(setup, foundation.orderId);
      const refundId = (
        await setup.query<{ id: string }>(
          `SELECT id FROM refund_transactions
           WHERE payment_id = $1
             AND reason = 'CUSTOMER_CANCELLATION'
             AND status = 'PENDING'`,
          [foundation.paymentId],
        )
      ).rows[0]?.id;
      if (!refundId) {
        throw new Error("refund lock-order fixture is missing");
      }
      await setup.query("COMMIT");

      await refundHolder.query("BEGIN");
      await refundHolder.query(
        `SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`,
        [foundation.orderId],
      );

      await receiptWriter.query("BEGIN");
      await receiptWriter.query("SET LOCAL statement_timeout = '3s'");
      const refundWriterPid = (
        await receiptWriter.query<{ pid: number }>(
          `SELECT pg_backend_pid() AS pid`,
        )
      ).rows[0]?.pid;
      if (!refundWriterPid) {
        throw new Error("refund writer backend pid is unavailable");
      }
      refundInsert = receiptWriter.query(
        `INSERT INTO refund_transactions
           (id, payment_id, idempotency_key, provider, amount_minor, reason,
            status, requested_at, created_at, updated_at)
         VALUES ($1,$2,$3,'test',1,'CUSTOMER_CANCELLATION','PENDING',
                 clock_timestamp(),clock_timestamp(),clock_timestamp())`,
        [
          randomUUID(),
          foundation.paymentId,
          `${fixtureScope}:lock-ordered-refund-insert`,
        ],
      );

      let refundInsertWaitsForOrder = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const activity = await refundHolder.query<{
          wait_event_type: string | null;
        }>(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE pid = $1`,
          [refundWriterPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          refundInsertWaitsForOrder = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(refundInsertWaitsForOrder).toBe(true);
      await expect(
        refundHolder.query(
          `SELECT 1 FROM order_phases WHERE order_id = $1 FOR UPDATE NOWAIT`,
          [foundation.orderId],
        ),
      ).resolves.toBeDefined();
      await expect(
        refundHolder.query(
          `SELECT 1 FROM payments WHERE id = $1 FOR UPDATE NOWAIT`,
          [foundation.paymentId],
        ),
      ).resolves.toBeDefined();

      await refundHolder.query("ROLLBACK");
      await expect(refundInsert).rejects.toMatchObject({
        code: "23514",
        constraint: "refund_captured_payment_check",
      });
      await receiptWriter.query("ROLLBACK");
      refundInsert = undefined;

      await refundHolder.query("BEGIN");
      await refundHolder.query(
        `SELECT 1 FROM refund_transactions WHERE id = $1 FOR UPDATE`,
        [refundId],
      );

      await receiptWriter.query("BEGIN");
      await receiptWriter.query("SET LOCAL statement_timeout = '3s'");
      const receiptWriterPid = (
        await receiptWriter.query<{ pid: number }>(
          `SELECT pg_backend_pid() AS pid`,
        )
      ).rows[0]?.pid;
      if (!receiptWriterPid) {
        throw new Error("refund receipt backend pid is unavailable");
      }
      const writerFixtures = new PersistenceFactory(
        receiptWriter,
        fixtureScope,
      );
      receiptInsert = writerFixtures.persistRefundProviderEvent(
        refundId,
        "REFUND_SUCCEEDED",
        "lock-ordered-provider-refund",
        new Date(),
      );

      let receiptWaitsForRefund = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const activity = await refundHolder.query<{
          wait_event_type: string | null;
        }>(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE pid = $1`,
          [receiptWriterPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          receiptWaitsForRefund = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(receiptWaitsForRefund).toBe(true);
      await expect(
        refundHolder.query(
          `SELECT 1 FROM payments WHERE id = $1 FOR UPDATE NOWAIT`,
          [foundation.paymentId],
        ),
      ).resolves.toBeDefined();

      await refundHolder.query("ROLLBACK");
      await expect(receiptInsert).resolves.toBeDefined();
      await receiptWriter.query("ROLLBACK");
    } finally {
      await setup.query("ROLLBACK").catch(() => undefined);
      await refundHolder.query("ROLLBACK").catch(() => undefined);
      await receiptWriter.query("ROLLBACK").catch(() => undefined);
      await receiptInsert?.catch(() => undefined);
      await refundInsert?.catch(() => undefined);
      setup.release();
      refundHolder.release();
      receiptWriter.release();
    }
  });

  it("claims refund dispatch only after acquiring the canonical order lock", async () => {
    const setup = await pool.connect();
    const orderHolder = await pool.connect();
    const claimant = await pool.connect();
    let claim: Promise<unknown> | undefined;
    try {
      const fixtureScope = `${scope}:refund-dispatch-claim-lock-order`;
      const fixtures = new PersistenceFactory(setup, fixtureScope);
      await setup.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "refund-dispatch-claim-lock-order",
      );
      const productions = await createCurrentPlanAndPayment(
        setup,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(setup, fixtures, foundation, productions);
      await cancelOrderBeforeHandoff(setup, foundation.orderId);
      const refundId = (
        await setup.query<{ id: string }>(
          `SELECT id FROM refund_transactions
           WHERE payment_id = $1
             AND reason = 'CUSTOMER_CANCELLATION'
             AND status = 'PENDING'`,
          [foundation.paymentId],
        )
      ).rows[0]?.id;
      if (!refundId) {
        throw new Error("refund dispatch claim fixture is missing");
      }
      await setup.query("COMMIT");

      await orderHolder.query("BEGIN");
      await orderHolder.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [
        foundation.orderId,
      ]);

      await claimant.query("BEGIN");
      await claimant.query("SET LOCAL statement_timeout = '3s'");
      const claimantPid = (
        await claimant.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]?.pid;
      if (!claimantPid) {
        throw new Error("refund dispatch claimant backend pid is unavailable");
      }
      claim = claimant.query(
        `SELECT taven_claim_refund_dispatch($1) AS claimed_at`,
        [refundId],
      );

      let claimWaitsForOrder = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const activity = await orderHolder.query<{
          wait_event_type: string | null;
        }>(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE pid = $1`,
          [claimantPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          claimWaitsForOrder = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(claimWaitsForOrder).toBe(true);
      await expect(
        orderHolder.query(
          `SELECT 1 FROM refund_transactions WHERE id = $1 FOR UPDATE NOWAIT`,
          [refundId],
        ),
      ).resolves.toBeDefined();
      await expect(
        orderHolder.query(
          `SELECT 1 FROM payments WHERE id = $1 FOR UPDATE NOWAIT`,
          [foundation.paymentId],
        ),
      ).resolves.toBeDefined();

      await orderHolder.query("ROLLBACK");
      await expect(claim).resolves.toMatchObject({
        rows: [{ claimed_at: expect.any(Date) }],
      });
      await claimant.query("ROLLBACK");
      claim = undefined;
    } finally {
      await setup.query("ROLLBACK").catch(() => undefined);
      await orderHolder.query("ROLLBACK").catch(() => undefined);
      await claimant.query("ROLLBACK").catch(() => undefined);
      await claim?.catch(() => undefined);
      setup.release();
      orderHolder.release();
      claimant.release();
    }
  });

  it("serializes refunded order closure with concurrent refund completion without deadlocking", async () => {
    const setup = await pool.connect();
    const closing = await pool.connect();
    const refunding = await pool.connect();
    let refundEventInsert: Promise<string> | undefined;
    try {
      const fixtures = new PersistenceFactory(
        setup,
        `${scope}:refund-completion-concurrency`,
      );
      await setup.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "refund-completion-concurrency",
      );
      const productions = await createCurrentPlanAndPayment(
        setup,
        fixtures,
        foundation,
      );
      await activateCurrentPlan(setup, fixtures, foundation, productions);
      await cancelOrderBeforeHandoff(setup, foundation.orderId);
      const refundId = (
        await setup.query<{ id: string }>(
          `SELECT id
           FROM refund_transactions
           WHERE payment_id = $1
             AND reason = 'CUSTOMER_CANCELLATION'
             AND status = 'PENDING'`,
          [foundation.paymentId],
        )
      ).rows[0]?.id;
      if (!refundId) {
        throw new Error("refund completion concurrency work is unavailable");
      }
      await setup.query("COMMIT");

      await closing.query("BEGIN");
      await closing.query("SET LOCAL lock_timeout = '500ms'");
      await closing.query(
        `UPDATE orders SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [foundation.orderId, new Date()],
      );

      await refunding.query("BEGIN");
      await refunding.query("SET LOCAL statement_timeout = '2s'");
      const refundingPid = (
        await refunding.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]?.pid;
      if (!refundingPid) {
        throw new Error("refund concurrency backend pid is unavailable");
      }
      const completedAt = new Date();
      const refundingFixtures = new PersistenceFactory(
        refunding,
        `${scope}:refund-completion-concurrency`,
      );
      refundEventInsert = refundingFixtures.persistRefundProviderEvent(
        refundId,
        "REFUND_SUCCEEDED",
        "concurrent-provider-refund",
        completedAt,
      );

      let refundIsWaitingForOrder = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const activity = await setup.query<{ wait_event_type: string | null }>(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE pid = $1`,
          [refundingPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          refundIsWaitingForOrder = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(refundIsWaitingForOrder).toBe(true);
      await expect(
        closing.query(
          `SELECT 1 FROM refund_transactions WHERE id = $1 FOR UPDATE NOWAIT`,
          [refundId],
        ),
      ).resolves.toBeDefined();
      await expect(
        closing.query(
          `SELECT 1 FROM payments WHERE id = $1 FOR UPDATE NOWAIT`,
          [foundation.paymentId],
        ),
      ).resolves.toBeDefined();

      await expect(
        closing.query(
          `SET CONSTRAINTS "orders_refund_completion_reconciled" IMMEDIATE`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "order_refund_completion_check",
      });
      await closing.query("ROLLBACK");
      await expect(refundEventInsert).resolves.toBeDefined();
      await refunding.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_refund_id = $2,
             completed_at = $3, updated_at = $3
         WHERE id = $1`,
        [refundId, "concurrent-provider-refund", completedAt],
      );
      await refunding.query(
        `UPDATE payments SET status = 'REFUNDED', updated_at = $2 WHERE id = $1`,
        [foundation.paymentId, completedAt],
      );
      await refunding.query(
        `SET CONSTRAINTS
           "payments_refund_status_reconciled",
           "refund_transactions_payment_status_reconciled",
           "payments_customer_cancellation_refund_reconciled" IMMEDIATE`,
      );
    } finally {
      await setup.query("ROLLBACK").catch(() => undefined);
      await closing.query("ROLLBACK").catch(() => undefined);
      await refunding.query("ROLLBACK").catch(() => undefined);
      await refundEventInsert?.catch(() => undefined);
      setup.release();
      closing.release();
      refunding.release();
    }
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
      for (const status of ["IN_PRODUCTION", "QC_PASSED"] as const) {
        await advanceOrderLifecycleStep(client, completed.orderId, status);
      }
      await expectQueryError(
        client,
        "release_active_order_source",
        () =>
          client.query(
            `UPDATE model_files SET retention_hold = 'NONE' WHERE id = $1`,
            [completed.modelFileId],
          ),
        { code: "23514", constraint: "order_source_active_order_check" },
      );
      await expectQueryError(
        client,
        "delete_active_order_source",
        () =>
          client.query(
            `UPDATE model_files SET deleted_at = clock_timestamp() WHERE id = $1`,
            [completed.modelFileId],
          ),
        { code: "23514", constraint: "order_source_active_order_check" },
      );
      for (const status of [
        "READY_TO_SHIP",
        "SHIPPED",
        "DELIVERED",
        "COMPLETED",
      ] as const) {
        await advanceOrderLifecycleStep(client, completed.orderId, status);
      }
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
      const retentionRefund = (
        await client.query<{ id: string }>(
          `SELECT id FROM refund_transactions
           WHERE payment_id = $1
             AND reason = 'CUSTOMER_CANCELLATION'
             AND status = 'PENDING'`,
          [captured.paymentId],
        )
      ).rows[0];
      if (!retentionRefund) {
        throw new Error("retention refund fixture is missing");
      }
      const retentionRefundedAt = new Date();
      await fixtures.persistRefundProviderEvent(
        retentionRefund.id,
        "REFUND_SUCCEEDED",
        "retention-full-refund",
        retentionRefundedAt,
      );
      await client.query(
        `UPDATE refund_transactions
         SET status = 'SUCCEEDED', provider_refund_id = $2,
             completed_at = $3, updated_at = $3
         WHERE id = $1`,
        [retentionRefund.id, "retention-full-refund", retentionRefundedAt],
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

  it("retains individual quote-reference photos through the order lifecycle", async () => {
    await rollback(
      "individual-quote-reference-retention",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "individual-quote-reference-retention",
          {},
          undefined,
          undefined,
          undefined,
          1,
          undefined,
          "QUOTED",
          undefined,
          {},
          "INDIVIDUAL",
        );
        const uploadedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
        const initialPhotoId = fixtures.id(
          "individual-quote-reference-initial",
        );
        await client.query(
          `INSERT INTO photo_assets
           (id, kind, scope_kind, scope_id, storage_object_key, content_hash,
            media_type, size_bytes, uploaded_at, photo_delete_after,
            retention_hold, created_at)
         VALUES ($1,'QUOTE_REFERENCE','QUOTE_REQUEST',$2,$3,$4,'image/jpeg',1,$5,$6,'NONE',$5)`,
          [
            initialPhotoId,
            foundation.quoteRequestId,
            `quote-reference/${initialPhotoId}`,
            "c".repeat(64),
            uploadedAt,
            new Date(Date.now() - 24 * 60 * 60 * 1_000),
          ],
        );
        expect(
          (
            await client.query<{ retention_hold: string }>(
              `SELECT retention_hold::text FROM photo_assets WHERE id = $1`,
              [initialPhotoId],
            )
          ).rows,
        ).toEqual([{ retention_hold: "NONE" }]);

        const productions = await createCurrentPlanAndPayment(
          client,
          fixtures,
          foundation,
        );
        await activateCurrentPlan(client, fixtures, foundation, productions);
        expect(
          (
            await client.query<{ retention_hold: string }>(
              `SELECT retention_hold::text FROM photo_assets WHERE id = $1`,
              [initialPhotoId],
            )
          ).rows,
        ).toEqual([{ retention_hold: "ACTIVE_ORDER" }]);
        await expectQueryError(
          client,
          "release_active_order_quote_reference",
          () =>
            client.query(
              `UPDATE photo_assets SET retention_hold = 'NONE' WHERE id = $1`,
              [initialPhotoId],
            ),
          {
            code: "23514",
            constraint: "quote_reference_photo_active_order_check",
          },
        );
        await expectQueryError(
          client,
          "move_active_order_quote_reference_scope",
          () =>
            client.query(
              `UPDATE photo_assets SET scope_id = $2 WHERE id = $1`,
              [initialPhotoId, fixtures.id("unrelated-quote-reference-scope")],
            ),
          {
            code: "55000",
          },
        );

        const deletedPhotoId = fixtures.id(
          "individual-quote-reference-deleted",
        );
        await expectQueryError(
          client,
          "insert_deleted_active_order_quote_reference",
          () =>
            client.query(
              `INSERT INTO photo_assets
               (id, kind, scope_kind, scope_id, storage_object_key, content_hash,
                media_type, size_bytes, uploaded_at, photo_delete_after,
                retention_hold, deleted_at, created_at)
               VALUES ($1,'QUOTE_REFERENCE','QUOTE_REQUEST',$2,$3,$4,
                       'image/jpeg',1,$5,$6,'NONE',$5,$5)`,
              [
                deletedPhotoId,
                foundation.quoteRequestId,
                `quote-reference/${deletedPhotoId}`,
                "e".repeat(64),
                uploadedAt,
                new Date(Date.now() - 24 * 60 * 60 * 1_000),
              ],
            ),
          {
            code: "23514",
            constraint: "quote_reference_photo_active_order_check",
          },
        );

        const latePhotoId = fixtures.id("individual-quote-reference-late");
        await client.query(
          `INSERT INTO photo_assets
           (id, kind, scope_kind, scope_id, storage_object_key, content_hash,
            media_type, size_bytes, uploaded_at, photo_delete_after,
            retention_hold, created_at)
         VALUES ($1,'QUOTE_REFERENCE','QUOTE_REQUEST',$2,$3,$4,'image/jpeg',1,$5,$6,'NONE',$5)`,
          [
            latePhotoId,
            foundation.quoteRequestId,
            `quote-reference/${latePhotoId}`,
            "d".repeat(64),
            uploadedAt,
            new Date(Date.now() - 24 * 60 * 60 * 1_000),
          ],
        );
        expect(
          (
            await client.query<{ retention_hold: string }>(
              `SELECT retention_hold::text FROM photo_assets WHERE id = $1`,
              [latePhotoId],
            )
          ).rows,
        ).toEqual([{ retention_hold: "ACTIVE_ORDER" }]);

        const terminalStartedAt = (
          await client.query<{ terminal_started_at: Date }>(
            `SELECT clock_timestamp() AS terminal_started_at`,
          )
        ).rows[0]?.terminal_started_at;
        if (!terminalStartedAt) {
          throw new Error("database terminal clock is unavailable");
        }
        for (const status of [
          "IN_PRODUCTION",
          "QC_PASSED",
          "READY_TO_SHIP",
          "SHIPPED",
          "DELIVERED",
          "COMPLETED",
        ] as const) {
          await advanceOrderLifecycleStep(client, foundation.orderId, status);
        }
        const releasedPhotos = await client.query<{
          id: string;
          retention_hold: string;
          photo_delete_after: Date;
        }>(
          `SELECT id, retention_hold::text, photo_delete_after
         FROM photo_assets
         WHERE id IN ($1,$2)
         ORDER BY id`,
          [initialPhotoId, latePhotoId],
        );
        expect(
          releasedPhotos.rows.map((photo) => photo.retention_hold),
        ).toEqual(["NONE", "NONE"]);
        for (const photo of releasedPhotos.rows) {
          expect(photo.photo_delete_after.getTime()).toBeGreaterThanOrEqual(
            terminalStartedAt.getTime() + 90 * 24 * 60 * 60 * 1_000,
          );
        }
      },
    );
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
      const oldReferencePhotoId = fixtures.id(
        "quote-issuance-old-reference-photo",
      );
      const longReferencePhotoId = fixtures.id(
        "quote-issuance-long-reference-photo",
      );
      const uploadedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000);
      const initialPhotoDeadline = new Date(
        now.getTime() - 24 * 60 * 60 * 1_000,
      );
      const longPhotoDeadline = new Date(
        now.getTime() + 120 * 24 * 60 * 60 * 1_000,
      );
      const quoteExpiresAt = new Date(now.getTime() + 60 * 60 * 1_000);

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
      await client.query(
        `INSERT INTO photo_assets
           (id, kind, scope_kind, scope_id, storage_object_key, content_hash,
            media_type, size_bytes, uploaded_at, photo_delete_after,
            retention_hold, created_at)
         VALUES
           ($1,'QUOTE_REFERENCE','QUOTE_REQUEST',$3,$4,$5,'image/jpeg',1,$6,$7,'NONE',$6),
           ($2,'QUOTE_REFERENCE','QUOTE_REQUEST',$3,$8,$9,'image/jpeg',1,$6,$10,'NONE',$6)`,
        [
          oldReferencePhotoId,
          longReferencePhotoId,
          requestId,
          `quote-reference/${oldReferencePhotoId}`,
          "8".repeat(64),
          uploadedAt,
          initialPhotoDeadline,
          `quote-reference/${longReferencePhotoId}`,
          "9".repeat(64),
          longPhotoDeadline,
        ],
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
            [quoteId, requestId, foundation.customerId, quoteExpiresAt, now],
          );
          await forceQuoteIssuanceConstraints(client);
        },
        {
          code: "23514",
          constraint: "quote_request_issuance_atomic_check",
        },
      );
      expect(
        (
          await client.query<{ id: string; photo_delete_after: Date }>(
            `SELECT id, photo_delete_after
             FROM photo_assets WHERE id IN ($1,$2) ORDER BY id`,
            [oldReferencePhotoId, longReferencePhotoId],
          )
        ).rows.map(({ id, photo_delete_after }) => ({
          id,
          photoDeleteAfter: photo_delete_after.getTime(),
        })),
      ).toEqual(
        [
          {
            id: oldReferencePhotoId,
            photoDeleteAfter: initialPhotoDeadline.getTime(),
          },
          {
            id: longReferencePhotoId,
            photoDeleteAfter: longPhotoDeadline.getTime(),
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
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
        [quoteId, requestId, foundation.customerId, quoteExpiresAt, now],
      );
      await client.query(
        `INSERT INTO price_snapshots
           (id, price_list_id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                 'EUR',0,'legacy-v0-eur','{}'::jsonb,$2,$3)`,
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
      const issuedPhotoDeadlines = (
        await client.query<{ id: string; photo_delete_after: Date }>(
          `SELECT id, photo_delete_after
           FROM photo_assets WHERE id IN ($1,$2) ORDER BY id`,
          [oldReferencePhotoId, longReferencePhotoId],
        )
      ).rows;
      expect(
        issuedPhotoDeadlines
          .find(({ id }) => id === oldReferencePhotoId)
          ?.photo_delete_after.getTime(),
      ).toBe(quoteExpiresAt.getTime() + 90 * 24 * 60 * 60 * 1_000);
      expect(
        issuedPhotoDeadlines
          .find(({ id }) => id === longReferencePhotoId)
          ?.photo_delete_after.getTime(),
      ).toBe(longPhotoDeadline.getTime());
      await expectQueryError(
        client,
        "shorten_issued_quote_reference_deadline",
        () =>
          client.query(
            `UPDATE photo_assets SET photo_delete_after = $2 WHERE id = $1`,
            [oldReferencePhotoId, initialPhotoDeadline],
          ),
        {
          code: "23514",
          constraint: "asset_deadline_monotonic_check",
        },
      );
      await expectQueryError(
        client,
        "mutate_quote_reference_retention_snapshot",
        () =>
          client.query(
            `UPDATE photo_assets SET retention_days = 1 WHERE id = $1`,
            [oldReferencePhotoId],
          ),
        { code: "55000" },
      );

      const lateReferencePhotoId = fixtures.id(
        "quote-issuance-late-reference-photo",
      );
      await client.query(
        `INSERT INTO photo_assets
           (id, kind, scope_kind, scope_id, storage_object_key, content_hash,
            media_type, size_bytes, uploaded_at, photo_delete_after,
            retention_hold, created_at)
         VALUES ($1,'QUOTE_REFERENCE','QUOTE_REQUEST',$2,$3,$4,'image/jpeg',1,
                 $5,$6,'NONE',$5)`,
        [
          lateReferencePhotoId,
          requestId,
          `quote-reference/${lateReferencePhotoId}`,
          "b".repeat(64),
          uploadedAt,
          initialPhotoDeadline,
        ],
      );
      expect(
        (
          await client.query<{ photo_delete_after: Date }>(
            `SELECT photo_delete_after FROM photo_assets WHERE id = $1`,
            [lateReferencePhotoId],
          )
        ).rows[0]?.photo_delete_after.getTime(),
      ).toBe(quoteExpiresAt.getTime() + 90 * 24 * 60 * 60 * 1_000);

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

  it("serializes Quote issuance with concurrent reference-photo uploads", async () => {
    const setup = await pool.connect();
    const issuing = await pool.connect();
    const uploading = await pool.connect();
    try {
      const fixtures = new PersistenceFactory(
        setup,
        `${scope}:quote-photo-issuance-concurrency`,
      );
      const createdAt = new Date();
      const quoteExpiresAt = new Date(
        createdAt.getTime() + 24 * 60 * 60 * 1_000,
      );
      const initialPhotoDeadline = new Date(
        createdAt.getTime() + 2 * 24 * 60 * 60 * 1_000,
      );
      const requestId = fixtures.id("concurrent-reference-request");
      const quoteId = fixtures.id("concurrent-reference-quote");
      const snapshotId = fixtures.id("concurrent-reference-snapshot");
      const photoId = fixtures.id("concurrent-reference-photo");

      await setup.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "quote-photo-issuance-concurrency",
      );
      await setup.query(
        `INSERT INTO quote_requests
           (id, customer_id, status, created_at, updated_at)
         VALUES ($1,$2,'NEW',$3,$3)`,
        [requestId, foundation.customerId, createdAt],
      );
      await setup.query(
        `UPDATE quote_requests SET status = 'IN_REVIEW', updated_at = $2
         WHERE id = $1`,
        [requestId, createdAt],
      );
      await setup.query("COMMIT");

      await issuing.query("BEGIN");
      await issuing.query(
        `UPDATE quote_requests SET status = 'QUOTED', updated_at = $2
         WHERE id = $1`,
        [requestId, createdAt],
      );
      await issuing.query(
        `INSERT INTO quotes
           (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [quoteId, requestId, foundation.customerId, quoteExpiresAt, createdAt],
      );
      await issuing.query(
        `INSERT INTO price_snapshots
           (id, price_list_id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                 'EUR',0,'legacy-v0-eur','{}'::jsonb,$2,$3)`,
        [snapshotId, randomUUID().replaceAll("-", "").repeat(2), createdAt],
      );
      await issuing.query(
        `INSERT INTO payment_schedules
           (id, price_snapshot_id, sequence, role, gross_amount_minor,
            fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
         VALUES ($1,$2,0,'FULL',0,0,0,'{}'::jsonb,$3)`,
        [fixtures.id("concurrent-reference-schedule"), snapshotId, createdAt],
      );
      await issuing.query(
        `INSERT INTO quote_price_bindings (quote_id, price_snapshot_id)
         VALUES ($1,$2)`,
        [quoteId, snapshotId],
      );

      await uploading.query("BEGIN");
      await uploading.query("SET LOCAL statement_timeout = '2s'");
      const uploadingPid = (
        await uploading.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]?.pid;
      if (!uploadingPid) {
        throw new Error("quote-reference upload backend pid is unavailable");
      }
      const blockedUpload = uploading.query(
        `INSERT INTO photo_assets
           (id, kind, scope_kind, scope_id, storage_object_key, content_hash,
            media_type, size_bytes, uploaded_at, photo_delete_after,
            retention_hold, created_at)
         VALUES ($1,'QUOTE_REFERENCE','QUOTE_REQUEST',$2,$3,$4,'image/jpeg',1,
                 $5,$6,'NONE',$5)`,
        [
          photoId,
          requestId,
          `quote-reference/${photoId}`,
          "f".repeat(64),
          createdAt,
          initialPhotoDeadline,
        ],
      );

      let uploadIsWaitingForIssuance = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const activity = await setup.query<{ wait_event_type: string | null }>(
          `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
          [uploadingPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          uploadIsWaitingForIssuance = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(uploadIsWaitingForIssuance).toBe(true);

      await issuing.query("COMMIT");
      await expect(blockedUpload).resolves.toBeDefined();
      await uploading.query("COMMIT");

      expect(
        (
          await setup.query<{ photo_delete_after: Date }>(
            `SELECT photo_delete_after FROM photo_assets WHERE id = $1`,
            [photoId],
          )
        ).rows[0]?.photo_delete_after.getTime(),
      ).toBe(quoteExpiresAt.getTime() + 90 * 24 * 60 * 60 * 1_000);
    } finally {
      await setup.query("ROLLBACK").catch(() => undefined);
      await issuing.query("ROLLBACK").catch(() => undefined);
      await uploading.query("ROLLBACK").catch(() => undefined);
      setup.release();
      issuing.release();
      uploading.release();
    }
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
          includeItem = true,
        ): Promise<string> => {
          const requestId = fixtures.id(`${name}:request`);
          const quoteId = fixtures.id(`${name}:quote`);
          const quoteItemId = fixtures.id(`${name}:item`);
          const snapshotId = fixtures.id(`${name}:snapshot`);
          const contractTotal = includeItem ? 0 : 1;
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
          if (includeItem) {
            await client.query(
              `INSERT INTO quote_items
                 (id, quote_id, ordinal, source_model_file_id,
                  model_geometry_id, print_config_revision_id, material,
                  color, quantity, created_at)
               VALUES ($1,$2,0,$3,$4,$5,'PLA','black',1,$6)`,
              [
                quoteItemId,
                quoteId,
                foundation.modelFileId,
                foundation.modelGeometryId,
                foundation.printConfigRevisionId,
                issuedAt,
              ],
            );
          }
          await client.query(
            `INSERT INTO price_snapshots
             (id, price_list_id, currency, contract_total_minor, pricing_revision,
              input_snapshot, snapshot_hash, created_at)
           VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                   'EUR',$2,'legacy-v0-eur','{}'::jsonb,$3,$4)`,
            [snapshotId, contractTotal, snapshotHash, issuedAt],
          );
          await client.query(
            `INSERT INTO quote_price_bindings (quote_id, price_snapshot_id)
             VALUES ($1,$2)`,
            [quoteId, snapshotId],
          );
          if (includeItem) {
            await client.query(
              `INSERT INTO price_snapshot_components
                 (id, price_snapshot_id, kind, scope, quote_item_id,
                  amount_minor, allocation, created_at)
               VALUES
                 ($1,$2,'ITEM_PRODUCTION','QUOTE_ITEM',$3,0,'{}'::jsonb,$4),
                 ($5,$2,'ITEM_QUANTITY','QUOTE_ITEM',$3,0,'{}'::jsonb,$4),
                 ($6,$2,'ITEM_POSTPROCESSING','QUOTE_ITEM',$3,0,'{}'::jsonb,$4)`,
              [
                fixtures.id(`${name}:production-component`),
                snapshotId,
                quoteItemId,
                issuedAt,
                fixtures.id(`${name}:quantity-component`),
                fixtures.id(`${name}:postprocessing-component`),
              ],
            );
          } else {
            await client.query(
              `INSERT INTO price_snapshot_components
                 (id, price_snapshot_id, kind, scope, amount_minor,
                  allocation, created_at)
               VALUES ($1,$2,'ORDER_MIN_PRINT','ORDER',$3,'{}'::jsonb,$4)`,
              [
                fixtures.id(`${name}:order-component`),
                snapshotId,
                contractTotal,
                issuedAt,
              ],
            );
          }
          await client.query(
            `INSERT INTO payment_schedules
             (id, price_snapshot_id, sequence, role, gross_amount_minor,
              fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
           VALUES ($1,$2,0,'FULL',$3,0,0,'{}'::jsonb,$4)`,
            [
              fixtures.id(`${name}:schedule`),
              snapshotId,
              contractTotal,
              issuedAt,
            ],
          );
          return requestId;
        };

        const now = new Date();
        const itemlessRequestId = await createPricedOffer(
          "itemless-offer",
          now,
          new Date(now.getTime() + 60 * 60 * 1_000),
          "4".repeat(64),
          false,
        );
        await expectQueryError(
          client,
          "accept_itemless_offer",
          () =>
            client.query(
              `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2
               WHERE id = $1`,
              [itemlessRequestId, now],
            ),
          {
            code: "23514",
            constraint: "quote_price_binding_acceptance_check",
          },
        );
        const zeroValueRequestId = await createPricedOffer(
          "zero-value-offer",
          now,
          new Date(now.getTime() + 60 * 60 * 1_000),
          "5".repeat(64),
        );
        await expectQueryError(
          client,
          "accept_zero_value_offer",
          () =>
            client.query(
              `UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2
               WHERE id = $1`,
              [zeroValueRequestId, now],
            ),
          {
            code: "23514",
            constraint: "quote_price_binding_acceptance_check",
          },
        );
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

        const toleratedRequestId = fixtures.id(
          "tolerated-future-offer:request",
        );
        const toleratedQuoteId = fixtures.id("tolerated-future-offer:quote");
        await client.query(
          `INSERT INTO quote_requests
             (id, customer_id, status, created_at, updated_at)
           VALUES ($1,$2,'NEW',clock_timestamp(),clock_timestamp())`,
          [toleratedRequestId, foundation.customerId],
        );
        await advanceQuoteRequestToQuoted(client, toleratedRequestId, now);
        await client.query(
          `INSERT INTO quotes
             (id, quote_request_id, customer_id, expires_at, issued_at, created_at)
           VALUES ($1,$2,$3,clock_timestamp() + interval '1 hour',
                   clock_timestamp() + interval '2 seconds',clock_timestamp())`,
          [toleratedQuoteId, toleratedRequestId, foundation.customerId],
        );
        expect(
          (
            await client.query<{ quote_exists: boolean }>(
              `SELECT EXISTS (
                   SELECT 1 FROM quotes WHERE id = $1
               ) AS quote_exists`,
              [toleratedQuoteId],
            )
          ).rows,
        ).toEqual([{ quote_exists: true }]);

        await expectQueryError(
          client,
          "rewrite_quote_request_created_at",
          () =>
            client.query(
              `UPDATE quote_requests
               SET created_at = created_at + interval '1 second'
               WHERE id = $1`,
              [toleratedRequestId],
            ),
          {
            code: "23514",
            constraint: "quote_request_created_at_immutable_check",
          },
        );

        const historicalRequestId = fixtures.id("historical-offer:request");
        await client.query(
          `INSERT INTO quote_requests
             (id, customer_id, status, created_at, updated_at)
           VALUES ($1,$2,'NEW',clock_timestamp(),clock_timestamp())`,
          [historicalRequestId, foundation.customerId],
        );
        await advanceQuoteRequestToQuoted(client, historicalRequestId, now);
        await expectQueryError(
          client,
          "historical_quote_issuance",
          () =>
            client.query(
              `INSERT INTO quotes
                 (id, quote_request_id, customer_id, expires_at,
                  issued_at, created_at)
               SELECT $1,$2,$3,clock_timestamp() + interval '1 hour',
                      created_at - interval '1 millisecond',clock_timestamp()
               FROM quote_requests WHERE id = $2`,
              [
                fixtures.id("historical-offer:quote"),
                historicalRequestId,
                foundation.customerId,
              ],
            ),
          {
            code: "23514",
            constraint: "quote_issuance_request_created_at_check",
          },
        );

        const futureRequestId = fixtures.id("future-offer:request");
        await client.query(
          `INSERT INTO quote_requests
             (id, customer_id, status, created_at, updated_at)
           VALUES ($1,$2,'NEW',clock_timestamp(),clock_timestamp())`,
          [futureRequestId, foundation.customerId],
        );
        await advanceQuoteRequestToQuoted(client, futureRequestId, now);
        await expectQueryError(
          client,
          "future_quote_issuance",
          () =>
            client.query(
              `INSERT INTO quotes
                 (id, quote_request_id, customer_id, expires_at,
                  issued_at, created_at)
               VALUES ($1,$2,$3,clock_timestamp() + interval '1 hour',
                       clock_timestamp() + interval '60 seconds',clock_timestamp())`,
              [
                fixtures.id("future-offer:quote"),
                futureRequestId,
                foundation.customerId,
              ],
            ),
          {
            code: "23514",
            constraint: "quote_issuance_evidence_check",
          },
        );
      },
    );
  });

  it("retains the accepted snapshot for an individual order binding", async () => {
    await rollback("individual-binding-retention", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation(
        "individual-binding-retention",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "DRAFT",
        undefined,
        {},
        "INDIVIDUAL",
        false,
        true,
        false,
      );

      await expectQueryError(
        client,
        "invalidate_individual_binding",
        () =>
          client.query(
            `UPDATE order_price_bindings
             SET invalidated_at = clock_timestamp()
             WHERE id = $1`,
            [foundation.orderPriceBindingId],
          ),
        {
          code: "23514",
          constraint: "individual_order_price_binding_invalidation_check",
        },
      );

      expect(
        (
          await client.query<{ invalidated_at: Date | null }>(
            `SELECT invalidated_at FROM order_price_bindings WHERE id = $1`,
            [foundation.orderPriceBindingId],
          )
        ).rows,
      ).toEqual([{ invalidated_at: null }]);
    });
  });

  it("quotes an individual order only after copying every accepted quote item exactly", async () => {
    await rollback("individual-copy", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation("individual-copy");
      const quoteRequestId = fixtures.id("custom-request");
      const quoteId = fixtures.id("custom-quote");
      const quoteItemId = fixtures.id("custom-quote-item");
      const secondQuoteItemId = fixtures.id("custom-quote-item-2");
      const snapshotId = fixtures.id("custom-snapshot");
      const depositScheduleId = fixtures.id("custom-deposit-schedule");
      const balanceScheduleId = fixtures.id("custom-balance-schedule");
      const priceComponents = [
        {
          id: fixtures.id("custom-item-production"),
          kind: "ITEM_PRODUCTION",
          quoteItemId,
          amountMinor: 2,
        },
        {
          id: fixtures.id("custom-item-quantity"),
          kind: "ITEM_QUANTITY",
          quoteItemId,
          amountMinor: 0,
        },
        {
          id: fixtures.id("custom-item-postprocessing"),
          kind: "ITEM_POSTPROCESSING",
          quoteItemId,
          amountMinor: 0,
        },
        {
          id: fixtures.id("custom-item-2-production"),
          kind: "ITEM_PRODUCTION",
          quoteItemId: secondQuoteItemId,
          amountMinor: 0,
        },
        {
          id: fixtures.id("custom-item-2-quantity"),
          kind: "ITEM_QUANTITY",
          quoteItemId: secondQuoteItemId,
          amountMinor: 0,
        },
        {
          id: fixtures.id("custom-item-2-postprocessing"),
          kind: "ITEM_POSTPROCESSING",
          quoteItemId: secondQuoteItemId,
          amountMinor: 0,
        },
      ] as const;
      const fulfilmentSlotIds = [
        fixtures.id("custom-slot-1"),
        fixtures.id("custom-slot-2"),
        fixtures.id("custom-slot-3"),
      ] as const;
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
        `INSERT INTO price_snapshots (id, price_list_id, currency,
                                     contract_total_minor, pricing_revision,
                                     input_snapshot, snapshot_hash, created_at)
         VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                 'EUR',2,'legacy-v0-eur','{}'::jsonb,$2,$3)`,
        [snapshotId, "b".repeat(64), now],
      );
      await client.query(
        `INSERT INTO payment_schedules (id, price_snapshot_id, sequence, role,
                                       gross_amount_minor, fee_rate_basis_points, fee_fixed_minor,
                                       provider_config, created_at)
         VALUES ($1,$3,0,'DEPOSIT',1,0,0,'{}'::jsonb,$4),
                ($2,$3,1,'BALANCE',1,0,0,'{}'::jsonb,$4)`,
        [depositScheduleId, balanceScheduleId, snapshotId, now],
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
        "direct_snapshot_seal_before_components",
        () =>
          client.query(
            `UPDATE price_snapshots
             SET sealed_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [snapshotId],
          ),
        { code: "23514" },
      );
      const insertQuotePriceComponent = (
        component: (typeof priceComponents)[number],
      ) =>
        client.query(
          `INSERT INTO price_snapshot_components
             (id, price_snapshot_id, kind, scope, quote_item_id,
              amount_minor, allocation, created_at)
           VALUES ($1,$2,$3::price_component_kind,'QUOTE_ITEM',$4,$5,
                   '{}'::jsonb,$6)`,
          [
            component.id,
            snapshotId,
            component.kind,
            component.quoteItemId,
            component.amountMinor,
            now,
          ],
        );
      for (const component of priceComponents.slice(0, -1)) {
        await insertQuotePriceComponent(component);
      }
      await expectQueryError(
        client,
        "accept_quote_without_item_price_coverage",
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
      await insertQuotePriceComponent(priceComponents.at(-1)!);
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
        `INSERT INTO price_snapshots (id, price_list_id, currency,
                                     contract_total_minor, pricing_revision, input_snapshot,
                                     snapshot_hash, created_at)
         VALUES ($1,(SELECT id FROM price_lists WHERE revision = 'legacy-v0-eur'),
                 'EUR',0,'legacy-v0-eur','{}'::jsonb,$2,$3)`,
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

      await expectQueryError(
        client,
        "invalidated_binding_before_individual_origin",
        async () => {
          const invalidatedOrderId = fixtures.id("invalidated-custom-order");
          const invalidatedDestinationId = fixtures.id(
            "invalidated-custom-destination",
          );
          await client.query(
            `INSERT INTO orders
               (id, customer_id, public_reference, status, created_at, updated_at)
             VALUES ($1,$2,$3,'DRAFT',$4,$4)`,
            [
              invalidatedOrderId,
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
              invalidatedDestinationId,
              invalidatedOrderId,
              `endpoint-${randomUUID()}`,
              now,
            ],
          );
          await client.query(
            `INSERT INTO order_price_bindings
               (id, order_id, price_snapshot_id, delivery_destination_id,
                invalidated_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$5)`,
            [
              fixtures.id("invalidated-custom-binding"),
              invalidatedOrderId,
              snapshotId,
              invalidatedDestinationId,
              now,
            ],
          );
          await client.query(
            `INSERT INTO individual_order_origins (order_id, quote_id)
             VALUES ($1,$2)`,
            [invalidatedOrderId, quoteId],
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
      const shipmentPlanId = fixtures.id("custom-shipment-plan");
      const shipmentComponentId = fixtures.id("custom-shipment-component");
      const createQuotedTopology = async (
        includeFulfilmentMoney = false,
      ): Promise<void> => {
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
        if (includeFulfilmentMoney) {
          await client.query(
            `INSERT INTO shipment_plans
               (id, order_id, order_phase_id, price_snapshot_id,
                order_price_binding_id, delivery_destination_id, ordinal,
                category, planned_volume_cubic_mm, planned_weight_milligrams,
                shipping_amount_minor, packaging_amount_minor,
                handling_amount_minor, allocation_snapshot, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,0,'standard',1,1,0,0,0,
                     '{}'::jsonb,$7)`,
            [
              shipmentPlanId,
              orderId,
              phaseId,
              snapshotId,
              bindingId,
              destinationId,
              now,
            ],
          );
          await client.query(
            `INSERT INTO fulfilment_slots
               (id, order_id, order_phase_id, order_item_id,
                quantity_ordinal, settlement_amount_minor, created_at, updated_at)
             VALUES ($1,$2,$3,$4,1,2,$8,$8),
                    ($5,$2,$3,$4,2,0,$8,$8),
                    ($6,$2,$3,$7,1,0,$8,$8)`,
            [
              fulfilmentSlotIds[0],
              orderId,
              phaseId,
              orderItemId,
              fulfilmentSlotIds[1],
              fulfilmentSlotIds[2],
              secondOrderItemId,
              now,
            ],
          );
          await client.query(
            `INSERT INTO shipment_plan_fulfilment_slots
               (shipment_plan_id, order_price_binding_id, fulfilment_slot_id)
             VALUES ($1,$2,$3),($1,$2,$4),($1,$2,$5)`,
            [
              shipmentPlanId,
              bindingId,
              fulfilmentSlotIds[0],
              fulfilmentSlotIds[1],
              fulfilmentSlotIds[2],
            ],
          );
          await client.query(
            `INSERT INTO price_snapshot_components
               (id, price_snapshot_id, kind, scope, shipment_plan_id,
                amount_minor, allocation, created_at)
             VALUES ($1,$2,'SHIPMENT','SHIPMENT_PLAN',$3,0,'{}'::jsonb,$4)`,
            [shipmentComponentId, snapshotId, shipmentPlanId, now],
          );
          for (const component of priceComponents) {
            await client.query(
              `INSERT INTO price_component_fulfilment_allocations
                 (price_snapshot_component_id, fulfilment_slot_id, amount_minor)
               VALUES ($1,$2,$3)`,
              [
                component.id,
                component.quoteItemId === quoteItemId
                  ? fulfilmentSlotIds[0]
                  : fulfilmentSlotIds[2],
                component.amountMinor,
              ],
            );
          }
        }
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
      await createQuotedTopology(true);
      await client.query(
        `SET CONSTRAINTS
           "price_snapshots_total_reconciled",
           "price_snapshot_components_total_reconciled",
           "payment_schedules_total_reconciled",
           "quote_price_bindings_snapshot_sealed",
           "order_price_bindings_snapshot_sealed",
           "shipment_plans_price_reconciled" IMMEDIATE`,
      );
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

  it("enforces immutable price-list provenance and deterministic packing-unit identity", async () => {
    await rollback(
      "price-list-and-packing-contract",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "price-list-and-packing-contract",
        );

        await expectQueryError(
          client,
          "price_list_update_is_immutable",
          () =>
            client.query(
              `UPDATE price_lists SET parameters = '{"changed":true}'::jsonb
             WHERE id = (SELECT price_list_id FROM price_snapshots WHERE id = $1)`,
              [foundation.priceSnapshotId],
            ),
          { code: "23514", constraint: "price_lists_immutable" },
        );
        await expectQueryError(
          client,
          "price_snapshot_requires_explicit_price_list",
          () =>
            client.query(
              `INSERT INTO price_snapshots
               (id, currency, contract_total_minor, pricing_revision,
                input_snapshot, snapshot_hash, created_at)
             VALUES ($1,'EUR',0,'unknown-prices-v1','{}'::jsonb,$2,clock_timestamp())`,
              [fixtures.id("missing-price-list-snapshot"), "d".repeat(64)],
            ),
          { code: "23502", column: "price_list_id" },
        );

        const slot = (
          await client.query<{ packing_unit_key: string }>(
            `SELECT packing_unit_key FROM fulfilment_slots WHERE id = $1`,
            [foundation.fulfilmentSlotId],
          )
        ).rows[0];
        expect(slot?.packing_unit_key).toBe(
          `${foundation.orderItemId}:single:1`,
        );

        const splitSnapshotId = fixtures.id("split-capture-snapshot");
        const splitPriceListId = fixtures.id("split-capture-price-list");
        await client.query(
          `INSERT INTO price_lists
           (id, revision, terms_revision, currency, parameters, created_at)
         VALUES ($1,'split-capture-v1','terms-v1','EUR','{}'::jsonb,clock_timestamp())`,
          [splitPriceListId],
        );
        await client.query(
          `INSERT INTO price_snapshots
           (id, price_list_id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,$2,'EUR',100,'split-capture-v1','{}'::jsonb,$3,clock_timestamp())`,
          [
            splitSnapshotId,
            splitPriceListId,
            splitSnapshotId.replaceAll("-", "").repeat(2),
          ],
        );
        await client.query(
          `INSERT INTO price_snapshot_components
           (id, price_snapshot_id, kind, scope, amount_minor, allocation, created_at)
         VALUES ($1,$2,'ORDER_MIN_PRINT','ORDER',100,'{}'::jsonb,clock_timestamp())`,
          [fixtures.id("split-capture-component"), splitSnapshotId],
        );
        await client.query(
          `INSERT INTO payment_schedules
           (id, price_snapshot_id, sequence, role, gross_amount_minor,
            fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
         VALUES ($1,$2,0,'DEPOSIT',40,0,0,'{}'::jsonb,clock_timestamp()),
                ($3,$2,1,'BALANCE',60,0,0,'{}'::jsonb,clock_timestamp())`,
          [
            fixtures.id("split-capture-deposit"),
            splitSnapshotId,
            fixtures.id("split-capture-balance"),
          ],
        );
        await client.query(
          `SET CONSTRAINTS "price_snapshots_total_reconciled",
           "price_snapshot_components_total_reconciled",
           "payment_schedules_total_reconciled" IMMEDIATE`,
        );
        expect(
          (
            await client.query<{
              balance_deadline_valid: boolean;
              generic_valid: boolean;
              split_valid: boolean;
            }>(
              `SELECT taven_payment_schedule_is_valid($1, 100) AS generic_valid,
                      taven_split_payment_schedule_is_valid($1, 100) AS split_valid,
                      taven_price_snapshot_balance_deadline_is_valid($1)
                        AS balance_deadline_valid`,
              [splitSnapshotId],
            )
          ).rows,
        ).toEqual([
          {
            balance_deadline_valid: false,
            generic_valid: true,
            split_valid: true,
          },
        ]);
        await client.query(
          `SET CONSTRAINTS "price_snapshots_total_reconciled",
           "price_snapshot_components_total_reconciled",
           "payment_schedules_total_reconciled" DEFERRED`,
        );

        await expectQueryError(
          client,
          "individual_full_payment_rejected",
          async () => {
            await fixtures.createFoundation(
              "individual-full-payment",
              {},
              undefined,
              undefined,
              undefined,
              1,
              undefined,
              "QUOTED",
              undefined,
              {},
              "INDIVIDUAL",
              true,
              true,
              true,
              "FULL",
            );
            await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          },
          {
            code: "23514",
            constraint: "quote_price_binding_acceptance_check",
          },
        );

        const invalidSnapshotId = fixtures.id("incomplete-capture-snapshot");
        const invalidPriceListId = fixtures.id("incomplete-capture-price-list");
        await client.query(
          `INSERT INTO price_lists
           (id, revision, terms_revision, currency, parameters, created_at)
         VALUES ($1,'split-capture-invalid-v1','terms-v1','EUR','{}'::jsonb,clock_timestamp())`,
          [invalidPriceListId],
        );
        await client.query(
          `INSERT INTO price_snapshots
           (id, price_list_id, currency, contract_total_minor, pricing_revision,
            input_snapshot, snapshot_hash, created_at)
         VALUES ($1,$2,'EUR',100,'split-capture-invalid-v1','{}'::jsonb,$3,clock_timestamp())`,
          [
            invalidSnapshotId,
            invalidPriceListId,
            invalidSnapshotId.replaceAll("-", "").repeat(2),
          ],
        );
        await client.query(
          `INSERT INTO price_snapshot_components
           (id, price_snapshot_id, kind, scope, amount_minor, allocation, created_at)
         VALUES ($1,$2,'ORDER_MIN_PRINT','ORDER',100,'{}'::jsonb,clock_timestamp())`,
          [fixtures.id("incomplete-capture-component"), invalidSnapshotId],
        );
        await client.query(
          `INSERT INTO payment_schedules
           (id, price_snapshot_id, sequence, role, gross_amount_minor,
            fee_rate_basis_points, fee_fixed_minor, provider_config, created_at)
         VALUES ($1,$2,0,'DEPOSIT',100,0,0,'{}'::jsonb,clock_timestamp())`,
          [fixtures.id("incomplete-capture-deposit"), invalidSnapshotId],
        );
        await expectQueryError(
          client,
          "incomplete_split_capture_rejected",
          () =>
            client.query(
              `SET CONSTRAINTS "price_snapshots_total_reconciled" IMMEDIATE`,
            ),
          {
            code: "23514",
            constraint: "price_snapshot_total_reconciliation_check",
          },
        );
        await client.query(
          `SET CONSTRAINTS "price_snapshots_total_reconciled",
           "price_snapshot_components_total_reconciled",
           "payment_schedules_total_reconciled" DEFERRED`,
        );

        expect(
          (
            await client.query<{ indexdef: string }>(
              `SELECT indexdef FROM pg_indexes
               WHERE schemaname = current_schema()
                 AND indexname = 'fulfilment_slots_order_id_packing_unit_key_key'`,
            )
          ).rows,
        ).toEqual([
          {
            indexdef: expect.stringMatching(
              /CREATE UNIQUE INDEX .*order_id.*packing_unit_key/,
            ),
          },
        ]);
      },
    );
  });

  it("binds deposit-plus-balance only for individual quotes and orders", async () => {
    await rollback("split-payment-binding-policy", async (client, fixtures) => {
      const expectEarnedPolicyRejected = async (
        name: string,
        parameters: Record<string, unknown>,
      ) => {
        await expectQueryError(
          client,
          name,
          async () => {
            const revision = `${name}-v1`;
            await client.query(
              `INSERT INTO price_lists
                 (id, revision, terms_revision, currency, parameters, created_at)
               VALUES ($1,$2,'terms-v1','EUR',$3::jsonb,clock_timestamp())`,
              [fixtures.id(`${name}:price-list`), revision, parameters],
            );
            await fixtures.createFoundation(
              name,
              {},
              undefined,
              undefined,
              undefined,
              1,
              undefined,
              "QUOTED",
              undefined,
              { priceListRevision: revision },
              "INDIVIDUAL",
              true,
              true,
              true,
              "DEPOSIT_BALANCE",
            );
          },
          {
            code: "23514",
            constraint: "quote_price_binding_acceptance_check",
          },
        );
      };

      await expectEarnedPolicyRejected("missing_earned_policy", {
        balance_payment_days: 7,
      });
      await expectEarnedPolicyRejected("non_string_earned_policy", {
        balance_payment_days: 7,
        balance_timeout_earned_component_kinds: [null],
      });

      const individual = await fixtures.createFoundation(
        "individual-split-payment",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "QUOTED",
        undefined,
        { orderMinimum: 2000 },
        "INDIVIDUAL",
        true,
        true,
        true,
        "DEPOSIT_BALANCE",
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect(
        (
          await client.query<{
            order_status: string;
            quote_request_status: string;
            schedule_roles: string[];
          }>(
            `SELECT target_order.status::text AS order_status,
                    request.status::text AS quote_request_status,
                    ARRAY(
                      SELECT schedule.role::text
                      FROM payment_schedules schedule
                      WHERE schedule.price_snapshot_id = binding.price_snapshot_id
                      ORDER BY schedule.sequence
                    ) AS schedule_roles
             FROM orders target_order
             JOIN individual_order_origins origin ON origin.order_id = target_order.id
             JOIN quotes quote ON quote.id = origin.quote_id
             JOIN quote_requests request ON request.id = quote.quote_request_id
             JOIN order_price_bindings binding
               ON binding.id = target_order.accepted_order_price_binding_id
             WHERE target_order.id = $1`,
            [individual.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "QUOTED",
          quote_request_status: "ACCEPTED",
          schedule_roles: ["DEPOSIT", "BALANCE"],
        },
      ]);
      await client.query("SET CONSTRAINTS ALL DEFERRED");

      const productions = await createCurrentPlanAndPayment(
        client,
        fixtures,
        individual,
      );
      await activateCurrentPlan(client, fixtures, individual, productions);
      expect(
        (
          await client.query<{
            order_status: string;
            payment_role: string;
            payment_status: string;
            phase_status: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                    phase.status::text AS phase_status,
                    payment.role::text AS payment_role,
                    payment.status::text AS payment_status
             FROM orders target_order
             JOIN order_phases phase ON phase.order_id = target_order.id
             JOIN payments payment ON payment.order_id = target_order.id
             WHERE target_order.id = $1`,
            [individual.orderId],
          )
        ).rows,
      ).toEqual([
        {
          order_status: "CONFIRMED",
          payment_role: "DEPOSIT",
          payment_status: "CAPTURED",
          phase_status: "ACTIVE",
        },
      ]);

      await advanceOrderLifecycleStep(
        client,
        individual.orderId,
        "IN_PRODUCTION",
      );
      const qcPassedAt = new Date();
      await advanceOrderLifecycleStep(
        client,
        individual.orderId,
        "QC_PASSED",
        qcPassedAt,
      );
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
        [individual.orderId, qcPassedAt],
      );

      const balanceDueAt = new Date(
        qcPassedAt.getTime() + 7 * 24 * 60 * 60 * 1_000,
      );
      const createdBalances = (
        await client.query<{
          balance_due_at: Date;
          id: string;
          order_status: string;
          provider_intent_id: string | null;
          status: string;
        }>(
          `SELECT payment.id, payment.status::text,
                  payment.provider_intent_id, payment.balance_due_at,
                  target_order.status::text AS order_status
           FROM payments payment
           JOIN orders target_order ON target_order.id = payment.order_id
           WHERE payment.order_id = $1 AND payment.role = 'BALANCE'`,
          [individual.orderId],
        )
      ).rows;
      expect(createdBalances).toEqual([
        {
          id: expect.any(String),
          status: "CREATED",
          provider_intent_id: null,
          balance_due_at: balanceDueAt,
          order_status: "QC_PASSED",
        },
      ]);
      const balancePaymentId = createdBalances[0]?.id;
      if (!balancePaymentId) {
        throw new Error("QC completion did not create its balance payment");
      }
      await client.query(
        `SET CONSTRAINTS "payments_balance_waiting_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{
            provider_intent_id: string | null;
            status: string;
          }>(
            `SELECT provider_intent_id, status::text
             FROM payments
             WHERE id = $1`,
            [balancePaymentId],
          )
        ).rows,
      ).toEqual([{ provider_intent_id: null, status: "CREATED" }]);
      await client.query(
        `SET CONSTRAINTS "payments_balance_waiting_reconciled" DEFERRED`,
      );

      await client.query(`SAVEPOINT "created_balance_timeout_path"`);
      try {
        await client.query(`SET LOCAL session_replication_role = 'replica'`);
        await client.query(
          `UPDATE payments
           SET balance_due_at = clock_timestamp() - interval '1 second'
           WHERE id = $1`,
          [balancePaymentId],
        );
        await client.query(`SET LOCAL session_replication_role = 'origin'`);

        const closedCreatedBalance = await client.query<{
          payment_id: string;
          settlement_id: string;
        }>(
          `SELECT payment_id, settlement_id
           FROM taven_close_expired_balance_payments(10)`,
        );
        expect(closedCreatedBalance.rows).toEqual([
          {
            payment_id: balancePaymentId,
            settlement_id: expect.any(String),
          },
        ]);
        expect(
          (
            await client.query<{
              order_status: string;
              payment_status: string;
              settlement_count: string;
              void_commands: string;
            }>(
              `SELECT target_order.status::text AS order_status,
                      balance.status::text AS payment_status,
                      (SELECT count(*)::text FROM order_settlements settlement
                       WHERE settlement.order_id = target_order.id
                         AND settlement.kind = 'BALANCE_SETTLEMENT') AS settlement_count,
                      (SELECT count(*)::text FROM outbox_messages message
                       WHERE message.deduplication_key =
                         'void_payment:v1:' || balance.id::text) AS void_commands
               FROM orders target_order
               JOIN payments balance
                 ON balance.order_id = target_order.id AND balance.role = 'BALANCE'
               WHERE target_order.id = $1`,
              [individual.orderId],
            )
          ).rows,
        ).toEqual([
          {
            order_status: "AWAITING_BALANCE",
            payment_status: "VOIDED",
            settlement_count: "1",
            void_commands: "0",
          },
        ]);
        expect(
          (
            await client.query(
              `SELECT payment_id, settlement_id
               FROM taven_close_expired_balance_payments(10)`,
            )
          ).rows,
        ).toEqual([]);
        await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      } finally {
        await client.query(
          `ROLLBACK TO SAVEPOINT "created_balance_timeout_path"`,
        );
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      }

      await client.query(`SAVEPOINT "failed_balance_timeout_path"`);
      try {
        const intentFailureAt = new Date();
        const intentFailureId =
          await fixtures.persistPaymentIntentCreationFailure(
            balancePaymentId,
            intentFailureAt,
            "post-qc-balance-intent-failure",
          );
        await client.query(
          `UPDATE payments
           SET status = 'FAILED', capture_authorized = false,
               capture_cutoff_at = $2,
               intent_creation_failure_result_id = $3,
               updated_at = $2
           WHERE id = $1`,
          [balancePaymentId, intentFailureAt, intentFailureId],
        );
        const retryPaymentId = fixtures.id("post-qc-balance-payment-retry");
        const retryCreatedAt = new Date(intentFailureAt.getTime() + 1);
        await client.query(
          `INSERT INTO payments
             (id, order_id, price_snapshot_id, order_price_binding_id,
              payment_schedule_id, role, provider, requested_amount_minor,
              currency, status, balance_due_at, created_at, updated_at)
           SELECT $1, order_id, price_snapshot_id, order_price_binding_id,
                  payment_schedule_id, role, provider, requested_amount_minor,
                  currency, 'CREATED', balance_due_at, $2, $2
           FROM payments WHERE id = $3`,
          [retryPaymentId, retryCreatedAt, balancePaymentId],
        );
        const retryFailureAt = new Date(retryCreatedAt.getTime() + 1);
        const retryFailureId =
          await fixtures.persistPaymentIntentCreationFailure(
            retryPaymentId,
            retryFailureAt,
            "post-qc-balance-intent-retry-failure",
          );
        await client.query(
          `UPDATE payments
           SET status = 'FAILED', capture_authorized = false,
               capture_cutoff_at = $2,
               intent_creation_failure_result_id = $3,
               updated_at = $2
           WHERE id = $1`,
          [retryPaymentId, retryFailureAt, retryFailureId],
        );
        await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
        await client.query(`SET LOCAL session_replication_role = 'replica'`);
        await client.query(
          `UPDATE payments
           SET balance_due_at = clock_timestamp() - interval '1 second'
           WHERE order_id = $1 AND role = 'BALANCE'`,
          [individual.orderId],
        );
        await client.query(`SET LOCAL session_replication_role = 'origin'`);

        expect(
          (
            await client.query<{
              payment_id: string;
              settlement_id: string;
            }>(
              `SELECT payment_id, settlement_id
               FROM taven_close_expired_balance_payments(10)`,
            )
          ).rows,
        ).toEqual([
          {
            payment_id: retryPaymentId,
            settlement_id: expect.any(String),
          },
        ]);
        expect(
          (
            await client.query<{
              order_status: string;
              payment_status: string;
              settlement_count: string;
              void_commands: string;
            }>(
              `SELECT target_order.status::text AS order_status,
                      balance.status::text AS payment_status,
                      (SELECT count(*)::text FROM order_settlements settlement
                       WHERE settlement.order_id = target_order.id
                         AND settlement.kind = 'BALANCE_SETTLEMENT') AS settlement_count,
                      (SELECT count(*)::text FROM outbox_messages message
                       WHERE message.deduplication_key =
                         'void_payment:v1:' || balance.id::text) AS void_commands
               FROM orders target_order
               JOIN payments balance
                 ON balance.id = $2
               WHERE target_order.id = $1`,
              [individual.orderId, retryPaymentId],
            )
          ).rows,
        ).toEqual([
          {
            order_status: "AWAITING_BALANCE",
            payment_status: "FAILED",
            settlement_count: "1",
            void_commands: "0",
          },
        ]);
        expect(
          (
            await client.query(
              `SELECT payment_id, settlement_id
               FROM taven_close_expired_balance_payments(10)`,
            )
          ).rows,
        ).toEqual([]);
        await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      } finally {
        await client.query(
          `ROLLBACK TO SAVEPOINT "failed_balance_timeout_path"`,
        );
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      }

      await client.query(
        `UPDATE payments
         SET status = 'PENDING', provider_intent_id = $2, updated_at = $3
         WHERE id = $1`,
        [balancePaymentId, `intent-${balancePaymentId}`, qcPassedAt],
      );
      await client.query(
        `UPDATE orders
         SET status = 'AWAITING_BALANCE', updated_at = $2
         WHERE id = $1`,
        [individual.orderId, qcPassedAt],
      );
      await client.query(
        `SET CONSTRAINTS
           "payments_balance_waiting_reconciled",
           "orders_balance_readiness_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{ order_status: string; payment_status: string }>(
            `SELECT target_order.status::text AS order_status,
                    payment.status::text AS payment_status
             FROM orders target_order
             JOIN payments payment ON payment.order_id = target_order.id
             WHERE target_order.id = $1 AND payment.role = 'BALANCE'`,
            [individual.orderId],
          )
        ).rows,
      ).toEqual([
        { order_status: "AWAITING_BALANCE", payment_status: "PENDING" },
      ]);
      await client.query(
        `SET CONSTRAINTS
           "payments_balance_waiting_reconciled",
           "orders_balance_readiness_reconciled" DEFERRED`,
      );

      await client.query(`SAVEPOINT "failed_balance_retry_path"`);
      try {
        const insertBalanceAttempt = async (paymentId: string) => {
          const attemptCreatedAt = new Date();
          await client.query(
            `INSERT INTO payments
               (id, order_id, price_snapshot_id, order_price_binding_id,
                payment_schedule_id, role, provider, requested_amount_minor,
                currency, status, balance_due_at, created_at, updated_at)
             SELECT $1, order_id, price_snapshot_id, order_price_binding_id,
                    payment_schedule_id, role, provider, requested_amount_minor,
                    currency, 'CREATED', balance_due_at, $2, $2
             FROM payments WHERE id = $3`,
            [paymentId, attemptCreatedAt, balancePaymentId],
          );
          return attemptCreatedAt;
        };

        await expectQueryError(
          client,
          "concurrent_balance_attempt",
          () =>
            insertBalanceAttempt(
              fixtures.id("post-qc-concurrent-balance-payment"),
            ),
          {
            code: "23505",
            constraint: "payments_one_active_attempt_per_schedule_key",
          },
        );

        const failedAt = new Date();
        await fixtures.persistPaymentFailureEvent(
          balancePaymentId,
          failedAt,
          "post-qc-provider-declined-balance",
        );
        await client.query(
          `UPDATE payments
           SET status = 'FAILED', capture_authorized = false,
               capture_cutoff_at = $2, updated_at = $2
           WHERE id = $1`,
          [balancePaymentId, failedAt],
        );

        const retryPaymentId = fixtures.id(
          "post-qc-provider-declined-balance-retry",
        );
        const retryCreatedAt = await insertBalanceAttempt(retryPaymentId);
        await client.query(
          `UPDATE payments
           SET status = 'PENDING', provider_intent_id = $2, updated_at = $3
           WHERE id = $1`,
          [retryPaymentId, `intent-${retryPaymentId}`, retryCreatedAt],
        );
        await client.query(
          `SET CONSTRAINTS
             "payment_provider_events_consumed",
             "payments_balance_waiting_reconciled" IMMEDIATE`,
        );
        expect(
          (
            await client.query<{
              active_attempt_count: string;
              failed_status: string;
              order_status: string;
              retry_status: string;
            }>(
              `SELECT target_order.status::text AS order_status,
                      failed.status::text AS failed_status,
                      retry.status::text AS retry_status,
                      (SELECT count(*)::text
                       FROM payments active
                       WHERE active.payment_schedule_id = retry.payment_schedule_id
                         AND active.status IN ('CREATED', 'PENDING', 'CAPTURED'))
                        AS active_attempt_count
               FROM orders target_order
               JOIN payments failed ON failed.id = $2
               JOIN payments retry ON retry.id = $3
               WHERE target_order.id = $1`,
              [individual.orderId, balancePaymentId, retryPaymentId],
            )
          ).rows,
        ).toEqual([
          {
            active_attempt_count: "1",
            failed_status: "FAILED",
            order_status: "AWAITING_BALANCE",
            retry_status: "PENDING",
          },
        ]);
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT "failed_balance_retry_path"`);
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      }

      await client.query(`SAVEPOINT "provider_failed_balance_timeout_path"`);
      try {
        const providerFailedAt = new Date();
        await fixtures.persistPaymentFailureEvent(
          balancePaymentId,
          providerFailedAt,
          "post-qc-provider-failed-before-deadline",
        );
        await client.query(
          `UPDATE payments
           SET status = 'FAILED', capture_authorized = false,
               capture_cutoff_at = $2, updated_at = $2
           WHERE id = $1`,
          [balancePaymentId, providerFailedAt],
        );
        await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
        await client.query(`SET LOCAL session_replication_role = 'replica'`);
        await client.query(
          `UPDATE payments
           SET balance_due_at = clock_timestamp() - interval '1 second'
           WHERE id = $1`,
          [balancePaymentId],
        );
        await client.query(`SET LOCAL session_replication_role = 'origin'`);

        const providerFailedDeadlineRun = await client.query<{
          payment_id: string;
          settlement_id: string;
        }>(
          `SELECT payment_id, settlement_id
           FROM taven_close_expired_balance_payments(10)`,
        );
        expect(providerFailedDeadlineRun.rows).toEqual([
          {
            payment_id: balancePaymentId,
            settlement_id: expect.any(String),
          },
        ]);
        expect(
          (
            await client.query<{
              order_status: string;
              payment_status: string;
              settlement_count: string;
              void_commands: string;
            }>(
              `SELECT target_order.status::text AS order_status,
                      balance.status::text AS payment_status,
                      (SELECT count(*)::text FROM order_settlements settlement
                       WHERE settlement.order_id = target_order.id
                         AND settlement.kind = 'BALANCE_SETTLEMENT') AS settlement_count,
                      (SELECT count(*)::text FROM outbox_messages message
                       WHERE message.deduplication_key =
                         'void_payment:v1:' || balance.id::text) AS void_commands
               FROM orders target_order
               JOIN payments balance ON balance.id = $2
               WHERE target_order.id = $1`,
              [individual.orderId, balancePaymentId],
            )
          ).rows,
        ).toEqual([
          {
            order_status: "AWAITING_BALANCE",
            payment_status: "FAILED",
            settlement_count: "1",
            void_commands: "0",
          },
        ]);
        expect(
          (
            await client.query(
              `SELECT payment_id, settlement_id
               FROM taven_close_expired_balance_payments(10)`,
            )
          ).rows,
        ).toEqual([]);

        const settlementCutoff = (
          await client.query<{ cutoff_at: Date }>(
            `SELECT cutoff_at
             FROM order_settlements
             WHERE order_id = $1 AND kind = 'BALANCE_SETTLEMENT'`,
            [individual.orderId],
          )
        ).rows[0]?.cutoff_at;
        if (!settlementCutoff) {
          throw new Error("provider-failed balance settlement has no cutoff");
        }
        const lateCapturedAt = new Date(settlementCutoff.getTime() + 1);
        const lateCaptureId = `late-provider-failed-${balancePaymentId}`;
        await fixtures.persistPaymentProviderEvent(
          balancePaymentId,
          "PAYMENT_CAPTURED",
          lateCaptureId,
          lateCapturedAt,
        );
        const firstLateRefund = (
          await client.query<{ refund_id: string }>(
            `SELECT taven_record_late_balance_capture($1,$2,$3) AS refund_id`,
            [balancePaymentId, lateCaptureId, lateCapturedAt],
          )
        ).rows[0]?.refund_id;
        const repeatedLateRefund = (
          await client.query<{ refund_id: string }>(
            `SELECT taven_record_late_balance_capture($1,$2,$3) AS refund_id`,
            [balancePaymentId, lateCaptureId, lateCapturedAt],
          )
        ).rows[0]?.refund_id;
        expect(firstLateRefund).toEqual(expect.any(String));
        expect(repeatedLateRefund).toBe(firstLateRefund);
        await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        expect(
          (
            await client.query<{
              late_refunds: string;
              payment_status: string;
            }>(
              `SELECT balance.status::text AS payment_status,
                      (SELECT count(*)::text
                       FROM refund_transactions refund
                       WHERE refund.payment_id = balance.id
                         AND refund.reason = 'LATE_CAPTURE_COMPENSATION')
                        AS late_refunds
               FROM payments balance
               WHERE balance.id = $1`,
              [balancePaymentId],
            )
          ).rows,
        ).toEqual([{ late_refunds: "1", payment_status: "REFUND_PENDING" }]);
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      } finally {
        await client.query(
          `ROLLBACK TO SAVEPOINT "provider_failed_balance_timeout_path"`,
        );
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      }

      await expectQueryError(
        client,
        "split_payment_skips_awaiting_balance",
        async () => {
          await client.query(
            `UPDATE orders
             SET status = 'READY_TO_SHIP', updated_at = clock_timestamp()
             WHERE id = $1`,
            [individual.orderId],
          );
          await client.query(
            `SET CONSTRAINTS "orders_balance_readiness_reconciled" IMMEDIATE`,
          );
        },
        {
          code: "23514",
          constraint: "balance_payment_readiness_check",
        },
      );

      await client.query(`SAVEPOINT "expired_balance_path"`);
      try {
        // Simulate the immutable deadline elapsing without making this test
        // wait seven real days. The topology was fully reconciled above.
        await client.query(`SET LOCAL session_replication_role = 'replica'`);
        await client.query(
          `UPDATE payments
           SET balance_due_at = clock_timestamp() - interval '1 second'
           WHERE id = $1`,
          [balancePaymentId],
        );
        await client.query(`SET LOCAL session_replication_role = 'origin'`);

        const firstDeadlineRun = await client.query<{
          payment_id: string;
          settlement_id: string;
        }>(
          `SELECT payment_id, settlement_id
           FROM taven_close_expired_balance_payments(10)`,
        );
        expect(firstDeadlineRun.rows).toEqual([
          {
            payment_id: balancePaymentId,
            settlement_id: expect.any(String),
          },
        ]);
        expect(
          (
            await client.query<{
              balance_status: string;
              deposit_status: string;
              late_refunds: string;
              order_status: string;
              phase_status: string;
              settlement_count: string;
              settlement_refunds: string;
              void_commands: string;
              settlement_formula_valid: boolean;
            }>(
              `SELECT target_order.status::text AS order_status,
                      phase.status::text AS phase_status,
                      balance.status::text AS balance_status,
                      deposit.status::text AS deposit_status,
                      (SELECT count(*)::text FROM order_settlements settlement
                       WHERE settlement.order_id = target_order.id
                         AND settlement.kind = 'BALANCE_SETTLEMENT') AS settlement_count,
                      (SELECT count(*)::text FROM refund_transactions refund
                       WHERE refund.payment_id = deposit.id
                         AND refund.reason = 'BALANCE_SETTLEMENT') AS settlement_refunds,
                      (SELECT count(*)::text FROM refund_transactions refund
                       WHERE refund.payment_id = balance.id
                         AND refund.reason = 'LATE_CAPTURE_COMPENSATION') AS late_refunds,
                      (SELECT count(*)::text FROM outbox_messages message
                       WHERE message.deduplication_key =
                         'void_payment:v1:' || balance.id::text) AS void_commands,
                      (SELECT settlement.retained_amount_minor = least(
                                  settlement.captured_total_minor,
                                  settlement.earned_amount_minor)
                               AND settlement.refund_amount_minor =
                                  settlement.captured_total_minor - settlement.retained_amount_minor
                               AND settlement.written_off_amount_minor = greatest(
                                  0, settlement.earned_amount_minor - settlement.captured_total_minor)
                               AND settlement.unearned_cancelled_amount_minor =
                                  settlement.contract_total_minor - settlement.earned_amount_minor
                       FROM order_settlements settlement
                       WHERE settlement.order_id = target_order.id
                         AND settlement.kind = 'BALANCE_SETTLEMENT')
                        AS settlement_formula_valid
               FROM orders target_order
               JOIN order_phases phase ON phase.order_id = target_order.id
               JOIN payments balance
                 ON balance.order_id = target_order.id AND balance.role = 'BALANCE'
               JOIN payments deposit
                 ON deposit.order_id = target_order.id AND deposit.role = 'DEPOSIT'
               WHERE target_order.id = $1`,
              [individual.orderId],
            )
          ).rows,
        ).toEqual([
          {
            balance_status: "VOIDED",
            deposit_status: "REFUND_PENDING",
            late_refunds: "0",
            order_status: "AWAITING_BALANCE",
            phase_status: "CANCELLED",
            settlement_count: "1",
            settlement_refunds: "1",
            void_commands: "1",
            settlement_formula_valid: true,
          },
        ]);
        expect(
          (
            await client.query(
              `SELECT payment_id, settlement_id
               FROM taven_close_expired_balance_payments(10)`,
            )
          ).rows,
        ).toEqual([]);
        await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);

        const cutoff = (
          await client.query<{ capture_cutoff_at: Date }>(
            `SELECT capture_cutoff_at FROM payments WHERE id = $1`,
            [balancePaymentId],
          )
        ).rows[0]?.capture_cutoff_at;
        if (!cutoff) {
          throw new Error("expired balance is missing its immutable cutoff");
        }
        const lateCapturedAt = new Date(cutoff.getTime() + 1);
        const lateCaptureId = `late-balance-${balancePaymentId}`;
        await fixtures.persistPaymentProviderEvent(
          balancePaymentId,
          "PAYMENT_CAPTURED",
          lateCaptureId,
          lateCapturedAt,
        );
        const firstLateRefund = (
          await client.query<{ refund_id: string }>(
            `SELECT taven_record_late_balance_capture($1,$2,$3) AS refund_id`,
            [balancePaymentId, lateCaptureId, lateCapturedAt],
          )
        ).rows[0]?.refund_id;
        const repeatedLateRefund = (
          await client.query<{ refund_id: string }>(
            `SELECT taven_record_late_balance_capture($1,$2,$3) AS refund_id`,
            [balancePaymentId, lateCaptureId, lateCapturedAt],
          )
        ).rows[0]?.refund_id;
        expect(repeatedLateRefund).toBe(firstLateRefund);
        await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        expect(
          (
            await client.query<{
              balance_status: string;
              late_refunds: string;
              order_status: string;
              settlement_count: string;
            }>(
              `SELECT target_order.status::text AS order_status,
                      balance.status::text AS balance_status,
                      (SELECT count(*)::text FROM order_settlements settlement
                       WHERE settlement.order_id = target_order.id) AS settlement_count,
                      (SELECT count(*)::text FROM refund_transactions refund
                       WHERE refund.payment_id = balance.id
                         AND refund.reason = 'LATE_CAPTURE_COMPENSATION') AS late_refunds
               FROM orders target_order
               JOIN payments balance
                 ON balance.order_id = target_order.id AND balance.role = 'BALANCE'
               WHERE target_order.id = $1`,
              [individual.orderId],
            )
          ).rows,
        ).toEqual([
          {
            balance_status: "REFUND_PENDING",
            late_refunds: "1",
            order_status: "AWAITING_BALANCE",
            settlement_count: "1",
          },
        ]);

        const balanceSettlementRefund = (
          await client.query<{ id: string }>(
            `SELECT refund.id
             FROM refund_transactions refund
             JOIN payments deposit ON deposit.id = refund.payment_id
             WHERE deposit.order_id = $1
               AND refund.reason = 'BALANCE_SETTLEMENT'`,
            [individual.orderId],
          )
        ).rows[0]?.id;
        if (!balanceSettlementRefund) {
          throw new Error("expired balance is missing its settlement refund");
        }
        const normalRefundAt = new Date(lateCapturedAt.getTime() + 1);
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
        await fixtures.persistRefundProviderEvent(
          balanceSettlementRefund,
          "REFUND_SUCCEEDED",
          `balance-settlement-${balancePaymentId}`,
          normalRefundAt,
        );
        await client.query(
          `UPDATE refund_transactions
           SET status = 'SUCCEEDED', provider_refund_id = $2,
               completed_at = $3, updated_at = $3
           WHERE id = $1`,
          [
            balanceSettlementRefund,
            `balance-settlement-${balancePaymentId}`,
            normalRefundAt,
          ],
        );
        await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        expect(
          (
            await client.query<{
              deposit_status: string;
              order_status: string;
              phase_status: string;
            }>(
              `SELECT target_order.status::text AS order_status,
                      phase.status::text AS phase_status,
                      deposit.status::text AS deposit_status
               FROM orders target_order
               JOIN order_phases phase ON phase.order_id = target_order.id
               JOIN payments deposit
                 ON deposit.order_id = target_order.id AND deposit.role = 'DEPOSIT'
               WHERE target_order.id = $1`,
              [individual.orderId],
            )
          ).rows,
        ).toEqual([
          {
            deposit_status: "PARTIALLY_REFUNDED",
            order_status: "CANCELLED_SETTLED",
            phase_status: "CANCELLED_SETTLED",
          },
        ]);
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT "expired_balance_path"`);
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
      }

      const readyAt = new Date(qcPassedAt.getTime() + 1_000);
      await advanceOrderLifecycleStep(
        client,
        individual.orderId,
        "READY_TO_SHIP",
        readyAt,
      );
      const balanceCaptureId = `capture-${balancePaymentId}`;
      await fixtures.persistPaymentProviderEvent(
        balancePaymentId,
        "PAYMENT_CAPTURED",
        balanceCaptureId,
        readyAt,
      );
      await client.query(
        `UPDATE payments
         SET status = 'CAPTURED',
             captured_amount_minor = requested_amount_minor,
             provider_capture_id = $2, captured_at = $3, updated_at = $3
         WHERE id = $1`,
        [balancePaymentId, balanceCaptureId, readyAt],
      );
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_capture_activation_reconciled",
           "payments_balance_readiness_reconciled",
           "orders_balance_readiness_reconciled" IMMEDIATE`,
      );
      expect(
        (
          await client.query<{
            balance_due_at: Date;
            order_status: string;
            payment_statuses: string[];
            phase_status: string;
          }>(
            `SELECT target_order.status::text AS order_status,
                    phase.status::text AS phase_status,
                    max(payment.balance_due_at) AS balance_due_at,
                    array_agg(payment.role::text || ':' || payment.status::text
                              ORDER BY payment.role::text) AS payment_statuses
             FROM orders target_order
             JOIN order_phases phase ON phase.order_id = target_order.id
             JOIN payments payment ON payment.order_id = target_order.id
             WHERE target_order.id = $1
             GROUP BY target_order.status, phase.status`,
            [individual.orderId],
          )
        ).rows,
      ).toEqual([
        {
          balance_due_at: balanceDueAt,
          order_status: "READY_TO_SHIP",
          payment_statuses: ["BALANCE:CAPTURED", "DEPOSIT:CAPTURED"],
          phase_status: "QC_PASSED",
        },
      ]);
      await client.query(
        `SET CONSTRAINTS
           "payment_provider_events_consumed",
           "payments_capture_activation_reconciled",
           "payments_balance_readiness_reconciled",
           "orders_balance_readiness_reconciled" DEFERRED`,
      );

      const expiringDeposit = await fixtures.createFoundation(
        "expiring-individual-deposit",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "QUOTED",
        undefined,
        {},
        "INDIVIDUAL",
        true,
        true,
        true,
        "DEPOSIT_BALANCE",
      );
      await expectQueryError(
        client,
        "expired_individual_deposit_rejected",
        () =>
          fixtures.finalizePayment(
            expiringDeposit,
            new Date(Date.now() - 1_000),
          ),
        { code: "23514", constraint: "payment_capture_window_check" },
      );

      const unclosedDeposit = await fixtures.createFoundation(
        "unclosed-individual-deposit",
        {},
        undefined,
        undefined,
        undefined,
        1,
        undefined,
        "QUOTED",
        undefined,
        {},
        "INDIVIDUAL",
        true,
        true,
        true,
        "DEPOSIT_BALANCE",
      );
      await createCurrentPlan(client, fixtures, unclosedDeposit);
      await fixtures.finalizePayment(unclosedDeposit);
      await expectQueryError(
        client,
        "deposit_void_without_order_closure",
        async () => {
          await client.query(
            `UPDATE payments
             SET status = 'VOIDED', capture_authorized = false,
                 capture_cutoff_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [unclosedDeposit.paymentId],
          );
          await client.query(
            `SET CONSTRAINTS
               "payments_quoted_void_closure_reconciled" IMMEDIATE`,
          );
        },
        { code: "23514", constraint: "quoted_payment_void_closure_check" },
      );

      await expectQueryError(
        client,
        "automatic_split_payment_rejected",
        async () => {
          await fixtures.createFoundation(
            "automatic-split-payment",
            {},
            undefined,
            undefined,
            undefined,
            1,
            undefined,
            "QUOTED",
            undefined,
            {},
            "AUTOMATIC",
            true,
            true,
            true,
            "DEPOSIT_BALANCE",
          );
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        },
        {
          code: "23514",
          constraint: "price_snapshot_total_reconciliation_check",
        },
      );
    });
  });
});
