# ADR 0002: Use Prisma for persistence

- **Status:** accepted
- **Date:** 2026-08-26

## Context

Taven has an explicit relational model and requires reviewed, repeatable
PostgreSQL migrations. The sibling repositories already operate Prisma in the
same NestJS and pnpm workspace shape.

## Decision

Use Prisma in `apps/backend`. Database models and generated Prisma types are
backend implementation details and must not become the public API of
`packages/core` or frontend workspaces. Schema changes use migrations; `prisma
db push` is not an accepted development or deployment path.

## Consequences

The repository gets consistent migration and generation commands. Persistence
adapters stay behind backend module boundaries, and the HTTP contract remains
the only type boundary exposed to web clients.
