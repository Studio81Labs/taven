# ADR 0029: Prepare fresh candidates for exact recovery scopes

- **Status:** accepted; implementation and validation required
- **Date:** 2026-09-25
- **Authority:** escalation #259, Epic #10 revision 9, orchestration #186
- **Implementation:** #262 / P6b-P before #34/P6b PR #260 merges
- **Inspected baseline:** main `bd30e6bc`; UI checkpoint `c3ee474d`
- **Related:** ADR0003 transaction boundaries, ADR0024 resource admission

## Evidence and decision

OrdersService exposes replacement and whole-LOST-parcel reprint commands which
require new candidates, but no protected producer/read supplies those candidates.
AutomaticQuotesService.dispatchOrderCandidates enumerates whole shipment-item
quantities from initial quote provenance, not the exact source Job partition.
Calling it directly for recovery can select the wrong quantity or reuse a
pre-incident candidate. Existing tests copy candidates directly through Prisma.

There is also an incompatible expiry check. CandidateEstimateService schedules
ordinary work starting at its 30-minute estimate expiry; both recovery commands
reject intervals ending after that expiry. The resource planner and SQL instead
use expiry as the deadline for admission, independently of the work window.

Add asynchronous, authorized **recovery candidate preparation**, with durable
source/dispatch provenance and typed scoped reads. Reuse worker-v2, trusted
snapshot materialization, CandidateEstimateService ingestion and resource rules.
Keep preparation advisory and separate from the existing atomic replacement
commands. Cover failed/QC-rejected Jobs and the existing whole-parcel LOST claim
topology, including a subsequent LOST remedy predecessor. No new quality-claim,
mixed-remedy, routing, payment or reproduction-artifact subsystem is introduced.

Correct both recovery command checks: candidate expiry limits the reservation
decision, not printing completion. Preserve all other fresh admission checks.

## HTTP contract and operator workflow

All paths below are under `/admin/orders/:orderId/fulfilment`:

| Collection                             | POST input                                  | Mutation permission |
| -------------------------------------- | ------------------------------------------- | ------------------- |
| `jobs/:jobId/replacement-preparations` | `{ expectedReplacementRequestId, reason }`  | OPERATIONS_WRITE    |
| `claims/:claimId/reprint-preparations` | `{ expectedPredecessorShipmentId, reason }` | FINANCIAL_EXCEPTION |

The reason is trimmed nonempty text, at most 1000 characters. Expected IDs are
UUIDs returned by current protected reads. The server derives node, scope, source
Jobs, geometry, configuration, quantity, material/color, accepted express policy,
body selection, profiles, machines, inventory and schedule. The browser cannot
submit those physical inputs, arbitrary candidate IDs for preparation, prices,
hashes, object keys, calendar windows or substitute geometry.

Require session, CSRF, node/order scope and Idempotency-Key. Check authorization
and every parent/nested scope before completed replay. Each POST returns a typed
202 RecoveryCandidatePreparationAcceptedDto with preparationId, kind, orderId,
targetId, generation, requestedAt and relative statusPath. The saved response is
an acknowledgement of staged work, never a reservation or replacement success.

For each collection expose:

- GET collection: newest first, bounded history, recovering the current attempt
  after reload without a browser-stored command or token.
- GET `:preparationId`: identity, exact sourceJobIds and slot counts, target
  request/predecessor, current generation, progress counts, per-source readiness,
  blocking codes, current eligibility and next refresh time.
- GET `:preparationId/candidates`: filter by sourceJobId, bounded cursor pages;
  return candidateResourceEstimateId, sourceJobId, safe machine/profile/calibration,
  inventory/material/color and frozen config identities, quantity/partsPerPlate,
  decimal-string material/time estimates, future intervals, calculatedAt,
  expiresAt, selectable and blockingCodes. Pending/failed work is summarized in
  detail from durable dispatch/terminal/dead-letter evidence, not raw payloads.

GET requires OPERATIONS_READ and existing order/node visibility; financial
mutation permission is never inferred from read visibility. Use the repository's
opaque scope/filter-bound cursor, default 50 and maximum 100 rows. No GET queues
work. DTOs are generated; dynamic result JSON is not a replacement for documented
contracts. Dates are timezone-qualified, text escaped, and no storage URL/token,
private dispatch input or raw worker stderr is exposed.

Project progress as PREPARING, CANDIDATES_AVAILABLE, BLOCKED, EXPIRED or
SUPERSEDED; this is derived read state, not a new persisted Job/Claim lifecycle.
Expose candidate coverage per source Job. CANDIDATES_AVAILABLE does not assert
that arbitrary choices form a feasible whole-parcel reservation. The UI selects
one displayed eligible candidate per required source Job, shows its schedule and
resource choice, then confirms the existing mutation. Missing coverage blocks
claim submission. Refresh after commit/replay/conflict; preserve the same key and
body while a command outcome is uncertain.

Use existing error semantics: 400 malformed, 401 no session, 403 permission/CSRF,
404 missing or foreign scope, 409 stale context/ineligible/conflicting intent,
410 deleted/expired required source, 429 established rate limit, 503 unavailable
snapshot/storage/queue prerequisite. Worker outages after durable staging remain
visible progress/failure; do not turn acknowledged work into a false HTTP failure.

## Eligibility and frozen inputs

Job preparation requires a current FAILED/QC_REJECTED leaf, its exact OPEN
ReplacementRequest, database time before deadlineAt, and the unchanged source
plan/slot partition. It neither creates a request nor extends its deadline.
Expired requests retain the existing explicit expiry/refund recovery command.

Claim preparation shares createClaimReprint's eligibility: SHIPPED order,
SHIPMENT_INCIDENT claim in its permitted OPEN/ACTIVE state, exact current LOST
predecessor, no successor or claim financial work, all unresolved claim slots
covering the whole parcel, and all current source Jobs in the predecessor lineage
with the required handed-over/settled status. Resolve the complete source Job set
server-side. Do not use claim.openedAt alone to identify repeated LOST episodes;
pin the expected current predecessor Shipment and its selected incident evidence.
Preparation changes no claim resolution, slot ownership, Shipment or Job.

For each source Job derive geometry/config/quantity from its immutable plan job
and candidate, and exact sorted slots from plan membership. Prove the accepted
OrderItem and origin selection: automatic source selection must agree with the
accepted item and retained exact dispatch/selection evidence; individual source
must follow IndividualOrderItemSource to the accepted QuoteItem/model selection.
Require unambiguous matching body IDs, selection hash, source content hash and
geometry hash. Never choose the latest mutable draft or another same-hash model
as authority. If trustworthy provenance is missing, expose a blocker and
escalate repair; do not synthesize a historical selection.

Reuse the established profile/reference compatibility, geometry fit, quality,
material/color, installed nozzle, active same-node machine/calibration, receipt,
mount/express and availability eligibility, and candidatePlateCapacities rules.
New machine-specific profiles/calibrations and a different compatible machine
are allowed. Preserve the accepted PrintConfigRevision and source Job quantity
and slot partition; do not split/merge source Jobs or reprice the order. A failed
Job containing only part of a shipment item must not regenerate the whole item.

Extract only the reusable frozen-input builder/enumerator from current quote
code. Do not call the whole initial quote/payment resource preparation flow or
create an automatic session for an individual order. New generation/source/
resource identities produce distinct dispatch Job IDs and candidate estimate
keys. Identical physical occupancy metrics may use existing validated worker
caches; resource observation, capacity, expiry and provenance are always fresh.
Never clone the old candidate or alter its calculatedAt/expiresAt.

Retained canonical/source bytes and exact hashes must remain available under the
existing ACTIVE_ORDER/ACTIVE_CLAIM/legal hold or through the production horizon.
Check again at final reservation and production dispatch. A deleted source or
missing trusted selection fails closed. This active-order/LOST scope does not
authorize resurrection, new retention policy or the future post-delivery
ReproductionArtifact subsystem.

## Persistence and dispatch transaction

Add two narrow relations, with forward Prisma SQL and no backfill:

1. RecoveryCandidatePreparation: UUID, node/order/phase/shipment-plan scope,
   kind JOB_REPLACEMENT or LOST_CLAIM_REPRINT, exact sourceJobId and
   replacementRequestId for the first kind, or claimId and predecessorShipmentId
   for the second; selected incident evidence identity where applicable;
   monotonic generation within that logical context, immutable source-scope/input
   fingerprint, requestedAt from database time, operator/session attribution,
   reason and audit linkage. Conditional shape checks and scoped Restrict FKs
   must prove that every identity belongs to the same recovery aggregate.
2. RecoveryCandidateDispatch: preparationId, sourceJobId, frozen source/slot
   fingerprint, dispatch Job ID and exact outboxMessageId, with unique outbox
   ownership and scoped composite FKs. The outbox already holds immutable worker
   input; do not duplicate it into a second editable payload or candidate table.

Preparation generation and associations are append-only. Index bounded history
by context/generation and mappings by preparation/source/outbox. Candidate
identity resolves through the existing successful CandidateEstimateTerminalResult
for that dispatch; no client can attach an arbitrary candidate. New-insert SQL
guards validate mapping/input identity and immutable context. A deferred guard
on fresh replacement Job creation verifies the completed request/claim lineage,
plan candidate and exact preparation provenance after the existing transaction
has created all required rows. Do not impose new freshness/provenance validation
on later updates to historical Jobs or require retroactive mappings.

Use a new preparation command namespace/fingerprint. Exact completed replay
returns the original 202 even after expiry/supersession, following scope checks;
the GET reports current facts. Changed input with the same key conflicts.
Under the parent Order lock, allocate a unique next generation. A different-key
refresh supersedes prior generations for new consumption without deleting them.
Concurrent duplicate fresh intents cannot both become the current generation.

Limit one in-progress generation per context. While its durable work is pending,
a different key returns 409 PREPARATION_IN_PROGRESS. An explicit refresh may
supersede it after 30 minutes without terminal progress, or after terminal work;
the response exposes the actual retry time. This is a liveness bound, not a
change to the replacement deadline or candidate TTL. Late old results stay
nonselectable. Cap the enumerated dispatch set at 256 per preparation; overflow
fails atomically with RECOVERY_PREPARATION_LIMIT, never silent truncation. This
v0 work bound can be revisited explicitly if an actual supported scope exceeds
it. No timer automatically chooses a remedy or creates a fresh generation.

Before the database transaction, resolve/build immutable inputs and perform
trusted profile snapshot materialization through the existing service. No
storage/Redis/Orca call is held under resource locks. Revalidate the captured
context and resource identities under locks, then atomically persist preparation,
all dispatch mappings/outbox messages, audit and idempotent acknowledgement.
Extract a transaction-aware staging part of CandidateEstimateService.dispatch;
do not invoke its independently committing transaction from the parent command.
Declare all rank-0 dispatch/command fences before business/resource locks. A
failed preflight/revalidation leaves no successful command or partial dispatch.

Queue publication, worker retry policy, v2 validation, authenticated result
ingestion, artifact checksums and existing terminal/dead-letter dedupe remain.
No producer/consumer message schema change is required: recovery authorization
is the backend relation, not a browser or worker assertion. Ingestion may retain
an otherwise valid late candidate as historical evidence, but reads/consumption
must reject superseded or resolved context. Worker completion never commits a
replacement, extends a deadline or reserves resources. Cached/late output cannot
revive deleted/invalid sources or current resource ineligibility.

## Consumption, scheduling and locks

Keep existing createReplacement and createClaimReprint DTOs, namespaces and old
completed replay shapes. For a fresh invocation, selected candidate must join
to the latest preparation of this exact request or claim/predecessor, the exact
source Job/slot fingerprint and a successful persisted dispatch/receipt. For a
claim all selected candidates belong to the same preparation and cover every
source Job once, with no duplicate candidate, foreign source or previous episode.
This intentionally tightens fresh admission; it preserves old completed effects.

Correct the two endsAt-versus-expiresAt checks. At post-lock database time:

- candidate must differ from source and be calculated after the current recovery
  context/preparation, not merely an older claim creation;
- min(candidate.expiresAt, now + 30 minutes) must be strictly later than
  now + 15 minutes, preserving the existing reservation horizon;
- every interval must start in the future, have sufficient positive duration,
  fit current selected availability and not conflict with committed work;
- source retention/hold must cover the scheduled production horizon;
- frozen scope, active compatible resources, selected availability version,
  inventory receipt/mount and aggregate remaining mass must still pass.

Interval end may exceed candidate expiry. Do not lengthen expiry to print end,
shorten work, or bypass admission checks. Existing HELD reservations do not
become invalid when the advisory candidate later expires.

Reuse the existing scheduler's occupied-work plus unexpired same-phase candidate
interval union so sibling work on one machine is scheduled without overlap.
Preparation creates no capacity/inventory reservation; competing orders can
still win before consumption. Do not remove existing same-phase serialization
or promise a reservation from candidate visibility.

Final replacement/reprint remains one atomic transaction, using existing complete
plan/reservation/HELD conversion and lineage rules. Predeclare the union of all
required order/session, phases, slots, claim/resolutions, source Jobs/Shipments,
candidate, profile, machine, calibration, inventory and interval targets in
ADR0003 order. Preparation rows are immutable and generation selection is
serialized by the existing business lock; no new lock rank is required. Do not
lock a Claim before its lower-ranked slots, or reserve the first reprint Job and
then acquire a lower-ranked resource for the second. Prelock all shared targets
canonically before per-job helpers; use the final locked facts for budget and
freshness decisions. Acquire any required financial targets in their established
position, not after resource locks. SQL helper calls must use the same envelope.

Refund/expiry/delivery/refresh/consumption races have one valid winner. Any stale
candidate, inadequate aggregate stock or conflicting interval rolls back all
Jobs, successor Shipment, request/resolution updates and reservations. Do not
commit a partial parcel or auto-switch financial remedies. Customer prices,
captured payments, legal acceptance, recovery deadlines and refund rules stay
unchanged; preparation writes no quote/paid-conversion business event.

## Validation, rollout and handoff

#262 owns one backend/resource/API/generated/forward-migration/test/runbook PR.
Then rebase #260 and implement typed progress, candidate selection and separate
confirmation of existing commands. PREPARE_REPLACEMENT becomes executable when
eligible; add corresponding permitted claim preparation and concrete blockers.
Keep financial permissions and current server checks authoritative. #185 adds
connected browser proof; #34 still awaits #39 communication before closure.

Required evidence includes automatic and individual real-command journeys;
failed/QC-rejected Jobs and multi-Job LOST/repeated-LOST lineage; same-machine
candidate scheduling/shared stock; default TTL with production ending later;
strict 15-minute boundary, expiry/past intervals/retention failures; replay and
two-key refresh races; partial coverage, worker outage/dead-letter, duplicate/
out-of-order/late results; wrong context/source/node/candidate; direct SQL
provenance rejection; cancellation/refund/delivery/availability/stock contention;
all-or-none reservation and no lock-order inversion. Prove unchanged price/legal
history and production dispatch from the new reservation. SQL-cloned candidates
or manually marked GCODE_READY are not sole end-to-end evidence.

Run fresh/populated migrations, backend/core and generated contract checks,
relevant lint/typecheck/build/format, existing initial preparation/production
regressions and secure real worker integration. Parent-observed commands and
independent review precede merge. #260 owns component/browser consumers and #185
the final connected proof. Planning runs documentation checks only.

Rollout drains affected backend preparation/replacement writers, applies forward
schema/guards, deploys compatible backend and validates before enabling UI.
Worker-v2 remains compatible. Do not backfill provenance, redispatch old work or
rewrite historical rows. Disable new recovery commands and roll forward if a
rollback would lose provenance enforcement. No deployment is performed here.

SERIAL/max1 is unchanged: #262/P6b-P then #34/P6b PR #260, then the existing
#252/P7a, #39/P7b, #35/P8, #185/P9 sequence. Independent UI work may continue but
cannot claim replacement or #34 completion before the producer and consumer pass.

## Alternatives and escalation

Rejected: old-candidate reuse/timestamp editing (false resource evidence), whole
quote dispatch (wrong partition/no incident provenance), inline slicing inside
replacement (long external work under locks), browser UUID entry (no producer),
and copying original machine estimates to a different machine (untrusted inputs).
A new scheduler, generic workflow engine or worker-v3 is unnecessary.

Routine implementation structure may be resolved locally. Missing authentic
source provenance, unsupported mixed/post-delivery remedy topology, need for
new retained reproduction bytes, actual fan-out beyond the v0 bound, worker
contract changes, changed financial/product invariants or inability to preserve
the full lock protocol require architectural escalation. No unresolved design
question blocks the described existing v0 paths; readiness is not runtime proof.
