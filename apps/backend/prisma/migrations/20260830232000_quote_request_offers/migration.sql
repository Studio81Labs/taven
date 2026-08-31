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

ALTER TABLE "quote_sessions"
    ADD COLUMN "capability_key_id" VARCHAR(64),
    ADD CONSTRAINT "quote_sessions_capability_key_id_check" CHECK (
        "capability_key_id" IS NULL
        OR "capability_key_id" ~ '^[0-9a-f]{64}$'
    );

CREATE FUNCTION taven_protect_quote_session_capability_key_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."capability_key_id" IS DISTINCT FROM OLD."capability_key_id" THEN
        RAISE EXCEPTION 'quote session capability key id is immutable'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'quote_session_capability_key_id_immutable_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_sessions_capability_key_id_immutable"
BEFORE UPDATE OF "capability_key_id" ON "quote_sessions"
FOR EACH ROW EXECUTE FUNCTION taven_protect_quote_session_capability_key_id();

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

-- Individual offers carry delivery topology before an Order exists. Keep that
-- topology immutable beside the sealed quote snapshot, then copy and link it
-- when the offer is accepted.
CREATE TABLE "quote_delivery_destinations" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "provider_endpoint_id" VARCHAR(255) NOT NULL,
    "endpoint_type" VARCHAR(100) NOT NULL,
    "address_snapshot" JSONB NOT NULL,
    "capability_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quote_delivery_destinations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quote_delivery_destinations_quote_id_key" UNIQUE ("quote_id"),
    CONSTRAINT "quote_delivery_destinations_id_quote_id_key" UNIQUE ("id", "quote_id"),
    CONSTRAINT "quote_delivery_destinations_shape_check" CHECK (
        "provider_endpoint_id" ~ '[^[:space:]]'
        AND "endpoint_type" ~ '[^[:space:]]'
        AND jsonb_typeof("address_snapshot") = 'object'
        AND jsonb_typeof("capability_snapshot") = 'object'
    ),
    CONSTRAINT "quote_delivery_destinations_quote_id_fkey"
        FOREIGN KEY ("quote_id") REFERENCES "quotes"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "quote_shipment_plans" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "price_snapshot_id" UUID NOT NULL,
    "quote_delivery_destination_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "planned_volume_cubic_mm" BIGINT NOT NULL,
    "planned_weight_milligrams" BIGINT NOT NULL,
    "shipping_amount_minor" BIGINT NOT NULL,
    "packaging_amount_minor" BIGINT NOT NULL,
    "handling_amount_minor" BIGINT NOT NULL,
    "allocation_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quote_shipment_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quote_shipment_plans_quote_id_ordinal_key" UNIQUE ("quote_id", "ordinal"),
    CONSTRAINT "quote_shipment_plans_id_price_snapshot_id_key" UNIQUE ("id", "price_snapshot_id"),
    CONSTRAINT "quote_shipment_plans_shape_check" CHECK (
        "ordinal" >= 0
        AND "category" ~ '[^[:space:]]'
        AND "planned_volume_cubic_mm" >= 0
        AND "planned_weight_milligrams" >= 0
        AND "shipping_amount_minor" >= 0
        AND "packaging_amount_minor" >= 0
        AND "handling_amount_minor" >= 0
        AND jsonb_typeof("allocation_snapshot") = 'object'
        AND jsonb_typeof("allocation_snapshot" -> 'packingUnits') = 'array'
        AND jsonb_array_length("allocation_snapshot" -> 'packingUnits') > 0
    ),
    CONSTRAINT "quote_shipment_plans_quote_id_fkey"
        FOREIGN KEY ("quote_id") REFERENCES "quotes"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quote_shipment_plans_price_snapshot_id_fkey"
        FOREIGN KEY ("price_snapshot_id") REFERENCES "price_snapshots"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quote_shipment_plans_destination_scope_fkey"
        FOREIGN KEY ("quote_delivery_destination_id", "quote_id")
        REFERENCES "quote_delivery_destinations"("id", "quote_id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "price_snapshot_components"
    ADD COLUMN "quote_shipment_plan_id" UUID,
    ADD CONSTRAINT "price_snapshot_components_quote_shipment_plan_id_key"
        UNIQUE ("quote_shipment_plan_id"),
    ADD CONSTRAINT "price_snapshot_components_quote_shipment_plan_snapshot_key"
        UNIQUE ("quote_shipment_plan_id", "price_snapshot_id"),
    ADD CONSTRAINT "price_snapshot_components_quote_shipment_plan_snapshot_fkey"
        FOREIGN KEY ("quote_shipment_plan_id", "price_snapshot_id")
        REFERENCES "quote_shipment_plans"("id", "price_snapshot_id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "price_snapshot_components_quote_shipment_plan_id_idx"
    ON "price_snapshot_components"("quote_shipment_plan_id");

ALTER TABLE "shipment_plans"
    ADD COLUMN "quote_shipment_plan_id" UUID,
    ADD CONSTRAINT "shipment_plans_quote_shipment_plan_id_key"
        UNIQUE ("quote_shipment_plan_id"),
    ADD CONSTRAINT "shipment_plans_quote_shipment_plan_snapshot_key"
        UNIQUE ("quote_shipment_plan_id", "price_snapshot_id"),
    ADD CONSTRAINT "shipment_plans_quote_shipment_plan_snapshot_fkey"
        FOREIGN KEY ("quote_shipment_plan_id", "price_snapshot_id")
        REFERENCES "quote_shipment_plans"("id", "price_snapshot_id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "price_snapshot_components"
    DROP CONSTRAINT "price_snapshot_components_amount_scope_check";

ALTER TABLE "price_snapshot_components"
    ADD CONSTRAINT "price_snapshot_components_amount_scope_check" CHECK (
        "amount_minor" >= 0
        AND (
            ("scope" = 'ORDER'
             AND "quote_item_id" IS NULL
             AND "quote_shipment_plan_id" IS NULL
             AND "order_item_id" IS NULL
             AND "shipment_plan_id" IS NULL)
            OR ("scope" = 'QUOTE_ITEM'
                AND "quote_item_id" IS NOT NULL
                AND "quote_shipment_plan_id" IS NULL
                AND "order_item_id" IS NULL
                AND "shipment_plan_id" IS NULL)
            OR ("scope" = 'QUOTE_SHIPMENT_PLAN'
                AND "quote_item_id" IS NULL
                AND "quote_shipment_plan_id" IS NOT NULL
                AND "order_item_id" IS NULL
                AND "shipment_plan_id" IS NULL)
            OR ("scope" = 'ORDER_ITEM'
                AND "quote_item_id" IS NULL
                AND "quote_shipment_plan_id" IS NULL
                AND "order_item_id" IS NOT NULL
                AND "shipment_plan_id" IS NULL)
            OR ("scope" = 'SHIPMENT_PLAN'
                AND "quote_item_id" IS NULL
                AND "quote_shipment_plan_id" IS NULL
                AND "order_item_id" IS NULL
                AND "shipment_plan_id" IS NOT NULL)
        )
        AND (
            ("kind" IN ('ITEM_PRODUCTION', 'ITEM_QUANTITY', 'ITEM_POSTPROCESSING')
             AND "scope" IN ('QUOTE_ITEM', 'ORDER_ITEM'))
            OR ("kind" = 'SHIPMENT'
                AND "scope" IN ('QUOTE_SHIPMENT_PLAN', 'SHIPMENT_PLAN'))
            OR ("kind" IN ('ORDER_MIN_PRINT', 'ORDER_SMALL_SURCHARGE', 'EXPRESS', 'PAYMENT_FEE')
                AND "scope" = 'ORDER')
        )
    );

CREATE TRIGGER "commerce_creation_evidence_bounded"
BEFORE INSERT ON "quote_delivery_destinations"
FOR EACH ROW EXECUTE FUNCTION taven_validate_commerce_creation_evidence();
CREATE TRIGGER "commerce_creation_evidence_bounded"
BEFORE INSERT ON "quote_shipment_plans"
FOR EACH ROW EXECUTE FUNCTION taven_validate_commerce_creation_evidence();

CREATE TRIGGER "quote_delivery_destinations_immutable"
BEFORE UPDATE OR DELETE ON "quote_delivery_destinations"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();
CREATE TRIGGER "quote_shipment_plans_immutable"
BEFORE UPDATE OR DELETE ON "quote_shipment_plans"
FOR EACH ROW EXECUTE FUNCTION taven_prevent_commerce_row_mutation();
CREATE TRIGGER "quote_shipment_plans_binding_guard"
BEFORE INSERT ON "quote_shipment_plans"
FOR EACH ROW EXECUTE FUNCTION taven_require_unsealed_price_snapshot();

CREATE FUNCTION taven_validate_quote_shipment_plan_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "quote_price_bindings" binding
        WHERE binding."quote_id" = NEW."quote_id"
          AND binding."price_snapshot_id" = NEW."price_snapshot_id"
    ) THEN
        RAISE EXCEPTION 'quote shipment plan must belong to its quote price snapshot'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'quote_shipment_plan_snapshot_owner_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_shipment_plans_ownership"
BEFORE INSERT ON "quote_shipment_plans"
FOR EACH ROW EXECUTE FUNCTION taven_validate_quote_shipment_plan_ownership();

CREATE OR REPLACE FUNCTION taven_validate_price_component_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."quote_item_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM "quote_price_bindings" binding
        JOIN "quote_items" quote_item
          ON quote_item."id" = NEW."quote_item_id"
         AND quote_item."quote_id" = binding."quote_id"
        WHERE binding."price_snapshot_id" = NEW."price_snapshot_id"
    ) THEN
        RAISE EXCEPTION 'quote-item component must belong to the bound quote snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'price_component_quote_item_owner_check';
    END IF;

    IF NEW."quote_shipment_plan_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM "quote_shipment_plans" plan
        JOIN "quote_price_bindings" binding
          ON binding."quote_id" = plan."quote_id"
         AND binding."price_snapshot_id" = plan."price_snapshot_id"
        WHERE plan."id" = NEW."quote_shipment_plan_id"
          AND plan."price_snapshot_id" = NEW."price_snapshot_id"
    ) THEN
        RAISE EXCEPTION 'quote-shipment component must belong to the bound quote snapshot'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'price_component_quote_shipment_owner_check';
    END IF;

    IF NEW."order_item_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM "order_price_bindings" binding
        JOIN "order_items" order_item
          ON order_item."id" = NEW."order_item_id"
         AND order_item."order_id" = binding."order_id"
        WHERE binding."price_snapshot_id" = NEW."price_snapshot_id"
    ) THEN
        RAISE EXCEPTION 'order-item component must belong to the bound order snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'price_component_order_item_owner_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION taven_validate_quoted_shipment_plan_copy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."quote_shipment_plan_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM "quote_shipment_plans" quote_plan
        JOIN "individual_order_origins" origin
          ON origin."quote_id" = quote_plan."quote_id"
         AND origin."order_id" = NEW."order_id"
        JOIN "quote_delivery_destinations" quote_destination
          ON quote_destination."id" = quote_plan."quote_delivery_destination_id"
         AND quote_destination."quote_id" = quote_plan."quote_id"
        JOIN "delivery_destinations" destination
          ON destination."id" = NEW."delivery_destination_id"
         AND destination."order_id" = NEW."order_id"
        WHERE quote_plan."id" = NEW."quote_shipment_plan_id"
          AND quote_plan."price_snapshot_id" = NEW."price_snapshot_id"
          AND quote_plan."ordinal" = NEW."ordinal"
          AND quote_plan."category" = NEW."category"
          AND quote_plan."planned_volume_cubic_mm" = NEW."planned_volume_cubic_mm"
          AND quote_plan."planned_weight_milligrams" = NEW."planned_weight_milligrams"
          AND quote_plan."shipping_amount_minor" = NEW."shipping_amount_minor"
          AND quote_plan."packaging_amount_minor" = NEW."packaging_amount_minor"
          AND quote_plan."handling_amount_minor" = NEW."handling_amount_minor"
          AND quote_plan."allocation_snapshot" = NEW."allocation_snapshot"
          AND quote_destination."provider_endpoint_id" = destination."provider_endpoint_id"
          AND quote_destination."endpoint_type" = destination."endpoint_type"
          AND quote_destination."address_snapshot" = destination."address_snapshot"
          AND quote_destination."capability_snapshot" = destination."capability_snapshot"
    ) THEN
        RAISE EXCEPTION 'accepted shipment plan must exactly copy its quoted topology and destination'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'shipment_plan_quote_copy_reconciliation_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "shipment_plans_quote_copy_reconciled"
BEFORE INSERT ON "shipment_plans"
FOR EACH ROW EXECUTE FUNCTION taven_validate_quoted_shipment_plan_copy();

CREATE OR REPLACE FUNCTION taven_validate_price_component_fulfilment_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    SELECT binding."order_id"
    INTO target_order_id
    FROM "price_snapshot_components" component
    JOIN "order_price_bindings" binding
      ON binding."price_snapshot_id" = component."price_snapshot_id"
    WHERE component."id" = NEW."price_snapshot_component_id";

    IF target_order_id IS NOT NULL THEN
        PERFORM taven_lock_automatic_order_session(target_order_id);

        PERFORM 1
        FROM "orders"
        WHERE "id" = target_order_id
        FOR UPDATE;
    END IF;

    IF target_order_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = target_order_id) THEN
        RAISE EXCEPTION 'price component allocations cannot be added after payment intent creation'
            USING ERRCODE = '23514', CONSTRAINT = 'price_component_fulfilment_allocation_payment_guard';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "price_snapshot_components" component
        JOIN "order_price_bindings" binding
          ON binding."price_snapshot_id" = component."price_snapshot_id"
        JOIN "fulfilment_slots" slot ON slot."id" = NEW."fulfilment_slot_id"
        WHERE component."id" = NEW."price_snapshot_component_id"
          AND slot."order_id" = binding."order_id"
          AND (
              component."scope" = 'ORDER'
              OR (component."scope" = 'ORDER_ITEM'
                  AND component."order_item_id" = slot."order_item_id")
              OR (component."scope" = 'QUOTE_ITEM' AND EXISTS (
                  SELECT 1
                  FROM "individual_order_item_sources" source
                  WHERE source."order_item_id" = slot."order_item_id"
                    AND source."quote_item_id" = component."quote_item_id"
              ))
              OR (component."scope" = 'QUOTE_SHIPMENT_PLAN' AND EXISTS (
                  SELECT 1
                  FROM "shipment_plan_fulfilment_slots" plan_slot
                  JOIN "shipment_plans" plan ON plan."id" = plan_slot."shipment_plan_id"
                  WHERE plan_slot."fulfilment_slot_id" = slot."id"
                    AND plan_slot."order_price_binding_id" = binding."id"
                    AND plan."quote_shipment_plan_id" = component."quote_shipment_plan_id"
                    AND plan."order_price_binding_id" = binding."id"
              ))
              OR (component."scope" = 'SHIPMENT_PLAN' AND EXISTS (
                  SELECT 1
                  FROM "shipment_plan_fulfilment_slots" plan_slot
                  JOIN "shipment_plans" plan ON plan."id" = plan_slot."shipment_plan_id"
                  WHERE plan_slot."fulfilment_slot_id" = slot."id"
                    AND plan_slot."order_price_binding_id" = binding."id"
                    AND plan."id" = component."shipment_plan_id"
                    AND plan."order_price_binding_id" = binding."id"
              ))
          )
    ) THEN
        RAISE EXCEPTION 'price component allocation must target a slot in its bound order scope'
            USING ERRCODE = '23514', CONSTRAINT = 'price_component_fulfilment_allocation_scope_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION taven_assert_quote_shipment_plan_price_components(target_snapshot_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "quote_delivery_destinations" destination
        JOIN "quote_price_bindings" binding
          ON binding."quote_id" = destination."quote_id"
        WHERE binding."price_snapshot_id" = target_snapshot_id
          AND NOT EXISTS (
              SELECT 1
              FROM "quote_shipment_plans" plan
              WHERE plan."quote_id" = destination."quote_id"
                AND plan."price_snapshot_id" = binding."price_snapshot_id"
          )
    ) THEN
        RAISE EXCEPTION 'a quoted delivery destination requires at least one shipment plan'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'quote_shipment_plan_coverage_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "quote_shipment_plans" plan
        LEFT JOIN "price_snapshot_components" component
          ON component."price_snapshot_id" = plan."price_snapshot_id"
         AND component."quote_shipment_plan_id" = plan."id"
         AND component."kind" = 'SHIPMENT'
         AND component."scope" = 'QUOTE_SHIPMENT_PLAN'
        WHERE plan."price_snapshot_id" = target_snapshot_id
        GROUP BY plan."id",
                 plan."shipping_amount_minor",
                 plan."packaging_amount_minor",
                 plan."handling_amount_minor"
        HAVING count(component."id") <> 1
            OR coalesce(sum(component."amount_minor"::numeric), 0::numeric) <>
               plan."shipping_amount_minor"::numeric
               + plan."packaging_amount_minor"::numeric
               + plan."handling_amount_minor"::numeric
    ) THEN
        RAISE EXCEPTION 'each quote shipment plan requires one exact shipment component'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'quote_shipment_plan_price_component_reconciliation_check';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION taven_assert_shipment_plan_price_components(target_snapshot_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "shipment_plans" plan
        LEFT JOIN "price_snapshot_components" component
          ON component."price_snapshot_id" = plan."price_snapshot_id"
         AND component."kind" = 'SHIPMENT'
         AND (
             (component."scope" = 'SHIPMENT_PLAN'
              AND component."shipment_plan_id" = plan."id")
             OR (component."scope" = 'QUOTE_SHIPMENT_PLAN'
                 AND component."quote_shipment_plan_id" = plan."quote_shipment_plan_id")
         )
        WHERE plan."price_snapshot_id" = target_snapshot_id
        GROUP BY plan."id",
                 plan."shipping_amount_minor",
                 plan."packaging_amount_minor",
                 plan."handling_amount_minor"
        HAVING count(component."id") <> 1
            OR coalesce(sum(component."amount_minor"::numeric), 0::numeric) <>
               plan."shipping_amount_minor"::numeric
               + plan."packaging_amount_minor"::numeric
               + plan."handling_amount_minor"::numeric
    ) THEN
        RAISE EXCEPTION 'each shipment plan requires exactly one price component equal to its shipping, packaging, and handling charges'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_price_component_reconciliation_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "quote_shipment_plans" quote_plan
        JOIN "individual_order_origins" origin
          ON origin."quote_id" = quote_plan."quote_id"
        JOIN "order_price_bindings" binding
          ON binding."order_id" = origin."order_id"
         AND binding."price_snapshot_id" = quote_plan."price_snapshot_id"
        WHERE quote_plan."price_snapshot_id" = target_snapshot_id
          AND NOT EXISTS (
              SELECT 1
              FROM "shipment_plans" plan
              WHERE plan."order_id" = origin."order_id"
                AND plan."order_price_binding_id" = binding."id"
                AND plan."quote_shipment_plan_id" = quote_plan."id"
          )
    ) THEN
        RAISE EXCEPTION 'an accepted individual offer must copy every quoted shipment plan'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'shipment_plan_quote_coverage_check';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION taven_validate_price_snapshot_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_snapshot_id uuid;
    contract_total bigint;
    component_total bigint;
BEGIN
    target_snapshot_id := CASE
        WHEN TG_TABLE_NAME = 'price_snapshots' THEN (to_jsonb(NEW) ->> 'id')::uuid
        ELSE (to_jsonb(NEW) ->> 'price_snapshot_id')::uuid
    END;

    SELECT "contract_total_minor"
    INTO contract_total
    FROM "price_snapshots"
    WHERE "id" = target_snapshot_id;

    PERFORM taven_assert_quote_shipment_plan_price_components(target_snapshot_id);

    IF EXISTS (
        SELECT 1
        FROM "order_price_bindings" binding
        JOIN "orders" target_order ON target_order."id" = binding."order_id"
        WHERE binding."price_snapshot_id" = target_snapshot_id
          AND (
              target_order."status" <> 'DRAFT'
              OR EXISTS (
                  SELECT 1
                  FROM "individual_order_origins" origin
                  JOIN "quote_shipment_plans" quote_plan
                    ON quote_plan."quote_id" = origin."quote_id"
                   AND quote_plan."price_snapshot_id" = binding."price_snapshot_id"
                  WHERE origin."order_id" = binding."order_id"
              )
          )
    ) THEN
        PERFORM taven_assert_shipment_plan_price_components(target_snapshot_id);
    END IF;

    SELECT coalesce(sum("amount_minor"), 0)
    INTO component_total
    FROM "price_snapshot_components"
    WHERE "price_snapshot_id" = target_snapshot_id;

    PERFORM taven_assert_payment_schedule_fee_component(target_snapshot_id);

    IF component_total <> contract_total
       OR NOT taven_price_snapshot_payment_schedule_is_valid(
           target_snapshot_id,
           contract_total
       ) THEN
        RAISE EXCEPTION 'price snapshot % requires components and a valid payment schedule equal to its contract total', target_snapshot_id
            USING ERRCODE = '23514', CONSTRAINT = 'price_snapshot_total_reconciliation_check';
    END IF;

    PERFORM taven_assert_automatic_order_reference_slices(binding."order_id")
    FROM "order_price_bindings" binding
    WHERE binding."price_snapshot_id" = target_snapshot_id;

    IF EXISTS (
        SELECT 1
        FROM "quote_price_bindings"
        WHERE "price_snapshot_id" = target_snapshot_id
        UNION ALL
        SELECT 1
        FROM "order_price_bindings"
        WHERE "price_snapshot_id" = target_snapshot_id
    ) THEN
        UPDATE "price_snapshots"
        SET "sealed_at" = CURRENT_TIMESTAMP(3)
        WHERE "id" = target_snapshot_id
          AND "sealed_at" IS NULL;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "quote_shipment_plans_total_reconciled"
AFTER INSERT ON "quote_shipment_plans"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_price_snapshot_totals();

CREATE FUNCTION taven_validate_quote_destination_snapshot_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_snapshot_id uuid;
BEGIN
    SELECT binding."price_snapshot_id"
    INTO target_snapshot_id
    FROM "quote_price_bindings" binding
    WHERE binding."quote_id" = NEW."quote_id";

    IF target_snapshot_id IS NOT NULL THEN
        PERFORM taven_assert_quote_shipment_plan_price_components(target_snapshot_id);
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "quote_delivery_destinations_total_reconciled"
AFTER INSERT ON "quote_delivery_destinations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_quote_destination_snapshot_totals();
