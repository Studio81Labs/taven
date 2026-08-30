-- Candidate estimates created by the legacy schema cannot be given an
-- invented tail slice. Exact-multiple estimates can be migrated losslessly;
-- every other data set must be re-estimated before this migration.
LOCK TABLE "candidate_resource_estimates" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "candidate_resource_estimates" candidate
        JOIN "slice_results" primary_slice
          ON primary_slice."id" = candidate."slice_result_id"
        WHERE candidate."quantity" % primary_slice."parts_per_plate" <> 0
    ) THEN
        RAISE EXCEPTION 'candidate estimates with partial plates must be re-estimated before adding occupancy slices';
    END IF;
END;
$$;

ALTER TABLE "candidate_resource_estimates"
    ADD COLUMN "parts_per_plate" INTEGER,
    ADD COLUMN "tail_slice_result_id" UUID;

ALTER TABLE "candidate_resource_estimates"
    DISABLE TRIGGER "candidate_resource_estimates_immutable";

UPDATE "candidate_resource_estimates" candidate
SET "parts_per_plate" = primary_slice."parts_per_plate"
FROM "slice_results" primary_slice
WHERE primary_slice."id" = candidate."slice_result_id";

ALTER TABLE "candidate_resource_estimates"
    ENABLE TRIGGER "candidate_resource_estimates_immutable";

ALTER TABLE "candidate_resource_estimates"
    ALTER COLUMN "parts_per_plate" SET NOT NULL,
    ADD CONSTRAINT "candidate_resource_estimates_occupancy_shape_check" CHECK (
        "parts_per_plate" > 0 AND
        ("tail_slice_result_id" IS NULL OR "tail_slice_result_id" <> "slice_result_id")
    ),
    ADD CONSTRAINT "candidate_resource_estimates_tail_slice_result_id_model_ge_fkey"
        FOREIGN KEY (
            "tail_slice_result_id",
            "model_geometry_id",
            "print_config_revision_id",
            "machine_profile_id",
            "machine_calibration_id"
        ) REFERENCES "slice_results" (
            "id",
            "model_geometry_id",
            "print_config_revision_id",
            "machine_profile_id",
            "machine_calibration_id"
        ) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "candidate_resource_estimates_tail_slice_result_id_idx"
    ON "candidate_resource_estimates"("tail_slice_result_id");

CREATE OR REPLACE FUNCTION taven_validate_candidate_resource_quantities()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    primary_parts_per_plate integer;
    primary_print_seconds numeric;
    primary_material_milligrams numeric;
    tail_parts_per_plate integer;
    tail_print_seconds numeric;
    tail_material_milligrams numeric;
    full_plate_count integer;
    tail_part_count integer;
    minimum_print_seconds numeric;
    minimum_material_milligrams numeric;
BEGIN
    IF NEW."quantity" <= 0 OR NEW."parts_per_plate" <= 0 THEN
        RAISE EXCEPTION 'candidate quantity and plate capacity must be positive'
            USING ERRCODE = '23514', CONSTRAINT = 'candidate_resource_quantity_check';
    END IF;

    SELECT
        selected_slice."parts_per_plate",
        selected_slice."estimated_print_seconds"::numeric,
        selected_slice."estimated_material_milligrams"::numeric
    INTO
        primary_parts_per_plate,
        primary_print_seconds,
        primary_material_milligrams
    FROM "slice_results" selected_slice
    WHERE selected_slice."id" = NEW."slice_result_id"
      AND selected_slice."kind" = 'PRODUCTION'
      AND selected_slice."model_geometry_id" = NEW."model_geometry_id"
      AND selected_slice."print_config_revision_id" = NEW."print_config_revision_id"
      AND selected_slice."machine_profile_id" = NEW."machine_profile_id"
      AND selected_slice."machine_calibration_id" = NEW."machine_calibration_id";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'candidate primary occupancy slice is incompatible'
            USING ERRCODE = '23514', CONSTRAINT = 'candidate_resource_quantity_check';
    END IF;

    full_plate_count := NEW."quantity" / NEW."parts_per_plate";
    tail_part_count := NEW."quantity" % NEW."parts_per_plate";

    IF full_plate_count = 0 THEN
        IF primary_parts_per_plate <> NEW."quantity" OR NEW."tail_slice_result_id" IS NOT NULL THEN
            RAISE EXCEPTION 'candidate below plate capacity must use its actual occupancy as the primary slice'
                USING ERRCODE = '23514', CONSTRAINT = 'candidate_resource_quantity_check';
        END IF;
        minimum_print_seconds := primary_print_seconds;
        minimum_material_milligrams := primary_material_milligrams;
    ELSE
        IF primary_parts_per_plate <> NEW."parts_per_plate" THEN
            RAISE EXCEPTION 'candidate primary slice must match planned plate capacity'
                USING ERRCODE = '23514', CONSTRAINT = 'candidate_resource_quantity_check';
        END IF;

        minimum_print_seconds := primary_print_seconds * full_plate_count;
        minimum_material_milligrams := primary_material_milligrams * full_plate_count;

        IF tail_part_count = 0 THEN
            IF NEW."tail_slice_result_id" IS NOT NULL THEN
                RAISE EXCEPTION 'an exact-multiple candidate must not persist a tail slice'
                    USING ERRCODE = '23514', CONSTRAINT = 'candidate_resource_quantity_check';
            END IF;
        ELSE
            IF NEW."tail_slice_result_id" IS NULL THEN
                RAISE EXCEPTION 'a partial candidate plate requires its tail occupancy slice'
                    USING ERRCODE = '23514', CONSTRAINT = 'candidate_resource_quantity_check';
            END IF;

            SELECT
                selected_slice."parts_per_plate",
                selected_slice."estimated_print_seconds"::numeric,
                selected_slice."estimated_material_milligrams"::numeric
            INTO
                tail_parts_per_plate,
                tail_print_seconds,
                tail_material_milligrams
            FROM "slice_results" selected_slice
            WHERE selected_slice."id" = NEW."tail_slice_result_id"
              AND selected_slice."kind" = 'PRODUCTION'
              AND selected_slice."model_geometry_id" = NEW."model_geometry_id"
              AND selected_slice."print_config_revision_id" = NEW."print_config_revision_id"
              AND selected_slice."machine_profile_id" = NEW."machine_profile_id"
              AND selected_slice."machine_calibration_id" = NEW."machine_calibration_id";

            IF NOT FOUND OR tail_parts_per_plate <> tail_part_count THEN
                RAISE EXCEPTION 'candidate tail slice must match the partial plate occupancy'
                    USING ERRCODE = '23514', CONSTRAINT = 'candidate_resource_quantity_check';
            END IF;

            minimum_print_seconds := minimum_print_seconds + tail_print_seconds;
            minimum_material_milligrams := minimum_material_milligrams + tail_material_milligrams;
        END IF;
    END IF;

    IF NEW."required_material_milligrams"::numeric < minimum_material_milligrams OR
       NEW."required_machine_seconds"::numeric < minimum_print_seconds THEN
        RAISE EXCEPTION 'candidate aggregate quantities understate its occupancy slices'
            USING ERRCODE = '23514', CONSTRAINT = 'candidate_resource_quantity_check';
    END IF;

    RETURN NEW;
END;
$$;
