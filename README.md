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
- `infra` — local PostgreSQL, Redis, and S3-compatible object storage
- `scripts` — maintained bootstrap and repository checks
- `tools` — developer/operator utilities, not application runtime code
- `docs` — product sources, ADRs, plans, process, and reference material

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- Corepack with pnpm 11.22.0
- Python 3.11 or newer with pip (for repository checks)
- Docker with Docker Compose v2

## Getting started

```bash
pnpm bootstrap
pnpm dev
```

Bootstrap installs dependencies, creates missing local `.env` files, starts the
three infrastructure services, applies Prisma migrations, and regenerates the
OpenAPI artifacts. It is safe to run again after pulling changes.

`pnpm dev` starts the backend, public web app, and admin app. The slicer worker
is deliberately excluded; start its isolated Node worker, Orca runtime, and
dispatcher containers explicitly with `pnpm stack:worker`.

Default local ports are `3001` for the API, `3000` for the public web app, and
`3002` for admin. PostgreSQL uses `5435`, Redis uses `6381`, and MinIO uses
`9010` with its console on `9011`, avoiding the sibling repositories' defaults.

Manage local infrastructure independently with:

```bash
pnpm infra:up
pnpm infra:logs
pnpm infra:down
```

To build and run the complete containerized stack instead, use:

```bash
pnpm stack:up
```

This builds the same independently runnable backend, web, and admin images used
by the integration stack, applies Prisma migrations once, and waits until every
long-running service is healthy. The public app is available at
`http://localhost:3000`, the API at `http://localhost:3001`, the admin app at
`http://localhost:3002`, and MinIO at `http://localhost:9010`. All published
ports bind to loopback and every credential in the Compose file is local-only.
Binding quote/offer, quote-photo upload, and checkout-payment flows are
fail-closed while launch inputs remain unapproved. Set
`TAVEN_BINDING_QUOTE_FLOWS_ENABLED=true`,
`TAVEN_QUOTE_PHOTO_UPLOADS_ENABLED=true`, and/or
`TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED=true` only when intentionally exercising
those flows in a local environment. The public web also remains acquisition
disabled until its separately approved content manifest and runtime gate allow
it.

Follow logs or stop the stack with `pnpm stack:logs` and `pnpm stack:down`.
`pnpm stack:reset` also deletes the local PostgreSQL, Redis, MinIO, and Garage
volumes; use it only when intentionally testing a clean-volume startup.

The slicer fixture worker is deliberately excluded from `stack:up`. Start it
explicitly with `pnpm stack:worker`. Run the same object-storage integration
contract against the default MinIO or the pinned Garage compatibility profile
with:

```bash
pnpm stack:storage:test:minio
pnpm stack:storage:test:garage
```

Garage is exposed only while its compatibility profile is running, at
`http://localhost:3900`. Each contract command resets only its dedicated
`taven_contract_minio` or `taven_contract_garage` test database; it does not
reset the development `taven` database. These local commands do not require
Cloudflare, Coolify, Comgate, Resend, production secrets, or VPS access.
Production database backups are configured through Coolify and sent to
Cloudflare R2; this repository does not run a SQL dump container or backup
scheduler.

## Validation

```bash
pnpm format:check
pnpm stack:config:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm generated:check
pnpm ci:config:check
pnpm overrides:check
```

Run `pnpm sibling:check` to compare shared infrastructure against Nexcue,
Tarmoto, TableTap, and Poker Hero through GitHub. It uses `SIBLING_TOKEN`, or the
token from an authenticated `gh` CLI, and provisions its locked Python
dependency in a temporary directory. For the narrower local Nexcue runtime
baseline, check out Nexcue beside this repository and run `pnpm baseline:check`;
override that checkout location with `NEXCUE_REPO_PATH` when necessary.

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
- [`docs/product/taven-identita-v1.1.md`](docs/product/taven-identita-v1.1.md)
- [`docs/product/taven-design-brief-v1.2.md`](docs/product/taven-design-brief-v1.2.md)
- [`docs/product/taven-maker-economics-v0.1.md`](docs/product/taven-maker-economics-v0.1.md)
- [`docs/product/taven-launch-approvals-v0.1.md`](docs/product/taven-launch-approvals-v0.1.md)

They describe the product; they are not executable repository instructions.
Technical decisions that are not already fixed by those documents live under
`docs/decisions/`.
