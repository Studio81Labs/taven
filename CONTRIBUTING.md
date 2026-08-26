# Contributing to Taven

## Set up

Use Node.js 24 and run:

```bash
pnpm bootstrap
```

The bootstrap is intentionally limited to dependency installation and
deterministic generation until local infrastructure lands in the next
foundation slice.

## Branches and commits

Branch from `main`. Commit with conventional commits:

```text
<type>(<scope>): <lower-case subject>
```

Valid types and scopes are enforced by `commitlint.config.js`. Keep one logical
change per commit and do not force-push a branch under review.

## Before opening a pull request

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm generated:check
```

If backend decorators or DTOs changed the HTTP contract, run
`pnpm openapi:generate` and commit both `packages/openapi/openapi.json` and the
generated client changes.

## Boundaries and secrets

Read `AGENTS.md` before changing workspace ownership. Never commit credentials,
production data, or local `.env` files. Product decisions belong in the product
decision log; technical decisions belong in ADRs.
