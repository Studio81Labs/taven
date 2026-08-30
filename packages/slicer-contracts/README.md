# `@taven/slicer-contracts`

Versioned, runtime-validated BullMQ payloads shared by the backend and slicing
worker. This package contains no queue connection, Orca invocation, temporary
file, storage, backend, or worker implementation code.

## Compatibility policy

The v2 queue carries strict, discriminated contracts for model inspection,
reference slicing, machine candidate estimates, and accepted-job production
slicing. Producers and consumers must reject unknown versions and fields. A
breaking shape change gets a new contract version and queue name; consumers are
deployed before producers, and an old queue is retired only after it drains.

During the v1-to-v2 transition, the worker consumes both `taven-slicing-v1` and
`taven-slicing-v2`. New producers publish only v2 messages. The v1 schema and
fixture processor must remain deployed until the legacy queue has zero waiting,
active, delayed, prioritized, and paused jobs; failed jobs require explicit
triage before the v1 consumer is removed.

Every dispatch includes a schema-verified SHA-256 fingerprint of canonical
`{ kind, input }` JSON and a job-scoped idempotency key derived from its kind,
stable dispatch ID, and fingerprint. Retries keep that dispatch ID and key;
correlation IDs and attempt numbers do not define the effect. Producers use
`slicingInputFingerprint(kind, input)` rather than supplying their own digest.
Body subsets use `geometrySelectionSha256(bodyIds)`, which rejects duplicate or
non-canonical ordering and binds the digest to the exact selected body set.
Every result echoes the complete immutable input identity. Consumers use
`slicingResultForJobSchema(job)` against the persisted dispatch before saving a
result, so a stale retry or a result for another selected geometry cannot be
associated accidentally. Successful artifact keys are also bound to the
dispatch ID. A production dispatch and result represent one exact planned Job
and may span multiple physical plates. The result exposes canonical
full-then-tail plate metrics and one immutable machine-specific multi-plate package,
matching the singular persisted `Job.productionSliceResultId` and
`SliceResult.artifactObjectKey`. `quantity` is the Job's complete slot count;
`partsPerPlate` is its plate capacity, so the result contains exactly
`ceil(quantity / partsPerPlate)` ordered plate summaries. Candidate and
production arrangement revisions bind the same accepted plan to that package.
The aggregate production package uses a separate production-package key. Its bounded
identity digest includes the accepted Job ID, complete Job quantity, and
arrangement revision in addition to the geometry, machine profile, calibration,
print configuration, and plate capacity. Two packages whose bytes or Job-bound
object keys can differ therefore cannot share the unique persisted
`SliceResult.cacheKey`.

Machine-profile snapshots declare the production artifact format explicitly:
`gcode_3mf` for Bambu, `bgcode` for Prusa, or `gcode` for Klipper. Production
results must use that exact format and its deterministic Job-bound suffix; the
slicer engine name alone never selects the transport artifact.

Candidate results separately return one cache-derived, full-occupancy
machine-slice metrics artifact. Concurrent dispatches for the same immutable
occupancy use the same identity digest and object key; the backend upserts the
`SliceResult` by that key and uses the winning row ID. The reusable row uses the
product production-slice identity through the bounded
`buildMachineOccupancySliceCacheKey` builder (geometry, machine profile,
calibration, print configuration, and occupancy only) and contains no usable
G-code. The contract rederives that digest with the shared core identity helper,
so a producer cannot substitute an opaque cache identity unrelated to those
immutable inputs. Until candidate plate-child persistence is introduced,
aggregate and final-tail estimates remain conservative at the full-occupancy
material and time floor.

Model inspection is explicitly two-step for multi-body inputs. `inspect_source`
discovers a canonical ordered body list and returns no persistable geometry.
`canonicalize_selection` carries the successful source-inspection fingerprint,
the exact body set, and a retry-stable backend-allocated `ModelGeometry` ID and
object key. Its success returns that same identity plus the canonical geometry
digest, which is sufficient to construct `GeometrySelectionSchema` without the
worker inventing persistence IDs. Dispatchers must authorize the discovery
fingerprint against a persisted successful discovery before enqueueing the
selection. STEP producers remain disabled until the trigger-gated issue #52;
the schema's format support does not authorize that product flow.

Every `canonicalize_selection` operation also carries the confirmed source-unit
to millimetre conversion. Known millimetre, inch, and metre choices have exact
scale factors; a bounded custom factor covers an explicit customer-confirmed
conversion. The conversion participates in dispatch identity and is echoed by
the canonical geometry, so differently scaled bytes cannot share a result.

Candidate and production inputs both carry the immutable arrangement revision.
The production dispatcher copies it from the candidate-backed reservation, and
its content digest participates in dispatch and fixture artifact identity.

Payloads are capped at 64 KiB and contain only generated object keys, bounded
normalized metrics, stable codes, and immutable identifiers or hashes. Raw
model bytes, storage URLs, filesystem paths, credentials, engine logs, stack
traces, arbitrary JSON, and provider configuration do not belong on the queue.
Human-readable findings and failures may not contain `/` or `\` path
separators; processors sanitize diagnostics to stable codes and safe summaries
before publishing them.
