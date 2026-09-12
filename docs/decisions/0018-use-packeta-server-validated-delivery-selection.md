# ADR 0018: Use Packeta server-validated delivery selection

- **Status:** accepted
- **Date:** 2026-09-11
- **Implementation:** issue #142

## Context

The configured delivery endpoint adapter is useful for local development and
fixtures, but cannot represent the full Czech Packeta pickup-point and Z-BOX
network. A browser widget selection is untrusted, and a successful HTTP call to
the provider validation endpoint is not itself proof that the point is usable.
The automatic-quote, handoff, payment and capture paths already rely on
immutable delivery snapshots and must not acquire network I/O inside their
transactions.

## Decision

Keep a single delivery port split into three explicit operations:

1. `selectionPolicy()` and `configuredOptions()` are process-local reads. They
   supply the public selector projection and legacy configured options without
   provider I/O.
2. `validateSelection()` is called before the idempotent destination
   transaction. It reads bounded Packeta branch/Z-BOX metadata, validates every
   server-derived planned parcel through the Packeta v6 widget validation endpoint
   and returns only an immutable address/capability snapshot. A 200 response
   with `isValid: false` is rejected.
3. `readCommittedCapability()` validates stored snapshot structure only. It is
   the operation used by payment creation, callback/capture and reacquisition;
   it never refreshes Packeta or checks current provider availability.

The provider adapter fetches only the fixed Packeta v5 branch and box endpoints
with a five-second timeout, 10 MiB response bound, one shared in-flight fetch,
hourly refresh and a 24-hour maximum usable cache age. Missing/old metadata or
provider outages fail new selection with 503. A provider-invalid selection is 400. The destination command rechecks the session, configuration revision and
checkout-acceptance fence under its existing lock; a changed configuration is
409 without mutation. Completed exact idempotency replays remain local and do
not depend on provider availability.

Only Czech internal Packeta pickup points and Z-BOXes are allowed. A Z-BOX maps
only to `zbox`; a staffed point maps only to `pickup`; `oversize` is never
inferred from Packeta feed data. Endpoint evidence can narrow an existing
versioned PriceList limit (currently max weight); it can never add a category or
widen a PriceList limit. The planner continues to evaluate the server-derived
packed units and the resulting snapshot is immutable for that quote revision.

`TAVEN_DELIVERY_SELECTOR_MODE` defaults to `CONFIGURED`. `PACKETA` requires
`TAVEN_PACKETA_WIDGET_ACCOUNT_ID` and exposes that public widget identifier,
plus bounded options, through `deliverySelector`; it exposes no service
password. Deploy backend support before its web consumer, activate PACKETA only
with that compatible web release, and disable it before rolling back to an old
web build. Existing accepted snapshots and payment-return routes remain valid.

The lazy browser component loads only
`https://widget.packeta.com/v6/www/js/library.js`; the widget uses its Packeta
iframe and validation endpoint. #39 owns production CSP/origin allowlisting,
credentials, provider onboarding and live proof. Fixture tests may intercept
these origins but cannot turn on production mode.

## Consequences

ADR 0011's former configuration-only delivery assumption applies only to the
process-local policy reads above. Handoff issuance uses one database decision
instant plus committed selected evidence; it never asks Packeta. Payment and
capture likewise use the committed snapshot. This preserves the existing
immutable quote, all-or-none reservation, idempotency and handoff lifecycle
semantics while allowing provider-backed selection before commitment.
