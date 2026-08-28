-- CreateEnum
CREATE TYPE "quote_session_status" AS ENUM ('OPEN', 'EXPIRED', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "quote_request_status" AS ENUM ('NEW', 'IN_REVIEW', 'QUOTED', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "price_component_kind" AS ENUM ('ITEM_PRODUCTION', 'ITEM_QUANTITY', 'ITEM_POSTPROCESSING', 'ORDER_MIN_PRINT', 'ORDER_SMALL_SURCHARGE', 'SHIPMENT', 'EXPRESS', 'PAYMENT_FEE');

-- CreateEnum
CREATE TYPE "price_component_scope" AS ENUM ('ORDER', 'QUOTE_ITEM', 'ORDER_ITEM', 'SHIPMENT_PLAN');

-- CreateEnum
CREATE TYPE "payment_role" AS ENUM ('FULL');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('DRAFT', 'QUOTED', 'EXPIRED', 'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_FULFILLED', 'CANCELLED_SETTLED');

-- CreateEnum
CREATE TYPE "order_phase_kind" AS ENUM ('SINGLE');

-- CreateEnum
CREATE TYPE "order_phase_status" AS ENUM ('QUOTED', 'ACTIVE', 'IN_PRODUCTION', 'QC_PASSED', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'CANCELLED_REFUNDED');

-- CreateEnum
CREATE TYPE "fulfilment_slot_outcome" AS ENUM ('PENDING', 'DELIVERED', 'CANCELLED', 'CANCELLED_REFUNDED');

-- CreateEnum
CREATE TYPE "shipment_status" AS ENUM ('PLANNED', 'LABEL_CREATED', 'HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('CREATED', 'ACCEPTED', 'GCODE_READY', 'PRINTING', 'PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED', 'CANCELLED', 'FAILED', 'QC_REJECTED');

-- CreateEnum
CREATE TYPE "job_failure_stage" AS ENUM ('PREPARATION', 'GCODE', 'MACHINE', 'PRINTING', 'POST_PRINT', 'POST_QC', 'PACKING');

-- CreateEnum
CREATE TYPE "job_cancellation_reason" AS ENUM ('ROUTING_EXHAUSTED', 'ORDER_CANCELLED', 'PHASE_CANCELLED', 'CLAIM_WITHDRAWN');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('CREATED', 'PENDING', 'CAPTURED', 'FAILED', 'VOIDED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "refund_reason" AS ENUM ('CUSTOMER_CANCELLATION', 'PRODUCTION_FAILURE', 'LATE_CAPTURE_COMPENSATION');

-- CreateEnum
CREATE TYPE "audit_actor_kind" AS ENUM ('SYSTEM', 'CUSTOMER', 'OPERATOR');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "display_name" VARCHAR(200),
    "phone" VARCHAR(50),
    "first_attribution" JSONB,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_sessions" (
    "id" UUID NOT NULL,
    "customer_id" UUID,
    "public_token_hash" VARCHAR(64) NOT NULL,
    "status" "quote_session_status" NOT NULL DEFAULT 'OPEN',
    "attribution" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "quote_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_requests" (
    "id" UUID NOT NULL,
    "quote_session_id" UUID,
    "customer_id" UUID,
    "status" "quote_request_status" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "quote_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "quote_request_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_items" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "source_model_file_id" UUID NOT NULL,
    "model_geometry_id" UUID NOT NULL,
    "print_config_revision_id" UUID NOT NULL,
    "reference_slice_result_id" UUID,
    "material" "material" NOT NULL,
    "color" VARCHAR(100),
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quote_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_snapshots" (
    "id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "contract_total_minor" BIGINT NOT NULL,
    "pricing_revision" VARCHAR(100) NOT NULL,
    "input_snapshot" JSONB NOT NULL,
    "snapshot_hash" VARCHAR(64) NOT NULL,
    "sealed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_snapshot_components" (
    "id" UUID NOT NULL,
    "price_snapshot_id" UUID NOT NULL,
    "kind" "price_component_kind" NOT NULL,
    "scope" "price_component_scope" NOT NULL,
    "quote_item_id" UUID,
    "order_item_id" UUID,
    "shipment_plan_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "allocation" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_snapshot_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_component_fulfilment_allocations" (
    "price_snapshot_component_id" UUID NOT NULL,
    "fulfilment_slot_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    CONSTRAINT "price_component_fulfilment_allocations_pkey" PRIMARY KEY ("price_snapshot_component_id", "fulfilment_slot_id")
);

-- CreateTable
CREATE TABLE "payment_schedules" (
    "id" UUID NOT NULL,
    "price_snapshot_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" "payment_role" NOT NULL,
    "gross_amount_minor" BIGINT NOT NULL,
    "fee_rate_basis_points" INTEGER NOT NULL,
    "fee_fixed_minor" BIGINT NOT NULL,
    "provider_config" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "customer_id" UUID,
    "public_reference" VARCHAR(50) NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'DRAFT',
    "quoted_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "source_model_file_id" UUID NOT NULL,
    "model_geometry_id" UUID NOT NULL,
    "print_config_revision_id" UUID NOT NULL,
    "reference_slice_result_id" UUID,
    "material" "material" NOT NULL,
    "color" VARCHAR(100),
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automatic_order_origins" (
    "order_id" UUID NOT NULL,
    "quote_session_id" UUID NOT NULL,
    CONSTRAINT "automatic_order_origins_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "individual_order_origins" (
    "order_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    CONSTRAINT "individual_order_origins_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "quote_price_bindings" (
    "quote_id" UUID NOT NULL,
    "price_snapshot_id" UUID NOT NULL,
    CONSTRAINT "quote_price_bindings_pkey" PRIMARY KEY ("quote_id")
);

-- CreateTable
CREATE TABLE "order_price_bindings" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "price_snapshot_id" UUID NOT NULL,
    "delivery_destination_id" UUID NOT NULL,
    "invalidated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_price_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_destinations" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider_endpoint_id" VARCHAR(255) NOT NULL,
    "endpoint_type" VARCHAR(100) NOT NULL,
    "address_snapshot" JSONB NOT NULL,
    "capability_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_active_price_bindings" (
    "order_id" UUID NOT NULL,
    "order_price_binding_id" UUID NOT NULL,
    CONSTRAINT "order_active_price_bindings_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "individual_order_item_sources" (
    "order_item_id" UUID NOT NULL,
    "quote_item_id" UUID NOT NULL,
    CONSTRAINT "individual_order_item_sources_pkey" PRIMARY KEY ("order_item_id")
);

-- CreateTable
CREATE TABLE "order_phases" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" "order_phase_kind" NOT NULL DEFAULT 'SINGLE',
    "status" "order_phase_status" NOT NULL DEFAULT 'QUOTED',
    "activated_at" TIMESTAMPTZ(3),
    "qc_passed_at" TIMESTAMPTZ(3),
    "shipped_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "order_phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_plans" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_phase_id" UUID NOT NULL,
    "price_snapshot_id" UUID NOT NULL,
    "order_price_binding_id" UUID NOT NULL,
    "delivery_destination_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "planned_volume_cubic_mm" BIGINT NOT NULL,
    "planned_weight_milligrams" BIGINT NOT NULL,
    "shipping_amount_minor" BIGINT NOT NULL,
    "packaging_amount_minor" BIGINT NOT NULL,
    "handling_amount_minor" BIGINT NOT NULL,
    "allocation_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shipment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfilment_slots" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_phase_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity_ordinal" INTEGER NOT NULL,
    "settlement_amount_minor" BIGINT NOT NULL,
    "outcome" "fulfilment_slot_outcome" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "fulfilment_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_plan_fulfilment_slots" (
    "shipment_plan_id" UUID NOT NULL,
    "order_price_binding_id" UUID NOT NULL,
    "fulfilment_slot_id" UUID NOT NULL,
    CONSTRAINT "shipment_plan_fulfilment_slots_pkey" PRIMARY KEY ("shipment_plan_id", "fulfilment_slot_id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_phase_id" UUID NOT NULL,
    "shipment_plan_id" UUID NOT NULL,
    "delivery_destination_id" UUID NOT NULL,
    "replaces_shipment_id" UUID,
    "status" "shipment_status" NOT NULL DEFAULT 'PLANNED',
    "carrier" VARCHAR(100),
    "provider_shipment_id" VARCHAR(255),
    "tracking_code" VARCHAR(255),
    "label_created_at" TIMESTAMPTZ(3),
    "handed_over_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_phase_id" UUID NOT NULL,
    "shipment_plan_id" UUID NOT NULL,
    "phase_resource_plan_job_id" UUID NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'CREATED',
    "accepted_at" TIMESTAMPTZ(3),
    "payout_amount" BIGINT,
    "payout_currency" CHAR(3),
    "gcode_ready_at" TIMESTAMPTZ(3),
    "production_slice_result_id" UUID,
    "production_artifact_hash" VARCHAR(64),
    "printing_at" TIMESTAMPTZ(3),
    "printed_at" TIMESTAMPTZ(3),
    "photo_submitted_at" TIMESTAMPTZ(3),
    "qc_photo_asset_id" UUID,
    "qc_approved_at" TIMESTAMPTZ(3),
    "qc_rejected_at" TIMESTAMPTZ(3),
    "packed_at" TIMESTAMPTZ(3),
    "handed_over_at" TIMESTAMPTZ(3),
    "settled_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "failure_stage" "job_failure_stage",
    "failure_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" "job_cancellation_reason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "price_snapshot_id" UUID NOT NULL,
    "order_price_binding_id" UUID NOT NULL,
    "payment_schedule_id" UUID NOT NULL,
    "role" "payment_role" NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "provider_intent_id" VARCHAR(255),
    "provider_capture_id" VARCHAR(255),
    "requested_amount_minor" BIGINT NOT NULL,
    "captured_amount_minor" BIGINT,
    "currency" CHAR(3) NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'CREATED',
    "capture_authorized" BOOLEAN NOT NULL DEFAULT true,
    "capture_cutoff_at" TIMESTAMPTZ(3),
    "checkout_capture_expires_at" TIMESTAMPTZ(3),
    "captured_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_transactions" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "provider_refund_id" VARCHAR(255),
    "amount_minor" BIGINT NOT NULL,
    "reason" "refund_reason" NOT NULL,
    "status" "refund_status" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "refund_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "quote_id" UUID,
    "order_id" UUID,
    "payment_id" UUID,
    "refund_transaction_id" UUID,
    "event_type" VARCHAR(150) NOT NULL,
    "actor_kind" "audit_actor_kind" NOT NULL DEFAULT 'SYSTEM',
    "actor_id" UUID,
    "correlation_id" UUID,
    "idempotency_key" VARCHAR(255),
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");
CREATE UNIQUE INDEX "quote_sessions_public_token_hash_key" ON "quote_sessions"("public_token_hash");
CREATE INDEX "quote_sessions_customer_id_created_at_idx" ON "quote_sessions"("customer_id", "created_at");
CREATE INDEX "quote_sessions_status_expires_at_idx" ON "quote_sessions"("status", "expires_at");
CREATE UNIQUE INDEX "quote_requests_quote_session_id_key" ON "quote_requests"("quote_session_id");
CREATE INDEX "quote_requests_customer_id_status_idx" ON "quote_requests"("customer_id", "status");
CREATE UNIQUE INDEX "quotes_quote_request_id_key" ON "quotes"("quote_request_id");
CREATE UNIQUE INDEX "quotes_id_customer_key" ON "quotes"("id", "customer_id");
CREATE INDEX "quotes_customer_id_issued_at_idx" ON "quotes"("customer_id", "issued_at");
CREATE UNIQUE INDEX "quote_items_quote_id_ordinal_key" ON "quote_items"("quote_id", "ordinal");
CREATE UNIQUE INDEX "quote_items_id_quote_id_key" ON "quote_items"("id", "quote_id");
CREATE INDEX "quote_items_model_geometry_id_idx" ON "quote_items"("model_geometry_id");
CREATE UNIQUE INDEX "price_snapshots_snapshot_hash_key" ON "price_snapshots"("snapshot_hash");
CREATE UNIQUE INDEX "price_snapshots_id_currency_key" ON "price_snapshots"("id", "currency");
CREATE INDEX "price_snapshot_components_price_snapshot_id_kind_idx" ON "price_snapshot_components"("price_snapshot_id", "kind");
CREATE INDEX "price_snapshot_components_quote_item_id_idx" ON "price_snapshot_components"("quote_item_id");
CREATE INDEX "price_snapshot_components_order_item_id_idx" ON "price_snapshot_components"("order_item_id");
CREATE INDEX "price_snapshot_components_shipment_plan_id_idx" ON "price_snapshot_components"("shipment_plan_id");
CREATE UNIQUE INDEX "payment_schedules_price_snapshot_id_sequence_key" ON "payment_schedules"("price_snapshot_id", "sequence");
CREATE UNIQUE INDEX "payment_schedules_price_snapshot_id_role_key" ON "payment_schedules"("price_snapshot_id", "role");
CREATE UNIQUE INDEX "payment_schedules_contract_key" ON "payment_schedules"("id", "price_snapshot_id", "role", "gross_amount_minor");
CREATE UNIQUE INDEX "orders_public_reference_key" ON "orders"("public_reference");
CREATE INDEX "orders_customer_id_created_at_idx" ON "orders"("customer_id", "created_at");
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");
CREATE UNIQUE INDEX "order_items_order_id_ordinal_key" ON "order_items"("order_id", "ordinal");
CREATE UNIQUE INDEX "order_items_id_order_id_key" ON "order_items"("id", "order_id");
CREATE INDEX "order_items_model_geometry_id_idx" ON "order_items"("model_geometry_id");
CREATE UNIQUE INDEX "automatic_order_origins_quote_session_id_key" ON "automatic_order_origins"("quote_session_id");
CREATE UNIQUE INDEX "individual_order_origins_quote_id_key" ON "individual_order_origins"("quote_id");
CREATE UNIQUE INDEX "quote_price_bindings_price_snapshot_id_key" ON "quote_price_bindings"("price_snapshot_id");
CREATE UNIQUE INDEX "order_price_bindings_price_snapshot_id_key" ON "order_price_bindings"("price_snapshot_id");
CREATE UNIQUE INDEX "order_price_bindings_order_snapshot_key" ON "order_price_bindings"("order_id", "price_snapshot_id");
CREATE UNIQUE INDEX "order_price_bindings_payment_contract_key" ON "order_price_bindings"("id", "order_id", "price_snapshot_id");
CREATE UNIQUE INDEX "order_price_bindings_contract_destination_key" ON "order_price_bindings"("id", "order_id", "price_snapshot_id", "delivery_destination_id");
CREATE UNIQUE INDEX "delivery_destinations_id_order_id_key" ON "delivery_destinations"("id", "order_id");
CREATE INDEX "delivery_destinations_order_id_created_at_idx" ON "delivery_destinations"("order_id", "created_at");
CREATE UNIQUE INDEX "order_active_price_bindings_order_price_binding_id_key" ON "order_active_price_bindings"("order_price_binding_id");
CREATE UNIQUE INDEX "individual_order_item_sources_quote_item_id_key" ON "individual_order_item_sources"("quote_item_id");
CREATE UNIQUE INDEX "order_phases_order_id_key" ON "order_phases"("order_id");
CREATE UNIQUE INDEX "order_phases_id_order_id_key" ON "order_phases"("id", "order_id");
CREATE UNIQUE INDEX "shipment_plans_order_phase_id_order_price_binding_id_ordina_key" ON "shipment_plans"("order_phase_id", "order_price_binding_id", "ordinal");
CREATE UNIQUE INDEX "shipment_plans_id_order_id_order_phase_id_key" ON "shipment_plans"("id", "order_id", "order_phase_id");
CREATE UNIQUE INDEX "shipment_plans_id_order_price_binding_id_key" ON "shipment_plans"("id", "order_price_binding_id");
CREATE UNIQUE INDEX "shipment_plans_id_order_id_order_phase_id_delivery_destinat_key" ON "shipment_plans"("id", "order_id", "order_phase_id", "delivery_destination_id");
CREATE UNIQUE INDEX "shipment_plans_id_price_snapshot_id_key" ON "shipment_plans"("id", "price_snapshot_id");
CREATE INDEX "shipment_plans_order_id_idx" ON "shipment_plans"("order_id");
CREATE UNIQUE INDEX "fulfilment_slots_order_item_id_order_phase_id_quantity_ordi_key" ON "fulfilment_slots"("order_item_id", "order_phase_id", "quantity_ordinal");
CREATE INDEX "fulfilment_slots_order_phase_id_idx" ON "fulfilment_slots"("order_phase_id");
CREATE UNIQUE INDEX "shipment_plan_fulfilment_slots_order_price_binding_id_fulfi_key" ON "shipment_plan_fulfilment_slots"("order_price_binding_id", "fulfilment_slot_id");
CREATE INDEX "shipment_plan_fulfilment_slots_fulfilment_slot_id_idx" ON "shipment_plan_fulfilment_slots"("fulfilment_slot_id");
CREATE INDEX "price_component_fulfilment_allocations_fulfilment_slot_id_idx" ON "price_component_fulfilment_allocations"("fulfilment_slot_id");
CREATE UNIQUE INDEX "shipments_carrier_provider_shipment_id_key" ON "shipments"("carrier", "provider_shipment_id");
CREATE UNIQUE INDEX "shipments_replaces_shipment_id_key" ON "shipments"("replaces_shipment_id", "shipment_plan_id", "order_id", "order_phase_id", "delivery_destination_id");
CREATE UNIQUE INDEX "shipments_lineage_scope_key" ON "shipments"("id", "shipment_plan_id", "order_id", "order_phase_id", "delivery_destination_id");
CREATE UNIQUE INDEX "shipments_plan_root_key" ON "shipments"("shipment_plan_id") WHERE "replaces_shipment_id" IS NULL;
CREATE INDEX "shipments_order_id_status_idx" ON "shipments"("order_id", "status");
CREATE INDEX "shipments_shipment_plan_id_status_idx" ON "shipments"("shipment_plan_id", "status");
CREATE UNIQUE INDEX "jobs_id_node_id_phase_resource_plan_job_id_key" ON "jobs"("id", "node_id", "phase_resource_plan_job_id");
CREATE UNIQUE INDEX "jobs_phase_resource_plan_job_id_key" ON "jobs"("phase_resource_plan_job_id");
CREATE UNIQUE INDEX "jobs_qc_photo_asset_id_key" ON "jobs"("qc_photo_asset_id");
CREATE INDEX "jobs_shipment_plan_id_status_idx" ON "jobs"("shipment_plan_id", "status");
CREATE INDEX "jobs_node_id_status_idx" ON "jobs"("node_id", "status");
CREATE INDEX "jobs_production_slice_result_id_idx" ON "jobs"("production_slice_result_id");
CREATE UNIQUE INDEX "payments_provider_provider_intent_id_key" ON "payments"("provider", "provider_intent_id");
CREATE UNIQUE INDEX "payments_provider_provider_capture_id_key" ON "payments"("provider", "provider_capture_id");
CREATE UNIQUE INDEX "payments_one_nonfailed_attempt_per_schedule_key" ON "payments"("payment_schedule_id") WHERE "status" <> 'FAILED';
CREATE INDEX "payments_order_id_status_idx" ON "payments"("order_id", "status");
CREATE INDEX "payments_capture_cutoff_at_status_idx" ON "payments"("capture_cutoff_at", "status");
CREATE INDEX "payments_checkout_capture_expires_at_status_idx" ON "payments"("checkout_capture_expires_at", "status");
CREATE UNIQUE INDEX "refund_transactions_provider_provider_refund_id_key" ON "refund_transactions"("provider", "provider_refund_id");
CREATE UNIQUE INDEX "refund_transactions_payment_id_idempotency_key_key" ON "refund_transactions"("payment_id", "idempotency_key");
CREATE INDEX "refund_transactions_payment_id_status_idx" ON "refund_transactions"("payment_id", "status");
CREATE INDEX "audit_events_quote_id_created_at_idx" ON "audit_events"("quote_id", "created_at");
CREATE INDEX "audit_events_order_id_created_at_idx" ON "audit_events"("order_id", "created_at");
CREATE INDEX "audit_events_payment_id_created_at_idx" ON "audit_events"("payment_id", "created_at");
CREATE INDEX "audit_events_refund_transaction_id_created_at_idx" ON "audit_events"("refund_transaction_id", "created_at");

-- AddForeignKey
ALTER TABLE "quote_sessions" ADD CONSTRAINT "quote_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_quote_session_id_fkey" FOREIGN KEY ("quote_session_id") REFERENCES "quote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_quote_request_id_fkey" FOREIGN KEY ("quote_request_id") REFERENCES "quote_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_source_model_file_id_fkey" FOREIGN KEY ("source_model_file_id") REFERENCES "model_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_model_geometry_id_source_model_file_id_fkey" FOREIGN KEY ("model_geometry_id", "source_model_file_id") REFERENCES "model_geometries"("id", "source_model_file_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_print_config_revision_id_fkey" FOREIGN KEY ("print_config_revision_id") REFERENCES "print_config_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_reference_slice_result_id_fkey" FOREIGN KEY ("reference_slice_result_id") REFERENCES "slice_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_snapshot_components" ADD CONSTRAINT "price_snapshot_components_price_snapshot_id_fkey" FOREIGN KEY ("price_snapshot_id") REFERENCES "price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_snapshot_components" ADD CONSTRAINT "price_snapshot_components_quote_item_id_fkey" FOREIGN KEY ("quote_item_id") REFERENCES "quote_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_snapshot_components" ADD CONSTRAINT "price_snapshot_components_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_snapshot_components" ADD CONSTRAINT "price_snapshot_components_shipment_plan_snapshot_fkey" FOREIGN KEY ("shipment_plan_id", "price_snapshot_id") REFERENCES "shipment_plans"("id", "price_snapshot_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_component_fulfilment_allocations" ADD CONSTRAINT "price_component_fulfilment_allocations_price_snapshot_comp_fkey" FOREIGN KEY ("price_snapshot_component_id") REFERENCES "price_snapshot_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_component_fulfilment_allocations" ADD CONSTRAINT "price_component_fulfilment_allocations_fulfilment_slot_id_fkey" FOREIGN KEY ("fulfilment_slot_id") REFERENCES "fulfilment_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_price_snapshot_id_fkey" FOREIGN KEY ("price_snapshot_id") REFERENCES "price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_source_model_file_id_fkey" FOREIGN KEY ("source_model_file_id") REFERENCES "model_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_model_geometry_id_source_model_file_id_fkey" FOREIGN KEY ("model_geometry_id", "source_model_file_id") REFERENCES "model_geometries"("id", "source_model_file_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_print_config_revision_id_fkey" FOREIGN KEY ("print_config_revision_id") REFERENCES "print_config_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_reference_slice_result_id_fkey" FOREIGN KEY ("reference_slice_result_id") REFERENCES "slice_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_order_origins" ADD CONSTRAINT "automatic_order_origins_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_order_origins" ADD CONSTRAINT "automatic_order_origins_quote_session_id_fkey" FOREIGN KEY ("quote_session_id") REFERENCES "quote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "individual_order_origins" ADD CONSTRAINT "individual_order_origins_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "individual_order_origins" ADD CONSTRAINT "individual_order_origins_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_price_bindings" ADD CONSTRAINT "quote_price_bindings_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_price_bindings" ADD CONSTRAINT "quote_price_bindings_price_snapshot_id_fkey" FOREIGN KEY ("price_snapshot_id") REFERENCES "price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_price_bindings" ADD CONSTRAINT "order_price_bindings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_price_bindings" ADD CONSTRAINT "order_price_bindings_price_snapshot_id_fkey" FOREIGN KEY ("price_snapshot_id") REFERENCES "price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_price_bindings" ADD CONSTRAINT "order_price_bindings_delivery_destination_id_order_id_fkey" FOREIGN KEY ("delivery_destination_id", "order_id") REFERENCES "delivery_destinations"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_destinations" ADD CONSTRAINT "delivery_destinations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_active_price_bindings" ADD CONSTRAINT "order_active_price_bindings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_active_price_bindings" ADD CONSTRAINT "order_active_price_bindings_order_price_binding_id_fkey" FOREIGN KEY ("order_price_binding_id") REFERENCES "order_price_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "individual_order_item_sources" ADD CONSTRAINT "individual_order_item_sources_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "individual_order_item_sources" ADD CONSTRAINT "individual_order_item_sources_quote_item_id_fkey" FOREIGN KEY ("quote_item_id") REFERENCES "quote_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_phases" ADD CONSTRAINT "order_phases_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_plans" ADD CONSTRAINT "shipment_plans_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_plans" ADD CONSTRAINT "shipment_plans_order_phase_id_order_id_fkey" FOREIGN KEY ("order_phase_id", "order_id") REFERENCES "order_phases"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_plans" ADD CONSTRAINT "shipment_plans_order_snapshot_fkey" FOREIGN KEY ("order_price_binding_id", "order_id", "price_snapshot_id", "delivery_destination_id") REFERENCES "order_price_bindings"("id", "order_id", "price_snapshot_id", "delivery_destination_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_plans" ADD CONSTRAINT "shipment_plans_price_snapshot_id_fkey" FOREIGN KEY ("price_snapshot_id") REFERENCES "price_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_plans" ADD CONSTRAINT "shipment_plans_delivery_destination_id_order_id_fkey" FOREIGN KEY ("delivery_destination_id", "order_id") REFERENCES "delivery_destinations"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fulfilment_slots" ADD CONSTRAINT "fulfilment_slots_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fulfilment_slots" ADD CONSTRAINT "fulfilment_slots_order_phase_id_order_id_fkey" FOREIGN KEY ("order_phase_id", "order_id") REFERENCES "order_phases"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fulfilment_slots" ADD CONSTRAINT "fulfilment_slots_order_item_id_order_id_fkey" FOREIGN KEY ("order_item_id", "order_id") REFERENCES "order_items"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_plan_fulfilment_slots" ADD CONSTRAINT "shipment_plan_fulfilment_slots_shipment_plan_id_order_pric_fkey" FOREIGN KEY ("shipment_plan_id", "order_price_binding_id") REFERENCES "shipment_plans"("id", "order_price_binding_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_plan_fulfilment_slots" ADD CONSTRAINT "shipment_plan_fulfilment_slots_order_price_binding_id_fkey" FOREIGN KEY ("order_price_binding_id") REFERENCES "order_price_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_plan_fulfilment_slots" ADD CONSTRAINT "shipment_plan_fulfilment_slots_fulfilment_slot_id_fkey" FOREIGN KEY ("fulfilment_slot_id") REFERENCES "fulfilment_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_phase_id_order_id_fkey" FOREIGN KEY ("order_phase_id", "order_id") REFERENCES "order_phases"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_shipment_plan_id_order_id_order_phase_id_deliver_fkey" FOREIGN KEY ("shipment_plan_id", "order_id", "order_phase_id", "delivery_destination_id") REFERENCES "shipment_plans"("id", "order_id", "order_phase_id", "delivery_destination_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_delivery_destination_id_order_id_fkey" FOREIGN KEY ("delivery_destination_id", "order_id") REFERENCES "delivery_destinations"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_replacement_scope_fkey" FOREIGN KEY ("replaces_shipment_id", "shipment_plan_id", "order_id", "order_phase_id", "delivery_destination_id") REFERENCES "shipments"("id", "shipment_plan_id", "order_id", "order_phase_id", "delivery_destination_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_order_phase_id_order_id_fkey" FOREIGN KEY ("order_phase_id", "order_id") REFERENCES "order_phases"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_shipment_plan_id_order_id_order_phase_id_fkey" FOREIGN KEY ("shipment_plan_id", "order_id", "order_phase_id") REFERENCES "shipment_plans"("id", "order_id", "order_phase_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_phase_resource_plan_job_id_node_id_fkey" FOREIGN KEY ("phase_resource_plan_job_id", "node_id") REFERENCES "phase_resource_plan_jobs"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_production_slice_result_id_fkey" FOREIGN KEY ("production_slice_result_id") REFERENCES "slice_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_qc_photo_asset_id_fkey" FOREIGN KEY ("qc_photo_asset_id") REFERENCES "photo_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_snapshot_fkey" FOREIGN KEY ("order_price_binding_id", "order_id", "price_snapshot_id") REFERENCES "order_price_bindings"("id", "order_id", "price_snapshot_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_snapshot_currency_fkey" FOREIGN KEY ("price_snapshot_id", "currency") REFERENCES "price_snapshots"("id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_schedule_contract_fkey" FOREIGN KEY ("payment_schedule_id", "price_snapshot_id", "role", "requested_amount_minor") REFERENCES "payment_schedules"("id", "price_snapshot_id", "role", "gross_amount_minor") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_transactions" ADD CONSTRAINT "refund_transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_refund_transaction_id_fkey" FOREIGN KEY ("refund_transaction_id") REFERENCES "refund_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Refuse an unsafe upgrade: issue #15 persisted these identifiers as UUID seams
-- without a recoverable ownership mapping. A data migration must be designed
-- separately if any of the seam tables already contain rows.
DO $$
DECLARE
    seam_table text;
    has_rows boolean;
BEGIN
    FOREACH seam_table IN ARRAY ARRAY[
        'candidate_resource_estimates',
        'eligibility_snapshots',
        'phase_resource_plan_slots',
        'production_reservations'
    ] LOOP
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', seam_table) INTO has_rows;
        IF has_rows THEN
            RAISE EXCEPTION 'cannot apply v0 commerce foundations: issue-15 seam table % is non-empty; provide an explicit backfill migration', seam_table
                USING ERRCODE = '55000';
        END IF;
    END LOOP;
END;
$$;

-- Replace issue-15 UUID seams with relational foreign keys.
ALTER TABLE "candidate_resource_estimates" ADD CONSTRAINT "candidate_resource_estimates_shipment_plan_id_fkey" FOREIGN KEY ("shipment_plan_id") REFERENCES "shipment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "eligibility_snapshots" ADD CONSTRAINT "eligibility_snapshots_order_phase_id_fkey" FOREIGN KEY ("order_phase_id") REFERENCES "order_phases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "phase_resource_plan_slots" ADD CONSTRAINT "phase_resource_plan_slots_fulfilment_slot_id_fkey" FOREIGN KEY ("fulfilment_slot_id") REFERENCES "fulfilment_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_job_scope_fkey" FOREIGN KEY ("job_id", "node_id", "phase_resource_plan_job_id") REFERENCES "jobs"("id", "node_id", "phase_resource_plan_job_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Focused data checks.
ALTER TABLE "model_files" ADD COLUMN "source_retention_days" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "model_files" ADD CONSTRAINT "model_files_source_retention_days_check" CHECK ("source_retention_days" > 0);
ALTER TABLE "photo_assets" ADD COLUMN "retention_days" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "photo_assets" ADD CONSTRAINT "photo_assets_retention_days_check" CHECK ("retention_days" > 0);
ALTER TABLE "customers" ADD CONSTRAINT "customers_email_normalized_check" CHECK ("email" = lower(btrim("email")) AND "email" ~ '[^[:space:]]' AND "email" !~ '[[:space:]]');
ALTER TABLE "quote_sessions" ADD CONSTRAINT "quote_sessions_expiry_check" CHECK ("expires_at" > "created_at");
ALTER TABLE "quote_sessions" ADD CONSTRAINT "quote_sessions_public_token_hash_check" CHECK ("public_token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_expiry_check" CHECK ("expires_at" > "issued_at");
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_ordinal_quantity_check" CHECK ("ordinal" >= 0 AND "quantity" > 0);
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_money_currency_check" CHECK ("contract_total_minor" >= 0 AND "currency" ~ '^[A-Z]{3}$' AND "snapshot_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "price_snapshot_components" ADD CONSTRAINT "price_snapshot_components_amount_scope_check" CHECK (
    "amount_minor" >= 0
    AND (
        ("scope" = 'ORDER' AND "quote_item_id" IS NULL AND "order_item_id" IS NULL AND "shipment_plan_id" IS NULL)
        OR ("scope" = 'QUOTE_ITEM' AND "quote_item_id" IS NOT NULL AND "order_item_id" IS NULL AND "shipment_plan_id" IS NULL)
        OR ("scope" = 'ORDER_ITEM' AND "quote_item_id" IS NULL AND "order_item_id" IS NOT NULL AND "shipment_plan_id" IS NULL)
        OR ("scope" = 'SHIPMENT_PLAN' AND "quote_item_id" IS NULL AND "order_item_id" IS NULL AND "shipment_plan_id" IS NOT NULL)
    )
    AND (
        ("kind" IN ('ITEM_PRODUCTION', 'ITEM_QUANTITY', 'ITEM_POSTPROCESSING') AND "scope" IN ('QUOTE_ITEM', 'ORDER_ITEM'))
        OR ("kind" = 'SHIPMENT' AND "scope" = 'SHIPMENT_PLAN')
        OR ("kind" IN ('ORDER_MIN_PRINT', 'ORDER_SMALL_SURCHARGE', 'EXPRESS', 'PAYMENT_FEE') AND "scope" = 'ORDER')
    )
);
ALTER TABLE "price_component_fulfilment_allocations" ADD CONSTRAINT "price_component_fulfilment_allocations_amount_check" CHECK ("amount_minor" >= 0);
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_values_check" CHECK ("sequence" >= 0 AND "gross_amount_minor" >= 0 AND "fee_rate_basis_points" >= 0 AND "fee_fixed_minor" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_public_reference_identity_check" CHECK ("public_reference" ~ '[^[:space:]]');
ALTER TABLE "orders" ADD CONSTRAINT "orders_timestamps_check" CHECK (
    ("quoted_at" IS NULL OR "quoted_at" >= "created_at")
    AND ("confirmed_at" IS NULL OR ("quoted_at" IS NOT NULL AND "confirmed_at" >= "quoted_at"))
    AND (
        ("status" = 'DRAFT' AND "quoted_at" IS NULL AND "confirmed_at" IS NULL)
        OR ("status" IN ('QUOTED', 'EXPIRED') AND "quoted_at" IS NOT NULL AND "confirmed_at" IS NULL)
        OR (
            "status" IN (
                'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED', 'READY_TO_SHIP',
                'SHIPPED', 'DELIVERED', 'COMPLETED', 'PARTIALLY_FULFILLED'
            )
            AND "quoted_at" IS NOT NULL
            AND "confirmed_at" IS NOT NULL
        )
        OR (
            "status" IN ('CANCELLED', 'REFUNDED', 'CANCELLED_SETTLED')
            AND "quoted_at" IS NOT NULL
        )
    )
);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_ordinal_quantity_check" CHECK ("ordinal" >= 0 AND "quantity" > 0);
ALTER TABLE "order_phases" ADD CONSTRAINT "order_phases_timestamps_check" CHECK (("activated_at" IS NULL OR "activated_at" >= "created_at") AND ("qc_passed_at" IS NULL OR "qc_passed_at" >= "created_at") AND ("shipped_at" IS NULL OR "shipped_at" >= "created_at") AND ("delivered_at" IS NULL OR "delivered_at" >= "created_at") AND ("completed_at" IS NULL OR "completed_at" >= "created_at") AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at"));
ALTER TABLE "shipment_plans" ADD CONSTRAINT "shipment_plans_values_check" CHECK ("ordinal" >= 0 AND "category" <> '' AND "planned_volume_cubic_mm" >= 0 AND "planned_weight_milligrams" >= 0 AND "shipping_amount_minor" >= 0 AND "packaging_amount_minor" >= 0 AND "handling_amount_minor" >= 0);
ALTER TABLE "fulfilment_slots" ADD CONSTRAINT "fulfilment_slots_values_check" CHECK ("quantity_ordinal" >= 1 AND "settlement_amount_minor" >= 0);
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_timestamps_check" CHECK (("label_created_at" IS NULL OR "label_created_at" >= "created_at") AND ("handed_over_at" IS NULL OR "handed_over_at" >= "created_at") AND ("delivered_at" IS NULL OR "delivered_at" >= "created_at") AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at"));
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_provider_identity_check" CHECK (
    ("carrier" IS NULL OR "carrier" ~ '[^[:space:]]')
    AND ("provider_shipment_id" IS NULL OR "provider_shipment_id" ~ '[^[:space:]]')
    AND ("tracking_code" IS NULL OR "tracking_code" ~ '[^[:space:]]')
);
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_replacement_not_self_check" CHECK ("replaces_shipment_id" IS NULL OR "replaces_shipment_id" <> "id");
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_timestamps_check" CHECK (
    ("accepted_at" IS NULL OR "accepted_at" >= "created_at")
    AND ("gcode_ready_at" IS NULL OR "gcode_ready_at" >= "created_at")
    AND ("printing_at" IS NULL OR "printing_at" >= "created_at")
    AND ("printed_at" IS NULL OR "printed_at" >= "created_at")
    AND ("photo_submitted_at" IS NULL OR "photo_submitted_at" >= "created_at")
    AND ("qc_approved_at" IS NULL OR "qc_approved_at" >= "created_at")
    AND ("qc_rejected_at" IS NULL OR "qc_rejected_at" >= "created_at")
    AND ("packed_at" IS NULL OR "packed_at" >= "created_at")
    AND ("handed_over_at" IS NULL OR "handed_over_at" >= "created_at")
    AND ("settled_at" IS NULL OR "settled_at" >= "created_at")
    AND ("failed_at" IS NULL OR "failed_at" >= "created_at")
    AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at")
    AND ("production_artifact_hash" IS NULL OR "production_artifact_hash" ~ '^[0-9a-f]{64}$')
    AND ("failure_reason" IS NULL OR "failure_reason" ~ '[^[:space:]]')
);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_payout_acceptance_check" CHECK (
    ("accepted_at" IS NULL AND "payout_amount" IS NULL AND "payout_currency" IS NULL)
    OR (
        "accepted_at" IS NOT NULL
        AND "payout_amount" IS NOT NULL
        AND "payout_amount" >= 0
        AND "payout_currency" IS NOT NULL
        AND "payout_currency" ~ '^[A-Z]{3}$'
    )
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_values_check" CHECK ("requested_amount_minor" > 0 AND ("captured_amount_minor" IS NULL OR ("captured_amount_minor" > 0 AND "captured_amount_minor" <= "requested_amount_minor")) AND "currency" ~ '^[A-Z]{3}$' AND ("capture_cutoff_at" IS NULL OR "capture_cutoff_at" >= "created_at") AND ("checkout_capture_expires_at" IS NULL OR "checkout_capture_expires_at" > "created_at") AND ("captured_at" IS NULL OR "captured_at" >= "created_at"));
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_identity_check" CHECK (
    "provider" ~ '[^[:space:]]'
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_capture_authorization_pair_check" CHECK (
    "capture_authorized" = ("capture_cutoff_at" IS NULL)
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_intent_identity_check" CHECK (
    ("provider_intent_id" IS NOT NULL AND "provider_intent_id" ~ '[^[:space:]]')
    OR ("provider_intent_id" IS NULL AND "status" IN ('CREATED', 'VOIDED'))
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_capture_identity_check" CHECK (
    "provider_capture_id" IS NULL OR "provider_capture_id" ~ '[^[:space:]]'
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_capture_facts_check" CHECK (
    (
        "status" IN ('CREATED', 'PENDING', 'FAILED', 'VOIDED')
        AND "captured_amount_minor" IS NULL
        AND "provider_capture_id" IS NULL
        AND "captured_at" IS NULL
    ) OR (
        "status" IN ('CAPTURED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED')
        AND "captured_amount_minor" IS NOT NULL
        AND "provider_capture_id" IS NOT NULL
        AND "captured_at" IS NOT NULL
    )
);
ALTER TABLE "refund_transactions" ADD CONSTRAINT "refund_transactions_values_check" CHECK ("amount_minor" > 0 AND ("completed_at" IS NULL OR "completed_at" >= "requested_at"));
ALTER TABLE "refund_transactions" ADD CONSTRAINT "refund_transactions_idempotency_key_identity_check" CHECK (
    "idempotency_key" ~ '[^[:space:]]'
);
ALTER TABLE "refund_transactions" ADD CONSTRAINT "refund_transactions_provider_refund_identity_check" CHECK (
    "provider_refund_id" IS NULL OR "provider_refund_id" ~ '[^[:space:]]'
);
ALTER TABLE "refund_transactions" ADD CONSTRAINT "refund_transactions_success_facts_check" CHECK (
    "status" <> 'SUCCEEDED'
    OR ("provider_refund_id" IS NOT NULL AND "completed_at" IS NOT NULL)
);
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_scope_check" CHECK ("quote_id" IS NOT NULL OR "order_id" IS NOT NULL OR "payment_id" IS NOT NULL OR "refund_transaction_id" IS NOT NULL);
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_identity_check" CHECK (
    ("actor_kind" = 'SYSTEM' AND "actor_id" IS NULL)
    OR ("actor_kind" IN ('CUSTOMER', 'OPERATOR') AND "actor_id" IS NOT NULL)
);

-- Immutable commercial snapshots and append-only audit rows.
CREATE FUNCTION taven_prevent_commerce_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION taven_protect_price_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND pg_trigger_depth() > 1
       AND OLD."sealed_at" IS NULL
       AND NEW."sealed_at" IS NOT NULL
       AND NEW."sealed_at" IS NOT DISTINCT FROM CURRENT_TIMESTAMP(3)
       AND NEW."id" IS NOT DISTINCT FROM OLD."id"
       AND NEW."currency" IS NOT DISTINCT FROM OLD."currency"
       AND NEW."contract_total_minor" IS NOT DISTINCT FROM OLD."contract_total_minor"
       AND NEW."pricing_revision" IS NOT DISTINCT FROM OLD."pricing_revision"
       AND NEW."input_snapshot" IS NOT DISTINCT FROM OLD."input_snapshot"
       AND NEW."snapshot_hash" IS NOT DISTINCT FROM OLD."snapshot_hash"
       AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
       AND (
           EXISTS (
               SELECT 1
               FROM "quote_price_bindings"
               WHERE "price_snapshot_id" = OLD."id"
           )
           OR EXISTS (
               SELECT 1
               FROM "order_price_bindings"
               WHERE "price_snapshot_id" = OLD."id"
           )
       )
       AND EXISTS (
           SELECT 1
           FROM "price_snapshots" snapshot
           WHERE snapshot."id" = OLD."id"
             AND (
                 SELECT coalesce(sum(component."amount_minor"), 0)
                 FROM "price_snapshot_components" component
                 WHERE component."price_snapshot_id" = snapshot."id"
             ) = snapshot."contract_total_minor"
             AND (
                 SELECT count(*)
                 FROM "payment_schedules" schedule
                 WHERE schedule."price_snapshot_id" = snapshot."id"
                   AND schedule."role" = 'FULL'
             ) = 1
             AND (
                 SELECT coalesce(sum(schedule."gross_amount_minor"), 0)
                 FROM "payment_schedules" schedule
                 WHERE schedule."price_snapshot_id" = snapshot."id"
                   AND schedule."role" = 'FULL'
             ) = snapshot."contract_total_minor"
       ) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'price_snapshots rows are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "price_snapshots_immutable"
BEFORE UPDATE OR DELETE ON "price_snapshots"
FOR EACH ROW EXECUTE FUNCTION taven_protect_price_snapshot();
CREATE TRIGGER "price_snapshot_components_immutable"
BEFORE UPDATE OR DELETE ON "price_snapshot_components"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();
CREATE TRIGGER "payment_schedules_immutable"
BEFORE UPDATE OR DELETE ON "payment_schedules"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();
CREATE TRIGGER "quotes_immutable"
BEFORE UPDATE OR DELETE ON "quotes"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();
CREATE TRIGGER "quote_items_immutable"
BEFORE UPDATE OR DELETE ON "quote_items"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();

CREATE FUNCTION taven_require_unsealed_price_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_snapshot_id uuid := NEW."price_snapshot_id";
    target_sealed_at timestamptz;
BEGIN
    -- Binding and graph assembly share one transaction. The snapshot row lock
    -- serializes that assembly with later attempts to extend the graph.
    SELECT "sealed_at"
    INTO target_sealed_at
    FROM "price_snapshots"
    WHERE "id" = target_snapshot_id
    FOR UPDATE;

    IF target_sealed_at IS NOT NULL THEN
        RAISE EXCEPTION 'sealed price snapshot cannot receive more components or schedules'
            USING ERRCODE = '23514', CONSTRAINT = 'price_snapshot_binding_immutable_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "price_snapshot_components_binding_guard"
BEFORE INSERT ON "price_snapshot_components"
FOR EACH ROW EXECUTE FUNCTION taven_require_unsealed_price_snapshot();
CREATE TRIGGER "payment_schedules_binding_guard"
BEFORE INSERT ON "payment_schedules"
FOR EACH ROW EXECUTE FUNCTION taven_require_unsealed_price_snapshot();

CREATE FUNCTION taven_require_mutable_quote_for_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    request_status "quote_request_status";
BEGIN
    SELECT request."status" INTO request_status
    FROM "quotes" quote
    JOIN "quote_requests" request ON request."id" = quote."quote_request_id"
    WHERE quote."id" = NEW."quote_id"
    FOR UPDATE OF request;

    IF request_status IS DISTINCT FROM 'QUOTED'::"quote_request_status" THEN
        RAISE EXCEPTION 'quote items can be inserted only before the quote is accepted or closed'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_item_accepted_immutable_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "quote_price_bindings"
        WHERE "quote_id" = NEW."quote_id"
    ) THEN
        RAISE EXCEPTION 'quote items cannot be inserted after their immutable price binding exists'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_item_price_binding_immutable_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_items_require_mutable_quote"
BEFORE INSERT ON "quote_items"
FOR EACH ROW EXECUTE FUNCTION taven_require_mutable_quote_for_item();

CREATE FUNCTION taven_validate_item_reference_slice_inputs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."reference_slice_result_id" IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM 1
    FROM "slice_results" slice_result
    JOIN "reference_profiles" reference_profile
      ON reference_profile."id" = slice_result."reference_profile_id"
    WHERE slice_result."id" = NEW."reference_slice_result_id"
      AND slice_result."kind" = 'REFERENCE'
      AND slice_result."model_geometry_id" = NEW."model_geometry_id"
      AND slice_result."print_config_revision_id" = NEW."print_config_revision_id"
      AND reference_profile."material" = NEW."material"
    FOR KEY SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION '% reference slice must be a REFERENCE slice for its exact geometry, print configuration, and material', TG_TABLE_NAME
            USING ERRCODE = '23514',
                  CONSTRAINT = CASE TG_TABLE_NAME
                      WHEN 'quote_items' THEN 'quote_item_reference_slice_input_check'
                      ELSE 'order_item_reference_slice_input_check'
                  END;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_items_reference_slice_inputs"
BEFORE INSERT ON "quote_items"
FOR EACH ROW EXECUTE FUNCTION taven_validate_item_reference_slice_inputs();
CREATE TRIGGER "order_items_reference_slice_inputs"
BEFORE INSERT OR UPDATE OF "reference_slice_result_id", "model_geometry_id", "print_config_revision_id", "material" ON "order_items"
FOR EACH ROW EXECUTE FUNCTION taven_validate_item_reference_slice_inputs();

CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();

CREATE FUNCTION taven_validate_audit_event_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    matching_customer_owners integer;
    mismatched_customer_owners integer;
BEGIN
    IF NEW."quote_id" IS NOT NULL
       AND NEW."order_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "individual_order_origins" origin
           WHERE origin."quote_id" = NEW."quote_id"
             AND origin."order_id" = NEW."order_id"
           UNION ALL
           SELECT 1
           FROM "automatic_order_origins" origin
           JOIN "orders" target_order ON target_order."id" = origin."order_id"
           JOIN "quote_requests" request
             ON request."quote_session_id" = origin."quote_session_id"
           JOIN "quotes" quote ON quote."quote_request_id" = request."id"
           WHERE quote."id" = NEW."quote_id"
             AND origin."order_id" = NEW."order_id"
             AND (target_order."customer_id" IS NULL
                  OR quote."customer_id" = target_order."customer_id")
       ) THEN
        RAISE EXCEPTION 'audit event quote must belong to its scoped order origin'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."quote_id" IS NOT NULL
       AND NEW."payment_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "payments" payment
           JOIN "individual_order_origins" origin
             ON origin."order_id" = payment."order_id"
            AND origin."quote_id" = NEW."quote_id"
           WHERE payment."id" = NEW."payment_id"
           UNION ALL
           SELECT 1
           FROM "payments" payment
           JOIN "automatic_order_origins" origin
             ON origin."order_id" = payment."order_id"
           JOIN "orders" target_order ON target_order."id" = payment."order_id"
           JOIN "quote_requests" request
             ON request."quote_session_id" = origin."quote_session_id"
           JOIN "quotes" quote ON quote."quote_request_id" = request."id"
           WHERE payment."id" = NEW."payment_id"
             AND quote."id" = NEW."quote_id"
             AND (target_order."customer_id" IS NULL
                  OR quote."customer_id" = target_order."customer_id")
       ) THEN
        RAISE EXCEPTION 'audit event quote must belong to its scoped payment order origin'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."quote_id" IS NOT NULL
       AND NEW."refund_transaction_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "refund_transactions" refund
           JOIN "payments" payment ON payment."id" = refund."payment_id"
           JOIN "individual_order_origins" origin
             ON origin."order_id" = payment."order_id"
            AND origin."quote_id" = NEW."quote_id"
           WHERE refund."id" = NEW."refund_transaction_id"
           UNION ALL
           SELECT 1
           FROM "refund_transactions" refund
           JOIN "payments" payment ON payment."id" = refund."payment_id"
           JOIN "automatic_order_origins" origin
             ON origin."order_id" = payment."order_id"
           JOIN "orders" target_order ON target_order."id" = payment."order_id"
           JOIN "quote_requests" request
             ON request."quote_session_id" = origin."quote_session_id"
           JOIN "quotes" quote ON quote."quote_request_id" = request."id"
           WHERE refund."id" = NEW."refund_transaction_id"
             AND quote."id" = NEW."quote_id"
             AND (target_order."customer_id" IS NULL
                  OR quote."customer_id" = target_order."customer_id")
       ) THEN
        RAISE EXCEPTION 'audit event quote must belong to its scoped refund order origin'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."payment_id" IS NOT NULL
       AND NEW."order_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "payments" payment
           WHERE payment."id" = NEW."payment_id"
             AND payment."order_id" = NEW."order_id"
       ) THEN
        RAISE EXCEPTION 'audit event payment must belong to its scoped order'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."refund_transaction_id" IS NOT NULL
       AND NEW."payment_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "refund_transactions" refund
           WHERE refund."id" = NEW."refund_transaction_id"
             AND refund."payment_id" = NEW."payment_id"
       ) THEN
        RAISE EXCEPTION 'audit event refund must belong to its scoped payment'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."refund_transaction_id" IS NOT NULL
       AND NEW."order_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "refund_transactions" refund
           JOIN "payments" payment ON payment."id" = refund."payment_id"
           WHERE refund."id" = NEW."refund_transaction_id"
             AND payment."order_id" = NEW."order_id"
       ) THEN
        RAISE EXCEPTION 'audit event refund must belong to its scoped order'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."actor_kind" = 'CUSTOMER'::"audit_actor_kind"
       AND NEW."actor_id" IS NOT NULL THEN
        SELECT
            count(*) FILTER (WHERE scoped_owner."customer_id" = NEW."actor_id"),
            count(*) FILTER (
                WHERE scoped_owner."customer_id" IS NOT NULL
                  AND scoped_owner."customer_id" <> NEW."actor_id"
            )
        INTO matching_customer_owners, mismatched_customer_owners
        FROM (
            SELECT quote."customer_id"
            FROM "quotes" quote
            WHERE quote."id" = NEW."quote_id"
            UNION ALL
            SELECT target_order."customer_id"
            FROM "orders" target_order
            WHERE target_order."id" = NEW."order_id"
            UNION ALL
            SELECT target_order."customer_id"
            FROM "payments" payment
            JOIN "orders" target_order ON target_order."id" = payment."order_id"
            WHERE payment."id" = NEW."payment_id"
            UNION ALL
            SELECT target_order."customer_id"
            FROM "refund_transactions" refund
            JOIN "payments" payment ON payment."id" = refund."payment_id"
            JOIN "orders" target_order ON target_order."id" = payment."order_id"
            WHERE refund."id" = NEW."refund_transaction_id"
        ) scoped_owner;

        IF matching_customer_owners = 0 OR mismatched_customer_owners > 0 THEN
            RAISE EXCEPTION 'customer audit actor must match every non-null scoped commerce owner'
                USING ERRCODE = '23514', CONSTRAINT = 'audit_event_customer_owner_check';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "audit_events_scope_reconciled"
BEFORE INSERT ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION taven_validate_audit_event_scope();

CREATE FUNCTION taven_prevent_quote_price_binding_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'quote price bindings are immutable issued-quote topology'
        USING ERRCODE = '23514', CONSTRAINT = 'quote_price_binding_immutable_check';
END;
$$;

CREATE TRIGGER "quote_price_bindings_immutable"
BEFORE UPDATE OR DELETE ON "quote_price_bindings"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_quote_price_binding_mutation();

CREATE FUNCTION taven_require_quotable_request_for_price_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    request_status "quote_request_status";
BEGIN
    SELECT request."status"
    INTO request_status
    FROM "quotes" quote
    JOIN "quote_requests" request ON request."id" = quote."quote_request_id"
    WHERE quote."id" = NEW."quote_id"
    FOR UPDATE OF request;

    PERFORM 1
    FROM "price_snapshots"
    WHERE "id" = NEW."price_snapshot_id"
    FOR UPDATE;

    IF request_status IS DISTINCT FROM 'QUOTED'::"quote_request_status" THEN
        RAISE EXCEPTION 'quote price binding must be fixed before quote acceptance or closure'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_price_binding_acceptance_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_price_bindings_require_quotable_request"
BEFORE INSERT ON "quote_price_bindings"
FOR EACH ROW EXECUTE FUNCTION taven_require_quotable_request_for_price_binding();

-- A draft may be assembled incrementally. Once quoted, exactly one stable
-- single phase is required; the immediate foreign key still requires Order
-- insertion before its phase in the same transaction.
CREATE FUNCTION taven_require_initial_quoted_single_phase()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    phase_count integer;
BEGIN
    IF NEW."status" <> 'QUOTED' THEN
        RETURN NULL;
    END IF;

    SELECT count(*) INTO phase_count
    FROM "order_phases"
    WHERE "order_id" = NEW."id"
      AND "kind" = 'SINGLE'
      AND "status" = 'QUOTED';

    IF phase_count <> 1 THEN
        RAISE EXCEPTION 'new order requires exactly one quoted single phase' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "order_active_price_bindings" active
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
        WHERE active."order_id" = NEW."id"
          AND binding."order_id" = NEW."id"
          AND binding."invalidated_at" IS NULL
    ) THEN
        RAISE EXCEPTION 'quoted order requires one active destination-bound price binding'
            USING ERRCODE = '23514', CONSTRAINT = 'quoted_order_binding_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "individual_order_origins" origin
        WHERE origin."order_id" = NEW."id"
          AND (
              EXISTS (
                  SELECT 1
                  FROM "order_items" item
                  LEFT JOIN "individual_order_item_sources" source
                    ON source."order_item_id" = item."id"
                  WHERE item."order_id" = origin."order_id"
                    AND source."order_item_id" IS NULL
              )
              OR EXISTS (
                  SELECT 1
                  FROM "quote_items" quote_item
                  LEFT JOIN "individual_order_item_sources" source
                    ON source."quote_item_id" = quote_item."id"
                  LEFT JOIN "order_items" item
                    ON item."id" = source."order_item_id"
                   AND item."order_id" = origin."order_id"
                  WHERE quote_item."quote_id" = origin."quote_id"
                    AND item."id" IS NULL
              )
          )
    ) THEN
        RAISE EXCEPTION 'quoted individual order requires an exact immutable source for every item'
            USING ERRCODE = '23514', CONSTRAINT = 'individual_order_item_completion_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "automatic_order_origins" origin
        JOIN "individual_order_item_sources" source ON true
        JOIN "order_items" item ON item."id" = source."order_item_id"
        WHERE origin."order_id" = NEW."id"
          AND item."order_id" = NEW."id"
    ) THEN
        RAISE EXCEPTION 'automatic order items cannot claim a QuoteItem source'
            USING ERRCODE = '23514', CONSTRAINT = 'automatic_order_item_source_check';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "order_active_price_bindings" active
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
        JOIN "price_snapshots" snapshot
          ON snapshot."id" = binding."price_snapshot_id"
        JOIN "payment_schedules" schedule
          ON schedule."price_snapshot_id" = snapshot."id"
         AND schedule."role" = 'FULL'
        WHERE active."order_id" = NEW."id"
          AND binding."order_id" = NEW."id"
          AND binding."invalidated_at" IS NULL
          AND snapshot."contract_total_minor" > 0
          AND schedule."gross_amount_minor" > 0
    ) THEN
        RAISE EXCEPTION 'quoted order requires a positive contract total and full payment schedule'
            USING ERRCODE = '23514', CONSTRAINT = 'quoted_order_positive_payment_check';
    END IF;

    PERFORM taven_assert_order_fulfilment_money(NEW."id");

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_require_initial_quoted_single_phase"
AFTER INSERT OR UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_require_initial_quoted_single_phase();

CREATE FUNCTION taven_validate_issued_quote()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
    request_created_at timestamptz;
BEGIN
    SELECT "created_at"
    INTO request_created_at
    FROM "quote_requests"
    WHERE "id" = NEW."quote_request_id"
    FOR UPDATE;

    IF NEW."issued_at" < request_created_at THEN
        RAISE EXCEPTION 'Quote issuance evidence cannot predate its request'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_issuance_request_created_at_check';
    END IF;

    IF NEW."issued_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'Quote issuance evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_issuance_evidence_check';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "quote_requests" request
        WHERE request."id" = NEW."quote_request_id"
          AND request."customer_id" = NEW."customer_id"
          AND request."status" = 'QUOTED'
    ) THEN
        RAISE EXCEPTION 'issued quote must belong to a quoted request with the same customer'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_issued_quote_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "quotes_issued_from_quoted_request"
BEFORE INSERT ON "quotes"
FOR EACH ROW EXECUTE FUNCTION taven_validate_issued_quote();

CREATE FUNCTION taven_protect_quote_session_customer_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    IF OLD."customer_id" IS NULL
       AND NEW."customer_id" IS NOT NULL THEN
        SELECT origin."order_id"
        INTO target_order_id
        FROM "automatic_order_origins" origin
        WHERE origin."quote_session_id" = OLD."id";

        IF target_order_id IS NOT NULL THEN
            PERFORM taven_lock_automatic_order_session(target_order_id);
        END IF;

        PERFORM 1
        FROM "automatic_order_origins" origin
        JOIN "orders" target_order ON target_order."id" = origin."order_id"
        WHERE origin."quote_session_id" = OLD."id"
        ORDER BY target_order."id"
        FOR UPDATE OF target_order;
    END IF;

    IF OLD."customer_id" IS NOT NULL
       AND NEW."customer_id" IS NULL
       AND (
           EXISTS (
               SELECT 1
               FROM "quote_requests" request
               WHERE request."quote_session_id" = OLD."id"
           )
           OR EXISTS (
               SELECT 1
               FROM "automatic_order_origins" origin
               WHERE origin."quote_session_id" = OLD."id"
           )
       ) THEN
        RAISE EXCEPTION 'an attached quote session cannot lose its customer owner'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_session_owner_removal_check';
    END IF;

    IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id"
       AND NEW."customer_id" IS NOT NULL
       AND EXISTS (
           SELECT 1
           FROM "quote_requests" request
           WHERE request."quote_session_id" = OLD."id"
             AND request."customer_id" IS NOT NULL
             AND request."customer_id" <> NEW."customer_id"
       ) THEN
        RAISE EXCEPTION 'quote session customer cannot contradict its quote request owner'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_session_owner_check';
    END IF;

    IF NEW."customer_id" IS DISTINCT FROM OLD."customer_id"
       AND EXISTS (
           SELECT 1
           FROM "automatic_order_origins" origin
           JOIN "orders" target_order ON target_order."id" = origin."order_id"
           WHERE origin."quote_session_id" = OLD."id"
             AND NEW."customer_id" IS NOT NULL
             AND target_order."customer_id" IS NOT NULL
             AND target_order."customer_id" <> NEW."customer_id"
       ) THEN
        RAISE EXCEPTION 'quote session customer cannot contradict an automatic order owner'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_session_automatic_order_owner_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_sessions_customer_ownership_protected"
BEFORE UPDATE OF "customer_id" ON "quote_sessions"
FOR EACH ROW EXECUTE FUNCTION taven_protect_quote_session_customer_ownership();

CREATE FUNCTION taven_propagate_quote_session_customer_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE "orders" target_order
    SET "customer_id" = NEW."customer_id",
        "updated_at" = CURRENT_TIMESTAMP
    FROM "automatic_order_origins" origin
    WHERE origin."quote_session_id" = NEW."id"
      AND target_order."id" = origin."order_id"
      AND target_order."customer_id" IS NULL;

    RETURN NULL;
END;
$$;

CREATE TRIGGER "quote_sessions_customer_ownership_propagated"
AFTER UPDATE OF "customer_id" ON "quote_sessions"
FOR EACH ROW
WHEN (OLD."customer_id" IS NULL AND NEW."customer_id" IS NOT NULL)
EXECUTE FUNCTION taven_propagate_quote_session_customer_ownership();

CREATE FUNCTION taven_protect_quote_session_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'OPEN' THEN
            RAISE EXCEPTION 'quote sessions must begin open'
                USING ERRCODE = '23514', CONSTRAINT = 'quote_session_initial_status_check';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'quote session creation timestamp is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_session_created_at_immutable_check';
    END IF;

    IF NEW."public_token_hash" IS DISTINCT FROM OLD."public_token_hash" THEN
        RAISE EXCEPTION 'quote session public token hash is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_session_public_token_hash_immutable_check';
    END IF;

    IF NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
        RAISE EXCEPTION 'quote session expiry is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_session_expiry_immutable_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           OLD."status" = 'OPEN'
           AND NEW."status" IN ('EXPIRED', 'CONVERTED', 'CANCELLED')
       ) THEN
        RAISE EXCEPTION 'quote session status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_session_status_transition_check';
    END IF;

    IF OLD."status" = 'OPEN'
       AND NEW."status" = 'EXPIRED'
       AND OLD."expires_at" > clock_timestamp() THEN
        RAISE EXCEPTION 'quote session can expire only after its immutable deadline'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_session_expiration_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_sessions_lifecycle_protected"
BEFORE INSERT OR UPDATE OF "status", "expires_at", "created_at", "public_token_hash" ON "quote_sessions"
FOR EACH ROW EXECUTE FUNCTION taven_protect_quote_session_lifecycle();

CREATE FUNCTION taven_claim_quote_session_customer(
    target_session_id uuid,
    target_customer_id uuid,
    mismatch_constraint text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    session_customer_id uuid;
BEGIN
    IF target_session_id IS NULL THEN
        RETURN;
    END IF;

    SELECT session."customer_id"
    INTO session_customer_id
    FROM "quote_sessions" session
    WHERE session."id" = target_session_id
    FOR UPDATE;

    IF NOT FOUND
       OR (session_customer_id IS NOT NULL
           AND session_customer_id IS DISTINCT FROM target_customer_id) THEN
        RAISE EXCEPTION 'attached commerce customer must match its quote session owner'
            USING ERRCODE = '23514', CONSTRAINT = mismatch_constraint;
    END IF;

    IF session_customer_id IS NULL AND target_customer_id IS NOT NULL THEN
        UPDATE "quote_sessions"
        SET "customer_id" = target_customer_id,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = target_session_id;
    END IF;
END;
$$;

CREATE FUNCTION taven_assert_quote_request_session_owner(
    target_session_id uuid,
    target_customer_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM taven_claim_quote_session_customer(
        target_session_id,
        target_customer_id,
        'quote_request_session_owner_check'
    );
END;
$$;

CREATE FUNCTION taven_assert_quote_session_commerce_open(target_session_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    session_status "quote_session_status";
    session_expires_at timestamptz;
BEGIN
    IF target_session_id IS NULL THEN
        RETURN;
    END IF;

    SELECT session."status", session."expires_at"
    INTO session_status, session_expires_at
    FROM "quote_sessions" session
    WHERE session."id" = target_session_id
    FOR UPDATE;

    IF NOT FOUND
       OR session_status <> 'OPEN'
       OR session_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'commerce can be attached only to an open, unexpired quote session'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_session_commerce_open_check';
    END IF;
END;
$$;

CREATE FUNCTION taven_require_initial_quote_request_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."status" <> 'NEW' THEN
        RAISE EXCEPTION 'quote requests must begin in NEW'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_initial_status_check';
    END IF;

    PERFORM taven_assert_quote_session_commerce_open(NEW."quote_session_id");

    PERFORM taven_assert_quote_request_session_owner(
        NEW."quote_session_id",
        NEW."customer_id"
    );

    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_requests_require_initial_status"
BEFORE INSERT ON "quote_requests"
FOR EACH ROW EXECUTE FUNCTION taven_require_initial_quote_request_status();

CREATE FUNCTION taven_protect_quote_request_issued_quote()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'quote request creation evidence is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_created_at_immutable_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'NEW' AND NEW."status" = 'IN_REVIEW')
           OR (OLD."status" = 'IN_REVIEW' AND NEW."status" = 'QUOTED')
           OR (OLD."status" = 'QUOTED' AND NEW."status" IN ('ACCEPTED', 'REJECTED', 'EXPIRED'))
       ) THEN
        RAISE EXCEPTION 'quote request status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_status_transition_check';
    END IF;

    IF NEW."quote_session_id" IS DISTINCT FROM OLD."quote_session_id"
       AND EXISTS (
           SELECT 1 FROM "quotes" quote WHERE quote."quote_request_id" = OLD."id"
       ) THEN
        RAISE EXCEPTION 'a quoted request must retain its quote session origin'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_issued_quote_identity_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "quotes" quote
        WHERE quote."quote_request_id" = OLD."id"
          AND quote."customer_id" IS DISTINCT FROM NEW."customer_id"
    ) THEN
        RAISE EXCEPTION 'a quoted request must retain its issued quote customer'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_issued_quote_owner_check';
    END IF;

    IF EXISTS (
        SELECT 1 FROM "individual_order_origins" origin
        JOIN "quotes" quote ON quote."id" = origin."quote_id"
        WHERE quote."quote_request_id" = OLD."id"
    ) AND NEW."status" <> 'ACCEPTED' THEN
        RAISE EXCEPTION 'an accepted quote request cannot leave ACCEPTED while it owns an order'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_individual_order_status_check';
    END IF;

    IF EXISTS (
        SELECT 1 FROM "quotes" quote WHERE quote."quote_request_id" = OLD."id"
    ) AND NEW."status" NOT IN ('QUOTED', 'ACCEPTED', 'REJECTED', 'EXPIRED') THEN
        RAISE EXCEPTION 'an issued quote request cannot return to a pre-quote state'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_issued_quote_status_check';
    END IF;

    IF NEW."status" = 'EXPIRED'
       AND OLD."status" IS DISTINCT FROM NEW."status"
       AND NOT EXISTS (
           SELECT 1
           FROM "quotes" quote
           WHERE quote."quote_request_id" = OLD."id"
             AND quote."expires_at" <= clock_timestamp()
       ) THEN
        RAISE EXCEPTION 'quote request can expire only after its immutable Quote deadline'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_expiration_check';
    END IF;

    IF NEW."status" = 'ACCEPTED'
       AND OLD."status" IS DISTINCT FROM NEW."status"
       AND (
           OLD."status" IS DISTINCT FROM 'QUOTED'::"quote_request_status"
           OR NOT EXISTS (
           SELECT 1
           FROM "quotes" quote
           JOIN "quote_price_bindings" binding ON binding."quote_id" = quote."id"
           JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
           WHERE quote."quote_request_id" = OLD."id"
             AND quote."issued_at" <= clock_timestamp()
             AND quote."expires_at" > clock_timestamp()
             AND (
                 SELECT coalesce(sum(component."amount_minor"), 0)
                 FROM "price_snapshot_components" component
                 WHERE component."price_snapshot_id" = snapshot."id"
             ) = snapshot."contract_total_minor"
             AND (
                 SELECT count(*)
                 FROM "payment_schedules" schedule
                 WHERE schedule."price_snapshot_id" = snapshot."id"
                   AND schedule."role" = 'FULL'
             ) = 1
             AND (
                 SELECT coalesce(sum(schedule."gross_amount_minor"), 0)
                 FROM "payment_schedules" schedule
                 WHERE schedule."price_snapshot_id" = snapshot."id"
                   AND schedule."role" = 'FULL'
             ) = snapshot."contract_total_minor"
             AND EXISTS (
                 SELECT 1
                 FROM "quote_items" quote_item
                 WHERE quote_item."quote_id" = quote."id"
             )
             AND NOT EXISTS (
                 SELECT 1
                 FROM "quote_items" quote_item
                 CROSS JOIN (
                     VALUES
                         ('ITEM_PRODUCTION'::"price_component_kind"),
                         ('ITEM_QUANTITY'::"price_component_kind"),
                         ('ITEM_POSTPROCESSING'::"price_component_kind")
                 ) AS mandatory("kind")
                 WHERE quote_item."quote_id" = quote."id"
                   AND NOT EXISTS (
                       SELECT 1
                       FROM "price_snapshot_components" component
                       WHERE component."price_snapshot_id" = snapshot."id"
                         AND component."scope" = 'QUOTE_ITEM'
                         AND component."quote_item_id" = quote_item."id"
                         AND component."kind" = mandatory."kind"
                   )
             )
           )
       ) THEN
        RAISE EXCEPTION 'accepted quote request requires a current quoted offer with one complete immutable price binding'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_price_binding_acceptance_check';
    END IF;

    IF NEW."quote_session_id" IS DISTINCT FROM OLD."quote_session_id" THEN
        PERFORM taven_assert_quote_session_commerce_open(NEW."quote_session_id");
    END IF;

    PERFORM taven_assert_quote_request_session_owner(
        NEW."quote_session_id",
        NEW."customer_id"
    );

    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_requests_issued_quote_protected"
BEFORE UPDATE OF "quote_session_id", "customer_id", "status", "created_at" ON "quote_requests"
FOR EACH ROW EXECUTE FUNCTION taven_protect_quote_request_issued_quote();

CREATE FUNCTION taven_reconcile_issued_quote_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_request_id uuid;
    target_status "quote_request_status";
BEGIN
    IF TG_TABLE_NAME = 'quote_requests' THEN
        target_request_id := NEW."id";
    ELSIF TG_TABLE_NAME = 'quotes' THEN
        target_request_id := NEW."quote_request_id";
    ELSE
        SELECT quote."quote_request_id"
        INTO target_request_id
        FROM "quotes" quote
        WHERE quote."id" = NEW."quote_id";
    END IF;

    SELECT request."status"
    INTO target_status
    FROM "quote_requests" request
    WHERE request."id" = target_request_id
    FOR UPDATE;

    IF target_status IN ('QUOTED', 'ACCEPTED', 'REJECTED', 'EXPIRED')
       AND NOT EXISTS (
           SELECT 1
           FROM "quote_requests" request
           JOIN "quotes" quote ON quote."quote_request_id" = request."id"
           JOIN "quote_price_bindings" binding ON binding."quote_id" = quote."id"
           JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
           WHERE request."id" = target_request_id
             AND quote."customer_id" = request."customer_id"
       ) THEN
        RAISE EXCEPTION 'quoted or closed request requires its immutable Quote and price binding atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_issuance_atomic_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "quote_requests_issuance_reconciled"
AFTER INSERT OR UPDATE OF "status" ON "quote_requests"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_issued_quote_request();
CREATE CONSTRAINT TRIGGER "quotes_request_issuance_reconciled"
AFTER INSERT ON "quotes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_issued_quote_request();
CREATE CONSTRAINT TRIGGER "quote_price_bindings_request_issuance_reconciled"
AFTER INSERT ON "quote_price_bindings"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_issued_quote_request();

CREATE FUNCTION taven_require_order_origin_for_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    automatic_count integer;
    individual_count integer;
    target_order_id uuid;
BEGIN
    target_order_id := CASE
        WHEN TG_TABLE_NAME = 'orders' THEN (to_jsonb(NEW) ->> 'id')::uuid
        ELSE (to_jsonb(NEW) ->> 'order_id')::uuid
    END;

    SELECT count(*) INTO automatic_count
    FROM "automatic_order_origins"
    WHERE "order_id" = target_order_id;
    SELECT count(*) INTO individual_count
    FROM "individual_order_origins"
    WHERE "order_id" = target_order_id;

    IF automatic_count + individual_count <> 1 THEN
        RAISE EXCEPTION 'order requires exactly one automatic or individual origin'
            USING ERRCODE = '23514', CONSTRAINT = 'order_exactly_one_origin_check';
    END IF;

    IF automatic_count = 1 AND NOT EXISTS (
        SELECT 1
        FROM "automatic_order_origins" origin
        JOIN "quote_sessions" session ON session."id" = origin."quote_session_id"
        JOIN "orders" target_order ON target_order."id" = origin."order_id"
        WHERE origin."order_id" = target_order_id
          AND (session."customer_id" IS NULL
               OR session."customer_id" = target_order."customer_id")
    ) THEN
        RAISE EXCEPTION 'automatic order customer must remain owned by its quote session'
            USING ERRCODE = '23514', CONSTRAINT = 'automatic_order_origin_owner_check';
    END IF;

    IF individual_count = 1 AND NOT EXISTS (
        SELECT 1
        FROM "individual_order_origins" origin
        JOIN "quotes" quote ON quote."id" = origin."quote_id"
        JOIN "quote_requests" request ON request."id" = quote."quote_request_id"
        JOIN "orders" target_order ON target_order."id" = origin."order_id"
        WHERE origin."order_id" = target_order_id
          AND quote."customer_id" = target_order."customer_id"
          AND request."status" = 'ACCEPTED'
    ) THEN
        RAISE EXCEPTION 'individual order must remain owned by its accepted quote customer'
            USING ERRCODE = '23514', CONSTRAINT = 'individual_order_origin_owner_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_require_exactly_one_origin"
AFTER INSERT OR UPDATE OF "customer_id", "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_require_order_origin_for_order();
CREATE CONSTRAINT TRIGGER "automatic_order_origins_require_exactly_one_origin"
AFTER INSERT ON "automatic_order_origins"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_require_order_origin_for_order();
CREATE CONSTRAINT TRIGGER "individual_order_origins_require_exactly_one_origin"
AFTER INSERT ON "individual_order_origins"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_require_order_origin_for_order();

CREATE FUNCTION taven_lock_automatic_order_session(target_order_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    session_status "quote_session_status";
    session_expires_at timestamptz;
    session_has_bound_order boolean;
BEGIN
    SELECT session."status", session."expires_at", (
        target_order."status" <> 'DRAFT'
        AND EXISTS (
            SELECT 1
            FROM "order_active_price_bindings" active
            JOIN "order_price_bindings" binding
              ON binding."id" = active."order_price_binding_id"
             AND binding."order_id" = active."order_id"
            WHERE active."order_id" = target_order."id"
              AND binding."invalidated_at" IS NULL
        )
    )
    INTO session_status, session_expires_at, session_has_bound_order
    FROM "automatic_order_origins" origin
    JOIN "quote_sessions" session ON session."id" = origin."quote_session_id"
    JOIN "orders" target_order ON target_order."id" = origin."order_id"
    WHERE origin."order_id" = target_order_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- A converted session cannot return to a cancellable state, so operations
    -- on its binding order do not need to serialize on the session row. This
    -- preserves normal parallel reservation accounting after checkout.
    IF session_status = 'CONVERTED' AND session_has_bound_order THEN
        RETURN;
    END IF;

    SELECT session."status", session."expires_at", (
        target_order."status" <> 'DRAFT'
        AND EXISTS (
            SELECT 1
            FROM "order_active_price_bindings" active
            JOIN "order_price_bindings" binding
              ON binding."id" = active."order_price_binding_id"
             AND binding."order_id" = active."order_id"
            WHERE active."order_id" = target_order."id"
              AND binding."invalidated_at" IS NULL
        )
    )
    INTO session_status, session_expires_at, session_has_bound_order
    FROM "automatic_order_origins" origin
    JOIN "quote_sessions" session ON session."id" = origin."quote_session_id"
    JOIN "orders" target_order ON target_order."id" = origin."order_id"
    WHERE origin."order_id" = target_order_id
    FOR UPDATE OF session NOWAIT;

    -- A QuoteRequest handed off from the configurator has its own lifecycle.
    -- Automatic draft commerce remains scoped to its bearer session until the
    -- session is converted into a binding order.
    IF NOT (
        (session_status = 'OPEN' AND session_expires_at > clock_timestamp())
        OR (session_status = 'CONVERTED' AND session_has_bound_order)
    ) THEN
        RAISE EXCEPTION 'automatic commerce requires an open or converted quote session'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_session_commerce_open_check';
    END IF;
END;
$$;

CREATE FUNCTION taven_lock_automatic_order_resource_topology()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    CASE TG_TABLE_NAME
        WHEN 'candidate_resource_estimates' THEN
            SELECT plan."order_id"
            INTO target_order_id
            FROM "shipment_plans" plan
            WHERE plan."id" = NEW."shipment_plan_id";
        WHEN 'candidate_capacity_intervals' THEN
            SELECT plan."order_id"
            INTO target_order_id
            FROM "candidate_resource_estimates" candidate
            JOIN "shipment_plans" plan ON plan."id" = candidate."shipment_plan_id"
            WHERE candidate."id" = NEW."candidate_resource_estimate_id"
              AND candidate."node_id" = NEW."node_id";
        WHEN 'eligibility_snapshots' THEN
            SELECT phase."order_id"
            INTO target_order_id
            FROM "order_phases" phase
            WHERE phase."id" = NEW."order_phase_id";
        WHEN 'phase_resource_plans' THEN
            SELECT phase."order_id"
            INTO target_order_id
            FROM "order_phases" phase
            WHERE phase."id" = NEW."order_phase_id";
        WHEN 'phase_resource_plan_jobs', 'phase_resource_plan_slots' THEN
            SELECT phase."order_id"
            INTO target_order_id
            FROM "phase_resource_plans" plan
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE plan."id" = NEW."phase_resource_plan_id"
              AND plan."node_id" = NEW."node_id";
        WHEN 'phase_reservation_sets', 'production_reservations' THEN
            SELECT phase."order_id"
            INTO target_order_id
            FROM "phase_resource_plans" plan
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE plan."id" = NEW."phase_resource_plan_id"
              AND plan."node_id" = NEW."node_id";
        WHEN 'inventory_reservations', 'capacity_reservations' THEN
            SELECT phase."order_id"
            INTO target_order_id
            FROM "production_reservations" production
            JOIN "phase_resource_plans" plan
              ON plan."id" = production."phase_resource_plan_id"
             AND plan."node_id" = production."node_id"
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE production."id" = NEW."production_reservation_id"
              AND production."node_id" = NEW."node_id";
    END CASE;

    IF target_order_id IS NOT NULL THEN
        PERFORM taven_lock_automatic_order_session(target_order_id);
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "candidate_resource_estimates_automatic_session_guard"
BEFORE INSERT ON "candidate_resource_estimates"
FOR EACH ROW EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "candidate_capacity_intervals_automatic_session_guard"
BEFORE INSERT ON "candidate_capacity_intervals"
FOR EACH ROW EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "eligibility_snapshots_automatic_session_guard"
BEFORE INSERT ON "eligibility_snapshots"
FOR EACH ROW EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "phase_resource_plans_automatic_session_guard"
BEFORE INSERT ON "phase_resource_plans"
FOR EACH ROW EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "phase_resource_plan_jobs_automatic_session_guard"
BEFORE INSERT ON "phase_resource_plan_jobs"
FOR EACH ROW EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "phase_resource_plan_slots_automatic_session_guard"
BEFORE INSERT ON "phase_resource_plan_slots"
FOR EACH ROW EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "phase_reservation_sets_00_automatic_session_insert_guard"
BEFORE INSERT ON "phase_reservation_sets"
FOR EACH ROW EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "production_reservations_00_automatic_session_insert_guard"
BEFORE INSERT ON "production_reservations"
FOR EACH ROW EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "inventory_reservations_00_automatic_session_insert_guard"
BEFORE INSERT ON "inventory_reservations"
FOR EACH ROW EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "capacity_reservations_00_automatic_session_insert_guard"
BEFORE INSERT ON "capacity_reservations"
FOR EACH ROW EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();

-- Forward reservation progress remains automatic commerce until the draft is
-- converted. Release and expiry are deliberately excluded so cancellation can
-- always return capacity and inventory. The 00 prefix keeps the session lock
-- ahead of the resource locks taken by the foundation triggers.
CREATE TRIGGER "phase_reservation_sets_00_automatic_session_forward_guard"
BEFORE UPDATE OF "status" ON "phase_reservation_sets"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status"
      AND NEW."status" IN ('RESERVED', 'HELD', 'SETTLED'))
EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "production_reservations_00_automatic_session_forward_guard"
BEFORE UPDATE OF "status" ON "production_reservations"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status"
      AND NEW."status" IN ('HELD', 'SCHEDULED', 'PRINTING', 'CONSUMED'))
EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "inventory_reservations_00_automatic_session_forward_guard"
BEFORE UPDATE OF "status" ON "inventory_reservations"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status"
      AND NEW."status" IN ('HELD', 'ALLOCATED', 'CONSUMED'))
EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();
CREATE TRIGGER "capacity_reservations_00_automatic_session_forward_guard"
BEFORE UPDATE OF "status" ON "capacity_reservations"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status"
      AND NEW."status" IN ('HELD', 'SCHEDULED', 'PRINTING', 'COMPLETED'))
EXECUTE FUNCTION taven_lock_automatic_order_resource_topology();

CREATE FUNCTION taven_protect_order_customer_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    has_automatic_origin boolean := false;
    has_commerce_topology boolean := false;
    session_claim_matches boolean := false;
BEGIN
    IF NEW."customer_id" IS NOT DISTINCT FROM OLD."customer_id" THEN
        RETURN NEW;
    END IF;

    SELECT (
       EXISTS (
           SELECT 1
           FROM "order_items" item
           WHERE item."order_id" = OLD."id"
       )
       OR EXISTS (
           SELECT 1
           FROM "delivery_destinations" destination
           WHERE destination."order_id" = OLD."id"
       )
       OR EXISTS (
           SELECT 1
           FROM "order_phases" phase
           WHERE phase."order_id" = OLD."id"
       )
       OR EXISTS (
           SELECT 1
           FROM "order_price_bindings" binding
           WHERE binding."order_id" = OLD."id"
       )
       OR EXISTS (
           SELECT 1
           FROM "payments" payment
           WHERE payment."order_id" = OLD."id"
       )
    ) INTO has_commerce_topology;

    IF OLD."customer_id" IS NULL AND NEW."customer_id" IS NOT NULL THEN
        SELECT
            EXISTS (
                SELECT 1
                FROM "automatic_order_origins" origin
                WHERE origin."order_id" = OLD."id"
            ),
            EXISTS (
                SELECT 1
                FROM "automatic_order_origins" origin
                JOIN "quote_sessions" session
                  ON session."id" = origin."quote_session_id"
                WHERE origin."order_id" = OLD."id"
                  AND session."customer_id" = NEW."customer_id"
            )
        INTO has_automatic_origin, session_claim_matches;
    END IF;

    IF OLD."customer_id" IS NOT NULL
       OR OLD."status" <> 'DRAFT'
       OR (has_automatic_origin AND NOT session_claim_matches)
       OR (NOT has_automatic_origin AND has_commerce_topology) THEN
        RAISE EXCEPTION 'order customer is immutable after ownership or commerce topology is attached'
            USING ERRCODE = '23514', CONSTRAINT = 'order_customer_ownership_immutable_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "orders_customer_ownership_protected"
BEFORE UPDATE OF "customer_id" ON "orders"
FOR EACH ROW EXECUTE FUNCTION taven_protect_order_customer_ownership();

CREATE FUNCTION taven_lock_child_order_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM taven_lock_automatic_order_session(NEW."order_id");

    PERFORM 1
    FROM "orders"
    WHERE "id" = NEW."order_id"
    FOR UPDATE;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "delivery_destinations_parent_order_locked"
BEFORE INSERT ON "delivery_destinations"
FOR EACH ROW EXECUTE FUNCTION taven_lock_child_order_parent();
CREATE TRIGGER "order_phases_parent_order_locked"
BEFORE INSERT ON "order_phases"
FOR EACH ROW EXECUTE FUNCTION taven_lock_child_order_parent();
CREATE TRIGGER "jobs_parent_order_locked"
BEFORE INSERT ON "jobs"
FOR EACH ROW EXECUTE FUNCTION taven_lock_child_order_parent();
CREATE TRIGGER "shipments_parent_order_locked"
BEFORE INSERT ON "shipments"
FOR EACH ROW EXECUTE FUNCTION taven_lock_child_order_parent();

CREATE FUNCTION taven_validate_automatic_order_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_customer_id uuid;
BEGIN
    PERFORM taven_assert_quote_session_commerce_open(NEW."quote_session_id");

    SELECT target_order."customer_id"
    INTO target_order_customer_id
    FROM "orders" target_order
    WHERE target_order."id" = NEW."order_id"
      AND target_order."status" = 'DRAFT'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'automatic order origin requires a draft order'
            USING ERRCODE = '23514', CONSTRAINT = 'automatic_order_origin_owner_check';
    END IF;

    PERFORM taven_claim_quote_session_customer(
        NEW."quote_session_id",
        target_order_customer_id,
        'automatic_order_origin_owner_check'
    );

    IF NOT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "quote_sessions" session ON session."id" = NEW."quote_session_id"
        WHERE target_order."id" = NEW."order_id"
          AND target_order."status" = 'DRAFT'
          AND session."customer_id" IS NOT DISTINCT FROM target_order."customer_id"
    ) THEN
        RAISE EXCEPTION 'automatic draft order must belong to its session customer'
            USING ERRCODE = '23514', CONSTRAINT = 'automatic_order_origin_owner_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "automatic_order_origins_owner"
BEFORE INSERT ON "automatic_order_origins"
FOR EACH ROW EXECUTE FUNCTION taven_validate_automatic_order_origin();

CREATE FUNCTION taven_validate_individual_order_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM "quote_requests" request
    JOIN "quotes" quote ON quote."quote_request_id" = request."id"
    WHERE quote."id" = NEW."quote_id"
    FOR UPDATE OF request;

    IF NOT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "quotes" quote ON quote."id" = NEW."quote_id"
        JOIN "quote_requests" request ON request."id" = quote."quote_request_id"
        WHERE target_order."id" = NEW."order_id"
          AND target_order."status" = 'DRAFT'
          AND quote."customer_id" = target_order."customer_id"
          AND request."status" = 'ACCEPTED'
    ) THEN
        RAISE EXCEPTION 'individual draft order must belong to an accepted quote for its customer'
            USING ERRCODE = '23514', CONSTRAINT = 'individual_order_origin_owner_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "individual_order_origins_owner"
BEFORE INSERT ON "individual_order_origins"
FOR EACH ROW EXECUTE FUNCTION taven_validate_individual_order_origin();

CREATE FUNCTION taven_reconcile_accepted_quote_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_request_id uuid;
    target_status "quote_request_status";
    origin_count integer;
BEGIN
    IF TG_TABLE_NAME = 'quote_requests' THEN
        target_request_id := (to_jsonb(NEW) ->> 'id')::uuid;
    ELSE
        SELECT quote."quote_request_id"
        INTO target_request_id
        FROM "quotes" quote
        WHERE quote."id" = (to_jsonb(NEW) ->> 'quote_id')::uuid;
    END IF;

    SELECT request."status"
    INTO target_status
    FROM "quote_requests" request
    WHERE request."id" = target_request_id
    FOR UPDATE;

    SELECT count(*)
    INTO origin_count
    FROM "quotes" quote
    JOIN "individual_order_origins" origin ON origin."quote_id" = quote."id"
    WHERE quote."quote_request_id" = target_request_id;

    PERFORM 1
    FROM "quotes" quote
    JOIN "individual_order_origins" origin ON origin."quote_id" = quote."id"
    JOIN "orders" target_order ON target_order."id" = origin."order_id"
    WHERE quote."quote_request_id" = target_request_id
    ORDER BY target_order."id"
    FOR UPDATE OF target_order;

    IF target_status = 'ACCEPTED' THEN
        IF origin_count <> 1 OR NOT EXISTS (
            SELECT 1
            FROM "quote_requests" request
            JOIN "quotes" quote ON quote."quote_request_id" = request."id"
            JOIN "individual_order_origins" origin ON origin."quote_id" = quote."id"
            JOIN "orders" target_order ON target_order."id" = origin."order_id"
            WHERE request."id" = target_request_id
              AND target_order."status" = 'DRAFT'
              AND request."customer_id" = quote."customer_id"
              AND quote."customer_id" = target_order."customer_id"
        ) THEN
            RAISE EXCEPTION 'accepted quote request requires its exact individual draft order in the same transaction'
                USING ERRCODE = '23514', CONSTRAINT = 'quote_request_individual_order_atomic_check';
        END IF;
    ELSIF origin_count <> 0 THEN
        RAISE EXCEPTION 'individual order origin requires its quote request to be accepted atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_individual_order_atomic_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "quote_requests_individual_order_reconciled"
AFTER INSERT OR UPDATE OF "status" ON "quote_requests"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_accepted_quote_order();
CREATE CONSTRAINT TRIGGER "individual_order_origins_request_reconciled"
AFTER INSERT ON "individual_order_origins"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_accepted_quote_order();

CREATE FUNCTION taven_prevent_order_origin_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable ownership topology', TG_TABLE_NAME
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "automatic_order_origins_immutable"
BEFORE UPDATE OR DELETE ON "automatic_order_origins"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_order_origin_mutation();
CREATE TRIGGER "individual_order_origins_immutable"
BEFORE UPDATE OR DELETE ON "individual_order_origins"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_order_origin_mutation();

CREATE FUNCTION taven_validate_individual_order_item_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "order_items" order_item
        JOIN "individual_order_origins" origin ON origin."order_id" = order_item."order_id"
        JOIN "quote_items" quote_item
          ON quote_item."id" = NEW."quote_item_id"
        JOIN "quotes" quote ON quote."id" = origin."quote_id"
         AND quote_item."quote_id" = quote."id"
        WHERE order_item."id" = NEW."order_item_id"
          AND order_item."ordinal" = quote_item."ordinal"
          AND order_item."source_model_file_id" = quote_item."source_model_file_id"
          AND order_item."model_geometry_id" = quote_item."model_geometry_id"
          AND order_item."print_config_revision_id" = quote_item."print_config_revision_id"
          AND order_item."reference_slice_result_id" IS NOT DISTINCT FROM quote_item."reference_slice_result_id"
          AND order_item."material" = quote_item."material"
          AND order_item."color" IS NOT DISTINCT FROM quote_item."color"
          AND order_item."quantity" = quote_item."quantity"
    ) THEN
        RAISE EXCEPTION 'individual order item must exactly copy an item from its accepted quote'
            USING ERRCODE = '23514', CONSTRAINT = 'individual_order_item_source_match_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "individual_order_item_sources_match"
BEFORE INSERT ON "individual_order_item_sources"
FOR EACH ROW EXECUTE FUNCTION taven_validate_individual_order_item_source();

CREATE FUNCTION taven_prevent_individual_order_item_source_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'individual order item sources are immutable accepted-quote topology'
        USING ERRCODE = '23514', CONSTRAINT = 'individual_order_item_source_immutable_check';
END;
$$;

CREATE TRIGGER "individual_order_item_sources_immutable"
BEFORE UPDATE OR DELETE ON "individual_order_item_sources"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_individual_order_item_source_mutation();

CREATE FUNCTION taven_protect_order_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW."order_id" ELSE OLD."order_id" END;
    target_order_status "order_status";
BEGIN
    PERFORM taven_lock_automatic_order_session(target_order_id);

    SELECT "status" INTO target_order_status
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM "order_price_bindings"
        WHERE "order_id" = target_order_id
    ) THEN
        RAISE EXCEPTION 'order items cannot change after pricing is bound'
            USING ERRCODE = '23514', CONSTRAINT = 'order_item_price_binding_immutable_check';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF target_order_status IS DISTINCT FROM 'DRAFT'::"order_status" THEN
            RAISE EXCEPTION 'order items can be inserted only while the order is draft'
                USING ERRCODE = '23514', CONSTRAINT = 'order_item_mutability_check';
        END IF;

        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW."order_id" IS DISTINCT FROM OLD."order_id" THEN
        RAISE EXCEPTION 'order items cannot be moved between orders'
            USING ERRCODE = '23514', CONSTRAINT = 'order_item_mutability_check';
    END IF;

    IF target_order_status IS DISTINCT FROM 'DRAFT'::"order_status" OR NOT EXISTS (
        SELECT 1
        FROM "automatic_order_origins" origin
        WHERE origin."order_id" = target_order_id
    ) THEN
        RAISE EXCEPTION 'order items are mutable only on automatic draft orders'
            USING ERRCODE = '23514', CONSTRAINT = 'order_item_mutability_check';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_items_draft_mutability"
BEFORE INSERT OR UPDATE OR DELETE ON "order_items"
FOR EACH ROW EXECUTE FUNCTION taven_protect_order_item_mutation();

CREATE FUNCTION taven_validate_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'DRAFT'
           OR NEW."quoted_at" IS NOT NULL
           OR NEW."confirmed_at" IS NOT NULL THEN
            RAISE EXCEPTION 'new orders must begin draft without lifecycle timestamps'
                USING ERRCODE = '23514', CONSTRAINT = 'order_status_transition_check';
        END IF;

        RETURN NEW;
    END IF;

    IF greatest(NEW."quoted_at", NEW."confirmed_at")
       > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'Order lifecycle evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."public_reference" IS DISTINCT FROM OLD."public_reference" THEN
        RAISE EXCEPTION 'order identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_identity_immutable_check';
    END IF;

    IF NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR (OLD."quoted_at" IS NOT NULL AND NEW."quoted_at" IS DISTINCT FROM OLD."quoted_at")
       OR (OLD."confirmed_at" IS NOT NULL AND NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at") THEN
        RAISE EXCEPTION 'order creation and recorded lifecycle timestamps are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_immutable_check';
    END IF;

    IF NEW."quoted_at" IS DISTINCT FROM OLD."quoted_at"
       AND NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'QUOTED'
                AND OLD."quoted_at" IS NULL AND NEW."quoted_at" IS NOT NULL) THEN
        RAISE EXCEPTION 'quoted timestamp must be assigned with the draft-to-quoted transition'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_check';
    END IF;

    IF NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
       AND NOT (OLD."status" = 'QUOTED' AND NEW."status" = 'CONFIRMED'
                AND OLD."confirmed_at" IS NULL AND NEW."confirmed_at" IS NOT NULL) THEN
        RAISE EXCEPTION 'confirmed timestamp must be assigned with the quoted-to-confirmed transition'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_check';
    END IF;

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'QUOTED'
       AND NEW."quoted_at" IS NULL THEN
        RAISE EXCEPTION 'draft-to-quoted transition requires its quoted timestamp'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_check';
    END IF;

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'QUOTED' THEN
        PERFORM taven_lock_automatic_order_session(NEW."id");

        UPDATE "quote_sessions" session
        SET "status" = 'CONVERTED',
            "updated_at" = clock_timestamp()
        FROM "automatic_order_origins" origin
        WHERE origin."order_id" = NEW."id"
          AND origin."quote_session_id" = session."id"
          AND session."status" = 'OPEN';
    END IF;

    IF OLD."status" = 'QUOTED' AND NEW."status" = 'CONFIRMED'
       AND NEW."confirmed_at" IS NULL THEN
        RAISE EXCEPTION 'quoted-to-confirmed transition requires its confirmed timestamp'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'DRAFT' AND NEW."status" = 'QUOTED')
           OR (OLD."status" = 'QUOTED' AND NEW."status" IN ('CONFIRMED', 'EXPIRED', 'CANCELLED'))
           OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('IN_PRODUCTION', 'CANCELLED'))
           OR (OLD."status" = 'IN_PRODUCTION' AND NEW."status" IN ('QC_PASSED', 'CANCELLED'))
           OR (OLD."status" = 'QC_PASSED' AND NEW."status" IN ('READY_TO_SHIP', 'CANCELLED'))
           OR (OLD."status" = 'READY_TO_SHIP' AND NEW."status" IN ('SHIPPED', 'CANCELLED'))
           -- Post-handoff cancellation/partial fulfilment remain unreachable
           -- until the settlement and claim tranches persist their proof.
           OR (OLD."status" = 'SHIPPED' AND NEW."status" = 'DELIVERED')
           OR (OLD."status" = 'DELIVERED' AND NEW."status" = 'COMPLETED')
           -- CANCELLED_SETTLED stays unreachable until the deferred settlement
           -- tranche persists the immutable OrderSettlement that proves it.
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'REFUNDED')
       ) THEN
        RAISE EXCEPTION 'order status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'order_status_transition_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "orders_status_transitions_valid"
BEFORE INSERT OR UPDATE OF "id", "public_reference", "status", "quoted_at", "confirmed_at", "created_at" ON "orders"
FOR EACH ROW EXECUTE FUNCTION taven_validate_order_status_transition();

CREATE FUNCTION taven_reconcile_refunded_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM "orders"
    WHERE "id" = NEW."id"
    FOR UPDATE;

    IF NOT EXISTS (
        SELECT 1
        FROM "payments" payment
        WHERE payment."order_id" = NEW."id"
          AND payment."captured_amount_minor" > 0
    ) OR EXISTS (
        SELECT 1
        FROM "payments" payment
        WHERE payment."order_id" = NEW."id"
          AND payment."captured_amount_minor" > 0
          AND (
              payment."status" <> 'REFUNDED'
              OR payment."captured_amount_minor" <> (
                  SELECT coalesce(sum(refund."amount_minor"), 0)
                  FROM "refund_transactions" refund
                  WHERE refund."payment_id" = payment."id"
                    AND refund."status" = 'SUCCEEDED'
              )
          )
    ) THEN
        RAISE EXCEPTION 'refunded order requires every captured payment to be fully refunded'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_completion_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_refund_completion_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status" AND NEW."status" = 'REFUNDED')
EXECUTE FUNCTION taven_reconcile_refunded_order();

CREATE FUNCTION taven_protect_order_phase_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'QUOTED'
           OR NEW."activated_at" IS NOT NULL
           OR NEW."qc_passed_at" IS NOT NULL
           OR NEW."shipped_at" IS NOT NULL
           OR NEW."delivered_at" IS NOT NULL
           OR NEW."completed_at" IS NOT NULL
           OR NEW."cancelled_at" IS NOT NULL THEN
            RAISE EXCEPTION 'new order phases must begin quoted without lifecycle evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'order_phase_initial_status_check';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'order phases are stable lifecycle topology and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_immutable_check';
    END IF;

    IF greatest(
        NEW."activated_at", NEW."qc_passed_at", NEW."shipped_at",
        NEW."delivered_at", NEW."completed_at", NEW."cancelled_at"
    ) > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'OrderPhase lifecycle evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_evidence_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR (OLD."activated_at" IS NOT NULL AND NEW."activated_at" IS DISTINCT FROM OLD."activated_at")
       OR (OLD."qc_passed_at" IS NOT NULL AND NEW."qc_passed_at" IS DISTINCT FROM OLD."qc_passed_at")
       OR (OLD."shipped_at" IS NOT NULL AND NEW."shipped_at" IS DISTINCT FROM OLD."shipped_at")
       OR (OLD."delivered_at" IS NOT NULL AND NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at")
       OR (OLD."completed_at" IS NOT NULL AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at")
       OR (OLD."cancelled_at" IS NOT NULL AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at") THEN
        RAISE EXCEPTION 'order phase identity and recorded lifecycle evidence are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_immutable_check';
    END IF;

    IF NEW."status" IS NOT DISTINCT FROM OLD."status"
       AND (
           NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
           OR NEW."qc_passed_at" IS DISTINCT FROM OLD."qc_passed_at"
           OR NEW."shipped_at" IS DISTINCT FROM OLD."shipped_at"
           OR NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
           OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
           OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
       ) THEN
        RAISE EXCEPTION 'order phase lifecycle evidence must be assigned with its status transition'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_evidence_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'QUOTED' AND NEW."status" IN ('ACTIVE', 'CANCELLED'))
           OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('IN_PRODUCTION', 'CANCELLED'))
           OR (OLD."status" = 'IN_PRODUCTION' AND NEW."status" IN ('QC_PASSED', 'CANCELLED'))
           OR (OLD."status" = 'QC_PASSED' AND NEW."status" IN ('SHIPPED', 'CANCELLED'))
           OR (OLD."status" = 'SHIPPED' AND NEW."status" = 'DELIVERED')
           OR (OLD."status" = 'DELIVERED' AND NEW."status" = 'COMPLETED')
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'CANCELLED_REFUNDED')
       ) THEN
        RAISE EXCEPTION 'order phase status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_status_transition_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'QUOTED' AND NEW."status" = 'ACTIVE'
            AND NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
            AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
            AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
            AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
            AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
            AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'IN_PRODUCTION'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'IN_PRODUCTION' AND NEW."status" = 'QC_PASSED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'QC_PASSED' AND NEW."status" = 'SHIPPED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'SHIPPED' AND NEW."status" = 'DELIVERED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'DELIVERED' AND NEW."status" = 'COMPLETED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (NEW."status" = 'CANCELLED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'CANCELLED_REFUNDED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
       ) THEN
        RAISE EXCEPTION 'order phase transition may assign only its own lifecycle evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_evidence_check';
    END IF;

    IF (NEW."status" IN ('ACTIVE', 'IN_PRODUCTION', 'QC_PASSED', 'SHIPPED', 'DELIVERED', 'COMPLETED')
        AND NEW."activated_at" IS NULL)
       OR (NEW."status" IN ('QC_PASSED', 'SHIPPED', 'DELIVERED', 'COMPLETED')
           AND NEW."qc_passed_at" IS NULL)
       OR (NEW."status" IN ('SHIPPED', 'DELIVERED', 'COMPLETED')
           AND NEW."shipped_at" IS NULL)
       OR (NEW."status" IN ('DELIVERED', 'COMPLETED') AND NEW."delivered_at" IS NULL)
       OR (NEW."status" = 'COMPLETED' AND NEW."completed_at" IS NULL)
       OR (NEW."status" IN ('CANCELLED', 'CANCELLED_REFUNDED') AND NEW."cancelled_at" IS NULL) THEN
        RAISE EXCEPTION 'order phase lifecycle state requires its complete timestamp evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_evidence_check';
    END IF;

    IF (NEW."activated_at" IS NOT NULL AND NEW."qc_passed_at" IS NOT NULL
        AND NEW."qc_passed_at" < NEW."activated_at")
       OR (NEW."qc_passed_at" IS NOT NULL AND NEW."shipped_at" IS NOT NULL
           AND NEW."shipped_at" < NEW."qc_passed_at")
       OR (NEW."shipped_at" IS NOT NULL AND NEW."delivered_at" IS NOT NULL
           AND NEW."delivered_at" < NEW."shipped_at")
       OR (NEW."delivered_at" IS NOT NULL AND NEW."completed_at" IS NOT NULL
           AND NEW."completed_at" < NEW."delivered_at")
       OR (NEW."cancelled_at" IS NOT NULL AND NEW."activated_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."activated_at")
       OR (NEW."cancelled_at" IS NOT NULL AND NEW."qc_passed_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."qc_passed_at")
       OR (NEW."cancelled_at" IS NOT NULL AND NEW."shipped_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."shipped_at")
       OR (NEW."cancelled_at" IS NOT NULL AND NEW."delivered_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."delivered_at") THEN
        RAISE EXCEPTION 'order phase lifecycle timestamps must be chronological'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_evidence_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_phases_lifecycle_protected"
BEFORE INSERT OR UPDATE OR DELETE ON "order_phases"
FOR EACH ROW EXECUTE FUNCTION taven_protect_order_phase_lifecycle();

CREATE FUNCTION taven_protect_job_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'CREATED'
           OR NEW."accepted_at" IS NOT NULL
           OR NEW."payout_amount" IS NOT NULL
           OR NEW."payout_currency" IS NOT NULL
           OR NEW."gcode_ready_at" IS NOT NULL
           OR NEW."production_slice_result_id" IS NOT NULL
           OR NEW."production_artifact_hash" IS NOT NULL
           OR NEW."printing_at" IS NOT NULL
           OR NEW."printed_at" IS NOT NULL
           OR NEW."photo_submitted_at" IS NOT NULL
           OR NEW."qc_photo_asset_id" IS NOT NULL
           OR NEW."qc_approved_at" IS NOT NULL
           OR NEW."qc_rejected_at" IS NOT NULL
           OR NEW."packed_at" IS NOT NULL
           OR NEW."handed_over_at" IS NOT NULL
           OR NEW."settled_at" IS NOT NULL
           OR NEW."failed_at" IS NOT NULL
           OR NEW."failure_stage" IS NOT NULL
           OR NEW."failure_reason" IS NOT NULL
           OR NEW."cancelled_at" IS NOT NULL
           OR NEW."cancellation_reason" IS NOT NULL THEN
            RAISE EXCEPTION 'new Jobs must begin created without lifecycle evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'job_initial_status_check';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Jobs are stable production history and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_immutable_check';
    END IF;

    IF greatest(
        NEW."accepted_at", NEW."gcode_ready_at", NEW."printing_at",
        NEW."printed_at", NEW."photo_submitted_at", NEW."qc_approved_at",
        NEW."qc_rejected_at", NEW."packed_at", NEW."handed_over_at",
        NEW."settled_at", NEW."failed_at", NEW."cancelled_at"
    ) > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'Job lifecycle evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_evidence_check';
    END IF;

    IF NEW."status" IS NOT DISTINCT FROM OLD."status"
       AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM
           (to_jsonb(OLD) - 'updated_at') THEN
        RAISE EXCEPTION 'Job identity and lifecycle evidence are immutable outside a status transition'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_immutable_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'CREATED' AND NEW."status" IN ('ACCEPTED', 'CANCELLED'))
           OR (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('GCODE_READY', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'GCODE_READY' AND NEW."status" IN ('PRINTING', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'PRINTING' AND NEW."status" IN ('PRINTED', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'PRINTED' AND NEW."status" IN ('PHOTO_SUBMITTED', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'PHOTO_SUBMITTED' AND NEW."status" IN ('QC_APPROVED', 'QC_REJECTED', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'QC_APPROVED' AND NEW."status" IN ('PACKED', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'PACKED' AND NEW."status" IN ('HANDED_OVER', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'HANDED_OVER' AND NEW."status" = 'SETTLED')
       ) THEN
        RAISE EXCEPTION 'Job status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'job_status_transition_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND (
       NEW."status" = 'ACCEPTED' AND NOT (
        OLD."accepted_at" IS NULL AND NEW."accepted_at" IS NOT NULL
        AND OLD."payout_amount" IS NULL AND NEW."payout_amount" IS NOT NULL
        AND OLD."payout_currency" IS NULL AND NEW."payout_currency" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'accepted_at', 'payout_amount', 'payout_currency']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'accepted_at', 'payout_amount', 'payout_currency'])
    ) OR NEW."status" = 'GCODE_READY' AND NOT (
        OLD."gcode_ready_at" IS NULL AND NEW."gcode_ready_at" IS NOT NULL
        AND OLD."production_slice_result_id" IS NULL AND NEW."production_slice_result_id" IS NOT NULL
        AND OLD."production_artifact_hash" IS NULL AND NEW."production_artifact_hash" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'gcode_ready_at', 'production_slice_result_id', 'production_artifact_hash']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'gcode_ready_at', 'production_slice_result_id', 'production_artifact_hash'])
    ) OR NEW."status" = 'PRINTING' AND NOT (
        OLD."printing_at" IS NULL AND NEW."printing_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'printing_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'printing_at'])
    ) OR NEW."status" = 'PRINTED' AND NOT (
        OLD."printed_at" IS NULL AND NEW."printed_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'printed_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'printed_at'])
    ) OR NEW."status" = 'PHOTO_SUBMITTED' AND NOT (
        OLD."photo_submitted_at" IS NULL AND NEW."photo_submitted_at" IS NOT NULL
        AND OLD."qc_photo_asset_id" IS NULL AND NEW."qc_photo_asset_id" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'photo_submitted_at', 'qc_photo_asset_id']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'photo_submitted_at', 'qc_photo_asset_id'])
    ) OR NEW."status" = 'QC_APPROVED' AND NOT (
        OLD."qc_approved_at" IS NULL AND NEW."qc_approved_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'qc_approved_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'qc_approved_at'])
    ) OR NEW."status" = 'QC_REJECTED' AND NOT (
        OLD."qc_rejected_at" IS NULL AND NEW."qc_rejected_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'qc_rejected_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'qc_rejected_at'])
    ) OR NEW."status" = 'PACKED' AND NOT (
        OLD."packed_at" IS NULL AND NEW."packed_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'packed_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'packed_at'])
    ) OR NEW."status" = 'HANDED_OVER' AND NOT (
        OLD."handed_over_at" IS NULL AND NEW."handed_over_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'handed_over_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'handed_over_at'])
    ) OR NEW."status" = 'SETTLED' AND NOT (
        OLD."settled_at" IS NULL AND NEW."settled_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'settled_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'settled_at'])
    ) OR NEW."status" = 'FAILED' AND NOT (
        OLD."failed_at" IS NULL AND NEW."failed_at" IS NOT NULL
        AND OLD."failure_stage" IS NULL AND NEW."failure_stage" IS NOT NULL
        AND OLD."failure_reason" IS NULL AND NEW."failure_reason" ~ '[^[:space:]]'
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'failed_at', 'failure_stage', 'failure_reason']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'failed_at', 'failure_stage', 'failure_reason'])
    ) OR NEW."status" = 'CANCELLED' AND NOT (
        OLD."cancelled_at" IS NULL AND NEW."cancelled_at" IS NOT NULL
        AND OLD."cancellation_reason" IS NULL AND NEW."cancellation_reason" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'cancelled_at', 'cancellation_reason']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'cancelled_at', 'cancellation_reason'])
    )) THEN
        RAISE EXCEPTION 'Job transition may assign only its own lifecycle evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_evidence_check';
    END IF;

    IF (NEW."status" IN ('ACCEPTED', 'GCODE_READY', 'PRINTING', 'PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
        AND NEW."accepted_at" IS NULL)
       OR (NEW."status" IN ('GCODE_READY', 'PRINTING', 'PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND (NEW."gcode_ready_at" IS NULL OR NEW."production_slice_result_id" IS NULL OR NEW."production_artifact_hash" IS NULL))
       OR (NEW."status" IN ('PRINTING', 'PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND NEW."printing_at" IS NULL)
       OR (NEW."status" IN ('PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND NEW."printed_at" IS NULL)
       OR (NEW."status" IN ('PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND (NEW."photo_submitted_at" IS NULL OR NEW."qc_photo_asset_id" IS NULL))
       OR (NEW."status" IN ('QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND NEW."qc_approved_at" IS NULL)
       OR (NEW."status" IN ('PACKED', 'HANDED_OVER', 'SETTLED') AND NEW."packed_at" IS NULL)
       OR (NEW."status" IN ('HANDED_OVER', 'SETTLED') AND NEW."handed_over_at" IS NULL)
       OR (NEW."status" = 'SETTLED' AND NEW."settled_at" IS NULL)
       OR (NEW."status" = 'QC_REJECTED' AND NEW."qc_rejected_at" IS NULL)
       OR (NEW."status" = 'FAILED' AND (NEW."failed_at" IS NULL OR NEW."failure_stage" IS NULL OR NEW."failure_reason" IS NULL))
       OR (NEW."status" = 'CANCELLED' AND (NEW."cancelled_at" IS NULL OR NEW."cancellation_reason" IS NULL)) THEN
        RAISE EXCEPTION 'Job lifecycle state requires its complete timestamp evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_evidence_check';
    END IF;

    IF (NEW."accepted_at" IS NOT NULL AND NEW."gcode_ready_at" IS NOT NULL
        AND NEW."gcode_ready_at" < NEW."accepted_at")
       OR (NEW."gcode_ready_at" IS NOT NULL AND NEW."printing_at" IS NOT NULL
           AND NEW."printing_at" < NEW."gcode_ready_at")
       OR (NEW."printing_at" IS NOT NULL AND NEW."printed_at" IS NOT NULL
           AND NEW."printed_at" < NEW."printing_at")
       OR (NEW."printed_at" IS NOT NULL AND NEW."photo_submitted_at" IS NOT NULL
           AND NEW."photo_submitted_at" < NEW."printed_at")
       OR (NEW."photo_submitted_at" IS NOT NULL AND NEW."qc_approved_at" IS NOT NULL
           AND NEW."qc_approved_at" < NEW."photo_submitted_at")
       OR (NEW."photo_submitted_at" IS NOT NULL AND NEW."qc_rejected_at" IS NOT NULL
           AND NEW."qc_rejected_at" < NEW."photo_submitted_at")
       OR (NEW."printing_at" IS NOT NULL AND NEW."qc_approved_at" IS NOT NULL
           AND NEW."qc_approved_at" < NEW."printing_at")
       OR (NEW."qc_approved_at" IS NOT NULL AND NEW."packed_at" IS NOT NULL
           AND NEW."packed_at" < NEW."qc_approved_at")
       OR (NEW."packed_at" IS NOT NULL AND NEW."handed_over_at" IS NOT NULL
           AND NEW."handed_over_at" < NEW."packed_at")
       OR (NEW."handed_over_at" IS NOT NULL AND NEW."settled_at" IS NOT NULL
           AND NEW."settled_at" < NEW."handed_over_at") THEN
        RAISE EXCEPTION 'Job lifecycle timestamps must be chronological'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_evidence_check';
    END IF;

    IF (NEW."status" = 'FAILED' AND NEW."failed_at" < CASE OLD."status"
            WHEN 'ACCEPTED' THEN OLD."accepted_at"
            WHEN 'GCODE_READY' THEN OLD."gcode_ready_at"
            WHEN 'PRINTING' THEN OLD."printing_at"
            WHEN 'PRINTED' THEN OLD."printed_at"
            WHEN 'PHOTO_SUBMITTED' THEN OLD."photo_submitted_at"
            WHEN 'QC_APPROVED' THEN OLD."qc_approved_at"
            WHEN 'PACKED' THEN OLD."packed_at"
        END)
       OR (NEW."status" = 'CANCELLED' AND NEW."cancelled_at" < CASE OLD."status"
            WHEN 'CREATED' THEN OLD."created_at"
            WHEN 'ACCEPTED' THEN OLD."accepted_at"
            WHEN 'GCODE_READY' THEN OLD."gcode_ready_at"
            WHEN 'PRINTING' THEN OLD."printing_at"
            WHEN 'PRINTED' THEN OLD."printed_at"
            WHEN 'PHOTO_SUBMITTED' THEN OLD."photo_submitted_at"
            WHEN 'QC_APPROVED' THEN OLD."qc_approved_at"
            WHEN 'PACKED' THEN OLD."packed_at"
        END) THEN
        RAISE EXCEPTION 'Job terminal evidence cannot predate its source state'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_evidence_check';
    END IF;

    IF NEW."status" = 'GCODE_READY' AND NOT EXISTS (
        SELECT 1
        FROM "production_reservations" production
        JOIN "slice_results" slice ON slice."id" = NEW."production_slice_result_id"
        WHERE production."job_id" = NEW."id"
          AND production."node_id" = NEW."node_id"
          AND production."phase_resource_plan_job_id" = NEW."phase_resource_plan_job_id"
          AND production."slice_result_id" = slice."id"
          AND slice."kind" = 'PRODUCTION'
          AND slice."artifact_hash" = NEW."production_artifact_hash"
    ) THEN
        RAISE EXCEPTION 'G-code readiness requires the sealed production slice from the exact Job reservation'
            USING ERRCODE = '23514', CONSTRAINT = 'job_gcode_artifact_check';
    END IF;

    IF NEW."status" = 'PHOTO_SUBMITTED' THEN
        PERFORM 1
        FROM "photo_assets" photo
        WHERE photo."id" = NEW."qc_photo_asset_id"
          AND photo."kind" = 'QC'
          AND photo."scope_kind" = 'JOB'
          AND photo."scope_id" = NEW."id"
          AND photo."uploaded_at" <= NEW."photo_submitted_at"
          AND photo."photo_delete_after" > NEW."photo_submitted_at"
          AND photo."retention_hold" IN ('ACTIVE_ORDER', 'ACTIVE_CLAIM', 'LEGAL')
          AND photo."deleted_at" IS NULL
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'photo submission requires an active retained QC PhotoAsset for the exact Job'
                USING ERRCODE = '23514', CONSTRAINT = 'job_qc_photo_asset_check';
        END IF;
    END IF;

    IF NEW."status" = 'FAILED' AND NOT (
        (OLD."status" IN ('ACCEPTED', 'GCODE_READY') AND NEW."failure_stage" IN ('PREPARATION', 'GCODE', 'MACHINE'))
        OR (OLD."status" = 'PRINTING' AND NEW."failure_stage" = 'PRINTING')
        OR (OLD."status" IN ('PRINTED', 'PHOTO_SUBMITTED') AND NEW."failure_stage" = 'POST_PRINT')
        OR (OLD."status" = 'QC_APPROVED' AND NEW."failure_stage" = 'POST_QC')
        OR (OLD."status" = 'PACKED' AND NEW."failure_stage" = 'PACKING')
    ) THEN
        RAISE EXCEPTION 'failure stage must match the Job source state'
            USING ERRCODE = '23514', CONSTRAINT = 'job_failure_stage_check';
    END IF;

    IF NEW."status" = 'CANCELLED' AND NOT (
        (OLD."status" = 'CREATED' AND NEW."cancellation_reason" IN ('ROUTING_EXHAUSTED', 'ORDER_CANCELLED'))
        OR (OLD."status" <> 'CREATED' AND NEW."cancellation_reason" IN ('ORDER_CANCELLED', 'PHASE_CANCELLED', 'CLAIM_WITHDRAWN'))
    ) THEN
        RAISE EXCEPTION 'cancellation reason must match the Job source state'
            USING ERRCODE = '23514', CONSTRAINT = 'job_cancellation_reason_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "jobs_lifecycle_protected"
BEFORE INSERT OR UPDATE OR DELETE ON "jobs"
FOR EACH ROW EXECUTE FUNCTION taven_protect_job_lifecycle();

CREATE FUNCTION taven_protect_active_order_qc_photo()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
            SELECT 1
            FROM "jobs" job
            JOIN "orders" target_order ON target_order."id" = job."order_id"
            WHERE NEW."kind" = 'QC'::"photo_asset_kind"
              AND NEW."scope_kind" = 'JOB'::"photo_scope_kind"
              AND NEW."scope_id" = job."id"
              AND job."qc_photo_asset_id" = NEW."id"
              AND (
                  target_order."status" IN (
                      'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED',
                      'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'
                  )
                  OR (
                      target_order."status" = 'CANCELLED'
                      AND EXISTS (
                          SELECT 1
                          FROM "payments" payment
                          WHERE payment."order_id" = target_order."id"
                            AND coalesce(payment."captured_amount_minor", 0) > 0
                      )
                  )
              )
        ) AND (
        NEW."deleted_at" IS NOT NULL
        OR NEW."retention_hold" NOT IN ('ACTIVE_ORDER', 'ACTIVE_CLAIM', 'LEGAL')
    ) THEN
        RAISE EXCEPTION 'Order-bound QC PhotoAsset must remain retained throughout its active order'
            USING ERRCODE = '23514', CONSTRAINT = 'job_qc_photo_active_order_check';
    END IF;

    IF EXISTS (
            SELECT 1
            FROM "individual_order_origins" origin
            JOIN "quotes" quote ON quote."id" = origin."quote_id"
            JOIN "orders" target_order ON target_order."id" = origin."order_id"
            WHERE NEW."kind" = 'QUOTE_REFERENCE'::"photo_asset_kind"
              AND NEW."scope_kind" = 'QUOTE_REQUEST'::"photo_scope_kind"
              AND NEW."scope_id" = quote."quote_request_id"
              AND (
                  target_order."status" IN (
                      'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED',
                      'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'
                  )
                  OR (
                      target_order."status" = 'CANCELLED'
                      AND EXISTS (
                          SELECT 1
                          FROM "payments" payment
                          WHERE payment."order_id" = target_order."id"
                            AND coalesce(payment."captured_amount_minor", 0) > 0
                      )
                  )
              )
        ) AND (
        NEW."deleted_at" IS NOT NULL
        OR NEW."retention_hold" NOT IN ('ACTIVE_ORDER', 'ACTIVE_CLAIM', 'LEGAL')
    ) THEN
        RAISE EXCEPTION 'Order-bound quote-reference PhotoAsset must remain retained throughout its active order'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_reference_photo_active_order_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "photo_assets_active_order_qc_protected"
BEFORE UPDATE OF "retention_hold", "deleted_at" ON "photo_assets"
FOR EACH ROW EXECUTE FUNCTION taven_protect_active_order_qc_photo();

CREATE FUNCTION taven_hold_active_order_quote_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."kind" = 'QUOTE_REFERENCE'::"photo_asset_kind"
       AND NEW."scope_kind" = 'QUOTE_REQUEST'::"photo_scope_kind" THEN
        PERFORM 1
        FROM "individual_order_origins" origin
        JOIN "quotes" quote ON quote."id" = origin."quote_id"
        JOIN "orders" target_order ON target_order."id" = origin."order_id"
        WHERE NEW."scope_id" = quote."quote_request_id"
          AND (
              target_order."status" IN (
                  'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED',
                  'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'
              )
              OR (
                  target_order."status" = 'CANCELLED'
                  AND EXISTS (
                      SELECT 1
                      FROM "payments" payment
                      WHERE payment."order_id" = target_order."id"
                        AND coalesce(payment."captured_amount_minor", 0) > 0
                  )
              )
          )
        ORDER BY target_order."id"
        FOR UPDATE OF target_order;

        IF FOUND THEN
            IF NEW."deleted_at" IS NOT NULL THEN
                RAISE EXCEPTION 'Active-order quote-reference PhotoAsset cannot be inserted deleted'
                    USING ERRCODE = '23514', CONSTRAINT = 'quote_reference_photo_active_order_check';
            END IF;

            NEW."retention_hold" := CASE
                WHEN NEW."retention_hold" IN ('ACTIVE_CLAIM', 'LEGAL') THEN NEW."retention_hold"
                ELSE 'ACTIVE_ORDER'::"retention_hold"
            END;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "photo_assets_hold_active_order_quote_reference"
BEFORE INSERT ON "photo_assets"
FOR EACH ROW EXECUTE FUNCTION taven_hold_active_order_quote_reference();

CREATE FUNCTION taven_protect_active_order_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "order_items" item
        JOIN "orders" target_order ON target_order."id" = item."order_id"
        WHERE item."source_model_file_id" = NEW."id"
          AND (
              target_order."status" IN (
                  'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED',
                  'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'
              )
              OR (
                  target_order."status" = 'CANCELLED'
                  AND EXISTS (
                      SELECT 1
                      FROM "payments" payment
                      WHERE payment."order_id" = target_order."id"
                        AND coalesce(payment."captured_amount_minor", 0) > 0
                  )
              )
          )
    ) AND (
        NEW."deleted_at" IS NOT NULL
        OR NEW."retention_hold" NOT IN ('ACTIVE_ORDER', 'ACTIVE_CLAIM', 'LEGAL')
    ) THEN
        RAISE EXCEPTION 'source ModelFile must remain retained throughout every active referencing order'
            USING ERRCODE = '23514', CONSTRAINT = 'order_source_active_order_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "model_files_active_order_protected"
BEFORE UPDATE OF "retention_hold", "deleted_at" ON "model_files"
FOR EACH ROW EXECUTE FUNCTION taven_protect_active_order_source();

CREATE FUNCTION taven_reconcile_order_post_confirmation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_status "order_status";
BEGIN
    target_order_id := CASE TG_TABLE_NAME
        WHEN 'orders' THEN (to_jsonb(NEW) ->> 'id')::uuid
        WHEN 'order_phases' THEN (to_jsonb(NEW) ->> 'order_id')::uuid
        WHEN 'jobs' THEN (to_jsonb(NEW) ->> 'order_id')::uuid
        WHEN 'shipments' THEN (to_jsonb(NEW) ->> 'order_id')::uuid
        ELSE (to_jsonb(NEW) ->> 'order_id')::uuid
    END;

    SELECT "status"
    INTO target_status
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    IF target_status IS NULL THEN
        RETURN NULL;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "jobs" job
        WHERE job."order_id" = target_order_id
          AND (
              (job."status" = 'HANDED_OVER'
               AND target_status NOT IN ('SHIPPED', 'DELIVERED'))
              OR (job."status" = 'SETTLED'
                  AND target_status NOT IN ('DELIVERED', 'COMPLETED'))
          )
    ) THEN
        RAISE EXCEPTION 'Job handoff and settlement require the corresponding delivery lifecycle'
            USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
    END IF;

    IF target_status IN ('DRAFT', 'QUOTED') THEN
        IF EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND (
                  phase."status" <> 'QUOTED'
                  OR phase."activated_at" IS NOT NULL
                  OR phase."qc_passed_at" IS NOT NULL
                  OR phase."shipped_at" IS NOT NULL
                  OR phase."delivered_at" IS NOT NULL
                  OR phase."completed_at" IS NOT NULL
                  OR phase."cancelled_at" IS NOT NULL
              )
        ) OR EXISTS (
            SELECT 1 FROM "jobs" WHERE "order_id" = target_order_id
        ) OR EXISTS (
            SELECT 1
            FROM "shipments"
            WHERE "order_id" = target_order_id
              AND (
                  "status" <> 'PLANNED'
                  OR "carrier" IS NOT NULL
                  OR "provider_shipment_id" IS NOT NULL
                  OR "tracking_code" IS NOT NULL
                  OR "label_created_at" IS NOT NULL
                  OR "handed_over_at" IS NOT NULL
                  OR "delivered_at" IS NOT NULL
                  OR "cancelled_at" IS NOT NULL
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'pre-confirmation order requires only quoted phase and initial fulfilment facts'
                USING ERRCODE = '23514', CONSTRAINT = 'pre_confirmation_fulfilment_state_check';
        END IF;
    ELSIF target_status = 'EXPIRED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."kind" = 'SINGLE'
              AND phase."status" = 'CANCELLED'
              AND phase."cancelled_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND (
                  phase."status" <> 'CANCELLED'
                  OR phase."cancelled_at" IS NULL
              )
        ) OR EXISTS (
            SELECT 1 FROM "jobs" WHERE "order_id" = target_order_id
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND (shipment."status" <> 'CANCELLED' OR shipment."cancelled_at" IS NULL)
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'CANCELLED'
        ) THEN
            RAISE EXCEPTION 'expired quoted order requires a closed pre-capture fulfilment graph'
                USING ERRCODE = '23514', CONSTRAINT = 'expired_order_checkout_closure_check';
        END IF;
    ELSIF target_status = 'CONFIRMED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."kind" = 'SINGLE'
              AND phase."status" = 'ACTIVE'
              AND phase."activated_at" IS NOT NULL
        ) OR NOT EXISTS (
            SELECT 1 FROM "jobs" WHERE "order_id" = target_order_id
        ) OR EXISTS (
            SELECT 1
            FROM "jobs"
            WHERE "order_id" = target_order_id
              AND "status" NOT IN ('CREATED', 'ACCEPTED', 'GCODE_READY')
        ) OR EXISTS (
            SELECT 1
            FROM "shipments"
            WHERE "order_id" = target_order_id
              AND "status" <> 'PLANNED'
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'confirmed order requires its active phase and initial pre-production fulfilment facts'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'IN_PRODUCTION' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."kind" = 'SINGLE'
              AND phase."status" = 'IN_PRODUCTION'
        ) OR NOT EXISTS (
            SELECT 1
            FROM "jobs"
            WHERE "order_id" = target_order_id
              AND "status" IN ('PRINTING', 'PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED')
              AND "printing_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "jobs"
            WHERE "order_id" = target_order_id
              AND "status" IN ('CANCELLED', 'FAILED', 'QC_REJECTED')
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" <> 'PLANNED'
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'in-production order requires production facts and initial fulfilment state'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'QC_PASSED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'QC_PASSED'
              AND phase."qc_passed_at" IS NOT NULL
        ) OR NOT EXISTS (
            SELECT 1 FROM "jobs" WHERE "order_id" = target_order_id
        ) OR EXISTS (
            SELECT 1
            FROM "jobs"
            WHERE "order_id" = target_order_id
              AND (
                  "status" NOT IN ('QC_APPROVED', 'PACKED')
                  OR "qc_approved_at" IS NULL
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" <> 'PLANNED'
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'QC-passed order requires complete QC and initial fulfilment state'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'READY_TO_SHIP' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'QC_PASSED'
              AND phase."qc_passed_at" IS NOT NULL
        ) OR NOT EXISTS (
            SELECT 1 FROM "jobs" WHERE "order_id" = target_order_id
        ) OR EXISTS (
            SELECT 1
            FROM "jobs"
            WHERE "order_id" = target_order_id
              AND ("status" <> 'PACKED' OR "packed_at" IS NULL)
        ) OR NOT EXISTS (
            SELECT 1
            FROM "shipment_plans" plan
            JOIN "order_active_price_bindings" active_binding
              ON active_binding."order_id" = plan."order_id"
             AND active_binding."order_price_binding_id" = plan."order_price_binding_id"
            JOIN "order_price_bindings" binding
              ON binding."id" = active_binding."order_price_binding_id"
             AND binding."order_id" = plan."order_id"
             AND binding."delivery_destination_id" = plan."delivery_destination_id"
             AND binding."invalidated_at" IS NULL
            WHERE plan."order_id" = target_order_id
        ) OR EXISTS (
            SELECT 1
            FROM "shipment_plans" plan
            JOIN "order_active_price_bindings" active_binding
              ON active_binding."order_id" = plan."order_id"
             AND active_binding."order_price_binding_id" = plan."order_price_binding_id"
            JOIN "order_price_bindings" binding
              ON binding."id" = active_binding."order_price_binding_id"
             AND binding."order_id" = plan."order_id"
             AND binding."delivery_destination_id" = plan."delivery_destination_id"
             AND binding."invalidated_at" IS NULL
            WHERE plan."order_id" = target_order_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" shipment
                  WHERE shipment."order_id" = plan."order_id"
                    AND shipment."order_phase_id" = plan."order_phase_id"
                    AND shipment."shipment_plan_id" = plan."id"
                    AND shipment."delivery_destination_id" = plan."delivery_destination_id"
                    AND NOT EXISTS (
                        SELECT 1
                        FROM "shipments" replacement
                        WHERE replacement."replaces_shipment_id" = shipment."id"
                          AND replacement."order_id" = shipment."order_id"
                          AND replacement."order_phase_id" = shipment."order_phase_id"
                          AND replacement."shipment_plan_id" = shipment."shipment_plan_id"
                          AND replacement."delivery_destination_id" = shipment."delivery_destination_id"
                    )
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
              AND (
                  shipment."status" <> 'LABEL_CREATED'
                  OR shipment."carrier" IS NULL
                  OR shipment."provider_shipment_id" IS NULL
                  OR shipment."label_created_at" IS NULL
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'ready-to-ship order requires every Job packed and every Shipment labelled'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'SHIPPED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'SHIPPED'
              AND phase."shipped_at" IS NOT NULL
        ) OR NOT EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED')
              AND shipment."handed_over_at" IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" NOT IN ('LABEL_CREATED', 'HANDED_OVER', 'IN_TRANSIT', 'DELIVERED')
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR NOT EXISTS (
            SELECT 1
            FROM "jobs"
            WHERE "order_id" = target_order_id
              AND "status" = 'HANDED_OVER'
              AND "handed_over_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "jobs"
            WHERE "order_id" = target_order_id
              AND "status" NOT IN ('PACKED', 'HANDED_OVER')
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED')
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
              AND (
                  NOT EXISTS (
                      SELECT 1
                      FROM "jobs" job
                      WHERE job."order_id" = shipment."order_id"
                        AND job."order_phase_id" = shipment."order_phase_id"
                        AND job."shipment_plan_id" = shipment."shipment_plan_id"
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM "jobs" job
                      WHERE job."order_id" = shipment."order_id"
                        AND job."order_phase_id" = shipment."order_phase_id"
                        AND job."shipment_plan_id" = shipment."shipment_plan_id"
                        AND (
                            job."status" <> 'HANDED_OVER'
                            OR job."handed_over_at" IS NULL
                        )
                  )
              )
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND job."status" = 'HANDED_OVER'
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" shipment
                  WHERE shipment."order_id" = job."order_id"
                    AND shipment."order_phase_id" = job."order_phase_id"
                    AND shipment."shipment_plan_id" = job."shipment_plan_id"
                    AND shipment."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED')
                    AND shipment."handed_over_at" IS NOT NULL
                    AND NOT EXISTS (
                        SELECT 1
                        FROM "shipments" replacement
                        WHERE replacement."replaces_shipment_id" = shipment."id"
                    )
              )
        ) OR (
            NOT EXISTS (
                SELECT 1
                FROM "shipments" shipment
                WHERE shipment."order_id" = target_order_id
                  AND shipment."status" <> 'DELIVERED'
                  AND NOT EXISTS (
                      SELECT 1
                      FROM "shipments" replacement
                      WHERE replacement."replaces_shipment_id" = shipment."id"
                  )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM "fulfilment_slots"
                WHERE "order_id" = target_order_id
                  AND "outcome" <> 'DELIVERED'
            )
        ) THEN
            RAISE EXCEPTION 'shipped order requires matched handoff evidence and must advance after final delivery'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'DELIVERED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'DELIVERED'
              AND phase."delivered_at" IS NOT NULL
        ) OR NOT EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND (shipment."status" <> 'DELIVERED' OR shipment."delivered_at" IS NULL)
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
              AND (
                  NOT EXISTS (
                      SELECT 1
                      FROM "jobs" job
                      WHERE job."order_id" = shipment."order_id"
                        AND job."order_phase_id" = shipment."order_phase_id"
                        AND job."shipment_plan_id" = shipment."shipment_plan_id"
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM "jobs" job
                      WHERE job."order_id" = shipment."order_id"
                        AND job."order_phase_id" = shipment."order_phase_id"
                        AND job."shipment_plan_id" = shipment."shipment_plan_id"
                        AND (
                            job."status" NOT IN ('HANDED_OVER', 'SETTLED')
                            OR job."handed_over_at" IS NULL
                        )
                  )
              )
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" shipment
                  WHERE shipment."order_id" = job."order_id"
                    AND shipment."order_phase_id" = job."order_phase_id"
                    AND shipment."shipment_plan_id" = job."shipment_plan_id"
                    AND shipment."status" = 'DELIVERED'
                    AND shipment."handed_over_at" IS NOT NULL
                    AND shipment."delivered_at" IS NOT NULL
                    AND NOT EXISTS (
                        SELECT 1
                        FROM "shipments" replacement
                        WHERE replacement."replaces_shipment_id" = shipment."id"
                    )
              )
        ) OR NOT EXISTS (
            SELECT 1 FROM "fulfilment_slots" WHERE "order_id" = target_order_id
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'DELIVERED'
        ) THEN
            RAISE EXCEPTION 'delivered order requires every Shipment, Job, and fulfilment slot delivered'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'COMPLETED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'COMPLETED'
              AND phase."completed_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND (shipment."status" <> 'DELIVERED' OR shipment."delivered_at" IS NULL)
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'DELIVERED'
        ) OR NOT EXISTS (
            SELECT 1 FROM "jobs" WHERE "order_id" = target_order_id
        ) OR EXISTS (
            SELECT 1
            FROM "jobs"
            WHERE "order_id" = target_order_id
              AND "status" <> 'SETTLED'
        ) THEN
            RAISE EXCEPTION 'completed order requires its complete settled delivery aggregate'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'CANCELLED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'CANCELLED'
              AND phase."cancelled_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "jobs"
            WHERE "order_id" = target_order_id
              AND "status" NOT IN ('CANCELLED', 'FAILED', 'QC_REJECTED')
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND (shipment."status" <> 'CANCELLED' OR shipment."cancelled_at" IS NULL)
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'CANCELLED'
        ) THEN
            RAISE EXCEPTION 'cancelled order requires terminal phase, Jobs, Shipments, and slots'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'REFUNDED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'CANCELLED_REFUNDED'
              AND phase."cancelled_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "jobs"
            WHERE "order_id" = target_order_id
              AND "status" NOT IN ('CANCELLED', 'FAILED', 'QC_REJECTED')
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND (shipment."status" <> 'CANCELLED' OR shipment."cancelled_at" IS NULL)
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'CANCELLED_REFUNDED'
        ) THEN
            RAISE EXCEPTION 'refunded order requires terminal cancelled phase, Jobs, Shipments, and slots'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSE
        RAISE EXCEPTION 'order status requires persistence not available in this tranche'
            USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_post_confirmation_lifecycle_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_order_post_confirmation_lifecycle();
CREATE CONSTRAINT TRIGGER "order_phases_parent_lifecycle_reconciled"
AFTER UPDATE OF "status" ON "order_phases"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_order_post_confirmation_lifecycle();
CREATE CONSTRAINT TRIGGER "jobs_parent_lifecycle_reconciled"
AFTER INSERT OR UPDATE OF "status" ON "jobs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_order_post_confirmation_lifecycle();
CREATE CONSTRAINT TRIGGER "shipments_parent_lifecycle_reconciled"
AFTER INSERT OR UPDATE OF "status" ON "shipments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_order_post_confirmation_lifecycle();
CREATE CONSTRAINT TRIGGER "fulfilment_slots_parent_lifecycle_reconciled"
AFTER UPDATE OF "outcome" ON "fulfilment_slots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_order_post_confirmation_lifecycle();

CREATE FUNCTION taven_reconcile_cancelled_order_reservation_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_status "order_status";
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        target_order_id := (to_jsonb(NEW) ->> 'id')::uuid;
    ELSE
        SELECT phase."order_id"
        INTO target_order_id
        FROM "phase_reservation_sets" reservation_set
        JOIN "phase_resource_plans" resource_plan
          ON resource_plan."id" = reservation_set."phase_resource_plan_id"
         AND resource_plan."node_id" = reservation_set."node_id"
        JOIN "order_phases" phase ON phase."id" = resource_plan."order_phase_id"
        WHERE reservation_set."id" = (to_jsonb(NEW) ->> 'id')::uuid;
    END IF;

    SELECT target_order."status"
    INTO target_status
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    IF target_status IS NULL OR target_status NOT IN ('EXPIRED', 'CANCELLED', 'REFUNDED') THEN
        IF target_status = 'COMPLETED' THEN
            IF EXISTS (
                SELECT 1
                FROM "order_phases" phase
                JOIN "phase_resource_plans" resource_plan
                  ON resource_plan."order_phase_id" = phase."id"
                JOIN "phase_reservation_sets" reservation_set
                  ON reservation_set."phase_resource_plan_id" = resource_plan."id"
                 AND reservation_set."node_id" = resource_plan."node_id"
                WHERE phase."order_id" = target_order_id
                  AND reservation_set."status" IN ('BUILDING', 'RESERVED', 'HELD')
            ) OR EXISTS (
                SELECT 1
                FROM "jobs" job
                WHERE job."order_id" = target_order_id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM "production_reservations" production
                      JOIN "phase_reservation_sets" reservation_set
                        ON reservation_set."id" = production."phase_reservation_set_id"
                       AND reservation_set."node_id" = production."node_id"
                       AND reservation_set."phase_resource_plan_id" = production."phase_resource_plan_id"
                      WHERE production."job_id" = job."id"
                        AND production."node_id" = job."node_id"
                        AND production."phase_resource_plan_job_id" = job."phase_resource_plan_job_id"
                        AND production."status" = 'CONSUMED'
                        AND reservation_set."status" = 'SETTLED'
                        AND EXISTS (
                            SELECT 1
                            FROM "inventory_reservations" inventory_reservation
                            WHERE inventory_reservation."production_reservation_id" = production."id"
                              AND inventory_reservation."node_id" = production."node_id"
                              AND inventory_reservation."status" = 'CONSUMED'
                              AND inventory_reservation."consumed_milligrams" IS NOT NULL
                        )
                        AND EXISTS (
                            SELECT 1
                            FROM "capacity_reservations" capacity_reservation
                            WHERE capacity_reservation."production_reservation_id" = production."id"
                              AND capacity_reservation."node_id" = production."node_id"
                        )
                        AND NOT EXISTS (
                            SELECT 1
                            FROM "capacity_reservations" capacity_reservation
                            WHERE capacity_reservation."production_reservation_id" = production."id"
                              AND capacity_reservation."node_id" = production."node_id"
                              AND capacity_reservation."status" <> 'COMPLETED'
                        )
                  )
            ) THEN
                RAISE EXCEPTION 'completed order requires settled consumed reservation groups'
                    USING ERRCODE = '23514', CONSTRAINT = 'completed_order_reservation_settlement_check';
            END IF;
        END IF;
        RETURN NULL;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "order_phases" phase
        JOIN "phase_resource_plans" resource_plan
          ON resource_plan."order_phase_id" = phase."id"
        JOIN "phase_reservation_sets" reservation_set
          ON reservation_set."phase_resource_plan_id" = resource_plan."id"
         AND reservation_set."node_id" = resource_plan."node_id"
        WHERE phase."order_id" = target_order_id
          AND reservation_set."status" NOT IN ('SETTLED', 'RELEASED', 'EXPIRED')
    ) THEN
        RAISE EXCEPTION 'closed order cannot retain an active reservation set'
            USING ERRCODE = '23514', CONSTRAINT = 'cancelled_order_reservation_terminal_check';
    END IF;

    IF target_status = 'EXPIRED' AND EXISTS (
        SELECT 1
        FROM "order_phases" phase
        JOIN "phase_resource_plans" resource_plan
          ON resource_plan."order_phase_id" = phase."id"
        JOIN "phase_reservation_sets" reservation_set
          ON reservation_set."phase_resource_plan_id" = resource_plan."id"
         AND reservation_set."node_id" = resource_plan."node_id"
        WHERE phase."order_id" = target_order_id
          AND reservation_set."status" <> 'RELEASED'
    ) THEN
        RAISE EXCEPTION 'expired checkout requires every reservation set to be released'
            USING ERRCODE = '23514', CONSTRAINT = 'expired_order_reservation_release_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_cancelled_reservations_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION taven_reconcile_cancelled_order_reservation_terminal();
CREATE CONSTRAINT TRIGGER "phase_reservation_sets_cancelled_order_reconciled"
AFTER INSERT OR UPDATE OF "status" ON "phase_reservation_sets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION taven_reconcile_cancelled_order_reservation_terminal();

CREATE FUNCTION taven_reconcile_quoted_order_cancellation_payments()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM "orders"
    WHERE "id" = NEW."id"
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM "payments"
        WHERE "order_id" = NEW."id"
          AND (
              "status" NOT IN ('FAILED', 'VOIDED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED')
              OR "capture_authorized"
              OR "capture_cutoff_at" IS NULL
          )
    ) THEN
        RAISE EXCEPTION 'quoted order closure requires every payment intent to be closed'
            USING ERRCODE = '23514', CONSTRAINT = 'quoted_order_payment_cancellation_check';
    END IF;

    IF NEW."status" = 'EXPIRED' AND NOT EXISTS (
        SELECT 1
        FROM "payments"
        WHERE "order_id" = NEW."id"
          AND "role" = 'FULL'
          AND "checkout_capture_expires_at" IS NOT NULL
          AND "checkout_capture_expires_at" <= clock_timestamp()
          AND "capture_cutoff_at" >= "checkout_capture_expires_at"
    ) THEN
        RAISE EXCEPTION 'quoted order expiry requires its immutable checkout capture deadline to pass'
            USING ERRCODE = '23514', CONSTRAINT = 'quoted_order_expiry_deadline_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_quoted_cancellation_payments_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" = 'QUOTED' AND NEW."status" IN ('EXPIRED', 'CANCELLED'))
EXECUTE FUNCTION taven_reconcile_quoted_order_cancellation_payments();

CREATE FUNCTION taven_validate_order_price_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM taven_lock_automatic_order_session(NEW."order_id");

    PERFORM 1
    FROM "orders"
    WHERE "id" = NEW."order_id"
    FOR UPDATE;

    PERFORM 1
    FROM "price_snapshots"
    WHERE "id" = NEW."price_snapshot_id"
    FOR UPDATE;

    IF EXISTS (
        SELECT 1 FROM "individual_order_origins" origin WHERE origin."order_id" = NEW."order_id"
    ) AND (
        NEW."invalidated_at" IS NOT NULL
        OR NOT EXISTS (
            SELECT 1
            FROM "individual_order_origins" origin
            JOIN "quote_price_bindings" quote_binding ON quote_binding."quote_id" = origin."quote_id"
            WHERE origin."order_id" = NEW."order_id"
              AND quote_binding."price_snapshot_id" = NEW."price_snapshot_id"
        )
    ) THEN
        RAISE EXCEPTION 'individual order price binding must use its accepted quote snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'individual_order_price_binding_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_price_bindings_validate_origin"
BEFORE INSERT ON "order_price_bindings"
FOR EACH ROW EXECUTE FUNCTION taven_validate_order_price_binding();

CREATE FUNCTION taven_require_individual_order_quote_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid := NEW."order_id";
BEGIN
    PERFORM 1
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM "order_price_bindings" binding
        JOIN "individual_order_origins" origin
          ON origin."order_id" = binding."order_id"
        LEFT JOIN "quote_price_bindings" quoted
          ON quoted."quote_id" = origin."quote_id"
         AND quoted."price_snapshot_id" = binding."price_snapshot_id"
        WHERE binding."order_id" = target_order_id
          AND (quoted."quote_id" IS NULL OR binding."invalidated_at" IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'individual order price binding must use its accepted quote snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'individual_order_price_binding_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "order_price_bindings_individual_quote_snapshot_reconciled"
AFTER INSERT ON "order_price_bindings"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_require_individual_order_quote_snapshot();
CREATE CONSTRAINT TRIGGER "individual_order_origins_quote_snapshot_reconciled"
AFTER INSERT ON "individual_order_origins"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_require_individual_order_quote_snapshot();

CREATE FUNCTION taven_protect_order_price_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'order price bindings retain immutable pricing history'
            USING ERRCODE = '23514', CONSTRAINT = 'order_price_binding_immutable_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."price_snapshot_id" IS DISTINCT FROM OLD."price_snapshot_id"
       OR NEW."delivery_destination_id" IS DISTINCT FROM OLD."delivery_destination_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR (OLD."invalidated_at" IS NOT NULL AND NEW."invalidated_at" IS DISTINCT FROM OLD."invalidated_at") THEN
        RAISE EXCEPTION 'order price binding identity is immutable; it may only be invalidated once'
            USING ERRCODE = '23514', CONSTRAINT = 'order_price_binding_immutable_check';
    END IF;

    IF OLD."invalidated_at" IS NULL AND NEW."invalidated_at" IS NOT NULL THEN
        -- Reject an already-active binding before taking any secondary lock.
        IF EXISTS (
            SELECT 1
            FROM "order_active_price_bindings" active
            WHERE active."order_id" = OLD."order_id"
              AND active."order_price_binding_id" = OLD."id"
        ) THEN
            RAISE EXCEPTION 'active price binding can be invalidated only by an atomic binding move'
                USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_invalidation_check';
        END IF;

        PERFORM 1
        FROM "orders"
        WHERE "id" = OLD."order_id"
        FOR UPDATE NOWAIT;

        IF EXISTS (
            SELECT 1
            FROM "individual_order_origins" origin
            WHERE origin."order_id" = OLD."order_id"
        ) THEN
            RAISE EXCEPTION 'individual order price bindings retain their accepted Quote snapshot'
                USING ERRCODE = '23514', CONSTRAINT = 'individual_order_price_binding_invalidation_check';
        END IF;

        -- Repeat the active-reference check after taking the Order lock.
        IF EXISTS (
            SELECT 1
            FROM "order_active_price_bindings" active
            WHERE active."order_id" = OLD."order_id"
              AND active."order_price_binding_id" = OLD."id"
        ) THEN
            RAISE EXCEPTION 'active price binding can be invalidated only by an atomic binding move'
                USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_invalidation_check';
        END IF;

        IF EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = OLD."order_id") THEN
            RAISE EXCEPTION 'price binding cannot be invalidated after payment intent creation'
                USING ERRCODE = '23514', CONSTRAINT = 'order_price_binding_payment_guard';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_price_bindings_immutable"
BEFORE UPDATE OR DELETE ON "order_price_bindings"
FOR EACH ROW EXECUTE FUNCTION taven_protect_order_price_binding();

CREATE FUNCTION taven_move_active_order_price_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_status "order_status";
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."order_id" IS DISTINCT FROM OLD."order_id" THEN
        RAISE EXCEPTION 'active order price binding cannot be reparented'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_owner_immutable_check';
    END IF;

    PERFORM taven_lock_automatic_order_session(NEW."order_id");

    -- Lock the candidate without waiting on transactions that may already hold
    -- it while waiting for this active-pointer row. The no-op update creates an
    -- MVCC version so stronger-isolation invalidators cannot miss activation.
    PERFORM 1
    FROM "order_price_bindings" binding
    WHERE binding."id" = NEW."order_price_binding_id"
      AND binding."order_id" = NEW."order_id"
      AND binding."invalidated_at" IS NULL
    FOR UPDATE NOWAIT;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'active order price binding must belong to its order and remain valid'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_owner_check';
    END IF;

    UPDATE "order_price_bindings"
    SET "invalidated_at" = "invalidated_at"
    WHERE "id" = NEW."order_price_binding_id";

    SELECT "status"
    INTO target_order_status
    FROM "orders"
    WHERE "id" = NEW."order_id"
    FOR UPDATE NOWAIT;

    IF EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = NEW."order_id") THEN
        RAISE EXCEPTION 'active destination and price binding cannot change after payment intent creation'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_payment_guard';
    END IF;

    IF target_order_status <> 'DRAFT'
       AND (CASE WHEN TG_OP = 'INSERT' THEN true
                 ELSE NEW."order_price_binding_id" IS DISTINCT FROM OLD."order_price_binding_id"
            END)
       AND (
           NOT EXISTS (
               SELECT 1
               FROM "shipment_plans" plan
               JOIN "order_phases" phase
                 ON phase."id" = plan."order_phase_id"
                AND phase."order_id" = plan."order_id"
               WHERE plan."order_id" = NEW."order_id"
                 AND plan."order_price_binding_id" = NEW."order_price_binding_id"
                 AND phase."kind" = 'SINGLE'
                 AND phase."status" = 'QUOTED'
           )
           OR EXISTS (
               SELECT 1
               FROM "fulfilment_slots" slot
               WHERE slot."order_id" = NEW."order_id"
                 AND NOT EXISTS (
                     SELECT 1
                     FROM "shipment_plan_fulfilment_slots" allocation
                     WHERE allocation."fulfilment_slot_id" = slot."id"
                       AND allocation."order_price_binding_id" = NEW."order_price_binding_id"
                 )
           )
           OR EXISTS (
               SELECT 1
               FROM "shipment_plans" plan
               WHERE plan."order_id" = NEW."order_id"
                 AND plan."order_price_binding_id" = NEW."order_price_binding_id"
                 AND NOT EXISTS (
                     SELECT 1
                     FROM "shipment_plan_fulfilment_slots" allocation
                     WHERE allocation."shipment_plan_id" = plan."id"
                       AND allocation."order_price_binding_id" = NEW."order_price_binding_id"
                 )
           )
           OR NOT EXISTS (
               SELECT 1
               FROM "order_price_bindings" binding
               JOIN "price_snapshots" snapshot
                 ON snapshot."id" = binding."price_snapshot_id"
               JOIN "payment_schedules" schedule
                 ON schedule."price_snapshot_id" = snapshot."id"
                AND schedule."role" = 'FULL'
               WHERE binding."id" = NEW."order_price_binding_id"
                 AND snapshot."contract_total_minor" > 0
                 AND schedule."gross_amount_minor" = snapshot."contract_total_minor"
           )
       ) THEN
        RAISE EXCEPTION 'non-draft active binding requires complete quote-ready shipment topology'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_quote_topology_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_active_price_bindings_guarded"
BEFORE INSERT OR UPDATE ON "order_active_price_bindings"
FOR EACH ROW EXECUTE FUNCTION taven_move_active_order_price_binding();

CREATE FUNCTION taven_invalidate_moved_order_price_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM "order_price_bindings"
    WHERE "id" = OLD."order_price_binding_id"
    FOR UPDATE NOWAIT;

    UPDATE "order_price_bindings"
    SET "invalidated_at" = CURRENT_TIMESTAMP
    WHERE "id" = OLD."order_price_binding_id"
      AND "invalidated_at" IS NULL;

    RETURN NULL;
END;
$$;

CREATE TRIGGER "order_active_price_bindings_invalidate_previous"
AFTER UPDATE OF "order_price_binding_id" ON "order_active_price_bindings"
FOR EACH ROW
WHEN (NEW."order_price_binding_id" IS DISTINCT FROM OLD."order_price_binding_id")
EXECUTE FUNCTION taven_invalidate_moved_order_price_binding();

CREATE FUNCTION taven_prevent_active_order_price_binding_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'active order price binding cannot be deleted; move it before payment instead'
        USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_payment_guard';
END;
$$;

CREATE TRIGGER "order_active_price_bindings_not_deleted"
BEFORE DELETE ON "order_active_price_bindings"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_active_order_price_binding_delete();

CREATE TRIGGER "delivery_destinations_immutable"
BEFORE UPDATE OR DELETE ON "delivery_destinations"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();

CREATE FUNCTION taven_validate_price_component_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."quote_item_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM "quote_price_bindings" binding
        JOIN "quote_items" quote_item
          ON quote_item."id" = NEW."quote_item_id"
         AND quote_item."quote_id" = binding."quote_id"
        WHERE binding."price_snapshot_id" = NEW."price_snapshot_id"
    ) THEN
        RAISE EXCEPTION 'quote-item component must belong to the bound quote snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'price_component_quote_item_owner_check';
    END IF;

    IF NEW."order_item_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM "order_price_bindings" binding
        JOIN "order_items" order_item
          ON order_item."id" = NEW."order_item_id"
         AND order_item."order_id" = binding."order_id"
        WHERE binding."price_snapshot_id" = NEW."price_snapshot_id"
    ) THEN
        RAISE EXCEPTION 'order-item component must belong to the bound order snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'price_component_order_item_owner_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "price_snapshot_components_ownership"
BEFORE INSERT ON "price_snapshot_components"
FOR EACH ROW EXECUTE FUNCTION taven_validate_price_component_ownership();

CREATE FUNCTION taven_validate_price_component_fulfilment_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    SELECT binding."order_id"
    INTO target_order_id
    FROM "price_snapshot_components" component
    JOIN "order_price_bindings" binding
      ON binding."price_snapshot_id" = component."price_snapshot_id"
    WHERE component."id" = NEW."price_snapshot_component_id";

    IF target_order_id IS NOT NULL THEN
        PERFORM taven_lock_automatic_order_session(target_order_id);

        PERFORM 1
        FROM "orders"
        WHERE "id" = target_order_id
        FOR UPDATE;
    END IF;

    IF target_order_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = target_order_id) THEN
        RAISE EXCEPTION 'price component allocations cannot be added after payment intent creation'
            USING ERRCODE = '23514', CONSTRAINT = 'price_component_fulfilment_allocation_payment_guard';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "price_snapshot_components" component
        JOIN "order_price_bindings" binding
          ON binding."price_snapshot_id" = component."price_snapshot_id"
        JOIN "fulfilment_slots" slot ON slot."id" = NEW."fulfilment_slot_id"
        WHERE component."id" = NEW."price_snapshot_component_id"
          AND slot."order_id" = binding."order_id"
          AND (
              component."scope" = 'ORDER'
              OR (component."scope" = 'ORDER_ITEM'
                  AND component."order_item_id" = slot."order_item_id")
              OR (component."scope" = 'QUOTE_ITEM' AND EXISTS (
                  SELECT 1
                  FROM "individual_order_item_sources" source
                  WHERE source."order_item_id" = slot."order_item_id"
                    AND source."quote_item_id" = component."quote_item_id"
              ))
              OR (component."scope" = 'SHIPMENT_PLAN' AND EXISTS (
                  SELECT 1
                  FROM "shipment_plan_fulfilment_slots" plan_slot
                  JOIN "shipment_plans" plan ON plan."id" = plan_slot."shipment_plan_id"
                  WHERE plan_slot."fulfilment_slot_id" = slot."id"
                    AND plan_slot."order_price_binding_id" = binding."id"
                    AND plan."id" = component."shipment_plan_id"
                    AND plan."order_price_binding_id" = binding."id"
              ))
          )
    ) THEN
        RAISE EXCEPTION 'price component allocation must target a slot in its bound order scope'
            USING ERRCODE = '23514', CONSTRAINT = 'price_component_fulfilment_allocation_scope_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "price_component_fulfilment_allocations_scope"
BEFORE INSERT ON "price_component_fulfilment_allocations"
FOR EACH ROW EXECUTE FUNCTION taven_validate_price_component_fulfilment_allocation();
CREATE TRIGGER "price_component_fulfilment_allocations_immutable"
BEFORE UPDATE OR DELETE ON "price_component_fulfilment_allocations"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();

CREATE FUNCTION taven_assert_order_fulfilment_money(target_order_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    target_snapshot_id uuid;
    contract_total bigint;
    slot_total bigint;
BEGIN
    SELECT binding."price_snapshot_id", snapshot."contract_total_minor"
    INTO target_snapshot_id, contract_total
    FROM "order_active_price_bindings" active
    JOIN "order_price_bindings" binding ON binding."id" = active."order_price_binding_id"
    JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
    WHERE active."order_id" = target_order_id
      AND binding."invalidated_at" IS NULL;

    -- Drafts and issued custom quotes can exist without an Order binding.
    IF target_snapshot_id IS NULL THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "fulfilment_slots"
        WHERE "order_id" = target_order_id
    ) AND EXISTS (
        SELECT 1
        FROM "order_items" item
        CROSS JOIN (
            VALUES
                ('ITEM_PRODUCTION'::"price_component_kind"),
                ('ITEM_QUANTITY'::"price_component_kind"),
                ('ITEM_POSTPROCESSING'::"price_component_kind")
        ) AS mandatory("kind")
        WHERE item."order_id" = target_order_id
          AND NOT EXISTS (
              SELECT 1
              FROM "price_snapshot_components" component
              WHERE component."price_snapshot_id" = target_snapshot_id
                AND component."kind" = mandatory."kind"
                AND (
                    (component."scope" = 'ORDER_ITEM'
                     AND component."order_item_id" = item."id")
                    OR (component."scope" = 'QUOTE_ITEM' AND EXISTS (
                        SELECT 1
                        FROM "individual_order_item_sources" source
                        WHERE source."order_item_id" = item."id"
                          AND source."quote_item_id" = component."quote_item_id"
                    ))
                )
                AND EXISTS (
                    SELECT 1
                    FROM "price_component_fulfilment_allocations" allocation
                    JOIN "fulfilment_slots" slot
                      ON slot."id" = allocation."fulfilment_slot_id"
                    WHERE allocation."price_snapshot_component_id" = component."id"
                      AND slot."order_id" = target_order_id
                      AND slot."order_item_id" = item."id"
                )
          )
    ) THEN
        RAISE EXCEPTION 'every order item requires allocated production, quantity, and post-processing components'
            USING ERRCODE = '23514', CONSTRAINT = 'order_item_price_component_coverage_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "price_snapshot_components" component
        LEFT JOIN "price_component_fulfilment_allocations" allocation
          ON allocation."price_snapshot_component_id" = component."id"
        WHERE component."price_snapshot_id" = target_snapshot_id
        GROUP BY component."id", component."amount_minor"
        HAVING coalesce(sum(allocation."amount_minor"), 0) <> component."amount_minor"
    ) THEN
        RAISE EXCEPTION 'each active price component must reconcile to immutable fulfilment allocations'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfilment_allocation_reconciliation_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "fulfilment_slots" slot
        LEFT JOIN "price_component_fulfilment_allocations" allocation
          ON allocation."fulfilment_slot_id" = slot."id"
        LEFT JOIN "price_snapshot_components" component
          ON component."id" = allocation."price_snapshot_component_id"
         AND component."price_snapshot_id" = target_snapshot_id
        WHERE slot."order_id" = target_order_id
        GROUP BY slot."id", slot."settlement_amount_minor"
        HAVING slot."settlement_amount_minor" <> coalesce(
            sum(allocation."amount_minor") FILTER (WHERE component."id" IS NOT NULL),
            0
        )
    ) THEN
        RAISE EXCEPTION 'each fulfilment slot settlement must equal its active component allocations'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfilment_slot_reconciliation_check';
    END IF;

    SELECT coalesce(sum("settlement_amount_minor"), 0)
    INTO slot_total
    FROM "fulfilment_slots"
    WHERE "order_id" = target_order_id;

    IF slot_total <> contract_total THEN
        RAISE EXCEPTION 'active fulfilment slot settlements must equal the price contract total'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfilment_total_reconciliation_check';
    END IF;
END;
$$;

CREATE FUNCTION taven_validate_bound_order_fulfilment_money()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    SELECT binding."order_id"
    INTO target_order_id
    FROM "price_snapshot_components" component
    JOIN "order_price_bindings" binding
      ON binding."price_snapshot_id" = component."price_snapshot_id"
    JOIN "orders" target_order ON target_order."id" = binding."order_id"
    WHERE component."id" = NEW."price_snapshot_component_id"
      AND target_order."status" <> 'DRAFT'
      AND binding."invalidated_at" IS NULL;

    IF target_order_id IS NOT NULL THEN
        PERFORM taven_assert_order_fulfilment_money(target_order_id);
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "price_component_fulfilment_allocations_reconciled"
AFTER INSERT ON "price_component_fulfilment_allocations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_bound_order_fulfilment_money();

CREATE FUNCTION taven_validate_quoted_order_fulfilment_money()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    target_order_id := NEW."order_id";

    IF EXISTS (
        SELECT 1 FROM "orders"
        WHERE "id" = target_order_id
          AND "status" <> 'DRAFT'
    ) THEN
        PERFORM taven_assert_order_fulfilment_money(target_order_id);
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "order_active_price_bindings_quoted_reconciled"
AFTER INSERT OR UPDATE ON "order_active_price_bindings"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_quoted_order_fulfilment_money();
CREATE CONSTRAINT TRIGGER "fulfilment_slots_settlement_quoted_reconciled"
AFTER UPDATE OF "settlement_amount_minor" ON "fulfilment_slots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_quoted_order_fulfilment_money();

CREATE FUNCTION taven_validate_price_snapshot_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_snapshot_id uuid;
    contract_total bigint;
    component_total bigint;
    schedule_count integer;
    scheduled_total bigint;
BEGIN
    target_snapshot_id := CASE
        WHEN TG_TABLE_NAME = 'price_snapshots' THEN (to_jsonb(NEW) ->> 'id')::uuid
        ELSE (to_jsonb(NEW) ->> 'price_snapshot_id')::uuid
    END;

    SELECT "contract_total_minor"
    INTO contract_total
    FROM "price_snapshots"
    WHERE "id" = target_snapshot_id;

    SELECT coalesce(sum("amount_minor"), 0)
    INTO component_total
    FROM "price_snapshot_components"
    WHERE "price_snapshot_id" = target_snapshot_id;

    SELECT count(*), coalesce(sum("gross_amount_minor"), 0)
    INTO schedule_count, scheduled_total
    FROM "payment_schedules"
    WHERE "price_snapshot_id" = target_snapshot_id
      AND "role" = 'FULL';

    IF component_total <> contract_total
       OR schedule_count <> 1
       OR scheduled_total <> contract_total THEN
        RAISE EXCEPTION 'price snapshot % requires components and one full payment schedule equal to its contract total', target_snapshot_id
            USING ERRCODE = '23514', CONSTRAINT = 'price_snapshot_total_reconciliation_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "quote_price_bindings"
        WHERE "price_snapshot_id" = target_snapshot_id
        UNION ALL
        SELECT 1
        FROM "order_price_bindings"
        WHERE "price_snapshot_id" = target_snapshot_id
    ) THEN
        UPDATE "price_snapshots"
        SET "sealed_at" = CURRENT_TIMESTAMP(3)
        WHERE "id" = target_snapshot_id
          AND "sealed_at" IS NULL;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "price_snapshots_total_reconciled"
AFTER INSERT ON "price_snapshots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_price_snapshot_totals();
CREATE CONSTRAINT TRIGGER "price_snapshot_components_total_reconciled"
AFTER INSERT ON "price_snapshot_components"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_price_snapshot_totals();
CREATE CONSTRAINT TRIGGER "payment_schedules_total_reconciled"
AFTER INSERT ON "payment_schedules"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_price_snapshot_totals();
CREATE CONSTRAINT TRIGGER "quote_price_bindings_snapshot_sealed"
AFTER INSERT ON "quote_price_bindings"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_price_snapshot_totals();
CREATE CONSTRAINT TRIGGER "order_price_bindings_snapshot_sealed"
AFTER INSERT ON "order_price_bindings"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_price_snapshot_totals();

CREATE FUNCTION taven_validate_phase_plan_job_shipment_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "phase_resource_plans" plan
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = NEW."candidate_resource_estimate_id"
         AND candidate."node_id" = NEW."node_id"
        JOIN "shipment_plans" shipment_plan
          ON shipment_plan."id" = candidate."shipment_plan_id"
        WHERE plan."id" = NEW."phase_resource_plan_id"
          AND plan."node_id" = NEW."node_id"
          AND shipment_plan."order_phase_id" = plan."order_phase_id"
    ) THEN
        RAISE EXCEPTION 'planned job candidate shipment plan must belong to the resource plan phase'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_plan_job_shipment_scope_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "phase_resource_plan_jobs_shipment_scope"
BEFORE INSERT OR UPDATE ON "phase_resource_plan_jobs"
FOR EACH ROW EXECUTE FUNCTION taven_validate_phase_plan_job_shipment_scope();

CREATE FUNCTION taven_validate_phase_plan_slot_candidate_inputs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "phase_resource_plan_jobs" plan_job
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = plan_job."candidate_resource_estimate_id"
         AND candidate."node_id" = plan_job."node_id"
        JOIN "inventories" inventory
          ON inventory."id" = candidate."inventory_id"
         AND inventory."node_id" = candidate."node_id"
        JOIN "fulfilment_slots" slot ON slot."id" = NEW."fulfilment_slot_id"
        JOIN "order_items" item
          ON item."id" = slot."order_item_id"
         AND item."order_id" = slot."order_id"
        JOIN "shipment_plan_fulfilment_slots" allocation
          ON allocation."fulfilment_slot_id" = slot."id"
         AND allocation."shipment_plan_id" = candidate."shipment_plan_id"
        WHERE plan_job."id" = NEW."phase_resource_plan_job_id"
          AND plan_job."node_id" = NEW."node_id"
          AND plan_job."phase_resource_plan_id" = NEW."phase_resource_plan_id"
          AND candidate."model_geometry_id" = item."model_geometry_id"
          AND candidate."print_config_revision_id" = item."print_config_revision_id"
          AND inventory."material" = item."material"
          AND (item."color" IS NULL OR inventory."color" = item."color")
    ) THEN
        RAISE EXCEPTION 'planned slot must match its candidate geometry, print configuration, material, color, and shipment allocation'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_resource_plan_slot_candidate_input_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "phase_resource_plan_slots_candidate_inputs"
BEFORE INSERT ON "phase_resource_plan_slots"
FOR EACH ROW EXECUTE FUNCTION taven_validate_phase_plan_slot_candidate_inputs();

CREATE FUNCTION taven_validate_phase_plan_job_candidate_quantity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_plan_job_id uuid;
    candidate_quantity integer;
    planned_slot_count integer;
    planned_item_count integer;
BEGIN
    target_plan_job_id := CASE
        WHEN TG_TABLE_NAME = 'phase_resource_plan_jobs'
            THEN (to_jsonb(NEW) ->> 'id')::uuid
        ELSE (to_jsonb(NEW) ->> 'phase_resource_plan_job_id')::uuid
    END;

    SELECT candidate."quantity"
    INTO candidate_quantity
    FROM "phase_resource_plan_jobs" plan_job
    JOIN "candidate_resource_estimates" candidate
      ON candidate."id" = plan_job."candidate_resource_estimate_id"
     AND candidate."node_id" = plan_job."node_id"
    WHERE plan_job."id" = target_plan_job_id;

    SELECT count(*), count(DISTINCT slot."order_item_id")
    INTO planned_slot_count, planned_item_count
    FROM "phase_resource_plan_slots" plan_slot
    JOIN "fulfilment_slots" slot ON slot."id" = plan_slot."fulfilment_slot_id"
    WHERE plan_slot."phase_resource_plan_job_id" = target_plan_job_id;

    IF candidate_quantity IS NULL OR planned_slot_count <> candidate_quantity THEN
        RAISE EXCEPTION 'planned job slot count must equal its candidate quantity'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_resource_plan_slot_candidate_quantity_check';
    END IF;

    IF planned_item_count <> 1 THEN
        RAISE EXCEPTION 'planned job slots must belong to one independently configured order item'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_resource_plan_slot_candidate_item_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "phase_resource_plan_jobs_candidate_quantity_reconciled"
AFTER INSERT ON "phase_resource_plan_jobs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_phase_plan_job_candidate_quantity();
CREATE CONSTRAINT TRIGGER "phase_resource_plan_slots_candidate_quantity_reconciled"
AFTER INSERT ON "phase_resource_plan_slots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_phase_plan_job_candidate_quantity();

CREATE FUNCTION taven_validate_job_planning_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "phase_resource_plan_jobs" plan_job
        JOIN "phase_resource_plans" plan
          ON plan."id" = plan_job."phase_resource_plan_id"
         AND plan."node_id" = plan_job."node_id"
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = plan_job."candidate_resource_estimate_id"
         AND candidate."node_id" = plan_job."node_id"
        WHERE plan_job."id" = NEW."phase_resource_plan_job_id"
          AND plan_job."node_id" = NEW."node_id"
          AND candidate."shipment_plan_id" = NEW."shipment_plan_id"
          AND plan."order_phase_id" = NEW."order_phase_id"
    ) THEN
        RAISE EXCEPTION 'job must use a planned candidate for its phase and shipment plan'
            USING ERRCODE = '23514', CONSTRAINT = 'job_planning_scope_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "jobs_planning_scope"
BEFORE INSERT OR UPDATE ON "jobs"
FOR EACH ROW EXECUTE FUNCTION taven_validate_job_planning_scope();

CREATE FUNCTION taven_require_captured_reservation_for_job()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM "payments"
    WHERE "order_id" = NEW."order_id"
    ORDER BY "id"
    FOR UPDATE;

    PERFORM 1
    FROM "phase_resource_plan_jobs"
    WHERE "id" = NEW."phase_resource_plan_job_id"
      AND "node_id" = NEW."node_id"
    FOR UPDATE;

    IF NOT EXISTS (
        SELECT 1
        FROM "payments" payment
        WHERE payment."order_id" = NEW."order_id"
          AND payment."status" = 'CAPTURED'
    ) OR NOT EXISTS (
        SELECT 1
        FROM "production_reservations" production
        WHERE production."job_id" = NEW."id"
          AND production."node_id" = NEW."node_id"
          AND production."phase_resource_plan_job_id" = NEW."phase_resource_plan_job_id"
          AND production."status" = 'HELD'
    ) THEN
        RAISE EXCEPTION 'job requires a captured payment and its held production reservation'
            USING ERRCODE = '23514', CONSTRAINT = 'job_capture_reconciliation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "jobs_captured_reservation_reconciled"
AFTER INSERT ON "jobs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_require_captured_reservation_for_job();

CREATE FUNCTION taven_reconcile_payment_capture_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_payment_id uuid;
BEGIN
    CASE TG_TABLE_NAME
        WHEN 'payments' THEN
            target_order_id := (to_jsonb(NEW) ->> 'order_id')::uuid;
            target_payment_id := (to_jsonb(NEW) ->> 'id')::uuid;
        WHEN 'orders' THEN
            target_order_id := (to_jsonb(NEW) ->> 'id')::uuid;
        WHEN 'order_phases' THEN
            target_order_id := (to_jsonb(NEW) ->> 'order_id')::uuid;
        ELSE
            SELECT phase."order_id"
            INTO target_order_id
            FROM "phase_reservation_sets" reservation_set
            JOIN "phase_resource_plans" plan
              ON plan."id" = reservation_set."phase_resource_plan_id"
             AND plan."node_id" = reservation_set."node_id"
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE reservation_set."id" = (to_jsonb(NEW) ->> 'id')::uuid;
    END CASE;

    PERFORM 1
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    IF NOT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "order_phases" phase
          ON phase."order_id" = target_order."id"
         AND phase."kind" = 'SINGLE'
         AND phase."status" = 'ACTIVE'
         AND phase."activated_at" IS NOT NULL
        JOIN "payments" payment
          ON payment."order_id" = target_order."id"
         AND payment."status" = 'CAPTURED'
         AND payment."role" = 'FULL'
         AND payment."captured_amount_minor" = payment."requested_amount_minor"
        JOIN "order_active_price_bindings" active_binding
          ON active_binding."order_id" = target_order."id"
         AND active_binding."order_price_binding_id" = payment."order_price_binding_id"
        JOIN "phase_resource_plans" resource_plan
          ON resource_plan."order_phase_id" = phase."id"
         AND resource_plan."expires_at" > clock_timestamp()
        JOIN "phase_reservation_sets" reservation_set
          ON reservation_set."phase_resource_plan_id" = resource_plan."id"
         AND reservation_set."node_id" = resource_plan."node_id"
         AND reservation_set."status" = 'HELD'
         AND reservation_set."expires_at" > clock_timestamp()
        WHERE target_order."id" = target_order_id
          AND target_order."status" = 'CONFIRMED'
          AND target_order."confirmed_at" IS NOT NULL
          AND (target_payment_id IS NULL OR payment."id" = target_payment_id)
          AND (
              SELECT count(*)
              FROM "phase_reservation_sets" held_set
              JOIN "phase_resource_plans" held_plan
                ON held_plan."id" = held_set."phase_resource_plan_id"
               AND held_plan."node_id" = held_set."node_id"
              WHERE held_plan."order_phase_id" = phase."id"
                AND held_set."status" = 'HELD'
          ) = 1
          AND EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              LEFT JOIN "production_reservations" production
                ON production."phase_reservation_set_id" = reservation_set."id"
               AND production."phase_resource_plan_job_id" = plan_job."id"
               AND production."node_id" = plan_job."node_id"
              LEFT JOIN "jobs" job
                ON job."id" = production."job_id"
               AND job."node_id" = production."node_id"
               AND job."phase_resource_plan_job_id" = production."phase_resource_plan_job_id"
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
                AND (
                    production."id" IS NULL
                    OR production."status" <> 'HELD'
                    OR production."job_id" IS NULL
                    OR job."id" IS NULL
                    OR job."order_id" <> target_order."id"
                    OR job."order_phase_id" <> phase."id"
                    OR job."status" <> 'CREATED'
                    OR NOT EXISTS (
                        SELECT 1
                        FROM "inventory_reservations" inventory_reservation
                        WHERE inventory_reservation."production_reservation_id" = production."id"
                          AND inventory_reservation."node_id" = production."node_id"
                          AND inventory_reservation."status" = 'HELD'
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM "inventory_reservations" inventory_reservation
                        WHERE inventory_reservation."production_reservation_id" = production."id"
                          AND inventory_reservation."node_id" = production."node_id"
                          AND inventory_reservation."status" <> 'HELD'
                    )
                    OR NOT EXISTS (
                        SELECT 1
                        FROM "capacity_reservations" capacity_reservation
                        WHERE capacity_reservation."production_reservation_id" = production."id"
                          AND capacity_reservation."node_id" = production."node_id"
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM "capacity_reservations" capacity_reservation
                        WHERE capacity_reservation."production_reservation_id" = production."id"
                          AND capacity_reservation."node_id" = production."node_id"
                          AND capacity_reservation."status" <> 'HELD'
                    )
                )
          )
    ) THEN
        RAISE EXCEPTION 'captured payment requires atomic order, phase, reservation, and Job activation'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_activation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_capture_activation_reconciled"
AFTER UPDATE OF "status" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" = 'PENDING' AND NEW."status" = 'CAPTURED')
EXECUTE FUNCTION taven_reconcile_payment_capture_activation();
CREATE CONSTRAINT TRIGGER "orders_capture_activation_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" = 'QUOTED' AND NEW."status" = 'CONFIRMED')
EXECUTE FUNCTION taven_reconcile_payment_capture_activation();
CREATE CONSTRAINT TRIGGER "order_phases_capture_activation_reconciled"
AFTER UPDATE OF "status" ON "order_phases"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" = 'QUOTED' AND NEW."status" = 'ACTIVE')
EXECUTE FUNCTION taven_reconcile_payment_capture_activation();
CREATE CONSTRAINT TRIGGER "phase_reservation_sets_capture_activation_reconciled"
AFTER UPDATE OF "status" ON "phase_reservation_sets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status" AND NEW."status" = 'HELD')
EXECUTE FUNCTION taven_reconcile_payment_capture_activation();

CREATE FUNCTION taven_reconcile_confirmed_order_reservation_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_status "order_status";
BEGIN
    CASE TG_TABLE_NAME
        WHEN 'phase_reservation_sets' THEN
            SELECT phase."order_id"
            INTO target_order_id
            FROM "phase_reservation_sets" reservation_set
            JOIN "phase_resource_plans" plan
              ON plan."id" = reservation_set."phase_resource_plan_id"
             AND plan."node_id" = reservation_set."node_id"
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE reservation_set."id" = (to_jsonb(NEW) ->> 'id')::uuid;
        WHEN 'production_reservations' THEN
            SELECT phase."order_id"
            INTO target_order_id
            FROM "production_reservations" production
            JOIN "phase_resource_plans" plan
              ON plan."id" = production."phase_resource_plan_id"
             AND plan."node_id" = production."node_id"
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE production."id" = (to_jsonb(NEW) ->> 'id')::uuid;
        ELSE
            SELECT phase."order_id"
            INTO target_order_id
            FROM "production_reservations" production
            JOIN "phase_resource_plans" plan
              ON plan."id" = production."phase_resource_plan_id"
             AND plan."node_id" = production."node_id"
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE production."id" = (to_jsonb(NEW) ->> 'production_reservation_id')::uuid;
    END CASE;

    SELECT target_order."status"
    INTO target_status
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    IF target_status IS DISTINCT FROM 'CONFIRMED'::"order_status" THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "order_phases" phase
        JOIN "phase_resource_plans" resource_plan
          ON resource_plan."order_phase_id" = phase."id"
        JOIN "phase_reservation_sets" reservation_set
          ON reservation_set."phase_resource_plan_id" = resource_plan."id"
         AND reservation_set."node_id" = resource_plan."node_id"
         AND reservation_set."status" = 'HELD'
        WHERE phase."order_id" = target_order_id
          AND phase."kind" = 'SINGLE'
          AND phase."status" = 'ACTIVE'
          AND phase."activated_at" IS NOT NULL
          AND (
              SELECT count(*)
              FROM "phase_reservation_sets" held_set
              JOIN "phase_resource_plans" held_plan
                ON held_plan."id" = held_set."phase_resource_plan_id"
               AND held_plan."node_id" = held_set."node_id"
              WHERE held_plan."order_phase_id" = phase."id"
                AND held_set."status" = 'HELD'
          ) = 1
          AND EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              LEFT JOIN "production_reservations" production
                ON production."phase_reservation_set_id" = reservation_set."id"
               AND production."phase_resource_plan_job_id" = plan_job."id"
               AND production."node_id" = plan_job."node_id"
              LEFT JOIN "jobs" job
                ON job."id" = production."job_id"
               AND job."node_id" = production."node_id"
               AND job."phase_resource_plan_job_id" = production."phase_resource_plan_job_id"
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
                AND (
                    production."id" IS NULL
                    OR production."status" <> 'HELD'
                    OR production."job_id" IS NULL
                    OR job."id" IS NULL
                    OR job."order_id" <> target_order_id
                    OR job."order_phase_id" <> phase."id"
                    OR job."status" NOT IN ('CREATED', 'ACCEPTED', 'GCODE_READY')
                    OR NOT EXISTS (
                        SELECT 1
                        FROM "inventory_reservations" inventory_reservation
                        WHERE inventory_reservation."production_reservation_id" = production."id"
                          AND inventory_reservation."node_id" = production."node_id"
                          AND inventory_reservation."status" = 'HELD'
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM "inventory_reservations" inventory_reservation
                        WHERE inventory_reservation."production_reservation_id" = production."id"
                          AND inventory_reservation."node_id" = production."node_id"
                          AND inventory_reservation."status" <> 'HELD'
                    )
                    OR NOT EXISTS (
                        SELECT 1
                        FROM "capacity_reservations" capacity_reservation
                        WHERE capacity_reservation."production_reservation_id" = production."id"
                          AND capacity_reservation."node_id" = production."node_id"
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM "capacity_reservations" capacity_reservation
                        WHERE capacity_reservation."production_reservation_id" = production."id"
                          AND capacity_reservation."node_id" = production."node_id"
                          AND capacity_reservation."status" <> 'HELD'
                    )
                )
          )
    ) THEN
        RAISE EXCEPTION 'confirmed order must retain its complete held reservation graph'
            USING ERRCODE = '23514', CONSTRAINT = 'confirmed_order_reservation_hold_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "phase_reservation_sets_confirmed_order_hold_reconciled"
AFTER UPDATE OF "status" ON "phase_reservation_sets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION taven_reconcile_confirmed_order_reservation_hold();
CREATE CONSTRAINT TRIGGER "production_reservations_confirmed_order_hold_reconciled"
AFTER UPDATE OF "status" ON "production_reservations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION taven_reconcile_confirmed_order_reservation_hold();
CREATE CONSTRAINT TRIGGER "inventory_reservations_confirmed_order_hold_reconciled"
AFTER UPDATE OF "status" ON "inventory_reservations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION taven_reconcile_confirmed_order_reservation_hold();
CREATE CONSTRAINT TRIGGER "capacity_reservations_confirmed_order_hold_reconciled"
AFTER UPDATE OF "status" ON "capacity_reservations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION taven_reconcile_confirmed_order_reservation_hold();

CREATE FUNCTION taven_reconcile_order_production_resource_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_status "order_status";
BEGIN
    SELECT "status"
    INTO target_status
    FROM "orders"
    WHERE "id" = NEW."id"
    FOR UPDATE;

    IF target_status IS DISTINCT FROM 'IN_PRODUCTION'::"order_status" THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "jobs" job
        JOIN "production_reservations" production
          ON production."job_id" = job."id"
         AND production."node_id" = job."node_id"
         AND production."phase_resource_plan_job_id" = job."phase_resource_plan_job_id"
        WHERE job."order_id" = NEW."id"
          AND job."printing_at" IS NOT NULL
          AND (
              (
                  production."status" = 'PRINTING'
                  AND EXISTS (
                      SELECT 1
                      FROM "inventory_reservations" inventory_reservation
                      WHERE inventory_reservation."production_reservation_id" = production."id"
                        AND inventory_reservation."node_id" = production."node_id"
                        AND inventory_reservation."status" = 'ALLOCATED'
                  )
                  AND EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                        AND capacity_reservation."node_id" = production."node_id"
                        AND capacity_reservation."status" = 'PRINTING'
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                        AND capacity_reservation."node_id" = production."node_id"
                        AND capacity_reservation."status" NOT IN ('SCHEDULED', 'PRINTING')
                  )
              ) OR (
                  production."status" = 'CONSUMED'
                  AND EXISTS (
                      SELECT 1
                      FROM "inventory_reservations" inventory_reservation
                      WHERE inventory_reservation."production_reservation_id" = production."id"
                        AND inventory_reservation."node_id" = production."node_id"
                        AND inventory_reservation."status" = 'CONSUMED'
                  )
                  AND EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                        AND capacity_reservation."node_id" = production."node_id"
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                        AND capacity_reservation."node_id" = production."node_id"
                        AND capacity_reservation."status" <> 'COMPLETED'
                  )
              )
          )
    ) THEN
        RAISE EXCEPTION 'in-production order requires an atomically started reservation group'
            USING ERRCODE = '23514', CONSTRAINT = 'order_production_resource_start_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_production_resource_start_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" = 'CONFIRMED' AND NEW."status" = 'IN_PRODUCTION')
EXECUTE FUNCTION taven_reconcile_order_production_resource_start();

CREATE FUNCTION taven_reconcile_job_printing_reservation_group()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_job_id uuid;
    target_job_status "job_status";
    target_job_printing_at timestamptz;
    job_started_printing_event boolean := false;
    live_printing_group_started boolean;
    group_started_or_completed boolean;
    live_printing_group_consistent boolean;
    completed_printing_group_consistent boolean;
BEGIN
    IF TG_TABLE_NAME = 'jobs' THEN
        target_job_id := NEW."id";
        job_started_printing_event := OLD."status" = 'GCODE_READY' AND NEW."status" = 'PRINTING';
    ELSIF TG_TABLE_NAME = 'production_reservations' THEN
        target_job_id := coalesce(NEW."job_id", OLD."job_id");
    ELSE
        SELECT production."job_id"
        INTO target_job_id
        FROM "production_reservations" production
        WHERE production."id" = NEW."production_reservation_id";
    END IF;

    IF target_job_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT job."status", job."printing_at"
    INTO target_job_status, target_job_printing_at
    FROM "jobs" job
    WHERE job."id" = target_job_id
    FOR UPDATE;

    IF target_job_status IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT
        EXISTS (
            SELECT 1
            FROM "production_reservations" production
            WHERE production."job_id" = target_job_id
              AND (
                  production."status" = 'PRINTING'
                  OR EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                        AND capacity_reservation."node_id" = production."node_id"
                        AND capacity_reservation."status" = 'PRINTING'
                  )
              )
        ),
        EXISTS (
            SELECT 1
            FROM "production_reservations" production
            WHERE production."job_id" = target_job_id
              AND (
                  production."status" IN ('PRINTING', 'CONSUMED')
                  OR EXISTS (
                      SELECT 1
                      FROM "capacity_reservations" capacity_reservation
                      WHERE capacity_reservation."production_reservation_id" = production."id"
                        AND capacity_reservation."node_id" = production."node_id"
                        AND capacity_reservation."status" IN ('PRINTING', 'COMPLETED')
                  )
              )
        ),
        EXISTS (
            SELECT 1
            FROM "production_reservations" production
            WHERE production."job_id" = target_job_id
              AND production."status" = 'PRINTING'
              AND EXISTS (
                  SELECT 1
                  FROM "inventory_reservations" inventory_reservation
                  WHERE inventory_reservation."production_reservation_id" = production."id"
                    AND inventory_reservation."node_id" = production."node_id"
                    AND inventory_reservation."status" = 'ALLOCATED'
              )
              AND EXISTS (
                  SELECT 1
                  FROM "capacity_reservations" capacity_reservation
                  WHERE capacity_reservation."production_reservation_id" = production."id"
                    AND capacity_reservation."node_id" = production."node_id"
                    AND capacity_reservation."status" = 'PRINTING'
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM "capacity_reservations" capacity_reservation
                  WHERE capacity_reservation."production_reservation_id" = production."id"
                    AND capacity_reservation."node_id" = production."node_id"
                    AND capacity_reservation."status" NOT IN ('SCHEDULED', 'PRINTING')
              )
        ),
        EXISTS (
            SELECT 1
            FROM "production_reservations" production
            WHERE production."job_id" = target_job_id
              AND production."status" = 'CONSUMED'
              AND EXISTS (
                  SELECT 1
                  FROM "inventory_reservations" inventory_reservation
                  WHERE inventory_reservation."production_reservation_id" = production."id"
                    AND inventory_reservation."node_id" = production."node_id"
                    AND inventory_reservation."status" = 'CONSUMED'
              )
              AND EXISTS (
                  SELECT 1
                  FROM "capacity_reservations" capacity_reservation
                  WHERE capacity_reservation."production_reservation_id" = production."id"
                    AND capacity_reservation."node_id" = production."node_id"
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM "capacity_reservations" capacity_reservation
                  WHERE capacity_reservation."production_reservation_id" = production."id"
                    AND capacity_reservation."node_id" = production."node_id"
                    AND capacity_reservation."status" <> 'COMPLETED'
              )
        )
    INTO live_printing_group_started,
         group_started_or_completed,
         live_printing_group_consistent,
         completed_printing_group_consistent;

    IF (job_started_printing_event AND NOT live_printing_group_consistent)
       OR (target_job_status = 'PRINTING'
           AND NOT live_printing_group_consistent)
       OR (target_job_status IN ('PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND (target_job_printing_at IS NULL OR NOT completed_printing_group_consistent))
       OR (live_printing_group_started AND target_job_status <> 'PRINTING')
       OR (target_job_status IN ('CREATED', 'ACCEPTED', 'GCODE_READY') AND group_started_or_completed) THEN
        RAISE EXCEPTION 'printing Job and its exact reservation group must transition atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'job_printing_reservation_group_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "jobs_printing_reservation_group_reconciled"
AFTER UPDATE OF "status" ON "jobs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION taven_reconcile_job_printing_reservation_group();
CREATE CONSTRAINT TRIGGER "production_reservations_job_printing_reconciled"
AFTER UPDATE OF "status", "job_id" ON "production_reservations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status" OR OLD."job_id" IS DISTINCT FROM NEW."job_id")
EXECUTE FUNCTION taven_reconcile_job_printing_reservation_group();
CREATE CONSTRAINT TRIGGER "inventory_reservations_job_printing_reconciled"
AFTER UPDATE OF "status" ON "inventory_reservations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION taven_reconcile_job_printing_reservation_group();
CREATE CONSTRAINT TRIGGER "capacity_reservations_job_printing_reconciled"
AFTER UPDATE OF "status" ON "capacity_reservations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION taven_reconcile_job_printing_reservation_group();

CREATE FUNCTION taven_extend_quote_source_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE "model_files" source
    SET "source_delete_after" = greatest(
        source."source_delete_after",
        quote."expires_at" + make_interval(days => source."source_retention_days")
    )
    FROM "quotes" quote
    WHERE quote."id" = NEW."quote_id"
      AND source."id" = NEW."source_model_file_id";

    RETURN NULL;
END;
$$;

CREATE TRIGGER "quote_items_geometry_source_available"
BEFORE INSERT ON "quote_items"
FOR EACH ROW EXECUTE FUNCTION taven_assert_geometry_usage_available();
CREATE TRIGGER "quote_items_extend_source_retention"
AFTER INSERT ON "quote_items"
FOR EACH ROW EXECUTE FUNCTION taven_extend_quote_source_retention();

CREATE FUNCTION taven_hold_order_source_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE "model_files"
    SET "retention_hold" = CASE
        WHEN "retention_hold" IN ('ACTIVE_CLAIM', 'LEGAL') THEN "retention_hold"
        ELSE 'ACTIVE_ORDER'::"retention_hold"
    END
    WHERE "id" = NEW."source_model_file_id"
      AND EXISTS (
          SELECT 1
          FROM "orders" target_order
          WHERE target_order."id" = NEW."order_id"
            AND target_order."status" NOT IN ('DRAFT', 'QUOTED', 'EXPIRED')
      );

    RETURN NULL;
END;
$$;

CREATE TRIGGER "order_items_geometry_source_available"
BEFORE INSERT OR UPDATE OF "source_model_file_id", "model_geometry_id" ON "order_items"
FOR EACH ROW EXECUTE FUNCTION taven_assert_geometry_usage_available();
CREATE TRIGGER "order_items_hold_source_retention"
AFTER INSERT ON "order_items"
FOR EACH ROW EXECUTE FUNCTION taven_hold_order_source_retention();

CREATE FUNCTION taven_hold_confirmed_order_sources()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    terminal_at timestamptz := clock_timestamp();
    old_is_terminal boolean;
    new_is_terminal boolean;
BEGIN
    old_is_terminal := OLD."status" IN ('EXPIRED', 'COMPLETED', 'REFUNDED', 'PARTIALLY_FULFILLED', 'CANCELLED_SETTLED')
        OR (
            OLD."status" = 'CANCELLED'
            AND NOT EXISTS (
                SELECT 1
                FROM "payments" payment
                WHERE payment."order_id" = OLD."id"
                  AND coalesce(payment."captured_amount_minor", 0) > 0
            )
        );
    new_is_terminal := NEW."status" IN ('EXPIRED', 'COMPLETED', 'REFUNDED', 'PARTIALLY_FULFILLED', 'CANCELLED_SETTLED')
        OR (
            NEW."status" = 'CANCELLED'
            AND NOT EXISTS (
                SELECT 1
                FROM "payments" payment
                WHERE payment."order_id" = NEW."id"
                  AND coalesce(payment."captured_amount_minor", 0) > 0
            )
        );

    IF old_is_terminal AND NOT new_is_terminal THEN
        RAISE EXCEPTION 'terminal orders cannot return to an active status'
            USING ERRCODE = '23514', CONSTRAINT = 'order_terminal_status_check';
    END IF;

    IF OLD."status" IN ('DRAFT', 'QUOTED')
       AND NEW."status" NOT IN ('DRAFT', 'QUOTED')
       AND NOT new_is_terminal THEN
        UPDATE "model_files" source
        SET "retention_hold" = CASE
            WHEN source."retention_hold" IN ('ACTIVE_CLAIM', 'LEGAL') THEN source."retention_hold"
            ELSE 'ACTIVE_ORDER'::"retention_hold"
        END
        FROM "order_items" item
        WHERE item."order_id" = NEW."id"
          AND source."id" = item."source_model_file_id";

        UPDATE "photo_assets" photo
        SET "retention_hold" = CASE
            WHEN photo."retention_hold" IN ('ACTIVE_CLAIM', 'LEGAL') THEN photo."retention_hold"
            ELSE 'ACTIVE_ORDER'::"retention_hold"
        END
        FROM "individual_order_origins" origin
        JOIN "quotes" quote ON quote."id" = origin."quote_id"
        WHERE origin."order_id" = NEW."id"
          AND photo."kind" = 'QUOTE_REFERENCE'::"photo_asset_kind"
          AND photo."scope_kind" = 'QUOTE_REQUEST'::"photo_scope_kind"
          AND photo."scope_id" = quote."quote_request_id";
    END IF;

    IF NOT old_is_terminal AND new_is_terminal THEN
        PERFORM 1
        FROM "model_files" source
        WHERE source."id" IN (
            SELECT item."source_model_file_id"
            FROM "order_items" item
            WHERE item."order_id" = NEW."id"
        )
        ORDER BY source."id"
        FOR UPDATE;

        PERFORM 1
        FROM "photo_assets" photo
        WHERE (
            (
                photo."kind" = 'QC'::"photo_asset_kind"
                AND photo."scope_kind" = 'JOB'::"photo_scope_kind"
                AND EXISTS (
                    SELECT 1
                    FROM "jobs" job
                    WHERE job."order_id" = NEW."id"
                      AND job."qc_photo_asset_id" = photo."id"
                      AND photo."scope_id" = job."id"
                )
            )
            OR (
                photo."kind" = 'QUOTE_REFERENCE'::"photo_asset_kind"
                AND photo."scope_kind" = 'QUOTE_REQUEST'::"photo_scope_kind"
                AND EXISTS (
                    SELECT 1
                    FROM "individual_order_origins" origin
                    JOIN "quotes" quote ON quote."id" = origin."quote_id"
                    WHERE origin."order_id" = NEW."id"
                      AND photo."scope_id" = quote."quote_request_id"
                )
            )
        )
        ORDER BY photo."id"
        FOR UPDATE OF photo;

        UPDATE "model_files" source
        SET "source_delete_after" = greatest(
                source."source_delete_after",
                terminal_at + make_interval(days => source."source_retention_days")
            ),
            "retention_hold" = CASE
                WHEN source."retention_hold" IN ('ACTIVE_CLAIM', 'LEGAL') THEN source."retention_hold"
                WHEN EXISTS (
                    SELECT 1
                    FROM "order_items" other_item
                    JOIN "orders" other_order ON other_order."id" = other_item."order_id"
                    WHERE other_item."source_model_file_id" = source."id"
                      AND other_order."id" <> NEW."id"
                      AND (
                          other_order."status" IN (
                              'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED',
                              'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'
                          )
                          OR (
                              other_order."status" = 'CANCELLED'
                              AND EXISTS (
                                  SELECT 1
                                  FROM "payments" other_payment
                                  WHERE other_payment."order_id" = other_order."id"
                                    AND coalesce(other_payment."captured_amount_minor", 0) > 0
                              )
                          )
                      )
                ) THEN 'ACTIVE_ORDER'::"retention_hold"
                ELSE 'NONE'::"retention_hold"
            END
        FROM "order_items" item
        WHERE item."order_id" = NEW."id"
          AND source."id" = item."source_model_file_id";

        UPDATE "photo_assets" photo
            SET "photo_delete_after" = greatest(
                photo."photo_delete_after",
                terminal_at + make_interval(days => photo."retention_days")
            ),
            "retention_hold" = CASE
                WHEN photo."retention_hold" IN ('ACTIVE_CLAIM', 'LEGAL') THEN photo."retention_hold"
                WHEN photo."kind" = 'QUOTE_REFERENCE'::"photo_asset_kind"
                     AND photo."scope_kind" = 'QUOTE_REQUEST'::"photo_scope_kind"
                     AND EXISTS (
                         SELECT 1
                         FROM "individual_order_origins" other_origin
                         JOIN "quotes" other_quote ON other_quote."id" = other_origin."quote_id"
                         JOIN "orders" other_order ON other_order."id" = other_origin."order_id"
                         WHERE other_quote."quote_request_id" = photo."scope_id"
                           AND other_order."id" <> NEW."id"
                           AND (
                               other_order."status" IN (
                                   'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED',
                                   'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'
                               )
                               OR (
                                   other_order."status" = 'CANCELLED'
                                   AND EXISTS (
                                       SELECT 1
                                       FROM "payments" other_payment
                                       WHERE other_payment."order_id" = other_order."id"
                                         AND coalesce(other_payment."captured_amount_minor", 0) > 0
                                   )
                               )
                           )
                     ) THEN 'ACTIVE_ORDER'::"retention_hold"
                ELSE 'NONE'::"retention_hold"
            END
        WHERE (
            (
                photo."kind" = 'QC'::"photo_asset_kind"
                AND photo."scope_kind" = 'JOB'::"photo_scope_kind"
                AND EXISTS (
                    SELECT 1
                    FROM "jobs" job
                    WHERE job."order_id" = NEW."id"
                      AND job."qc_photo_asset_id" = photo."id"
                      AND photo."scope_id" = job."id"
                )
            )
            OR (
                photo."kind" = 'QUOTE_REFERENCE'::"photo_asset_kind"
                AND photo."scope_kind" = 'QUOTE_REQUEST'::"photo_scope_kind"
                AND EXISTS (
                    SELECT 1
                    FROM "individual_order_origins" origin
                    JOIN "quotes" quote ON quote."id" = origin."quote_id"
                    WHERE origin."order_id" = NEW."id"
                      AND photo."scope_id" = quote."quote_request_id"
                )
            )
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "orders_hold_confirmed_sources"
AFTER UPDATE OF "status" ON "orders"
FOR EACH ROW EXECUTE FUNCTION taven_hold_confirmed_order_sources();

CREATE FUNCTION taven_protect_order_phase_topology()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'order phases are stable topology and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_topology_immutable_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."kind" IS DISTINCT FROM OLD."kind" THEN
        RAISE EXCEPTION 'order phase identity, parent, and kind are stable topology'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_topology_immutable_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_phases_topology_protected"
BEFORE UPDATE OR DELETE ON "order_phases"
FOR EACH ROW EXECUTE FUNCTION taven_protect_order_phase_topology();

CREATE FUNCTION taven_prevent_shipment_plan_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_status "order_status";
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM taven_lock_automatic_order_session(NEW."order_id");

        SELECT "status"
        INTO target_order_status
        FROM "orders"
        WHERE "id" = NEW."order_id"
        FOR UPDATE;

        IF EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = NEW."order_id") THEN
            RAISE EXCEPTION 'shipment plans cannot be added after payment intent creation'
                USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_payment_guard';
        END IF;

        IF target_order_status IS DISTINCT FROM 'DRAFT'::"order_status" THEN
            RAISE EXCEPTION 'shipment plans can be added only while the order is draft'
                USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_order_status_guard';
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'shipment plans are insert-only topology'
        USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_insert_only_check';
END;
$$;

CREATE TRIGGER "shipment_plans_insert_only"
BEFORE INSERT OR UPDATE OR DELETE ON "shipment_plans"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_shipment_plan_mutation();

CREATE FUNCTION taven_validate_shipment_plan_fulfilment_slot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    SELECT plan."order_id"
    INTO target_order_id
    FROM "shipment_plans" plan
    WHERE plan."id" = NEW."shipment_plan_id";

    IF target_order_id IS NOT NULL THEN
        PERFORM taven_lock_automatic_order_session(target_order_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "shipment_plans" plan
        JOIN "fulfilment_slots" slot
          ON slot."id" = NEW."fulfilment_slot_id"
        WHERE plan."id" = NEW."shipment_plan_id"
          AND plan."order_price_binding_id" = NEW."order_price_binding_id"
          AND slot."order_id" = plan."order_id"
          AND slot."order_phase_id" = plan."order_phase_id"
    ) THEN
        RAISE EXCEPTION 'shipment plan allocation must use a slot from the same order and phase'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_slot_scope_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "shipment_plan_fulfilment_slots_scope"
BEFORE INSERT ON "shipment_plan_fulfilment_slots"
FOR EACH ROW EXECUTE FUNCTION taven_validate_shipment_plan_fulfilment_slot();
CREATE TRIGGER "shipment_plan_fulfilment_slots_immutable"
BEFORE UPDATE OR DELETE ON "shipment_plan_fulfilment_slots"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();

CREATE FUNCTION taven_protect_fulfilment_slot_topology()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW."order_id" ELSE OLD."order_id" END;
    target_order_status "order_status";
BEGIN
    IF TG_OP = 'INSERT'
       OR (TG_OP = 'UPDATE'
           AND NEW."settlement_amount_minor" IS DISTINCT FROM OLD."settlement_amount_minor") THEN
        PERFORM taven_lock_automatic_order_session(target_order_id);
    END IF;

    SELECT "status" INTO target_order_status
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    IF TG_OP = 'INSERT' THEN
        IF target_order_status IS DISTINCT FROM 'DRAFT'::"order_status" THEN
            RAISE EXCEPTION 'fulfilment slots can be inserted only while the order is draft'
                USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_topology_immutable_check';
        END IF;

        IF NEW."outcome" <> 'PENDING' THEN
            RAISE EXCEPTION 'new fulfilment slots must begin pending'
                USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_initial_outcome_check';
        END IF;

        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'fulfilment slots are stable topology and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_topology_immutable_check';
    END IF;

    IF (to_jsonb(NEW) - 'outcome' - 'updated_at' - 'settlement_amount_minor')
       IS DISTINCT FROM (to_jsonb(OLD) - 'outcome' - 'updated_at' - 'settlement_amount_minor') THEN
        RAISE EXCEPTION 'fulfilment slot identity and packing topology cannot be changed'
            USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_topology_immutable_check';
    END IF;

    IF NEW."settlement_amount_minor" IS DISTINCT FROM OLD."settlement_amount_minor"
       AND EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = OLD."order_id") THEN
        RAISE EXCEPTION 'fulfilment slot settlement cannot change after payment intent creation'
            USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_settlement_payment_guard';
    END IF;

    IF NEW."outcome" IS DISTINCT FROM OLD."outcome"
       AND NOT (
           (OLD."outcome" = 'PENDING'
            AND NEW."outcome" IN ('DELIVERED', 'CANCELLED', 'CANCELLED_REFUNDED'))
           OR (OLD."outcome" = 'CANCELLED'
               AND NEW."outcome" = 'CANCELLED_REFUNDED')
       ) THEN
        RAISE EXCEPTION 'fulfilment slot outcome is terminal once recorded'
            USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_outcome_transition_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "fulfilment_slots_topology_protected"
BEFORE INSERT OR UPDATE OR DELETE ON "fulfilment_slots"
FOR EACH ROW EXECUTE FUNCTION taven_protect_fulfilment_slot_topology();

CREATE FUNCTION taven_protect_shipment_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF (NEW."label_created_at" IS NOT NULL
        AND NEW."label_created_at" > evidence_now + interval '5 seconds')
       OR (NEW."handed_over_at" IS NOT NULL
           AND NEW."handed_over_at" > evidence_now + interval '5 seconds')
       OR (NEW."delivered_at" IS NOT NULL
           AND NEW."delivered_at" > evidence_now + interval '5 seconds')
       OR (NEW."cancelled_at" IS NOT NULL
           AND NEW."cancelled_at" > evidence_now + interval '5 seconds') THEN
        RAISE EXCEPTION 'Shipment lifecycle evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_evidence_check';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'PLANNED'
           OR NEW."carrier" IS NOT NULL
           OR NEW."provider_shipment_id" IS NOT NULL
           OR NEW."tracking_code" IS NOT NULL
           OR NEW."label_created_at" IS NOT NULL
           OR NEW."handed_over_at" IS NOT NULL
           OR NEW."delivered_at" IS NOT NULL
           OR NEW."cancelled_at" IS NOT NULL THEN
            RAISE EXCEPTION 'new Shipments must begin planned without provider lifecycle evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'shipment_initial_status_check';
        END IF;
        RETURN NEW;
    END IF;

    IF (OLD."carrier" IS NOT NULL AND NEW."carrier" IS DISTINCT FROM OLD."carrier")
       OR (OLD."provider_shipment_id" IS NOT NULL AND NEW."provider_shipment_id" IS DISTINCT FROM OLD."provider_shipment_id")
       OR (OLD."tracking_code" IS NOT NULL AND NEW."tracking_code" IS DISTINCT FROM OLD."tracking_code")
       OR (OLD."label_created_at" IS NOT NULL AND NEW."label_created_at" IS DISTINCT FROM OLD."label_created_at")
       OR (OLD."handed_over_at" IS NOT NULL AND NEW."handed_over_at" IS DISTINCT FROM OLD."handed_over_at")
       OR (OLD."delivered_at" IS NOT NULL AND NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at")
       OR (OLD."cancelled_at" IS NOT NULL AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at") THEN
        RAISE EXCEPTION 'Shipment provider identity and lifecycle evidence are immutable after assignment'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_immutable_check';
    END IF;

    IF NEW."status" IS NOT DISTINCT FROM OLD."status"
       AND (
           NEW."carrier" IS DISTINCT FROM OLD."carrier"
           OR NEW."provider_shipment_id" IS DISTINCT FROM OLD."provider_shipment_id"
           OR NEW."tracking_code" IS DISTINCT FROM OLD."tracking_code"
           OR NEW."label_created_at" IS DISTINCT FROM OLD."label_created_at"
           OR NEW."handed_over_at" IS DISTINCT FROM OLD."handed_over_at"
           OR NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
           OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
       ) THEN
        RAISE EXCEPTION 'Shipment lifecycle evidence must be assigned with its status transition'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_evidence_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'PLANNED' AND NEW."status" IN ('LABEL_CREATED', 'CANCELLED'))
           OR (OLD."status" = 'LABEL_CREATED' AND NEW."status" IN ('HANDED_OVER', 'CANCELLED'))
           OR (OLD."status" = 'HANDED_OVER' AND NEW."status" IN ('IN_TRANSIT', 'DELIVERED'))
           OR (OLD."status" = 'IN_TRANSIT' AND NEW."status" = 'DELIVERED')
       ) THEN
        RAISE EXCEPTION 'Shipment status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_status_transition_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'PLANNED' AND NEW."status" = 'LABEL_CREATED'
            AND NEW."carrier" IS DISTINCT FROM OLD."carrier"
            AND NEW."provider_shipment_id" IS DISTINCT FROM OLD."provider_shipment_id"
            AND NEW."label_created_at" IS DISTINCT FROM OLD."label_created_at"
            AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
            AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
            AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'LABEL_CREATED' AND NEW."status" = 'HANDED_OVER'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."handed_over_at" IS DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'HANDED_OVER' AND NEW."status" = 'IN_TRANSIT'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" IN ('HANDED_OVER', 'IN_TRANSIT') AND NEW."status" = 'DELIVERED'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (NEW."status" = 'CANCELLED'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at")
       ) THEN
        RAISE EXCEPTION 'Shipment transition may assign only its own lifecycle evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_evidence_check';
    END IF;

    IF (NEW."status" IN ('LABEL_CREATED', 'HANDED_OVER', 'IN_TRANSIT', 'DELIVERED')
        AND (
            NEW."carrier" IS NULL
            OR NEW."carrier" !~ '[^[:space:]]'
            OR NEW."provider_shipment_id" IS NULL
            OR NEW."provider_shipment_id" !~ '[^[:space:]]'
            OR NEW."label_created_at" IS NULL
        ))
       OR (NEW."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED')
           AND NEW."handed_over_at" IS NULL)
       OR (NEW."status" = 'DELIVERED' AND NEW."delivered_at" IS NULL)
       OR (NEW."status" = 'CANCELLED' AND NEW."cancelled_at" IS NULL) THEN
        RAISE EXCEPTION 'Shipment lifecycle state requires its complete provider evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_evidence_check';
    END IF;

    IF (NEW."label_created_at" IS NOT NULL AND NEW."handed_over_at" IS NOT NULL
        AND NEW."handed_over_at" < NEW."label_created_at")
       OR (NEW."handed_over_at" IS NOT NULL AND NEW."delivered_at" IS NOT NULL
           AND NEW."delivered_at" < NEW."handed_over_at")
       OR (NEW."cancelled_at" IS NOT NULL AND NEW."label_created_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."label_created_at") THEN
        RAISE EXCEPTION 'Shipment lifecycle timestamps must be chronological'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_evidence_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "shipments_lifecycle_protected"
BEFORE INSERT OR UPDATE ON "shipments"
FOR EACH ROW EXECUTE FUNCTION taven_protect_shipment_lifecycle();

CREATE FUNCTION taven_protect_shipment_topology()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'shipments are stable operational history and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_topology_immutable_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."order_phase_id" IS DISTINCT FROM OLD."order_phase_id"
       OR NEW."shipment_plan_id" IS DISTINCT FROM OLD."shipment_plan_id"
       OR NEW."delivery_destination_id" IS DISTINCT FROM OLD."delivery_destination_id"
       OR NEW."replaces_shipment_id" IS DISTINCT FROM OLD."replaces_shipment_id" THEN
        RAISE EXCEPTION 'shipment identity, creation time, topology, and replacement lineage cannot be changed'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_topology_immutable_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "shipments_topology_protected"
BEFORE UPDATE OR DELETE ON "shipments"
FOR EACH ROW EXECUTE FUNCTION taven_protect_shipment_topology();

CREATE FUNCTION taven_require_payment_fulfilment_topology()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    quoted_phase_count integer;
BEGIN
    IF NEW."status" NOT IN ('CREATED', 'PENDING') THEN
        RAISE EXCEPTION 'new payments must begin in a pre-capture state'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_initial_status_check';
    END IF;

    IF NOT NEW."capture_authorized"
       OR NEW."capture_cutoff_at" IS NOT NULL
       OR (NEW."role" = 'FULL' AND (
           NEW."checkout_capture_expires_at" IS NULL
           OR NEW."checkout_capture_expires_at" <= clock_timestamp()
       )) THEN
        RAISE EXCEPTION 'new payment capture intent requires an open authorization window'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
    END IF;

    PERFORM taven_lock_automatic_order_session(NEW."order_id");

    PERFORM 1
    FROM "orders"
    WHERE "id" = NEW."order_id"
    FOR UPDATE;

    SELECT count(*) INTO quoted_phase_count
    FROM "order_phases"
    WHERE "order_id" = NEW."order_id"
      AND "kind" = 'SINGLE'
      AND "status" = 'QUOTED';

    IF quoted_phase_count <> 1 THEN
        RAISE EXCEPTION 'payment requires exactly one quoted single phase'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_fulfilment_topology_check';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "order_active_price_bindings" active ON active."order_id" = target_order."id"
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
        WHERE target_order."id" = NEW."order_id"
          AND target_order."status" = 'QUOTED'
          AND target_order."customer_id" IS NOT NULL
          AND binding."id" = NEW."order_price_binding_id"
          AND binding."price_snapshot_id" = NEW."price_snapshot_id"
          AND binding."invalidated_at" IS NULL
    ) THEN
        RAISE EXCEPTION 'payment requires the active destination-bound price binding and a customer'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_fulfilment_topology_check';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM "order_items" WHERE "order_id" = NEW."order_id")
       OR NOT EXISTS (
           SELECT 1
           FROM "shipment_plans" plan
           JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
           JOIN "order_price_bindings" binding
             ON binding."id" = plan."order_price_binding_id"
           WHERE plan."order_id" = NEW."order_id"
             AND phase."kind" = 'SINGLE'
             AND phase."status" = 'QUOTED'
             AND plan."delivery_destination_id" = binding."delivery_destination_id"
             AND binding."id" = NEW."order_price_binding_id"
       )
       OR NOT EXISTS (
           SELECT 1
           FROM "fulfilment_slots" slot
           WHERE slot."order_id" = NEW."order_id"
       ) THEN
        RAISE EXCEPTION 'payment requires order items, shipment plans, and fulfilment slots'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_fulfilment_topology_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "order_items" item
        LEFT JOIN "fulfilment_slots" slot
          ON slot."order_item_id" = item."id"
        WHERE item."order_id" = NEW."order_id"
        GROUP BY item."id", item."quantity"
        HAVING count(slot."id") <> item."quantity"
            OR coalesce(min(slot."quantity_ordinal"), 0) <> 1
            OR coalesce(max(slot."quantity_ordinal"), 0) <> item."quantity"
            OR bool_or(slot."quantity_ordinal" < 1 OR slot."quantity_ordinal" > item."quantity")
    ) THEN
        RAISE EXCEPTION 'each order item requires one in-range fulfilment slot per unit'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_fulfilment_topology_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "fulfilment_slots" slot
        WHERE slot."order_id" = NEW."order_id"
          AND NOT EXISTS (
              SELECT 1
              FROM "shipment_plan_fulfilment_slots" allocation
              WHERE allocation."fulfilment_slot_id" = slot."id"
                AND allocation."order_price_binding_id" = NEW."order_price_binding_id"
          )
    ) THEN
        RAISE EXCEPTION 'active price binding must allocate every stable fulfilment slot exactly once'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_fulfilment_topology_check';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "phase_resource_plans" resource_plan
        WHERE resource_plan."order_phase_id" = (
            SELECT "id" FROM "order_phases"
            WHERE "order_id" = NEW."order_id" AND "kind" = 'SINGLE' AND "status" = 'QUOTED'
        )
          AND resource_plan."expires_at" > clock_timestamp()
          AND EXISTS (
              SELECT 1
              FROM "phase_reservation_sets" reservation_set
              WHERE reservation_set."phase_resource_plan_id" = resource_plan."id"
                AND reservation_set."node_id" = resource_plan."node_id"
                AND reservation_set."status" IN ('RESERVED', 'HELD')
                AND reservation_set."expires_at" > clock_timestamp()
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              JOIN "candidate_resource_estimates" candidate
                ON candidate."id" = plan_job."candidate_resource_estimate_id"
               AND candidate."node_id" = plan_job."node_id"
              JOIN "shipment_plans" candidate_plan
                ON candidate_plan."id" = candidate."shipment_plan_id"
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
                AND candidate_plan."order_price_binding_id" IS DISTINCT FROM NEW."order_price_binding_id"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "fulfilment_slots" slot
              WHERE slot."order_id" = NEW."order_id"
                AND NOT EXISTS (
                    SELECT 1
                    FROM "phase_resource_plan_slots" resource_slot
                    WHERE resource_slot."phase_resource_plan_id" = resource_plan."id"
                      AND resource_slot."fulfilment_slot_id" = slot."id"
                )
          )
    ) THEN
        RAISE EXCEPTION 'payment requires a current complete phase resource plan for every fulfilment slot'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_fulfilment_topology_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "shipment_plans" plan
        WHERE plan."order_id" = NEW."order_id"
          AND plan."order_price_binding_id" = NEW."order_price_binding_id"
          AND NOT EXISTS (
              SELECT 1 FROM "shipment_plan_fulfilment_slots" allocation
              WHERE allocation."shipment_plan_id" = plan."id"
                AND allocation."order_price_binding_id" = NEW."order_price_binding_id"
          )
    ) THEN
        RAISE EXCEPTION 'every shipment plan requires at least one fulfilment slot'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_fulfilment_topology_check';
    END IF;

    PERFORM taven_assert_order_fulfilment_money(NEW."order_id");

    RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_require_fulfilment_topology"
BEFORE INSERT ON "payments"
FOR EACH ROW EXECUTE FUNCTION taven_require_payment_fulfilment_topology();

CREATE FUNCTION taven_protect_payment_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'payment transactions are append-only financial history'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_identity_immutable_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'CREATED' AND NEW."status" IN ('PENDING', 'VOIDED'))
           OR (OLD."status" = 'PENDING' AND NEW."status" IN ('CAPTURED', 'FAILED', 'VOIDED', 'REFUND_PENDING'))
           OR (OLD."status" = 'CAPTURED' AND NEW."status" = 'REFUND_PENDING')
           OR (OLD."status" = 'VOIDED' AND NEW."status" = 'REFUND_PENDING')
           OR (OLD."status" = 'REFUND_PENDING' AND NEW."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'))
           OR (OLD."status" = 'PARTIALLY_REFUNDED' AND NEW."status" IN ('REFUND_PENDING', 'REFUNDED'))
       ) THEN
        RAISE EXCEPTION 'payment status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_status_transition_check';
    END IF;

    IF OLD."status" IN ('PENDING', 'REFUND_PENDING')
       AND NEW."status" = 'CAPTURED' THEN
        PERFORM taven_lock_automatic_order_session(NEW."order_id");

        PERFORM 1
        FROM "orders"
        WHERE "id" = NEW."order_id"
        FOR UPDATE;

        IF OLD."status" = 'PENDING'
           AND (NOT NEW."capture_authorized"
           OR NEW."capture_cutoff_at" IS NOT NULL
           OR (NEW."role" = 'FULL' AND (
               NEW."checkout_capture_expires_at" IS NULL
               OR NEW."checkout_capture_expires_at" <= clock_timestamp()
           ))) THEN
            RAISE EXCEPTION 'ordinary payment capture requires an open authorization window'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
        END IF;
    END IF;

    IF NEW."capture_authorized" IS DISTINCT FROM (NEW."capture_cutoff_at" IS NULL) THEN
        RAISE EXCEPTION 'payment capture authorization and cutoff must change atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
    END IF;

    IF NEW."status" IN ('FAILED', 'VOIDED')
       AND (NEW."capture_authorized" OR NEW."capture_cutoff_at" IS NULL) THEN
        RAISE EXCEPTION 'failed or voided payment requires a closed authorization window'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."price_snapshot_id" IS DISTINCT FROM OLD."price_snapshot_id"
       OR NEW."order_price_binding_id" IS DISTINCT FROM OLD."order_price_binding_id"
       OR NEW."payment_schedule_id" IS DISTINCT FROM OLD."payment_schedule_id"
       OR NEW."role" IS DISTINCT FROM OLD."role"
       OR NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."requested_amount_minor" IS DISTINCT FROM OLD."requested_amount_minor"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."checkout_capture_expires_at" IS DISTINCT FROM OLD."checkout_capture_expires_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR (
           OLD."captured_amount_minor" IS NOT NULL
           AND NEW."captured_amount_minor" IS DISTINCT FROM OLD."captured_amount_minor"
       )
       OR (
           OLD."captured_at" IS NOT NULL
           AND NEW."captured_at" IS DISTINCT FROM OLD."captured_at"
       )
       OR (
           NOT OLD."capture_authorized"
           AND NEW."capture_authorized"
       )
       OR (
           OLD."capture_cutoff_at" IS NOT NULL
           AND NEW."capture_cutoff_at" IS DISTINCT FROM OLD."capture_cutoff_at"
       )
       OR (
           OLD."provider_intent_id" IS NOT NULL
           AND NEW."provider_intent_id" IS DISTINCT FROM OLD."provider_intent_id"
       )
       OR (
           OLD."provider_capture_id" IS NOT NULL
           AND NEW."provider_capture_id" IS DISTINCT FROM OLD."provider_capture_id"
       ) THEN
        RAISE EXCEPTION 'payment financial identity is immutable after assignment'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_identity_immutable_check';
    END IF;

    IF NEW."captured_at" IS NOT NULL
       AND NEW."captured_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'payment capture evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_evidence_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_identity_protected"
BEFORE UPDATE OR DELETE ON "payments"
FOR EACH ROW EXECUTE FUNCTION taven_protect_payment_identity();

CREATE FUNCTION taven_reconcile_quoted_payment_void_closure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_status "order_status";
BEGIN
    SELECT "status"
    INTO target_order_status
    FROM "orders"
    WHERE "id" = NEW."order_id"
    FOR UPDATE;

    IF target_order_status NOT IN ('EXPIRED', 'CANCELLED') THEN
        RAISE EXCEPTION 'voided quoted checkout payment requires atomic order closure'
            USING ERRCODE = '23514', CONSTRAINT = 'quoted_payment_void_closure_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_quoted_void_closure_reconciled"
AFTER UPDATE OF "status" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" IN ('CREATED', 'PENDING') AND NEW."status" = 'VOIDED' AND NEW."role" = 'FULL')
EXECUTE FUNCTION taven_reconcile_quoted_payment_void_closure();

CREATE FUNCTION taven_validate_payment_refund_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_payment_id uuid;
    payment_status "payment_status";
    captured_amount bigint;
    succeeded_refunds bigint;
    pending_refunds bigint;
BEGIN
    target_payment_id := CASE
        WHEN TG_TABLE_NAME = 'payments' THEN (to_jsonb(NEW) ->> 'id')::uuid
        ELSE (to_jsonb(NEW) ->> 'payment_id')::uuid
    END;

    SELECT "status", "captured_amount_minor"
    INTO payment_status, captured_amount
    FROM "payments"
    WHERE "id" = target_payment_id
    FOR UPDATE;

    SELECT coalesce(sum("amount_minor") FILTER (WHERE "status" = 'SUCCEEDED'), 0),
           count(*) FILTER (WHERE "status" = 'PENDING')
    INTO succeeded_refunds, pending_refunds
    FROM "refund_transactions"
    WHERE "payment_id" = target_payment_id;

    IF (payment_status = 'REFUND_PENDING') IS DISTINCT FROM (pending_refunds > 0) THEN
        RAISE EXCEPTION 'refund-pending payment and pending refund work must be persisted atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_status_reconciliation_check';
    ELSIF payment_status IN ('CREATED', 'PENDING', 'FAILED', 'VOIDED', 'CAPTURED')
       AND succeeded_refunds <> 0 THEN
        RAISE EXCEPTION 'payment status cannot hide successful refunds'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_status_reconciliation_check';
    ELSIF payment_status = 'REFUND_PENDING'
          AND (captured_amount IS NULL OR succeeded_refunds >= captured_amount) THEN
        RAISE EXCEPTION 'refund-pending payment must remain below its captured amount'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_status_reconciliation_check';
    ELSIF payment_status = 'PARTIALLY_REFUNDED'
          AND (captured_amount IS NULL OR succeeded_refunds <= 0 OR succeeded_refunds >= captured_amount) THEN
        RAISE EXCEPTION 'partially refunded payment requires a positive refund below its capture'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_status_reconciliation_check';
    ELSIF payment_status = 'REFUNDED'
          AND (captured_amount IS NULL OR succeeded_refunds <> captured_amount) THEN
        RAISE EXCEPTION 'refunded payment requires successful refunds equal to its capture'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_status_reconciliation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_refund_status_reconciled"
AFTER INSERT OR UPDATE OF "status", "captured_amount_minor" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_payment_refund_status();
CREATE CONSTRAINT TRIGGER "refund_transactions_payment_status_reconciled"
AFTER INSERT OR UPDATE OF "payment_id", "amount_minor", "status" ON "refund_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_payment_refund_status();

CREATE FUNCTION taven_reconcile_customer_cancellation_refund_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_order_status "order_status";
    has_failed_job boolean;
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        target_order_id := NEW."id";
    ELSIF TG_TABLE_NAME = 'payments' THEN
        target_order_id := NEW."order_id";
    ELSE
        SELECT payment."order_id"
        INTO target_order_id
        FROM "payments" payment
        WHERE payment."id" = NEW."payment_id";
    END IF;

    SELECT target_order."status"
    INTO target_order_status
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    SELECT EXISTS (
        SELECT 1
        FROM "jobs" job
        WHERE job."order_id" = target_order_id
          AND job."status" IN ('FAILED', 'QC_REJECTED')
    )
    INTO has_failed_job;

    IF target_order_status NOT IN ('CANCELLED', 'REFUNDED')
       AND EXISTS (
           SELECT 1
           FROM "payments" payment
           JOIN "refund_transactions" refund
             ON refund."payment_id" = payment."id"
           WHERE payment."order_id" = target_order_id
             AND refund."reason" = 'CUSTOMER_CANCELLATION'
             AND refund."status" IN ('PENDING', 'SUCCEEDED')
       ) THEN
        RAISE EXCEPTION 'customer-cancellation refund requires a cancelled order lifecycle'
            USING ERRCODE = '23514', CONSTRAINT = 'order_customer_cancellation_refund_lifecycle_check';
    END IF;

    IF target_order_status = 'CANCELLED'
       AND NOT has_failed_job
       AND EXISTS (
           SELECT 1
           FROM "payments" payment
           CROSS JOIN LATERAL (
               SELECT coalesce(sum(refund."amount_minor") FILTER (
                          WHERE refund."status" = 'SUCCEEDED'
                      ), 0) AS succeeded_total,
                      coalesce(sum(refund."amount_minor") FILTER (
                          WHERE refund."reason" = 'CUSTOMER_CANCELLATION'
                            AND refund."status" = 'PENDING'
                      ), 0) AS customer_cancellation_pending
               FROM "refund_transactions" refund
               WHERE refund."payment_id" = payment."id"
           ) refund_totals
           WHERE payment."order_id" = target_order_id
             AND payment."captured_amount_minor" IS NOT NULL
             AND NOT (
                 NOT payment."capture_authorized"
                 AND payment."capture_cutoff_at" IS NOT NULL
                 AND payment."captured_at" IS NOT NULL
                 AND payment."captured_at" >= payment."capture_cutoff_at"
             )
             AND NOT (
                 (
                     payment."captured_amount_minor"
                       - refund_totals.succeeded_total = 0
                     AND payment."status" = 'REFUNDED'
                 )
                 OR (
                     payment."captured_amount_minor"
                       - refund_totals.succeeded_total > 0
                     AND refund_totals.customer_cancellation_pending
                       = payment."captured_amount_minor"
                         - refund_totals.succeeded_total
                     AND payment."status" = 'REFUND_PENDING'
                 )
             )
       ) THEN
        RAISE EXCEPTION 'ordinary cancelled orders require complete customer-cancellation refund work for every captured payment'
            USING ERRCODE = '23514', CONSTRAINT = 'order_customer_cancellation_refund_obligation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_customer_cancellation_refund_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_customer_cancellation_refund_order();
CREATE CONSTRAINT TRIGGER "payments_customer_cancellation_refund_reconciled"
AFTER UPDATE OF "status", "captured_amount_minor", "capture_authorized", "capture_cutoff_at", "captured_at" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_customer_cancellation_refund_order();
CREATE CONSTRAINT TRIGGER "refunds_customer_cancellation_order_reconciled"
AFTER INSERT OR UPDATE OF "payment_id", "amount_minor", "reason", "status" ON "refund_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_customer_cancellation_refund_order();
CREATE FUNCTION taven_reconcile_production_failure_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_order_status "order_status";
    has_failed_job boolean;
    has_production_failure_refund boolean;
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        target_order_id := NEW."id";
    ELSIF TG_TABLE_NAME = 'jobs' OR TG_TABLE_NAME = 'payments' THEN
        target_order_id := NEW."order_id";
    ELSE
        SELECT payment."order_id"
        INTO target_order_id
        FROM "payments" payment
        WHERE payment."id" = NEW."payment_id";
    END IF;

    SELECT target_order."status",
           EXISTS (
               SELECT 1
               FROM "jobs" job
               WHERE job."order_id" = target_order_id
                 AND job."status" IN ('FAILED', 'QC_REJECTED')
           ),
           EXISTS (
               SELECT 1
               FROM "payments" payment
               JOIN "refund_transactions" refund
                 ON refund."payment_id" = payment."id"
               WHERE payment."order_id" = target_order_id
                 AND refund."reason" = 'PRODUCTION_FAILURE'
           )
    INTO target_order_status, has_failed_job, has_production_failure_refund
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    IF has_failed_job AND (
        target_order_status NOT IN ('CANCELLED', 'REFUNDED')
        OR EXISTS (
            SELECT 1
            FROM "payments" payment
            CROSS JOIN LATERAL (
                SELECT coalesce(sum(refund."amount_minor") FILTER (
                           WHERE refund."status" = 'SUCCEEDED'
                       ), 0) AS succeeded_total,
                       coalesce(sum(refund."amount_minor") FILTER (
                           WHERE refund."reason" = 'PRODUCTION_FAILURE'
                             AND refund."status" = 'PENDING'
                       ), 0) AS production_pending
                FROM "refund_transactions" refund
                WHERE refund."payment_id" = payment."id"
            ) refund_totals
            LEFT JOIN LATERAL (
                SELECT refund."amount_minor", refund."status"
                FROM "refund_transactions" refund
                WHERE refund."payment_id" = payment."id"
                  AND refund."reason" = 'PRODUCTION_FAILURE'
                ORDER BY refund."requested_at" DESC,
                         refund."created_at" DESC,
                         refund."id" DESC
                LIMIT 1
            ) latest_production_refund ON true
            WHERE payment."order_id" = target_order_id
              AND payment."captured_amount_minor" IS NOT NULL
              AND NOT (
                  (
                      payment."captured_amount_minor"
                        - refund_totals.succeeded_total = 0
                      AND payment."status" = 'REFUNDED'
                  )
                  OR (
                      payment."captured_amount_minor"
                        - refund_totals.succeeded_total > 0
                      AND (
                          (
                              refund_totals.production_pending
                                = payment."captured_amount_minor"
                                  - refund_totals.succeeded_total
                              AND payment."status" = 'REFUND_PENDING'
                          )
                          OR (
                              refund_totals.production_pending = 0
                              AND latest_production_refund."status" = 'FAILED'
                              AND latest_production_refund."amount_minor"
                                = payment."captured_amount_minor"
                                  - refund_totals.succeeded_total
                              AND payment."status" = CASE
                                  WHEN refund_totals.succeeded_total = 0
                                      THEN 'CAPTURED'::"payment_status"
                                  ELSE 'PARTIALLY_REFUNDED'::"payment_status"
                              END
                          )
                      )
                  )
              )
        )
    ) THEN
        RAISE EXCEPTION 'failed production must cancel the order and retain a complete production-failure refund obligation or attempt'
            USING ERRCODE = '23514', CONSTRAINT = 'job_failure_cancellation_check';
    ELSIF has_production_failure_refund
          AND (NOT has_failed_job OR target_order_status NOT IN ('CANCELLED', 'REFUNDED')) THEN
        RAISE EXCEPTION 'production-failure refunds require retained failure evidence in a cancelled order lifecycle'
            USING ERRCODE = '23514', CONSTRAINT = 'job_failure_cancellation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_production_failure_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_production_failure_cancellation();
CREATE CONSTRAINT TRIGGER "jobs_production_failure_reconciled"
AFTER UPDATE OF "status" ON "jobs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_production_failure_cancellation();
CREATE CONSTRAINT TRIGGER "payments_production_failure_reconciled"
AFTER UPDATE OF "status", "captured_amount_minor" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_production_failure_cancellation();
CREATE CONSTRAINT TRIGGER "refunds_production_failure_reconciled"
AFTER INSERT OR UPDATE OF "payment_id", "amount_minor", "reason", "status" ON "refund_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_production_failure_cancellation();

CREATE FUNCTION taven_validate_payment_capture_against_refunds()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    committed_refunds bigint;
BEGIN
    SELECT coalesce(sum("amount_minor"), 0)
    INTO committed_refunds
    FROM "refund_transactions"
    WHERE "payment_id" = NEW."id"
      AND "status" IN ('PENDING', 'SUCCEEDED');

    IF committed_refunds > coalesce(NEW."captured_amount_minor", 0) THEN
        RAISE EXCEPTION 'captured payment amount cannot fall below committed refunds'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_captured_refund_floor_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_capture_refund_floor"
BEFORE UPDATE OF "captured_amount_minor" ON "payments"
FOR EACH ROW EXECUTE FUNCTION taven_validate_payment_capture_against_refunds();

CREATE FUNCTION taven_assign_refund_provider_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    payment_provider varchar(100);
BEGIN
    SELECT provider
    INTO payment_provider
    FROM "payments"
    WHERE id = NEW."payment_id";

    IF TG_OP = 'INSERT' THEN
        IF NEW."provider" IS NOT NULL
           AND NEW."provider" IS DISTINCT FROM payment_provider THEN
            RAISE EXCEPTION 'refund provider must match its payment provider'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_transactions_provider_identity_check';
        END IF;
        NEW."provider" := payment_provider;
    ELSIF NEW."payment_id" IS DISTINCT FROM OLD."payment_id" THEN
        NEW."provider" := payment_provider;
    ELSIF NEW."provider" IS DISTINCT FROM OLD."provider" THEN
        RAISE EXCEPTION 'refund provider identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_transactions_provider_identity_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "refund_transactions_provider_identity"
BEFORE INSERT OR UPDATE OF "payment_id", "provider" ON "refund_transactions"
FOR EACH ROW EXECUTE FUNCTION taven_assign_refund_provider_identity();

CREATE FUNCTION taven_protect_refund_transaction_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'refund transactions are append-only financial history'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_transaction_append_only_check';
    END IF;

    IF OLD."status" = 'SUCCEEDED'
       AND NEW."status" IS DISTINCT FROM OLD."status" THEN
        RAISE EXCEPTION 'successful refund transactions are terminal'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_transaction_succeeded_immutable_check';
    END IF;

    IF OLD."status" = 'FAILED'
       AND NEW."status" IS DISTINCT FROM OLD."status" THEN
        RAISE EXCEPTION 'failed refund transactions are terminal attempts'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_transaction_failed_immutable_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."reason" IS DISTINCT FROM OLD."reason"
       OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR (OLD."completed_at" IS NOT NULL
           AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at")
       OR (OLD."provider_refund_id" IS NOT NULL
           AND NEW."provider_refund_id" IS DISTINCT FROM OLD."provider_refund_id") THEN
        RAISE EXCEPTION 'refund transaction financial identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_transaction_identity_immutable_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "refund_transactions_identity_protected"
BEFORE UPDATE OR DELETE ON "refund_transactions"
FOR EACH ROW EXECUTE FUNCTION taven_protect_refund_transaction_identity();

CREATE FUNCTION taven_validate_refund_against_capture()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    captured_amount bigint;
    committed_refunds bigint;
    payment_capture_authorized boolean;
    payment_capture_cutoff_at timestamptz;
    payment_captured_at timestamptz;
    target_order_status "order_status";
    evidence_now timestamptz := clock_timestamp();
BEGIN
    SELECT payment."captured_amount_minor", payment."capture_authorized",
           payment."capture_cutoff_at", payment."captured_at",
           target_order."status"
    INTO captured_amount, payment_capture_authorized,
         payment_capture_cutoff_at, payment_captured_at, target_order_status
    FROM "payments" payment
    JOIN "orders" target_order ON target_order."id" = payment."order_id"
    WHERE payment."id" = NEW."payment_id"
    FOR UPDATE OF payment;

    IF captured_amount IS NULL OR captured_amount <= 0 THEN
        RAISE EXCEPTION 'refund requires a captured payment'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_captured_payment_check';
    END IF;

    IF NEW."requested_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'refund request evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_request_evidence_check';
    END IF;

    IF NEW."completed_at" IS NOT NULL
       AND NEW."completed_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'refund completion evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_completion_evidence_check';
    END IF;

    IF NEW."requested_at" < payment_captured_at
       OR (NEW."completed_at" IS NOT NULL AND NEW."completed_at" < payment_captured_at) THEN
        RAISE EXCEPTION 'refund evidence cannot predate payment capture'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_capture_timestamp_order_check';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        SELECT coalesce(sum("amount_minor"), 0)
        INTO committed_refunds
        FROM "refund_transactions"
        WHERE "payment_id" = NEW."payment_id"
          AND "status" IN ('PENDING', 'SUCCEEDED')
          AND "id" <> OLD."id";
    ELSE
        SELECT coalesce(sum("amount_minor"), 0)
        INTO committed_refunds
        FROM "refund_transactions"
        WHERE "payment_id" = NEW."payment_id"
          AND "status" IN ('PENDING', 'SUCCEEDED');
    END IF;

    IF NEW."reason" = 'LATE_CAPTURE_COMPENSATION' AND (
        payment_capture_authorized
        OR payment_capture_cutoff_at IS NULL
        OR payment_captured_at IS NULL
        OR payment_captured_at < payment_capture_cutoff_at
        OR target_order_status NOT IN ('EXPIRED', 'CANCELLED')
        OR NEW."amount_minor" <> captured_amount - committed_refunds
    ) THEN
        RAISE EXCEPTION 'late-capture compensation requires the full remaining capture after a terminal checkout cutoff'
            USING ERRCODE = '23514', CONSTRAINT = 'late_capture_compensation_check';
    END IF;

    IF NOT payment_capture_authorized
       AND payment_capture_cutoff_at IS NOT NULL
       AND payment_captured_at >= payment_capture_cutoff_at
       AND target_order_status IN ('EXPIRED', 'CANCELLED')
       AND NEW."reason" <> 'LATE_CAPTURE_COMPENSATION' THEN
        RAISE EXCEPTION 'a capture after a terminal checkout cutoff requires late-capture compensation'
            USING ERRCODE = '23514', CONSTRAINT = 'late_capture_compensation_reason_check';
    END IF;

    IF committed_refunds
       + (CASE WHEN NEW."status" IN ('PENDING', 'SUCCEEDED') THEN NEW."amount_minor" ELSE 0 END)
       > captured_amount THEN
        RAISE EXCEPTION 'refund amount exceeds captured payment amount'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_captured_payment_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "refunds_cannot_exceed_capture"
BEFORE INSERT OR UPDATE OF "payment_id", "amount_minor", "status", "completed_at" ON "refund_transactions"
FOR EACH ROW EXECUTE FUNCTION taven_validate_refund_against_capture();

CREATE FUNCTION taven_reconcile_shipment_plan_slot_terminal_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid := NEW."order_id";
BEGIN
    PERFORM 1
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM "shipments" predecessor
        JOIN "shipments" replacement
          ON replacement."replaces_shipment_id" = predecessor."id"
        WHERE predecessor."order_id" = target_order_id
          AND (predecessor."status" <> 'CANCELLED'
               OR predecessor."cancelled_at" IS NULL)
    ) THEN
        RAISE EXCEPTION 'a replaced Shipment must be terminally cancelled before its successor is attached'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_replacement_predecessor_terminal_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "fulfilment_slots" slot
        WHERE slot."order_id" = target_order_id
          AND slot."outcome" IN ('DELIVERED', 'CANCELLED', 'CANCELLED_REFUNDED')
          AND NOT EXISTS (
              SELECT 1
              FROM "shipment_plan_fulfilment_slots" allocation
              JOIN "shipment_plans" plan
                ON plan."id" = allocation."shipment_plan_id"
               AND plan."order_price_binding_id" = allocation."order_price_binding_id"
              JOIN "order_active_price_bindings" active_binding
                ON active_binding."order_id" = plan."order_id"
               AND active_binding."order_price_binding_id" = plan."order_price_binding_id"
              WHERE allocation."fulfilment_slot_id" = slot."id"
                AND plan."order_id" = slot."order_id"
                AND plan."order_phase_id" = slot."order_phase_id"
                AND (
                    (
                        slot."outcome" = 'DELIVERED'
                        AND EXISTS (
                            SELECT 1
                            FROM "shipments" shipment
                            WHERE shipment."shipment_plan_id" = plan."id"
                              AND shipment."status" = 'DELIVERED'
                              AND shipment."delivered_at" IS NOT NULL
                              AND NOT EXISTS (
                                  SELECT 1
                                  FROM "shipments" replacement
                                  WHERE replacement."replaces_shipment_id" = shipment."id"
                              )
                        )
                    )
                    OR (
                        slot."outcome" IN ('CANCELLED', 'CANCELLED_REFUNDED')
                        AND EXISTS (
                            SELECT 1
                            FROM "shipments" shipment
                            WHERE shipment."shipment_plan_id" = plan."id"
                              AND shipment."status" = 'CANCELLED'
                              AND shipment."cancelled_at" IS NOT NULL
                              AND NOT EXISTS (
                                  SELECT 1
                                  FROM "shipments" replacement
                                  WHERE replacement."replaces_shipment_id" = shipment."id"
                              )
                        )
                    )
                )
          )
    ) OR EXISTS (
        SELECT 1
        FROM "shipments" shipment
        WHERE shipment."order_id" = target_order_id
          AND shipment."status" IN ('DELIVERED', 'CANCELLED')
          AND NOT EXISTS (
              SELECT 1
              FROM "shipments" replacement
              WHERE replacement."replaces_shipment_id" = shipment."id"
          )
          AND (
              NOT EXISTS (
                  SELECT 1
                  FROM "shipment_plan_fulfilment_slots" allocation
                  WHERE allocation."shipment_plan_id" = shipment."shipment_plan_id"
              )
              OR EXISTS (
                  SELECT 1
                  FROM "shipment_plan_fulfilment_slots" allocation
                  JOIN "fulfilment_slots" slot
                    ON slot."id" = allocation."fulfilment_slot_id"
                  WHERE allocation."shipment_plan_id" = shipment."shipment_plan_id"
                    AND (
                        (shipment."status" = 'DELIVERED' AND slot."outcome" <> 'DELIVERED')
                        OR (shipment."status" = 'CANCELLED'
                            AND slot."outcome" NOT IN ('CANCELLED', 'CANCELLED_REFUNDED'))
                    )
              )
          )
    ) THEN
        RAISE EXCEPTION 'ShipmentPlan terminal Shipment and fulfilment slots must transition atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_slot_terminal_reconciliation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "fulfilment_slots_shipment_plan_terminal_reconciled"
AFTER UPDATE OF "outcome" ON "fulfilment_slots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_shipment_plan_slot_terminal_state();
CREATE CONSTRAINT TRIGGER "shipments_fulfilment_slots_terminal_reconciled"
AFTER INSERT OR UPDATE OF "status", "delivered_at", "cancelled_at" ON "shipments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_shipment_plan_slot_terminal_state();
