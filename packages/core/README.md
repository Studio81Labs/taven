# `@taven/core`

Pure, deterministic domain rules shared by Taven processes. This package must
remain testable without NestJS, Vue, Prisma, Redis, S3, or generated API types.
Its runtime dependency list is intentionally empty and enforced by
`pnpm boundaries:check`.

The public API contains integer value objects, immutable revision and hash
identities, injected clocks, v0 lifecycle policies, financial and fulfilment
projections, and versioned cache/idempotency key builders. Infrastructure
adapters convert these values at the boundary and execute persistence, locks,
outbox delivery, and provider calls in `apps/backend`.
