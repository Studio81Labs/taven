-- Canonical issuance evidence is deliberately additive. Existing handoff
-- capabilities stay consumable through their original token expiry, but rows
-- whose original command identity cannot be proved never become issuable or
-- replayable again.
ALTER TABLE "automatic_quote_handoff_capabilities"
  ADD COLUMN "issuance_idempotency_record_id" UUID,
  ADD COLUMN "issuance_key_hash" VARCHAR(64),
  ADD COLUMN "issuance_replay_until" TIMESTAMPTZ(3),
  ADD COLUMN "issuance_legacy_exhausted" BOOLEAN NOT NULL DEFAULT FALSE;

-- The pre-existing trigger allows only consumption transitions. Disable just
-- that trigger for this transactional, one-time data migration; the hardened
-- definition below is restored before the migration commits.
ALTER TABLE "automatic_quote_handoff_capabilities"
  DISABLE TRIGGER "automatic_quote_handoff_capabilities_immutable";

-- A historical binding is provable only when precisely one generation-one,
-- completed command in the source namespace saved this exact handoff ID.
-- Its persisted deadline, not migration time, remains the replay deadline.
WITH candidates AS (
  SELECT
    capability.id AS capability_id,
    record.id AS record_id,
    record.idempotency_key,
    record.expires_at,
    count(*) OVER (PARTITION BY capability.id) AS candidate_count,
    count(*) OVER (PARTITION BY record.id) AS record_count
  FROM "automatic_quote_handoff_capabilities" capability
  JOIN "idempotency_records" record
    ON record.namespace = 'automatic-quote.handoff:' || capability.source_quote_session_id::text
   AND record.generation = 1
   AND record.status = 'COMPLETED'
   AND record.response_body ->> 'handoffId' = capability.id::text
   AND record.response_body ->> 'expiresAt' = to_char(
     capability.expires_at AT TIME ZONE 'UTC',
     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
   )
   AND record.created_at <= capability.issued_at
)
UPDATE "automatic_quote_handoff_capabilities" capability
SET
  "issuance_idempotency_record_id" = candidates.record_id,
  "issuance_key_hash" = encode(
    sha256(convert_to(candidates.idempotency_key::text, 'UTF8')),
    'hex'
  ),
  "issuance_replay_until" = candidates.expires_at
FROM candidates
WHERE capability.id = candidates.capability_id
  AND candidates.candidate_count = 1
  AND candidates.record_count = 1
  AND candidates.expires_at > capability.issued_at;

-- No key may be fabricated for ambiguous or otherwise unprovable legacy rows.
UPDATE "automatic_quote_handoff_capabilities"
SET "issuance_legacy_exhausted" = TRUE
WHERE "issuance_idempotency_record_id" IS NULL;

ALTER TABLE "automatic_quote_handoff_capabilities"
  ADD CONSTRAINT "automatic_quote_handoff_issuance_idempotency_key"
    UNIQUE ("issuance_idempotency_record_id"),
  ADD CONSTRAINT "automatic_quote_handoff_issuance_idempotency_fkey"
    FOREIGN KEY ("issuance_idempotency_record_id") REFERENCES "idempotency_records"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "automatic_quote_handoff_capabilities_issuance_binding_check"
    CHECK (
      (
        "issuance_legacy_exhausted"
        AND "issuance_idempotency_record_id" IS NULL
        AND "issuance_key_hash" IS NULL
        AND "issuance_replay_until" IS NULL
      )
      OR (
        NOT "issuance_legacy_exhausted"
        AND "issuance_idempotency_record_id" IS NOT NULL
        AND "issuance_key_hash" ~ '^[0-9a-f]{64}$'
        AND "issuance_replay_until" IS NOT NULL
        AND "issuance_replay_until" > "issued_at"
      )
    );

CREATE INDEX "automatic_quote_handoff_capabilities_issuance_replay_until_idx"
  ON "automatic_quote_handoff_capabilities"("issuance_replay_until")
  WHERE NOT "issuance_legacy_exhausted";

CREATE OR REPLACE FUNCTION taven_protect_automatic_quote_handoff_capability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'automatic quote handoff capabilities cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'automatic_quote_handoff_capability_immutable_check';
  END IF;

  IF NEW."id" IS NOT DISTINCT FROM OLD."id"
     AND NEW."source_quote_session_id" IS NOT DISTINCT FROM OLD."source_quote_session_id"
     AND NEW."token_hash" IS NOT DISTINCT FROM OLD."token_hash"
     AND NEW."scope" IS NOT DISTINCT FROM OLD."scope"
     AND NEW."reasons" IS NOT DISTINCT FROM OLD."reasons"
     AND NEW."model_file_ids" IS NOT DISTINCT FROM OLD."model_file_ids"
     AND NEW."item_selections" IS NOT DISTINCT FROM OLD."item_selections"
     AND NEW."issued_at" IS NOT DISTINCT FROM OLD."issued_at"
     AND NEW."expires_at" IS NOT DISTINCT FROM OLD."expires_at"
     AND NEW."issuance_idempotency_record_id" IS NOT DISTINCT FROM OLD."issuance_idempotency_record_id"
     AND NEW."issuance_key_hash" IS NOT DISTINCT FROM OLD."issuance_key_hash"
     AND NEW."issuance_replay_until" IS NOT DISTINCT FROM OLD."issuance_replay_until"
     AND NEW."issuance_legacy_exhausted" IS NOT DISTINCT FROM OLD."issuance_legacy_exhausted"
     AND OLD."consumed_at" IS NULL
     AND NEW."consumed_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'automatic quote handoff capability is immutable after issuance'
    USING ERRCODE = '23514', CONSTRAINT = 'automatic_quote_handoff_capability_immutable_check';
END;
$$;

ALTER TABLE "automatic_quote_handoff_capabilities"
  ENABLE TRIGGER "automatic_quote_handoff_capabilities_immutable";
