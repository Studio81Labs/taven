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

Every dispatch includes a schema-verified SHA-256 fingerprint of canonical
`{ kind, input }` JSON and an idempotency key derived from it. Producers use
`slicingInputFingerprint(kind, input)` rather than supplying their own digest.
Every result echoes the complete immutable input identity. Consumers use
`slicingResultForJobSchema(job)` against the persisted dispatch before saving a
result, so a stale retry or a result for another selected geometry cannot be
associated accidentally. Successful artifact keys are also bound to the
dispatch ID and, for production, the plate ordinal.

Payloads are capped at 64 KiB and contain only generated object keys, bounded
normalized metrics, stable codes, and immutable identifiers or hashes. Raw
model bytes, storage URLs, filesystem paths, credentials, engine logs, stack
traces, arbitrary JSON, and provider configuration do not belong on the queue.
