# ADR 0019: Enforce legal approval times in the backend

## Status

Accepted (2026-09-12, [#150](https://github.com/Studio81Labs/taven/issues/150)).

Ownership, storage and deployment-based revision selection are superseded by
[ADR 0020](0020-persist-legal-document-revisions.md), implemented through
[#151](https://github.com/Studio81Labs/taven/issues/151) and
[#152](https://github.com/Studio81Labs/taven/issues/152). This document describes
the shipped PR #149 baseline. Trusted server time, fail-closed new acceptance
and preservation of accepted settlement/replay remain binding requirements.

## Context

The public web manifest renders repository-owned legal text, but a browser or
cached SSR response cannot authorize acceptance of a future legal revision.
Checkout, assisted requests and individual-offer acceptance already have
database-time transaction decision instants.

## Decision

The backend owns a checked-in, versioned legal-approval catalog. Each of the
six fixed document keys has immutable revision metadata, status, canonical UTC
ISO-8601 effective instant and approval evidence. Draft records have neither
instant nor evidence. The catalog is process-immutable; a new policy revision
is deployed rather than mutated in a command.

`GET /legal-documents/availability` evaluates that catalog using database time
and is `no-store`. It is presentation data, never an authorization token.
Backend commands re-evaluate at their existing post-lock decision instants
(and checkout also at idempotency preflight). Missing, future, draft or
mismatched records fail closed with `LAUNCH_APPROVAL_REQUIRED` before new
customer, consent, payment or acceptance effects commit.

Web text remains in `apps/web`; it must exactly match server revision and
effective instant before it enables a new action. Failed or unavailable reads
leave SSR content and customer input visible, but disable acquisition. Existing
accepted snapshots, idempotent committed replay, payment status, capture,
refund, cancellation and cleanup are not retroactively gated by a later policy
revision.

## Consequences

No database table, CMS or browser clock policy is introduced. PR5 will commit
matching approved backend metadata and web text only after #38 supplies
evidence and an unambiguous effective instant. Deployment must put an
enforcing backend in service before enabling corresponding web acquisition.
