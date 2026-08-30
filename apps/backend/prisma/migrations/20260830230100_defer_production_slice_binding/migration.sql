BEGIN;

-- A candidate's reusable occupancy metrics are evidence for a reservation,
-- not the accepted Job's production artifact. Keep both identities explicit.
ALTER TABLE "production_reservations"
    ADD COLUMN "occupancy_slice_result_id" UUID;
ALTER TABLE "production_reservations"
    ALTER COLUMN "slice_result_id" DROP NOT NULL;

-- Candidate rows created before this correction used PRODUCTION for their
-- slice-metrics JSON. A Job which has already sealed one of those rows cannot
-- be repaired without producing a real Job-bound G-code package.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "jobs" job
        JOIN "production_reservations" production
          ON production."job_id" = job."id"
         AND production."node_id" = job."node_id"
         AND production."phase_resource_plan_job_id" = job."phase_resource_plan_job_id"
        JOIN "phase_resource_plan_jobs" plan_job
          ON plan_job."id" = production."phase_resource_plan_job_id"
         AND plan_job."node_id" = production."node_id"
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = plan_job."candidate_resource_estimate_id"
         AND candidate."node_id" = plan_job."node_id"
        WHERE job."status" IN (
            'GCODE_READY', 'PRINTING', 'PRINTED', 'PHOTO_SUBMITTED',
            'QC_APPROVED', 'QC_REJECTED', 'PACKED', 'HANDED_OVER', 'SETTLED'
        )
          AND job."production_slice_result_id" = candidate."slice_result_id"
    ) THEN
        RAISE EXCEPTION 'cannot migrate a Job whose G-code is a candidate occupancy analysis row; re-slice the Job before deploying'
            USING ERRCODE = '55000';
    END IF;
END;
$$;

ALTER TABLE "slice_results"
    DROP CONSTRAINT "slice_results_profile_shape_check",
    ADD CONSTRAINT "slice_results_profile_shape_check" CHECK (
        ("kind" = 'REFERENCE' AND "reference_profile_id" IS NOT NULL AND "machine_profile_id" IS NULL AND "machine_calibration_id" IS NULL) OR
        ("kind" IN ('ANALYSIS', 'PRODUCTION') AND "reference_profile_id" IS NULL AND "machine_profile_id" IS NOT NULL AND "machine_calibration_id" IS NOT NULL)
    );

ALTER TABLE "production_reservations"
    DISABLE TRIGGER "production_reservations_payload_immutable";

UPDATE "production_reservations" production
SET "occupancy_slice_result_id" = candidate."slice_result_id"
FROM "phase_resource_plan_jobs" plan_job
JOIN "candidate_resource_estimates" candidate
  ON candidate."id" = plan_job."candidate_resource_estimate_id"
 AND candidate."node_id" = plan_job."node_id"
WHERE plan_job."id" = production."phase_resource_plan_job_id"
  AND plan_job."node_id" = production."node_id"
  AND plan_job."phase_resource_plan_id" = production."phase_resource_plan_id";

-- Old reservation creation copied the candidate primary row into this column.
-- Clear only that erroneous copied value; a separately persisted actual
-- production artifact remains a valid deferred binding.
UPDATE "production_reservations" production
SET "slice_result_id" = NULL
FROM "phase_resource_plan_jobs" plan_job
JOIN "candidate_resource_estimates" candidate
  ON candidate."id" = plan_job."candidate_resource_estimate_id"
 AND candidate."node_id" = plan_job."node_id"
WHERE plan_job."id" = production."phase_resource_plan_job_id"
  AND plan_job."node_id" = production."node_id"
  AND production."slice_result_id" = candidate."slice_result_id";

ALTER TABLE "production_reservations"
    ENABLE TRIGGER "production_reservations_payload_immutable";

ALTER TABLE "slice_results"
    DISABLE TRIGGER "slice_results_immutable";

UPDATE "slice_results" result
SET "kind" = 'ANALYSIS'
WHERE EXISTS (
    SELECT 1
    FROM "candidate_resource_estimates" candidate
    WHERE candidate."slice_result_id" = result."id"
       OR candidate."tail_slice_result_id" = result."id"
);

ALTER TABLE "slice_results"
    ENABLE TRIGGER "slice_results_immutable";

ALTER TABLE "production_reservations"
    ALTER COLUMN "occupancy_slice_result_id" SET NOT NULL,
    ADD CONSTRAINT "production_reservations_occupancy_slice_result_id_fkey"
        FOREIGN KEY ("occupancy_slice_result_id")
        REFERENCES "slice_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "production_reservations_occupancy_slice_result_id_idx"
    ON "production_reservations"("occupancy_slice_result_id");

-- Candidate occupancy validation must accept only reusable analysis rows.
DO $$
DECLARE
    definition text;
BEGIN
    SELECT pg_get_functiondef(
        'taven_validate_candidate_resource_quantities()'::regprocedure
    ) INTO definition;
    IF position('selected_slice."kind" = ''PRODUCTION''' IN definition) = 0 THEN
        RAISE EXCEPTION 'candidate quantity validation no longer has the expected production-slice predicate';
    END IF;
    definition := replace(
        definition,
        'selected_slice."kind" = ''PRODUCTION''',
        'selected_slice."kind" = ''ANALYSIS'''
    );
    EXECUTE definition;
END;
$$;

-- Preserve direct, immutable reservation provenance even though the eventual
-- G-code package is not available when capacity is reserved. The existing
-- reservation SQL still supplies the legacy slice column; normalize it here.
CREATE FUNCTION taven_bind_production_reservation_occupancy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_occupancy_id uuid;
BEGIN
    SELECT candidate."slice_result_id"
    INTO expected_occupancy_id
    FROM "phase_resource_plan_jobs" plan_job
    JOIN "candidate_resource_estimates" candidate
      ON candidate."id" = plan_job."candidate_resource_estimate_id"
     AND candidate."node_id" = plan_job."node_id"
    WHERE plan_job."id" = NEW."phase_resource_plan_job_id"
      AND plan_job."node_id" = NEW."node_id"
      AND plan_job."phase_resource_plan_id" = NEW."phase_resource_plan_id";

    IF expected_occupancy_id IS NULL THEN
        RAISE EXCEPTION 'production reservation must be created from a planned candidate occupancy'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_occupancy_binding_check';
    END IF;

    IF NEW."slice_result_id" IS NOT NULL
       AND NEW."slice_result_id" <> expected_occupancy_id THEN
        RAISE EXCEPTION 'production reservation cannot bind a production artifact before its accepted Job exists'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_occupancy_binding_check';
    END IF;

    NEW."occupancy_slice_result_id" := expected_occupancy_id;
    NEW."slice_result_id" := NULL;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "production_reservations_occupancy_binding"
BEFORE INSERT ON "production_reservations"
FOR EACH ROW EXECUTE FUNCTION taven_bind_production_reservation_occupancy();

CREATE FUNCTION taven_validate_production_slice_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."slice_result_id" IS NOT NULL
       OR NEW."slice_result_id" IS NULL
       OR NEW."job_id" IS NULL
       OR NOT EXISTS (
            SELECT 1
            FROM "slice_results" slice_result
            WHERE slice_result."id" = NEW."slice_result_id"
              AND slice_result."kind" = 'PRODUCTION'
              AND slice_result."print_config_revision_id" = NEW."print_config_revision_id"
              AND slice_result."machine_profile_id" = NEW."machine_profile_id"
              AND slice_result."machine_calibration_id" = NEW."machine_calibration_id"
              AND EXISTS (
                  SELECT 1
                  FROM "slice_results" occupancy
                  WHERE occupancy."id" = NEW."occupancy_slice_result_id"
                    AND occupancy."model_geometry_id" = slice_result."model_geometry_id"
              )
              AND slice_result."artifact_object_key" ~
                  ('^gcode/' || NEW."job_id"::text || '/toolpaths\.(gcode_3mf|bgcode|gcode)$')
       ) THEN
        RAISE EXCEPTION 'production reservation may bind exactly one Job-bound production artifact'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_production_slice_binding_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "production_reservations_production_slice_binding"
BEFORE UPDATE OF "slice_result_id" ON "production_reservations"
FOR EACH ROW
WHEN (OLD."slice_result_id" IS DISTINCT FROM NEW."slice_result_id")
EXECUTE FUNCTION taven_validate_production_slice_binding();

DROP TRIGGER "production_reservations_payload_immutable" ON "production_reservations";
CREATE TRIGGER "production_reservations_payload_immutable"
BEFORE UPDATE OR DELETE ON "production_reservations"
FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('job_id,slice_result_id,status,updated_at');

-- The old lock helper follows production_reservations.slice_result_id. Before
-- G-code exists, lock the immutable candidate occupancy instead.
DO $$
DECLARE
    definition text;
    old_fragment text := 'FROM "production_reservations" production
        JOIN "slice_results" slice_result
          ON slice_result."id" = production."slice_result_id"';
    new_fragment text := 'FROM "production_reservations" production
        JOIN "phase_resource_plan_jobs" plan_job
          ON plan_job."id" = production."phase_resource_plan_job_id"
         AND plan_job."node_id" = production."node_id"
         AND plan_job."phase_resource_plan_id" = production."phase_resource_plan_id"
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = plan_job."candidate_resource_estimate_id"
         AND candidate."node_id" = plan_job."node_id"
        JOIN "slice_results" slice_result
          ON slice_result."id" = candidate."slice_result_id"';
BEGIN
    SELECT pg_get_functiondef(
        'taven_lock_phase_reservation_resources()'::regprocedure
    ) INTO definition;
    IF position(old_fragment IN definition) = 0 THEN
        RAISE EXCEPTION 'phase reservation lock function no longer has the expected slice join';
    END IF;
    definition := replace(definition, old_fragment, new_fragment);
    EXECUTE definition;
END;
$$;

-- Retention and complete-set validation have the same separation: candidate
-- analysis establishes resource feasibility; a later production artifact
-- establishes G-code readiness.
DO $$
DECLARE
    definition text;
    old_retention_fragment text := 'FROM "production_reservations" production
        JOIN "slice_results" slice_result
          ON slice_result."id" = production."slice_result_id"';
    new_retention_fragment text := 'FROM "production_reservations" production
        JOIN "phase_resource_plan_jobs" plan_job
          ON plan_job."id" = production."phase_resource_plan_job_id"
         AND plan_job."node_id" = production."node_id"
         AND plan_job."phase_resource_plan_id" = production."phase_resource_plan_id"
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = plan_job."candidate_resource_estimate_id"
         AND candidate."node_id" = plan_job."node_id"
        JOIN "slice_results" slice_result
          ON slice_result."id" = candidate."slice_result_id"';
    old_resource_fragment text := 'JOIN "slice_results" selected_slice
                ON selected_slice."id" = production."slice_result_id"';
    new_resource_fragment text := 'JOIN "phase_resource_plan_jobs" plan_job
                ON plan_job."id" = production."phase_resource_plan_job_id"
               AND plan_job."node_id" = production."node_id"
               AND plan_job."phase_resource_plan_id" = production."phase_resource_plan_id"
              JOIN "candidate_resource_estimates" candidate
                ON candidate."id" = plan_job."candidate_resource_estimate_id"
               AND candidate."node_id" = plan_job."node_id"
              JOIN "slice_results" selected_slice
                ON selected_slice."id" = candidate."slice_result_id"';
    old_complete_fragment text := 'AND production."slice_result_id" = candidate."slice_result_id"';
    new_complete_fragment text := 'AND production."occupancy_slice_result_id" = candidate."slice_result_id"';
    old_complete_slice_fragment text := 'JOIN "slice_results" slice_result
      ON slice_result."id" = production."slice_result_id"
     AND slice_result."kind" = ''PRODUCTION''
     AND slice_result."print_config_revision_id" = production."print_config_revision_id"
     AND slice_result."machine_profile_id" = production."machine_profile_id"
     AND slice_result."machine_calibration_id" = production."machine_calibration_id"';
    new_complete_slice_fragment text := 'JOIN "slice_results" slice_result
      ON slice_result."id" = production."occupancy_slice_result_id"
     AND slice_result."kind" = ''ANALYSIS''
     AND slice_result."print_config_revision_id" = production."print_config_revision_id"
     AND slice_result."machine_profile_id" = production."machine_profile_id"
     AND slice_result."machine_calibration_id" = production."machine_calibration_id"';
BEGIN
    SELECT pg_get_functiondef(
        'taven_validate_phase_reservation_set(uuid)'::regprocedure
    ) INTO definition;
    IF position(old_retention_fragment IN definition) = 0
       OR position(old_resource_fragment IN definition) = 0
       OR position(old_complete_fragment IN definition) = 0
       OR position(old_complete_slice_fragment IN definition) = 0 THEN
        RAISE EXCEPTION 'phase reservation validation no longer has the expected candidate slice predicates';
    END IF;
    definition := replace(definition, old_retention_fragment, new_retention_fragment);
    definition := replace(definition, old_resource_fragment, new_resource_fragment);
    definition := replace(definition, old_complete_fragment, new_complete_fragment);
    definition := replace(definition, old_complete_slice_fragment, new_complete_slice_fragment);
    EXECUTE definition;
END;
$$;

DO $$
DECLARE
    definition text;
BEGIN
    SELECT pg_get_functiondef(
        'taven_model_source_live_capacity_horizon(uuid)'::regprocedure
    ) INTO definition;
    IF position('production."slice_result_id" = slice_result."id"' IN definition) = 0 THEN
        RAISE EXCEPTION 'model source retention horizon no longer has the expected reservation slice join';
    END IF;
    definition := replace(
        definition,
        'production."slice_result_id" = slice_result."id"',
        'production."occupancy_slice_result_id" = slice_result."id"'
    );
    EXECUTE definition;
END;
$$;

COMMIT;
