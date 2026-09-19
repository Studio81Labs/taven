# Legal document management workflow

Legal documents are managed through the authenticated admin API. An operator must
have `legal:read` to inspect documents and `legal:write` to make changes. A
node-free `ADMIN` is intentionally limited to legal and audit access.

## Development/staging baseline

The owner authorizes an explicit v0.1 import for development/staging under the
[baseline contract](../product/taven-development-legal-baseline-v0.1.md). Use the
ordinary protected workflow below, pin content/commit/hash and record the actual
limited approval scope and environment-specific effective instant. This is not
counsel or production approval. No automatic approval seed or NODE_ENV shortcut
is permitted; verify an isolated non-production target before writes. #39 must
reject the v0.1 baseline as production policy before public activation. Keep all
historical v0.1 records unchanged when later production revisions are created.

## Authenticate and preserve the session

In development, create a session with `POST /admin/auth/login`. In staging and
production, begin the GitHub flow with `POST /admin/auth/github/start` and let
the browser complete `GET /admin/auth/github/callback`. The callback creates the
HTTP-only session cookie.

Call `GET /admin/auth/session` with that cookie to obtain the CSRF token. Send
the cookie, an allowed `Origin`, and `X-CSRF-Token` on every mutation. End a
session with `DELETE /admin/auth/session`; this request is CSRF-protected and
revokes the server-side session.

## Read and edit a draft

1. List documents with `GET /admin/legal-documents`, then read one with
   `GET /admin/legal-documents/{key}`. The detail response provides the current
   document `generation`, draft `editVersion`, and content hash.
2. Create a draft using `POST /admin/legal-documents/{key}/revisions`. Supply
   `expectedGeneration` from the read response, the required rationale, and a
   unique `Idempotency-Key`.
3. Update a draft with `PUT /admin/legal-documents/{key}/revisions/{revisionId}`.
   Supply the draft's current `expectedEditVersion`, a new rationale, and a
   unique idempotency key.

Each successful mutation advances its optimistic-concurrency token. Re-read and
retry with the new token after a `409 Conflict`; never reuse a key with changed
input.

## Approve and publish

1. Approve a draft through
   `POST /admin/legal-documents/{key}/revisions/{revisionId}/approve` using its
   current `expectedEditVersion` and `expectedContentHash`. Provide an immutable
   revision code, a timezone-aware effective instant, approval evidence, a
   rationale, and an idempotency key.
2. Publish the approved revision through
   `POST /admin/legal-documents/{key}/revisions/{revisionId}/publish`, supplying
   the current document `expectedGeneration`, rationale, and idempotency key.
   Omit `startsAt` for immediate publication or provide a future RFC 3339 instant
   to schedule it.
3. Inspect history with
   `GET /admin/legal-documents/{key}/publications` and audit history with
   `GET /admin/legal-documents/{key}/audit-events`.

An immediate or scheduled publication replaces the active publication only at
its start boundary. Published text is publicly available at
`GET /legal-documents/{key}/revisions/{revisionCode}` once active.

## Import the owner-approved development baseline

PR5c's v0.1 package is a development/staging baseline only. It is not counsel
review, a production revision, or launch authorization. The package is pinned
to the source commit and exact hashes described in
`docs/product/taven-development-legal-baseline-v0.1.md`.

Run the importer only with an explicitly selected, non-production target
descriptor. Start from `docs/operator/legal-baseline-target.example.json`, copy
it outside the repository, and set the real target URL and stable target ID.
The descriptor must identify `development` or `staging`, set
`allowBaselineImport` to `true`, and use an exact allowed admin origin; a
production target is rejected before any request is sent. The importer does
not classify a target from `NODE_ENV`.

Supply an existing authenticated ADMIN session and its CSRF token through
`TAVEN_LEGAL_IMPORT_SESSION_COOKIE` and `TAVEN_LEGAL_IMPORT_CSRF_TOKEN`. These
values are never written to the receipt or logged. The session is used for the
ordinary protected create, approve and publish commands, so the authenticated
actor and audit trail remain real operator evidence.

```bash
cp docs/operator/legal-baseline-target.example.json /tmp/taven-baseline-target.json
TAVEN_LEGAL_IMPORT_SESSION_COOKIE='taven_admin=…' \
TAVEN_LEGAL_IMPORT_CSRF_TOKEN='…' \
  pnpm -C apps/backend legal:baseline:import \
    --target-config /tmp/taven-baseline-target.json \
    --receipt /tmp/taven-legal-baseline-receipt.json
```

The receipt is created before mutations and records the immutable source and
package hashes, target descriptor hash, per-document effective instant,
revision/publication UUIDs, and audit event IDs. Re-running with the same
target descriptor and receipt reconciles completed documents and reuses the
same effective instants and idempotency namespace; it never overwrites an
approved code or resamples a timestamp. Partial imports resume only missing
documents. Use a new receipt for a different isolated target. Keep receipts
restricted because they identify operator and environment metadata, even
though they contain no credentials.

The importer verifies the exact public revision and availability response after
all six documents are complete. A future `--effective-at` is allowed for
boundary testing and remains scheduled until its database publication starts.
It does not enable production defaults, bypass database triggers, create a
seed approval, or change the schema/API.

## Cancel or archive

Cancel a still-pending scheduled publication with
`POST /admin/legal-documents/{key}/publications/{publicationId}/cancel`.
Archive an active publication without replacement using
`POST /admin/legal-documents/{key}/publications/{publicationId}/archive`.
Both require the current `expectedGeneration`, a rationale, and a unique
idempotency key. History is immutable; cancellation and archival only apply at
their permitted lifecycle boundaries and otherwise return `409 Conflict`.

## Controlled SQL maintenance and backfill

Ordinary legal work must use the management API above. A controlled maintenance
or backfill transaction must acquire any command identity first, then lock all
affected `legal_documents` rows in canonical `key` order in a separate completed
statement before it selects, inserts, or updates any publication row. After
locking, revalidate the generation, lifecycle and database decision time, make
the transition, and write its required actor, reason, audit and command evidence
in the same transaction.

Do not rely on CTE evaluation order, lock a publication before its document, or
add document locks after publication work begins. The publication trigger uses a
nonblocking guard as a final integrity boundary: an out-of-order update that
conflicts with a document owner fails with SQLSTATE `55P03` and
`legal_document_publications_document_lock_conflict`. Roll back the whole
transaction and retry only by re-entering through this document-first protocol;
never retry inside the failed transaction or treat that error as partial success.
