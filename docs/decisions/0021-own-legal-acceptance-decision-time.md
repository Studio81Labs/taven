# ADR 0021: Own legal acceptance decision time in PostgreSQL

- **Status:** accepted architecture; implementation required in #152 / PR #158
- **Decision:** [escalation #159](https://github.com/Studio81Labs/taven/issues/159)
- **Amends:** ADR 0020 acceptance provenance and the individual acceptance clock;
  preserves ADR 0003 lock order and ADR 0004 database enforcement
- **Inspected baseline:** PR #158 `1ccc427`

## Context

LegalAcceptance currently validates publication eligibility at a supplied
acceptedAt. QuoteRequest.createdAt and automatic Order withdrawal timestamps
are supplied too; equating them would still allow a writer to forge both.
Individual QuoteRequest.acceptedAt is already stamped by PostgreSQL, but its
statement timestamp is a different source and does not prevent later ledger
insertion. Existing deferred checks prove completeness, not time provenance.
The current legacy photo-augmentation branches also permit new evidence after
first acceptance, contrary to the frozen retry contract.

## Decision

Use one narrow append-only LegalAcceptanceDecision per first acceptance subject.
It owns a single server-generated instant and the transaction that created it.
All eligibility checks, subject timestamps and ledger rows for that decision
must agree. A database-generated instant is not proof of customer action by
itself: the existing capability, explicit acknowledgements and business guards
remain mandatory.

### Persistence and insertion boundary

Add legal_acceptance_decisions with UUID id, exactly one nullable unique Order
or QuoteRequest FK, nullable unique sourceQuoteId FK, nonblank commandIdentity
with the existing command-key bound, decidedAt timestamptz(3), and originatingXid
stored as the decimal text of pg_current_xact_id(). SourceQuoteId is required
for individual Order decisions, forbidden for automatic Order and request-creation
decisions, and must resolve to the exact IndividualOrderOrigin at commit. All
FKs retain evidence with RESTRICT deletion. The subject FK may be initially
deferred so the command can preallocate a new subject UUID. SourceQuote already
exists. Do not expose this table or its transaction identifier over HTTP.

Add decisionId to LegalAcceptance. Every new ledger INSERT requires it; its
subject, command identity and acceptedAt must equal the decision, and the
decision's originatingXid must equal the current transaction ID. Enforce this
in PostgreSQL, not only Prisma. Historical retained rows without a decision
remain explicitly legacy/unverified and are never silently upgraded. New
inserts cannot use that legacy exception.

The decision INSERT trigger overwrites any supplied decidedAt and originatingXid
with database values after its locking/eligibility checks. Use one millisecond
clock_timestamp value and the stored INSERT RETURNING value everywhere; never
sample a clock per purpose. Reject UPDATE/DELETE of decisions and ledger rows.
Do not use user-settable session flags, xmin, caller timestamps, or a tolerance
window as evidence. PostgreSQL's [clock functions](https://www.postgresql.org/docs/18/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)
and [transaction ID functions](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-PG-SNAPSHOT)
provide the required time and originating-transaction identity.

A request-creation decision requires a not-yet-existing request ID. An automatic
Order decision requires an existing automatic Order with no prior acceptance,
photo grant or payment attempt. An individual decision requires a new Order ID
and the exact current Quote on an unaccepted QUOTED request. Expiry is
validated at the returned decision instant before any acceptance transition. Reject
partial accepted evidence and accepted legacy subjects; do not repair them by
starting a new decision. Check these entry facts and reconcile source kind,
subject, source Quote and complete acceptance again at deferred commit.

Install deferred constraints on the decision itself as well as the subject and
ledger. A decision cannot commit without the subject and its complete required
ledger/scalar bundle, and a fresh acceptance cannot commit without its decision.
Otherwise a bare decision could permanently consume the unique subject slot.
All purposes for a subject share its one decision; optional photo absence stays
absence. A later transaction cannot attach a missing purpose or manufacture a
new grant against an old decision.

### Command and locking protocol

Preserve replay lookup before fresh eligibility. Fresh execution acquires
idempotency, then the full legal document set in canonical key order, then
existing subject/source-request and other business locks required by the command.
For request creation the legal set is privacy + photoConsent; for either Order
flow it is claims + photoConsent + terms, even when photo consent is false.
This fixed set avoids a late lower-ranked acquisition for an optional purpose.

Insert the decision only at the final acceptance stage after those locks. Its
trigger defensively verifies/acquires the same legal locks FOR SHARE NOWAIT,
then existing source-request/Order locks FOR UPDATE NOWAIT, before stamping.
A missing document or conflicting unordered writer fails, never skips validation
or waits on a lower-ranked parent. Supported direct SQL uses the same explicit
prelock protocol as the APIs. New subject UUIDs are protected by unique decision
subject keys and deferred subject ownership/completeness checks. Retain the
existing bounded legal conflict handling; identify guard conflicts specifically.

Read legal publications with readAt(transaction, decision.decidedAt), validate
exact presented revisions and all relevant business deadlines at that instant,
then persist the subject and ledger with it. Earlier lockAndRead/preflight values
may inform presentation but cannot authorize the commit. Do not pass a caller
clock into decision creation. Keep the decision and all effects in one transaction;
a failed policy check rolls it back. No network work occurs under these locks.

| Flow                                          | Fields required to equal decision.decidedAt                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Assisted request / automatic handoff creation | New QuoteRequest.createdAt, privacy ledger acceptedAt, optional request photo-grant scalar and ledger                                                                                                                    |
| First automatic checkout acceptance           | Order.withdrawalExceptionAcknowledgedAt, terms/claims ledger acceptedAt, optional Order photo-grant scalar and ledger; existing Order.createdAt remains unchanged                                                        |
| Individual offer acceptance                   | Source QuoteRequest.acceptedAt, new Order.createdAt and withdrawal acknowledgement, terms/claims ledger acceptedAt; optional Order photo evidence only if an independently authorized existing flow actually captures it |

For individual conversion, replace the current independent statement_timestamp
assignment with the matching current-transaction Order decision selected by its
unique sourceQuoteId. Amend acceptLockedQuoteRequest and its SQL guards to take
and validate exact Quote/decision identity, not an arbitrary time or ANY live
quote. Verify expiry at the same decidedAt before the transition. The request
acceptance-time trigger derives NEW.accepted_at from that decision; it cannot
accept a client timestamp. Deferred checks require the decision's Order origin
to name that Quote. Initial conversion remains DRAFT as currently designed;
this change does not jump the Order into a paid/confirmed state.

An expired individual attempt must not commit an empty decision. Use a command-local
savepoint around the candidate decision insertion. Compare Quote.expiresAt with
the returned decidedAt; on expiry (including equality), roll back to that savepoint
before performing the existing expiry transition/response at that evaluation
instant. The canonical locks were acquired before the savepoint and remain held.
No deletion of a committed decision is authorized. A fresh direct writer must
also satisfy the expiry/current-Quote checks in the request transition and deferred
origin validation; an expired candidate cannot commit an accepted bundle.

### Compatibility, import and retry policy

Accepted legacy records retain their real scalars/snapshots and settle through
the existing legacy branch. No decision or ledger backfill is inferred from
createdAt, an old code, an imported timestamp or a legacy-import string. Fresh
acceptance of unaccepted legacy offers must reissue under ADR 0022 first.

Completed replay, eligible payment retries, capture, balance, refunds and
fulfilment read frozen evidence; they do not create decisions/ledger rows and
do not compare the old originatingXid with the new transaction. Remove the PR's
later legacy photo-augmentation paths. Retry never adds or changes a permission,
acknowledgement or timestamp. A future post-order consent workflow is separate
scope, not an import/repair exception.

Normal maintenance/import may execute a fresh acceptance only through this
same current-time contract and with actual authorized input. No online historical
acceptance import is introduced. Authentic offline database restore preserves
existing decisions, rows and references as a unit; it is not a runtime bypass
flag. Missing historical evidence remains missing. If actual data requires
repair, pause that data's cutover and escalate with its authentic source evidence.
Privileged trigger disabling or fabricated backups are outside the established
PostgreSQL trust boundary.

### Validation and delivery

Keep this in #152 / PR5b / PR #158, before merge. Add the decision migration,
Prisma relations, all three producer changes, SQL/ledger/deferred checks and
fixtures together. Amend an unmerged migration only for disposable databases;
otherwise append a forward migration without rewriting checksums or evidence.
Drain old writers and retain the existing admission-disabled cutover protocol.

Require real PostgreSQL tests for forged ledger time, forging both subject and
ledger time, caller-supplied decision time/xid, later-transaction ledger insertion,
wrong subject/Quote/command, empty/incomplete decisions, duplicate decisions,
mutation/deletion, rollback/replay and optional-photo absence. Cover all three
flows and equality of all copied instants. Test lock waits and scheduled legal
boundaries, expiry equality, archive/publication races, direct SQL under canonical
locks, unordered guard rejection, accepted legacy settlement and unchanged
failed-payment retries. No fresh legacy-marker bypass or late photo augmentation.
Use isolated approved fixtures, never production approval seeds. Implementation
must execute relevant backend/core/DB/e2e and consumer checks, generated/format/
boundary checks and independent review; this ADR claims no implementation pass.

## Alternatives

Timestamp equality alone accepts jointly forged values. Per-ledger DB clocks
split one decision across instants. Stamping three different existing subject
fields reduces schema additions but leaves branch-sensitive provenance and
late-insertion checks. A single decision record adds bounded persistence while
making time ownership and atomic origin explicit. Historical-import exception
flags and external signing infrastructure are outside the required repair.
