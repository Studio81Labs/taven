BEGIN;

CREATE TABLE "arrangement_revisions" (
    "id" UUID NOT NULL,
    "content_sha256" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arrangement_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "arrangement_revisions_content_sha256_check"
        CHECK ("content_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE TRIGGER "arrangement_revisions_immutable"
    BEFORE UPDATE OR DELETE ON "arrangement_revisions"
    FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');

-- Candidate rows introduced before this identity anchor can be backfilled only
-- from their immutable dispatch envelopes. Refuse ambiguous or missing input
-- rather than guessing a digest for an already reserved arrangement UUID.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "candidate_resource_estimates" candidate
        WHERE NOT EXISTS (
            SELECT 1
            FROM "outbox_messages" message
            WHERE message."message_type" = 'slicing.candidate-estimate.requested'
              AND message."aggregate_id" =
                    (candidate."resource_snapshot" ->> 'dispatchJobId')::uuid
              AND message."payload" #>> '{job,input,arrangementRevision,revisionId}' =
                    candidate."arrangement_revision_id"::text
              AND message."payload" #>> '{job,input,arrangementRevision,contentSha256}'
                    ~ '^[0-9a-f]{64}$'
        )
    ) THEN
        RAISE EXCEPTION 'candidate arrangement revision has no immutable dispatch digest'
            USING ERRCODE = '23514', CONSTRAINT = 'candidate_arrangement_revision_backfill_check';
    END IF;

    IF EXISTS (
        SELECT candidate."arrangement_revision_id"
        FROM "candidate_resource_estimates" candidate
        JOIN "outbox_messages" message
          ON message."message_type" = 'slicing.candidate-estimate.requested'
         AND message."aggregate_id" =
                (candidate."resource_snapshot" ->> 'dispatchJobId')::uuid
         AND message."payload" #>> '{job,input,arrangementRevision,revisionId}' =
                candidate."arrangement_revision_id"::text
        GROUP BY candidate."arrangement_revision_id"
        HAVING count(DISTINCT (
            message."payload" #>> '{job,input,arrangementRevision,contentSha256}'
        )) > 1
    ) THEN
        RAISE EXCEPTION 'candidate arrangement revision maps to conflicting immutable digests'
            USING ERRCODE = '23514', CONSTRAINT = 'candidate_arrangement_revision_backfill_check';
    END IF;
END;
$$;

INSERT INTO "arrangement_revisions" ("id", "content_sha256")
SELECT candidate."arrangement_revision_id",
       min(message."payload" #>> '{job,input,arrangementRevision,contentSha256}')
FROM "candidate_resource_estimates" candidate
JOIN "outbox_messages" message
  ON message."message_type" = 'slicing.candidate-estimate.requested'
 AND message."aggregate_id" =
        (candidate."resource_snapshot" ->> 'dispatchJobId')::uuid
 AND message."payload" #>> '{job,input,arrangementRevision,revisionId}' =
        candidate."arrangement_revision_id"::text
GROUP BY candidate."arrangement_revision_id";

ALTER TABLE "candidate_resource_estimates"
    ADD CONSTRAINT "candidate_resource_estimates_arrangement_revision_id_fkey"
        FOREIGN KEY ("arrangement_revision_id")
        REFERENCES "arrangement_revisions"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
