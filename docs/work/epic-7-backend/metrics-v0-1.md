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
  order.
- Order value, express share, and price bands use immutable accepted pricing.
  Current contract amounts, captured cash, and successful refunds remain
  separate.
- Automation is counted once per model file, with successful, persisted
  assisted-handoff, unresolved, and unavailable evidence called out separately.
- Actual-cost reports use leaf (not superseded) costs and completed,
  non-voided handling allocations. Final contribution margin stays null unless
  the order has terminal settlement evidence, no unresolved refund, explicit
  zero-or-measured coverage for every v0 cost category, and completed handling
  allocation evidence.
- CAC includes only leaf acquisition spend wholly inside the interval. Repeat
  status uses the historical first confirmed order for the customer.
- FPY considers original jobs only. Queue time comes from unconsumed planned or
  active machine capacity intervals, never measured labour time.
- Assisted SLA uses persisted request/offer timestamps against the database
  clock. Operational monthly turnover uses Europe/Prague months and keeps
  confirmed value, captured cash, successful refunds, and net receipts apart.

Raw client observations are intentionally not backfilled. The report therefore
signals coverage uncertainty instead of inventing historical funnel facts.
