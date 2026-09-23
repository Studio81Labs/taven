# v0-1 business metrics

`GET /admin/metrics` returns the v0-1 aggregate report and
`GET /admin/metrics/orders` returns its node-proven operational order details.
Both require an authenticated `ADMIN` operator with `metrics:read`, use a
read-only `REPEATABLE READ` transaction, take `generatedAt` from the database,
and send `Cache-Control: no-store`.

The required `from` and `to` instants define `[from,to)`, must span no more
than 366 days, and accept only the known v0 `CZK` currency. A channel filter
uses the privacy-minimized stored attribution. The supplied or defaulted node
is used only for operational sections and `/orders`; commercial sections are
always platform aggregates.

Every report carries the `v0-1` definition label, interval, source coverage,
and completeness flags. Money is represented as a signed decimal
`amountMinor` string plus its currency. Ratios always contain numerator,
denominator, and a nullable value. No report returns customer contact data or
raw event payloads.

The aggregate covers these definitions:

- Funnel stages are distinct confirmed model-file uploads, automatic
  binding-price quote views, checkout starts, and confirmed orders. Impressions
  and clicks are explicitly not collected.
- Quote-to-paid cohorts use immutable binding offers issued in the interval;
  expired offers remain in the denominator and deposits do not create a second
  order. Automatic clean, warning, and unknown preflight cohorts each report
  their own issued, accepted, and conversion values.
- Order value, express share, and price bands use immutable accepted pricing.
  Current contract amounts, captured cash, and successful refunds remain
  separate.
- Automation is counted once per model file, with successful, persisted
  assisted-handoff, unresolved, and unavailable evidence called out separately.
- Actual-cost reports use leaf (not superseded) costs and completed,
  non-voided handling allocations. Final contribution margin stays null unless
  the order has terminal settlement evidence, no unresolved refund, explicit
  zero-or-measured coverage for every v0 cost category, and completed handling
  allocation evidence. A partially fulfilled order is terminal when those
  conditions hold. Fully refunded orders retain zero revenue and their
  incurred costs. A `CANCELLED_SETTLED` order uses its immutable reconciled
  balance settlement's retained cash, converted to net under the accepted tax
  policy, only after it matches succeeded captures and refunds.
- CAC includes only leaf acquisition spend wholly inside the interval. Repeat
  status uses the historical first confirmed order for the customer.
- FPY considers original jobs only. Queue time comes from unconsumed planned or
  active machine capacity intervals, never measured labour time.
- Assisted SLA uses persisted request/offer timestamps against the database
  clock; responses are split into on-time and late populations, and its rate
  is the on-time cohort rate. Operational monthly turnover uses Europe/Prague
  months and keeps confirmed value, captured cash, successful refunds, and net
  receipts apart.

Raw client observations are intentionally not backfilled. The report therefore
signals coverage uncertainty instead of inventing historical funnel facts.

## Additive v0-2 price-band conversion

`commercial.quoteToPaid.priceBandConversion` has its own `v0-2` label; the
aggregate and all existing v0-1 fields retain their original definitions.
It assigns each issued immutable binding to a band using its gross CZK amount
at issuance: below 250, 250–499, 500–999, 1000–1999, or at least 2000 CZK.
It reports issued and confirmed-paid counts and nullable conversion ratios for
the total, automatic and individual origins, and each origin's preflight
classification. Reissued or expired bindings remain in their issuance cohort.
An accepted order refers to its exact binding; a deposit never adds a binding.
Missing or non-CZK gross evidence is counted as unavailable rather than placed
in a price band. Existing `acceptedGrossBands` still describes accepted-order
amounts and is not a conversion denominator.

For every new automatic binding, the server stores
`PriceSnapshot.inputSnapshot.automaticQuote.preflightAtIssuance` as
`{ "schemaVersion": 1, "classification": "clean" | "warning" }` before
hashing and committing the immutable snapshot. The successful current risk
gate supplies this summary in the same locked transaction: zero WARNING
findings is clean (including INFO-only findings), while permitted acknowledged
WARNING findings are warning. Blocking, declined, unacknowledged and excessive
warnings still prevent binding. The exact binding's snapshot is the sole v0-2
preflight source; `quote.bound` provides its issuance identity and timestamp.

Older automatic bindings without a supported summary are `unknown` in v0-2.
Missing, null, malformed and future-version summaries are also unknown. Every
individual offer remains unknown, including one reached by automatic handoff.
Unknown preflight still contributes to origin and total denominators and to
its known gross band; `unavailableGross` is an independent count. No historical
binding, snapshot hash or event is rewritten or inferred from current findings.
The preserved v0-1 preflight projection intentionally continues using current
order-scoped risk decisions, so its classification can differ from v0-2's
issuance classification after reconfiguration or source cleanup.

## Evidence and warning reads

`GET /admin/orders/{orderId}/actual-costs` and
`GET /admin/acquisition-spend` provide bounded, cursor-paged correction
histories for an authenticated ADMIN with financial-exception permission.
Order costs additionally prove the operator's node. Amounts are decimal minor
units, and `successorId`/`isCurrent` distinguish corrected evidence from the
leaf used in CM or CAC. These reads never change costs.

`GET /admin/warnings` gives an ADMIN a bounded snapshot of factual refund,
capture-compensation, email-outbox, retention, inventory, profile, live
reservation-conflict, reference-activation, and receipt-rate observations.
Retention work with an expired processing lease is due using the lease deadline;
profile availability is evaluated only for usable inventory. Candidate conflicts
exclude intervals that have ended and `RESERVED` rows whose expiry has passed.
`truncated` indicates more collected warnings than the requested limit;
`coverage.sourceScanLimited` signals that a source hit its bounded scan limit
and additional matching facts may be omitted. The feed has no
acknowledgement or invented severity threshold. It does not expose outbox
payloads, addresses, or contacts. Actively processing email is excluded until
the email runtime defines a durable stale-claim lease; delivery-attempt and historical
reservation-conflict coverage are explicitly unavailable. Legacy inventory
lots without receipt evidence are counted separately, and selected material
rate coverage is unavailable until a CZK commercial policy is selected.
