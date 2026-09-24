# ADR 0023: Fence commercial policy publication at binding commitment

- **Status:** accepted
- **Date:** 2026-09-23
- **Implementation:** Epic #10, escalation #194, PR3a of #183

## Combined publication contract (Epic #10 revision 4, escalation #238)

The same immutable CZK PriceList supplies automatic pricing/tax and individual
balance terms. Fresh catalog creation and activation require four root fields:
`sellerTaxPolicy`, `automaticQuote`, `balance_payment_days` (integer 1–36500),
and a nonempty, unique `balance_timeout_earned_component_kinds` array of the
supported price component kinds. The development compatibility baseline is
seven days and ITEM_PRODUCTION, ITEM_QUANTITY, ITEM_POSTPROCESSING. These are
explicit publication values, never runtime defaults.

The existing automatic-only revision remains selected and can serve automatic
work until an operator creates and explicitly activates a complete successor
through authenticated catalog commands. Copy the selected revision's tax and
automatic configuration exactly; creation alone does not publish. A selected
incomplete policy makes fresh individual preview/issue/reissue unavailable.
Completed historical catalog retries and previously issued bindings retain
their original payload and result. Accepted payments, deadlines, earned
components and settlement continue to read the bound immutable list after
any later activation. Historical automatic-only and individual-only rows stay
readable. This correction adds no policy table or data migration.

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
