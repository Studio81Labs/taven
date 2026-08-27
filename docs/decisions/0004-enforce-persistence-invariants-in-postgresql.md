# ADR 0004: Enforce persistence invariants in PostgreSQL

- **Status:** accepted
- **Date:** 2026-08-27

## Context

Issue #15 establishes the persistence foundation for immutable slicing inputs,
source-file retention, and resource reservations. These records are written by
different backend commands and workers, so application validation alone cannot
protect them from concurrent writers or a future adapter. The database must
reject ambiguous revision references, invalid source lineage, cross-node
references, oversubscribed inventory, overlapping machine reservations, and
incomplete reservation sets at commit time.

Prisma remains the schema and client boundary. Prisma migrations, including
their hand-written PostgreSQL SQL, are the source of truth for extensions,
indexes, triggers, and constraint timing. Generated Prisma schema and types do
not replace reviewed migration SQL. Phase, Job, and Shipment identifiers are
opaque UUIDs in this foundation; their domain relationships and lifecycle
rules are deferred to issue #16.

## Decision

Use PostgreSQL declarative constraints, indexes, and narrowly scoped triggers
as the final persistence boundary. Backend commands still use the transaction
and lock protocol from ADR 0003, but a transaction cannot commit when one of
the following invariants is violated.

### Global revision identity

Maintain one immutable registry of globally unique revision IDs. The registry
is used only by `PrintConfigRevision`, `ReferenceProfile`, `MachineProfile`,
and `MachineCalibration`. Each revision table uses its revision ID as a
primary/foreign key to the registry, and an insert trigger verifies the
registry's family discriminator. A revision ID therefore cannot collide with
a local version number in another table or be interpreted as a different
revision family.

Revision identities and payloads are insert-only. A database trigger rejects
payload updates and deletes, including writes made outside the application.
Profiles and calibrations may move only forward through their explicit
draft/active/retired lifecycle while their content stays unchanged. The
revision payload and identity remain stable for cache keys, estimates, plans,
and production input snapshots.

### Source lineage and retention deadlines

`ModelGeometry` must reference its source `ModelFile`; the foreign key is
required and cannot be replaced by a hash-only association. Source-derived
records carry the source-file identity needed to enforce the same lineage.
Geometry hashes are indexed for cache lookup but are not globally unique,
because identical bodies uploaded as distinct source files retain distinct
lineage and retention records. A geometry can be created or used by a new
slice/estimate only while its source deadline is in the future or an explicit
retention hold is active. Source cleanup propagates the source deletion
timestamp to an immutable geometry deletion marker, retaining hashes and
lineage for audit while preventing further reconstructed use.
Row checks require an upload timestamp and a deletion deadline, with the
deadline no earlier than the upload/creation instant. An upload cannot become
persisted without its initial deadline.

Deadline extensions and retention holds are monotonic: a valid quote/order
hold or legal hold may extend the deadline, but a write cannot shorten it,
clear required source lineage, or remove the deadline. Cleanup is an
outbox-driven backend side effect; the database remains authoritative for the
deadline and hold state. Object deletion therefore cannot be justified by a
stale deadline copied by a worker.

### Node scope and declarative constraints

Operational resource records always carry `node_id`, and inventory is also
scoped to its concrete machine. Composite foreign keys include `node_id` (and
`machine_id` for machine inventory), proving that a candidate estimate,
inventory reservation, capacity reservation, production reservation, or
related resource belongs to the same node and physical machine. A missing
node scope is invalid; it never means “all nodes”.

Use `CHECK` constraints for row-local facts such as non-negative quantities,
positive durations, valid interval bounds, and required/forbidden nullable
columns. Use partial unique indexes for active planned keys and other
conditional cardinality rules while retaining historical rows. Phase, Job,
and Shipment IDs are intentionally treated as opaque UUID foreign-key targets
until issue #16 defines their domain topology.

### Inventory and capacity

Inventory reservations are node-scoped, reference a concrete inventory bucket,
and store non-negative required milligrams. A reservation trigger locks the
affected `Inventory` row and atomically updates
`Inventory.reserved_milligrams` when a reservation is created, changed, or
released. The trigger rejects an operation when the resulting reserved amount
would exceed available stock. The maintained counter, rather than a deferred
aggregate `SUM`, is the invariant used for concurrency-safe anti-
oversubscription; reservation state transitions and the counter update happen
in the same transaction. A deferred reconciliation trigger also compares the
stored counter with all active reservation rows, so a direct counter update
cannot manufacture availability.

Capacity reservations are node- and machine-scoped and store a non-empty,
half-open time interval. Install PostgreSQL's `btree_gist` extension and use a
GiST exclusion constraint on machine identity and the interval for active
reservations. PostgreSQL consequently rejects overlapping reservations for the
same machine while allowing disjoint intervals and different machines. Checks
reject reversed or empty ranges; released historical reservations are excluded
by the active-state predicate.

### Complete reservation sets

`PhaseReservationSet` is the atomic resource hold for an eligible plan.
Each planned job has a stable `planned_job_key`, a candidate estimate, and one
or more normalized fulfilment-slot rows. The candidate stores the exact
profile, calibration, config, machine inventory, and immutable plate-interval
snapshots. Production, inventory, and one-or-more capacity reservation rows
copy and protect those selections. Composite foreign keys prove set, plan,
machine, and node ownership; unique indexes allow each planned key and slot
only once within its scope, and a partial unique index allows only one active
reservation set per plan. Terminal sets retain their immutable history without
preventing a later set from retrying the same planned jobs. Reference slices
require their immutable print configuration and reference profile to select the
same quality; candidate creation enforces the equivalent production-profile
match. Before planning,
the union of a candidate's capacity intervals must cover its declared machine
seconds, and intervals must not overlap within a candidate or across candidates
assigned to the same machine in one plan. This keeps every accepted plan
representable by the active-capacity exclusion constraint.

A deferred constraint trigger compares the reservation children with the
authoritative plan. Every required planned key must have exactly one complete
production/inventory reservation and a matching active capacity reservation
for every candidate plate interval; every required fulfilment slot must be
assigned exactly once, and no extra key or interval is allowed. Plan and
candidate-interval membership freeze when reservation/planning begins. Writers
lock the shared plan or candidate row before either side of each membership
boundary changes, serializing reservation creation against concurrent plan
members and planning against concurrent candidate intervals. The set cannot
become held or active while the completeness comparison fails, and later child
changes revalidate both reserved and held sets. A reservation set must remain
within a resource plan that is still current at insertion and confirmation
time, and all production, inventory, and capacity children share the set
expiry. Terminal parent states cannot retain or later acquire active children.
Reservation rows must start at their lifecycle entry states before following
the allowed transition graph. `BUILDING` is transaction-local and cannot
survive commit. A reserved set requires every child to remain reserved; a held
set may mix fully live and fully terminal job-resource groups while at least
one group remains live. A held set remains valid after its checkout TTL because
it is then governed by the active phase's operational deadline. Confirmation
locks and revalidates the selected geometry source, machine, profile,
calibration, and inventory, requires every live capacity interval to remain in
the future, and compares each copied resource snapshot with its candidate
estimate. Deferral permits one
confirming transaction to insert the set and all children together; it does not
make a partial set valid across transactions.

### Immutable inputs and snapshots

The following payloads are immutable once persisted: the four revision
families, source and geometry inputs, candidate resource estimates, and phase
resource plans. Their hashes, selected revision IDs, and resource facts are
protected by immutable-row triggers. Corrections create a new revision,
estimate, or plan and preserve the old row for auditability. Retention
deadlines/holds, profile lifecycle state, reservation status, and other
explicitly operational fields remain mutable only where the model defines
them as such. Completed idempotency results are terminal so a replay cannot
replace the stored command response; immutability is not an application
convention.

Triggers are kept narrow. Checks, foreign keys, partial unique indexes, and
the GiST exclusion constraint remain preferred for facts they can express
declaratively. Every trigger function, extension, non-default index, and
deferrable constraint is versioned in migration SQL and tested with concurrent
transactions.

## Consequences

The commit boundary rejects ambiguous revision identities, broken model-source
lineage, missing upload deadlines, cross-node resource references,
oversubscribed inventory, overlapping machine intervals, incomplete phase
reservation sets, and rewritten immutable inputs. The maintained inventory
counter gives a direct and lockable anti-oversubscription invariant, while
GiST exclusion provides a database-native machine calendar guarantee.

The tradeoff is PostgreSQL-specific migration complexity. Prisma
introspection and generated clients may not expose every trigger, partial
index, extension, or exclusion constraint, and some errors surface at commit
because reservation completeness is deferred. The backend must preserve lock
ordering and make cleanup/outbox effects retry-safe. Those costs are accepted
because application-only checks cannot reliably protect finite inventory,
machine time, or immutable production inputs under concurrent and future
writers.
