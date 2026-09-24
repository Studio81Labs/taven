-- Request-scoped upload intent provenance. Existing anonymous intents remain valid.
ALTER TABLE "upload_intents"
  ADD COLUMN "quote_request_id" UUID,
  ADD COLUMN "initiating_operator_id" UUID,
  ADD CONSTRAINT "upload_intents_operator_model_scope_check"
    CHECK (("quote_request_id" IS NULL AND "initiating_operator_id" IS NULL)
      OR ("quote_request_id" IS NOT NULL AND "initiating_operator_id" IS NOT NULL
        AND "asset_kind" = 'MODEL_FILE')),
  ADD CONSTRAINT "upload_intents_quote_request_id_fkey"
    FOREIGN KEY ("quote_request_id") REFERENCES "quote_requests"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "upload_intents_initiating_operator_id_fkey"
    FOREIGN KEY ("initiating_operator_id") REFERENCES "operator_identities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "upload_intents_quote_request_id_created_at_idx"
  ON "upload_intents"("quote_request_id", "created_at")
  WHERE "quote_request_id" IS NOT NULL;

CREATE FUNCTION taven_protect_operator_upload_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."quote_request_id" IS DISTINCT FROM OLD."quote_request_id"
     OR NEW."initiating_operator_id" IS DISTINCT FROM OLD."initiating_operator_id" THEN
    RAISE EXCEPTION 'operator model upload scope is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'upload_intents_operator_model_scope_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "upload_intents_operator_model_scope_immutable"
BEFORE UPDATE ON "upload_intents"
FOR EACH ROW EXECUTE FUNCTION taven_protect_operator_upload_scope();

-- A request can use only explicitly attached retained model sources.
CREATE TABLE "quote_request_models" (
  "request_id" UUID NOT NULL,
  "model_file_id" UUID NOT NULL,
  "attached_by_operator_id" UUID NOT NULL,
  "inspection_job_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quote_request_models_pkey" PRIMARY KEY ("request_id", "model_file_id"),
  CONSTRAINT "quote_request_models_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "quote_requests"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quote_request_models_model_file_id_fkey"
    FOREIGN KEY ("model_file_id") REFERENCES "model_files"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quote_request_models_attached_by_operator_id_fkey"
    FOREIGN KEY ("attached_by_operator_id") REFERENCES "operator_identities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quote_request_models_request_id_model_file_id_inspection_job_id_key"
    UNIQUE ("request_id", "model_file_id", "inspection_job_id"),
  CONSTRAINT "quote_request_models_request_id_inspection_job_id_key"
    UNIQUE ("request_id", "inspection_job_id")
);
CREATE INDEX "quote_request_models_model_file_id_idx"
  ON "quote_request_models"("model_file_id");

-- Geometry ID is deterministic before worker completion. The source and
-- selected bodies are immutable; QuoteItem's geometry FK requires completed
-- canonicalization before the selection can enter a binding.
CREATE TABLE "quote_request_model_selections" (
  "id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "model_file_id" UUID NOT NULL,
  "model_geometry_id" UUID NOT NULL,
  "inspection_job_id" UUID NOT NULL,
  "source_content_sha256" VARCHAR(64) NOT NULL,
  "body_ids" TEXT[] NOT NULL,
  "selection_sha256" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quote_request_model_selections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quote_request_model_selections_source_hash_check"
    CHECK ("source_content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "quote_request_model_selections_selection_hash_check"
    CHECK ("selection_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "quote_request_model_selections_body_ids_check"
    CHECK (cardinality("body_ids") > 0 AND array_position("body_ids", NULL) IS NULL),
  CONSTRAINT "quote_request_model_selections_request_id_model_file_id_inspection_job_id_fkey"
    FOREIGN KEY ("request_id", "model_file_id", "inspection_job_id")
    REFERENCES "quote_request_models"("request_id", "model_file_id", "inspection_job_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "quote_request_model_selections_request_id_model_file_id_selection_sha256_key"
    UNIQUE ("request_id", "model_file_id", "selection_sha256"),
  CONSTRAINT "quote_request_model_selections_id_model_file_id_model_geometry_id_key"
    UNIQUE ("id", "model_file_id", "model_geometry_id")
);
CREATE INDEX "quote_request_model_selections_model_geometry_id_idx"
  ON "quote_request_model_selections"("model_geometry_id");

CREATE FUNCTION taven_protect_quote_request_model_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'request model evidence is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'quote_request_model_evidence_immutable';
END;
$$;
CREATE TRIGGER "quote_request_models_immutable"
BEFORE UPDATE OR DELETE ON "quote_request_models"
FOR EACH ROW EXECUTE FUNCTION taven_protect_quote_request_model_evidence();
CREATE TRIGGER "quote_request_model_selections_immutable"
BEFORE UPDATE OR DELETE ON "quote_request_model_selections"
FOR EACH ROW EXECUTE FUNCTION taven_protect_quote_request_model_evidence();

-- Legacy QuoteItems remain nullable. Fresh issuance supplies the selection.
ALTER TABLE "quote_items"
  ADD COLUMN "model_selection_id" UUID,
  ADD CONSTRAINT "quote_items_model_selection_id_source_model_file_id_model_geometry_id_fkey"
    FOREIGN KEY ("model_selection_id", "source_model_file_id", "model_geometry_id")
    REFERENCES "quote_request_model_selections"("id", "model_file_id", "model_geometry_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "quote_items_model_selection_id_idx"
  ON "quote_items"("model_selection_id")
  WHERE "model_selection_id" IS NOT NULL;

CREATE FUNCTION taven_check_quote_item_model_selection_request()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."model_selection_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "quotes" quote
    JOIN "quote_request_model_selections" selection
      ON selection."id" = NEW."model_selection_id"
    WHERE quote."id" = NEW."quote_id"
      AND quote."quote_request_id" = selection."request_id"
  ) THEN
    RAISE EXCEPTION 'quote item model selection belongs to another request'
      USING ERRCODE = '23514', CONSTRAINT = 'quote_item_model_selection_request_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "quote_items_model_selection_request_check"
BEFORE INSERT OR UPDATE OF "model_selection_id", "quote_id" ON "quote_items"
FOR EACH ROW EXECUTE FUNCTION taven_check_quote_item_model_selection_request();
