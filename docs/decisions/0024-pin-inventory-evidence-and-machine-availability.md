# ADR 0024: Pin inventory evidence and machine availability at resource admission

- **Status:** accepted
- **Date:** 2026-09-23
- **Implementation:** Epic #10 revision 2, PR3b of #183

## Context

The v0 resource model tracks per-machine inventory counters and occupied capacity, but it does not establish purchase receipt, physical mount, or operator availability windows. Inferring those facts from an `AVAILABLE` status or reservation gaps would admit work on unsupported evidence. Existing accepted reservations must remain fulfillable during the transition.

## Decision

Receiving stock creates a new Inventory lot and one immutable initial receipt with vendor, purchase instant, original mass, currency, and rational unit rate. A correction appends a receipt that supersedes the prior one with a reason. New inventory reservations pin the current receipt identity, so later corrections do not rewrite consumed cost evidence. Legacy lots have unknown receipt coverage and are excluded from fresh admission until an operator records attested original purchase evidence; the attested mass must cover the current balance. Earlier consumed reservations retain unknown cost evidence. The mounted state is independent of remaining and reserved grams; a scoped, audited mount command changes it. Express admission requires mounted stock. Standard reservations may be held while unmounted, and printing requires mount readiness. Unmounting material in an active print is rejected under the inventory lock.

An operator publishes immutable machine availability revisions containing nonoverlapping half-open UTC intervals. A selection row carries the current revision and monotonic version. Publication uses expected-version compare-and-swap and the machine row lock. It rejects revisions that exclude any live capacity reservation. Fresh candidate scheduling fits each whole plate into the earliest selected interval after subtracting occupied capacity. Candidates pin the selection revision and version. Eligibility and fresh reservation commits reject stale identities and intervals. The reservation SQL function locks its complete machine set in canonical resource order; the capacity insert guard takes the same lock and checks the selected window. Existing coarse machine status still closes new admission.

The forward migration leaves legacy stock receipt and mount state unknown. Machines with live reservations receive a sentinel revision whose windows cover only those exact live intervals. The sentinel permits legacy fulfillment and capture but cannot admit new candidates or capacity. Other machines remain unconfigured. An operator publishes a deliberate revision covering live reservations before new work can be admitted. Existing committed price bindings and reservations retain their identities and costs; policy publication does not rewrite them.

## Consequences

Operators must record purchase evidence, mount material, and publish availability before affected new work can be admitted. Reads expose receipt coverage, mount state, selected windows, and occupied intervals separately. Availability changes may fail with scoped live reservation IDs, which an operator resolves through existing cancellation or replacement paths. Drain old resource writers before enabling new admissions, as required by Epic #10's rollout order.
