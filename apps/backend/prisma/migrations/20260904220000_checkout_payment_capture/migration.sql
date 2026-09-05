BEGIN;

ALTER TABLE "payment_provider_events"
  DROP CONSTRAINT "payment_provider_events_scope_check",
  ADD CONSTRAINT "payment_provider_events_scope_check" CHECK (
    ("kind" IN ('PAYMENT_PENDING', 'PAYMENT_CAPTURED', 'PAYMENT_FAILED')
      AND "refund_transaction_id" IS NULL)
    OR ("kind" IN ('REFUND_SUCCEEDED', 'REFUND_FAILED')
      AND "refund_transaction_id" IS NOT NULL)
  );

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
    target_merchant_reference varchar(255);
    target_payment_created_at timestamptz;
    target_returned_intent_matched boolean := false;
    target_terminal_merchant_reference_matched boolean := false;
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
           payment."provider_capture_id", payment."merchant_reference",
           payment."created_at"
    INTO target_provider, target_payment_status, target_requested_amount,
         target_currency, target_provider_intent_id,
         target_provider_capture_id, target_merchant_reference,
         target_payment_created_at
    FROM "payments" payment
    WHERE payment."id" = NEW."payment_id"
    FOR UPDATE;

    IF NOT FOUND
       OR NEW."provider" IS DISTINCT FROM target_provider
       OR NEW."occurred_at" < target_payment_created_at - interval '5 seconds' THEN
        RAISE EXCEPTION 'Payment provider event does not match its exact Payment parent'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
    END IF;

    -- A returned intent can be closed before it is assigned to the Payment.
    -- Its durable void command remains the exact locator for later callbacks.
    IF target_payment_status = 'VOIDED'
       AND target_provider_intent_id IS NULL THEN
        SELECT EXISTS (
            SELECT 1
            FROM "outbox_messages" command
            WHERE command."aggregate_type" = 'Payment'
              AND command."aggregate_id" = NEW."payment_id"
              AND command."message_type" = 'void_payment'
              AND command."payload" ->> 'paymentId' = NEW."payment_id"::text
              AND command."payload" ->> 'provider' = NEW."provider"
              AND command."payload" ->> 'providerIntentId' =
                  NEW."provider_transaction_id"
              AND command."payload" ->> 'action' = 'void_payment'
        ) INTO target_returned_intent_matched;
    END IF;

    -- An ambiguous create can be closed without ever learning the provider
    -- intent. The authenticated merchant reference still binds a later
    -- non-capture terminal callback to that exact durable payment command.
    IF target_payment_status = 'VOIDED'
       AND target_provider_intent_id IS NULL
       AND NEW."kind" IN ('PAYMENT_PENDING', 'PAYMENT_FAILED') THEN
        target_terminal_merchant_reference_matched :=
            target_merchant_reference IS NOT NULL
            AND NEW."payload" ->> 'merchantReference'
                IS NOT DISTINCT FROM target_merchant_reference;
    END IF;

    IF NEW."kind" IN (
        'PAYMENT_PENDING', 'PAYMENT_CAPTURED', 'PAYMENT_FAILED'
    ) THEN
        IF NEW."amount_minor" IS DISTINCT FROM target_requested_amount
           OR NEW."currency" IS DISTINCT FROM target_currency
           OR (NEW."kind" = 'PAYMENT_PENDING' AND (
               target_payment_status NOT IN (
                   'PENDING', 'FAILED', 'VOIDED', 'CAPTURED', 'REFUND_PENDING',
                   'PARTIALLY_REFUNDED', 'REFUNDED'
               )
               OR (NOT target_returned_intent_matched
                   AND NOT target_terminal_merchant_reference_matched AND (
                   target_provider_intent_id IS NULL
                   OR target_provider_intent_id !~ '[^[:space:]]'
                   OR NEW."provider_transaction_id" IS DISTINCT FROM
                      target_provider_intent_id
               ))
           ))
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
                   AND NEW."provider_transaction_id" IS DISTINCT FROM target_provider_capture_id)
           ))
           OR (NEW."kind" = 'PAYMENT_FAILED' AND (
               target_payment_status NOT IN (
                   'PENDING', 'FAILED', 'VOIDED', 'CAPTURED',
                   'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'
               )
               OR (NOT target_returned_intent_matched
                   AND NOT target_terminal_merchant_reference_matched AND (
                   target_provider_intent_id IS NULL
                   OR target_provider_intent_id !~ '[^[:space:]]'
                   OR NEW."provider_transaction_id" IS DISTINCT FROM
                      target_provider_intent_id
               ))
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
               AND NEW."provider_transaction_id" IS DISTINCT FROM target_provider_refund_id)
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

ALTER TABLE "orders"
  ADD COLUMN "checkout_contact_snapshot" jsonb,
  ADD CONSTRAINT "orders_checkout_contact_snapshot_values_check" CHECK (
      "checkout_contact_snapshot" IS NULL
      OR (
          jsonb_typeof("checkout_contact_snapshot") = 'object'
          AND jsonb_typeof("checkout_contact_snapshot" -> 'email') = 'string'
          AND jsonb_typeof("checkout_contact_snapshot" -> 'fullName') = 'string'
          AND "checkout_contact_snapshot" ->> 'email' =
              lower(btrim("checkout_contact_snapshot" ->> 'email'))
          AND "checkout_contact_snapshot" ->> 'email' ~
              '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          AND char_length("checkout_contact_snapshot" ->> 'email') <= 320
          AND "checkout_contact_snapshot" ->> 'fullName' =
              btrim("checkout_contact_snapshot" ->> 'fullName')
          AND "checkout_contact_snapshot" ->> 'fullName' ~ '[^[:space:]]'
          AND char_length("checkout_contact_snapshot" ->> 'fullName') <= 200
      )
  );

CREATE FUNCTION taven_protect_order_checkout_contact_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."checkout_contact_snapshot" IS NOT NULL THEN
            RAISE EXCEPTION 'checkout contact cannot predate the quoted order'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'order_checkout_contact_snapshot_immutable_check';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."checkout_contact_snapshot" IS NOT DISTINCT FROM
       OLD."checkout_contact_snapshot" THEN
        IF OLD."accepted_order_price_binding_id" IS NULL
           AND OLD."accepted_terms_revision" IS NULL
           AND OLD."accepted_claim_policy_revision" IS NULL
           AND OLD."withdrawal_exception_acknowledged_at" IS NULL
           AND (
               NEW."accepted_order_price_binding_id" IS NOT NULL
               OR NEW."accepted_terms_revision" IS NOT NULL
               OR NEW."accepted_claim_policy_revision" IS NOT NULL
               OR NEW."withdrawal_exception_acknowledged_at" IS NOT NULL
           )
           AND NEW."checkout_contact_snapshot" IS NULL THEN
            RAISE EXCEPTION 'checkout acceptance requires its contact snapshot'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'order_checkout_contact_snapshot_immutable_check';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."checkout_contact_snapshot" IS NOT NULL
       OR NEW."checkout_contact_snapshot" IS NULL
       OR OLD."accepted_order_price_binding_id" IS NOT NULL
       OR OLD."accepted_terms_revision" IS NOT NULL
       OR OLD."accepted_claim_policy_revision" IS NOT NULL
       OR OLD."withdrawal_exception_acknowledged_at" IS NOT NULL
       OR NEW."accepted_order_price_binding_id" IS NULL
       OR NEW."accepted_terms_revision" IS NULL
       OR NEW."accepted_claim_policy_revision" IS NULL
       OR NEW."withdrawal_exception_acknowledged_at" IS NULL
       OR OLD."status" <> 'QUOTED'
       OR NEW."status" <> 'QUOTED'
       OR EXISTS (
           SELECT 1 FROM "payments" payment
           WHERE payment."order_id" = OLD."id"
       ) THEN
        RAISE EXCEPTION 'checkout contact snapshot is immutable acceptance evidence'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'order_checkout_contact_snapshot_immutable_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "orders_checkout_contact_snapshot_protected"
BEFORE INSERT OR UPDATE OF
  "accepted_order_price_binding_id", "accepted_terms_revision",
  "accepted_claim_policy_revision", "withdrawal_exception_acknowledged_at",
  "checkout_contact_snapshot"
ON "orders"
FOR EACH ROW EXECUTE FUNCTION taven_protect_order_checkout_contact_snapshot();

ALTER TABLE "payments"
  ADD COLUMN "checkout_method" varchar(50) NOT NULL DEFAULT 'ALL',
  ADD COLUMN "merchant_reference" varchar(255),
  ADD COLUMN "checkout_command_id" uuid,
  ADD COLUMN "provider_checkout_url" text;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_checkout_method_check"
  CHECK ("checkout_method" IN ('ALL', 'CARD', 'BANK_TRANSFER')),
  ADD CONSTRAINT "payments_checkout_command_values_check" CHECK (
      ("checkout_method" = 'ALL'
       AND "merchant_reference" IS NULL
       AND "checkout_command_id" IS NULL)
      OR ("checkout_method" IN ('CARD', 'BANK_TRANSFER')
          AND "merchant_reference" IS NOT NULL
          AND "merchant_reference" ~ '[^[:space:]]'
          AND "checkout_command_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "payments_checkout_command_fkey"
  FOREIGN KEY ("checkout_command_id") REFERENCES "idempotency_records"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX "payments_checkout_command_id_key"
  ON "payments"("checkout_command_id");
CREATE UNIQUE INDEX "payments_provider_merchant_reference_key"
  ON "payments"("provider", "merchant_reference");

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
                 AND payment."requested_amount_minor" = NEW."amount_minor"
                 AND payment."currency" = NEW."currency"
                 AND (
                     payment."provider_intent_id" =
                         NEW."provider_transaction_id"
                     OR (
                         payment."status" = 'VOIDED'
                         AND payment."provider_intent_id" IS NULL
                         AND (
                             (
                                 payment."merchant_reference" IS NOT NULL
                                 AND NEW."payload" ->> 'merchantReference'
                                     IS NOT DISTINCT FROM
                                     payment."merchant_reference"
                             )
                             OR EXISTS (
                                 SELECT 1
                                 FROM "outbox_messages" command
                                 WHERE command."aggregate_type" = 'Payment'
                                   AND command."aggregate_id" = payment."id"
                                   AND command."message_type" = 'void_payment'
                                   AND command."payload" ->> 'paymentId' =
                                       payment."id"::text
                                   AND command."payload" ->> 'provider' =
                                       NEW."provider"
                                   AND command."payload" ->> 'providerIntentId' =
                                       NEW."provider_transaction_id"
                                   AND command."payload" ->> 'action' =
                                       'void_payment'
                             )
                         )
                     )
                 )
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

-- A provider intent can return after checkout cancellation already won the
-- Payment lock. Its durable void command remains the authoritative intent
-- locator; a later authenticated capture records provider_capture_id before
-- entering compensation even though provider_intent_id was never assigned.
ALTER TABLE "payments"
  DROP CONSTRAINT "payments_provider_intent_identity_check";
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_provider_intent_identity_check" CHECK (
      ("provider_intent_id" IS NOT NULL
       AND "provider_intent_id" ~ '[^[:space:]]'
       AND "status" <> 'CREATED')
      OR ("provider_intent_id" IS NULL
          AND (
              "status" IN ('CREATED', 'FAILED', 'VOIDED')
              OR ("status" = 'REFUND_PENDING'
                  AND "provider_capture_id" IS NOT NULL)
          ))
  );

CREATE FUNCTION taven_protect_payment_checkout_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."provider_checkout_url" IS NOT NULL
           OR (NEW."checkout_method" IN ('CARD', 'BANK_TRANSFER') AND (
               NEW."merchant_reference" IS NULL
               OR NEW."checkout_command_id" IS NULL
           )) THEN
            RAISE EXCEPTION 'new checkout Payment requires its command and merchant reference before provider dispatch'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_checkout_identity_check';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."checkout_method" IS DISTINCT FROM OLD."checkout_method"
       OR NEW."merchant_reference" IS DISTINCT FROM OLD."merchant_reference"
       OR NEW."checkout_command_id" IS DISTINCT FROM OLD."checkout_command_id"
       OR (OLD."provider_checkout_url" IS NOT NULL
           AND NEW."provider_checkout_url" IS DISTINCT FROM OLD."provider_checkout_url")
       OR (OLD."provider_checkout_url" IS NULL
           AND NEW."provider_checkout_url" IS NOT NULL
           AND NOT (
               (OLD."status" = 'CREATED' AND NEW."status" = 'PENDING')
               OR (OLD."status" = 'PENDING' AND NEW."status" = 'PENDING'
                   AND OLD."provider_intent_id" IS NOT NULL
                   AND NEW."provider_intent_id" = OLD."provider_intent_id")
           ))
       OR (NEW."provider_checkout_url" IS NOT NULL
           AND NEW."provider_checkout_url" !~ '^https?://[^[:space:]]+$') THEN
        RAISE EXCEPTION 'Payment checkout identity is immutable and assigned only with its provider intent'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_checkout_identity_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_checkout_identity_protected"
BEFORE INSERT OR UPDATE ON "payments"
FOR EACH ROW EXECUTE FUNCTION taven_protect_payment_checkout_identity();

-- Resource and checkout transitions share the same lower-rank envelope before
-- either can lock a reservation set: Order, then ordered phases.
CREATE FUNCTION taven_lock_order_phase_envelope(target_order_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1 FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'orders_pkey';
    END IF;

    PERFORM 1 FROM "order_phases" phase
    WHERE phase."order_id" = target_order_id
    ORDER BY phase."id"
    FOR UPDATE;
END;
$$;

-- Checkout transitions extend the canonical order/phase envelope with ordered
-- refunds and then Payment. The first Payment read resolves immutable identity
-- only and takes no lock.
CREATE FUNCTION taven_lock_checkout_payment_envelope(target_payment_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    SELECT payment."order_id" INTO target_order_id
    FROM "payments" payment
    WHERE payment."id" = target_payment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'checkout Payment does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'payments_pkey';
    END IF;

    PERFORM taven_lock_order_phase_envelope(target_order_id);

    PERFORM 1 FROM "refund_transactions" refund
    WHERE refund."payment_id" = target_payment_id
    ORDER BY refund."id"
    FOR UPDATE;

    PERFORM 1 FROM "payments" payment
    WHERE payment."id" = target_payment_id
      AND payment."order_id" = target_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'checkout Payment identity changed during lock acquisition'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_order_binding_immutable_check';
    END IF;
END;
$$;

-- The original expiry functions claimed PhaseReservationSet before a deferred
-- reconciliation trigger locked Order. Checkout release takes those rows in
-- the opposite order, so the two workers could deadlock. Preserve the focused
-- set mutation behind an Order-first wrapper, and make batch claiming skip
-- already locked Orders without touching their reservation sets.
ALTER FUNCTION taven_expire_reserved_phase_reservation_set(uuid)
RENAME TO taven_expire_reserved_phase_reservation_set_after_order_lock;

CREATE FUNCTION taven_expire_reserved_phase_reservation_set(target_set_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    SELECT phase."order_id"
    INTO target_order_id
    FROM "phase_reservation_sets" reservation_set
    JOIN "phase_resource_plans" resource_plan
      ON resource_plan."id" = reservation_set."phase_resource_plan_id"
     AND resource_plan."node_id" = reservation_set."node_id"
    JOIN "order_phases" phase
      ON phase."id" = resource_plan."order_phase_id"
    WHERE reservation_set."id" = target_set_id;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- Expiry is opportunistic worker work. Skip a checkout transition which
    -- already owns the Order fence instead of waiting behind it.
    PERFORM 1 FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    PERFORM 1 FROM "order_phases" phase
    WHERE phase."order_id" = target_order_id
    ORDER BY phase."id"
    FOR UPDATE;

    -- Generic non-checkout release predates the Order-first envelope and can
    -- already own this set. Never wait on it while holding Order, because its
    -- deferred reconciliation will in turn request the Order lock.
    PERFORM 1 FROM "phase_reservation_sets" reservation_set
    WHERE reservation_set."id" = target_set_id
      AND reservation_set."status" = 'RESERVED'
      AND reservation_set."expires_at" <= clock_timestamp()
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    RETURN taven_expire_reserved_phase_reservation_set_after_order_lock(
        target_set_id
    );
END;
$$;

CREATE OR REPLACE FUNCTION taven_expire_reserved_phase_reservation_sets(
    batch_limit integer
)
RETURNS TABLE (phase_reservation_set_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
    target_set_id uuid;
    expired_count integer := 0;
BEGIN
    IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 1000 THEN
        RAISE EXCEPTION 'reservation expiry batch limit must be 1 through 1000'
            USING ERRCODE = '22023', CONSTRAINT = 'phase_reservation_expiry_batch_limit_check';
    END IF;

    FOR target_set_id IN
        SELECT reservation_set."id"
        FROM "phase_reservation_sets" reservation_set
        JOIN "phase_resource_plans" resource_plan
          ON resource_plan."id" = reservation_set."phase_resource_plan_id"
         AND resource_plan."node_id" = reservation_set."node_id"
        JOIN "order_phases" phase
          ON phase."id" = resource_plan."order_phase_id"
        WHERE reservation_set."status" = 'RESERVED'
          AND reservation_set."expires_at" <= clock_timestamp()
        ORDER BY reservation_set."expires_at", reservation_set."id"
    LOOP
        IF taven_expire_reserved_phase_reservation_set(target_set_id) THEN
            phase_reservation_set_id := target_set_id;
            expired_count := expired_count + 1;
            RETURN NEXT;
            EXIT WHEN expired_count >= batch_limit;
        END IF;
    END LOOP;
END;
$$;

-- A provider-authenticated capture can be the first conclusive response for an
-- intent whose create request lost its acknowledgement. Bind that exact intent
-- before reservation reacquisition so the generic resource function continues
-- to accept only Payments with durable provider identity. The provider event is
-- intentionally recorded later by taven_apply_checkout_payment_event, together
-- with capture, Job creation, or compensation.
CREATE FUNCTION taven_stage_created_checkout_payment_for_capture(
    target_payment_id uuid,
    event_provider text,
    event_transaction_id text,
    event_merchant_reference text,
    event_amount_minor bigint,
    event_currency char(3),
    event_occurred_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    target_payment "payments"%ROWTYPE;
    staged_at timestamptz := clock_timestamp();
BEGIN
    PERFORM taven_lock_checkout_payment_envelope(target_payment_id);

    SELECT payment.* INTO target_payment
    FROM "payments" payment
    WHERE payment."id" = target_payment_id
    FOR UPDATE;

    IF target_payment."status" NOT IN ('CREATED', 'PENDING') THEN
        RETURN false;
    END IF;

    IF event_provider IS NULL
       OR event_transaction_id IS NULL
       OR event_transaction_id !~ '[^[:space:]]'
       OR char_length(event_transaction_id) > 255
       OR event_merchant_reference IS NULL
       OR event_occurred_at IS NULL
       OR target_payment."provider" IS DISTINCT FROM event_provider
       OR target_payment."merchant_reference" IS DISTINCT FROM
          event_merchant_reference
       OR target_payment."requested_amount_minor" IS DISTINCT FROM
          event_amount_minor
       OR target_payment."currency" IS DISTINCT FROM event_currency
       OR event_occurred_at < target_payment."created_at" - interval '5 seconds'
       OR target_payment."role" NOT IN ('FULL', 'DEPOSIT')
       OR target_payment."checkout_method" NOT IN ('CARD', 'BANK_TRANSFER')
       OR target_payment."checkout_command_id" IS NULL THEN
        RAISE EXCEPTION 'verified capture does not match its checkout Payment'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_verified_capture_staging_check';
    END IF;

    IF NOT target_payment."capture_authorized"
       OR target_payment."capture_cutoff_at" IS NOT NULL
       OR target_payment."checkout_capture_expires_at" IS NULL
       OR target_payment."checkout_capture_expires_at" <= staged_at THEN
        RETURN false;
    END IF;

    -- This append-only marker distinguishes an authenticated capture recovery
    -- from a pending callback that arrived while provider intent creation was
    -- still in flight. Same-key retries may close the latter, but must leave the
    -- former open for the capture transition (or its compensation path).
    INSERT INTO "audit_events" (
        "id", "order_id", "payment_id", "event_type", "actor_kind",
        "correlation_id", "payload", "created_at"
    )
    SELECT gen_random_uuid(), target_payment."order_id", target_payment."id",
           'checkout.verified_capture_staged', 'SYSTEM',
           target_payment."checkout_command_id",
           jsonb_build_object(
               'provider', event_provider,
               'providerTransactionId', event_transaction_id,
               'merchantReference', event_merchant_reference,
               'amountMinor', event_amount_minor::text,
               'currency', event_currency,
               'occurredAt', event_occurred_at
           ),
           staged_at
    WHERE NOT EXISTS (
        SELECT 1
        FROM "audit_events" staged
        WHERE staged."payment_id" = target_payment."id"
          AND staged."event_type" = 'checkout.verified_capture_staged'
    );

    IF target_payment."status" = 'PENDING' THEN
        IF target_payment."provider_intent_id" IS DISTINCT FROM
           event_transaction_id THEN
            RAISE EXCEPTION 'verified capture conflicts with the assigned provider intent'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_verified_capture_staging_check';
        END IF;
        RETURN true;
    END IF;

    IF target_payment."provider_intent_id" IS NOT NULL
       OR target_payment."provider_checkout_url" IS NOT NULL
       OR target_payment."intent_creation_failure_result_id" IS NOT NULL THEN
        RAISE EXCEPTION 'created checkout Payment already has conflicting provider evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_verified_capture_staging_check';
    END IF;

    UPDATE "payments"
    SET "status" = 'PENDING',
        "provider_intent_id" = event_transaction_id,
        "updated_at" = staged_at
    WHERE "id" = target_payment_id
      AND "status" = 'CREATED';

    RETURN FOUND;
END;
$$;

-- Checkout-driven release must join the same Order-first serialization fence
-- as cancellation and provider capture before it touches reservation rows.
-- The generic release function remains reusable for non-checkout workflows;
-- this wrapper also proves that the set belongs to the Payment's Order.
CREATE FUNCTION taven_release_checkout_phase_reservation_set(
    target_payment_id uuid,
    target_set_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
BEGIN
    PERFORM taven_lock_checkout_payment_envelope(target_payment_id);

    SELECT payment."order_id" INTO target_order_id
    FROM "payments" payment
    WHERE payment."id" = target_payment_id;

    PERFORM 1
    FROM "phase_reservation_sets" reservation_set
    JOIN "phase_resource_plans" resource_plan
      ON resource_plan."id" = reservation_set."phase_resource_plan_id"
     AND resource_plan."node_id" = reservation_set."node_id"
    JOIN "order_phases" phase
      ON phase."id" = resource_plan."order_phase_id"
    WHERE reservation_set."id" = target_set_id
      AND phase."order_id" = target_order_id
    FOR UPDATE OF reservation_set;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'checkout reservation set does not belong to the Payment order'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_capture_reacquire_guard_check';
    END IF;

    RETURN taven_release_phase_reservation_set(target_set_id);
END;
$$;

-- Preserve the reservation-key fence as the first blocking lock, then add the
-- canonical checkout envelope before the existing Payment/resource mutation.
-- This keeps retries compatible while preventing Payment/phase inversion with
-- concurrent cancellation.
ALTER FUNCTION taven_reacquire_phase_reservation_for_capture(
    uuid, uuid, uuid, text, uuid
) RENAME TO taven_reacquire_phase_reservation_after_checkout_lock;

CREATE FUNCTION taven_reacquire_phase_reservation_for_capture(
    previous_phase_reservation_set_id uuid,
    target_node_id uuid,
    target_phase_resource_plan_id uuid,
    target_reservation_key text,
    target_payment_id uuid
)
RETURNS TABLE (
    phase_reservation_set_id uuid,
    phase_reservation_set_status "phase_reservation_set_status",
    expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
    existing_replacement_set "phase_reservation_sets"%ROWTYPE;
    active_checkout_set "phase_reservation_sets"%ROWTYPE;
    target_payment "payments"%ROWTYPE;
    target_phase_id uuid;
    target_order_id uuid;
    payment_order_id uuid;
BEGIN
    IF target_reservation_key IS NULL OR btrim(target_reservation_key) = ''
       OR octet_length(target_reservation_key) > 255 THEN
        RAISE EXCEPTION 'reservation key must be a non-empty value up to 255 bytes'
            USING ERRCODE = '22023', CONSTRAINT = 'phase_reservation_set_reservation_key_input_check';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(target_reservation_key, 0));

    -- A committed replay does not mutate checkout state, so it can return
    -- under the reservation-key fence without joining the Order envelope.
    -- Preserve the original function's identity and terminal checks exactly.
    SELECT * INTO existing_replacement_set
    FROM "phase_reservation_sets"
    WHERE "reservation_key" = target_reservation_key
    FOR UPDATE;
    IF FOUND THEN
        IF existing_replacement_set."node_id" <> target_node_id
           OR existing_replacement_set."phase_resource_plan_id" <> target_phase_resource_plan_id
           OR existing_replacement_set."reacquired_from_phase_reservation_set_id"
                IS DISTINCT FROM previous_phase_reservation_set_id
           OR existing_replacement_set."reacquisition_payment_id"
                IS DISTINCT FROM target_payment_id THEN
            RAISE EXCEPTION 'reservation key is already bound to another reacquisition identity'
                USING ERRCODE = '23505', CONSTRAINT = 'phase_reservation_sets_reacquisition_identity_check';
        END IF;

        IF existing_replacement_set."status" NOT IN ('RESERVED', 'HELD')
           OR (
               existing_replacement_set."status" = 'RESERVED'
               AND existing_replacement_set."expires_at" <= clock_timestamp()
           ) THEN
            RAISE EXCEPTION 'terminal replacement reservation cannot be revived'
                USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_terminal_reacquire_check';
        END IF;

        RETURN QUERY
        SELECT existing_replacement_set."id",
               existing_replacement_set."status",
               existing_replacement_set."expires_at";
        RETURN;
    END IF;

    SELECT payment."order_id" INTO payment_order_id
    FROM "payments" payment
    WHERE payment."id" = target_payment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'capture payment does not exist for reservation reacquisition'
            USING ERRCODE = '23503', CONSTRAINT = 'payments_pkey';
    END IF;

    SELECT phase."id", phase."order_id"
    INTO target_phase_id, target_order_id
    FROM "phase_resource_plans" plan
    JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
    WHERE plan."id" = target_phase_resource_plan_id
      AND plan."node_id" = target_node_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'replacement phase resource plan does not exist for the requested node'
            USING ERRCODE = '23503', CONSTRAINT = 'phase_reservation_sets_phase_resource_plan_id_node_id_fkey';
    END IF;
    IF target_order_id IS DISTINCT FROM payment_order_id THEN
        RAISE EXCEPTION 'replacement reservation must belong to the Payment order'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_capture_reacquire_guard_check';
    END IF;

    PERFORM taven_lock_checkout_payment_envelope(target_payment_id);

    SELECT payment.* INTO target_payment
    FROM "payments" payment
    WHERE payment."id" = target_payment_id;

    -- Different authenticated provider-event IDs can race for the same
    -- Payment and therefore use different reservation keys. The checkout
    -- envelope is the shared serialization fence: reject a second replacement
    -- when one won while this caller was preparing its immutable resource plan.
    -- The service treats this conflict as a resolved reacquisition and lets the
    -- locked provider-event transition validate and capture the winning set.
    IF target_payment."status" = 'PENDING'
       AND target_payment."capture_authorized"
       AND target_payment."capture_cutoff_at" IS NULL
       AND target_payment."checkout_capture_expires_at" > clock_timestamp()
    THEN
        SELECT reservation_set.* INTO active_checkout_set
        FROM "phase_reservation_sets" reservation_set
        JOIN "phase_resource_plans" resource_plan
          ON resource_plan."id" = reservation_set."phase_resource_plan_id"
         AND resource_plan."node_id" = reservation_set."node_id"
        WHERE resource_plan."order_phase_id" = target_phase_id
          AND reservation_set."status" = 'RESERVED'
          AND reservation_set."expires_at" > clock_timestamp()
        ORDER BY reservation_set."created_at" DESC, reservation_set."id" DESC
        LIMIT 1
        FOR UPDATE OF reservation_set;
        IF FOUND THEN
            RAISE EXCEPTION 'checkout Payment already has a live reservation'
                USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_capture_reacquire_guard_check';
        END IF;
    END IF;

    RETURN QUERY
    SELECT *
    FROM taven_reacquire_phase_reservation_after_checkout_lock(
        previous_phase_reservation_set_id,
        target_node_id,
        target_phase_resource_plan_id,
        target_reservation_key,
        target_payment_id
    );
END;
$$;

-- Close one initial checkout attempt and all still-reversible fulfilment work.
-- The canonical checkout envelope is the serialization fence shared with the
-- provider-event transition below, so timeout, customer cancellation, and
-- capture have exactly one winner.
CREATE FUNCTION taven_close_initial_checkout_payment(
    target_payment_id uuid,
    close_reason text,
    close_observed_at timestamptz DEFAULT NULL
)
RETURNS "payment_status"
LANGUAGE plpgsql
AS $$
DECLARE
    target_payment "payments"%ROWTYPE;
    closed_at timestamptz;
    effective_close_reason text := close_reason;
    terminal_order_status "order_status";
BEGIN
    IF close_reason NOT IN (
        'CUSTOMER_CANCELLED', 'CHECKOUT_EXPIRED', 'CAPACITY_UNAVAILABLE'
    ) THEN
        RAISE EXCEPTION 'checkout close reason is invalid'
            USING ERRCODE = '22023', CONSTRAINT = 'checkout_payment_close_reason_check';
    END IF;

    PERFORM taven_lock_checkout_payment_envelope(target_payment_id);

    SELECT * INTO target_payment
    FROM "payments"
    WHERE "id" = target_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'checkout Payment does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'payments_pkey';
    END IF;

    IF target_payment."status" NOT IN ('CREATED', 'PENDING') THEN
        RETURN target_payment."status";
    END IF;

    -- Decide against the locked Payment. A customer cancellation which waited
    -- behind another checkout transition must not win with a timestamp from
    -- before the immutable capture deadline elapsed.
    closed_at := coalesce(close_observed_at, clock_timestamp());
    IF effective_close_reason = 'CUSTOMER_CANCELLED'
       AND target_payment."checkout_capture_expires_at" IS NOT NULL
       AND target_payment."checkout_capture_expires_at" <= closed_at THEN
        effective_close_reason := 'CHECKOUT_EXPIRED';
    END IF;

    IF effective_close_reason = 'CHECKOUT_EXPIRED' THEN
        IF target_payment."checkout_capture_expires_at" IS NULL
           OR target_payment."checkout_capture_expires_at" > closed_at THEN
            RAISE EXCEPTION 'checkout Payment deadline has not elapsed'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
        END IF;
        closed_at := target_payment."checkout_capture_expires_at";
        terminal_order_status := 'EXPIRED';
    ELSIF effective_close_reason = 'CAPACITY_UNAVAILABLE' THEN
        IF target_payment."checkout_capture_expires_at" IS NULL
           OR target_payment."checkout_capture_expires_at" <= closed_at THEN
            RAISE EXCEPTION 'checkout capacity failure must precede the capture deadline'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_window_check';
        END IF;
        IF EXISTS (
            SELECT 1
            FROM "phase_reservation_sets" reservation_set
            JOIN "phase_resource_plans" resource_plan
              ON resource_plan."id" = reservation_set."phase_resource_plan_id"
             AND resource_plan."node_id" = reservation_set."node_id"
            JOIN "order_phases" phase
              ON phase."id" = resource_plan."order_phase_id"
            WHERE phase."order_id" = target_payment."order_id"
              AND reservation_set."status" = 'RESERVED'
              AND reservation_set."expires_at" > closed_at
        ) THEN
            RAISE EXCEPTION 'checkout capacity failure cannot close a live reservation'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_resource_check';
        END IF;
        terminal_order_status := 'CANCELLED';
    ELSE
        terminal_order_status := 'CANCELLED';
    END IF;

    UPDATE "payments"
    SET "status" = 'VOIDED', "capture_authorized" = false,
        "capture_cutoff_at" = closed_at, "updated_at" = closed_at
    WHERE "id" = target_payment_id
      AND "status" IN ('CREATED', 'PENDING');

    UPDATE "inventory_reservations" inventory_reservation
    SET "status" = 'RELEASED', "updated_at" = closed_at
    FROM "production_reservations" production,
         "phase_resource_plans" resource_plan,
         "order_phases" phase
    WHERE inventory_reservation."production_reservation_id" = production."id"
      AND inventory_reservation."node_id" = production."node_id"
      AND production."phase_resource_plan_id" = resource_plan."id"
      AND production."node_id" = resource_plan."node_id"
      AND resource_plan."order_phase_id" = phase."id"
      AND phase."order_id" = target_payment."order_id"
      AND inventory_reservation."status" IN ('RESERVED', 'HELD', 'ALLOCATED');

    UPDATE "capacity_reservations" capacity_reservation
    SET "status" = 'RELEASED', "updated_at" = closed_at
    FROM "production_reservations" production,
         "phase_resource_plans" resource_plan,
         "order_phases" phase
    WHERE capacity_reservation."production_reservation_id" = production."id"
      AND capacity_reservation."node_id" = production."node_id"
      AND production."phase_resource_plan_id" = resource_plan."id"
      AND production."node_id" = resource_plan."node_id"
      AND resource_plan."order_phase_id" = phase."id"
      AND phase."order_id" = target_payment."order_id"
      AND capacity_reservation."status" IN ('RESERVED', 'HELD', 'SCHEDULED');

    UPDATE "production_reservations" production
    SET "status" = 'RELEASED', "updated_at" = closed_at
    FROM "phase_resource_plans" resource_plan,
         "order_phases" phase
    WHERE production."phase_resource_plan_id" = resource_plan."id"
      AND production."node_id" = resource_plan."node_id"
      AND resource_plan."order_phase_id" = phase."id"
      AND phase."order_id" = target_payment."order_id"
      AND production."status" IN ('RESERVED', 'HELD', 'SCHEDULED');

    UPDATE "phase_reservation_sets" reservation_set
    SET "status" = 'RELEASED', "updated_at" = closed_at
    FROM "phase_resource_plans" resource_plan,
         "order_phases" phase
    WHERE reservation_set."phase_resource_plan_id" = resource_plan."id"
      AND reservation_set."node_id" = resource_plan."node_id"
      AND resource_plan."order_phase_id" = phase."id"
      AND phase."order_id" = target_payment."order_id"
      AND reservation_set."status" IN ('BUILDING', 'RESERVED', 'HELD');

    UPDATE "jobs"
    SET "status" = 'CANCELLED', "cancelled_at" = closed_at,
        "cancellation_reason" = 'ORDER_CANCELLED', "updated_at" = closed_at
    WHERE "order_id" = target_payment."order_id"
      AND "status" NOT IN ('CANCELLED', 'FAILED', 'QC_REJECTED');

    UPDATE "shipments"
    SET "status" = 'CANCELLED', "cancelled_at" = closed_at,
        "updated_at" = closed_at
    WHERE "order_id" = target_payment."order_id"
      AND "status" = 'PLANNED';

    UPDATE "fulfilment_slots"
    SET "outcome" = 'CANCELLED', "updated_at" = closed_at
    WHERE "order_id" = target_payment."order_id"
      AND "outcome" = 'PENDING';

    UPDATE "order_phases"
    SET "status" = 'CANCELLED', "cancelled_at" = closed_at,
        "updated_at" = closed_at
    WHERE "order_id" = target_payment."order_id"
      AND "status" = 'QUOTED';

    UPDATE "orders"
    SET "status" = terminal_order_status, "updated_at" = closed_at
    WHERE "id" = target_payment."order_id"
      AND "status" = 'QUOTED';

    INSERT INTO "audit_events" (
        "id", "order_id", "payment_id", "event_type", "actor_kind", "payload",
        "created_at"
    ) VALUES (
        gen_random_uuid(), target_payment."order_id", target_payment_id,
        'checkout.payment_closed', 'SYSTEM',
        jsonb_build_object('reason', effective_close_reason), closed_at
    );

    IF target_payment."provider_intent_id" IS NOT NULL THEN
        INSERT INTO "outbox_messages" (
            "id", "deduplication_key", "aggregate_type", "aggregate_id",
            "message_type", "schema_version", "payload", "status", "attempts",
            "available_at", "created_at", "updated_at"
        ) VALUES (
            gen_random_uuid(),
            'void_payment:v1:' || target_payment."id"::text,
            'Payment', target_payment."id", 'void_payment', 1,
            jsonb_build_object(
                'paymentId', target_payment."id"::text,
                'provider', target_payment."provider",
                'providerIntentId', target_payment."provider_intent_id",
                'action', 'void_payment'
            ), 'PENDING', 0, closed_at, closed_at, closed_at
        ) ON CONFLICT ("deduplication_key") DO NOTHING;
    END IF;

    RETURN 'VOIDED';
END;
$$;

CREATE FUNCTION taven_close_expired_checkout_payments(batch_limit integer)
RETURNS TABLE (payment_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
    candidate_id uuid;
    candidate_status "payment_status";
BEGIN
    IF batch_limit < 1 OR batch_limit > 1000 THEN
        RAISE EXCEPTION 'checkout deadline batch limit is invalid'
            USING ERRCODE = '22023';
    END IF;

    FOR candidate_id IN
        SELECT payment."id"
        FROM "payments" payment
        WHERE payment."role" IN ('FULL', 'DEPOSIT')
          AND payment."status" IN ('CREATED', 'PENDING')
          AND payment."checkout_capture_expires_at" <= clock_timestamp()
        ORDER BY payment."checkout_capture_expires_at", payment."id"
        LIMIT batch_limit
    LOOP
        PERFORM taven_lock_checkout_payment_envelope(candidate_id);
        SELECT payment."status" INTO candidate_status
        FROM "payments" payment
        WHERE payment."id" = candidate_id
          AND payment."status" IN ('CREATED', 'PENDING')
          AND payment."checkout_capture_expires_at" <= clock_timestamp();
        IF FOUND THEN
            PERFORM taven_close_initial_checkout_payment(
                candidate_id, 'CHECKOUT_EXPIRED'
            );
            payment_id := candidate_id;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;

-- Capture must make its current-resource decision while holding every mutable
-- row that can invalidate a reserved production assignment. The reservation
-- set lock serializes the supported release/expiry paths; these child locks
-- also make the validation safe against direct lifecycle updates.
CREATE FUNCTION taven_lock_phase_reservation_set_for_capture(target_set_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM inventory_reservation."id"
    FROM "inventory_reservations" inventory_reservation
    JOIN "production_reservations" production
      ON production."id" = inventory_reservation."production_reservation_id"
    WHERE production."phase_reservation_set_id" = target_set_id
    ORDER BY inventory_reservation."id"
    FOR UPDATE OF inventory_reservation;

    PERFORM capacity_reservation."id"
    FROM "capacity_reservations" capacity_reservation
    JOIN "production_reservations" production
      ON production."id" = capacity_reservation."production_reservation_id"
    WHERE production."phase_reservation_set_id" = target_set_id
    ORDER BY capacity_reservation."id"
    FOR UPDATE OF capacity_reservation;

    PERFORM production."id"
    FROM "production_reservations" production
    WHERE production."phase_reservation_set_id" = target_set_id
    ORDER BY production."id"
    FOR UPDATE;

    PERFORM node."id"
    FROM "nodes" node
    WHERE node."id" IN (
        SELECT production."node_id"
        FROM "production_reservations" production
        WHERE production."phase_reservation_set_id" = target_set_id
    )
    ORDER BY node."id"
    FOR SHARE OF node;

    PERFORM source."id"
    FROM "model_files" source
    WHERE source."id" IN (
        SELECT geometry."source_model_file_id"
        FROM "production_reservations" production
        JOIN "slice_results" slice_result
          ON slice_result."id" = production."slice_result_id"
        JOIN "model_geometries" geometry
          ON geometry."id" = slice_result."model_geometry_id"
        WHERE production."phase_reservation_set_id" = target_set_id
    )
    ORDER BY source."id"
    FOR SHARE OF source;

    PERFORM geometry."id"
    FROM "model_geometries" geometry
    WHERE geometry."id" IN (
        SELECT slice_result."model_geometry_id"
        FROM "production_reservations" production
        JOIN "slice_results" slice_result
          ON slice_result."id" = production."slice_result_id"
        WHERE production."phase_reservation_set_id" = target_set_id
    )
    ORDER BY geometry."id"
    FOR SHARE OF geometry;

    PERFORM profile."id"
    FROM "machine_profiles" profile
    WHERE profile."id" IN (
        SELECT production."machine_profile_id"
        FROM "production_reservations" production
        WHERE production."phase_reservation_set_id" = target_set_id
    )
    ORDER BY profile."id"
    FOR UPDATE OF profile;

    PERFORM machine."id"
    FROM "machines" machine
    WHERE (machine."node_id", machine."id") IN (
        SELECT production."node_id", production."machine_id"
        FROM "production_reservations" production
        WHERE production."phase_reservation_set_id" = target_set_id
    )
    ORDER BY machine."node_id", machine."id"
    FOR UPDATE OF machine;

    PERFORM calibration."id"
    FROM "machine_calibrations" calibration
    WHERE calibration."id" IN (
        SELECT production."machine_calibration_id"
        FROM "production_reservations" production
        WHERE production."phase_reservation_set_id" = target_set_id
    )
    ORDER BY calibration."id"
    FOR UPDATE OF calibration;

    PERFORM inventory."id"
    FROM "inventories" inventory
    WHERE (inventory."node_id", inventory."id") IN (
        SELECT production."node_id", production."inventory_id"
        FROM "production_reservations" production
        WHERE production."phase_reservation_set_id" = target_set_id
    )
    ORDER BY inventory."node_id", inventory."id"
    FOR UPDATE OF inventory;
END;
$$;

-- Reuse the canonical reservation-set validator so capture cannot drift from
-- the eligibility, retention, capacity-window, or completeness invariants.
-- Expected invalidation is a business outcome: return false so the authenticated
-- provider event can be committed together with its compensation record.
CREATE FUNCTION taven_phase_reservation_set_is_capture_eligible(target_set_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM taven_lock_phase_reservation_set_for_capture(target_set_id);
    BEGIN
        PERFORM taven_validate_phase_reservation_set(target_set_id);
    EXCEPTION
        WHEN check_violation THEN
            RETURN false;
    END;
    RETURN true;
END;
$$;

-- Consume one authenticated, normalized provider result. The caller never
-- chooses the Payment: its provider transaction identity does. Duplicates are
-- checked against the immutable receipt and otherwise become a no-op.
CREATE FUNCTION taven_apply_checkout_payment_event(
    event_provider text,
    event_id text,
    event_transaction_id text,
    event_kind "payment_provider_event_kind",
    event_amount_minor bigint,
    event_currency char(3),
    event_occurred_at timestamptz,
    event_evidence jsonb,
    event_capture_context_valid boolean DEFAULT true,
    event_merchant_reference text DEFAULT NULL,
    event_capture_reacquisition_resolved boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    target_payment "payments"%ROWTYPE;
    matched_payment_id uuid;
    existing_event "payment_provider_events"%ROWTYPE;
    target_phase_id uuid;
    active_set_id uuid;
    active_set_expires_at timestamptz;
    active_set_capture_eligible boolean := false;
    capture_evaluated_at timestamptz;
    capture_topology_current boolean := false;
    payment_was_created boolean := false;
    verified_at timestamptz := clock_timestamp();
    receipt_id uuid := gen_random_uuid();
    receipt_payload jsonb;
    created_job_id uuid;
    production_row record;
    refund_id uuid;
    refund_key text;
    compensation_kind text;
BEGIN
    IF event_kind NOT IN (
        'PAYMENT_PENDING', 'PAYMENT_CAPTURED', 'PAYMENT_FAILED'
    ) THEN
        RAISE EXCEPTION 'checkout provider event kind is invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO existing_event
    FROM "payment_provider_events"
    WHERE "provider" = event_provider
      AND "provider_event_id" = event_id;
    IF FOUND THEN
        IF existing_event."provider_transaction_id" IS DISTINCT FROM event_transaction_id
           OR existing_event."kind" IS DISTINCT FROM event_kind
           OR existing_event."amount_minor" IS DISTINCT FROM event_amount_minor
           OR existing_event."currency" IS DISTINCT FROM event_currency THEN
            RAISE EXCEPTION 'provider event identity was reused with different evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
        END IF;
        RETURN 'DUPLICATE';
    END IF;

    SELECT payment.* INTO target_payment
    FROM "payments" payment
    WHERE payment."provider" = event_provider
      AND (
          payment."provider_intent_id" = event_transaction_id
          OR (
              payment."provider_intent_id" IS NULL
              AND event_merchant_reference IS NOT NULL
              AND payment."merchant_reference" = event_merchant_reference
              AND payment."status" IN ('CREATED', 'VOIDED')
          )
          OR (
              payment."provider_intent_id" IS NULL
              AND payment."status" = 'VOIDED'
              AND EXISTS (
                  SELECT 1
                  FROM "outbox_messages" command
                  WHERE command."aggregate_type" = 'Payment'
                    AND command."aggregate_id" = payment."id"
                    AND command."message_type" = 'void_payment'
                    AND command."payload" ->> 'paymentId' = payment."id"::text
                    AND command."payload" ->> 'provider' = event_provider
                    AND command."payload" ->> 'providerIntentId' = event_transaction_id
                    AND command."payload" ->> 'action' = 'void_payment'
              )
          )
      );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'provider transaction does not match a Payment'
            USING ERRCODE = '23503', CONSTRAINT = 'payments_provider_provider_intent_id_key';
    END IF;

    matched_payment_id := target_payment."id";
    PERFORM taven_lock_checkout_payment_envelope(matched_payment_id);

    -- Revalidate the provider locator after acquiring the complete canonical
    -- lock envelope. The initial lookup above intentionally took no row lock.
    SELECT payment.* INTO target_payment
    FROM "payments" payment
    WHERE payment."id" = matched_payment_id
      AND payment."provider" = event_provider
      AND (
          payment."provider_intent_id" = event_transaction_id
          OR (
              payment."provider_intent_id" IS NULL
              AND event_merchant_reference IS NOT NULL
              AND payment."merchant_reference" = event_merchant_reference
              AND payment."status" IN ('CREATED', 'VOIDED')
          )
          OR (
              payment."provider_intent_id" IS NULL
              AND payment."status" = 'VOIDED'
              AND EXISTS (
                  SELECT 1
                  FROM "outbox_messages" command
                  WHERE command."aggregate_type" = 'Payment'
                    AND command."aggregate_id" = payment."id"
                    AND command."message_type" = 'void_payment'
                    AND command."payload" ->> 'paymentId' = payment."id"::text
                    AND command."payload" ->> 'provider' = event_provider
                    AND command."payload" ->> 'providerIntentId' = event_transaction_id
                    AND command."payload" ->> 'action' = 'void_payment'
              )
          )
      )
    FOR UPDATE OF payment;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'provider transaction no longer matches its Payment'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
    END IF;

    -- A duplicate can arrive while the first request owns the Payment lock.
    -- Recheck after that lock so concurrent duplicates return the same result
    -- instead of racing the provider-event uniqueness constraint.
    SELECT * INTO existing_event
    FROM "payment_provider_events"
    WHERE "provider" = event_provider
      AND "provider_event_id" = event_id;
    IF FOUND THEN
        IF existing_event."provider_transaction_id" IS DISTINCT FROM event_transaction_id
           OR existing_event."kind" IS DISTINCT FROM event_kind
           OR existing_event."amount_minor" IS DISTINCT FROM event_amount_minor
           OR existing_event."currency" IS DISTINCT FROM event_currency THEN
            RAISE EXCEPTION 'provider event identity was reused with different evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
        END IF;
        RETURN 'DUPLICATE';
    END IF;

    PERFORM 1 FROM "orders"
    WHERE "id" = target_payment."order_id" FOR UPDATE;

    IF target_payment."requested_amount_minor" IS DISTINCT FROM event_amount_minor
       OR target_payment."currency" IS DISTINCT FROM event_currency THEN
        RAISE EXCEPTION 'provider amount or currency does not match the Payment'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
    END IF;
    IF target_payment."merchant_reference" IS NOT NULL
       AND event_merchant_reference IS DISTINCT FROM
           target_payment."merchant_reference" THEN
        RAISE EXCEPTION 'provider merchant reference does not match the Payment command'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
    END IF;

    payment_was_created := target_payment."status" = 'CREATED';

    -- A create request can be accepted even when its HTTP response is lost.
    -- The provider-authenticated merchant reference binds that intent back to
    -- the one durable checkout command before any provider event is applied.
    IF target_payment."status" = 'CREATED' THEN
        UPDATE "payments"
        SET "status" = 'PENDING',
            "provider_intent_id" = event_transaction_id,
            "updated_at" = verified_at
        WHERE "id" = target_payment."id";
        SELECT * INTO target_payment FROM "payments"
        WHERE "id" = target_payment."id" FOR UPDATE;
    END IF;

    receipt_payload := jsonb_build_object(
        'paymentId', target_payment."id"::text,
        'providerEventId', event_id,
        'providerTransactionId', event_transaction_id,
        'merchantReference', event_merchant_reference,
        'kind', event_kind::text,
        'amountMinor', event_amount_minor::text,
        'currency', event_currency,
        'evidence', coalesce(event_evidence, '{}'::jsonb)
    );

    IF event_kind = 'PAYMENT_CAPTURED' THEN
        SELECT phase."id" INTO target_phase_id
        FROM "order_phases" phase
        WHERE phase."order_id" = target_payment."order_id"
          AND phase."kind" = 'SINGLE'
        FOR UPDATE;

        SELECT reservation_set."id", reservation_set."expires_at"
        INTO active_set_id, active_set_expires_at
        FROM "phase_reservation_sets" reservation_set
        JOIN "phase_resource_plans" resource_plan
          ON resource_plan."id" = reservation_set."phase_resource_plan_id"
         AND resource_plan."node_id" = reservation_set."node_id"
        WHERE resource_plan."order_phase_id" = target_phase_id
          AND reservation_set."status" = 'RESERVED'
        ORDER BY reservation_set."created_at" DESC, reservation_set."id" DESC
        LIMIT 1
        FOR UPDATE OF reservation_set;

        IF active_set_id IS NOT NULL
           AND active_set_expires_at > clock_timestamp() THEN
            active_set_capture_eligible :=
                taven_phase_reservation_set_is_capture_eligible(active_set_id);
        END IF;

        -- Reservation validation can itself wait for resource locks. Take the
        -- liveness timestamp only after the entire capture lock envelope has
        -- been acquired so a wait which crosses the immutable TTL cannot turn
        -- a recoverable capture into compensation.
        capture_evaluated_at := clock_timestamp();

        SELECT EXISTS (
            SELECT 1
            FROM "orders" target_order
            JOIN "order_active_price_bindings" active_binding
              ON active_binding."order_id" = target_order."id"
            JOIN "order_price_bindings" binding
              ON binding."id" = active_binding."order_price_binding_id"
             AND binding."order_id" = target_order."id"
            JOIN "automatic_quote_drafts" draft
              ON draft."order_id" = target_order."id"
            WHERE target_order."id" = target_payment."order_id"
              AND target_order."status" = 'QUOTED'
              AND binding."id" = target_payment."order_price_binding_id"
              AND binding."price_snapshot_id" =
                  target_payment."price_snapshot_id"
              AND binding."invalidated_at" IS NULL
              AND binding."delivery_destination_id" =
                  draft."selected_delivery_destination_id"
        ) INTO capture_topology_current;

        -- The service preflight can observe a live set immediately before its
        -- immutable TTL elapses. Let it reacquire from the longer checkout
        -- window before consuming real-money evidence or compensating.
        IF target_payment."status" = 'PENDING'
           AND target_payment."capture_authorized"
           AND target_payment."capture_cutoff_at" IS NULL
           AND target_payment."checkout_capture_expires_at" >
               capture_evaluated_at
           AND event_capture_context_valid
           AND capture_topology_current
           AND target_phase_id IS NOT NULL
           AND (active_set_id IS NULL
                OR active_set_expires_at <= capture_evaluated_at)
           AND NOT payment_was_created
           AND NOT event_capture_reacquisition_resolved THEN
            RETURN 'REACQUIRE_REQUIRED';
        END IF;
    END IF;

    INSERT INTO "payment_provider_events" (
        "id", "payment_id", "refund_transaction_id", "provider",
        "provider_event_id", "provider_transaction_id", "kind",
        "amount_minor", "currency", "payload", "payload_hash",
        "occurred_at", "authenticated_at", "verified_at", "created_at"
    ) VALUES (
        receipt_id, target_payment."id", NULL, event_provider,
        event_id, event_transaction_id, event_kind,
        event_amount_minor, event_currency, receipt_payload,
        encode(sha256(convert_to(receipt_payload::text, 'UTF8')), 'hex'),
        event_occurred_at, verified_at,
        coalesce(capture_evaluated_at, verified_at),
        coalesce(capture_evaluated_at, verified_at)
    );

    IF event_kind = 'PAYMENT_PENDING' THEN
        RETURN CASE WHEN target_payment."status" = 'PENDING'
                    THEN 'PENDING' ELSE 'IGNORED_TERMINAL' END;
    END IF;

    IF event_kind = 'PAYMENT_FAILED' THEN
        IF target_payment."status" = 'PENDING' THEN
            UPDATE "payments"
            SET "status" = 'FAILED', "capture_authorized" = false,
                "capture_cutoff_at" = verified_at, "updated_at" = verified_at
            WHERE "id" = target_payment."id";
            RETURN 'FAILED';
        END IF;
        RETURN 'IGNORED_TERMINAL';
    END IF;

    IF target_payment."status" = 'PENDING'
       AND target_payment."capture_authorized"
       AND target_payment."capture_cutoff_at" IS NULL
       AND target_payment."checkout_capture_expires_at" > capture_evaluated_at
       AND event_capture_context_valid
       AND active_set_id IS NOT NULL
       AND active_set_expires_at > capture_evaluated_at
       AND active_set_capture_eligible
       AND capture_topology_current THEN
        UPDATE "payments"
        SET "status" = 'CAPTURED',
            "captured_amount_minor" = "requested_amount_minor",
            "provider_capture_id" = event_transaction_id,
            "captured_at" = capture_evaluated_at,
            "updated_at" = capture_evaluated_at
        WHERE "id" = target_payment."id";

        UPDATE "inventory_reservations" inventory_reservation
        SET "status" = 'HELD', "updated_at" = capture_evaluated_at
        FROM "production_reservations" production
        WHERE production."phase_reservation_set_id" = active_set_id
          AND inventory_reservation."production_reservation_id" = production."id"
          AND inventory_reservation."node_id" = production."node_id"
          AND inventory_reservation."status" = 'RESERVED';

        UPDATE "capacity_reservations" capacity_reservation
        SET "status" = 'HELD', "updated_at" = capture_evaluated_at
        FROM "production_reservations" production
        WHERE production."phase_reservation_set_id" = active_set_id
          AND capacity_reservation."production_reservation_id" = production."id"
          AND capacity_reservation."node_id" = production."node_id"
          AND capacity_reservation."status" = 'RESERVED';

        FOR production_row IN
            SELECT production."id" AS production_id,
                   production."node_id", production."phase_resource_plan_job_id",
                   candidate."shipment_plan_id"
            FROM "production_reservations" production
            JOIN "phase_resource_plan_jobs" plan_job
              ON plan_job."id" = production."phase_resource_plan_job_id"
             AND plan_job."node_id" = production."node_id"
            JOIN "candidate_resource_estimates" candidate
              ON candidate."id" = plan_job."candidate_resource_estimate_id"
             AND candidate."node_id" = plan_job."node_id"
            WHERE production."phase_reservation_set_id" = active_set_id
              AND production."status" = 'RESERVED'
            ORDER BY production."id"
        LOOP
            created_job_id := gen_random_uuid();
            INSERT INTO "jobs" (
                "id", "node_id", "order_id", "order_phase_id",
                "shipment_plan_id", "phase_resource_plan_job_id", "status",
                "created_at", "updated_at"
            ) VALUES (
                created_job_id, production_row."node_id", target_payment."order_id",
                target_phase_id, production_row."shipment_plan_id",
                production_row."phase_resource_plan_job_id", 'CREATED',
                capture_evaluated_at, capture_evaluated_at
            );
            UPDATE "production_reservations"
            SET "status" = 'HELD', "job_id" = created_job_id,
                "updated_at" = capture_evaluated_at
            WHERE "id" = production_row."production_id";
        END LOOP;

        UPDATE "phase_reservation_sets"
        SET "status" = 'HELD', "updated_at" = capture_evaluated_at
        WHERE "id" = active_set_id;
        UPDATE "orders"
        SET "status" = 'CONFIRMED', "confirmed_at" = capture_evaluated_at,
            "updated_at" = capture_evaluated_at
        WHERE "id" = target_payment."order_id";
        UPDATE "order_phases"
        SET "status" = 'ACTIVE', "activated_at" = capture_evaluated_at,
            "updated_at" = capture_evaluated_at
        WHERE "id" = target_phase_id;
        RETURN 'CAPTURED';
    END IF;

    -- A verified capture after any terminal winner is real money and must be
    -- compensated exactly once. Close still-open order work before recording
    -- the capture so no Job can be activated from the late event.
    IF target_payment."status" = 'PENDING' THEN
        -- CAPACITY_UNAVAILABLE normally means no live reservation exists. A
        -- set that failed the locked eligibility check is still live by status,
        -- so release it first and let the common close path finish the order.
        IF event_capture_context_valid
           AND active_set_id IS NOT NULL
           AND active_set_expires_at > capture_evaluated_at
           AND NOT active_set_capture_eligible THEN
            PERFORM taven_release_phase_reservation_set(active_set_id);
        END IF;
        PERFORM taven_close_initial_checkout_payment(
            target_payment."id",
            CASE WHEN target_payment."checkout_capture_expires_at" <=
                           capture_evaluated_at
                 THEN 'CHECKOUT_EXPIRED'
                 WHEN event_capture_context_valid
                      AND (active_set_id IS NULL
                           OR active_set_expires_at <= capture_evaluated_at
                           OR NOT active_set_capture_eligible)
                 THEN 'CAPACITY_UNAVAILABLE'
                 ELSE 'CUSTOMER_CANCELLED' END,
            capture_evaluated_at
        );
        SELECT * INTO target_payment FROM "payments"
        WHERE "id" = target_payment."id" FOR UPDATE;
    END IF;

    IF target_payment."status" IN ('FAILED', 'VOIDED') THEN
        SELECT CASE audit_event."payload" ->> 'reason'
                   WHEN 'CHECKOUT_EXPIRED' THEN 'initial_checkout_expired'
                   WHEN 'CAPACITY_UNAVAILABLE' THEN 'initial_checkout_capacity'
                   ELSE 'initial_checkout_cancelled'
               END
        INTO compensation_kind
        FROM "audit_events" audit_event
        WHERE audit_event."payment_id" = target_payment."id"
          AND audit_event."event_type" = 'checkout.payment_closed'
        ORDER BY audit_event."created_at" DESC, audit_event."id" DESC
        LIMIT 1;
        compensation_kind := coalesce(
            compensation_kind,
            CASE
                WHEN target_payment."checkout_capture_expires_at" <=
                     target_payment."capture_cutoff_at"
                THEN 'initial_checkout_expired'
                ELSE 'initial_checkout_cancelled'
            END
        );

        UPDATE "payments"
        SET "status" = 'REFUND_PENDING',
            "captured_amount_minor" = "requested_amount_minor",
            "provider_capture_id" = event_transaction_id,
            "captured_at" = capture_evaluated_at,
            "updated_at" = capture_evaluated_at
        WHERE "id" = target_payment."id";

        refund_id := gen_random_uuid();
        refund_key := 'late_initial_capture:' || encode(
            sha256(convert_to(event_provider || ':' || event_id, 'UTF8')),
            'hex'
        );
        INSERT INTO "refund_transactions" (
            "id", "payment_id", "idempotency_key", "provider",
            "amount_minor", "reason", "status", "requested_at",
            "created_at", "updated_at"
        ) VALUES (
            refund_id, target_payment."id",
            refund_key, event_provider,
            event_amount_minor, 'LATE_CAPTURE_COMPENSATION', 'PENDING',
            capture_evaluated_at, capture_evaluated_at, capture_evaluated_at
        ) ON CONFLICT ("payment_id", "idempotency_key") DO NOTHING;

        INSERT INTO "audit_events" (
            "id", "order_id", "payment_id", "refund_transaction_id",
            "event_type", "actor_kind", "idempotency_key", "payload",
            "created_at"
        ) VALUES (
            gen_random_uuid(), target_payment."order_id", target_payment."id",
            refund_id, 'checkout.late_capture_compensation_created', 'SYSTEM',
            refund_key, jsonb_build_object(
                'kind', compensation_kind,
                'providerEventId', event_id,
                'providerTransactionId', event_transaction_id,
                'amountMinor', event_amount_minor::text,
                'currency', event_currency
            ), capture_evaluated_at
        );

        INSERT INTO "outbox_messages" (
            "id", "deduplication_key", "aggregate_type", "aggregate_id",
            "message_type", "schema_version", "payload", "status", "attempts",
            "available_at", "created_at", "updated_at"
        ) VALUES (
            gen_random_uuid(), 'refund_payment:v1:' || refund_id::text,
            'RefundTransaction', refund_id, 'refund_payment', 1,
            jsonb_build_object(
                'refundTransactionId', refund_id::text,
                'paymentId', target_payment."id"::text,
                'provider', event_provider,
                'providerIntentId', event_transaction_id,
                'amountMinor', event_amount_minor::text,
                'currency', event_currency,
                'idempotencyKey', refund_key,
                'compensationKind', compensation_kind,
                'action', 'refund_payment'
            ), 'PENDING', 0, capture_evaluated_at, capture_evaluated_at,
            capture_evaluated_at
        ) ON CONFLICT ("deduplication_key") DO NOTHING;
        RETURN 'REFUND_PENDING';
    END IF;

    RETURN 'IGNORED_TERMINAL';
END;
$$;

CREATE FUNCTION taven_apply_checkout_refund_success(
    target_refund_id uuid,
    refund_provider_id text,
    refund_event_id text,
    refund_occurred_at timestamptz,
    refund_evidence jsonb
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    target_refund "refund_transactions"%ROWTYPE;
    target_payment "payments"%ROWTYPE;
    target_payment_id uuid;
    existing_event "payment_provider_events"%ROWTYPE;
    receipt_id uuid := gen_random_uuid();
    verified_at timestamptz := clock_timestamp();
    receipt_payload jsonb;
BEGIN
    SELECT refund."payment_id" INTO target_payment_id
    FROM "refund_transactions" refund
    WHERE refund."id" = target_refund_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'refund transaction does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'refund_transactions_pkey';
    END IF;

    PERFORM taven_lock_checkout_payment_envelope(target_payment_id);

    SELECT * INTO target_refund FROM "refund_transactions"
    WHERE "id" = target_refund_id
      AND "payment_id" = target_payment_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'refund transaction identity changed during lock acquisition'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_transactions_payment_binding_immutable_check';
    END IF;
    SELECT * INTO target_payment FROM "payments"
    WHERE "id" = target_payment_id FOR UPDATE;

    IF target_refund."status" = 'SUCCEEDED' THEN
        RETURN false;
    END IF;

    SELECT * INTO existing_event
    FROM "payment_provider_events"
    WHERE "provider" = target_payment."provider"
      AND "provider_event_id" = refund_event_id;
    IF FOUND THEN
        IF existing_event."payment_id" IS DISTINCT FROM target_payment."id"
           OR existing_event."refund_transaction_id" IS DISTINCT FROM target_refund."id"
           OR existing_event."provider_transaction_id" IS DISTINCT FROM refund_provider_id
           OR existing_event."kind" IS DISTINCT FROM 'REFUND_SUCCEEDED'::"payment_provider_event_kind"
           OR existing_event."amount_minor" IS DISTINCT FROM target_refund."amount_minor"
           OR existing_event."currency" IS DISTINCT FROM target_payment."currency" THEN
            RAISE EXCEPTION 'refund provider event identity was reused with different evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_event_scope_check';
        END IF;
        receipt_id := existing_event."id";
        verified_at := existing_event."verified_at";
    END IF;

    receipt_payload := jsonb_build_object(
        'paymentId', target_payment."id"::text,
        'refundTransactionId', target_refund."id"::text,
        'providerEventId', refund_event_id,
        'providerTransactionId', refund_provider_id,
        'kind', 'REFUND_SUCCEEDED',
        'amountMinor', target_refund."amount_minor"::text,
        'currency', target_payment."currency",
        'evidence', coalesce(refund_evidence, '{}'::jsonb)
    );
    INSERT INTO "payment_provider_events" (
        "id", "payment_id", "refund_transaction_id", "provider",
        "provider_event_id", "provider_transaction_id", "kind",
        "amount_minor", "currency", "payload", "payload_hash",
        "occurred_at", "authenticated_at", "verified_at", "created_at"
    )
    SELECT receipt_id, target_payment."id", target_refund."id",
        target_payment."provider", refund_event_id, refund_provider_id,
        'REFUND_SUCCEEDED', target_refund."amount_minor", target_payment."currency",
        receipt_payload,
        encode(sha256(convert_to(receipt_payload::text, 'UTF8')), 'hex'),
        refund_occurred_at, verified_at, verified_at, verified_at
    WHERE existing_event."id" IS NULL;

    UPDATE "refund_transactions"
    SET "status" = 'SUCCEEDED', "provider_refund_id" = refund_provider_id,
        "provider_result_event_id" = receipt_id, "completed_at" = verified_at,
        "updated_at" = verified_at
    WHERE "id" = target_refund."id";
    UPDATE "payments"
    SET "status" = 'REFUNDED', "updated_at" = verified_at
    WHERE "id" = target_payment."id";
    RETURN true;
END;
$$;

COMMIT;
