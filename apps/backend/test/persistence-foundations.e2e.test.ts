import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  PersistenceFactory,
  testTimes,
  type PersistenceFoundation,
  type ProductionReservationFixture,
  type SourceRetention,
} from "./support/persistence-factory";

const databaseUrl = process.env.DATABASE_URL;
const testScope = `persistence-foundations-${randomUUID()}`;
let pool: Pool;

function factory(client: PoolClient, name: string): PersistenceFactory {
  return new PersistenceFactory(client, `${testScope}:${name}`);
}

function checkoutReservationTiming(): { createdAt: Date; expiresAt: Date } {
  const createdAt = new Date();
  return {
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1_000),
  };
}

async function inRollbackTransaction<T>(
  name: string,
  work: (client: PoolClient, fixtures: PersistenceFactory) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    return await work(client, factory(client, name));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function createCompleteSingleReservationGraph(
  client: PoolClient,
  fixtures: PersistenceFactory,
  name: string,
  interval: { startsAt: Date; endsAt: Date },
  resourceSnapshot: unknown = {},
  sourceRetention: SourceRetention = {},
): Promise<{
  foundation: PersistenceFoundation;
  production: ProductionReservationFixture;
}> {
  const reservationTiming = checkoutReservationTiming();
  const { foundation, productions } = await fixtures.createReservationGraph(
    name,
    [interval],
    resourceSnapshot,
    sourceRetention,
    reservationTiming,
  );
  const production = productions[0];
  if (!production) {
    throw new Error("reservation graph did not create a production fixture");
  }
  await client.query(
    'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      production.inventoryReservationId,
      foundation.nodeId,
      production.productionReservationId,
      foundation.inventoryId,
      60,
      reservationTiming.expiresAt,
      reservationTiming.createdAt,
      reservationTiming.createdAt,
    ],
  );
  await client.query(
    'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [
      fixtures.id(`${name}:capacity-reservation`),
      foundation.nodeId,
      production.productionReservationId,
      production.candidateCapacityIntervalId,
      foundation.machineId,
      interval.startsAt,
      interval.endsAt,
      reservationTiming.expiresAt,
      reservationTiming.createdAt,
      reservationTiming.createdAt,
    ],
  );
  return { foundation, production };
}

async function activateReservationGraph(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
  productions: ProductionReservationFixture[],
): Promise<void> {
  for (const production of productions) {
    await client.query(
      'UPDATE "inventory_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
      [production.productionReservationId, "HELD"],
    );
    await client.query(
      'UPDATE "capacity_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
      [production.productionReservationId, "HELD"],
    );
    await fixtures.createJob(foundation, production);
    await client.query(
      'UPDATE "production_reservations" SET "status" = $2, "job_id" = $3 WHERE "id" = $1',
      [production.productionReservationId, "HELD", production.jobId],
    );
  }
  await client.query(
    'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
    [foundation.phaseReservationSetId, "HELD"],
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

async function advanceReservationOrderToProduction(
  client: PoolClient,
  foundation: PersistenceFoundation,
): Promise<void> {
  const printingAt = new Date();
  await client.query(
    `UPDATE jobs
     SET status = 'ACCEPTED', accepted_at = $2,
         payout_amount = 0, payout_currency = 'EUR', updated_at = $2
     WHERE order_id = $1
       AND EXISTS (
           SELECT 1
           FROM production_reservations production
           WHERE production.job_id = jobs.id
             AND production.node_id = jobs.node_id
             AND production.phase_resource_plan_job_id = jobs.phase_resource_plan_job_id
             AND production.status = 'PRINTING'
       )`,
    [foundation.orderId, printingAt],
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
       AND production.phase_resource_plan_job_id = job.phase_resource_plan_job_id
       AND production.status = 'PRINTING'`,
    [foundation.orderId, printingAt],
  );
  await client.query(
    `UPDATE jobs
     SET status = 'PRINTING', printing_at = $2, updated_at = $2
     WHERE order_id = $1
       AND EXISTS (
           SELECT 1
           FROM production_reservations production
           WHERE production.job_id = jobs.id
             AND production.node_id = jobs.node_id
             AND production.phase_resource_plan_job_id = jobs.phase_resource_plan_job_id
             AND production.status = 'PRINTING'
       )`,
    [foundation.orderId, printingAt],
  );
  await client.query(
    `UPDATE order_phases
     SET status = 'IN_PRODUCTION', updated_at = $2
     WHERE id = $1`,
    [foundation.orderPhaseId, printingAt],
  );
  await client.query(
    `UPDATE orders SET status = 'IN_PRODUCTION', updated_at = $2 WHERE id = $1`,
    [foundation.orderId, printingAt],
  );
  await client.query(
    `SET CONSTRAINTS
       "orders_post_confirmation_lifecycle_reconciled",
       "orders_production_resource_start_reconciled",
       "order_phases_parent_lifecycle_reconciled",
       "jobs_parent_lifecycle_reconciled",
       "jobs_printing_reservation_group_reconciled",
       "production_reservations_job_printing_reconciled",
       "inventory_reservations_job_printing_reconciled",
       "capacity_reservations_job_printing_reconciled" IMMEDIATE`,
  );
  await client.query(`SET CONSTRAINTS ALL DEFERRED`);
}

async function cancelConfirmedReservationOrder(
  client: PoolClient,
  foundation: PersistenceFoundation,
): Promise<void> {
  const cancelledAt = new Date();
  await client.query(
    `UPDATE jobs
     SET status = 'CANCELLED', cancelled_at = $2,
         cancellation_reason = 'ORDER_CANCELLED', updated_at = $2
     WHERE order_id = $1`,
    [foundation.orderId, cancelledAt],
  );
  await client.query(
    `INSERT INTO refund_transactions
       (id, payment_id, idempotency_key, amount_minor, reason, status,
        requested_at, created_at, updated_at)
     SELECT $2, payment.id, $3, payment.captured_amount_minor,
            'CUSTOMER_CANCELLATION', 'PENDING', $4, $4, $4
     FROM payments payment
     WHERE payment.order_id = $1
       AND payment.captured_amount_minor IS NOT NULL`,
    [
      foundation.orderId,
      randomUUID(),
      `test-cancellation:${randomUUID()}`,
      cancelledAt,
    ],
  );
  await client.query(
    `UPDATE payments
     SET status = 'REFUND_PENDING', updated_at = $2
     WHERE order_id = $1 AND captured_amount_minor IS NOT NULL`,
    [foundation.orderId, cancelledAt],
  );
  await client.query(
    `UPDATE shipments
     SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2
     WHERE order_id = $1`,
    [foundation.orderId, cancelledAt],
  );
  await client.query(
    `UPDATE fulfilment_slots
     SET outcome = 'CANCELLED', updated_at = $2
     WHERE order_id = $1 AND outcome = 'PENDING'`,
    [foundation.orderId, cancelledAt],
  );
  await client.query(
    `UPDATE order_phases
     SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2
     WHERE id = $1`,
    [foundation.orderPhaseId, cancelledAt],
  );
  await client.query(
    `UPDATE orders SET status = 'CANCELLED', updated_at = $2 WHERE id = $1`,
    [foundation.orderId, cancelledAt],
  );
}

async function createReferenceSlice(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
  referenceProfileId: string,
  name: string,
  slicerIdentity: { engine: string; version: string } = {
    engine: "orca",
    version: "test",
  },
): Promise<void> {
  await client.query(
    'INSERT INTO "slice_results" ("id", "kind", "cache_key", "model_geometry_id", "print_config_revision_id", "reference_profile_id", "parts_per_plate", "artifact_object_key", "artifact_hash", "estimated_print_seconds", "estimated_material_milligrams", "slicer_engine", "slicer_version") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
    [
      fixtures.id(`${name}:slice`),
      "REFERENCE",
      `reference-${fixtures.id(`${name}:cache-key`)}`,
      foundation.modelGeometryId,
      foundation.printConfigRevisionId,
      referenceProfileId,
      1,
      `slices/${fixtures.id(`${name}:artifact-key`)}`,
      "9".repeat(64),
      60,
      60,
      slicerIdentity.engine,
      slicerIdentity.version,
    ],
  );
}

async function createProductionSlice(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
  name: string,
  options: {
    slicerEngine?: string;
    slicerVersion?: string;
    printConfigRevisionId?: string;
  } = {},
): Promise<void> {
  await client.query(
    'INSERT INTO "slice_results" ("id", "kind", "cache_key", "model_geometry_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id", "parts_per_plate", "artifact_object_key", "artifact_hash", "estimated_print_seconds", "estimated_material_milligrams", "slicer_engine", "slicer_version") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
    [
      fixtures.id(`${name}:slice`),
      "PRODUCTION",
      `production-${fixtures.id(`${name}:cache-key`)}`,
      foundation.modelGeometryId,
      options.printConfigRevisionId ?? foundation.printConfigRevisionId,
      foundation.machineProfileId,
      foundation.machineCalibrationId,
      1,
      `slices/${fixtures.id(`${name}:artifact-key`)}`,
      "8".repeat(64),
      60,
      60,
      options.slicerEngine ?? "orca",
      options.slicerVersion ?? "test",
    ],
  );
}

async function createSiblingMachineFoundation(
  client: PoolClient,
  fixtures: PersistenceFactory,
  foundation: PersistenceFoundation,
  name: string,
  sourceRetention: SourceRetention = {},
): Promise<PersistenceFoundation> {
  const machineId = fixtures.id(`${name}:machine`);
  const inventoryId = fixtures.id(`${name}:inventory`);
  const calibrationId = fixtures.id(`${name}:calibration`);
  const modelFileId = fixtures.id(`${name}:model-file`);
  const geometryId = fixtures.id(`${name}:geometry`);
  const sliceResultId = fixtures.id(`${name}:slice-result`);
  const referenceSliceResultId = fixtures.id(`${name}:reference-slice-result`);
  const printConfigRevisionId =
    foundation.fulfilmentSlotPrintConfigRevisionIds[1] ??
    foundation.printConfigRevisionId;
  const capability = await client.query<{ machine_capability_id: string }>(
    'SELECT "machine_capability_id" FROM "machines" WHERE "id" = $1',
    [foundation.machineId],
  );
  const capabilityId = capability.rows[0]?.machine_capability_id;
  if (!capabilityId) {
    throw new Error("foundation machine capability is missing");
  }
  const plannedItem = await client.query<{ color: string | null }>(
    'SELECT "color" FROM "order_items" WHERE "id" = $1',
    [foundation.orderItemIds[1] ?? foundation.orderItemId],
  );
  if (!plannedItem.rows[0]) {
    throw new Error("foundation planned order item is missing");
  }

  await client.query(
    'INSERT INTO "machines" ("id", "node_id", "machine_capability_id", "code", "display_name", "installed_nozzle_micrometers", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      machineId,
      foundation.nodeId,
      capabilityId,
      `sibling-${machineId.slice(0, 24)}`,
      "Sibling test machine",
      400,
      testTimes.createdAt,
      testTimes.createdAt,
    ],
  );
  await client.query(
    'INSERT INTO "inventories" ("id", "node_id", "machine_id", "sku", "material", "color", "vendor", "price_minor_units_numerator", "price_minor_units_denominator", "currency", "remaining_milligrams", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
    [
      inventoryId,
      foundation.nodeId,
      machineId,
      `sibling-${inventoryId.slice(0, 24)}`,
      "PLA",
      plannedItem.rows[0].color,
      "Test vendor",
      1,
      1,
      "EUR",
      100,
      testTimes.createdAt,
      testTimes.createdAt,
    ],
  );
  await client.query(
    'INSERT INTO "model_files" ("id", "format", "original_filename", "storage_object_key", "content_hash", "size_bytes", "uploaded_at", "source_delete_after", "retention_hold") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [
      modelFileId,
      "STL",
      `${name}.stl`,
      `models/${modelFileId}.stl`,
      "4".repeat(64),
      1,
      sourceRetention.uploadedAt ?? testTimes.createdAt,
      sourceRetention.deleteAfter ?? testTimes.expiresAt,
      sourceRetention.hold ?? "NONE",
    ],
  );
  await client.query(
    'INSERT INTO "model_geometries" ("id", "source_model_file_id", "canonical_object_key", "geometry_hash", "canonicalizer_revision", "volume_cubic_micrometers", "bounds_x_micrometers", "bounds_y_micrometers", "bounds_z_micrometers", "triangle_count") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [
      geometryId,
      modelFileId,
      `canonical/${geometryId}`,
      "3".repeat(64),
      "test",
      1,
      1,
      1,
      1,
      1,
    ],
  );
  await fixtures.createRevisionIdentity(calibrationId, "MACHINE_CALIBRATION");
  await client.query(
    'INSERT INTO "machine_calibrations" ("id", "node_id", "machine_id", "flow_ratio_parts_per_million", "xy_compensation_micrometers", "elephant_foot_compensation_micrometers", "settings", "state", "activated_at") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)',
    [
      calibrationId,
      foundation.nodeId,
      machineId,
      1_000_000,
      0,
      0,
      JSON.stringify({}),
      "ACTIVE",
      testTimes.createdAt,
    ],
  );
  await client.query(
    `INSERT INTO slice_results
       (id, kind, cache_key, model_geometry_id, print_config_revision_id,
        reference_profile_id, parts_per_plate, artifact_object_key,
        artifact_hash, estimated_print_seconds,
        estimated_material_milligrams, slicer_engine, slicer_version)
     SELECT $1, 'REFERENCE', $2, $3, $4, source.reference_profile_id,
            source.parts_per_plate, $5, source.artifact_hash,
            source.estimated_print_seconds,
            source.estimated_material_milligrams,
            source.slicer_engine, source.slicer_version
     FROM slice_results source WHERE source.id = $6`,
    [
      referenceSliceResultId,
      `sibling-reference-${fixtures.id(`${name}:cache-key`)}`,
      geometryId,
      printConfigRevisionId,
      `reference-slices/${fixtures.id(`${name}:artifact-key`)}`,
      foundation.referenceSliceResultId,
    ],
  );
  await client.query(
    'INSERT INTO "slice_results" ("id", "kind", "cache_key", "model_geometry_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id", "parts_per_plate", "artifact_object_key", "artifact_hash", "estimated_print_seconds", "estimated_material_milligrams", "slicer_engine", "slicer_version") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
    [
      sliceResultId,
      "PRODUCTION",
      `sibling-${fixtures.id(`${name}:cache-key`)}`,
      geometryId,
      printConfigRevisionId,
      foundation.machineProfileId,
      calibrationId,
      1,
      `slices/${fixtures.id(`${name}:artifact-key`)}`,
      "6".repeat(64),
      60,
      60,
      "orca",
      "test",
    ],
  );

  return {
    ...foundation,
    machineId,
    inventoryId,
    modelFileId,
    modelGeometryId: geometryId,
    modelGeometryIds: foundation.modelGeometryIds.map(() => geometryId),
    machineCalibrationId: calibrationId,
    printConfigRevisionId,
    printConfigRevisionIds: foundation.printConfigRevisionIds.map(
      () => printConfigRevisionId,
    ),
    sliceResultId,
    sliceResultIds: foundation.sliceResultIds.map(() => sliceResultId),
    referenceSliceResultId,
    referenceSliceResultIds: foundation.referenceSliceResultIds.map(
      () => referenceSliceResultId,
    ),
    fulfilmentSlotModelGeometryIds:
      foundation.fulfilmentSlotModelGeometryIds.map(() => geometryId),
    fulfilmentSlotSliceResultIds: foundation.fulfilmentSlotSliceResultIds.map(
      () => sliceResultId,
    ),
    fulfilmentSlotPrintConfigRevisionIds:
      foundation.fulfilmentSlotPrintConfigRevisionIds.map(
        () => printConfigRevisionId,
      ),
  };
}

describe("persistence foundations", () => {
  beforeAll(() => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for persistence E2E tests");
    }
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("has every resource-foundation table after migration", async () => {
    const result = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
      [
        [
          "revision_identities",
          "model_files",
          "model_geometries",
          "preflight_findings",
          "photo_assets",
          "print_config_revisions",
          "reference_profiles",
          "machine_capabilities",
          "machine_profiles",
          "nodes",
          "machines",
          "machine_calibrations",
          "inventories",
          "slice_results",
          "candidate_resource_estimates",
          "candidate_capacity_intervals",
          "eligibility_snapshots",
          "phase_resource_plans",
          "phase_resource_plan_jobs",
          "phase_resource_plan_slots",
          "phase_reservation_sets",
          "production_reservations",
          "inventory_reservations",
          "capacity_reservations",
          "outbox_messages",
          "idempotency_records",
        ],
      ],
    );

    expect(new Set(result.rows.map((row) => row.tablename))).toEqual(
      new Set([
        "revision_identities",
        "model_files",
        "model_geometries",
        "preflight_findings",
        "photo_assets",
        "print_config_revisions",
        "reference_profiles",
        "machine_capabilities",
        "machine_profiles",
        "nodes",
        "machines",
        "machine_calibrations",
        "inventories",
        "slice_results",
        "candidate_resource_estimates",
        "candidate_capacity_intervals",
        "eligibility_snapshots",
        "phase_resource_plans",
        "phase_resource_plan_jobs",
        "phase_resource_plan_slots",
        "phase_reservation_sets",
        "production_reservations",
        "inventory_reservations",
        "capacity_reservations",
        "outbox_messages",
        "idempotency_records",
      ]),
    );
  });

  it("creates an active, immutable node-scoped resource foundation", async () => {
    await inRollbackTransaction(
      "active-foundation",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation("active-foundation");
        const machine = await client.query<{
          installed_nozzle_micrometers: number;
          build_volume_x_micrometers: string;
          build_volume_y_micrometers: string;
          build_volume_z_micrometers: string;
        }>(
          `SELECT machine.installed_nozzle_micrometers,
                capability.build_volume_x_micrometers,
                capability.build_volume_y_micrometers,
                capability.build_volume_z_micrometers
         FROM machines machine
         JOIN machine_capabilities capability ON capability.id = machine.machine_capability_id
         WHERE machine.id = $1`,
          [foundation.machineId],
        );
        expect(machine.rows).toEqual([
          {
            installed_nozzle_micrometers: 400,
            build_volume_x_micrometers: "200000",
            build_volume_y_micrometers: "200000",
            build_volume_z_micrometers: "200000",
          },
        ]);
        const revisions = await client.query<{ state: string }>(
          `SELECT state::text
         FROM reference_profiles
         WHERE id IN (
           SELECT reference_profile_id FROM machine_profiles WHERE id = $1
         )`,
          [foundation.machineProfileId],
        );
        expect(revisions.rows).toEqual([{ state: "ACTIVE" }]);
        await expect(
          client.query(
            `UPDATE print_config_revisions SET infill_percent = 21 WHERE id = $1`,
            [foundation.printConfigRevisionId],
          ),
        ).rejects.toMatchObject({ code: "55000" });
      },
    );
  });

  it("requires eligibility snapshot arrays to be canonical UUID sets", async () => {
    const insertSnapshot = async (
      client: PoolClient,
      fixtures: PersistenceFactory,
      name: string,
      requiredSlotIds: unknown[],
      eligibleCandidateIds: unknown[],
    ) => {
      const foundation = await fixtures.createFoundation();
      await client.query(
        'INSERT INTO "eligibility_snapshots" ("id", "node_id", "order_phase_id", "required_fulfilment_slot_ids", "eligible_candidate_estimate_ids", "snapshot_hash", "calculated_at", "expires_at") VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)',
        [
          fixtures.id(`${name}:snapshot`),
          foundation.nodeId,
          foundation.orderPhaseId,
          JSON.stringify(requiredSlotIds),
          JSON.stringify(eligibleCandidateIds),
          "f".repeat(64),
          testTimes.createdAt,
          testTimes.expiresAt,
        ],
      );
    };

    await inRollbackTransaction(
      "eligibility-uuid-set-control",
      async (client, fixtures) => {
        await expect(
          insertSnapshot(
            client,
            fixtures,
            "control",
            [fixtures.id("slot-one"), fixtures.id("slot-two")],
            [fixtures.id("candidate-one"), fixtures.id("candidate-two")],
          ),
        ).resolves.toBeUndefined();
      },
    );

    for (const testCase of [
      {
        name: "duplicate-required-slots",
        requiredSlotIds: ["slot", "slot"] as const,
        eligibleCandidateIds: ["candidate"] as const,
        constraint: "eligibility_snapshots_required_slots_uuid_set_check",
      },
      {
        name: "duplicate-eligible-candidates",
        requiredSlotIds: ["slot"] as const,
        eligibleCandidateIds: ["candidate", "candidate"] as const,
        constraint: "eligibility_snapshots_eligible_candidates_uuid_set_check",
      },
      {
        name: "non-string-required-slot",
        requiredSlotIds: [42] as const,
        eligibleCandidateIds: ["candidate"] as const,
        constraint: "eligibility_snapshots_required_slots_uuid_set_check",
      },
      {
        name: "noncanonical-eligible-candidate",
        requiredSlotIds: ["slot"] as const,
        eligibleCandidateIds: ["candidate"] as const,
        uppercaseEligibleCandidate: true,
        constraint: "eligibility_snapshots_eligible_candidates_uuid_set_check",
      },
    ] as const) {
      await inRollbackTransaction(testCase.name, async (client, fixtures) => {
        const requiredSlotIds = testCase.requiredSlotIds.map((value) =>
          value === "slot" ? fixtures.id("slot") : value,
        );
        const eligibleCandidateIds = testCase.eligibleCandidateIds.map(
          (value) => (value === "candidate" ? fixtures.id("candidate") : value),
        );
        if ("uppercaseEligibleCandidate" in testCase) {
          eligibleCandidateIds[0] = String(
            eligibleCandidateIds[0],
          ).toUpperCase();
        }

        await expect(
          insertSnapshot(
            client,
            fixtures,
            testCase.name,
            requiredSlotIds,
            eligibleCandidateIds,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: testCase.constraint,
        });
      });
    }
  });

  it("enforces asset deadline checks and geometry source lineage", async () => {
    await inRollbackTransaction(
      "model-file-deadline",
      async (client, fixtures) => {
        await expect(
          client.query(
            'INSERT INTO "model_files" ("id", "format", "original_filename", "storage_object_key", "content_hash", "size_bytes", "uploaded_at", "source_delete_after") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              fixtures.id("file"),
              "STL",
              "late.stl",
              `models/${fixtures.id("file")}`,
              "b".repeat(64),
              1,
              testTimes.createdAt,
              testTimes.beforeCreatedAt,
            ],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      },
    );
    await inRollbackTransaction("photo-deadline", async (client, fixtures) => {
      await expect(
        client.query(
          'INSERT INTO "photo_assets" ("id", "kind", "scope_kind", "scope_id", "storage_object_key", "content_hash", "media_type", "size_bytes", "uploaded_at", "photo_delete_after") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            fixtures.id("photo"),
            "QC",
            "JOB",
            fixtures.id("future-job"),
            `photos/${fixtures.id("photo")}`,
            "c".repeat(64),
            "image/png",
            1,
            testTimes.createdAt,
            testTimes.beforeCreatedAt,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
    await inRollbackTransaction(
      "early-source-deletion",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        await expect(
          client.query(
            'UPDATE "model_files" SET "deleted_at" = "source_delete_after" WHERE "id" = $1',
            [foundation.modelFileId],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "asset_deletion_eligibility_check",
        });
      },
    );
    await inRollbackTransaction(
      "held-source-deletion",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation("held-source", {
          uploadedAt: new Date(Date.now() - 120_000),
          deleteAfter: new Date(Date.now() - 60_000),
          hold: "ACTIVE_ORDER",
        });
        await expect(
          client.query(
            'UPDATE "model_files" SET "deleted_at" = clock_timestamp() WHERE "id" = $1',
            [foundation.modelFileId],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "asset_deletion_eligibility_check",
        });
      },
    );
    await inRollbackTransaction(
      "geometry-lineage",
      async (client, fixtures) => {
        await expect(
          client.query(
            'INSERT INTO "model_geometries" ("id", "source_model_file_id", "canonical_object_key", "geometry_hash", "canonicalizer_revision", "volume_cubic_micrometers", "bounds_x_micrometers", "bounds_y_micrometers", "bounds_z_micrometers", "triangle_count") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [
              fixtures.id("geometry"),
              fixtures.id("missing-file"),
              `canonical/${fixtures.id("geometry")}`,
              "d".repeat(64),
              "test",
              1,
              1,
              1,
              1,
              1,
            ],
          ),
        ).rejects.toMatchObject({ code: "23503" });
      },
    );
  });

  it("deduplicates preflight findings at their file or geometry scope", async () => {
    const insertFinding = (
      client: PoolClient,
      fixtures: PersistenceFactory,
      foundation: PersistenceFoundation,
      name: string,
      geometryId: string | null,
    ) =>
      client.query(
        'INSERT INTO "preflight_findings" ("id", "model_file_id", "model_geometry_id", "inspection_revision", "code", "severity", "message") VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [
          fixtures.id(`${name}:finding`),
          foundation.modelFileId,
          geometryId,
          "inspection-v1",
          "thin-wall",
          "WARNING",
          "Thin wall detected",
        ],
      );

    await inRollbackTransaction(
      "preflight-geometry-scope",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const secondGeometryId = fixtures.id("second-geometry");
        await client.query(
          'INSERT INTO "model_geometries" ("id", "source_model_file_id", "canonical_object_key", "geometry_hash", "canonicalizer_revision", "volume_cubic_micrometers", "bounds_x_micrometers", "bounds_y_micrometers", "bounds_z_micrometers", "triangle_count") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            secondGeometryId,
            foundation.modelFileId,
            `canonical/${secondGeometryId}`,
            "5".repeat(64),
            "test",
            1,
            1,
            1,
            1,
            1,
          ],
        );

        await insertFinding(
          client,
          fixtures,
          foundation,
          "first-geometry",
          foundation.modelGeometryId,
        );
        await expect(
          insertFinding(
            client,
            fixtures,
            foundation,
            "second-geometry",
            secondGeometryId,
          ),
        ).resolves.toBeDefined();
        await expect(
          insertFinding(
            client,
            fixtures,
            foundation,
            "duplicate-first-geometry",
            foundation.modelGeometryId,
          ),
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "preflight_findings_geometry_scope_key",
        });
      },
    );

    await inRollbackTransaction(
      "preflight-file-scope",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        await insertFinding(client, fixtures, foundation, "file", null);
        await expect(
          insertFinding(
            client,
            fixtures,
            foundation,
            "geometry",
            foundation.modelGeometryId,
          ),
        ).resolves.toBeDefined();
        await expect(
          insertFinding(client, fixtures, foundation, "duplicate-file", null),
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "preflight_findings_file_scope_key",
        });
      },
    );
  });

  it("keeps delivered outbox messages terminal", async () => {
    const createDeliveredMessage = async (
      client: PoolClient,
      fixtures: PersistenceFactory,
      name: string,
    ) => {
      const messageId = fixtures.id(`${name}:message`);
      const deliveredAt = new Date(testTimes.createdAt.getTime() + 1_000);
      await client.query(
        'INSERT INTO "outbox_messages" ("id", "deduplication_key", "aggregate_type", "aggregate_id", "message_type", "schema_version", "payload", "available_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)',
        [
          messageId,
          `outbox-${messageId}`,
          "Order",
          fixtures.id(`${name}:aggregate`),
          "order.accepted",
          1,
          JSON.stringify({}),
          testTimes.createdAt,
          testTimes.createdAt,
          testTimes.createdAt,
        ],
      );
      await client.query(
        'UPDATE "outbox_messages" SET "status" = $2, "delivered_at" = $3, "updated_at" = $3 WHERE "id" = $1',
        [messageId, "DELIVERED", deliveredAt],
      );
      return { messageId, deliveredAt };
    };

    await inRollbackTransaction(
      "outbox-delivered-requeue",
      async (client, fixtures) => {
        const { messageId } = await createDeliveredMessage(
          client,
          fixtures,
          "requeue",
        );

        await expect(
          client.query(
            'UPDATE "outbox_messages" SET "attempts" = "attempts" + 1, "updated_at" = $2 WHERE "id" = $1',
            [messageId, testTimes.expiresAt],
          ),
        ).resolves.toBeDefined();

        await expect(
          client.query(
            'UPDATE "outbox_messages" SET "status" = $2, "delivered_at" = NULL, "updated_at" = $3 WHERE "id" = $1',
            [messageId, "PENDING", testTimes.expiresAt],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "outbox_messages_delivered_terminal_check",
        });
      },
    );

    await inRollbackTransaction(
      "outbox-delivery-marker",
      async (client, fixtures) => {
        const { messageId } = await createDeliveredMessage(
          client,
          fixtures,
          "marker",
        );

        await expect(
          client.query(
            'UPDATE "outbox_messages" SET "delivered_at" = $2, "updated_at" = $2 WHERE "id" = $1',
            [messageId, testTimes.expiresAt],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "outbox_messages_delivered_terminal_check",
        });
      },
    );
  });

  it("allows identical canonical geometry under distinct source files", async () => {
    await inRollbackTransaction(
      "duplicate-geometry-hash",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const existing = await client.query<{ geometry_hash: string }>(
          'SELECT "geometry_hash" FROM "model_geometries" WHERE "id" = $1',
          [foundation.modelGeometryId],
        );
        const geometryHash = existing.rows[0]?.geometry_hash;
        if (!geometryHash) {
          throw new Error("foundation geometry hash was not persisted");
        }

        const secondFileId = fixtures.id("second-model-file");
        await client.query(
          'INSERT INTO "model_files" ("id", "format", "original_filename", "storage_object_key", "content_hash", "size_bytes", "uploaded_at", "source_delete_after") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            secondFileId,
            "STEP",
            "same-body.step",
            `models/${secondFileId}`,
            "f".repeat(64),
            1,
            testTimes.createdAt,
            testTimes.expiresAt,
          ],
        );
        await client.query(
          'INSERT INTO "model_geometries" ("id", "source_model_file_id", "canonical_object_key", "geometry_hash", "canonicalizer_revision", "volume_cubic_micrometers", "bounds_x_micrometers", "bounds_y_micrometers", "bounds_z_micrometers", "triangle_count") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            fixtures.id("second-geometry"),
            secondFileId,
            `canonical/${fixtures.id("second-geometry")}`,
            geometryHash,
            "test",
            1,
            1,
            1,
            1,
            1,
          ],
        );

        const matching = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "model_geometries" WHERE "geometry_hash" = $1',
          [geometryHash],
        );
        expect(matching.rows).toEqual([{ count: "2" }]);
      },
    );
  });

  it("expires retained geometry with its source and blocks new use", async () => {
    const expiredSource = {
      uploadedAt: new Date(Date.now() - 120_000),
      deleteAfter: new Date(Date.now() - 60_000),
      hold: "ACTIVE_ORDER" as const,
      quoteExpiresAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000),
    };

    await inRollbackTransaction(
      "expired-geometry-slice",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "expired-geometry-slice",
          expiredSource,
        );
        await client.query(
          'UPDATE "model_files" SET "retention_hold" = $2 WHERE "id" = $1',
          [foundation.modelFileId, "NONE"],
        );

        await expect(
          client.query(
            'INSERT INTO "slice_results" ("id", "kind", "cache_key", "model_geometry_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id", "parts_per_plate", "artifact_object_key", "artifact_hash", "estimated_print_seconds", "estimated_material_milligrams", "slicer_engine", "slicer_version") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
            [
              fixtures.id("expired-slice"),
              "PRODUCTION",
              `expired-${fixtures.id("expired-slice")}`,
              foundation.modelGeometryId,
              foundation.printConfigRevisionId,
              foundation.machineProfileId,
              foundation.machineCalibrationId,
              1,
              `slices/${fixtures.id("expired-slice")}`,
              "7".repeat(64),
              60,
              60,
              "orca",
              "test",
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "model_geometry_source_available_check",
        });
      },
    );

    await inRollbackTransaction(
      "expired-geometry-candidate",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "expired-geometry-candidate",
          expiredSource,
        );
        await client.query(
          'UPDATE "model_files" SET "retention_hold" = $2 WHERE "id" = $1',
          [foundation.modelFileId, "NONE"],
        );

        await expect(
          fixtures.planProduction(foundation, "expired-candidate"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "model_geometry_source_available_check",
        });
      },
    );

    await inRollbackTransaction(
      "geometry-deletion-marker",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "geometry-deletion-marker",
          expiredSource,
        );
        await client.query(
          'UPDATE "model_files" SET "retention_hold" = $2, "deleted_at" = clock_timestamp() WHERE "id" = $1',
          [foundation.modelFileId, "NONE"],
        );

        const deletion = await client.query<{
          source_deleted_at: Date;
          geometry_deleted_at: Date;
        }>(
          'SELECT source."deleted_at" AS source_deleted_at, geometry."deleted_at" AS geometry_deleted_at FROM "model_files" source JOIN "model_geometries" geometry ON geometry."source_model_file_id" = source."id" WHERE source."id" = $1',
          [foundation.modelFileId],
        );
        expect(deletion.rows[0]?.geometry_deleted_at).toEqual(
          deletion.rows[0]?.source_deleted_at,
        );

        await expect(
          client.query(
            'UPDATE "model_geometries" SET "deleted_at" = NULL WHERE "id" = $1',
            [foundation.modelGeometryId],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "model_geometry_deletion_binding_check",
        });
      },
    );
  });

  it("requires matching revision identity kinds and immutable payloads", async () => {
    await inRollbackTransaction("revision-kind", async (client, fixtures) => {
      const revisionId = fixtures.id("revision");
      await fixtures.createRevisionIdentity(revisionId, "PRINT_CONFIG");
      await expect(
        client.query(
          'INSERT INTO "reference_profiles" ("id", "material", "quality", "slicer_engine", "slicer_version", "settings") VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
          [revisionId, "PLA", "STANDARD", "orca", "test", JSON.stringify({})],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "revision_identity_kind_check",
      });
    });
    await inRollbackTransaction(
      "revision-immutable",
      async (client, fixtures) => {
        const revisionId = fixtures.id("revision");
        await fixtures.createRevisionIdentity(revisionId, "PRINT_CONFIG");
        await expect(
          client.query(
            'UPDATE "revision_identities" SET "digest" = $2 WHERE "id" = $1',
            [revisionId, "e".repeat(64)],
          ),
        ).rejects.toMatchObject({ code: "55000" });
      },
    );
  });

  it("requires reference slices to use an active profile for the requested quality", async () => {
    await inRollbackTransaction(
      "reference-slice-quality",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const referenceProfileId = fixtures.id("fine-reference-profile");
        await fixtures.createRevisionIdentity(
          referenceProfileId,
          "REFERENCE_PROFILE",
        );
        await client.query(
          'INSERT INTO "reference_profiles" ("id", "material", "quality", "slicer_engine", "slicer_version", "settings", "state", "activated_at") VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)',
          [
            referenceProfileId,
            "PLA",
            "FINE",
            "orca",
            "test",
            JSON.stringify({}),
            "ACTIVE",
            testTimes.createdAt,
          ],
        );

        await expect(
          createReferenceSlice(
            client,
            fixtures,
            foundation,
            referenceProfileId,
            "mismatched",
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "slice_results_reference_quality_check",
        });
      },
    );

    await inRollbackTransaction(
      "reference-slice-inactive",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const referenceProfileId = fixtures.id("draft-reference-profile");
        await fixtures.createRevisionIdentity(
          referenceProfileId,
          "REFERENCE_PROFILE",
        );
        await client.query(
          'INSERT INTO "reference_profiles" ("id", "material", "quality", "slicer_engine", "slicer_version", "settings") VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
          [
            referenceProfileId,
            "PLA",
            "STANDARD",
            "orca",
            "test",
            JSON.stringify({}),
          ],
        );

        await expect(
          createReferenceSlice(
            client,
            fixtures,
            foundation,
            referenceProfileId,
            "inactive",
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "slice_results_reference_profile_active_check",
        });
      },
    );

    await inRollbackTransaction(
      "reference-slice-active",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const referenceProfile = await client.query<{
          id: string;
          slicer_engine: string;
          slicer_version: string;
        }>(
          'SELECT "id", "slicer_engine", "slicer_version" FROM "reference_profiles" WHERE "material" = $1 AND "quality" = $2 AND "state" = $3 ORDER BY "id" LIMIT 1',
          ["PLA", "STANDARD", "ACTIVE"],
        );
        const selectedProfile = referenceProfile.rows[0];
        if (!selectedProfile) {
          throw new Error(
            "foundation machine profile has no reference profile",
          );
        }

        await expect(
          createReferenceSlice(
            client,
            fixtures,
            foundation,
            selectedProfile.id,
            "active",
            {
              engine: selectedProfile.slicer_engine,
              version: selectedProfile.slicer_version,
            },
          ),
        ).resolves.toBeUndefined();
      },
    );
  });

  it("binds slice runtimes and quality to their selected profiles", async () => {
    for (const field of ["engine", "version"] as const) {
      const name = `reference-${field}`;
      await inRollbackTransaction(name, async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const profile = await client.query<{
          id: string;
          slicer_engine: string;
          slicer_version: string;
        }>(
          'SELECT "id", "slicer_engine", "slicer_version" FROM "reference_profiles" WHERE "material" = $1 AND "quality" = $2 AND "state" = $3 ORDER BY "id" LIMIT 1',
          ["PLA", "STANDARD", "ACTIVE"],
        );
        const selectedProfile = profile.rows[0];
        if (!selectedProfile) {
          throw new Error("active reference profile is missing");
        }
        const slicerIdentity = {
          engine: selectedProfile.slicer_engine,
          version: selectedProfile.slicer_version,
        };
        slicerIdentity[field] = `${slicerIdentity[field]}-mismatch`;

        await expect(
          createReferenceSlice(
            client,
            fixtures,
            foundation,
            selectedProfile.id,
            name,
            slicerIdentity,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "slice_results_reference_slicer_check",
        });
      });
    }

    for (const [name, slicerIdentity] of [
      ["production-engine", { slicerEngine: "prusa" }],
      ["production-version", { slicerVersion: "other" }],
    ] as const) {
      await inRollbackTransaction(name, async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();

        await expect(
          createProductionSlice(
            client,
            fixtures,
            foundation,
            name,
            slicerIdentity,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "slice_results_production_slicer_check",
        });
      });
    }

    await inRollbackTransaction(
      "production-quality",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const printConfigRevisionId = fixtures.id("fine-print-config");
        await fixtures.createRevisionIdentity(
          printConfigRevisionId,
          "PRINT_CONFIG",
        );
        await client.query(
          'INSERT INTO "print_config_revisions" ("id", "quality", "infill_percent", "layer_height_micrometers", "settings") VALUES ($1, $2, $3, $4, $5::jsonb)',
          [printConfigRevisionId, "FINE", 20, 200, JSON.stringify({})],
        );

        await expect(
          createProductionSlice(client, fixtures, foundation, "quality", {
            printConfigRevisionId,
          }),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "slice_results_production_quality_check",
        });
      },
    );

    await inRollbackTransaction(
      "blank-slicer-identities",
      async (client, fixtures) => {
        const referenceProfileId = fixtures.id("blank-reference-profile");
        await fixtures.createRevisionIdentity(
          referenceProfileId,
          "REFERENCE_PROFILE",
        );

        await expect(
          client.query(
            'INSERT INTO "reference_profiles" ("id", "material", "quality", "slicer_engine", "slicer_version", "settings") VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
            [
              referenceProfileId,
              "PLA",
              "STANDARD",
              "   ",
              "test",
              JSON.stringify({}),
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "reference_profiles_slicer_identity_check",
        });
      },
    );
  });

  it("rejects records that combine a node with another node's machine", async () => {
    await inRollbackTransaction("node-scoping", async (client, fixtures) => {
      const foundation = await fixtures.createFoundation();
      const otherNodeId = fixtures.id("other-node");
      const calibrationId = fixtures.id("foreign-calibration");
      await client.query(
        'INSERT INTO "nodes" ("id", "code", "name", "time_zone", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6)',
        [
          otherNodeId,
          `other-${fixtures.id("other-node").slice(0, 24)}`,
          "Other node",
          "UTC",
          testTimes.createdAt,
          testTimes.createdAt,
        ],
      );
      await fixtures.createRevisionIdentity(
        calibrationId,
        "MACHINE_CALIBRATION",
      );

      await expect(
        client.query(
          'INSERT INTO "machine_calibrations" ("id", "node_id", "machine_id", "flow_ratio_parts_per_million", "xy_compensation_micrometers", "elephant_foot_compensation_micrometers", "settings") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
          [
            calibrationId,
            otherNodeId,
            foundation.machineId,
            1_000_000,
            0,
            0,
            JSON.stringify({}),
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("rejects candidate resources that do not match the concrete machine", async () => {
    await inRollbackTransaction(
      "candidate-build-volume-rotation",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "rotated-geometry",
          {},
          {
            xMicrometers: 350_000,
            yMicrometers: 250_000,
            zMicrometers: 150_000,
          },
          {
            xMicrometers: 200_000,
            yMicrometers: 300_000,
            zMicrometers: 400_000,
          },
        );

        await expect(
          fixtures.planProduction(foundation, "rotated-geometry"),
        ).resolves.toBeDefined();
      },
    );
    await inRollbackTransaction(
      "candidate-build-volume-mismatch",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "oversized-geometry",
          {},
          {
            xMicrometers: 350_000,
            yMicrometers: 310_000,
            zMicrometers: 150_000,
          },
          {
            xMicrometers: 200_000,
            yMicrometers: 300_000,
            zMicrometers: 400_000,
          },
        );

        await expect(
          fixtures.planProduction(foundation, "oversized-geometry"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "candidate_resource_compatibility_check",
        });
      },
    );
    await inRollbackTransaction(
      "candidate-inactive-node",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        await client.query(
          'UPDATE "nodes" SET "active" = false WHERE "id" = $1',
          [foundation.nodeId],
        );

        await expect(
          fixtures.planProduction(foundation, "inactive-node"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "candidate_resource_compatibility_check",
        });
      },
    );
    await inRollbackTransaction(
      "candidate-nozzle-mismatch",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        await client.query(
          'UPDATE "machines" SET "installed_nozzle_micrometers" = $2 WHERE "id" = $1',
          [foundation.machineId, 600],
        );

        await expect(
          fixtures.planProduction(foundation, "wrong-nozzle"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "candidate_resource_compatibility_check",
        });
      },
    );
    await inRollbackTransaction(
      "candidate-capability-mismatch",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const otherCapabilityId = fixtures.id("other-capability");
        await client.query(
          'INSERT INTO "machine_capabilities" ("id", "capability_key", "manufacturer", "model", "build_volume_x_micrometers", "build_volume_y_micrometers", "build_volume_z_micrometers", "supported_nozzle_micrometers", "supported_materials") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [
            otherCapabilityId,
            `other-${otherCapabilityId}`,
            "Other manufacturer",
            "Other model",
            200_000,
            200_000,
            200_000,
            [400],
            ["PLA"],
          ],
        );
        await client.query(
          'UPDATE "machines" SET "machine_capability_id" = $2 WHERE "id" = $1',
          [foundation.machineId, otherCapabilityId],
        );

        await expect(
          fixtures.planProduction(foundation, "wrong-capability"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "candidate_resource_compatibility_check",
        });
      },
    );
    await inRollbackTransaction(
      "candidate-quality-mismatch",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const printConfigRevisionId = fixtures.id("fine-print-config");
        const sliceResultId = fixtures.id("fine-slice");
        await fixtures.createRevisionIdentity(
          printConfigRevisionId,
          "PRINT_CONFIG",
        );
        await client.query(
          'INSERT INTO "print_config_revisions" ("id", "quality", "infill_percent", "layer_height_micrometers", "settings") VALUES ($1, $2, $3, $4, $5::jsonb)',
          [printConfigRevisionId, "FINE", 20, 200, JSON.stringify({})],
        );
        await expect(
          client.query(
            'INSERT INTO "slice_results" ("id", "kind", "cache_key", "model_geometry_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id", "parts_per_plate", "artifact_object_key", "artifact_hash", "estimated_print_seconds", "estimated_material_milligrams", "slicer_engine", "slicer_version") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
            [
              sliceResultId,
              "PRODUCTION",
              `fine-${sliceResultId}`,
              foundation.modelGeometryId,
              printConfigRevisionId,
              foundation.machineProfileId,
              foundation.machineCalibrationId,
              1,
              `slices/${sliceResultId}`,
              "8".repeat(64),
              60,
              60,
              "orca",
              "test",
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "slice_results_production_quality_check",
        });
      },
    );
  });

  it("prevents candidate quantities from understating the selected slice", async () => {
    const createQuantityFoundation = (
      fixtures: PersistenceFactory,
      name: string,
    ) =>
      fixtures.createFoundation(name, {}, undefined, undefined, {
        partsPerPlate: 4,
        estimatedPrintSeconds: 120,
        estimatedMaterialMilligrams: 40,
      });
    const twoPlateIntervals = [
      {
        startsAt: testTimes.capacityStart,
        endsAt: new Date(testTimes.capacityStart.getTime() + 120_000),
      },
      {
        startsAt: new Date(testTimes.capacityStart.getTime() + 120_000),
        endsAt: new Date(testTimes.capacityStart.getTime() + 240_000),
      },
    ];

    await inRollbackTransaction(
      "candidate-quantity-exact",
      async (_client, fixtures) => {
        const foundation = await createQuantityFoundation(fixtures, "exact");
        const production = await fixtures.planProduction(
          foundation,
          "exact",
          twoPlateIntervals,
          240,
          80,
          5,
        );

        await expect(
          fixtures.createResourcePlan(foundation, [production]),
        ).resolves.toBeUndefined();
      },
    );
    await inRollbackTransaction(
      "candidate-quantity-time-understatement",
      async (_client, fixtures) => {
        const foundation = await createQuantityFoundation(
          fixtures,
          "time-understatement",
        );

        await expect(
          fixtures.planProduction(
            foundation,
            "time-understatement",
            twoPlateIntervals,
            239,
            80,
            5,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "candidate_resource_quantity_check",
        });
      },
    );
    await inRollbackTransaction(
      "candidate-quantity-material-understatement",
      async (_client, fixtures) => {
        const foundation = await createQuantityFoundation(
          fixtures,
          "material-understatement",
        );

        await expect(
          fixtures.planProduction(
            foundation,
            "material-understatement",
            twoPlateIntervals,
            240,
            79,
            5,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "candidate_resource_quantity_check",
        });
      },
    );
    await inRollbackTransaction(
      "candidate-quantity-conservative-overestimate",
      async (_client, fixtures) => {
        const foundation = await createQuantityFoundation(
          fixtures,
          "conservative-overestimate",
        );
        const bufferedIntervals = [
          twoPlateIntervals[0]!,
          {
            startsAt: twoPlateIntervals[1]!.startsAt,
            endsAt: new Date(testTimes.capacityStart.getTime() + 241_000),
          },
        ];
        const production = await fixtures.planProduction(
          foundation,
          "conservative-overestimate",
          bufferedIntervals,
          241,
          81,
          5,
        );

        await expect(
          fixtures.createResourcePlan(foundation, [production]),
        ).resolves.toBeUndefined();
      },
    );
  });

  it("requires sufficient non-overlapping candidate capacity", async () => {
    await inRollbackTransaction(
      "candidate-capacity-short",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const startsAt = testTimes.capacityStart;
        const production = await fixtures.planProduction(
          foundation,
          "short-capacity",
          {
            startsAt,
            endsAt: new Date(startsAt.getTime() + 59_000),
          },
        );

        await expect(
          fixtures.createResourcePlan(foundation, [production]),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_resource_plan_candidate_capacity_coverage_check",
        });
      },
    );

    await inRollbackTransaction(
      "candidate-capacity-overlap",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const startsAt = testTimes.capacityStart;
        const production = await fixtures.planProduction(
          foundation,
          "overlapping-capacity",
          [
            {
              startsAt,
              endsAt: new Date(startsAt.getTime() + 40_000),
            },
            {
              startsAt: new Date(startsAt.getTime() + 20_000),
              endsAt: new Date(startsAt.getTime() + 60_000),
            },
          ],
        );

        await expect(
          fixtures.createResourcePlan(foundation, [production]),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_resource_plan_candidate_capacity_overlap_check",
        });
      },
    );

    await inRollbackTransaction(
      "plan-machine-capacity-overlap",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "foundation",
          undefined,
          undefined,
          undefined,
          undefined,
          2,
        );
        const productions = [
          await fixtures.planProduction(
            foundation,
            "first-plan-candidate",
            {
              startsAt: testTimes.capacityStart,
              endsAt: testTimes.capacityEnd,
            },
            undefined,
            undefined,
            undefined,
            0,
          ),
          await fixtures.planProduction(
            foundation,
            "second-plan-candidate",
            {
              startsAt: testTimes.capacityHalfHour,
              endsAt: testTimes.capacityOneAndHalfHours,
            },
            undefined,
            undefined,
            undefined,
            1,
          ),
        ];

        await expect(
          fixtures.createResourcePlan(foundation, productions),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_resource_plan_machine_capacity_overlap_check",
        });
      },
    );

    await inRollbackTransaction(
      "candidate-capacity-exact",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const startsAt = testTimes.capacityStart;
        const production = await fixtures.planProduction(
          foundation,
          "exact-capacity",
          {
            startsAt,
            endsAt: new Date(startsAt.getTime() + 60_000),
          },
        );

        await expect(
          fixtures.createResourcePlan(foundation, [production]),
        ).resolves.toBeUndefined();
      },
    );
  });

  it("allows adjacent capacity reservations but rejects active overlaps", async () => {
    await inRollbackTransaction("capacity", async (client, fixtures) => {
      const startsAt = testTimes.capacityStart;
      const endsAt = testTimes.capacityEnd;
      const { foundation, productions } = await fixtures.createReservationGraph(
        "capacity",
        [
          { startsAt, endsAt },
          {
            startsAt: endsAt,
            endsAt: testTimes.capacityTwoHours,
          },
        ],
      );
      const [first, adjacent] = productions;
      if (!first || !adjacent) {
        throw new Error(
          "capacity graph did not create both production fixtures",
        );
      }
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          fixtures.id("first-capacity"),
          foundation.nodeId,
          first.productionReservationId,
          first.candidateCapacityIntervalId,
          foundation.machineId,
          startsAt,
          endsAt,
          testTimes.expiresAt,
          testTimes.createdAt,
          testTimes.createdAt,
        ],
      );
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          fixtures.id("adjacent-capacity"),
          foundation.nodeId,
          adjacent.productionReservationId,
          adjacent.candidateCapacityIntervalId,
          foundation.machineId,
          endsAt,
          testTimes.capacityTwoHours,
          testTimes.expiresAt,
          testTimes.createdAt,
          testTimes.createdAt,
        ],
      );
    });
    await inRollbackTransaction(
      "capacity-overlap",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        const intervals = [
          {
            startsAt: testTimes.capacityStart,
            endsAt: testTimes.capacityEnd,
          },
          {
            startsAt: testTimes.capacityHalfHour,
            endsAt: testTimes.capacityOneAndHalfHours,
          },
        ];
        const plans: Array<{
          foundation: PersistenceFoundation;
          production: ProductionReservationFixture;
        }> = [];
        for (const [index, interval] of intervals.entries()) {
          const planFoundation = {
            ...foundation,
            eligibilitySnapshotId: fixtures.id(`overlap-${index}:snapshot`),
            phaseResourcePlanId: fixtures.id(`overlap-${index}:plan`),
            phaseReservationSetId: fixtures.id(`overlap-${index}:set`),
          };
          const production = await fixtures.planProduction(
            planFoundation,
            `overlap-${index}:production`,
            interval,
          );
          await fixtures.createResourcePlan(planFoundation, [production]);
          const planFixtures = factory(client, `capacity-overlap-${index}`);
          await planFixtures.createPhaseReservationSet(planFoundation);
          await planFixtures.createProductionReservation(
            planFoundation,
            production,
          );
          plans.push({ foundation: planFoundation, production });
        }
        const [first, overlapping] = plans;
        if (!first || !overlapping) {
          throw new Error("capacity setup did not create both plans");
        }
        await client.query(
          'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            fixtures.id("first-capacity"),
            first.foundation.nodeId,
            first.production.productionReservationId,
            first.production.candidateCapacityIntervalId,
            first.foundation.machineId,
            testTimes.capacityStart,
            testTimes.capacityEnd,
            testTimes.expiresAt,
            testTimes.createdAt,
            testTimes.createdAt,
          ],
        );
        await expect(
          client.query(
            'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [
              fixtures.id("overlapping-capacity"),
              overlapping.foundation.nodeId,
              overlapping.production.productionReservationId,
              overlapping.production.candidateCapacityIntervalId,
              overlapping.foundation.machineId,
              testTimes.capacityHalfHour,
              testTimes.capacityOneAndHalfHours,
              testTimes.expiresAt,
              testTimes.createdAt,
              testTimes.createdAt,
            ],
          ),
        ).rejects.toMatchObject({
          code: "23P01",
          constraint: "capacity_reservations_no_active_overlap",
        });
      },
    );
  });

  it("does not let concurrent inventory reservation inserts oversubscribe", async () => {
    const setup = await pool.connect();
    const setupFactory = factory(setup, "inventory-concurrency");
    let cleanupWinner: (() => Promise<void>) | undefined;
    try {
      await setup.query("BEGIN");
      const foundation = await setupFactory.createFoundation(
        "inventory-concurrency",
        undefined,
        undefined,
        undefined,
        undefined,
        2,
      );
      const intervals = [
        {
          startsAt: testTimes.capacityStart,
          endsAt: testTimes.capacityEnd,
        },
        {
          startsAt: testTimes.capacityEnd,
          endsAt: testTimes.capacityTwoHours,
        },
      ];
      const plans: Array<{
        capacityReservationId: string;
        foundation: PersistenceFoundation;
        interval: { startsAt: Date; endsAt: Date };
        production: ProductionReservationFixture;
        scope: string;
      }> = [];
      for (const [index, interval] of intervals.entries()) {
        const planFoundation = {
          ...foundation,
          eligibilitySnapshotId: setupFactory.id(`plan-${index}:snapshot`),
          phaseResourcePlanId: setupFactory.id(`plan-${index}:plan`),
          phaseReservationSetId: setupFactory.id(`plan-${index}:set`),
        };
        const production = await setupFactory.planProduction(
          planFoundation,
          `plan-${index}:production`,
          interval,
          undefined,
          undefined,
          undefined,
          index,
        );
        await setupFactory.createResourcePlan(planFoundation, [production]);
        plans.push({
          capacityReservationId: setupFactory.id(`plan-${index}:capacity`),
          foundation: planFoundation,
          interval,
          production,
          scope: `inventory-concurrency-${index}`,
        });
      }
      for (const plan of plans) {
        const topology = await setup.query<{
          jobs: string;
          plan_slots: string[];
          required_slots: string[];
        }>(
          `SELECT snapshot.required_fulfilment_slot_ids AS required_slots,
                  (SELECT array_agg(slot.fulfilment_slot_id ORDER BY slot.fulfilment_slot_id)
                   FROM phase_resource_plan_slots slot
                   WHERE slot.phase_resource_plan_id = resource_plan.id) AS plan_slots,
                  (SELECT count(*)::text
                   FROM phase_resource_plan_jobs job
                   WHERE job.phase_resource_plan_id = resource_plan.id) AS jobs
           FROM phase_resource_plans resource_plan
           JOIN eligibility_snapshots snapshot
             ON snapshot.id = resource_plan.eligibility_snapshot_id
            AND snapshot.node_id = resource_plan.node_id
           WHERE resource_plan.id = $1`,
          [plan.foundation.phaseResourcePlanId],
        );
        expect(topology.rows).toEqual([
          {
            jobs: "1",
            plan_slots: [plan.production.fulfilmentSlotId],
            required_slots: [plan.production.fulfilmentSlotId],
          },
        ]);
      }
      await setup.query("COMMIT");

      const reserve = async (plan: (typeof plans)[number]) => {
        const client = await pool.connect();
        const fixtures = factory(client, plan.scope);
        try {
          await client.query("BEGIN");
          await fixtures.createPhaseReservationSet(plan.foundation);
          await fixtures.createProductionReservation(
            plan.foundation,
            plan.production,
          );
          await client.query(
            'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              plan.production.inventoryReservationId,
              plan.foundation.nodeId,
              plan.production.productionReservationId,
              plan.foundation.inventoryId,
              60,
              testTimes.expiresAt,
              testTimes.createdAt,
              testTimes.createdAt,
            ],
          );
          await client.query(
            'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [
              plan.capacityReservationId,
              plan.foundation.nodeId,
              plan.production.productionReservationId,
              plan.production.candidateCapacityIntervalId,
              plan.foundation.machineId,
              plan.interval.startsAt,
              plan.interval.endsAt,
              testTimes.expiresAt,
              testTimes.createdAt,
              testTimes.createdAt,
            ],
          );
          await client.query(
            'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
            [plan.foundation.phaseReservationSetId, "RESERVED"],
          );
          await client.query("COMMIT");
          return plan;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };

      const attempts = await Promise.allSettled(plans.map(reserve));
      const successes = attempts.filter(
        (attempt): attempt is PromiseFulfilledResult<(typeof plans)[number]> =>
          attempt.status === "fulfilled",
      );
      const failures = attempts.filter(
        (attempt): attempt is PromiseRejectedResult =>
          attempt.status === "rejected",
      );

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.reason).toMatchObject({
        code: "23514",
        constraint: "inventory_reservation_available_balance_check",
      });
      const winningPlan = successes[0]?.value;
      if (!winningPlan) {
        throw new Error("inventory concurrency did not produce a winner");
      }
      expect(
        await setup.query<{ reserved_milligrams: string }>(
          'SELECT "reserved_milligrams" FROM "inventories" WHERE "id" = $1',
          [foundation.inventoryId],
        ),
      ).toMatchObject({ rows: [{ reserved_milligrams: "60" }] });
      cleanupWinner = async () => {
        await setup.query("BEGIN");
        await setup.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [winningPlan.foundation.phaseReservationSetId, "RELEASED"],
        );
        await setup.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [winningPlan.production.productionReservationId, "RELEASED"],
        );
        await setup.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
          [winningPlan.production.inventoryReservationId, "RELEASED"],
        );
        await setup.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
          [winningPlan.capacityReservationId, "RELEASED"],
        );
        await setup.query("COMMIT");
      };
    } finally {
      await cleanupWinner?.();
      setup.release();
    }
  });

  it("rejects direct writes to the maintained inventory reservation counter", async () => {
    await inRollbackTransaction(
      "inventory-counter-write",
      async (client, fixtures) => {
        const foundation = await fixtures.createFoundation();
        await client.query(
          'UPDATE "inventories" SET "reserved_milligrams" = 1 WHERE "id" = $1',
          [foundation.inventoryId],
        );

        await expect(
          client.query(
            'SET CONSTRAINTS "inventories_reserved_counter_matches_reservations" IMMEDIATE',
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "inventory_reserved_counter_matches_reservations_check",
        });
      },
    );
  });

  it("cannot reserve a multi-plate candidate until every interval is reserved", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fixtures = factory(client, "multi-plate");
      const foundation = await fixtures.createFoundation("multi-plate");
      const production = await fixtures.planProduction(
        foundation,
        "multi-production",
        [
          {
            startsAt: testTimes.capacityStart,
            endsAt: testTimes.capacityEnd,
          },
          {
            startsAt: testTimes.capacityEnd,
            endsAt: testTimes.capacityTwoHours,
          },
        ],
      );
      await fixtures.createResourcePlan(foundation, [production]);
      await fixtures.createPhaseReservationSet(foundation);
      await fixtures.createProductionReservation(foundation, production);
      await client.query(
        'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          production.inventoryReservationId,
          foundation.nodeId,
          production.productionReservationId,
          foundation.inventoryId,
          60,
          testTimes.expiresAt,
          testTimes.createdAt,
          testTimes.createdAt,
        ],
      );
      const firstIntervalId = production.candidateCapacityIntervalIds[0];
      if (!firstIntervalId) {
        throw new Error(
          "multi-plate fixture did not create its first interval",
        );
      }
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          fixtures.id("first-plate-capacity"),
          foundation.nodeId,
          production.productionReservationId,
          firstIntervalId,
          foundation.machineId,
          testTimes.capacityStart,
          testTimes.capacityEnd,
          testTimes.expiresAt,
          testTimes.createdAt,
          testTimes.createdAt,
        ],
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_complete_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("allows staggered capacity states for one multi-plate production", async () => {
    await inRollbackTransaction(
      "multi-plate-staggered-capacity",
      async (client, fixtures) => {
        const intervals = [
          {
            startsAt: testTimes.capacityStart,
            endsAt: testTimes.capacityEnd,
          },
          {
            startsAt: testTimes.capacityEnd,
            endsAt: testTimes.capacityTwoHours,
          },
        ];
        const foundation = await fixtures.createFoundation("multi-plate-live");
        const production = await fixtures.planProduction(
          foundation,
          "multi-plate-live",
          intervals,
        );
        const reservationTiming = checkoutReservationTiming();
        await fixtures.createResourcePlan(foundation, [production]);
        await fixtures.createPhaseReservationSet(
          foundation,
          reservationTiming.expiresAt,
          "BUILDING",
          reservationTiming.createdAt,
        );
        await fixtures.createProductionReservation(
          foundation,
          production,
          "RESERVED",
          {},
          null,
          reservationTiming.expiresAt,
          reservationTiming.createdAt,
        );
        await client.query(
          'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            production.inventoryReservationId,
            foundation.nodeId,
            production.productionReservationId,
            foundation.inventoryId,
            60,
            reservationTiming.expiresAt,
            reservationTiming.createdAt,
            reservationTiming.createdAt,
          ],
        );
        const capacityReservationIds = intervals.map((interval, index) => {
          const candidateCapacityIntervalId =
            production.candidateCapacityIntervalIds[index];
          if (!candidateCapacityIntervalId) {
            throw new Error("multi-plate candidate interval is missing");
          }
          return {
            id: fixtures.id(`multi-plate-capacity-${index}`),
            candidateCapacityIntervalId,
            interval,
          };
        });
        for (const capacity of capacityReservationIds) {
          await client.query(
            'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [
              capacity.id,
              foundation.nodeId,
              production.productionReservationId,
              capacity.candidateCapacityIntervalId,
              foundation.machineId,
              capacity.interval.startsAt,
              capacity.interval.endsAt,
              reservationTiming.expiresAt,
              reservationTiming.createdAt,
              reservationTiming.createdAt,
            ],
          );
        }
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );
        await activateReservationGraph(client, fixtures, foundation, [
          production,
        ]);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.productionReservationId, "SCHEDULED"],
        );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.inventoryReservationId, "ALLOCATED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "SCHEDULED"],
        );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.productionReservationId, "PRINTING"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
          [capacityReservationIds[0]?.id, "PRINTING"],
        );
        await advanceReservationOrderToProduction(client, foundation);

        await expect(
          client.query("SET CONSTRAINTS ALL IMMEDIATE"),
        ).resolves.toBeDefined();
      },
    );
  });

  it("freezes plan membership once a reservation set exists", async () => {
    await inRollbackTransaction(
      "plan-membership-freeze",
      async (client, fixtures) => {
        const { foundation, productions } =
          await fixtures.createReservationGraph("graph");
        const production = productions[0];
        if (!production) {
          throw new Error(
            "reservation graph did not create a production fixture",
          );
        }
        await expect(
          client.query(
            'INSERT INTO "phase_resource_plan_jobs" ("id", "node_id", "phase_resource_plan_id", "candidate_resource_estimate_id", "planned_job_key") VALUES ($1, $2, $3, $4, $5)',
            [
              fixtures.id("late-plan-job"),
              foundation.nodeId,
              foundation.phaseResourcePlanId,
              production.candidateResourceEstimateId,
              "late-plan-membership",
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_resource_plan_membership_frozen_check",
        });
      },
    );
  });

  it("serializes plan membership changes with reservation creation", async () => {
    const setup = await pool.connect();
    const reserving = await pool.connect();
    const competing = await pool.connect();
    try {
      const scope = "plan-membership-concurrency";
      const setupFixtures = factory(setup, scope);
      await setup.query("BEGIN");
      const foundation = await setupFixtures.createFoundation(scope);
      const production = await setupFixtures.planProduction(
        foundation,
        "initial-production",
      );
      await setupFixtures.createResourcePlan(foundation, [production]);
      await setup.query("COMMIT");

      await reserving.query("BEGIN");
      await factory(reserving, scope).createPhaseReservationSet(foundation);

      await competing.query("BEGIN");
      await competing.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        competing.query(
          'INSERT INTO "phase_resource_plan_jobs" ("id", "node_id", "phase_resource_plan_id", "candidate_resource_estimate_id", "planned_job_key") VALUES ($1, $2, $3, $4, $5)',
          [
            setupFixtures.id("concurrent-plan-job"),
            foundation.nodeId,
            foundation.phaseResourcePlanId,
            production.candidateResourceEstimateId,
            "concurrent-plan-membership",
          ],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await reserving.query("ROLLBACK").catch(() => undefined);
      await competing.query("ROLLBACK").catch(() => undefined);
      setup.release();
      reserving.release();
      competing.release();
    }
  });

  it("rejects reservation sets outside their plan validity window", async () => {
    await inRollbackTransaction(
      "expired-reservation-plan",
      async (_client, fixtures) => {
        const planCreatedAt = new Date(Date.now() - 120_000);
        const planExpiresAt = new Date(Date.now() - 60_000);
        const foundation = await fixtures.createFoundation("expired-plan");
        const production = await fixtures.planProduction(
          foundation,
          "expired-plan-production",
        );
        await fixtures.createResourcePlan(
          foundation,
          [production],
          planExpiresAt,
          planCreatedAt,
        );

        await expect(
          fixtures.createPhaseReservationSet(
            foundation,
            planExpiresAt,
            "BUILDING",
            planCreatedAt,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_reservation_set_plan_expiry_check",
        });
      },
    );
    await inRollbackTransaction(
      "reservation-beyond-plan",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation("future-plan");
        const production = await fixtures.planProduction(
          foundation,
          "future-plan-production",
        );
        await fixtures.createResourcePlan(foundation, [production]);

        await expect(
          fixtures.createPhaseReservationSet(
            foundation,
            testTimes.afterExpiresAt,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_reservation_set_plan_expiry_check",
        });
      },
    );
  });

  it("revalidates capacity, geometry, resources, and snapshots at confirmation", async () => {
    await inRollbackTransaction(
      "past-capacity-confirmation",
      async (client, fixtures) => {
        const { foundation } = await createCompleteSingleReservationGraph(
          client,
          fixtures,
          "past-capacity-confirmation",
          {
            startsAt: new Date(Date.now() - 120_000),
            endsAt: new Date(Date.now() - 60_000),
          },
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );

        await expect(
          client.query("SET CONSTRAINTS ALL IMMEDIATE"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_reservation_set_capacity_window_check",
        });
      },
    );

    await inRollbackTransaction(
      "mutable-resource-confirmation",
      async (client, fixtures) => {
        const { foundation } = await createCompleteSingleReservationGraph(
          client,
          fixtures,
          "mutable-resource-confirmation",
          {
            startsAt: testTimes.capacityStart,
            endsAt: testTimes.capacityEnd,
          },
        );
        await client.query(
          'UPDATE "machines" SET "status" = $2 WHERE "id" = $1',
          [foundation.machineId, "DISABLED"],
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );

        await expect(
          client.query("SET CONSTRAINTS ALL IMMEDIATE"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_reservation_set_resource_compatibility_check",
        });
      },
    );

    await inRollbackTransaction(
      "inactive-node-confirmation",
      async (client, fixtures) => {
        const { foundation } = await createCompleteSingleReservationGraph(
          client,
          fixtures,
          "inactive-node-confirmation",
          {
            startsAt: testTimes.capacityStart,
            endsAt: testTimes.capacityEnd,
          },
        );
        await client.query(
          'UPDATE "nodes" SET "active" = false WHERE "id" = $1',
          [foundation.nodeId],
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );

        await expect(
          client.query("SET CONSTRAINTS ALL IMMEDIATE"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_reservation_set_resource_compatibility_check",
        });
      },
    );

    await inRollbackTransaction(
      "resource-snapshot-confirmation",
      async (client, fixtures) => {
        const { foundation } = await createCompleteSingleReservationGraph(
          client,
          fixtures,
          "resource-snapshot-confirmation",
          {
            startsAt: testTimes.capacityStart,
            endsAt: testTimes.capacityEnd,
          },
          { inventoryRemainingMilligrams: 99 },
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );

        await expect(
          client.query("SET CONSTRAINTS ALL IMMEDIATE"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_reservation_set_complete_check",
        });
      },
    );

    await inRollbackTransaction(
      "elapsed-source-horizon-retention",
      async (client, fixtures) => {
        const capacityStartsAt = new Date(Date.now() - 120_000);
        const capacityEndsAt = new Date(Date.now() - 60_000);
        const { foundation } = await createCompleteSingleReservationGraph(
          client,
          fixtures,
          "elapsed-source-horizon-retention",
          {
            startsAt: capacityStartsAt,
            endsAt: capacityEndsAt,
          },
          {},
          {
            uploadedAt: new Date(capacityStartsAt.getTime() - 60_000),
            deleteAfter: capacityEndsAt,
            hold: "ACTIVE_ORDER",
            quoteExpiresAt: capacityEndsAt,
          },
        );
        await expect(
          client.query(
            'UPDATE "model_files" SET "retention_hold" = $2 WHERE "id" = $1',
            [foundation.modelFileId, "NONE"],
          ),
        ).resolves.toBeDefined();
        await expect(
          client.query(
            'UPDATE "model_files" SET "deleted_at" = CURRENT_TIMESTAMP WHERE "id" = $1',
            [foundation.modelFileId],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "model_file_live_capacity_horizon_check",
        });
      },
    );

    await inRollbackTransaction(
      "short-source-horizon-confirmation",
      async (client, fixtures) => {
        const { foundation } = await createCompleteSingleReservationGraph(
          client,
          fixtures,
          "short-source-horizon-confirmation",
          {
            startsAt: testTimes.capacityStart,
            endsAt: testTimes.capacityEnd,
          },
          {},
          {
            deleteAfter: testTimes.capacityHalfHour,
            hold: "NONE",
            quoteExpiresAt: new Date(
              testTimes.capacityStart.getTime() - 91 * 24 * 60 * 60 * 1_000,
            ),
          },
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );

        await expect(
          client.query("SET CONSTRAINTS ALL IMMEDIATE"),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "model_geometry_source_available_check",
        });
      },
    );

    for (const hold of ["ACTIVE_ORDER", "LEGAL"] as const) {
      const holdName = hold === "ACTIVE_ORDER" ? "order" : "legal";
      await inRollbackTransaction(
        `held-source-horizon-${holdName}`,
        async (client, fixtures) => {
          const { foundation } = await createCompleteSingleReservationGraph(
            client,
            fixtures,
            `held-source-horizon-${holdName}`,
            {
              startsAt: testTimes.capacityStart,
              endsAt: testTimes.capacityEnd,
            },
            {},
            { deleteAfter: testTimes.capacityHalfHour, hold },
          );
          await client.query(
            'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
            [foundation.phaseReservationSetId, "RESERVED"],
          );

          await expect(
            client.query("SET CONSTRAINTS ALL IMMEDIATE"),
          ).resolves.toBeDefined();
        },
      );
    }
  });

  it("retains model sources through live production capacity", async () => {
    await inRollbackTransaction(
      "live-source-retention-horizon",
      async (client, fixtures) => {
        const capacityStart = new Date(Date.now() + 100 * 24 * 60 * 60 * 1_000);
        const capacityEnd = new Date(capacityStart.getTime() + 60 * 60 * 1_000);
        const { foundation, production } =
          await createCompleteSingleReservationGraph(
            client,
            fixtures,
            "live-source-retention-horizon",
            {
              startsAt: capacityStart,
              endsAt: capacityEnd,
            },
            {},
            {
              deleteAfter: new Date(capacityStart.getTime() + 30 * 60 * 1_000),
              hold: "ACTIVE_ORDER",
            },
          );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );
        await activateReservationGraph(client, fixtures, foundation, [
          production,
        ]);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");

        await expect(
          client.query(
            'UPDATE "model_files" SET "retention_hold" = $2 WHERE "id" = $1',
            [foundation.modelFileId, "NONE"],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "order_source_active_order_check",
        });
      },
    );
  });

  it("serializes node deactivation with reservation confirmation", async () => {
    const setup = await pool.connect();
    const confirming = await pool.connect();
    const disabling = await pool.connect();
    let foundation: PersistenceFoundation | undefined;
    let production: ProductionReservationFixture | undefined;
    let cleanupError: unknown;
    try {
      const fixtures = factory(setup, "node-deactivation-concurrency");
      await setup.query("BEGIN");
      const graph = await createCompleteSingleReservationGraph(
        setup,
        fixtures,
        "node-deactivation-concurrency",
        {
          startsAt: testTimes.capacityStart,
          endsAt: testTimes.capacityEnd,
        },
      );
      foundation = graph.foundation;
      production = graph.production;
      await setup.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );
      await setup.query("COMMIT");

      await confirming.query("BEGIN");
      const confirmingFixtures = factory(
        confirming,
        "node-deactivation-concurrency",
      );
      await activateReservationGraph(
        confirming,
        confirmingFixtures,
        foundation,
        [production],
      );

      await disabling.query("BEGIN");
      await disabling.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        disabling.query('UPDATE "nodes" SET "active" = false WHERE "id" = $1', [
          foundation.nodeId,
        ]),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await confirming.query("ROLLBACK").catch(() => undefined);
      await disabling.query("ROLLBACK").catch(() => undefined);

      if (foundation && production) {
        await setup.query("BEGIN");
        try {
          await setup.query(
            'UPDATE "inventory_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
            [production.productionReservationId, "RELEASED"],
          );
          await setup.query(
            'UPDATE "capacity_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
            [production.productionReservationId, "RELEASED"],
          );
          await setup.query(
            'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
            [production.productionReservationId, "RELEASED"],
          );
          await setup.query(
            'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
            [foundation.phaseReservationSetId, "RELEASED"],
          );
          await setup.query("COMMIT");
        } catch (error) {
          await setup.query("ROLLBACK").catch(() => undefined);
          cleanupError = error;
        }
      }

      setup.release();
      confirming.release();
      disabling.release();
    }
    if (cleanupError) {
      throw cleanupError;
    }
  });

  it("requires resource children to share the production expiry", async () => {
    await inRollbackTransaction(
      "inventory-expiry-mismatch",
      async (client, fixtures) => {
        const { foundation, productions } =
          await fixtures.createReservationGraph("inventory-expiry-mismatch");
        const production = productions[0];
        if (!production) {
          throw new Error(
            "reservation graph did not create a production fixture",
          );
        }

        await expect(
          client.query(
            'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              production.inventoryReservationId,
              foundation.nodeId,
              production.productionReservationId,
              foundation.inventoryId,
              60,
              testTimes.beforeExpiresAt,
              testTimes.createdAt,
              testTimes.createdAt,
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "inventory_reservation_production_inventory_check",
        });
      },
    );
    await inRollbackTransaction(
      "capacity-expiry-mismatch",
      async (client, fixtures) => {
        const { foundation, productions } =
          await fixtures.createReservationGraph("capacity-expiry-mismatch");
        const production = productions[0];
        if (!production) {
          throw new Error(
            "reservation graph did not create a production fixture",
          );
        }

        await expect(
          client.query(
            'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [
              fixtures.id("mismatched-expiry-capacity"),
              foundation.nodeId,
              production.productionReservationId,
              production.candidateCapacityIntervalId,
              foundation.machineId,
              testTimes.capacityStart,
              testTimes.capacityEnd,
              testTimes.beforeExpiresAt,
              testTimes.createdAt,
              testTimes.createdAt,
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "capacity_reservation_production_binding_check",
        });
      },
    );
  });

  it("cannot commit a BUILDING phase reservation set", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fixtures = factory(client, "building-set");
      await fixtures.createReservationGraph("building-set");

      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_building_commit_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("rejects post-capture child states under a RESERVED set", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fixtures = factory(client, "reserved-child-phase");
      const reservationTiming = checkoutReservationTiming();
      const { foundation, productions } = await fixtures.createReservationGraph(
        "reserved-child-phase",
        undefined,
        undefined,
        undefined,
        reservationTiming,
      );
      const production = productions[0];
      if (!production) {
        throw new Error(
          "reservation graph did not create a production fixture",
        );
      }
      const capacityReservationId = fixtures.id("reserved-capacity");
      await client.query(
        'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          production.inventoryReservationId,
          foundation.nodeId,
          production.productionReservationId,
          foundation.inventoryId,
          60,
          reservationTiming.expiresAt,
          reservationTiming.createdAt,
          reservationTiming.createdAt,
        ],
      );
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          capacityReservationId,
          foundation.nodeId,
          production.productionReservationId,
          production.candidateCapacityIntervalId,
          foundation.machineId,
          testTimes.capacityStart,
          testTimes.capacityEnd,
          reservationTiming.expiresAt,
          reservationTiming.createdAt,
          reservationTiming.createdAt,
        ],
      );
      await client.query(
        'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
        [production.inventoryReservationId, "HELD"],
      );
      await fixtures.createJob(foundation, production);
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2, "job_id" = $3 WHERE "id" = $1',
        [production.productionReservationId, "HELD", production.jobId],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [capacityReservationId, "HELD"],
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );
      await fixtures.activatePayment(foundation);

      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_child_status_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("cannot commit an incomplete RESERVED phase reservation set", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fixtures = factory(client, "incomplete-reserved-set");
      const { foundation } = await fixtures.createReservationGraph(
        "incomplete-reserved-set",
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );

      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_complete_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("allows retrying a plan after its reservation set is released", async () => {
    await inRollbackTransaction(
      "released-set-retry",
      async (client, fixtures) => {
        const interval = {
          startsAt: testTimes.capacityStart,
          endsAt: testTimes.capacityEnd,
        };
        const { foundation, production } =
          await createCompleteSingleReservationGraph(
            client,
            fixtures,
            "released-set-retry",
            interval,
          );

        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("SET CONSTRAINTS ALL DEFERRED");

        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RELEASED"],
        );
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("SET CONSTRAINTS ALL DEFERRED");

        const retryFixtures = factory(client, "released-set-retry-attempt-2");
        const retryFoundation = {
          ...foundation,
          phaseReservationSetId: retryFixtures.id("phase-reservation-set"),
        };
        const retryProduction = {
          ...production,
          jobId: retryFixtures.id("future-job"),
          productionReservationId: retryFixtures.id("production-reservation"),
          inventoryReservationId: retryFixtures.id("inventory-reservation"),
        };
        await retryFixtures.createPhaseReservationSet(retryFoundation);
        await retryFixtures.createProductionReservation(
          retryFoundation,
          retryProduction,
        );
        await client.query(
          'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            retryProduction.inventoryReservationId,
            retryFoundation.nodeId,
            retryProduction.productionReservationId,
            retryFoundation.inventoryId,
            60,
            testTimes.expiresAt,
            testTimes.createdAt,
            testTimes.createdAt,
          ],
        );
        await client.query(
          'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            retryFixtures.id("capacity-reservation"),
            retryFoundation.nodeId,
            retryProduction.productionReservationId,
            retryProduction.candidateCapacityIntervalId,
            retryFoundation.machineId,
            interval.startsAt,
            interval.endsAt,
            testTimes.expiresAt,
            testTimes.createdAt,
            testTimes.createdAt,
          ],
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [retryFoundation.phaseReservationSetId, "RESERVED"],
        );

        await expect(
          client.query("SET CONSTRAINTS ALL IMMEDIATE"),
        ).resolves.toBeDefined();
      },
    );
  });

  it("cannot commit an inconsistent HELD phase reservation set", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const fixtures = factory(client, "incomplete-held-set");
      const reservationTiming = checkoutReservationTiming();
      const { foundation, productions } = await fixtures.createReservationGraph(
        "incomplete-held-set",
        undefined,
        undefined,
        undefined,
        reservationTiming,
      );
      const production = productions[0];
      if (!production) {
        throw new Error(
          "reservation graph did not create a production fixture",
        );
      }
      await client.query(
        'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          production.inventoryReservationId,
          foundation.nodeId,
          production.productionReservationId,
          foundation.inventoryId,
          60,
          reservationTiming.expiresAt,
          reservationTiming.createdAt,
          reservationTiming.createdAt,
        ],
      );
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          fixtures.id("held-capacity"),
          foundation.nodeId,
          production.productionReservationId,
          production.candidateCapacityIntervalId,
          foundation.machineId,
          testTimes.capacityStart,
          testTimes.capacityEnd,
          reservationTiming.expiresAt,
          reservationTiming.createdAt,
          reservationTiming.createdAt,
        ],
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );
      await activateReservationGraph(client, fixtures, foundation, [
        production,
      ]);
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [fixtures.id("held-capacity"), "RELEASED"],
      );

      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_child_status_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("revalidates child changes after a HELD set was committed", async () => {
    const client = await pool.connect();
    let heldCommitted = false;
    const fixtures = factory(client, "committed-held-set");
    let foundation: Awaited<
      ReturnType<PersistenceFactory["createFoundation"]>
    > | null = null;
    let production: Awaited<
      ReturnType<PersistenceFactory["planProduction"]>
    > | null = null;
    const capacityReservationId = fixtures.id("held-capacity");
    try {
      await client.query("BEGIN");
      const reservationTiming = checkoutReservationTiming();
      const graph = await fixtures.createReservationGraph(
        "committed-held-set",
        undefined,
        undefined,
        undefined,
        reservationTiming,
      );
      foundation = graph.foundation;
      production = graph.productions[0] ?? null;
      if (!production) {
        throw new Error(
          "reservation graph did not create a production fixture",
        );
      }
      await client.query(
        'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          production.inventoryReservationId,
          foundation.nodeId,
          production.productionReservationId,
          foundation.inventoryId,
          60,
          reservationTiming.expiresAt,
          reservationTiming.createdAt,
          reservationTiming.createdAt,
        ],
      );
      await client.query(
        'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          capacityReservationId,
          foundation.nodeId,
          production.productionReservationId,
          production.candidateCapacityIntervalId,
          foundation.machineId,
          testTimes.capacityStart,
          testTimes.capacityEnd,
          reservationTiming.expiresAt,
          reservationTiming.createdAt,
          reservationTiming.createdAt,
        ],
      );
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );
      await activateReservationGraph(client, fixtures, foundation, [
        production,
      ]);
      await client.query("COMMIT");
      heldCommitted = true;

      await client.query("BEGIN");
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [capacityReservationId, "RELEASED"],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_child_status_check",
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RELEASED"],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_terminal_children_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      if (heldCommitted && foundation && production) {
        await client.query("BEGIN");
        await cancelConfirmedReservationOrder(client, foundation);
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RELEASED"],
        );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.inventoryReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
          [capacityReservationId, "RELEASED"],
        );
        await client.query("COMMIT");
      }
      client.release();
    }
  });

  it("allows a HELD set to mix terminal and live job groups", async () => {
    const client = await pool.connect();
    const fixtures = factory(client, "mixed-held-groups");
    const intervals = [
      {
        startsAt: testTimes.capacityStart,
        endsAt: testTimes.capacityEnd,
      },
      {
        startsAt: testTimes.capacityEnd,
        endsAt: testTimes.capacityTwoHours,
      },
    ];
    const capacityReservationIds = intervals.map((_, index) =>
      fixtures.id(`held-capacity-${index}`),
    );
    let graph: Awaited<
      ReturnType<PersistenceFactory["createReservationGraph"]>
    > | null = null;
    let heldCommitted = false;
    try {
      await client.query("BEGIN");
      const reservationTiming = checkoutReservationTiming();
      graph = await fixtures.createReservationGraph(
        "mixed-held-groups",
        intervals,
        undefined,
        undefined,
        reservationTiming,
      );
      await client.query(
        'UPDATE "inventories" SET "remaining_milligrams" = $2 WHERE "id" = $1',
        [graph.foundation.inventoryId, 200],
      );
      for (const [index, production] of graph.productions.entries()) {
        const interval = intervals[index];
        const capacityReservationId = capacityReservationIds[index];
        if (!interval || !capacityReservationId) {
          throw new Error("reservation group fixture is incomplete");
        }
        await client.query(
          'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            production.inventoryReservationId,
            graph.foundation.nodeId,
            production.productionReservationId,
            graph.foundation.inventoryId,
            60,
            reservationTiming.expiresAt,
            reservationTiming.createdAt,
            reservationTiming.createdAt,
          ],
        );
        await client.query(
          'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            capacityReservationId,
            graph.foundation.nodeId,
            production.productionReservationId,
            production.candidateCapacityIntervalId,
            graph.foundation.machineId,
            interval.startsAt,
            interval.endsAt,
            reservationTiming.expiresAt,
            reservationTiming.createdAt,
            reservationTiming.createdAt,
          ],
        );
      }
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [graph.foundation.phaseReservationSetId, "RESERVED"],
      );
      await activateReservationGraph(
        client,
        fixtures,
        graph.foundation,
        graph.productions,
      );
      await client.query(
        'SET CONSTRAINTS "jobs_captured_reservation_reconciled" IMMEDIATE',
      );

      const terminalProduction = graph.productions[0];
      const liveProduction = graph.productions[1];
      const liveCapacityReservationId = capacityReservationIds[1];
      if (
        !terminalProduction ||
        !liveProduction ||
        !liveCapacityReservationId
      ) {
        throw new Error("reservation group fixture is missing");
      }
      await client.query(
        'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveProduction.inventoryReservationId, "ALLOCATED"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveCapacityReservationId, "SCHEDULED"],
      );
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveProduction.productionReservationId, "SCHEDULED"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveCapacityReservationId, "PRINTING"],
      );
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveProduction.productionReservationId, "PRINTING"],
      );
      await advanceReservationOrderToProduction(client, graph.foundation);
      const heldSetId = graph.foundation.phaseReservationSetId;
      const consumeWithReleasedInventory = async (
        settleParent: boolean,
      ): Promise<void> => {
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [terminalProduction.productionReservationId, "SCHEDULED"],
        );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
          [terminalProduction.inventoryReservationId, "ALLOCATED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
          [capacityReservationIds[0], "SCHEDULED"],
        );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [terminalProduction.productionReservationId, "PRINTING"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
          [capacityReservationIds[0], "PRINTING"],
        );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [terminalProduction.productionReservationId, "CONSUMED"],
        );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
          [terminalProduction.inventoryReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
          [capacityReservationIds[0], "COMPLETED"],
        );
        if (settleParent) {
          await client.query(
            'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
            [liveProduction.productionReservationId, "RELEASED"],
          );
          await client.query(
            'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
            [liveProduction.inventoryReservationId, "RELEASED"],
          );
          await client.query(
            'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
            [liveCapacityReservationId, "RELEASED"],
          );
          await client.query(
            'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
            [heldSetId, "SETTLED"],
          );
        }
      };

      await client.query("SAVEPOINT mismatched_consumed_group");
      await consumeWithReleasedInventory(false);
      await expect(
        client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_child_status_check",
      });
      await client.query("ROLLBACK TO SAVEPOINT mismatched_consumed_group");
      await client.query("SET CONSTRAINTS ALL DEFERRED");

      await client.query("SAVEPOINT mismatched_settled_group");
      await consumeWithReleasedInventory(true);
      await expect(
        client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_child_status_check",
      });
      await client.query("ROLLBACK TO SAVEPOINT mismatched_settled_group");
      await client.query("SET CONSTRAINTS ALL DEFERRED");

      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [terminalProduction.productionReservationId, "RELEASED"],
      );
      await client.query(
        'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
        [terminalProduction.inventoryReservationId, "RELEASED"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [capacityReservationIds[0], "RELEASED"],
      );
      await client.query("COMMIT");
      heldCommitted = true;

      await client.query("BEGIN");
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveProduction.productionReservationId, "RELEASED"],
      );
      await client.query(
        'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveProduction.inventoryReservationId, "RELEASED"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveCapacityReservationId, "RELEASED"],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_child_status_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      const liveProduction = graph?.productions[1];
      if (heldCommitted && graph && liveProduction) {
        await client.query("BEGIN");
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2, "consumed_milligrams" = "reserved_milligrams" WHERE "id" = $1',
          [liveProduction.inventoryReservationId, "CONSUMED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
          [capacityReservationIds[1], "COMPLETED"],
        );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [liveProduction.productionReservationId, "CONSUMED"],
        );
        await client.query(
          'UPDATE "jobs" SET "status" = $2, "printed_at" = $3, "updated_at" = $3 WHERE "id" = $1',
          [liveProduction.jobId, "PRINTED", new Date()],
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [graph.foundation.phaseReservationSetId, "SETTLED"],
        );
        await client.query("COMMIT");
      }
      client.release();
    }
  });

  it("settles only reservation groups with reconciled consumption", async () => {
    await inRollbackTransaction(
      "settled-consumed-group",
      async (client, fixtures) => {
        const { foundation, production } =
          await createCompleteSingleReservationGraph(
            client,
            fixtures,
            "settled-consumed-group",
            {
              startsAt: testTimes.capacityStart,
              endsAt: testTimes.capacityEnd,
            },
          );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );
        await activateReservationGraph(client, fixtures, foundation, [
          production,
        ]);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.productionReservationId, "SCHEDULED"],
        );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "ALLOCATED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "SCHEDULED"],
        );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.productionReservationId, "PRINTING"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "PRINTING"],
        );
        await advanceReservationOrderToProduction(client, foundation);
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.productionReservationId, "CONSUMED"],
        );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2, "consumed_milligrams" = $3 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "CONSUMED", 60],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "COMPLETED"],
        );
        await client.query(
          'UPDATE "jobs" SET "status" = $2, "printed_at" = $3, "updated_at" = $3 WHERE "id" = $1',
          [production.jobId, "PRINTED", new Date()],
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "SETTLED"],
        );
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");

        expect(
          await client.query<{
            capacity_status: string;
            inventory_status: string;
            production_status: string;
            set_status: string;
          }>(
            'SELECT production."status" AS production_status, inventory_reservation."status" AS inventory_status, capacity_reservation."status" AS capacity_status, reservation_set."status" AS set_status FROM "production_reservations" production JOIN "inventory_reservations" inventory_reservation ON inventory_reservation."production_reservation_id" = production."id" JOIN "capacity_reservations" capacity_reservation ON capacity_reservation."production_reservation_id" = production."id" JOIN "phase_reservation_sets" reservation_set ON reservation_set."id" = production."phase_reservation_set_id" WHERE production."id" = $1',
            [production.productionReservationId],
          ),
        ).toMatchObject({
          rows: [
            {
              capacity_status: "COMPLETED",
              inventory_status: "CONSUMED",
              production_status: "CONSUMED",
              set_status: "SETTLED",
            },
          ],
        });
        expect(
          await client.query<{
            remaining_milligrams: string;
            reserved_milligrams: string;
          }>(
            'SELECT "remaining_milligrams", "reserved_milligrams" FROM "inventories" WHERE "id" = $1',
            [foundation.inventoryId],
          ),
        ).toMatchObject({
          rows: [{ remaining_milligrams: "40", reserved_milligrams: "0" }],
        });
      },
    );
  });

  it("revalidates mutable resources and sources only for live jobs in a HELD set", async () => {
    const client = await pool.connect();
    const fixtures = factory(client, "held-live-resource-eligibility");
    const expiredHeldSource = {
      uploadedAt: new Date(Date.now() - 120_000),
      deleteAfter: new Date(Date.now() - 60_000),
      hold: "ACTIVE_ORDER" as const,
      quoteExpiresAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000),
    };
    let foundation: PersistenceFoundation | null = null;
    let liveFoundation: PersistenceFoundation | null = null;
    let terminalProduction: ProductionReservationFixture;
    let liveProduction: ProductionReservationFixture | null = null;
    let heldCommitted = false;
    const terminalCapacityId = fixtures.id("terminal-capacity");
    const liveCapacityId = fixtures.id("live-capacity");
    try {
      await client.query("BEGIN");
      foundation = await fixtures.createFoundation(
        "terminal-machine",
        expiredHeldSource,
        undefined,
        undefined,
        undefined,
        2,
        undefined,
        "QUOTED",
        async (draftFoundation) => {
          liveFoundation = await createSiblingMachineFoundation(
            client,
            fixtures,
            draftFoundation,
            "live-machine",
            expiredHeldSource,
          );
          await client.query(
            `UPDATE order_items
             SET source_model_file_id = $2, model_geometry_id = $3,
                 print_config_revision_id = $4,
                 reference_slice_result_id = $5
             WHERE id = $1`,
            [
              draftFoundation.orderItemIds[1],
              liveFoundation.modelFileId,
              liveFoundation.modelGeometryId,
              liveFoundation.printConfigRevisionId,
              liveFoundation.referenceSliceResultId,
            ],
          );
        },
      );
      const activeLiveFoundation =
        liveFoundation as PersistenceFoundation | null;
      if (!activeLiveFoundation) {
        throw new Error("live machine foundation was not created");
      }
      terminalProduction = await fixtures.planProduction(
        foundation,
        "terminal-production",
        {
          startsAt: testTimes.capacityStart,
          endsAt: testTimes.capacityEnd,
        },
      );
      liveProduction = await fixtures.planProduction(
        activeLiveFoundation,
        "live-production",
        {
          startsAt: testTimes.capacityStart,
          endsAt: testTimes.capacityEnd,
        },
        undefined,
        undefined,
        undefined,
        1,
      );
      await fixtures.createResourcePlan(foundation, [
        terminalProduction,
        liveProduction,
      ]);
      const reservationTiming = checkoutReservationTiming();
      await fixtures.createPhaseReservationSet(
        foundation,
        reservationTiming.expiresAt,
        "BUILDING",
        reservationTiming.createdAt,
      );
      await fixtures.createProductionReservation(
        foundation,
        terminalProduction,
        "RESERVED",
        {},
        null,
        reservationTiming.expiresAt,
        reservationTiming.createdAt,
      );
      await fixtures.createProductionReservation(
        activeLiveFoundation,
        liveProduction,
        "RESERVED",
        {},
        null,
        reservationTiming.expiresAt,
        reservationTiming.createdAt,
      );

      for (const [resource, production, capacityId] of [
        [foundation, terminalProduction, terminalCapacityId],
        [activeLiveFoundation, liveProduction, liveCapacityId],
      ] as const) {
        await client.query(
          'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            production.inventoryReservationId,
            resource.nodeId,
            production.productionReservationId,
            resource.inventoryId,
            60,
            reservationTiming.expiresAt,
            reservationTiming.createdAt,
            reservationTiming.createdAt,
          ],
        );
        await client.query(
          'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            capacityId,
            resource.nodeId,
            production.productionReservationId,
            production.candidateCapacityIntervalId,
            resource.machineId,
            testTimes.capacityStart,
            testTimes.capacityEnd,
            reservationTiming.expiresAt,
            reservationTiming.createdAt,
            reservationTiming.createdAt,
          ],
        );
      }
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RESERVED"],
      );
      for (const [resource, production, capacityId] of [
        [foundation, terminalProduction, terminalCapacityId],
        [activeLiveFoundation, liveProduction, liveCapacityId],
      ] as const) {
        await fixtures.createJob(resource, production);
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2, "job_id" = $3 WHERE "id" = $1',
          [production.productionReservationId, "HELD", production.jobId],
        );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.inventoryReservationId, "HELD"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
          [capacityId, "HELD"],
        );
      }
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "HELD"],
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
        'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
        [terminalProduction.inventoryReservationId, "ALLOCATED"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [terminalCapacityId, "SCHEDULED"],
      );
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [terminalProduction.productionReservationId, "SCHEDULED"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [terminalCapacityId, "PRINTING"],
      );
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [terminalProduction.productionReservationId, "PRINTING"],
      );
      await advanceReservationOrderToProduction(client, foundation);
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [terminalProduction.productionReservationId, "CONSUMED"],
      );
      await client.query(
        'UPDATE "inventory_reservations" SET "status" = $2, "consumed_milligrams" = "reserved_milligrams" WHERE "id" = $1',
        [terminalProduction.inventoryReservationId, "CONSUMED"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [terminalCapacityId, "COMPLETED"],
      );
      await client.query(
        'UPDATE "jobs" SET "status" = $2, "printed_at" = $3, "updated_at" = $3 WHERE "id" = $1',
        [terminalProduction.jobId, "PRINTED", new Date()],
      );
      await client.query("COMMIT");
      heldCommitted = true;

      await client.query("BEGIN");
      await client.query(
        'UPDATE "machines" SET "status" = $2 WHERE "id" = $1',
        [foundation.machineId, "DISABLED"],
      );
      await expect(
        client.query(
          'UPDATE "model_files" SET "retention_hold" = $2, "deleted_at" = clock_timestamp() WHERE "id" = $1',
          [foundation.modelFileId, "NONE"],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "order_source_active_order_check",
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query(
        'UPDATE "machines" SET "status" = $2 WHERE "id" = $1',
        [foundation.machineId, "DISABLED"],
      );
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveProduction.productionReservationId, "SCHEDULED"],
      );
      await client.query(
        'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveProduction.inventoryReservationId, "ALLOCATED"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveCapacityId, "SCHEDULED"],
      );
      await expect(client.query("COMMIT")).resolves.toBeDefined();

      await client.query("BEGIN");
      await expect(
        client.query(
          'UPDATE "model_files" SET "retention_hold" = $2, "deleted_at" = clock_timestamp() WHERE "id" = $1',
          [activeLiveFoundation.modelFileId, "NONE"],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "order_source_active_order_check",
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query(
        'UPDATE "machines" SET "status" = $2 WHERE "id" = $1',
        [activeLiveFoundation.machineId, "DISABLED"],
      );
      await client.query(
        'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveProduction.productionReservationId, "PRINTING"],
      );
      await client.query(
        'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
        [liveCapacityId, "PRINTING"],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_resource_compatibility_check",
      });
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      if (heldCommitted && foundation && liveProduction && liveFoundation) {
        await client.query("BEGIN");
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RELEASED"],
        );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [liveProduction.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
          [liveProduction.inventoryReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "id" = $1',
          [liveCapacityId, "RELEASED"],
        );
        await client.query("COMMIT");
      }
      client.release();
    }
  });

  it("requires reservation rows to start at their lifecycle entry states", async () => {
    await inRollbackTransaction(
      "initial-phase-set-status",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "initial-phase-set-status",
        );
        const production = await fixtures.planProduction(
          foundation,
          "production",
        );
        await fixtures.createResourcePlan(foundation, [production]);

        await expect(
          fixtures.createPhaseReservationSet(
            foundation,
            testTimes.expiresAt,
            "HELD",
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "reservation_lifecycle_initial_state_check",
        });
      },
    );

    await inRollbackTransaction(
      "initial-production-status",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "initial-production-status",
        );
        const production = await fixtures.planProduction(
          foundation,
          "production",
        );
        await fixtures.createResourcePlan(foundation, [production]);
        await fixtures.createPhaseReservationSet(foundation);

        await expect(
          fixtures.createProductionReservation(
            foundation,
            production,
            "SCHEDULED",
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "reservation_lifecycle_initial_state_check",
        });
      },
    );

    await inRollbackTransaction(
      "initial-capacity-status",
      async (client, fixtures) => {
        const { foundation, productions } =
          await fixtures.createReservationGraph("initial-capacity-status");
        const production = productions[0];
        if (!production) {
          throw new Error(
            "reservation graph did not create a production fixture",
          );
        }

        await expect(
          client.query(
            'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "status", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
            [
              fixtures.id("initial-capacity"),
              foundation.nodeId,
              production.productionReservationId,
              production.candidateCapacityIntervalId,
              foundation.machineId,
              testTimes.capacityStart,
              testTimes.capacityEnd,
              "PRINTING",
              testTimes.expiresAt,
              testTimes.createdAt,
              testTimes.createdAt,
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "reservation_lifecycle_initial_state_check",
        });
      },
    );
  });

  it("binds production jobs only during successful capture", async () => {
    await inRollbackTransaction(
      "initial-production-job-binding",
      async (_client, fixtures) => {
        const foundation = await fixtures.createFoundation(
          "initial-production-job-binding",
        );
        const production = await fixtures.planProduction(
          foundation,
          "production",
        );
        await fixtures.createResourcePlan(foundation, [production]);
        await fixtures.createPhaseReservationSet(foundation);

        await expect(
          fixtures.createProductionReservation(
            foundation,
            production,
            "RESERVED",
            {},
            production.jobId,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "production_reservation_job_binding_check",
        });
      },
    );

    await inRollbackTransaction(
      "reserved-production-job-binding",
      async (client, fixtures) => {
        const { foundation, production } =
          await createCompleteSingleReservationGraph(
            client,
            fixtures,
            "reserved-production-job-binding",
            {
              startsAt: testTimes.capacityStart,
              endsAt: testTimes.capacityEnd,
            },
          );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query(
          `SET CONSTRAINTS
             "jobs_captured_reservation_reconciled",
             "jobs_parent_lifecycle_reconciled" DEFERRED`,
        );

        await fixtures.createJob(foundation, production);
        await expect(
          client.query(
            'UPDATE "production_reservations" SET "job_id" = $2 WHERE "id" = $1',
            [production.productionReservationId, production.jobId],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "production_reservation_job_binding_check",
        });
      },
    );

    await inRollbackTransaction(
      "unbound-held-production",
      async (client, fixtures) => {
        const { production } = await createCompleteSingleReservationGraph(
          client,
          fixtures,
          "unbound-held-production",
          {
            startsAt: testTimes.capacityStart,
            endsAt: testTimes.capacityEnd,
          },
        );

        await expect(
          client.query(
            'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
            [production.productionReservationId, "HELD"],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "production_reservation_job_binding_check",
        });
      },
    );

    await inRollbackTransaction(
      "terminal-production-job-binding",
      async (client, fixtures) => {
        const { foundation, production } =
          await createCompleteSingleReservationGraph(
            client,
            fixtures,
            "terminal-production-job-binding",
            {
              startsAt: testTimes.capacityStart,
              endsAt: testTimes.capacityEnd,
            },
          );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RELEASED"],
        );
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query(
          `SET CONSTRAINTS
             "jobs_captured_reservation_reconciled",
             "jobs_parent_lifecycle_reconciled" DEFERRED`,
        );

        await fixtures.createJob(foundation, production);
        await expect(
          client.query(
            'UPDATE "production_reservations" SET "job_id" = $2 WHERE "id" = $1',
            [production.productionReservationId, production.jobId],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "production_reservation_job_binding_check",
        });
      },
    );

    await inRollbackTransaction(
      "captured-production-job-binding",
      async (client, fixtures) => {
        const { foundation, production } =
          await createCompleteSingleReservationGraph(
            client,
            fixtures,
            "captured-production-job-binding",
            {
              startsAt: testTimes.capacityStart,
              endsAt: testTimes.capacityEnd,
            },
          );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RESERVED"],
        );
        await activateReservationGraph(client, fixtures, foundation, [
          production,
        ]);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");

        expect(
          await client.query<{ job_id: string; status: string }>(
            'SELECT "job_id", "status" FROM "production_reservations" WHERE "id" = $1',
            [production.productionReservationId],
          ),
        ).toMatchObject({
          rows: [{ job_id: production.jobId, status: "HELD" }],
        });
        await expect(
          client.query(
            'UPDATE "production_reservations" SET "job_id" = $2 WHERE "id" = $1',
            [
              production.productionReservationId,
              fixtures.id("replacement-job"),
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "production_reservation_job_binding_check",
        });
      },
    );
  });

  it("keeps a completed idempotency result immutable", async () => {
    const insertCompletedRecord = async (
      client: PoolClient,
      fixtures: PersistenceFactory,
    ): Promise<string> => {
      const id = fixtures.id("completed-idempotency-record");
      await client.query(
        'INSERT INTO "idempotency_records" ("id", "namespace", "idempotency_key", "request_fingerprint", "status", "response_status_code", "response_body", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)',
        [
          id,
          "test-command",
          `idempotency-${fixtures.id("key")}`,
          "b".repeat(64),
          "COMPLETED",
          201,
          JSON.stringify({ result: "original" }),
          testTimes.expiresAt,
          testTimes.createdAt,
          testTimes.createdAt,
        ],
      );
      return id;
    };

    await inRollbackTransaction(
      "rewind-completed-idempotency",
      async (client, fixtures) => {
        const id = await insertCompletedRecord(client, fixtures);
        await expect(
          client.query(
            'UPDATE "idempotency_records" SET "status" = $2, "response_status_code" = NULL, "response_body" = NULL WHERE "id" = $1',
            [id, "PROCESSING"],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "idempotency_records_completed_result_immutable_check",
        });
      },
    );

    await inRollbackTransaction(
      "replace-completed-idempotency",
      async (client, fixtures) => {
        const id = await insertCompletedRecord(client, fixtures);
        await expect(
          client.query(
            'UPDATE "idempotency_records" SET "response_body" = $2::jsonb WHERE "id" = $1',
            [id, JSON.stringify({ result: "replacement" })],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "idempotency_records_completed_result_immutable_check",
        });
      },
    );
  });

  it("rejects production children added after a reservation set is terminal", async () => {
    const client = await pool.connect();
    const fixtures = factory(client, "terminal-set-late-children");
    try {
      await client.query("BEGIN");
      const foundation = await fixtures.createFoundation(
        "terminal-set-late-children",
      );
      const production = await fixtures.planProduction(
        foundation,
        "production",
      );
      await fixtures.createResourcePlan(foundation, [production]);
      await fixtures.createPhaseReservationSet(foundation);
      await client.query(
        'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
        [foundation.phaseReservationSetId, "RELEASED"],
      );
      await client.query("COMMIT");

      await client.query("BEGIN");
      await expect(
        fixtures.createProductionReservation(foundation, production),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "phase_reservation_set_child_insert_state_check",
      });
      await client.query("ROLLBACK");

      const inventory = await client.query<{ reserved_milligrams: string }>(
        'SELECT "reserved_milligrams" FROM "inventories" WHERE "id" = $1',
        [foundation.inventoryId],
      );
      expect(inventory.rows[0]?.reserved_milligrams).toBe("0");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("rejects resource children added after a reservation set is terminal", async () => {
    await inRollbackTransaction(
      "terminal-set-late-resources",
      async (client, fixtures) => {
        const { foundation, production } =
          await createCompleteSingleReservationGraph(
            client,
            fixtures,
            "terminal-set-late-resources",
            {
              startsAt: testTimes.capacityStart,
              endsAt: testTimes.capacityEnd,
            },
          );
        await client.query(
          'UPDATE "production_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "inventory_reservations" SET "status" = $2 WHERE "id" = $1',
          [production.inventoryReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "capacity_reservations" SET "status" = $2 WHERE "production_reservation_id" = $1',
          [production.productionReservationId, "RELEASED"],
        );
        await client.query(
          'UPDATE "phase_reservation_sets" SET "status" = $2 WHERE "id" = $1',
          [foundation.phaseReservationSetId, "RELEASED"],
        );
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");

        await client.query("SAVEPOINT late_inventory");
        await expect(
          client.query(
            'INSERT INTO "inventory_reservations" ("id", "node_id", "production_reservation_id", "inventory_id", "reserved_milligrams", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              fixtures.id("late-inventory"),
              foundation.nodeId,
              production.productionReservationId,
              foundation.inventoryId,
              60,
              testTimes.expiresAt,
              testTimes.createdAt,
              testTimes.createdAt,
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_reservation_set_child_insert_state_check",
        });
        await client.query("ROLLBACK TO SAVEPOINT late_inventory");

        await client.query("SAVEPOINT late_capacity");
        await expect(
          client.query(
            'INSERT INTO "capacity_reservations" ("id", "node_id", "production_reservation_id", "candidate_capacity_interval_id", "machine_id", "starts_at", "ends_at", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [
              fixtures.id("late-capacity"),
              foundation.nodeId,
              production.productionReservationId,
              production.candidateCapacityIntervalId,
              foundation.machineId,
              testTimes.capacityStart,
              testTimes.capacityEnd,
              testTimes.expiresAt,
              testTimes.createdAt,
              testTimes.createdAt,
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "phase_reservation_set_child_insert_state_check",
        });
        await client.query("ROLLBACK TO SAVEPOINT late_capacity");

        const inventory = await client.query<{ reserved_milligrams: string }>(
          'SELECT "reserved_milligrams" FROM "inventories" WHERE "id" = $1',
          [foundation.inventoryId],
        );
        expect(inventory.rows[0]?.reserved_milligrams).toBe("0");
      },
    );
  });
});
