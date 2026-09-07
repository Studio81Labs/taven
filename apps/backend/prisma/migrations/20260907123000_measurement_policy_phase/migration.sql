DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "handling_sessions")
     OR EXISTS (SELECT 1 FROM "handling_allocations") THEN
    RAISE EXCEPTION 'measurement policy and phase migration requires empty handling evidence tables';
  END IF;
END;
$$;

ALTER TABLE "handling_sessions"
  ADD COLUMN "labor_rate_policy_version" varchar(100) NOT NULL,
  ADD CONSTRAINT "handling_sessions_labor_rate_policy_check" CHECK (
    "labor_rate_policy_version" = 'operator-labor-czk-300-v1'
    AND "labor_rate_numerator" = 25
    AND "labor_rate_denominator" = 3
    AND "currency" = 'CZK'
  );

ALTER TABLE "handling_allocations"
  ADD COLUMN "order_phase_id" uuid,
  ADD CONSTRAINT "handling_allocations_order_phase_scope_fkey"
    FOREIGN KEY ("order_phase_id", "order_id") REFERENCES "order_phases"("id", "order_id") ON DELETE RESTRICT;
CREATE INDEX "handling_allocations_order_phase_id_idx" ON "handling_allocations"("order_phase_id");
ALTER TABLE "handling_allocations"
  DROP CONSTRAINT "handling_allocations_target_key_check",
  ADD CONSTRAINT "handling_allocations_target_key_check" CHECK (
    "target_key" = "order_id"::text || ':' || coalesce("order_item_id"::text, '') || ':' || coalesce("order_phase_id"::text, '') || ':' || coalesce("job_id"::text, '') || ':' || coalesce("shipment_id"::text, '')
  );

CREATE FUNCTION "taven_validate_handling_allocation_phase"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE session_component "handling_component";
BEGIN
  SELECT "component" INTO session_component FROM "handling_sessions" WHERE "id" = NEW."handling_session_id";
  IF (session_component = 'POSTPROCESSING_ITEM' AND (NEW."order_item_id" IS NULL OR NEW."order_phase_id" IS NULL OR NEW."job_id" IS NOT NULL OR NEW."shipment_id" IS NOT NULL OR NEW."served_unit_count" <> 1))
     OR (session_component <> 'POSTPROCESSING_ITEM' AND NEW."order_phase_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'handling allocation phase is invalid for its component';
  END IF;
  IF session_component = 'POSTPROCESSING_ITEM' AND NOT EXISTS (
    SELECT 1 FROM "fulfilment_slots" WHERE "order_id" = NEW."order_id" AND "order_item_id" = NEW."order_item_id" AND "order_phase_id" = NEW."order_phase_id"
  ) THEN RAISE EXCEPTION 'handling phase is outside its order item'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "handling_allocations_phase_lineage" BEFORE INSERT ON "handling_allocations"
  FOR EACH ROW EXECUTE FUNCTION "taven_validate_handling_allocation_phase"();

CREATE FUNCTION "taven_protect_handling_rate_policy"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."labor_rate_policy_version" IS DISTINCT FROM OLD."labor_rate_policy_version"
     OR NEW."labor_rate_numerator" IS DISTINCT FROM OLD."labor_rate_numerator"
     OR NEW."labor_rate_denominator" IS DISTINCT FROM OLD."labor_rate_denominator"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" THEN RAISE EXCEPTION 'handling rate policy is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "handling_sessions_rate_policy_immutable" BEFORE UPDATE ON "handling_sessions"
  FOR EACH ROW EXECUTE FUNCTION "taven_protect_handling_rate_policy"();
