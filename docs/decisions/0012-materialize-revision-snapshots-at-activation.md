# ADR 0012: Materialize immutable revision snapshots at activation

- **Status:** accepted
- **Date:** 2026-09-09
- **Related:** Epic #7 §4.4.1, escalation #101, PR #99

## Context

Catalog revisions persist canonical slicer settings in PostgreSQL and are
insert-only. The storage adapter materializes the same settings as an immutable,
content-addressed object at
`slicer-revisions/<lowercase-sha256>/settings.json`.

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

## Historical-object maintenance runbook

Older binaries may have produced unreferenced objects. The default maintenance
operation is a dry-run inventory of exact-format
`slicer-revisions/<sha256>/settings.json` keys against canonical hashes from
all four persisted revision families in every lifecycle state.

Deletion is permitted only during a confirmed stop/drain of every old and new
snapshot writer, bootstrap process, and dispatcher. Immediately recheck the
canonical hash reference before deleting an exact-format unreferenced key; keep
shared, referenced, malformed, or unfamiliar keys. The operation must be
idempotent and resumable. If writer quiescence cannot be proven, report only;
elapsed time is not a deletion fence.
