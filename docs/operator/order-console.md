# Operating orders and measured work

Open **Objednávky a úlohy** in the authenticated, node-scoped admin console.
Filter the order or job lists by status, then open an order. The detail shows
accepted prices and legal references, model and slot evidence, job and parcel
lineage, payments, refunds, settlements, unresolved barriers, and audit history.
Use **Další** controls to page older evidence; the first screen is bounded.
Open a job to see its exact source, estimate, mount readiness, accepted risks,
and artifact availability. Artifact access issues a short-lived audited link;
open it before its shown expiry. An unavailable source or production artifact
is not replaced with another file.

Use only the actions offered for the current order and target. A disabled
action shows its blocking codes. Forms collect the reason, confirmation,
material consumption, parcel identity, or carrier evidence required for the
named command. Packing offers shipments from the job's shipment plan. The
backend checks scope and lifecycle again when a command commits, so a stale
tab can receive a conflict. After a conflict, review the refreshed detail
before deciding whether to submit a new intent.

An uncertain HTTP response retains the exact command content and key in the
current tab. Use **Opakovat stejný požadavek** for that intent, or read the
current server state; do not change its fields or submit another financial
intent merely because the response was lost. The command result alone does
not establish the latest lifecycle state. The console refreshes order and
financial evidence after confirmed writes.

Unresolved compensation, refund incidents, live shipments, and remedy
obligations remain visible even when an order status looks terminal. A
cancelled late-capture payment may read `CAPTURED` while its full refund is
still due. That status does not authorize fulfilment. For provider-result
attestation or a one-time failed refund retry, follow
[refund recovery](refund-recovery.md). A queued refund is not a completed
transfer. Stop when the exact provider outcome is ambiguous.

Start and stop handling timers explicitly; lifecycle buttons do not measure
work. Open timers remain visible after reload. At stop, allocate the measured
duration to the served order, job, item, or shipment. A shared shipping trip
may allocate to multiple orders, with each share entered once. For work
recorded after the fact, use the manual form with a timezone-qualified start
and end; its duration must match the interval. Voiding a completed record
requires an administrator and a reason and preserves the original evidence.

Replacement and incident reprint require a fresh, compatible resource
candidate. If the action is blocked, do not reuse the original candidate or
enter an arbitrary ID; resolve the missing preparation path before acting.
Communications status and resend are delivered in the separate notification
integration phase.
