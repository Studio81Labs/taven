# ADR 0025: Pin automatic preflight classification to issued price snapshots

- **Status:** accepted
- **Date:** 2026-09-23
- **Implementation:** Epic #10 revision 3, escalation #218, PR3c of #183

## Context

The additive v0-2 price-band conversion report partitions issued automatic
bindings by preflight class. Existing risk decisions are scoped to the current
order configuration and can change or disappear after reconfiguration. Reading
them for every retained `quote.bound` event retrospectively changes historical
cohorts. No complete, trustworthy binding-to-finding history exists for a
legacy backfill.

## Decision

At every genuinely new automatic binding, the successful risk gate returns a
server-derived `{ schemaVersion: 1, classification: "clean" | "warning" }`
summary from its same pass over current findings and matching configuration
decisions. The binding transaction puts the summary at
`PriceSnapshot.inputSnapshot.automaticQuote.preflightAtIssuance` before
computing `snapshotHash`. Zero WARNING findings, including INFO-only findings,
are clean. One or more permitted acknowledged WARNING findings are warning.
The existing fit-sensitive, BLOCKING, DECLINED, missing-acknowledgement,
three-warning maximum and reference-readiness gates remain authoritative.

The snapshot, binding, active pointer and deduplicated `quote.bound` event
commit atomically. The event remains the source of issuance identity and time;
its exact binding's immutable snapshot supplies gross and preflight class.
Replay or reuse never repairs or refreshes the stored summary. This extends
ADR 0023's binding commitment boundary without changing its lock order.

The v0-2 reader accepts only the supported version and class. Absent, null,
malformed or unsupported evidence is unknown, as are legacy automatic bindings
and all individual offers. Unknown preflight remains in total/origin and known
gross-band denominators; unavailable gross is a separate dimension. The v0-1
preflight algorithm and every existing v0-1 field remain unchanged and continue
to reflect current order-scoped decisions.

## Consequences

No new table, column, SQL migration, event version, request field or historical
rewrite is needed. PostgreSQL's existing snapshot protection prevents updates
or deletion of the stored summary, and the snapshot hash covers it. Deploy the
reader and producer together; bindings written by an older writer during
overlap or rollback report unknown instead of gaining a guessed class. The
summary contains no raw findings or customer acknowledgements and does not
replace risk, consent or legal evidence.
