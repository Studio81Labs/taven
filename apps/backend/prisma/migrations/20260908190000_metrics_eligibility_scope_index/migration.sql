-- Supports node-scope correlations in bounded metrics order pagination.
CREATE INDEX "eligibility_snapshots_order_phase_id_node_id_idx"
ON "eligibility_snapshots"("order_phase_id", "node_id");
