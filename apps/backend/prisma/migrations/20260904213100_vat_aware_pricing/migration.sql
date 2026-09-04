CREATE TYPE "seller_tax_regime" AS ENUM ('NON_VAT_PAYER', 'VAT_PAYER');

ALTER TABLE "price_snapshot_components"
    DROP CONSTRAINT "price_snapshot_components_amount_scope_check";

ALTER TABLE "price_snapshot_components"
    ADD CONSTRAINT "price_snapshot_components_amount_scope_check" CHECK (
        "amount_minor" >= 0
        AND (
            ("scope" = 'ORDER'
             AND "quote_item_id" IS NULL
             AND "quote_shipment_plan_id" IS NULL
             AND "order_item_id" IS NULL
             AND "shipment_plan_id" IS NULL)
            OR ("scope" = 'QUOTE_ITEM'
                AND "quote_item_id" IS NOT NULL
                AND "quote_shipment_plan_id" IS NULL
                AND "order_item_id" IS NULL
                AND "shipment_plan_id" IS NULL)
            OR ("scope" = 'QUOTE_SHIPMENT_PLAN'
                AND "quote_item_id" IS NULL
                AND "quote_shipment_plan_id" IS NOT NULL
                AND "order_item_id" IS NULL
                AND "shipment_plan_id" IS NULL)
            OR ("scope" = 'ORDER_ITEM'
                AND "quote_item_id" IS NULL
                AND "quote_shipment_plan_id" IS NULL
                AND "order_item_id" IS NOT NULL
                AND "shipment_plan_id" IS NULL)
            OR ("scope" = 'SHIPMENT_PLAN'
                AND "quote_item_id" IS NULL
                AND "quote_shipment_plan_id" IS NULL
                AND "order_item_id" IS NULL
                AND "shipment_plan_id" IS NOT NULL)
        )
        AND (
            ("kind" IN ('ITEM_PRODUCTION', 'ITEM_QUANTITY', 'ITEM_POSTPROCESSING')
             AND "scope" IN ('QUOTE_ITEM', 'ORDER_ITEM'))
            OR ("kind" = 'SHIPMENT'
                AND "scope" IN ('QUOTE_SHIPMENT_PLAN', 'SHIPMENT_PLAN'))
            OR ("kind" IN ('ORDER_MIN_PRINT', 'ORDER_SMALL_SURCHARGE', 'EXPRESS', 'PAYMENT_FEE', 'VAT')
                AND "scope" = 'ORDER')
        )
    );

ALTER TABLE "price_snapshots"
    ADD COLUMN "tax_regime" "seller_tax_regime",
    ADD COLUMN "vat_rate_basis_points" INTEGER,
    ADD COLUMN "net_amount_minor" BIGINT,
    ADD COLUMN "vat_amount_minor" BIGINT;

ALTER TABLE "price_snapshots" DISABLE TRIGGER "price_snapshots_immutable";

UPDATE "price_snapshots"
SET "tax_regime" = 'NON_VAT_PAYER',
    "vat_rate_basis_points" = 0,
    "net_amount_minor" = "contract_total_minor",
    "vat_amount_minor" = 0;

ALTER TABLE "price_snapshots" ENABLE TRIGGER "price_snapshots_immutable";

ALTER TABLE "price_snapshots"
    ALTER COLUMN "tax_regime" SET NOT NULL,
    ALTER COLUMN "vat_rate_basis_points" SET NOT NULL,
    ALTER COLUMN "net_amount_minor" SET NOT NULL,
    ALTER COLUMN "vat_amount_minor" SET NOT NULL,
    ADD CONSTRAINT "price_snapshots_tax_values_check" CHECK (
        "vat_rate_basis_points" BETWEEN 0 AND 10000
        AND "net_amount_minor" >= 0
        AND "vat_amount_minor" >= 0
        AND "net_amount_minor" + "vat_amount_minor" = "contract_total_minor"
        AND (
            (
                "tax_regime" = 'NON_VAT_PAYER'
                AND "vat_rate_basis_points" = 0
                AND "vat_amount_minor" = 0
            )
            OR (
                "tax_regime" = 'VAT_PAYER'
                AND "vat_rate_basis_points" > 0
            )
        )
    );

-- Keep the tax facts inside the same immutable identity as the original
-- snapshot fields. The only permitted update is the existing nested seal
-- transition performed after all totals and payment schedules reconcile.
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
       AND NEW."tax_regime" IS NOT DISTINCT FROM OLD."tax_regime"
       AND NEW."vat_rate_basis_points" IS NOT DISTINCT FROM OLD."vat_rate_basis_points"
       AND NEW."net_amount_minor" IS NOT DISTINCT FROM OLD."net_amount_minor"
       AND NEW."vat_amount_minor" IS NOT DISTINCT FROM OLD."vat_amount_minor"
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

-- Completing the immutable configuration with the historical non-payer fact
-- does not change any existing price-list calculation or snapshot total.
ALTER TABLE "price_lists" DISABLE TRIGGER "price_lists_immutable";

UPDATE "price_lists"
SET "parameters" = jsonb_set(
    "parameters",
    '{sellerTaxPolicy}',
    '{"regime":"NON_VAT_PAYER","vatRateBasisPoints":0}'::jsonb,
    true
)
WHERE NOT "parameters" ? 'sellerTaxPolicy';

ALTER TABLE "price_lists" ENABLE TRIGGER "price_lists_immutable";

CREATE FUNCTION taven_default_non_vat_price_snapshot_tax()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    configured_policy jsonb;
BEGIN
    IF NEW."price_list_id" IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW."tax_regime" IS NULL
       AND NEW."vat_rate_basis_points" IS NULL
       AND NEW."net_amount_minor" IS NULL
       AND NEW."vat_amount_minor" IS NULL THEN
        SELECT "parameters" -> 'sellerTaxPolicy'
        INTO configured_policy
        FROM "price_lists"
        WHERE "id" = NEW."price_list_id";

        IF configured_policy =
           '{"regime":"NON_VAT_PAYER","vatRateBasisPoints":0}'::jsonb THEN
            NEW."tax_regime" := 'NON_VAT_PAYER';
            NEW."vat_rate_basis_points" := 0;
            NEW."net_amount_minor" := NEW."contract_total_minor";
            NEW."vat_amount_minor" := 0;
        ELSE
            RAISE EXCEPTION 'price snapshot tax fields are required'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'price_snapshots_tax_fields_required';
        END IF;
    ELSIF NEW."tax_regime" IS NULL
       OR NEW."vat_rate_basis_points" IS NULL
       OR NEW."net_amount_minor" IS NULL
       OR NEW."vat_amount_minor" IS NULL THEN
        RAISE EXCEPTION 'price snapshot tax fields must be supplied together'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'price_snapshots_tax_fields_required';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "price_snapshots_default_non_vat_tax"
BEFORE INSERT ON "price_snapshots"
FOR EACH ROW EXECUTE FUNCTION taven_default_non_vat_price_snapshot_tax();

CREATE OR REPLACE FUNCTION taven_price_snapshot_balance_earned_policy_is_valid(target_snapshot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
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
                  'EXPRESS', 'PAYMENT_FEE', 'VAT'
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
