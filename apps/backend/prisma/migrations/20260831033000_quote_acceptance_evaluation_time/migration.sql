-- Quote acceptance is decided against the database instant captured by the
-- application and persisted as accepted_at. Reusing that instant here avoids
-- turning a valid near-deadline acceptance into a constraint failure when the
-- deadline passes during the rest of the transaction.

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
           FROM "quotes" quote
           WHERE quote."quote_request_id" = OLD."id"
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
