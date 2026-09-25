# Refund provider-result reconciliation and one-time retry

This is an exceptional financial procedure, not a way to resend a timed-out
request. Only an operator with `financial:exception` may use the two scoped
commands. Review [ADR 0028](../decisions/0028-gate-operator-refund-recovery-on-provider-evidence.md)
before acting. The original refund, dispatch claim, provider receipt and audit
record remain immutable.

1. Open the order's financial detail and refund history. Confirm the payment
   provider/account/environment, capture intent, amount, currency, exact refund
   request reference, dispatch claim and any replacement. An outbox `FAILED`
   status or a missing provider row is **not** evidence that a transfer failed.
2. In the authenticated provider portal or a provider support response, obtain
   final evidence for the exact attempt. `FAILED` is usable only when the
   provider confirms that this request definitively did not and will not
   transfer money. Record its stable case/statement/item reference and actual
   outcome instant. If either exact identity or finality is uncertain, stop:
   leave the attempt unresolved and escalate the incident. Do not infer success
   from an aggregate balance, or accept a timeout, pending status or generic
   API error as a final failure.
3. Call `POST /admin/orders/:orderId/fulfilment/refunds/:refundId/provider-results`
   with a fresh `Idempotency-Key`, operator session and CSRF header. Supply the
   currently read `expectedStatus` and `expectedProviderResultEventId`, the
   persisted `providerIntentId`, `requestReference`, `amountMinor` and
   `currency`, optional actual `providerRefundReference`, `outcome`,
   `evidenceKind` (`PROVIDER_PORTAL` or `PROVIDER_SUPPORT`), bounded
   `evidenceReference`, timezone-qualified `occurredAt`, reason and
   `finalOutcomeConfirmed: true`. No file, secret, raw statement or URL is
   accepted. This records attested evidence; it makes **no** provider call.
   Use the refund-level `providerIntentId` from the refund history, not the
   payment-level field. For a late-capture compensation, the payment's intent
   may remain null; the refund-level locator is verified against the immutable
   original refund command and captured provider event. Stop if it is null.
4. Re-read the order and confirm the selected result receipt and incident
   state. Only a root refund with a selected final `REFUND_FAILED` receipt,
   no replacement, no later success or unresolved provider incident, and an
   outstanding funded obligation can be retried. Call
   `POST /admin/orders/:orderId/fulfilment/refunds/:refundId/retry` with a new
   `Idempotency-Key` and `{ "expectedFailureProviderEventId": "<selected receipt UUID>",
"reason": "<why this verified obligation must be retried>" }`.
   A successful response means one new refund attempt was **queued**, not
   that money moved. Re-read its outbox, dispatch claim and provider result.

Reuse the same key and identical body only to recover an uncertain HTTP
response; changing the body under that key returns 409. A second key cannot
create a sibling. A failed replacement cannot be retried again in v0. A late
source success may supersede an unclaimed replacement or suspend a claimed one;
any suspended or double-success incident requires explicit financial
escalation, not another transfer.

Before deploying the forward migration/application pair, drain financial
writers and refund dispatchers. Apply migrations, deploy the compatible backend
and consumer, validate the read/command paths, then re-enable consumers. This
release does not backfill historical missing outbox work, rewrite old lineage
or initiate a transfer during migration. Do not manually replay an old pending
refund without a separate audited repair decision.
