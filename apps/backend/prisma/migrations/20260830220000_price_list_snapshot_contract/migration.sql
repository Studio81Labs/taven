-- Versioned pricing inputs are immutable and every snapshot must point at the
-- exact list which produced it.  The deterministic legacy row keeps this
-- migration replayable for the v0 foundation rows.
CREATE TABLE "price_lists" (
    "id" UUID NOT NULL,
    "revision" VARCHAR(100) NOT NULL,
    "terms_revision" VARCHAR(100) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "parameters" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_lists_currency_revision_key" UNIQUE ("currency", "revision"),
    CONSTRAINT "price_lists_values_check" CHECK (
        "revision" ~ '[^[:space:]]'
        AND "terms_revision" ~ '[^[:space:]]'
        AND "currency" ~ '^[A-Z]{3}$'
        AND jsonb_typeof("parameters") = 'object'
    )
);

INSERT INTO "price_lists" ("id", "revision", "terms_revision", "currency", "parameters")
VALUES
    ('00000000-0000-4000-8000-000000000019', 'legacy-v0-czk', 'legacy-v0', 'CZK', '{}'::jsonb),
    ('00000000-0000-4000-8000-000000000020', 'legacy-v0-eur', 'legacy-v0', 'EUR', '{}'::jsonb);

INSERT INTO "price_lists" ("id", "revision", "terms_revision", "currency", "parameters")
SELECT md5(snapshot."currency" || ':' || snapshot."pricing_revision")::uuid,
       snapshot."pricing_revision", 'legacy-v0', snapshot."currency", '{}'::jsonb
FROM (SELECT DISTINCT "currency", "pricing_revision" FROM "price_snapshots") snapshot
ON CONFLICT ("currency", "revision") DO NOTHING;

ALTER TABLE "price_snapshots"
    ADD COLUMN "price_list_id" UUID;

UPDATE "price_snapshots"
SET "price_list_id" = (
    SELECT list."id" FROM "price_lists" list
    WHERE list."currency" = "price_snapshots"."currency"
      AND list."revision" = "price_snapshots"."pricing_revision"
)
WHERE "price_list_id" IS NULL;

ALTER TABLE "price_snapshots"
    ALTER COLUMN "price_list_id" SET NOT NULL;

ALTER TABLE "price_snapshots"
    ADD CONSTRAINT "price_snapshots_price_list_id_fkey"
    FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "price_lists"
    ADD CONSTRAINT "price_lists_id_currency_revision_key" UNIQUE ("id", "currency", "revision");

ALTER TABLE "price_snapshots"
    ADD CONSTRAINT "price_snapshots_price_list_currency_fkey"
    FOREIGN KEY ("price_list_id", "currency", "pricing_revision")
    REFERENCES "price_lists"("id", "currency", "revision")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "price_snapshots_price_list_id_idx"
    ON "price_snapshots"("price_list_id");

CREATE FUNCTION taven_prevent_price_list_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'price_lists rows are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'price_lists_immutable';
END;
$$;

CREATE FUNCTION taven_payment_schedule_is_valid(target_snapshot_id uuid, expected_total bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT (
        (
            SELECT count(*) FROM "payment_schedules"
            WHERE "price_snapshot_id" = target_snapshot_id AND "role" = 'FULL'
        ) = 1
        AND (
            SELECT count(*) FROM "payment_schedules"
            WHERE "price_snapshot_id" = target_snapshot_id
        ) = 1
        OR
        (
            SELECT count(*) FROM "payment_schedules"
            WHERE "price_snapshot_id" = target_snapshot_id AND "role" = 'DEPOSIT'
        ) = 1
        AND (
            SELECT count(*) FROM "payment_schedules"
            WHERE "price_snapshot_id" = target_snapshot_id AND "role" = 'BALANCE'
        ) = 1
        AND (
            SELECT count(*) FROM "payment_schedules"
            WHERE "price_snapshot_id" = target_snapshot_id
        ) = 2
    )
    AND (
        SELECT coalesce(sum("gross_amount_minor"), 0)
        FROM "payment_schedules"
        WHERE "price_snapshot_id" = target_snapshot_id
    ) = expected_total;
$$;

CREATE FUNCTION taven_full_payment_schedule_is_valid(target_snapshot_id uuid, expected_total bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT (
        SELECT count(*)
        FROM "payment_schedules"
        WHERE "price_snapshot_id" = target_snapshot_id
          AND "role" = 'FULL'
    ) = 1
    AND (
        SELECT count(*)
        FROM "payment_schedules"
        WHERE "price_snapshot_id" = target_snapshot_id
    ) = 1
    AND (
        SELECT coalesce(sum("gross_amount_minor"), 0)
        FROM "payment_schedules"
        WHERE "price_snapshot_id" = target_snapshot_id
    ) = expected_total;
$$;

CREATE FUNCTION taven_payment_schedule_is_valid_for_order(
    target_order_id uuid,
    target_snapshot_id uuid,
    expected_total bigint
)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN EXISTS (
            SELECT 1 FROM "automatic_order_origins"
            WHERE "order_id" = target_order_id
        )
        THEN taven_full_payment_schedule_is_valid(target_snapshot_id, expected_total)
        ELSE taven_payment_schedule_is_valid(target_snapshot_id, expected_total)
    END;
$$;

CREATE FUNCTION taven_price_snapshot_payment_schedule_is_valid(
    target_snapshot_id uuid,
    expected_total bigint
)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM "order_price_bindings" binding
            JOIN "automatic_order_origins" origin
              ON origin."order_id" = binding."order_id"
            WHERE binding."price_snapshot_id" = target_snapshot_id
        )
        THEN taven_full_payment_schedule_is_valid(target_snapshot_id, expected_total)
        ELSE taven_payment_schedule_is_valid(target_snapshot_id, expected_total)
    END;
$$;


-- Quote acceptance and order readiness originally assumed one FULL capture.
-- Individual offers may instead use the immutable DEPOSIT + BALANCE schedule,
-- while automatic orders retain their v0 FULL-only policy.
CREATE OR REPLACE FUNCTION taven_require_initial_quoted_single_phase()
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

    PERFORM taven_assert_automatic_order_reference_slices(NEW."id");

    IF NOT EXISTS (
        SELECT 1
        FROM "order_active_price_bindings" active
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
        JOIN "price_snapshots" snapshot
          ON snapshot."id" = binding."price_snapshot_id"
        WHERE active."order_id" = NEW."id"
          AND binding."order_id" = NEW."id"
          AND binding."invalidated_at" IS NULL
          AND snapshot."contract_total_minor" > 0
          AND taven_payment_schedule_is_valid_for_order(
              NEW."id",
              snapshot."id",
              snapshot."contract_total_minor"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "payment_schedules" schedule
              WHERE schedule."price_snapshot_id" = snapshot."id"
                AND schedule."gross_amount_minor" <= 0
          )
    ) THEN
        RAISE EXCEPTION 'quoted order requires a positive contract total and valid payment schedule'
            USING ERRCODE = '23514', CONSTRAINT = 'quoted_order_positive_payment_check';
    END IF;

    PERFORM taven_assert_order_quote_fulfilment_topology(NEW."id");
    PERFORM taven_assert_order_fulfilment_money(NEW."id");

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION taven_protect_quote_request_issued_quote()
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
             AND snapshot."contract_total_minor" > 0
             AND (
                 SELECT coalesce(sum(component."amount_minor"), 0)
                 FROM "price_snapshot_components" component
                 WHERE component."price_snapshot_id" = snapshot."id"
             ) = snapshot."contract_total_minor"
             AND taven_payment_schedule_is_valid(
                 snapshot."id",
                 snapshot."contract_total_minor"
             )
             AND NOT EXISTS (
                 SELECT 1
                 FROM "payment_schedules" schedule
                 WHERE schedule."price_snapshot_id" = snapshot."id"
                   AND schedule."gross_amount_minor" <= 0
             )
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

CREATE OR REPLACE FUNCTION taven_move_active_order_price_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_status "order_status";
    target_accepted_order_price_binding_id uuid;
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

    SELECT "status", "accepted_order_price_binding_id"
    INTO target_order_status, target_accepted_order_price_binding_id
    FROM "orders"
    WHERE "id" = NEW."order_id"
    FOR UPDATE NOWAIT;

    IF EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = NEW."order_id") THEN
        RAISE EXCEPTION 'active destination and price binding cannot change after payment intent creation'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_payment_guard';
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW."order_price_binding_id" IS DISTINCT FROM OLD."order_price_binding_id"
       AND target_accepted_order_price_binding_id IS NOT NULL THEN
        RAISE EXCEPTION 'active destination and price binding cannot change after checkout acceptance'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_acceptance_guard';
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW."order_price_binding_id" IS DISTINCT FROM OLD."order_price_binding_id"
       AND EXISTS (
           SELECT 1
           FROM "shipment_plans" plan
           JOIN "shipments" shipment ON shipment."shipment_plan_id" = plan."id"
           WHERE plan."order_id" = NEW."order_id"
             AND plan."order_price_binding_id" = OLD."order_price_binding_id"
       ) THEN
        RAISE EXCEPTION 'active destination and price binding cannot change after Shipment creation'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_shipment_guard';
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
               WHERE binding."id" = NEW."order_price_binding_id"
                 AND snapshot."contract_total_minor" > 0
                 AND taven_payment_schedule_is_valid_for_order(
                     NEW."order_id",
                     snapshot."id",
                     snapshot."contract_total_minor"
                 )
                 AND NOT EXISTS (
                     SELECT 1
                     FROM "payment_schedules" schedule
                     WHERE schedule."price_snapshot_id" = snapshot."id"
                       AND schedule."gross_amount_minor" <= 0
                 )
           )
       ) THEN
        RAISE EXCEPTION 'non-draft active binding requires complete quote-ready shipment topology'
            USING ERRCODE = '23514', CONSTRAINT = 'active_order_price_binding_quote_topology_check';
    END IF;

    RETURN NEW;
END;
$$;


CREATE TRIGGER "price_lists_immutable"
BEFORE UPDATE OR DELETE ON "price_lists"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_price_list_mutation();

-- Replace the foundation seal check so a schedule is either one full capture,
-- or exactly one deposit plus one balance, and both forms reconcile exactly to
-- the immutable contract total.
CREATE OR REPLACE FUNCTION taven_protect_price_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND pg_trigger_depth() > 1
       AND OLD."sealed_at" IS NULL
       AND NEW."sealed_at" IS NOT NULL
       AND NEW."sealed_at" IS NOT DISTINCT FROM CURRENT_TIMESTAMP(3)
       AND NEW."id" IS NOT DISTINCT FROM OLD."id"
       AND NEW."price_list_id" IS NOT DISTINCT FROM OLD."price_list_id"
       AND NEW."currency" IS NOT DISTINCT FROM OLD."currency"
       AND NEW."contract_total_minor" IS NOT DISTINCT FROM OLD."contract_total_minor"
       AND NEW."pricing_revision" IS NOT DISTINCT FROM OLD."pricing_revision"
       AND NEW."input_snapshot" IS NOT DISTINCT FROM OLD."input_snapshot"
       AND NEW."snapshot_hash" IS NOT DISTINCT FROM OLD."snapshot_hash"
       AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
       AND (
           EXISTS (SELECT 1 FROM "quote_price_bindings" WHERE "price_snapshot_id" = OLD."id")
           OR EXISTS (SELECT 1 FROM "order_price_bindings" WHERE "price_snapshot_id" = OLD."id")
       )
       AND EXISTS (
           SELECT 1 FROM "price_snapshots" snapshot
           WHERE snapshot."id" = OLD."id"
             AND (SELECT coalesce(sum(component."amount_minor"), 0)
                  FROM "price_snapshot_components" component
                  WHERE component."price_snapshot_id" = snapshot."id") = snapshot."contract_total_minor"
             AND taven_price_snapshot_payment_schedule_is_valid(
                 snapshot."id",
                 snapshot."contract_total_minor"
             )
       ) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'price_snapshots rows are immutable' USING ERRCODE = '23514';
END;
$$;

ALTER TABLE "payment_schedules"
    ADD CONSTRAINT "payment_schedules_role_sequence_check"
    CHECK (
        ("role" = 'FULL' AND "sequence" = 0)
        OR ("role" = 'DEPOSIT' AND "sequence" = 0)
        OR ("role" = 'BALANCE' AND "sequence" = 1)
    );

ALTER TABLE "fulfilment_slots"
    ADD COLUMN "packing_unit_key" VARCHAR(255);

UPDATE "fulfilment_slots" slot
SET "packing_unit_key" = slot."order_item_id"::text
    || ':' || lower(phase."kind"::text)
    || ':' || slot."quantity_ordinal"::text
FROM "order_phases" phase
WHERE phase."id" = slot."order_phase_id"
  AND phase."order_id" = slot."order_id";

ALTER TABLE "fulfilment_slots"
    ALTER COLUMN "packing_unit_key" SET NOT NULL,
    ADD CONSTRAINT "fulfilment_slots_packing_unit_key_check"
      CHECK ("packing_unit_key" ~ '^[0-9a-f-]{36}:(single|sample|batch):[1-9][0-9]*$');

CREATE FUNCTION taven_assign_packing_unit_key()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    expected_key text;
BEGIN
    SELECT NEW."order_item_id"::text || ':' || lower("kind"::text) || ':' || NEW."quantity_ordinal"::text
      INTO expected_key
      FROM "order_phases"
     WHERE "id" = NEW."order_phase_id" AND "order_id" = NEW."order_id";
    IF expected_key IS NULL THEN
        RAISE EXCEPTION 'fulfilment slot phase does not belong to order' USING ERRCODE = '23514';
    END IF;
    IF NEW."packing_unit_key" IS NULL THEN
        NEW."packing_unit_key" := expected_key;
    ELSIF NEW."packing_unit_key" <> expected_key THEN
        RAISE EXCEPTION 'packing unit key must be the canonical order item key' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "fulfilment_slots_assign_packing_unit_key"
BEFORE INSERT ON "fulfilment_slots"
FOR EACH ROW EXECUTE FUNCTION taven_assign_packing_unit_key();

CREATE UNIQUE INDEX "fulfilment_slots_order_id_packing_unit_key_key"
    ON "fulfilment_slots"("order_id", "packing_unit_key");

-- The foundation migration's deferred reconciliation predates split captures
-- and counted only FULL schedules. Replace its body while retaining the
-- existing trigger names and transaction boundary.
CREATE OR REPLACE FUNCTION taven_validate_price_snapshot_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_snapshot_id uuid;
    contract_total bigint;
    component_total bigint;
BEGIN
    target_snapshot_id := CASE
        WHEN TG_TABLE_NAME = 'price_snapshots' THEN (to_jsonb(NEW) ->> 'id')::uuid
        ELSE (to_jsonb(NEW) ->> 'price_snapshot_id')::uuid
    END;

    SELECT "contract_total_minor" INTO contract_total
    FROM "price_snapshots" WHERE "id" = target_snapshot_id;

    IF EXISTS (
        SELECT 1 FROM "order_price_bindings" binding
        JOIN "orders" target_order ON target_order."id" = binding."order_id"
        WHERE binding."price_snapshot_id" = target_snapshot_id
          AND target_order."status" <> 'DRAFT'
    ) THEN
        PERFORM taven_assert_shipment_plan_price_components(target_snapshot_id);
    END IF;

    SELECT coalesce(sum("amount_minor"), 0) INTO component_total
    FROM "price_snapshot_components"
    WHERE "price_snapshot_id" = target_snapshot_id;

    PERFORM taven_assert_payment_schedule_fee_component(target_snapshot_id);

    IF component_total <> contract_total
       OR NOT taven_price_snapshot_payment_schedule_is_valid(
           target_snapshot_id,
           contract_total
       ) THEN
        RAISE EXCEPTION 'price snapshot % requires components and a valid payment schedule equal to its contract total', target_snapshot_id
            USING ERRCODE = '23514', CONSTRAINT = 'price_snapshot_total_reconciliation_check';
    END IF;

    PERFORM taven_assert_automatic_order_reference_slices(binding."order_id")
    FROM "order_price_bindings" binding
    WHERE binding."price_snapshot_id" = target_snapshot_id;

    IF EXISTS (
        SELECT 1 FROM "quote_price_bindings" WHERE "price_snapshot_id" = target_snapshot_id
        UNION ALL
        SELECT 1 FROM "order_price_bindings" WHERE "price_snapshot_id" = target_snapshot_id
    ) THEN
        UPDATE "price_snapshots"
        SET "sealed_at" = CURRENT_TIMESTAMP(3)
        WHERE "id" = target_snapshot_id AND "sealed_at" IS NULL;
    END IF;
    RETURN NULL;
END;
$$;


-- FULL and DEPOSIT are the two initial checkout captures. They share the
-- reservation activation, capture-window, expiry, and void-closure contract;
-- BALANCE retains its later business deadline.
CREATE OR REPLACE FUNCTION taven_reconcile_quoted_order_cancellation_payments()
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

    IF NEW."status" = 'EXPIRED'
       AND NOT EXISTS (
           SELECT 1
           FROM "payments"
           WHERE "order_id" = NEW."id"
             AND "role" IN ('FULL', 'DEPOSIT')
             AND "checkout_capture_expires_at" IS NOT NULL
             AND "checkout_capture_expires_at" <= clock_timestamp()
             AND "capture_cutoff_at" >= "checkout_capture_expires_at"
       )
       AND NOT (
           NOT EXISTS (
               SELECT 1
               FROM "payments"
               WHERE "order_id" = NEW."id"
                 AND "status" <> 'FAILED'
           )
           AND EXISTS (
               SELECT 1
               FROM "automatic_order_origins" origin
               JOIN "quote_sessions" session
                 ON session."id" = origin."quote_session_id"
               WHERE origin."order_id" = NEW."id"
                 AND session."status" = 'CONVERTED'
                 AND session."expires_at" <= clock_timestamp()
           )
       ) THEN
        RAISE EXCEPTION 'quoted order expiry requires its immutable checkout or converted-session deadline to pass'
            USING ERRCODE = '23514', CONSTRAINT = 'quoted_order_expiry_deadline_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION taven_reconcile_payment_capture_activation()
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
         AND payment."role" IN ('FULL', 'DEPOSIT')
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
          AND target_order."accepted_order_price_binding_id" = payment."order_price_binding_id"
          AND target_order."accepted_terms_revision" IS NOT NULL
          AND target_order."accepted_claim_policy_revision" IS NOT NULL
          AND target_order."withdrawal_exception_acknowledged_at" IS NOT NULL
          AND target_order."confirmed_at" >= payment."captured_at" - interval '5 seconds'
          AND phase."activated_at" >= payment."captured_at" - interval '5 seconds'
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
              JOIN "candidate_resource_estimates" candidate
                ON candidate."id" = plan_job."candidate_resource_estimate_id"
               AND candidate."node_id" = plan_job."node_id"
              JOIN "shipment_plans" candidate_plan
                ON candidate_plan."id" = candidate."shipment_plan_id"
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
                AND candidate_plan."order_price_binding_id" IS DISTINCT FROM payment."order_price_binding_id"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "phase_reservation_sets" competing_set
              JOIN "phase_resource_plans" competing_plan
                ON competing_plan."id" = competing_set."phase_resource_plan_id"
               AND competing_plan."node_id" = competing_set."node_id"
              WHERE competing_plan."order_phase_id" = phase."id"
                AND competing_set."id" <> reservation_set."id"
                AND competing_set."status" IN ('BUILDING', 'RESERVED', 'HELD')
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

CREATE OR REPLACE FUNCTION taven_require_payment_fulfilment_topology()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    quoted_phase_count integer;
BEGIN
    IF NEW."status" <> 'CREATED' THEN
        RAISE EXCEPTION 'new payments must begin created'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_initial_status_check';
    END IF;

    IF NOT NEW."capture_authorized"
       OR NEW."capture_cutoff_at" IS NOT NULL
       OR (NEW."role" IN ('FULL', 'DEPOSIT') AND (
           NEW."checkout_capture_expires_at" IS NULL
           OR NEW."checkout_capture_expires_at" IS DISTINCT FROM
              NEW."created_at" + interval '60 minutes'
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

    IF NOT EXISTS (
        SELECT 1
        FROM "orders" target_order
        WHERE target_order."id" = NEW."order_id"
          AND target_order."accepted_order_price_binding_id" = NEW."order_price_binding_id"
          AND target_order."accepted_terms_revision" IS NOT NULL
          AND target_order."accepted_claim_policy_revision" IS NOT NULL
          AND target_order."withdrawal_exception_acknowledged_at" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'payment requires immutable checkout acceptance evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_terms_acceptance_check';
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
                AND reservation_set."created_at" <=
                    clock_timestamp() + interval '5 seconds'
                AND reservation_set."expires_at" =
                    reservation_set."created_at" + interval '15 minutes'
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

CREATE OR REPLACE FUNCTION taven_protect_payment_identity()
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
           (OLD."status" = 'CREATED' AND NEW."status" IN ('PENDING', 'FAILED', 'VOIDED'))
           OR (OLD."status" = 'PENDING' AND NEW."status" IN ('CAPTURED', 'FAILED', 'VOIDED', 'REFUND_PENDING'))
           OR (OLD."status" = 'FAILED' AND NEW."status" = 'REFUND_PENDING')
           OR (OLD."status" = 'CAPTURED' AND NEW."status" = 'REFUND_PENDING')
           OR (OLD."status" = 'VOIDED' AND NEW."status" = 'REFUND_PENDING')
           OR (OLD."status" = 'REFUND_PENDING' AND NEW."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'))
           OR (OLD."status" = 'PARTIALLY_REFUNDED' AND NEW."status" IN ('REFUND_PENDING', 'REFUNDED'))
           OR (OLD."status" = 'PARTIALLY_REFUNDED'
               AND NEW."status" = 'CAPTURED'
               AND taven_payment_has_newer_refund_failure(NEW."id"))
           OR (OLD."status" = 'REFUNDED'
               AND NEW."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING')
               AND taven_payment_has_newer_refund_failure(NEW."id"))
       ) THEN
        RAISE EXCEPTION 'payment status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_status_transition_check';
    END IF;

    IF OLD."provider_intent_id" IS NULL
       AND NEW."provider_intent_id" IS NOT NULL
       AND NOT (OLD."status" = 'CREATED' AND NEW."status" = 'PENDING') THEN
        RAISE EXCEPTION 'provider intent may be assigned only as a payment becomes pending'
            USING ERRCODE = '23514', CONSTRAINT = 'payments_provider_intent_identity_check';
    END IF;

    IF NEW."intent_creation_failure_result_id" IS DISTINCT FROM
          OLD."intent_creation_failure_result_id"
       AND NOT (
           OLD."intent_creation_failure_result_id" IS NULL
           AND NEW."intent_creation_failure_result_id" IS NOT NULL
           AND OLD."status" = 'CREATED'
           AND NEW."status" = 'FAILED'
       ) THEN
        RAISE EXCEPTION 'intent creation failure result may be assigned only as a created Payment fails'
            USING ERRCODE = '23514', CONSTRAINT = 'payments_intent_creation_failure_identity_check';
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
           OR (NEW."role" IN ('FULL', 'DEPOSIT') AND (
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

    IF NEW."capture_cutoff_at" IS DISTINCT FROM OLD."capture_cutoff_at"
       AND NEW."capture_cutoff_at" IS NOT NULL
       AND NEW."capture_cutoff_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'payment capture cutoff evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_cutoff_evidence_check';
    END IF;

    IF NEW."status" IN ('FAILED', 'VOIDED')
       AND (NEW."capture_authorized" OR NEW."capture_cutoff_at" IS NULL) THEN
        RAISE EXCEPTION 'failed or voided payment requires a closed authorization window'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
    END IF;

    IF OLD."status" = 'FAILED'
       AND NEW."status" = 'REFUND_PENDING'
       AND (
           NEW."provider_intent_id" IS NULL
           OR NEW."provider_intent_id" !~ '[^[:space:]]'
           OR NEW."capture_authorized"
           OR NEW."capture_cutoff_at" IS NULL
           OR NEW."captured_at" IS NULL
           OR NEW."captured_at" < NEW."capture_cutoff_at"
           OR NOT EXISTS (
               SELECT 1
               FROM "payment_provider_events" event
               WHERE event."payment_id" = NEW."id"
                 AND event."refund_transaction_id" IS NULL
                 AND event."provider" = NEW."provider"
                 AND event."kind" = 'PAYMENT_FAILED'
                 AND event."provider_transaction_id" = NEW."provider_intent_id"
                 AND event."amount_minor" = NEW."requested_amount_minor"
                 AND event."currency" = NEW."currency"
                 AND event."verified_at" = NEW."capture_cutoff_at"
           )
       ) THEN
        RAISE EXCEPTION 'failed Payment may reopen only for a verified capture after its closed authorization cutoff'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_failed_late_capture_check';
    END IF;

    IF OLD."status" = 'PENDING'
       AND NEW."status" = 'REFUND_PENDING'
       AND EXISTS (
           SELECT 1
           FROM "payment_provider_events" event
           WHERE event."payment_id" = NEW."id"
             AND event."refund_transaction_id" IS NULL
             AND event."provider" = NEW."provider"
             AND event."kind" = 'PAYMENT_FAILED'
             AND event."provider_transaction_id" = NEW."provider_intent_id"
             AND event."amount_minor" = NEW."requested_amount_minor"
             AND event."currency" = NEW."currency"
             AND event."verified_at" = NEW."capture_cutoff_at"
       ) THEN
        RAISE EXCEPTION 'a provider-failed Payment must record failure before late-capture compensation'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_failed_late_capture_source_check';
    END IF;

    IF OLD."status" = 'REFUND_PENDING'
       AND NEW."status" = 'CAPTURED'
       AND EXISTS (
           SELECT 1
           FROM "refund_transactions" refund
           WHERE refund."payment_id" = NEW."id"
             AND refund."reason" = 'LATE_CAPTURE_COMPENSATION'
       )
       AND EXISTS (
           SELECT 1
           FROM "payment_provider_events" event
           WHERE event."payment_id" = NEW."id"
             AND event."refund_transaction_id" IS NULL
             AND event."provider" = NEW."provider"
             AND event."kind" = 'PAYMENT_FAILED'
             AND event."provider_transaction_id" = NEW."provider_intent_id"
             AND event."amount_minor" = NEW."requested_amount_minor"
             AND event."currency" = NEW."currency"
             AND event."verified_at" = NEW."capture_cutoff_at"
       ) THEN
        RAISE EXCEPTION 'failed-source late capture must retain pending compensation until fully refunded'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_failed_late_capture_refund_retry_check';
    END IF;

    IF OLD."status" IN ('REFUNDED', 'PARTIALLY_REFUNDED')
       AND NEW."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED')
       AND EXISTS (
           SELECT 1
           FROM "refund_transactions" refund
           WHERE refund."payment_id" = NEW."id"
             AND refund."reason" = 'LATE_CAPTURE_COMPENSATION'
             AND refund."status" = 'FAILED'
             AND taven_refund_result_event_matches(
                 refund."id", refund."provider_result_event_id",
                 'FAILED'::"refund_status"
             )
       ) THEN
        RAISE EXCEPTION 'reversed late-capture compensation must atomically retain pending retry work'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_late_capture_refund_reversal_retry_check';
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

    IF OLD."captured_amount_minor" IS NULL
       AND NEW."status" IN ('CAPTURED', 'REFUND_PENDING')
       AND NEW."captured_amount_minor" IS NOT NULL
       AND NEW."captured_amount_minor" > 0
       AND NEW."captured_amount_minor" <= NEW."requested_amount_minor"
       AND NEW."provider_capture_id" IS NOT NULL
       AND NEW."provider_capture_id" ~ '[^[:space:]]'
       AND NEW."captured_at" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "payment_provider_events" event
           WHERE event."payment_id" = NEW."id"
             AND event."refund_transaction_id" IS NULL
             AND event."provider" = NEW."provider"
             AND event."kind" = 'PAYMENT_CAPTURED'
             AND event."provider_transaction_id" = NEW."provider_capture_id"
             AND event."amount_minor" = NEW."captured_amount_minor"
             AND event."currency" = NEW."currency"
             AND event."verified_at" = NEW."captured_at"
       ) THEN
        RAISE EXCEPTION 'payment capture requires its exact verified provider event receipt'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_provider_receipt_check';
    END IF;

    IF OLD."status" = 'PENDING'
       AND NEW."status" = 'FAILED'
       AND NOT EXISTS (
           SELECT 1
           FROM "payment_provider_events" event
           WHERE event."payment_id" = NEW."id"
             AND event."refund_transaction_id" IS NULL
             AND event."provider" = NEW."provider"
             AND event."kind" = 'PAYMENT_FAILED'
             AND event."provider_transaction_id" = NEW."provider_intent_id"
             AND event."amount_minor" = NEW."requested_amount_minor"
             AND event."currency" = NEW."currency"
             AND event."verified_at" = NEW."capture_cutoff_at"
       ) THEN
        RAISE EXCEPTION 'payment failure requires its exact verified provider event receipt'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_failure_provider_receipt_check';
    END IF;

    IF OLD."status" = 'CREATED'
       AND NEW."status" = 'FAILED'
       AND NOT EXISTS (
           SELECT 1
           FROM "payment_intent_creation_failures" failure
           WHERE failure."id" = NEW."intent_creation_failure_result_id"
             AND failure."payment_id" = NEW."id"
             AND failure."provider" = NEW."provider"
             AND failure."outcome" = 'FAILED'
             AND failure."provider_intent_id" IS NULL
             AND failure."failed_at" = NEW."capture_cutoff_at"
       ) THEN
        RAISE EXCEPTION 'created Payment failure requires its exact immutable provider attempt failure'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_intent_creation_failure_evidence_check';
    END IF;

    IF OLD."status" = 'PENDING' AND NEW."status" = 'VOIDED' THEN
        INSERT INTO "outbox_messages" (
            "id", "deduplication_key", "aggregate_type", "aggregate_id",
            "message_type", "schema_version", "payload", "status", "attempts",
            "available_at", "created_at", "updated_at"
        ) VALUES (
            gen_random_uuid(),
            'void_payment:v1:' || NEW."id"::text,
            'Payment',
            NEW."id",
            'void_payment',
            1,
            jsonb_build_object(
                'paymentId', NEW."id"::text,
                'provider', NEW."provider",
                'providerIntentId', NEW."provider_intent_id",
                'action', 'void_payment'
            ),
            'PENDING',
            0,
            evidence_now,
            evidence_now,
            evidence_now
        )
        ON CONFLICT ("deduplication_key") DO NOTHING;

        IF NOT EXISTS (
            SELECT 1
            FROM "outbox_messages" message
            WHERE message."deduplication_key" =
                  'void_payment:v1:' || NEW."id"::text
              AND message."aggregate_type" = 'Payment'
              AND message."aggregate_id" = NEW."id"
              AND message."message_type" = 'void_payment'
              AND message."schema_version" = 1
              AND message."status" = 'PENDING'
              AND message."attempts" = 0
              AND message."payload" = jsonb_build_object(
                  'paymentId', NEW."id"::text,
                  'provider', NEW."provider",
                  'providerIntentId', NEW."provider_intent_id",
                  'action', 'void_payment'
              )
        ) THEN
            RAISE EXCEPTION 'pending payment void requires its exact durable provider command'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_void_outbox_check';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER "payments_quoted_void_closure_reconciled" ON "payments";
CREATE CONSTRAINT TRIGGER "payments_quoted_void_closure_reconciled"
AFTER UPDATE OF "status" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
    OLD."status" IN ('CREATED', 'PENDING')
    AND NEW."status" = 'VOIDED'
    AND NEW."role" IN ('FULL', 'DEPOSIT')
)
EXECUTE FUNCTION taven_reconcile_quoted_payment_void_closure();
