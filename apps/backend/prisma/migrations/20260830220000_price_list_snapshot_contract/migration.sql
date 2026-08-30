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
    ('00000000-0000-4000-8000-000000000019', 'legacy-v0-czk', 'terms-v1', 'CZK', '{"balance_payment_days":7,"balance_timeout_earned_component_kinds":["ITEM_PRODUCTION","ITEM_QUANTITY","ITEM_POSTPROCESSING"]}'::jsonb),
    ('00000000-0000-4000-8000-000000000020', 'legacy-v0-eur', 'terms-v1', 'EUR', '{"balance_payment_days":7,"balance_timeout_earned_component_kinds":["ITEM_PRODUCTION","ITEM_QUANTITY","ITEM_POSTPROCESSING"]}'::jsonb);

INSERT INTO "price_lists" ("id", "revision", "terms_revision", "currency", "parameters")
SELECT md5(snapshot."currency" || ':' || snapshot."pricing_revision")::uuid,
       snapshot."pricing_revision", 'terms-v1', snapshot."currency",
       '{"balance_payment_days":7,"balance_timeout_earned_component_kinds":["ITEM_PRODUCTION","ITEM_QUANTITY","ITEM_POSTPROCESSING"]}'::jsonb
FROM (SELECT DISTINCT "currency", "pricing_revision" FROM "price_snapshots") snapshot
ON CONFLICT ("currency", "revision") DO NOTHING;

ALTER TABLE "price_snapshots"
    ADD COLUMN "price_list_id" UUID;

-- Existing snapshots are immutable. Suspend only that user trigger inside one
-- atomic statement while assigning the deterministic legacy list. If the
-- backfill fails, PostgreSQL restores the trigger before surfacing the error.
DO $$
BEGIN
    EXECUTE 'ALTER TABLE "price_snapshots" DISABLE TRIGGER "price_snapshots_immutable"';

    UPDATE "price_snapshots"
    SET "price_list_id" = (
        SELECT list."id" FROM "price_lists" list
        WHERE list."currency" = "price_snapshots"."currency"
          AND list."revision" = "price_snapshots"."pricing_revision"
    )
    WHERE "price_list_id" IS NULL;

    EXECUTE 'ALTER TABLE "price_snapshots" ENABLE TRIGGER "price_snapshots_immutable"';
END;
$$;

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

-- The checkout deadline is intentionally limited to the initial FULL or
-- DEPOSIT capture.  A post-QC BALANCE capture uses its own business deadline,
-- derived from the accepted versioned PriceList.
ALTER TABLE "payments"
    ADD COLUMN "balance_due_at" TIMESTAMPTZ(3);

CREATE INDEX "payments_balance_due_at_status_idx"
    ON "payments"("balance_due_at", "status");

-- The foundation constraint enumerates every live status. Extend it with the
-- post-QC balance state while preserving the original timestamp guarantees.
ALTER TABLE "orders" DROP CONSTRAINT "orders_timestamps_check";
ALTER TABLE "orders" ADD CONSTRAINT "orders_timestamps_check" CHECK (
    ("quoted_at" IS NULL OR "quoted_at" >= "created_at" - interval '5 seconds')
    AND ("confirmed_at" IS NULL OR ("quoted_at" IS NOT NULL AND "confirmed_at" >= "quoted_at"))
    AND (
        "withdrawal_exception_acknowledged_at" IS NULL
        OR (
            "quoted_at" IS NOT NULL
            AND "withdrawal_exception_acknowledged_at" >= "quoted_at"
        )
    )
    AND (
        ("status" = 'DRAFT' AND "quoted_at" IS NULL AND "confirmed_at" IS NULL)
        OR ("status" IN ('QUOTED', 'EXPIRED') AND "quoted_at" IS NOT NULL AND "confirmed_at" IS NULL)
        OR (
            "status" IN (
                'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED', 'AWAITING_BALANCE',
                'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'COMPLETED',
                'PARTIALLY_FULFILLED'
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

ALTER TABLE "order_settlements"
    DROP CONSTRAINT "order_settlements_unauthorized_handoff_formula_check";

-- A balance timeout has two distinct payment identities: the captured DEPOSIT
-- which may be retained/refunded, and the BALANCE intent whose capture window
-- was closed. Keep both on the immutable settlement instead of overloading the
-- captured payment reference. A retained deposit may produce no refund at all.
ALTER TABLE "order_settlements"
    ADD COLUMN "balance_payment_id" UUID,
    ALTER COLUMN "refund_transaction_id" DROP NOT NULL;

ALTER TABLE "order_settlements"
    ADD CONSTRAINT "order_settlements_balance_payment_scope_fkey"
    FOREIGN KEY ("balance_payment_id", "order_id")
    REFERENCES "payments"("id", "order_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_settlements"
    ADD CONSTRAINT "order_settlements_kind_formula_check" CHECK (
        (
            "kind" = 'UNAUTHORIZED_HANDOFF'
            AND "refund_transaction_id" IS NOT NULL
            AND "balance_payment_id" IS NULL
            AND "captured_total_minor" = "contract_total_minor"
            AND "earned_amount_minor" = 0
            AND "retained_amount_minor" = least("captured_total_minor", "earned_amount_minor")
            AND "refund_amount_minor" = "captured_total_minor" - "retained_amount_minor"
            AND "written_off_amount_minor" = greatest(0, "earned_amount_minor" - "captured_total_minor")
            AND "unearned_cancelled_amount_minor" = "contract_total_minor" - "earned_amount_minor"
            AND "amount_due_minor" = 0
            AND "refundable_balance_minor" = 0
        )
        OR
        (
            "kind" = 'BALANCE_SETTLEMENT'
            AND "captured_total_minor" < "contract_total_minor"
            AND "balance_payment_id" IS NOT NULL
            AND "retained_amount_minor" = least("captured_total_minor", "earned_amount_minor")
            AND "refund_amount_minor" = "captured_total_minor" - "retained_amount_minor"
            AND "written_off_amount_minor" = greatest(0, "earned_amount_minor" - "captured_total_minor")
            AND "unearned_cancelled_amount_minor" = "contract_total_minor" - "earned_amount_minor"
            AND "amount_due_minor" = 0
            AND "refundable_balance_minor" = "refund_amount_minor"
            AND (
                ("refund_amount_minor" = 0 AND "refund_transaction_id" IS NULL)
                OR ("refund_amount_minor" > 0 AND "refund_transaction_id" IS NOT NULL)
            )
        )
    );

DROP TRIGGER "order_settlements_refunded_handoff_reconciled"
    ON "order_settlements";
CREATE CONSTRAINT TRIGGER "order_settlements_refunded_handoff_reconciled"
AFTER INSERT ON "order_settlements"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."kind" = 'UNAUTHORIZED_HANDOFF')
EXECUTE FUNCTION taven_reconcile_refunded_handoff_record();

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

CREATE FUNCTION taven_split_payment_schedule_is_valid(target_snapshot_id uuid, expected_total bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT expected_total > 1
       AND (
           SELECT count(*) FROM "payment_schedules"
           WHERE "price_snapshot_id" = target_snapshot_id
             AND "role" = 'DEPOSIT'
             AND "sequence" = 0
             AND "gross_amount_minor" > 0
       ) = 1
       AND (
           SELECT count(*) FROM "payment_schedules"
           WHERE "price_snapshot_id" = target_snapshot_id
             AND "role" = 'BALANCE'
             AND "sequence" = 1
             AND "gross_amount_minor" > 0
       ) = 1
       AND (
           SELECT count(*) FROM "payment_schedules"
           WHERE "price_snapshot_id" = target_snapshot_id
       ) = 2
       AND (
           SELECT coalesce(sum("gross_amount_minor"), 0)
           FROM "payment_schedules"
           WHERE "price_snapshot_id" = target_snapshot_id
       ) = expected_total;
$$;

CREATE FUNCTION taven_price_snapshot_balance_deadline_is_valid(target_snapshot_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "price_snapshots" snapshot
        JOIN "price_lists" list ON list."id" = snapshot."price_list_id"
        WHERE snapshot."id" = target_snapshot_id
          AND jsonb_typeof(list."parameters" -> 'balance_payment_days') = 'number'
          AND (list."parameters" ->> 'balance_payment_days') ~ '^[1-9][0-9]*$'
          AND (list."parameters" ->> 'balance_payment_days')::numeric <= 36500
    );
$$;

-- The component kinds are a terms-bound, immutable policy input. The values
-- are deliberately validated here instead of inferring earned value from a
-- slot's total, which also contains shipping, fees, and other unearned work.
CREATE FUNCTION taven_price_snapshot_balance_earned_policy_is_valid(
    target_snapshot_id uuid
)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "price_snapshots" snapshot
        JOIN "price_lists" list ON list."id" = snapshot."price_list_id"
        WHERE snapshot."id" = target_snapshot_id
          AND jsonb_typeof(
              list."parameters" -> 'balance_timeout_earned_component_kinds'
          ) = 'array'
          AND jsonb_array_length(
              list."parameters" -> 'balance_timeout_earned_component_kinds'
          ) > 0
          AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                  list."parameters" -> 'balance_timeout_earned_component_kinds'
              ) AS policy_kind("value")
              WHERE jsonb_typeof(policy_kind."value") <> 'string'
          )
          AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                  list."parameters" -> 'balance_timeout_earned_component_kinds'
              ) AS policy_kind("kind")
              WHERE policy_kind."kind" NOT IN (
                  'ITEM_PRODUCTION', 'ITEM_QUANTITY', 'ITEM_POSTPROCESSING',
                  'ORDER_MIN_PRINT', 'ORDER_SMALL_SURCHARGE', 'SHIPMENT',
                  'EXPRESS', 'PAYMENT_FEE'
              )
          )
          AND NOT EXISTS (
              SELECT policy_kind."kind"
              FROM jsonb_array_elements_text(
                  list."parameters" -> 'balance_timeout_earned_component_kinds'
              ) AS policy_kind("kind")
              GROUP BY policy_kind."kind"
              HAVING count(*) > 1
          )
    );
$$;

CREATE FUNCTION taven_balance_timeout_earned_amount(
    target_order_id uuid,
    target_phase_id uuid,
    target_binding_id uuid,
    target_snapshot_id uuid
)
RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT coalesce(sum(allocation."amount_minor"), 0)
    FROM "orders" target_order
    JOIN "order_price_bindings" binding
      ON binding."id" = target_binding_id
     AND binding."order_id" = target_order_id
     AND binding."price_snapshot_id" = target_snapshot_id
    JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
    JOIN "price_lists" list ON list."id" = snapshot."price_list_id"
    JOIN "price_snapshot_components" component
      ON component."price_snapshot_id" = snapshot."id"
    JOIN "price_component_fulfilment_allocations" allocation
      ON allocation."price_snapshot_component_id" = component."id"
    JOIN "fulfilment_slots" slot
      ON slot."id" = allocation."fulfilment_slot_id"
     AND slot."order_id" = target_order_id
     AND slot."order_phase_id" = target_phase_id
    WHERE target_order."id" = target_order_id
      AND target_order."accepted_order_price_binding_id" = target_binding_id
      AND target_order."accepted_terms_revision" = list."terms_revision"
      AND component."kind"::text IN (
          SELECT jsonb_array_elements_text(
              list."parameters" -> 'balance_timeout_earned_component_kinds'
          )
      );
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
        WHEN EXISTS (
            SELECT 1 FROM "individual_order_origins"
            WHERE "order_id" = target_order_id
        )
        THEN taven_split_payment_schedule_is_valid(target_snapshot_id, expected_total)
             AND taven_price_snapshot_balance_deadline_is_valid(target_snapshot_id)
             AND taven_price_snapshot_balance_earned_policy_is_valid(target_snapshot_id)
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
        WHEN EXISTS (
            SELECT 1
            FROM "order_price_bindings" binding
            JOIN "individual_order_origins" origin
              ON origin."order_id" = binding."order_id"
            WHERE binding."price_snapshot_id" = target_snapshot_id
        )
        THEN taven_split_payment_schedule_is_valid(target_snapshot_id, expected_total)
             AND taven_price_snapshot_balance_deadline_is_valid(target_snapshot_id)
             AND taven_price_snapshot_balance_earned_policy_is_valid(target_snapshot_id)
        ELSE taven_payment_schedule_is_valid(target_snapshot_id, expected_total)
    END;
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "individual_order_origins" origin
        JOIN "order_active_price_bindings" active
          ON active."order_id" = origin."order_id"
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
         AND binding."order_id" = origin."order_id"
        JOIN "price_snapshots" snapshot
          ON snapshot."id" = binding."price_snapshot_id"
        WHERE binding."invalidated_at" IS NULL
          AND (
              NOT taven_split_payment_schedule_is_valid(
                  snapshot."id", snapshot."contract_total_minor"
              )
              OR NOT taven_price_snapshot_balance_deadline_is_valid(snapshot."id")
              OR NOT taven_price_snapshot_balance_earned_policy_is_valid(snapshot."id")
          )
    ) THEN
        RAISE EXCEPTION 'existing individual order has no valid deposit-plus-balance contract'
            USING ERRCODE = '23514', CONSTRAINT = 'individual_split_payment_migration_check';
    END IF;
END;
$$;

CREATE FUNCTION taven_order_accepts_bound_price_list_terms(
    target_order_id uuid,
    target_binding_id uuid
)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "order_active_price_bindings" active
          ON active."order_id" = target_order."id"
         AND active."order_price_binding_id" = target_binding_id
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
         AND binding."order_id" = target_order."id"
        JOIN "price_snapshots" snapshot
          ON snapshot."id" = binding."price_snapshot_id"
        JOIN "price_lists" list
          ON list."id" = snapshot."price_list_id"
        WHERE target_order."id" = target_order_id
          AND target_order."accepted_order_price_binding_id" = binding."id"
          AND target_order."accepted_terms_revision" = list."terms_revision"
    );
$$;

CREATE FUNCTION taven_require_price_list_terms_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."accepted_order_price_binding_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "order_active_price_bindings" active
           JOIN "order_price_bindings" binding
             ON binding."id" = active."order_price_binding_id"
            AND binding."order_id" = active."order_id"
           JOIN "price_snapshots" snapshot
             ON snapshot."id" = binding."price_snapshot_id"
           JOIN "price_lists" list
             ON list."id" = snapshot."price_list_id"
           WHERE active."order_id" = NEW."id"
             AND active."order_price_binding_id" = NEW."accepted_order_price_binding_id"
             AND NEW."accepted_terms_revision" = list."terms_revision"
       ) THEN
        RAISE EXCEPTION 'checkout acceptance must match the bound PriceList terms revision'
            USING ERRCODE = '23514', CONSTRAINT = 'order_checkout_acceptance_terms_revision_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "orders_price_list_terms_acceptance_valid"
BEFORE UPDATE OF "status", "accepted_order_price_binding_id", "accepted_terms_revision"
ON "orders"
FOR EACH ROW EXECUTE FUNCTION taven_require_price_list_terms_acceptance();

-- The foundation status trigger predates the post-QC balance state. Keep it
-- authoritative for every existing edge and isolate the two new edges in a
-- narrowly scoped validator.
DROP TRIGGER "orders_status_transitions_valid" ON "orders";

CREATE TRIGGER "orders_status_transitions_valid_insert"
BEFORE INSERT ON "orders"
FOR EACH ROW EXECUTE FUNCTION taven_validate_order_status_transition();

CREATE TRIGGER "orders_status_transitions_valid_update"
BEFORE UPDATE OF "id", "public_reference", "status", "quoted_at", "confirmed_at",
    "accepted_order_price_binding_id", "accepted_terms_revision",
    "accepted_claim_policy_revision", "withdrawal_exception_acknowledged_at", "created_at"
ON "orders"
FOR EACH ROW
WHEN (
    NOT (
        (OLD."status" = 'QC_PASSED' AND NEW."status" = 'AWAITING_BALANCE')
        OR (OLD."status" = 'AWAITING_BALANCE'
            AND NEW."status" IN ('READY_TO_SHIP', 'CANCELLED_SETTLED'))
    )
)
EXECUTE FUNCTION taven_validate_order_status_transition();

CREATE FUNCTION taven_validate_balance_order_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."public_reference" IS DISTINCT FROM OLD."public_reference"
       OR NEW."customer_id" IS DISTINCT FROM OLD."customer_id"
       OR NEW."quoted_at" IS DISTINCT FROM OLD."quoted_at"
       OR NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
       OR NEW."accepted_order_price_binding_id" IS DISTINCT FROM OLD."accepted_order_price_binding_id"
       OR NEW."accepted_terms_revision" IS DISTINCT FROM OLD."accepted_terms_revision"
       OR NEW."accepted_claim_policy_revision" IS DISTINCT FROM OLD."accepted_claim_policy_revision"
       OR NEW."withdrawal_exception_acknowledged_at" IS DISTINCT FROM OLD."withdrawal_exception_acknowledged_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'balance lifecycle transitions cannot change order identity or acceptance evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'order_balance_transition_identity_check';
    END IF;

    IF NOT (
        (OLD."status" = 'QC_PASSED' AND NEW."status" = 'AWAITING_BALANCE')
        OR (OLD."status" = 'AWAITING_BALANCE'
            AND NEW."status" IN ('READY_TO_SHIP', 'CANCELLED_SETTLED'))
    ) THEN
        RAISE EXCEPTION 'order balance status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'order_status_transition_check';
    END IF;

    IF OLD."status" = 'AWAITING_BALANCE'
       AND NEW."status" = 'CANCELLED_SETTLED'
       AND NOT EXISTS (
           SELECT 1 FROM "order_settlements" settlement
           WHERE settlement."order_id" = NEW."id"
             AND settlement."kind" = 'BALANCE_SETTLEMENT'
       ) THEN
        RAISE EXCEPTION 'cancelled-settled balance order requires its immutable settlement'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_timeout_settlement_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "orders_balance_status_transitions_valid"
BEFORE UPDATE OF "id", "customer_id", "public_reference", "status", "quoted_at", "confirmed_at",
    "accepted_order_price_binding_id", "accepted_terms_revision",
    "accepted_claim_policy_revision", "withdrawal_exception_acknowledged_at", "created_at"
ON "orders"
FOR EACH ROW
WHEN (
    (OLD."status" = 'QC_PASSED' AND NEW."status" = 'AWAITING_BALANCE')
    OR (OLD."status" = 'AWAITING_BALANCE'
        AND NEW."status" IN ('READY_TO_SHIP', 'CANCELLED_SETTLED'))
)
EXECUTE FUNCTION taven_validate_balance_order_status_transition();

-- The foundation phase trigger predates the balance-settlement terminal phase.
-- Preserve it on every established edge and admit only the immutable
-- cancellation disposition used by the refund-success finalizer below.
DROP TRIGGER "order_phases_lifecycle_protected" ON "order_phases";

CREATE FUNCTION taven_validate_balance_settled_phase_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."status" <> 'CANCELLED'
       OR NEW."status" <> 'CANCELLED_SETTLED'
       OR NEW."cancelled_at" IS NULL
       OR (to_jsonb(NEW) - 'status' - 'updated_at')
          IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
        RAISE EXCEPTION 'balance settlement may only terminally dispose an unchanged cancelled phase'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_status_transition_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_phases_lifecycle_protected_insert_delete"
BEFORE INSERT OR DELETE ON "order_phases"
FOR EACH ROW EXECUTE FUNCTION taven_protect_order_phase_lifecycle();

CREATE TRIGGER "order_phases_lifecycle_protected_update"
BEFORE UPDATE ON "order_phases"
FOR EACH ROW
WHEN (NOT (OLD."status" = 'CANCELLED' AND NEW."status" = 'CANCELLED_SETTLED'))
EXECUTE FUNCTION taven_protect_order_phase_lifecycle();

CREATE TRIGGER "order_phases_balance_settled_transition_valid"
BEFORE UPDATE ON "order_phases"
FOR EACH ROW
WHEN (OLD."status" = 'CANCELLED' AND NEW."status" = 'CANCELLED_SETTLED')
EXECUTE FUNCTION taven_validate_balance_settled_phase_transition();

DROP TRIGGER "orders_post_confirmation_lifecycle_reconciled" ON "orders";
CREATE CONSTRAINT TRIGGER "orders_post_confirmation_lifecycle_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."status" NOT IN ('AWAITING_BALANCE', 'CANCELLED_SETTLED'))
EXECUTE FUNCTION taven_reconcile_order_post_confirmation_lifecycle();

-- Preserve the complete foundation lifecycle contract while routing the new
-- balance-settlement terminal state to its dedicated deferred validator.
CREATE OR REPLACE FUNCTION taven_reconcile_order_post_confirmation_lifecycle()
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

    -- Awaiting the balance payment is a live post-QC state with its own
    -- readiness and timeout reconciliation; the foundation lifecycle has no
    -- branch for it, but child cancellation updates still fire this trigger.
    IF target_status = 'AWAITING_BALANCE' THEN
        RETURN NULL;
    END IF;

    -- The dedicated balance-timeout constraint below validates this terminal
    -- state, including the phase disposition and completed refund lineage.
    IF target_status = 'CANCELLED_SETTLED'
       AND EXISTS (
           SELECT 1
           FROM "order_settlements" settlement
           WHERE settlement."order_id" = target_order_id
             AND settlement."kind" = 'BALANCE_SETTLEMENT'
       ) THEN
        RETURN NULL;
    END IF;

    IF target_status IN ('SHIPPED', 'DELIVERED', 'COMPLETED')
       AND EXISTS (
           SELECT 1
           FROM "payments" payment
           JOIN "refund_transactions" refund
             ON refund."payment_id" = payment."id"
           WHERE payment."order_id" = target_order_id
             AND payment."status" = 'REFUNDED'
             AND refund."reason" = 'CUSTOMER_CANCELLATION'
             AND refund."status" = 'SUCCEEDED'
       )
       AND NOT taven_has_refunded_post_void_handoff_reconciliation(
           target_order_id
       ) THEN
        RAISE EXCEPTION 'fulfilled order with a completed cancellation refund requires exact immutable handoff reconciliation and settlement proof'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunded_handoff_reconciliation_check';
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
                  OR "carrier_label_id" IS NOT NULL
                  OR "tracking_code" IS NOT NULL
                  OR "label_created_at" IS NOT NULL
                  OR "cancellation_requested_at" IS NOT NULL
                  OR "provider_void_id" IS NOT NULL
                  OR "provider_voided_at" IS NOT NULL
                  OR "provider_acceptance_scan_id" IS NOT NULL
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
                  shipment."status" NOT IN ('LABEL_CREATED', 'CANCELLATION_PENDING')
                  OR shipment."carrier" IS NULL
                  OR shipment."provider_shipment_id" IS NULL
                  OR shipment."carrier_label_id" IS NULL
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
              AND shipment."status" NOT IN ('LABEL_CREATED', 'CANCELLATION_PENDING', 'HANDED_OVER', 'IN_TRANSIT', 'DELIVERED')
              AND NOT (
                  shipment."status" = 'CANCELLED'
                  AND taven_has_refunded_post_void_handoff_reconciliation(
                      target_order_id
                  )
              )
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
              AND NOT (
                  "status" = 'CANCELLED'
                  AND taven_has_refunded_post_void_handoff_reconciliation(
                      target_order_id
                  )
              )
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
             AND taven_split_payment_schedule_is_valid(
                 snapshot."id",
                 snapshot."contract_total_minor"
             )
             AND taven_price_snapshot_balance_deadline_is_valid(snapshot."id")
             AND taven_price_snapshot_balance_earned_policy_is_valid(snapshot."id")
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

-- Stable slots predate the canonical key. Suspend only their topology guard
-- inside one atomic statement for the deterministic one-time backfill.
DO $$
BEGIN
    EXECUTE 'ALTER TABLE "fulfilment_slots" DISABLE TRIGGER "fulfilment_slots_topology_protected"';

    UPDATE "fulfilment_slots" slot
    SET "packing_unit_key" = slot."order_item_id"::text
        || ':' || lower(phase."kind"::text)
        || ':' || slot."quantity_ordinal"::text
    FROM "order_phases" phase
    WHERE phase."id" = slot."order_phase_id"
      AND phase."order_id" = slot."order_id";

    EXECUTE 'ALTER TABLE "fulfilment_slots" ENABLE TRIGGER "fulfilment_slots_topology_protected"';
END;
$$;

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
    target_order_status "order_status";
BEGIN
    -- BALANCE capture is a post-QC readiness transition.  It must never
    -- recreate or reactivate the initial reservation topology.
    IF TG_TABLE_NAME = 'payments'
       AND (to_jsonb(NEW) ->> 'role') = 'BALANCE' THEN
        RETURN NULL;
    END IF;

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

    SELECT "status"
    INTO target_order_status
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
          AND taven_order_accepts_bound_price_list_terms(
              target_order."id", payment."order_price_binding_id"
          )
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
    balance_qc_passed_at timestamptz;
    balance_payment_days integer;
BEGIN
    IF NEW."status" <> 'CREATED' THEN
        RAISE EXCEPTION 'new payments must begin created'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_initial_status_check';
    END IF;

    IF NEW."role" = 'BALANCE' THEN
        IF NOT NEW."capture_authorized"
           OR NEW."capture_cutoff_at" IS NOT NULL
           OR NEW."checkout_capture_expires_at" IS NOT NULL
           OR NEW."balance_due_at" IS NULL
           OR NEW."balance_due_at" <= clock_timestamp() THEN
            RAISE EXCEPTION 'new balance payment requires an open post-QC business deadline'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
        END IF;

        PERFORM 1
        FROM "orders"
        WHERE "id" = NEW."order_id"
        FOR UPDATE;

        SELECT phase."qc_passed_at",
               CASE
                   WHEN jsonb_typeof(list."parameters" -> 'balance_payment_days') = 'number'
                    AND (list."parameters" ->> 'balance_payment_days') ~ '^[1-9][0-9]*$'
                   THEN (list."parameters" ->> 'balance_payment_days')::integer
               END
        INTO balance_qc_passed_at, balance_payment_days
        FROM "orders" target_order
        JOIN "individual_order_origins" origin
          ON origin."order_id" = target_order."id"
        JOIN "order_active_price_bindings" active
          ON active."order_id" = target_order."id"
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
         AND binding."order_id" = target_order."id"
        JOIN "price_snapshots" snapshot
          ON snapshot."id" = binding."price_snapshot_id"
        JOIN "price_lists" list
          ON list."id" = snapshot."price_list_id"
        JOIN "payment_schedules" schedule
          ON schedule."id" = NEW."payment_schedule_id"
         AND schedule."price_snapshot_id" = snapshot."id"
         AND schedule."role" = 'BALANCE'
        JOIN "order_phases" phase
          ON phase."order_id" = target_order."id"
         AND phase."kind" = 'SINGLE'
         AND phase."status" = 'QC_PASSED'
         AND phase."qc_passed_at" IS NOT NULL
        WHERE target_order."id" = NEW."order_id"
          AND target_order."status" IN ('QC_PASSED', 'AWAITING_BALANCE')
          AND target_order."customer_id" IS NOT NULL
          AND target_order."accepted_order_price_binding_id" = binding."id"
          AND target_order."accepted_terms_revision" IS NOT NULL
          AND taven_order_accepts_bound_price_list_terms(
              target_order."id", binding."id"
          )
          AND target_order."accepted_claim_policy_revision" IS NOT NULL
          AND target_order."withdrawal_exception_acknowledged_at" IS NOT NULL
          AND binding."id" = NEW."order_price_binding_id"
          AND binding."price_snapshot_id" = NEW."price_snapshot_id"
          AND binding."invalidated_at" IS NULL
          AND snapshot."currency" = NEW."currency"
          AND (
              SELECT count(*)
              FROM "order_phases" single_phase
              WHERE single_phase."order_id" = target_order."id"
                AND single_phase."kind" = 'SINGLE'
          ) = 1
          AND EXISTS (
              SELECT 1
              FROM "payments" deposit
              JOIN "payment_schedules" deposit_schedule
                ON deposit_schedule."id" = deposit."payment_schedule_id"
               AND deposit_schedule."price_snapshot_id" = deposit."price_snapshot_id"
               AND deposit_schedule."role" = 'DEPOSIT'
              WHERE deposit."order_id" = target_order."id"
                AND deposit."order_price_binding_id" = binding."id"
                AND deposit."price_snapshot_id" = snapshot."id"
                AND deposit."status" = 'CAPTURED'
                AND deposit."captured_amount_minor" = deposit."requested_amount_minor"
          )
          AND NOT EXISTS (
              SELECT 1 FROM "order_settlements" settlement
              WHERE settlement."order_id" = target_order."id"
          );

        IF balance_qc_passed_at IS NULL OR balance_payment_days IS NULL THEN
            RAISE EXCEPTION 'balance payment requires the accepted post-QC split-payment topology'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_fulfilment_topology_check';
        END IF;

        IF NEW."balance_due_at" IS DISTINCT FROM
           balance_qc_passed_at + make_interval(days => balance_payment_days) THEN
            RAISE EXCEPTION 'balance deadline must derive from QC and the accepted PriceList'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
        END IF;

        PERFORM taven_assert_order_fulfilment_money(NEW."order_id");
        RETURN NEW;
    END IF;

    IF NOT NEW."capture_authorized"
       OR NEW."capture_cutoff_at" IS NOT NULL
       OR NEW."balance_due_at" IS NOT NULL
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
          AND taven_order_accepts_bound_price_list_terms(
              target_order."id", NEW."order_price_binding_id"
          )
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

-- QC completion owns the durable balance deadline. Provider intent creation is
-- deliberately asynchronous, but it must always start from this CREATED row so
-- a crash cannot leave an individual order without timeout work.
CREATE FUNCTION taven_create_post_qc_balance_payment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "individual_order_origins" origin
        WHERE origin."order_id" = NEW."id"
    ) THEN
        RETURN NULL;
    END IF;

    INSERT INTO "payments" (
        "id", "order_id", "price_snapshot_id", "order_price_binding_id",
        "payment_schedule_id", "role", "provider", "requested_amount_minor",
        "currency", "status", "balance_due_at", "created_at", "updated_at"
    )
    SELECT gen_random_uuid(), target_order."id", snapshot."id", binding."id",
           balance_schedule."id", 'BALANCE', deposit."provider",
           balance_schedule."gross_amount_minor", snapshot."currency", 'CREATED',
           phase."qc_passed_at"
               + make_interval(
                   days => (list."parameters" ->> 'balance_payment_days')::integer
                 ),
           phase."qc_passed_at", phase."qc_passed_at"
    FROM "orders" target_order
    JOIN "individual_order_origins" origin
      ON origin."order_id" = target_order."id"
    JOIN "order_phases" phase
      ON phase."order_id" = target_order."id"
     AND phase."kind" = 'SINGLE'
     AND phase."status" = 'QC_PASSED'
     AND phase."qc_passed_at" IS NOT NULL
    JOIN "order_active_price_bindings" active
      ON active."order_id" = target_order."id"
    JOIN "order_price_bindings" binding
      ON binding."id" = active."order_price_binding_id"
     AND binding."order_id" = target_order."id"
     AND binding."invalidated_at" IS NULL
    JOIN "price_snapshots" snapshot
      ON snapshot."id" = binding."price_snapshot_id"
    JOIN "price_lists" list
      ON list."id" = snapshot."price_list_id"
    JOIN "payment_schedules" balance_schedule
      ON balance_schedule."price_snapshot_id" = snapshot."id"
     AND balance_schedule."role" = 'BALANCE'
     AND balance_schedule."sequence" = 1
     AND balance_schedule."gross_amount_minor" > 0
    JOIN "payments" deposit
      ON deposit."order_id" = target_order."id"
     AND deposit."order_price_binding_id" = binding."id"
     AND deposit."price_snapshot_id" = snapshot."id"
     AND deposit."role" = 'DEPOSIT'
     AND deposit."status" = 'CAPTURED'
     AND deposit."captured_amount_minor" = deposit."requested_amount_minor"
    WHERE target_order."id" = NEW."id"
      AND target_order."status" = 'QC_PASSED'
      AND target_order."accepted_order_price_binding_id" = binding."id"
      AND taven_order_accepts_bound_price_list_terms(
          target_order."id", binding."id"
      )
      AND taven_price_snapshot_balance_deadline_is_valid(snapshot."id")
      AND taven_price_snapshot_balance_earned_policy_is_valid(snapshot."id")
      AND NOT EXISTS (
          SELECT 1
          FROM "order_settlements" settlement
          WHERE settlement."order_id" = target_order."id"
      );

    IF NOT FOUND THEN
        RAISE EXCEPTION 'individual QC completion requires its durable balance deadline payment'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_payment_qc_creation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE TRIGGER "orders_qc_balance_payment_created"
AFTER UPDATE OF "status" ON "orders"
FOR EACH ROW
WHEN (OLD."status" = 'IN_PRODUCTION' AND NEW."status" = 'QC_PASSED')
EXECUTE FUNCTION taven_create_post_qc_balance_payment();

-- A BALANCE capture completes the commercial obligation after QC.  It has a
-- distinct deferred reconciliation because the initial FULL/DEPOSIT capture
-- owns reservation activation and must never run a second time.
CREATE FUNCTION taven_reconcile_balance_payment_readiness()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_payment_id uuid;
    target_order_status "order_status";
BEGIN
    IF TG_TABLE_NAME = 'payments' THEN
        IF (to_jsonb(NEW) ->> 'role') <> 'BALANCE' THEN
            RETURN NULL;
        END IF;
        target_order_id := (to_jsonb(NEW) ->> 'order_id')::uuid;
        target_payment_id := (to_jsonb(NEW) ->> 'id')::uuid;
    ELSE
        target_order_id := (to_jsonb(NEW) ->> 'id')::uuid;
    END IF;

    SELECT "status" INTO target_order_status
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    -- FULL-only orders do not participate in this post-QC branch.
    IF NOT EXISTS (
        SELECT 1
        FROM "order_active_price_bindings" active
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
        JOIN "payment_schedules" schedule
          ON schedule."price_snapshot_id" = binding."price_snapshot_id"
         AND schedule."role" = 'BALANCE'
        WHERE active."order_id" = target_order_id
    ) THEN
        RETURN NULL;
    END IF;

    IF TG_TABLE_NAME = 'orders'
       AND (to_jsonb(OLD) ->> 'status') = 'QC_PASSED'
       AND (to_jsonb(NEW) ->> 'status') = 'READY_TO_SHIP' THEN
        RAISE EXCEPTION 'split-payment orders must enter awaiting balance before readiness'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_payment_readiness_check';
    END IF;

    IF target_order_status IN ('AWAITING_BALANCE', 'CANCELLED_SETTLED')
       AND EXISTS (
           SELECT 1
           FROM "order_settlements" settlement
           JOIN "order_phases" phase
             ON phase."id" = settlement."order_phase_id"
            AND phase."order_id" = settlement."order_id"
            AND phase."status" IN ('CANCELLED', 'CANCELLED_SETTLED')
           JOIN "payments" balance
             ON balance."id" = settlement."balance_payment_id"
            AND balance."order_id" = settlement."order_id"
            AND balance."order_price_binding_id" = settlement."order_price_binding_id"
            AND balance."price_snapshot_id" = settlement."price_snapshot_id"
            AND balance."role" = 'BALANCE'
           WHERE settlement."order_id" = target_order_id
             AND settlement."kind" = 'BALANCE_SETTLEMENT'
             AND (target_payment_id IS NULL OR balance."id" = target_payment_id)
             AND taven_balance_payment_is_closed_for_timeout(
                 balance."id", settlement."cutoff_at"
             )
       ) THEN
        RETURN NULL;
    END IF;

    IF target_order_status = 'AWAITING_BALANCE' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "orders" target_order
            JOIN "individual_order_origins" origin
              ON origin."order_id" = target_order."id"
            JOIN "order_phases" phase
              ON phase."order_id" = target_order."id"
             AND phase."kind" = 'SINGLE'
             AND phase."status" = 'QC_PASSED'
             AND phase."qc_passed_at" IS NOT NULL
            JOIN "order_active_price_bindings" active
              ON active."order_id" = target_order."id"
            JOIN "order_price_bindings" binding
              ON binding."id" = active."order_price_binding_id"
             AND binding."order_id" = target_order."id"
             AND binding."invalidated_at" IS NULL
            JOIN "price_snapshots" snapshot
              ON snapshot."id" = binding."price_snapshot_id"
            JOIN "price_lists" list
              ON list."id" = snapshot."price_list_id"
            JOIN "payments" balance
              ON balance."order_id" = target_order."id"
             AND balance."order_price_binding_id" = binding."id"
             AND balance."price_snapshot_id" = binding."price_snapshot_id"
             AND balance."role" = 'BALANCE'
             AND balance."status" = 'PENDING'
             AND balance."provider_intent_id" IS NOT NULL
             AND balance."provider_intent_id" ~ '[^[:space:]]'
             AND balance."capture_authorized"
             AND balance."capture_cutoff_at" IS NULL
             AND balance."checkout_capture_expires_at" IS NULL
             AND balance."balance_due_at" = phase."qc_passed_at"
                 + make_interval(days => (list."parameters" ->> 'balance_payment_days')::integer)
             AND balance."balance_due_at" > clock_timestamp()
            WHERE target_order."id" = target_order_id
              AND target_order."accepted_order_price_binding_id" = binding."id"
              AND taven_order_accepts_bound_price_list_terms(
                  target_order."id", binding."id"
              )
              AND EXISTS (
                  SELECT 1
                  FROM "payments" deposit
                  WHERE deposit."order_id" = target_order."id"
                    AND deposit."order_price_binding_id" = binding."id"
                    AND deposit."price_snapshot_id" = binding."price_snapshot_id"
                    AND deposit."role" = 'DEPOSIT'
                    AND deposit."status" = 'CAPTURED'
                    AND deposit."captured_amount_minor" = deposit."requested_amount_minor"
              )
              AND (
                  SELECT count(*) FROM "payments" candidate
                  WHERE candidate."order_id" = target_order."id"
                    AND candidate."role" = 'BALANCE'
                    AND candidate."status" <> 'FAILED'
              ) = 1
              AND EXISTS (
                  SELECT 1 FROM "jobs" job
                  WHERE job."order_id" = target_order."id"
              )
              AND NOT EXISTS (
                  SELECT 1 FROM "jobs" job
                  WHERE job."order_id" = target_order."id"
                    AND (job."status" <> 'QC_APPROVED'
                         OR job."qc_approved_at" IS NULL)
              )
              AND NOT EXISTS (
                  SELECT 1 FROM "shipments" shipment
                  WHERE shipment."order_id" = target_order."id"
                    AND shipment."status" <> 'PLANNED'
                    AND NOT EXISTS (
                        SELECT 1 FROM "shipments" replacement
                        WHERE replacement."replaces_shipment_id" = shipment."id"
                    )
              )
              AND NOT EXISTS (
                  SELECT 1 FROM "fulfilment_slots" slot
                  WHERE slot."order_id" = target_order."id"
                    AND slot."outcome" <> 'PENDING'
              )
              AND NOT EXISTS (
                  SELECT 1 FROM "order_settlements" settlement
                  WHERE settlement."order_id" = target_order."id"
              )
        ) THEN
            RAISE EXCEPTION 'awaiting-balance order requires its exact pending post-QC payment topology'
                USING ERRCODE = '23514', CONSTRAINT = 'balance_payment_waiting_check';
        END IF;
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "individual_order_origins" origin
          ON origin."order_id" = target_order."id"
        JOIN "order_phases" phase
          ON phase."order_id" = target_order."id"
         AND phase."kind" = 'SINGLE'
         AND phase."status" = 'QC_PASSED'
         AND phase."qc_passed_at" IS NOT NULL
        JOIN "order_active_price_bindings" active
          ON active."order_id" = target_order."id"
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
         AND binding."order_id" = target_order."id"
         AND binding."invalidated_at" IS NULL
        JOIN "payments" balance
          ON balance."order_id" = target_order."id"
         AND balance."order_price_binding_id" = binding."id"
         AND balance."price_snapshot_id" = binding."price_snapshot_id"
         AND balance."role" = 'BALANCE'
         AND balance."status" = 'CAPTURED'
         AND balance."captured_amount_minor" = balance."requested_amount_minor"
         AND balance."captured_at" IS NOT NULL
         AND balance."balance_due_at" IS NOT NULL
         AND balance."captured_at" < balance."balance_due_at"
         AND balance."checkout_capture_expires_at" IS NULL
        JOIN "payment_schedules" balance_schedule
          ON balance_schedule."id" = balance."payment_schedule_id"
         AND balance_schedule."price_snapshot_id" = balance."price_snapshot_id"
         AND balance_schedule."role" = 'BALANCE'
         AND balance_schedule."gross_amount_minor" = balance."requested_amount_minor"
        WHERE target_order."id" = target_order_id
          AND target_order."status" = 'READY_TO_SHIP'
          AND target_order."accepted_order_price_binding_id" = binding."id"
          AND (target_payment_id IS NULL OR balance."id" = target_payment_id)
          AND EXISTS (
              SELECT 1
              FROM "payments" deposit
              WHERE deposit."order_id" = target_order."id"
                AND deposit."order_price_binding_id" = binding."id"
                AND deposit."price_snapshot_id" = binding."price_snapshot_id"
                AND deposit."role" = 'DEPOSIT'
                AND deposit."status" = 'CAPTURED'
                AND deposit."captured_amount_minor" = deposit."requested_amount_minor"
          )
          AND NOT EXISTS (
              SELECT 1 FROM "order_settlements" settlement
              WHERE settlement."order_id" = target_order."id"
          )
    ) THEN
        RAISE EXCEPTION 'balance capture requires atomic post-QC payment and ready-to-ship reconciliation'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_payment_readiness_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_balance_readiness_reconciled"
AFTER UPDATE OF "status" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
    OLD."status" = 'PENDING'
    AND NEW."status" = 'CAPTURED'
    AND NEW."role" = 'BALANCE'
)
EXECUTE FUNCTION taven_reconcile_balance_payment_readiness();

CREATE CONSTRAINT TRIGGER "payments_balance_waiting_reconciled"
AFTER UPDATE OF "status" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."role" = 'BALANCE' AND NEW."status" = 'PENDING')
EXECUTE FUNCTION taven_reconcile_balance_payment_readiness();

CREATE CONSTRAINT TRIGGER "orders_balance_readiness_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
    (OLD."status" = 'QC_PASSED'
     AND NEW."status" IN ('AWAITING_BALANCE', 'READY_TO_SHIP'))
    OR (OLD."status" = 'AWAITING_BALANCE'
        AND NEW."status" = 'READY_TO_SHIP')
)
EXECUTE FUNCTION taven_reconcile_balance_payment_readiness();

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
           ))
           OR (NEW."role" = 'BALANCE' AND (
               NEW."checkout_capture_expires_at" IS NOT NULL
               OR NEW."balance_due_at" IS NULL
               OR NEW."balance_due_at" <= clock_timestamp()
               OR NOT EXISTS (
                   SELECT 1
                   FROM "orders" target_order
                   WHERE target_order."id" = NEW."order_id"
                     AND target_order."status" IN ('AWAITING_BALANCE', 'READY_TO_SHIP')
                     AND NOT EXISTS (
                         SELECT 1 FROM "order_settlements" settlement
                         WHERE settlement."order_id" = target_order."id"
                     )
               )
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
       OR NEW."balance_due_at" IS DISTINCT FROM OLD."balance_due_at"
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

-- Late-capture refunds need one additional terminal source: an immutable
-- balance settlement. Preserve every foundation refund safeguard while
-- extending only the terminal-cutoff predicates for that source.
CREATE OR REPLACE FUNCTION taven_validate_refund_against_capture()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    captured_amount bigint;
    committed_refunds bigint;
    payment_capture_authorized boolean;
    payment_capture_cutoff_at timestamptz;
    payment_captured_at timestamptz;
    payment_failed_before_capture boolean;
    target_order_status "order_status";
    balance_settled boolean;
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT payment."order_id"
        INTO target_order_id
        FROM "payments" payment
        WHERE payment."id" = NEW."payment_id";

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Refund parent Payment does not exist'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_captured_payment_check';
        END IF;

        PERFORM taven_lock_automatic_order_session(target_order_id);

        PERFORM 1
        FROM "orders" target_order
        WHERE target_order."id" = target_order_id
        FOR UPDATE;

        PERFORM 1
        FROM "order_phases" phase
        WHERE phase."order_id" = target_order_id
        ORDER BY phase."id"
        FOR UPDATE;
    END IF;

    SELECT payment."captured_amount_minor", payment."capture_authorized",
           payment."capture_cutoff_at", payment."captured_at",
           EXISTS (
               SELECT 1
               FROM "payment_provider_events" event
               WHERE event."payment_id" = payment."id"
                 AND event."refund_transaction_id" IS NULL
                 AND event."provider" = payment."provider"
                 AND event."kind" = 'PAYMENT_FAILED'
                 AND event."provider_transaction_id" = payment."provider_intent_id"
                 AND event."amount_minor" = payment."requested_amount_minor"
                 AND event."currency" = payment."currency"
                 AND event."verified_at" = payment."capture_cutoff_at"
           ), target_order."status",
           EXISTS (
               SELECT 1
               FROM "order_settlements" settlement
               WHERE settlement."order_id" = target_order."id"
                 AND settlement."kind" = 'BALANCE_SETTLEMENT'
                 AND settlement."balance_payment_id" = payment."id"
                 AND settlement."cutoff_at" = payment."capture_cutoff_at"
                 AND payment."role" = 'BALANCE'
           )
    INTO captured_amount, payment_capture_authorized,
         payment_capture_cutoff_at, payment_captured_at,
         payment_failed_before_capture, target_order_status,
         balance_settled
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

    IF NEW."requested_at" < payment_captured_at - interval '5 seconds'
       OR (NEW."completed_at" IS NOT NULL
           AND NEW."completed_at" < payment_captured_at - interval '5 seconds') THEN
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
        OR (
            target_order_status NOT IN ('EXPIRED', 'CANCELLED')
            AND NOT payment_failed_before_capture
            AND NOT (
                target_order_status IN ('AWAITING_BALANCE', 'CANCELLED_SETTLED')
                AND balance_settled
            )
        )
        OR NEW."amount_minor" <> captured_amount - committed_refunds
    ) THEN
        RAISE EXCEPTION 'late-capture compensation requires the full remaining capture after a terminal cutoff'
            USING ERRCODE = '23514', CONSTRAINT = 'late_capture_compensation_check';
    END IF;

    IF NOT payment_capture_authorized
       AND payment_capture_cutoff_at IS NOT NULL
       AND payment_captured_at >= payment_capture_cutoff_at
       AND (
           target_order_status IN ('EXPIRED', 'CANCELLED')
           OR payment_failed_before_capture
           OR (
               target_order_status IN ('AWAITING_BALANCE', 'CANCELLED_SETTLED')
               AND balance_settled
           )
       )
       AND NEW."reason" <> 'LATE_CAPTURE_COMPENSATION' THEN
        RAISE EXCEPTION 'a capture after a terminal cutoff requires late-capture compensation'
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

-- Provider-declined attempts retain their FAILED status through timeout
-- settlement and possible late-capture compensation, so expose their immutable
-- evidence independently of the Payment's current status.
CREATE FUNCTION taven_balance_payment_has_verified_provider_failure(
    target_payment_id uuid
)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "payments" balance
        WHERE balance."id" = target_payment_id
          AND balance."role" = 'BALANCE'
          AND NOT balance."capture_authorized"
          AND balance."capture_cutoff_at" IS NOT NULL
          AND balance."provider_intent_id" IS NOT NULL
          AND balance."provider_intent_id" ~ '[^[:space:]]'
          AND EXISTS (
              SELECT 1
              FROM "payment_provider_events" event
              WHERE event."payment_id" = balance."id"
                AND event."refund_transaction_id" IS NULL
                AND event."provider" = balance."provider"
                AND event."kind" = 'PAYMENT_FAILED'
                AND event."provider_transaction_id" = balance."provider_intent_id"
                AND event."amount_minor" = balance."requested_amount_minor"
                AND event."currency" = balance."currency"
                AND event."verified_at" = balance."capture_cutoff_at"
          )
    );
$$;

-- A timeout can close an open balance attempt or a FAILED attempt backed by
-- immutable provider evidence. A failed attempt has no open authorization to
-- void and therefore keeps its FAILED audit state.
CREATE FUNCTION taven_balance_payment_is_closed_for_timeout(
    target_payment_id uuid,
    target_cutoff_at timestamptz
)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "payments" balance
        WHERE balance."id" = target_payment_id
          AND balance."role" = 'BALANCE'
          AND NOT balance."capture_authorized"
          AND balance."balance_due_at" IS NOT NULL
          AND balance."balance_due_at" <= target_cutoff_at
          AND (
              (
                  balance."status" = 'VOIDED'
                  AND balance."capture_cutoff_at" = target_cutoff_at
              )
              OR (
                  balance."status" = 'FAILED'
                  AND balance."capture_cutoff_at" <= target_cutoff_at
                  AND (
                      (
                          balance."provider_intent_id" IS NULL
                          AND EXISTS (
                              SELECT 1
                              FROM "payment_intent_creation_failures" failure
                              WHERE failure."id" = balance."intent_creation_failure_result_id"
                                AND failure."payment_id" = balance."id"
                                AND failure."provider" = balance."provider"
                                AND failure."outcome" = 'FAILED'
                                AND failure."provider_intent_id" IS NULL
                                AND failure."failed_at" = balance."capture_cutoff_at"
                          )
                      )
                      OR taven_balance_payment_has_verified_provider_failure(
                          balance."id"
                      )
                  )
              )
          )
    );
$$;

CREATE FUNCTION taven_reconcile_balance_timeout_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "individual_order_origins" origin
          ON origin."order_id" = target_order."id"
        JOIN "order_phases" phase
          ON phase."order_id" = target_order."id"
         AND phase."kind" = 'SINGLE'
         AND phase."status" = 'CANCELLED'
         AND phase."cancelled_at" IS NOT NULL
        JOIN "order_settlements" settlement
          ON settlement."order_id" = target_order."id"
         AND settlement."order_phase_id" = phase."id"
         AND settlement."kind" = 'BALANCE_SETTLEMENT'
        JOIN "payments" deposit
          ON deposit."id" = settlement."payment_id"
         AND deposit."order_id" = target_order."id"
         AND deposit."role" = 'DEPOSIT'
         AND deposit."status" = 'REFUND_PENDING'
         AND deposit."captured_amount_minor" = settlement."captured_total_minor"
        JOIN "refund_transactions" refund
          ON refund."id" = settlement."refund_transaction_id"
         AND refund."payment_id" = deposit."id"
         AND refund."reason" = 'BALANCE_SETTLEMENT'
         AND refund."status" = 'PENDING'
         AND refund."amount_minor" = settlement."refund_amount_minor"
        JOIN "payments" balance
          ON balance."order_id" = target_order."id"
         AND balance."order_price_binding_id" = settlement."order_price_binding_id"
         AND balance."price_snapshot_id" = settlement."price_snapshot_id"
         AND balance."role" = 'BALANCE'
         AND balance."status" = 'VOIDED'
         AND NOT balance."capture_authorized"
         AND balance."capture_cutoff_at" = settlement."cutoff_at"
         AND balance."balance_due_at" <= settlement."cutoff_at"
        WHERE target_order."id" = NEW."id"
          AND target_order."status" = 'CANCELLED_SETTLED'
          AND target_order."accepted_order_price_binding_id" = settlement."order_price_binding_id"
          AND NOT EXISTS (
              SELECT 1 FROM "jobs" job
              WHERE job."order_id" = target_order."id"
                AND job."status" <> 'CANCELLED'
          )
          AND NOT EXISTS (
              SELECT 1 FROM "shipments" shipment
              WHERE shipment."order_id" = target_order."id"
                AND shipment."status" <> 'CANCELLED'
                AND NOT EXISTS (
                    SELECT 1 FROM "shipments" replacement
                    WHERE replacement."replaces_shipment_id" = shipment."id"
                )
          )
          AND NOT EXISTS (
              SELECT 1 FROM "fulfilment_slots" slot
              WHERE slot."order_id" = target_order."id"
                AND slot."outcome" <> 'CANCELLED'
          )
    ) THEN
        RAISE EXCEPTION 'cancelled-settled balance order requires its atomic timeout settlement'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_timeout_settlement_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_balance_timeout_settlement_reconciled"
AFTER UPDATE OF "status" ON "orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" = 'AWAITING_BALANCE' AND NEW."status" = 'CANCELLED_SETTLED')
EXECUTE FUNCTION taven_reconcile_balance_timeout_terminal();

CREATE FUNCTION taven_close_expired_balance_payment(
    target_payment_id uuid,
    target_cutoff_at timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    target_order_id uuid;
    target_order_status "order_status";
    target_phase_id uuid;
    target_binding_id uuid;
    target_snapshot_id uuid;
    target_currency char(3);
    target_balance_due_at timestamptz;
    target_balance_status "payment_status";
    target_deposit_id uuid;
    target_deposit_amount bigint;
    target_deposit_provider varchar(100);
    target_contract_total bigint;
    target_earned_amount bigint;
    target_retained_amount bigint;
    target_refund_amount bigint;
    target_refund_id uuid;
    target_settlement_id uuid := gen_random_uuid();
BEGIN
    SELECT payment."order_id"
    INTO target_order_id
    FROM "payments" payment
    WHERE payment."id" = target_payment_id;

    IF target_order_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT target_order."status"
    INTO target_order_status
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    IF target_order_status = 'CANCELLED_SETTLED' THEN
        RETURN (
            SELECT settlement."id"
            FROM "order_settlements" settlement
            WHERE settlement."order_id" = target_order_id
              AND settlement."kind" = 'BALANCE_SETTLEMENT'
        );
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "order_settlements" settlement
        WHERE settlement."order_id" = target_order_id
          AND settlement."kind" = 'BALANCE_SETTLEMENT'
    ) THEN
        RETURN (
            SELECT settlement."id"
            FROM "order_settlements" settlement
            WHERE settlement."order_id" = target_order_id
              AND settlement."kind" = 'BALANCE_SETTLEMENT'
        );
    END IF;

    SELECT phase."id"
    INTO target_phase_id
    FROM "order_phases" phase
    WHERE phase."order_id" = target_order_id
      AND phase."kind" = 'SINGLE'
    ORDER BY phase."id"
    FOR UPDATE;

    SELECT balance."order_price_binding_id", balance."price_snapshot_id",
           balance."currency", balance."balance_due_at", balance."status"
    INTO target_binding_id, target_snapshot_id, target_currency,
         target_balance_due_at, target_balance_status
    FROM "payments" balance
    WHERE balance."id" = target_payment_id
      AND balance."order_id" = target_order_id
      AND balance."role" = 'BALANCE'
    FOR UPDATE;

    IF target_order_status NOT IN ('QC_PASSED', 'AWAITING_BALANCE')
       OR target_phase_id IS NULL
       OR NOT (
           target_balance_status IN ('CREATED', 'PENDING')
           OR (
               target_balance_status = 'FAILED'
               AND taven_balance_payment_is_closed_for_timeout(
                   target_payment_id, target_cutoff_at
               )
           )
       )
       OR target_balance_due_at IS NULL
       OR target_balance_due_at > target_cutoff_at
       OR target_cutoff_at > clock_timestamp() + interval '5 seconds' THEN
        RETURN NULL;
    END IF;

    SELECT deposit."id", deposit."captured_amount_minor", deposit."provider",
           snapshot."contract_total_minor"
    INTO target_deposit_id, target_deposit_amount, target_deposit_provider,
         target_contract_total
    FROM "payments" deposit
    JOIN "price_snapshots" snapshot
      ON snapshot."id" = deposit."price_snapshot_id"
    WHERE deposit."order_id" = target_order_id
      AND deposit."order_price_binding_id" = target_binding_id
      AND deposit."price_snapshot_id" = target_snapshot_id
      AND deposit."role" = 'DEPOSIT'
      AND deposit."status" = 'CAPTURED'
      AND deposit."captured_amount_minor" = deposit."requested_amount_minor"
    FOR UPDATE OF deposit;

    IF target_deposit_id IS NULL OR target_deposit_amount IS NULL THEN
        RAISE EXCEPTION 'expired balance requires its captured deposit'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_timeout_settlement_check';
    END IF;

    IF NOT taven_price_snapshot_balance_earned_policy_is_valid(target_snapshot_id) THEN
        RAISE EXCEPTION 'expired balance requires an accepted earned-value policy'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_timeout_earned_policy_check';
    END IF;

    target_earned_amount := taven_balance_timeout_earned_amount(
        target_order_id, target_phase_id, target_binding_id, target_snapshot_id
    );
    IF target_earned_amount < 0 OR target_earned_amount > target_contract_total THEN
        RAISE EXCEPTION 'earned balance settlement amount is outside the accepted contract'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_timeout_settlement_check';
    END IF;
    target_retained_amount := least(target_deposit_amount, target_earned_amount);
    target_refund_amount := target_deposit_amount - target_retained_amount;

    UPDATE "payments"
    SET "status" = 'VOIDED', "capture_authorized" = false,
        "capture_cutoff_at" = target_cutoff_at, "updated_at" = target_cutoff_at
    WHERE "id" = target_payment_id
      AND "status" IN ('CREATED', 'PENDING');

    UPDATE "phase_reservation_sets" reservation_set
    SET "status" = 'SETTLED', "updated_at" = target_cutoff_at
    FROM "phase_resource_plans" resource_plan
    WHERE reservation_set."phase_resource_plan_id" = resource_plan."id"
      AND reservation_set."node_id" = resource_plan."node_id"
      AND resource_plan."order_phase_id" = target_phase_id
      AND reservation_set."status" = 'HELD';

    UPDATE "jobs"
    SET "status" = 'CANCELLED', "cancelled_at" = target_cutoff_at,
        "cancellation_reason" = 'ORDER_CANCELLED', "updated_at" = target_cutoff_at
    WHERE "order_id" = target_order_id
      AND "status" = 'QC_APPROVED';

    UPDATE "shipments"
    SET "status" = 'CANCELLED', "cancelled_at" = target_cutoff_at,
        "updated_at" = target_cutoff_at
    WHERE "order_id" = target_order_id
      AND "status" = 'PLANNED';

    UPDATE "fulfilment_slots"
    SET "outcome" = 'CANCELLED', "updated_at" = target_cutoff_at
    WHERE "order_id" = target_order_id
      AND "outcome" = 'PENDING';

    UPDATE "order_phases"
    SET "status" = 'CANCELLED', "cancelled_at" = target_cutoff_at,
        "updated_at" = target_cutoff_at
    WHERE "id" = target_phase_id
      AND "status" = 'QC_PASSED';

    IF target_refund_amount > 0 THEN
        target_refund_id := gen_random_uuid();
        INSERT INTO "refund_transactions" (
            "id", "payment_id", "idempotency_key", "provider", "amount_minor",
            "reason", "status", "requested_at", "created_at", "updated_at"
        ) VALUES (
            target_refund_id, target_deposit_id,
            'balance_settlement:' || target_order_id::text,
            target_deposit_provider, target_refund_amount,
            'BALANCE_SETTLEMENT', 'PENDING', target_cutoff_at,
            target_cutoff_at, target_cutoff_at
        );

        UPDATE "payments"
        SET "status" = 'REFUND_PENDING', "updated_at" = target_cutoff_at
        WHERE "id" = target_deposit_id;
    END IF;

    INSERT INTO "order_settlements" (
        "id", "order_id", "order_phase_id", "order_price_binding_id",
        "price_snapshot_id", "payment_id", "balance_payment_id", "refund_transaction_id", "kind",
        "currency", "contract_total_minor", "captured_total_minor",
        "earned_amount_minor", "retained_amount_minor", "refund_amount_minor",
        "written_off_amount_minor", "unearned_cancelled_amount_minor",
        "amount_due_minor", "refundable_balance_minor", "cutoff_at", "settled_at"
    ) VALUES (
        target_settlement_id, target_order_id, target_phase_id,
        target_binding_id, target_snapshot_id, target_deposit_id, target_payment_id,
        target_refund_id, 'BALANCE_SETTLEMENT', target_currency,
        target_contract_total, target_deposit_amount, target_earned_amount,
        target_retained_amount, target_refund_amount,
        greatest(0, target_earned_amount - target_deposit_amount),
        target_contract_total - target_earned_amount, 0,
        target_refund_amount, target_cutoff_at, target_cutoff_at
    );

    UPDATE "orders"
    SET "status" = 'AWAITING_BALANCE', "updated_at" = target_cutoff_at
    WHERE "id" = target_order_id
      AND "status" = 'QC_PASSED';

    PERFORM taven_finalize_balance_timeout_settlement(target_order_id, target_cutoff_at);

    RETURN target_settlement_id;
END;
$$;

CREATE FUNCTION taven_close_expired_balance_payments(batch_limit integer DEFAULT 100)
RETURNS TABLE(payment_id uuid, settlement_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
    candidate record;
BEGIN
    IF batch_limit < 1 OR batch_limit > 1000 THEN
        RAISE EXCEPTION 'balance timeout batch limit must be between 1 and 1000'
            USING ERRCODE = '22023';
    END IF;

    FOR candidate IN
        SELECT payment."id"
        FROM "orders" target_order
        JOIN LATERAL (
            SELECT attempt."id", attempt."balance_due_at"
            FROM "payments" attempt
            WHERE attempt."order_id" = target_order."id"
              AND attempt."role" = 'BALANCE'
              AND attempt."balance_due_at" <= clock_timestamp()
              AND (
                  (
                      attempt."status" IN ('CREATED', 'PENDING')
                      AND attempt."capture_authorized"
                      AND attempt."capture_cutoff_at" IS NULL
                  )
                  OR (
                      attempt."status" = 'FAILED'
                      AND taven_balance_payment_is_closed_for_timeout(
                          attempt."id", clock_timestamp()
                      )
                  )
              )
            ORDER BY
                (attempt."status" IN ('CREATED', 'PENDING')) DESC,
                attempt."created_at" DESC,
                attempt."id" DESC
            LIMIT 1
        ) payment ON true
        WHERE target_order."status" IN ('QC_PASSED', 'AWAITING_BALANCE')
          AND NOT EXISTS (
              SELECT 1
              FROM "order_settlements" settlement
              WHERE settlement."order_id" = target_order."id"
                AND settlement."kind" = 'BALANCE_SETTLEMENT'
          )
        ORDER BY payment."balance_due_at", payment."id"
        FOR UPDATE OF target_order SKIP LOCKED
        LIMIT batch_limit
    LOOP
        payment_id := candidate."id";
        settlement_id := taven_close_expired_balance_payment(payment_id);
        IF settlement_id IS NOT NULL THEN
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;

CREATE FUNCTION taven_balance_settlement_refund_completed(
    target_settlement_id uuid
)
RETURNS boolean LANGUAGE sql STABLE AS $$
    WITH RECURSIVE lineage AS (
        SELECT refund."id", refund."payment_id", refund."amount_minor", refund."status"
        FROM "order_settlements" settlement
        JOIN "refund_transactions" refund
          ON refund."id" = settlement."refund_transaction_id"
         AND refund."payment_id" = settlement."payment_id"
         AND refund."reason" = 'BALANCE_SETTLEMENT'
         AND refund."amount_minor" = settlement."refund_amount_minor"
        WHERE settlement."id" = target_settlement_id
        UNION ALL
        SELECT retry."id", retry."payment_id", retry."amount_minor", retry."status"
        FROM "refund_transactions" retry
        JOIN lineage source
          ON retry."replaces_refund_transaction_id" = source."id"
         AND retry."payment_id" = source."payment_id"
    ), totals AS (
        SELECT coalesce(sum("amount_minor") FILTER (
                   WHERE "status" = 'SUCCEEDED'
               ), 0) AS succeeded_amount,
               count(*) FILTER (
                   WHERE "status" IN ('PENDING', 'SUSPENDED')
               ) AS active_count
        FROM lineage
    )
    SELECT coalesce((
        SELECT CASE
            WHEN settlement."refund_amount_minor" = 0
                THEN settlement."refund_transaction_id" IS NULL
            ELSE settlement."refund_transaction_id" IS NOT NULL
                 AND totals.succeeded_amount = settlement."refund_amount_minor"
                 AND totals.active_count = 0
                 AND NOT taven_payment_has_suspended_refund_incident(
                     settlement."payment_id"
                 )
        END
        FROM "order_settlements" settlement
        CROSS JOIN totals
        WHERE settlement."id" = target_settlement_id
          AND settlement."kind" = 'BALANCE_SETTLEMENT'
    ), false);
$$;

CREATE FUNCTION taven_has_balance_late_capture_compensation(
    target_payment_id uuid,
    target_cutoff_at timestamptz
)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "payments" balance
        JOIN "refund_transactions" refund
          ON refund."payment_id" = balance."id"
         AND refund."reason" = 'LATE_CAPTURE_COMPENSATION'
         AND refund."amount_minor" = balance."requested_amount_minor"
        WHERE balance."id" = target_payment_id
          AND balance."role" = 'BALANCE'
          AND NOT balance."capture_authorized"
          AND balance."capture_cutoff_at" <= target_cutoff_at
          AND balance."captured_amount_minor" = balance."requested_amount_minor"
          AND balance."captured_at" >= balance."capture_cutoff_at"
          AND (
              balance."capture_cutoff_at" = target_cutoff_at
              OR taven_balance_payment_has_verified_provider_failure(
                  balance."id"
              )
          )
    );
$$;

CREATE FUNCTION taven_finalize_balance_timeout_settlement(
    target_order_id uuid,
    target_updated_at timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    settlement record;
BEGIN
    SELECT target_order."status", phase."status" AS phase_status,
           target_settlement.*, deposit."status" AS deposit_status,
           deposit."captured_amount_minor" AS deposit_captured_amount,
           balance."status" AS balance_status,
           balance."capture_authorized" AS balance_capture_authorized,
           balance."capture_cutoff_at" AS balance_capture_cutoff_at
    INTO settlement
    FROM "orders" target_order
    JOIN "order_phases" phase
      ON phase."order_id" = target_order."id" AND phase."kind" = 'SINGLE'
    JOIN "order_settlements" target_settlement
      ON target_settlement."order_id" = target_order."id"
     AND target_settlement."order_phase_id" = phase."id"
     AND target_settlement."kind" = 'BALANCE_SETTLEMENT'
    JOIN "payments" deposit
      ON deposit."id" = target_settlement."payment_id"
    JOIN "payments" balance
      ON balance."id" = target_settlement."balance_payment_id"
    WHERE target_order."id" = target_order_id
    FOR UPDATE OF target_order, phase, deposit, balance;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF settlement."status" = 'CANCELLED_SETTLED' THEN
        RETURN settlement."id";
    END IF;

    IF settlement."status" <> 'AWAITING_BALANCE'
       OR settlement.phase_status <> 'CANCELLED'
       OR NOT (
           taven_balance_payment_is_closed_for_timeout(
               settlement."balance_payment_id", settlement."cutoff_at"
           )
           OR taven_has_balance_late_capture_compensation(
               settlement."balance_payment_id", settlement."cutoff_at"
           )
       )
       OR NOT taven_balance_settlement_refund_completed(settlement."id") THEN
        RETURN NULL;
    END IF;

    IF settlement."refund_amount_minor" > 0 THEN
        UPDATE "payments"
        SET "status" = CASE
                WHEN settlement."refund_amount_minor" = settlement.deposit_captured_amount
                    THEN 'REFUNDED'::"payment_status"
                ELSE 'PARTIALLY_REFUNDED'::"payment_status"
            END,
            "updated_at" = target_updated_at
        WHERE "id" = settlement."payment_id";
    END IF;

    UPDATE "order_phases"
    SET "status" = 'CANCELLED_SETTLED', "updated_at" = target_updated_at
    WHERE "id" = settlement."order_phase_id" AND "status" = 'CANCELLED';

    UPDATE "orders"
    SET "status" = 'CANCELLED_SETTLED', "updated_at" = target_updated_at
    WHERE "id" = target_order_id AND "status" = 'AWAITING_BALANCE';

    RETURN settlement."id";
END;
$$;

CREATE OR REPLACE FUNCTION taven_reconcile_balance_timeout_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "individual_order_origins" origin
          ON origin."order_id" = target_order."id"
        JOIN "order_phases" phase
          ON phase."order_id" = target_order."id"
         AND phase."kind" = 'SINGLE'
         AND phase."status" = 'CANCELLED_SETTLED'
         AND phase."cancelled_at" IS NOT NULL
        JOIN "order_settlements" settlement
          ON settlement."order_id" = target_order."id"
         AND settlement."order_phase_id" = phase."id"
         AND settlement."kind" = 'BALANCE_SETTLEMENT'
        JOIN "payments" deposit
          ON deposit."id" = settlement."payment_id"
         AND deposit."order_id" = target_order."id"
         AND deposit."role" = 'DEPOSIT'
         AND deposit."captured_amount_minor" = settlement."captured_total_minor"
         AND deposit."status" = CASE
             WHEN settlement."refund_amount_minor" = 0 THEN 'CAPTURED'::"payment_status"
             WHEN settlement."refund_amount_minor" = settlement."captured_total_minor"
                 THEN 'REFUNDED'::"payment_status"
             ELSE 'PARTIALLY_REFUNDED'::"payment_status"
         END
        JOIN "payments" balance
          ON balance."id" = settlement."balance_payment_id"
         AND balance."order_id" = target_order."id"
         AND balance."role" = 'BALANCE'
         AND (
             taven_balance_payment_is_closed_for_timeout(
                 balance."id", settlement."cutoff_at"
             )
             OR taven_has_balance_late_capture_compensation(
                 balance."id", settlement."cutoff_at"
             )
         )
        WHERE target_order."id" = NEW."id"
          AND target_order."status" = 'CANCELLED_SETTLED'
          AND target_order."accepted_order_price_binding_id" = settlement."order_price_binding_id"
          AND taven_balance_settlement_refund_completed(settlement."id")
          AND NOT EXISTS (
              SELECT 1 FROM "jobs" job
              WHERE job."order_id" = target_order."id"
                AND job."status" <> 'CANCELLED'
          )
          AND NOT EXISTS (
              SELECT 1 FROM "shipments" shipment
              WHERE shipment."order_id" = target_order."id"
                AND shipment."status" <> 'CANCELLED'
          )
          AND NOT EXISTS (
              SELECT 1 FROM "fulfilment_slots" slot
              WHERE slot."order_id" = target_order."id"
                AND slot."outcome" <> 'CANCELLED'
          )
    ) THEN
        RAISE EXCEPTION 'cancelled-settled balance order requires a completed timeout settlement'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_timeout_settlement_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION taven_reconcile_balance_timeout_refund_finalization()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_order_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'payments' THEN
        target_order_id := NEW."order_id";
    ELSE
        SELECT payment."order_id" INTO target_order_id
        FROM "payments" payment WHERE payment."id" = NEW."payment_id";
    END IF;
    PERFORM taven_finalize_balance_timeout_settlement(target_order_id);
    RETURN NULL;
END;
$$;

CREATE TRIGGER "refunds_balance_timeout_finalized"
AFTER UPDATE OF "status" ON "refund_transactions"
FOR EACH ROW
WHEN (NEW."status" = 'SUCCEEDED')
EXECUTE FUNCTION taven_reconcile_balance_timeout_refund_finalization();

CREATE FUNCTION taven_record_late_balance_capture(
    target_payment_id uuid,
    target_provider_capture_id varchar(255),
    target_captured_at timestamptz
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    target_order_id uuid;
    target_refund_id uuid := gen_random_uuid();
    target_amount bigint;
    target_provider varchar(100);
BEGIN
    SELECT payment."order_id"
    INTO target_order_id
    FROM "payments" payment
    WHERE payment."id" = target_payment_id;

    PERFORM 1 FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    PERFORM 1 FROM "order_phases"
    WHERE "order_id" = target_order_id
    ORDER BY "id"
    FOR UPDATE;

    SELECT payment."requested_amount_minor", payment."provider"
    INTO target_amount, target_provider
    FROM "payments" payment
    JOIN "order_settlements" settlement
      ON settlement."order_id" = payment."order_id"
     AND settlement."kind" = 'BALANCE_SETTLEMENT'
     AND settlement."balance_payment_id" = payment."id"
     AND (
         (
             payment."status" = 'VOIDED'
             AND settlement."cutoff_at" = payment."capture_cutoff_at"
         )
         OR (
             payment."status" = 'FAILED'
             AND payment."capture_cutoff_at" <= settlement."cutoff_at"
             AND taven_balance_payment_has_verified_provider_failure(
                 payment."id"
             )
         )
     )
    JOIN "orders" target_order
      ON target_order."id" = payment."order_id"
     AND target_order."status" IN ('AWAITING_BALANCE', 'CANCELLED_SETTLED')
    WHERE payment."id" = target_payment_id
      AND payment."role" = 'BALANCE'
      AND NOT payment."capture_authorized"
      AND payment."capture_cutoff_at" IS NOT NULL
      AND target_captured_at >= payment."capture_cutoff_at"
      AND EXISTS (
          SELECT 1 FROM "payment_provider_events" event
          WHERE event."payment_id" = payment."id"
            AND event."refund_transaction_id" IS NULL
            AND event."provider" = payment."provider"
            AND event."kind" = 'PAYMENT_CAPTURED'
            AND event."provider_transaction_id" = target_provider_capture_id
            AND event."amount_minor" = payment."requested_amount_minor"
            AND event."currency" = payment."currency"
            AND event."verified_at" = target_captured_at
      )
    FOR UPDATE OF payment;

    IF target_amount IS NULL THEN
        RETURN (
            SELECT refund."id"
            FROM "refund_transactions" refund
            WHERE refund."payment_id" = target_payment_id
              AND refund."idempotency_key" =
                  'late_balance_capture:' || target_provider_capture_id
        );
    END IF;

    UPDATE "payments"
    SET "status" = 'REFUND_PENDING',
        "captured_amount_minor" = target_amount,
        "provider_capture_id" = target_provider_capture_id,
        "captured_at" = target_captured_at,
        "updated_at" = target_captured_at
    WHERE "id" = target_payment_id;

    INSERT INTO "refund_transactions" (
        "id", "payment_id", "idempotency_key", "provider", "amount_minor",
        "reason", "status", "requested_at", "created_at", "updated_at"
    ) VALUES (
        target_refund_id, target_payment_id,
        'late_balance_capture:' || target_provider_capture_id,
        target_provider, target_amount, 'LATE_CAPTURE_COMPENSATION',
        'PENDING', target_captured_at, target_captured_at, target_captured_at
    )
    ON CONFLICT ("payment_id", "idempotency_key") DO NOTHING;

    RETURN coalesce(
        (SELECT refund."id" FROM "refund_transactions" refund
         WHERE refund."payment_id" = target_payment_id
           AND refund."idempotency_key" =
               'late_balance_capture:' || target_provider_capture_id),
        target_refund_id
    );
END;
$$;
