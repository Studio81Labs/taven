CREATE TYPE "automatic_quote_handoff_scope" AS ENUM (
    'ASSISTED_QUOTE_REQUEST'
);

CREATE TABLE "automatic_quote_handoff_capabilities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_quote_session_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "scope" "automatic_quote_handoff_scope" NOT NULL,
    "reasons" TEXT[] NOT NULL,
    "model_file_ids" TEXT[] NOT NULL,
    "item_selections" JSONB NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "automatic_quote_handoff_capabilities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "automatic_quote_handoff_capabilities_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "automatic_quote_handoff_capabilities_expiry_check"
      CHECK ("expires_at" > "issued_at"),
    CONSTRAINT "automatic_quote_handoff_capabilities_consumed_at_check"
      CHECK ("consumed_at" IS NULL OR "consumed_at" >= "issued_at")
);

CREATE TABLE "automatic_quote_request_handoffs" (
    "quote_request_id" UUID NOT NULL,
    "capability_id" UUID NOT NULL,
    "source_quote_session_id" UUID NOT NULL,
    "reasons" TEXT[] NOT NULL,
    "model_file_ids" TEXT[] NOT NULL,
    "item_selections" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "automatic_quote_request_handoffs_pkey" PRIMARY KEY ("quote_request_id"),
    CONSTRAINT "automatic_quote_request_handoffs_capability_id_key" UNIQUE ("capability_id")
);

ALTER TABLE "automatic_quote_handoff_capabilities"
  ADD CONSTRAINT "automatic_quote_handoff_capabilities_source_quote_session_id_fkey"
  FOREIGN KEY ("source_quote_session_id") REFERENCES "quote_sessions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "automatic_quote_request_handoffs"
  ADD CONSTRAINT "automatic_quote_request_handoffs_quote_request_id_fkey"
  FOREIGN KEY ("quote_request_id") REFERENCES "quote_requests"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "automatic_quote_request_handoffs_capability_id_fkey"
  FOREIGN KEY ("capability_id") REFERENCES "automatic_quote_handoff_capabilities"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "automatic_quote_request_handoffs_source_quote_session_id_fkey"
  FOREIGN KEY ("source_quote_session_id") REFERENCES "quote_sessions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "automatic_quote_handoff_capabilities_source_quote_session_id_expires_at_idx"
  ON "automatic_quote_handoff_capabilities"("source_quote_session_id", "expires_at");

CREATE INDEX "automatic_quote_handoff_capabilities_expires_at_idx"
  ON "automatic_quote_handoff_capabilities"("expires_at");

CREATE INDEX "automatic_quote_request_handoffs_source_quote_session_id_idx"
  ON "automatic_quote_request_handoffs"("source_quote_session_id");

CREATE FUNCTION taven_protect_automatic_quote_handoff_capability()
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
     AND OLD."consumed_at" IS NULL
     AND NEW."consumed_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'automatic quote handoff capability is immutable after issuance'
    USING ERRCODE = '23514', CONSTRAINT = 'automatic_quote_handoff_capability_immutable_check';
END;
$$;

CREATE TRIGGER "automatic_quote_handoff_capabilities_immutable"
  BEFORE UPDATE OR DELETE ON "automatic_quote_handoff_capabilities"
  FOR EACH ROW EXECUTE FUNCTION taven_protect_automatic_quote_handoff_capability();

CREATE TRIGGER "automatic_quote_request_handoffs_immutable"
  BEFORE UPDATE OR DELETE ON "automatic_quote_request_handoffs"
  FOR EACH ROW EXECUTE FUNCTION taven_protect_row_payload('');
