-- Supports the bounded node-scope anti-join used by metrics order pagination.
CREATE INDEX "jobs_order_id_node_id_idx" ON "jobs"("order_id", "node_id");
