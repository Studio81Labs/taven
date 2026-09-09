# ADR 0013: Separate catalog command fingerprints from persisted hashes

- **Status:** accepted
- **Date:** 2026-09-09
- **Related:** Epic #7 §4.4.2, escalation #102, issue #91, PR #99

## Context

Catalog revision digests and immutable slicer snapshot object keys were already
derived from the historical `canonicalJson` serializer. That serializer uses
`localeCompare` for object keys. Replacing it with a code-unit comparator would
silently change durable revision digests, snapshot SHA-256 values, and object
keys for some Unicode payloads, making committed data unreadable to corrected
backend and worker binaries.

Catalog idempotency needs a total key ordering: semantically identical command
bodies must receive the same request fingerprint even when Unicode keys compare
as equal under locale collation. This command-local requirement does not justify
changing durable identifiers.

## Decision

1. `canonicalJson` retains the exact historical `localeCompare` ordering. It
   remains the sole serializer for persisted resource revision digests and
   slicer profile snapshot bytes, SHA-256 values, and object keys.
2. `canonicalCatalogCommandJson` uses a deterministic UTF-16 code-unit total
   order. It is used only after catalog command input validation to derive
   idempotency request fingerprints.
3. No migration, rewrite, fallback lookup, or dual-read scheme is introduced.
   Corrected binaries must read historical PostgreSQL revision data and MinIO
   objects using their original hashes and keys.
4. Compatibility coverage uses literal historical bytes and SHA-256 goldens,
   and exercises existing command replays through the new fingerprint path.

## Consequences

Existing snapshots and revision identities remain stable across deployment.
Catalog commands gain total-order idempotency without altering persistence or
the worker storage contract. Any future durable serializer change requires an
explicit data migration and a new architectural decision.
