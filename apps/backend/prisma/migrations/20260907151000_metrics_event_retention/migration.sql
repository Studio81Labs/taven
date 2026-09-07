CREATE INDEX "business_events_expires_at_id_idx"
  ON "business_events"("expires_at", "id")
  WHERE "expires_at" IS NOT NULL;
