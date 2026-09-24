# ADR 0027: Require atomic object creation and select Silo for v0

- **Status:** accepted architecture; implementation and runtime qualification required
- **Date:** 2026-09-24
- **Authority:** escalation #251, Epic #10 revision 6, orchestration #186
- **Implementation:** #249/PR #250, #252, operational activation #39
- **Inspected:** main `f92b7e40`, PR #250 `3f1811de`, PR #247 `9f4aa9bc`
- **Amends:** ADR 0006/0007's live Garage selection and ADR 0026's provider matrix

## Evidence and root cause

The connected test in PR #250 records that Garage v2.3.0 accepts two different
`PutObject` bodies at the same key with `IfNoneMatch: "*"`, returning success
and retaining the second body. Its storage suite passed 21/22 cases; Silo
passed 22/22. Those are implementation-reported native arm64 results, not
planner-run validation or complete production acceptance.

`S3ObjectStorageAdapter.putImmutableObject` validates the supplied bytes/hash
and relies on the provider to atomically reject replacement. Its unit fixture
supplied `PreconditionFailed`; that did not establish Garage's capability.
The inspected upstream v2.3.0 and v2.4.1 `src/api/s3/put.rs` handlers do not
enforce this condition. A release or configuration upgrade has not been shown
to fix it. A general S3 compatibility claim is insufficient evidence.

The dependency extends beyond content-addressed catalog snapshots.
`S3WorkerObjectStore.write` uses the same condition for geometry UUID keys,
input-fingerprint reference/metrics keys and accepted-job production keys.
These keys are stable across attempts. Two workers can both read absence,
produce different bytes, and write; one reports a digest which a later write
invalidates. A post-write read or a subsequent operator integrity check detects
some failures but cannot prevent the overwrite. Database result acceptance does
not fence an already-running S3 request.

## Decision

Keep the existing provider-neutral ports and **atomic first-writer-wins object
creation**. Select **self-hosted Silo** as the v0 live-store target, using the
same classic release/index as local/CI ADR 0026:

```text
docker.io/pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46
```

Source: `pgsty/silo@2a4d51406b7ed87af5fe6fe0f801f3290f96eb3c`.
Keep its bundled `mcli`, verified publisher identity and explicit update owner
from ADR 0026. Do not deploy an unreviewed floating or alternate artifact.

Garage v2.3.0 is **unsupported for live Taven writes**. Retain its pinned
diagnostic profile and the failing assertion as evidence, outside the supported
provider acceptance matrix. Running its full contract must still fail; do not
skip the assertion, accept a false immutable result, or report Garage green.
No development/staging business flow may be enabled against Garage. Existing
retained Garage data is preserved for inventory and controlled transfer.

R2 remains the EU off-host backup target. Its live fallback candidacy requires
the full unchanged contract, including checksums, signatures and concurrency;
it is not an automatic or already-qualified replacement. No remote deployment
or data migration is performed by this planning decision.

### Unchanged contracts

No production application repair is needed merely to make Silo honor the
existing conditional PUT. Preserve `ObjectStorage`, worker storage behavior,
canonical serialization, object keys, SHA-256 identities, content metadata,
immutable revision ownership, DB acceptance, queue-v2, public HTTP/OpenAPI,
signed-upload validation and retention/holds. No SQL migration is required.
Do not add distributed locks, a manifest table, worker RPC or an object-key
version to compensate for an incompatible provider.

For backend immutable writes, same-byte/type/length replay succeeds and
different data conflicts without replacing the winner. Worker cache replay
retains its existing input-fingerprint semantics: the accepted winner's bytes
and digest remain stable even if a competing producer computed other bytes.
Do not impose the backend's strict byte-replay rule on that worker contract.

## Implementation gates and PR boundaries

1. **#249 / existing PR #250:** finish the pinned Silo local/CI configuration,
   provenance and documentation boundary. Incorporate this ADR and amend
   ADR 0006/0007/0026 and the provider matrix to remove the supported-Garage
   claim. Keep all security/retention assertions. Add real-provider backend
   and worker-store race tests: same and different bodies, delayed writers,
   existing winner replay and fingerprint cache winner agreement; verify
   bytes/digests after every writer settles. Use separate adapter instances
   and controlled barriers where needed. A raw concurrent conditional PUT
   probe must have exactly one successful creator; failed competitors cannot
   change that object. Preserve the original sequential regression unchanged.
   Pass Silo on native arm64 and clean hosted amd64, required backend/browser
   CI and independent review. No production adapter or contract rewrite in
   this configuration/test/docs PR. A discovered Silo/worker contract failure
   stops that gate and escalates; do not silently expand the boundary.
2. **#184 / PR #247:** after #250 merges, refresh and rerun its own final-head
   payment/resource/worker and browser validation/review. Local integration
   on qualified Silo does not wait for remote production provisioning.
3. **#252:** one separate runtime qualification/security/backup/runbook PR in
   the #39 runtime prerequisite slot, before #185 production-like acceptance
   and any target-environment activation. Preserve the VPS, Coolify, single-host
   failure model and R2 backup architecture; use a fresh explicit Silo volume,
   private credentials and production security controls. Reassess advisories
   for production exposure; ADR 0026's isolated-test assessment is not a waiver.
   Implement a bounded pre-start conditional-write/checksum capability probe
   for the actual endpoint/bucket before API bootstrap or worker consumption.
   Probe keys are random, infrastructure-only and non-sensitive; verify cleanup.
   Unknown results, overwrite, unavailable services or cleanup failure prevent
   start. The gate must reject Garage and admit qualified Silo. Do not add a
   bypass flag or confuse the probe with full provider qualification.
4. **#39:** record environment-specific credential, capacity/security, backup
   and restore proof before activation. Public release still requires #38.
   #252's local qualification does not attest that a remote environment exists
   or has passed. SERIAL, one implementation writer; no parallel groups.

The concrete #252 criteria define credential separation, TLS/CORS, non-root
runtime, image/provenance checks, audit procedure and backup/restore drill.
Preserve the existing hobby-cost constraint; measured capacity/cost failure or
an unmitigated production security finding requires escalation.

## Retained data and recovery

Do not extrapolate ADR 0012's earlier fresh-project confirmation to today's
environments. Record an empty matching DB/store for fresh installations. Before
any retained cutover, stop admissions, drain all backend/bootstrap/worker and
retention writes, reconcile deadlines/holds and inventory committed references.

For every owned catalog snapshot, reconstruct canonical bytes from the committed
ReferenceProfile, MachineProfile, MachineCalibration or PrintConfigRevision and
compare exact key, full body/digest, size and type. Audit geometry, reference,
production and metric artifacts against persisted digests and identity metadata
as well. Copy only live/held referenced verified objects to the new store,
preserving keys and metadata; reconcile again before traffic resumes. Do not
rewrite DB hashes to match observed corruption or revive expired data.

Missing catalog snapshots can be reconstructed from committed settings after
audit. Mismatched objects remain evidence and are not silently overwritten.
Corruption or missing irreproducible worker artifacts require a specific repair
decision before retained cutover. Nothing here authorizes destructive repair,
bulk history rewrites or mounting Garage/MinIO data directories into Silo.

Keep coordinated write-free DB/object recovery points. Snapshot the complete
Silo state with writers quiesced and Silo stopped unless an equivalent atomic
snapshot is verified; preserve config/identity material securely and encrypt
restic backups in R2. Rehearse restoring data, metadata, access policy and the
matching database, including retention reconciliation before service reopening.
Never back up a mutable live directory as a consistent recovery point.

Rollback uses a qualified compatible Silo image and matching verified recovery
data. Garage cannot become a writable rollback target. Preserve old volumes
read-only; if no compatible rollback exists, keep writes stopped and roll forward.

## Alternatives

- **Profile-only content-address validation:** helpful defense but fails to
  cover worker outputs at job/input keys, so it does not resolve this incident.
- **Read-before-write, post-read, process/Redis/SQL locks:** do not provide an
  S3-side fence against concurrent or delayed requests after a lock is lost.
- **Manifest/unique-attempt-object redesign:** can be correct but changes
  persistence, worker messages, result acceptance and retention unnecessarily.
- **Garage upgrade/configuration:** no verified atomic-create capability in
  the inspected releases. Requalification requires evidence, not a new tag.
- **Immediate R2 live cutover:** existing fallback candidacy is useful, but
  conditional-header documentation alone does not prove the complete checksum,
  copy and retention contract. Silo already has matching connected evidence
  and preserves the selected self-hosted operating model.
- **Merge a knowingly broken supported-provider gate:** rejected. #250 can
  merge only because Garage is explicitly disqualified and the unchanged
  contract passes on the selected supported target; not because the test is
  disabled or relabeled a success.

## References and uncertainty

- [Escalation and connected reproduction](https://github.com/Studio81Labs/taven/issues/251)
- [Garage v2.3.0 PUT source](https://github.com/deuxfleurs-org/garage/blob/7b119c0b4fa58ab3cb6d5db435fe52d990f6a7aa/src/api/s3/put.rs)
- [Garage v2.4.1 PUT source](https://github.com/deuxfleurs-org/garage/blob/268334bd2530fa99f8b06c7383b2e9f776691edd/src/api/s3/put.rs)
- [Pinned Silo release](https://github.com/pgsty/silo/releases/tag/RELEASE.2026-09-16T00-00-00Z)
- [R2 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)

Outstanding implementation evidence includes the new concurrent worker tests,
production security/capacity qualification, retained-data inventory if any, and
target-specific restore/activation. These are explicit acceptance gates, not
claims of successful deployment. A contract/security/retained-corruption failure
escalates; it cannot be resolved by weakening the invariant.
