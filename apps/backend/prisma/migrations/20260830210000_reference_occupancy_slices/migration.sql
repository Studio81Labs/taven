-- A legacy item with a partial plate has no durable tail identity to recover.
-- Lock out concurrent legacy inserts before checking and backfilling exact rows.
LOCK TABLE "quote_items", "order_items" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM (
            SELECT "reference_slice_result_id", "quantity" FROM "quote_items"
            UNION ALL
            SELECT "reference_slice_result_id", "quantity" FROM "order_items"
        ) item
        JOIN "slice_results" primary_slice
          ON primary_slice."id" = item."reference_slice_result_id"
        WHERE item."reference_slice_result_id" IS NOT NULL
          AND item."quantity" % primary_slice."parts_per_plate" <> 0
    ) THEN
        RAISE EXCEPTION 'items with partial reference plates must be re-priced before adding occupancy slices';
    END IF;
END;
$$;

ALTER TABLE "quote_items"
    ADD COLUMN "tail_reference_slice_result_id" UUID,
    ADD COLUMN "reference_parts_per_plate" INTEGER;

ALTER TABLE "order_items"
    ADD COLUMN "tail_reference_slice_result_id" UUID,
    ADD COLUMN "reference_parts_per_plate" INTEGER;

ALTER TABLE "quote_items" DISABLE TRIGGER "quote_items_immutable";
ALTER TABLE "order_items" DISABLE TRIGGER "order_items_draft_mutability";

UPDATE "quote_items" item
SET "reference_parts_per_plate" = primary_slice."parts_per_plate"
FROM "slice_results" primary_slice
WHERE primary_slice."id" = item."reference_slice_result_id";

UPDATE "order_items" item
SET "reference_parts_per_plate" = primary_slice."parts_per_plate"
FROM "slice_results" primary_slice
WHERE primary_slice."id" = item."reference_slice_result_id";

ALTER TABLE "quote_items" ENABLE TRIGGER "quote_items_immutable";
ALTER TABLE "order_items" ENABLE TRIGGER "order_items_draft_mutability";

ALTER TABLE "quote_items"
    ADD CONSTRAINT "quote_items_reference_occupancy_shape_check" CHECK (
        (
            "reference_slice_result_id" IS NULL AND
            "tail_reference_slice_result_id" IS NULL AND
            "reference_parts_per_plate" IS NULL
        ) OR (
            "reference_slice_result_id" IS NOT NULL AND
            "reference_parts_per_plate" > 0 AND
            (
                "tail_reference_slice_result_id" IS NULL OR
                "tail_reference_slice_result_id" <> "reference_slice_result_id"
            )
        )
    ),
    ADD CONSTRAINT "quote_items_tail_reference_slice_result_id_fkey"
        FOREIGN KEY ("tail_reference_slice_result_id")
        REFERENCES "slice_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_items"
    ADD CONSTRAINT "order_items_reference_occupancy_shape_check" CHECK (
        (
            "reference_slice_result_id" IS NULL AND
            "tail_reference_slice_result_id" IS NULL AND
            "reference_parts_per_plate" IS NULL
        ) OR (
            "reference_slice_result_id" IS NOT NULL AND
            "reference_parts_per_plate" > 0 AND
            (
                "tail_reference_slice_result_id" IS NULL OR
                "tail_reference_slice_result_id" <> "reference_slice_result_id"
            )
        )
    ),
    ADD CONSTRAINT "order_items_tail_reference_slice_result_id_fkey"
        FOREIGN KEY ("tail_reference_slice_result_id")
        REFERENCES "slice_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "quote_items_tail_reference_slice_result_id_idx"
    ON "quote_items"("tail_reference_slice_result_id");
CREATE INDEX "order_items_tail_reference_slice_result_id_idx"
    ON "order_items"("tail_reference_slice_result_id");

CREATE OR REPLACE FUNCTION taven_validate_item_reference_slice_inputs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    constraint_name text := CASE TG_TABLE_NAME
        WHEN 'quote_items' THEN 'quote_item_reference_slice_input_check'
        ELSE 'order_item_reference_slice_input_check'
    END;
    primary_parts_per_plate integer;
    primary_reference_profile_id uuid;
    tail_parts_per_plate integer;
    full_plate_count integer;
    tail_part_count integer;
BEGIN
    IF NEW."reference_slice_result_id" IS NULL THEN
        IF NEW."tail_reference_slice_result_id" IS NOT NULL OR
           NEW."reference_parts_per_plate" IS NOT NULL THEN
            RAISE EXCEPTION '% reference occupancy fields must be all null without a primary slice', TG_TABLE_NAME
                USING ERRCODE = '23514', CONSTRAINT = constraint_name;
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."quantity" <= 0 OR
       NEW."reference_parts_per_plate" IS NULL OR
       NEW."reference_parts_per_plate" <= 0 THEN
        RAISE EXCEPTION '% reference plate capacity must be positive', TG_TABLE_NAME
            USING ERRCODE = '23514', CONSTRAINT = constraint_name;
    END IF;

    SELECT slice_result."parts_per_plate", slice_result."reference_profile_id"
    INTO primary_parts_per_plate, primary_reference_profile_id
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
        RAISE EXCEPTION '% primary reference slice must match its exact geometry, print configuration, and material', TG_TABLE_NAME
            USING ERRCODE = '23514', CONSTRAINT = constraint_name;
    END IF;

    full_plate_count := NEW."quantity" / NEW."reference_parts_per_plate";
    tail_part_count := NEW."quantity" % NEW."reference_parts_per_plate";

    IF full_plate_count = 0 THEN
        IF primary_parts_per_plate <> NEW."quantity" OR
           NEW."tail_reference_slice_result_id" IS NOT NULL THEN
            RAISE EXCEPTION '% below-capacity reference pricing must use the actual occupancy only', TG_TABLE_NAME
                USING ERRCODE = '23514', CONSTRAINT = constraint_name;
        END IF;
        RETURN NEW;
    END IF;

    IF primary_parts_per_plate <> NEW."reference_parts_per_plate" THEN
        RAISE EXCEPTION '% primary reference slice must match the full plate capacity', TG_TABLE_NAME
            USING ERRCODE = '23514', CONSTRAINT = constraint_name;
    END IF;

    IF tail_part_count = 0 THEN
        IF NEW."tail_reference_slice_result_id" IS NOT NULL THEN
            RAISE EXCEPTION '% exact-multiple reference pricing must not persist a tail slice', TG_TABLE_NAME
                USING ERRCODE = '23514', CONSTRAINT = constraint_name;
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."tail_reference_slice_result_id" IS NULL THEN
        RAISE EXCEPTION '% partial reference pricing requires a tail slice', TG_TABLE_NAME
            USING ERRCODE = '23514', CONSTRAINT = constraint_name;
    END IF;

    SELECT slice_result."parts_per_plate"
    INTO tail_parts_per_plate
    FROM "slice_results" slice_result
    JOIN "reference_profiles" reference_profile
      ON reference_profile."id" = slice_result."reference_profile_id"
    WHERE slice_result."id" = NEW."tail_reference_slice_result_id"
      AND slice_result."kind" = 'REFERENCE'
      AND slice_result."model_geometry_id" = NEW."model_geometry_id"
      AND slice_result."print_config_revision_id" = NEW."print_config_revision_id"
      AND slice_result."reference_profile_id" = primary_reference_profile_id
      AND reference_profile."material" = NEW."material"
    FOR KEY SHARE;

    IF NOT FOUND OR tail_parts_per_plate <> tail_part_count THEN
        RAISE EXCEPTION '% tail reference slice must match the partial plate occupancy and immutable inputs', TG_TABLE_NAME
            USING ERRCODE = '23514', CONSTRAINT = constraint_name;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER "order_items_reference_slice_inputs" ON "order_items";
CREATE TRIGGER "order_items_reference_slice_inputs"
BEFORE INSERT OR UPDATE OF
    "reference_slice_result_id",
    "tail_reference_slice_result_id",
    "reference_parts_per_plate",
    "model_geometry_id",
    "print_config_revision_id",
    "material",
    "quantity"
ON "order_items"
FOR EACH ROW EXECUTE FUNCTION taven_validate_item_reference_slice_inputs();

CREATE OR REPLACE FUNCTION taven_assert_automatic_order_reference_slices(target_order_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "automatic_order_origins" origin
        JOIN "order_items" item ON item."order_id" = origin."order_id"
        LEFT JOIN "slice_results" primary_slice
          ON primary_slice."id" = item."reference_slice_result_id"
        LEFT JOIN "reference_profiles" primary_profile
          ON primary_profile."id" = primary_slice."reference_profile_id"
        LEFT JOIN "slice_results" tail_slice
          ON tail_slice."id" = item."tail_reference_slice_result_id"
        LEFT JOIN "reference_profiles" tail_profile
          ON tail_profile."id" = tail_slice."reference_profile_id"
        WHERE origin."order_id" = target_order_id
          AND (
              item."reference_slice_result_id" IS NOT NULL AND
              item."reference_parts_per_plate" IS NOT NULL AND
              item."reference_parts_per_plate" > 0 AND
              primary_slice."kind" = 'REFERENCE' AND
              primary_slice."model_geometry_id" = item."model_geometry_id" AND
              primary_slice."print_config_revision_id" = item."print_config_revision_id" AND
              primary_profile."material" = item."material" AND
              (
                  (
                      item."quantity" < item."reference_parts_per_plate" AND
                      primary_slice."parts_per_plate" = item."quantity" AND
                      item."tail_reference_slice_result_id" IS NULL
                  ) OR (
                      item."quantity" >= item."reference_parts_per_plate" AND
                      primary_slice."parts_per_plate" = item."reference_parts_per_plate" AND
                      (
                          (
                              item."quantity" % item."reference_parts_per_plate" = 0 AND
                              item."tail_reference_slice_result_id" IS NULL
                          ) OR (
                              item."quantity" % item."reference_parts_per_plate" > 0 AND
                              item."tail_reference_slice_result_id" IS NOT NULL AND
                              tail_slice."kind" = 'REFERENCE' AND
                              tail_slice."model_geometry_id" = item."model_geometry_id" AND
                              tail_slice."print_config_revision_id" = item."print_config_revision_id" AND
                              tail_slice."reference_profile_id" = primary_slice."reference_profile_id" AND
                              tail_profile."material" = item."material" AND
                              tail_slice."parts_per_plate" =
                                  item."quantity" % item."reference_parts_per_plate"
                          )
                      )
                  )
              )
          ) IS NOT TRUE
    ) THEN
        RAISE EXCEPTION 'automatic order pricing requires canonical reference occupancies for every item'
            USING ERRCODE = '23514', CONSTRAINT = 'automatic_order_reference_slice_check';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION taven_validate_individual_order_item_source()
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
          AND order_item."tail_reference_slice_result_id" IS NOT DISTINCT FROM quote_item."tail_reference_slice_result_id"
          AND order_item."reference_parts_per_plate" IS NOT DISTINCT FROM quote_item."reference_parts_per_plate"
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
