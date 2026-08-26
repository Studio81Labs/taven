# `@taven/core`

Pure, deterministic domain rules shared by Taven processes. This package must
remain testable without NestJS, Vue, Prisma, Redis, S3, or generated API types.
Its runtime dependency list is intentionally empty and enforced by
`pnpm boundaries:check`.
