# Taven

Taven is a local 3D-printing service built around deterministic quoting,
versioned slicing inputs, and traceable production jobs. The product name is a
working name until the clearance steps in the product specification are done.

This repository is in its foundation stage. It contains workspace skeletons,
health-only application seams, shared contracts, and repository policy; it does
not contain customer or operator product flows yet.

## Repository map

- `apps/backend` — NestJS API, Prisma seam, and future BullMQ producers
- `apps/web` — Nuxt/Vue public site and customer flow
- `apps/admin` — Vue/Vite internal administration
- `apps/slicer-worker` — opt-in BullMQ slicing worker
- `packages/core` — framework-independent domain rules
- `packages/openapi` — emitted HTTP contract and generation command
- `packages/openapi-client` — generated types and typed client factory
- `packages/slicer-contracts` — runtime-validated queue messages and results
- `packages/ui-web` — the visual foundation shared by both Vue applications
- `infra` — local runtime dependencies (added in the execution-foundation slice)
- `scripts` — maintained bootstrap and repository checks
- `tools` — developer/operator utilities, not application runtime code
- `docs` — product sources, ADRs, plans, process, and reference material

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- Corepack with pnpm 11.22.0

Docker is not required until the execution-foundation slice adds PostgreSQL,
Redis, and local object storage.

## Getting started

```bash
pnpm bootstrap
pnpm dev
```

`pnpm dev` starts the backend, public web app, and admin app. The slicer worker
is deliberately excluded; start its fixture consumer explicitly with
`pnpm slicer-worker:dev` once Redis is available.

Default local ports are `3001` for the API, `3000` for the public web app, and
`3002` for admin.

## Validation

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm generated:check
```

Regenerate the OpenAPI artifact and typed client after changing backend DTOs or
Swagger decorators:

```bash
pnpm openapi:generate
```

## Sources of truth

The canonical product inputs are:

- [`docs/product/taven-specifikace-v1.3.md`](docs/product/taven-specifikace-v1.3.md)
- [`docs/product/taven-parametry.md`](docs/product/taven-parametry.md)
- [`docs/product/taven-rozhodovaci-log.md`](docs/product/taven-rozhodovaci-log.md)

They describe the product; they are not executable repository instructions.
Technical decisions that are not already fixed by those documents live under
`docs/decisions/`.
