-- Owner-approved pre-offer decline. Keep the existing issued-offer and legal
-- guards intact while adding the two pre-offer edges and a no-offer terminal.
DO $migration$
DECLARE
    function_definition text;
    old_transition text :=
        '           OR (OLD."status" = ''IN_REVIEW'' AND NEW."status" = ''QUOTED'')';
    new_transition text :=
        '           OR (OLD."status" = ''IN_REVIEW'' AND NEW."status" = ''QUOTED'')' || E'\n' ||
        '           OR (OLD."status" IN (''NEW'', ''IN_REVIEW'') AND NEW."status" = ''REJECTED'')';
    old_no_offer text :=
        'IF request_row."status" IN (''QUOTED'', ''ACCEPTED'', ''REJECTED'', ''EXPIRED'')' || E'\n' ||
        '           OR TG_TABLE_NAME = ''quotes'' THEN';
    new_no_offer text :=
        'IF request_row."status" IN (''QUOTED'', ''ACCEPTED'', ''EXPIRED'')' || E'\n' ||
        '           OR (request_row."status" = ''REJECTED'' AND EXISTS (' || E'\n' ||
        '               SELECT 1 FROM "quotes" WHERE "quote_request_id" = request_row."id"' || E'\n' ||
        '           ))' || E'\n' ||
        '           OR TG_TABLE_NAME = ''quotes'' THEN';
BEGIN
    SELECT pg_get_functiondef('taven_protect_quote_request_issued_quote()'::regprocedure)
      INTO function_definition;
    IF position(old_transition IN function_definition) = 0 THEN
        RAISE EXCEPTION 'quote request transition guard shape changed';
    END IF;
    EXECUTE replace(function_definition, old_transition, new_transition);

    SELECT pg_get_functiondef('taven_reconcile_issued_quote_request()'::regprocedure)
      INTO function_definition;
    IF position(old_no_offer IN function_definition) = 0 THEN
        RAISE EXCEPTION 'quote request current-offer reconciliation shape changed';
    END IF;
    EXECUTE replace(function_definition, old_no_offer, new_no_offer);
END;
$migration$;

-- A pre-offer decline records the first response in the existing SLA field.
-- Issued-offer customer rejection keeps its historical nullable reason shape.
CREATE FUNCTION taven_protect_quote_request_preoffer_decline()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."status" IN ('NEW', 'IN_REVIEW')
       AND NEW."status" = 'REJECTED' THEN
        IF NEW."current_quote_id" IS NOT NULL
           OR EXISTS (SELECT 1 FROM "quotes" WHERE "quote_request_id" = NEW."id")
           OR NEW."rejected_at" IS NULL
           OR NEW."rejection_reason" IS NULL
           OR btrim(NEW."rejection_reason") = ''
           OR length(NEW."rejection_reason") > 1000
           OR NEW."sla_responded_at" IS DISTINCT FROM NEW."rejected_at" THEN
            RAISE EXCEPTION 'pre-offer decline requires no offer and complete response evidence'
                USING ERRCODE = '23514', CONSTRAINT = 'quote_request_preoffer_decline_check';
        END IF;
    END IF;

    IF OLD."status" = 'REJECTED' AND OLD."current_quote_id" IS NULL
       AND (
           NEW."status" IS DISTINCT FROM OLD."status"
           OR NEW."current_quote_id" IS DISTINCT FROM OLD."current_quote_id"
           OR NEW."quote_session_id" IS DISTINCT FROM OLD."quote_session_id"
           OR NEW."customer_id" IS DISTINCT FROM OLD."customer_id"
           OR NEW."photo_publication_consent_granted_at" IS DISTINCT FROM OLD."photo_publication_consent_granted_at"
           OR NEW."rejected_at" IS DISTINCT FROM OLD."rejected_at"
           OR NEW."rejection_reason" IS DISTINCT FROM OLD."rejection_reason"
           OR NEW."sla_responded_at" IS DISTINCT FROM OLD."sla_responded_at"
           OR NEW."current_state_command_key" IS DISTINCT FROM OLD."current_state_command_key"
           OR NEW."current_state_result_id" IS DISTINCT FROM OLD."current_state_result_id"
       ) THEN
        RAISE EXCEPTION 'declined quote request is terminal and immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'quote_request_decline_terminal_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_requests_preoffer_decline_protected"
BEFORE UPDATE OF "status", "current_quote_id", "rejected_at", "rejection_reason",
    "sla_responded_at", "current_state_command_key", "current_state_result_id",
    "quote_session_id", "customer_id", "photo_publication_consent_granted_at"
ON "quote_requests"
FOR EACH ROW EXECUTE FUNCTION taven_protect_quote_request_preoffer_decline();

-- Reconcile an offerless terminal even though the pointer itself did not move.
DROP TRIGGER "quote_requests_current_offer_reconciled" ON "quote_requests";
CREATE CONSTRAINT TRIGGER "quote_requests_current_offer_reconciled"
AFTER UPDATE OF "status", "current_quote_id" ON "quote_requests"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_reconcile_issued_quote_request();
