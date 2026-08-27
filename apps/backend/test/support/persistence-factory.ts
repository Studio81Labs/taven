import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

type Sql = Pick<PoolClient, "query">;

export type PersistenceFoundation = {
  nodeId: string;
  machineId: string;
  inventoryId: string;
  modelFileId: string;
  modelGeometryId: string;
  sliceResultId: string;
  printConfigRevisionId: string;
  machineProfileId: string;
  machineCalibrationId: string;
  eligibilitySnapshotId: string;
  phaseResourcePlanId: string;
  phaseReservationSetId: string;
};

export type ProductionReservationFixture = {
  candidateResourceEstimateId: string;
  phaseResourcePlanJobId: string;
  plannedJobKey: string;
  fulfilmentSlotId: string;
  jobId: string;
  productionReservationId: string;
  inventoryReservationId: string;
  candidateCapacityIntervalId: string;
  candidateCapacityIntervalIds: string[];
  requiredMachineSeconds: number;
};

type CapacityInterval = { startsAt: Date; endsAt: Date };
export type SourceRetention = {
  uploadedAt?: Date;
  deleteAfter?: Date;
  hold?: "NONE" | "ACTIVE_ORDER" | "ACTIVE_CLAIM" | "LEGAL";
};

const createdAt = new Date("2026-08-27T12:00:00.000Z");
const expiresAt = new Date("2030-08-27T12:00:00.000Z");
const digest = "a".repeat(64);

/**
 * Builds a complete, node-scoped reservation graph using only opaque UUIDs.
 * IDs are stable for a supplied scope so assertions can name related records
 * without depending on customer or order tables that have not been introduced.
 */
export class PersistenceFactory {
  constructor(
    private readonly sql: Sql,
    private readonly scope: string,
  ) {}

  id(name: string): string {
    const hex = createHash("sha256")
      .update(`${this.scope}:${name}`)
      .digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  async createFoundation(
    name = "foundation",
    sourceRetention: SourceRetention = {},
  ): Promise<PersistenceFoundation> {
    const nodeId = this.id(`${name}:node`);
    const capabilityId = this.id(`${name}:capability`);
    const machineId = this.id(`${name}:machine`);
    const inventoryId = this.id(`${name}:inventory`);
    const modelFileId = this.id(`${name}:model-file`);
    const geometryId = this.id(`${name}:geometry`);
    const printConfigRevisionId = this.id(`${name}:print-config`);
    const referenceProfileId = this.id(`${name}:reference-profile`);
    const machineProfileId = this.id(`${name}:machine-profile`);
    const machineCalibrationId = this.id(`${name}:machine-calibration`);
    const sliceResultId = this.id(`${name}:slice-result`);
    const eligibilitySnapshotId = this.id(`${name}:eligibility-snapshot`);
    const phaseResourcePlanId = this.id(`${name}:phase-resource-plan`);
    const phaseReservationSetId = this.id(`${name}:phase-reservation-set`);

    await this.sql.query(
      'INSERT INTO "nodes" ("id", "code", "name", "time_zone", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6)',
      [
        nodeId,
        `node-${this.hash(`${name}:node-code`).slice(0, 24)}`,
        "Test node",
        "UTC",
        createdAt,
        createdAt,
      ],
    );
    await this.sql.query(
      'INSERT INTO "machine_capabilities" ("id", "capability_key", "manufacturer", "model", "build_volume_x_micrometers", "build_volume_y_micrometers", "build_volume_z_micrometers", "supported_nozzle_micrometers", "supported_materials") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        capabilityId,
        `capability-${this.hash(`${name}:capability-key`).slice(0, 32)}`,
        "Test manufacturer",
        "Test model",
        200_000,
        200_000,
        200_000,
        [400, 600],
        ["PLA"],
      ],
    );
    await this.sql.query(
      'INSERT INTO "machines" ("id", "node_id", "machine_capability_id", "code", "display_name", "installed_nozzle_micrometers", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        machineId,
        nodeId,
        capabilityId,
        `machine-${name}`,
        "Test machine",
        400,
        createdAt,
        createdAt,
      ],
    );
    await this.sql.query(
      'INSERT INTO "inventories" ("id", "node_id", "machine_id", "sku", "material", "vendor", "price_minor_units_numerator", "price_minor_units_denominator", "currency", "remaining_milligrams", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      [
        inventoryId,
        nodeId,
        machineId,
        `sku-${this.hash(`${name}:sku`).slice(0, 32)}`,
        "PLA",
        "Test vendor",
        1,
        1,
        "EUR",
        100,
        createdAt,
        createdAt,
      ],
    );
    await this.sql.query(
      'INSERT INTO "model_files" ("id", "format", "original_filename", "storage_object_key", "content_hash", "size_bytes", "uploaded_at", "source_delete_after", "retention_hold") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        modelFileId,
        "STL",
        "test.stl",
        `models/${this.scope}/${name}.stl`,
        digest,
        1,
        sourceRetention.uploadedAt ?? createdAt,
        sourceRetention.deleteAfter ?? expiresAt,
        sourceRetention.hold ?? "NONE",
      ],
    );
    await this.sql.query(
      'INSERT INTO "model_geometries" ("id", "source_model_file_id", "canonical_object_key", "geometry_hash", "canonicalizer_revision", "volume_cubic_micrometers", "bounds_x_micrometers", "bounds_y_micrometers", "bounds_z_micrometers", "triangle_count") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [
        geometryId,
        modelFileId,
        `canonical/${this.scope}/${name}`,
        this.hash(`${name}:geometry`),
        "test-canonicalizer",
        1,
        1,
        1,
        1,
        1,
      ],
    );

    await this.createRevisionIdentity(printConfigRevisionId, "PRINT_CONFIG");
    await this.sql.query(
      'INSERT INTO "print_config_revisions" ("id", "quality", "infill_percent", "layer_height_micrometers", "settings") VALUES ($1, $2, $3, $4, $5::jsonb)',
      [printConfigRevisionId, "STANDARD", 20, 200, JSON.stringify({})],
    );
    await this.createRevisionIdentity(referenceProfileId, "REFERENCE_PROFILE");
    await this.sql.query(
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
    await this.createRevisionIdentity(machineProfileId, "MACHINE_PROFILE");
    await this.sql.query(
      'INSERT INTO "machine_profiles" ("id", "machine_capability_id", "reference_profile_id", "material", "quality", "nozzle_diameter_micrometers", "slicer_engine", "slicer_version", "settings", "state", "activated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)',
      [
        machineProfileId,
        capabilityId,
        referenceProfileId,
        "PLA",
        "STANDARD",
        400,
        "orca",
        "test",
        JSON.stringify({}),
        "ACTIVE",
        createdAt,
      ],
    );
    await this.createRevisionIdentity(
      machineCalibrationId,
      "MACHINE_CALIBRATION",
    );
    await this.sql.query(
      'INSERT INTO "machine_calibrations" ("id", "node_id", "machine_id", "flow_ratio_parts_per_million", "xy_compensation_micrometers", "elephant_foot_compensation_micrometers", "settings", "state", "activated_at") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)',
      [
        machineCalibrationId,
        nodeId,
        machineId,
        1_000_000,
        0,
        0,
        JSON.stringify({}),
        "ACTIVE",
        createdAt,
      ],
    );
    await this.sql.query(
      'INSERT INTO "slice_results" ("id", "kind", "cache_key", "model_geometry_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id", "parts_per_plate", "artifact_object_key", "artifact_hash", "estimated_print_seconds", "estimated_material_milligrams", "slicer_engine", "slicer_version") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
      [
        sliceResultId,
        "PRODUCTION",
        `slice-${this.scope}-${name}`,
        geometryId,
        printConfigRevisionId,
        machineProfileId,
        machineCalibrationId,
        1,
        `slices/${this.scope}/${name}`,
        this.hash(`${name}:slice`),
        60,
        60,
        "orca",
        "test",
      ],
    );
    return {
      nodeId,
      machineId,
      inventoryId,
      modelFileId,
      modelGeometryId: geometryId,
      sliceResultId,
      printConfigRevisionId,
      machineProfileId,
      machineCalibrationId,
      eligibilitySnapshotId,
      phaseResourcePlanId,
      phaseReservationSetId,
    };
  }

  async planProduction(
    foundation: PersistenceFoundation,
    name: string,
    intervalOrIntervals: CapacityInterval | CapacityInterval[] = {
      startsAt: new Date("2027-01-01T10:00:00.000Z"),
      endsAt: new Date("2027-01-01T11:00:00.000Z"),
    },
    requiredMachineSeconds = 60,
  ): Promise<ProductionReservationFixture> {
    const candidateId = this.id(`${name}:candidate`);
    const capacityIntervals = Array.isArray(intervalOrIntervals)
      ? intervalOrIntervals
      : [intervalOrIntervals];
    const candidateCapacityIntervalIds = capacityIntervals.map((_, index) =>
      this.id(`${name}:candidate-capacity-interval:${index}`),
    );
    const candidateCapacityIntervalId = candidateCapacityIntervalIds[0];
    if (!candidateCapacityIntervalId) {
      throw new Error(
        "a planned production needs at least one capacity interval",
      );
    }
    const planJobId = this.id(`${name}:plan-job`);
    const productionReservationId = this.id(`${name}:production-reservation`);
    const inventoryReservationId = this.id(`${name}:inventory-reservation`);

    await this.sql.query(
      'INSERT INTO "candidate_resource_estimates" ("id", "node_id", "estimate_key", "model_geometry_id", "slice_result_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id", "machine_id", "inventory_id", "shipment_plan_id", "arrangement_revision_id", "quantity", "required_material_milligrams", "required_machine_seconds", "resource_snapshot", "calculated_at", "expires_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)',
      [
        candidateId,
        foundation.nodeId,
        `estimate-${this.scope}-${name}`,
        foundation.modelGeometryId,
        foundation.sliceResultId,
        foundation.printConfigRevisionId,
        foundation.machineProfileId,
        foundation.machineCalibrationId,
        foundation.machineId,
        foundation.inventoryId,
        this.id(`${name}:future-shipment-plan`),
        this.id(`${name}:future-arrangement-revision`),
        1,
        60,
        requiredMachineSeconds,
        JSON.stringify({}),
        createdAt,
        expiresAt,
      ],
    );
    for (const [index, capacityInterval] of capacityIntervals.entries()) {
      const candidateCapacityIntervalId = candidateCapacityIntervalIds[index];
      if (!candidateCapacityIntervalId) {
        throw new Error("capacity interval identifier was not generated");
      }
      await this.sql.query(
        'INSERT INTO "candidate_capacity_intervals" ("id", "node_id", "candidate_resource_estimate_id", "interval_index", "starts_at", "ends_at") VALUES ($1, $2, $3, $4, $5, $6)',
        [
          candidateCapacityIntervalId,
          foundation.nodeId,
          candidateId,
          index,
          capacityInterval.startsAt,
          capacityInterval.endsAt,
        ],
      );
    }
    const plannedJobKey = `planned-${this.hash(`${name}:planned-job-key`).slice(0, 32)}`;
    const jobId = this.id(`${name}:future-job`);
    const fulfilmentSlotId = this.id(`${name}:future-fulfilment-slot`);
    return {
      candidateResourceEstimateId: candidateId,
      phaseResourcePlanJobId: planJobId,
      plannedJobKey,
      fulfilmentSlotId,
      jobId,
      productionReservationId,
      inventoryReservationId,
      candidateCapacityIntervalId,
      candidateCapacityIntervalIds,
      requiredMachineSeconds,
    };
  }

  async createPhaseReservationSet(
    foundation: PersistenceFoundation,
    reservationExpiresAt = expiresAt,
    status = "BUILDING",
    reservationCreatedAt = createdAt,
  ): Promise<void> {
    await this.sql.query(
      'INSERT INTO "phase_reservation_sets" ("id", "node_id", "phase_resource_plan_id", "reservation_key", "status", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        foundation.phaseReservationSetId,
        foundation.nodeId,
        foundation.phaseResourcePlanId,
        `reservation-${this.scope}`,
        status,
        reservationExpiresAt,
        reservationCreatedAt,
        reservationCreatedAt,
      ],
    );
  }

  async createResourcePlan(
    foundation: PersistenceFoundation,
    productions: ProductionReservationFixture[],
    planExpiresAt = expiresAt,
    planCreatedAt = createdAt,
  ): Promise<void> {
    const requiredFulfilmentSlotIds = productions.map(
      (production) => production.fulfilmentSlotId,
    );
    const candidateIds = productions.map(
      (production) => production.candidateResourceEstimateId,
    );
    await this.sql.query(
      'INSERT INTO "eligibility_snapshots" ("id", "node_id", "order_phase_id", "required_fulfilment_slot_ids", "eligible_candidate_estimate_ids", "snapshot_hash", "calculated_at", "expires_at") VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)',
      [
        foundation.eligibilitySnapshotId,
        foundation.nodeId,
        this.id("future-order-phase"),
        JSON.stringify(requiredFulfilmentSlotIds),
        JSON.stringify(candidateIds),
        this.hash(`snapshot:${foundation.eligibilitySnapshotId}`),
        planCreatedAt,
        planExpiresAt,
      ],
    );
    await this.sql.query(
      'INSERT INTO "phase_resource_plans" ("id", "node_id", "order_phase_id", "eligibility_snapshot_id", "plan_key", "created_at", "expires_at") VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        foundation.phaseResourcePlanId,
        foundation.nodeId,
        this.id("future-order-phase"),
        foundation.eligibilitySnapshotId,
        `plan-${this.hash(foundation.phaseResourcePlanId).slice(0, 32)}`,
        planCreatedAt,
        planExpiresAt,
      ],
    );
    for (const production of productions) {
      await this.sql.query(
        'INSERT INTO "phase_resource_plan_jobs" ("id", "node_id", "phase_resource_plan_id", "candidate_resource_estimate_id", "planned_job_key") VALUES ($1, $2, $3, $4, $5)',
        [
          production.phaseResourcePlanJobId,
          foundation.nodeId,
          foundation.phaseResourcePlanId,
          production.candidateResourceEstimateId,
          production.plannedJobKey,
        ],
      );
      await this.sql.query(
        'INSERT INTO "phase_resource_plan_slots" ("id", "node_id", "phase_resource_plan_id", "phase_resource_plan_job_id", "fulfilment_slot_id") VALUES ($1, $2, $3, $4, $5)',
        [
          this.id(`${production.plannedJobKey}:phase-resource-plan-slot`),
          foundation.nodeId,
          foundation.phaseResourcePlanId,
          production.phaseResourcePlanJobId,
          production.fulfilmentSlotId,
        ],
      );
    }
  }

  async createProductionReservation(
    foundation: PersistenceFoundation,
    planned: ProductionReservationFixture,
    status = "RESERVED",
    resourceSnapshot: unknown = {},
  ): Promise<void> {
    await this.sql.query(
      'INSERT INTO "production_reservations" ("id", "node_id", "phase_reservation_set_id", "phase_resource_plan_job_id", "planned_job_key", "job_id", "machine_id", "inventory_id", "slice_result_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id", "required_material_milligrams", "required_machine_seconds", "resource_snapshot", "status", "expires_at", "created_at", "updated_at", "phase_resource_plan_id") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, $20)',
      [
        planned.productionReservationId,
        foundation.nodeId,
        foundation.phaseReservationSetId,
        planned.phaseResourcePlanJobId,
        planned.plannedJobKey,
        planned.jobId,
        foundation.machineId,
        foundation.inventoryId,
        foundation.sliceResultId,
        foundation.printConfigRevisionId,
        foundation.machineProfileId,
        foundation.machineCalibrationId,
        60,
        planned.requiredMachineSeconds,
        JSON.stringify(resourceSnapshot),
        status,
        expiresAt,
        createdAt,
        createdAt,
        foundation.phaseResourcePlanId,
      ],
    );
  }

  async createReservationGraph(
    name: string,
    intervals = [
      {
        startsAt: new Date("2027-01-01T10:00:00.000Z"),
        endsAt: new Date("2027-01-01T11:00:00.000Z"),
      },
    ],
    resourceSnapshot: unknown = {},
    sourceRetention: SourceRetention = {},
  ): Promise<{
    foundation: PersistenceFoundation;
    productions: ProductionReservationFixture[];
  }> {
    const foundation = await this.createFoundation(name, sourceRetention);
    const productions: ProductionReservationFixture[] = [];
    for (const [index, interval] of intervals.entries()) {
      productions.push(
        await this.planProduction(foundation, `production-${index}`, interval),
      );
    }
    await this.createResourcePlan(foundation, productions);
    await this.createPhaseReservationSet(foundation);
    for (const production of productions) {
      await this.createProductionReservation(
        foundation,
        production,
        "RESERVED",
        resourceSnapshot,
      );
    }
    return { foundation, productions };
  }

  async createRevisionIdentity(id: string, kind: string): Promise<void> {
    await this.sql.query(
      'INSERT INTO "revision_identities" ("id", "kind", "digest") VALUES ($1, $2::"revision_kind", $3)',
      [id, kind, this.hash(`revision:${id}`)],
    );
  }

  private hash(value: string): string {
    return createHash("sha256").update(`${this.scope}:${value}`).digest("hex");
  }
}
