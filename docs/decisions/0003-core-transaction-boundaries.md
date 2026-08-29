# ADR 0003: Keep transaction policies in core and execution in backend

- **Status:** accepted
- **Date:** 2026-08-26

## Context

The domain rules must be deterministic and testable without a database,
framework, queue, or provider SDK. At the same time, commands that reserve
resources, receive provider events, and publish work need one database
transaction and a consistent concurrency protocol. Mixing those concerns
would make the rules impossible to reuse and would allow adapters to bypass
invariants.

## Decision

`packages/core` owns value objects, lifecycle transition tables, projections,
guards, idempotency fingerprints, and the lock set that a command requires.
Core code is framework-free TypeScript: it does not import NestJS, Prisma,
generated HTTP or slicer contracts, Redis/BullMQ, object storage, Vue, or
provider SDKs, and it never reads the system clock. A caller supplies an
`Instant` through an injected clock.

`apps/backend` owns Prisma transactions and all adapters (HTTP, persistence,
queues, Redis, object storage, payments, carriers, and email). The backend
acquires the lock set returned by core, invokes the policy, persists the
result, and performs external effects only after the transaction commits.
Generated API types remain an HTTP boundary and are not domain types.

### Quote state ownership

An issued `Quote` is an immutable offer snapshot with issue and expiry
instants. Its owning `QuoteRequest` carries the mutable
`new → in_review → quoted → accepted | rejected | expired` lifecycle. Quote
availability is projected from that request state, the immutable expiry, and
an injected clock; a second independently writable Quote status is forbidden.

### Deterministic lock protocol

Every mutating command declares its complete lock set before making a state
change. Targets are ordered by the following global rank, from lowest to
highest; a command uses the core `orderLockTargets` policy, acquires every
target in rank order, and sorts canonical kind/node/ID identities
lexicographically within each rank:

0. `IdempotencyRecord` / provider event receipt
1. `QuoteRequest` / `Order`
2. `OrderPhase`
3. `FulfilmentSlot`
4. `Claim` / `ClaimSlotResolution`
5. `ShipmentPlan` / `Shipment` / `Job`
6. `Payment` / active `RefundTransaction`
7. price snapshots and component-credit allocations
8. resource estimates, inventory reservations, and capacity reservations

Commands must not acquire a lower-ranked target after a higher-ranked target.
When a command touches multiple aggregates, it includes all parent and child
targets in this same ordering. Empty sets are valid; an incomplete set is a
conflict, never an invitation to continue with a partial mutation.

`Job`, candidate estimate, inventory, capacity, and production-reservation
targets always carry `node_id`. Backend repositories likewise require node
scope on every Job and operational-resource read or mutation, even while v0
has only one node; a missing scope is a domain error, not a global query.

### Idempotency and outbox

The API supplies an idempotency key and a canonical request fingerprint. The
backend stores both with the command result. A retry with the same key and
fingerprint returns the recorded result without replaying side effects. A
retry with the same key and a different fingerprint fails with an idempotency
conflict. Domain mutation and its outbox records are inserted in the same
database transaction, so a committed mutation always has its pending effect.

Outbox records have a versioned, length-prefixed canonical key and a unique
deduplication constraint. Workers claim records safely, retry transient
failures, and treat a completed key as already applied. Provider webhook
events have a unique `(provider, provider_event_id)` identity and are recorded
before applying their domain effect in the same database transaction; a
duplicate event is acknowledged without applying the effect twice. Provider
transaction IDs are separate identities where a provider can emit multiple
event IDs for one transaction.

### Refund retry dispatch and late receipts

A refund dispatcher durably claims an attempt through the database claim
function, which acquires the canonical order, phase, refund, and payment lock
set before recording the database claim time and making its first provider
call. Direct dispatch-claim updates are rejected. If a failed source attempt
later succeeds, an unclaimed linked retry is atomically `SUPERSEDED` and is no
longer included in committed refund totals. A claimed retry is instead
`SUSPENDED`: the source receipt is retained, Payment remains
`REFUND_PENDING`, and no further automatic dispatch is allowed.

An exact retry failure resolves that suspension atomically by selecting the
retry failure, applying the retained source success, and recalculating Payment
from the complete refund set. An exact retry success remains selected on the
suspended retry as durable financial-incident evidence; normal refund
completion stays blocked for manual financial reconciliation. Provider truth
is never rewritten as a locally invented failure or discarded because retry
work exists.

## Consequences

Concurrency behavior is reviewable as data rather than hidden in adapter
control flow. The backend has explicit responsibility for transaction
boundaries and external effects, while core can be tested with in-memory
fixtures and a fake clock. New adapters require no changes to domain policy,
but commands must update their lock declaration and outbox/provider keys when
their consistency scope changes.
