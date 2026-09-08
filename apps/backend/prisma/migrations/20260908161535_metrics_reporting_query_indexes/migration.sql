-- CreateIndex
CREATE INDEX "business_events_event_type_observed_at_idx" ON "business_events"("event_type", "observed_at");

-- CreateIndex
CREATE INDEX "orders_confirmed_at_id_idx" ON "orders"("confirmed_at", "id");
