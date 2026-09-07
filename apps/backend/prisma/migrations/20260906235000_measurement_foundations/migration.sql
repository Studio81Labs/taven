CREATE TYPE "handling_component" AS ENUM (
  'HANDLING_ORDER_FIX', 'HANDLING_PLATE', 'HANDLING_PIECE', 'HANDLING_PACK',
  'SHIPPING_TRIP', 'POSTPROCESSING_ITEM'
);
CREATE TYPE "handling_source" AS ENUM ('TIMER', 'MANUAL');
CREATE TYPE "handling_session_lifecycle" AS ENUM ('OPEN', 'COMPLETED', 'VOIDED');
CREATE TYPE "actual_cost_category" AS ENUM ('MATERIAL', 'VARIABLE_MACHINE', 'CARRIER', 'PACKAGING', 'PAYMENT_FEE');
CREATE TYPE "actual_cost_source" AS ENUM ('MEASURED', 'MANUAL');
CREATE TYPE "acquisition_channel" AS ENUM ('DIRECT', 'ORGANIC', 'PAID', 'REFERRAL', 'UNKNOWN');
CREATE TYPE "business_event_source" AS ENUM ('SERVER', 'CLIENT', 'BACKFILL');

CREATE TABLE "handling_sessions" (
  "id" uuid NOT NULL,
  "node_id" uuid NOT NULL,
  "operator_identity_id" uuid NOT NULL,
  "component" "handling_component" NOT NULL,
  "source" "handling_source" NOT NULL,
  "lifecycle" "handling_session_lifecycle" NOT NULL DEFAULT 'OPEN',
  "started_at" timestamptz(3) NOT NULL,
  "ended_at" timestamptz(3),
  "duration_milliseconds" bigint,
  "labor_rate_numerator" bigint NOT NULL,
  "labor_rate_denominator" bigint NOT NULL,
  "currency" char(3) NOT NULL,
  "total_cost_minor" bigint,
  "reason" varchar(1000),
  "command_idempotency_key" varchar(255) NOT NULL,
  "completed_at" timestamptz(3),
  "voided_at" timestamptz(3),
  "void_reason" varchar(1000),
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(3) NOT NULL,
  CONSTRAINT "handling_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "handling_sessions_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT,
  CONSTRAINT "handling_sessions_operator_identity_id_fkey" FOREIGN KEY ("operator_identity_id") REFERENCES "operator_identities"("id") ON DELETE RESTRICT,
  CONSTRAINT "handling_sessions_rate_check" CHECK ("labor_rate_numerator" >= 0 AND "labor_rate_denominator" > 0),
  CONSTRAINT "handling_sessions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "handling_sessions_reason_check" CHECK (
    ("reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 1000)
    AND ("void_reason" IS NULL OR length(btrim("void_reason")) BETWEEN 1 AND 1000)
    AND ("source" <> 'MANUAL' OR "reason" IS NOT NULL)
  ),
  CONSTRAINT "handling_sessions_shape_check" CHECK (
    ("lifecycle" = 'OPEN' AND "ended_at" IS NULL AND "duration_milliseconds" IS NULL AND "total_cost_minor" IS NULL AND "completed_at" IS NULL AND "voided_at" IS NULL)
    OR ("lifecycle" = 'COMPLETED' AND "ended_at" IS NOT NULL AND "ended_at" >= "started_at" AND "duration_milliseconds" > 0 AND "duration_milliseconds" = (extract(epoch FROM ("ended_at" - "started_at")) * 1000)::bigint AND "total_cost_minor" = ceil(("duration_milliseconds"::numeric * "labor_rate_numerator"::numeric) / (1000::numeric * "labor_rate_denominator"::numeric))::bigint AND "completed_at" IS NOT NULL AND "completed_at" >= "ended_at" AND "voided_at" IS NULL)
    OR ("lifecycle" = 'VOIDED' AND "voided_at" IS NOT NULL AND "voided_at" >= "started_at" AND ("completed_at" IS NULL OR "voided_at" >= "completed_at") AND "void_reason" IS NOT NULL)
  )
);
CREATE INDEX "handling_sessions_node_id_created_at_idx" ON "handling_sessions"("node_id", "created_at");
CREATE INDEX "handling_sessions_operator_identity_id_lifecycle_idx" ON "handling_sessions"("operator_identity_id", "lifecycle");
CREATE UNIQUE INDEX "handling_sessions_one_open_timer_per_operator"
  ON "handling_sessions"("operator_identity_id") WHERE "source" = 'TIMER' AND "lifecycle" = 'OPEN';

CREATE TABLE "handling_allocations" (
  "id" uuid NOT NULL,
  "handling_session_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "order_item_id" uuid,
  "job_id" uuid,
  "shipment_id" uuid,
  "target_key" varchar(255) NOT NULL,
  "served_unit_count" integer NOT NULL,
  "allocated_duration_milliseconds" bigint NOT NULL,
  "allocated_cost_minor" bigint NOT NULL,
  "currency" char(3) NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "handling_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "handling_allocations_session_target_key" UNIQUE ("handling_session_id", "target_key"),
  CONSTRAINT "handling_allocations_session_id_fkey" FOREIGN KEY ("handling_session_id") REFERENCES "handling_sessions"("id") ON DELETE RESTRICT,
  CONSTRAINT "handling_allocations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT,
  CONSTRAINT "handling_allocations_order_item_scope_fkey" FOREIGN KEY ("order_item_id", "order_id") REFERENCES "order_items"("id", "order_id") ON DELETE RESTRICT,
  CONSTRAINT "handling_allocations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT,
  CONSTRAINT "handling_allocations_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT,
  CONSTRAINT "handling_allocations_values_check" CHECK ("served_unit_count" > 0 AND "allocated_duration_milliseconds" >= 0 AND "allocated_cost_minor" >= 0),
  CONSTRAINT "handling_allocations_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "handling_allocations_target_key_check" CHECK (
    "target_key" = "order_id"::text || ':' || coalesce("order_item_id"::text, '') || ':' || coalesce("job_id"::text, '') || ':' || coalesce("shipment_id"::text, '')
  )
);
CREATE INDEX "handling_allocations_order_id_created_at_idx" ON "handling_allocations"("order_id", "created_at");
CREATE INDEX "handling_allocations_job_id_idx" ON "handling_allocations"("job_id");
CREATE INDEX "handling_allocations_shipment_id_idx" ON "handling_allocations"("shipment_id");

CREATE TABLE "order_actual_costs" (
  "id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "category" "actual_cost_category" NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" char(3) NOT NULL,
  "occurred_at" timestamptz(3) NOT NULL,
  "source" "actual_cost_source" NOT NULL,
  "source_key" varchar(255) NOT NULL,
  "source_entity_type" varchar(80) NOT NULL,
  "source_entity_id" uuid,
  "supersedes_id" uuid,
  "reason" varchar(1000),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_actual_costs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_actual_costs_source_key_key" UNIQUE ("source_key"),
  CONSTRAINT "order_actual_costs_supersedes_id_key" UNIQUE ("supersedes_id"),
  CONSTRAINT "order_actual_costs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT,
  CONSTRAINT "order_actual_costs_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "order_actual_costs"("id") ON DELETE RESTRICT,
  CONSTRAINT "order_actual_costs_amount_check" CHECK ("amount_minor" >= 0),
  CONSTRAINT "order_actual_costs_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "order_actual_costs_source_check" CHECK (length(btrim("source_key")) BETWEEN 1 AND 255 AND length(btrim("source_entity_type")) BETWEEN 1 AND 80),
  CONSTRAINT "order_actual_costs_reason_check" CHECK (
    ("reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 1000)
    AND ("source" <> 'MANUAL' AND "supersedes_id" IS NULL OR "reason" IS NOT NULL)
  )
);
CREATE INDEX "order_actual_costs_order_category_recorded_idx" ON "order_actual_costs"("order_id", "category", "recorded_at");

CREATE TABLE "acquisition_spend" (
  "id" uuid NOT NULL,
  "channel" "acquisition_channel" NOT NULL,
  "period_start" timestamptz(3) NOT NULL,
  "period_end" timestamptz(3) NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" char(3) NOT NULL,
  "source_key" varchar(255) NOT NULL,
  "source_entity_type" varchar(80) NOT NULL,
  "supersedes_id" uuid,
  "reason" varchar(1000),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acquisition_spend_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acquisition_spend_source_key_key" UNIQUE ("source_key"),
  CONSTRAINT "acquisition_spend_supersedes_id_key" UNIQUE ("supersedes_id"),
  CONSTRAINT "acquisition_spend_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "acquisition_spend"("id") ON DELETE RESTRICT,
  CONSTRAINT "acquisition_spend_period_check" CHECK ("period_end" > "period_start"),
  CONSTRAINT "acquisition_spend_amount_check" CHECK ("amount_minor" >= 0),
  CONSTRAINT "acquisition_spend_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "acquisition_spend_source_check" CHECK (length(btrim("source_key")) BETWEEN 1 AND 255 AND length(btrim("source_entity_type")) BETWEEN 1 AND 80),
  CONSTRAINT "acquisition_spend_reason_check" CHECK (
    ("reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 1000)
    AND ("supersedes_id" IS NULL OR "reason" IS NOT NULL)
  )
);
CREATE INDEX "acquisition_spend_channel_period_start_idx" ON "acquisition_spend"("channel", "period_start");

CREATE TABLE "business_events" (
  "id" uuid NOT NULL,
  "schema_version" integer NOT NULL DEFAULT 1,
  "event_type" varchar(100) NOT NULL,
  "dedupe_key" varchar(255) NOT NULL,
  "recorded_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "observed_at" timestamptz(3) NOT NULL,
  "source" "business_event_source" NOT NULL,
  "quote_session_id" uuid,
  "order_id" uuid,
  "job_id" uuid,
  "node_id" uuid,
  "payload" jsonb NOT NULL,
  "expires_at" timestamptz(3),
  CONSTRAINT "business_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_events_type_dedupe_key" UNIQUE ("event_type", "dedupe_key"),
  CONSTRAINT "business_events_quote_session_id_fkey" FOREIGN KEY ("quote_session_id") REFERENCES "quote_sessions"("id") ON DELETE RESTRICT,
  CONSTRAINT "business_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT,
  CONSTRAINT "business_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT,
  CONSTRAINT "business_events_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT,
  CONSTRAINT "business_events_schema_check" CHECK ("schema_version" = 1),
  CONSTRAINT "business_events_type_check" CHECK ("event_type" ~ '^[a-z][a-z0-9_.-]{0,99}$' AND length(btrim("dedupe_key")) BETWEEN 1 AND 255),
  CONSTRAINT "business_events_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "business_events_expiry_check" CHECK ("expires_at" IS NULL OR "expires_at" > "recorded_at")
);
CREATE INDEX "business_events_recorded_at_idx" ON "business_events"("recorded_at");
CREATE INDEX "business_events_order_id_recorded_at_idx" ON "business_events"("order_id", "recorded_at");

CREATE FUNCTION "taven_reject_measurement_evidence_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'measurement evidence is append-only';
END;
$$;
CREATE TRIGGER "order_actual_costs_append_only" BEFORE UPDATE OR DELETE ON "order_actual_costs"
  FOR EACH ROW EXECUTE FUNCTION "taven_reject_measurement_evidence_mutation"();
CREATE TRIGGER "acquisition_spend_append_only" BEFORE UPDATE OR DELETE ON "acquisition_spend"
  FOR EACH ROW EXECUTE FUNCTION "taven_reject_measurement_evidence_mutation"();
CREATE TRIGGER "handling_allocations_append_only" BEFORE UPDATE OR DELETE ON "handling_allocations"
  FOR EACH ROW EXECUTE FUNCTION "taven_reject_measurement_evidence_mutation"();

CREATE FUNCTION "taven_validate_actual_cost_supersession"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prior "order_actual_costs"%ROWTYPE;
BEGIN
  IF NEW."supersedes_id" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO prior FROM "order_actual_costs" WHERE "id" = NEW."supersedes_id";
  IF NOT FOUND OR prior."order_id" <> NEW."order_id" OR prior."category" <> NEW."category" OR prior."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'actual cost correction must preserve order, category, and currency';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "order_actual_costs_supersession" BEFORE INSERT ON "order_actual_costs"
  FOR EACH ROW EXECUTE FUNCTION "taven_validate_actual_cost_supersession"();

CREATE FUNCTION "taven_validate_acquisition_spend_supersession"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prior "acquisition_spend"%ROWTYPE;
BEGIN
  IF NEW."supersedes_id" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO prior FROM "acquisition_spend" WHERE "id" = NEW."supersedes_id";
  IF NOT FOUND OR prior."channel" <> NEW."channel" OR prior."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'acquisition spend correction must preserve channel and currency';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "acquisition_spend_supersession" BEFORE INSERT ON "acquisition_spend"
  FOR EACH ROW EXECUTE FUNCTION "taven_validate_acquisition_spend_supersession"();

CREATE FUNCTION "taven_validate_handling_allocation_lineage"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE session_node uuid; session_currency char(3); session_component "handling_component"; session_lifecycle "handling_session_lifecycle"; job_order uuid; job_node uuid; shipment_order uuid;
BEGIN
  SELECT "node_id", "currency", "component", "lifecycle" INTO session_node, session_currency, session_component, session_lifecycle FROM "handling_sessions" WHERE "id" = NEW."handling_session_id" FOR UPDATE;
  IF session_node IS NULL OR session_currency IS DISTINCT FROM NEW."currency" THEN RAISE EXCEPTION 'handling allocation has an invalid session currency'; END IF;
  IF session_lifecycle <> 'OPEN' THEN RAISE EXCEPTION 'handling allocations are sealed once a session is closed'; END IF;
  IF (session_component = 'HANDLING_ORDER_FIX' AND (NEW."order_item_id" IS NOT NULL OR NEW."job_id" IS NOT NULL OR NEW."shipment_id" IS NOT NULL OR NEW."served_unit_count" <> 1))
     OR (session_component IN ('HANDLING_PLATE', 'HANDLING_PIECE') AND (NEW."order_item_id" IS NULL OR NEW."shipment_id" IS NOT NULL))
     OR (session_component IN ('HANDLING_PACK', 'SHIPPING_TRIP') AND (NEW."shipment_id" IS NULL OR NEW."order_item_id" IS NOT NULL OR NEW."job_id" IS NOT NULL OR NEW."served_unit_count" <> 1))
     OR (session_component = 'POSTPROCESSING_ITEM' AND (NEW."order_item_id" IS NULL OR NEW."job_id" IS NOT NULL OR NEW."shipment_id" IS NOT NULL OR NEW."served_unit_count" <> 1)) THEN
    RAISE EXCEPTION 'handling allocation target is invalid for its component';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "jobs" WHERE "order_id" = NEW."order_id" AND "node_id" = session_node)
     OR EXISTS (SELECT 1 FROM "jobs" WHERE "order_id" = NEW."order_id" AND "node_id" <> session_node) THEN
    RAISE EXCEPTION 'handling order is outside its node';
  END IF;
  IF NEW."job_id" IS NOT NULL THEN
    SELECT "order_id", "node_id" INTO job_order, job_node FROM "jobs" WHERE "id" = NEW."job_id";
    IF job_order IS DISTINCT FROM NEW."order_id" OR job_node IS DISTINCT FROM session_node THEN RAISE EXCEPTION 'handling job target is outside its order or node'; END IF;
  END IF;
  IF NEW."shipment_id" IS NOT NULL THEN
    SELECT "order_id" INTO shipment_order FROM "shipments" WHERE "id" = NEW."shipment_id";
    IF shipment_order IS DISTINCT FROM NEW."order_id" THEN RAISE EXCEPTION 'handling shipment target is outside its order'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "handling_allocations_lineage" BEFORE INSERT ON "handling_allocations"
  FOR EACH ROW EXECUTE FUNCTION "taven_validate_handling_allocation_lineage"();

CREATE FUNCTION "taven_reject_handling_session_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'handling sessions are immutable'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."lifecycle" <> 'OPEN' THEN
      RAISE EXCEPTION 'handling session has an invalid initial lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."lifecycle" = 'VOIDED' THEN RAISE EXCEPTION 'voided handling sessions cannot change'; END IF;
  IF NEW."node_id" IS DISTINCT FROM OLD."node_id"
     OR NEW."operator_identity_id" IS DISTINCT FROM OLD."operator_identity_id"
     OR NEW."component" IS DISTINCT FROM OLD."component"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
     OR NEW."labor_rate_numerator" IS DISTINCT FROM OLD."labor_rate_numerator"
     OR NEW."labor_rate_denominator" IS DISTINCT FROM OLD."labor_rate_denominator"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."command_idempotency_key" IS DISTINCT FROM OLD."command_idempotency_key"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'handling measurement inputs are immutable';
  END IF;
  IF OLD."lifecycle" = 'COMPLETED' AND NEW."lifecycle" <> 'VOIDED' THEN
    RAISE EXCEPTION 'completed handling sessions can only be voided';
  END IF;
  IF OLD."lifecycle" = 'COMPLETED' AND (
    NEW."ended_at" IS DISTINCT FROM OLD."ended_at"
    OR NEW."duration_milliseconds" IS DISTINCT FROM OLD."duration_milliseconds"
    OR NEW."total_cost_minor" IS DISTINCT FROM OLD."total_cost_minor"
    OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
  ) THEN
    RAISE EXCEPTION 'completed handling measurements are immutable';
  END IF;
  IF OLD."lifecycle" = 'OPEN' AND NEW."lifecycle" NOT IN ('COMPLETED', 'VOIDED') THEN
    RAISE EXCEPTION 'open handling session has an invalid transition';
  END IF;
  IF OLD."lifecycle" = 'OPEN' AND NEW."lifecycle" = 'VOIDED' AND (
    NEW."ended_at" IS DISTINCT FROM OLD."ended_at"
    OR NEW."duration_milliseconds" IS DISTINCT FROM OLD."duration_milliseconds"
    OR NEW."total_cost_minor" IS DISTINCT FROM OLD."total_cost_minor"
    OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
  ) THEN
    RAISE EXCEPTION 'voiding an open handling session cannot add measurements';
  END IF;
  IF OLD."lifecycle" = 'OPEN' AND NEW."lifecycle" = 'VOIDED'
     AND EXISTS (SELECT 1 FROM "handling_allocations" WHERE "handling_session_id" = OLD."id") THEN
    RAISE EXCEPTION 'voiding an open handling session cannot retain allocations';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "handling_sessions_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "handling_sessions"
  FOR EACH ROW EXECUTE FUNCTION "taven_reject_handling_session_mutation"();

CREATE FUNCTION "taven_validate_handling_reconciliation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE session_id uuid; session_state "handling_session_lifecycle"; session_source "handling_source"; session_component "handling_component"; total_duration bigint; total_cost bigint; allocation_count bigint; expected_duration bigint; expected_cost bigint;
BEGIN
  IF TG_TABLE_NAME = 'handling_sessions' THEN
    session_id := COALESCE(NEW."id", OLD."id");
  ELSE
    session_id := COALESCE(NEW."handling_session_id", OLD."handling_session_id");
  END IF;
  SELECT "lifecycle", "source", "component", "duration_milliseconds", "total_cost_minor" INTO session_state, session_source, session_component, expected_duration, expected_cost FROM "handling_sessions" WHERE "id" = session_id;
  IF session_state = 'COMPLETED' THEN
    SELECT count(*), coalesce(sum("allocated_duration_milliseconds"), 0), coalesce(sum("allocated_cost_minor"), 0)
      INTO allocation_count, total_duration, total_cost FROM "handling_allocations" WHERE "handling_session_id" = session_id;
    IF allocation_count = 0
       OR total_duration <> expected_duration
       OR total_cost <> expected_cost
       OR (session_component = 'HANDLING_ORDER_FIX' AND allocation_count <> 1) THEN
      RAISE EXCEPTION 'completed handling session allocations do not reconcile';
    END IF;
  ELSIF session_state = 'OPEN' AND (session_source = 'MANUAL' OR EXISTS (SELECT 1 FROM "handling_allocations" WHERE "handling_session_id" = session_id)) THEN
    RAISE EXCEPTION 'open handling session cannot be manual or have allocations';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "handling_sessions_reconcile" AFTER INSERT OR UPDATE OR DELETE ON "handling_sessions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "taven_validate_handling_reconciliation"();
CREATE CONSTRAINT TRIGGER "handling_allocations_reconcile" AFTER INSERT OR UPDATE OR DELETE ON "handling_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "taven_validate_handling_reconciliation"();
