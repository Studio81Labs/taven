DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "automatic_quote_handoff_capabilities"
    GROUP BY "source_quote_session_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'cannot enforce one automatic quote handoff capability per source session: duplicate evidence exists';
  END IF;
END;
$$;

DROP INDEX "automatic_quote_handoff_capabilities_source_quote_session_id_expires_at_idx";

ALTER TABLE "automatic_quote_handoff_capabilities"
  ADD CONSTRAINT "automatic_quote_handoff_capabilities_source_quote_session_id_key"
  UNIQUE ("source_quote_session_id");
