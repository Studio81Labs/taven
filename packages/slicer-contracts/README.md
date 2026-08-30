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

During the v1-to-v2 transition, the worker consumes both `taven:slicing:v1` and
`taven:slicing:v2`. New producers publish only v2 messages. The v1 schema and
fixture processor must remain deployed until the legacy queue has zero waiting,
active, delayed, prioritized, and paused jobs; failed jobs require explicit
triage before the v1 consumer is removed.

Every dispatch includes a schema-verified SHA-256 fingerprint of canonical
`{ kind, input }` JSON and an idempotency key derived from it. Producers use
`slicingInputFingerprint(kind, input)` rather than supplying their own digest.
Every result echoes the complete immutable input identity. Consumers use
`slicingResultForJobSchema(job)` against the persisted dispatch before saving a
result, so a stale retry or a result for another selected geometry cannot be
associated accidentally. Successful artifact keys are also bound to the
dispatch ID. A production dispatch and result represent one exact plate
occupancy and expose one occupancy-keyed artifact, matching the persisted
`SliceResult`. Each physical plate is a distinct accepted Job/queue job ID; a
Job may cover multiple slots only when they share that plate. A batch's full and
final partial occupancies therefore use distinct accepted Jobs and results. For
production, `quantity` equals that Job's exact `partsPerPlate` occupancy.
The upstream planner and dispatcher must materialize a distinct plan job,
reservation, and accepted Job per physical plate; a multi-plate candidate
aggregate is planning evidence, never one production dispatch.

Payloads are capped at 64 KiB and contain only generated object keys, bounded
normalized metrics, stable codes, and immutable identifiers or hashes. Raw
model bytes, storage URLs, filesystem paths, credentials, engine logs, stack
traces, arbitrary JSON, and provider configuration do not belong on the queue.
Human-readable findings and failures may not contain `/` or `\` path
separators; processors sanitize diagnostics to stable codes and safe summaries
before publishing them.
