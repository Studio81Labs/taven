-- PR5b: database-backed legal acceptance provenance.  This intentionally
-- preserves pre-cutover scalar evidence and only makes the new references
-- authoritative when they are present.

CREATE TYPE "legal_acceptance_purpose" AS ENUM (
    'TERMS_ACCEPTED',
    'CLAIM_POLICY_ACCEPTED',
    'PRIVACY_NOTICE_ACKNOWLEDGED',
    'PHOTO_PUBLICATION_GRANTED'
);

ALTER TABLE "quotes"
    ADD COLUMN "legal_terms_revision_id" UUID,
    ADD COLUMN "legal_claims_revision_id" UUID,
    ADD COLUMN "claim_window_days" INTEGER;

ALTER TABLE "order_price_bindings"
    ADD COLUMN "legal_terms_revision_id" UUID;

ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_legal_terms_revision_id_fkey"
        FOREIGN KEY ("legal_terms_revision_id")
        REFERENCES "legal_document_revisions"("id") ON DELETE RESTRICT,
    ADD CONSTRAINT "quotes_legal_claims_revision_id_fkey"
        FOREIGN KEY ("legal_claims_revision_id")
        REFERENCES "legal_document_revisions"("id") ON DELETE RESTRICT,
    ADD CONSTRAINT "quotes_legal_revisions_shape_check" CHECK (
        ("legal_terms_revision_id" IS NULL AND "legal_claims_revision_id" IS NULL AND "claim_window_days" IS NULL)
        OR ("legal_terms_revision_id" IS NOT NULL AND "legal_claims_revision_id" IS NOT NULL AND "claim_window_days" > 0)
    );

ALTER TABLE "order_price_bindings"
    ADD CONSTRAINT "order_price_bindings_legal_terms_revision_id_fkey"
        FOREIGN KEY ("legal_terms_revision_id")
        REFERENCES "legal_document_revisions"("id") ON DELETE RESTRICT;

CREATE INDEX "quotes_legal_terms_revision_id_idx" ON "quotes"("legal_terms_revision_id");
CREATE INDEX "quotes_legal_claims_revision_id_idx" ON "quotes"("legal_claims_revision_id");
CREATE INDEX "order_price_bindings_legal_terms_revision_id_idx" ON "order_price_bindings"("legal_terms_revision_id");

CREATE TABLE "legal_acceptances" (
    "id" UUID NOT NULL,
    "order_id" UUID,
    "quote_request_id" UUID,
    "revision_id" UUID NOT NULL,
    "purpose" "legal_acceptance_purpose" NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL,
    "command_identity" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "legal_acceptances_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT,
    CONSTRAINT "legal_acceptances_quote_request_id_fkey" FOREIGN KEY ("quote_request_id") REFERENCES "quote_requests"("id") ON DELETE RESTRICT,
    CONSTRAINT "legal_acceptances_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "legal_document_revisions"("id") ON DELETE RESTRICT,
    CONSTRAINT "legal_acceptances_subject_check" CHECK (
        ("order_id" IS NOT NULL AND "quote_request_id" IS NULL)
        OR ("order_id" IS NULL AND "quote_request_id" IS NOT NULL)
    ),
    CONSTRAINT "legal_acceptances_command_identity_check" CHECK (btrim("command_identity") <> ''),
    CONSTRAINT "legal_acceptances_timestamp_check" CHECK (
        "accepted_at" >= TIMESTAMPTZ '2000-01-01T00:00:00Z'
        AND "accepted_at" <= TIMESTAMPTZ '2100-01-01T00:00:00Z'
    )
);

CREATE UNIQUE INDEX "legal_acceptances_order_purpose_key"
    ON "legal_acceptances"("order_id", "purpose") WHERE "order_id" IS NOT NULL;
CREATE UNIQUE INDEX "legal_acceptances_quote_request_purpose_key"
    ON "legal_acceptances"("quote_request_id", "purpose") WHERE "quote_request_id" IS NOT NULL;
CREATE INDEX "legal_acceptances_revision_id_idx" ON "legal_acceptances"("revision_id");

CREATE OR REPLACE FUNCTION taven_legal_revision_matches_document(
    target_revision_id uuid,
    target_key text
) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "legal_document_revisions" revision
        JOIN "legal_documents" document ON document."id" = revision."document_id"
        WHERE revision."id" = target_revision_id
          AND document."key" = target_key
    );
$$;

CREATE OR REPLACE FUNCTION taven_validate_legal_binding_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'order_price_bindings' THEN
        IF NEW."legal_terms_revision_id" IS NOT NULL
           AND NOT taven_legal_revision_matches_document(NEW."legal_terms_revision_id", 'terms') THEN
            RAISE EXCEPTION 'Order price binding legal terms revision must belong to terms'
                USING ERRCODE = '23514', CONSTRAINT = 'order_price_bindings_legal_terms_document_check';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."legal_terms_revision_id" IS NOT NULL
       AND NOT taven_legal_revision_matches_document(NEW."legal_terms_revision_id", 'terms') THEN
        RAISE EXCEPTION 'Quote legal terms revision must belong to terms'
            USING ERRCODE = '23514', CONSTRAINT = 'quotes_legal_terms_document_check';
    END IF;
    IF NEW."legal_claims_revision_id" IS NOT NULL
       AND NOT taven_legal_revision_matches_document(NEW."legal_claims_revision_id", 'claims') THEN
        RAISE EXCEPTION 'Quote legal claims revision must belong to claims'
            USING ERRCODE = '23514', CONSTRAINT = 'quotes_legal_claims_document_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "quotes_legal_binding_revision_valid"
BEFORE INSERT OR UPDATE OF "legal_terms_revision_id", "legal_claims_revision_id", "claim_window_days"
ON "quotes" FOR EACH ROW EXECUTE FUNCTION taven_validate_legal_binding_revision();

CREATE TRIGGER "order_price_bindings_legal_binding_revision_valid"
BEFORE INSERT OR UPDATE OF "legal_terms_revision_id"
ON "order_price_bindings" FOR EACH ROW EXECUTE FUNCTION taven_validate_legal_binding_revision();

CREATE OR REPLACE FUNCTION taven_validate_legal_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    expected_key text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Legal acceptance evidence is append-only'
            USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptances_append_only_check';
    END IF;

    expected_key := CASE NEW."purpose"
        WHEN 'TERMS_ACCEPTED' THEN 'terms'
        WHEN 'CLAIM_POLICY_ACCEPTED' THEN 'claims'
        WHEN 'PRIVACY_NOTICE_ACKNOWLEDGED' THEN 'privacy'
        WHEN 'PHOTO_PUBLICATION_GRANTED' THEN 'photoConsent'
    END;
    IF NOT EXISTS (
        SELECT 1
        FROM "legal_document_revisions" revision
        JOIN "legal_documents" document ON document."id" = revision."document_id"
        JOIN "legal_document_publications" publication
          ON publication."revision_id" = revision."id"
         AND publication."cancelled_at" IS NULL
         AND publication."starts_at" <= NEW."accepted_at"
         AND (publication."ends_at" IS NULL OR publication."ends_at" > NEW."accepted_at")
        WHERE revision."id" = NEW."revision_id"
          AND document."key" = expected_key
          AND revision."status" = 'APPROVED'
          AND revision."revision_code" IS NOT NULL
          AND revision."effective_at" <= NEW."accepted_at"
    ) THEN
        RAISE EXCEPTION 'Legal acceptance must use the effective published document revision'
            USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptances_effective_revision_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "legal_acceptances_integrity"
BEFORE INSERT OR UPDATE OR DELETE ON "legal_acceptances"
FOR EACH ROW EXECUTE FUNCTION taven_validate_legal_acceptance();

-- A deferred check lets the command atomically create an Order and then add
-- its immutable ledger evidence, while preventing any committed new binding
-- from relying on legacy strings alone.
CREATE OR REPLACE FUNCTION taven_validate_order_legal_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_order_id uuid;
    binding_terms_revision_id uuid;
    terms_code text;
    claims_code text;
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        target_order_id := COALESCE(NEW."id", OLD."id");
    ELSE
        target_order_id := COALESCE(NEW."order_id", OLD."order_id");
    END IF;
    IF target_order_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT binding."legal_terms_revision_id", target."accepted_terms_revision", target."accepted_claim_policy_revision"
      INTO binding_terms_revision_id, terms_code, claims_code
      FROM "orders" target
      LEFT JOIN "order_price_bindings" binding ON binding."id" = target."accepted_order_price_binding_id"
     WHERE target."id" = target_order_id;

    -- No new binding reference means pre-cutover evidence.  Preserve it as-is.
    IF binding_terms_revision_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF terms_code IS NULL OR claims_code IS NULL
       OR NOT EXISTS (
           SELECT 1 FROM "legal_acceptances" acceptance
           JOIN "legal_document_revisions" revision ON revision."id" = acceptance."revision_id"
           WHERE acceptance."order_id" = target_order_id
             AND acceptance."purpose" = 'TERMS_ACCEPTED'
             AND acceptance."revision_id" = binding_terms_revision_id
             AND revision."revision_code" = terms_code
       )
       OR NOT EXISTS (
           SELECT 1 FROM "legal_acceptances" acceptance
           JOIN "legal_document_revisions" revision ON revision."id" = acceptance."revision_id"
           WHERE acceptance."order_id" = target_order_id
             AND acceptance."purpose" = 'CLAIM_POLICY_ACCEPTED'
             AND revision."revision_code" = claims_code
       ) THEN
        RAISE EXCEPTION 'Accepted order with database-backed terms requires matching immutable legal acceptance evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_legal_acceptance_evidence_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_legal_acceptance_evidence_valid"
AFTER INSERT OR UPDATE OF "accepted_order_price_binding_id", "accepted_terms_revision", "accepted_claim_policy_revision"
ON "orders" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_order_legal_acceptance();

CREATE CONSTRAINT TRIGGER "legal_acceptances_order_evidence_valid"
AFTER INSERT ON "legal_acceptances" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_order_legal_acceptance();

-- All settlement and fulfilment callers already use this function.  A new
-- binding is authoritative by revision FK; the legacy PriceList comparison is
-- retained only for records created before this migration.
CREATE OR REPLACE FUNCTION taven_order_accepts_bound_price_list_terms(
    target_order_id uuid,
    target_binding_id uuid
)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "order_active_price_bindings" active
          ON active."order_id" = target_order."id"
         AND active."order_price_binding_id" = target_binding_id
        JOIN "order_price_bindings" binding
          ON binding."id" = active."order_price_binding_id"
         AND binding."order_id" = target_order."id"
        LEFT JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
        LEFT JOIN "price_lists" list ON list."id" = snapshot."price_list_id"
        LEFT JOIN "legal_document_revisions" terms ON terms."id" = binding."legal_terms_revision_id"
        WHERE target_order."id" = target_order_id
          AND target_order."accepted_order_price_binding_id" = binding."id"
          AND (
            (binding."legal_terms_revision_id" IS NOT NULL
             AND terms."revision_code" = target_order."accepted_terms_revision"
             AND EXISTS (
                 SELECT 1 FROM "legal_acceptances" acceptance
                 WHERE acceptance."order_id" = target_order."id"
                   AND acceptance."purpose" = 'TERMS_ACCEPTED'
                   AND acceptance."revision_id" = binding."legal_terms_revision_id"
             ))
            OR
            (binding."legal_terms_revision_id" IS NULL
             AND target_order."accepted_terms_revision" = list."terms_revision")
          )
    );
$$;

CREATE OR REPLACE FUNCTION taven_require_price_list_terms_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."accepted_order_price_binding_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "order_active_price_bindings" active
           JOIN "order_price_bindings" binding
             ON binding."id" = active."order_price_binding_id"
            AND binding."order_id" = active."order_id"
           LEFT JOIN "legal_document_revisions" terms
             ON terms."id" = binding."legal_terms_revision_id"
           JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
           JOIN "price_lists" list ON list."id" = snapshot."price_list_id"
           WHERE active."order_id" = NEW."id"
             AND active."order_price_binding_id" = NEW."accepted_order_price_binding_id"
             AND (
               (binding."legal_terms_revision_id" IS NOT NULL
                AND terms."revision_code" = NEW."accepted_terms_revision")
               OR (binding."legal_terms_revision_id" IS NULL
                   AND NEW."accepted_terms_revision" = list."terms_revision")
             )
       ) THEN
        RAISE EXCEPTION 'checkout acceptance must match its bound legal terms evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'order_checkout_acceptance_terms_revision_check';
    END IF;
    RETURN NEW;
END;
$$;

-- The individual-offer conversion creates its Order aggregate in this same
-- transaction.  It is the sole additional first-acceptance path; it must move
-- DRAFT to QUOTED together with the immutable evidence and cannot be replayed.
CREATE OR REPLACE FUNCTION taven_protect_order_checkout_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
    individual_initial_acceptance boolean := false;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."accepted_order_price_binding_id" IS NOT NULL
           OR NEW."accepted_terms_revision" IS NOT NULL
           OR NEW."accepted_claim_policy_revision" IS NOT NULL
           OR NEW."withdrawal_exception_acknowledged_at" IS NOT NULL THEN
            RAISE EXCEPTION 'checkout acceptance cannot predate the quoted order'
                USING ERRCODE = '23514', CONSTRAINT = 'order_checkout_acceptance_immutable_check';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."accepted_order_price_binding_id" IS NOT DISTINCT FROM OLD."accepted_order_price_binding_id"
       AND NEW."accepted_terms_revision" IS NOT DISTINCT FROM OLD."accepted_terms_revision"
       AND NEW."accepted_claim_policy_revision" IS NOT DISTINCT FROM OLD."accepted_claim_policy_revision"
       AND NEW."withdrawal_exception_acknowledged_at" IS NOT DISTINCT FROM OLD."withdrawal_exception_acknowledged_at" THEN
        RETURN NEW;
    END IF;

    individual_initial_acceptance := OLD."status" = 'DRAFT'
        AND NEW."status" = 'QUOTED'
        AND EXISTS (SELECT 1 FROM "individual_order_origins" origin WHERE origin."order_id" = OLD."id");

    IF OLD."accepted_order_price_binding_id" IS NOT NULL
       OR OLD."accepted_terms_revision" IS NOT NULL
       OR OLD."accepted_claim_policy_revision" IS NOT NULL
       OR OLD."withdrawal_exception_acknowledged_at" IS NOT NULL
       OR NEW."accepted_order_price_binding_id" IS NULL
       OR NEW."accepted_terms_revision" IS NULL
       OR btrim(NEW."accepted_terms_revision") = ''
       OR NEW."accepted_claim_policy_revision" IS NULL
       OR btrim(NEW."accepted_claim_policy_revision") = ''
       OR NEW."withdrawal_exception_acknowledged_at" IS NULL
       OR (NOT individual_initial_acceptance AND (OLD."status" <> 'QUOTED' OR NEW."status" <> 'QUOTED'))
       OR EXISTS (SELECT 1 FROM "payments" payment WHERE payment."order_id" = OLD."id") THEN
        RAISE EXCEPTION 'checkout acceptance must be recorded atomically once before payment'
            USING ERRCODE = '23514', CONSTRAINT = 'order_checkout_acceptance_immutable_check';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "order_active_price_bindings" active
        WHERE active."order_id" = OLD."id"
          AND active."order_price_binding_id" = NEW."accepted_order_price_binding_id"
    ) THEN
        RAISE EXCEPTION 'checkout acceptance must identify the active destination-bound price binding'
            USING ERRCODE = '23514', CONSTRAINT = 'order_checkout_acceptance_binding_check';
    END IF;

    IF NEW."withdrawal_exception_acknowledged_at" < OLD."created_at"
       OR NEW."withdrawal_exception_acknowledged_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'checkout acceptance evidence must follow the quote and cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'order_checkout_acceptance_evidence_check';
    END IF;
    RETURN NEW;
END;
$$;
