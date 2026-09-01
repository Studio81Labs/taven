ALTER TABLE "automatic_quote_item_drafts"
    DROP CONSTRAINT "automatic_quote_item_drafts_values_check";

ALTER TABLE "automatic_quote_item_drafts"
    ALTER COLUMN "reference_parts_per_plate" DROP NOT NULL,
    ADD COLUMN "reference_probe_lower_bound" INTEGER,
    ADD COLUMN "reference_probe_upper_bound" INTEGER;

UPDATE "automatic_quote_item_drafts" item
SET "reference_probe_lower_bound" = item."reference_parts_per_plate",
    "reference_probe_upper_bound" = item."reference_parts_per_plate" + 1
WHERE EXISTS (
    SELECT 1
    FROM "order_price_bindings" binding
    WHERE binding."order_id" = item."order_id"
);

UPDATE "automatic_quote_item_drafts" item
SET "reference_parts_per_plate" = NULL,
    "reference_probe_lower_bound" = 0,
    "reference_probe_upper_bound" = item."quantity" + 1
WHERE NOT EXISTS (
    SELECT 1
    FROM "order_price_bindings" binding
    WHERE binding."order_id" = item."order_id"
);

ALTER TABLE "automatic_quote_item_drafts"
    ALTER COLUMN "reference_probe_lower_bound" SET NOT NULL,
    ALTER COLUMN "reference_probe_lower_bound" SET DEFAULT 0,
    ALTER COLUMN "reference_probe_upper_bound" SET NOT NULL,
    ADD CONSTRAINT "automatic_quote_item_drafts_values_check" CHECK (
        "ordinal" >= 0
        AND cardinality("body_ids") BETWEEN 1 AND 256
        AND "selection_sha256" ~ '^[a-f0-9]{64}$'
        AND "configuration_fingerprint" ~ '^[a-f0-9]{64}$'
        AND "infill_preset" ~ '[^[:space:]]'
        AND "quantity" BETWEEN 1 AND 1000
        AND "reference_probe_lower_bound" BETWEEN 0 AND "quantity"
        AND "reference_probe_upper_bound" BETWEEN 1 AND "quantity" + 1
        AND "reference_probe_lower_bound" < "reference_probe_upper_bound"
        AND (
            "reference_parts_per_plate" IS NULL
            OR (
                "reference_parts_per_plate" = "reference_probe_lower_bound"
                AND "reference_probe_upper_bound" =
                    "reference_parts_per_plate" + 1
            )
        )
    );
