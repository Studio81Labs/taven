-- PR5b: database-backed legal acceptance provenance.  This intentionally
-- preserves pre-cutover scalar evidence and only makes the new references
-- authoritative when they are present.

CREATE TYPE "legal_acceptance_purpose" AS ENUM (
    'TERMS_ACCEPTED',
    'CLAIM_POLICY_ACCEPTED',
    'PRIVACY_NOTICE_ACKNOWLEDGED',
    'PHOTO_PUBLICATION_GRANTED'
);

ALTER TABLE "quote_requests" ADD COLUMN "current_quote_id" UUID;

DROP INDEX "quotes_quote_request_id_key";
ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_id_request_key" UNIQUE ("id", "quote_request_id"),
    ADD CONSTRAINT "quotes_request_version_key" UNIQUE ("quote_request_id", "version");
ALTER TABLE "quote_requests"
    ADD CONSTRAINT "quote_requests_current_quote_key" UNIQUE ("current_quote_id", "id"),
    ADD CONSTRAINT "quote_requests_current_quote_fkey"
        FOREIGN KEY ("current_quote_id", "id")
        REFERENCES "quotes"("id", "quote_request_id")
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
UPDATE "quote_requests" request
SET "current_quote_id" = quote."id"
FROM "quotes" quote
WHERE quote."quote_request_id" = request."id";

-- Reference-photo retention follows the offer currently selected for the
-- request. Historical offers must not shorten the retention deadline after a
-- reissue changes the current offer pointer.
CREATE OR REPLACE FUNCTION taven_hold_active_order_quote_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    issued_quote_expires_at timestamptz;
BEGIN
    IF NEW."kind" = 'QUOTE_REFERENCE'::"photo_asset_kind"
       AND NEW."scope_kind" = 'QUOTE_REQUEST'::"photo_scope_kind" THEN
        PERFORM 1
        FROM "quote_requests" request
        WHERE request."id" = NEW."scope_id"
        FOR UPDATE;

        SELECT quote."expires_at"
        INTO issued_quote_expires_at
        FROM "quote_requests" request
        JOIN "quotes" quote
          ON quote."id" = request."current_quote_id"
         AND quote."quote_request_id" = request."id"
        WHERE request."id" = NEW."scope_id";

        IF issued_quote_expires_at IS NOT NULL THEN
            NEW."photo_delete_after" := greatest(
                NEW."photo_delete_after",
                issued_quote_expires_at + make_interval(days => NEW."retention_days")
            );
        END IF;

        PERFORM 1
        FROM "individual_order_origins" origin
        JOIN "quotes" quote ON quote."id" = origin."quote_id"
        JOIN "orders" target_order ON target_order."id" = origin."order_id"
        WHERE NEW."scope_id" = quote."quote_request_id"
          AND (
              target_order."status" IN (
                  'CONFIRMED', 'IN_PRODUCTION', 'QC_PASSED',
                  'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'
              )
              OR (
                  target_order."status" = 'CANCELLED'
                  AND EXISTS (
                      SELECT 1
                      FROM "payments" payment
                      WHERE payment."order_id" = target_order."id"
                        AND coalesce(payment."captured_amount_minor", 0) > 0
                  )
              )
          )
        ORDER BY target_order."id"
        FOR UPDATE OF target_order;

        IF FOUND THEN
            IF NEW."deleted_at" IS NOT NULL THEN
                RAISE EXCEPTION 'Active-order quote-reference PhotoAsset cannot be inserted deleted'
                    USING ERRCODE = '23514', CONSTRAINT = 'quote_reference_photo_active_order_check';
            END IF;

            NEW."retention_hold" := CASE
                WHEN NEW."retention_hold" IN ('ACTIVE_CLAIM', 'LEGAL') THEN NEW."retention_hold"
                ELSE 'ACTIVE_ORDER'::"retention_hold"
            END;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- Expiration is evaluated against the request's current offer only. An older
-- superseded offer must not make a reissued request expire early.
CREATE OR REPLACE FUNCTION taven_protect_quote_request_issued_quote()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    acceptance_evaluated_at timestamptz;
BEGIN
    acceptance_evaluated_at := coalesce(NEW."accepted_at", clock_timestamp());

    IF NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'quote request creation evidence is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_created_at_immutable_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'NEW' AND NEW."status" = 'IN_REVIEW')
           OR (OLD."status" = 'IN_REVIEW' AND NEW."status" = 'QUOTED')
           OR (OLD."status" = 'QUOTED' AND NEW."status" IN ('ACCEPTED', 'REJECTED', 'EXPIRED'))
       ) THEN
        RAISE EXCEPTION 'quote request status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_status_transition_check';
    END IF;

    IF NEW."quote_session_id" IS DISTINCT FROM OLD."quote_session_id"
       AND EXISTS (
           SELECT 1 FROM "quotes" quote WHERE quote."quote_request_id" = OLD."id"
       ) THEN
        RAISE EXCEPTION 'a quoted request must retain its quote session origin'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_issued_quote_identity_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "quotes" quote
        WHERE quote."quote_request_id" = OLD."id"
          AND quote."customer_id" IS DISTINCT FROM NEW."customer_id"
    ) THEN
        RAISE EXCEPTION 'a quoted request must retain its issued quote customer'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_issued_quote_owner_check';
    END IF;

    IF EXISTS (
        SELECT 1 FROM "individual_order_origins" origin
        JOIN "quotes" quote ON quote."id" = origin."quote_id"
        WHERE quote."quote_request_id" = OLD."id"
    ) AND NEW."status" <> 'ACCEPTED' THEN
        RAISE EXCEPTION 'an accepted quote request cannot leave ACCEPTED while it owns an order'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_individual_order_status_check';
    END IF;

    IF EXISTS (
        SELECT 1 FROM "quotes" quote WHERE quote."quote_request_id" = OLD."id"
    ) AND NEW."status" NOT IN ('QUOTED', 'ACCEPTED', 'REJECTED', 'EXPIRED') THEN
        RAISE EXCEPTION 'an issued quote request cannot return to a pre-quote state'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_issued_quote_status_check';
    END IF;

    IF NEW."status" = 'EXPIRED'
       AND OLD."status" IS DISTINCT FROM NEW."status"
       AND NOT EXISTS (
           SELECT 1
           FROM "quote_requests" request
           JOIN "quotes" quote
             ON quote."id" = request."current_quote_id"
            AND quote."quote_request_id" = request."id"
           WHERE request."id" = OLD."id"
             AND quote."expires_at" <= clock_timestamp()
       ) THEN
        RAISE EXCEPTION 'quote request can expire only after its immutable Quote deadline'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_expiration_check';
    END IF;

    IF NEW."status" = 'ACCEPTED'
       AND OLD."status" IS DISTINCT FROM NEW."status"
       AND (
           OLD."status" IS DISTINCT FROM 'QUOTED'::"quote_request_status"
           OR NOT EXISTS (
           SELECT 1
           FROM "quotes" quote
           JOIN "quote_price_bindings" binding ON binding."quote_id" = quote."id"
           JOIN "price_snapshots" snapshot ON snapshot."id" = binding."price_snapshot_id"
           WHERE quote."quote_request_id" = OLD."id"
             AND quote."issued_at" <= acceptance_evaluated_at
             AND quote."expires_at" > acceptance_evaluated_at
             AND snapshot."contract_total_minor" > 0
             AND (
                 SELECT coalesce(sum(component."amount_minor"), 0)
                 FROM "price_snapshot_components" component
                 WHERE component."price_snapshot_id" = snapshot."id"
             ) = snapshot."contract_total_minor"
             AND (
                 (
                     taven_individual_full_quote_binding_is_grandfathered(
                         quote."id", snapshot."id"
                     )
                     AND taven_full_payment_schedule_is_valid(
                         snapshot."id", snapshot."contract_total_minor"
                     )
                 )
                 OR (
                     taven_split_payment_schedule_is_valid(
                         snapshot."id", snapshot."contract_total_minor"
                     )
                     AND taven_price_snapshot_balance_deadline_is_valid(snapshot."id")
                     AND taven_price_snapshot_balance_earned_policy_is_valid(snapshot."id")
                 )
             )
             AND NOT EXISTS (
                 SELECT 1
                 FROM "payment_schedules" schedule
                 WHERE schedule."price_snapshot_id" = snapshot."id"
                   AND schedule."gross_amount_minor" <= 0
             )
             AND EXISTS (
                 SELECT 1
                 FROM "quote_items" quote_item
                 WHERE quote_item."quote_id" = quote."id"
             )
             AND NOT EXISTS (
                 SELECT 1
                 FROM "quote_items" quote_item
                 CROSS JOIN (
                     VALUES
                         ('ITEM_PRODUCTION'::"price_component_kind"),
                         ('ITEM_QUANTITY'::"price_component_kind"),
                         ('ITEM_POSTPROCESSING'::"price_component_kind")
                 ) AS mandatory("kind")
                 WHERE quote_item."quote_id" = quote."id"
                   AND NOT EXISTS (
                       SELECT 1
                       FROM "price_snapshot_components" component
                       WHERE component."price_snapshot_id" = snapshot."id"
                         AND component."scope" = 'QUOTE_ITEM'
                         AND component."quote_item_id" = quote_item."id"
                         AND component."kind" = mandatory."kind"
                   )
             )
           )
       ) THEN
        RAISE EXCEPTION 'accepted quote request requires a current quoted offer with one complete immutable price binding'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_price_binding_acceptance_check';
    END IF;

    IF NEW."quote_session_id" IS DISTINCT FROM OLD."quote_session_id" THEN
        PERFORM taven_assert_quote_session_commerce_open(NEW."quote_session_id");
    END IF;

    PERFORM taven_assert_quote_request_session_owner(
        NEW."quote_session_id",
        NEW."customer_id"
    );

    RETURN NEW;
END;
$$;

-- Record the exact request/Quote pairs that were present at cutover. This is
-- immutable migration evidence for the narrowly retained legacy branch; a
-- post-cutover writer cannot manufacture provenance by choosing the marker
-- string or by adding another Quote to an old request.
CREATE TABLE "legacy_quote_request_imports" (
    "quote_request_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    CONSTRAINT "legacy_quote_request_imports_pkey"
        PRIMARY KEY ("quote_request_id", "quote_id"),
    CONSTRAINT "legacy_quote_request_imports_request_fkey"
        FOREIGN KEY ("quote_request_id") REFERENCES "quote_requests"("id") ON DELETE RESTRICT,
    CONSTRAINT "legacy_quote_request_imports_quote_fkey"
        FOREIGN KEY ("quote_id", "quote_request_id")
        REFERENCES "quotes"("id", "quote_request_id") ON DELETE RESTRICT
);
INSERT INTO "legacy_quote_request_imports" ("quote_request_id", "quote_id")
SELECT quote."quote_request_id", quote."id"
FROM "quotes" quote
WHERE quote."issuance_command_key" = 'legacy-import';

CREATE FUNCTION taven_protect_legacy_quote_request_imports()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'legacy quote import evidence is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'legacy_quote_request_imports_immutable_check';
END;
$$;
CREATE TRIGGER "legacy_quote_request_imports_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "legacy_quote_request_imports"
FOR EACH ROW EXECUTE FUNCTION taven_protect_legacy_quote_request_imports();

-- Reconcile the versioned offer pointer at commit.  The composite foreign key
-- proves request ownership, while this deferred check proves that the
-- selected offer is the newest sealed version and that every newly inserted
-- offer is selected before its transaction commits.
CREATE OR REPLACE FUNCTION taven_reconcile_issued_quote_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_request_id uuid;
    request_row record;
    current_quote record;
    latest_version integer;
BEGIN
    IF TG_TABLE_NAME = 'quote_requests' THEN
        target_request_id := NEW."id";
    ELSIF TG_TABLE_NAME = 'quotes' THEN
        target_request_id := NEW."quote_request_id";
    ELSE
        SELECT quote."quote_request_id"
          INTO target_request_id
          FROM "quotes" quote
         WHERE quote."id" = NEW."quote_id";
    END IF;

    SELECT request.*
      INTO request_row
      FROM "quote_requests" request
     WHERE request."id" = target_request_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF TG_TABLE_NAME = 'quotes' AND TG_OP = 'INSERT' THEN
        IF request_row."current_quote_id" IS DISTINCT FROM NEW."id" THEN
            RAISE EXCEPTION 'every inserted Quote must become the current offer'
                USING ERRCODE = '23514', CONSTRAINT = 'quote_request_inserted_offer_current_check';
        END IF;
        SELECT coalesce(max(quote."version"), 0)
          INTO latest_version
          FROM "quotes" quote
         WHERE quote."quote_request_id" = request_row."id"
           AND quote."id" <> NEW."id";
        IF NEW."version" IS DISTINCT FROM latest_version + 1 THEN
            RAISE EXCEPTION 'inserted Quote version must immediately follow the current offer'
                USING ERRCODE = '23514', CONSTRAINT = 'quote_request_inserted_offer_version_check';
        END IF;
    END IF;

    IF TG_TABLE_NAME = 'quote_requests' AND TG_OP = 'UPDATE' THEN
        IF NEW."current_quote_id" IS DISTINCT FROM OLD."current_quote_id"
           AND (
               OLD."status" IN ('ACCEPTED', 'REJECTED', 'EXPIRED')
               OR NEW."status" IN ('ACCEPTED', 'REJECTED', 'EXPIRED')
           ) THEN
            RAISE EXCEPTION 'terminal quote request current offer is immutable'
                USING ERRCODE = '23514', CONSTRAINT = 'quote_request_current_offer_terminal_check';
        END IF;
    END IF;

    IF request_row."current_quote_id" IS NULL THEN
        IF request_row."status" IN ('QUOTED', 'ACCEPTED', 'REJECTED', 'EXPIRED')
           OR TG_TABLE_NAME = 'quotes' THEN
            RAISE EXCEPTION 'quoted or closed request requires its current offer'
                USING ERRCODE = '23514', CONSTRAINT = 'quote_request_issuance_atomic_check';
        END IF;
        RETURN NULL;
    END IF;

    SELECT quote.*
      INTO current_quote
      FROM "quotes" quote
     WHERE quote."id" = request_row."current_quote_id"
       AND quote."quote_request_id" = request_row."id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'quote request current offer does not belong to the request'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_current_offer_identity_check';
    END IF;

    IF current_quote."customer_id" IS DISTINCT FROM request_row."customer_id" THEN
        RAISE EXCEPTION 'quote request current offer customer does not match the request'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_current_offer_customer_check';
    END IF;

    SELECT max(quote."version")
      INTO latest_version
      FROM "quotes" quote
     WHERE quote."quote_request_id" = request_row."id";
    IF current_quote."version" IS DISTINCT FROM latest_version THEN
        RAISE EXCEPTION 'quote request current offer must be the newest version'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_current_offer_version_check';
    END IF;

    IF request_row."status" IN ('NEW', 'IN_REVIEW') THEN
        RAISE EXCEPTION 'pre-quote request cannot select a current offer'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_current_offer_status_check';
    END IF;

    IF request_row."status" = 'QUOTED'
       AND current_quote."issuance_command_key" IS DISTINCT FROM request_row."current_state_command_key" THEN
        RAISE EXCEPTION 'current offer issuance command must match request state command'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_current_offer_command_check';
    END IF;

    IF current_quote."issuance_command_key" <> 'legacy-import' THEN
        IF current_quote."legal_terms_revision_id" IS NULL
           OR current_quote."legal_claims_revision_id" IS NULL
           OR current_quote."claim_window_days" IS NULL
           OR NOT EXISTS (
               SELECT 1
                 FROM "quote_price_bindings" binding
                 JOIN "price_snapshots" snapshot
                   ON snapshot."id" = binding."price_snapshot_id"
                WHERE binding."quote_id" = current_quote."id"
           )
           OR NOT EXISTS (
               SELECT 1 FROM "quote_items" item
                WHERE item."quote_id" = current_quote."id"
           )
           OR NOT EXISTS (
               SELECT 1 FROM "quote_delivery_destinations" destination
                WHERE destination."quote_id" = current_quote."id"
           )
           OR NOT EXISTS (
               SELECT 1 FROM "quote_shipment_plans" plan
                WHERE plan."quote_id" = current_quote."id"
           ) THEN
            RAISE EXCEPTION 'current offer does not contain a complete sealed package'
                USING ERRCODE = '23514', CONSTRAINT = 'quote_request_current_offer_package_check';
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "quote_requests_current_offer_reconciled"
AFTER UPDATE OF "current_quote_id" ON "quote_requests"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_issued_quote_request();

-- Snapshot sealing is performed by the pre-existing deferred commerce
-- reconciliation trigger. Check the sealed bit from a later event so offer
-- reconciliation cannot observe the row before that trigger has sealed it.
CREATE OR REPLACE FUNCTION taven_validate_current_offer_sealed_package()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_request_id uuid;
    request_row record;
    quote_row record;
BEGIN
    SELECT binding."quote_id"
      INTO quote_row
      FROM "quote_price_bindings" binding
     WHERE binding."price_snapshot_id" = NEW."id"
     LIMIT 1;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT quote."quote_request_id"
      INTO target_request_id
      FROM "quotes" quote
     WHERE quote."id" = quote_row."quote_id";
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT request.*
      INTO request_row
      FROM "quote_requests" request
     WHERE request."id" = target_request_id
       AND request."current_quote_id" = quote_row."quote_id"
     FOR UPDATE;
    IF NOT FOUND OR request_row."status" IN ('NEW', 'IN_REVIEW') THEN
        RETURN NULL;
    END IF;

    SELECT quote.*
      INTO quote_row
      FROM "quotes" quote
     WHERE quote."id" = request_row."current_quote_id";
    IF quote_row."issuance_command_key" <> 'legacy-import'
       AND NEW."sealed_at" IS NULL THEN
        RAISE EXCEPTION 'current offer price package must be sealed'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_current_offer_package_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "price_snapshots_current_offer_sealed"
AFTER UPDATE OF "sealed_at" ON "price_snapshots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_current_offer_sealed_package();

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
    "decision_id" UUID,
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

CREATE TABLE "legal_acceptance_decisions" (
    "id" UUID NOT NULL,
    "order_id" UUID,
    "quote_request_id" UUID,
    "source_quote_id" UUID,
    "command_identity" VARCHAR(255) NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL,
    "originating_xid" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "legal_acceptance_decisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "legal_acceptance_decisions_subject_check" CHECK (
        ("order_id" IS NOT NULL AND "quote_request_id" IS NULL)
        OR ("order_id" IS NULL AND "quote_request_id" IS NOT NULL)
    ),
    CONSTRAINT "legal_acceptance_decisions_command_check" CHECK (btrim("command_identity") <> ''),
    CONSTRAINT "legal_acceptance_decisions_time_check" CHECK (
        "decided_at" >= TIMESTAMPTZ '2000-01-01T00:00:00Z'
        AND "decided_at" <= TIMESTAMPTZ '2100-01-01T00:00:00Z'
    )
);

ALTER TABLE "legal_acceptance_decisions"
    ADD CONSTRAINT "legal_acceptance_decisions_order_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT "legal_acceptance_decisions_request_fkey"
        FOREIGN KEY ("quote_request_id") REFERENCES "quote_requests"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT "legal_acceptance_decisions_source_quote_fkey"
        FOREIGN KEY ("source_quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "legal_acceptances"
    ADD CONSTRAINT "legal_acceptances_decision_fkey"
        FOREIGN KEY ("decision_id") REFERENCES "legal_acceptance_decisions"("id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "legal_acceptance_decisions_order_id_key"
    ON "legal_acceptance_decisions"("order_id");
CREATE UNIQUE INDEX "legal_acceptance_decisions_quote_request_id_key"
    ON "legal_acceptance_decisions"("quote_request_id");
CREATE UNIQUE INDEX "legal_acceptance_decisions_source_quote_id_key"
    ON "legal_acceptance_decisions"("source_quote_id");
CREATE INDEX "legal_acceptances_decision_id_idx" ON "legal_acceptances"("decision_id");

CREATE UNIQUE INDEX "legal_acceptances_order_purpose_key"
    ON "legal_acceptances"("order_id", "purpose") WHERE "order_id" IS NOT NULL;
CREATE UNIQUE INDEX "legal_acceptances_quote_request_purpose_key"
    ON "legal_acceptances"("quote_request_id", "purpose") WHERE "quote_request_id" IS NOT NULL;
CREATE INDEX "legal_acceptances_revision_id_idx" ON "legal_acceptances"("revision_id");

-- Historical QuoteRequests retain their explicit legacy marker, but new
-- controlled writes must identify legacy provenance deliberately rather than
-- receiving it from a column default.
ALTER TABLE "quote_requests"
    ALTER COLUMN "current_state_command_key" DROP DEFAULT;

ALTER TABLE "quotes"
    ALTER COLUMN "issuance_command_key" DROP DEFAULT;

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

    -- Publication writers lock these rows FOR UPDATE. Lock both documents in
    -- key order before reading either publication interval below so quote
    -- provenance cannot race an archive or replacement transaction.
    IF NEW."legal_terms_revision_id" IS NOT NULL
       OR NEW."legal_claims_revision_id" IS NOT NULL THEN
        PERFORM document."id"
        FROM "legal_documents" document
        WHERE document."key" IN ('claims', 'terms')
        ORDER BY document."key"
        FOR SHARE;
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
    -- Serialize acceptance validation with publication archival/replacement.
    -- Writers update the same legal_documents row, so a share lock keeps the
    -- publication interval read below consistent with the committed document.
    PERFORM document."id"
    FROM "legal_documents" document
    WHERE document."key" = expected_key
    FOR SHARE;
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
    legacy_complete_acceptance boolean;
    terms_code text;
    claims_code text;
    photo_consent_granted_at timestamptz;
    photo_consent_code text;
    acceptance_purpose legal_acceptance_purpose;
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
    ELSIF TG_TABLE_NAME = 'legal_acceptances' THEN
        target_order_id := COALESCE(NEW."order_id", OLD."order_id");
        acceptance_purpose := NEW."purpose";
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
           target."accepted_order_price_binding_id" IS NOT NULL
             AND target."accepted_terms_revision" IS NOT NULL
             AND target."accepted_claim_policy_revision" IS NOT NULL
             AND target."accepted_claim_window_days" IS NOT NULL
             AND target."withdrawal_exception_acknowledged_at" IS NOT NULL,
           target."accepted_terms_revision", target."accepted_claim_policy_revision",
           target."photo_publication_consent_granted_at", target."photo_publication_consent_revision"
      INTO binding_terms_revision_id, has_current_acceptance, legacy_complete_acceptance,
           terms_code, claims_code, photo_consent_granted_at, photo_consent_code
      FROM "orders" target
      LEFT JOIN "order_price_bindings" binding ON binding."id" = target."accepted_order_price_binding_id"
     WHERE target."id" = target_order_id;

    -- A legacy Order may add its v2 photo fields and the matching immutable
    -- photo grant in one transaction. The ledger trigger must recognize that
    -- the pre-existing scalar acceptance is the authorized legacy state.
    IF TG_TABLE_NAME = 'legal_acceptances'
       AND acceptance_purpose = 'PHOTO_PUBLICATION_GRANTED'
       AND binding_terms_revision_id IS NULL
       AND legacy_complete_acceptance THEN
        accepted_before_update := true;
    END IF;

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
        IF TG_TABLE_NAME = 'legal_acceptances'
           AND acceptance_purpose IN ('TERMS_ACCEPTED', 'CLAIM_POLICY_ACCEPTED') THEN
            RAISE EXCEPTION 'Order terms and claim acceptance require matching accepted order evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_orphaned_legal_acceptance_check';
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
-- Historical rows remain readable, but no later legacy-consent augmentation
-- can bypass the decision-owned writer path.
CREATE OR REPLACE FUNCTION taven_validate_quote_request_legal_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_quote_request_id uuid;
    photo_consent_granted_at timestamptz;
BEGIN
    IF TG_TABLE_NAME = 'quote_requests' THEN
        target_quote_request_id := COALESCE(NEW."id", OLD."id");
    ELSE
        target_quote_request_id := COALESCE(NEW."quote_request_id", OLD."quote_request_id");
    END IF;
    IF target_quote_request_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT target."photo_publication_consent_granted_at"
      INTO photo_consent_granted_at
      FROM "quote_requests" target
     WHERE target."id" = target_quote_request_id;

    IF EXISTS (
        SELECT 1 FROM "quote_requests" target
        WHERE target."id" = target_quote_request_id
          AND target."status" = 'ACCEPTED'
    ) AND NOT EXISTS (
        SELECT 1
        FROM "quote_requests" target
        JOIN "quotes" source_quote
          ON source_quote."quote_request_id" = target."id"
        JOIN "legal_acceptance_decisions" decision
          ON decision."source_quote_id" = source_quote."id"
         AND decision."decided_at" = target."accepted_at"
        WHERE target."id" = target_quote_request_id
          AND target."accepted_at" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Quote request acceptance requires a matching database decision'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_acceptance_decision_check';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "legal_acceptances" acceptance
        WHERE acceptance."quote_request_id" = target_quote_request_id
          AND acceptance."purpose" = 'PRIVACY_NOTICE_ACKNOWLEDGED'
    ) THEN
        -- Historical requests predate the immutable acceptance ledger. Once
        -- such a request is carried forward by the explicit offer reissue
        -- path, retain its legacy privacy evidence rather than making the
        -- replacement offer impossible to accept.
        IF NOT EXISTS (
            SELECT 1
            FROM "legacy_quote_request_imports" imported
            JOIN "quotes" quote
              ON quote."id" = imported."quote_id"
             AND quote."quote_request_id" = imported."quote_request_id"
            WHERE imported."quote_request_id" = target_quote_request_id
              AND quote."issuance_command_key" = 'legacy-import'
        ) THEN
            RAISE EXCEPTION 'Quote request requires immutable privacy acknowledgement evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'quote_requests_privacy_acceptance_evidence_check';
        END IF;
        -- Keep validating photo-consent evidence below. The legacy privacy
        -- exception must not make the mutable photo scalar a bypass for the
        -- immutable consent ledger.
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

CREATE CONSTRAINT TRIGGER "quote_requests_acceptance_decision_valid"
AFTER UPDATE OF "status", "accepted_at" ON "quote_requests"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."status" = 'ACCEPTED')
EXECUTE FUNCTION taven_validate_quote_request_legal_acceptance();

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

-- PR5b decision provenance. Existing legacy rows remain readable with a NULL
-- decision_id; all new acceptance bundles must be owned by one DB-stamped row.
CREATE OR REPLACE FUNCTION taven_validate_legal_acceptance_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    source_request uuid;
    source_order uuid;
    source_quote uuid;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Legal acceptance decisions are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_immutable_check';
    END IF;
    IF (NEW."order_id" IS NULL) = (NEW."quote_request_id" IS NULL) THEN
        RAISE EXCEPTION 'Legal acceptance decision must have exactly one subject'
            USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_subject_check';
    END IF;
    IF btrim(NEW."command_identity") = '' THEN
        RAISE EXCEPTION 'Legal acceptance decision command identity is required'
            USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_command_check';
    END IF;
    IF NEW."quote_request_id" IS NOT NULL THEN
        PERFORM document."id"
        FROM "legal_documents" document
        WHERE document."key" IN ('privacy', 'photoConsent')
        FOR SHARE NOWAIT;
    ELSE
        PERFORM document."id"
        FROM "legal_documents" document
        WHERE document."key" IN ('claims', 'photoConsent', 'terms')
        FOR SHARE NOWAIT;
    END IF;
    IF NEW."quote_request_id" IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM "quote_requests" WHERE id = NEW."quote_request_id") THEN
            RAISE EXCEPTION 'Quote request acceptance decision requires a new request'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_request_state_check';
        END IF;
        IF NEW."source_quote_id" IS NOT NULL THEN
            RAISE EXCEPTION 'Request creation decision cannot have a source Quote'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_source_check';
        END IF;
    ELSE
        IF EXISTS (SELECT 1 FROM "orders" WHERE "id" = NEW."order_id") THEN
            PERFORM target."id"
            FROM "orders" target
            WHERE target."id" = NEW."order_id"
              AND target."status" IN ('DRAFT', 'QUOTED')
            FOR UPDATE NOWAIT;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Order acceptance decision requires a draft or quoted Order'
                    USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_order_state_check';
            END IF;
        ELSE
            IF NEW."source_quote_id" IS NULL THEN
                RAISE EXCEPTION 'Automatic order decision requires an existing Order subject'
                    USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_order_subject_check';
            END IF;
            PERFORM request."id"
            FROM "quote_requests" request
            WHERE request."current_quote_id" = NEW."source_quote_id"
            FOR UPDATE NOWAIT;
        END IF;
        IF EXISTS (SELECT 1 FROM "orders" WHERE "id" = NEW."order_id") THEN
            SELECT origin."quote_id" INTO source_quote
            FROM "individual_order_origins" origin
            WHERE origin."order_id" = NEW."order_id";
        ELSE
            source_quote := NEW."source_quote_id";
        END IF;
        IF source_quote IS NULL THEN
            IF NEW."source_quote_id" IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1
                   FROM "orders" target
                   WHERE target."id" = NEW."order_id"
                     AND target."status" = 'DRAFT'
               ) THEN
                RAISE EXCEPTION 'Automatic order decision cannot have a source Quote'
                    USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_source_check';
            END IF;
            IF EXISTS (
                SELECT 1 FROM "orders" target
                WHERE target."id" = NEW."order_id"
                  AND (target."accepted_order_price_binding_id" IS NOT NULL
                    OR target."accepted_terms_revision" IS NOT NULL
                    OR target."accepted_claim_policy_revision" IS NOT NULL
                    OR target."accepted_claim_window_days" IS NOT NULL
                    OR target."withdrawal_exception_acknowledged_at" IS NOT NULL
                    OR target."photo_publication_consent_granted_at" IS NOT NULL
                    OR EXISTS (SELECT 1 FROM "payments" payment WHERE payment."order_id" = target."id"))
            ) THEN
                RAISE EXCEPTION 'Automatic order already has acceptance evidence'
                    USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_order_state_check';
            END IF;
        ELSIF NEW."source_quote_id" IS DISTINCT FROM source_quote THEN
            RAISE EXCEPTION 'Individual decision source Quote does not match its Order origin'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_source_check';
        END IF;
        IF NEW."source_quote_id" IS NOT NULL AND NOT EXISTS (
            SELECT 1
            FROM "quotes" quote
            JOIN "quote_requests" request
              ON request."id" = quote."quote_request_id"
             AND request."current_quote_id" = quote."id"
            WHERE quote."id" = NEW."source_quote_id"
              AND request."status" = 'QUOTED'
              AND NOT EXISTS (
                  SELECT 1 FROM "individual_order_origins" origin
                  WHERE origin."quote_id" = quote."id"
              )
        ) THEN
            RAISE EXCEPTION 'Individual decision source Quote must be the unexpired current offer'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_source_check';
        END IF;
    END IF;
    NEW."decided_at" := date_trunc('milliseconds', clock_timestamp());
    NEW."originating_xid" := pg_current_xact_id()::text;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "legal_acceptance_decisions_integrity"
BEFORE INSERT OR UPDATE OR DELETE ON "legal_acceptance_decisions"
FOR EACH ROW EXECUTE FUNCTION taven_validate_legal_acceptance_decision();

CREATE OR REPLACE FUNCTION taven_validate_legal_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    expected_key text;
    decision record;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Legal acceptance evidence is append-only'
            USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptances_append_only_check';
    END IF;
    IF NEW."decision_id" IS NULL THEN
        RAISE EXCEPTION 'New legal acceptance requires a database decision'
            USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptances_decision_required_check';
    END IF;
    SELECT * INTO decision FROM "legal_acceptance_decisions" WHERE id = NEW."decision_id";
    IF NOT FOUND
       OR decision."command_identity" IS DISTINCT FROM NEW."command_identity"
       OR decision."decided_at" IS DISTINCT FROM NEW."accepted_at"
       OR decision."originating_xid" IS DISTINCT FROM pg_current_xact_id()::text
       OR ((decision."order_id" IS NULL) IS DISTINCT FROM (NEW."order_id" IS NULL))
       OR decision."order_id" IS DISTINCT FROM NEW."order_id"
       OR decision."quote_request_id" IS DISTINCT FROM NEW."quote_request_id" THEN
        RAISE EXCEPTION 'Legal acceptance does not match its database decision'
            USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptances_decision_match_check';
    END IF;
    expected_key := CASE NEW."purpose"
        WHEN 'TERMS_ACCEPTED' THEN 'terms'
        WHEN 'CLAIM_POLICY_ACCEPTED' THEN 'claims'
        WHEN 'PRIVACY_NOTICE_ACKNOWLEDGED' THEN 'privacy'
        WHEN 'PHOTO_PUBLICATION_GRANTED' THEN 'photoConsent'
    END;
    PERFORM document."id"
    FROM "legal_documents" document
    WHERE document."key" = expected_key
    FOR SHARE NOWAIT;
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

CREATE OR REPLACE FUNCTION taven_validate_legal_acceptance_bundle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    decision record;
    target_order uuid;
    target_request uuid;
    terms_count integer;
    claims_count integer;
    privacy_count integer;
    photo_count integer;
    photo_scalar timestamptz;
    request_created timestamptz;
    order_created timestamptz;
    withdrawal timestamptz;
    origin_quote uuid;
    source_request_status text;
    source_request_accepted timestamptz;
BEGIN
    target_order := COALESCE(NEW."order_id", OLD."order_id");
    target_request := COALESCE(NEW."quote_request_id", OLD."quote_request_id");
    IF TG_TABLE_NAME = 'legal_acceptance_decisions' THEN
        target_order := NEW."order_id";
        target_request := NEW."quote_request_id";
    END IF;
    SELECT * INTO decision
    FROM "legal_acceptance_decisions"
    WHERE (target_order IS NOT NULL AND "order_id" = target_order)
       OR (target_request IS NOT NULL AND "quote_request_id" = target_request);
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF decision."order_id" IS NOT NULL THEN
        SELECT target."created_at", target."withdrawal_exception_acknowledged_at",
               target."photo_publication_consent_granted_at"
          INTO order_created, withdrawal, photo_scalar
          FROM "orders" target WHERE target."id" = decision."order_id";
        IF order_created IS NULL THEN
            RAISE EXCEPTION 'Legal acceptance decision has no Order subject'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_bundle_check';
        END IF;
        IF withdrawal IS DISTINCT FROM decision."decided_at" THEN
            RAISE EXCEPTION 'Order withdrawal acknowledgement must use the decision instant'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_time_check';
        END IF;
        SELECT count(*) FILTER (WHERE purpose = 'TERMS_ACCEPTED'),
               count(*) FILTER (WHERE purpose = 'CLAIM_POLICY_ACCEPTED'),
               count(*) FILTER (WHERE purpose = 'PHOTO_PUBLICATION_GRANTED')
          INTO terms_count, claims_count, photo_count
          FROM "legal_acceptances" WHERE "decision_id" = decision."id";
        IF terms_count <> 1 OR claims_count <> 1 OR photo_count > 1
           OR (photo_scalar IS NULL AND photo_count <> 0)
           OR (photo_scalar IS NOT NULL AND photo_count <> 1)
           OR (photo_count = 1 AND photo_scalar IS DISTINCT FROM decision."decided_at") THEN
            RAISE EXCEPTION 'Order legal acceptance decision is incomplete'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_bundle_check';
        END IF;
        SELECT origin."quote_id" INTO origin_quote
          FROM "individual_order_origins" origin
         WHERE origin."order_id" = decision."order_id";
        IF decision."source_quote_id" IS NOT NULL AND origin_quote IS NULL THEN
            RAISE EXCEPTION 'Automatic order decision cannot have a source Quote'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_source_check';
        END IF;
        IF origin_quote IS NOT NULL
           AND EXISTS (
               SELECT 1
               FROM "quotes" quote
               WHERE quote."id" = origin_quote
                 AND quote."issuance_command_key" <> 'legacy-import'
           )
           AND order_created IS DISTINCT FROM decision."decided_at" THEN
            RAISE EXCEPTION 'Individual Order creation must use the decision instant'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_time_check';
        END IF;
        IF origin_quote IS NOT NULL AND decision."source_quote_id" IS DISTINCT FROM origin_quote THEN
            RAISE EXCEPTION 'Individual decision source Quote is not its Order origin'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_source_check';
        END IF;
        IF origin_quote IS NOT NULL AND EXISTS (
            SELECT 1 FROM "quotes" quote
            WHERE quote."id" = origin_quote
              AND quote."expires_at" <= decision."decided_at"
        ) THEN
            RAISE EXCEPTION 'Individual acceptance decision cannot commit after offer expiry'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_expiry_check';
        END IF;
        IF origin_quote IS NOT NULL THEN
            SELECT request."status"::text, request."accepted_at"
              INTO source_request_status, source_request_accepted
              FROM "quotes" quote
              JOIN "quote_requests" request ON request."id" = quote."quote_request_id"
             WHERE quote."id" = origin_quote;
            IF source_request_status <> 'ACCEPTED'
               OR source_request_accepted IS DISTINCT FROM decision."decided_at" THEN
                RAISE EXCEPTION 'Individual acceptance decision must own the accepted source request transition'
                    USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_request_transition_check';
            END IF;
        END IF;
    ELSE
        SELECT target."created_at", target."photo_publication_consent_granted_at"
          INTO request_created, photo_scalar
          FROM "quote_requests" target WHERE target."id" = decision."quote_request_id";
        IF request_created IS NULL OR request_created IS DISTINCT FROM decision."decided_at" THEN
            RAISE EXCEPTION 'Quote request creation must use the decision instant'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_time_check';
        END IF;
        SELECT count(*) FILTER (WHERE purpose = 'PRIVACY_NOTICE_ACKNOWLEDGED'),
               count(*) FILTER (WHERE purpose = 'PHOTO_PUBLICATION_GRANTED')
          INTO privacy_count, photo_count
          FROM "legal_acceptances" WHERE "decision_id" = decision."id";
        IF privacy_count <> 1 OR photo_count > 1
           OR (photo_scalar IS NULL AND photo_count <> 0)
           OR (photo_scalar IS NOT NULL AND photo_count <> 1) THEN
            RAISE EXCEPTION 'Quote request legal acceptance decision is incomplete'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_bundle_check';
        END IF;
        IF photo_scalar IS NOT NULL AND photo_scalar IS DISTINCT FROM decision."decided_at" THEN
            RAISE EXCEPTION 'Quote request photo consent must use the decision instant'
                USING ERRCODE = '23514', CONSTRAINT = 'legal_acceptance_decision_time_check';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "legal_acceptance_decisions_bundle_valid"
AFTER INSERT ON "legal_acceptance_decisions" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_legal_acceptance_bundle();
CREATE CONSTRAINT TRIGGER "legal_acceptances_decision_bundle_valid"
AFTER INSERT ON "legal_acceptances" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_legal_acceptance_bundle();

-- The earlier acceptance trigger used statement_timestamp(), which would
-- silently replace the database-owned decision instant. Preserve the caller's
-- decision-bound value and let the deferred decision bundle validate it.
CREATE OR REPLACE FUNCTION taven_set_quote_request_acceptance_time()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" = 'ACCEPTED'
       AND NEW."accepted_at" IS DISTINCT FROM OLD."accepted_at" THEN
        RAISE EXCEPTION 'quote request acceptance evidence is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_accepted_at_immutable_check';
    END IF;
    IF OLD."status" = 'QUOTED'
       AND NEW."status" = 'ACCEPTED'
       AND OLD."status" IS DISTINCT FROM NEW."status"
       AND NEW."accepted_at" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "quotes" source_quote
           JOIN "legal_acceptance_decisions" decision
             ON decision."source_quote_id" = source_quote."id"
           WHERE source_quote."quote_request_id" = NEW."id"
             AND decision."decided_at" = NEW."accepted_at"
       ) THEN
        RAISE EXCEPTION 'Quote request acceptance requires a matching database decision'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_acceptance_decision_check';
    END IF;
    RETURN NEW;
END;
$$;

-- A fixture (and any future import) may persist an already-expired immutable
-- offer. It must not extend source retention beyond a deadline that has
-- already elapsed; live offers retain the existing behavior.
CREATE OR REPLACE FUNCTION taven_extend_quote_source_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE "model_files" source
    SET "source_delete_after" = greatest(
        source."source_delete_after",
        quote."expires_at" + make_interval(days => source."source_retention_days")
    )
    FROM "quotes" quote
    WHERE quote."id" = NEW."quote_id"
      AND source."id" = NEW."source_model_file_id"
      AND quote."expires_at" + make_interval(days => source."source_retention_days")
          > clock_timestamp()
      AND quote."expires_at" > quote."issued_at" + interval '1 second';

    RETURN NULL;
END;
$$;

-- Existing completeness functions remain in force, but new acceptance bundles
-- also require the decision-specific transaction/time checks above.
