-- One receipt applicator owns both provider API successes and operator-attested
-- final results. The immutable receipt is inserted before selecting an outcome;
-- all lineage, Payment and order-barrier changes commit in the same transaction.
CREATE FUNCTION taven_apply_refund_provider_result(
    target_refund_id uuid,
    refund_provider_id text,
    refund_event_id text,
    refund_kind "payment_provider_event_kind",
    refund_occurred_at timestamptz,
    refund_evidence jsonb
)
RETURNS TABLE (
    receipt_id uuid,
    recorded boolean,
    success_refund_id uuid,
    incident_code text
)
LANGUAGE plpgsql
AS $$
DECLARE
    target_refund "refund_transactions"%ROWTYPE;
    target_payment "payments"%ROWTYPE;
    replacement "refund_transactions"%ROWTYPE;
    source_refund "refund_transactions"%ROWTYPE;
    source_success "payment_provider_events"%ROWTYPE;
    prior_result "payment_provider_events"%ROWTYPE;
    existing_event "payment_provider_events"%ROWTYPE;
    target_payment_id uuid;
    result_verified_at timestamptz;
    effective_occurred_at timestamptz;
    receipt_payload jsonb;
    receipt_hash text;
    succeeded_total bigint;
    pending_count bigint;
BEGIN
    IF refund_kind NOT IN ('REFUND_SUCCEEDED', 'REFUND_FAILED')
       OR refund_provider_id IS NULL
       OR refund_provider_id !~ '[^[:space:]]'
       OR refund_event_id IS NULL
       OR refund_event_id !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'refund result evidence is incomplete'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_result_evidence_check';
    END IF;

    SELECT refund."payment_id" INTO target_payment_id
    FROM "refund_transactions" refund
    WHERE refund."id" = target_refund_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'refund transaction does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'refund_transactions_pkey';
    END IF;

    -- An absent provider event has no row to lock. Its advisory fence is rank
    -- zero, before the Order/Phase/Refund/Payment envelope.
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'refund-receipt:' || refund_event_id, 0
    ));
    PERFORM taven_lock_checkout_payment_envelope(target_payment_id);

    SELECT * INTO target_refund FROM "refund_transactions" refund
    WHERE refund."id" = target_refund_id
      AND refund."payment_id" = target_payment_id FOR UPDATE;
    SELECT * INTO target_payment FROM "payments" payment
    WHERE payment."id" = target_payment_id FOR UPDATE;
    IF target_refund."provider" IS DISTINCT FROM target_payment."provider"
       OR (target_refund."provider_refund_id" IS NOT NULL
           AND target_refund."provider_refund_id" IS DISTINCT FROM refund_provider_id)
       OR (refund_occurred_at IS NOT NULL
           AND (
               refund_occurred_at < target_refund."requested_at" - interval '5 seconds'
               OR (target_refund."dispatch_claimed_at" IS NOT NULL
                   AND refund_occurred_at <
                       target_refund."dispatch_claimed_at" - interval '5 seconds')
           )) THEN
        RAISE EXCEPTION 'refund result does not match its exact attempt'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_result_scope_check';
    END IF;

    result_verified_at := clock_timestamp();
    -- Some authenticated provider APIs report success without an occurrence
    -- instant. In that case use database observation time; operator-attested
    -- evidence is separately required by the HTTP contract to supply it.
    effective_occurred_at := coalesce(refund_occurred_at, result_verified_at);
    receipt_payload := jsonb_build_object(
        'paymentId', target_payment."id"::text,
        'refundTransactionId', target_refund."id"::text,
        'providerEventId', refund_event_id,
        'providerTransactionId', refund_provider_id,
        'kind', refund_kind::text,
        'amountMinor', target_refund."amount_minor"::text,
        'currency', target_payment."currency",
        'evidence', coalesce(refund_evidence, '{}'::jsonb)
    );
    receipt_hash := encode(
        sha256(convert_to(receipt_payload::text, 'UTF8')), 'hex'
    );

    SELECT * INTO existing_event
    FROM "payment_provider_events" event
    WHERE event."provider" = target_payment."provider"
      AND event."provider_event_id" = refund_event_id FOR UPDATE;
    IF FOUND THEN
        IF existing_event."payment_id" IS DISTINCT FROM target_payment."id"
           OR existing_event."refund_transaction_id" IS DISTINCT FROM target_refund."id"
           OR existing_event."provider_transaction_id" IS DISTINCT FROM refund_provider_id
           OR existing_event."kind" IS DISTINCT FROM refund_kind
           OR existing_event."amount_minor" IS DISTINCT FROM target_refund."amount_minor"
           OR existing_event."currency" IS DISTINCT FROM target_payment."currency"
           OR (refund_occurred_at IS NOT NULL
               AND existing_event."occurred_at" IS DISTINCT FROM refund_occurred_at)
           OR existing_event."payload_hash" IS DISTINCT FROM receipt_hash THEN
            RAISE EXCEPTION 'refund provider event identity was reused with different evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
        END IF;
        receipt_id := existing_event."id";
        recorded := false;
        success_refund_id := NULL;
        incident_code := NULL;
        IF refund_kind = 'REFUND_SUCCEEDED' THEN
            IF target_refund."status" = 'SUSPENDED'
               AND target_refund."provider_result_event_id" = existing_event."id"
               AND target_refund."source_success_provider_event_id" IS NOT NULL THEN
                incident_code := 'REFUND_DOUBLE_SUCCESS';
            ELSIF EXISTS (
                SELECT 1 FROM "refund_transactions" child
                WHERE child."replaces_refund_transaction_id" = target_refund."id"
                  AND child."status" = 'SUSPENDED'
                  AND child."source_success_provider_event_id" = existing_event."id"
            ) THEN
                incident_code := 'REFUND_SUSPENDED';
            END IF;
        END IF;
        RETURN NEXT;
        RETURN;
    END IF;

    receipt_id := gen_random_uuid();
    recorded := true;
    success_refund_id := NULL;
    incident_code := NULL;
    INSERT INTO "payment_provider_events" (
        "id", "payment_id", "refund_transaction_id", "provider",
        "provider_event_id", "provider_transaction_id", "kind",
        "amount_minor", "currency", "payload", "payload_hash",
        "occurred_at", "authenticated_at", "verified_at", "created_at"
    ) VALUES (
        receipt_id, target_payment."id", target_refund."id",
        target_payment."provider", refund_event_id, refund_provider_id,
        refund_kind, target_refund."amount_minor", target_payment."currency",
        receipt_payload, receipt_hash, effective_occurred_at,
        result_verified_at, result_verified_at, result_verified_at
    );

    IF target_refund."status" = 'PENDING' THEN
        UPDATE "refund_transactions"
        SET "status" = CASE refund_kind
                WHEN 'REFUND_SUCCEEDED' THEN 'SUCCEEDED'::"refund_status"
                ELSE 'FAILED'::"refund_status" END,
            "provider_refund_id" = refund_provider_id,
            "provider_result_event_id" = receipt_id,
            "completed_at" = CASE refund_kind
                WHEN 'REFUND_SUCCEEDED' THEN result_verified_at
                ELSE NULL END,
            "updated_at" = result_verified_at
        WHERE "id" = target_refund."id";
        IF refund_kind = 'REFUND_SUCCEEDED' THEN
            success_refund_id := target_refund."id";
        END IF;
    ELSIF target_refund."status" = 'FAILED'
          AND refund_kind = 'REFUND_SUCCEEDED' THEN
        SELECT * INTO prior_result FROM "payment_provider_events" event
        WHERE event."id" = target_refund."provider_result_event_id";
        IF prior_result."kind" IS DISTINCT FROM 'REFUND_FAILED'
           OR effective_occurred_at <= prior_result."occurred_at" THEN
            RAISE EXCEPTION 'late refund success must follow its selected failure'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_result_event_order_check';
        END IF;
        SELECT * INTO replacement FROM "refund_transactions" child
        WHERE child."replaces_refund_transaction_id" = target_refund."id"
        FOR UPDATE;
        IF FOUND AND replacement."status" IN ('PENDING', 'SUCCEEDED') THEN
            IF replacement."dispatch_claimed_at" IS NULL THEN
                UPDATE "refund_transactions"
                SET "status" = 'SUPERSEDED',
                    "source_success_provider_event_id" = receipt_id,
                    "reconciliation_started_at" = result_verified_at,
                    "updated_at" = result_verified_at
                WHERE "id" = replacement."id";
            ELSE
                UPDATE "refund_transactions"
                SET "status" = 'SUSPENDED',
                    "source_success_provider_event_id" = receipt_id,
                    "reconciliation_started_at" = result_verified_at,
                    "completed_at" = NULL,
                    "updated_at" = result_verified_at
                WHERE "id" = replacement."id";
                incident_code := 'REFUND_SUSPENDED';
            END IF;
        ELSIF FOUND AND replacement."status" <> 'FAILED' THEN
            RAISE EXCEPTION 'refund replacement has an unresolved outcome'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_retry_source_reconciliation_check';
        END IF;
        IF incident_code IS NULL THEN
            UPDATE "refund_transactions"
            SET "status" = 'SUCCEEDED',
                "provider_result_event_id" = receipt_id,
                "completed_at" = result_verified_at,
                "updated_at" = result_verified_at
            WHERE "id" = target_refund."id";
            success_refund_id := target_refund."id";
        END IF;
    ELSIF target_refund."status" = 'SUSPENDED'
          AND refund_kind = 'REFUND_FAILED' THEN
        IF target_refund."dispatch_claimed_at" IS NULL
           OR target_refund."provider_result_event_id" IS NOT NULL THEN
            RAISE EXCEPTION 'suspended replacement failure cannot overwrite a selected provider result'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'refund_retry_source_reconciliation_check';
        END IF;
        SELECT * INTO source_refund FROM "refund_transactions" source
        WHERE source."id" = target_refund."replaces_refund_transaction_id"
        FOR UPDATE;
        SELECT * INTO source_success FROM "payment_provider_events" event
        WHERE event."id" = target_refund."source_success_provider_event_id";
        IF source_refund."status" IS DISTINCT FROM 'FAILED'
           OR source_success."kind" IS DISTINCT FROM 'REFUND_SUCCEEDED'
           OR source_success."refund_transaction_id" IS DISTINCT FROM source_refund."id" THEN
            RAISE EXCEPTION 'suspended refund has no exact retained source success'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_retry_source_reconciliation_check';
        END IF;
        UPDATE "refund_transactions"
        SET "status" = 'FAILED',
            "provider_refund_id" = refund_provider_id,
            "provider_result_event_id" = receipt_id,
            "updated_at" = result_verified_at
        WHERE "id" = target_refund."id";
        UPDATE "refund_transactions"
        SET "status" = 'SUCCEEDED',
            "provider_result_event_id" = source_success."id",
            "completed_at" = source_success."verified_at",
            "updated_at" = result_verified_at
        WHERE "id" = source_refund."id";
        success_refund_id := source_refund."id";
    ELSIF target_refund."status" = 'SUSPENDED'
          AND refund_kind = 'REFUND_SUCCEEDED' THEN
        UPDATE "refund_transactions"
        SET "provider_refund_id" = refund_provider_id,
            "provider_result_event_id" = receipt_id,
            "updated_at" = result_verified_at
        WHERE "id" = target_refund."id";
        incident_code := 'REFUND_DOUBLE_SUCCESS';
    ELSE
        RAISE EXCEPTION 'refund attempt cannot accept this provider outcome'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_result_status_check';
    END IF;

    SELECT coalesce(sum(refund."amount_minor") FILTER (
               WHERE refund."status" = 'SUCCEEDED'
           ), 0),
           count(*) FILTER (
               WHERE refund."status" IN ('PENDING', 'SUSPENDED')
           )
    INTO succeeded_total, pending_count
    FROM "refund_transactions" refund
    WHERE refund."payment_id" = target_payment."id";

    UPDATE "payments" payment
    SET "status" = CASE
            WHEN pending_count > 0 THEN 'REFUND_PENDING'::"payment_status"
            WHEN succeeded_total = target_payment."captured_amount_minor"
                THEN 'REFUNDED'::"payment_status"
            WHEN succeeded_total > 0 THEN 'PARTIALLY_REFUNDED'::"payment_status"
            ELSE 'CAPTURED'::"payment_status"
        END,
        "updated_at" = result_verified_at
    WHERE payment."id" = target_payment."id";

    RETURN NEXT;
END;
$$;

-- Preserve the historical SQL entry point while moving actual provider work
-- onto the same applicator used by operator reconciliation.
CREATE OR REPLACE FUNCTION taven_apply_checkout_refund_success(
    target_refund_id uuid,
    refund_provider_id text,
    refund_event_id text,
    refund_occurred_at timestamptz,
    refund_evidence jsonb
)
RETURNS boolean
LANGUAGE sql
AS $$
    SELECT result.recorded
    FROM taven_apply_refund_provider_result(
        target_refund_id, refund_provider_id, refund_event_id,
        'REFUND_SUCCEEDED'::"payment_provider_event_kind",
        refund_occurred_at, refund_evidence
    ) result;
$$;
