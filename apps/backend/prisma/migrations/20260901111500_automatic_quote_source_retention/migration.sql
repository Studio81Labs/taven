CREATE FUNCTION taven_extend_automatic_quote_source_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE "model_files" source
    SET "source_delete_after" = greatest(
        source."source_delete_after",
        session."expires_at" + make_interval(days => source."source_retention_days")
    )
    FROM "automatic_order_origins" origin
    JOIN "quote_sessions" session
      ON session."id" = origin."quote_session_id"
    WHERE origin."order_id" = NEW."order_id"
      AND source."id" = NEW."model_file_id";

    RETURN NULL;
END;
$$;

CREATE TRIGGER "automatic_quote_model_files_extend_source_retention"
AFTER INSERT ON "automatic_quote_model_files"
FOR EACH ROW EXECUTE FUNCTION taven_extend_automatic_quote_source_retention();
