-- ADR0028 / #258: a captured, cancelled checkout may never have received its
-- provider intent response. Preserve that absence while allowing the normal
-- aggregate refund states, but only when the immutable capture/root evidence
-- exists. Historical migrations and financial history stay untouched.

ALTER TABLE "payments"
  DROP CONSTRAINT "payments_provider_intent_identity_check";
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_provider_intent_identity_check" CHECK (
      ("provider_intent_id" IS NOT NULL
       AND "provider_intent_id" ~ '[^[:space:]]'
       AND "status" <> 'CREATED')
      OR ("provider_intent_id" IS NULL
          AND "status" IN ('CREATED', 'FAILED', 'VOIDED'))
      OR ("provider_intent_id" IS NULL
          AND "status" IN ('REFUND_PENDING', 'CAPTURED', 'REFUNDED')
          AND "provider_capture_id" IS NOT NULL
          AND "provider_capture_id" ~ '[^[:space:]]'
          AND "captured_amount_minor" > 0
          AND "captured_at" IS NOT NULL
          AND NOT "capture_authorized"
          AND "capture_cutoff_at" IS NOT NULL
          AND "captured_at" >= "capture_cutoff_at")
  );

CREATE FUNCTION taven_null_intent_compensation_evidence_matches(
    target_payment_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "payments" payment
        WHERE payment."id" = target_payment_id
          AND payment."provider_intent_id" IS NULL
          AND payment."status" IN ('REFUND_PENDING', 'CAPTURED', 'REFUNDED')
          AND payment."provider_capture_id" ~ '[^[:space:]]'
          AND payment."captured_amount_minor" > 0
          AND payment."captured_at" >= payment."capture_cutoff_at"
          AND NOT payment."capture_authorized"
          AND EXISTS (
              SELECT 1
              FROM "payment_provider_events" capture
              WHERE capture."payment_id" = payment."id"
                AND capture."refund_transaction_id" IS NULL
                AND capture."kind" = 'PAYMENT_CAPTURED'
                AND capture."provider" = payment."provider"
                AND capture."provider_transaction_id" =
                    payment."provider_capture_id"
                AND capture."amount_minor" =
                    payment."captured_amount_minor"
                AND capture."currency" = payment."currency"
                AND capture."verified_at" = payment."captured_at"
          )
          AND (
              SELECT count(*)
              FROM "refund_transactions" root
              WHERE root."payment_id" = payment."id"
                AND root."replaces_refund_transaction_id" IS NULL
                AND root."reason" = 'LATE_CAPTURE_COMPENSATION'
                AND root."provider" = payment."provider"
                AND root."amount_minor" = payment."captured_amount_minor"
                AND root."claim_id" IS NULL
                AND root."price_adjustment_id" IS NULL
          ) = 1
          AND NOT EXISTS (
              SELECT 1
              FROM "refund_transactions" refund
              WHERE refund."payment_id" = payment."id"
                AND NOT (
                    refund."reason" = 'LATE_CAPTURE_COMPENSATION'
                    AND refund."provider" = payment."provider"
                    AND refund."amount_minor" = payment."captured_amount_minor"
                    AND refund."claim_id" IS NULL
                    AND refund."price_adjustment_id" IS NULL
                    AND (
                        refund."replaces_refund_transaction_id" IS NULL
                        OR EXISTS (
                            SELECT 1 FROM "refund_transactions" root
                            WHERE root."id" =
                                refund."replaces_refund_transaction_id"
                              AND root."payment_id" = payment."id"
                              AND root."replaces_refund_transaction_id" IS NULL
                              AND root."reason" = 'LATE_CAPTURE_COMPENSATION'
                        )
                    )
                )
          )
          AND EXISTS (
              SELECT 1
              FROM "refund_transactions" root
              JOIN "outbox_messages" command
                ON command."deduplication_key" =
                    'refund_payment:v1:' || root."id"::text
              WHERE root."payment_id" = payment."id"
                AND root."replaces_refund_transaction_id" IS NULL
                AND root."reason" = 'LATE_CAPTURE_COMPENSATION'
                AND root."amount_minor" = payment."captured_amount_minor"
                AND command."aggregate_type" = 'RefundTransaction'
                AND command."aggregate_id" = root."id"
                AND command."message_type" = 'refund_payment'
                AND command."schema_version" = 1
                AND command."payload" ->> 'refundTransactionId' = root."id"::text
                AND command."payload" ->> 'paymentId' = payment."id"::text
                AND command."payload" ->> 'provider' = payment."provider"
                AND command."payload" ->> 'providerIntentId' =
                    payment."provider_capture_id"
                AND command."payload" ->> 'amountMinor' =
                    payment."captured_amount_minor"::text
                AND command."payload" ->> 'currency' = payment."currency"
                AND command."payload" ->> 'idempotencyKey' =
                    root."idempotency_key"
                AND command."payload" ->> 'action' = 'refund_payment'
          )
          AND (
              (payment."status" = 'CAPTURED'
               AND EXISTS (
                   SELECT 1 FROM "refund_transactions" failed
                   WHERE failed."payment_id" = payment."id"
                     AND failed."status" = 'FAILED'
                     AND taven_refund_result_event_matches(
                         failed."id", failed."provider_result_event_id",
                         'FAILED'::"refund_status"
                     )
               )
               AND NOT EXISTS (
                   SELECT 1 FROM "refund_transactions" active_or_succeeded
                   WHERE active_or_succeeded."payment_id" = payment."id"
                     AND active_or_succeeded."status" IN
                         ('PENDING', 'SUSPENDED', 'SUCCEEDED')
               ))
              OR (payment."status" = 'REFUNDED'
                  AND EXISTS (
                      SELECT 1 FROM "refund_transactions" succeeded
                      WHERE succeeded."payment_id" = payment."id"
                        AND succeeded."status" = 'SUCCEEDED'
                        AND taven_refund_result_event_matches(
                            succeeded."id",
                            succeeded."provider_result_event_id",
                            'SUCCEEDED'::"refund_status"
                        )
                  )
                  AND (
                      SELECT coalesce(sum(succeeded."amount_minor"), 0)
                      FROM "refund_transactions" succeeded
                      WHERE succeeded."payment_id" = payment."id"
                        AND succeeded."status" = 'SUCCEEDED'
                  ) = payment."captured_amount_minor"
                  AND NOT EXISTS (
                      SELECT 1 FROM "refund_transactions" active
                      WHERE active."payment_id" = payment."id"
                        AND active."status" IN ('PENDING', 'SUSPENDED')
                  ))
              OR (payment."status" = 'REFUND_PENDING'
                  AND EXISTS (
                      SELECT 1 FROM "refund_transactions" active
                      WHERE active."payment_id" = payment."id"
                        AND active."status" IN ('PENDING', 'SUSPENDED')
                  ))
          )
    );
$$;

-- Fail rollout rather than fabricating evidence for retained rows.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "payments" payment
        WHERE payment."provider_intent_id" IS NULL
          AND payment."status" IN ('REFUND_PENDING', 'CAPTURED', 'REFUNDED')
          AND NOT taven_null_intent_compensation_evidence_matches(payment."id")
    ) THEN
        RAISE EXCEPTION 'retained null-intent capture lacks exact compensation evidence'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'payment_null_intent_compensation_check';
    END IF;
END;
$$;

CREATE FUNCTION taven_validate_null_intent_compensation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_payment_id uuid;
    target_payment "payments"%ROWTYPE;
BEGIN
    IF TG_TABLE_NAME = 'payments' THEN
        target_payment_id := NEW."id";
    ELSE
        target_payment_id := NEW."payment_id";
    END IF;
    SELECT * INTO target_payment FROM "payments"
    WHERE "id" = target_payment_id;
    IF FOUND
       AND target_payment."provider_intent_id" IS NULL
       AND target_payment."status" IN ('REFUND_PENDING', 'CAPTURED', 'REFUNDED')
       AND NOT taven_null_intent_compensation_evidence_matches(target_payment_id)
    THEN
        RAISE EXCEPTION 'null-intent capture requires exact authenticated capture and full compensation evidence'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'payment_null_intent_compensation_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_null_intent_compensation_reconciled"
AFTER INSERT OR UPDATE ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_null_intent_compensation();

CREATE CONSTRAINT TRIGGER "refunds_null_intent_compensation_reconciled"
AFTER INSERT OR UPDATE ON "refund_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_null_intent_compensation();

-- The older failed-source guard correctly rejected arbitrary restoration, but
-- also rejected the approved final failure of a full compensation refund.
-- This predicate proves the only permitted exception; the original capture
-- and prior-failure guards still run independently.
CREATE FUNCTION taven_failed_source_compensation_rollback_matches(
    target_payment_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM "payments" payment
        WHERE payment."id" = target_payment_id
          AND payment."status" = 'REFUND_PENDING'
          AND payment."provider_intent_id" ~ '[^[:space:]]'
          AND payment."provider_capture_id" = payment."provider_intent_id"
          AND payment."captured_amount_minor" > 0
          AND NOT payment."capture_authorized"
          AND payment."capture_cutoff_at" IS NOT NULL
          AND payment."captured_at" >= payment."capture_cutoff_at"
          AND EXISTS (
              SELECT 1 FROM "payment_provider_events" failure
              WHERE failure."payment_id" = payment."id"
                AND failure."refund_transaction_id" IS NULL
                AND failure."provider" = payment."provider"
                AND failure."kind" = 'PAYMENT_FAILED'
                AND failure."provider_transaction_id" =
                    payment."provider_intent_id"
                AND failure."amount_minor" = payment."requested_amount_minor"
                AND failure."currency" = payment."currency"
                AND failure."verified_at" = payment."capture_cutoff_at"
          )
          AND EXISTS (
              SELECT 1 FROM "payment_provider_events" capture
              WHERE capture."payment_id" = payment."id"
                AND capture."refund_transaction_id" IS NULL
                AND capture."provider" = payment."provider"
                AND capture."kind" = 'PAYMENT_CAPTURED'
                AND capture."provider_transaction_id" =
                    payment."provider_capture_id"
                AND capture."amount_minor" = payment."captured_amount_minor"
                AND capture."currency" = payment."currency"
                AND capture."verified_at" = payment."captured_at"
          )
          AND (
              SELECT count(*) FROM "refund_transactions" root
              WHERE root."payment_id" = payment."id"
                AND root."replaces_refund_transaction_id" IS NULL
                AND root."reason" = 'LATE_CAPTURE_COMPENSATION'
                AND root."provider" = payment."provider"
                AND root."amount_minor" = payment."captured_amount_minor"
                AND root."claim_id" IS NULL
                AND root."price_adjustment_id" IS NULL
          ) = 1
          AND NOT EXISTS (
              SELECT 1 FROM "refund_transactions" refund
              WHERE refund."payment_id" = payment."id"
                AND NOT (
                    refund."reason" = 'LATE_CAPTURE_COMPENSATION'
                    AND refund."provider" = payment."provider"
                    AND refund."amount_minor" = payment."captured_amount_minor"
                    AND refund."claim_id" IS NULL
                    AND refund."price_adjustment_id" IS NULL
                    AND (
                        refund."replaces_refund_transaction_id" IS NULL
                        OR EXISTS (
                            SELECT 1 FROM "refund_transactions" root
                            WHERE root."id" =
                                refund."replaces_refund_transaction_id"
                              AND root."payment_id" = payment."id"
                              AND root."replaces_refund_transaction_id" IS NULL
                              AND root."reason" = 'LATE_CAPTURE_COMPENSATION'
                        )
                    )
                )
          )
          AND EXISTS (
              SELECT 1 FROM "refund_transactions" root
              JOIN "outbox_messages" command
                ON command."deduplication_key" =
                    'refund_payment:v1:' || root."id"::text
              WHERE root."payment_id" = payment."id"
                AND root."replaces_refund_transaction_id" IS NULL
                AND root."reason" = 'LATE_CAPTURE_COMPENSATION'
                AND root."amount_minor" = payment."captured_amount_minor"
                AND command."aggregate_type" = 'RefundTransaction'
                AND command."aggregate_id" = root."id"
                AND command."message_type" = 'refund_payment'
                AND command."schema_version" = 1
                AND command."payload" ->> 'refundTransactionId' = root."id"::text
                AND command."payload" ->> 'paymentId' = payment."id"::text
                AND command."payload" ->> 'provider' = payment."provider"
                AND command."payload" ->> 'providerIntentId' =
                    payment."provider_capture_id"
                AND command."payload" ->> 'amountMinor' =
                    payment."captured_amount_minor"::text
                AND command."payload" ->> 'currency' = payment."currency"
                AND command."payload" ->> 'idempotencyKey' =
                    root."idempotency_key"
                AND command."payload" ->> 'action' = 'refund_payment'
          )
          AND EXISTS (
              SELECT 1 FROM "refund_transactions" refund
              WHERE refund."payment_id" = payment."id"
                AND refund."reason" = 'LATE_CAPTURE_COMPENSATION'
                AND refund."amount_minor" = payment."captured_amount_minor"
                AND refund."status" = 'FAILED'
                AND taven_refund_result_event_matches(
                    refund."id", refund."provider_result_event_id",
                    'FAILED'::"refund_status"
                )
          )
          AND NOT EXISTS (
              SELECT 1 FROM "refund_transactions" refund
              WHERE refund."payment_id" = payment."id"
                AND refund."status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED')
          )
    );
$$;
CREATE OR REPLACE FUNCTION taven_protect_payment_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'payment transactions are append-only financial history'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_identity_immutable_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'CREATED' AND NEW."status" IN ('PENDING', 'FAILED', 'VOIDED'))
           OR (OLD."status" = 'PENDING' AND NEW."status" IN ('CAPTURED', 'FAILED', 'VOIDED', 'REFUND_PENDING'))
           OR (OLD."status" = 'FAILED' AND NEW."status" = 'REFUND_PENDING')
           OR (OLD."status" = 'CAPTURED' AND NEW."status" = 'REFUND_PENDING')
           OR (OLD."status" = 'VOIDED' AND NEW."status" = 'REFUND_PENDING')
           OR (OLD."status" = 'REFUND_PENDING' AND NEW."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'))
           OR (OLD."status" = 'PARTIALLY_REFUNDED' AND NEW."status" IN ('REFUND_PENDING', 'REFUNDED'))
           OR (OLD."status" = 'PARTIALLY_REFUNDED'
               AND NEW."status" = 'CAPTURED'
               AND taven_payment_has_newer_refund_failure(NEW."id"))
           OR (OLD."status" = 'REFUNDED'
               AND NEW."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING')
               AND taven_payment_has_newer_refund_failure(NEW."id"))
       ) THEN
        RAISE EXCEPTION 'payment status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_status_transition_check';
    END IF;

    IF OLD."provider_intent_id" IS NULL
       AND NEW."provider_intent_id" IS NOT NULL
       AND NOT (OLD."status" = 'CREATED' AND NEW."status" = 'PENDING') THEN
        RAISE EXCEPTION 'provider intent may be assigned only as a payment becomes pending'
            USING ERRCODE = '23514', CONSTRAINT = 'payments_provider_intent_identity_check';
    END IF;

    IF NEW."intent_creation_failure_result_id" IS DISTINCT FROM
          OLD."intent_creation_failure_result_id"
       AND NOT (
           OLD."intent_creation_failure_result_id" IS NULL
           AND NEW."intent_creation_failure_result_id" IS NOT NULL
           AND OLD."status" = 'CREATED'
           AND NEW."status" = 'FAILED'
       ) THEN
        RAISE EXCEPTION 'intent creation failure result may be assigned only as a created Payment fails'
            USING ERRCODE = '23514', CONSTRAINT = 'payments_intent_creation_failure_identity_check';
    END IF;

    IF OLD."status" IN ('PENDING', 'REFUND_PENDING')
       AND NEW."status" = 'CAPTURED' THEN
        PERFORM taven_lock_automatic_order_session(NEW."order_id");

        PERFORM 1
        FROM "orders"
        WHERE "id" = NEW."order_id"
        FOR UPDATE;

        IF OLD."status" = 'PENDING'
           AND (NOT NEW."capture_authorized"
           OR NEW."capture_cutoff_at" IS NOT NULL
           OR (NEW."role" IN ('FULL', 'DEPOSIT') AND (
               NEW."checkout_capture_expires_at" IS NULL
               OR NEW."checkout_capture_expires_at" <= clock_timestamp()
           ))
           OR (NEW."role" = 'BALANCE' AND (
               NEW."checkout_capture_expires_at" IS NOT NULL
               OR NEW."balance_due_at" IS NULL
               OR NEW."balance_due_at" <= clock_timestamp()
               OR NOT EXISTS (
                   SELECT 1
                   FROM "orders" target_order
                   WHERE target_order."id" = NEW."order_id"
                     AND target_order."status" IN ('AWAITING_BALANCE', 'READY_TO_SHIP')
                     AND NOT EXISTS (
                         SELECT 1 FROM "order_settlements" settlement
                         WHERE settlement."order_id" = target_order."id"
                     )
               )
           ))) THEN
            RAISE EXCEPTION 'ordinary payment capture requires an open authorization window'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
        END IF;
    END IF;

    IF NEW."capture_authorized" IS DISTINCT FROM (NEW."capture_cutoff_at" IS NULL) THEN
        RAISE EXCEPTION 'payment capture authorization and cutoff must change atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
    END IF;

    IF NEW."capture_cutoff_at" IS DISTINCT FROM OLD."capture_cutoff_at"
       AND NEW."capture_cutoff_at" IS NOT NULL
       AND NEW."capture_cutoff_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'payment capture cutoff evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_cutoff_evidence_check';
    END IF;

    IF NEW."status" IN ('FAILED', 'VOIDED')
       AND (NEW."capture_authorized" OR NEW."capture_cutoff_at" IS NULL) THEN
        RAISE EXCEPTION 'failed or voided payment requires a closed authorization window'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
    END IF;

    IF OLD."status" = 'FAILED'
       AND NEW."status" = 'REFUND_PENDING'
       AND (
           NEW."provider_intent_id" IS NULL
           OR NEW."provider_intent_id" !~ '[^[:space:]]'
           OR NEW."capture_authorized"
           OR NEW."capture_cutoff_at" IS NULL
           OR NEW."captured_at" IS NULL
           OR NEW."captured_at" < NEW."capture_cutoff_at"
           OR NOT EXISTS (
               SELECT 1
               FROM "payment_provider_events" event
               WHERE event."payment_id" = NEW."id"
                 AND event."refund_transaction_id" IS NULL
                 AND event."provider" = NEW."provider"
                 AND event."kind" = 'PAYMENT_FAILED'
                 AND event."provider_transaction_id" = NEW."provider_intent_id"
                 AND event."amount_minor" = NEW."requested_amount_minor"
                 AND event."currency" = NEW."currency"
                 AND event."verified_at" = NEW."capture_cutoff_at"
           )
       ) THEN
        RAISE EXCEPTION 'failed Payment may reopen only for a verified capture after its closed authorization cutoff'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_failed_late_capture_check';
    END IF;

    IF OLD."status" = 'PENDING'
       AND NEW."status" = 'REFUND_PENDING'
       AND EXISTS (
           SELECT 1
           FROM "payment_provider_events" event
           WHERE event."payment_id" = NEW."id"
             AND event."refund_transaction_id" IS NULL
             AND event."provider" = NEW."provider"
             AND event."kind" = 'PAYMENT_FAILED'
             AND event."provider_transaction_id" = NEW."provider_intent_id"
             AND event."amount_minor" = NEW."requested_amount_minor"
             AND event."currency" = NEW."currency"
             AND event."verified_at" = NEW."capture_cutoff_at"
       ) THEN
        RAISE EXCEPTION 'a provider-failed Payment must record failure before late-capture compensation'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_failed_late_capture_source_check';
    END IF;

    IF OLD."status" = 'REFUND_PENDING'
       AND NEW."status" = 'CAPTURED'
       AND EXISTS (
           SELECT 1 FROM "refund_transactions" refund
           WHERE refund."payment_id" = NEW."id"
             AND refund."reason" = 'LATE_CAPTURE_COMPENSATION'
       )
       AND EXISTS (
           SELECT 1 FROM "payment_provider_events" event
           WHERE event."payment_id" = NEW."id"
             AND event."refund_transaction_id" IS NULL
             AND event."provider" = NEW."provider"
             AND event."kind" = 'PAYMENT_FAILED'
             AND event."provider_transaction_id" = NEW."provider_intent_id"
             AND event."amount_minor" = NEW."requested_amount_minor"
             AND event."currency" = NEW."currency"
             AND event."verified_at" = NEW."capture_cutoff_at"
       )
       AND NOT taven_failed_source_compensation_rollback_matches(NEW."id")
    THEN
        RAISE EXCEPTION 'failed-source late capture requires exact final compensation failure before restoration'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_failed_late_capture_refund_retry_check';
    END IF;

    IF OLD."status" IN ('REFUNDED', 'PARTIALLY_REFUNDED')
       AND NEW."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED')
       AND EXISTS (
           SELECT 1
           FROM "refund_transactions" refund
           WHERE refund."payment_id" = NEW."id"
             AND refund."reason" = 'LATE_CAPTURE_COMPENSATION'
             AND refund."status" = 'FAILED'
             AND taven_refund_result_event_matches(
                 refund."id", refund."provider_result_event_id",
                 'FAILED'::"refund_status"
             )
       ) THEN
        RAISE EXCEPTION 'reversed late-capture compensation must atomically retain pending retry work'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_late_capture_refund_reversal_retry_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."price_snapshot_id" IS DISTINCT FROM OLD."price_snapshot_id"
       OR NEW."order_price_binding_id" IS DISTINCT FROM OLD."order_price_binding_id"
       OR NEW."payment_schedule_id" IS DISTINCT FROM OLD."payment_schedule_id"
       OR NEW."role" IS DISTINCT FROM OLD."role"
       OR NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."requested_amount_minor" IS DISTINCT FROM OLD."requested_amount_minor"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."checkout_capture_expires_at" IS DISTINCT FROM OLD."checkout_capture_expires_at"
       OR NEW."balance_due_at" IS DISTINCT FROM OLD."balance_due_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR (
           OLD."captured_amount_minor" IS NOT NULL
           AND NEW."captured_amount_minor" IS DISTINCT FROM OLD."captured_amount_minor"
       )
       OR (
           OLD."captured_at" IS NOT NULL
           AND NEW."captured_at" IS DISTINCT FROM OLD."captured_at"
       )
       OR (
           NOT OLD."capture_authorized"
           AND NEW."capture_authorized"
       )
       OR (
           OLD."capture_cutoff_at" IS NOT NULL
           AND NEW."capture_cutoff_at" IS DISTINCT FROM OLD."capture_cutoff_at"
       )
       OR (
           OLD."provider_intent_id" IS NOT NULL
           AND NEW."provider_intent_id" IS DISTINCT FROM OLD."provider_intent_id"
       )
       OR (
           OLD."provider_capture_id" IS NOT NULL
           AND NEW."provider_capture_id" IS DISTINCT FROM OLD."provider_capture_id"
       ) THEN
        RAISE EXCEPTION 'payment financial identity is immutable after assignment'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_identity_immutable_check';
    END IF;

    IF NEW."captured_at" IS NOT NULL
       AND NEW."captured_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'payment capture evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_evidence_check';
    END IF;

    IF OLD."captured_amount_minor" IS NULL
       AND NEW."status" IN ('CAPTURED', 'REFUND_PENDING')
       AND NEW."captured_amount_minor" IS NOT NULL
       AND NEW."captured_amount_minor" > 0
       AND NEW."captured_amount_minor" <= NEW."requested_amount_minor"
       AND NEW."provider_capture_id" IS NOT NULL
       AND NEW."provider_capture_id" ~ '[^[:space:]]'
       AND NEW."captured_at" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "payment_provider_events" event
           WHERE event."payment_id" = NEW."id"
             AND event."refund_transaction_id" IS NULL
             AND event."provider" = NEW."provider"
             AND event."kind" = 'PAYMENT_CAPTURED'
             AND event."provider_transaction_id" = NEW."provider_capture_id"
             AND event."amount_minor" = NEW."captured_amount_minor"
             AND event."currency" = NEW."currency"
             AND event."verified_at" = NEW."captured_at"
       ) THEN
        RAISE EXCEPTION 'payment capture requires its exact verified provider event receipt'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_provider_receipt_check';
    END IF;

    IF OLD."status" = 'PENDING'
       AND NEW."status" = 'FAILED'
       AND NOT EXISTS (
           SELECT 1
           FROM "payment_provider_events" event
           WHERE event."payment_id" = NEW."id"
             AND event."refund_transaction_id" IS NULL
             AND event."provider" = NEW."provider"
             AND event."kind" = 'PAYMENT_FAILED'
             AND event."provider_transaction_id" = NEW."provider_intent_id"
             AND event."amount_minor" = NEW."requested_amount_minor"
             AND event."currency" = NEW."currency"
             AND event."verified_at" = NEW."capture_cutoff_at"
       ) THEN
        RAISE EXCEPTION 'payment failure requires its exact verified provider event receipt'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_failure_provider_receipt_check';
    END IF;

    IF OLD."status" = 'CREATED'
       AND NEW."status" = 'FAILED'
       AND NOT EXISTS (
           SELECT 1
           FROM "payment_intent_creation_failures" failure
           WHERE failure."id" = NEW."intent_creation_failure_result_id"
             AND failure."payment_id" = NEW."id"
             AND failure."provider" = NEW."provider"
             AND failure."outcome" = 'FAILED'
             AND failure."provider_intent_id" IS NULL
             AND failure."failed_at" = NEW."capture_cutoff_at"
       ) THEN
        RAISE EXCEPTION 'created Payment failure requires its exact immutable provider attempt failure'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_intent_creation_failure_evidence_check';
    END IF;

    IF OLD."status" = 'PENDING' AND NEW."status" = 'VOIDED' THEN
        INSERT INTO "outbox_messages" (
            "id", "deduplication_key", "aggregate_type", "aggregate_id",
            "message_type", "schema_version", "payload", "status", "attempts",
            "available_at", "created_at", "updated_at"
        ) VALUES (
            gen_random_uuid(),
            'void_payment:v1:' || NEW."id"::text,
            'Payment',
            NEW."id",
            'void_payment',
            1,
            jsonb_build_object(
                'paymentId', NEW."id"::text,
                'provider', NEW."provider",
                'providerIntentId', NEW."provider_intent_id",
                'action', 'void_payment'
            ),
            'PENDING',
            0,
            evidence_now,
            evidence_now,
            evidence_now
        )
        ON CONFLICT ("deduplication_key") DO NOTHING;

        IF NOT EXISTS (
            SELECT 1
            FROM "outbox_messages" message
            WHERE message."deduplication_key" =
                  'void_payment:v1:' || NEW."id"::text
              AND message."aggregate_type" = 'Payment'
              AND message."aggregate_id" = NEW."id"
              AND message."message_type" = 'void_payment'
              AND message."schema_version" = 1
              AND message."status" = 'PENDING'
              AND message."attempts" = 0
              AND message."payload" = jsonb_build_object(
                  'paymentId', NEW."id"::text,
                  'provider', NEW."provider",
                  'providerIntentId', NEW."provider_intent_id",
                  'action', 'void_payment'
              )
        ) THEN
            RAISE EXCEPTION 'pending payment void requires its exact durable provider command'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_void_outbox_check';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
