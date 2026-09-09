# ADR 0012: Materialize immutable revision snapshots at activation

- **Status:** accepted
- **Date:** 2026-09-09
- **Related:** Epic #7 §§4.4.1 and 4.4.3, escalations #101 and #103, issues #99 and #104

## Context

Catalog revisions persist canonical slicer settings in PostgreSQL and are
insert-only. The storage adapter materializes the same settings as an immutable,
content-addressed object at
`slicer-revisions/<lowercase-sha256>/settings.json`.

The canonical serialization used for persisted revision digests, snapshot bytes,
and catalog command fingerprints is the initial deterministic UTF-16 code-unit
order. The owner has confirmed this project is fresh and undeployed, with no
historical resource hashes or objects that require compatibility handling. ADR
0015 records the shared serializer contract.

Creating a DRAFT revision previously wrote that object before the catalog and
idempotency transaction committed. A concurrent request, later database
rejection, or process crash could therefore leave an object without a committed
revision that owned its hash. A database transaction cannot roll back that
external write.

The system needs immutable verified inputs before a revision becomes ACTIVE,
but creating a DRAFT does not require a ready external artifact. PostgreSQL
already holds the complete canonical source and permanent revision history.

## Decision

1. Creation of a reference profile, machine profile, or machine calibration is
   database-only. A successful create commits the immutable DRAFT revision,
   revision identity, original-actor audit event, and idempotent response in one
   transaction. It makes no snapshot-storage promise.
2. A committed revision in any state owns the canonical snapshot hash derived
   from its persisted settings. DRAFT, ACTIVE, and RETIRED ReferenceProfile,
   MachineProfile, MachineCalibration, and PrintConfigRevision revisions
   protect a shared snapshot from reclamation.
3. The first activation is the verification gate. The backend resolves a
   committed, trusted revision identity, canonicalizes its persisted settings,
   and materializes or verifies the immutable object outside an SQL transaction.
   It then starts the authoritative activation transaction, rechecks
   idempotency, scope, and lifecycle, and commits the transition, audit event,
   and idempotent response together.
4. Snapshot materialization accepts only a backend-resolved revision kind and
   ID. It never accepts request settings, caller-selected keys, paths, URLs, or
   a caller-supplied verification flag. A calibration additionally resolves
   through its trusted node scope.
5. Authorized completed replays are storage-free and return their original
   result. Storage unavailability before activation commits is a sanitized 503;
   immutable object hash, length, or content-type disagreement is a sanitized 409. Neither commits an activation, audit event, or completed activation
   record. Retirement performs no storage I/O.
6. `canonicalJson` uses deterministic UTF-16 code-unit key ordering for
   persisted revision digests, snapshot bytes/SHA-256 object keys, and catalog
   command idempotency fingerprints. It preserves JSON scalar encoding and
   array order. No legacy helper, dual hash, fallback lookup, or migration is
   introduced for the confirmed fresh state; ADR 0015 supersedes ADR 0013's
   former split.

No durable staging lease, new storage prefix, promotion state, migration,
background completion worker, or online snapshot garbage collector is added.

## Consequences

An activation PUT that survives a later lost activation race or failed database
transaction is safe: it is already owned by its permanent committed revision.
A crash or rejected create cannot create a new unowned snapshot. Bootstrap and
job-dispatch repair continue to reconstruct missing objects only from committed
revision settings.

The creation and activation operations intentionally have different guarantees:
create returns a DRAFT identity; activation returns only after its immutable
settings artifact has been verified. Clients obtain current lifecycle state
through reads rather than expecting a completed command replay to reflect later
transitions.

This refines ADR 0003: external materialization occurs after the revision's
creation transaction commits and before the separate activation transaction. It
relies on ADR 0004's insert-only revision payload and identity invariants for
permanent artifact ownership.

## Historical-object maintenance

Historical-object inventory, cleanup, writer drain, and compatibility work are
inapplicable: the owner confirmed that this project is fresh, undeployed, and
has no historical resource objects. The committed ownership and integrity rules
above remain required for all newly created revisions.
