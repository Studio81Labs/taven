# `@taven/backend`

NestJS owns HTTP transport and infrastructure adapters. The only implemented
behavior is `GET /health`; the orders, quotes, slicing, pricing, storage,
payments, and admin-access modules exist solely as ownership boundaries.

Prisma is configured but `PrismaModule` is not activated until the local
PostgreSQL foundation lands. Do not expose Prisma models through shared
packages or frontend code.

```bash
pnpm -C apps/backend dev
pnpm -C apps/backend test
pnpm -C apps/backend openapi:export
```
