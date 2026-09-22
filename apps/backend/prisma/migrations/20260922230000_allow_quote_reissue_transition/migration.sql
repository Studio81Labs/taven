-- PR5b: allow the atomic QUOTED -> QUOTED transition used by offer reissue.
-- The existing trigger already validates the immutable quote/order invariants;
-- this forward migration only aligns its status transition guard with ADR0022.

DO $migration$
DECLARE
    function_definition text;
    original_clause text :=
        '           OR (OLD."status" = ''IN_REVIEW'' AND NEW."status" = ''QUOTED'')';
    replacement_clause text :=
        '           OR (OLD."status" = ''IN_REVIEW'' AND NEW."status" = ''QUOTED'')' || E'\n' ||
        '           OR (OLD."status" = ''QUOTED'' AND NEW."status" = ''QUOTED'')';
BEGIN
    SELECT pg_get_functiondef('taven_protect_quote_request_issued_quote()'::regprocedure)
      INTO function_definition;

    IF position(original_clause IN function_definition) = 0 THEN
        RAISE EXCEPTION
            'taven_protect_quote_request_issued_quote transition clause is unavailable';
    END IF;

    function_definition := replace(
        function_definition,
        original_clause,
        replacement_clause
    );
    EXECUTE function_definition;
END;
$migration$;
