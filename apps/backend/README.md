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

```bash
pnpm -C apps/backend dev
pnpm -C apps/backend test
pnpm -C apps/backend test:e2e
pnpm -C apps/backend db:migrate
pnpm -C apps/backend db:seed
pnpm -C apps/backend openapi:export
pnpm -C apps/backend retention-worker:dev
```
