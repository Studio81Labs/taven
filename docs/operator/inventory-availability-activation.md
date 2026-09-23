# Inventory and machine availability activation

Epic #10 PR3b introduces receipt, mount, and availability evidence for new resource admission. Deploy the compatible backend and migration while affected new resource and payment admissions are stopped. Drain older resource writers before enabling the new path. Existing accepted orders and reservations remain readable; do not invent historical purchase or mount evidence.

## Legacy state after migration

- Existing Inventory rows have `mountStatus: UNKNOWN` and `receiptCoverage: UNKNOWN`. Existing inventory reservations keep a null `receiptId`; new reservations require a real receipt.
- A machine with live capacity receives a `LEGACY_LIVE_RESERVATION_BOOTSTRAP` revision covering each live interval. It preserves those reservations but cannot admit new candidates. A machine without live work has no selected revision.
- The availability read returns selected windows and occupied intervals separately. Check the occupied intervals before replacing a revision. Publication that excludes a live interval returns 409 with scoped `conflictReservationIds`.

## Operator setup

1. For a new purchased lot, call `POST /admin/nodes/{nodeId}/inventory-receipts` with the machine, SKU, material/color, vendor, rational purchase rate, currency, received mass, and an ISO purchase instant with explicit offset. This creates one new lot and its initial immutable receipt. Do not add a second purchase to an existing lot through quantity adjustment. If a legacy lot has a verifiable original purchase document, call `POST /admin/nodes/{nodeId}/inventories/{inventoryId}/initial-receipt` with attested mass (at least the current balance), rate, purchase instant, and reason; previous consumed reservations remain without cost evidence. A factual correction uses `POST /admin/nodes/{nodeId}/inventories/{inventoryId}/receipt-corrections` with the current receipt ID and reason; previous evidence stays immutable.
2. Physically load the lot, then call `POST /admin/nodes/{nodeId}/inventories/{inventoryId}/mount` with `mountStatus: MOUNTED` and a reason. Mounting never changes inventory counters or reservation ownership. A held standard job can remain unmounted, but must be mounted before printing. An active print prevents unmount.
3. Read `GET /admin/nodes/{nodeId}/machines/{machineId}/availability?from=<instant>&to=<instant>` with a bounded range. Publish `POST /admin/nodes/{nodeId}/machines/{machineId}/availability` with `expectedVersion` (null when unconfigured), reason, and up to 1000 nonoverlapping absolute `[startsAt, endsAt)` windows within the 366-day horizon. Include every occupied live interval. An empty list pauses new admission only when no live interval would be excluded. Convert local Prague times to explicit-offset instants before sending; no recurrence or daylight-saving guess is stored.
4. Verify the selected revision/version, inventory receipt coverage and mount status, and a fresh candidate/hold flow before reopening admissions. New candidates pin the selected availability identity. A later publication causes a fresh estimate and plan; it does not rewrite an already committed binding or reservation.

The commands require an operator session, node grant, CSRF header, `Idempotency-Key`, and catalog write permission. Reads require operations read permission. Roll back an application deploy by disabling new admissions and rolling forward with compatible readers/writers; do not reverse the evidence migration or delete accepted history.
