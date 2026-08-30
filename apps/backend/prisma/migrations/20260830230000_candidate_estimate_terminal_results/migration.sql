-- A candidate-estimate dispatch has exactly one immutable terminal worker
-- result. The outbox delivery marker alone cannot distinguish a failed result
-- from a later conflicting successful delivery.
CREATE TYPE "candidate_estimate_terminal_outcome" AS ENUM (
    'SUCCEEDED',
    'FAILED'
);

CREATE TABLE "candidate_estimate_terminal_results" (
    "outbox_message_id" UUID NOT NULL,
    "result_fingerprint_sha256" VARCHAR(64) NOT NULL,
    "outcome" "candidate_estimate_terminal_outcome" NOT NULL,
    "candidate_resource_estimate_id" UUID,
    "failure_class" VARCHAR(64),
    "failure_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_estimate_terminal_results_pkey"
        PRIMARY KEY ("outbox_message_id"),
    CONSTRAINT "candidate_terminal_results_candidate_key"
        UNIQUE ("candidate_resource_estimate_id"),
    CONSTRAINT "candidate_estimate_terminal_results_outbox_message_id_fkey"
        FOREIGN KEY ("outbox_message_id")
        REFERENCES "outbox_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "candidate_terminal_results_candidate_fkey"
        FOREIGN KEY ("candidate_resource_estimate_id")
        REFERENCES "candidate_resource_estimates"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "candidate_estimate_terminal_results_fingerprint_check"
        CHECK ("result_fingerprint_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "candidate_estimate_terminal_results_outcome_shape_check"
        CHECK (
            ("outcome" = 'SUCCEEDED'
             AND "candidate_resource_estimate_id" IS NOT NULL
             AND "failure_class" IS NULL
             AND "failure_code" IS NULL)
            OR
            ("outcome" = 'FAILED'
             AND "candidate_resource_estimate_id" IS NULL
             AND "failure_class" IS NOT NULL
             AND btrim("failure_class") <> ''
             AND "failure_code" IS NOT NULL
             AND btrim("failure_code") <> '')
        )
);

CREATE FUNCTION taven_validate_candidate_estimate_terminal_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    dispatch_type text;
    dispatch_job_id text;
BEGIN
    SELECT message."message_type", message."payload" #>> '{job,jobId}'
    INTO dispatch_type, dispatch_job_id
    FROM "outbox_messages" message
    WHERE message."id" = NEW."outbox_message_id"
    FOR KEY SHARE;

    IF dispatch_type IS DISTINCT FROM 'slicing.candidate-estimate.requested'
       OR dispatch_job_id IS NULL THEN
        RAISE EXCEPTION 'candidate terminal result must belong to a candidate-estimate dispatch'
            USING ERRCODE = '23514', CONSTRAINT = 'candidate_estimate_terminal_results_dispatch_scope_check';
    END IF;

    IF NEW."candidate_resource_estimate_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "candidate_resource_estimates" candidate
           WHERE candidate."id" = NEW."candidate_resource_estimate_id"
             AND candidate."resource_snapshot" ->> 'dispatchJobId' = dispatch_job_id
       ) THEN
        RAISE EXCEPTION 'candidate terminal success must reference the exact dispatch candidate'
            USING ERRCODE = '23514', CONSTRAINT = 'candidate_estimate_terminal_results_candidate_scope_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "candidate_estimate_terminal_results_scoped"
BEFORE INSERT ON "candidate_estimate_terminal_results"
FOR EACH ROW EXECUTE FUNCTION taven_validate_candidate_estimate_terminal_result();

CREATE TRIGGER "candidate_estimate_terminal_results_immutable"
BEFORE UPDATE OR DELETE ON "candidate_estimate_terminal_results"
FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
