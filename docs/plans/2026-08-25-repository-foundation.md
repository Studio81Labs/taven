# Taven repository foundation plan

**Status:** in progress — workspace, local execution, and PR-validation foundations implemented; deployment foundation pending
**Scope:** repository and delivery foundation only; no product features
**Prepared:** 2026-08-25

## 1. Reference repositories and adopted conventions

Taven should use the common Studio81 monorepo shape found in `nexcue`,
`tarmoto`, and `tabletap`:

- pnpm workspace with `apps/*` and `packages/*`
- Node.js and pnpm versions pinned at the repository root
- application code in `apps/`, reusable code in `packages/`
- local dependencies in `infra/docker/`
- maintained automation in `scripts/` and developer/operator utilities in
  `tools/`
- product, architecture, process, and decision documentation in `docs/`
- path-filtered GitHub Actions workflows in `.github/workflows/`
- shared formatting, linting, TypeScript, commitlint, Husky, Renovate, and
  supply-chain configuration at the root

Use the repositories selectively rather than cloning one wholesale:

- **Nexcue is the infrastructure baseline.** Take the current CI, repository
  policy, pnpm safety, Renovate, security scanning, and bootstrap conventions
  from it at implementation time.
- **TableTap is the boundary reference.** Its framework-independent `core`
  package is the right model for Taven's pricing, state machines, and other
  deterministic business rules.
- **Tarmoto is the worker/tooling reference.** It demonstrates when a domain
  process deserves its own app and when maintained evaluation utilities belong
  under `tools/`.

Any copied infrastructure file must be re-audited for Taven and carry sibling
provenance where the existing repositories require it. Do not copy deploy,
mobile, or framework-specific configuration that Taven does not use.

## 2. Proposed repository shape

```text
taven/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   ├── workflows/
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── labeler.yml
├── .husky/
├── apps/
│   ├── backend/                 NestJS API, Prisma, BullMQ producers
│   ├── web/                     Nuxt/Vue 3 public site and customer flow
│   ├── admin/                   Vue 3 + Vite internal administration
│   └── slicer-worker/           BullMQ worker and immutable Orca image
├── packages/
│   ├── core/                    pure domain rules; no framework imports
│   ├── openapi/                 emitted contract and generation tooling
│   ├── openapi-client/          generated TypeScript client and schemas
│   ├── slicer-contracts/        versioned queue payload/result schemas
│   └── ui-web/                  shared Vue components and design tokens
├── infra/
│   └── docker/                  PostgreSQL, Redis, local S3-compatible store
├── scripts/
│   ├── ci/                      workflow checks and repository policy scripts
│   ├── lib/                     reusable shell helpers
│   └── bootstrap.sh
├── tools/
│   └── slicing-fixtures/        reproducibility fixtures and profile checks
├── docs/
│   ├── product/                 canonical three-document product set
│   ├── decisions/               technical ADRs only
│   ├── plans/                   implementation plans
│   ├── process/                 setup, testing, migrations, releases, runbook
│   └── reference/               architecture and data-flow reference
├── AGENTS.md
├── CLAUDE.md
├── CONTRIBUTING.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

The names intentionally follow sibling conventions where possible:
`apps/backend` is the component called `api` in the product architecture, and
`packages/core`, `openapi`, `openapi-client`, and `ui-web` match established
workspace roles. `apps/web` remains one application for both the SEO-facing
landing pages and the interactive configurator/checkout; splitting a marketing
site now would duplicate routing, content, and design work. Nuxt is the proposed
Vue implementation because Taven treats SEO as a durable acquisition channel.

Do **not** create empty placeholders for `maker`, `ai-worker`, `routing-worker`,
or a node agent. The product specification explicitly gates them on observed
demand. Maker functions stay grouped inside `apps/admin`, while their backend
queries retain node scope. A future maker app should be an extraction, not a
parallel implementation.

## 3. Package boundaries

### `packages/core`

Own pure, deterministic rules that can be tested without Vue, NestJS, Prisma,
Redis, or S3:

- money and price calculations
- price-list and terms version references
- order, job, and quote-request transition rules
- cache-key construction and profile-version value objects
- automatic-quote limits and preflight policy evaluation
- shared domain enums and invariant checks

Database models and generated API DTOs must not become the public API of this
package. Infrastructure adapters remain in the backend.

### API contract packages

`packages/openapi` is the canonical HTTP contract emitted from the backend.
`packages/openapi-client` contains generated TypeScript code consumed by both
Vue applications. Do not hand-maintain duplicate request/response types in the
frontends.

### Slicer boundary

`packages/slicer-contracts` contains only versioned, runtime-validated queue
messages and results shared by the backend and worker. Orca invocation, image
contents, profiles, and temporary-file handling stay inside
`apps/slicer-worker`. This prevents either process from importing the other's
implementation.

The worker image must pin the Orca version and expose its version/profile hash
in every result. Image upgrades are deliberate changes tested against the
fixture corpus; they are never floating dependency updates.

### Shared UI

`packages/ui-web` contains tokens and components genuinely shared by `web` and
`admin`. Page-specific components remain in their application. Start with the
visual foundation and move a component only after there is a second consumer;
do not create a generic dumping-ground package.

## 4. Foundation implementation sequence

### Phase 1 — repository policy and root workspace

1. Add the root metadata and toolchain pins using the current Nexcue versions:
   `.nvmrc`, `packageManager`, Node/pnpm engines, `pnpm-workspace.yaml`,
   `.editorconfig`, `.gitignore`, and `.prettierignore`.
2. Add root scripts for `bootstrap`, `dev`, `build`, `lint`, `typecheck`,
   `test`, per-application commands, database lifecycle, and OpenAPI generation.
3. Add the shared TypeScript, ESLint, Prettier, commitlint, lint-staged, Husky,
   and Renovate baseline. Audit every pnpm allow-list, override, and exclusion
   against Taven's actual dependency graph rather than inheriting sibling
   exceptions.
4. Add `README.md`, `AGENTS.md`, `CLAUDE.md`, and `CONTRIBUTING.md` with Taven's
   actual commands, boundaries, source-of-truth documents, and validation rules.
5. Record technical ADRs for choices not already fixed by the product documents:
   Nuxt for the public web app and Prisma for persistence. Product/business
   decisions remain in `docs/product/taven-rozhodovaci-log.md` and are not
   duplicated as ADRs.

### Phase 2 — workspace skeletons

1. Create the four application workspaces and five package workspaces with
   scoped names (`@taven/...`), package-local scripts, TypeScript configs,
   lint configs, tests, and short ownership READMEs.
2. Scaffold `apps/backend` as NestJS with Prisma and health endpoints only.
   Establish module boundaries for orders, quotes, slicing, pricing, storage,
   payments, and admin access without implementing product flows.
3. Scaffold `apps/web` as a Nuxt/Vue 3 TypeScript application and `apps/admin`
   as a Vue 3 + Vite TypeScript SPA. Wire both only to the generated API client
   and shared UI foundation.
4. Scaffold `apps/slicer-worker` as an independently buildable BullMQ consumer.
   Define the container/version seam and a no-op or fixture job before Orca
   integration. The worker must not be part of the always-on default dev command.
5. Add dependency-boundary checks so `core` stays framework-free and generated
   clients cannot be edited by hand.

### Phase 3 — local infrastructure and bootstrap

1. Add Docker Compose services for PostgreSQL, Redis, and an S3-compatible local
   object store, all with health checks and explicit persistent volumes.
2. Put the slicer worker behind a Compose profile or a separate explicit command
   so a normal idle checkout does not keep a CPU worker running.
3. Add `.env.example` files per application. Keep secrets out of root shared
   configuration and document ownership/requiredness of every value.
4. Implement an idempotent `scripts/bootstrap.sh` that installs dependencies,
   starts local infrastructure, waits for health, applies migrations, and runs
   deterministic code generation. It must fail with actionable messages when
   Docker or another prerequisite is unavailable.
5. Add `tools/slicing-fixtures` only with small, licence-safe STL/3MF fixtures
   and expected metadata. Decide on Git LFS only if the real fixture corpus
   proves too large for normal Git.

### Phase 4 — CI and repository workflows

Start with pull-request validation, not deployment:

- `format-check.yml`
- `lint-pr.yml`
- `backend-ci.yml`
- `web-ci.yml`
- `admin-ci.yml`
- `slicer-worker-ci.yml`
- `packages-ci.yml`
- `openapi-check.yml`
- `ci-scripts.yml`
- `security-scan.yml`
- `labeler.yml`

Where useful, add a reusable `_build-openapi.yml` following Nexcue. Every
path-filtered workflow must include the root configs and shared packages that
can change its result. Add a policy test equivalent to the sibling check that
prevents a root configuration change from running zero relevant workflows.

The slicer workflow should build the pinned container, run the fixture corpus,
and prove that identical input plus profile version yields identical metadata.
Pull-request validation does not publish it. Issue #25 records the verified image
digest, and issue #39 exports the selected release as a checksummed OCI archive
for direct transfer rather than requiring a registry.

The foundation deliberately did not add deploy workflows. ADRs 0006–0008 now
resolve hosting, providers, secrets, environments, and release targets; issue
#39 must add the complete deploy workflow together with the real Dockerfiles,
local integration Compose profile, rollback, monitoring, and restore controls.
An empty deployment scaffold still creates false confidence.

### Phase 5 — architecture and operational documentation

Before feature implementation, add:

- `docs/reference/architecture.md` with process, queue, database, and blob flows
- `docs/process/definition-of-done.md`
- `docs/process/testing-strategy.md`
- `docs/process/prisma-migrations.md`
- `docs/process/runbook.md`
- `docs/process/api-contract-policy.md`

Document object retention and deletion semantics from the beginning because
uploaded models, generated G-code, and photos have different lifetimes. Define
adapter interfaces for payment, storage, and carrier integrations in the
backend, but implement only providers needed by v0.

After the foundation lands, add Taven to the cross-repository drift process so
future infrastructure fixes in Nexcue are deliberately evaluated here. That
may require follow-up changes or issues in the sibling repositories and should
be handled separately from Taven's initial scaffold.

## 5. Decisions to resolve before or during scaffolding

These decisions affect foundation files and should not be guessed in product
feature work:

1. Confirm Nuxt for `apps/web` versus a plain Vue/Vite SPA. Recommendation:
   Nuxt, because public landing and static legal/content pages need strong SEO.
2. Confirm Prisma for persistence versus TypeORM. Recommendation: Prisma, used
   by Nexcue and TableTap and suitable for Taven's explicit relational model.
3. Resolved by [ADR 0007](../decisions/0007-keep-v0-providers-behind-ports.md):
   Comgate Start is the gated first payment adapter and the backend port remains
   provider-neutral.
4. Resolved by [ADR 0006](../decisions/0006-run-v0-on-an-owner-operated-vps.md)
   and [ADR 0007](../decisions/0007-keep-v0-providers-behind-ports.md):
   self-hosted Garage v2.3.0 is the live S3-compatible store and Cloudflare R2
   EU is the off-host backup and fallback. Local development continues to use
   MinIO for the fast dependency stack, while issue #39 adds a pinned Garage
   profile and runs the same storage contract against both.
5. Resolved by [ADR 0008](../decisions/0008-pin-orcaslicer-v2-4-2.md): pin the
   verified OrcaSlicer v2.4.2 AppImage and record the separately built OCI image
   and resolved profile-bundle digests in issue #25.
6. Confirm the working product name after the clearance steps in the product
   specification. Package scopes can remain `@taven/*` while the name is a
   working name, but public domains and production resources should wait.

## 6. Foundation completion criteria

The repository is ready for product code when all of the following are true:

- a fresh clone succeeds with one documented bootstrap command
- the root workspace contains only intentional applications and packages
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass from root
- OpenAPI generation is deterministic and CI detects generated drift
- Docker Compose validates and PostgreSQL, Redis, and local object storage
  become healthy
- the worker container builds independently and is not always-on by default
- a fixture queue job crosses backend contract → Redis → worker → result without
  coupling the two implementations
- root/tooling changes trigger the appropriate path-filtered workflows
- commit and PR conventions are enforced locally and in CI
- security and dependency scans have no unexplained findings
- README, architecture, setup, migration, testing, and runbook documentation
  match the actual commands
- no maker, AI, routing, node-agent, mobile, or speculative deploy scaffold has
  been added

## 7. First implementation slice

Implement Phases 1 and 2 in one focused foundation change, then Phase 3 and
Phase 4 in a second change. This keeps reviewable boundaries:

1. **Workspace foundation:** root policy, app/package skeletons, generated
   contract seam, local checks.
2. **Execution foundation:** Docker services, bootstrap, worker image/fixture,
   and CI.

Feature development should begin only after both changes meet the completion
criteria above.
