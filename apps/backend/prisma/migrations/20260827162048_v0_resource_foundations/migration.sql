-- CreateEnum
CREATE TYPE "revision_kind" AS ENUM ('PRINT_CONFIG', 'REFERENCE_PROFILE', 'MACHINE_PROFILE', 'MACHINE_CALIBRATION');

-- CreateEnum
CREATE TYPE "revision_state" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "material" AS ENUM ('PLA', 'PETG');

-- CreateEnum
CREATE TYPE "print_quality" AS ENUM ('DRAFT', 'STANDARD', 'FINE');

-- CreateEnum
CREATE TYPE "model_file_format" AS ENUM ('STL', '3MF', 'STEP');

-- CreateEnum
CREATE TYPE "retention_hold" AS ENUM ('NONE', 'ACTIVE_ORDER', 'ACTIVE_CLAIM', 'LEGAL');

-- CreateEnum
CREATE TYPE "photo_asset_kind" AS ENUM ('QUOTE_REFERENCE', 'QC');

-- CreateEnum
CREATE TYPE "photo_scope_kind" AS ENUM ('QUOTE_REQUEST', 'JOB');

-- CreateEnum
CREATE TYPE "preflight_severity" AS ENUM ('INFO', 'WARNING', 'BLOCKING');

-- CreateEnum
CREATE TYPE "machine_status" AS ENUM ('ACTIVE', 'MAINTENANCE', 'DISABLED');

-- CreateEnum
CREATE TYPE "inventory_status" AS ENUM ('AVAILABLE', 'DEPLETED', 'RETIRED');

-- CreateEnum
CREATE TYPE "slice_kind" AS ENUM ('REFERENCE', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "phase_reservation_set_status" AS ENUM ('BUILDING', 'RESERVED', 'HELD', 'SETTLED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "production_reservation_status" AS ENUM ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING', 'CONSUMED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "inventory_reservation_status" AS ENUM ('RESERVED', 'HELD', 'ALLOCATED', 'CONSUMED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "capacity_reservation_status" AS ENUM ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING', 'COMPLETED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "revision_identities" (
    "id" UUID NOT NULL,
    "kind" "revision_kind" NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revision_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_files" (
    "id" UUID NOT NULL,
    "format" "model_file_format" NOT NULL,
    "original_filename" VARCHAR(255) NOT NULL,
    "storage_object_key" TEXT NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL,
    "source_delete_after" TIMESTAMPTZ(3) NOT NULL,
    "retention_hold" "retention_hold" NOT NULL DEFAULT 'NONE',
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_geometries" (
    "id" UUID NOT NULL,
    "source_model_file_id" UUID NOT NULL,
    "source_selector" TEXT,
    "canonical_object_key" TEXT NOT NULL,
    "geometry_hash" VARCHAR(64) NOT NULL,
    "canonicalizer_revision" VARCHAR(64) NOT NULL,
    "volume_cubic_micrometers" BIGINT NOT NULL,
    "bounds_x_micrometers" BIGINT NOT NULL,
    "bounds_y_micrometers" BIGINT NOT NULL,
    "bounds_z_micrometers" BIGINT NOT NULL,
    "triangle_count" INTEGER NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_geometries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preflight_findings" (
    "id" UUID NOT NULL,
    "model_file_id" UUID NOT NULL,
    "model_geometry_id" UUID,
    "inspection_revision" VARCHAR(64) NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "severity" "preflight_severity" NOT NULL,
    "message" TEXT NOT NULL,
    "evidence" JSONB,
    "acknowledged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preflight_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_assets" (
    "id" UUID NOT NULL,
    "kind" "photo_asset_kind" NOT NULL,
    "scope_kind" "photo_scope_kind" NOT NULL,
    "scope_id" UUID NOT NULL,
    "storage_object_key" TEXT NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "media_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL,
    "retention_days" INTEGER NOT NULL DEFAULT 90,
    "photo_delete_after" TIMESTAMPTZ(3) NOT NULL,
    "retention_hold" "retention_hold" NOT NULL DEFAULT 'NONE',
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_config_revisions" (
    "id" UUID NOT NULL,
    "quality" "print_quality" NOT NULL,
    "infill_percent" INTEGER NOT NULL,
    "layer_height_micrometers" INTEGER NOT NULL,
    "supports_enabled" BOOLEAN NOT NULL DEFAULT false,
    "brim_enabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_config_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_profiles" (
    "id" UUID NOT NULL,
    "material" "material" NOT NULL,
    "quality" "print_quality" NOT NULL,
    "slicer_engine" VARCHAR(100) NOT NULL,
    "slicer_version" VARCHAR(100) NOT NULL,
    "settings" JSONB NOT NULL,
    "state" "revision_state" NOT NULL DEFAULT 'DRAFT',
    "activated_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_capabilities" (
    "id" UUID NOT NULL,
    "capability_key" VARCHAR(100) NOT NULL,
    "manufacturer" VARCHAR(100) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "build_volume_x_micrometers" BIGINT NOT NULL,
    "build_volume_y_micrometers" BIGINT NOT NULL,
    "build_volume_z_micrometers" BIGINT NOT NULL,
    "supported_nozzle_micrometers" INTEGER[],
    "supported_materials" "material"[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_profiles" (
    "id" UUID NOT NULL,
    "machine_capability_id" UUID NOT NULL,
    "reference_profile_id" UUID NOT NULL,
    "material" "material" NOT NULL,
    "quality" "print_quality" NOT NULL,
    "nozzle_diameter_micrometers" INTEGER NOT NULL,
    "slicer_engine" VARCHAR(100) NOT NULL,
    "slicer_version" VARCHAR(100) NOT NULL,
    "settings" JSONB NOT NULL,
    "state" "revision_state" NOT NULL DEFAULT 'DRAFT',
    "activated_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "time_zone" VARCHAR(100) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machines" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "machine_capability_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "status" "machine_status" NOT NULL DEFAULT 'ACTIVE',
    "installed_nozzle_micrometers" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_calibrations" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "flow_ratio_parts_per_million" INTEGER NOT NULL,
    "xy_compensation_micrometers" INTEGER NOT NULL,
    "elephant_foot_compensation_micrometers" INTEGER NOT NULL,
    "settings" JSONB NOT NULL,
    "state" "revision_state" NOT NULL DEFAULT 'DRAFT',
    "activated_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_calibrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventories" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "sku" VARCHAR(100) NOT NULL,
    "material" "material" NOT NULL,
    "vendor" VARCHAR(200) NOT NULL,
    "color" VARCHAR(100),
    "lot_code" VARCHAR(100),
    "price_minor_units_numerator" BIGINT NOT NULL,
    "price_minor_units_denominator" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "remaining_milligrams" BIGINT NOT NULL,
    "reserved_milligrams" BIGINT NOT NULL DEFAULT 0,
    "status" "inventory_status" NOT NULL DEFAULT 'AVAILABLE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slice_results" (
    "id" UUID NOT NULL,
    "kind" "slice_kind" NOT NULL,
    "cache_key" VARCHAR(255) NOT NULL,
    "model_geometry_id" UUID NOT NULL,
    "print_config_revision_id" UUID NOT NULL,
    "reference_profile_id" UUID,
    "machine_profile_id" UUID,
    "machine_calibration_id" UUID,
    "parts_per_plate" INTEGER NOT NULL,
    "artifact_object_key" TEXT NOT NULL,
    "artifact_hash" VARCHAR(64) NOT NULL,
    "estimated_print_seconds" BIGINT NOT NULL,
    "estimated_material_milligrams" BIGINT NOT NULL,
    "slicer_engine" VARCHAR(100) NOT NULL,
    "slicer_version" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slice_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_resource_estimates" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "estimate_key" VARCHAR(255) NOT NULL,
    "model_geometry_id" UUID NOT NULL,
    "slice_result_id" UUID NOT NULL,
    "print_config_revision_id" UUID NOT NULL,
    "machine_profile_id" UUID NOT NULL,
    "machine_calibration_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "inventory_id" UUID NOT NULL,
    "shipment_plan_id" UUID NOT NULL,
    "arrangement_revision_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "required_material_milligrams" BIGINT NOT NULL,
    "required_machine_seconds" BIGINT NOT NULL,
    "resource_snapshot" JSONB NOT NULL,
    "calculated_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "candidate_resource_estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_capacity_intervals" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "candidate_resource_estimate_id" UUID NOT NULL,
    "interval_index" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_capacity_intervals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eligibility_snapshots" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "order_phase_id" UUID NOT NULL,
    "required_fulfilment_slot_ids" JSONB NOT NULL,
    "eligible_candidate_estimate_ids" JSONB NOT NULL,
    "snapshot_hash" VARCHAR(64) NOT NULL,
    "calculated_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "eligibility_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_resource_plans" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "order_phase_id" UUID NOT NULL,
    "eligibility_snapshot_id" UUID NOT NULL,
    "plan_key" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "phase_resource_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_resource_plan_jobs" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "phase_resource_plan_id" UUID NOT NULL,
    "candidate_resource_estimate_id" UUID NOT NULL,
    "planned_job_key" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phase_resource_plan_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_resource_plan_slots" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "phase_resource_plan_id" UUID NOT NULL,
    "phase_resource_plan_job_id" UUID NOT NULL,
    "fulfilment_slot_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phase_resource_plan_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_reservation_sets" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "phase_resource_plan_id" UUID NOT NULL,
    "reservation_key" VARCHAR(255) NOT NULL,
    "status" "phase_reservation_set_status" NOT NULL DEFAULT 'BUILDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "phase_reservation_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_reservations" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "phase_reservation_set_id" UUID NOT NULL,
    "phase_resource_plan_id" UUID NOT NULL,
    "phase_resource_plan_job_id" UUID NOT NULL,
    "planned_job_key" VARCHAR(255) NOT NULL,
    "job_id" UUID,
    "machine_id" UUID NOT NULL,
    "inventory_id" UUID NOT NULL,
    "slice_result_id" UUID NOT NULL,
    "print_config_revision_id" UUID NOT NULL,
    "machine_profile_id" UUID NOT NULL,
    "machine_calibration_id" UUID NOT NULL,
    "required_material_milligrams" BIGINT NOT NULL,
    "required_machine_seconds" BIGINT NOT NULL,
    "resource_snapshot" JSONB NOT NULL,
    "status" "production_reservation_status" NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "production_reservation_id" UUID NOT NULL,
    "inventory_id" UUID NOT NULL,
    "reserved_milligrams" BIGINT NOT NULL,
    "consumed_milligrams" BIGINT,
    "status" "inventory_reservation_status" NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_reservations" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "production_reservation_id" UUID NOT NULL,
    "candidate_capacity_interval_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "capacity_reservation_status" NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "capacity_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "deduplication_key" VARCHAR(255) NOT NULL,
    "aggregate_type" VARCHAR(100) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "message_type" VARCHAR(150) NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "namespace" VARCHAR(100) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "request_fingerprint" VARCHAR(64) NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'PROCESSING',
    "response_status_code" INTEGER,
    "response_body" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "revision_identities_digest_key" ON "revision_identities"("digest");

-- CreateIndex
CREATE UNIQUE INDEX "model_files_storage_object_key_key" ON "model_files"("storage_object_key");

-- CreateIndex
CREATE INDEX "model_files_content_hash_idx" ON "model_files"("content_hash");

-- CreateIndex
CREATE INDEX "model_files_source_delete_after_retention_hold_deleted_at_idx" ON "model_files"("source_delete_after", "retention_hold", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "model_geometries_canonical_object_key_key" ON "model_geometries"("canonical_object_key");

-- CreateIndex
CREATE INDEX "model_geometries_geometry_hash_idx" ON "model_geometries"("geometry_hash");

-- CreateIndex
CREATE UNIQUE INDEX "model_geometries_id_source_model_file_id_key" ON "model_geometries"("id", "source_model_file_id");

-- CreateIndex
CREATE INDEX "model_geometries_source_model_file_id_idx" ON "model_geometries"("source_model_file_id");

-- CreateIndex
CREATE INDEX "preflight_findings_model_geometry_id_idx" ON "preflight_findings"("model_geometry_id");

-- CreateIndex
CREATE INDEX "preflight_findings_severity_acknowledged_at_idx" ON "preflight_findings"("severity", "acknowledged_at");

-- CreateIndex
CREATE UNIQUE INDEX "preflight_findings_geometry_scope_key"
    ON "preflight_findings"("model_geometry_id", "inspection_revision", "code");

CREATE UNIQUE INDEX "preflight_findings_file_scope_key"
    ON "preflight_findings"("model_file_id", "inspection_revision", "code")
    WHERE "model_geometry_id" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "photo_assets_storage_object_key_key" ON "photo_assets"("storage_object_key");

-- CreateIndex
CREATE INDEX "photo_assets_content_hash_idx" ON "photo_assets"("content_hash");

-- CreateIndex
CREATE INDEX "photo_assets_scope_kind_scope_id_idx" ON "photo_assets"("scope_kind", "scope_id");

-- CreateIndex
CREATE INDEX "photo_assets_photo_delete_after_retention_hold_deleted_at_idx" ON "photo_assets"("photo_delete_after", "retention_hold", "deleted_at");

-- CreateIndex
CREATE INDEX "print_config_revisions_quality_infill_percent_idx" ON "print_config_revisions"("quality", "infill_percent");

-- CreateIndex
CREATE INDEX "reference_profiles_material_quality_state_idx" ON "reference_profiles"("material", "quality", "state");

-- CreateIndex
CREATE UNIQUE INDEX "machine_capabilities_capability_key_key" ON "machine_capabilities"("capability_key");

-- CreateIndex
CREATE INDEX "machine_profiles_machine_capability_id_material_quality_noz_idx" ON "machine_profiles"("machine_capability_id", "material", "quality", "nozzle_diameter_micrometers", "state");

-- CreateIndex
CREATE INDEX "machine_profiles_reference_profile_id_idx" ON "machine_profiles"("reference_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_code_key" ON "nodes"("code");

-- CreateIndex
CREATE INDEX "machines_machine_capability_id_idx" ON "machines"("machine_capability_id");

-- CreateIndex
CREATE INDEX "machines_node_id_status_idx" ON "machines"("node_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "machines_node_id_code_key" ON "machines"("node_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "machines_id_node_id_key" ON "machines"("id", "node_id");

-- CreateIndex
CREATE INDEX "machine_calibrations_machine_id_state_idx" ON "machine_calibrations"("machine_id", "state");

-- CreateIndex
CREATE INDEX "machine_calibrations_node_id_state_idx" ON "machine_calibrations"("node_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "machine_calibrations_id_node_id_machine_id_key" ON "machine_calibrations"("id", "node_id", "machine_id");

-- CreateIndex
CREATE INDEX "inventories_node_id_machine_id_material_status_idx" ON "inventories"("node_id", "machine_id", "material", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventories_node_id_machine_id_sku_key" ON "inventories"("node_id", "machine_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "inventories_id_node_id_key" ON "inventories"("id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventories_id_node_id_machine_id_key" ON "inventories"("id", "node_id", "machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "slice_results_cache_key_key" ON "slice_results"("cache_key");

-- CreateIndex
CREATE UNIQUE INDEX "slice_results_artifact_object_key_key" ON "slice_results"("artifact_object_key");

-- CreateIndex
CREATE INDEX "slice_results_model_geometry_id_idx" ON "slice_results"("model_geometry_id");

-- CreateIndex
CREATE INDEX "slice_results_reference_profile_id_idx" ON "slice_results"("reference_profile_id");

-- CreateIndex
CREATE INDEX "slice_results_machine_profile_id_machine_calibration_id_idx" ON "slice_results"("machine_profile_id", "machine_calibration_id");

-- CreateIndex
CREATE UNIQUE INDEX "slice_results_id_model_geometry_id_print_config_revision_id_key" ON "slice_results"("id", "model_geometry_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_resource_estimates_estimate_key_key" ON "candidate_resource_estimates"("estimate_key");

-- CreateIndex
CREATE INDEX "candidate_resource_estimates_node_id_expires_at_idx" ON "candidate_resource_estimates"("node_id", "expires_at");

-- CreateIndex
CREATE INDEX "candidate_resource_estimates_model_geometry_id_idx" ON "candidate_resource_estimates"("model_geometry_id");

-- CreateIndex
CREATE INDEX "candidate_resource_estimates_slice_result_id_idx" ON "candidate_resource_estimates"("slice_result_id");

-- CreateIndex
CREATE INDEX "candidate_resource_estimates_machine_id_inventory_id_idx" ON "candidate_resource_estimates"("machine_id", "inventory_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_resource_estimates_id_node_id_key" ON "candidate_resource_estimates"("id", "node_id");

-- CreateIndex
CREATE INDEX "candidate_capacity_intervals_node_id_starts_at_ends_at_idx" ON "candidate_capacity_intervals"("node_id", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_capacity_intervals_candidate_resource_estimate_id_key" ON "candidate_capacity_intervals"("candidate_resource_estimate_id", "interval_index");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_capacity_intervals_id_node_id_key" ON "candidate_capacity_intervals"("id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_capacity_intervals_id_node_id_candidate_resource__key" ON "candidate_capacity_intervals"("id", "node_id", "candidate_resource_estimate_id");

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_snapshots_snapshot_hash_key" ON "eligibility_snapshots"("snapshot_hash");

-- CreateIndex
CREATE INDEX "eligibility_snapshots_node_id_order_phase_id_expires_at_idx" ON "eligibility_snapshots"("node_id", "order_phase_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_snapshots_id_node_id_key" ON "eligibility_snapshots"("id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_snapshots_id_node_id_order_phase_id_key" ON "eligibility_snapshots"("id", "node_id", "order_phase_id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_resource_plans_plan_key_key" ON "phase_resource_plans"("plan_key");

-- CreateIndex
CREATE INDEX "phase_resource_plans_node_id_order_phase_id_expires_at_idx" ON "phase_resource_plans"("node_id", "order_phase_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "phase_resource_plans_id_node_id_key" ON "phase_resource_plans"("id", "node_id");

-- CreateIndex
CREATE INDEX "phase_resource_plan_jobs_node_id_candidate_resource_estimat_idx" ON "phase_resource_plan_jobs"("node_id", "candidate_resource_estimate_id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_resource_plan_jobs_phase_resource_plan_id_planned_job_key" ON "phase_resource_plan_jobs"("phase_resource_plan_id", "planned_job_key");

-- CreateIndex
CREATE UNIQUE INDEX "phase_resource_plan_jobs_id_node_id_key" ON "phase_resource_plan_jobs"("id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_resource_plan_jobs_id_node_id_phase_resource_plan_id_key" ON "phase_resource_plan_jobs"("id", "node_id", "phase_resource_plan_id");

-- CreateIndex
CREATE INDEX "phase_resource_plan_slots_node_id_phase_resource_plan_job_i_idx" ON "phase_resource_plan_slots"("node_id", "phase_resource_plan_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_resource_plan_slots_phase_resource_plan_id_fulfilment_key" ON "phase_resource_plan_slots"("phase_resource_plan_id", "fulfilment_slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_reservation_sets_reservation_key_key" ON "phase_reservation_sets"("reservation_key");

-- CreateIndex
CREATE INDEX "phase_reservation_sets_node_id_expires_at_status_idx" ON "phase_reservation_sets"("node_id", "expires_at", "status");

-- CreateIndex
CREATE INDEX "phase_reservation_sets_phase_resource_plan_id_idx" ON "phase_reservation_sets"("phase_resource_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_reservation_sets_id_node_id_key" ON "phase_reservation_sets"("id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_reservation_sets_id_node_id_phase_resource_plan_id_key" ON "phase_reservation_sets"("id", "node_id", "phase_resource_plan_id");

-- CreateIndex
CREATE INDEX "production_reservations_node_id_status_expires_at_idx" ON "production_reservations"("node_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "production_reservations_machine_id_idx" ON "production_reservations"("machine_id");

-- CreateIndex
CREATE INDEX "production_reservations_inventory_id_idx" ON "production_reservations"("inventory_id");

-- CreateIndex
CREATE INDEX "production_reservations_slice_result_id_idx" ON "production_reservations"("slice_result_id");

-- CreateIndex
CREATE INDEX "production_reservations_machine_calibration_id_idx" ON "production_reservations"("machine_calibration_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_reservations_id_node_id_key" ON "production_reservations"("id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_reservations_id_node_id_machine_id_key" ON "production_reservations"("id", "node_id", "machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_reservations_job_id_key" ON "production_reservations"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_reservations_phase_reservation_set_id_phase_reso_key" ON "production_reservations"("phase_reservation_set_id", "phase_resource_plan_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_reservations_phase_reservation_set_id_planned_jo_key" ON "production_reservations"("phase_reservation_set_id", "planned_job_key");

-- CreateIndex
CREATE INDEX "inventory_reservations_node_id_inventory_id_status_expires__idx" ON "inventory_reservations"("node_id", "inventory_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_id_node_id_key" ON "inventory_reservations"("id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_production_reservation_id_node_id_key" ON "inventory_reservations"("production_reservation_id", "node_id");

-- CreateIndex
CREATE INDEX "capacity_reservations_node_id_machine_id_status_starts_at_e_idx" ON "capacity_reservations"("node_id", "machine_id", "status", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "capacity_reservations_expires_at_status_idx" ON "capacity_reservations"("expires_at", "status");

-- CreateIndex
CREATE UNIQUE INDEX "capacity_reservations_id_node_id_key" ON "capacity_reservations"("id", "node_id");

-- CreateIndex
CREATE INDEX "capacity_reservations_node_id_candidate_capacity_interval_i_idx" ON "capacity_reservations"("node_id", "candidate_capacity_interval_id");

-- CreateIndex
CREATE UNIQUE INDEX "capacity_reservations_production_reservation_id_candidate_c_key" ON "capacity_reservations"("production_reservation_id", "candidate_capacity_interval_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_deduplication_key_key" ON "outbox_messages"("deduplication_key");

-- CreateIndex
CREATE INDEX "outbox_messages_status_available_at_idx" ON "outbox_messages"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_messages_aggregate_type_aggregate_id_idx" ON "outbox_messages"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_namespace_idempotency_key_key" ON "idempotency_records"("namespace", "idempotency_key");

-- AddForeignKey
ALTER TABLE "model_geometries" ADD CONSTRAINT "model_geometries_source_model_file_id_fkey" FOREIGN KEY ("source_model_file_id") REFERENCES "model_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preflight_findings" ADD CONSTRAINT "preflight_findings_model_file_id_fkey" FOREIGN KEY ("model_file_id") REFERENCES "model_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preflight_findings" ADD CONSTRAINT "preflight_findings_model_geometry_id_model_file_id_fkey" FOREIGN KEY ("model_geometry_id", "model_file_id") REFERENCES "model_geometries"("id", "source_model_file_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_config_revisions" ADD CONSTRAINT "print_config_revisions_id_fkey" FOREIGN KEY ("id") REFERENCES "revision_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_profiles" ADD CONSTRAINT "reference_profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "revision_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_profiles" ADD CONSTRAINT "machine_profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "revision_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_profiles" ADD CONSTRAINT "machine_profiles_machine_capability_id_fkey" FOREIGN KEY ("machine_capability_id") REFERENCES "machine_capabilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_profiles" ADD CONSTRAINT "machine_profiles_reference_profile_id_fkey" FOREIGN KEY ("reference_profile_id") REFERENCES "reference_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_machine_capability_id_fkey" FOREIGN KEY ("machine_capability_id") REFERENCES "machine_capabilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_calibrations" ADD CONSTRAINT "machine_calibrations_id_fkey" FOREIGN KEY ("id") REFERENCES "revision_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_calibrations" ADD CONSTRAINT "machine_calibrations_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_calibrations" ADD CONSTRAINT "machine_calibrations_machine_id_node_id_fkey" FOREIGN KEY ("machine_id", "node_id") REFERENCES "machines"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_machine_id_node_id_fkey" FOREIGN KEY ("machine_id", "node_id") REFERENCES "machines"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slice_results" ADD CONSTRAINT "slice_results_model_geometry_id_fkey" FOREIGN KEY ("model_geometry_id") REFERENCES "model_geometries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slice_results" ADD CONSTRAINT "slice_results_print_config_revision_id_fkey" FOREIGN KEY ("print_config_revision_id") REFERENCES "print_config_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slice_results" ADD CONSTRAINT "slice_results_reference_profile_id_fkey" FOREIGN KEY ("reference_profile_id") REFERENCES "reference_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slice_results" ADD CONSTRAINT "slice_results_machine_profile_id_fkey" FOREIGN KEY ("machine_profile_id") REFERENCES "machine_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slice_results" ADD CONSTRAINT "slice_results_machine_calibration_id_fkey" FOREIGN KEY ("machine_calibration_id") REFERENCES "machine_calibrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_resource_estimates" ADD CONSTRAINT "candidate_resource_estimates_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_resource_estimates" ADD CONSTRAINT "candidate_resource_estimates_model_geometry_id_fkey" FOREIGN KEY ("model_geometry_id") REFERENCES "model_geometries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_resource_estimates" ADD CONSTRAINT "candidate_resource_estimates_slice_result_id_model_geometr_fkey" FOREIGN KEY ("slice_result_id", "model_geometry_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id") REFERENCES "slice_results"("id", "model_geometry_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_resource_estimates" ADD CONSTRAINT "candidate_resource_estimates_print_config_revision_id_fkey" FOREIGN KEY ("print_config_revision_id") REFERENCES "print_config_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_resource_estimates" ADD CONSTRAINT "candidate_resource_estimates_machine_profile_id_fkey" FOREIGN KEY ("machine_profile_id") REFERENCES "machine_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_resource_estimates" ADD CONSTRAINT "candidate_resource_estimates_machine_calibration_id_node_i_fkey" FOREIGN KEY ("machine_calibration_id", "node_id", "machine_id") REFERENCES "machine_calibrations"("id", "node_id", "machine_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_resource_estimates" ADD CONSTRAINT "candidate_resource_estimates_machine_id_node_id_fkey" FOREIGN KEY ("machine_id", "node_id") REFERENCES "machines"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_resource_estimates" ADD CONSTRAINT "candidate_resource_estimates_inventory_id_node_id_machine__fkey" FOREIGN KEY ("inventory_id", "node_id", "machine_id") REFERENCES "inventories"("id", "node_id", "machine_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_capacity_intervals" ADD CONSTRAINT "candidate_capacity_intervals_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_capacity_intervals" ADD CONSTRAINT "candidate_capacity_intervals_candidate_resource_estimate_i_fkey" FOREIGN KEY ("candidate_resource_estimate_id", "node_id") REFERENCES "candidate_resource_estimates"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_snapshots" ADD CONSTRAINT "eligibility_snapshots_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_resource_plans" ADD CONSTRAINT "phase_resource_plans_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_resource_plans" ADD CONSTRAINT "phase_resource_plans_eligibility_snapshot_id_node_id_order_fkey" FOREIGN KEY ("eligibility_snapshot_id", "node_id", "order_phase_id") REFERENCES "eligibility_snapshots"("id", "node_id", "order_phase_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_resource_plan_jobs" ADD CONSTRAINT "phase_resource_plan_jobs_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_resource_plan_jobs" ADD CONSTRAINT "phase_resource_plan_jobs_phase_resource_plan_id_node_id_fkey" FOREIGN KEY ("phase_resource_plan_id", "node_id") REFERENCES "phase_resource_plans"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_resource_plan_jobs" ADD CONSTRAINT "phase_resource_plan_jobs_candidate_resource_estimate_id_no_fkey" FOREIGN KEY ("candidate_resource_estimate_id", "node_id") REFERENCES "candidate_resource_estimates"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_resource_plan_slots" ADD CONSTRAINT "phase_resource_plan_slots_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_resource_plan_slots" ADD CONSTRAINT "phase_resource_plan_slots_phase_resource_plan_id_node_id_fkey" FOREIGN KEY ("phase_resource_plan_id", "node_id") REFERENCES "phase_resource_plans"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_resource_plan_slots" ADD CONSTRAINT "phase_resource_plan_slots_phase_resource_plan_job_id_node__fkey" FOREIGN KEY ("phase_resource_plan_job_id", "node_id", "phase_resource_plan_id") REFERENCES "phase_resource_plan_jobs"("id", "node_id", "phase_resource_plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_reservation_sets" ADD CONSTRAINT "phase_reservation_sets_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_reservation_sets" ADD CONSTRAINT "phase_reservation_sets_phase_resource_plan_id_node_id_fkey" FOREIGN KEY ("phase_resource_plan_id", "node_id") REFERENCES "phase_resource_plans"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_phase_reservation_set_id_node_id_p_fkey" FOREIGN KEY ("phase_reservation_set_id", "node_id", "phase_resource_plan_id") REFERENCES "phase_reservation_sets"("id", "node_id", "phase_resource_plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_phase_resource_plan_id_node_id_fkey" FOREIGN KEY ("phase_resource_plan_id", "node_id") REFERENCES "phase_resource_plans"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_phase_resource_plan_job_id_node_id_fkey" FOREIGN KEY ("phase_resource_plan_job_id", "node_id", "phase_resource_plan_id") REFERENCES "phase_resource_plan_jobs"("id", "node_id", "phase_resource_plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_machine_id_node_id_fkey" FOREIGN KEY ("machine_id", "node_id") REFERENCES "machines"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_inventory_id_node_id_machine_id_fkey" FOREIGN KEY ("inventory_id", "node_id", "machine_id") REFERENCES "inventories"("id", "node_id", "machine_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_slice_result_id_fkey" FOREIGN KEY ("slice_result_id") REFERENCES "slice_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_print_config_revision_id_fkey" FOREIGN KEY ("print_config_revision_id") REFERENCES "print_config_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_machine_profile_id_fkey" FOREIGN KEY ("machine_profile_id") REFERENCES "machine_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_machine_calibration_id_node_id_mac_fkey" FOREIGN KEY ("machine_calibration_id", "node_id", "machine_id") REFERENCES "machine_calibrations"("id", "node_id", "machine_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_production_reservation_id_node_id_fkey" FOREIGN KEY ("production_reservation_id", "node_id") REFERENCES "production_reservations"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_inventory_id_node_id_fkey" FOREIGN KEY ("inventory_id", "node_id") REFERENCES "inventories"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_reservations" ADD CONSTRAINT "capacity_reservations_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_reservations" ADD CONSTRAINT "capacity_reservations_production_reservation_id_node_id_ma_fkey" FOREIGN KEY ("production_reservation_id", "node_id", "machine_id") REFERENCES "production_reservations"("id", "node_id", "machine_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_reservations" ADD CONSTRAINT "capacity_reservations_candidate_capacity_interval_id_node__fkey" FOREIGN KEY ("candidate_capacity_interval_id", "node_id") REFERENCES "candidate_capacity_intervals"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_reservations" ADD CONSTRAINT "capacity_reservations_machine_id_node_id_fkey" FOREIGN KEY ("machine_id", "node_id") REFERENCES "machines"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PostgreSQL-native invariants that Prisma cannot express.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "model_files"
    ADD CONSTRAINT "model_files_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "model_files_size_bytes_check" CHECK ("size_bytes" > 0),
    ADD CONSTRAINT "model_files_deletion_deadline_check" CHECK ("source_delete_after" >= "uploaded_at"),
    ADD CONSTRAINT "model_files_deleted_at_check" CHECK (
        "deleted_at" IS NULL OR (
            "deleted_at" >= "source_delete_after" AND
            "retention_hold" = 'NONE'
        )
    );

ALTER TABLE "model_geometries"
    ADD CONSTRAINT "model_geometries_geometry_hash_check" CHECK ("geometry_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "model_geometries_dimensions_check" CHECK (
        "volume_cubic_micrometers" > 0 AND
        "bounds_x_micrometers" > 0 AND
        "bounds_y_micrometers" > 0 AND
        "bounds_z_micrometers" > 0 AND
        "triangle_count" > 0
    );

ALTER TABLE "photo_assets"
    ADD CONSTRAINT "photo_assets_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "photo_assets_size_bytes_check" CHECK ("size_bytes" > 0),
    ADD CONSTRAINT "photo_assets_retention_days_check" CHECK ("retention_days" > 0),
    ADD CONSTRAINT "photo_assets_deletion_deadline_check" CHECK ("photo_delete_after" >= "uploaded_at"),
    ADD CONSTRAINT "photo_assets_deleted_at_check" CHECK (
        "deleted_at" IS NULL OR (
            "deleted_at" >= "photo_delete_after" AND
            "retention_hold" = 'NONE'
        )
    );

ALTER TABLE "revision_identities"
    ADD CONSTRAINT "revision_identities_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$');

ALTER TABLE "print_config_revisions"
    ADD CONSTRAINT "print_config_revisions_values_check" CHECK (
        "infill_percent" BETWEEN 1 AND 100 AND
        "layer_height_micrometers" > 0
    );

ALTER TABLE "reference_profiles"
    ADD CONSTRAINT "reference_profiles_slicer_identity_check" CHECK (
        btrim("slicer_engine") <> '' AND
        btrim("slicer_version") <> ''
    ),
    ADD CONSTRAINT "reference_profiles_lifecycle_check" CHECK (
        ("state" = 'DRAFT' AND "activated_at" IS NULL AND "retired_at" IS NULL) OR
        ("state" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "retired_at" IS NULL) OR
        ("state" = 'RETIRED' AND "activated_at" IS NOT NULL AND "retired_at" >= "activated_at")
    );

ALTER TABLE "machine_capabilities"
    ADD CONSTRAINT "machine_capabilities_dimensions_check" CHECK (
        "build_volume_x_micrometers" > 0 AND
        "build_volume_y_micrometers" > 0 AND
        "build_volume_z_micrometers" > 0 AND
        "supported_nozzle_micrometers" IS NOT NULL AND
        cardinality("supported_nozzle_micrometers") > 0 AND
        "supported_materials" IS NOT NULL AND
        cardinality("supported_materials") > 0
    );

ALTER TABLE "machine_profiles"
    ADD CONSTRAINT "machine_profiles_values_check" CHECK ("nozzle_diameter_micrometers" > 0),
    ADD CONSTRAINT "machine_profiles_slicer_identity_check" CHECK (
        btrim("slicer_engine") <> '' AND
        btrim("slicer_version") <> ''
    ),
    ADD CONSTRAINT "machine_profiles_lifecycle_check" CHECK (
        ("state" = 'DRAFT' AND "activated_at" IS NULL AND "retired_at" IS NULL) OR
        ("state" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "retired_at" IS NULL) OR
        ("state" = 'RETIRED' AND "activated_at" IS NOT NULL AND "retired_at" >= "activated_at")
    );

ALTER TABLE "machines"
    ADD CONSTRAINT "machines_nozzle_check" CHECK ("installed_nozzle_micrometers" > 0);

ALTER TABLE "machine_calibrations"
    ADD CONSTRAINT "machine_calibrations_values_check" CHECK ("flow_ratio_parts_per_million" > 0),
    ADD CONSTRAINT "machine_calibrations_lifecycle_check" CHECK (
        ("state" = 'DRAFT' AND "activated_at" IS NULL AND "retired_at" IS NULL) OR
        ("state" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "retired_at" IS NULL) OR
        ("state" = 'RETIRED' AND "activated_at" IS NOT NULL AND "retired_at" >= "activated_at")
    );

ALTER TABLE "inventories"
    ADD CONSTRAINT "inventories_price_check" CHECK (
        "price_minor_units_numerator" >= 0 AND
        "price_minor_units_denominator" > 0
    ),
    ADD CONSTRAINT "inventories_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "inventories_balance_check" CHECK (
        "remaining_milligrams" >= 0 AND
        "reserved_milligrams" >= 0 AND
        "reserved_milligrams" <= "remaining_milligrams"
    );

ALTER TABLE "slice_results"
    ADD CONSTRAINT "slice_results_artifact_hash_check" CHECK ("artifact_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "slice_results_slicer_identity_check" CHECK (
        btrim("slicer_engine") <> '' AND
        btrim("slicer_version") <> ''
    ),
    ADD CONSTRAINT "slice_results_values_check" CHECK (
        "parts_per_plate" > 0 AND
        "estimated_print_seconds" > 0 AND
        "estimated_material_milligrams" > 0
    ),
    ADD CONSTRAINT "slice_results_profile_shape_check" CHECK (
        ("kind" = 'REFERENCE' AND "reference_profile_id" IS NOT NULL AND "machine_profile_id" IS NULL AND "machine_calibration_id" IS NULL) OR
        ("kind" = 'PRODUCTION' AND "reference_profile_id" IS NULL AND "machine_profile_id" IS NOT NULL AND "machine_calibration_id" IS NOT NULL)
    );

ALTER TABLE "candidate_resource_estimates"
    ADD CONSTRAINT "candidate_resource_estimates_values_check" CHECK (
        "quantity" > 0 AND
        "required_material_milligrams" > 0 AND
        "required_machine_seconds" > 0 AND
        "expires_at" > "calculated_at"
    );

CREATE FUNCTION taven_validate_candidate_resource_quantities()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "slice_results" selected_slice
        WHERE selected_slice."id" = NEW."slice_result_id"
          AND selected_slice."kind" = 'PRODUCTION'
          AND selected_slice."model_geometry_id" = NEW."model_geometry_id"
          AND selected_slice."print_config_revision_id" = NEW."print_config_revision_id"
          AND selected_slice."machine_profile_id" = NEW."machine_profile_id"
          AND selected_slice."machine_calibration_id" = NEW."machine_calibration_id"
          AND NEW."required_material_milligrams"::numeric >=
              selected_slice."estimated_material_milligrams"::numeric *
              ceil(NEW."quantity"::numeric / selected_slice."parts_per_plate"::numeric)
          AND NEW."required_machine_seconds"::numeric >=
              selected_slice."estimated_print_seconds"::numeric *
              ceil(NEW."quantity"::numeric / selected_slice."parts_per_plate"::numeric)
    ) THEN
        RAISE EXCEPTION 'candidate aggregate quantities understate the selected production slice'
            USING ERRCODE = '23514', CONSTRAINT = 'candidate_resource_quantity_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "candidate_resource_estimates_quantities"
    BEFORE INSERT ON "candidate_resource_estimates"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_candidate_resource_quantities();

ALTER TABLE "candidate_capacity_intervals"
    ADD CONSTRAINT "candidate_capacity_intervals_values_check" CHECK (
        "interval_index" >= 0 AND
        "ends_at" > "starts_at"
    );

CREATE FUNCTION taven_is_uuid_string_set(payload jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN jsonb_typeof(payload) IS DISTINCT FROM 'array' THEN false
        ELSE
            NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(payload) element
                WHERE jsonb_typeof(element) <> 'string'
                   OR element #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            )
            AND jsonb_array_length(payload) = (
                SELECT count(DISTINCT element #>> '{}')
                FROM jsonb_array_elements(payload) element
            )
    END;
$$;

ALTER TABLE "eligibility_snapshots"
    ADD CONSTRAINT "eligibility_snapshots_hash_check" CHECK ("snapshot_hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "eligibility_snapshots_required_slots_uuid_set_check"
        CHECK (taven_is_uuid_string_set("required_fulfilment_slot_ids")),
    ADD CONSTRAINT "eligibility_snapshots_eligible_candidates_uuid_set_check"
        CHECK (taven_is_uuid_string_set("eligible_candidate_estimate_ids")),
    ADD CONSTRAINT "eligibility_snapshots_expiry_check" CHECK ("expires_at" > "calculated_at");

ALTER TABLE "phase_resource_plans"
    ADD CONSTRAINT "phase_resource_plans_expiry_check" CHECK ("expires_at" > "created_at");

ALTER TABLE "phase_reservation_sets"
    ADD CONSTRAINT "phase_reservation_sets_expiry_check" CHECK ("expires_at" > "created_at");

ALTER TABLE "production_reservations"
    ADD CONSTRAINT "production_reservations_values_check" CHECK (
        "required_material_milligrams" > 0 AND
        "required_machine_seconds" > 0 AND
        "expires_at" > "created_at"
    );

ALTER TABLE "inventory_reservations"
    ADD CONSTRAINT "inventory_reservations_values_check" CHECK (
        "reserved_milligrams" > 0 AND
        ("consumed_milligrams" IS NULL OR (
            "consumed_milligrams" >= 0 AND
            "consumed_milligrams" <= "reserved_milligrams"
        )) AND
        (("status" = 'CONSUMED') = ("consumed_milligrams" IS NOT NULL)) AND
        "expires_at" > "created_at"
    );

ALTER TABLE "capacity_reservations"
    ADD CONSTRAINT "capacity_reservations_interval_check" CHECK ("ends_at" > "starts_at"),
    ADD CONSTRAINT "capacity_reservations_expiry_check" CHECK ("expires_at" > "created_at");

ALTER TABLE "outbox_messages"
    ADD CONSTRAINT "outbox_messages_values_check" CHECK (
        "schema_version" > 0 AND
        "attempts" >= 0 AND
        (("status" = 'DELIVERED') = ("delivered_at" IS NOT NULL))
    );

ALTER TABLE "idempotency_records"
    ADD CONSTRAINT "idempotency_records_fingerprint_check" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "idempotency_records_expiry_check" CHECK ("expires_at" > "created_at"),
    ADD CONSTRAINT "idempotency_records_response_check" CHECK (
        ("status" = 'COMPLETED' AND "response_status_code" IS NOT NULL) OR
        ("status" <> 'COMPLETED' AND "response_status_code" IS NULL AND "response_body" IS NULL)
    );

CREATE FUNCTION taven_validate_slice_profile_compatibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    requested_quality "print_quality";
    selected_quality "print_quality";
    selected_state "revision_state";
    selected_slicer_engine varchar(100);
    selected_slicer_version varchar(100);
BEGIN
    SELECT print_config."quality"
    INTO requested_quality
    FROM "print_config_revisions" print_config
    WHERE print_config."id" = NEW."print_config_revision_id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NEW."kind" = 'REFERENCE' THEN
        SELECT
            reference_profile."quality",
            reference_profile."state",
            reference_profile."slicer_engine",
            reference_profile."slicer_version"
        INTO
            selected_quality,
            selected_state,
            selected_slicer_engine,
            selected_slicer_version
        FROM "reference_profiles" reference_profile
        WHERE reference_profile."id" = NEW."reference_profile_id"
        FOR SHARE;

        IF NOT FOUND THEN
            RETURN NEW;
        END IF;

        IF selected_state <> 'ACTIVE' THEN
            RAISE EXCEPTION 'reference slice must use an active reference profile'
                USING ERRCODE = '23514', CONSTRAINT = 'slice_results_reference_profile_active_check';
        END IF;

        IF selected_quality IS DISTINCT FROM requested_quality THEN
            RAISE EXCEPTION 'reference slice print configuration and reference profile quality must match'
                USING ERRCODE = '23514', CONSTRAINT = 'slice_results_reference_quality_check';
        END IF;

        IF selected_slicer_engine IS DISTINCT FROM NEW."slicer_engine"
           OR selected_slicer_version IS DISTINCT FROM NEW."slicer_version" THEN
            RAISE EXCEPTION 'reference slice slicer identity must match its reference profile'
                USING ERRCODE = '23514', CONSTRAINT = 'slice_results_reference_slicer_check';
        END IF;
    ELSE
        SELECT
            machine_profile."quality",
            machine_profile."slicer_engine",
            machine_profile."slicer_version"
        INTO
            selected_quality,
            selected_slicer_engine,
            selected_slicer_version
        FROM "machine_profiles" machine_profile
        WHERE machine_profile."id" = NEW."machine_profile_id"
        FOR SHARE;

        IF NOT FOUND THEN
            RETURN NEW;
        END IF;

        IF selected_quality IS DISTINCT FROM requested_quality THEN
            RAISE EXCEPTION 'production slice print configuration and machine profile quality must match'
                USING ERRCODE = '23514', CONSTRAINT = 'slice_results_production_quality_check';
        END IF;

        IF selected_slicer_engine IS DISTINCT FROM NEW."slicer_engine"
           OR selected_slicer_version IS DISTINCT FROM NEW."slicer_version" THEN
            RAISE EXCEPTION 'production slice slicer identity must match its machine profile'
                USING ERRCODE = '23514', CONSTRAINT = 'slice_results_production_slicer_check';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "slice_results_profile_compatibility"
    BEFORE INSERT ON "slice_results"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_slice_profile_compatibility();

CREATE UNIQUE INDEX "reference_profiles_active_material_quality_key"
    ON "reference_profiles" ("material", "quality")
    WHERE "state" = 'ACTIVE';

CREATE UNIQUE INDEX "machine_profiles_active_capability_material_quality_nozzle_key"
    ON "machine_profiles" (
        "machine_capability_id",
        "material",
        "quality",
        "nozzle_diameter_micrometers"
    )
    WHERE "state" = 'ACTIVE';

CREATE UNIQUE INDEX "machine_calibrations_active_machine_key"
    ON "machine_calibrations" ("node_id", "machine_id")
    WHERE "state" = 'ACTIVE';

CREATE UNIQUE INDEX "phase_reservation_sets_one_active_plan_key"
    ON "phase_reservation_sets" ("phase_resource_plan_id")
    WHERE "status" IN ('BUILDING', 'RESERVED', 'HELD');

ALTER TABLE "capacity_reservations"
    ADD CONSTRAINT "capacity_reservations_no_active_overlap"
    EXCLUDE USING gist (
        "node_id" WITH =,
        "machine_id" WITH =,
        tstzrange("starts_at", "ends_at", '[)') WITH &&
    )
    WHERE ("status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING'));

CREATE FUNCTION taven_assert_revision_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_kind "revision_kind";
    actual_kind "revision_kind";
BEGIN
    expected_kind := CASE TG_TABLE_NAME
        WHEN 'print_config_revisions' THEN 'PRINT_CONFIG'::"revision_kind"
        WHEN 'reference_profiles' THEN 'REFERENCE_PROFILE'::"revision_kind"
        WHEN 'machine_profiles' THEN 'MACHINE_PROFILE'::"revision_kind"
        WHEN 'machine_calibrations' THEN 'MACHINE_CALIBRATION'::"revision_kind"
    END;

    SELECT "kind" INTO actual_kind
    FROM "revision_identities"
    WHERE "id" = NEW."id";

    IF actual_kind IS DISTINCT FROM expected_kind THEN
        RAISE EXCEPTION 'revision identity % has kind %, expected %', NEW."id", actual_kind, expected_kind
            USING ERRCODE = '23514', CONSTRAINT = 'revision_identity_kind_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "print_config_revisions_kind_check"
    BEFORE INSERT ON "print_config_revisions"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_revision_kind();
CREATE TRIGGER "reference_profiles_kind_check"
    BEFORE INSERT ON "reference_profiles"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_revision_kind();
CREATE TRIGGER "machine_profiles_kind_check"
    BEFORE INSERT ON "machine_profiles"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_revision_kind();
CREATE TRIGGER "machine_calibrations_kind_check"
    BEFORE INSERT ON "machine_calibrations"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_revision_kind();

CREATE FUNCTION taven_assert_machine_profile_compatibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "reference_profiles" reference_profile
        JOIN "machine_capabilities" capability
          ON capability."id" = NEW."machine_capability_id"
        WHERE reference_profile."id" = NEW."reference_profile_id"
          AND reference_profile."material" = NEW."material"
          AND reference_profile."quality" = NEW."quality"
          AND NEW."material" = ANY(capability."supported_materials")
          AND NEW."nozzle_diameter_micrometers" = ANY(capability."supported_nozzle_micrometers")
    ) THEN
        RAISE EXCEPTION 'machine profile material, quality, or nozzle is incompatible'
            USING ERRCODE = '23514', CONSTRAINT = 'machine_profile_compatibility_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "machine_profiles_compatibility"
    BEFORE INSERT ON "machine_profiles"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_machine_profile_compatibility();

CREATE FUNCTION taven_assert_machine_nozzle_compatibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "machine_capabilities" capability
        WHERE capability."id" = NEW."machine_capability_id"
          AND NEW."installed_nozzle_micrometers" = ANY(capability."supported_nozzle_micrometers")
    ) THEN
        RAISE EXCEPTION 'installed nozzle is not supported by the machine capability'
            USING ERRCODE = '23514', CONSTRAINT = 'machine_installed_nozzle_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "machines_resource_compatibility"
    BEFORE INSERT OR UPDATE ON "machines"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_machine_nozzle_compatibility();

CREATE FUNCTION taven_assert_inventory_machine_compatibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "machines" machine
        JOIN "machine_capabilities" capability
          ON capability."id" = machine."machine_capability_id"
        WHERE machine."id" = NEW."machine_id"
          AND machine."node_id" = NEW."node_id"
          AND NEW."material" = ANY(capability."supported_materials")
    ) THEN
        RAISE EXCEPTION 'inventory material is not supported by the concrete machine'
            USING ERRCODE = '23514', CONSTRAINT = 'inventory_machine_material_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "inventories_resource_compatibility"
    BEFORE INSERT OR UPDATE ON "inventories"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_inventory_machine_compatibility();

CREATE FUNCTION taven_geometry_fits_machine_capability(
    requested_geometry_id uuid,
    requested_capability_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE((
        SELECT
            (
                geometry."bounds_x_micrometers" <= capability."build_volume_x_micrometers" AND
                geometry."bounds_y_micrometers" <= capability."build_volume_y_micrometers" AND
                geometry."bounds_z_micrometers" <= capability."build_volume_z_micrometers"
            ) OR (
                geometry."bounds_x_micrometers" <= capability."build_volume_x_micrometers" AND
                geometry."bounds_y_micrometers" <= capability."build_volume_z_micrometers" AND
                geometry."bounds_z_micrometers" <= capability."build_volume_y_micrometers"
            ) OR (
                geometry."bounds_x_micrometers" <= capability."build_volume_y_micrometers" AND
                geometry."bounds_y_micrometers" <= capability."build_volume_x_micrometers" AND
                geometry."bounds_z_micrometers" <= capability."build_volume_z_micrometers"
            ) OR (
                geometry."bounds_x_micrometers" <= capability."build_volume_y_micrometers" AND
                geometry."bounds_y_micrometers" <= capability."build_volume_z_micrometers" AND
                geometry."bounds_z_micrometers" <= capability."build_volume_x_micrometers"
            ) OR (
                geometry."bounds_x_micrometers" <= capability."build_volume_z_micrometers" AND
                geometry."bounds_y_micrometers" <= capability."build_volume_x_micrometers" AND
                geometry."bounds_z_micrometers" <= capability."build_volume_y_micrometers"
            ) OR (
                geometry."bounds_x_micrometers" <= capability."build_volume_z_micrometers" AND
                geometry."bounds_y_micrometers" <= capability."build_volume_y_micrometers" AND
                geometry."bounds_z_micrometers" <= capability."build_volume_x_micrometers"
            )
        FROM "model_geometries" geometry
        CROSS JOIN "machine_capabilities" capability
        WHERE geometry."id" = requested_geometry_id
          AND capability."id" = requested_capability_id
    ), false);
$$;

CREATE FUNCTION taven_assert_candidate_resource_compatibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM "nodes"
    WHERE "id" = NEW."node_id"
    FOR SHARE;

    IF NOT EXISTS (
        SELECT 1
        FROM "nodes" node
        JOIN "machine_profiles" machine_profile
          ON true
        JOIN "machines" machine
          ON machine."id" = NEW."machine_id"
         AND machine."node_id" = NEW."node_id"
        JOIN "inventories" inventory
          ON inventory."id" = NEW."inventory_id"
         AND inventory."node_id" = NEW."node_id"
         AND inventory."machine_id" = NEW."machine_id"
        JOIN "machine_calibrations" calibration
          ON calibration."id" = NEW."machine_calibration_id"
         AND calibration."node_id" = NEW."node_id"
         AND calibration."machine_id" = NEW."machine_id"
        JOIN "print_config_revisions" print_config
          ON print_config."id" = NEW."print_config_revision_id"
        WHERE node."id" = NEW."node_id"
          AND node."active"
          AND machine_profile."id" = NEW."machine_profile_id"
          AND machine_profile."machine_capability_id" = machine."machine_capability_id"
          AND machine_profile."nozzle_diameter_micrometers" = machine."installed_nozzle_micrometers"
          AND machine_profile."material" = inventory."material"
          AND machine_profile."quality" = print_config."quality"
          AND taven_geometry_fits_machine_capability(
              NEW."model_geometry_id",
              machine."machine_capability_id"
          )
          AND machine_profile."state" = 'ACTIVE'
          AND calibration."state" = 'ACTIVE'
          AND machine."status" = 'ACTIVE'
          AND inventory."status" = 'AVAILABLE'
    ) THEN
        RAISE EXCEPTION 'candidate profile, calibration, machine, or inventory is incompatible or inactive'
            USING ERRCODE = '23514', CONSTRAINT = 'candidate_resource_compatibility_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "candidate_resource_estimates_compatibility"
    BEFORE INSERT ON "candidate_resource_estimates"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_candidate_resource_compatibility();

CREATE FUNCTION taven_assert_model_geometry_source_available()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_deadline timestamptz;
    source_hold "retention_hold";
    source_deleted_at timestamptz;
BEGIN
    SELECT
        source."source_delete_after",
        source."retention_hold",
        source."deleted_at"
    INTO source_deadline, source_hold, source_deleted_at
    FROM "model_files" source
    WHERE source."id" = NEW."source_model_file_id"
    FOR SHARE;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NEW."deleted_at" IS NOT NULL
       OR source_deleted_at IS NOT NULL
       OR (source_hold = 'NONE' AND source_deadline <= clock_timestamp()) THEN
        RAISE EXCEPTION 'model geometry % cannot use expired or deleted source %', NEW."id", NEW."source_model_file_id"
            USING ERRCODE = '23514', CONSTRAINT = 'model_geometry_source_available_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "model_geometries_source_available"
    BEFORE INSERT ON "model_geometries"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_model_geometry_source_available();

CREATE FUNCTION taven_assert_geometry_usage_available()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_id uuid;
    source_deadline timestamptz;
    source_hold "retention_hold";
    source_deleted_at timestamptz;
    geometry_deleted_at timestamptz;
BEGIN
    SELECT geometry."source_model_file_id"
    INTO source_id
    FROM "model_geometries" geometry
    WHERE geometry."id" = NEW."model_geometry_id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT
        source."source_delete_after",
        source."retention_hold",
        source."deleted_at"
    INTO source_deadline, source_hold, source_deleted_at
    FROM "model_files" source
    WHERE source."id" = source_id
    FOR SHARE;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT geometry."deleted_at"
    INTO geometry_deleted_at
    FROM "model_geometries" geometry
    WHERE geometry."id" = NEW."model_geometry_id"
    FOR SHARE;

    IF source_deleted_at IS NOT NULL
       OR geometry_deleted_at IS NOT NULL
       OR (source_hold = 'NONE' AND source_deadline <= clock_timestamp()) THEN
        RAISE EXCEPTION '% cannot use geometry % after source % expires or is deleted', TG_TABLE_NAME, NEW."model_geometry_id", source_id
            USING ERRCODE = '23514', CONSTRAINT = 'model_geometry_source_available_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "slice_results_geometry_source_available"
    BEFORE INSERT ON "slice_results"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_geometry_usage_available();
CREATE TRIGGER "candidate_resource_estimates_geometry_source_available"
    BEFORE INSERT ON "candidate_resource_estimates"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_geometry_usage_available();

CREATE FUNCTION taven_validate_model_geometry_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_deleted_at timestamptz;
BEGIN
    IF NEW."deleted_at" IS NOT DISTINCT FROM OLD."deleted_at" THEN
        RETURN NEW;
    END IF;

    IF OLD."deleted_at" IS NOT NULL OR NEW."deleted_at" IS NULL THEN
        RAISE EXCEPTION 'model geometry deletion marker is immutable once set'
            USING ERRCODE = '23514', CONSTRAINT = 'model_geometry_deletion_binding_check';
    END IF;

    SELECT source."deleted_at"
    INTO source_deleted_at
    FROM "model_files" source
    WHERE source."id" = NEW."source_model_file_id";

    IF source_deleted_at IS NULL OR NEW."deleted_at" IS DISTINCT FROM source_deleted_at THEN
        RAISE EXCEPTION 'model geometry deletion must match its source deletion'
            USING ERRCODE = '23514', CONSTRAINT = 'model_geometry_deletion_binding_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "model_geometries_deletion_binding"
    BEFORE UPDATE ON "model_geometries"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_model_geometry_deletion();

CREATE FUNCTION taven_propagate_model_file_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL THEN
        UPDATE "model_geometries"
        SET "deleted_at" = NEW."deleted_at"
        WHERE "source_model_file_id" = NEW."id"
          AND "deleted_at" IS NULL;
    END IF;

    RETURN NULL;
END;
$$;

CREATE TRIGGER "model_files_propagate_deletion"
    AFTER UPDATE OF "deleted_at" ON "model_files"
    FOR EACH ROW EXECUTE FUNCTION taven_propagate_model_file_deletion();

CREATE FUNCTION taven_assert_phase_plan_snapshot_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "eligibility_snapshots" snapshot
        WHERE snapshot."id" = NEW."eligibility_snapshot_id"
          AND snapshot."node_id" = NEW."node_id"
          AND snapshot."order_phase_id" = NEW."order_phase_id"
          AND snapshot."expires_at" >= NEW."expires_at"
    ) THEN
        RAISE EXCEPTION 'phase resource plan must fit within its eligibility snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_resource_plan_snapshot_expiry_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "phase_resource_plans_snapshot_expiry"
    BEFORE INSERT ON "phase_resource_plans"
    FOR EACH ROW EXECUTE FUNCTION taven_assert_phase_plan_snapshot_expiry();

CREATE FUNCTION taven_protect_row_payload()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    mutable_columns text[] := string_to_array(COALESCE(TG_ARGV[0], ''), ',');
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;

    IF (to_jsonb(NEW) - mutable_columns) IS DISTINCT FROM (to_jsonb(OLD) - mutable_columns) THEN
        RAISE EXCEPTION '% immutable payload cannot be changed', TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "revision_identities_immutable"
    BEFORE UPDATE OR DELETE ON "revision_identities"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
CREATE TRIGGER "model_geometries_immutable"
    BEFORE UPDATE OR DELETE ON "model_geometries"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('deleted_at');
CREATE TRIGGER "print_config_revisions_immutable"
    BEFORE UPDATE OR DELETE ON "print_config_revisions"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
CREATE TRIGGER "machine_capabilities_immutable"
    BEFORE UPDATE OR DELETE ON "machine_capabilities"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
CREATE TRIGGER "slice_results_immutable"
    BEFORE UPDATE OR DELETE ON "slice_results"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
CREATE TRIGGER "candidate_resource_estimates_immutable"
    BEFORE UPDATE OR DELETE ON "candidate_resource_estimates"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
CREATE TRIGGER "candidate_capacity_intervals_immutable"
    BEFORE UPDATE OR DELETE ON "candidate_capacity_intervals"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
CREATE TRIGGER "eligibility_snapshots_immutable"
    BEFORE UPDATE OR DELETE ON "eligibility_snapshots"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
CREATE TRIGGER "phase_resource_plans_immutable"
    BEFORE UPDATE OR DELETE ON "phase_resource_plans"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
CREATE TRIGGER "phase_resource_plan_jobs_immutable"
    BEFORE UPDATE OR DELETE ON "phase_resource_plan_jobs"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
CREATE TRIGGER "phase_resource_plan_slots_immutable"
    BEFORE UPDATE OR DELETE ON "phase_resource_plan_slots"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');

CREATE TRIGGER "phase_reservation_sets_payload_immutable"
    BEFORE UPDATE OR DELETE ON "phase_reservation_sets"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('status,updated_at');
CREATE TRIGGER "production_reservations_payload_immutable"
    BEFORE UPDATE OR DELETE ON "production_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('job_id,status,updated_at');
CREATE TRIGGER "capacity_reservations_payload_immutable"
    BEFORE UPDATE OR DELETE ON "capacity_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('status,updated_at');
CREATE TRIGGER "outbox_messages_payload_immutable"
    BEFORE UPDATE OR DELETE ON "outbox_messages"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('status,attempts,available_at,locked_at,delivered_at,last_error,updated_at');
CREATE TRIGGER "idempotency_records_request_immutable"
    BEFORE UPDATE OR DELETE ON "idempotency_records"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('status,response_status_code,response_body,expires_at,updated_at');

CREATE FUNCTION taven_protect_delivered_outbox_message()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" = 'DELIVERED' AND (
        NEW."status" IS DISTINCT FROM OLD."status" OR
        NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
    ) THEN
        RAISE EXCEPTION 'delivered outbox message % cannot be requeued or redelivered', OLD."id"
            USING ERRCODE = '23514', CONSTRAINT = 'outbox_messages_delivered_terminal_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "outbox_messages_delivered_terminal"
    BEFORE UPDATE ON "outbox_messages"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_delivered_outbox_message();

CREATE FUNCTION taven_validate_reservation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_status text;
    new_status text := NEW."status"::text;
    required_initial_status text;
    allowed boolean := false;
BEGIN
    IF TG_OP = 'INSERT' THEN
        required_initial_status := CASE TG_TABLE_NAME
            WHEN 'phase_reservation_sets' THEN 'BUILDING'
            WHEN 'production_reservations' THEN 'RESERVED'
            WHEN 'capacity_reservations' THEN 'RESERVED'
        END;

        IF new_status <> required_initial_status THEN
            RAISE EXCEPTION '% must be created in % status', TG_TABLE_NAME, required_initial_status
                USING ERRCODE = '23514', CONSTRAINT = 'reservation_lifecycle_initial_state_check';
        END IF;

        RETURN NEW;
    END IF;

    old_status := OLD."status"::text;
    IF old_status = new_status THEN
        RETURN NEW;
    END IF;

    allowed := CASE TG_TABLE_NAME
        WHEN 'phase_reservation_sets' THEN
            (old_status = 'BUILDING' AND new_status IN ('RESERVED', 'RELEASED', 'EXPIRED')) OR
            (old_status = 'RESERVED' AND new_status IN ('HELD', 'RELEASED', 'EXPIRED')) OR
            (old_status = 'HELD' AND new_status IN ('SETTLED', 'RELEASED', 'EXPIRED'))
        WHEN 'production_reservations' THEN
            (old_status = 'RESERVED' AND new_status IN ('HELD', 'RELEASED', 'EXPIRED')) OR
            (old_status = 'HELD' AND new_status IN ('SCHEDULED', 'RELEASED', 'EXPIRED')) OR
            (old_status = 'SCHEDULED' AND new_status IN ('PRINTING', 'RELEASED', 'EXPIRED')) OR
            (old_status = 'PRINTING' AND new_status IN ('CONSUMED', 'RELEASED'))
        WHEN 'capacity_reservations' THEN
            (old_status = 'RESERVED' AND new_status IN ('HELD', 'RELEASED', 'EXPIRED')) OR
            (old_status = 'HELD' AND new_status IN ('SCHEDULED', 'RELEASED', 'EXPIRED')) OR
            (old_status = 'SCHEDULED' AND new_status IN ('PRINTING', 'RELEASED', 'EXPIRED')) OR
            (old_status = 'PRINTING' AND new_status IN ('COMPLETED', 'RELEASED'))
        ELSE false
    END;

    IF NOT allowed THEN
        RAISE EXCEPTION '% transition from % to % is invalid', TG_TABLE_NAME, old_status, new_status
            USING ERRCODE = '23514', CONSTRAINT = 'reservation_lifecycle_transition_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "phase_reservation_sets_lifecycle_transition"
    BEFORE INSERT OR UPDATE ON "phase_reservation_sets"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_reservation_lifecycle();
CREATE TRIGGER "production_reservations_lifecycle_transition"
    BEFORE INSERT OR UPDATE ON "production_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_reservation_lifecycle();
CREATE TRIGGER "capacity_reservations_lifecycle_transition"
    BEFORE INSERT OR UPDATE ON "capacity_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_reservation_lifecycle();

CREATE FUNCTION taven_lock_production_reservation_resources()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM "machine_profiles"
    WHERE "id" = NEW."machine_profile_id"
    FOR UPDATE;

    PERFORM 1
    FROM "machines"
    WHERE "node_id" = NEW."node_id"
      AND "id" = NEW."machine_id"
    FOR UPDATE;

    PERFORM 1
    FROM "machine_calibrations"
    WHERE "id" = NEW."machine_calibration_id"
    FOR UPDATE;

    PERFORM 1
    FROM "inventories"
    WHERE "node_id" = NEW."node_id"
      AND "id" = NEW."inventory_id"
    FOR UPDATE;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "production_reservations_lock_resources"
    BEFORE INSERT ON "production_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_lock_production_reservation_resources();

CREATE FUNCTION taven_lock_phase_reservation_resources()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" IS NOT DISTINCT FROM NEW."status"
       OR NEW."status" NOT IN ('RESERVED', 'HELD') THEN
        RETURN NEW;
    END IF;

    PERFORM 1
    FROM "nodes"
    WHERE "id" = NEW."node_id"
    FOR SHARE;

    PERFORM 1
    FROM "model_files" source
    WHERE source."id" IN (
        SELECT geometry."source_model_file_id"
        FROM "production_reservations" production
        JOIN "slice_results" slice_result
          ON slice_result."id" = production."slice_result_id"
        JOIN "model_geometries" geometry
          ON geometry."id" = slice_result."model_geometry_id"
        WHERE production."phase_reservation_set_id" = NEW."id"
    )
    ORDER BY source."id"
    FOR SHARE;

    PERFORM 1
    FROM "model_geometries" geometry
    WHERE geometry."id" IN (
        SELECT slice_result."model_geometry_id"
        FROM "production_reservations" production
        JOIN "slice_results" slice_result
          ON slice_result."id" = production."slice_result_id"
        WHERE production."phase_reservation_set_id" = NEW."id"
    )
    ORDER BY geometry."id"
    FOR SHARE;

    PERFORM 1
    FROM "machine_profiles"
    WHERE "id" IN (
        SELECT "machine_profile_id"
        FROM "production_reservations"
        WHERE "phase_reservation_set_id" = NEW."id"
    )
    ORDER BY "id"
    FOR UPDATE;

    PERFORM 1
    FROM "machines"
    WHERE ("node_id", "id") IN (
        SELECT "node_id", "machine_id"
        FROM "production_reservations"
        WHERE "phase_reservation_set_id" = NEW."id"
    )
    ORDER BY "node_id", "id"
    FOR UPDATE;

    PERFORM 1
    FROM "machine_calibrations"
    WHERE "id" IN (
        SELECT "machine_calibration_id"
        FROM "production_reservations"
        WHERE "phase_reservation_set_id" = NEW."id"
    )
    ORDER BY "id"
    FOR UPDATE;

    PERFORM 1
    FROM "inventories"
    WHERE ("node_id", "id") IN (
        SELECT "node_id", "inventory_id"
        FROM "production_reservations"
        WHERE "phase_reservation_set_id" = NEW."id"
    )
    ORDER BY "node_id", "id"
    FOR UPDATE;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "phase_reservation_sets_lock_resources"
    BEFORE UPDATE ON "phase_reservation_sets"
    FOR EACH ROW EXECUTE FUNCTION taven_lock_phase_reservation_resources();

CREATE FUNCTION taven_protect_completed_idempotency_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" = 'COMPLETED' AND (
        NEW."status" <> OLD."status" OR
        NEW."response_status_code" IS DISTINCT FROM OLD."response_status_code" OR
        NEW."response_body" IS DISTINCT FROM OLD."response_body"
    ) THEN
        RAISE EXCEPTION 'completed idempotency result cannot be changed'
            USING ERRCODE = '23514', CONSTRAINT = 'idempotency_records_completed_result_immutable_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "idempotency_records_completed_result_immutable"
    BEFORE UPDATE ON "idempotency_records"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_completed_idempotency_result();

CREATE TRIGGER "reference_profiles_payload_immutable"
    BEFORE UPDATE OR DELETE ON "reference_profiles"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('state,activated_at,retired_at');
CREATE TRIGGER "machine_profiles_payload_immutable"
    BEFORE UPDATE OR DELETE ON "machine_profiles"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('state,activated_at,retired_at');
CREATE TRIGGER "machine_calibrations_payload_immutable"
    BEFORE UPDATE OR DELETE ON "machine_calibrations"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('state,activated_at,retired_at');

CREATE FUNCTION taven_validate_revision_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."state" = OLD."state" THEN
        IF NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
           OR NEW."retired_at" IS DISTINCT FROM OLD."retired_at" THEN
            RAISE EXCEPTION '% lifecycle timestamps cannot change without a state transition', TG_TABLE_NAME
                USING ERRCODE = '23514', CONSTRAINT = 'revision_lifecycle_transition_check';
        END IF;
    ELSIF OLD."state" = 'DRAFT' AND NEW."state" = 'ACTIVE' THEN
        IF NEW."activated_at" IS NULL OR NEW."retired_at" IS NOT NULL THEN
            RAISE EXCEPTION '% activation requires activated_at only', TG_TABLE_NAME
                USING ERRCODE = '23514', CONSTRAINT = 'revision_lifecycle_transition_check';
        END IF;
    ELSIF OLD."state" = 'ACTIVE' AND NEW."state" = 'RETIRED' THEN
        IF NEW."activated_at" IS DISTINCT FROM OLD."activated_at" OR NEW."retired_at" IS NULL THEN
            RAISE EXCEPTION '% retirement must preserve activated_at and set retired_at', TG_TABLE_NAME
                USING ERRCODE = '23514', CONSTRAINT = 'revision_lifecycle_transition_check';
        END IF;
    ELSE
        RAISE EXCEPTION '% revision state transition from % to % is invalid', TG_TABLE_NAME, OLD."state", NEW."state"
            USING ERRCODE = '23514', CONSTRAINT = 'revision_lifecycle_transition_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "reference_profiles_lifecycle_transition"
    BEFORE UPDATE ON "reference_profiles"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_revision_lifecycle();
CREATE TRIGGER "machine_profiles_lifecycle_transition"
    BEFORE UPDATE ON "machine_profiles"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_revision_lifecycle();
CREATE TRIGGER "machine_calibrations_lifecycle_transition"
    BEFORE UPDATE ON "machine_calibrations"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_revision_lifecycle();

CREATE FUNCTION taven_validate_production_job_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."job_id" IS NOT NULL THEN
            RAISE EXCEPTION 'production reservation cannot bind a job before capture'
                USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_job_binding_check';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD."job_id" IS NOT NULL AND NEW."job_id" IS DISTINCT FROM OLD."job_id" THEN
        RAISE EXCEPTION 'production reservation job binding is immutable once assigned'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_job_binding_check';
    END IF;

    IF OLD."job_id" IS NULL AND NEW."job_id" IS NOT NULL AND NOT (
        OLD."status" = 'RESERVED' AND NEW."status" = 'HELD'
    ) THEN
        RAISE EXCEPTION 'production reservation job must be bound during capture'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_job_binding_check';
    END IF;

    IF NEW."status" IN ('HELD', 'SCHEDULED', 'PRINTING', 'CONSUMED')
       AND NEW."job_id" IS NULL THEN
        RAISE EXCEPTION 'captured production reservation requires a job binding'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_job_binding_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "production_reservations_job_binding"
    BEFORE INSERT OR UPDATE ON "production_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_production_job_binding();

CREATE FUNCTION taven_require_building_reservation_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status "phase_reservation_set_status";
BEGIN
    IF TG_TABLE_NAME = 'production_reservations' THEN
        SELECT reservation_set."status" INTO parent_status
        FROM "phase_reservation_sets" reservation_set
        WHERE reservation_set."id" = NEW."phase_reservation_set_id"
          AND reservation_set."node_id" = NEW."node_id"
        FOR UPDATE;
    ELSE
        SELECT reservation_set."status" INTO parent_status
        FROM "production_reservations" production
        JOIN "phase_reservation_sets" reservation_set
          ON reservation_set."id" = production."phase_reservation_set_id"
         AND reservation_set."node_id" = production."node_id"
        WHERE production."id" = NEW."production_reservation_id"
          AND production."node_id" = NEW."node_id"
        FOR UPDATE OF reservation_set;
    END IF;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF parent_status <> 'BUILDING' THEN
        RAISE EXCEPTION 'reservation children can only be created while their parent set is building'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_child_insert_state_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "production_reservations_00_parent_building_guard"
    BEFORE INSERT ON "production_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_require_building_reservation_parent();
CREATE TRIGGER "inventory_reservations_00_parent_building_guard"
    BEFORE INSERT ON "inventory_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_require_building_reservation_parent();
CREATE TRIGGER "capacity_reservations_00_parent_building_guard"
    BEFORE INSERT ON "capacity_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_require_building_reservation_parent();

CREATE FUNCTION taven_validate_production_set_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "phase_reservation_sets" reservation_set
        WHERE reservation_set."id" = NEW."phase_reservation_set_id"
          AND reservation_set."node_id" = NEW."node_id"
          AND reservation_set."phase_resource_plan_id" = NEW."phase_resource_plan_id"
          AND reservation_set."expires_at" = NEW."expires_at"
    ) THEN
        RAISE EXCEPTION 'production reservation must share its set plan and expiry'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_set_expiry_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "production_reservations_set_expiry"
    BEFORE INSERT ON "production_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_production_set_expiry();

CREATE FUNCTION taven_lock_plan_before_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM "phase_resource_plans" plan
    WHERE plan."id" = NEW."phase_resource_plan_id"
      AND plan."node_id" = NEW."node_id"
      AND plan."expires_at" > clock_timestamp()
      AND NEW."expires_at" > clock_timestamp()
      AND NEW."expires_at" <= plan."expires_at"
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'reservation set must fit within a current phase resource plan'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_plan_expiry_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "phase_reservation_sets_lock_plan"
    BEFORE INSERT ON "phase_reservation_sets"
    FOR EACH ROW EXECUTE FUNCTION taven_lock_plan_before_reservation();

CREATE FUNCTION taven_freeze_plan_membership_after_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM "phase_resource_plans"
    WHERE "id" = NEW."phase_resource_plan_id"
      AND "node_id" = NEW."node_id"
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM "phase_reservation_sets"
        WHERE "phase_resource_plan_id" = NEW."phase_resource_plan_id"
    ) THEN
        RAISE EXCEPTION 'phase resource plan membership is frozen after reservation begins'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_resource_plan_membership_frozen_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "phase_resource_plan_jobs_membership_frozen"
    BEFORE INSERT ON "phase_resource_plan_jobs"
    FOR EACH ROW EXECUTE FUNCTION taven_freeze_plan_membership_after_reservation();
CREATE TRIGGER "phase_resource_plan_slots_membership_frozen"
    BEFORE INSERT ON "phase_resource_plan_slots"
    FOR EACH ROW EXECUTE FUNCTION taven_freeze_plan_membership_after_reservation();

CREATE FUNCTION taven_require_candidate_intervals_before_planning()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    required_seconds bigint;
    covered_seconds numeric;
    candidate_machine_id uuid;
BEGIN
    SELECT "required_machine_seconds", "machine_id"
    INTO required_seconds, candidate_machine_id
    FROM "candidate_resource_estimates"
    WHERE "id" = NEW."candidate_resource_estimate_id"
      AND "node_id" = NEW."node_id"
    FOR UPDATE;

    IF NOT EXISTS (
        SELECT 1
        FROM "phase_resource_plans" plan
        JOIN "eligibility_snapshots" snapshot
          ON snapshot."id" = plan."eligibility_snapshot_id"
         AND snapshot."node_id" = plan."node_id"
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = NEW."candidate_resource_estimate_id"
         AND candidate."node_id" = NEW."node_id"
        WHERE plan."id" = NEW."phase_resource_plan_id"
          AND plan."node_id" = NEW."node_id"
          AND candidate."expires_at" >= plan."expires_at"
          AND snapshot."eligible_candidate_estimate_ids" ? NEW."candidate_resource_estimate_id"::text
    ) THEN
        RAISE EXCEPTION 'planned candidate is not present in the eligibility snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_resource_plan_candidate_eligibility_check';
    END IF;

    SELECT COALESCE(
        SUM(EXTRACT(EPOCH FROM upper(covered_range) - lower(covered_range))),
        0
    )
    INTO covered_seconds
    FROM (
        SELECT unnest(range_agg(tstzrange("starts_at", "ends_at", '[)'))) AS covered_range
        FROM "candidate_capacity_intervals"
        WHERE "candidate_resource_estimate_id" = NEW."candidate_resource_estimate_id"
          AND "node_id" = NEW."node_id"
    ) normalized_intervals;

    IF covered_seconds < required_seconds THEN
        RAISE EXCEPTION 'planned candidate capacity covers % seconds but requires %', covered_seconds, required_seconds
            USING ERRCODE = '23514', CONSTRAINT = 'phase_resource_plan_candidate_capacity_coverage_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "candidate_capacity_intervals" earlier
        JOIN "candidate_capacity_intervals" later
          ON later."candidate_resource_estimate_id" = earlier."candidate_resource_estimate_id"
         AND later."node_id" = earlier."node_id"
         AND later."interval_index" > earlier."interval_index"
         AND tstzrange(later."starts_at", later."ends_at", '[)')
             && tstzrange(earlier."starts_at", earlier."ends_at", '[)')
        WHERE earlier."candidate_resource_estimate_id" = NEW."candidate_resource_estimate_id"
          AND earlier."node_id" = NEW."node_id"
    ) THEN
        RAISE EXCEPTION 'planned candidate capacity intervals must not overlap'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_resource_plan_candidate_capacity_overlap_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "candidate_capacity_intervals" new_interval
        JOIN "phase_resource_plan_jobs" existing_job
          ON existing_job."phase_resource_plan_id" = NEW."phase_resource_plan_id"
         AND existing_job."node_id" = NEW."node_id"
        JOIN "candidate_resource_estimates" existing_candidate
          ON existing_candidate."id" = existing_job."candidate_resource_estimate_id"
         AND existing_candidate."node_id" = existing_job."node_id"
         AND existing_candidate."machine_id" = candidate_machine_id
        JOIN "candidate_capacity_intervals" existing_interval
          ON existing_interval."candidate_resource_estimate_id" = existing_candidate."id"
         AND existing_interval."node_id" = existing_candidate."node_id"
         AND tstzrange(existing_interval."starts_at", existing_interval."ends_at", '[)')
             && tstzrange(new_interval."starts_at", new_interval."ends_at", '[)')
        WHERE new_interval."candidate_resource_estimate_id" = NEW."candidate_resource_estimate_id"
          AND new_interval."node_id" = NEW."node_id"
    ) THEN
        RAISE EXCEPTION 'phase resource plan candidates overlap on machine %', candidate_machine_id
            USING ERRCODE = '23514', CONSTRAINT = 'phase_resource_plan_machine_capacity_overlap_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "phase_resource_plan_jobs_require_intervals"
    BEFORE INSERT ON "phase_resource_plan_jobs"
    FOR EACH ROW EXECUTE FUNCTION taven_require_candidate_intervals_before_planning();

CREATE FUNCTION taven_freeze_candidate_intervals_after_planning()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM "candidate_resource_estimates"
    WHERE "id" = NEW."candidate_resource_estimate_id"
      AND "node_id" = NEW."node_id"
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM "phase_resource_plan_jobs"
        WHERE "candidate_resource_estimate_id" = NEW."candidate_resource_estimate_id"
          AND "node_id" = NEW."node_id"
    ) THEN
        RAISE EXCEPTION 'candidate capacity intervals are frozen after planning'
            USING ERRCODE = '23514', CONSTRAINT = 'candidate_capacity_intervals_frozen_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "candidate_capacity_intervals_membership_frozen"
    BEFORE INSERT ON "candidate_capacity_intervals"
    FOR EACH ROW EXECUTE FUNCTION taven_freeze_candidate_intervals_after_planning();

CREATE FUNCTION taven_model_source_live_capacity_horizon(target_source_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
    SELECT max(capacity_reservation."ends_at")
    FROM "model_geometries" geometry
    JOIN "slice_results" slice_result
      ON slice_result."model_geometry_id" = geometry."id"
    JOIN "production_reservations" production
      ON production."slice_result_id" = slice_result."id"
    JOIN "capacity_reservations" capacity_reservation
      ON capacity_reservation."production_reservation_id" = production."id"
    WHERE geometry."source_model_file_id" = target_source_id
      AND production."status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
      AND capacity_reservation."status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING');
$$;

CREATE FUNCTION taven_protect_asset_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    deadline_column text := TG_ARGV[0];
    old_deadline timestamptz;
    new_deadline timestamptz;
    checked_at timestamptz := clock_timestamp();
    live_capacity_horizon timestamptz;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '% metadata is retained after object deletion', TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;

    old_deadline := (to_jsonb(OLD) ->> deadline_column)::timestamptz;
    new_deadline := (to_jsonb(NEW) ->> deadline_column)::timestamptz;

    IF (to_jsonb(NEW) - ARRAY[deadline_column, 'retention_hold', 'deleted_at'])
        IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY[deadline_column, 'retention_hold', 'deleted_at']) THEN
        RAISE EXCEPTION '% immutable asset payload cannot be changed', TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;

    IF new_deadline < old_deadline THEN
        RAISE EXCEPTION '% deletion deadline cannot be shortened', TG_TABLE_NAME
            USING ERRCODE = '23514', CONSTRAINT = 'asset_deadline_monotonic_check';
    END IF;

    IF TG_TABLE_NAME = 'model_files' THEN
        live_capacity_horizon := taven_model_source_live_capacity_horizon(NEW."id");
        IF live_capacity_horizon IS NOT NULL AND (
            NEW."deleted_at" IS NOT NULL OR (
                NEW."retention_hold" = 'NONE'
                AND (
                    new_deadline <= checked_at
                    OR new_deadline < live_capacity_horizon
                )
            )
        ) THEN
            RAISE EXCEPTION 'model source must remain available through live production capacity'
                USING ERRCODE = '23514', CONSTRAINT = 'model_file_live_capacity_horizon_check';
        END IF;
    END IF;

    IF OLD."deleted_at" IS NULL
       AND NEW."deleted_at" IS NOT NULL
       AND (
           NEW."retention_hold" <> 'NONE'
           OR new_deadline > checked_at
       ) THEN
        RAISE EXCEPTION '% cannot be marked deleted before its deadline or while retained', TG_TABLE_NAME
            USING ERRCODE = '23514', CONSTRAINT = 'asset_deletion_eligibility_check';
    END IF;

    IF OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL THEN
        NEW."deleted_at" := checked_at;
    END IF;

    IF OLD."deleted_at" IS NOT NULL AND NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at" THEN
        RAISE EXCEPTION '% deletion marker is immutable', TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "model_files_retention_protected"
    BEFORE UPDATE OR DELETE ON "model_files"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_asset_retention('source_delete_after');
CREATE TRIGGER "photo_assets_retention_protected"
    BEFORE UPDATE OR DELETE ON "photo_assets"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_asset_retention('photo_delete_after');

CREATE FUNCTION taven_inventory_reservation_is_active(value "inventory_reservation_status")
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT value IN ('RESERVED', 'HELD', 'ALLOCATED');
$$;

CREATE FUNCTION taven_account_inventory_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    changed_rows integer;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'inventory reservation history cannot be deleted'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'RESERVED' OR NEW."consumed_milligrams" IS NOT NULL THEN
            RAISE EXCEPTION 'inventory reservation must start RESERVED and unconsumed'
                USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_initial_state_check';
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM "production_reservations" production
            WHERE production."id" = NEW."production_reservation_id"
              AND production."node_id" = NEW."node_id"
              AND production."inventory_id" = NEW."inventory_id"
              AND production."expires_at" = NEW."expires_at"
        ) THEN
            RAISE EXCEPTION 'inventory reservation must use the production inventory and expiry'
                USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_production_inventory_check';
        END IF;

        UPDATE "inventories"
        SET "reserved_milligrams" = "reserved_milligrams" + NEW."reserved_milligrams",
            "updated_at" = clock_timestamp()
        WHERE "id" = NEW."inventory_id"
          AND "node_id" = NEW."node_id"
          AND "status" = 'AVAILABLE'
          AND "remaining_milligrams" - "reserved_milligrams" >= NEW."reserved_milligrams";
        GET DIAGNOSTICS changed_rows = ROW_COUNT;

        IF changed_rows <> 1 THEN
            RAISE EXCEPTION 'inventory % has insufficient available material', NEW."inventory_id"
                USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_available_balance_check';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."node_id" IS DISTINCT FROM OLD."node_id"
       OR NEW."production_reservation_id" IS DISTINCT FROM OLD."production_reservation_id"
       OR NEW."inventory_id" IS DISTINCT FROM OLD."inventory_id"
       OR NEW."reserved_milligrams" IS DISTINCT FROM OLD."reserved_milligrams"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'inventory reservation identity and amount are immutable'
            USING ERRCODE = '55000';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'RESERVED' AND NEW."status" IN ('HELD', 'ALLOCATED', 'RELEASED', 'EXPIRED')) OR
        (OLD."status" = 'HELD' AND NEW."status" IN ('ALLOCATED', 'RELEASED', 'EXPIRED')) OR
        (OLD."status" = 'ALLOCATED' AND NEW."status" IN ('CONSUMED', 'RELEASED', 'EXPIRED'))
    ) THEN
        RAISE EXCEPTION 'inventory reservation transition from % to % is invalid', OLD."status", NEW."status"
            USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_lifecycle_transition_check';
    END IF;

    IF NOT taven_inventory_reservation_is_active(OLD."status")
       AND NEW."status" IS DISTINCT FROM OLD."status" THEN
        RAISE EXCEPTION 'terminal inventory reservation cannot transition'
            USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_terminal_state_check';
    END IF;

    IF taven_inventory_reservation_is_active(OLD."status")
       AND NOT taven_inventory_reservation_is_active(NEW."status") THEN
        IF NEW."status" = 'CONSUMED' THEN
            UPDATE "inventories"
            SET "remaining_milligrams" = "remaining_milligrams" - NEW."consumed_milligrams",
                "reserved_milligrams" = "reserved_milligrams" - OLD."reserved_milligrams",
                "updated_at" = clock_timestamp()
            WHERE "id" = OLD."inventory_id"
              AND "node_id" = OLD."node_id"
              AND NEW."consumed_milligrams" IS NOT NULL
              AND NEW."consumed_milligrams" BETWEEN 0 AND OLD."reserved_milligrams"
              AND "remaining_milligrams" >= NEW."consumed_milligrams"
              AND "reserved_milligrams" >= OLD."reserved_milligrams";
        ELSE
            UPDATE "inventories"
            SET "reserved_milligrams" = "reserved_milligrams" - OLD."reserved_milligrams",
                "updated_at" = clock_timestamp()
            WHERE "id" = OLD."inventory_id"
              AND "node_id" = OLD."node_id"
              AND NEW."status" IN ('RELEASED', 'EXPIRED')
              AND NEW."consumed_milligrams" IS NULL
              AND "reserved_milligrams" >= OLD."reserved_milligrams";
        END IF;
        GET DIAGNOSTICS changed_rows = ROW_COUNT;

        IF changed_rows <> 1 THEN
            RAISE EXCEPTION 'inventory reservation terminal transition is invalid'
                USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_release_check';
        END IF;
    ELSIF NEW."consumed_milligrams" IS DISTINCT FROM OLD."consumed_milligrams" THEN
        RAISE EXCEPTION 'consumption can only be recorded on the terminal CONSUMED transition'
            USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_consumption_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "inventory_reservations_accounting"
    BEFORE INSERT OR UPDATE OR DELETE ON "inventory_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_account_inventory_reservation();

CREATE FUNCTION taven_validate_inventory_reserved_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_inventory_id uuid := NEW."id";
    stored_reserved bigint;
    calculated_reserved bigint;
BEGIN
    SELECT "reserved_milligrams" INTO stored_reserved
    FROM "inventories"
    WHERE "id" = target_inventory_id;

    SELECT COALESCE(sum("reserved_milligrams"), 0) INTO calculated_reserved
    FROM "inventory_reservations"
    WHERE "inventory_id" = target_inventory_id
      AND taven_inventory_reservation_is_active("status");

    IF stored_reserved IS DISTINCT FROM calculated_reserved THEN
        RAISE EXCEPTION 'inventory % reserved counter does not match active reservations', target_inventory_id
            USING ERRCODE = '23514', CONSTRAINT = 'inventory_reserved_counter_matches_reservations_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "inventories_reserved_counter_matches_reservations"
    AFTER INSERT OR UPDATE ON "inventories"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION taven_validate_inventory_reserved_counter();

CREATE FUNCTION taven_validate_capacity_reservation_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "production_reservations" production
        JOIN "phase_resource_plan_jobs" plan_job
          ON plan_job."id" = production."phase_resource_plan_job_id"
         AND plan_job."phase_resource_plan_id" = production."phase_resource_plan_id"
         AND plan_job."node_id" = production."node_id"
        JOIN "candidate_capacity_intervals" candidate_interval
          ON candidate_interval."id" = NEW."candidate_capacity_interval_id"
         AND candidate_interval."candidate_resource_estimate_id" = plan_job."candidate_resource_estimate_id"
         AND candidate_interval."node_id" = production."node_id"
        WHERE production."id" = NEW."production_reservation_id"
          AND production."node_id" = NEW."node_id"
          AND production."machine_id" = NEW."machine_id"
          AND production."expires_at" = NEW."expires_at"
          AND candidate_interval."starts_at" = NEW."starts_at"
          AND candidate_interval."ends_at" = NEW."ends_at"
    ) THEN
        RAISE EXCEPTION 'capacity reservation must match the production candidate interval, machine, and expiry'
            USING ERRCODE = '23514', CONSTRAINT = 'capacity_reservation_production_binding_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "capacity_reservations_production_binding"
    BEFORE INSERT ON "capacity_reservations"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_capacity_reservation_binding();

CREATE FUNCTION taven_production_reservation_group_is_consistent(target_production_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "production_reservations" production
        WHERE production."id" = target_production_id
          AND (
              (
                  production."status" IN ('HELD', 'SCHEDULED', 'PRINTING')
                  AND EXISTS (
                      SELECT 1
                      FROM "inventory_reservations" inventory_reservation
                      WHERE inventory_reservation."production_reservation_id" = production."id"
                        AND inventory_reservation."status" IN ('HELD', 'ALLOCATED')
                  )
                  AND EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                        AND capacity_reservation."status" NOT IN ('HELD', 'SCHEDULED', 'PRINTING')
                  )
              ) OR (
                  production."status" = 'CONSUMED'
                  AND EXISTS (
                      SELECT 1
                      FROM "inventory_reservations" inventory_reservation
                      WHERE inventory_reservation."production_reservation_id" = production."id"
                        AND inventory_reservation."status" = 'CONSUMED'
                  )
                  AND EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                        AND capacity_reservation."status" <> 'COMPLETED'
                  )
              ) OR (
                  production."status" IN ('RELEASED', 'EXPIRED')
                  AND EXISTS (
                      SELECT 1
                      FROM "inventory_reservations" inventory_reservation
                      WHERE inventory_reservation."production_reservation_id" = production."id"
                        AND inventory_reservation."status" IN ('CONSUMED', 'RELEASED', 'EXPIRED')
                  )
                  AND EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                        AND capacity_reservation."status" NOT IN ('COMPLETED', 'RELEASED', 'EXPIRED')
                  )
              )
          )
    );
$$;

CREATE FUNCTION taven_validate_phase_reservation_set(set_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    target_set "phase_reservation_sets"%ROWTYPE;
    expected_jobs integer;
    complete_jobs integer;
    expected_slots integer;
    planned_slots integer;
BEGIN
    SELECT * INTO target_set
    FROM "phase_reservation_sets"
    WHERE "id" = set_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF target_set."status" = 'BUILDING' THEN
        RAISE EXCEPTION 'building phase reservation set % cannot survive the transaction', target_set."id"
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_building_commit_check';
    END IF;

    IF target_set."status" = 'HELD'
       AND EXISTS (
           SELECT 1
           FROM "production_reservations" production
           WHERE production."phase_reservation_set_id" = target_set."id"
             AND NOT taven_production_reservation_group_is_consistent(production."id")
       ) THEN
        RAISE EXCEPTION 'phase reservation set % has child states outside its lifecycle phase', target_set."id"
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_child_status_check';
    END IF;

    IF target_set."status" IN ('SETTLED', 'RELEASED', 'EXPIRED') THEN
        IF EXISTS (
            SELECT 1
            FROM "production_reservations" production
            WHERE production."phase_reservation_set_id" = target_set."id"
              AND production."status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
        ) OR EXISTS (
            SELECT 1
            FROM "production_reservations" production
            JOIN "inventory_reservations" inventory_reservation
              ON inventory_reservation."production_reservation_id" = production."id"
            WHERE production."phase_reservation_set_id" = target_set."id"
              AND taven_inventory_reservation_is_active(inventory_reservation."status")
        ) OR EXISTS (
            SELECT 1
            FROM "production_reservations" production
            JOIN "capacity_reservations" capacity_reservation
              ON capacity_reservation."production_reservation_id" = production."id"
            WHERE production."phase_reservation_set_id" = target_set."id"
              AND capacity_reservation."status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
        ) THEN
            RAISE EXCEPTION 'terminal phase reservation set % still owns active children', target_set."id"
                USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_terminal_children_check';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM "production_reservations" production
            WHERE production."phase_reservation_set_id" = target_set."id"
              AND NOT taven_production_reservation_group_is_consistent(production."id")
        ) THEN
            RAISE EXCEPTION 'phase reservation set % has child states outside its lifecycle phase', target_set."id"
                USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_child_status_check';
        END IF;

        IF target_set."status" IN ('RELEASED', 'EXPIRED') THEN
            RETURN;
        END IF;
    END IF;

    IF target_set."status" NOT IN ('RESERVED', 'HELD', 'SETTLED') THEN
        RETURN;
    END IF;

    IF (
        target_set."status" = 'RESERVED' AND (
            EXISTS (
                SELECT 1
                FROM "production_reservations"
                WHERE "phase_reservation_set_id" = target_set."id"
                  AND "status" <> 'RESERVED'
            ) OR EXISTS (
                SELECT 1
                FROM "production_reservations" production
                JOIN "inventory_reservations" inventory_reservation
                  ON inventory_reservation."production_reservation_id" = production."id"
                WHERE production."phase_reservation_set_id" = target_set."id"
                  AND inventory_reservation."status" <> 'RESERVED'
            ) OR EXISTS (
                SELECT 1
                FROM "production_reservations" production
                JOIN "capacity_reservations" capacity_reservation
                  ON capacity_reservation."production_reservation_id" = production."id"
                WHERE production."phase_reservation_set_id" = target_set."id"
                  AND capacity_reservation."status" <> 'RESERVED'
            )
        )
    ) OR (
        target_set."status" = 'HELD'
        AND EXISTS (
            SELECT 1
            FROM "production_reservations"
            WHERE "phase_reservation_set_id" = target_set."id"
        )
        AND NOT EXISTS (
            SELECT 1
            FROM "production_reservations" production
            WHERE production."phase_reservation_set_id" = target_set."id"
              AND production."status" IN ('HELD', 'SCHEDULED', 'PRINTING')
        )
    ) THEN
        RAISE EXCEPTION 'phase reservation set % has child states outside its lifecycle phase', target_set."id"
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_child_status_check';
    END IF;

    IF target_set."status" = 'RESERVED' AND (
        target_set."expires_at" <= clock_timestamp() OR NOT EXISTS (
            SELECT 1
            FROM "phase_resource_plans" plan
            WHERE plan."id" = target_set."phase_resource_plan_id"
              AND plan."node_id" = target_set."node_id"
              AND plan."expires_at" > clock_timestamp()
              AND target_set."expires_at" <= plan."expires_at"
        )
    ) THEN
        RAISE EXCEPTION 'active phase reservation set % must fit within a current resource plan', target_set."id"
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_plan_expiry_check';
    END IF;

    IF target_set."status" = 'RESERVED' AND EXISTS (
        SELECT 1
        FROM "production_reservations" production
        JOIN "capacity_reservations" capacity_reservation
          ON capacity_reservation."production_reservation_id" = production."id"
        WHERE production."phase_reservation_set_id" = target_set."id"
          AND capacity_reservation."starts_at" <= clock_timestamp()
    ) THEN
        RAISE EXCEPTION 'reserved phase reservation set % contains capacity that has already started', target_set."id"
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_capacity_window_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "production_reservations" production
        JOIN "slice_results" slice_result
          ON slice_result."id" = production."slice_result_id"
        JOIN "model_geometries" geometry
          ON geometry."id" = slice_result."model_geometry_id"
        JOIN "model_files" source
          ON source."id" = geometry."source_model_file_id"
        WHERE production."phase_reservation_set_id" = target_set."id"
          AND production."status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
          AND (
              geometry."deleted_at" IS NOT NULL
              OR source."deleted_at" IS NOT NULL
              OR (
                  source."retention_hold" = 'NONE'
                  AND (
                      source."source_delete_after" <= clock_timestamp()
                      OR EXISTS (
                          SELECT 1
                          FROM "capacity_reservations" capacity_reservation
                          WHERE capacity_reservation."production_reservation_id" = production."id"
                            AND capacity_reservation."status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
                            AND source."source_delete_after" < capacity_reservation."ends_at"
                      )
                  )
              )
          )
    ) THEN
        RAISE EXCEPTION 'phase reservation set % uses expired or deleted model geometry', target_set."id"
            USING ERRCODE = '23514', CONSTRAINT = 'model_geometry_source_available_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "production_reservations" production
        WHERE production."phase_reservation_set_id" = target_set."id"
          AND production."status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
          AND NOT EXISTS (
              SELECT 1
              FROM "nodes" node
              JOIN "machine_profiles" machine_profile
                ON true
              JOIN "machines" machine
                ON machine."id" = production."machine_id"
               AND machine."node_id" = production."node_id"
              JOIN "inventories" inventory
                ON inventory."id" = production."inventory_id"
               AND inventory."node_id" = production."node_id"
               AND inventory."machine_id" = production."machine_id"
              JOIN "machine_calibrations" calibration
                ON calibration."id" = production."machine_calibration_id"
               AND calibration."node_id" = production."node_id"
               AND calibration."machine_id" = production."machine_id"
              JOIN "print_config_revisions" print_config
                ON print_config."id" = production."print_config_revision_id"
              JOIN "slice_results" selected_slice
                ON selected_slice."id" = production."slice_result_id"
              WHERE node."id" = production."node_id"
                AND node."active"
                AND machine_profile."id" = production."machine_profile_id"
                AND machine_profile."machine_capability_id" = machine."machine_capability_id"
                AND machine_profile."nozzle_diameter_micrometers" = machine."installed_nozzle_micrometers"
                AND machine_profile."material" = inventory."material"
                AND machine_profile."quality" = print_config."quality"
                AND taven_geometry_fits_machine_capability(
                    selected_slice."model_geometry_id",
                    machine."machine_capability_id"
                )
                AND machine_profile."state" = 'ACTIVE'
                AND calibration."state" = 'ACTIVE'
                AND machine."status" = 'ACTIVE'
                AND inventory."status" = 'AVAILABLE'
          )
    ) THEN
        RAISE EXCEPTION 'phase reservation set % uses a resource that is no longer compatible or active', target_set."id"
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_resource_compatibility_check';
    END IF;

    SELECT count(*) INTO expected_jobs
    FROM "phase_resource_plan_jobs"
    WHERE "phase_resource_plan_id" = target_set."phase_resource_plan_id"
      AND "node_id" = target_set."node_id";

    SELECT jsonb_array_length(snapshot."required_fulfilment_slot_ids") INTO expected_slots
    FROM "phase_resource_plans" plan
    JOIN "eligibility_snapshots" snapshot
      ON snapshot."id" = plan."eligibility_snapshot_id"
     AND snapshot."node_id" = plan."node_id"
    WHERE plan."id" = target_set."phase_resource_plan_id"
      AND plan."node_id" = target_set."node_id";

    SELECT count(*) INTO planned_slots
    FROM "phase_resource_plan_slots"
    WHERE "phase_resource_plan_id" = target_set."phase_resource_plan_id"
      AND "node_id" = target_set."node_id";

    SELECT count(*) INTO complete_jobs
    FROM "phase_resource_plan_jobs" plan_job
    JOIN "candidate_resource_estimates" candidate
      ON candidate."id" = plan_job."candidate_resource_estimate_id"
     AND candidate."node_id" = plan_job."node_id"
    JOIN "production_reservations" production
     ON production."phase_resource_plan_job_id" = plan_job."id"
     AND production."phase_reservation_set_id" = target_set."id"
     AND production."phase_resource_plan_id" = target_set."phase_resource_plan_id"
     AND production."node_id" = target_set."node_id"
     AND production."planned_job_key" = plan_job."planned_job_key"
     AND production."machine_id" = candidate."machine_id"
     AND production."inventory_id" = candidate."inventory_id"
     AND production."slice_result_id" = candidate."slice_result_id"
     AND production."print_config_revision_id" = candidate."print_config_revision_id"
     AND production."machine_profile_id" = candidate."machine_profile_id"
     AND production."machine_calibration_id" = candidate."machine_calibration_id"
     AND production."required_material_milligrams" = candidate."required_material_milligrams"
     AND production."required_machine_seconds" = candidate."required_machine_seconds"
     AND production."resource_snapshot" = candidate."resource_snapshot"
     AND production."expires_at" = target_set."expires_at"
    JOIN "slice_results" slice_result
      ON slice_result."id" = production."slice_result_id"
     AND slice_result."kind" = 'PRODUCTION'
     AND slice_result."print_config_revision_id" = production."print_config_revision_id"
     AND slice_result."machine_profile_id" = production."machine_profile_id"
     AND slice_result."machine_calibration_id" = production."machine_calibration_id"
    JOIN "inventory_reservations" inventory_reservation
      ON inventory_reservation."production_reservation_id" = production."id"
     AND inventory_reservation."node_id" = production."node_id"
     AND inventory_reservation."inventory_id" = production."inventory_id"
     AND inventory_reservation."reserved_milligrams" = production."required_material_milligrams"
     AND inventory_reservation."expires_at" = production."expires_at"
    WHERE plan_job."phase_resource_plan_id" = target_set."phase_resource_plan_id"
      AND plan_job."node_id" = target_set."node_id"
      AND EXISTS (
          SELECT 1
          FROM "candidate_capacity_intervals" candidate_interval
          WHERE candidate_interval."candidate_resource_estimate_id" = candidate."id"
            AND candidate_interval."node_id" = candidate."node_id"
      )
      AND NOT EXISTS (
          SELECT 1
          FROM "candidate_capacity_intervals" candidate_interval
          LEFT JOIN "capacity_reservations" capacity_reservation
            ON capacity_reservation."candidate_capacity_interval_id" = candidate_interval."id"
           AND capacity_reservation."production_reservation_id" = production."id"
           AND capacity_reservation."node_id" = production."node_id"
           AND capacity_reservation."machine_id" = production."machine_id"
           AND capacity_reservation."starts_at" = candidate_interval."starts_at"
           AND capacity_reservation."ends_at" = candidate_interval."ends_at"
           AND capacity_reservation."expires_at" = production."expires_at"
          WHERE candidate_interval."candidate_resource_estimate_id" = candidate."id"
            AND candidate_interval."node_id" = candidate."node_id"
            AND capacity_reservation."id" IS NULL
      )
      AND NOT EXISTS (
          SELECT 1
          FROM "capacity_reservations" capacity_reservation
          LEFT JOIN "candidate_capacity_intervals" candidate_interval
            ON candidate_interval."id" = capacity_reservation."candidate_capacity_interval_id"
           AND candidate_interval."candidate_resource_estimate_id" = candidate."id"
           AND candidate_interval."node_id" = candidate."node_id"
          WHERE capacity_reservation."production_reservation_id" = production."id"
            AND candidate_interval."id" IS NULL
      );

    IF expected_jobs = 0
       OR expected_slots = 0
       OR complete_jobs <> expected_jobs
       OR planned_slots <> expected_slots
       OR EXISTS (
           SELECT 1
           FROM "phase_resource_plan_jobs" plan_job
           WHERE plan_job."phase_resource_plan_id" = target_set."phase_resource_plan_id"
             AND plan_job."node_id" = target_set."node_id"
             AND NOT EXISTS (
                 SELECT 1
                 FROM "phase_resource_plan_slots" plan_slot
                 WHERE plan_slot."phase_resource_plan_job_id" = plan_job."id"
                   AND plan_slot."node_id" = plan_job."node_id"
             )
       )
       OR EXISTS (
           SELECT 1
           FROM "phase_resource_plan_slots" plan_slot
           JOIN "phase_resource_plans" plan
             ON plan."id" = plan_slot."phase_resource_plan_id"
            AND plan."node_id" = plan_slot."node_id"
           JOIN "eligibility_snapshots" snapshot
             ON snapshot."id" = plan."eligibility_snapshot_id"
            AND snapshot."node_id" = plan."node_id"
           WHERE plan_slot."phase_resource_plan_id" = target_set."phase_resource_plan_id"
             AND plan_slot."node_id" = target_set."node_id"
             AND NOT (snapshot."required_fulfilment_slot_ids" ? plan_slot."fulfilment_slot_id"::text)
       )
       OR EXISTS (
        SELECT 1
        FROM "production_reservations" production
        LEFT JOIN "phase_resource_plan_jobs" plan_job
          ON plan_job."id" = production."phase_resource_plan_job_id"
         AND plan_job."phase_resource_plan_id" = target_set."phase_resource_plan_id"
         AND plan_job."node_id" = target_set."node_id"
        WHERE production."phase_reservation_set_id" = target_set."id"
          AND plan_job."id" IS NULL
    ) THEN
        RAISE EXCEPTION 'phase reservation set % is incomplete or inconsistent', target_set."id"
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_complete_check';
    END IF;
END;
$$;

CREATE FUNCTION taven_validate_phase_set_from_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM taven_validate_phase_reservation_set(OLD."id");
    ELSE
        IF TG_OP = 'UPDATE'
           AND OLD."status" IS DISTINCT FROM NEW."status"
           AND NEW."status" IN ('RESERVED', 'HELD')
           AND (
               NEW."expires_at" <= clock_timestamp() OR NOT EXISTS (
                   SELECT 1
                   FROM "phase_resource_plans" plan
                   WHERE plan."id" = NEW."phase_resource_plan_id"
                     AND plan."node_id" = NEW."node_id"
                     AND plan."expires_at" > clock_timestamp()
                     AND NEW."expires_at" <= plan."expires_at"
               )
           ) THEN
            RAISE EXCEPTION 'active phase reservation set % must fit within a current resource plan', NEW."id"
                USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_plan_expiry_check';
        END IF;

        IF TG_OP = 'UPDATE'
           AND OLD."status" IS DISTINCT FROM NEW."status"
           AND NEW."status" IN ('RESERVED', 'HELD')
           AND EXISTS (
               SELECT 1
               FROM "production_reservations" production
               JOIN "capacity_reservations" capacity_reservation
                 ON capacity_reservation."production_reservation_id" = production."id"
               WHERE production."phase_reservation_set_id" = NEW."id"
                 AND capacity_reservation."status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
                 AND capacity_reservation."starts_at" <= clock_timestamp()
           ) THEN
            RAISE EXCEPTION 'phase reservation set % contains capacity that has already started', NEW."id"
                USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_capacity_window_check';
        END IF;

        PERFORM taven_validate_phase_reservation_set(NEW."id");
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION taven_validate_phase_set_from_production()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    set_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        set_id := OLD."phase_reservation_set_id";
    ELSE
        set_id := NEW."phase_reservation_set_id";
    END IF;

    IF set_id IS NOT NULL THEN
        PERFORM taven_validate_phase_reservation_set(set_id);
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION taven_validate_phase_set_from_resource()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    production_id uuid;
    set_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        production_id := OLD."production_reservation_id";
    ELSE
        production_id := NEW."production_reservation_id";
    END IF;

    SELECT "phase_reservation_set_id" INTO set_id
    FROM "production_reservations"
    WHERE "id" = production_id;
    IF set_id IS NOT NULL THEN
        PERFORM taven_validate_phase_reservation_set(set_id);
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "phase_reservation_sets_complete"
    AFTER INSERT OR UPDATE ON "phase_reservation_sets"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION taven_validate_phase_set_from_set();
CREATE CONSTRAINT TRIGGER "production_reservations_complete_set"
    AFTER INSERT OR UPDATE OR DELETE ON "production_reservations"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION taven_validate_phase_set_from_production();
CREATE CONSTRAINT TRIGGER "inventory_reservations_complete_set"
    AFTER INSERT OR UPDATE OR DELETE ON "inventory_reservations"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION taven_validate_phase_set_from_resource();
CREATE CONSTRAINT TRIGGER "capacity_reservations_complete_set"
    AFTER INSERT OR UPDATE OR DELETE ON "capacity_reservations"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION taven_validate_phase_set_from_resource();
