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
        OR ("legal_terms_revision_id" IS NOT NULL AND "legal_claims_revision_id" IS NOT NULL AND "claim_window_days" BETWEEN 1 AND 3650)
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

    IF NEW."issuance_command_key" <> 'legacy-import'
       AND NEW."legal_terms_revision_id" IS NULL
       AND NEW."legal_claims_revision_id" IS NULL
       AND NEW."claim_window_days" IS NULL THEN
        RAISE EXCEPTION 'New Quote requires database-backed legal evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'quotes_legal_revisions_required_check';
    END IF;

    IF NEW."legal_terms_revision_id" IS NOT NULL
       AND NOT taven_legal_revision_matches_document(NEW."legal_terms_revision_id", 'terms') THEN
        RAISE EXCEPTION 'Quote legal terms revision must belong to terms'
            USING ERRCODE = '23514', CONSTRAINT = 'quotes_legal_terms_document_check';
    END IF;
    IF NEW."legal_terms_revision_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "legal_document_revisions" revision
           WHERE revision."id" = NEW."legal_terms_revision_id"
             AND revision."revision_code" = NEW."terms_revision"
       ) THEN
        RAISE EXCEPTION 'Quote terms revision must match its legal terms revision'
            USING ERRCODE = '23514', CONSTRAINT = 'quotes_legal_terms_revision_code_check';
    END IF;
    IF NEW."legal_terms_revision_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "legal_document_revisions" revision
           WHERE revision."id" = NEW."legal_terms_revision_id"
             AND jsonb_build_object(
                 'contentVersion', revision."content_version",
                 'title', revision."title",
                 'summary', revision."summary",
                 'sections', revision."sections",
                 'contentHash', revision."content_hash"
             ) = NEW."terms_snapshot"
       ) THEN
        RAISE EXCEPTION 'Quote terms snapshot must match its legal terms revision'
            USING ERRCODE = '23514', CONSTRAINT = 'quotes_terms_snapshot_revision_check';
    END IF;
    IF NEW."legal_claims_revision_id" IS NOT NULL
       AND NOT taven_legal_revision_matches_document(NEW."legal_claims_revision_id", 'claims') THEN
        RAISE EXCEPTION 'Quote legal claims revision must belong to claims'
            USING ERRCODE = '23514', CONSTRAINT = 'quotes_legal_claims_document_check';
    END IF;
    IF NEW."legal_terms_revision_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "legal_document_revisions" revision
           JOIN "legal_documents" document ON document."id" = revision."document_id"
           JOIN "legal_document_publications" publication
             ON publication."revision_id" = revision."id"
            AND publication."cancelled_at" IS NULL
            AND publication."starts_at" <= NEW."issued_at"
            AND (publication."ends_at" IS NULL OR publication."ends_at" > NEW."issued_at")
           WHERE revision."id" = NEW."legal_terms_revision_id"
             AND document."key" = 'terms'
             AND revision."status" = 'APPROVED'
             AND revision."effective_at" <= NEW."issued_at"
       ) THEN
        RAISE EXCEPTION 'Quote legal terms revision must be effective when issued'
            USING ERRCODE = '23514', CONSTRAINT = 'quotes_legal_terms_effective_revision_check';
    END IF;
    IF NEW."legal_claims_revision_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "legal_document_revisions" revision
           JOIN "legal_documents" document ON document."id" = revision."document_id"
           JOIN "legal_document_publications" publication
             ON publication."revision_id" = revision."id"
            AND publication."cancelled_at" IS NULL
            AND publication."starts_at" <= NEW."issued_at"
            AND (publication."ends_at" IS NULL OR publication."ends_at" > NEW."issued_at")
           WHERE revision."id" = NEW."legal_claims_revision_id"
             AND document."key" = 'claims'
             AND revision."status" = 'APPROVED'
             AND revision."effective_at" <= NEW."issued_at"
       ) THEN
        RAISE EXCEPTION 'Quote legal claims revision must be effective when issued'
            USING ERRCODE = '23514', CONSTRAINT = 'quotes_legal_claims_effective_revision_check';
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
    IF NEW."order_id" IS NOT NULL
       AND NEW."purpose" NOT IN ('TERMS_ACCEPTED', 'CLAIM_POLICY_ACCEPTED', 'PHOTO_PUBLICATION_GRANTED') THEN
        RAISE EXCEPTION 'Legal acceptance purpose is incompatible with an Order subject'
            USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptances_order_purpose_check';
    END IF;
    IF NEW."quote_request_id" IS NOT NULL
       AND NEW."purpose" NOT IN ('PRIVACY_NOTICE_ACKNOWLEDGED', 'PHOTO_PUBLICATION_GRANTED') THEN
        RAISE EXCEPTION 'Legal acceptance purpose is incompatible with a QuoteRequest subject'
            USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptances_quote_request_purpose_check';
    END IF;
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
    has_current_acceptance boolean;
    terms_code text;
    claims_code text;
    photo_consent_granted_at timestamptz;
    photo_consent_code text;
    accepted_before_update boolean := false;
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        target_order_id := COALESCE(NEW."id", OLD."id");
        accepted_before_update := TG_OP = 'UPDATE'
            AND OLD."accepted_order_price_binding_id" IS NOT NULL
            AND OLD."accepted_terms_revision" IS NOT NULL
            AND OLD."accepted_claim_policy_revision" IS NOT NULL
            AND OLD."accepted_claim_window_days" IS NOT NULL
            AND OLD."withdrawal_exception_acknowledged_at" IS NOT NULL;
    ELSE
        target_order_id := COALESCE(NEW."order_id", OLD."order_id");
    END IF;
    IF target_order_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT binding."legal_terms_revision_id",
           target."accepted_order_price_binding_id" IS NOT NULL
             OR target."accepted_terms_revision" IS NOT NULL
             OR target."accepted_claim_policy_revision" IS NOT NULL
             OR target."accepted_claim_window_days" IS NOT NULL
             OR target."withdrawal_exception_acknowledged_at" IS NOT NULL,
           target."accepted_terms_revision", target."accepted_claim_policy_revision",
           target."photo_publication_consent_granted_at", target."photo_publication_consent_revision"
      INTO binding_terms_revision_id, has_current_acceptance, terms_code, claims_code, photo_consent_granted_at, photo_consent_code
      FROM "orders" target
      LEFT JOIN "order_price_bindings" binding ON binding."id" = target."accepted_order_price_binding_id"
     WHERE target."id" = target_order_id;

    IF (photo_consent_granted_at IS NULL AND (
           photo_consent_code IS NOT NULL
           OR EXISTS (
               SELECT 1 FROM "legal_acceptances" acceptance
               WHERE acceptance."order_id" = target_order_id
                 AND acceptance."purpose" = 'PHOTO_PUBLICATION_GRANTED'
           )
       ))
       OR (photo_consent_granted_at IS NOT NULL AND (
           photo_consent_code IS NULL
           OR NOT EXISTS (
               SELECT 1
               FROM "legal_acceptances" acceptance
               JOIN "legal_document_revisions" revision ON revision."id" = acceptance."revision_id"
               WHERE acceptance."order_id" = target_order_id
                 AND acceptance."purpose" = 'PHOTO_PUBLICATION_GRANTED'
                 AND revision."revision_code" = photo_consent_code
           )
       )) THEN
        RAISE EXCEPTION 'Accepted photo consent requires matching immutable legal acceptance evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_photo_consent_acceptance_evidence_check';
    END IF;

    -- The nullable revision field preserves only already-accepted pre-cutover
    -- orders. It cannot authorize a first acceptance after this migration.
    IF binding_terms_revision_id IS NULL THEN
        IF EXISTS (
            SELECT 1
            FROM "individual_order_origins" origin
            WHERE origin."order_id" = target_order_id
        ) THEN
            RAISE EXCEPTION 'Individual order requires database-backed legal evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_individual_legal_evidence_check';
        END IF;
        IF has_current_acceptance AND NOT accepted_before_update THEN
            RAISE EXCEPTION 'New order acceptance requires database-backed legal evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_legacy_legal_evidence_check';
        END IF;
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

    -- Individual offers freeze the Claim window on the originating Quote. An
    -- Order scalar and matching ledger row alone cannot prove that window was
    -- the one the customer accepted.
    IF EXISTS (
        SELECT 1
        FROM "individual_order_origins" origin
        WHERE origin."order_id" = target_order_id
    ) AND NOT EXISTS (
        SELECT 1
        FROM "individual_order_origins" origin
        JOIN "quotes" quote ON quote."id" = origin."quote_id"
        JOIN "orders" target ON target."id" = origin."order_id"
        JOIN "order_price_bindings" binding
          ON binding."id" = target."accepted_order_price_binding_id"
        JOIN "legal_acceptances" terms_acceptance
          ON terms_acceptance."order_id" = target_order_id
         AND terms_acceptance."purpose" = 'TERMS_ACCEPTED'
         AND terms_acceptance."revision_id" = quote."legal_terms_revision_id"
        JOIN "legal_acceptances" acceptance
          ON acceptance."order_id" = target_order_id
         AND acceptance."purpose" = 'CLAIM_POLICY_ACCEPTED'
         AND acceptance."revision_id" = quote."legal_claims_revision_id"
        JOIN "legal_document_revisions" revision ON revision."id" = acceptance."revision_id"
        WHERE origin."order_id" = target_order_id
          AND binding."legal_terms_revision_id" = quote."legal_terms_revision_id"
          AND target."accepted_terms_revision" = quote."terms_revision"
          AND quote."claim_window_days" = target."accepted_claim_window_days"
          AND revision."revision_code" = target."accepted_claim_policy_revision"
    ) THEN
        RAISE EXCEPTION 'Individual order legal evidence must match its immutable Quote'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_individual_claim_evidence_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "orders_legal_acceptance_evidence_valid"
AFTER INSERT OR UPDATE OF "accepted_order_price_binding_id", "accepted_terms_revision", "accepted_claim_policy_revision", "photo_publication_consent_granted_at", "photo_publication_consent_revision"
ON "orders" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_order_legal_acceptance();

CREATE CONSTRAINT TRIGGER "legal_acceptances_order_evidence_valid"
AFTER INSERT ON "legal_acceptances" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_order_legal_acceptance();

CREATE CONSTRAINT TRIGGER "individual_order_origins_legal_evidence_valid"
AFTER INSERT OR UPDATE OF "order_id" ON "individual_order_origins"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_order_legal_acceptance();

-- Each new QuoteRequest is an acceptance event, rather than an imported
-- historical record. Require its privacy acknowledgement in the immutable
-- ledger and, when requested, require the matching photo-publication grant.
-- The companion acceptance trigger lets the service insert the request and
-- both ledger rows in one deferred transaction.
CREATE OR REPLACE FUNCTION taven_validate_quote_request_legal_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_quote_request_id uuid;
    photo_consent_granted_at timestamptz;
    request_command_key text;
BEGIN
    IF TG_TABLE_NAME = 'quote_requests' THEN
        target_quote_request_id := COALESCE(NEW."id", OLD."id");
    ELSE
        target_quote_request_id := COALESCE(NEW."quote_request_id", OLD."quote_request_id");
    END IF;
    IF target_quote_request_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT target."photo_publication_consent_granted_at", target."current_state_command_key"
      INTO photo_consent_granted_at, request_command_key
      FROM "quote_requests" target
     WHERE target."id" = target_quote_request_id;

    -- The schema's legacy-import marker identifies pre-cutover/imported rows.
    -- All supported request writers persist a command key and must provide the
    -- ledger evidence below.
    IF request_command_key = 'legacy-import' THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "legal_acceptances" acceptance
        WHERE acceptance."quote_request_id" = target_quote_request_id
          AND acceptance."purpose" = 'PRIVACY_NOTICE_ACKNOWLEDGED'
    ) THEN
        RAISE EXCEPTION 'Quote request requires immutable privacy acknowledgement evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_requests_privacy_acceptance_evidence_check';
    END IF;

    IF (photo_consent_granted_at IS NULL AND EXISTS (
            SELECT 1
            FROM "legal_acceptances" acceptance
            WHERE acceptance."quote_request_id" = target_quote_request_id
              AND acceptance."purpose" = 'PHOTO_PUBLICATION_GRANTED'
        )) OR (photo_consent_granted_at IS NOT NULL AND NOT EXISTS (
            SELECT 1
            FROM "legal_acceptances" acceptance
            WHERE acceptance."quote_request_id" = target_quote_request_id
              AND acceptance."purpose" = 'PHOTO_PUBLICATION_GRANTED'
        )) THEN
        RAISE EXCEPTION 'Quote request photo consent requires matching immutable legal acceptance evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_requests_photo_consent_acceptance_evidence_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "quote_requests_legal_acceptance_evidence_valid"
AFTER INSERT OR UPDATE OF "photo_publication_consent_granted_at"
ON "quote_requests" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_quote_request_legal_acceptance();

CREATE CONSTRAINT TRIGGER "legal_acceptances_quote_request_evidence_valid"
AFTER INSERT ON "legal_acceptances" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_quote_request_legal_acceptance();

-- Individual offers record withdrawal acknowledgement before the order becomes
-- QUOTED. The order-level trigger below restricts that DRAFT exception to its
-- immutable accepted-offer conversion; ordinary checkout evidence still must
-- follow the quoted timestamp.
ALTER TABLE "orders" DROP CONSTRAINT "orders_timestamps_check";
ALTER TABLE "orders" ADD CONSTRAINT "orders_timestamps_check" CHECK (
    ("quoted_at" IS NULL OR "quoted_at" >= "created_at" - interval '5 seconds')
    AND ("confirmed_at" IS NULL OR ("quoted_at" IS NOT NULL AND "confirmed_at" >= "quoted_at"))
    AND (
        "withdrawal_exception_acknowledged_at" IS NULL
        OR "withdrawal_exception_acknowledged_at" >= coalesce("quoted_at", "created_at" - interval '5 seconds')
    )
    AND (
        ("status" = 'DRAFT' AND "quoted_at" IS NULL AND "confirmed_at" IS NULL)
        OR ("status" IN ('QUOTED', 'EXPIRED') AND "quoted_at" IS NOT NULL AND "confirmed_at" IS NULL)
        OR (
            "status" IN (
                'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED', 'AWAITING_BALANCE',
                'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'COMPLETED',
                'RECOVERY_PENDING', 'PARTIALLY_FULFILLED'
            )
            AND "quoted_at" IS NOT NULL
            AND "confirmed_at" IS NOT NULL
        )
        OR ("status" IN ('CANCELLED', 'REFUNDED', 'CANCELLED_SETTLED') AND "quoted_at" IS NOT NULL)
    )
);

-- Individual offer acceptance deliberately happens before payment checkout.
-- It freezes the accepted offer package first; checkout may later record its
-- separately immutable contact snapshot and optional photo decision once.
DROP TRIGGER "orders_checkout_contact_snapshot_protected" ON "orders";

CREATE OR REPLACE FUNCTION taven_protect_order_checkout_contact_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."checkout_contact_snapshot" IS NOT NULL
       OR NEW."accepted_order_price_binding_id" IS NOT NULL
       OR NEW."accepted_terms_revision" IS NOT NULL
       OR NEW."accepted_claim_policy_revision" IS NOT NULL
       OR NEW."accepted_claim_window_days" IS NOT NULL
       OR NEW."withdrawal_exception_acknowledged_at" IS NOT NULL
       OR NEW."photo_publication_consent_granted_at" IS NOT NULL
       OR NEW."photo_publication_consent_revision" IS NOT NULL THEN
      RAISE EXCEPTION 'checkout evidence cannot predate the quoted order'
        USING ERRCODE = '23514',
              CONSTRAINT = 'order_checkout_contact_snapshot_immutable_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."checkout_contact_snapshot" IS NOT DISTINCT FROM OLD."checkout_contact_snapshot"
     AND NEW."accepted_order_price_binding_id" IS NOT DISTINCT FROM OLD."accepted_order_price_binding_id"
     AND NEW."accepted_terms_revision" IS NOT DISTINCT FROM OLD."accepted_terms_revision"
     AND NEW."accepted_claim_policy_revision" IS NOT DISTINCT FROM OLD."accepted_claim_policy_revision"
     AND NEW."accepted_claim_window_days" IS NOT DISTINCT FROM OLD."accepted_claim_window_days"
     AND NEW."withdrawal_exception_acknowledged_at" IS NOT DISTINCT FROM OLD."withdrawal_exception_acknowledged_at"
     AND NEW."photo_publication_consent_granted_at" IS NOT DISTINCT FROM OLD."photo_publication_consent_granted_at"
     AND NEW."photo_publication_consent_revision" IS NOT DISTINCT FROM OLD."photo_publication_consent_revision" THEN
    RETURN NEW;
  END IF;

  -- A separately approved legacy Claim-window repair changes only that
  -- snapshot. Its dedicated trigger verifies the exact approval evidence.
  IF NEW."checkout_contact_snapshot" IS NOT DISTINCT FROM OLD."checkout_contact_snapshot"
     AND NEW."accepted_order_price_binding_id" IS NOT DISTINCT FROM OLD."accepted_order_price_binding_id"
     AND NEW."accepted_terms_revision" IS NOT DISTINCT FROM OLD."accepted_terms_revision"
     AND NEW."accepted_claim_policy_revision" IS NOT DISTINCT FROM OLD."accepted_claim_policy_revision"
     AND NEW."withdrawal_exception_acknowledged_at" IS NOT DISTINCT FROM OLD."withdrawal_exception_acknowledged_at"
     AND NEW."photo_publication_consent_granted_at" IS NOT DISTINCT FROM OLD."photo_publication_consent_granted_at"
     AND NEW."photo_publication_consent_revision" IS NOT DISTINCT FROM OLD."photo_publication_consent_revision"
     AND EXISTS (
       SELECT 1 FROM "claim_window_migration_approvals" approval
       WHERE approval."order_id" = NEW."id"
         AND approval."claim_policy_revision" = NEW."accepted_claim_policy_revision"
         AND approval."claim_window_days" = NEW."accepted_claim_window_days"
     ) THEN
    RETURN NEW;
  END IF;

  IF OLD."checkout_contact_snapshot" IS NULL
     AND OLD."accepted_order_price_binding_id" IS NULL
     AND OLD."accepted_terms_revision" IS NULL
     AND OLD."accepted_claim_policy_revision" IS NULL
     AND OLD."accepted_claim_window_days" IS NULL
     AND OLD."withdrawal_exception_acknowledged_at" IS NULL
     AND OLD."photo_publication_consent_granted_at" IS NULL
     AND OLD."photo_publication_consent_revision" IS NULL
     AND NEW."checkout_contact_snapshot" IS NULL
     AND NEW."accepted_order_price_binding_id" IS NOT NULL
     AND NEW."accepted_terms_revision" IS NOT NULL
     AND NEW."accepted_claim_policy_revision" IS NOT NULL
     AND NEW."accepted_claim_window_days" IS NOT NULL
     AND NEW."withdrawal_exception_acknowledged_at" IS NOT NULL
     AND NEW."photo_publication_consent_granted_at" IS NULL
     AND NEW."photo_publication_consent_revision" IS NULL
     AND OLD."status" = 'DRAFT'
     AND NEW."status" = 'DRAFT'
     AND NOT EXISTS (
       SELECT 1 FROM "payments" payment WHERE payment."order_id" = OLD."id"
     ) THEN
    RETURN NEW;
  END IF;

  IF OLD."checkout_contact_snapshot" IS NULL
     AND OLD."accepted_order_price_binding_id" IS NOT NULL
     AND OLD."accepted_terms_revision" IS NOT NULL
     AND OLD."accepted_claim_policy_revision" IS NOT NULL
     AND OLD."accepted_claim_window_days" IS NOT NULL
     AND OLD."withdrawal_exception_acknowledged_at" IS NOT NULL
     AND NEW."checkout_contact_snapshot" ->> 'version' = '2'
     AND NEW."accepted_order_price_binding_id" = OLD."accepted_order_price_binding_id"
     AND NEW."accepted_terms_revision" = OLD."accepted_terms_revision"
     AND NEW."accepted_claim_policy_revision" = OLD."accepted_claim_policy_revision"
     AND NEW."accepted_claim_window_days" = OLD."accepted_claim_window_days"
     AND NEW."withdrawal_exception_acknowledged_at" = OLD."withdrawal_exception_acknowledged_at"
     AND OLD."status" = 'QUOTED'
     AND NEW."status" = 'QUOTED'
     AND NOT EXISTS (
       SELECT 1 FROM "payments" payment WHERE payment."order_id" = OLD."id"
     ) THEN
    RETURN NEW;
  END IF;

  IF OLD."checkout_contact_snapshot" IS NULL
     AND OLD."accepted_order_price_binding_id" IS NULL
     AND OLD."accepted_terms_revision" IS NULL
     AND OLD."accepted_claim_policy_revision" IS NULL
     AND OLD."accepted_claim_window_days" IS NULL
     AND OLD."withdrawal_exception_acknowledged_at" IS NULL
     AND OLD."photo_publication_consent_granted_at" IS NULL
     AND OLD."photo_publication_consent_revision" IS NULL
     AND NEW."checkout_contact_snapshot" ->> 'version' = '2'
     AND NEW."accepted_order_price_binding_id" IS NOT NULL
     AND NEW."accepted_terms_revision" IS NOT NULL
     AND NEW."accepted_claim_policy_revision" IS NOT NULL
     AND NEW."accepted_claim_window_days" IS NOT NULL
     AND NEW."withdrawal_exception_acknowledged_at" IS NOT NULL
     AND OLD."status" = 'QUOTED'
     AND NEW."status" = 'QUOTED'
     AND NOT EXISTS (
       SELECT 1 FROM "payments" payment WHERE payment."order_id" = OLD."id"
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'checkout evidence is immutable acceptance evidence'
    USING ERRCODE = '23514',
          CONSTRAINT = 'order_checkout_contact_snapshot_immutable_check';
END;
$$;

CREATE TRIGGER "orders_checkout_contact_snapshot_protected"
BEFORE INSERT OR UPDATE OF
  "accepted_order_price_binding_id", "accepted_terms_revision",
  "accepted_claim_policy_revision", "accepted_claim_window_days",
  "withdrawal_exception_acknowledged_at", "checkout_contact_snapshot",
  "photo_publication_consent_granted_at", "photo_publication_consent_revision"
ON "orders"
FOR EACH ROW EXECUTE FUNCTION taven_protect_order_checkout_contact_snapshot();

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

-- Balance-timeout settlement is another consumer of the frozen acceptance
-- contract. New bindings prove terms through the revision FK and ledger while
-- pre-cutover bindings retain their PriceList provenance check.
CREATE OR REPLACE FUNCTION taven_balance_timeout_earned_amount(
    target_order_id uuid,
    target_phase_id uuid,
    target_binding_id uuid,
    target_snapshot_id uuid
)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
    WITH accepted_policy AS (
        SELECT list."parameters" -> 'balance_timeout_earned_component_kinds' AS kinds
        FROM "orders" target_order
        JOIN "order_price_bindings" binding
          ON binding."id" = target_binding_id
         AND binding."order_id" = target_order_id
         AND binding."price_snapshot_id" = target_snapshot_id
        JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
        JOIN "price_lists" list ON list."id" = snapshot."price_list_id"
        WHERE target_order."id" = target_order_id
          AND taven_order_accepts_bound_price_list_terms(
              target_order_id, target_binding_id
          )
    ),
    earned_by_slot AS (
        SELECT allocation."fulfilment_slot_id" AS slot_id,
               sum(allocation."amount_minor")::bigint AS amount_minor
        FROM "price_snapshot_components" component
        JOIN "price_component_fulfilment_allocations" allocation
          ON allocation."price_snapshot_component_id" = component."id"
        JOIN "fulfilment_slots" slot
          ON slot."id" = allocation."fulfilment_slot_id"
         AND slot."order_id" = target_order_id
         AND slot."order_phase_id" = target_phase_id
        CROSS JOIN accepted_policy policy
        WHERE component."price_snapshot_id" = target_snapshot_id
          AND component."kind"::text IN (
              SELECT jsonb_array_elements_text(policy.kinds)
          )
        GROUP BY allocation."fulfilment_slot_id"
    ),
    earned_credits_by_slot AS (
        SELECT (credit.value ->> 'fulfilmentSlotId')::uuid AS slot_id,
               sum((credit.value ->> 'amountMinor')::bigint)::bigint AS amount_minor
        FROM "price_adjustments" adjustment
        CROSS JOIN LATERAL jsonb_array_elements(
            adjustment."allocation" -> 'slotCredits'
        ) credit(value)
        CROSS JOIN accepted_policy policy
        WHERE adjustment."order_id" = target_order_id
          AND (
              adjustment."reason" <> 'EXPRESS_BREACH'
              OR 'EXPRESS' IN (
                  SELECT jsonb_array_elements_text(policy.kinds)
              )
          )
        GROUP BY (credit.value ->> 'fulfilmentSlotId')::uuid
    ),
    active_contract AS (
        SELECT revision."contract_total_minor"
        FROM "order_active_contract_prices" active
        JOIN "order_contract_price_revisions" revision
          ON revision."id" = active."contract_price_revision_id"
         AND revision."order_id" = active."order_id"
         AND revision."base_price_snapshot_id" = target_snapshot_id
        WHERE active."order_id" = target_order_id
    )
    SELECT least(
        active_contract."contract_total_minor",
        coalesce(sum(greatest(
            earned."amount_minor" - coalesce(credits."amount_minor", 0),
            0
        )), 0)::bigint
    )
    FROM active_contract
    LEFT JOIN earned_by_slot earned ON true
    LEFT JOIN earned_credits_by_slot credits ON credits.slot_id = earned.slot_id
    GROUP BY active_contract."contract_total_minor";
$$;

CREATE OR REPLACE FUNCTION taven_prevent_order_price_binding_legal_terms_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- An unaccepted pre-cutover binding may be initialized before its first
    -- checkout acceptance. Accepted evidence must retain its legacy shape
    -- unless a dedicated migration atomically adds the matching ledger rows.
    IF NEW."legal_terms_revision_id" IS DISTINCT FROM OLD."legal_terms_revision_id"
       AND (
           OLD."legal_terms_revision_id" IS NOT NULL
           OR NEW."legal_terms_revision_id" IS NULL
           OR EXISTS (
               SELECT 1
               FROM "orders" target
               WHERE target."accepted_order_price_binding_id" = OLD."id"
           )
       ) THEN
        RAISE EXCEPTION 'order price binding legal terms revision is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_price_binding_immutable_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "order_price_bindings_legal_terms_immutable"
BEFORE UPDATE OF "legal_terms_revision_id" ON "order_price_bindings"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_order_price_binding_legal_terms_mutation();

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
-- transaction. It is the sole additional first-acceptance path; the order
-- remains DRAFT while its immutable offer evidence is recorded.
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
       AND NEW."accepted_claim_window_days" IS NOT DISTINCT FROM OLD."accepted_claim_window_days"
       AND NEW."withdrawal_exception_acknowledged_at" IS NOT DISTINCT FROM OLD."withdrawal_exception_acknowledged_at" THEN
        RETURN NEW;
    END IF;

    individual_initial_acceptance := OLD."status" = 'DRAFT'
        AND NEW."status" = 'DRAFT'
        AND EXISTS (SELECT 1 FROM "individual_order_origins" origin WHERE origin."order_id" = OLD."id");

    IF OLD."accepted_order_price_binding_id" IS NOT NULL
       OR OLD."accepted_terms_revision" IS NOT NULL
       OR OLD."accepted_claim_policy_revision" IS NOT NULL
       OR OLD."accepted_claim_window_days" IS NOT NULL
       OR OLD."withdrawal_exception_acknowledged_at" IS NOT NULL
       OR NEW."accepted_order_price_binding_id" IS NULL
       OR NEW."accepted_terms_revision" IS NULL
       OR btrim(NEW."accepted_terms_revision") = ''
       OR NEW."accepted_claim_policy_revision" IS NULL
       OR btrim(NEW."accepted_claim_policy_revision") = ''
       OR NEW."accepted_claim_window_days" IS NULL
       OR NEW."accepted_claim_window_days" <= 0
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

CREATE OR REPLACE FUNCTION taven_protect_order_claim_window_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."accepted_claim_window_days" IS NOT NULL THEN
            RAISE EXCEPTION 'new orders cannot begin with a Claim-window snapshot'
                USING ERRCODE = '23514', CONSTRAINT = 'order_claim_window_snapshot_check';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."accepted_claim_window_days" IS NOT NULL
       AND NEW."accepted_claim_window_days" IS DISTINCT FROM OLD."accepted_claim_window_days" THEN
        RAISE EXCEPTION 'accepted Claim-window snapshot is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_claim_window_snapshot_check';
    END IF;

    IF NEW."accepted_claim_window_days" IS DISTINCT FROM OLD."accepted_claim_window_days"
       AND NOT (
           OLD."accepted_claim_window_days" IS NULL
           AND NEW."accepted_claim_window_days" IS NOT NULL
           AND NEW."accepted_claim_policy_revision" IS NOT NULL
           AND (
               NEW."status" = 'QUOTED'
               OR (
                   NEW."status" = 'DRAFT'
                   AND EXISTS (
                       SELECT 1 FROM "individual_order_origins" origin
                       WHERE origin."order_id" = NEW."id"
                   )
               )
               OR EXISTS (
                   SELECT 1 FROM "claim_window_migration_approvals" approval
                   WHERE approval."order_id" = NEW."id"
                     AND approval."claim_policy_revision" = NEW."accepted_claim_policy_revision"
                     AND approval."claim_window_days" = NEW."accepted_claim_window_days"
               )
           )
       ) THEN
        RAISE EXCEPTION 'Claim-window snapshot requires quoted acceptance or exact migration approval evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'order_claim_window_snapshot_check';
    END IF;
    RETURN NEW;
END;
$$;
