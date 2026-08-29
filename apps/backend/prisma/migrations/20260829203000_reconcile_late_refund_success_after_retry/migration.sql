-- Retain authenticated late refund successes after retry work has been created.
-- A retry that has not been dispatch-claimed is superseded atomically. A retry
-- whose dispatch already won the row lock is suspended for explicit financial
-- reconciliation; the provider receipt remains immutable audit evidence.

ALTER TABLE "refund_transactions"
    ADD COLUMN "dispatch_claimed_at" TIMESTAMPTZ(3),
    ADD COLUMN "source_success_provider_event_id" UUID,
    ADD COLUMN "reconciliation_started_at" TIMESTAMPTZ(3);

ALTER TABLE "refund_transactions"
    ADD CONSTRAINT "refund_transactions_source_success_event_scope_key"
        UNIQUE (
            "source_success_provider_event_id",
            "replaces_refund_transaction_id"
        ),
    ADD CONSTRAINT "refund_transactions_source_success_event_scope_fkey"
        FOREIGN KEY (
            "source_success_provider_event_id",
            "replaces_refund_transaction_id"
        )
        REFERENCES "payment_provider_events"("id", "refund_transaction_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "refund_transactions_dispatch_claim_check" CHECK (
        "dispatch_claimed_at" IS NULL
        OR "dispatch_claimed_at" >= "requested_at" - interval '5 seconds'
    ),
    ADD CONSTRAINT "refund_transactions_source_reconciliation_check" CHECK (
        (
            "status" IN ('SUPERSEDED', 'SUSPENDED')
            AND "replaces_refund_transaction_id" IS NOT NULL
            AND "replaces_failure_provider_event_id" IS NOT NULL
            AND "source_success_provider_event_id" IS NOT NULL
            AND "reconciliation_started_at" IS NOT NULL
            AND "completed_at" IS NULL
            AND (
                ("status" = 'SUPERSEDED'
                    AND "dispatch_claimed_at" IS NULL
                    AND "provider_result_event_id" IS NULL)
                OR ("status" = 'SUSPENDED' AND "dispatch_claimed_at" IS NOT NULL)
            )
        )
        OR (
            "status" = 'FAILED'
            AND "replaces_refund_transaction_id" IS NOT NULL
            AND "replaces_failure_provider_event_id" IS NOT NULL
            AND "dispatch_claimed_at" IS NOT NULL
            AND "source_success_provider_event_id" IS NOT NULL
            AND "reconciliation_started_at" IS NOT NULL
            AND "provider_result_event_id" IS NOT NULL
            AND "completed_at" IS NULL
        )
        OR (
            "status" NOT IN ('SUPERSEDED', 'SUSPENDED')
            AND "source_success_provider_event_id" IS NULL
            AND "reconciliation_started_at" IS NULL
        )
    );

CREATE TABLE "refund_dispatch_claims" (
    "refund_transaction_id" UUID NOT NULL,
    "claimed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "refund_dispatch_claims_pkey"
        PRIMARY KEY ("refund_transaction_id"),
    CONSTRAINT "refund_dispatch_claims_refund_transaction_id_fkey"
        FOREIGN KEY ("refund_transaction_id")
        REFERENCES "refund_transactions"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "refund_transactions"
    DROP CONSTRAINT "refund_transactions_terminal_result_event_check";
ALTER TABLE "refund_transactions"
    ADD CONSTRAINT "refund_transactions_terminal_result_event_check" CHECK (
        ("status" IN ('PENDING', 'SUPERSEDED')
            AND "provider_result_event_id" IS NULL)
        OR "status" = 'SUSPENDED'
        OR ("status" IN ('SUCCEEDED', 'FAILED')
            AND "provider_result_event_id" IS NOT NULL)
    );

CREATE FUNCTION taven_lock_refund_provider_event_retries()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    IF NEW."kind" NOT IN ('REFUND_SUCCEEDED', 'REFUND_FAILED') THEN
        RETURN NEW;
    END IF;

    SELECT payment."order_id"
    INTO target_order_id
    FROM "payments" payment
    WHERE payment."id" = NEW."payment_id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    PERFORM taven_lock_automatic_order_session(target_order_id);

    PERFORM 1
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    PERFORM 1
    FROM "order_phases" phase
    WHERE phase."order_id" = target_order_id
    ORDER BY phase."id"
    FOR UPDATE;

    -- Provider receipts, source attempts, and replacement work share one
    -- canonical refund-row lock order. A dispatcher must take the same row
    -- lock before assigning dispatch_claimed_at and making its first call.
    PERFORM 1
    FROM "refund_transactions" refund
    WHERE refund."payment_id" = NEW."payment_id"
    ORDER BY refund."id"
    FOR UPDATE;

    PERFORM 1
    FROM "payments" payment
    WHERE payment."id" = NEW."payment_id"
    FOR UPDATE;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_provider_events_refund_retries_locked"
BEFORE INSERT ON "payment_provider_events"
FOR EACH ROW EXECUTE FUNCTION taven_lock_refund_provider_event_retries();

CREATE FUNCTION taven_prepare_refund_dispatch_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_payment_id uuid;
    target_order_id uuid;
    target_status "refund_status";
    target_dispatch_claimed_at timestamptz;
    target_provider_result_event_id uuid;
    target_source_success_provider_event_id uuid;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION 'refund dispatch claims are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_dispatch_claim_identity_immutable_check';
    END IF;

    -- Read only immutable identities before taking the canonical lock set.
    -- INSERT has not acquired an existing refund row, so the claim can lock
    -- the complete order envelope before touching its target attempt.
    SELECT refund."payment_id", payment."order_id"
    INTO target_payment_id, target_order_id
    FROM "refund_transactions" refund
    JOIN "payments" payment ON payment."id" = refund."payment_id"
    WHERE refund."id" = NEW."refund_transaction_id";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'refund dispatch claim target does not exist'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_dispatch_claim_scope_check';
    END IF;

    PERFORM taven_lock_automatic_order_session(target_order_id);

    PERFORM 1
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    PERFORM 1
    FROM "order_phases" phase
    WHERE phase."order_id" = target_order_id
    ORDER BY phase."id"
    FOR UPDATE;

    PERFORM 1
    FROM "refund_transactions" refund
    WHERE refund."payment_id" = target_payment_id
    ORDER BY refund."id"
    FOR UPDATE;

    PERFORM 1
    FROM "payments" payment
    WHERE payment."id" = target_payment_id
    FOR UPDATE;

    -- Re-read through a locking query after the canonical lock wait so a
    -- receipt that won first deterministically makes this claim a no-op.
    SELECT refund."status", refund."dispatch_claimed_at",
           refund."provider_result_event_id",
           refund."source_success_provider_event_id"
    INTO target_status, target_dispatch_claimed_at,
         target_provider_result_event_id,
         target_source_success_provider_event_id
    FROM "refund_transactions" refund
    WHERE refund."id" = NEW."refund_transaction_id"
      AND refund."payment_id" = target_payment_id
    FOR UPDATE;

    IF target_status IS DISTINCT FROM 'PENDING'::"refund_status"
       OR target_dispatch_claimed_at IS NOT NULL
       OR target_provider_result_event_id IS NOT NULL
       OR target_source_success_provider_event_id IS NOT NULL THEN
        RETURN NULL;
    END IF;

    NEW."claimed_at" := clock_timestamp();
    NEW."created_at" := NEW."claimed_at";
    RETURN NEW;
END;
$$;

CREATE TRIGGER "refund_dispatch_claims_prepared"
BEFORE INSERT OR UPDATE OR DELETE ON "refund_dispatch_claims"
FOR EACH ROW EXECUTE FUNCTION taven_prepare_refund_dispatch_claim();

CREATE FUNCTION taven_apply_refund_dispatch_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE "refund_transactions"
    SET "dispatch_claimed_at" = NEW."claimed_at",
        "updated_at" = NEW."claimed_at"
    WHERE "id" = NEW."refund_transaction_id"
      AND "status" = 'PENDING'
      AND "dispatch_claimed_at" IS NULL
      AND "provider_result_event_id" IS NULL
      AND "source_success_provider_event_id" IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'refund dispatch claim lost its canonically locked target'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_dispatch_claim_apply_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE TRIGGER "refund_dispatch_claims_applied"
AFTER INSERT ON "refund_dispatch_claims"
FOR EACH ROW EXECUTE FUNCTION taven_apply_refund_dispatch_claim();

CREATE FUNCTION taven_claim_refund_dispatch(target_refund_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
AS $$
DECLARE
    result_claimed_at timestamptz;
BEGIN
    INSERT INTO "refund_dispatch_claims" ("refund_transaction_id")
    VALUES (target_refund_id)
    ON CONFLICT ("refund_transaction_id") DO NOTHING
    RETURNING "claimed_at" INTO result_claimed_at;

    RETURN result_claimed_at;
END;
$$;

CREATE OR REPLACE FUNCTION taven_protect_refund_transaction_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    selected_kind "payment_provider_event_kind";
    selected_occurred_at timestamptz;
    selected_verified_at timestamptz;
    source_success_verified_at timestamptz;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" IS DISTINCT FROM 'PENDING'::"refund_status"
           OR NEW."provider_result_event_id" IS NOT NULL
           OR NEW."dispatch_claimed_at" IS NOT NULL
           OR NEW."source_success_provider_event_id" IS NOT NULL
           OR NEW."reconciliation_started_at" IS NOT NULL THEN
            RAISE EXCEPTION 'new refund transactions must begin pending and undispatched'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_transaction_initial_status_check';
        END IF;

        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'refund transactions are append-only financial history'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_transaction_append_only_check';
    END IF;

    IF NEW."dispatch_claimed_at" IS DISTINCT FROM OLD."dispatch_claimed_at"
       AND NOT (
           OLD."dispatch_claimed_at" IS NULL
           AND NEW."dispatch_claimed_at" IS NOT NULL
           AND EXISTS (
               SELECT 1
               FROM "refund_dispatch_claims" claim
               WHERE claim."refund_transaction_id" = OLD."id"
                 AND claim."claimed_at" = NEW."dispatch_claimed_at"
           )
       ) THEN
        RAISE EXCEPTION 'refund dispatch requires its exact immutable canonical claim'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_dispatch_claim_protocol_check';
    END IF;

    IF NEW."dispatch_claimed_at" IS DISTINCT FROM OLD."dispatch_claimed_at"
       AND NOT (
           OLD."dispatch_claimed_at" IS NULL
           AND NEW."dispatch_claimed_at" IS NOT NULL
           AND OLD."status" = 'PENDING'
           AND NEW."status" = 'PENDING'
           AND NEW."provider_result_event_id" IS NULL
           AND NEW."source_success_provider_event_id" IS NULL
           AND NEW."dispatch_claimed_at" <= clock_timestamp() + interval '5 seconds'
       ) THEN
        RAISE EXCEPTION 'refund dispatch may be claimed exactly once while pending'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_dispatch_claim_check';
    END IF;

    IF OLD."status" = 'SUSPENDED'
       AND OLD."provider_refund_id" IS NULL
       AND NEW."provider_refund_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "payment_provider_events" retry_event
           JOIN "payments" payment ON payment."id" = NEW."payment_id"
           WHERE retry_event."payment_id" = NEW."payment_id"
             AND retry_event."refund_transaction_id" = NEW."id"
             AND retry_event."provider" = NEW."provider"
             AND retry_event."provider_transaction_id" =
                 NEW."provider_refund_id"
             AND retry_event."amount_minor" = NEW."amount_minor"
             AND retry_event."currency" = payment."currency"
             AND retry_event."kind" IN ('REFUND_SUCCEEDED', 'REFUND_FAILED')
       ) THEN
        RAISE EXCEPTION 'suspended refund provider identity requires its exact retained outcome receipt'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_suspended_provider_identity_check';
    END IF;

    IF OLD."status" = 'SUSPENDED'
       AND NEW."status" = 'SUSPENDED'
       AND NEW."provider_result_event_id" IS DISTINCT FROM
           OLD."provider_result_event_id" THEN
        SELECT event."kind", event."occurred_at"
        INTO selected_kind, selected_occurred_at
        FROM "payment_provider_events" event
        JOIN "payments" payment ON payment."id" = NEW."payment_id"
        WHERE event."id" = NEW."provider_result_event_id"
          AND event."payment_id" = NEW."payment_id"
          AND event."refund_transaction_id" = NEW."id"
          AND event."provider" = NEW."provider"
          AND event."provider" = payment."provider"
          AND event."provider_transaction_id" = NEW."provider_refund_id"
          AND event."amount_minor" = NEW."amount_minor"
          AND event."currency" = payment."currency";

        IF NOT FOUND
           OR selected_kind <> 'REFUND_SUCCEEDED'
           OR NEW."completed_at" IS NOT NULL
           OR EXISTS (
               SELECT 1
               FROM "payment_provider_events" other_event
               JOIN "payments" payment ON payment."id" = NEW."payment_id"
               WHERE other_event."id" <> NEW."provider_result_event_id"
                 AND other_event."payment_id" = NEW."payment_id"
                 AND other_event."refund_transaction_id" = NEW."id"
                 AND other_event."provider" = NEW."provider"
                 AND other_event."provider_transaction_id" =
                     NEW."provider_refund_id"
                 AND other_event."amount_minor" = NEW."amount_minor"
                 AND other_event."currency" = payment."currency"
                 AND other_event."occurred_at" >= selected_occurred_at
           ) THEN
            RAISE EXCEPTION 'suspended refund incident must select its latest exact success receipt'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_suspended_provider_outcome_check';
        END IF;
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'PENDING' AND NEW."status" IN (
               'SUCCEEDED', 'FAILED', 'SUPERSEDED', 'SUSPENDED'
           ))
           OR (OLD."status" = 'FAILED' AND NEW."status" = 'SUCCEEDED')
           OR (OLD."status" = 'SUCCEEDED'
               AND NEW."status" IN ('FAILED', 'SUSPENDED'))
           OR (OLD."status" = 'SUSPENDED' AND NEW."status" = 'FAILED')
       ) THEN
        IF OLD."status" = 'FAILED' THEN
            RAISE EXCEPTION 'failed refund transactions may only reconcile a late provider success'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_transaction_failed_immutable_check';
        ELSIF OLD."status" = 'SUCCEEDED' THEN
            RAISE EXCEPTION 'successful refund transactions may only reconcile a newer failure or an exact double-success incident'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_transaction_succeeded_immutable_check';
        ELSE
            RAISE EXCEPTION 'refund status transition is not allowed'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_transaction_status_transition_check';
        END IF;
    END IF;

    IF NEW."status" IS NOT DISTINCT FROM OLD."status"
       AND NEW."provider_result_event_id" IS DISTINCT FROM
           OLD."provider_result_event_id"
       AND OLD."status" <> 'SUSPENDED' THEN
        RAISE EXCEPTION 'selected refund result receipt changes only with its outcome'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_result_event_transition_check';
    END IF;

    IF (OLD."status" = 'PENDING'
        AND NEW."status" IN ('SUPERSEDED', 'SUSPENDED'))
       OR (OLD."status" = 'SUCCEEDED' AND NEW."status" = 'SUSPENDED') THEN
        SELECT success_event."verified_at"
        INTO source_success_verified_at
        FROM "refund_transactions" source_refund
        JOIN "payments" payment ON payment."id" = source_refund."payment_id"
        JOIN "payment_provider_events" failure_event
          ON failure_event."id" = NEW."replaces_failure_provider_event_id"
         AND failure_event."refund_transaction_id" = source_refund."id"
        JOIN "payment_provider_events" success_event
          ON success_event."id" = NEW."source_success_provider_event_id"
         AND success_event."refund_transaction_id" = source_refund."id"
        WHERE source_refund."id" = NEW."replaces_refund_transaction_id"
          AND source_refund."payment_id" = NEW."payment_id"
          AND source_refund."provider" = NEW."provider"
          AND source_refund."amount_minor" = NEW."amount_minor"
          AND source_refund."reason" = NEW."reason"
          AND source_refund."status" = 'FAILED'
          AND source_refund."provider_result_event_id" = failure_event."id"
          AND source_refund."completed_at" IS NULL
          AND failure_event."payment_id" = source_refund."payment_id"
          AND failure_event."provider" = source_refund."provider"
          AND failure_event."kind" = 'REFUND_FAILED'
          AND failure_event."provider_transaction_id" =
              source_refund."provider_refund_id"
          AND failure_event."amount_minor" = source_refund."amount_minor"
          AND failure_event."currency" = payment."currency"
          AND success_event."payment_id" = source_refund."payment_id"
          AND success_event."provider" = source_refund."provider"
          AND success_event."kind" = 'REFUND_SUCCEEDED'
          AND success_event."provider_transaction_id" =
              source_refund."provider_refund_id"
          AND success_event."amount_minor" = source_refund."amount_minor"
          AND success_event."currency" = payment."currency"
          AND success_event."occurred_at" > failure_event."occurred_at";

        IF NOT FOUND
           OR NEW."reconciliation_started_at" IS DISTINCT FROM
              source_success_verified_at
           OR NEW."completed_at" IS NOT NULL
           OR (OLD."status" = 'PENDING'
               AND NEW."provider_result_event_id" IS NOT NULL)
           OR (OLD."status" = 'SUCCEEDED' AND (
               NEW."provider_result_event_id" IS DISTINCT FROM
                   OLD."provider_result_event_id"
               OR NEW."provider_refund_id" IS DISTINCT FROM
                   OLD."provider_refund_id"
               OR OLD."completed_at" IS NULL
               OR NOT taven_refund_result_event_matches(
                   OLD."id", OLD."provider_result_event_id",
                   'SUCCEEDED'::"refund_status"
               )
           ))
           OR (NEW."status" = 'SUPERSEDED' AND (
               NEW."dispatch_claimed_at" IS NOT NULL
               OR NEW."provider_refund_id" IS NOT NULL
               OR EXISTS (
                   SELECT 1
                   FROM "payment_provider_events" retry_event
                   WHERE retry_event."refund_transaction_id" = NEW."id"
               )
           ))
           OR (NEW."status" = 'SUSPENDED'
               AND NEW."dispatch_claimed_at" IS NULL) THEN
            RAISE EXCEPTION 'refund retry reconciliation requires exact source success and dispatch state'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_retry_source_success_check';
        END IF;
    ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
        IF NEW."status" = 'SUCCEEDED'
           AND NEW."completed_at" IS NOT NULL
           AND NEW."completed_at" > clock_timestamp() + interval '5 seconds' THEN
            RAISE EXCEPTION 'refund completion evidence cannot be in the future'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_completion_evidence_check';
        END IF;

        IF (NEW."provider_result_event_id" IS NULL
            OR NEW."provider_result_event_id" IS NOT DISTINCT FROM
               OLD."provider_result_event_id")
           AND NEW."provider_refund_id" IS NOT NULL
           AND NEW."provider_refund_id" ~ '[^[:space:]]' THEN
            SELECT event."id"
            INTO NEW."provider_result_event_id"
            FROM "payment_provider_events" event
            JOIN "payments" payment ON payment."id" = NEW."payment_id"
            WHERE event."payment_id" = NEW."payment_id"
              AND event."refund_transaction_id" = NEW."id"
              AND event."provider" = NEW."provider"
              AND event."provider" = payment."provider"
              AND event."provider_transaction_id" = NEW."provider_refund_id"
              AND event."amount_minor" = NEW."amount_minor"
              AND event."currency" = payment."currency"
              AND event."kind" = CASE NEW."status"
                  WHEN 'SUCCEEDED'::"refund_status"
                      THEN 'REFUND_SUCCEEDED'::"payment_provider_event_kind"
                  WHEN 'FAILED'::"refund_status"
                      THEN 'REFUND_FAILED'::"payment_provider_event_kind"
                  ELSE NULL
              END
            ORDER BY event."occurred_at" DESC, event."id" DESC
            LIMIT 1;
        END IF;

        IF NEW."provider_result_event_id" IS NULL THEN
            IF OLD."status" = 'PENDING'
               AND (
                   NEW."provider_refund_id" IS NULL
                   OR NEW."provider_refund_id" !~ '[^[:space:]]'
               ) THEN
                RETURN NEW;
            END IF;

            IF NEW."status" = 'SUCCEEDED' THEN
                RAISE EXCEPTION 'successful refund requires its selected provider receipt'
                    USING ERRCODE = '23514', CONSTRAINT = 'refund_success_provider_receipt_check';
            ELSE
                RAISE EXCEPTION 'failed refund requires its selected provider receipt'
                    USING ERRCODE = '23514', CONSTRAINT = 'refund_failure_provider_receipt_check';
            END IF;
        END IF;

        SELECT event."kind", event."occurred_at", event."verified_at"
        INTO selected_kind, selected_occurred_at, selected_verified_at
        FROM "payment_provider_events" event
        JOIN "payments" payment ON payment."id" = NEW."payment_id"
        WHERE event."id" = NEW."provider_result_event_id"
          AND event."payment_id" = NEW."payment_id"
          AND event."refund_transaction_id" = NEW."id"
          AND event."provider" = NEW."provider"
          AND event."provider" = payment."provider"
          AND event."provider_transaction_id" = NEW."provider_refund_id"
          AND event."amount_minor" = NEW."amount_minor"
          AND event."currency" = payment."currency";

        IF NOT FOUND
           OR selected_kind IS DISTINCT FROM (CASE NEW."status"
               WHEN 'SUCCEEDED'::"refund_status"
                   THEN 'REFUND_SUCCEEDED'::"payment_provider_event_kind"
               WHEN 'FAILED'::"refund_status"
                   THEN 'REFUND_FAILED'::"payment_provider_event_kind"
               ELSE NULL
           END)
           OR EXISTS (
               SELECT 1
               FROM "payment_provider_events" other_event
               JOIN "payments" payment ON payment."id" = NEW."payment_id"
               WHERE other_event."id" <> NEW."provider_result_event_id"
                 AND other_event."payment_id" = NEW."payment_id"
                 AND other_event."refund_transaction_id" = NEW."id"
                 AND other_event."provider" = NEW."provider"
                 AND other_event."provider_transaction_id" =
                     NEW."provider_refund_id"
                 AND other_event."amount_minor" = NEW."amount_minor"
                 AND other_event."currency" = payment."currency"
                 AND other_event."occurred_at" >= selected_occurred_at
           ) THEN
            RAISE EXCEPTION 'refund outcome must select its strictly latest exact provider receipt'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_result_event_order_check';
        END IF;

        IF NEW."status" = 'SUCCEEDED'
           AND (
               NEW."completed_at" IS NULL
               OR NEW."completed_at" IS DISTINCT FROM selected_verified_at
               OR NEW."completed_at" < NEW."requested_at" - interval '5 seconds'
               OR NEW."completed_at" > clock_timestamp() + interval '5 seconds'
           ) THEN
            RAISE EXCEPTION 'successful refund requires its exact verified provider event receipt'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_success_provider_receipt_check';
        ELSIF NEW."status" = 'FAILED' AND NEW."completed_at" IS NOT NULL THEN
            RAISE EXCEPTION 'failed refund must clear successful completion evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_failure_provider_receipt_check';
        END IF;

        IF OLD."status" IN ('SUCCEEDED', 'FAILED')
           AND NOT taven_refund_result_event_matches(
               OLD."id", OLD."provider_result_event_id", OLD."status"
           ) THEN
            RAISE EXCEPTION 'refund reversal requires its exact prior selected provider receipt'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_prior_result_event_check';
        END IF;
    ELSIF NEW."status" IN ('SUCCEEDED', 'FAILED')
       AND NOT taven_refund_result_event_matches(
           OLD."id", OLD."provider_result_event_id", OLD."status"
       ) THEN
        RAISE EXCEPTION 'terminal refund must retain its exact selected provider receipt'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_result_provider_receipt_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
       OR NEW."replaces_refund_transaction_id" IS DISTINCT FROM OLD."replaces_refund_transaction_id"
       OR NEW."replaces_failure_provider_event_id" IS DISTINCT FROM OLD."replaces_failure_provider_event_id"
       OR NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."reason" IS DISTINCT FROM OLD."reason"
       OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR (OLD."dispatch_claimed_at" IS NOT NULL
           AND NEW."dispatch_claimed_at" IS DISTINCT FROM OLD."dispatch_claimed_at")
       OR (OLD."source_success_provider_event_id" IS NOT NULL
           AND NEW."source_success_provider_event_id" IS DISTINCT FROM OLD."source_success_provider_event_id")
       OR (OLD."reconciliation_started_at" IS NOT NULL
           AND NEW."reconciliation_started_at" IS DISTINCT FROM OLD."reconciliation_started_at")
       OR (
           OLD."completed_at" IS NOT NULL
           AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
           AND NOT (
               OLD."status" = 'SUCCEEDED'
               AND NEW."status" IN ('FAILED', 'SUSPENDED')
               AND NEW."completed_at" IS NULL
           )
       )
       OR (OLD."provider_refund_id" IS NOT NULL
           AND NEW."provider_refund_id" IS DISTINCT FROM OLD."provider_refund_id")
       OR (OLD."status" = 'SUPERSEDED'
           AND NEW."provider_refund_id" IS DISTINCT FROM OLD."provider_refund_id") THEN
        RAISE EXCEPTION 'refund transaction financial identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_transaction_identity_immutable_check';
    END IF;

    IF OLD."status" = 'SUCCEEDED'
       AND NEW."status" = 'FAILED'
       AND (
           NEW."provider_refund_id" IS NULL
           OR NEW."provider_refund_id" IS DISTINCT FROM OLD."provider_refund_id"
           OR NEW."provider_result_event_id" IS NOT DISTINCT FROM
               OLD."provider_result_event_id"
       ) THEN
        RAISE EXCEPTION 'successful refund may reverse only to its exact newer provider failure'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_success_failure_reconciliation_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION taven_validate_refund_retry_source_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (
        NEW."status" IN ('SUPERSEDED', 'SUSPENDED')
        OR (NEW."status" = 'FAILED'
            AND NEW."source_success_provider_event_id" IS NOT NULL)
    ) AND NOT EXISTS (
        SELECT 1
        FROM "refund_transactions" source_refund
        JOIN "payments" payment ON payment."id" = source_refund."payment_id"
        JOIN "payment_provider_events" failure_event
          ON failure_event."id" = NEW."replaces_failure_provider_event_id"
         AND failure_event."refund_transaction_id" = source_refund."id"
        JOIN "payment_provider_events" success_event
          ON success_event."id" = NEW."source_success_provider_event_id"
         AND success_event."refund_transaction_id" = source_refund."id"
        WHERE source_refund."id" = NEW."replaces_refund_transaction_id"
          AND source_refund."payment_id" = NEW."payment_id"
          AND source_refund."provider" = NEW."provider"
          AND source_refund."amount_minor" = NEW."amount_minor"
          AND source_refund."reason" = NEW."reason"
          AND failure_event."id" = NEW."replaces_failure_provider_event_id"
          AND failure_event."payment_id" = source_refund."payment_id"
          AND failure_event."provider" = source_refund."provider"
          AND failure_event."kind" = 'REFUND_FAILED'
          AND failure_event."provider_transaction_id" = source_refund."provider_refund_id"
          AND failure_event."amount_minor" = source_refund."amount_minor"
          AND failure_event."currency" = payment."currency"
          AND success_event."payment_id" = source_refund."payment_id"
          AND success_event."provider" = source_refund."provider"
          AND success_event."kind" = 'REFUND_SUCCEEDED'
          AND success_event."provider_transaction_id" = source_refund."provider_refund_id"
          AND success_event."amount_minor" = source_refund."amount_minor"
          AND success_event."currency" = payment."currency"
          AND success_event."occurred_at" > failure_event."occurred_at"
          AND success_event."verified_at" = NEW."reconciliation_started_at"
          AND (
              (NEW."status" IN ('SUPERSEDED', 'FAILED')
               AND source_refund."status" = 'SUCCEEDED'
               AND source_refund."provider_result_event_id" = success_event."id"
               AND source_refund."completed_at" = success_event."verified_at"
               AND (
                   NEW."status" = 'SUPERSEDED'
                   OR taven_refund_result_event_matches(
                       NEW."id", NEW."provider_result_event_id",
                       'FAILED'::"refund_status"
                   )
               ))
              OR
              (NEW."status" = 'SUSPENDED'
               AND source_refund."status" = 'FAILED'
               AND source_refund."provider_result_event_id" = failure_event."id"
               AND (
                   NEW."provider_result_event_id" IS NULL
                   OR EXISTS (
                       SELECT 1
                       FROM "payment_provider_events" retry_success
                       WHERE retry_success."id" = NEW."provider_result_event_id"
                         AND retry_success."payment_id" = NEW."payment_id"
                         AND retry_success."refund_transaction_id" = NEW."id"
                         AND retry_success."provider" = NEW."provider"
                         AND retry_success."provider_transaction_id" =
                             NEW."provider_refund_id"
                         AND retry_success."kind" = 'REFUND_SUCCEEDED'
                         AND retry_success."amount_minor" = NEW."amount_minor"
                         AND retry_success."currency" = payment."currency"
                   )
               ))
          )
    ) THEN
        RAISE EXCEPTION 'retry reconciliation and source provider truth must commit atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_retry_source_reconciliation_check';
    END IF;

    IF OLD."status" = 'FAILED'
       AND NEW."status" = 'SUCCEEDED'
       AND EXISTS (
           SELECT 1
           FROM "refund_transactions" retry
           WHERE retry."replaces_refund_transaction_id" = NEW."id"
             AND retry."replaces_failure_provider_event_id" = OLD."provider_result_event_id"
             AND retry."status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED')
       ) THEN
        RAISE EXCEPTION 'late source success must atomically supersede its undispatched retry'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_retry_source_reconciliation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "refund_transactions_source_reconciliation_reconciled"
AFTER UPDATE OF "status", "provider_result_event_id", "completed_at",
    "dispatch_claimed_at", "source_success_provider_event_id",
    "reconciliation_started_at"
ON "refund_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_refund_retry_source_reconciliation();

CREATE FUNCTION taven_payment_has_suspended_refund_incident(
    target_payment_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "refund_transactions" retry
        JOIN "payments" payment ON payment."id" = retry."payment_id"
        JOIN "refund_transactions" source_refund
          ON source_refund."id" = retry."replaces_refund_transaction_id"
         AND source_refund."payment_id" = retry."payment_id"
        JOIN "payment_provider_events" source_failure
          ON source_failure."id" = retry."replaces_failure_provider_event_id"
         AND source_failure."refund_transaction_id" = source_refund."id"
        JOIN "payment_provider_events" source_success
          ON source_success."id" = retry."source_success_provider_event_id"
         AND source_success."refund_transaction_id" = source_refund."id"
        JOIN "payment_provider_events" retry_success
          ON retry_success."id" = retry."provider_result_event_id"
         AND retry_success."refund_transaction_id" = retry."id"
        WHERE retry."payment_id" = target_payment_id
          AND retry."status" = 'SUSPENDED'
          AND retry."dispatch_claimed_at" IS NOT NULL
          AND retry."completed_at" IS NULL
          AND retry."reconciliation_started_at" = source_success."verified_at"
          AND retry."provider" = source_refund."provider"
          AND retry."amount_minor" = source_refund."amount_minor"
          AND retry."reason" = source_refund."reason"
          AND source_refund."status" = 'FAILED'
          AND source_refund."provider_result_event_id" = source_failure."id"
          AND source_refund."completed_at" IS NULL
          AND source_failure."payment_id" = payment."id"
          AND source_failure."provider" = source_refund."provider"
          AND source_failure."provider" = payment."provider"
          AND source_failure."kind" = 'REFUND_FAILED'
          AND source_failure."provider_transaction_id" =
              source_refund."provider_refund_id"
          AND source_failure."amount_minor" = source_refund."amount_minor"
          AND source_failure."currency" = payment."currency"
          AND source_success."payment_id" = payment."id"
          AND source_success."provider" = source_refund."provider"
          AND source_success."kind" = 'REFUND_SUCCEEDED'
          AND source_success."provider_transaction_id" =
              source_refund."provider_refund_id"
          AND source_success."amount_minor" = source_refund."amount_minor"
          AND source_success."currency" = payment."currency"
          AND source_success."occurred_at" > source_failure."occurred_at"
          AND retry_success."payment_id" = payment."id"
          AND retry_success."provider" = retry."provider"
          AND retry_success."provider" = payment."provider"
          AND retry_success."kind" = 'REFUND_SUCCEEDED'
          AND retry_success."provider_transaction_id" = retry."provider_refund_id"
          AND retry_success."amount_minor" = retry."amount_minor"
          AND retry_success."currency" = payment."currency"
          AND NOT EXISTS (
              SELECT 1
              FROM "payment_provider_events" later_retry_event
              WHERE later_retry_event."id" <> retry_success."id"
                AND later_retry_event."payment_id" = retry."payment_id"
                AND later_retry_event."refund_transaction_id" = retry."id"
                AND later_retry_event."provider" = retry."provider"
                AND later_retry_event."provider_transaction_id" =
                    retry."provider_refund_id"
                AND later_retry_event."amount_minor" = retry."amount_minor"
                AND later_retry_event."currency" = payment."currency"
                AND later_retry_event."occurred_at" >= retry_success."occurred_at"
          )
    );
$$;

CREATE OR REPLACE FUNCTION taven_payment_has_newer_refund_failure(
    target_payment_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT taven_payment_has_suspended_refund_incident(target_payment_id)
        OR EXISTS (
            SELECT 1
            FROM "refund_transactions" refund
            JOIN "payments" payment ON payment."id" = refund."payment_id"
            JOIN "payment_provider_events" failure
              ON failure."id" = refund."provider_result_event_id"
             AND failure."refund_transaction_id" = refund."id"
            WHERE refund."payment_id" = target_payment_id
              AND refund."status" = 'FAILED'
              AND taven_refund_result_event_matches(
                  refund."id", refund."provider_result_event_id",
                  'FAILED'::"refund_status"
              )
              AND EXISTS (
                  SELECT 1
                  FROM "payment_provider_events" success
                  WHERE success."payment_id" = refund."payment_id"
                    AND success."refund_transaction_id" = refund."id"
                    AND success."provider" = refund."provider"
                    AND success."kind" = 'REFUND_SUCCEEDED'
                    AND success."provider_transaction_id" =
                        refund."provider_refund_id"
                    AND success."amount_minor" = refund."amount_minor"
                    AND success."currency" = payment."currency"
                    AND success."occurred_at" < failure."occurred_at"
              )
        );
$$;

CREATE OR REPLACE FUNCTION taven_order_has_newer_refund_failure(
    target_order_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "payments" payment
        WHERE payment."order_id" = target_order_id
          AND taven_payment_has_suspended_refund_incident(payment."id")
    ) OR EXISTS (
        SELECT 1
        FROM "payments" payment
        JOIN "refund_transactions" refund
          ON refund."payment_id" = payment."id"
        JOIN "payment_provider_events" failure
          ON failure."id" = refund."provider_result_event_id"
         AND failure."payment_id" = payment."id"
         AND failure."refund_transaction_id" = refund."id"
        WHERE payment."order_id" = target_order_id
          AND refund."status" = 'FAILED'
          AND failure."provider" = refund."provider"
          AND failure."provider" = payment."provider"
          AND failure."kind" = 'REFUND_FAILED'
          AND failure."provider_transaction_id" = refund."provider_refund_id"
          AND failure."amount_minor" = refund."amount_minor"
          AND failure."currency" = payment."currency"
          AND EXISTS (
              SELECT 1
              FROM "payment_provider_events" success
              WHERE success."payment_id" = payment."id"
                AND success."refund_transaction_id" = refund."id"
                AND success."provider" = refund."provider"
                AND success."kind" = 'REFUND_SUCCEEDED'
                AND success."provider_transaction_id" =
                    refund."provider_refund_id"
                AND success."amount_minor" = refund."amount_minor"
                AND success."currency" = payment."currency"
                AND success."occurred_at" < failure."occurred_at"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "payment_provider_events" later_event
              WHERE later_event."id" <> failure."id"
                AND later_event."payment_id" = payment."id"
                AND later_event."refund_transaction_id" = refund."id"
                AND later_event."provider" = refund."provider"
                AND later_event."provider_transaction_id" =
                    refund."provider_refund_id"
                AND later_event."amount_minor" = refund."amount_minor"
                AND later_event."currency" = payment."currency"
                AND later_event."occurred_at" >= failure."occurred_at"
          )
    );
$$;

CREATE OR REPLACE FUNCTION taven_validate_payment_provider_event_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_provider varchar(100);
    target_payment_status "payment_status";
    target_requested_amount bigint;
    target_currency char(3);
    target_provider_intent_id varchar(255);
    target_provider_capture_id varchar(255);
    target_payment_created_at timestamptz;
    target_refund_payment_id uuid;
    target_refund_status "refund_status";
    target_refund_amount bigint;
    target_provider_refund_id varchar(255);
    target_refund_requested_at timestamptz;
BEGIN
    SELECT payment."order_id"
    INTO target_order_id
    FROM "payments" payment
    WHERE payment."id" = NEW."payment_id";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment provider event parent Payment does not exist'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
    END IF;

    PERFORM 1
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    PERFORM 1
    FROM "order_phases" phase
    WHERE phase."order_id" = target_order_id
    ORDER BY phase."id"
    FOR UPDATE;

    IF NEW."kind" IN ('REFUND_SUCCEEDED', 'REFUND_FAILED') THEN
        SELECT refund."payment_id", refund."status", refund."amount_minor",
               refund."provider_refund_id", refund."requested_at"
        INTO target_refund_payment_id, target_refund_status, target_refund_amount,
             target_provider_refund_id, target_refund_requested_at
        FROM "refund_transactions" refund
        WHERE refund."id" = NEW."refund_transaction_id"
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Payment provider event parent RefundTransaction does not exist'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
        END IF;
    END IF;

    SELECT payment."provider", payment."status", payment."requested_amount_minor",
           payment."currency", payment."provider_intent_id",
           payment."provider_capture_id", payment."created_at"
    INTO target_provider, target_payment_status, target_requested_amount,
         target_currency, target_provider_intent_id,
         target_provider_capture_id, target_payment_created_at
    FROM "payments" payment
    WHERE payment."id" = NEW."payment_id"
    FOR UPDATE;

    IF NOT FOUND
       OR NEW."provider" IS DISTINCT FROM target_provider
       OR NEW."occurred_at" < target_payment_created_at - interval '5 seconds' THEN
        RAISE EXCEPTION 'Payment provider event does not match its exact Payment parent'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
    END IF;

    IF NEW."kind" IN ('PAYMENT_CAPTURED', 'PAYMENT_FAILED') THEN
        IF NEW."amount_minor" IS DISTINCT FROM target_requested_amount
           OR NEW."currency" IS DISTINCT FROM target_currency
           OR (NEW."kind" = 'PAYMENT_CAPTURED' AND (
               target_payment_status NOT IN (
                   'PENDING', 'FAILED', 'VOIDED', 'CAPTURED', 'REFUND_PENDING',
                   'PARTIALLY_REFUNDED', 'REFUNDED'
               )
               OR (target_payment_status = 'FAILED' AND (
                   target_provider_intent_id IS NULL
                   OR target_provider_intent_id !~ '[^[:space:]]'
               ))
               OR (target_provider_capture_id IS NOT NULL
                   AND NEW."provider_transaction_id" IS DISTINCT FROM
                       target_provider_capture_id)
           ))
           OR (NEW."kind" = 'PAYMENT_FAILED' AND (
               target_payment_status NOT IN (
                   'PENDING', 'FAILED', 'VOIDED', 'CAPTURED',
                   'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'
               )
               OR target_provider_intent_id IS NULL
               OR target_provider_intent_id !~ '[^[:space:]]'
               OR NEW."provider_transaction_id" IS DISTINCT FROM
                   target_provider_intent_id
           )) THEN
            RAISE EXCEPTION 'Payment provider event does not match its exact Payment outcome scope'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
        END IF;
    ELSE
        IF target_refund_payment_id IS DISTINCT FROM NEW."payment_id"
           OR NEW."amount_minor" IS DISTINCT FROM target_refund_amount
           OR NEW."currency" IS DISTINCT FROM target_currency
           OR NEW."occurred_at" < target_refund_requested_at - interval '5 seconds'
           OR (target_provider_refund_id IS NOT NULL
               AND NEW."provider_transaction_id" IS DISTINCT FROM
                   target_provider_refund_id)
           OR target_refund_status NOT IN (
               'PENDING', 'FAILED', 'SUCCEEDED', 'SUSPENDED'
           ) THEN
            RAISE EXCEPTION 'Payment provider event does not match its exact RefundTransaction outcome scope'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION taven_reconcile_payment_provider_event_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (NEW."kind" = 'PAYMENT_CAPTURED'
        AND NOT EXISTS (
            SELECT 1
            FROM "payments" payment
            WHERE payment."id" = NEW."payment_id"
              AND payment."status" IN (
                  'CAPTURED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'
              )
              AND payment."provider" = NEW."provider"
              AND payment."provider_capture_id" = NEW."provider_transaction_id"
              AND payment."captured_amount_minor" = NEW."amount_minor"
              AND payment."currency" = NEW."currency"
              AND (
                  payment."captured_at" = NEW."verified_at"
                  OR EXISTS (
                      SELECT 1
                      FROM "payment_provider_events" exact_event
                      WHERE exact_event."id" <> NEW."id"
                        AND exact_event."payment_id" = NEW."payment_id"
                        AND exact_event."refund_transaction_id" IS NULL
                        AND exact_event."provider" = NEW."provider"
                        AND exact_event."kind" = 'PAYMENT_CAPTURED'
                        AND exact_event."provider_transaction_id" =
                            NEW."provider_transaction_id"
                        AND exact_event."amount_minor" = NEW."amount_minor"
                        AND exact_event."currency" = NEW."currency"
                        AND exact_event."verified_at" = payment."captured_at"
                  )
              )
        ))
       OR (NEW."kind" = 'PAYMENT_FAILED'
           AND NOT EXISTS (
               SELECT 1
               FROM "payments" payment
               WHERE payment."id" = NEW."payment_id"
                 AND payment."status" IN (
                     'FAILED', 'VOIDED', 'CAPTURED', 'REFUND_PENDING',
                     'PARTIALLY_REFUNDED', 'REFUNDED'
                 )
                 AND payment."provider" = NEW."provider"
                 AND payment."provider_intent_id" = NEW."provider_transaction_id"
                 AND payment."requested_amount_minor" = NEW."amount_minor"
                 AND payment."currency" = NEW."currency"
           ))
       OR (NEW."kind" = 'REFUND_SUCCEEDED'
           AND NOT EXISTS (
               SELECT 1
               FROM "refund_transactions" refund
               LEFT JOIN "payment_provider_events" selected_event
                 ON selected_event."id" = refund."provider_result_event_id"
                AND selected_event."refund_transaction_id" = refund."id"
               WHERE refund."id" = NEW."refund_transaction_id"
                 AND refund."payment_id" = NEW."payment_id"
                 AND refund."provider" = NEW."provider"
                 AND refund."provider_refund_id" = NEW."provider_transaction_id"
                 AND refund."amount_minor" = NEW."amount_minor"
                 AND (
                     (refund."status" = 'SUCCEEDED'
                      AND taven_refund_result_event_matches(
                          refund."id", refund."provider_result_event_id",
                          'SUCCEEDED'::"refund_status"
                      ))
                     OR (refund."status" = 'FAILED'
                         AND taven_refund_result_event_matches(
                             refund."id", refund."provider_result_event_id",
                             'FAILED'::"refund_status"
                         )
                         AND (
                             EXISTS (
                                 SELECT 1
                                 FROM "payment_provider_events" later_failure
                                 WHERE later_failure."payment_id" = NEW."payment_id"
                                   AND later_failure."refund_transaction_id" =
                                       NEW."refund_transaction_id"
                                   AND later_failure."provider" = NEW."provider"
                                   AND later_failure."kind" = 'REFUND_FAILED'
                                   AND later_failure."provider_transaction_id" =
                                       NEW."provider_transaction_id"
                                   AND later_failure."amount_minor" = NEW."amount_minor"
                                   AND later_failure."currency" = NEW."currency"
                                   AND later_failure."occurred_at" >= NEW."occurred_at"
                             )
                             OR EXISTS (
                                 SELECT 1
                                 FROM "refund_transactions" retry
                                 WHERE retry."replaces_refund_transaction_id" =
                                       refund."id"
                                   AND retry."replaces_failure_provider_event_id" =
                                       refund."provider_result_event_id"
                                   AND retry."status" = 'SUSPENDED'
                                   AND retry."source_success_provider_event_id" =
                                       NEW."id"
                                   AND retry."reconciliation_started_at" =
                                       NEW."verified_at"
                             )
                         ))
                     OR (refund."status" = 'SUSPENDED'
                         AND refund."source_success_provider_event_id" IS NOT NULL
                         AND refund."reconciliation_started_at" IS NOT NULL
                         AND refund."provider_result_event_id" = NEW."id")
                 )
           ))
       OR (NEW."kind" = 'REFUND_FAILED'
           AND NOT EXISTS (
               SELECT 1
               FROM "refund_transactions" refund
               LEFT JOIN "payment_provider_events" selected_event
                 ON selected_event."id" = refund."provider_result_event_id"
                AND selected_event."refund_transaction_id" = refund."id"
               WHERE refund."id" = NEW."refund_transaction_id"
                 AND refund."payment_id" = NEW."payment_id"
                 AND refund."provider" = NEW."provider"
                 AND refund."provider_refund_id" = NEW."provider_transaction_id"
                 AND refund."amount_minor" = NEW."amount_minor"
                 AND (
                     (refund."status" = 'FAILED'
                      AND taven_refund_result_event_matches(
                          refund."id", refund."provider_result_event_id",
                          'FAILED'::"refund_status"
                      ))
                     OR (refund."status" = 'SUCCEEDED'
                         AND taven_refund_result_event_matches(
                             refund."id", refund."provider_result_event_id",
                             'SUCCEEDED'::"refund_status"
                         )
                         AND EXISTS (
                             SELECT 1
                             FROM "payment_provider_events" later_success
                             WHERE later_success."payment_id" = NEW."payment_id"
                               AND later_success."refund_transaction_id" =
                                   NEW."refund_transaction_id"
                               AND later_success."provider" = NEW."provider"
                               AND later_success."kind" = 'REFUND_SUCCEEDED'
                               AND later_success."provider_transaction_id" =
                                   NEW."provider_transaction_id"
                               AND later_success."amount_minor" = NEW."amount_minor"
                               AND later_success."currency" = NEW."currency"
                               AND later_success."occurred_at" >= NEW."occurred_at"
                         ))
                 )
           )) THEN
        RAISE EXCEPTION 'Payment provider event and its financial outcome must commit atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_consumption_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION taven_validate_payment_refund_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_payment_id uuid;
    payment_status "payment_status";
    captured_amount bigint;
    succeeded_refunds bigint;
    pending_refunds bigint;
BEGIN
    target_payment_id := CASE
        WHEN TG_TABLE_NAME = 'payments' THEN (to_jsonb(NEW) ->> 'id')::uuid
        ELSE (to_jsonb(NEW) ->> 'payment_id')::uuid
    END;

    SELECT "status", "captured_amount_minor"
    INTO payment_status, captured_amount
    FROM "payments"
    WHERE "id" = target_payment_id
    FOR UPDATE;

    SELECT coalesce(sum("amount_minor") FILTER (
               WHERE "status" = 'SUCCEEDED'
           ), 0),
           count(*) FILTER (
               WHERE "status" IN ('PENDING', 'SUSPENDED')
           )
    INTO succeeded_refunds, pending_refunds
    FROM "refund_transactions"
    WHERE "payment_id" = target_payment_id;

    IF (payment_status = 'REFUND_PENDING') IS DISTINCT FROM
       (pending_refunds > 0) THEN
        RAISE EXCEPTION 'refund-pending payment and active or suspended refund work must be persisted atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_status_reconciliation_check';
    ELSIF payment_status IN ('CREATED', 'PENDING', 'FAILED', 'VOIDED', 'CAPTURED')
       AND succeeded_refunds <> 0 THEN
        RAISE EXCEPTION 'payment status cannot hide successful refunds'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_status_reconciliation_check';
    ELSIF payment_status = 'REFUND_PENDING'
          AND (captured_amount IS NULL OR succeeded_refunds >= captured_amount) THEN
        RAISE EXCEPTION 'refund-pending payment must remain below its captured amount'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_status_reconciliation_check';
    ELSIF payment_status = 'PARTIALLY_REFUNDED'
          AND (captured_amount IS NULL OR succeeded_refunds <= 0
               OR succeeded_refunds >= captured_amount) THEN
        RAISE EXCEPTION 'partially refunded payment requires a positive refund below its capture'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_status_reconciliation_check';
    ELSIF payment_status = 'REFUNDED'
          AND (captured_amount IS NULL OR succeeded_refunds <> captured_amount) THEN
        RAISE EXCEPTION 'refunded payment requires successful refunds equal to its capture'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_refund_status_reconciliation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION taven_reconcile_customer_cancellation_refund_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_order_status "order_status";
    has_failed_job boolean;
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        target_order_id := NEW."id";
    ELSIF TG_TABLE_NAME = 'payments' THEN
        target_order_id := NEW."order_id";
    ELSE
        SELECT payment."order_id"
        INTO target_order_id
        FROM "payments" payment
        WHERE payment."id" = NEW."payment_id";
    END IF;

    SELECT target_order."status"
    INTO target_order_status
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    SELECT EXISTS (
        SELECT 1
        FROM "jobs" job
        WHERE job."order_id" = target_order_id
          AND job."status" IN ('FAILED', 'QC_REJECTED')
    )
    INTO has_failed_job;

    IF target_order_status NOT IN ('CANCELLED', 'REFUNDED')
       AND NOT (
           target_order_status IN ('SHIPPED', 'DELIVERED', 'COMPLETED')
           AND taven_has_refunded_post_void_handoff_reconciliation(
               target_order_id
           )
       )
       AND EXISTS (
           SELECT 1
           FROM "payments" payment
           JOIN "refund_transactions" refund
             ON refund."payment_id" = payment."id"
           WHERE payment."order_id" = target_order_id
             AND refund."reason" = 'CUSTOMER_CANCELLATION'
             AND refund."status" IN (
                 'PENDING', 'SUSPENDED', 'SUCCEEDED'
             )
       ) THEN
        RAISE EXCEPTION 'customer-cancellation refund requires a cancelled order lifecycle'
            USING ERRCODE = '23514', CONSTRAINT = 'order_customer_cancellation_refund_lifecycle_check';
    END IF;

    IF target_order_status = 'CANCELLED'
       AND NOT has_failed_job
       AND EXISTS (
           SELECT 1
           FROM "payments" payment
           CROSS JOIN LATERAL (
               SELECT coalesce(sum(refund."amount_minor") FILTER (
                          WHERE refund."status" = 'SUCCEEDED'
                      ), 0) AS succeeded_total,
                      coalesce(sum(refund."amount_minor") FILTER (
                          WHERE refund."reason" = 'CUSTOMER_CANCELLATION'
                            AND refund."status" IN ('PENDING', 'SUSPENDED')
                      ), 0) AS customer_cancellation_pending
               FROM "refund_transactions" refund
               WHERE refund."payment_id" = payment."id"
           ) refund_totals
           LEFT JOIN LATERAL (
               SELECT refund."amount_minor", refund."status"
               FROM "refund_transactions" refund
               LEFT JOIN "payment_provider_events" selected_event
                 ON selected_event."id" = refund."provider_result_event_id"
                AND selected_event."refund_transaction_id" = refund."id"
               WHERE refund."payment_id" = payment."id"
                 AND refund."reason" = 'CUSTOMER_CANCELLATION'
               ORDER BY selected_event."occurred_at" DESC NULLS LAST,
                        refund."requested_at" DESC,
                        refund."created_at" DESC,
                        refund."id" DESC
               LIMIT 1
           ) latest_customer_cancellation_refund ON true
           WHERE payment."order_id" = target_order_id
             AND payment."captured_amount_minor" IS NOT NULL
             AND NOT (
                 NOT payment."capture_authorized"
                 AND payment."capture_cutoff_at" IS NOT NULL
                 AND payment."captured_at" IS NOT NULL
                 AND payment."captured_at" >= payment."capture_cutoff_at"
             )
             AND NOT (
                 (payment."captured_amount_minor" -
                      refund_totals.succeeded_total = 0
                  AND payment."status" = 'REFUNDED')
                 OR
                 (payment."captured_amount_minor" -
                      refund_totals.succeeded_total > 0
                  AND refund_totals.customer_cancellation_pending =
                      payment."captured_amount_minor" -
                      refund_totals.succeeded_total
                  AND payment."status" = 'REFUND_PENDING')
                 OR
                 (payment."captured_amount_minor" -
                      refund_totals.succeeded_total > 0
                  AND refund_totals.customer_cancellation_pending = 0
                  AND latest_customer_cancellation_refund."status"
                      IS NOT DISTINCT FROM 'FAILED'::"refund_status"
                  AND latest_customer_cancellation_refund."amount_minor" =
                      payment."captured_amount_minor" -
                      refund_totals.succeeded_total
                  AND payment."status" = CASE
                      WHEN refund_totals.succeeded_total = 0
                          THEN 'CAPTURED'::"payment_status"
                      ELSE 'PARTIALLY_REFUNDED'::"payment_status"
                  END)
             )
       ) THEN
        RAISE EXCEPTION 'ordinary cancelled orders require complete customer-cancellation refund work for every captured payment'
            USING ERRCODE = '23514', CONSTRAINT = 'order_customer_cancellation_refund_obligation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION taven_reconcile_production_failure_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_order_status "order_status";
    has_failed_job boolean;
    has_production_failure_refund boolean;
BEGIN
    IF TG_TABLE_NAME = 'orders' THEN
        target_order_id := NEW."id";
    ELSIF TG_TABLE_NAME IN ('jobs', 'payments') THEN
        target_order_id := NEW."order_id";
    ELSE
        SELECT payment."order_id"
        INTO target_order_id
        FROM "payments" payment
        WHERE payment."id" = NEW."payment_id";
    END IF;

    SELECT target_order."status",
           EXISTS (
               SELECT 1
               FROM "jobs" job
               WHERE job."order_id" = target_order_id
                 AND job."status" IN ('FAILED', 'QC_REJECTED')
           ),
           EXISTS (
               SELECT 1
               FROM "payments" payment
               JOIN "refund_transactions" refund
                 ON refund."payment_id" = payment."id"
               WHERE payment."order_id" = target_order_id
                 AND refund."reason" = 'PRODUCTION_FAILURE'
           )
    INTO target_order_status, has_failed_job, has_production_failure_refund
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    IF has_failed_job AND (
        target_order_status NOT IN ('CANCELLED', 'REFUNDED')
        OR EXISTS (
            SELECT 1
            FROM "payments" payment
            CROSS JOIN LATERAL (
                SELECT coalesce(sum(refund."amount_minor") FILTER (
                           WHERE refund."status" = 'SUCCEEDED'
                       ), 0) AS succeeded_total,
                       coalesce(sum(refund."amount_minor") FILTER (
                           WHERE refund."reason" = 'PRODUCTION_FAILURE'
                             AND refund."status" IN ('PENDING', 'SUSPENDED')
                       ), 0) AS production_pending
                FROM "refund_transactions" refund
                WHERE refund."payment_id" = payment."id"
            ) refund_totals
            LEFT JOIN LATERAL (
                SELECT refund."amount_minor", refund."status"
                FROM "refund_transactions" refund
                LEFT JOIN "payment_provider_events" selected_event
                  ON selected_event."id" = refund."provider_result_event_id"
                 AND selected_event."refund_transaction_id" = refund."id"
                WHERE refund."payment_id" = payment."id"
                  AND refund."reason" = 'PRODUCTION_FAILURE'
                ORDER BY selected_event."occurred_at" DESC NULLS LAST,
                         refund."requested_at" DESC,
                         refund."created_at" DESC,
                         refund."id" DESC
                LIMIT 1
            ) latest_production_refund ON true
            WHERE payment."order_id" = target_order_id
              AND payment."captured_amount_minor" IS NOT NULL
              AND NOT (
                  (payment."captured_amount_minor" -
                       refund_totals.succeeded_total = 0
                   AND payment."status" = 'REFUNDED')
                  OR
                  (payment."captured_amount_minor" -
                       refund_totals.succeeded_total > 0
                   AND (
                       (refund_totals.production_pending =
                            payment."captured_amount_minor" -
                            refund_totals.succeeded_total
                        AND payment."status" = 'REFUND_PENDING')
                       OR
                       (refund_totals.production_pending = 0
                        AND latest_production_refund."status"
                            IS NOT DISTINCT FROM 'FAILED'::"refund_status"
                        AND latest_production_refund."amount_minor" =
                            payment."captured_amount_minor" -
                            refund_totals.succeeded_total
                        AND payment."status" = CASE
                            WHEN refund_totals.succeeded_total = 0
                                THEN 'CAPTURED'::"payment_status"
                            ELSE 'PARTIALLY_REFUNDED'::"payment_status"
                        END)
                   ))
              )
        )
    ) THEN
        RAISE EXCEPTION 'failed production must cancel the order and retain a complete production-failure refund obligation or attempt'
            USING ERRCODE = '23514', CONSTRAINT = 'job_failure_cancellation_check';
    ELSIF has_production_failure_refund
          AND (NOT has_failed_job
               OR target_order_status NOT IN ('CANCELLED', 'REFUNDED')) THEN
        RAISE EXCEPTION 'production-failure refunds require retained failure evidence in a cancelled order lifecycle'
            USING ERRCODE = '23514', CONSTRAINT = 'job_failure_cancellation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION taven_validate_payment_capture_against_refunds()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    committed_refunds bigint;
BEGIN
    SELECT coalesce(sum("amount_minor"), 0)
    INTO committed_refunds
    FROM "refund_transactions"
    WHERE "payment_id" = NEW."id"
      AND "status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED');

    IF committed_refunds > coalesce(NEW."captured_amount_minor", 0) THEN
        RAISE EXCEPTION 'captured payment amount cannot fall below committed refunds'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_captured_refund_floor_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION taven_validate_refund_failure_retry_obligation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_payment_status "payment_status";
    captured_amount bigint;
    active_refund_amount bigint;
BEGIN
    IF OLD."status" IS DISTINCT FROM 'SUCCEEDED'::"refund_status"
       OR NEW."status" IS DISTINCT FROM 'FAILED'::"refund_status" THEN
        RETURN NULL;
    END IF;

    SELECT payment."status", payment."captured_amount_minor"
    INTO target_payment_status, captured_amount
    FROM "payments" payment
    WHERE payment."id" = NEW."payment_id";

    SELECT coalesce(sum(refund."amount_minor"), 0)
    INTO active_refund_amount
    FROM "refund_transactions" refund
    WHERE refund."payment_id" = NEW."payment_id"
      AND refund."status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED');

    IF target_payment_status = 'REFUND_PENDING'
       AND active_refund_amount = captured_amount
       AND NOT EXISTS (
           SELECT 1
           FROM "refund_transactions" retry
           WHERE retry."replaces_refund_transaction_id" = NEW."id"
             AND retry."replaces_failure_provider_event_id" =
                 NEW."provider_result_event_id"
             AND retry."payment_id" = NEW."payment_id"
             AND retry."provider" = NEW."provider"
             AND retry."amount_minor" = NEW."amount_minor"
             AND retry."reason" = NEW."reason"
             AND retry."status" IN ('PENDING', 'SUSPENDED')
       ) THEN
        RAISE EXCEPTION 'a stable refund-pending reversal requires its exact active retry'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_failure_retry_obligation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION taven_validate_refund_against_capture()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    captured_amount bigint;
    committed_refunds bigint;
    payment_capture_authorized boolean;
    payment_capture_cutoff_at timestamptz;
    payment_captured_at timestamptz;
    payment_failed_before_capture boolean;
    target_order_status "order_status";
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT payment."order_id"
        INTO target_order_id
        FROM "payments" payment
        WHERE payment."id" = NEW."payment_id";

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Refund parent Payment does not exist'
                USING ERRCODE = '23514', CONSTRAINT = 'refund_captured_payment_check';
        END IF;

        PERFORM taven_lock_automatic_order_session(target_order_id);

        PERFORM 1
        FROM "orders" target_order
        WHERE target_order."id" = target_order_id
        FOR UPDATE;

        PERFORM 1
        FROM "order_phases" phase
        WHERE phase."order_id" = target_order_id
        ORDER BY phase."id"
        FOR UPDATE;
    END IF;

    SELECT payment."captured_amount_minor", payment."capture_authorized",
           payment."capture_cutoff_at", payment."captured_at",
           EXISTS (
               SELECT 1
               FROM "payment_provider_events" event
               WHERE event."payment_id" = payment."id"
                 AND event."refund_transaction_id" IS NULL
                 AND event."provider" = payment."provider"
                 AND event."kind" = 'PAYMENT_FAILED'
                 AND event."provider_transaction_id" =
                     payment."provider_intent_id"
                 AND event."amount_minor" = payment."requested_amount_minor"
                 AND event."currency" = payment."currency"
                 AND event."verified_at" = payment."capture_cutoff_at"
           ), target_order."status"
    INTO captured_amount, payment_capture_authorized,
         payment_capture_cutoff_at, payment_captured_at,
         payment_failed_before_capture, target_order_status
    FROM "payments" payment
    JOIN "orders" target_order ON target_order."id" = payment."order_id"
    WHERE payment."id" = NEW."payment_id"
    FOR UPDATE OF payment;

    IF captured_amount IS NULL OR captured_amount <= 0 THEN
        RAISE EXCEPTION 'refund requires a captured payment'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_captured_payment_check';
    END IF;

    IF NEW."requested_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'refund request evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_request_evidence_check';
    END IF;

    IF NEW."completed_at" IS NOT NULL
       AND NEW."completed_at" > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'refund completion evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_completion_evidence_check';
    END IF;

    IF NEW."requested_at" < payment_captured_at - interval '5 seconds'
       OR (NEW."completed_at" IS NOT NULL
           AND NEW."completed_at" < payment_captured_at - interval '5 seconds') THEN
        RAISE EXCEPTION 'refund evidence cannot predate payment capture'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_capture_timestamp_order_check';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        SELECT coalesce(sum("amount_minor"), 0)
        INTO committed_refunds
        FROM "refund_transactions"
        WHERE "payment_id" = NEW."payment_id"
          AND "status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED')
          AND "id" <> OLD."id";
    ELSE
        SELECT coalesce(sum("amount_minor"), 0)
        INTO committed_refunds
        FROM "refund_transactions"
        WHERE "payment_id" = NEW."payment_id"
          AND "status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED');
    END IF;

    IF NEW."reason" = 'LATE_CAPTURE_COMPENSATION' AND (
        payment_capture_authorized
        OR payment_capture_cutoff_at IS NULL
        OR payment_captured_at IS NULL
        OR payment_captured_at < payment_capture_cutoff_at
        OR (target_order_status NOT IN ('EXPIRED', 'CANCELLED')
            AND NOT payment_failed_before_capture)
        OR NEW."amount_minor" <> captured_amount - committed_refunds
    ) THEN
        RAISE EXCEPTION 'late-capture compensation requires the full remaining capture after a terminal checkout cutoff'
            USING ERRCODE = '23514', CONSTRAINT = 'late_capture_compensation_check';
    END IF;

    IF NOT payment_capture_authorized
       AND payment_capture_cutoff_at IS NOT NULL
       AND payment_captured_at >= payment_capture_cutoff_at
       AND (target_order_status IN ('EXPIRED', 'CANCELLED')
            OR payment_failed_before_capture)
       AND NEW."reason" <> 'LATE_CAPTURE_COMPENSATION' THEN
        RAISE EXCEPTION 'a capture after a terminal checkout cutoff requires late-capture compensation'
            USING ERRCODE = '23514', CONSTRAINT = 'late_capture_compensation_reason_check';
    END IF;

    IF committed_refunds
       + (CASE WHEN NEW."status" IN (
              'PENDING', 'SUSPENDED', 'SUCCEEDED'
          ) THEN NEW."amount_minor" ELSE 0 END)
       > captured_amount THEN
        RAISE EXCEPTION 'refund amount exceeds captured payment amount'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_captured_payment_check';
    END IF;

    RETURN NEW;
END;
$$;
