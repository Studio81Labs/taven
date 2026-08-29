-- Upload capabilities and stale-safe retention deletion claims.
-- The object store is deliberately not represented by a polymorphic foreign key;
-- the claim fence below binds a job to exactly one supported asset row.

CREATE TYPE "upload_asset_kind" AS ENUM ('MODEL_FILE', 'PHOTO_ASSET');
CREATE TYPE "upload_intent_status" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "retention_asset_kind" AS ENUM ('UPLOAD_INTENT', 'MODEL_FILE', 'MODEL_GEOMETRY', 'PHOTO_ASSET');
CREATE TYPE "retention_deletion_job_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'STALE', 'FAILED');

CREATE TABLE "upload_intents" (
    "id" UUID NOT NULL,
    "customer_id" UUID,
    "asset_kind" "upload_asset_kind" NOT NULL,
    "capability_token_hash" VARCHAR(64) NOT NULL,
    "original_filename" VARCHAR(255),
    "model_format" "model_file_format",
    "photo_kind" "photo_asset_kind",
    "photo_scope_kind" "photo_scope_kind",
    "photo_scope_id" UUID,
    "intended_asset_id" UUID NOT NULL,
    "expected_content_type" VARCHAR(100) NOT NULL,
    "expected_size_bytes" BIGINT NOT NULL,
    "expected_content_hash" VARCHAR(64) NOT NULL,
    "quarantine_object_key" TEXT NOT NULL,
    "final_object_key" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "upload_intent_status" NOT NULL DEFAULT 'PENDING',
    "confirmed_model_file_id" UUID,
    "confirmed_photo_asset_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "upload_intents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "retention_deletion_jobs" (
    "id" UUID NOT NULL,
    "asset_kind" "retention_asset_kind" NOT NULL,
    "asset_id" UUID NOT NULL,
    "expected_delete_after" TIMESTAMPTZ(3) NOT NULL,
    "status" "retention_deletion_job_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(3),
    "lease_token" VARCHAR(64),
    "last_error" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "retention_deletion_jobs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "model_files" ADD COLUMN "retention_deletion_job_id" UUID;
ALTER TABLE "photo_assets" ADD COLUMN "retention_deletion_job_id" UUID;

ALTER TABLE "upload_intents"
    ADD CONSTRAINT "upload_intents_customer_id_fkey"
        FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "upload_intents_confirmed_model_file_id_fkey"
        FOREIGN KEY ("confirmed_model_file_id") REFERENCES "model_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "upload_intents_confirmed_photo_asset_id_fkey"
        FOREIGN KEY ("confirmed_photo_asset_id") REFERENCES "photo_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "model_files"
    ADD CONSTRAINT "model_files_retention_deletion_job_id_fkey"
        FOREIGN KEY ("retention_deletion_job_id") REFERENCES "retention_deletion_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "photo_assets"
    ADD CONSTRAINT "photo_assets_retention_deletion_job_id_fkey"
        FOREIGN KEY ("retention_deletion_job_id") REFERENCES "retention_deletion_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "upload_intents_capability_token_hash_key" ON "upload_intents"("capability_token_hash");
CREATE UNIQUE INDEX "upload_intents_quarantine_object_key_key" ON "upload_intents"("quarantine_object_key");
CREATE UNIQUE INDEX "upload_intents_final_object_key_key" ON "upload_intents"("final_object_key");
CREATE UNIQUE INDEX "upload_intents_confirmed_model_file_id_key" ON "upload_intents"("confirmed_model_file_id");
CREATE UNIQUE INDEX "upload_intents_confirmed_photo_asset_id_key" ON "upload_intents"("confirmed_photo_asset_id");
CREATE INDEX "upload_intents_customer_id_created_at_idx" ON "upload_intents"("customer_id", "created_at");
CREATE INDEX "upload_intents_status_expires_at_idx" ON "upload_intents"("status", "expires_at");
CREATE UNIQUE INDEX "retention_deletion_jobs_asset_deadline_key"
    ON "retention_deletion_jobs"("asset_kind", "asset_id", "expected_delete_after");
CREATE INDEX "retention_deletion_jobs_status_available_at_idx"
    ON "retention_deletion_jobs"("status", "available_at");
CREATE INDEX "retention_deletion_jobs_asset_status_idx"
    ON "retention_deletion_jobs"("asset_kind", "asset_id", "status");
CREATE UNIQUE INDEX "model_files_retention_deletion_job_id_key" ON "model_files"("retention_deletion_job_id");
CREATE UNIQUE INDEX "photo_assets_retention_deletion_job_id_key" ON "photo_assets"("retention_deletion_job_id");

ALTER TABLE "upload_intents"
    ADD CONSTRAINT "upload_intents_metadata_check" CHECK (
        "expected_size_bytes" > 0
        AND "expected_content_hash" ~ '^[0-9a-f]{64}$'
        AND "capability_token_hash" ~ '^[0-9a-f]{64}$'
        AND "expires_at" > "created_at"
        AND ("confirmed_model_file_id" IS NULL OR "confirmed_photo_asset_id" IS NULL)
        AND (("asset_kind" = 'MODEL_FILE' AND "original_filename" IS NOT NULL AND "model_format" IS NOT NULL AND "photo_kind" IS NULL AND "photo_scope_kind" IS NULL AND "photo_scope_id" IS NULL)
          OR ("asset_kind" = 'PHOTO_ASSET' AND "original_filename" IS NOT NULL AND "model_format" IS NULL AND "photo_kind" IS NOT NULL AND "photo_scope_kind" IS NOT NULL AND "photo_scope_id" IS NOT NULL))
        AND (
            ("asset_kind" = 'MODEL_FILE' AND "confirmed_photo_asset_id" IS NULL)
            OR ("asset_kind" = 'PHOTO_ASSET' AND "confirmed_model_file_id" IS NULL)
        )
        AND (("status" = 'CONFIRMED') = ("confirmed_at" IS NOT NULL))
        AND (("status" = 'CONFIRMED') = ("confirmed_model_file_id" IS NOT NULL OR "confirmed_photo_asset_id" IS NOT NULL))
    );
ALTER TABLE "retention_deletion_jobs"
    ADD CONSTRAINT "retention_deletion_jobs_metadata_check" CHECK (
        "attempts" >= 0
        AND ("status" IN ('SUCCEEDED', 'STALE')) = ("completed_at" IS NOT NULL)
        AND ("status" = 'PROCESSING') = ("lease_until" IS NOT NULL AND "lease_token" IS NOT NULL)
    );

-- Adding the cleanup claim is a retention-state change, not an asset payload
-- mutation. Preserve the original monotonic/deletion guards while admitting
-- only the separately fenced claim column.
CREATE OR REPLACE FUNCTION taven_protect_asset_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    deadline_column text := TG_ARGV[0];
    old_deadline timestamptz;
    new_deadline timestamptz;
    checked_at timestamptz := clock_timestamp();
    live_capacity_horizon timestamptz;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '% metadata is retained after object deletion', TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;

    old_deadline := (to_jsonb(OLD) ->> deadline_column)::timestamptz;
    new_deadline := (to_jsonb(NEW) ->> deadline_column)::timestamptz;

    IF (to_jsonb(NEW) - ARRAY[deadline_column, 'retention_hold', 'deleted_at', 'retention_deletion_job_id'])
        IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY[deadline_column, 'retention_hold', 'deleted_at', 'retention_deletion_job_id']) THEN
        RAISE EXCEPTION '% immutable asset payload cannot be changed', TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;

    IF new_deadline < old_deadline THEN
        RAISE EXCEPTION '% deletion deadline cannot be shortened', TG_TABLE_NAME
            USING ERRCODE = '23514', CONSTRAINT = 'asset_deadline_monotonic_check';
    END IF;

    IF TG_TABLE_NAME = 'model_files' THEN
        live_capacity_horizon := taven_model_source_live_capacity_horizon(NEW."id");
        IF live_capacity_horizon IS NOT NULL AND (
            NEW."deleted_at" IS NOT NULL OR (
                NEW."retention_hold" = 'NONE'
                AND (
                    new_deadline <= checked_at
                    OR new_deadline < live_capacity_horizon
                )
            )
        ) THEN
            RAISE EXCEPTION 'model source must remain available through live production capacity'
                USING ERRCODE = '23514', CONSTRAINT = 'model_file_live_capacity_horizon_check';
        END IF;
    END IF;

    IF OLD."deleted_at" IS NULL
       AND NEW."deleted_at" IS NOT NULL
       AND (
           NEW."retention_hold" <> 'NONE'
           OR new_deadline > checked_at
       ) THEN
        RAISE EXCEPTION '% cannot be marked deleted before its deadline or while retained', TG_TABLE_NAME
            USING ERRCODE = '23514', CONSTRAINT = 'asset_deletion_eligibility_check';
    END IF;

    IF OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL THEN
        NEW."deleted_at" := checked_at;
    END IF;

    IF OLD."deleted_at" IS NOT NULL AND NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at" THEN
        RAISE EXCEPTION '% deletion marker is immutable', TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION taven_protect_upload_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (
        (to_jsonb(NEW) - ARRAY['customer_id','status','confirmed_model_file_id','confirmed_photo_asset_id','confirmed_at','failure_reason','updated_at'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['customer_id','status','confirmed_model_file_id','confirmed_photo_asset_id','confirmed_at','failure_reason','updated_at'])
    ) THEN
        RAISE EXCEPTION 'upload intent capability and object contract are immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."customer_id" IS NOT NULL AND NEW."customer_id" IS DISTINCT FROM OLD."customer_id" THEN
        RAISE EXCEPTION 'upload intent customer ownership cannot be reassigned' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD."status" <> 'PENDING' AND NEW."status" <> OLD."status" THEN
        RAISE EXCEPTION 'terminal upload intent status is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "upload_intents_immutable_contract"
    BEFORE UPDATE ON "upload_intents" FOR EACH ROW EXECUTE FUNCTION taven_protect_upload_intent();

CREATE FUNCTION taven_validate_upload_intent_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."status" = 'CONFIRMED' AND (
        (NEW."asset_kind" = 'MODEL_FILE' AND (NEW."confirmed_model_file_id" IS DISTINCT FROM NEW."intended_asset_id"))
        OR (NEW."asset_kind" = 'PHOTO_ASSET' AND (NEW."confirmed_photo_asset_id" IS DISTINCT FROM NEW."intended_asset_id"))
    ) THEN
        RAISE EXCEPTION 'confirmed upload intent must bind its intended asset' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "upload_intents_confirmation_binding"
    BEFORE INSERT OR UPDATE ON "upload_intents" FOR EACH ROW EXECUTE FUNCTION taven_validate_upload_intent_confirmation();

CREATE FUNCTION taven_protect_retention_deletion_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (
        (to_jsonb(NEW) - ARRAY['status','attempts','available_at','lease_until','lease_token','last_error','completed_at','updated_at'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status','attempts','available_at','lease_until','lease_token','last_error','completed_at','updated_at'])
    ) THEN
        RAISE EXCEPTION 'retention deletion job identity and deadline are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW."attempts" < OLD."attempts" THEN
        RAISE EXCEPTION 'retention deletion attempts cannot decrease' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "retention_deletion_jobs_immutable_identity"
    BEFORE UPDATE ON "retention_deletion_jobs" FOR EACH ROW EXECUTE FUNCTION taven_protect_retention_deletion_job();

CREATE FUNCTION taven_validate_retention_deletion_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    job_kind "retention_asset_kind";
    job_asset_id UUID;
    job_deadline TIMESTAMPTZ;
    job_status "retention_deletion_job_status";
    deadline_column TEXT := CASE WHEN TG_ARGV[0] = 'MODEL_FILE' THEN 'source_delete_after' ELSE 'photo_delete_after' END;
    current_deadline TIMESTAMPTZ := (to_jsonb(NEW) ->> deadline_column)::TIMESTAMPTZ;
BEGIN
    IF OLD."retention_deletion_job_id" IS NOT NULL THEN
        SELECT "status" INTO job_status FROM "retention_deletion_jobs"
          WHERE "id" = OLD."retention_deletion_job_id" FOR SHARE;
        IF NEW."retention_deletion_job_id" IS NULL THEN
            IF job_status = 'FAILED'
               AND NEW."deleted_at" IS NOT DISTINCT FROM OLD."deleted_at"
               AND current_deadline IS NOT DISTINCT FROM ((to_jsonb(OLD) ->> deadline_column)::TIMESTAMPTZ)
               AND NEW."retention_hold" IS NOT DISTINCT FROM OLD."retention_hold" THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'retention deletion claim can only be released by its failed job' USING ERRCODE = '55000';
        END IF;
        IF NEW."retention_deletion_job_id" IS DISTINCT FROM OLD."retention_deletion_job_id" THEN
            RAISE EXCEPTION 'retention deletion claim is immutable' USING ERRCODE = '55000';
        END IF;
        IF NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"
           AND job_status = 'PROCESSING'
           AND current_deadline IS NOT DISTINCT FROM ((to_jsonb(OLD) ->> deadline_column)::TIMESTAMPTZ)
           AND NEW."retention_hold" IS NOT DISTINCT FROM OLD."retention_hold" THEN
            RETURN NEW;
        END IF;
        IF NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"
           OR current_deadline IS DISTINCT FROM ((to_jsonb(OLD) ->> deadline_column)::TIMESTAMPTZ)
           OR NEW."retention_hold" IS DISTINCT FROM OLD."retention_hold" THEN
            RAISE EXCEPTION 'claimed asset can only be marked deleted by its processing job' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW."retention_deletion_job_id" IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT "asset_kind", "asset_id", "expected_delete_after", "status" INTO job_kind, job_asset_id, job_deadline, job_status
      FROM "retention_deletion_jobs" WHERE "id" = NEW."retention_deletion_job_id" FOR SHARE;
    IF NOT FOUND OR job_kind <> TG_ARGV[0]::"retention_asset_kind" OR job_asset_id <> NEW."id"
       OR job_deadline IS DISTINCT FROM current_deadline
       OR job_status <> 'PENDING' OR NEW."retention_hold" <> 'NONE' OR NEW."deleted_at" IS NOT NULL OR job_deadline > clock_timestamp() THEN
        RAISE EXCEPTION 'retention deletion claim does not match the current due asset deadline' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "model_files_retention_claim_fence" BEFORE UPDATE OF "retention_deletion_job_id", "source_delete_after", "retention_hold", "deleted_at" ON "model_files"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_retention_deletion_claim('MODEL_FILE');
CREATE TRIGGER "photo_assets_retention_claim_fence" BEFORE UPDATE OF "retention_deletion_job_id", "photo_delete_after", "retention_hold", "deleted_at" ON "photo_assets"
    FOR EACH ROW EXECUTE FUNCTION taven_validate_retention_deletion_claim('PHOTO_ASSET');

CREATE FUNCTION taven_enqueue_retention_deletion_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_kind "retention_asset_kind" := TG_ARGV[0]::"retention_asset_kind";
    row_data JSONB := to_jsonb(NEW);
    target_deadline TIMESTAMPTZ;
BEGIN
    target_deadline := (
        row_data ->> CASE
            WHEN target_kind = 'UPLOAD_INTENT' THEN 'expires_at'
            WHEN target_kind = 'MODEL_FILE' THEN 'source_delete_after'
            ELSE 'photo_delete_after'
        END
    )::TIMESTAMPTZ;

    IF target_kind <> 'UPLOAD_INTENT'
       AND (row_data ->> 'retention_hold' <> 'NONE' OR row_data ->> 'deleted_at' IS NOT NULL) THEN
        RETURN NULL;
    END IF;

    INSERT INTO "retention_deletion_jobs" (
        "id", "asset_kind", "asset_id", "expected_delete_after",
        "status", "available_at", "updated_at"
    ) VALUES (
        gen_random_uuid(), target_kind, NEW."id", target_deadline,
        'PENDING', target_deadline, clock_timestamp()
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

CREATE TRIGGER "upload_intents_enqueue_retention"
    AFTER INSERT ON "upload_intents" FOR EACH ROW
    EXECUTE FUNCTION taven_enqueue_retention_deletion_job('UPLOAD_INTENT');
CREATE TRIGGER "model_files_enqueue_retention"
    AFTER INSERT OR UPDATE OF "source_delete_after", "retention_hold" ON "model_files" FOR EACH ROW
    EXECUTE FUNCTION taven_enqueue_retention_deletion_job('MODEL_FILE');
CREATE TRIGGER "photo_assets_enqueue_retention"
    AFTER INSERT OR UPDATE OF "photo_delete_after", "retention_hold" ON "photo_assets" FOR EACH ROW
    EXECUTE FUNCTION taven_enqueue_retention_deletion_job('PHOTO_ASSET');

-- Seed cleanup work for assets that predate this migration. Future deadline
-- changes enqueue their exact replacement keys in the mutating transaction.
INSERT INTO "retention_deletion_jobs" (
    "id", "asset_kind", "asset_id", "expected_delete_after",
    "status", "available_at", "updated_at"
)
SELECT gen_random_uuid(), 'MODEL_FILE', "id", "source_delete_after", 'PENDING', "source_delete_after", clock_timestamp()
FROM "model_files" WHERE "deleted_at" IS NULL AND "retention_hold" = 'NONE'
ON CONFLICT ("asset_kind", "asset_id", "expected_delete_after") DO NOTHING;

INSERT INTO "retention_deletion_jobs" (
    "id", "asset_kind", "asset_id", "expected_delete_after",
    "status", "available_at", "updated_at"
)
SELECT gen_random_uuid(), 'PHOTO_ASSET', "id", "photo_delete_after", 'PENDING', "photo_delete_after", clock_timestamp()
FROM "photo_assets" WHERE "deleted_at" IS NULL AND "retention_hold" = 'NONE'
ON CONFLICT ("asset_kind", "asset_id", "expected_delete_after") DO NOTHING;
