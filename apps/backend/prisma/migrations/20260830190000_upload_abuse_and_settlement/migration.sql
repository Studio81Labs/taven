-- Bound anonymous signed-upload issuance across every API instance. Subject
-- hashes are HMACs of the socket address; raw client addresses are not stored.
CREATE TABLE "anonymous_upload_limits" (
    "subject_hash" VARCHAR(64) NOT NULL,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    "window_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "issued_count" INTEGER NOT NULL DEFAULT 0,
    "reserved_bytes" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "anonymous_upload_limits_pkey" PRIMARY KEY ("subject_hash"),
    CONSTRAINT "anonymous_upload_limits_nonnegative" CHECK (
        "issued_count" >= 0 AND "reserved_bytes" >= 0
    ),
    CONSTRAINT "anonymous_upload_limits_window" CHECK (
        "window_expires_at" > "window_started_at"
    )
);

CREATE INDEX "anonymous_upload_limits_window_expires_at_idx"
    ON "anonymous_upload_limits"("window_expires_at");

-- A singleton cursor lets every retention-worker replica cooperatively scan
-- quarantine for objects that arrived after their per-intent cleanup ended.
CREATE TABLE "object_storage_sweep_cursors" (
    "sweep_name" VARCHAR(64) NOT NULL,
    "cursor_object_key" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "object_storage_sweep_cursors_pkey" PRIMARY KEY ("sweep_name")
);

ALTER TABLE "retention_deletion_jobs"
    ADD COLUMN "upload_settlement_verified_at" TIMESTAMPTZ(3);

ALTER TABLE "retention_deletion_jobs"
    ADD CONSTRAINT "retention_deletion_jobs_upload_settlement_check" CHECK (
        "upload_settlement_verified_at" IS NULL
        OR "asset_kind" = 'UPLOAD_INTENT'
    );

CREATE OR REPLACE FUNCTION taven_protect_retention_deletion_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (
        (to_jsonb(NEW) - ARRAY['status','attempts','available_at','lease_until','lease_token','upload_settlement_verified_at','last_error','completed_at','updated_at'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status','attempts','available_at','lease_until','lease_token','upload_settlement_verified_at','last_error','completed_at','updated_at'])
    ) THEN
        RAISE EXCEPTION 'retention deletion job identity and deadline are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW."attempts" < OLD."attempts" THEN
        RAISE EXCEPTION 'retention deletion attempts cannot decrease' USING ERRCODE = '23514';
    END IF;
    IF OLD."upload_settlement_verified_at" IS NOT NULL
       AND NEW."upload_settlement_verified_at" IS DISTINCT FROM OLD."upload_settlement_verified_at" THEN
        RAISE EXCEPTION 'upload settlement verification is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

-- A request authenticated before a signed URL expires may still be streaming
-- when the URL reaches its deadline. Keep confirmation expiry strict, but do
-- not start quarantine deletion until the bounded settlement period elapses.
CREATE OR REPLACE FUNCTION taven_enqueue_retention_deletion_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_kind "retention_asset_kind" := TG_ARGV[0]::"retention_asset_kind";
    row_data JSONB := to_jsonb(NEW);
    target_deadline TIMESTAMPTZ;
    target_available_at TIMESTAMPTZ;
BEGIN
    target_deadline := (
        row_data ->> CASE
            WHEN target_kind = 'UPLOAD_INTENT' THEN 'expires_at'
            WHEN target_kind = 'MODEL_FILE' THEN 'source_delete_after'
            ELSE 'photo_delete_after'
        END
    )::TIMESTAMPTZ;
    target_available_at := CASE
        WHEN target_kind = 'UPLOAD_INTENT' THEN target_deadline + INTERVAL '5 minutes'
        ELSE target_deadline
    END;

    IF target_kind <> 'UPLOAD_INTENT'
       AND (row_data ->> 'retention_hold' <> 'NONE' OR row_data ->> 'deleted_at' IS NOT NULL) THEN
        RETURN NULL;
    END IF;

    INSERT INTO "retention_deletion_jobs" (
        "id", "asset_kind", "asset_id", "expected_delete_after",
        "status", "available_at", "updated_at"
    ) VALUES (
        gen_random_uuid(), target_kind, NEW."id", target_deadline,
        'PENDING', target_available_at, clock_timestamp()
    )
    ON CONFLICT ("asset_kind", "asset_id", "expected_delete_after") DO UPDATE
      SET "status" = 'PENDING', "available_at" = EXCLUDED."available_at",
          "completed_at" = NULL, "last_error" = NULL,
          "lease_until" = NULL, "lease_token" = NULL,
          "updated_at" = clock_timestamp()
      WHERE "retention_deletion_jobs"."status" = 'STALE';
    RETURN NULL;
END;
$$;

-- Delay work already queued by the preceding migration. Re-arm completed
-- upload cleanups once so a late object from the former race is swept again.
UPDATE "retention_deletion_jobs"
SET "status" = 'PENDING',
    "available_at" = GREATEST(
        clock_timestamp(),
        "expected_delete_after" + INTERVAL '5 minutes'
    ),
    "completed_at" = NULL,
    "last_error" = NULL,
    "lease_until" = NULL,
    "lease_token" = NULL,
    "upload_settlement_verified_at" = NULL,
    "updated_at" = clock_timestamp()
WHERE "asset_kind" = 'UPLOAD_INTENT'
  AND "status" IN ('PENDING', 'FAILED', 'SUCCEEDED');
