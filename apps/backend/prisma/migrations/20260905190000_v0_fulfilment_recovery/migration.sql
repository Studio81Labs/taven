ALTER TYPE "order_status" ADD VALUE 'RECOVERY_PENDING';
ALTER TYPE "order_phase_status" ADD VALUE 'RECOVERY_PENDING';
ALTER TYPE "order_phase_status" ADD VALUE 'PARTIALLY_FULFILLED';
ALTER TYPE "shipment_status" ADD VALUE 'LOST';
ALTER TYPE "shipment_status" ADD VALUE 'RETURNED';
ALTER TYPE "shipment_status" ADD VALUE 'RECOVERED';
ALTER TYPE "shipment_provider_event_kind" ADD VALUE 'LOST';
ALTER TYPE "shipment_provider_event_kind" ADD VALUE 'RETURNED';
ALTER TYPE "shipment_provider_event_kind" ADD VALUE 'RECOVERED';
ALTER TYPE "refund_reason" ADD VALUE 'EXPRESS_BREACH';
ALTER TYPE "refund_reason" ADD VALUE 'SHIPMENT_INCIDENT';
ALTER TYPE "refund_reason" ADD VALUE 'POST_DELIVERY_ISSUE';
ALTER TYPE "outbox_status" ADD VALUE 'SUPERSEDED';

ALTER TABLE "orders" DROP CONSTRAINT "orders_timestamps_check";
ALTER TABLE "orders" ADD CONSTRAINT "orders_timestamps_check" CHECK (
    ("quoted_at" IS NULL OR "quoted_at" >= "created_at" - interval '5 seconds')
    AND ("confirmed_at" IS NULL OR ("quoted_at" IS NOT NULL AND "confirmed_at" >= "quoted_at"))
    AND (
        "withdrawal_exception_acknowledged_at" IS NULL
        OR (
            "quoted_at" IS NOT NULL
            AND "withdrawal_exception_acknowledged_at" >= "quoted_at"
        )
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
        OR (
            "status" IN ('CANCELLED', 'REFUNDED', 'CANCELLED_SETTLED')
            AND "quoted_at" IS NOT NULL
        )
    )
);

CREATE OR REPLACE FUNCTION taven_protect_delivered_outbox_message()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" IN ('DELIVERED', 'SUPERSEDED') AND (
        NEW."status" IS DISTINCT FROM OLD."status" OR
        NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
    ) THEN
        RAISE EXCEPTION 'terminal outbox message % cannot be requeued or redelivered', OLD."id"
            USING ERRCODE = '23514', CONSTRAINT = 'outbox_messages_delivered_terminal_check';
    END IF;

    RETURN NEW;
END;
$$;

-- Cancellation refunds reserve only the capture balance not already committed by
-- another active refund. Keep the order-level obligation aligned with the same
-- PENDING/SUSPENDED/SUCCEEDED accounting used by the capture guard.
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
             AND refund."status" IN ('PENDING', 'SUSPENDED', 'SUCCEEDED')
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
                          WHERE refund."status" IN ('PENDING', 'SUSPENDED')
                      ), 0) AS active_pending_total
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
                 (
                     payment."captured_amount_minor"
                       - refund_totals.succeeded_total = 0
                     AND payment."status" = 'REFUNDED'
                 )
                 OR (
                     payment."captured_amount_minor"
                       - refund_totals.succeeded_total > 0
                     AND refund_totals.active_pending_total
                       = payment."captured_amount_minor"
                         - refund_totals.succeeded_total
                     AND payment."status" = 'REFUND_PENDING'
                 )
                 OR (
                     payment."captured_amount_minor"
                       - refund_totals.succeeded_total
                       - refund_totals.active_pending_total > 0
                     AND latest_customer_cancellation_refund."status"
                       IS NOT DISTINCT FROM 'FAILED'::"refund_status"
                     AND latest_customer_cancellation_refund."amount_minor"
                       = payment."captured_amount_minor"
                         - refund_totals.succeeded_total
                         - refund_totals.active_pending_total
                     AND payment."status" = CASE
                         WHEN refund_totals.active_pending_total > 0
                             THEN 'REFUND_PENDING'::"payment_status"
                         WHEN refund_totals.succeeded_total = 0
                             THEN 'CAPTURED'::"payment_status"
                         ELSE 'PARTIALLY_REFUNDED'::"payment_status"
                     END
                 )
             )
       ) THEN
        RAISE EXCEPTION 'ordinary cancelled orders require complete customer-cancellation refund work for every captured payment'
            USING ERRCODE = '23514', CONSTRAINT = 'order_customer_cancellation_refund_obligation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION taven_reconcile_payment_capture_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_payment_id uuid;
    target_order_status "order_status";
BEGIN
    -- BALANCE capture is a post-QC readiness transition.  It must never
    -- recreate or reactivate the initial reservation topology.
    IF TG_TABLE_NAME = 'payments'
       AND (to_jsonb(NEW) ->> 'role') = 'BALANCE' THEN
        RETURN NULL;
    END IF;

    CASE TG_TABLE_NAME
        WHEN 'payments' THEN
            target_order_id := (to_jsonb(NEW) ->> 'order_id')::uuid;
            target_payment_id := (to_jsonb(NEW) ->> 'id')::uuid;
        WHEN 'orders' THEN
            target_order_id := (to_jsonb(NEW) ->> 'id')::uuid;
        WHEN 'order_phases' THEN
            target_order_id := (to_jsonb(NEW) ->> 'order_id')::uuid;
        ELSE
            SELECT phase."order_id"
            INTO target_order_id
            FROM "phase_reservation_sets" reservation_set
            JOIN "phase_resource_plans" plan
              ON plan."id" = reservation_set."phase_resource_plan_id"
             AND plan."node_id" = reservation_set."node_id"
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE reservation_set."id" = (to_jsonb(NEW) ->> 'id')::uuid;
    END CASE;

    SELECT "status"
    INTO target_order_status
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    -- Initial capture activation has already been reconciled once an order
    -- enters fulfilment recovery. A replacement reservation must still use
    -- the reservation lifecycle guards, but it must not be judged as a
    -- second checkout activation topology.
    IF TG_TABLE_NAME = 'phase_reservation_sets'
       AND target_order_status <> 'CONFIRMED' THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "orders" target_order
        JOIN "order_phases" phase
          ON phase."order_id" = target_order."id"
         AND phase."kind" = 'SINGLE'
         AND phase."status" = 'ACTIVE'
         AND phase."activated_at" IS NOT NULL
        JOIN "payments" payment
          ON payment."order_id" = target_order."id"
         AND payment."status" = 'CAPTURED'
         AND payment."role" IN ('FULL', 'DEPOSIT')
         AND payment."captured_amount_minor" = payment."requested_amount_minor"
        JOIN "order_active_price_bindings" active_binding
          ON active_binding."order_id" = target_order."id"
         AND active_binding."order_price_binding_id" = payment."order_price_binding_id"
        JOIN "phase_resource_plans" resource_plan
          ON resource_plan."order_phase_id" = phase."id"
         AND resource_plan."expires_at" > clock_timestamp()
        JOIN "phase_reservation_sets" reservation_set
          ON reservation_set."phase_resource_plan_id" = resource_plan."id"
         AND reservation_set."node_id" = resource_plan."node_id"
         AND reservation_set."status" = 'HELD'
         AND reservation_set."expires_at" > clock_timestamp()
        WHERE target_order."id" = target_order_id
          AND target_order."status" = 'CONFIRMED'
          AND target_order."confirmed_at" IS NOT NULL
          AND target_order."accepted_order_price_binding_id" = payment."order_price_binding_id"
          AND target_order."accepted_terms_revision" IS NOT NULL
          AND taven_order_accepts_bound_price_list_terms(
              target_order."id", payment."order_price_binding_id"
          )
          AND target_order."accepted_claim_policy_revision" IS NOT NULL
          AND target_order."withdrawal_exception_acknowledged_at" IS NOT NULL
          AND target_order."confirmed_at" >= payment."captured_at" - interval '5 seconds'
          AND phase."activated_at" >= payment."captured_at" - interval '5 seconds'
          AND (target_payment_id IS NULL OR payment."id" = target_payment_id)
          AND (
              SELECT count(*)
              FROM "phase_reservation_sets" held_set
              JOIN "phase_resource_plans" held_plan
                ON held_plan."id" = held_set."phase_resource_plan_id"
               AND held_plan."node_id" = held_set."node_id"
              WHERE held_plan."order_phase_id" = phase."id"
                AND held_set."status" = 'HELD'
          ) = 1
          AND EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              JOIN "candidate_resource_estimates" candidate
                ON candidate."id" = plan_job."candidate_resource_estimate_id"
               AND candidate."node_id" = plan_job."node_id"
              JOIN "shipment_plans" candidate_plan
                ON candidate_plan."id" = candidate."shipment_plan_id"
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
                AND candidate_plan."order_price_binding_id" IS DISTINCT FROM payment."order_price_binding_id"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "phase_reservation_sets" competing_set
              JOIN "phase_resource_plans" competing_plan
                ON competing_plan."id" = competing_set."phase_resource_plan_id"
               AND competing_plan."node_id" = competing_set."node_id"
              WHERE competing_plan."order_phase_id" = phase."id"
                AND competing_set."id" <> reservation_set."id"
                AND competing_set."status" IN ('BUILDING', 'RESERVED', 'HELD')
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              LEFT JOIN "production_reservations" production
                ON production."phase_reservation_set_id" = reservation_set."id"
               AND production."phase_resource_plan_job_id" = plan_job."id"
               AND production."node_id" = plan_job."node_id"
              LEFT JOIN "jobs" job
                ON job."id" = production."job_id"
               AND job."node_id" = production."node_id"
               AND job."phase_resource_plan_job_id" = production."phase_resource_plan_job_id"
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
                AND (
                    production."id" IS NULL
                    OR production."status" <> 'HELD'
                    OR production."job_id" IS NULL
                    OR job."id" IS NULL
                    OR job."order_id" <> target_order."id"
                    OR job."order_phase_id" <> phase."id"
                    OR job."status" <> 'CREATED'
                    OR NOT EXISTS (
                        SELECT 1
                        FROM "inventory_reservations" inventory_reservation
                        WHERE inventory_reservation."production_reservation_id" = production."id"
                          AND inventory_reservation."node_id" = production."node_id"
                          AND inventory_reservation."status" = 'HELD'
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM "inventory_reservations" inventory_reservation
                        WHERE inventory_reservation."production_reservation_id" = production."id"
                          AND inventory_reservation."node_id" = production."node_id"
                          AND inventory_reservation."status" <> 'HELD'
                    )
                    OR NOT EXISTS (
                        SELECT 1
                        FROM "capacity_reservations" capacity_reservation
                        WHERE capacity_reservation."production_reservation_id" = production."id"
                          AND capacity_reservation."node_id" = production."node_id"
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM "capacity_reservations" capacity_reservation
                        WHERE capacity_reservation."production_reservation_id" = production."id"
                          AND capacity_reservation."node_id" = production."node_id"
                          AND capacity_reservation."status" <> 'HELD'
                    )
                )
          )
    ) THEN
        RAISE EXCEPTION 'captured payment requires atomic order, phase, reservation, and Job activation'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_capture_activation_check';
    END IF;

    RETURN NULL;
END;
$$;

-- Incident events extend the original provider-event state machine. Keep the
-- original broad guards stable and add the incident-specific scope,
-- chronology, and atomic-consumption requirements here.
CREATE FUNCTION taven_validate_shipment_incident_provider_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_status "shipment_status";
    target_carrier varchar(100);
    target_label_id varchar(255);
    target_handed_over_at timestamptz;
BEGIN
    SELECT shipment."status", shipment."carrier", shipment."carrier_label_id",
           shipment."handed_over_at"
    INTO target_status, target_carrier, target_label_id,
         target_handed_over_at
    FROM "shipments" shipment
    WHERE shipment."id" = NEW."shipment_id"
    FOR UPDATE;

    IF NOT FOUND
       OR NEW."outbox_message_id" IS NOT NULL
       OR NEW."carrier" IS DISTINCT FROM target_carrier
       OR NEW."carrier_label_id" IS DISTINCT FROM target_label_id
       OR NEW."source_shipment_status" IS DISTINCT FROM target_status
       OR (NEW."kind" IN ('LOST', 'RETURNED')
           AND target_status <> 'IN_TRANSIT')
       OR (NEW."kind" = 'RECOVERED' AND target_status <> 'LOST') THEN
        RAISE EXCEPTION 'Shipment incident provider event must match the exact lifecycle scope without an outbox command'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_provider_event_scope_check';
    END IF;

    IF target_handed_over_at IS NULL
       OR NEW."occurred_at" < target_handed_over_at - interval '5 seconds'
       OR (NEW."kind" = 'RECOVERED' AND NOT EXISTS (
           SELECT 1
           FROM "shipment_provider_events" lost_event
           WHERE lost_event."shipment_id" = NEW."shipment_id"
             AND lost_event."kind" = 'LOST'
             AND lost_event."carrier" = NEW."carrier"
             AND lost_event."carrier_label_id" = NEW."carrier_label_id"
             AND lost_event."occurred_at" <= NEW."occurred_at" + interval '5 seconds'
       )) THEN
        RAISE EXCEPTION 'Shipment incident provider event timestamps must follow handoff and incident chronology'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_provider_event_evidence_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE TRIGGER "shipment_provider_events_zz_incident_scope_validated"
AFTER INSERT ON "shipment_provider_events"
FOR EACH ROW
WHEN (NEW."kind" IN ('LOST', 'RETURNED', 'RECOVERED'))
EXECUTE FUNCTION taven_validate_shipment_incident_provider_event();

CREATE FUNCTION taven_reconcile_shipment_incident_provider_event_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "shipments" shipment
        WHERE shipment."id" = NEW."shipment_id"
          AND shipment."carrier" = NEW."carrier"
          AND shipment."carrier_label_id" = NEW."carrier_label_id"
          AND shipment."status"::text = NEW."kind"::text
    ) THEN
        RAISE EXCEPTION 'Shipment incident provider event and its lifecycle outcome must commit atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_provider_event_consumption_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "shipment_provider_events_zz_incident_consumed"
AFTER INSERT ON "shipment_provider_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."kind" IN ('LOST', 'RETURNED', 'RECOVERED'))
EXECUTE FUNCTION taven_reconcile_shipment_incident_provider_event_consumption();

CREATE TYPE "replacement_request_reason" AS ENUM ('JOB_FAILED', 'QC_REJECTED');
CREATE TYPE "replacement_request_status" AS ENUM ('OPEN', 'JOB_CREATED', 'REFUND_REQUIRED', 'RESOLVED');
CREATE TYPE "claim_origin" AS ENUM ('SHIPMENT_INCIDENT', 'POST_DELIVERY_QUALITY');
CREATE TYPE "claim_status" AS ENUM (
    'OPEN', 'ACTIVE', 'RESOLVED_REPLACEMENT', 'RESOLVED_RESHIP',
    'RESOLVED_REFUND', 'RESOLVED_REJECTED'
);
CREATE TYPE "claim_slot_resolution_status" AS ENUM (
    'PENDING', 'REPLACEMENT_PENDING', 'RESHIP_PENDING', 'REFUND_PENDING',
    'DELIVERED_REPLACEMENT', 'DELIVERED_RESHIP', 'REFUNDED', 'REJECTED'
);
CREATE TYPE "price_adjustment_reason" AS ENUM (
    'EXPRESS_BREACH', 'PRODUCTION_FAILURE', 'SHIPMENT_INCIDENT', 'POST_DELIVERY_ISSUE'
);

ALTER TABLE "jobs"
    ADD COLUMN "replaces_job_id" uuid,
    ADD COLUMN "qc_evidence_omission_reason" varchar(500),
    ADD CONSTRAINT "jobs_replaces_job_id_fkey"
        FOREIGN KEY ("replaces_job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT,
    ADD CONSTRAINT "jobs_qc_evidence_choice_check" CHECK (
        "qc_photo_asset_id" IS NULL OR "qc_evidence_omission_reason" IS NULL
    );
CREATE UNIQUE INDEX "jobs_replaces_job_id_key" ON "jobs"("replaces_job_id");
CREATE UNIQUE INDEX "jobs_shipment_scope_key"
    ON "jobs"("id", "shipment_plan_id", "order_id", "order_phase_id");
CREATE UNIQUE INDEX "shipments_job_scope_key"
    ON "shipments"("id", "shipment_plan_id", "order_id", "order_phase_id");

CREATE TABLE "job_shipment_assignments" (
    "job_id" uuid PRIMARY KEY,
    "shipment_id" uuid NOT NULL,
    "shipment_plan_id" uuid NOT NULL,
    "order_id" uuid NOT NULL,
    "order_phase_id" uuid NOT NULL,
    "assigned_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "job_shipment_assignments_job_scope_fkey"
        FOREIGN KEY ("job_id", "shipment_plan_id", "order_id", "order_phase_id")
        REFERENCES "jobs"("id", "shipment_plan_id", "order_id", "order_phase_id")
        ON DELETE RESTRICT,
    CONSTRAINT "job_shipment_assignments_shipment_scope_fkey"
        FOREIGN KEY ("shipment_id", "shipment_plan_id", "order_id", "order_phase_id")
        REFERENCES "shipments"("id", "shipment_plan_id", "order_id", "order_phase_id")
        ON DELETE RESTRICT,
    CONSTRAINT "job_shipment_assignments_job_scope_key"
        UNIQUE ("job_id", "shipment_plan_id", "order_id", "order_phase_id")
);
CREATE INDEX "job_shipment_assignments_shipment_id_idx"
    ON "job_shipment_assignments"("shipment_id");

CREATE TABLE "replacement_requests" (
    "id" uuid PRIMARY KEY,
    "order_id" uuid NOT NULL,
    "order_phase_id" uuid NOT NULL,
    "shipment_plan_id" uuid NOT NULL,
    "source_job_id" uuid NOT NULL UNIQUE,
    "replacement_job_id" uuid UNIQUE,
    "phase_reservation_set_id" uuid UNIQUE,
    "reason" "replacement_request_reason" NOT NULL,
    "status" "replacement_request_status" NOT NULL DEFAULT 'OPEN',
    "deadline_at" timestamptz(3) NOT NULL,
    "resolved_at" timestamptz(3),
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" timestamptz(3) NOT NULL,
    CONSTRAINT "replacement_requests_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT,
    CONSTRAINT "replacement_requests_order_phase_scope_fkey"
        FOREIGN KEY ("order_phase_id", "order_id")
        REFERENCES "order_phases"("id", "order_id") ON DELETE RESTRICT,
    CONSTRAINT "replacement_requests_shipment_plan_scope_fkey"
        FOREIGN KEY ("shipment_plan_id", "order_id", "order_phase_id")
        REFERENCES "shipment_plans"("id", "order_id", "order_phase_id") ON DELETE RESTRICT,
    CONSTRAINT "replacement_requests_source_job_id_fkey"
        FOREIGN KEY ("source_job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT,
    CONSTRAINT "replacement_requests_replacement_job_id_fkey"
        FOREIGN KEY ("replacement_job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT,
    CONSTRAINT "replacement_requests_phase_reservation_set_id_fkey"
        FOREIGN KEY ("phase_reservation_set_id")
        REFERENCES "phase_reservation_sets"("id") ON DELETE RESTRICT,
    CONSTRAINT "replacement_requests_resolution_check" CHECK (
        ("status" = 'OPEN' AND "replacement_job_id" IS NULL
         AND "phase_reservation_set_id" IS NULL AND "resolved_at" IS NULL)
        OR ("status" = 'JOB_CREATED' AND "replacement_job_id" IS NOT NULL
            AND "phase_reservation_set_id" IS NOT NULL AND "resolved_at" IS NULL)
        OR ("status" = 'REFUND_REQUIRED' AND "replacement_job_id" IS NULL
            AND "phase_reservation_set_id" IS NULL AND "resolved_at" IS NULL)
        OR ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL)
    )
);
CREATE INDEX "replacement_requests_order_id_status_deadline_at_idx"
    ON "replacement_requests"("order_id", "status", "deadline_at");

CREATE TABLE "claims" (
    "id" uuid PRIMARY KEY,
    "order_id" uuid NOT NULL,
    "order_phase_id" uuid NOT NULL,
    "incident_shipment_id" uuid UNIQUE,
    "origin" "claim_origin" NOT NULL,
    "status" "claim_status" NOT NULL DEFAULT 'OPEN',
    "reason" text NOT NULL,
    "opened_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "resolved_at" timestamptz(3),
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" timestamptz(3) NOT NULL,
    CONSTRAINT "claims_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT,
    CONSTRAINT "claims_order_phase_scope_fkey"
        FOREIGN KEY ("order_phase_id", "order_id")
        REFERENCES "order_phases"("id", "order_id") ON DELETE RESTRICT,
    CONSTRAINT "claims_incident_shipment_id_fkey"
        FOREIGN KEY ("incident_shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT,
    CONSTRAINT "claims_reason_check" CHECK (btrim("reason") <> ''),
    CONSTRAINT "claims_origin_scope_check" CHECK (
        ("origin" = 'SHIPMENT_INCIDENT' AND "incident_shipment_id" IS NOT NULL)
        OR ("origin" = 'POST_DELIVERY_QUALITY')
    ),
    CONSTRAINT "claims_resolution_check" CHECK (
        ("status" IN ('OPEN', 'ACTIVE') AND "resolved_at" IS NULL)
        OR ("status" NOT IN ('OPEN', 'ACTIVE') AND "resolved_at" IS NOT NULL)
    )
);
CREATE INDEX "claims_order_id_status_idx" ON "claims"("order_id", "status");

CREATE TABLE "claim_slot_resolutions" (
    "id" uuid PRIMARY KEY,
    "claim_id" uuid NOT NULL,
    "fulfilment_slot_id" uuid NOT NULL,
    "replacement_request_id" uuid UNIQUE,
    "replacement_shipment_id" uuid,
    "status" "claim_slot_resolution_status" NOT NULL DEFAULT 'PENDING',
    "resolved_at" timestamptz(3),
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" timestamptz(3) NOT NULL,
    CONSTRAINT "claim_slot_resolutions_claim_id_fkey"
        FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT,
    CONSTRAINT "claim_slot_resolutions_fulfilment_slot_id_fkey"
        FOREIGN KEY ("fulfilment_slot_id") REFERENCES "fulfilment_slots"("id") ON DELETE RESTRICT,
    CONSTRAINT "claim_slot_resolutions_replacement_request_id_fkey"
        FOREIGN KEY ("replacement_request_id")
        REFERENCES "replacement_requests"("id") ON DELETE RESTRICT,
    CONSTRAINT "claim_slot_resolutions_replacement_shipment_id_fkey"
        FOREIGN KEY ("replacement_shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT,
    CONSTRAINT "claim_slot_resolutions_claim_slot_key"
        UNIQUE ("claim_id", "fulfilment_slot_id"),
    CONSTRAINT "claim_slot_resolutions_terminal_check" CHECK (
        ("status" IN ('PENDING', 'REPLACEMENT_PENDING', 'RESHIP_PENDING', 'REFUND_PENDING')
         AND "resolved_at" IS NULL)
        OR ("status" IN ('DELIVERED_REPLACEMENT', 'DELIVERED_RESHIP', 'REFUNDED', 'REJECTED')
            AND "resolved_at" IS NOT NULL)
    )
);
CREATE INDEX "claim_slot_resolutions_fulfilment_slot_id_status_idx"
    ON "claim_slot_resolutions"("fulfilment_slot_id", "status");
CREATE UNIQUE INDEX "claim_slot_resolutions_one_active_claim_per_slot_key"
    ON "claim_slot_resolutions"("fulfilment_slot_id")
    WHERE "status" IN ('PENDING', 'REPLACEMENT_PENDING', 'RESHIP_PENDING', 'REFUND_PENDING');

CREATE TABLE "price_adjustments" (
    "id" uuid PRIMARY KEY,
    "order_id" uuid NOT NULL,
    "payment_id" uuid,
    "claim_id" uuid,
    "idempotency_key" varchar(255) NOT NULL UNIQUE,
    "reason" "price_adjustment_reason" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" char(3) NOT NULL,
    "allocation" jsonb NOT NULL,
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "price_adjustments_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_adjustments_payment_id_fkey"
        FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_adjustments_claim_id_fkey"
        FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_adjustments_amount_check" CHECK ("amount_minor" > 0),
    CONSTRAINT "price_adjustments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "price_adjustments_idempotency_key_check" CHECK (btrim("idempotency_key") <> '')
);
CREATE INDEX "price_adjustments_order_id_created_at_idx"
    ON "price_adjustments"("order_id", "created_at");
CREATE INDEX "price_adjustments_claim_id_idx" ON "price_adjustments"("claim_id");

CREATE FUNCTION taven_validate_price_adjustment_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    slot_credits jsonb := NEW."allocation" -> 'slotCredits';
    credit jsonb;
    slot_id uuid;
    slot_ids uuid[] := ARRAY[]::uuid[];
    credit_amount bigint;
    slot_settlement_amount bigint;
    prior_credit_amount numeric;
    allocated_amount bigint := 0;
BEGIN
    IF jsonb_typeof(NEW."allocation") <> 'object' THEN
        RAISE EXCEPTION 'PriceAdjustment allocation must be an object'
            USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_allocation_check';
    END IF;

    IF slot_credits IS NULL THEN
        IF NEW."reason" <> 'EXPRESS_BREACH' THEN
            RAISE EXCEPTION 'non-express PriceAdjustment requires slotCredits'
                USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_allocation_check';
        END IF;
        RETURN NEW;
    END IF;

    IF jsonb_typeof(slot_credits) <> 'array'
       OR jsonb_array_length(slot_credits) = 0 THEN
        RAISE EXCEPTION 'PriceAdjustment slotCredits must be a non-empty array'
            USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_allocation_check';
    END IF;

    PERFORM 1
    FROM "orders"
    WHERE "id" = NEW."order_id"
    FOR UPDATE;

    FOR credit IN SELECT value FROM jsonb_array_elements(slot_credits)
    LOOP
        IF jsonb_typeof(credit) <> 'object'
           OR jsonb_typeof(credit -> 'fulfilmentSlotId') <> 'string'
           OR jsonb_typeof(credit -> 'amountMinor') <> 'string'
           OR (credit ->> 'fulfilmentSlotId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           OR (credit ->> 'amountMinor') !~ '^[1-9][0-9]*$' THEN
            RAISE EXCEPTION 'PriceAdjustment slot credit is invalid'
                USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_allocation_check';
        END IF;

        IF (credit ->> 'amountMinor')::numeric > 9223372036854775807 THEN
            RAISE EXCEPTION 'PriceAdjustment slot credit amount is invalid'
                USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_allocation_check';
        END IF;

        slot_id := (credit ->> 'fulfilmentSlotId')::uuid;
        credit_amount := (credit ->> 'amountMinor')::bigint;
        IF slot_id = ANY(slot_ids)
           OR NOT EXISTS (
               SELECT 1 FROM "fulfilment_slots" slot
               WHERE slot."id" = slot_id
                 AND slot."order_id" = NEW."order_id"
           ) THEN
            RAISE EXCEPTION 'PriceAdjustment slot credit scope is invalid'
                USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_allocation_check';
        END IF;

        SELECT slot."settlement_amount_minor"
        INTO slot_settlement_amount
        FROM "fulfilment_slots" slot
        WHERE slot."id" = slot_id;

        SELECT coalesce(sum((prior_credit.value ->> 'amountMinor')::bigint), 0)
        INTO prior_credit_amount
        FROM "price_adjustments" prior_adjustment
        CROSS JOIN LATERAL jsonb_array_elements(
            coalesce(prior_adjustment."allocation" -> 'slotCredits', '[]'::jsonb)
        ) prior_credit(value)
        WHERE prior_adjustment."order_id" = NEW."order_id"
          AND (prior_credit.value ->> 'fulfilmentSlotId')::uuid = slot_id;

        IF prior_credit_amount + credit_amount > slot_settlement_amount THEN
            RAISE EXCEPTION 'PriceAdjustment credits exceed the FulfilmentSlot settlement amount'
                USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_slot_credit_cap_check';
        END IF;
        slot_ids := array_append(slot_ids, slot_id);
        allocated_amount := allocated_amount + credit_amount;
    END LOOP;

    IF allocated_amount <> NEW."amount_minor" THEN
        RAISE EXCEPTION 'PriceAdjustment slot credits must equal its amount'
            USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_allocation_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "price_adjustments_allocation_valid"
BEFORE INSERT ON "price_adjustments"
FOR EACH ROW EXECUTE FUNCTION taven_validate_price_adjustment_allocation();

ALTER TABLE "refund_transactions"
    ADD COLUMN "claim_id" uuid,
    ADD COLUMN "price_adjustment_id" uuid,
    ADD CONSTRAINT "refund_transactions_claim_id_fkey"
        FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT,
    ADD CONSTRAINT "refund_transactions_price_adjustment_id_fkey"
        FOREIGN KEY ("price_adjustment_id") REFERENCES "price_adjustments"("id") ON DELETE RESTRICT;
CREATE INDEX "refund_transactions_claim_id_status_idx"
    ON "refund_transactions"("claim_id", "status");
CREATE INDEX "refund_transactions_price_adjustment_id_idx"
    ON "refund_transactions"("price_adjustment_id");

CREATE FUNCTION taven_protect_fulfilment_refund_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND (NEW."claim_id" IS DISTINCT FROM OLD."claim_id"
            OR NEW."price_adjustment_id" IS DISTINCT FROM OLD."price_adjustment_id") THEN
        RAISE EXCEPTION 'refund fulfilment scope is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_fulfilment_scope_immutable_check';
    END IF;

    IF NEW."replaces_refund_transaction_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "refund_transactions" source
           WHERE source."id" = NEW."replaces_refund_transaction_id"
             AND source."claim_id" IS NOT DISTINCT FROM NEW."claim_id"
             AND source."price_adjustment_id" IS NOT DISTINCT FROM NEW."price_adjustment_id"
       ) THEN
        RAISE EXCEPTION 'refund retry must preserve claim and adjustment scope'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_retry_fulfilment_scope_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "refund_transactions_fulfilment_scope_protected"
BEFORE INSERT OR UPDATE OF "claim_id", "price_adjustment_id", "replaces_refund_transaction_id"
ON "refund_transactions"
FOR EACH ROW EXECUTE FUNCTION taven_protect_fulfilment_refund_scope();

CREATE FUNCTION taven_reject_immutable_fulfilment_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'fulfilment recovery history is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'fulfilment_recovery_history_immutable_check';
END;
$$;

CREATE OR REPLACE FUNCTION taven_protect_shipment_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF (NEW."label_created_at" IS NOT NULL
        AND NEW."label_created_at" > evidence_now + interval '5 seconds')
       OR (NEW."cancellation_requested_at" IS NOT NULL
           AND NEW."cancellation_requested_at" > evidence_now + interval '5 seconds')
       OR (NEW."provider_voided_at" IS NOT NULL
           AND NEW."provider_voided_at" > evidence_now + interval '5 seconds')
       OR (NEW."handed_over_at" IS NOT NULL
           AND NEW."handed_over_at" > evidence_now + interval '5 seconds')
       OR (NEW."delivered_at" IS NOT NULL
           AND NEW."delivered_at" > evidence_now + interval '5 seconds')
       OR (NEW."cancelled_at" IS NOT NULL
           AND NEW."cancelled_at" > evidence_now + interval '5 seconds') THEN
        RAISE EXCEPTION 'Shipment lifecycle evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_evidence_check';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'PLANNED'
           OR NEW."carrier" IS NOT NULL
           OR NEW."provider_shipment_id" IS NOT NULL
           OR NEW."carrier_label_id" IS NOT NULL
           OR NEW."tracking_code" IS NOT NULL
           OR NEW."label_created_at" IS NOT NULL
           OR NEW."cancellation_requested_at" IS NOT NULL
           OR NEW."provider_void_id" IS NOT NULL
           OR NEW."provider_voided_at" IS NOT NULL
           OR NEW."provider_acceptance_scan_id" IS NOT NULL
           OR NEW."handed_over_at" IS NOT NULL
           OR NEW."delivered_at" IS NOT NULL
           OR NEW."cancelled_at" IS NOT NULL THEN
            RAISE EXCEPTION 'new Shipments must begin planned without provider lifecycle evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'shipment_initial_status_check';
        END IF;
        RETURN NEW;
    END IF;

    IF (OLD."carrier" IS NOT NULL AND NEW."carrier" IS DISTINCT FROM OLD."carrier")
       OR (OLD."provider_shipment_id" IS NOT NULL AND NEW."provider_shipment_id" IS DISTINCT FROM OLD."provider_shipment_id")
       OR (OLD."carrier_label_id" IS NOT NULL AND NEW."carrier_label_id" IS DISTINCT FROM OLD."carrier_label_id")
       OR (OLD."tracking_code" IS NOT NULL AND NEW."tracking_code" IS DISTINCT FROM OLD."tracking_code")
       OR (OLD."label_created_at" IS NOT NULL AND NEW."label_created_at" IS DISTINCT FROM OLD."label_created_at")
       OR (OLD."cancellation_requested_at" IS NOT NULL AND NEW."cancellation_requested_at" IS DISTINCT FROM OLD."cancellation_requested_at")
       OR (OLD."provider_void_id" IS NOT NULL AND NEW."provider_void_id" IS DISTINCT FROM OLD."provider_void_id")
       OR (OLD."provider_voided_at" IS NOT NULL AND NEW."provider_voided_at" IS DISTINCT FROM OLD."provider_voided_at")
       OR (OLD."provider_acceptance_scan_id" IS NOT NULL AND NEW."provider_acceptance_scan_id" IS DISTINCT FROM OLD."provider_acceptance_scan_id")
       OR (OLD."handed_over_at" IS NOT NULL AND NEW."handed_over_at" IS DISTINCT FROM OLD."handed_over_at")
       OR (OLD."delivered_at" IS NOT NULL AND NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at")
       OR (OLD."cancelled_at" IS NOT NULL AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at") THEN
        RAISE EXCEPTION 'Shipment provider identity and lifecycle evidence are immutable after assignment'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_immutable_check';
    END IF;

    IF NEW."status" IS NOT DISTINCT FROM OLD."status"
       AND (
           NEW."carrier" IS DISTINCT FROM OLD."carrier"
           OR NEW."provider_shipment_id" IS DISTINCT FROM OLD."provider_shipment_id"
           OR NEW."carrier_label_id" IS DISTINCT FROM OLD."carrier_label_id"
           OR NEW."tracking_code" IS DISTINCT FROM OLD."tracking_code"
           OR NEW."label_created_at" IS DISTINCT FROM OLD."label_created_at"
           OR NEW."cancellation_requested_at" IS DISTINCT FROM OLD."cancellation_requested_at"
           OR NEW."provider_void_id" IS DISTINCT FROM OLD."provider_void_id"
           OR NEW."provider_voided_at" IS DISTINCT FROM OLD."provider_voided_at"
           OR NEW."provider_acceptance_scan_id" IS DISTINCT FROM OLD."provider_acceptance_scan_id"
           OR NEW."handed_over_at" IS DISTINCT FROM OLD."handed_over_at"
           OR NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
           OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
       ) THEN
        RAISE EXCEPTION 'Shipment lifecycle evidence must be assigned with its status transition'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_evidence_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'PLANNED' AND NEW."status" IN ('LABEL_CREATED', 'CANCELLED'))
           OR (OLD."status" = 'LABEL_CREATED' AND NEW."status" IN ('HANDED_OVER', 'CANCELLATION_PENDING'))
           OR (OLD."status" = 'CANCELLATION_PENDING' AND NEW."status" IN ('CANCELLED', 'HANDED_OVER'))
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'HANDED_OVER')
           OR (OLD."status" = 'HANDED_OVER' AND NEW."status" = 'IN_TRANSIT')
           OR (OLD."status" = 'HANDED_OVER' AND NEW."status" = 'DELIVERED')
           OR (OLD."status" = 'IN_TRANSIT' AND NEW."status" IN ('DELIVERED', 'LOST', 'RETURNED'))
           OR (OLD."status" = 'LOST' AND NEW."status" = 'RECOVERED')
       ) THEN
        RAISE EXCEPTION 'Shipment status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_status_transition_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'PLANNED' AND NEW."status" = 'LABEL_CREATED'
            AND NEW."carrier" IS DISTINCT FROM OLD."carrier"
            AND NEW."provider_shipment_id" IS DISTINCT FROM OLD."provider_shipment_id"
            AND NEW."carrier_label_id" IS DISTINCT FROM OLD."carrier_label_id"
            AND NEW."label_created_at" IS DISTINCT FROM OLD."label_created_at"
            AND NEW."cancellation_requested_at" IS NOT DISTINCT FROM OLD."cancellation_requested_at"
            AND NEW."provider_void_id" IS NOT DISTINCT FROM OLD."provider_void_id"
            AND NEW."provider_voided_at" IS NOT DISTINCT FROM OLD."provider_voided_at"
            AND NEW."provider_acceptance_scan_id" IS NOT DISTINCT FROM OLD."provider_acceptance_scan_id"
            AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
            AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
            AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'LABEL_CREATED' AND NEW."status" = 'HANDED_OVER'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."carrier_label_id" IS NOT DISTINCT FROM OLD."carrier_label_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."cancellation_requested_at" IS NOT DISTINCT FROM OLD."cancellation_requested_at"
               AND NEW."provider_void_id" IS NOT DISTINCT FROM OLD."provider_void_id"
               AND NEW."provider_voided_at" IS NOT DISTINCT FROM OLD."provider_voided_at"
               AND NEW."handed_over_at" IS DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'HANDED_OVER' AND NEW."status" = 'IN_TRANSIT'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."carrier_label_id" IS NOT DISTINCT FROM OLD."carrier_label_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."cancellation_requested_at" IS NOT DISTINCT FROM OLD."cancellation_requested_at"
               AND NEW."provider_void_id" IS NOT DISTINCT FROM OLD."provider_void_id"
               AND NEW."provider_voided_at" IS NOT DISTINCT FROM OLD."provider_voided_at"
               AND NEW."provider_acceptance_scan_id" IS NOT DISTINCT FROM OLD."provider_acceptance_scan_id"
               AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'HANDED_OVER' AND NEW."status" = 'DELIVERED'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."carrier_label_id" IS NOT DISTINCT FROM OLD."carrier_label_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."cancellation_requested_at" IS NOT DISTINCT FROM OLD."cancellation_requested_at"
               AND NEW."provider_void_id" IS NOT DISTINCT FROM OLD."provider_void_id"
               AND NEW."provider_voided_at" IS NOT DISTINCT FROM OLD."provider_voided_at"
               AND NEW."provider_acceptance_scan_id" IS NOT DISTINCT FROM OLD."provider_acceptance_scan_id"
               AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'IN_TRANSIT' AND NEW."status" = 'DELIVERED'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."carrier_label_id" IS NOT DISTINCT FROM OLD."carrier_label_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."cancellation_requested_at" IS NOT DISTINCT FROM OLD."cancellation_requested_at"
               AND NEW."provider_void_id" IS NOT DISTINCT FROM OLD."provider_void_id"
               AND NEW."provider_voided_at" IS NOT DISTINCT FROM OLD."provider_voided_at"
               AND NEW."provider_acceptance_scan_id" IS NOT DISTINCT FROM OLD."provider_acceptance_scan_id"
               AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'PLANNED' AND NEW."status" = 'CANCELLED'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."carrier_label_id" IS NOT DISTINCT FROM OLD."carrier_label_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."cancellation_requested_at" IS NOT DISTINCT FROM OLD."cancellation_requested_at"
               AND NEW."provider_void_id" IS NOT DISTINCT FROM OLD."provider_void_id"
               AND NEW."provider_voided_at" IS NOT DISTINCT FROM OLD."provider_voided_at"
               AND NEW."provider_acceptance_scan_id" IS NOT DISTINCT FROM OLD."provider_acceptance_scan_id"
               AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'LABEL_CREATED' AND NEW."status" = 'CANCELLATION_PENDING'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."carrier_label_id" IS NOT DISTINCT FROM OLD."carrier_label_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."cancellation_requested_at" IS DISTINCT FROM OLD."cancellation_requested_at"
               AND NEW."provider_void_id" IS NOT DISTINCT FROM OLD."provider_void_id"
               AND NEW."provider_voided_at" IS NOT DISTINCT FROM OLD."provider_voided_at"
               AND NEW."provider_acceptance_scan_id" IS NOT DISTINCT FROM OLD."provider_acceptance_scan_id"
               AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'CANCELLATION_PENDING' AND NEW."status" = 'CANCELLED'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."carrier_label_id" IS NOT DISTINCT FROM OLD."carrier_label_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."cancellation_requested_at" IS NOT DISTINCT FROM OLD."cancellation_requested_at"
               AND NEW."provider_void_id" IS DISTINCT FROM OLD."provider_void_id"
               AND NEW."provider_voided_at" IS DISTINCT FROM OLD."provider_voided_at"
               AND NEW."provider_acceptance_scan_id" IS NOT DISTINCT FROM OLD."provider_acceptance_scan_id"
               AND NEW."handed_over_at" IS NOT DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'CANCELLATION_PENDING' AND NEW."status" = 'HANDED_OVER'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."carrier_label_id" IS NOT DISTINCT FROM OLD."carrier_label_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."cancellation_requested_at" IS NOT DISTINCT FROM OLD."cancellation_requested_at"
               AND NEW."provider_void_id" IS NOT DISTINCT FROM OLD."provider_void_id"
               AND NEW."provider_voided_at" IS NOT DISTINCT FROM OLD."provider_voided_at"
               AND NEW."provider_acceptance_scan_id" IS DISTINCT FROM OLD."provider_acceptance_scan_id"
               AND NEW."handed_over_at" IS DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'HANDED_OVER'
               AND NEW."carrier" IS NOT DISTINCT FROM OLD."carrier"
               AND NEW."provider_shipment_id" IS NOT DISTINCT FROM OLD."provider_shipment_id"
               AND NEW."carrier_label_id" IS NOT DISTINCT FROM OLD."carrier_label_id"
               AND NEW."tracking_code" IS NOT DISTINCT FROM OLD."tracking_code"
               AND NEW."label_created_at" IS NOT DISTINCT FROM OLD."label_created_at"
               AND NEW."cancellation_requested_at" IS NOT DISTINCT FROM OLD."cancellation_requested_at"
               AND NEW."provider_void_id" IS NOT DISTINCT FROM OLD."provider_void_id"
               AND NEW."provider_voided_at" IS NOT DISTINCT FROM OLD."provider_voided_at"
               AND NEW."provider_acceptance_scan_id" IS DISTINCT FROM OLD."provider_acceptance_scan_id"
               AND NEW."handed_over_at" IS DISTINCT FROM OLD."handed_over_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (((OLD."status" = 'IN_TRANSIT' AND NEW."status" IN ('LOST', 'RETURNED'))
                OR (OLD."status" = 'LOST' AND NEW."status" = 'RECOVERED'))
               AND (to_jsonb(NEW) - ARRAY['status', 'updated_at']) =
                   (to_jsonb(OLD) - ARRAY['status', 'updated_at']))
       ) THEN
        RAISE EXCEPTION 'Shipment transition may assign only its own lifecycle evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_evidence_check';
    END IF;

    IF (NEW."status" IN ('LABEL_CREATED', 'CANCELLATION_PENDING', 'HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED')
        AND (
            NEW."carrier" IS NULL
            OR NEW."carrier" !~ '[^[:space:]]'
            OR NEW."provider_shipment_id" IS NULL
            OR NEW."provider_shipment_id" !~ '[^[:space:]]'
            OR NEW."carrier_label_id" IS NULL
            OR NEW."carrier_label_id" !~ '[^[:space:]]'
            OR NEW."label_created_at" IS NULL
        ))
       OR (NEW."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED')
           AND NEW."handed_over_at" IS NULL)
       OR (NEW."status" = 'CANCELLATION_PENDING'
           AND (
               NEW."cancellation_requested_at" IS NULL
               OR NEW."provider_void_id" IS NOT NULL
               OR NEW."provider_voided_at" IS NOT NULL
               OR NEW."provider_acceptance_scan_id" IS NOT NULL
               OR NEW."cancelled_at" IS NOT NULL
           ))
       OR (NEW."provider_acceptance_scan_id" IS NOT NULL
           AND NEW."provider_acceptance_scan_id" !~ '[^[:space:]]')
       OR (NEW."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED')
           AND NEW."cancellation_requested_at" IS NOT NULL
           AND NEW."provider_acceptance_scan_id" IS NULL)
       OR (NEW."status" = 'DELIVERED' AND NEW."delivered_at" IS NULL)
       OR (NEW."status" = 'CANCELLED'
           AND (
               NEW."cancelled_at" IS NULL
               OR (
                   NEW."label_created_at" IS NULL
                   AND (
                       NEW."cancellation_requested_at" IS NOT NULL
                       OR NEW."provider_void_id" IS NOT NULL
                       OR NEW."provider_voided_at" IS NOT NULL
                       OR NEW."provider_acceptance_scan_id" IS NOT NULL
                   )
               )
               OR (
                   NEW."label_created_at" IS NOT NULL
                   AND (
                       NEW."cancellation_requested_at" IS NULL
                       OR NEW."provider_void_id" IS NULL
                       OR NEW."provider_void_id" !~ '[^[:space:]]'
                       OR NEW."provider_voided_at" IS NULL
                       OR NEW."provider_acceptance_scan_id" IS NOT NULL
                   )
               )
           )) THEN
        RAISE EXCEPTION 'Shipment lifecycle state requires its complete provider evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_evidence_check';
    END IF;

    -- A provider event may occur five seconds before the preceding lifecycle
    -- timestamp and be verified another five seconds before its occurrence.
    -- Provider-backed state timestamps therefore use the composed bound.
    IF (NEW."label_created_at" IS NOT NULL AND NEW."handed_over_at" IS NOT NULL
        AND NEW."handed_over_at" < NEW."label_created_at" - interval '10 seconds')
       OR (NEW."label_created_at" IS NOT NULL AND NEW."cancellation_requested_at" IS NOT NULL
           AND NEW."cancellation_requested_at" < NEW."label_created_at" - interval '5 seconds')
       OR (NEW."cancellation_requested_at" IS NOT NULL AND NEW."provider_voided_at" IS NOT NULL
           AND NEW."provider_voided_at" <
               NEW."cancellation_requested_at" - interval '10 seconds')
       OR (NEW."provider_voided_at" IS NOT NULL AND NEW."cancelled_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."provider_voided_at" - interval '5 seconds')
       OR (NEW."handed_over_at" IS NOT NULL AND NEW."delivered_at" IS NOT NULL
           AND NEW."delivered_at" < NEW."handed_over_at" - interval '10 seconds')
       OR (NEW."cancelled_at" IS NOT NULL AND NEW."label_created_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."label_created_at" - interval '15 seconds') THEN
        RAISE EXCEPTION 'Shipment lifecycle timestamps must be chronological'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_lifecycle_evidence_check';
    END IF;

    IF ((OLD."status" = 'IN_TRANSIT' AND NEW."status" IN ('LOST', 'RETURNED'))
         OR (OLD."status" = 'LOST' AND NEW."status" = 'RECOVERED'))
       AND NOT EXISTS (
           SELECT 1
           FROM "shipment_provider_events" event
           WHERE event."shipment_id" = NEW."id"
             AND event."kind"::text = NEW."status"::text
             AND event."carrier" = NEW."carrier"
             AND event."carrier_label_id" = NEW."carrier_label_id"
             AND event."source_shipment_status" = OLD."status"
       ) THEN
        RAISE EXCEPTION 'Shipment incident transition requires exact authenticated provider evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_incident_provider_event_check';
    END IF;

    IF OLD."status" = 'CANCELLATION_PENDING'
       AND NEW."status" = 'CANCELLED'
       AND NOT EXISTS (
           SELECT 1
           FROM "shipment_provider_events" event
           JOIN "outbox_messages" message
             ON message."id" = event."outbox_message_id"
           WHERE event."shipment_id" = NEW."id"
             AND event."kind" = 'LABEL_VOIDED'
             AND event."carrier" = NEW."carrier"
             AND event."carrier_label_id" = NEW."carrier_label_id"
             AND event."provider_event_id" = NEW."provider_void_id"
             AND event."verified_at" = NEW."provider_voided_at"
             AND message."deduplication_key" =
                 'void_carrier_label:' || NEW."id"::text || ':' || NEW."carrier_label_id"
             AND message."aggregate_type" = 'Shipment'
             AND message."aggregate_id" = NEW."id"
             AND message."message_type" = 'void_carrier_label'
             AND message."schema_version" = 1
             AND message."status" = 'DELIVERED'
             AND message."delivered_at" IS NOT NULL
             AND message."payload" = jsonb_build_object(
                 'shipmentId', NEW."id"::text,
                 'carrierLabelId', NEW."carrier_label_id",
                 'action', 'void_carrier_label'
             )
       ) THEN
        RAISE EXCEPTION 'Shipment cancellation requires an authenticated provider void result for its exact outbox command'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_provider_void_confirmation_check';
    END IF;

    IF OLD."status" IN ('LABEL_CREATED', 'CANCELLATION_PENDING', 'CANCELLED')
       AND NEW."status" = 'HANDED_OVER'
       AND NEW."provider_acceptance_scan_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "shipment_provider_events" event
           WHERE event."shipment_id" = NEW."id"
             AND event."outbox_message_id" IS NULL
             AND event."kind" = 'ACCEPTANCE_SCAN'
             AND event."carrier" = NEW."carrier"
             AND event."carrier_label_id" = NEW."carrier_label_id"
             AND event."provider_event_id" = NEW."provider_acceptance_scan_id"
             AND event."verified_at" = NEW."handed_over_at"
             AND (
                 OLD."status" <> 'CANCELLED'
                 OR EXISTS (
                     SELECT 1
                     FROM "shipment_provider_events" void_event
                     WHERE void_event."shipment_id" = NEW."id"
                       AND void_event."kind" = 'LABEL_VOIDED'
                       AND void_event."carrier" = NEW."carrier"
                       AND void_event."carrier_label_id" = NEW."carrier_label_id"
                       AND void_event."provider_event_id" = NEW."provider_void_id"
                       AND void_event."verified_at" = NEW."provider_voided_at"
                       AND event."occurred_at" < void_event."occurred_at"
                 )
             )
       ) THEN
        RAISE EXCEPTION 'Shipment handoff must bind its exact verified carrier acceptance scan'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_acceptance_scan_confirmation_check';
    END IF;

    IF OLD."status" = 'HANDED_OVER'
       AND NEW."status" = 'IN_TRANSIT'
       AND NOT EXISTS (
           SELECT 1
           FROM "shipment_provider_events" event
           WHERE event."shipment_id" = NEW."id"
             AND event."outbox_message_id" IS NULL
             AND event."kind" = 'TRANSIT_SCAN'
             AND event."carrier" = NEW."carrier"
             AND event."carrier_label_id" = NEW."carrier_label_id"
             AND event."occurred_at" >= NEW."handed_over_at" - interval '5 seconds'
       ) THEN
        RAISE EXCEPTION 'Shipment transit requires its exact authenticated carrier scan'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_transit_scan_confirmation_check';
    END IF;

    IF OLD."status" IN ('HANDED_OVER', 'IN_TRANSIT')
       AND NEW."status" = 'DELIVERED'
       AND NOT EXISTS (
           SELECT 1
           FROM "shipment_provider_events" event
           WHERE event."shipment_id" = NEW."id"
             AND event."outbox_message_id" IS NULL
             AND event."kind" = 'DELIVERY_SCAN'
             AND event."carrier" = NEW."carrier"
             AND event."carrier_label_id" = NEW."carrier_label_id"
             AND event."occurred_at" >= NEW."handed_over_at" - interval '5 seconds'
             AND event."verified_at" = NEW."delivered_at"
       ) THEN
        RAISE EXCEPTION 'Shipment delivery requires its exact authenticated carrier scan'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_delivery_scan_confirmation_check';
    END IF;

    IF OLD."status" = 'LABEL_CREATED'
       AND NEW."status" = 'CANCELLATION_PENDING' THEN
        INSERT INTO "outbox_messages" (
            "id", "deduplication_key", "aggregate_type", "aggregate_id",
            "message_type", "schema_version", "payload", "status", "attempts",
            "available_at", "created_at", "updated_at"
        ) VALUES (
            gen_random_uuid(),
            'void_carrier_label:' || NEW."id"::text || ':' || NEW."carrier_label_id",
            'Shipment',
            NEW."id",
            'void_carrier_label',
            1,
            jsonb_build_object(
                'shipmentId', NEW."id"::text,
                'carrierLabelId', NEW."carrier_label_id",
                'action', 'void_carrier_label'
            ),
            'PENDING',
            0,
            NEW."cancellation_requested_at",
            NEW."cancellation_requested_at",
            NEW."cancellation_requested_at"
        )
        ON CONFLICT ("deduplication_key") DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

-- A failed current Job may remain inside an active order only while a durable
-- replacement/refund obligation exists. Superseded failed Jobs retain their
-- evidence without forcing an otherwise successful order to cancel.
CREATE OR REPLACE FUNCTION taven_reconcile_production_failure_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_order_status "order_status";
    has_failed_job boolean;
    has_unhandled_current_failure boolean;
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
               FROM "jobs" job
               WHERE job."order_id" = target_order_id
                 AND job."status" IN ('FAILED', 'QC_REJECTED')
                 AND NOT EXISTS (
                     SELECT 1
                     FROM "jobs" replacement
                     WHERE replacement."replaces_job_id" = job."id"
                 )
                 AND NOT EXISTS (
                     SELECT 1
                     FROM "replacement_requests" request
                     WHERE request."source_job_id" = job."id"
                       AND request."status" IN (
                           'OPEN', 'JOB_CREATED', 'REFUND_REQUIRED', 'RESOLVED'
                       )
                 )
           ),
           EXISTS (
               SELECT 1
               FROM "payments" payment
               JOIN "refund_transactions" refund
                 ON refund."payment_id" = payment."id"
               WHERE payment."order_id" = target_order_id
                 AND refund."reason" = 'PRODUCTION_FAILURE'
           )
    INTO target_order_status, has_failed_job,
         has_unhandled_current_failure, has_production_failure_refund
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    IF has_unhandled_current_failure AND (
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
        RAISE EXCEPTION 'failed production must have a recovery obligation or cancel the order with complete refund work'
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


CREATE OR REPLACE FUNCTION taven_reconcile_confirmed_order_reservation_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_status "order_status";
BEGIN
    CASE TG_TABLE_NAME
        WHEN 'phase_reservation_sets' THEN
            SELECT phase."order_id"
            INTO target_order_id
            FROM "phase_reservation_sets" reservation_set
            JOIN "phase_resource_plans" plan
              ON plan."id" = reservation_set."phase_resource_plan_id"
             AND plan."node_id" = reservation_set."node_id"
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE reservation_set."id" = (to_jsonb(NEW) ->> 'id')::uuid;
        WHEN 'production_reservations' THEN
            SELECT phase."order_id"
            INTO target_order_id
            FROM "production_reservations" production
            JOIN "phase_resource_plans" plan
              ON plan."id" = production."phase_resource_plan_id"
             AND plan."node_id" = production."node_id"
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE production."id" = (to_jsonb(NEW) ->> 'id')::uuid;
        ELSE
            SELECT phase."order_id"
            INTO target_order_id
            FROM "production_reservations" production
            JOIN "phase_resource_plans" plan
              ON plan."id" = production."phase_resource_plan_id"
             AND plan."node_id" = production."node_id"
            JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
            WHERE production."id" = (to_jsonb(NEW) ->> 'production_reservation_id')::uuid;
    END CASE;

    SELECT target_order."status"
    INTO target_status
    FROM "orders" target_order
    WHERE target_order."id" = target_order_id
    FOR UPDATE;

    IF target_status IS DISTINCT FROM 'CONFIRMED'::"order_status" THEN
        RETURN NULL;
    END IF;

    -- A terminal Job may temporarily leave the captured order without a held
    -- production set only when a durable recovery obligation already exists.
    -- Creating the replacement must restore the ordinary complete held graph.
    IF EXISTS (
        SELECT 1
        FROM "replacement_requests" request
        WHERE request."order_id" = target_order_id
          AND request."status" IN ('OPEN', 'REFUND_REQUIRED')
    ) THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "order_phases" phase
        JOIN "order_active_price_bindings" active_binding
          ON active_binding."order_id" = phase."order_id"
        JOIN "phase_resource_plans" resource_plan
          ON resource_plan."order_phase_id" = phase."id"
        JOIN "phase_reservation_sets" reservation_set
          ON reservation_set."phase_resource_plan_id" = resource_plan."id"
         AND reservation_set."node_id" = resource_plan."node_id"
         AND reservation_set."status" = 'HELD'
        WHERE phase."order_id" = target_order_id
          AND phase."kind" = 'SINGLE'
          AND phase."status" = 'ACTIVE'
          AND phase."activated_at" IS NOT NULL
          AND (
              SELECT count(*)
              FROM "phase_reservation_sets" held_set
              JOIN "phase_resource_plans" held_plan
                ON held_plan."id" = held_set."phase_resource_plan_id"
               AND held_plan."node_id" = held_set."node_id"
              WHERE held_plan."order_phase_id" = phase."id"
                AND held_set."status" = 'HELD'
          ) = 1
          AND EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              JOIN "candidate_resource_estimates" candidate
                ON candidate."id" = plan_job."candidate_resource_estimate_id"
               AND candidate."node_id" = plan_job."node_id"
              JOIN "shipment_plans" candidate_plan
                ON candidate_plan."id" = candidate."shipment_plan_id"
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
                AND candidate_plan."order_price_binding_id" IS DISTINCT FROM active_binding."order_price_binding_id"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "phase_reservation_sets" competing_set
              JOIN "phase_resource_plans" competing_plan
                ON competing_plan."id" = competing_set."phase_resource_plan_id"
               AND competing_plan."node_id" = competing_set."node_id"
              WHERE competing_plan."order_phase_id" = phase."id"
                AND competing_set."id" <> reservation_set."id"
                AND competing_set."status" IN ('BUILDING', 'RESERVED', 'HELD')
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "phase_resource_plan_jobs" plan_job
              LEFT JOIN "production_reservations" production
                ON production."phase_reservation_set_id" = reservation_set."id"
               AND production."phase_resource_plan_job_id" = plan_job."id"
               AND production."node_id" = plan_job."node_id"
              LEFT JOIN "jobs" job
                ON job."id" = production."job_id"
               AND job."node_id" = production."node_id"
               AND job."phase_resource_plan_job_id" = production."phase_resource_plan_job_id"
              WHERE plan_job."phase_resource_plan_id" = resource_plan."id"
                AND plan_job."node_id" = resource_plan."node_id"
                AND (
                    production."id" IS NULL
                    OR production."status" <> 'HELD'
                    OR production."job_id" IS NULL
                    OR job."id" IS NULL
                    OR job."order_id" <> target_order_id
                    OR job."order_phase_id" <> phase."id"
                    OR job."status" NOT IN ('CREATED', 'ACCEPTED', 'GCODE_READY')
                    OR NOT EXISTS (
                        SELECT 1
                        FROM "inventory_reservations" inventory_reservation
                        WHERE inventory_reservation."production_reservation_id" = production."id"
                          AND inventory_reservation."node_id" = production."node_id"
                          AND inventory_reservation."status" = 'HELD'
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM "inventory_reservations" inventory_reservation
                        WHERE inventory_reservation."production_reservation_id" = production."id"
                          AND inventory_reservation."node_id" = production."node_id"
                          AND inventory_reservation."status" <> 'HELD'
                    )
                    OR NOT EXISTS (
                        SELECT 1
                        FROM "capacity_reservations" capacity_reservation
                        WHERE capacity_reservation."production_reservation_id" = production."id"
                          AND capacity_reservation."node_id" = production."node_id"
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM "capacity_reservations" capacity_reservation
                        WHERE capacity_reservation."production_reservation_id" = production."id"
                          AND capacity_reservation."node_id" = production."node_id"
                          AND capacity_reservation."status" <> 'HELD'
                    )
                )
          )
    ) THEN
        RAISE EXCEPTION 'confirmed order must retain its complete held reservation graph'
            USING ERRCODE = '23514', CONSTRAINT = 'confirmed_order_reservation_hold_check';
    END IF;

    RETURN NULL;
END;
$$;


CREATE FUNCTION taven_reconcile_claim_refund_success()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_claim_id uuid;
    refund_resolved_at timestamptz;
    delivered_count bigint;
    unresolved_count bigint;
BEGIN
    IF NEW."status" <> 'SUCCEEDED'
       OR OLD."status" = 'SUCCEEDED'
       OR NEW."claim_id" IS NULL THEN
        RETURN NULL;
    END IF;

    target_claim_id := NEW."claim_id";
    refund_resolved_at := NEW."completed_at";

    SELECT claim."order_id"
    INTO target_order_id
    FROM "claims" claim
    WHERE claim."id" = target_claim_id
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM "refund_transactions" refund
        WHERE refund."claim_id" = target_claim_id
          AND NOT EXISTS (
              SELECT 1
              FROM "refund_transactions" retry
              WHERE retry."replaces_refund_transaction_id" = refund."id"
          )
          AND refund."status" NOT IN ('SUCCEEDED', 'SUPERSEDED')
    ) THEN
        RETURN NULL;
    END IF;

    UPDATE "fulfilment_slots" slot
    SET "outcome" = 'CANCELLED_REFUNDED', "updated_at" = refund_resolved_at
    FROM "claim_slot_resolutions" resolution
    WHERE resolution."claim_id" = target_claim_id
      AND resolution."fulfilment_slot_id" = slot."id"
      AND resolution."status" = 'REFUND_PENDING'
      AND slot."outcome" = 'PENDING';

    UPDATE "claim_slot_resolutions"
    SET "status" = 'REFUNDED', "resolved_at" = refund_resolved_at,
        "updated_at" = refund_resolved_at
    WHERE "claim_id" = target_claim_id
      AND "status" = 'REFUND_PENDING';

    IF NOT EXISTS (
        SELECT 1 FROM "claim_slot_resolutions"
        WHERE "claim_id" = target_claim_id
          AND "status" NOT IN ('REFUNDED', 'REJECTED', 'DELIVERED_REPLACEMENT', 'DELIVERED_RESHIP')
    ) THEN
        UPDATE "claims"
        SET "status" = CASE
                WHEN NOT EXISTS (
                    SELECT 1 FROM "claim_slot_resolutions"
                    WHERE "claim_id" = target_claim_id
                      AND "status" <> 'REFUNDED'
                ) THEN 'RESOLVED_REFUND'::claim_status
                ELSE 'RESOLVED_REPLACEMENT'::claim_status
            END,
            "resolved_at" = refund_resolved_at,
            "updated_at" = refund_resolved_at
        WHERE "id" = target_claim_id;
    END IF;

    SELECT count(*) FILTER (WHERE slot."outcome" = 'DELIVERED'),
           count(*) FILTER (
               WHERE slot."outcome" NOT IN ('DELIVERED', 'CANCELLED_REFUNDED')
           )
    INTO delivered_count, unresolved_count
    FROM "fulfilment_slots" slot
    WHERE slot."order_id" = target_order_id;

    IF unresolved_count = 0 AND delivered_count > 0 THEN
        UPDATE "order_phases"
        SET "status" = 'PARTIALLY_FULFILLED', "updated_at" = refund_resolved_at
        WHERE "order_id" = target_order_id AND "status" = 'SHIPPED';
        UPDATE "orders"
        SET "status" = 'PARTIALLY_FULFILLED', "updated_at" = refund_resolved_at
        WHERE "id" = target_order_id AND "status" = 'SHIPPED';
    ELSIF unresolved_count = 0 AND delivered_count = 0 THEN
        UPDATE "order_phases"
        SET "status" = 'CANCELLED_REFUNDED',
            "cancelled_at" = coalesce("cancelled_at", refund_resolved_at),
            "updated_at" = refund_resolved_at
        WHERE "order_id" = target_order_id AND "status" = 'SHIPPED';
        UPDATE "orders"
        SET "status" = 'REFUNDED', "updated_at" = refund_resolved_at
        WHERE "id" = target_order_id AND "status" = 'SHIPPED';
    END IF;

    RETURN NULL;
END;
$$;

CREATE TRIGGER "refund_transactions_claim_success_reconciled"
AFTER UPDATE OF "status" ON "refund_transactions"
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_claim_refund_success();


-- The original checkout primitive only supported full refunds. Recovery claims
-- can refund one fulfilled subset, so reconcile the Payment from all committed
-- refund work instead of unconditionally marking it fully refunded.
CREATE OR REPLACE FUNCTION taven_apply_checkout_refund_success(
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
    succeeded_total bigint;
    pending_count bigint;
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
        coalesce(refund_occurred_at, verified_at), verified_at, verified_at,
        verified_at
    WHERE existing_event."id" IS NULL;

    UPDATE "refund_transactions"
    SET "status" = 'SUCCEEDED', "provider_refund_id" = refund_provider_id,
        "provider_result_event_id" = receipt_id, "completed_at" = verified_at,
        "updated_at" = verified_at
    WHERE "id" = target_refund."id";

    SELECT coalesce(sum(refund."amount_minor") FILTER (
               WHERE refund."status" = 'SUCCEEDED'
           ), 0),
           count(*) FILTER (
               WHERE refund."status" IN ('PENDING', 'SUSPENDED')
           )
    INTO succeeded_total, pending_count
    FROM "refund_transactions" refund
    WHERE refund."payment_id" = target_payment."id";

    UPDATE "payments"
    SET "status" = CASE
            WHEN pending_count > 0 THEN 'REFUND_PENDING'::"payment_status"
            WHEN succeeded_total = target_payment."captured_amount_minor"
                THEN 'REFUNDED'::"payment_status"
            ELSE 'PARTIALLY_REFUNDED'::"payment_status"
        END,
        "updated_at" = verified_at
    WHERE "id" = target_payment."id";
    RETURN true;
END;
$$;


CREATE OR REPLACE FUNCTION taven_reconcile_shipment_plan_slot_terminal_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid := NEW."order_id";
BEGIN
    PERFORM 1
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM "shipments" predecessor
        JOIN "shipments" replacement
          ON replacement."replaces_shipment_id" = predecessor."id"
        WHERE predecessor."order_id" = target_order_id
          AND (predecessor."status" <> 'CANCELLED'
               OR predecessor."cancelled_at" IS NULL)
    ) THEN
        RAISE EXCEPTION 'a replaced Shipment must be terminally cancelled before its successor is attached'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_replacement_predecessor_terminal_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "fulfilment_slots" slot
        WHERE slot."order_id" = target_order_id
          AND slot."outcome" IN ('DELIVERED', 'CANCELLED', 'CANCELLED_REFUNDED')
          AND NOT EXISTS (
              SELECT 1
              FROM "shipment_plan_fulfilment_slots" allocation
              JOIN "shipment_plans" plan
                ON plan."id" = allocation."shipment_plan_id"
               AND plan."order_price_binding_id" = allocation."order_price_binding_id"
              JOIN "order_active_price_bindings" active_binding
                ON active_binding."order_id" = plan."order_id"
               AND active_binding."order_price_binding_id" = plan."order_price_binding_id"
              WHERE allocation."fulfilment_slot_id" = slot."id"
                AND plan."order_id" = slot."order_id"
                AND plan."order_phase_id" = slot."order_phase_id"
                AND (
                    (
                        slot."outcome" = 'DELIVERED'
                        AND EXISTS (
                            SELECT 1
                            FROM "shipments" shipment
                            WHERE shipment."shipment_plan_id" = plan."id"
                              AND shipment."status" = 'DELIVERED'
                              AND shipment."delivered_at" IS NOT NULL
                              AND NOT EXISTS (
                                  SELECT 1
                                  FROM "shipments" replacement
                                  WHERE replacement."replaces_shipment_id" = shipment."id"
                              )
                        )
                    )
                    OR (
                        slot."outcome" IN ('CANCELLED', 'CANCELLED_REFUNDED')
                        AND (
                            NOT EXISTS (
                                SELECT 1
                                FROM "shipments" shipment
                                WHERE shipment."shipment_plan_id" = plan."id"
                            )
                            OR EXISTS (
                                SELECT 1
                                FROM "shipments" shipment
                                WHERE shipment."shipment_plan_id" = plan."id"
                                  AND (
                                      (shipment."status" = 'CANCELLED'
                                       AND shipment."cancelled_at" IS NOT NULL)
                                      OR (
                                          slot."outcome" = 'CANCELLED_REFUNDED'
                                          AND shipment."status" IN ('LOST', 'RETURNED')
                                      )
                                  )
                                  AND NOT EXISTS (
                                      SELECT 1
                                      FROM "shipments" replacement
                                      WHERE replacement."replaces_shipment_id" = shipment."id"
                                  )
                            )
                        )
                    )
                )
          )
    ) OR EXISTS (
        SELECT 1
        FROM "shipments" shipment
        WHERE shipment."order_id" = target_order_id
          AND shipment."status" IN ('DELIVERED', 'CANCELLED')
          AND NOT EXISTS (
              SELECT 1
              FROM "shipments" replacement
              WHERE replacement."replaces_shipment_id" = shipment."id"
          )
          AND (
              NOT EXISTS (
                  SELECT 1
                  FROM "shipment_plan_fulfilment_slots" allocation
                  WHERE allocation."shipment_plan_id" = shipment."shipment_plan_id"
              )
              OR EXISTS (
                  SELECT 1
                  FROM "shipment_plan_fulfilment_slots" allocation
                  JOIN "fulfilment_slots" slot
                    ON slot."id" = allocation."fulfilment_slot_id"
                  WHERE allocation."shipment_plan_id" = shipment."shipment_plan_id"
                    AND (
                        (shipment."status" = 'DELIVERED'
                         AND slot."outcome" <> 'DELIVERED')
                        OR (shipment."status" = 'CANCELLED'
                            AND slot."outcome" NOT IN ('CANCELLED', 'CANCELLED_REFUNDED'))
                    )
              )
          )
    ) THEN
        RAISE EXCEPTION 'ShipmentPlan terminal Shipment and fulfilment slots must transition atomically'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_slot_terminal_reconciliation_check';
    END IF;

    RETURN NULL;
END;
$$;

CREATE FUNCTION taven_job_is_current(target_job_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM "jobs" replacement
        WHERE replacement."replaces_job_id" = target_job_id
    );
$$;

CREATE OR REPLACE FUNCTION taven_reconcile_order_post_confirmation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid;
    target_status "order_status";
BEGIN
    target_order_id := CASE TG_TABLE_NAME
        WHEN 'orders' THEN (to_jsonb(NEW) ->> 'id')::uuid
        WHEN 'order_phases' THEN (to_jsonb(NEW) ->> 'order_id')::uuid
        WHEN 'jobs' THEN (to_jsonb(NEW) ->> 'order_id')::uuid
        WHEN 'shipments' THEN (to_jsonb(NEW) ->> 'order_id')::uuid
        ELSE (to_jsonb(NEW) ->> 'order_id')::uuid
    END;

    SELECT "status"
    INTO target_status
    FROM "orders"
    WHERE "id" = target_order_id
    FOR UPDATE;

    IF target_status IS NULL THEN
        RETURN NULL;
    END IF;

    -- Awaiting the balance payment is a live post-QC state with its own
    -- readiness and timeout reconciliation; the foundation lifecycle has no
    -- branch for it, but child cancellation updates still fire this trigger.
    IF target_status = 'AWAITING_BALANCE' THEN
        RETURN NULL;
    END IF;

    -- The dedicated balance-timeout constraint below validates this terminal
    -- state, including the phase disposition and completed refund lineage.
    IF target_status = 'CANCELLED_SETTLED'
       AND EXISTS (
           SELECT 1
           FROM "order_settlements" settlement
           WHERE settlement."order_id" = target_order_id
             AND settlement."kind" = 'BALANCE_SETTLEMENT'
       ) THEN
        RETURN NULL;
    END IF;

    IF target_status IN ('SHIPPED', 'DELIVERED', 'COMPLETED')
       AND EXISTS (
           SELECT 1
           FROM "payments" payment
           JOIN "refund_transactions" refund
             ON refund."payment_id" = payment."id"
           WHERE payment."order_id" = target_order_id
             AND payment."status" = 'REFUNDED'
             AND refund."reason" = 'CUSTOMER_CANCELLATION'
             AND refund."status" = 'SUCCEEDED'
       )
       AND NOT taven_has_refunded_post_void_handoff_reconciliation(
           target_order_id
       ) THEN
        RAISE EXCEPTION 'fulfilled order with a completed cancellation refund requires exact immutable handoff reconciliation and settlement proof'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunded_handoff_reconciliation_check';
    END IF;

    -- A carrier incident may legitimately end in a full refund after custody
    -- was transferred. Its terminal proof is the Claim/slot/refund graph, not
    -- cancellation of the already-handed-over production Jobs or parcel.
    IF target_status = 'REFUNDED'
       AND NOT EXISTS (
           SELECT 1 FROM "fulfilment_slots"
           WHERE "order_id" = target_order_id
             AND "outcome" <> 'CANCELLED_REFUNDED'
       )
       AND EXISTS (
           SELECT 1 FROM "claims"
           WHERE "order_id" = target_order_id
             AND "origin" = 'SHIPMENT_INCIDENT'
             AND "status" = 'RESOLVED_REFUND'
       )
       AND NOT EXISTS (
           SELECT 1
           FROM "refund_transactions" refund
           JOIN "payments" payment ON payment."id" = refund."payment_id"
           WHERE payment."order_id" = target_order_id
             AND refund."status" IN ('PENDING', 'SUSPENDED', 'FAILED')
       ) THEN
        RETURN NULL;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "jobs" job
        WHERE job."order_id" = target_order_id
          AND (
              (job."status" = 'HANDED_OVER'
               AND target_status NOT IN ('SHIPPED', 'DELIVERED', 'PARTIALLY_FULFILLED', 'REFUNDED'))
              OR (job."status" = 'SETTLED'
                  AND target_status NOT IN ('DELIVERED', 'COMPLETED', 'PARTIALLY_FULFILLED'))
          )
    ) THEN
        RAISE EXCEPTION 'Job handoff and settlement require the corresponding delivery lifecycle'
            USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
    END IF;

    -- The replacement constraint below proves the fresh held reservation and
    -- exact predecessor lineage. During that bounded recovery the current
    -- replacement leaf is the authoritative confirmed-order graph.
    IF target_status = 'CONFIRMED'
       AND EXISTS (
           SELECT 1 FROM "replacement_requests"
           WHERE "order_id" = target_order_id
             AND "status" IN ('OPEN', 'JOB_CREATED', 'REFUND_REQUIRED')
       ) THEN
        RETURN NULL;
    END IF;

    IF target_status IN ('DRAFT', 'QUOTED') THEN
        IF EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND (
                  phase."status" <> 'QUOTED'
                  OR phase."activated_at" IS NOT NULL
                  OR phase."qc_passed_at" IS NOT NULL
                  OR phase."shipped_at" IS NOT NULL
                  OR phase."delivered_at" IS NOT NULL
                  OR phase."completed_at" IS NOT NULL
                  OR phase."cancelled_at" IS NOT NULL
              )
        ) OR EXISTS (
            SELECT 1 FROM "jobs" job WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
        ) OR EXISTS (
            SELECT 1
            FROM "shipments"
            WHERE "order_id" = target_order_id
              AND (
                  "status" <> 'PLANNED'
                  OR "carrier" IS NOT NULL
                  OR "provider_shipment_id" IS NOT NULL
                  OR "carrier_label_id" IS NOT NULL
                  OR "tracking_code" IS NOT NULL
                  OR "label_created_at" IS NOT NULL
                  OR "cancellation_requested_at" IS NOT NULL
                  OR "provider_void_id" IS NOT NULL
                  OR "provider_voided_at" IS NOT NULL
                  OR "provider_acceptance_scan_id" IS NOT NULL
                  OR "handed_over_at" IS NOT NULL
                  OR "delivered_at" IS NOT NULL
                  OR "cancelled_at" IS NOT NULL
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'pre-confirmation order requires only quoted phase and initial fulfilment facts'
                USING ERRCODE = '23514', CONSTRAINT = 'pre_confirmation_fulfilment_state_check';
        END IF;
    ELSIF target_status = 'EXPIRED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."kind" = 'SINGLE'
              AND phase."status" = 'CANCELLED'
              AND phase."cancelled_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND (
                  phase."status" <> 'CANCELLED'
                  OR phase."cancelled_at" IS NULL
              )
        ) OR EXISTS (
            SELECT 1 FROM "jobs" job WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND (shipment."status" <> 'CANCELLED' OR shipment."cancelled_at" IS NULL)
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'CANCELLED'
        ) THEN
            RAISE EXCEPTION 'expired quoted order requires a closed pre-capture fulfilment graph'
                USING ERRCODE = '23514', CONSTRAINT = 'expired_order_checkout_closure_check';
        END IF;
    ELSIF target_status = 'CONFIRMED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."kind" = 'SINGLE'
              AND phase."status" = 'ACTIVE'
              AND phase."activated_at" IS NOT NULL
        ) OR NOT EXISTS (
            SELECT 1 FROM "jobs" job WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
              AND "status" NOT IN ('CREATED', 'ACCEPTED', 'GCODE_READY')
        ) OR EXISTS (
            SELECT 1
            FROM "shipments"
            WHERE "order_id" = target_order_id
              AND "status" <> 'PLANNED'
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'confirmed order requires its active phase and initial pre-production fulfilment facts'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'IN_PRODUCTION' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."kind" = 'SINGLE'
              AND phase."status" = 'IN_PRODUCTION'
        ) OR NOT EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
              AND "status" IN ('PRINTING', 'PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED')
              AND "printing_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
              AND "status" IN ('CANCELLED', 'FAILED', 'QC_REJECTED')
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" <> 'PLANNED'
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'in-production order requires production facts and initial fulfilment state'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'QC_PASSED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'QC_PASSED'
              AND phase."qc_passed_at" IS NOT NULL
        ) OR NOT EXISTS (
            SELECT 1 FROM "jobs" job WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
              AND (
                  "status" NOT IN ('QC_APPROVED', 'PACKED')
                  OR "qc_approved_at" IS NULL
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" NOT IN ('PLANNED', 'LABEL_CREATED')
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'QC-passed order requires complete QC and initial fulfilment state'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'READY_TO_SHIP' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'QC_PASSED'
              AND phase."qc_passed_at" IS NOT NULL
        ) OR NOT EXISTS (
            SELECT 1 FROM "jobs" job WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
              AND ("status" <> 'PACKED' OR "packed_at" IS NULL)
        ) OR NOT EXISTS (
            SELECT 1
            FROM "shipment_plans" plan
            JOIN "order_active_price_bindings" active_binding
              ON active_binding."order_id" = plan."order_id"
             AND active_binding."order_price_binding_id" = plan."order_price_binding_id"
            JOIN "order_price_bindings" binding
              ON binding."id" = active_binding."order_price_binding_id"
             AND binding."order_id" = plan."order_id"
             AND binding."delivery_destination_id" = plan."delivery_destination_id"
             AND binding."invalidated_at" IS NULL
            WHERE plan."order_id" = target_order_id
        ) OR EXISTS (
            SELECT 1
            FROM "shipment_plans" plan
            JOIN "order_active_price_bindings" active_binding
              ON active_binding."order_id" = plan."order_id"
             AND active_binding."order_price_binding_id" = plan."order_price_binding_id"
            JOIN "order_price_bindings" binding
              ON binding."id" = active_binding."order_price_binding_id"
             AND binding."order_id" = plan."order_id"
             AND binding."delivery_destination_id" = plan."delivery_destination_id"
             AND binding."invalidated_at" IS NULL
            WHERE plan."order_id" = target_order_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" shipment
                  WHERE shipment."order_id" = plan."order_id"
                    AND shipment."order_phase_id" = plan."order_phase_id"
                    AND shipment."shipment_plan_id" = plan."id"
                    AND shipment."delivery_destination_id" = plan."delivery_destination_id"
                    AND NOT EXISTS (
                        SELECT 1
                        FROM "shipments" replacement
                        WHERE replacement."replaces_shipment_id" = shipment."id"
                          AND replacement."order_id" = shipment."order_id"
                          AND replacement."order_phase_id" = shipment."order_phase_id"
                          AND replacement."shipment_plan_id" = shipment."shipment_plan_id"
                          AND replacement."delivery_destination_id" = shipment."delivery_destination_id"
                    )
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
              AND (
                  shipment."status" NOT IN ('LABEL_CREATED', 'CANCELLATION_PENDING')
                  OR shipment."carrier" IS NULL
                  OR shipment."provider_shipment_id" IS NULL
                  OR shipment."carrier_label_id" IS NULL
                  OR shipment."label_created_at" IS NULL
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'ready-to-ship order requires every Job packed and every Shipment labelled'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'SHIPPED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'SHIPPED'
              AND phase."shipped_at" IS NOT NULL
        ) OR NOT EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED')
              AND shipment."handed_over_at" IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" NOT IN ('LABEL_CREATED', 'CANCELLATION_PENDING', 'HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED')
              AND NOT (
                  shipment."status" = 'CANCELLED'
                  AND taven_has_refunded_post_void_handoff_reconciliation(
                      target_order_id
                  )
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR NOT EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
              AND "status" = 'HANDED_OVER'
              AND "handed_over_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
              AND "status" NOT IN ('PACKED', 'HANDED_OVER')
              AND NOT (
                  "status" = 'CANCELLED'
                  AND taven_has_refunded_post_void_handoff_reconciliation(
                      target_order_id
                  )
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED')
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
              AND (
                  NOT EXISTS (
                      SELECT 1
                      FROM "jobs" job
                      WHERE job."order_id" = shipment."order_id"
                        AND job."order_phase_id" = shipment."order_phase_id"
                        AND job."shipment_plan_id" = shipment."shipment_plan_id"
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM "jobs" job
                      WHERE job."order_id" = shipment."order_id"
                        AND job."order_phase_id" = shipment."order_phase_id"
                        AND job."shipment_plan_id" = shipment."shipment_plan_id"
                        AND (
                            job."status" <> 'HANDED_OVER'
                            OR job."handed_over_at" IS NULL
                        )
                  )
              )
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND job."status" = 'HANDED_OVER'
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" shipment
                  WHERE shipment."order_id" = job."order_id"
                    AND shipment."order_phase_id" = job."order_phase_id"
                    AND shipment."shipment_plan_id" = job."shipment_plan_id"
                    AND shipment."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED')
                    AND shipment."handed_over_at" IS NOT NULL
                    AND NOT EXISTS (
                        SELECT 1
                        FROM "shipments" replacement
                        WHERE replacement."replaces_shipment_id" = shipment."id"
                    )
              )
        ) OR (
            NOT EXISTS (
                SELECT 1
                FROM "shipments" shipment
                WHERE shipment."order_id" = target_order_id
                  AND shipment."status" <> 'DELIVERED'
                  AND NOT EXISTS (
                      SELECT 1
                      FROM "shipments" replacement
                      WHERE replacement."replaces_shipment_id" = shipment."id"
                  )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM "fulfilment_slots"
                WHERE "order_id" = target_order_id
                  AND "outcome" <> 'DELIVERED'
            )
        ) THEN
            RAISE EXCEPTION 'shipped order requires matched handoff evidence and must advance after final delivery'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'DELIVERED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'DELIVERED'
              AND phase."delivered_at" IS NOT NULL
        ) OR NOT EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND (shipment."status" <> 'DELIVERED' OR shipment."delivered_at" IS NULL)
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
              AND (
                  NOT EXISTS (
                      SELECT 1
                      FROM "jobs" job
                      WHERE job."order_id" = shipment."order_id"
                        AND job."order_phase_id" = shipment."order_phase_id"
                        AND job."shipment_plan_id" = shipment."shipment_plan_id"
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM "jobs" job
                      WHERE job."order_id" = shipment."order_id"
                        AND job."order_phase_id" = shipment."order_phase_id"
                        AND job."shipment_plan_id" = shipment."shipment_plan_id"
                        AND (
                            job."status" NOT IN ('HANDED_OVER', 'SETTLED')
                            OR job."handed_over_at" IS NULL
                        )
                  )
              )
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" shipment
                  WHERE shipment."order_id" = job."order_id"
                    AND shipment."order_phase_id" = job."order_phase_id"
                    AND shipment."shipment_plan_id" = job."shipment_plan_id"
                    AND shipment."status" = 'DELIVERED'
                    AND shipment."handed_over_at" IS NOT NULL
                    AND shipment."delivered_at" IS NOT NULL
                    AND NOT EXISTS (
                        SELECT 1
                        FROM "shipments" replacement
                        WHERE replacement."replaces_shipment_id" = shipment."id"
                    )
              )
        ) OR NOT EXISTS (
            SELECT 1 FROM "fulfilment_slots" WHERE "order_id" = target_order_id
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'DELIVERED'
        ) THEN
            RAISE EXCEPTION 'delivered order requires every Shipment, Job, and fulfilment slot delivered'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'COMPLETED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'COMPLETED'
              AND phase."completed_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND (shipment."status" <> 'DELIVERED' OR shipment."delivered_at" IS NULL)
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'DELIVERED'
        ) OR NOT EXISTS (
            SELECT 1 FROM "jobs" job WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
              AND "status" <> 'SETTLED'
        ) THEN
            RAISE EXCEPTION 'completed order requires its complete settled delivery aggregate'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'RECOVERY_PENDING' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'RECOVERY_PENDING'
        ) OR NOT EXISTS (
            SELECT 1
            FROM "replacement_requests" request
            WHERE request."order_id" = target_order_id
              AND request."status" IN ('OPEN', 'JOB_CREATED', 'REFUND_REQUIRED')
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND shipment."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED')
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'PENDING'
        ) THEN
            RAISE EXCEPTION 'recovery-pending order requires a pre-handoff replacement or refund obligation'
                USING ERRCODE = '23514', CONSTRAINT = 'order_recovery_pending_check';
        END IF;
    ELSIF target_status = 'PARTIALLY_FULFILLED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'PARTIALLY_FULFILLED'
        ) OR NOT EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" = 'DELIVERED'
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" NOT IN ('DELIVERED', 'CANCELLED_REFUNDED')
        ) OR EXISTS (
            SELECT 1
            FROM "claims"
            WHERE "order_id" = target_order_id
              AND "status" IN ('OPEN', 'ACTIVE')
        ) OR EXISTS (
            SELECT 1
            FROM "refund_transactions" refund
            JOIN "payments" payment ON payment."id" = refund."payment_id"
            WHERE payment."order_id" = target_order_id
              AND refund."status" IN ('PENDING', 'SUSPENDED')
        ) THEN
            RAISE EXCEPTION 'partially fulfilled order requires delivered and financially resolved slot outcomes'
                USING ERRCODE = '23514', CONSTRAINT = 'order_partial_fulfilment_check';
        END IF;
    ELSIF target_status = 'CANCELLED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'CANCELLED'
              AND phase."cancelled_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
              AND "status" NOT IN ('CANCELLED', 'FAILED', 'QC_REJECTED')
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND (shipment."status" <> 'CANCELLED' OR shipment."cancelled_at" IS NULL)
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'CANCELLED'
        ) THEN
            RAISE EXCEPTION 'cancelled order requires terminal phase, Jobs, Shipments, and slots'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSIF target_status = 'REFUNDED' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "order_phases" phase
            WHERE phase."order_id" = target_order_id
              AND phase."status" = 'CANCELLED_REFUNDED'
              AND phase."cancelled_at" IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM "jobs" job
            WHERE job."order_id" = target_order_id
              AND taven_job_is_current(job."id")
              AND "status" NOT IN ('CANCELLED', 'FAILED', 'QC_REJECTED')
        ) OR EXISTS (
            SELECT 1
            FROM "shipments" shipment
            WHERE shipment."order_id" = target_order_id
              AND (shipment."status" <> 'CANCELLED' OR shipment."cancelled_at" IS NULL)
              AND NOT EXISTS (
                  SELECT 1
                  FROM "shipments" replacement
                  WHERE replacement."replaces_shipment_id" = shipment."id"
              )
        ) OR EXISTS (
            SELECT 1
            FROM "fulfilment_slots"
            WHERE "order_id" = target_order_id
              AND "outcome" <> 'CANCELLED_REFUNDED'
        ) THEN
            RAISE EXCEPTION 'refunded order requires terminal cancelled phase, Jobs, Shipments, and slots'
                USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
        END IF;
    ELSE
        RAISE EXCEPTION 'order status requires persistence not available in this tranche'
            USING ERRCODE = '23514', CONSTRAINT = 'order_post_confirmation_lifecycle_check';
    END IF;

    RETURN NULL;
END;
$$;



CREATE TRIGGER "job_shipment_assignments_immutable"
BEFORE UPDATE OR DELETE ON "job_shipment_assignments"
FOR EACH ROW EXECUTE FUNCTION taven_reject_immutable_fulfilment_history_mutation();
CREATE TRIGGER "price_adjustments_immutable"
BEFORE UPDATE OR DELETE ON "price_adjustments"
FOR EACH ROW EXECUTE FUNCTION taven_reject_immutable_fulfilment_history_mutation();

CREATE FUNCTION taven_validate_fulfilment_recovery_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    scoped_order_id uuid;
    scoped_phase_id uuid;
    scoped_plan_id uuid;
    scoped_currency char(3);
BEGIN
    IF TG_TABLE_NAME = 'replacement_requests' THEN
        SELECT job."order_id", job."order_phase_id", job."shipment_plan_id"
        INTO scoped_order_id, scoped_phase_id, scoped_plan_id
        FROM "jobs" job
        WHERE job."id" = NEW."source_job_id";
        IF NOT FOUND
           OR (scoped_order_id, scoped_phase_id, scoped_plan_id)
              IS DISTINCT FROM (NEW."order_id", NEW."order_phase_id", NEW."shipment_plan_id")
           OR (NEW."replacement_job_id" IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM "jobs" replacement
                WHERE replacement."id" = NEW."replacement_job_id"
                  AND replacement."replaces_job_id" = NEW."source_job_id"
                  AND replacement."order_id" = NEW."order_id"
                  AND replacement."order_phase_id" = NEW."order_phase_id"
                  AND replacement."shipment_plan_id" = NEW."shipment_plan_id"
           ))
           OR (NEW."phase_reservation_set_id" IS NOT NULL AND NOT EXISTS (
                SELECT 1
                FROM "phase_reservation_sets" reservation_set
                JOIN "phase_resource_plans" resource_plan
                  ON resource_plan."id" = reservation_set."phase_resource_plan_id"
                 AND resource_plan."node_id" = reservation_set."node_id"
                WHERE reservation_set."id" = NEW."phase_reservation_set_id"
                  AND reservation_set."status" = 'HELD'
                  AND resource_plan."order_phase_id" = NEW."order_phase_id"
           )) THEN
            RAISE EXCEPTION 'replacement request must preserve its exact Job, phase, plan, and reservation scope'
                USING ERRCODE = '23514', CONSTRAINT = 'replacement_request_scope_check';
        END IF;
    ELSIF TG_TABLE_NAME = 'claims' THEN
        IF NEW."incident_shipment_id" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "shipments" shipment
            WHERE shipment."id" = NEW."incident_shipment_id"
              AND shipment."order_id" = NEW."order_id"
              AND shipment."order_phase_id" = NEW."order_phase_id"
        ) THEN
            RAISE EXCEPTION 'Claim incident Shipment must belong to the exact order phase'
                USING ERRCODE = '23514', CONSTRAINT = 'claim_incident_scope_check';
        END IF;
    ELSIF TG_TABLE_NAME = 'claim_slot_resolutions' THEN
        SELECT claim."order_id", claim."order_phase_id"
        INTO scoped_order_id, scoped_phase_id
        FROM "claims" claim WHERE claim."id" = NEW."claim_id";
        IF NOT EXISTS (
            SELECT 1 FROM "fulfilment_slots" slot
            WHERE slot."id" = NEW."fulfilment_slot_id"
              AND slot."order_id" = scoped_order_id
              AND slot."order_phase_id" = scoped_phase_id
        ) OR (NEW."replacement_shipment_id" IS NOT NULL AND NOT EXISTS (
            SELECT 1
            FROM "shipments" shipment
            JOIN "shipment_plan_fulfilment_slots" allocation
              ON allocation."shipment_plan_id" = shipment."shipment_plan_id"
            WHERE shipment."id" = NEW."replacement_shipment_id"
              AND shipment."order_id" = scoped_order_id
              AND shipment."order_phase_id" = scoped_phase_id
              AND allocation."fulfilment_slot_id" = NEW."fulfilment_slot_id"
        )) THEN
            RAISE EXCEPTION 'Claim slot resolution must preserve exact order, phase, slot, and Shipment scope'
                USING ERRCODE = '23514', CONSTRAINT = 'claim_slot_resolution_scope_check';
        END IF;
    ELSE
        SELECT payment."order_id", payment."currency"
        INTO scoped_order_id, scoped_currency
        FROM "payments" payment WHERE payment."id" = NEW."payment_id";
        IF NEW."payment_id" IS NOT NULL
           AND (NOT FOUND OR scoped_order_id <> NEW."order_id"
                OR scoped_currency <> NEW."currency") THEN
            RAISE EXCEPTION 'PriceAdjustment Payment must match its order and currency'
                USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_scope_check';
        END IF;
        IF NEW."claim_id" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "claims" claim
            WHERE claim."id" = NEW."claim_id" AND claim."order_id" = NEW."order_id"
        ) THEN
            RAISE EXCEPTION 'PriceAdjustment Claim must belong to its order'
                USING ERRCODE = '23514', CONSTRAINT = 'price_adjustment_scope_check';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "replacement_requests_scope_valid"
BEFORE INSERT OR UPDATE ON "replacement_requests"
FOR EACH ROW EXECUTE FUNCTION taven_validate_fulfilment_recovery_scope();
CREATE TRIGGER "claims_scope_valid"
BEFORE INSERT OR UPDATE ON "claims"
FOR EACH ROW EXECUTE FUNCTION taven_validate_fulfilment_recovery_scope();
CREATE TRIGGER "claim_slot_resolutions_scope_valid"
BEFORE INSERT OR UPDATE ON "claim_slot_resolutions"
FOR EACH ROW EXECUTE FUNCTION taven_validate_fulfilment_recovery_scope();
CREATE TRIGGER "price_adjustments_scope_valid"
BEFORE INSERT ON "price_adjustments"
FOR EACH ROW EXECUTE FUNCTION taven_validate_fulfilment_recovery_scope();

CREATE FUNCTION taven_reconcile_job_replacement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_job_id uuid;
BEGIN
    target_job_id := CASE
        WHEN TG_TABLE_NAME = 'jobs' THEN (to_jsonb(NEW) ->> 'id')::uuid
        ELSE coalesce(
            (to_jsonb(NEW) ->> 'replacement_job_id')::uuid,
            (to_jsonb(NEW) ->> 'source_job_id')::uuid
        )
    END;
    IF EXISTS (
        SELECT 1
        FROM "jobs" replacement
        JOIN "jobs" source ON source."id" = replacement."replaces_job_id"
        LEFT JOIN "replacement_requests" request
          ON request."source_job_id" = source."id"
         AND request."replacement_job_id" = replacement."id"
        LEFT JOIN "production_reservations" production
          ON production."job_id" = replacement."id"
         AND production."node_id" = replacement."node_id"
         AND production."phase_resource_plan_job_id" = replacement."phase_resource_plan_job_id"
        LEFT JOIN "phase_reservation_sets" reservation_set
          ON reservation_set."id" = production."phase_reservation_set_id"
        WHERE replacement."id" = target_job_id
          AND (
              source."status" NOT IN ('FAILED', 'QC_REJECTED')
              OR source."order_id" <> replacement."order_id"
              OR source."order_phase_id" <> replacement."order_phase_id"
              OR source."shipment_plan_id" <> replacement."shipment_plan_id"
              OR request."id" IS NULL
              OR request."status" <> 'JOB_CREATED'
              OR request."phase_reservation_set_id" <> reservation_set."id"
              OR reservation_set."status" <> 'HELD'
              OR production."status" <> 'HELD'
          )
    ) THEN
        RAISE EXCEPTION 'replacement Job requires a terminal predecessor and a fresh held reservation'
            USING ERRCODE = '23514', CONSTRAINT = 'job_replacement_reservation_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "jobs_replacement_reconciled"
AFTER INSERT OR UPDATE OF "status", "replaces_job_id" ON "jobs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_job_replacement();
CREATE CONSTRAINT TRIGGER "replacement_requests_job_reconciled"
AFTER INSERT OR UPDATE ON "replacement_requests"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_job_replacement();

CREATE FUNCTION taven_reconcile_job_shipment_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id uuid := NEW."order_id";
BEGIN
    IF TG_TABLE_NAME = 'jobs' THEN
        target_order_id := NEW."order_id";
    ELSIF TG_TABLE_NAME = 'shipments' THEN
        target_order_id := NEW."order_id";
    END IF;

    -- Existing provider-race reconciliation moves the proven Job and Shipment
    -- leaves atomically at the database boundary. Materialize the unambiguous
    -- one-parcel binding for that legacy path before validating the invariant.
    INSERT INTO "job_shipment_assignments" (
        "job_id", "shipment_id", "shipment_plan_id", "order_id",
        "order_phase_id", "assigned_at"
    )
    SELECT job."id", shipment."id", job."shipment_plan_id", job."order_id",
           job."order_phase_id", coalesce(job."handed_over_at", clock_timestamp())
    FROM "jobs" job
    JOIN "shipments" shipment
      ON shipment."order_id" = job."order_id"
     AND shipment."order_phase_id" = job."order_phase_id"
     AND shipment."shipment_plan_id" = job."shipment_plan_id"
    WHERE job."order_id" = target_order_id
      AND job."status" IN ('HANDED_OVER', 'SETTLED')
      AND shipment."status" IN (
          'HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED'
      )
      AND NOT EXISTS (
          SELECT 1 FROM "jobs" replacement
          WHERE replacement."replaces_job_id" = job."id"
      )
      AND NOT EXISTS (
          SELECT 1 FROM "shipments" successor
          WHERE successor."replaces_shipment_id" = shipment."id"
      )
      AND NOT EXISTS (
          SELECT 1 FROM "job_shipment_assignments" existing
          WHERE existing."job_id" = job."id"
      )
      AND (
          SELECT count(*)
          FROM "shipments" current_shipment
          WHERE current_shipment."order_id" = job."order_id"
            AND current_shipment."order_phase_id" = job."order_phase_id"
            AND current_shipment."shipment_plan_id" = job."shipment_plan_id"
            AND current_shipment."status" IN (
                'HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED'
            )
            AND NOT EXISTS (
                SELECT 1 FROM "shipments" successor
                WHERE successor."replaces_shipment_id" = current_shipment."id"
            )
      ) = 1
    ON CONFLICT ("job_id") DO NOTHING;

    IF EXISTS (
        SELECT 1
        FROM "job_shipment_assignments" assignment
        JOIN "jobs" job ON job."id" = assignment."job_id"
        JOIN "shipments" shipment ON shipment."id" = assignment."shipment_id"
        WHERE assignment."order_id" = target_order_id
          AND (
              job."shipment_plan_id" <> shipment."shipment_plan_id"
              OR EXISTS (
                  SELECT 1 FROM "jobs" replacement
                  WHERE replacement."replaces_job_id" = job."id"
              )
              OR EXISTS (
                  SELECT 1 FROM "shipments" successor
                  WHERE successor."replaces_shipment_id" = shipment."id"
              )
              OR (job."status" IN ('HANDED_OVER', 'SETTLED')
                  AND shipment."status" NOT IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED'))
          )
    ) OR EXISTS (
        SELECT 1
        FROM "shipments" shipment
        WHERE shipment."order_id" = target_order_id
          AND shipment."status" IN ('HANDED_OVER', 'IN_TRANSIT', 'DELIVERED', 'LOST', 'RETURNED', 'RECOVERED')
          AND NOT EXISTS (
              SELECT 1
              FROM "jobs" job
              JOIN "job_shipment_assignments" assignment
                ON assignment."job_id" = job."id"
               AND assignment."shipment_id" = shipment."id"
              WHERE job."shipment_plan_id" = shipment."shipment_plan_id"
                AND job."order_id" = shipment."order_id"
                AND NOT EXISTS (
                    SELECT 1 FROM "jobs" replacement
                    WHERE replacement."replaces_job_id" = job."id"
                )
                AND job."status" IN ('HANDED_OVER', 'SETTLED')
          )
    ) THEN
        RAISE EXCEPTION 'Job packing and handoff must bind one current Shipment in the same parcel plan'
            USING ERRCODE = '23514', CONSTRAINT = 'job_shipment_assignment_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "job_shipment_assignments_reconciled"
AFTER INSERT ON "job_shipment_assignments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_job_shipment_assignment();
CREATE CONSTRAINT TRIGGER "jobs_shipment_assignments_reconciled"
AFTER UPDATE OF "status" ON "jobs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_job_shipment_assignment();
CREATE CONSTRAINT TRIGGER "shipments_job_assignments_reconciled"
AFTER UPDATE OF "status" ON "shipments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_job_shipment_assignment();

CREATE OR REPLACE FUNCTION taven_protect_job_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'CREATED'
           OR NEW."accepted_at" IS NOT NULL
           OR NEW."payout_amount" IS NOT NULL
           OR NEW."payout_currency" IS NOT NULL
           OR NEW."gcode_ready_at" IS NOT NULL
           OR NEW."production_slice_result_id" IS NOT NULL
           OR NEW."production_artifact_hash" IS NOT NULL
           OR NEW."printing_at" IS NOT NULL
           OR NEW."printed_at" IS NOT NULL
           OR NEW."photo_submitted_at" IS NOT NULL
           OR NEW."qc_photo_asset_id" IS NOT NULL
           OR NEW."qc_evidence_omission_reason" IS NOT NULL
           OR NEW."qc_approved_at" IS NOT NULL
           OR NEW."qc_rejected_at" IS NOT NULL
           OR NEW."packed_at" IS NOT NULL
           OR NEW."handed_over_at" IS NOT NULL
           OR NEW."settled_at" IS NOT NULL
           OR NEW."failed_at" IS NOT NULL
           OR NEW."failure_stage" IS NOT NULL
           OR NEW."failure_reason" IS NOT NULL
           OR NEW."cancelled_at" IS NOT NULL
           OR NEW."cancellation_reason" IS NOT NULL THEN
            RAISE EXCEPTION 'new Jobs must begin created without lifecycle evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'job_initial_status_check';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Jobs are stable production history and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_immutable_check';
    END IF;

    IF greatest(
        NEW."accepted_at", NEW."gcode_ready_at", NEW."printing_at",
        NEW."printed_at", NEW."photo_submitted_at", NEW."qc_approved_at",
        NEW."qc_rejected_at", NEW."packed_at", NEW."handed_over_at",
        NEW."settled_at", NEW."failed_at", NEW."cancelled_at"
    ) > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'Job lifecycle evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_evidence_check';
    END IF;

    IF NEW."status" IS NOT DISTINCT FROM OLD."status"
       AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM
           (to_jsonb(OLD) - 'updated_at') THEN
        RAISE EXCEPTION 'Job identity and lifecycle evidence are immutable outside a status transition'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_immutable_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'CREATED' AND NEW."status" IN ('ACCEPTED', 'CANCELLED'))
           OR (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('GCODE_READY', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'GCODE_READY' AND NEW."status" IN ('PRINTING', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'PRINTING' AND NEW."status" IN ('PRINTED', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'PRINTED' AND NEW."status" IN ('PHOTO_SUBMITTED', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'PHOTO_SUBMITTED' AND NEW."status" IN ('QC_APPROVED', 'QC_REJECTED', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'QC_APPROVED' AND NEW."status" IN ('PACKED', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'PACKED' AND NEW."status" IN ('HANDED_OVER', 'CANCELLED', 'FAILED'))
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'HANDED_OVER'
               AND (
                   (EXISTS (
                       SELECT 1 FROM "orders" target_order
                       WHERE target_order."id" = NEW."order_id"
                         AND target_order."status" = 'CANCELLED'
                    ) AND taven_has_reconciled_post_void_handoff(
                       NEW."order_id", NEW."order_phase_id",
                       NEW."shipment_plan_id", NULL, NEW."id",
                       NEW."handed_over_at"
                   ))
                   OR
                   (EXISTS (
                       SELECT 1 FROM "orders" target_order
                       WHERE target_order."id" = NEW."order_id"
                         AND target_order."status" IN ('REFUNDED', 'SHIPPED')
                    ) AND taven_has_refunded_post_void_handoff_reconciliation(
                       NEW."order_id", NEW."order_phase_id",
                       NEW."shipment_plan_id", NULL, NEW."id",
                       NEW."handed_over_at"
                   ))
               ))
           OR (OLD."status" = 'HANDED_OVER' AND NEW."status" = 'SETTLED')
       ) THEN
        RAISE EXCEPTION 'Job status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'job_status_transition_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND (
       NEW."status" = 'ACCEPTED' AND NOT (
        OLD."accepted_at" IS NULL AND NEW."accepted_at" IS NOT NULL
        AND OLD."payout_amount" IS NULL AND NEW."payout_amount" IS NOT NULL
        AND OLD."payout_currency" IS NULL AND NEW."payout_currency" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'accepted_at', 'payout_amount', 'payout_currency']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'accepted_at', 'payout_amount', 'payout_currency'])
    ) OR NEW."status" = 'GCODE_READY' AND NOT (
        OLD."gcode_ready_at" IS NULL AND NEW."gcode_ready_at" IS NOT NULL
        AND OLD."production_slice_result_id" IS NULL AND NEW."production_slice_result_id" IS NOT NULL
        AND OLD."production_artifact_hash" IS NULL AND NEW."production_artifact_hash" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'gcode_ready_at', 'production_slice_result_id', 'production_artifact_hash']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'gcode_ready_at', 'production_slice_result_id', 'production_artifact_hash'])
    ) OR NEW."status" = 'PRINTING' AND NOT (
        OLD."printing_at" IS NULL AND NEW."printing_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'printing_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'printing_at'])
    ) OR NEW."status" = 'PRINTED' AND NOT (
        OLD."printed_at" IS NULL AND NEW."printed_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'printed_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'printed_at'])
    ) OR NEW."status" = 'PHOTO_SUBMITTED' AND NOT (
        OLD."photo_submitted_at" IS NULL AND NEW."photo_submitted_at" IS NOT NULL
        AND OLD."qc_photo_asset_id" IS NULL
        AND OLD."qc_evidence_omission_reason" IS NULL
        AND ((NEW."qc_photo_asset_id" IS NOT NULL AND NEW."qc_evidence_omission_reason" IS NULL)
             OR (NEW."qc_photo_asset_id" IS NULL AND NEW."qc_evidence_omission_reason" ~ '[^[:space:]]'))
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'photo_submitted_at', 'qc_photo_asset_id', 'qc_evidence_omission_reason']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'photo_submitted_at', 'qc_photo_asset_id', 'qc_evidence_omission_reason'])
    ) OR NEW."status" = 'QC_APPROVED' AND NOT (
        OLD."qc_approved_at" IS NULL AND NEW."qc_approved_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'qc_approved_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'qc_approved_at'])
    ) OR NEW."status" = 'QC_REJECTED' AND NOT (
        OLD."qc_rejected_at" IS NULL AND NEW."qc_rejected_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'qc_rejected_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'qc_rejected_at'])
    ) OR NEW."status" = 'PACKED' AND NOT (
        OLD."packed_at" IS NULL AND NEW."packed_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'packed_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'packed_at'])
    ) OR NEW."status" = 'HANDED_OVER' AND NOT (
        OLD."handed_over_at" IS NULL AND NEW."handed_over_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'handed_over_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'handed_over_at'])
    ) OR NEW."status" = 'SETTLED' AND NOT (
        OLD."settled_at" IS NULL AND NEW."settled_at" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'settled_at']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'settled_at'])
    ) OR NEW."status" = 'FAILED' AND NOT (
        OLD."failed_at" IS NULL AND NEW."failed_at" IS NOT NULL
        AND OLD."failure_stage" IS NULL AND NEW."failure_stage" IS NOT NULL
        AND OLD."failure_reason" IS NULL AND NEW."failure_reason" ~ '[^[:space:]]'
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'failed_at', 'failure_stage', 'failure_reason']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'failed_at', 'failure_stage', 'failure_reason'])
    ) OR NEW."status" = 'CANCELLED' AND NOT (
        OLD."cancelled_at" IS NULL AND NEW."cancelled_at" IS NOT NULL
        AND OLD."cancellation_reason" IS NULL AND NEW."cancellation_reason" IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'cancelled_at', 'cancellation_reason']) =
            (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'cancelled_at', 'cancellation_reason'])
    )) THEN
        RAISE EXCEPTION 'Job transition may assign only its own lifecycle evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_evidence_check';
    END IF;

    IF (NEW."status" IN ('ACCEPTED', 'GCODE_READY', 'PRINTING', 'PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
        AND NEW."accepted_at" IS NULL)
       OR (NEW."status" IN ('GCODE_READY', 'PRINTING', 'PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND (NEW."gcode_ready_at" IS NULL OR NEW."production_slice_result_id" IS NULL OR NEW."production_artifact_hash" IS NULL))
       OR (NEW."status" IN ('PRINTING', 'PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND NEW."printing_at" IS NULL)
       OR (NEW."status" IN ('PRINTED', 'PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND NEW."printed_at" IS NULL)
       OR (NEW."status" IN ('PHOTO_SUBMITTED', 'QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND (NEW."photo_submitted_at" IS NULL
                OR (NEW."qc_photo_asset_id" IS NULL
                    AND NEW."qc_evidence_omission_reason" IS NULL)))
       OR (NEW."status" IN ('QC_APPROVED', 'PACKED', 'HANDED_OVER', 'SETTLED')
           AND NEW."qc_approved_at" IS NULL)
       OR (NEW."status" IN ('PACKED', 'HANDED_OVER', 'SETTLED') AND NEW."packed_at" IS NULL)
       OR (NEW."status" IN ('HANDED_OVER', 'SETTLED') AND NEW."handed_over_at" IS NULL)
       OR (NEW."status" = 'SETTLED' AND NEW."settled_at" IS NULL)
       OR (NEW."status" = 'QC_REJECTED' AND NEW."qc_rejected_at" IS NULL)
       OR (NEW."status" = 'FAILED' AND (NEW."failed_at" IS NULL OR NEW."failure_stage" IS NULL OR NEW."failure_reason" IS NULL))
       OR (NEW."status" = 'CANCELLED' AND (NEW."cancelled_at" IS NULL OR NEW."cancellation_reason" IS NULL)) THEN
        RAISE EXCEPTION 'Job lifecycle state requires its complete timestamp evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_evidence_check';
    END IF;

    IF (NEW."accepted_at" IS NOT NULL AND NEW."gcode_ready_at" IS NOT NULL
        AND NEW."gcode_ready_at" < NEW."accepted_at")
       OR (NEW."gcode_ready_at" IS NOT NULL AND NEW."printing_at" IS NOT NULL
           AND NEW."printing_at" < NEW."gcode_ready_at")
       OR (NEW."printing_at" IS NOT NULL AND NEW."printed_at" IS NOT NULL
           AND NEW."printed_at" < NEW."printing_at")
       OR (NEW."printed_at" IS NOT NULL AND NEW."photo_submitted_at" IS NOT NULL
           AND NEW."photo_submitted_at" < NEW."printed_at")
       OR (NEW."photo_submitted_at" IS NOT NULL AND NEW."qc_approved_at" IS NOT NULL
           AND NEW."qc_approved_at" < NEW."photo_submitted_at")
       OR (NEW."photo_submitted_at" IS NOT NULL AND NEW."qc_rejected_at" IS NOT NULL
           AND NEW."qc_rejected_at" < NEW."photo_submitted_at")
       OR (NEW."printing_at" IS NOT NULL AND NEW."qc_approved_at" IS NOT NULL
           AND NEW."qc_approved_at" < NEW."printing_at")
       OR (NEW."qc_approved_at" IS NOT NULL AND NEW."packed_at" IS NOT NULL
           AND NEW."packed_at" < NEW."qc_approved_at")
       OR (NEW."packed_at" IS NOT NULL AND NEW."handed_over_at" IS NOT NULL
           AND NEW."handed_over_at" < NEW."packed_at" - interval '5 seconds')
       OR (NEW."handed_over_at" IS NOT NULL AND NEW."settled_at" IS NOT NULL
           AND NEW."settled_at" < NEW."handed_over_at" - interval '5 seconds') THEN
        RAISE EXCEPTION 'Job lifecycle timestamps must be chronological'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_evidence_check';
    END IF;

    IF (NEW."status" = 'FAILED' AND NEW."failed_at" < CASE OLD."status"
            WHEN 'ACCEPTED' THEN OLD."accepted_at"
            WHEN 'GCODE_READY' THEN OLD."gcode_ready_at"
            WHEN 'PRINTING' THEN OLD."printing_at"
            WHEN 'PRINTED' THEN OLD."printed_at"
            WHEN 'PHOTO_SUBMITTED' THEN OLD."photo_submitted_at"
            WHEN 'QC_APPROVED' THEN OLD."qc_approved_at"
            WHEN 'PACKED' THEN OLD."packed_at"
        END)
       OR (NEW."status" = 'CANCELLED' AND NEW."cancelled_at" < CASE OLD."status"
            WHEN 'CREATED' THEN OLD."created_at"
            WHEN 'ACCEPTED' THEN OLD."accepted_at"
            WHEN 'GCODE_READY' THEN OLD."gcode_ready_at"
            WHEN 'PRINTING' THEN OLD."printing_at"
            WHEN 'PRINTED' THEN OLD."printed_at"
            WHEN 'PHOTO_SUBMITTED' THEN OLD."photo_submitted_at"
            WHEN 'QC_APPROVED' THEN OLD."qc_approved_at"
            WHEN 'PACKED' THEN OLD."packed_at"
        END) THEN
        RAISE EXCEPTION 'Job terminal evidence cannot predate its source state'
            USING ERRCODE = '23514', CONSTRAINT = 'job_lifecycle_evidence_check';
    END IF;

    IF NEW."status" = 'GCODE_READY' AND NOT EXISTS (
        SELECT 1
        FROM "production_reservations" production
        JOIN "slice_results" slice ON slice."id" = NEW."production_slice_result_id"
        WHERE production."job_id" = NEW."id"
          AND production."node_id" = NEW."node_id"
          AND production."phase_resource_plan_job_id" = NEW."phase_resource_plan_job_id"
          AND production."slice_result_id" = slice."id"
          AND slice."kind" = 'PRODUCTION'
          AND slice."artifact_hash" = NEW."production_artifact_hash"
    ) THEN
        RAISE EXCEPTION 'G-code readiness requires the sealed production slice from the exact Job reservation'
            USING ERRCODE = '23514', CONSTRAINT = 'job_gcode_artifact_check';
    END IF;

    IF NEW."status" = 'PHOTO_SUBMITTED'
       AND NEW."qc_photo_asset_id" IS NOT NULL THEN
        PERFORM 1
        FROM "photo_assets" photo
        WHERE photo."id" = NEW."qc_photo_asset_id"
          AND photo."kind" = 'QC'
          AND photo."scope_kind" = 'JOB'
          AND photo."scope_id" = NEW."id"
          AND photo."uploaded_at" <= NEW."photo_submitted_at"
          AND photo."photo_delete_after" > NEW."photo_submitted_at"
          AND photo."retention_hold" IN ('ACTIVE_ORDER', 'ACTIVE_CLAIM', 'LEGAL')
          AND photo."deleted_at" IS NULL
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'photo submission requires an active retained QC PhotoAsset for the exact Job'
                USING ERRCODE = '23514', CONSTRAINT = 'job_qc_photo_asset_check';
        END IF;
    END IF;

    IF NEW."status" = 'FAILED' AND NOT (
        (OLD."status" IN ('ACCEPTED', 'GCODE_READY') AND NEW."failure_stage" IN ('PREPARATION', 'GCODE', 'MACHINE'))
        OR (OLD."status" = 'PRINTING' AND NEW."failure_stage" = 'PRINTING')
        OR (OLD."status" IN ('PRINTED', 'PHOTO_SUBMITTED') AND NEW."failure_stage" = 'POST_PRINT')
        OR (OLD."status" = 'QC_APPROVED' AND NEW."failure_stage" = 'POST_QC')
        OR (OLD."status" = 'PACKED' AND NEW."failure_stage" = 'PACKING')
    ) THEN
        RAISE EXCEPTION 'failure stage must match the Job source state'
            USING ERRCODE = '23514', CONSTRAINT = 'job_failure_stage_check';
    END IF;

    IF NEW."status" = 'CANCELLED' AND NOT (
        (OLD."status" = 'CREATED' AND NEW."cancellation_reason" IN ('ROUTING_EXHAUSTED', 'ORDER_CANCELLED'))
        OR (OLD."status" <> 'CREATED' AND NEW."cancellation_reason" IN ('ORDER_CANCELLED', 'PHASE_CANCELLED', 'CLAIM_WITHDRAWN'))
    ) THEN
        RAISE EXCEPTION 'cancellation reason must match the Job source state'
            USING ERRCODE = '23514', CONSTRAINT = 'job_cancellation_reason_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION taven_validate_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'DRAFT'
           OR NEW."quoted_at" IS NOT NULL
           OR NEW."confirmed_at" IS NOT NULL
           OR NEW."accepted_order_price_binding_id" IS NOT NULL
           OR NEW."accepted_terms_revision" IS NOT NULL
           OR NEW."accepted_claim_policy_revision" IS NOT NULL
           OR NEW."withdrawal_exception_acknowledged_at" IS NOT NULL THEN
            RAISE EXCEPTION 'new orders must begin draft without lifecycle timestamps'
                USING ERRCODE = '23514', CONSTRAINT = 'order_status_transition_check';
        END IF;

        RETURN NEW;
    END IF;

    IF greatest(NEW."quoted_at", NEW."confirmed_at")
       > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'Order lifecycle evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."public_reference" IS DISTINCT FROM OLD."public_reference" THEN
        RAISE EXCEPTION 'order identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_identity_immutable_check';
    END IF;

    IF NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR (OLD."quoted_at" IS NOT NULL AND NEW."quoted_at" IS DISTINCT FROM OLD."quoted_at")
       OR (OLD."confirmed_at" IS NOT NULL AND NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at") THEN
        RAISE EXCEPTION 'order creation and recorded lifecycle timestamps are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_immutable_check';
    END IF;

    IF NEW."quoted_at" IS DISTINCT FROM OLD."quoted_at"
       AND NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'QUOTED'
                AND OLD."quoted_at" IS NULL AND NEW."quoted_at" IS NOT NULL) THEN
        RAISE EXCEPTION 'quoted timestamp must be assigned with the draft-to-quoted transition'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_check';
    END IF;

    IF NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
       AND NOT (OLD."status" = 'QUOTED' AND NEW."status" = 'CONFIRMED'
                AND OLD."confirmed_at" IS NULL AND NEW."confirmed_at" IS NOT NULL) THEN
        RAISE EXCEPTION 'confirmed timestamp must be assigned with the quoted-to-confirmed transition'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_check';
    END IF;

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'QUOTED'
       AND NEW."quoted_at" IS NULL THEN
        RAISE EXCEPTION 'draft-to-quoted transition requires its quoted timestamp'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_check';
    END IF;

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'QUOTED' THEN
        PERFORM taven_lock_automatic_order_session(NEW."id");

        UPDATE "quote_sessions" session
        SET "status" = 'CONVERTED',
            "updated_at" = clock_timestamp()
        FROM "automatic_order_origins" origin
        WHERE origin."order_id" = NEW."id"
          AND origin."quote_session_id" = session."id"
          AND session."status" = 'OPEN';
    END IF;

    IF OLD."status" = 'QUOTED' AND NEW."status" = 'CONFIRMED'
       AND NEW."confirmed_at" IS NULL THEN
        RAISE EXCEPTION 'quoted-to-confirmed transition requires its confirmed timestamp'
            USING ERRCODE = '23514', CONSTRAINT = 'order_lifecycle_timestamp_check';
    END IF;

    IF OLD."status" = 'QUOTED' AND NEW."status" = 'CONFIRMED'
       AND (
           NEW."accepted_order_price_binding_id" IS NULL
           OR NEW."accepted_terms_revision" IS NULL
           OR NEW."accepted_claim_policy_revision" IS NULL
           OR NEW."withdrawal_exception_acknowledged_at" IS NULL
           OR NEW."withdrawal_exception_acknowledged_at" > NEW."confirmed_at"
           OR NOT EXISTS (
               SELECT 1
               FROM "order_active_price_bindings" active
               WHERE active."order_id" = NEW."id"
                 AND active."order_price_binding_id" = NEW."accepted_order_price_binding_id"
           )
       ) THEN
        RAISE EXCEPTION 'quoted-to-confirmed transition requires prior checkout acceptance evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'order_checkout_acceptance_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'DRAFT' AND NEW."status" = 'QUOTED')
           OR (OLD."status" = 'QUOTED' AND NEW."status" IN ('CONFIRMED', 'EXPIRED', 'CANCELLED'))
           OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('IN_PRODUCTION', 'CANCELLED'))
           OR (OLD."status" = 'IN_PRODUCTION' AND NEW."status" IN ('QC_PASSED', 'RECOVERY_PENDING', 'CANCELLED'))
           OR (OLD."status" = 'QC_PASSED' AND NEW."status" IN ('READY_TO_SHIP', 'RECOVERY_PENDING', 'CANCELLED'))
           OR (OLD."status" = 'READY_TO_SHIP' AND NEW."status" IN ('SHIPPED', 'RECOVERY_PENDING', 'CANCELLED'))
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'SHIPPED'
               AND taven_has_reconciled_post_void_handoff(NEW."id"))
           OR (OLD."status" = 'REFUNDED' AND NEW."status" = 'SHIPPED'
               AND taven_has_refunded_post_void_handoff_reconciliation(NEW."id"))
           OR (OLD."status" = 'REFUNDED' AND NEW."status" = 'CANCELLED'
               AND taven_order_has_newer_refund_failure(NEW."id"))
           OR (OLD."status" = 'SHIPPED' AND NEW."status" IN ('DELIVERED', 'PARTIALLY_FULFILLED', 'CANCELLED', 'REFUNDED'))
           OR (OLD."status" = 'RECOVERY_PENDING' AND NEW."status" IN ('QC_PASSED', 'PARTIALLY_FULFILLED', 'CANCELLED'))
           OR (OLD."status" = 'DELIVERED' AND NEW."status" = 'COMPLETED')
           -- CANCELLED_SETTLED stays unreachable until the deferred settlement
           -- tranche persists the immutable OrderSettlement that proves it.
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'REFUNDED')
       ) THEN
        RAISE EXCEPTION 'order status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'order_status_transition_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION taven_protect_order_phase_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    evidence_now timestamptz := clock_timestamp();
    reconciled_post_void_handoff boolean := false;
    reconciled_refunded_post_void_handoff boolean := false;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'QUOTED'
           OR NEW."activated_at" IS NOT NULL
           OR NEW."qc_passed_at" IS NOT NULL
           OR NEW."shipped_at" IS NOT NULL
           OR NEW."delivered_at" IS NOT NULL
           OR NEW."completed_at" IS NOT NULL
           OR NEW."cancelled_at" IS NOT NULL THEN
            RAISE EXCEPTION 'new order phases must begin quoted without lifecycle evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'order_phase_initial_status_check';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'order phases are stable lifecycle topology and cannot be deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_immutable_check';
    END IF;

    reconciled_post_void_handoff :=
        NEW."cancelled_at" IS NOT NULL
        AND taven_has_reconciled_post_void_handoff(
            NEW."order_id", NEW."id", NULL, NULL, NULL,
            NEW."shipped_at"
        );
    reconciled_refunded_post_void_handoff :=
        OLD."status" = 'CANCELLED_REFUNDED'
        AND NEW."cancelled_at" IS NOT NULL
        AND taven_has_refunded_post_void_handoff_reconciliation(
            NEW."order_id", NEW."id", NULL, NULL, NULL,
            NEW."shipped_at"
        );

    IF greatest(
        NEW."activated_at", NEW."qc_passed_at", NEW."shipped_at",
        NEW."delivered_at", NEW."completed_at", NEW."cancelled_at"
    ) > evidence_now + interval '5 seconds' THEN
        RAISE EXCEPTION 'OrderPhase lifecycle evidence cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_evidence_check';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR (OLD."activated_at" IS NOT NULL AND NEW."activated_at" IS DISTINCT FROM OLD."activated_at")
       OR (OLD."qc_passed_at" IS NOT NULL AND NEW."qc_passed_at" IS DISTINCT FROM OLD."qc_passed_at")
       OR (OLD."shipped_at" IS NOT NULL AND NEW."shipped_at" IS DISTINCT FROM OLD."shipped_at")
       OR (OLD."delivered_at" IS NOT NULL AND NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at")
       OR (OLD."completed_at" IS NOT NULL AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at")
       OR (OLD."cancelled_at" IS NOT NULL AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at") THEN
        RAISE EXCEPTION 'order phase identity and recorded lifecycle evidence are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_immutable_check';
    END IF;

    IF NEW."status" IS NOT DISTINCT FROM OLD."status"
       AND (
           NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
           OR NEW."qc_passed_at" IS DISTINCT FROM OLD."qc_passed_at"
           OR NEW."shipped_at" IS DISTINCT FROM OLD."shipped_at"
           OR NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
           OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
           OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
       ) THEN
        RAISE EXCEPTION 'order phase lifecycle evidence must be assigned with its status transition'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_evidence_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'QUOTED' AND NEW."status" IN ('ACTIVE', 'CANCELLED'))
           OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('IN_PRODUCTION', 'CANCELLED'))
           OR (OLD."status" = 'IN_PRODUCTION' AND NEW."status" IN ('QC_PASSED', 'RECOVERY_PENDING', 'CANCELLED'))
           OR (OLD."status" = 'QC_PASSED' AND NEW."status" IN ('SHIPPED', 'RECOVERY_PENDING', 'CANCELLED'))
           OR (OLD."status" = 'SHIPPED' AND NEW."status" IN ('DELIVERED', 'PARTIALLY_FULFILLED', 'CANCELLED_REFUNDED'))
           OR (OLD."status" = 'RECOVERY_PENDING' AND NEW."status" IN ('QC_PASSED', 'PARTIALLY_FULFILLED', 'CANCELLED_REFUNDED'))
           OR (OLD."status" = 'DELIVERED' AND NEW."status" = 'COMPLETED')
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'CANCELLED_REFUNDED')
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'SHIPPED'
               AND reconciled_post_void_handoff)
           OR (OLD."status" = 'CANCELLED_REFUNDED'
               AND NEW."status" = 'SHIPPED'
               AND reconciled_refunded_post_void_handoff)
           OR (OLD."status" = 'CANCELLED_REFUNDED'
               AND NEW."status" = 'CANCELLED'
               AND taven_order_has_newer_refund_failure(NEW."order_id"))
       ) THEN
        RAISE EXCEPTION 'order phase status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_status_transition_check';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (
           (OLD."status" = 'QUOTED' AND NEW."status" = 'ACTIVE'
            AND NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
            AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
            AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
            AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
            AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
            AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'IN_PRODUCTION'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'IN_PRODUCTION' AND NEW."status" = 'QC_PASSED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'QC_PASSED' AND NEW."status" = 'SHIPPED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'SHIPPED' AND NEW."status" = 'DELIVERED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'DELIVERED' AND NEW."status" = 'COMPLETED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (NEW."status" = 'CANCELLED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'CANCELLED_REFUNDED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'SHIPPED' AND NEW."status" = 'CANCELLED_REFUNDED'
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'CANCELLED' AND NEW."status" = 'SHIPPED'
               AND reconciled_post_void_handoff
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'CANCELLED_REFUNDED'
               AND NEW."status" = 'SHIPPED'
               AND reconciled_refunded_post_void_handoff
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (OLD."status" = 'CANCELLED_REFUNDED'
               AND NEW."status" = 'CANCELLED'
               AND taven_order_has_newer_refund_failure(NEW."order_id")
               AND NEW."activated_at" IS NOT DISTINCT FROM OLD."activated_at"
               AND NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at"
               AND NEW."shipped_at" IS NOT DISTINCT FROM OLD."shipped_at"
               AND NEW."delivered_at" IS NOT DISTINCT FROM OLD."delivered_at"
               AND NEW."completed_at" IS NOT DISTINCT FROM OLD."completed_at"
               AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at")
           OR (NEW."status" IN ('RECOVERY_PENDING', 'PARTIALLY_FULFILLED')
               AND (to_jsonb(NEW) - ARRAY['status', 'updated_at']) =
                   (to_jsonb(OLD) - ARRAY['status', 'updated_at']))
           OR (OLD."status" = 'RECOVERY_PENDING'
               AND NEW."status" = 'CANCELLED_REFUNDED'
               AND (to_jsonb(NEW) - ARRAY['status', 'updated_at']) =
                   (to_jsonb(OLD) - ARRAY['status', 'updated_at']))
           OR (OLD."status" = 'RECOVERY_PENDING'
               AND NEW."status" = 'QC_PASSED'
               AND NEW."qc_passed_at" IS NOT NULL
               AND (OLD."qc_passed_at" IS NULL
                    OR NEW."qc_passed_at" IS NOT DISTINCT FROM OLD."qc_passed_at")
               AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'qc_passed_at']) =
                   (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'qc_passed_at']))
       ) THEN
        RAISE EXCEPTION 'order phase transition may assign only its own lifecycle evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_evidence_check';
    END IF;

    IF (NEW."status" IN ('ACTIVE', 'IN_PRODUCTION', 'QC_PASSED', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'RECOVERY_PENDING', 'PARTIALLY_FULFILLED')
        AND NEW."activated_at" IS NULL)
       OR (NEW."status" IN ('QC_PASSED', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'PARTIALLY_FULFILLED')
           AND NEW."qc_passed_at" IS NULL)
       OR (NEW."status" IN ('SHIPPED', 'DELIVERED', 'COMPLETED', 'PARTIALLY_FULFILLED')
           AND NEW."shipped_at" IS NULL)
       OR (NEW."status" IN ('DELIVERED', 'COMPLETED') AND NEW."delivered_at" IS NULL)
       OR (NEW."status" = 'COMPLETED' AND NEW."completed_at" IS NULL)
       OR (NEW."status" IN ('CANCELLED', 'CANCELLED_REFUNDED') AND NEW."cancelled_at" IS NULL) THEN
        RAISE EXCEPTION 'order phase lifecycle state requires its complete timestamp evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_evidence_check';
    END IF;

    IF (NEW."activated_at" IS NOT NULL AND NEW."qc_passed_at" IS NOT NULL
        AND NEW."qc_passed_at" < NEW."activated_at")
       OR (NEW."qc_passed_at" IS NOT NULL AND NEW."shipped_at" IS NOT NULL
           AND NEW."shipped_at" < NEW."qc_passed_at" - interval '5 seconds')
       OR (NEW."shipped_at" IS NOT NULL AND NEW."delivered_at" IS NOT NULL
           AND NEW."delivered_at" < NEW."shipped_at" - interval '10 seconds')
       OR (NEW."delivered_at" IS NOT NULL AND NEW."completed_at" IS NOT NULL
           AND NEW."completed_at" < NEW."delivered_at" - interval '5 seconds')
       OR (NEW."cancelled_at" IS NOT NULL AND NEW."activated_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."activated_at")
       OR (NEW."cancelled_at" IS NOT NULL AND NEW."qc_passed_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."qc_passed_at")
       OR (NEW."cancelled_at" IS NOT NULL AND NEW."shipped_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."shipped_at"
           AND NOT reconciled_post_void_handoff
           AND NOT reconciled_refunded_post_void_handoff)
       OR (NEW."cancelled_at" IS NOT NULL AND NEW."delivered_at" IS NOT NULL
           AND NEW."cancelled_at" < NEW."delivered_at"
           AND NOT reconciled_post_void_handoff
           AND NOT reconciled_refunded_post_void_handoff) THEN
        RAISE EXCEPTION 'order phase lifecycle timestamps must be chronological'
            USING ERRCODE = '23514', CONSTRAINT = 'order_phase_lifecycle_evidence_check';
    END IF;

    RETURN NEW;
END;
$$;
