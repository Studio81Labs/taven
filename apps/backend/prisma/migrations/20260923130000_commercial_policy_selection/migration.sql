-- Publication selects one immutable PriceList per currency. Deployment must
-- identify the exact legacy automatic list; a missing or ambiguous seed is a
-- migration failure, never an inferred default.
DO $$
BEGIN
    IF (SELECT count(*) FROM "price_lists"
        WHERE "currency" = 'CZK' AND "revision" = 'automatic-v0-czk') <> 1 THEN
        RAISE EXCEPTION 'expected exactly one automatic-v0-czk PriceList for selector bootstrap';
    END IF;
END;
$$;

ALTER TABLE "price_lists"
    ADD CONSTRAINT "price_lists_id_currency_key" UNIQUE ("id", "currency");

CREATE TABLE "commercial_policy_selections" (
    "currency" CHAR(3) NOT NULL,
    "price_list_id" UUID NOT NULL,
    "selection_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "commercial_policy_selections_pkey" PRIMARY KEY ("currency"),
    CONSTRAINT "commercial_policy_selections_version_check"
        CHECK ("selection_version" > 0),
    CONSTRAINT "commercial_policy_selections_currency_check"
        CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "commercial_policy_selections_price_list_currency_fkey"
        FOREIGN KEY ("price_list_id", "currency")
        REFERENCES "price_lists"("id", "currency")
        ON DELETE RESTRICT ON UPDATE RESTRICT
);

INSERT INTO "commercial_policy_selections"
    ("currency", "price_list_id", "selection_version")
SELECT 'CZK', "id", 1 FROM "price_lists"
WHERE "currency" = 'CZK' AND "revision" = 'automatic-v0-czk';

CREATE FUNCTION taven_guard_commercial_policy_selection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commercial policy selection cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'commercial_policy_selection_guard';
    END IF;
    IF NEW."currency" <> OLD."currency"
       OR NEW."selection_version" <> OLD."selection_version" + 1 THEN
        RAISE EXCEPTION 'commercial policy selection version must advance once'
            USING ERRCODE = '23514', CONSTRAINT = 'commercial_policy_selection_guard';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "commercial_policy_selection_guard"
BEFORE UPDATE OR DELETE ON "commercial_policy_selections"
FOR EACH ROW EXECUTE FUNCTION taven_guard_commercial_policy_selection();

-- A fresh automatic binding may be inserted only while its transaction has
-- declared and held the current selector fence. This guard checks the tuple;
-- it intentionally does not acquire a lower-ranked selector lock after the
-- order/session lock has already been taken.
CREATE FUNCTION taven_require_automatic_commercial_policy_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    selected_list_id uuid;
    selected_version integer;
    declared_version text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "automatic_quote_drafts" draft
        WHERE draft."order_id" = NEW."order_id"
    ) THEN
        RETURN NEW;
    END IF;
    -- Historical EUR automatic fixtures and imports predate the CZK automatic
    -- selector. Only CZK new-admission bindings use this publication fence.
    IF NOT EXISTS (
        SELECT 1 FROM "price_snapshots" snapshot
        WHERE snapshot."id" = NEW."price_snapshot_id"
          AND snapshot."currency" = 'CZK'
    ) THEN
        RETURN NEW;
    END IF;

    declared_version := current_setting('taven.commercial_policy_selection_version', true);
    IF declared_version IS NULL OR declared_version = '' THEN
        RAISE EXCEPTION 'automatic binding requires a commercial policy fence'
            USING ERRCODE = '23514', CONSTRAINT = 'automatic_binding_commercial_policy_fence';
    END IF;

    SELECT "price_list_id", "selection_version"
      INTO selected_list_id, selected_version
      FROM "commercial_policy_selections" WHERE "currency" = 'CZK';
    IF selected_list_id IS NULL
       OR selected_version::text <> declared_version
       OR NOT EXISTS (
           SELECT 1 FROM "price_snapshots" snapshot
           WHERE snapshot."id" = NEW."price_snapshot_id"
             AND snapshot."price_list_id" = selected_list_id
       ) THEN
        RAISE EXCEPTION 'automatic binding commercial policy changed'
            USING ERRCODE = '23514', CONSTRAINT = 'automatic_binding_commercial_policy_fence';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "automatic_binding_commercial_policy_fence"
BEFORE INSERT ON "order_price_bindings"
FOR EACH ROW EXECUTE FUNCTION taven_require_automatic_commercial_policy_fence();
