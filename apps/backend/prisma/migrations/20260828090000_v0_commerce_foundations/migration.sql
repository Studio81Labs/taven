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
CREATE TYPE "order_status" AS ENUM ('DRAFT', 'QUOTED', 'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_FULFILLED', 'CANCELLED_SETTLED');

-- CreateEnum
CREATE TYPE "order_phase_kind" AS ENUM ('SINGLE');

-- CreateEnum
CREATE TYPE "order_phase_status" AS ENUM ('QUOTED', 'ACTIVE', 'IN_PRODUCTION', 'QC_PASSED', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'CANCELLED_REFUNDED');

-- CreateEnum
CREATE TYPE "fulfilment_slot_outcome" AS ENUM ('PENDING', 'DELIVERED', 'CANCELLED_REFUNDED');

-- CreateEnum
CREATE TYPE "shipment_status" AS ENUM ('PLANNED', 'LABEL_CREATED', 'HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('CREATED', 'ACCEPTED', 'PRINTING', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED', 'CANCELLED', 'FAILED', 'QC_REJECTED');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('CREATED', 'PENDING', 'CAPTURED', 'FAILED', 'VOIDED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "refund_reason" AS ENUM ('CUSTOMER_CANCELLATION');

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
    "printing_at" TIMESTAMPTZ(3),
    "qc_approved_at" TIMESTAMPTZ(3),
    "packed_at" TIMESTAMPTZ(3),
    "handed_over_at" TIMESTAMPTZ(3),
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
    "captured_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_transactions" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "provider_refund_id" VARCHAR(255),
    "amount_minor" BIGINT NOT NULL,
    "reason" "refund_reason" NOT NULL,
    "status" "refund_status" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE UNIQUE INDEX "shipments_provider_shipment_id_key" ON "shipments"("provider_shipment_id");
CREATE INDEX "shipments_order_id_status_idx" ON "shipments"("order_id", "status");
CREATE INDEX "shipments_shipment_plan_id_status_idx" ON "shipments"("shipment_plan_id", "status");
CREATE UNIQUE INDEX "jobs_id_node_id_phase_resource_plan_job_id_key" ON "jobs"("id", "node_id", "phase_resource_plan_job_id");
CREATE UNIQUE INDEX "jobs_phase_resource_plan_job_id_key" ON "jobs"("phase_resource_plan_job_id");
CREATE INDEX "jobs_shipment_plan_id_status_idx" ON "jobs"("shipment_plan_id", "status");
CREATE INDEX "jobs_node_id_status_idx" ON "jobs"("node_id", "status");
CREATE UNIQUE INDEX "payments_provider_intent_id_key" ON "payments"("provider_intent_id");
CREATE UNIQUE INDEX "payments_provider_capture_id_key" ON "payments"("provider_capture_id");
CREATE UNIQUE INDEX "payments_one_nonfailed_attempt_per_schedule_key" ON "payments"("payment_schedule_id") WHERE "status" <> 'FAILED';
CREATE INDEX "payments_order_id_status_idx" ON "payments"("order_id", "status");
CREATE INDEX "payments_capture_cutoff_at_status_idx" ON "payments"("capture_cutoff_at", "status");
CREATE UNIQUE INDEX "refund_transactions_provider_refund_id_key" ON "refund_transactions"("provider_refund_id");
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
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_order_phase_id_order_id_fkey" FOREIGN KEY ("order_phase_id", "order_id") REFERENCES "order_phases"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_shipment_plan_id_order_id_order_phase_id_fkey" FOREIGN KEY ("shipment_plan_id", "order_id", "order_phase_id") REFERENCES "shipment_plans"("id", "order_id", "order_phase_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_phase_resource_plan_job_id_node_id_fkey" FOREIGN KEY ("phase_resource_plan_job_id", "node_id") REFERENCES "phase_resource_plan_jobs"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;
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
ALTER TABLE "customers" ADD CONSTRAINT "customers_email_normalized_check" CHECK ("email" = lower("email") AND "email" <> '');
ALTER TABLE "quote_sessions" ADD CONSTRAINT "quote_sessions_expiry_check" CHECK ("expires_at" > "created_at");
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
ALTER TABLE "orders" ADD CONSTRAINT "orders_timestamps_check" CHECK (("quoted_at" IS NULL OR "quoted_at" >= "created_at") AND ("confirmed_at" IS NULL OR "confirmed_at" >= "created_at"));
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_ordinal_quantity_check" CHECK ("ordinal" >= 0 AND "quantity" > 0);
ALTER TABLE "order_phases" ADD CONSTRAINT "order_phases_timestamps_check" CHECK (("activated_at" IS NULL OR "activated_at" >= "created_at") AND ("qc_passed_at" IS NULL OR "qc_passed_at" >= "created_at") AND ("shipped_at" IS NULL OR "shipped_at" >= "created_at") AND ("delivered_at" IS NULL OR "delivered_at" >= "created_at") AND ("completed_at" IS NULL OR "completed_at" >= "created_at") AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at"));
ALTER TABLE "shipment_plans" ADD CONSTRAINT "shipment_plans_values_check" CHECK ("ordinal" >= 0 AND "category" <> '' AND "planned_volume_cubic_mm" >= 0 AND "planned_weight_milligrams" >= 0 AND "shipping_amount_minor" >= 0 AND "packaging_amount_minor" >= 0 AND "handling_amount_minor" >= 0);
ALTER TABLE "fulfilment_slots" ADD CONSTRAINT "fulfilment_slots_values_check" CHECK ("quantity_ordinal" >= 1 AND "settlement_amount_minor" >= 0);
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_timestamps_check" CHECK (("label_created_at" IS NULL OR "label_created_at" >= "created_at") AND ("handed_over_at" IS NULL OR "handed_over_at" >= "created_at") AND ("delivered_at" IS NULL OR "delivered_at" >= "created_at") AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at"));
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_timestamps_check" CHECK (("accepted_at" IS NULL OR "accepted_at" >= "created_at") AND ("printing_at" IS NULL OR "printing_at" >= "created_at") AND ("qc_approved_at" IS NULL OR "qc_approved_at" >= "created_at") AND ("packed_at" IS NULL OR "packed_at" >= "created_at") AND ("handed_over_at" IS NULL OR "handed_over_at" >= "created_at"));
ALTER TABLE "payments" ADD CONSTRAINT "payments_values_check" CHECK ("requested_amount_minor" > 0 AND ("captured_amount_minor" IS NULL OR ("captured_amount_minor" > 0 AND "captured_amount_minor" <= "requested_amount_minor")) AND "currency" ~ '^[A-Z]{3}$' AND ("capture_cutoff_at" IS NULL OR "capture_cutoff_at" >= "created_at") AND ("captured_at" IS NULL OR "captured_at" >= "created_at"));
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
ALTER TABLE "refund_transactions" ADD CONSTRAINT "refund_transactions_success_facts_check" CHECK (
    "status" <> 'SUCCEEDED'
    OR ("provider_refund_id" IS NOT NULL AND "completed_at" IS NOT NULL)
);
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_scope_check" CHECK ("quote_id" IS NOT NULL OR "order_id" IS NOT NULL OR "payment_id" IS NOT NULL OR "refund_transaction_id" IS NOT NULL);

-- Immutable commercial snapshots and append-only audit rows.
CREATE FUNCTION taven_prevent_commerce_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "price_snapshots_immutable"
BEFORE UPDATE OR DELETE ON "price_snapshots"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();
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
    WHERE slice_result."id" = NEW."reference_slice_result_id"
      AND slice_result."kind" = 'REFERENCE'
      AND slice_result."model_geometry_id" = NEW."model_geometry_id"
      AND slice_result."print_config_revision_id" = NEW."print_config_revision_id"
    FOR KEY SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION '% reference slice must be a REFERENCE slice for its exact geometry and print configuration', TG_TABLE_NAME
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
BEFORE INSERT OR UPDATE OF "reference_slice_result_id", "model_geometry_id", "print_config_revision_id" ON "order_items"
FOR EACH ROW EXECUTE FUNCTION taven_validate_item_reference_slice_inputs();

CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();

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
        JOIN "order_items" item ON item."order_id" = origin."order_id"
        LEFT JOIN "individual_order_item_sources" source ON source."order_item_id" = item."id"
        WHERE origin."order_id" = NEW."id"
        GROUP BY origin."order_id"
        HAVING count(item."id") = 0 OR count(source."order_item_id") <> count(item."id")
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
BEGIN
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
BEGIN
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

CREATE FUNCTION taven_protect_quote_request_issued_quote()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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
    ) AND NEW."status" NOT IN ('QUOTED', 'ACCEPTED', 'EXPIRED') THEN
        RAISE EXCEPTION 'an issued quote request cannot return to a pre-quote or rejected state'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_issued_quote_status_check';
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
           )
       ) THEN
        RAISE EXCEPTION 'accepted quote request requires a current quoted offer with one complete immutable price binding'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_price_binding_acceptance_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_requests_issued_quote_protected"
BEFORE UPDATE OF "customer_id", "status" ON "quote_requests"
FOR EACH ROW EXECUTE FUNCTION taven_protect_quote_request_issued_quote();

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
               OR target_order."customer_id" IS NULL
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

CREATE FUNCTION taven_validate_automatic_order_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "quote_sessions" session ON session."id" = NEW."quote_session_id"
        WHERE target_order."id" = NEW."order_id"
          AND target_order."status" = 'DRAFT'
          AND (session."customer_id" IS NULL
               OR target_order."customer_id" IS NULL
               OR session."customer_id" = target_order."customer_id")
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
    SELECT "status" INTO target_order_status
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

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

CREATE FUNCTION taven_protect_order_draft_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" <> 'DRAFT' AND NEW."status" = 'DRAFT' THEN
        RAISE EXCEPTION 'draft is an initial order state and cannot be restored'
            USING ERRCODE = '23514', CONSTRAINT = 'order_status_transition_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "orders_draft_status_not_restored"
BEFORE UPDATE OF "status" ON "orders"
FOR EACH ROW EXECUTE FUNCTION taven_protect_order_draft_status();

CREATE FUNCTION taven_validate_order_price_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "individual_order_origins" origin WHERE origin."order_id" = NEW."order_id"
    ) AND NOT EXISTS (
        SELECT 1
        FROM "individual_order_origins" origin
        JOIN "quote_price_bindings" quote_binding ON quote_binding."quote_id" = origin."quote_id"
        WHERE origin."order_id" = NEW."order_id"
          AND quote_binding."price_snapshot_id" = NEW."price_snapshot_id"
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

    IF OLD."invalidated_at" IS NULL
       AND NEW."invalidated_at" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = OLD."order_id") THEN
        RAISE EXCEPTION 'price binding cannot be invalidated after payment intent creation'
            USING ERRCODE = '23514', CONSTRAINT = 'order_price_binding_payment_guard';
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
    previous_binding_id uuid;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."order_id" IS DISTINCT FROM OLD."order_id" THEN
        RAISE EXCEPTION 'active order price binding cannot be reparented'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_owner_immutable_check';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "order_price_bindings" binding
        WHERE binding."id" = NEW."order_price_binding_id"
          AND binding."order_id" = NEW."order_id"
          AND binding."invalidated_at" IS NULL
    ) THEN
        RAISE EXCEPTION 'active order price binding must belong to its order and remain valid'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_owner_check';
    END IF;

    IF EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = NEW."order_id") THEN
        RAISE EXCEPTION 'active destination and price binding cannot change after payment intent creation'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_payment_guard';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW."order_price_binding_id" IS DISTINCT FROM OLD."order_price_binding_id" THEN
        previous_binding_id := OLD."order_price_binding_id";
        UPDATE "order_price_bindings"
        SET "invalidated_at" = CURRENT_TIMESTAMP
        WHERE "id" = previous_binding_id
          AND "invalidated_at" IS NULL;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_active_price_bindings_guarded"
BEFORE INSERT OR UPDATE ON "order_active_price_bindings"
FOR EACH ROW EXECUTE FUNCTION taven_move_active_order_price_binding();

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
    JOIN "orders" target_order ON target_order."id" = binding."order_id"
    WHERE component."id" = NEW."price_snapshot_component_id"
    FOR UPDATE OF target_order;

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
            AND target_order."status" NOT IN ('DRAFT', 'QUOTED')
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
    old_is_terminal := OLD."status" IN ('COMPLETED', 'REFUNDED', 'PARTIALLY_FULFILLED', 'CANCELLED_SETTLED')
        OR (
            OLD."status" = 'CANCELLED'
            AND NOT EXISTS (
                SELECT 1
                FROM "payments" payment
                WHERE payment."order_id" = OLD."id"
                  AND coalesce(payment."captured_amount_minor", 0) > 0
            )
        );
    new_is_terminal := NEW."status" IN ('COMPLETED', 'REFUNDED', 'PARTIALLY_FULFILLED', 'CANCELLED_SETTLED')
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
       AND NEW."status" NOT IN ('DRAFT', 'QUOTED') THEN
        UPDATE "model_files" source
        SET "retention_hold" = CASE
            WHEN source."retention_hold" IN ('ACTIVE_CLAIM', 'LEGAL') THEN source."retention_hold"
            ELSE 'ACTIVE_ORDER'::"retention_hold"
        END
        FROM "order_items" item
        WHERE item."order_id" = NEW."id"
          AND source."id" = item."source_model_file_id";
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
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM 1
        FROM "orders"
        WHERE "id" = NEW."order_id"
        FOR UPDATE;

        IF EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = NEW."order_id") THEN
            RAISE EXCEPTION 'shipment plans cannot be added after payment intent creation'
                USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_payment_guard';
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
BEGIN
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
    SELECT "status" INTO target_order_status
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    IF TG_OP = 'INSERT' THEN
        IF target_order_status IS DISTINCT FROM 'DRAFT'::"order_status" THEN
            RAISE EXCEPTION 'fulfilment slots can be inserted only while the order is draft'
                USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_topology_immutable_check';
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

    RETURN NEW;
END;
$$;

CREATE TRIGGER "fulfilment_slots_topology_protected"
BEFORE INSERT OR UPDATE OR DELETE ON "fulfilment_slots"
FOR EACH ROW EXECUTE FUNCTION taven_protect_fulfilment_slot_topology();

CREATE FUNCTION taven_protect_shipment_topology()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."order_phase_id" IS DISTINCT FROM OLD."order_phase_id"
       OR NEW."shipment_plan_id" IS DISTINCT FROM OLD."shipment_plan_id"
       OR NEW."delivery_destination_id" IS DISTINCT FROM OLD."delivery_destination_id" THEN
        RAISE EXCEPTION 'shipment order, phase, plan, and destination cannot be changed'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_topology_immutable_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "shipments_topology_protected"
BEFORE UPDATE ON "shipments"
FOR EACH ROW EXECUTE FUNCTION taven_protect_shipment_topology();

CREATE FUNCTION taven_require_payment_fulfilment_topology()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    quoted_phase_count integer;
BEGIN
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
          AND resource_plan."expires_at" > CURRENT_TIMESTAMP
          AND EXISTS (
              SELECT 1
              FROM "phase_reservation_sets" reservation_set
              WHERE reservation_set."phase_resource_plan_id" = resource_plan."id"
                AND reservation_set."node_id" = resource_plan."node_id"
                AND reservation_set."status" IN ('RESERVED', 'HELD')
                AND reservation_set."expires_at" > CURRENT_TIMESTAMP
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
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'payment transactions are append-only financial history'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_identity_immutable_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'CREATED' AND NEW."status" = 'PENDING')
           OR (OLD."status" = 'PENDING' AND NEW."status" IN ('CAPTURED', 'FAILED', 'VOIDED'))
           OR (OLD."status" = 'CAPTURED' AND NEW."status" = 'REFUND_PENDING')
           OR (OLD."status" = 'VOIDED' AND NEW."status" = 'REFUND_PENDING')
           OR (OLD."status" = 'REFUND_PENDING' AND NEW."status" IN ('PARTIALLY_REFUNDED', 'REFUNDED'))
           OR (OLD."status" = 'PARTIALLY_REFUNDED' AND NEW."status" IN ('REFUND_PENDING', 'REFUNDED'))
       ) THEN
        RAISE EXCEPTION 'payment status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_status_transition_check';
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

    RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_identity_protected"
BEFORE UPDATE OR DELETE ON "payments"
FOR EACH ROW EXECUTE FUNCTION taven_protect_payment_identity();

CREATE FUNCTION taven_validate_payment_refund_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_payment_id uuid;
    payment_status "payment_status";
    captured_amount bigint;
    succeeded_refunds bigint;
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

    SELECT coalesce(sum("amount_minor"), 0)
    INTO succeeded_refunds
    FROM "refund_transactions"
    WHERE "payment_id" = target_payment_id
      AND "status" = 'SUCCEEDED';

    IF payment_status IN ('CREATED', 'PENDING', 'FAILED', 'VOIDED', 'CAPTURED')
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
BEGIN
    SELECT "captured_amount_minor"
    INTO captured_amount
    FROM "payments"
    WHERE "id" = NEW."payment_id"
    FOR UPDATE;

    IF captured_amount IS NULL OR captured_amount <= 0 THEN
        RAISE EXCEPTION 'refund requires a captured payment'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_captured_payment_check';
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
BEFORE INSERT OR UPDATE OF "payment_id", "amount_minor", "status" ON "refund_transactions"
FOR EACH ROW EXECUTE FUNCTION taven_validate_refund_against_capture();
