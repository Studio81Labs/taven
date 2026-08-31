# ADR 0007: Keep v0 providers behind application ports

- **Status:** accepted
- **Date:** 2026-08-31

## Context

Taven needs a concrete payment processor, object store, and transactional email
sender before the v0 path can be shipped. These providers have different
commercial terms and operational behavior. The owner explicitly requires the
ability to use Comgate, Stripe, or another payment processor; Cloudflare R2 or
a self-hosted S3 implementation; and Resend or another mail relay without
rewriting business rules.

The product specification already requires replaceable adapters for external
integrations. A provider selection therefore chooses the first operational
adapter, not a provider-shaped domain model.

## Decision

Select these first v0 implementations:

- Comgate Start is the first payment adapter. Merchant onboarding provisions
  its production/test access and confirms the selected zero-monthly-fee tariff;
  it does not reopen the architecture decision.
- Garage v2.3.0 on the owner-operated VPS is the primary S3-compatible object
  store. Cloudflare R2 in the EU jurisdiction is the off-host backup target and
  the ready production fallback. MinIO remains a local-development adapter
  target, not the production selection.
- Resend Free is the first transactional email adapter. It upgrades to Resend
  Pro only when its documented daily or monthly quotas are insufficient.

Payment, object storage, and email are application ports in `apps/backend`.
Pure money, order, quote, and lifecycle rules remain in `packages/core` and do
not import provider SDKs, provider event types, NestJS infrastructure, or
generated provider clients. Adapter configuration selects exactly one live
implementation at startup and fails explicitly when required capabilities or
credentials are absent.

The payment port exposes Taven concepts: create an intent for an immutable
amount and currency, read authoritative status, cancel or refund an eligible
payment, and authenticate and normalize a provider event. Taven supplies and
persists its own command idempotency key, provider name, merchant reference,
provider payment reference, amount, currency, and normalized event identity.
Callbacks are treated as untrusted, at-least-once, and possibly out of order.
For Comgate, callback possession is not payment authentication: the adapter
uses its Merchant API credentials to retrieve authoritative `/2.0/status`
state before one transactional state transition. Comgate's `refId` is not
unique, so it is never Taven's idempotency boundary. Raw evidence is retained
only in the bounded, redacted audit form defined by the payment issue.

The object-storage port uses S3 semantics already represented by
`TAVEN_S3_*`. Object keys, retention deadlines, legal holds, and deletion
verification are Taven data. Provider lifecycle rules are defense in depth and
must not replace the durable application deletion jobs. Switching Garage,
MinIO, or R2 changes endpoint and credential configuration, not stored domain
meaning. The existing presigner currently relies on MinIO accepting a checksum
passed in both the signed query and required request headers. Garage correctly
rejects that shape. Before production, issue #39 must rename the implementation
to a provider-neutral S3 adapter, sign `x-amz-checksum-sha256` as an unhoistable
header, and run the same signed upload, download, checksum, range, copy, list,
deletion, and retention contract suite against both local MinIO and pinned
Garage. The decision spike verified that Garage passes those operations with
that standards-compliant signing shape.

The email port accepts a template identity, recipients, locale, correlation
identity, and already-rendered safe variables. It returns a provider message
reference and normalized delivery result. No model, photo, token value, or
provider SDK object enters the outbox contract. An SMTP adapter is the fallback
for an owner-operated relay or a different commercial relay.

## Consequences

Comgate, Garage, and Resend unblock implementation while commercial and service
exit paths remain explicit. A Comgate onboarding failure falls back first to
ThePay when Czech bank buttons are mandatory, or to Stripe when card-only
checkout is temporarily acceptable. Stripe is not represented as equivalent to
a Czech bank-button provider.

Provider-specific authentication, retries, refunds, webhooks, quotas, and
errors still require adapter tests. The common port intentionally captures the
minimum semantic intersection; capabilities that materially change checkout
behavior must be surfaced explicitly rather than hidden behind silent fallback.
