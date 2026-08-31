-- Acceptance time is database-owned. This trigger runs before the issued-quote
-- guard (PostgreSQL orders same-kind triggers alphabetically), so callers cannot
-- backdate accepted_at to revive an expired immutable offer.

CREATE FUNCTION taven_set_quote_request_acceptance_time()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."status" = 'ACCEPTED'
       AND OLD."status" IS DISTINCT FROM NEW."status" THEN
        NEW."accepted_at" := statement_timestamp();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "quote_requests_acceptance_time_owned"
BEFORE UPDATE OF "status" ON "quote_requests"
FOR EACH ROW EXECUTE FUNCTION taven_set_quote_request_acceptance_time();
