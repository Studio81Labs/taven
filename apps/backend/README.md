# `@taven/backend`

NestJS owns HTTP transport and infrastructure adapters. In addition to
`GET /health`, the storage module exposes capability-scoped direct upload,
confirmation, short-lived download, and model reorder-eligibility contracts.
Quote-reference photos additionally require the owning live quote-session
capability; QC upload remains an internal operator workflow. Large uploads go
from the client to S3-compatible storage; confirmation checks the stored size,
media type, provider-verified SHA-256, and bounded signature/archive byte ranges
before promoting a quarantine key.

Prisma owns the reviewed PostgreSQL schema for immutable model inputs,
profiles, slicing metadata, node-scoped resources, reservation planning,
idempotency, upload intents, retention deletion jobs, and the outbox. Storage
cleanup claims an exact entity/deadline in PostgreSQL before deleting external
objects, then records success or a retryable failure. OpenAPI export uses an
explicit offline mode and does not connect to PostgreSQL or object storage. Do
not expose Prisma models through shared packages or frontend code.

Automatic quotes select the currency-keyed `CommercialPolicySelection` row.
The migration initializes CZK only from the exact known `automatic-v0-czk`
PriceList and fails if that list is missing. Before migration, inspect any
custom `TAVEN_AUTOMATIC_PRICE_LIST_REVISION` deployment value: the Prisma
preflight rejects a different value rather than guessing which legacy list
was active. Create a validated immutable PriceList, then publish it with the
ADMIN version-checked activation command. Already committed DRAFT and QUOTED
bindings retain their original list. Drain old policy-writing processes before
enabling activation. New binding preparation performs one bounded provider
validation call, so an outage can defer only a genuinely new binding.

Anonymous checkout freezes normalized electronic contact and billing details
on the order before creating a provider intent. No phone or customer account is
required. `TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED` stays false until the
database-backed legal documents are approved and published and
`TAVEN_CLAIM_WINDOW_DAYS` is configured. The accepted duration is snapshotted
on each order so later policy changes cannot shorten an existing customer's
window. Terms, claims and optional publication consent are selected exclusively
from their published database revisions; the former revision-selector
environment variables are not authorization inputs.

```bash
pnpm -C apps/backend dev
pnpm -C apps/backend test
pnpm -C apps/backend test:e2e
pnpm -C apps/backend db:migrate
pnpm -C apps/backend db:seed
pnpm -C apps/backend openapi:export
pnpm -C apps/backend retention-worker:dev
```
