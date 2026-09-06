-- Keep the accepted fulfilment PriceSnapshot immutable while maintaining the
-- current contractual total through its own linear, immutable revision chain.
-- Credits can then reduce amount_due without rewriting shipment topology.
CREATE TABLE "order_contract_price_revisions" (
    "id" uuid PRIMARY KEY,
    "order_id" uuid NOT NULL,
    "base_price_snapshot_id" uuid NOT NULL,
    "predecessor_id" uuid,
    "price_adjustment_id" uuid,
    "contract_total_minor" bigint NOT NULL,
    "tax_regime" "seller_tax_regime" NOT NULL,
    "vat_rate_basis_points" integer NOT NULL,
    "net_amount_minor" bigint NOT NULL,
    "vat_amount_minor" bigint NOT NULL,
    "currency" char(3) NOT NULL,
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "order_contract_price_revisions_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT,
    CONSTRAINT "order_contract_price_revisions_base_snapshot_id_fkey"
        FOREIGN KEY ("base_price_snapshot_id") REFERENCES "price_snapshots"("id") ON DELETE RESTRICT,
    CONSTRAINT "order_contract_price_revisions_predecessor_id_fkey"
        FOREIGN KEY ("predecessor_id") REFERENCES "order_contract_price_revisions"("id") ON DELETE RESTRICT,
    CONSTRAINT "order_contract_price_revisions_values_check" CHECK (
        "contract_total_minor" >= 0
        AND "vat_rate_basis_points" BETWEEN 0 AND 10000
        AND "net_amount_minor" >= 0
        AND "vat_amount_minor" >= 0
        AND "net_amount_minor" + "vat_amount_minor" = "contract_total_minor"
        AND (
            ("tax_regime" = 'NON_VAT_PAYER' AND "vat_rate_basis_points" = 0 AND "vat_amount_minor" = 0)
            OR ("tax_regime" = 'VAT_PAYER' AND "vat_rate_basis_points" > 0)
        )
        AND "currency" ~ '^[A-Z]{3}$'
    )
);
CREATE UNIQUE INDEX "order_contract_price_revisions_predecessor_id_key"
    ON "order_contract_price_revisions"("predecessor_id");
CREATE UNIQUE INDEX "order_contract_price_revisions_price_adjustment_id_key"
    ON "order_contract_price_revisions"("price_adjustment_id");
CREATE UNIQUE INDEX "order_contract_price_revisions_order_scope_key"
    ON "order_contract_price_revisions"("id", "order_id");
CREATE INDEX "order_contract_price_revisions_order_created_idx"
    ON "order_contract_price_revisions"("order_id", "created_at");

CREATE TABLE "order_active_contract_prices" (
    "order_id" uuid PRIMARY KEY,
    "contract_price_revision_id" uuid NOT NULL UNIQUE,
    CONSTRAINT "order_active_contract_prices_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT,
    CONSTRAINT "order_active_contract_prices_revision_scope_fkey"
        FOREIGN KEY ("contract_price_revision_id", "order_id")
        REFERENCES "order_contract_price_revisions"("id", "order_id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "order_active_contract_prices_revision_scope_key"
    ON "order_active_contract_prices"("contract_price_revision_id", "order_id");

ALTER TABLE "price_adjustments"
    ADD COLUMN "source_contract_price_id" uuid,
    ADD COLUMN "refund_required_minor" bigint;

-- No released application version could have written PriceAdjustment rows
-- between the immediately preceding migration and this one. Abort rather than
-- manufacture a contractual predecessor if that deployment invariant is false.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "price_adjustments") THEN
        RAISE EXCEPTION 'contract-price revision upgrade found pre-existing PriceAdjustment rows; migrate them with explicit evidence before deployment'
            USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_contract_upgrade_check';
    END IF;
END;
$$;

ALTER TABLE "price_adjustments"
    ALTER COLUMN "source_contract_price_id" SET NOT NULL,
    ALTER COLUMN "refund_required_minor" SET NOT NULL,
    ADD CONSTRAINT "price_adjustments_refund_required_check" CHECK (
        "refund_required_minor" >= 0
        AND "refund_required_minor" <= "amount_minor"
    ),
    ADD CONSTRAINT "price_adjustments_source_contract_price_id_fkey"
        FOREIGN KEY ("source_contract_price_id")
        REFERENCES "order_contract_price_revisions"("id") ON DELETE RESTRICT;
ALTER TABLE "order_contract_price_revisions"
    ADD CONSTRAINT "order_contract_price_revisions_price_adjustment_id_fkey"
        FOREIGN KEY ("price_adjustment_id") REFERENCES "price_adjustments"("id") ON DELETE RESTRICT;

CREATE FUNCTION taven_insert_initial_contract_price(target_order_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    target_snapshot "price_snapshots"%ROWTYPE;
    revision_id uuid := gen_random_uuid();
BEGIN
    SELECT snapshot.* INTO target_snapshot
    FROM "order_active_price_bindings" active
    JOIN "order_price_bindings" binding
      ON binding."id" = active."order_price_binding_id"
     AND binding."order_id" = active."order_id"
    JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
    WHERE active."order_id" = target_order_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'active fulfilment price is unavailable for contract initialization'
            USING ERRCODE = '23514', CONSTRAINT = 'order_contract_price_base_check';
    END IF;

    INSERT INTO "order_contract_price_revisions" (
        "id", "order_id", "base_price_snapshot_id", "contract_total_minor",
        "tax_regime", "vat_rate_basis_points", "net_amount_minor",
        "vat_amount_minor", "currency"
    ) VALUES (
        revision_id, target_order_id, target_snapshot."id",
        target_snapshot."contract_total_minor", target_snapshot."tax_regime",
        target_snapshot."vat_rate_basis_points", target_snapshot."net_amount_minor",
        target_snapshot."vat_amount_minor", target_snapshot."currency"
    );

    INSERT INTO "order_active_contract_prices" (
        "order_id", "contract_price_revision_id"
    ) VALUES (target_order_id, revision_id)
    ON CONFLICT ("order_id") DO UPDATE
      SET "contract_price_revision_id" = EXCLUDED."contract_price_revision_id";

    RETURN revision_id;
END;
$$;

-- Seed every historical active accepted/draft binding before protecting the
-- pointer. Each row exactly copies its immutable base snapshot tax facts.
DO $$
DECLARE
    target_order_id uuid;
BEGIN
    FOR target_order_id IN
        SELECT "order_id" FROM "order_active_price_bindings" ORDER BY "order_id"
    LOOP
        PERFORM taven_insert_initial_contract_price(target_order_id);
    END LOOP;
END;
$$;

CREATE FUNCTION taven_sync_initial_contract_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "order_active_contract_prices"
        WHERE "order_id" = NEW."order_id"
    ) OR EXISTS (
        SELECT 1 FROM "orders"
        WHERE "id" = NEW."order_id" AND "status" = 'DRAFT'
    ) THEN
        PERFORM taven_insert_initial_contract_price(NEW."order_id");
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "order_active_price_binding_contract_price_synced"
AFTER INSERT OR UPDATE OF "order_price_binding_id" ON "order_active_price_bindings"
FOR EACH ROW EXECUTE FUNCTION taven_sync_initial_contract_price();

CREATE FUNCTION taven_protect_contract_price_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    base_snapshot "price_snapshots"%ROWTYPE;
    predecessor "order_contract_price_revisions"%ROWTYPE;
    adjustment "price_adjustments"%ROWTYPE;
    expected_vat bigint;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'contract-price revisions are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_contract_price_revision_immutable_check';
    END IF;

    SELECT * INTO base_snapshot FROM "price_snapshots"
    WHERE "id" = NEW."base_price_snapshot_id";
    IF NOT FOUND OR base_snapshot."currency" IS DISTINCT FROM NEW."currency"
       OR base_snapshot."tax_regime" IS DISTINCT FROM NEW."tax_regime"
       OR base_snapshot."vat_rate_basis_points" IS DISTINCT FROM NEW."vat_rate_basis_points" THEN
        RAISE EXCEPTION 'contract-price revision must preserve base snapshot currency and tax regime'
            USING ERRCODE = '23514', CONSTRAINT = 'order_contract_price_base_check';
    END IF;

    expected_vat := CASE
        WHEN NEW."tax_regime" = 'NON_VAT_PAYER' THEN 0
        ELSE floor(
            (NEW."contract_total_minor"::numeric * NEW."vat_rate_basis_points")
            / (10000 + NEW."vat_rate_basis_points") + 0.5
        )::bigint
    END;
    IF NEW."vat_amount_minor" <> expected_vat
       OR NEW."net_amount_minor" <> NEW."contract_total_minor" - expected_vat THEN
        RAISE EXCEPTION 'contract-price revision tax amounts are not the half-up extraction from gross total'
            USING ERRCODE = '23514', CONSTRAINT = 'order_contract_price_tax_check';
    END IF;

    IF NEW."predecessor_id" IS NULL OR NEW."price_adjustment_id" IS NULL THEN
        IF NEW."predecessor_id" IS NOT NULL OR NEW."price_adjustment_id" IS NOT NULL
           OR NEW."contract_total_minor" <> base_snapshot."contract_total_minor"
           OR NEW."net_amount_minor" <> base_snapshot."net_amount_minor"
           OR NEW."vat_amount_minor" <> base_snapshot."vat_amount_minor" THEN
            RAISE EXCEPTION 'initial contract-price revision must exactly copy its base snapshot'
                USING ERRCODE = '23514', CONSTRAINT = 'order_contract_price_base_check';
        END IF;
        RETURN NEW;
    END IF;

    SELECT * INTO predecessor FROM "order_contract_price_revisions"
    WHERE "id" = NEW."predecessor_id" FOR UPDATE;
    SELECT * INTO adjustment FROM "price_adjustments"
    WHERE "id" = NEW."price_adjustment_id";
    IF predecessor."order_id" IS DISTINCT FROM NEW."order_id"
       OR predecessor."base_price_snapshot_id" IS DISTINCT FROM NEW."base_price_snapshot_id"
       OR predecessor."currency" IS DISTINCT FROM NEW."currency"
       OR adjustment."order_id" IS DISTINCT FROM NEW."order_id"
       OR adjustment."source_contract_price_id" IS DISTINCT FROM predecessor."id"
       OR adjustment."currency" IS DISTINCT FROM NEW."currency"
       OR NEW."contract_total_minor" <> predecessor."contract_total_minor" - adjustment."amount_minor" THEN
        RAISE EXCEPTION 'contract-price successor must exactly apply its PriceAdjustment'
            USING ERRCODE = '23514', CONSTRAINT = 'order_contract_price_successor_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_contract_price_revisions_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "order_contract_price_revisions"
FOR EACH ROW EXECUTE FUNCTION taven_protect_contract_price_revision();

CREATE FUNCTION taven_protect_active_contract_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'active contract price cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'order_active_contract_price_check';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."contract_price_revision_id" IS DISTINCT FROM OLD."contract_price_revision_id"
       AND NOT (
           EXISTS (
               SELECT 1 FROM "orders" target_order
               JOIN "order_contract_price_revisions" revision
                 ON revision."id" = NEW."contract_price_revision_id"
                AND revision."order_id" = target_order."id"
               WHERE target_order."id" = NEW."order_id"
                 AND (
                     (target_order."status" = 'DRAFT'
                      AND revision."predecessor_id" IS NULL
                      AND revision."price_adjustment_id" IS NULL)
                     OR revision."predecessor_id" = OLD."contract_price_revision_id"
                 )
           )
       ) THEN
        RAISE EXCEPTION 'active contract price must advance through one exact immutable successor'
            USING ERRCODE = '23514', CONSTRAINT = 'order_active_contract_price_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_active_contract_prices_protected"
BEFORE UPDATE OR DELETE ON "order_active_contract_prices"
FOR EACH ROW EXECUTE FUNCTION taven_protect_active_contract_price();

CREATE FUNCTION taven_validate_price_adjustment_contract_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    active_revision "order_contract_price_revisions"%ROWTYPE;
BEGIN
    SELECT revision.* INTO active_revision
    FROM "order_active_contract_prices" active
    JOIN "order_contract_price_revisions" revision
      ON revision."id" = active."contract_price_revision_id"
     AND revision."order_id" = active."order_id"
    WHERE active."order_id" = NEW."order_id"
    FOR UPDATE OF revision;

    IF NOT FOUND
       OR NEW."source_contract_price_id" IS DISTINCT FROM active_revision."id"
       OR NEW."currency" IS DISTINCT FROM active_revision."currency"
       OR NEW."amount_minor" > active_revision."contract_total_minor" THEN
        RAISE EXCEPTION 'PriceAdjustment must reduce the exact active contract price'
            USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_contract_source_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "price_adjustments_contract_source_valid"
BEFORE INSERT ON "price_adjustments"
FOR EACH ROW EXECUTE FUNCTION taven_validate_price_adjustment_contract_source();

CREATE FUNCTION taven_reconcile_price_adjustment_contract_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "order_contract_price_revisions" result
        JOIN "order_active_contract_prices" active
          ON active."order_id" = result."order_id"
         AND active."contract_price_revision_id" = result."id"
        WHERE result."price_adjustment_id" = NEW."id"
          AND result."predecessor_id" = NEW."source_contract_price_id"
          AND result."order_id" = NEW."order_id"
          AND result."contract_total_minor" = (
              SELECT source."contract_total_minor" - NEW."amount_minor"
              FROM "order_contract_price_revisions" source
              WHERE source."id" = NEW."source_contract_price_id"
          )
    ) THEN
        RAISE EXCEPTION 'PriceAdjustment requires its atomically activated contract-price successor'
            USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_contract_result_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "price_adjustments_contract_result_reconciled"
AFTER INSERT ON "price_adjustments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_price_adjustment_contract_result();

CREATE FUNCTION taven_require_activated_adjustment_before_refund()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    required_refund bigint;
BEGIN
    IF NEW."price_adjustment_id" IS NOT NULL
       AND NOT EXISTS (
           WITH RECURSIVE lineage AS (
               SELECT revision."id", revision."predecessor_id", revision."price_adjustment_id"
               FROM "order_active_contract_prices" active
               JOIN "order_contract_price_revisions" revision
                 ON revision."id" = active."contract_price_revision_id"
               JOIN "price_adjustments" adjustment
                 ON adjustment."order_id" = active."order_id"
               WHERE adjustment."id" = NEW."price_adjustment_id"
                 AND active."order_id" = adjustment."order_id"
               UNION ALL
               SELECT predecessor."id", predecessor."predecessor_id", predecessor."price_adjustment_id"
               FROM "order_contract_price_revisions" predecessor
               JOIN lineage current_revision
                 ON current_revision."predecessor_id" = predecessor."id"
           )
           SELECT 1 FROM lineage
           WHERE "price_adjustment_id" = NEW."price_adjustment_id"
       ) THEN
        RAISE EXCEPTION 'adjustment refund requires an activated contract-price revision'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_adjustment_contract_price_check';
    END IF;
    IF NEW."price_adjustment_id" IS NOT NULL
       AND NEW."status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED') THEN
        SELECT adjustment."refund_required_minor"
        INTO required_refund
        FROM "price_adjustments" adjustment
        WHERE adjustment."id" = NEW."price_adjustment_id";
        IF coalesce((
            SELECT sum(refund."amount_minor")
            FROM "refund_transactions" refund
            WHERE refund."price_adjustment_id" = NEW."price_adjustment_id"
              AND refund."id" <> NEW."id"
              AND refund."status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED')
        ), 0) + NEW."amount_minor" > required_refund THEN
            RAISE EXCEPTION 'adjustment refund work exceeds its recorded cash obligation'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_adjustment_required_amount_check';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "refund_transactions_adjustment_contract_price_valid"
BEFORE INSERT OR UPDATE OF "price_adjustment_id", "status", "amount_minor"
ON "refund_transactions"
FOR EACH ROW EXECUTE FUNCTION taven_require_activated_adjustment_before_refund();

CREATE FUNCTION taven_create_price_adjustment_with_revision(
    target_adjustment_id uuid,
    target_order_id uuid,
    target_payment_id uuid,
    target_claim_id uuid,
    target_idempotency_key text,
    target_reason "price_adjustment_reason",
    target_amount_minor bigint,
    target_currency char(3),
    target_allocation jsonb
)
RETURNS TABLE (price_adjustment_id uuid, contract_price_revision_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
    source_revision "order_contract_price_revisions"%ROWTYPE;
    result_revision_id uuid := gen_random_uuid();
    result_total bigint;
    result_vat bigint;
    net_captured bigint;
    source_overpayment bigint;
    refund_required bigint;
    selected_payment_available bigint;
    adjustment_created_at timestamptz := clock_timestamp();
BEGIN
    PERFORM 1 FROM "orders" WHERE "id" = target_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'orders_pkey';
    END IF;

    SELECT revision.* INTO source_revision
    FROM "order_active_contract_prices" active
    JOIN "order_contract_price_revisions" revision
      ON revision."id" = active."contract_price_revision_id"
     AND revision."order_id" = active."order_id"
    WHERE active."order_id" = target_order_id
    FOR UPDATE OF active, revision;

    IF NOT FOUND OR target_amount_minor IS NULL OR target_amount_minor <= 0
       OR target_amount_minor > source_revision."contract_total_minor"
       OR target_currency IS DISTINCT FROM source_revision."currency" THEN
        RAISE EXCEPTION 'PriceAdjustment cannot reduce the active contract price by that amount'
            USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_contract_source_check';
    END IF;

    result_total := source_revision."contract_total_minor" - target_amount_minor;
    SELECT greatest(
        coalesce(sum(payment."captured_amount_minor"), 0)
        - coalesce((
            SELECT sum(refund."amount_minor")
            FROM "refund_transactions" refund
            JOIN "payments" refund_payment
              ON refund_payment."id" = refund."payment_id"
            WHERE refund_payment."order_id" = target_order_id
              AND refund."status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED')
        ), 0),
        0
    ) INTO net_captured
    FROM "payments" payment
    WHERE payment."order_id" = target_order_id
      AND payment."captured_amount_minor" IS NOT NULL;
    source_overpayment := greatest(
        net_captured - source_revision."contract_total_minor", 0
    );
    refund_required := greatest(net_captured - result_total, 0) - source_overpayment;

    IF target_payment_id IS NOT NULL THEN
        SELECT payment."captured_amount_minor" - coalesce((
            SELECT sum(refund."amount_minor")
            FROM "refund_transactions" refund
            WHERE refund."payment_id" = payment."id"
              AND refund."status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED')
        ), 0)
        INTO selected_payment_available
        FROM "payments" payment
        WHERE payment."id" = target_payment_id
          AND payment."order_id" = target_order_id
          AND payment."currency" = target_currency
          AND payment."captured_amount_minor" IS NOT NULL
        FOR UPDATE;
        IF NOT FOUND OR selected_payment_available < refund_required THEN
            RAISE EXCEPTION 'selected Payment cannot fund the incremental contract refund'
                USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_payment_refund_check';
        END IF;
    END IF;

    INSERT INTO "price_adjustments" (
        "id", "order_id", "payment_id", "claim_id",
        "source_contract_price_id", "idempotency_key", "reason",
        "amount_minor", "refund_required_minor", "currency", "allocation", "created_at"
    ) VALUES (
        target_adjustment_id, target_order_id, target_payment_id,
        target_claim_id, source_revision."id", target_idempotency_key,
        target_reason, target_amount_minor, refund_required, target_currency,
        target_allocation, adjustment_created_at
    );

    result_vat := CASE
        WHEN source_revision."tax_regime" = 'NON_VAT_PAYER' THEN 0
        ELSE floor(
            (result_total::numeric * source_revision."vat_rate_basis_points")
            / (10000 + source_revision."vat_rate_basis_points") + 0.5
        )::bigint
    END;

    INSERT INTO "order_contract_price_revisions" (
        "id", "order_id", "base_price_snapshot_id", "predecessor_id",
        "price_adjustment_id", "contract_total_minor", "tax_regime",
        "vat_rate_basis_points", "net_amount_minor", "vat_amount_minor",
        "currency", "created_at"
    ) VALUES (
        result_revision_id, target_order_id,
        source_revision."base_price_snapshot_id", source_revision."id",
        target_adjustment_id, result_total, source_revision."tax_regime",
        source_revision."vat_rate_basis_points", result_total - result_vat,
        result_vat, source_revision."currency", adjustment_created_at
    );

    UPDATE "order_active_contract_prices" active_contract
    SET "contract_price_revision_id" = result_revision_id
    WHERE active_contract."order_id" = target_order_id
      AND active_contract."contract_price_revision_id" = source_revision."id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'active contract price changed during adjustment activation'
            USING ERRCODE = '40001', CONSTRAINT = 'order_active_contract_price_check';
    END IF;

    price_adjustment_id := target_adjustment_id;
    contract_price_revision_id := result_revision_id;
    RETURN NEXT;
END;
$$;

-- Legacy accepted orders require explicit operator evidence before the new
-- duration may be populated outside QUOTED. No current environment value is
-- ever retroactively assigned to a customer contract.
CREATE TABLE "claim_window_migration_approvals" (
    "order_id" uuid PRIMARY KEY,
    "claim_policy_revision" varchar(100) NOT NULL,
    "claim_window_days" integer NOT NULL,
    "approval_reference" varchar(500) NOT NULL,
    "approved_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "claim_window_migration_approvals_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT,
    CONSTRAINT "claim_window_migration_approvals_values_check" CHECK (
        "claim_policy_revision" = btrim("claim_policy_revision")
        AND "claim_policy_revision" ~ '[^[:space:]]'
        AND "claim_window_days" BETWEEN 1 AND 3650
        AND "approval_reference" = btrim("approval_reference")
        AND "approval_reference" ~ '[^[:space:]]'
    )
);

CREATE FUNCTION taven_validate_claim_window_migration_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Claim-window migration approval is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'claim_window_migration_approval_check';
    END IF;
    PERFORM 1
    FROM "orders" target_order
    WHERE target_order."id" = NEW."order_id"
      AND target_order."status" NOT IN ('DRAFT', 'QUOTED', 'EXPIRED')
      AND target_order."accepted_claim_policy_revision" = NEW."claim_policy_revision"
      AND target_order."accepted_claim_window_days" IS NULL
    FOR UPDATE OF target_order;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Claim-window migration approval does not match a legacy accepted Order'
            USING ERRCODE = '23514', CONSTRAINT = 'claim_window_migration_approval_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "claim_window_migration_approvals_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "claim_window_migration_approvals"
FOR EACH ROW EXECUTE FUNCTION taven_validate_claim_window_migration_approval();

CREATE OR REPLACE FUNCTION taven_protect_order_claim_window_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."accepted_claim_window_days" IS NOT NULL THEN
            RAISE EXCEPTION 'new orders cannot begin with a Claim-window snapshot'
                USING ERRCODE = '23514', CONSTRAINT = 'order_claim_window_snapshot_check';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."accepted_claim_window_days" IS NOT NULL
       AND NEW."accepted_claim_window_days" IS DISTINCT FROM OLD."accepted_claim_window_days" THEN
        RAISE EXCEPTION 'accepted Claim-window snapshot is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_claim_window_snapshot_check';
    END IF;

    IF NEW."accepted_claim_window_days" IS DISTINCT FROM OLD."accepted_claim_window_days"
       AND NOT (
           OLD."accepted_claim_window_days" IS NULL
           AND NEW."accepted_claim_window_days" IS NOT NULL
           AND NEW."accepted_claim_policy_revision" IS NOT NULL
           AND (
               NEW."status" = 'QUOTED'
               OR EXISTS (
                   SELECT 1 FROM "claim_window_migration_approvals" approval
                   WHERE approval."order_id" = NEW."id"
                     AND approval."claim_policy_revision" = NEW."accepted_claim_policy_revision"
                     AND approval."claim_window_days" = NEW."accepted_claim_window_days"
               )
           )
       ) THEN
        RAISE EXCEPTION 'Claim-window snapshot requires quoted acceptance or exact migration approval evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'order_claim_window_snapshot_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION taven_legacy_claim_slot_repair_is_authorized(
    target_slot_id uuid,
    target_delivered_at timestamptz,
    target_claim_until timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "fulfilment_slots" slot
        JOIN "orders" target_order ON target_order."id" = slot."order_id"
        JOIN "claim_window_migration_approvals" approval
          ON approval."order_id" = target_order."id"
         AND approval."claim_policy_revision" = target_order."accepted_claim_policy_revision"
         AND approval."claim_window_days" = target_order."accepted_claim_window_days"
        JOIN "shipment_plan_fulfilment_slots" allocation
          ON allocation."fulfilment_slot_id" = slot."id"
        JOIN "shipments" shipment
          ON shipment."shipment_plan_id" = allocation."shipment_plan_id"
         AND shipment."order_id" = slot."order_id"
         AND shipment."order_phase_id" = slot."order_phase_id"
        JOIN "shipment_provider_events" delivery_event
          ON delivery_event."shipment_id" = shipment."id"
         AND delivery_event."kind" = 'DELIVERY_SCAN'
         AND delivery_event."outbox_message_id" IS NULL
         AND delivery_event."carrier" = shipment."carrier"
         AND delivery_event."carrier_label_id" = shipment."carrier_label_id"
         AND delivery_event."verified_at" = shipment."delivered_at"
        WHERE slot."id" = target_slot_id
          AND slot."outcome" = 'DELIVERED'
          AND shipment."status" = 'DELIVERED'
          AND shipment."delivered_at" = target_delivered_at
          AND target_claim_until = target_delivered_at
              + make_interval(days => approval."claim_window_days")
          AND NOT EXISTS (
              SELECT 1 FROM "shipments" successor
              WHERE successor."replaces_shipment_id" = shipment."id"
          )
          AND (
              SELECT count(*)
              FROM "shipments" leaf
              WHERE leaf."shipment_plan_id" = allocation."shipment_plan_id"
                AND leaf."status" = 'DELIVERED'
                AND leaf."delivered_at" IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM "shipments" successor
                    WHERE successor."replaces_shipment_id" = leaf."id"
                )
          ) = 1
    );
$$;

CREATE OR REPLACE FUNCTION taven_protect_fulfilment_slot_topology()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW."order_id" ELSE OLD."order_id" END;
    target_order_status "order_status";
    target_claim_window_days integer;
BEGIN
    IF TG_OP = 'INSERT'
       OR (TG_OP = 'UPDATE'
           AND NEW."settlement_amount_minor" IS DISTINCT FROM OLD."settlement_amount_minor") THEN
        PERFORM taven_lock_automatic_order_session(target_order_id);
    END IF;

    SELECT "status", "accepted_claim_window_days"
    INTO target_order_status, target_claim_window_days
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    IF TG_OP = 'INSERT' THEN
        IF target_order_status IS DISTINCT FROM 'DRAFT'::"order_status" THEN
            RAISE EXCEPTION 'fulfilment slots can be inserted only while the order is draft'
                USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_topology_immutable_check';
        END IF;
        IF NEW."outcome" <> 'PENDING'
           OR NEW."delivered_at" IS NOT NULL
           OR NEW."claim_until" IS NOT NULL THEN
            RAISE EXCEPTION 'new fulfilment slots must begin pending without delivery evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_initial_outcome_check';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'fulfilment slots are stable topology and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_topology_immutable_check';
    END IF;

    IF (to_jsonb(NEW) - 'outcome' - 'updated_at' - 'settlement_amount_minor' - 'delivered_at' - 'claim_until')
       IS DISTINCT FROM (to_jsonb(OLD) - 'outcome' - 'updated_at' - 'settlement_amount_minor' - 'delivered_at' - 'claim_until') THEN
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
           OR (OLD."outcome" = 'CANCELLED'
               AND NEW."outcome" = 'PENDING'
               AND taven_has_reconciled_post_void_handoff(
                   NEW."order_id", NEW."order_phase_id", NULL,
                   NEW."id", NULL, NEW."updated_at"
               ))
           OR (OLD."outcome" = 'CANCELLED_REFUNDED'
               AND NEW."outcome" = 'PENDING'
               AND target_order_status IN ('REFUNDED', 'SHIPPED')
               AND taven_has_refunded_post_void_handoff_reconciliation(
                   NEW."order_id", NEW."order_phase_id", NULL,
                   NEW."id", NULL, NEW."updated_at"
               ))
           OR (OLD."outcome" = 'CANCELLED_REFUNDED'
               AND NEW."outcome" = 'CANCELLED'
               AND taven_order_has_newer_refund_failure(NEW."order_id"))
       ) THEN
        RAISE EXCEPTION 'fulfilment slot outcome is terminal once recorded'
            USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_outcome_transition_check';
    END IF;

    IF OLD."delivered_at" IS NOT NULL
       AND (
           NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
           OR NEW."claim_until" IS DISTINCT FROM OLD."claim_until"
       ) THEN
        RAISE EXCEPTION 'fulfilment slot delivery and Claim deadline are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_claim_window_immutable_check';
    END IF;

    IF OLD."outcome" = 'PENDING'
       AND NEW."outcome" = 'DELIVERED'
       AND (
           NEW."delivered_at" IS NULL
           OR NEW."claim_until" IS NULL
           OR target_claim_window_days IS NULL
           OR NEW."claim_until" <> NEW."delivered_at" + make_interval(days => target_claim_window_days)
       ) THEN
        RAISE EXCEPTION 'delivered fulfilment slot requires its snapshotted Claim deadline'
            USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_claim_window_snapshot_check';
    END IF;

    IF (
        NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
        OR NEW."claim_until" IS DISTINCT FROM OLD."claim_until"
       ) AND NOT (
        (
            OLD."outcome" = 'PENDING'
            AND NEW."outcome" = 'DELIVERED'
            AND OLD."delivered_at" IS NULL
            AND OLD."claim_until" IS NULL
            AND NEW."delivered_at" IS NOT NULL
            AND target_claim_window_days IS NOT NULL
            AND NEW."claim_until" = NEW."delivered_at" + make_interval(days => target_claim_window_days)
        ) OR (
            OLD."outcome" = 'DELIVERED'
            AND NEW."outcome" = 'DELIVERED'
            AND OLD."delivered_at" IS NULL
            AND OLD."claim_until" IS NULL
            AND NEW."delivered_at" IS NOT NULL
            AND NEW."claim_until" IS NOT NULL
            AND taven_legacy_claim_slot_repair_is_authorized(
                NEW."id", NEW."delivered_at", NEW."claim_until"
            )
        )
       ) THEN
        RAISE EXCEPTION 'delivery must derive the Claim deadline from accepted policy and delivery evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_slot_claim_window_snapshot_check';
    END IF;

    RETURN NEW;
END;
$$;

-- Customer cancellation is also valid while a dispatched balance attempt is
-- open. Keep that edge in the dedicated split-payment validator so the same
-- immutable acceptance fields remain protected.
DROP TRIGGER "orders_status_transitions_valid_update" ON "orders";
DROP TRIGGER "orders_balance_status_transitions_valid" ON "orders";

CREATE OR REPLACE FUNCTION taven_validate_balance_order_status_transition()
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
            AND NEW."status" IN ('READY_TO_SHIP', 'CANCELLED', 'CANCELLED_SETTLED'))
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
            AND NEW."status" IN ('READY_TO_SHIP', 'CANCELLED', 'CANCELLED_SETTLED'))
    )
)
EXECUTE FUNCTION taven_validate_order_status_transition();

CREATE TRIGGER "orders_balance_status_transitions_valid"
BEFORE UPDATE OF "id", "customer_id", "public_reference", "status", "quoted_at", "confirmed_at",
    "accepted_order_price_binding_id", "accepted_terms_revision",
    "accepted_claim_policy_revision", "withdrawal_exception_acknowledged_at", "created_at"
ON "orders"
FOR EACH ROW
WHEN (
    (OLD."status" = 'QC_PASSED' AND NEW."status" = 'AWAITING_BALANCE')
    OR (OLD."status" = 'AWAITING_BALANCE'
        AND NEW."status" IN ('READY_TO_SHIP', 'CANCELLED', 'CANCELLED_SETTLED'))
)
EXECUTE FUNCTION taven_validate_balance_order_status_transition();

-- BALANCE is the amount still due against the active contractual revision;
-- FULL and DEPOSIT remain exact immutable schedule amounts.
ALTER TABLE "payments" DROP CONSTRAINT "payments_schedule_contract_fkey";
ALTER TABLE "payments"
    ADD CONSTRAINT "payments_schedule_contract_fkey"
        FOREIGN KEY ("payment_schedule_id") REFERENCES "payment_schedules"("id") ON DELETE RESTRICT;

CREATE FUNCTION taven_balance_requested_amount(target_order_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
    SELECT greatest(
        revision."contract_total_minor"
        - coalesce((
            SELECT sum(payment."captured_amount_minor")
            FROM "payments" payment
            WHERE payment."order_id" = target_order_id
              AND payment."role" IN ('FULL', 'DEPOSIT')
              AND payment."captured_amount_minor" IS NOT NULL
        ), 0)
        + coalesce((
            SELECT sum(refund."amount_minor")
            FROM "refund_transactions" refund
            JOIN "payments" payment ON payment."id" = refund."payment_id"
            WHERE payment."order_id" = target_order_id
              AND payment."role" IN ('FULL', 'DEPOSIT')
              AND refund."status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED')
        ), 0),
        0
    )::bigint
    FROM "order_active_contract_prices" active
    JOIN "order_contract_price_revisions" revision
      ON revision."id" = active."contract_price_revision_id"
     AND revision."order_id" = active."order_id"
    WHERE active."order_id" = target_order_id;
$$;

CREATE FUNCTION taven_validate_payment_schedule_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    schedule "payment_schedules"%ROWTYPE;
    expected_balance bigint;
BEGIN
    SELECT * INTO schedule FROM "payment_schedules"
    WHERE "id" = NEW."payment_schedule_id";
    IF NOT FOUND
       OR schedule."price_snapshot_id" IS DISTINCT FROM NEW."price_snapshot_id"
       OR schedule."role" IS DISTINCT FROM NEW."role" THEN
        RAISE EXCEPTION 'Payment schedule does not match its immutable snapshot and role'
            USING ERRCODE = '23514', CONSTRAINT = 'payments_schedule_contract_check';
    END IF;

    IF NEW."role" IN ('FULL', 'DEPOSIT') THEN
        IF NEW."requested_amount_minor" IS DISTINCT FROM schedule."gross_amount_minor" THEN
            RAISE EXCEPTION 'initial Payment amount must equal its immutable schedule'
                USING ERRCODE = '23514', CONSTRAINT = 'payments_schedule_contract_check';
        END IF;
    ELSE
        expected_balance := taven_balance_requested_amount(NEW."order_id");
        IF expected_balance IS NULL OR expected_balance <= 0
           OR NEW."requested_amount_minor" IS DISTINCT FROM expected_balance THEN
            RAISE EXCEPTION 'balance Payment must equal the active contract amount due'
                USING ERRCODE = '23514', CONSTRAINT = 'payments_schedule_contract_check';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_schedule_contract_valid"
BEFORE INSERT OR UPDATE OF "payment_schedule_id", "price_snapshot_id", "role", "requested_amount_minor"
ON "payments"
FOR EACH ROW EXECUTE FUNCTION taven_validate_payment_schedule_contract();

CREATE OR REPLACE FUNCTION taven_validate_price_adjustment_contract_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    active_revision "order_contract_price_revisions"%ROWTYPE;
BEGIN
    SELECT revision.* INTO active_revision
    FROM "order_active_contract_prices" active
    JOIN "order_contract_price_revisions" revision
      ON revision."id" = active."contract_price_revision_id"
     AND revision."order_id" = active."order_id"
    WHERE active."order_id" = NEW."order_id"
    FOR UPDATE OF revision;

    IF NOT FOUND
       OR NEW."source_contract_price_id" IS DISTINCT FROM active_revision."id"
       OR NEW."currency" IS DISTINCT FROM active_revision."currency"
       OR NEW."amount_minor" > active_revision."contract_total_minor"
       OR EXISTS (
           SELECT 1 FROM "payments" balance
           WHERE balance."order_id" = NEW."order_id"
             AND balance."role" = 'BALANCE'
             AND balance."status" IN ('CREATED', 'PENDING')
       ) THEN
        RAISE EXCEPTION 'PriceAdjustment must reduce the exact active contract before a balance attempt opens'
            USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_contract_source_check';
    END IF;
    RETURN NEW;
END;
$$;

-- The first balance attempt is durable at final QC. Provider dispatch remains
-- outside the transaction, but it now charges the reduced contractual amount.
CREATE OR REPLACE FUNCTION taven_create_post_qc_balance_payment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    requested_balance bigint;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "individual_order_origins" origin
        WHERE origin."order_id" = NEW."id"
    ) THEN
        RETURN NULL;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM "order_active_price_bindings" active
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
         AND binding."order_id" = active."order_id"
         AND binding."invalidated_at" IS NULL
        WHERE active."order_id" = NEW."id"
          AND taven_individual_full_payment_binding_is_grandfathered(
              NEW."id", binding."price_snapshot_id"
          )
    ) THEN
        RETURN NULL;
    END IF;

    requested_balance := taven_balance_requested_amount(NEW."id");
    IF requested_balance IS NULL OR requested_balance <= 0 THEN
        RETURN NULL;
    END IF;

    INSERT INTO "payments" (
        "id", "order_id", "price_snapshot_id", "order_price_binding_id",
        "payment_schedule_id", "role", "provider", "requested_amount_minor",
        "currency", "status", "balance_due_at", "created_at", "updated_at"
    )
    SELECT gen_random_uuid(), target_order."id", snapshot."id", binding."id",
           balance_schedule."id", 'BALANCE', deposit."provider",
           requested_balance, snapshot."currency", 'CREATED',
           phase."qc_passed_at" + make_interval(
               days => (list."parameters" ->> 'balance_payment_days')::integer
           ), phase."qc_passed_at", phase."qc_passed_at"
    FROM "orders" target_order
    JOIN "order_phases" phase
      ON phase."order_id" = target_order."id"
     AND phase."kind" = 'SINGLE'
     AND phase."status" = 'QC_PASSED'
     AND phase."qc_passed_at" IS NOT NULL
    JOIN "order_active_price_bindings" active ON active."order_id" = target_order."id"
    JOIN "order_price_bindings" binding
      ON binding."id" = active."order_price_binding_id"
     AND binding."order_id" = target_order."id"
     AND binding."invalidated_at" IS NULL
    JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
    JOIN "price_lists" list ON list."id" = snapshot."price_list_id"
    JOIN "payment_schedules" balance_schedule
      ON balance_schedule."price_snapshot_id" = snapshot."id"
     AND balance_schedule."role" = 'BALANCE'
     AND balance_schedule."sequence" = 1
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
      AND taven_order_accepts_bound_price_list_terms(target_order."id", binding."id")
      AND taven_price_snapshot_balance_deadline_is_valid(snapshot."id")
      AND taven_price_snapshot_balance_earned_policy_is_valid(snapshot."id")
      AND NOT EXISTS (
          SELECT 1 FROM "order_settlements" settlement
          WHERE settlement."order_id" = target_order."id"
      );

    IF NOT FOUND THEN
        RAISE EXCEPTION 'individual QC completion requires its durable balance deadline payment'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_payment_qc_creation_check';
    END IF;
    RETURN NULL;
END;
$$;

-- The durable QC-created balance row may receive its checkout identity exactly
-- once when an operator dispatches the provider-neutral payment link.
CREATE OR REPLACE FUNCTION taven_protect_payment_checkout_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    balance_dispatch boolean := false;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."provider_checkout_url" IS NOT NULL
           OR (NEW."checkout_method" IN ('CARD', 'BANK_TRANSFER') AND (
               NEW."merchant_reference" IS NULL OR NEW."checkout_command_id" IS NULL
           )) THEN
            RAISE EXCEPTION 'new checkout Payment requires its command and merchant reference before provider dispatch'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_checkout_identity_check';
        END IF;
        RETURN NEW;
    END IF;

    balance_dispatch :=
        OLD."role" = 'BALANCE' AND OLD."status" = 'CREATED'
        AND NEW."status" = 'CREATED'
        AND OLD."checkout_method" = 'ALL'
        AND OLD."merchant_reference" IS NULL
        AND OLD."checkout_command_id" IS NULL
        AND OLD."provider_checkout_url" IS NULL
        AND NEW."checkout_method" IN ('CARD', 'BANK_TRANSFER')
        AND NEW."merchant_reference" = NEW."id"::text
        AND NEW."checkout_command_id" IS NOT NULL
        AND NEW."provider_checkout_url" IS NULL;

    IF (
        NEW."checkout_method" IS DISTINCT FROM OLD."checkout_method"
        OR NEW."merchant_reference" IS DISTINCT FROM OLD."merchant_reference"
        OR NEW."checkout_command_id" IS DISTINCT FROM OLD."checkout_command_id"
       ) AND NOT balance_dispatch THEN
        RAISE EXCEPTION 'Payment checkout identity is immutable and assigned only for one balance dispatch'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_checkout_identity_check';
    END IF;
    IF (OLD."provider_checkout_url" IS NOT NULL
        AND NEW."provider_checkout_url" IS DISTINCT FROM OLD."provider_checkout_url")
       OR (OLD."provider_checkout_url" IS NULL
           AND NEW."provider_checkout_url" IS NOT NULL
           AND NOT (
               (OLD."status" = 'CREATED' AND NEW."status" = 'PENDING')
               OR (OLD."status" = 'PENDING' AND NEW."status" = 'PENDING'
                   AND OLD."provider_intent_id" IS NOT NULL
                   AND NEW."provider_intent_id" = OLD."provider_intent_id")
           ))
       OR (NEW."provider_checkout_url" IS NOT NULL
           AND NEW."provider_checkout_url" !~ '^https?://[^[:space:]]+$') THEN
        RAISE EXCEPTION 'Payment checkout URL is immutable and assigned only with its provider intent'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_checkout_identity_check';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER "payments_balance_readiness_reconciled" ON "payments";
DROP TRIGGER "payments_balance_waiting_reconciled" ON "payments";
DROP TRIGGER "orders_balance_readiness_reconciled" ON "orders";

CREATE OR REPLACE FUNCTION taven_reconcile_balance_payment_readiness()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_payment_id uuid;
    target_order_status "order_status";
    required_balance bigint;
BEGIN
    IF TG_TABLE_NAME = 'payments' THEN
        IF (to_jsonb(NEW) ->> 'role') <> 'BALANCE' THEN RETURN NULL; END IF;
        target_order_id := (to_jsonb(NEW) ->> 'order_id')::uuid;
        target_payment_id := (to_jsonb(NEW) ->> 'id')::uuid;
    ELSE
        target_order_id := (to_jsonb(NEW) ->> 'id')::uuid;
    END IF;

    SELECT "status" INTO target_order_status FROM "orders"
    WHERE "id" = target_order_id FOR UPDATE;
    IF NOT EXISTS (
        SELECT 1 FROM "order_active_price_bindings" active
        JOIN "order_price_bindings" binding ON binding."id" = active."order_price_binding_id"
        JOIN "payment_schedules" schedule
          ON schedule."price_snapshot_id" = binding."price_snapshot_id"
         AND schedule."role" = 'BALANCE'
        WHERE active."order_id" = target_order_id
    ) THEN RETURN NULL; END IF;

    IF target_order_status IN ('AWAITING_BALANCE', 'CANCELLED_SETTLED')
       AND EXISTS (
           SELECT 1 FROM "order_settlements" settlement
           JOIN "payments" balance ON balance."id" = settlement."balance_payment_id"
           WHERE settlement."order_id" = target_order_id
             AND settlement."kind" = 'BALANCE_SETTLEMENT'
             AND (target_payment_id IS NULL OR balance."id" = target_payment_id)
             AND taven_balance_payment_is_closed_for_timeout(balance."id", settlement."cutoff_at")
       ) THEN RETURN NULL; END IF;

    required_balance := taven_balance_requested_amount(target_order_id);

    IF target_order_status = 'READY_TO_SHIP' AND required_balance = 0
       AND NOT EXISTS (
           SELECT 1 FROM "payments" payment
           WHERE payment."order_id" = target_order_id
             AND payment."role" = 'BALANCE'
             AND payment."status" NOT IN ('FAILED', 'VOIDED')
       ) THEN
        RETURN NULL;
    END IF;

    IF target_order_status = 'AWAITING_BALANCE' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "orders" target_order
            JOIN "individual_order_origins" origin ON origin."order_id" = target_order."id"
            JOIN "order_phases" phase
              ON phase."order_id" = target_order."id"
             AND phase."kind" = 'SINGLE'
             AND phase."status" = 'QC_PASSED'
             AND phase."qc_passed_at" IS NOT NULL
            JOIN "order_active_price_bindings" active ON active."order_id" = target_order."id"
            JOIN "order_price_bindings" binding
              ON binding."id" = active."order_price_binding_id"
             AND binding."order_id" = target_order."id"
             AND binding."invalidated_at" IS NULL
            JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
            JOIN "price_lists" list ON list."id" = snapshot."price_list_id"
            JOIN "payments" balance
              ON balance."order_id" = target_order."id"
             AND balance."order_price_binding_id" = binding."id"
             AND balance."price_snapshot_id" = binding."price_snapshot_id"
             AND balance."role" = 'BALANCE'
             AND balance."requested_amount_minor" = required_balance
             AND balance."checkout_capture_expires_at" IS NULL
             AND balance."balance_due_at" = phase."qc_passed_at"
                 + make_interval(days => (list."parameters" ->> 'balance_payment_days')::integer)
            WHERE target_order."id" = target_order_id
              AND target_order."accepted_order_price_binding_id" = binding."id"
              AND (target_payment_id IS NULL OR balance."id" = target_payment_id)
              AND taven_order_accepts_bound_price_list_terms(target_order."id", binding."id")
              AND (
                  (
                      balance."status" = 'PENDING'
                      AND balance."provider_intent_id" ~ '[^[:space:]]'
                      AND balance."capture_authorized"
                      AND balance."capture_cutoff_at" IS NULL
                      AND balance."balance_due_at" > clock_timestamp()
                  )
                  OR (
                      balance."status" = 'CAPTURED'
                      AND balance."captured_amount_minor" = balance."requested_amount_minor"
                      AND balance."provider_capture_id" ~ '[^[:space:]]'
                      AND balance."captured_at" IS NOT NULL
                      AND balance."captured_at" < balance."balance_due_at"
                      AND (
                          EXISTS (
                              SELECT 1 FROM "jobs" packing_job
                              WHERE packing_job."order_id" = target_order."id"
                                AND taven_job_is_current(packing_job."id")
                                AND packing_job."status" <> 'PACKED'
                          )
                          OR EXISTS (
                              SELECT 1 FROM "shipments" packing_shipment
                              WHERE packing_shipment."order_id" = target_order."id"
                                AND NOT EXISTS (
                                    SELECT 1 FROM "shipments" successor
                                    WHERE successor."replaces_shipment_id" = packing_shipment."id"
                                )
                                AND packing_shipment."status" <> 'LABEL_CREATED'
                          )
                      )
                  )
              )
              AND (SELECT count(*) FROM "payments" candidate
                   WHERE candidate."order_id" = target_order."id"
                     AND candidate."role" = 'BALANCE'
                     AND candidate."status" IN (
                         'CREATED', 'PENDING', 'CAPTURED',
                         'REFUND_PENDING', 'PARTIALLY_REFUNDED'
                     )) = 1
              AND EXISTS (SELECT 1 FROM "jobs" job WHERE job."order_id" = target_order."id")
              AND NOT EXISTS (
                  SELECT 1 FROM "jobs" job WHERE job."order_id" = target_order."id"
                    AND (job."status" NOT IN ('QC_APPROVED', 'PACKED')
                         OR job."qc_approved_at" IS NULL)
              )
              AND NOT EXISTS (
                  SELECT 1 FROM "shipments" shipment WHERE shipment."order_id" = target_order."id"
                    AND shipment."status" NOT IN ('PLANNED', 'LABEL_CREATED')
                    AND NOT EXISTS (SELECT 1 FROM "shipments" replacement
                                    WHERE replacement."replaces_shipment_id" = shipment."id")
              )
              AND NOT EXISTS (
                  SELECT 1 FROM "fulfilment_slots" slot
                  WHERE slot."order_id" = target_order."id" AND slot."outcome" <> 'PENDING'
              )
              AND NOT EXISTS (
                  SELECT 1 FROM "order_settlements" settlement
                  WHERE settlement."order_id" = target_order."id"
              )
        ) THEN
            RAISE EXCEPTION 'awaiting-balance order requires its exact active-contract payment and packing topology'
                USING ERRCODE = '23514', CONSTRAINT = 'balance_payment_waiting_check';
        END IF;
        RETURN NULL;
    END IF;

    IF target_order_status = 'READY_TO_SHIP' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "orders" target_order
            JOIN "individual_order_origins" origin ON origin."order_id" = target_order."id"
            JOIN "order_phases" phase
              ON phase."order_id" = target_order."id"
             AND phase."kind" = 'SINGLE'
             AND phase."status" = 'QC_PASSED'
            JOIN "order_active_price_bindings" active ON active."order_id" = target_order."id"
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
             AND balance."requested_amount_minor" = required_balance
             AND balance."captured_amount_minor" = balance."requested_amount_minor"
             AND balance."captured_at" IS NOT NULL
             AND balance."balance_due_at" IS NOT NULL
             AND balance."captured_at" < balance."balance_due_at"
             AND balance."checkout_capture_expires_at" IS NULL
            WHERE target_order."id" = target_order_id
              AND target_order."accepted_order_price_binding_id" = binding."id"
              AND (target_payment_id IS NULL OR balance."id" = target_payment_id)
              AND NOT EXISTS (
                  SELECT 1 FROM "order_settlements" settlement
                  WHERE settlement."order_id" = target_order."id"
              )
              AND NOT EXISTS (
                  SELECT 1 FROM "jobs" packing_job
                  WHERE packing_job."order_id" = target_order."id"
                    AND taven_job_is_current(packing_job."id")
                    AND packing_job."status" <> 'PACKED'
              )
              AND NOT EXISTS (
                  SELECT 1 FROM "shipments" packing_shipment
                  WHERE packing_shipment."order_id" = target_order."id"
                    AND NOT EXISTS (
                        SELECT 1 FROM "shipments" successor
                        WHERE successor."replaces_shipment_id" = packing_shipment."id"
                    )
                    AND packing_shipment."status" <> 'LABEL_CREATED'
              )
        ) THEN
            RAISE EXCEPTION 'balance capture requires atomic active-contract payment and readiness reconciliation'
                USING ERRCODE = '23514', CONSTRAINT = 'balance_payment_readiness_check';
        END IF;
        RETURN NULL;
    END IF;

    IF TG_TABLE_NAME = 'orders'
       AND (to_jsonb(NEW) ->> 'status') IN ('AWAITING_BALANCE', 'READY_TO_SHIP') THEN
        RAISE EXCEPTION 'split-payment order transition lacks its balance reconciliation'
            USING ERRCODE = '23514', CONSTRAINT = 'balance_payment_readiness_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_balance_readiness_reconciled"
AFTER UPDATE OF "status" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."status" = 'PENDING' AND NEW."status" = 'CAPTURED' AND NEW."role" = 'BALANCE')
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
    (OLD."status" = 'QC_PASSED' AND NEW."status" IN ('AWAITING_BALANCE', 'READY_TO_SHIP'))
    OR (OLD."status" = 'AWAITING_BALANCE' AND NEW."status" = 'READY_TO_SHIP')
)
EXECUTE FUNCTION taven_reconcile_balance_payment_readiness();

CREATE FUNCTION taven_apply_balance_payment_event(
    event_provider text,
    event_id text,
    event_transaction_id text,
    event_kind "payment_provider_event_kind",
    event_amount_minor bigint,
    event_currency char(3),
    event_occurred_at timestamptz,
    event_evidence jsonb,
    event_merchant_reference text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    target_payment "payments"%ROWTYPE;
    existing_event "payment_provider_events"%ROWTYPE;
    matched_payment_id uuid;
    receipt_id uuid := gen_random_uuid();
    verified_at timestamptz := clock_timestamp();
    receipt_payload jsonb;
    settlement_id uuid;
    refund_id uuid;
    refund_key text;
BEGIN
    IF event_kind NOT IN ('PAYMENT_PENDING', 'PAYMENT_CAPTURED', 'PAYMENT_FAILED') THEN
        RAISE EXCEPTION 'balance provider event kind is invalid' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO existing_event FROM "payment_provider_events"
    WHERE "provider" = event_provider AND "provider_event_id" = event_id;
    IF FOUND THEN
        IF existing_event."provider_transaction_id" IS DISTINCT FROM event_transaction_id
           OR existing_event."kind" IS DISTINCT FROM event_kind
           OR existing_event."amount_minor" IS DISTINCT FROM event_amount_minor
           OR existing_event."currency" IS DISTINCT FROM event_currency THEN
            RAISE EXCEPTION 'provider event identity was reused with different evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
        END IF;
        RETURN 'DUPLICATE';
    END IF;

    SELECT payment."id" INTO matched_payment_id
    FROM "payments" payment
    WHERE payment."provider" = event_provider
      AND payment."role" = 'BALANCE'
      AND (
          payment."provider_intent_id" = event_transaction_id
          OR (
              payment."provider_intent_id" IS NULL
              AND event_merchant_reference IS NOT NULL
              AND payment."merchant_reference" = event_merchant_reference
              AND payment."status" IN ('CREATED', 'FAILED', 'VOIDED')
          )
          OR (
              payment."provider_intent_id" IS NULL
              AND EXISTS (
                  SELECT 1 FROM "outbox_messages" command
                  WHERE command."aggregate_type" = 'Payment'
                    AND command."aggregate_id" = payment."id"
                    AND command."message_type" = 'void_payment'
                    AND command."payload" ->> 'paymentId' = payment."id"::text
                    AND command."payload" ->> 'provider' = event_provider
                    AND command."payload" ->> 'providerIntentId' = event_transaction_id
                    AND command."payload" ->> 'action' = 'void_payment'
              )
          )
      );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'provider transaction does not match a balance Payment'
            USING ERRCODE = '23503', CONSTRAINT = 'payments_provider_provider_intent_id_key';
    END IF;

    PERFORM taven_lock_checkout_payment_envelope(matched_payment_id);
    SELECT * INTO target_payment FROM "payments" payment
    WHERE payment."id" = matched_payment_id
      AND payment."provider" = event_provider
      AND payment."role" = 'BALANCE'
    FOR UPDATE;

    SELECT * INTO existing_event FROM "payment_provider_events"
    WHERE "provider" = event_provider AND "provider_event_id" = event_id;
    IF FOUND THEN RETURN 'DUPLICATE'; END IF;

    IF target_payment."requested_amount_minor" IS DISTINCT FROM event_amount_minor
       OR target_payment."currency" IS DISTINCT FROM event_currency
       OR target_payment."checkout_method" NOT IN ('CARD', 'BANK_TRANSFER')
       OR target_payment."checkout_command_id" IS NULL
       OR target_payment."merchant_reference" IS DISTINCT FROM event_merchant_reference THEN
        RAISE EXCEPTION 'provider evidence does not match its balance Payment command'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
    END IF;

    IF target_payment."status" = 'CREATED' THEN
        UPDATE "payments"
        SET "status" = 'PENDING', "provider_intent_id" = event_transaction_id,
            "updated_at" = verified_at
        WHERE "id" = target_payment."id";
        UPDATE "orders"
        SET "status" = 'AWAITING_BALANCE', "updated_at" = verified_at
        WHERE "id" = target_payment."order_id" AND "status" = 'QC_PASSED';
        SELECT * INTO target_payment FROM "payments"
        WHERE "id" = matched_payment_id FOR UPDATE;
    END IF;

    receipt_payload := jsonb_build_object(
        'paymentId', target_payment."id"::text,
        'providerEventId', event_id,
        'providerTransactionId', event_transaction_id,
        'merchantReference', event_merchant_reference,
        'kind', event_kind::text,
        'amountMinor', event_amount_minor::text,
        'currency', event_currency,
        'evidence', coalesce(event_evidence, '{}'::jsonb)
    );
    INSERT INTO "payment_provider_events" (
        "id", "payment_id", "refund_transaction_id", "provider",
        "provider_event_id", "provider_transaction_id", "kind",
        "amount_minor", "currency", "payload", "payload_hash",
        "occurred_at", "authenticated_at", "verified_at", "created_at"
    ) VALUES (
        receipt_id, target_payment."id", NULL, event_provider, event_id,
        event_transaction_id, event_kind, event_amount_minor, event_currency,
        receipt_payload,
        encode(sha256(convert_to(receipt_payload::text, 'UTF8')), 'hex'),
        event_occurred_at, verified_at, verified_at, verified_at
    );

    IF event_kind = 'PAYMENT_PENDING' THEN
        RETURN CASE WHEN target_payment."status" = 'PENDING'
                    THEN 'PENDING' ELSE 'IGNORED_TERMINAL' END;
    END IF;

    IF event_kind = 'PAYMENT_FAILED' THEN
        IF target_payment."status" = 'PENDING' THEN
            UPDATE "payments"
            SET "status" = 'FAILED', "capture_authorized" = false,
                "capture_cutoff_at" = verified_at, "updated_at" = verified_at
            WHERE "id" = target_payment."id";
            RETURN 'FAILED';
        END IF;
        RETURN 'IGNORED_TERMINAL';
    END IF;

    IF target_payment."status" = 'PENDING'
       AND target_payment."capture_authorized"
       AND target_payment."capture_cutoff_at" IS NULL
       AND target_payment."balance_due_at" > verified_at
       AND EXISTS (
           SELECT 1 FROM "orders" target_order
           WHERE target_order."id" = target_payment."order_id"
             AND target_order."status" IN ('QC_PASSED', 'AWAITING_BALANCE')
             AND NOT EXISTS (
                 SELECT 1 FROM "order_settlements" settlement
                 WHERE settlement."order_id" = target_order."id"
             )
       ) THEN
        UPDATE "payments"
        SET "status" = 'CAPTURED',
            "captured_amount_minor" = "requested_amount_minor",
            "provider_capture_id" = event_transaction_id,
            "captured_at" = verified_at, "updated_at" = verified_at
        WHERE "id" = target_payment."id";
        UPDATE "orders"
        SET "status" = 'READY_TO_SHIP', "updated_at" = verified_at
        WHERE "id" = target_payment."order_id"
          AND "status" IN ('QC_PASSED', 'AWAITING_BALANCE')
          AND NOT EXISTS (
              SELECT 1 FROM "jobs" packing_job
              WHERE packing_job."order_id" = target_payment."order_id"
                AND taven_job_is_current(packing_job."id")
                AND packing_job."status" <> 'PACKED'
          )
          AND NOT EXISTS (
              SELECT 1 FROM "shipments" packing_shipment
              WHERE packing_shipment."order_id" = target_payment."order_id"
                AND NOT EXISTS (
                    SELECT 1 FROM "shipments" successor
                    WHERE successor."replaces_shipment_id" = packing_shipment."id"
                )
                AND packing_shipment."status" <> 'LABEL_CREATED'
          );
        RETURN 'CAPTURED';
    END IF;

    IF target_payment."status" = 'PENDING'
       AND target_payment."balance_due_at" <= verified_at THEN
        settlement_id := taven_close_expired_balance_payment(
            target_payment."id", target_payment."balance_due_at"
        );
        SELECT * INTO target_payment FROM "payments"
        WHERE "id" = matched_payment_id FOR UPDATE;
    END IF;

    IF target_payment."status" IN ('FAILED', 'VOIDED')
       AND (
           taven_balance_payment_has_verified_provider_failure(target_payment."id")
           OR settlement_id IS NOT NULL
           OR (
               target_payment."status" = 'VOIDED'
               AND target_payment."capture_authorized" = false
               AND target_payment."capture_cutoff_at" IS NOT NULL
               AND EXISTS (
                   SELECT 1 FROM "orders" cancelled_order
                   WHERE cancelled_order."id" = target_payment."order_id"
                     AND cancelled_order."status" = 'CANCELLED'
               )
           )
           OR EXISTS (
               SELECT 1 FROM "order_settlements" settlement
               WHERE settlement."order_id" = target_payment."order_id"
                 AND settlement."kind" = 'BALANCE_SETTLEMENT'
                 AND taven_balance_attempt_belongs_to_timeout_settlement(
                     target_payment."id", settlement."id"
                 )
           )
       ) THEN
        UPDATE "payments"
        SET "status" = 'REFUND_PENDING', "capture_authorized" = false,
            "capture_cutoff_at" = coalesce("capture_cutoff_at", verified_at),
            "captured_amount_minor" = "requested_amount_minor",
            "provider_capture_id" = event_transaction_id,
            "captured_at" = verified_at, "updated_at" = verified_at
        WHERE "id" = target_payment."id";

        refund_id := gen_random_uuid();
        refund_key := 'late_balance_capture:' || encode(
            sha256(convert_to(event_provider || ':' || event_id, 'UTF8')), 'hex'
        );
        INSERT INTO "refund_transactions" (
            "id", "payment_id", "idempotency_key", "provider",
            "amount_minor", "reason", "status", "requested_at",
            "created_at", "updated_at"
        ) VALUES (
            refund_id, target_payment."id", refund_key, event_provider,
            event_amount_minor, 'LATE_CAPTURE_COMPENSATION', 'PENDING',
            verified_at, verified_at, verified_at
        ) ON CONFLICT ("payment_id", "idempotency_key") DO NOTHING;
        INSERT INTO "outbox_messages" (
            "id", "deduplication_key", "aggregate_type", "aggregate_id",
            "message_type", "schema_version", "payload", "status", "attempts",
            "available_at", "created_at", "updated_at"
        ) VALUES (
            gen_random_uuid(), 'refund_payment:v1:' || refund_id::text,
            'RefundTransaction', refund_id, 'refund_payment', 1,
            jsonb_build_object(
                'refundTransactionId', refund_id::text,
                'paymentId', target_payment."id"::text,
                'provider', event_provider,
                'providerIntentId', event_transaction_id,
                'amountMinor', event_amount_minor::text,
                'currency', event_currency,
                'idempotencyKey', refund_key,
                'compensationKind', 'balance_late_capture',
                'action', 'refund_payment'
            ), 'PENDING', 0, verified_at, verified_at, verified_at
        ) ON CONFLICT ("deduplication_key") DO NOTHING;
        RETURN 'REFUND_PENDING';
    END IF;
    RETURN 'IGNORED_TERMINAL';
END;
$$;

-- A delivered parcel can still be useful as incident evidence, but it must not
-- bypass the same accepted customer Claim window as any other post-delivery
-- report. Undelivered LOST and RETURNED parcels remain deadline-independent.
CREATE FUNCTION taven_enforce_delivered_incident_claim_window()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "claims" claim
        JOIN "shipments" incident
          ON incident."id" = claim."incident_shipment_id"
        WHERE claim."id" = NEW."claim_id"
          AND claim."origin" = 'SHIPMENT_INCIDENT'
          AND incident."status" = 'DELIVERED'
    ) AND NOT EXISTS (
        SELECT 1
        FROM "claims" claim
        JOIN "fulfilment_slots" slot
          ON slot."id" = NEW."fulfilment_slot_id"
         AND slot."order_id" = claim."order_id"
         AND slot."order_phase_id" = claim."order_phase_id"
        WHERE claim."id" = NEW."claim_id"
          AND slot."outcome" = 'DELIVERED'
          AND slot."claim_until" IS NOT NULL
          AND claim."opened_at" <= slot."claim_until"
    ) THEN
        RAISE EXCEPTION 'delivered Shipment incident Claim exceeds the accepted Claim window'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'claim_delivered_incident_window_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "claim_slot_resolutions_delivered_incident_window_valid"
BEFORE INSERT OR UPDATE ON "claim_slot_resolutions"
FOR EACH ROW EXECUTE FUNCTION taven_enforce_delivered_incident_claim_window();
