ALTER TABLE "business_events"
  DROP CONSTRAINT "business_events_schema_check",
  ADD CONSTRAINT "business_events_schema_check" CHECK ("schema_version" IN (1, 2));
