# Scoped recovery candidate preparation

Use this procedure when an existing failed or QC-rejected Job has an open
replacement request, or an unresolved whole-parcel LOST claim permits a
reprint. The preparation is advisory. It creates no Job, Shipment, stock hold,
capacity hold, payment change or customer price change. See
[ADR 0029](../decisions/0029-prepare-scoped-recovery-candidates.md) for the
frozen-source and transaction rules.

1. Read the order's fulfilment detail under the correct node. For a Job, use
   its current `replacementRequestId`; for a claim, use the current LOST
   predecessor Shipment ID. Confirm the existing remedy is still available.
   Do not enter model, geometry, configuration, machine, inventory or candidate
   IDs into a preparation request.
2. With an operator session, CSRF header and a fresh `Idempotency-Key`, call
   `POST /admin/orders/:orderId/fulfilment/jobs/:jobId/replacement-preparations`
   with `{ "expectedReplacementRequestId": "...", "reason": "..." }`, or
   `POST /admin/orders/:orderId/fulfilment/claims/:claimId/reprint-preparations`
   with `{ "expectedPredecessorShipmentId": "...", "reason": "..." }`.
   A 202 response records one immutable generation and durable candidate
   dispatches. It does not promise an eligible candidate. Reuse the exact key
   and body after a lost response; a changed body conflicts. A different key
   waits while a generation is still pending, with a 30-minute liveness bound.
3. Poll the returned `statusPath`, or the scoped preparation collection. Read
   `sourceJobIds`, per-source slot counts, pending/failed/selectable counts,
   `blockingCodes` and `nextRefreshAt`. Worker or queue failure remains visible;
   do not infer success from a sent outbox message. A late result from an older
   generation cannot authorize a replacement. A new key explicitly refreshes
   after terminal work or the pending liveness bound.
4. Read `:preparationId/candidates`, filtered by `sourceJobId` for a parcel.
   Choose one currently selectable candidate for **each** source Job and
   review its machine, material, quantity, future intervals and `expiresAt`.
   The list is a live advisory view: resources, stock, availability and remedy
   state can change before final admission. Do not copy a candidate from a
   different preparation, source Job or LOST episode.
5. Confirm through the existing replacement or claim-reprint command with
   those selected candidate IDs and a separate idempotency key. Final
   admission atomically checks current context, successful dispatch receipts,
   source retention, availability, capacity and aggregate material. Candidate
   expiry is the admission deadline; printing may end later. A conflict leaves
   no partial replacement Job or parcel Shipment. Re-read and prepare a new
   generation when the context remains eligible.

`OPERATIONS_WRITE` is required for Job preparation,
`FINANCIAL_EXCEPTION` for claim preparation, and `OPERATIONS_READ` for the
scoped reads. A missing trusted source selection, deleted source, expired
replacement deadline, non-whole parcel topology or unresolved incident is a
blocker. Escalate source repair or the unsupported topology; do not synthesize
historical selection evidence or bypass the existing refund remedy.

Before applying the forward migration, drain backend writers that insert
replacement Jobs and dispatch candidate estimates. Apply the migration and
compatible backend together, then validate fresh replacement and LOST-claim
reads and commands before re-enabling writers. Keep the independently running
worker-v2 contract unchanged. The migration does not backfill old provenance
or redispatch historical work.
