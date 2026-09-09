# ADR 0014: Derive reference-profile activation notices from committed state

- **Status:** accepted
- **Date:** 2026-09-09
- **Related:** Epic #7 §4.4.3, escalation #100, issue #91, PR #99

## Context

Activating a reference profile changes the trusted slicer basis used for future
quoting. Operators need a durable prompt to review the price list, but neither
existing quotes nor the delivery queue may be changed automatically.

An activation already commits `ReferenceProfile.activatedAt` atomically with
its lifecycle transition. This immutable historical fact includes profiles that
have subsequently retired, so it can produce a deterministic operator feed
without introducing another durable workflow record.

## Decision

1. Every committed reference-profile activation derives one notice from the
   persisted profile row. Its deterministic ID is
   `reference-profile-activated:<lowercase-profile-id>`, with schema version
   1 and action `REVIEW_PRICE_LIST`.
2. The successful first activation response includes that notice. Idempotent
   replays return the persisted response verbatim; no new notice is generated.
3. Operators with `OPERATIONS_READ` can list notices using a bounded,
   version-bound keyset feed ordered by `(activated_at DESC, id DESC)`. Active
   and retired profiles are included; drafts and unactivated profiles are not.
4. The notice creates no price list revision, quote reprice, customer message,
   payment action, delivery queue action, background worker, schema change, or
   acknowledgement state.

## Consequences

Notice history is durable because it is derived from committed lifecycle state,
not from an ephemeral response or delivery attempt. Operators have an explicit
review signal while existing commercial and delivery state remains immutable.
