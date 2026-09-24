-- Accepted individual orders remain DRAFT during resource preparation.
-- Permit their first immutable contact snapshot before any payment exists.
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

  -- Keep the established QUOTED checkout path for automatic orders; only
  -- individual orders may also freeze their contact while still DRAFT.
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
     AND (
       (OLD."status" = 'QUOTED' AND NEW."status" = 'QUOTED')
       OR (OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT'
           AND EXISTS (
             SELECT 1 FROM "individual_order_origins" origin
             WHERE origin."order_id" = OLD."id"
           ))
     )
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
     AND (
       (OLD."status" = 'QUOTED' AND NEW."status" = 'QUOTED')
       OR (OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT'
           AND EXISTS (
             SELECT 1 FROM "individual_order_origins" origin
             WHERE origin."order_id" = OLD."id"
           ))
     )
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


-- The verified capture transition accepts the same frozen topology for either origin.
CREATE OR REPLACE FUNCTION taven_apply_checkout_payment_event(
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
            LEFT JOIN "automatic_quote_drafts" draft
              ON draft."order_id" = target_order."id"
            WHERE target_order."id" = target_payment."order_id"
              AND target_order."status" = 'QUOTED'
              AND binding."id" = target_payment."order_price_binding_id"
              AND binding."price_snapshot_id" =
                  target_payment."price_snapshot_id"
              AND binding."invalidated_at" IS NULL
              AND (
                  binding."delivery_destination_id" =
                      draft."selected_delivery_destination_id"
                  OR (
                      target_order."accepted_order_price_binding_id" = binding."id"
                      AND EXISTS (
                          SELECT 1
                          FROM "individual_order_origins" origin
                          JOIN "quotes" quote ON quote."id" = origin."quote_id"
                          JOIN "quote_price_bindings" quote_binding
                            ON quote_binding."quote_id" = quote."id"
                          JOIN "quote_delivery_destinations" accepted_destination
                            ON accepted_destination."quote_id" = quote."id"
                          JOIN "delivery_destinations" order_destination
                            ON order_destination."id" = binding."delivery_destination_id"
                           AND order_destination."order_id" = target_order."id"
                          WHERE origin."order_id" = target_order."id"
                            AND quote_binding."price_snapshot_id" = binding."price_snapshot_id"
                            AND accepted_destination."provider_endpoint_id" = order_destination."provider_endpoint_id"
                            AND accepted_destination."endpoint_type" = order_destination."endpoint_type"
                            AND accepted_destination."address_snapshot" = order_destination."address_snapshot"
                            AND accepted_destination."capability_snapshot" = order_destination."capability_snapshot"
                      )
                  )
              )
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
