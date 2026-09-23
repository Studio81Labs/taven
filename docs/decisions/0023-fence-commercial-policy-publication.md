# ADR 0023: Fence commercial policy publication at binding commitment

- **Status:** accepted
- **Date:** 2026-09-23
- **Implementation:** Epic #10, escalation #194, PR3a of #183

## Context

An immutable PriceList can be created but the automatic quote flow previously
selected a process environment revision. Publishing a new list while a
destination provider call or quote preparation is in flight could mix old
validation with new pricing. A draft order may already have a committed price
binding while resource checks continue.

## Decision

One currency-keyed `CommercialPolicySelection` points to an immutable
`PriceList` and carries a monotonic version. The CZK selector is initialized
only from the exact known `automatic-v0-czk` list. A missing or ambiguous
bootstrap list fails migration; runtime never creates a selector implicitly.

Activation is an idempotent ADMIN command with expected version, bounded
reason, audit, and an exclusive row lock. It increments the version even when
selecting the same PriceList or returning to an earlier revision. Fresh
policy-dependent writes lock the selector row `FOR SHARE` before session or
order locks, and hold the lock through commit. A binding insert also verifies
the declared selection tuple. See ADR 0003 for the full lock order.

The automatic commercial decision commits when `PriceSnapshot`,
`OrderPriceBinding`, `OrderActivePriceBinding`, and `quote.bound` evidence commit
atomically. That binding pins its PriceList even if its order is still DRAFT
or its QUOTED offer is unaccepted. Activation affects only the next genuinely
new binding. Later eligibility, checkout, payment and settlement use the
binding's immutable list; existing legal, resource, expiry and ownership
gates remain in force.

Destination provider validation captures a selector tuple and draft revision
before I/O and checks them under the selector lock before committing. Because
destination and binding commit separately, a fresh binding performs one more
bounded provider validation outside its transaction, then checks the selected
tuple and parcel input fingerprint under the lock. Changed provider evidence
requires explicit reselection. A completed binding or idempotency replay does
not depend on current provider availability.

## Consequences

Publication can wait for a concurrent fresh decision, or a stale decision can
fail with 409 and retry after rereading policy. Neither order scanning nor a
new historical policy column is needed. Deploy compatible readers and writers
and drain old policy-writing processes before enabling activation.
