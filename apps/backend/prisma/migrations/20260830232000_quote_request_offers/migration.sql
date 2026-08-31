-- Persist the complete individual-request/offer contract. No-file requests can
-- be quoted after an operator supplies production-ready model inputs; order
-- items remain model-backed so the existing fulfilment planner can cover them.

CREATE TABLE "anonymous_quote_limits" (
    "subject_hash" VARCHAR(64) NOT NULL,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    "window_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "issued_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "anonymous_quote_limits_pkey" PRIMARY KEY ("subject_hash"),
    CONSTRAINT "anonymous_quote_limits_nonnegative" CHECK ("issued_count" >= 0),
    CONSTRAINT "anonymous_quote_limits_window" CHECK (
        "window_expires_at" > "window_started_at"
    )
);

CREATE INDEX "anonymous_quote_limits_window_expires_at_idx"
    ON "anonymous_quote_limits"("window_expires_at");

ALTER TABLE "quote_requests"
    ADD COLUMN "public_reference" VARCHAR(50),
    ADD COLUMN "description" TEXT NOT NULL DEFAULT 'Legacy quote request',
    ADD COLUMN "purpose" TEXT,
    ADD COLUMN "measurements" JSONB,
    ADD COLUMN "requested_date" DATE,
    ADD COLUMN "contact_snapshot" JSONB,
    ADD COLUMN "attribution" JSONB,
    ADD COLUMN "sla_due_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "sla_responded_at" TIMESTAMPTZ(3),
    ADD COLUMN "current_state_command_key" VARCHAR(255) NOT NULL DEFAULT 'legacy-import',
    ADD COLUMN "current_state_result_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN "accepted_at" TIMESTAMPTZ(3),
    ADD COLUMN "rejected_at" TIMESTAMPTZ(3),
    ADD COLUMN "expired_at" TIMESTAMPTZ(3),
    ADD COLUMN "rejection_reason" TEXT;

UPDATE "quote_requests"
SET "public_reference" = 'QR-' || upper(substr(replace("id"::text, '-', ''), 1, 12));

ALTER TABLE "quote_requests"
    ALTER COLUMN "public_reference" SET NOT NULL,
    ALTER COLUMN "public_reference" SET DEFAULT gen_random_uuid()::text,
    ADD CONSTRAINT "quote_requests_public_reference_key" UNIQUE ("public_reference"),
    ADD CONSTRAINT "quote_requests_content_shape_check" CHECK (
        "public_reference" ~ '[^[:space:]]'
        AND "description" ~ '[^[:space:]]'
        AND ("purpose" IS NULL OR "purpose" ~ '[^[:space:]]')
        AND ("measurements" IS NULL OR jsonb_typeof("measurements") = 'object')
        AND ("contact_snapshot" IS NULL OR jsonb_typeof("contact_snapshot") = 'object')
        AND ("attribution" IS NULL OR jsonb_typeof("attribution") = 'object')
        AND (
            "current_state_command_key" = 'legacy-import'
            OR "sla_due_at" >= "created_at"
        )
        AND "current_state_command_key" ~ '[^[:space:]]'
    ),
    ADD CONSTRAINT "quote_requests_terminal_evidence_check" CHECK (
        (
            "status" IN ('NEW', 'IN_REVIEW', 'QUOTED')
            AND "accepted_at" IS NULL
            AND "rejected_at" IS NULL
            AND "expired_at" IS NULL
            AND "rejection_reason" IS NULL
        ) OR (
            "status" = 'ACCEPTED'
            AND ("accepted_at" IS NOT NULL OR "current_state_command_key" = 'legacy-import')
            AND "rejected_at" IS NULL
            AND "expired_at" IS NULL
            AND "rejection_reason" IS NULL
        ) OR (
            "status" = 'REJECTED'
            AND "accepted_at" IS NULL
            AND ("rejected_at" IS NOT NULL OR "current_state_command_key" = 'legacy-import')
            AND "expired_at" IS NULL
        ) OR (
            "status" = 'EXPIRED'
            AND "accepted_at" IS NULL
            AND "rejected_at" IS NULL
            AND ("expired_at" IS NOT NULL OR "current_state_command_key" = 'legacy-import')
            AND "rejection_reason" IS NULL
        )
    );

CREATE INDEX "quote_requests_status_sla_due_at_idx"
    ON "quote_requests"("status", "sla_due_at");

ALTER TABLE "audit_events"
    ADD COLUMN "quote_request_id" UUID;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_quote_request_id_fkey"
    FOREIGN KEY ("quote_request_id") REFERENCES "quote_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "audit_events_quote_request_id_created_at_idx"
    ON "audit_events"("quote_request_id", "created_at");

ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_scope_check";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_scope_check" CHECK (
    "quote_request_id" IS NOT NULL
    OR "quote_id" IS NOT NULL
    OR "order_id" IS NOT NULL
    OR "payment_id" IS NOT NULL
    OR "refund_transaction_id" IS NOT NULL
);

-- Extend the commerce audit reconciliation trigger with the newly addressable
-- quote-request scope while preserving every pre-existing cross-scope check.
CREATE OR REPLACE FUNCTION taven_validate_audit_event_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
    matching_customer_owners integer;
    mismatched_customer_owners integer;
BEGIN
    IF NEW."created_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'Audit event creation evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_created_at_check';
    END IF;

    IF NEW."quote_request_id" IS NOT NULL
       AND NEW."quote_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM "quotes" quote
           WHERE quote."id" = NEW."quote_id"
             AND quote."quote_request_id" = NEW."quote_request_id"
       ) THEN
        RAISE EXCEPTION 'audit event quote must belong to its scoped quote request'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."quote_request_id" IS NOT NULL
       AND NEW."order_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "quote_requests" request
           JOIN "quotes" quote ON quote."quote_request_id" = request."id"
           JOIN "individual_order_origins" origin
             ON origin."quote_id" = quote."id"
           WHERE request."id" = NEW."quote_request_id"
             AND origin."order_id" = NEW."order_id"
           UNION ALL
           SELECT 1
           FROM "quote_requests" request
           JOIN "automatic_order_origins" origin
             ON origin."quote_session_id" = request."quote_session_id"
           WHERE request."id" = NEW."quote_request_id"
             AND origin."order_id" = NEW."order_id"
       ) THEN
        RAISE EXCEPTION 'audit event quote request must belong to its scoped order origin'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."quote_request_id" IS NOT NULL
       AND NEW."payment_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "payments" payment
           JOIN "individual_order_origins" origin
             ON origin."order_id" = payment."order_id"
           JOIN "quotes" quote ON quote."id" = origin."quote_id"
           WHERE quote."quote_request_id" = NEW."quote_request_id"
             AND payment."id" = NEW."payment_id"
           UNION ALL
           SELECT 1
           FROM "payments" payment
           JOIN "automatic_order_origins" origin
             ON origin."order_id" = payment."order_id"
           JOIN "quote_requests" request
             ON request."quote_session_id" = origin."quote_session_id"
           WHERE request."id" = NEW."quote_request_id"
             AND payment."id" = NEW."payment_id"
       ) THEN
        RAISE EXCEPTION 'audit event quote request must belong to its scoped payment order origin'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."quote_request_id" IS NOT NULL
       AND NEW."refund_transaction_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "refund_transactions" refund
           JOIN "payments" payment ON payment."id" = refund."payment_id"
           JOIN "individual_order_origins" origin
             ON origin."order_id" = payment."order_id"
           JOIN "quotes" quote ON quote."id" = origin."quote_id"
           WHERE quote."quote_request_id" = NEW."quote_request_id"
             AND refund."id" = NEW."refund_transaction_id"
           UNION ALL
           SELECT 1
           FROM "refund_transactions" refund
           JOIN "payments" payment ON payment."id" = refund."payment_id"
           JOIN "automatic_order_origins" origin
             ON origin."order_id" = payment."order_id"
           JOIN "quote_requests" request
             ON request."quote_session_id" = origin."quote_session_id"
           WHERE request."id" = NEW."quote_request_id"
             AND refund."id" = NEW."refund_transaction_id"
       ) THEN
        RAISE EXCEPTION 'audit event quote request must belong to its scoped refund order origin'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."quote_id" IS NOT NULL
       AND NEW."order_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "individual_order_origins" origin
           WHERE origin."quote_id" = NEW."quote_id"
             AND origin."order_id" = NEW."order_id"
           UNION ALL
           SELECT 1
           FROM "automatic_order_origins" origin
           JOIN "orders" target_order ON target_order."id" = origin."order_id"
           JOIN "quote_requests" request
             ON request."quote_session_id" = origin."quote_session_id"
           JOIN "quotes" quote ON quote."quote_request_id" = request."id"
           WHERE quote."id" = NEW."quote_id"
             AND origin."order_id" = NEW."order_id"
             AND (target_order."customer_id" IS NULL
                  OR quote."customer_id" = target_order."customer_id")
       ) THEN
        RAISE EXCEPTION 'audit event quote must belong to its scoped order origin'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."quote_id" IS NOT NULL
       AND NEW."payment_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "payments" payment
           JOIN "individual_order_origins" origin
             ON origin."order_id" = payment."order_id"
            AND origin."quote_id" = NEW."quote_id"
           WHERE payment."id" = NEW."payment_id"
           UNION ALL
           SELECT 1
           FROM "payments" payment
           JOIN "automatic_order_origins" origin
             ON origin."order_id" = payment."order_id"
           JOIN "orders" target_order ON target_order."id" = payment."order_id"
           JOIN "quote_requests" request
             ON request."quote_session_id" = origin."quote_session_id"
           JOIN "quotes" quote ON quote."quote_request_id" = request."id"
           WHERE payment."id" = NEW."payment_id"
             AND quote."id" = NEW."quote_id"
             AND (target_order."customer_id" IS NULL
                  OR quote."customer_id" = target_order."customer_id")
       ) THEN
        RAISE EXCEPTION 'audit event quote must belong to its scoped payment order origin'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."quote_id" IS NOT NULL
       AND NEW."refund_transaction_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "refund_transactions" refund
           JOIN "payments" payment ON payment."id" = refund."payment_id"
           JOIN "individual_order_origins" origin
             ON origin."order_id" = payment."order_id"
            AND origin."quote_id" = NEW."quote_id"
           WHERE refund."id" = NEW."refund_transaction_id"
           UNION ALL
           SELECT 1
           FROM "refund_transactions" refund
           JOIN "payments" payment ON payment."id" = refund."payment_id"
           JOIN "automatic_order_origins" origin
             ON origin."order_id" = payment."order_id"
           JOIN "orders" target_order ON target_order."id" = payment."order_id"
           JOIN "quote_requests" request
             ON request."quote_session_id" = origin."quote_session_id"
           JOIN "quotes" quote ON quote."quote_request_id" = request."id"
           WHERE refund."id" = NEW."refund_transaction_id"
             AND quote."id" = NEW."quote_id"
             AND (target_order."customer_id" IS NULL
                  OR quote."customer_id" = target_order."customer_id")
       ) THEN
        RAISE EXCEPTION 'audit event quote must belong to its scoped refund order origin'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."payment_id" IS NOT NULL
       AND NEW."order_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM "payments" payment
           WHERE payment."id" = NEW."payment_id"
             AND payment."order_id" = NEW."order_id"
       ) THEN
        RAISE EXCEPTION 'audit event payment must belong to its scoped order'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."refund_transaction_id" IS NOT NULL
       AND NEW."payment_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM "refund_transactions" refund
           WHERE refund."id" = NEW."refund_transaction_id"
             AND refund."payment_id" = NEW."payment_id"
       ) THEN
        RAISE EXCEPTION 'audit event refund must belong to its scoped payment'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."refund_transaction_id" IS NOT NULL
       AND NEW."order_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "refund_transactions" refund
           JOIN "payments" payment ON payment."id" = refund."payment_id"
           WHERE refund."id" = NEW."refund_transaction_id"
             AND payment."order_id" = NEW."order_id"
       ) THEN
        RAISE EXCEPTION 'audit event refund must belong to its scoped order'
            USING ERRCODE = '23514', CONSTRAINT = 'audit_event_scope_reconciliation_check';
    END IF;

    IF NEW."actor_kind" = 'CUSTOMER'::"audit_actor_kind"
       AND NEW."actor_id" IS NOT NULL THEN
        SELECT
            count(*) FILTER (WHERE scoped_owner."customer_id" = NEW."actor_id"),
            count(*) FILTER (
                WHERE scoped_owner."customer_id" IS NOT NULL
                  AND scoped_owner."customer_id" <> NEW."actor_id"
            )
        INTO matching_customer_owners, mismatched_customer_owners
        FROM (
            SELECT request."customer_id"
            FROM "quote_requests" request
            WHERE request."id" = NEW."quote_request_id"
            UNION ALL
            SELECT quote."customer_id"
            FROM "quotes" quote
            WHERE quote."id" = NEW."quote_id"
            UNION ALL
            SELECT target_order."customer_id"
            FROM "orders" target_order
            WHERE target_order."id" = NEW."order_id"
            UNION ALL
            SELECT target_order."customer_id"
            FROM "payments" payment
            JOIN "orders" target_order ON target_order."id" = payment."order_id"
            WHERE payment."id" = NEW."payment_id"
            UNION ALL
            SELECT target_order."customer_id"
            FROM "refund_transactions" refund
            JOIN "payments" payment ON payment."id" = refund."payment_id"
            JOIN "orders" target_order ON target_order."id" = payment."order_id"
            WHERE refund."id" = NEW."refund_transaction_id"
        ) scoped_owner;

        IF matching_customer_owners = 0 OR mismatched_customer_owners > 0 THEN
            RAISE EXCEPTION 'customer audit actor must match every non-null scoped commerce owner'
                USING ERRCODE = '23514', CONSTRAINT = 'audit_event_customer_owner_check';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION taven_protect_quote_request_content()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."public_reference" IS DISTINCT FROM OLD."public_reference"
       OR NEW."description" IS DISTINCT FROM OLD."description"
       OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
       OR NEW."measurements" IS DISTINCT FROM OLD."measurements"
       OR NEW."requested_date" IS DISTINCT FROM OLD."requested_date"
       OR NEW."contact_snapshot" IS DISTINCT FROM OLD."contact_snapshot"
       OR NEW."attribution" IS DISTINCT FROM OLD."attribution"
       OR NEW."sla_due_at" IS DISTINCT FROM OLD."sla_due_at" THEN
        RAISE EXCEPTION 'quote request submitted content and SLA deadline are immutable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'quote_request_content_immutable_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_requests_content_immutable"
BEFORE UPDATE ON "quote_requests"
FOR EACH ROW EXECUTE FUNCTION taven_protect_quote_request_content();

ALTER TABLE "quotes"
    ADD COLUMN "public_token_hash" VARCHAR(64),
    ADD COLUMN "capability_key_id" VARCHAR(64),
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "summary" TEXT NOT NULL DEFAULT 'Legacy individual offer',
    ADD COLUMN "terms_revision" VARCHAR(100) NOT NULL DEFAULT 'legacy-terms',
    ADD COLUMN "terms_snapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN "promised_date" DATE,
    ADD COLUMN "issuance_command_key" VARCHAR(255) NOT NULL DEFAULT 'legacy-import',
    ADD COLUMN "issuance_result_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD CONSTRAINT "quotes_public_token_hash_key" UNIQUE ("public_token_hash"),
    ADD CONSTRAINT "quotes_offer_shape_check" CHECK (
        (
            ("public_token_hash" IS NULL AND "capability_key_id" IS NULL)
            OR (
                "public_token_hash" ~ '^[0-9a-f]{64}$'
                AND "capability_key_id" ~ '^[0-9a-f]{64}$'
            )
        )
        AND "version" > 0
        AND "summary" ~ '[^[:space:]]'
        AND "terms_revision" ~ '[^[:space:]]'
        AND jsonb_typeof("terms_snapshot") = 'object'
        AND "issuance_command_key" ~ '[^[:space:]]'
    );
