# `@taven/backend`

NestJS owns HTTP transport and infrastructure adapters. The only implemented
behavior is `GET /health`; the orders, quotes, slicing, pricing, storage,
payments, and admin-access modules exist solely as ownership boundaries.

Prisma owns the reviewed PostgreSQL schema for immutable model inputs,
profiles, slicing metadata, node-scoped resources, reservation planning,
idempotency, and the outbox. `PrismaModule` remains opt-in until a backend
command needs it; the health and OpenAPI entry points must still run without a
database connection. Do not expose Prisma models through shared packages or
frontend code.

```bash
pnpm -C apps/backend dev
pnpm -C apps/backend test
pnpm -C apps/backend db:migrate
pnpm -C apps/backend db:seed
pnpm -C apps/backend openapi:export
```
