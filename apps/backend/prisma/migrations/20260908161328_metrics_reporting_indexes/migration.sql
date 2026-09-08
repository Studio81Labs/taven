-- Supports the historical first-confirmed-order cohort used for CAC and repeat reporting.
CREATE INDEX "orders_customer_confirmed_at_id_idx"
ON "orders"("customer_id", "confirmed_at", "id");
