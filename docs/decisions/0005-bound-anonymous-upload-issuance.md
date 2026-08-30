# ADR 0005: Bound anonymous upload issuance and settlement

- **Status:** accepted
- **Date:** 2026-08-30

## Context

The public configurator accepts a model before an account or quote session
exists. Each accepted initiation otherwise creates durable metadata and a
signed object-storage PUT for as much as 100 MiB. Process-local throttling is
not a sufficient boundary because API replicas would enforce independent
limits. Signed PUT authorization also expires when the request is accepted by
the object store; an upload already in flight can finish after that instant and
race the first quarantine deletion attempt.

## Decision

Reserve every anonymous model-upload initiation in PostgreSQL in the same
transaction that creates its `UploadIntent`. A fixed 15-minute window limits
each client to 20 signed URLs and 2 GiB of declared bytes, and limits the whole
service to 100 signed URLs and 10 GiB. Reservations are not refunded after a
signing or upload failure, so retries cannot evade the boundary. The global row
is locked before the client row, providing deterministic serialization across
API replicas. Expired client-window rows are removed in bounded batches.

Clients are identified by an HMAC-SHA256 of the normalized socket address with
the dedicated `TAVEN_UPLOAD_CLIENT_HASH_KEY`; raw addresses are not persisted.
The HTTP application does not trust caller-supplied forwarding headers by
default. A deployment behind a reverse proxy configures the exact trusted
proxy addresses or CIDRs through `TAVEN_TRUSTED_PROXY_CIDRS`; broad boolean or
hop-count trust is rejected. Until configured, the direct peer is used and the
global budget remains the cross-client safety boundary.

Keep the upload intent's expiry as the strict confirmation deadline. Schedule
its object cleanup five minutes later to let a request accepted before expiry
settle. After deletion, HEAD every affected quarantine/final key, repeat one
bounded deletion for keys that reappeared, and fail the durable job if absence
cannot be confirmed. A successful first sweep retains and reschedules the
durable job for a second verification one hour later. Only after that second
clean sweep may an expired or rejected unconfirmed intent and its cleanup job
be removed. Confirmation holds the same intent-row lock while copying the
verified quarantine object to its final key, so cleanup cannot finish ahead of
an in-flight promotion. Confirmed intents remain as capability and retention
audit records. Independently, one database-coordinated cursor continuously
scans the quarantine namespace. Objects older than eight days—the maximum
seven-day configurable signed-URL lifetime plus settlement margin—are deleted,
so a PUT that completes after every per-intent pass still has a bounded, durable
cleanup path without retaining one database job per upload forever.

## Consequences

Anonymous pre-quote uploads remain available without creating an unbounded
database or signed-byte path. Limits are enforced consistently across replicas
and forwarded-header spoofing does not create new client buckets. Shared NAT
addresses share a client budget. The two settlement periods temporarily retain
abandoned bytes. The continuous sweep is the provider-neutral late-write
backstop; an object-store-native quarantine lifecycle remains useful as
defense-in-depth in production.
