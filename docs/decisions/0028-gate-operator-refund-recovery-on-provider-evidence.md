# ADR 0028: Gate operator refund recovery on final provider evidence

- **Status:** accepted; implementation and validation required
- **Date:** 2026-09-24
- **Authority:** escalations #254/#258, Epic #10 revision 8, orchestration #186
- **Implementation:** #256 / P6a-R, between #34/P6a (PR #255) and P6b
- **Inspected baseline:** main `8aa1839a`, P6a operational-contracts worktree
- **Refines:** ADR 0003 refund retry/late-receipt execution, ADR 0007 payment port

## Evidence and decision

The Epic assumed refund retry was an existing command. OrdersController exposes
initial claim/adjustment refunds, but no retry or provider-result reconciliation.
OrdersService refuses to recreate an adjustment's persisted refund work. The
dispatcher only sends pending attempts; an outbox delivery failure does not
create a failed refund receipt. RefundTransaction already records retry lineage,
exact failure evidence, one-time dispatch claims and late-success reconciliation.
Existing database tests construct the missing application flow with SQL.

Comgate explicitly allows multiple refunds with the same `refId`. Its adapter
correctly selects MANUAL_RECONCILIATION and will not repeat a claimed ambiguous
request. A timeout, process crash or outbox FAILED is not proof that money did
not move. Preserve this boundary.

Provide two separate financial commands: **record final provider evidence**, then
**request a replacement for a proven failed refund**. Recording a result does
not initiate a transfer; retry does not invent a provider result. The existing
FINANCIAL_EXCEPTION permission (currently ADMIN), session/CSRF guards and exact
operational node scope apply to both. No additional role or two-person policy
is introduced for the sole-operator v0.

V0 permits **one replacement per root refund obligation**, not recursive retries
or parallel siblings. SQL permits A -> B -> C, but its late-success protocol
only reconciles an immediate child: C cannot reference A's success through its
source-event composite FK. A late success of A can either violate the captured
amount guard or double-commit a smaller partial refund alongside C. Do not expose
that unsupported topology. A failed replacement remains a visible incident;
further transfer/recovery requires a specific escalation, not another button.

## HTTP and evidence contracts

Both routes use the existing controller prefix
`/admin/orders/:orderId/fulfilment`, required Idempotency-Key and normal typed
200 FulfilmentCommandResultDto response. Document explicit result payloads in
OpenAPI. No provider call occurs in either command's database transaction.

### Record a provider result

`POST refunds/:refundId/provider-results` accepts:

- `outcome`: SUCCEEDED or FAILED, always a **final** provider outcome;
- `expectedStatus` and nullable `expectedProviderResultEventId`, copied from
  the latest authorized read;
- `providerIntentId` and `requestReference`, matching the persisted capture
  intent and this refund attempt's idempotency key;
- `amountMinor` as the existing positive decimal-integer string and `currency`,
  both required to equal persisted values, never used to set the transfer amount;
- optional `providerRefundReference` (1-255 characters), the actual external
  reference when one exists;
- `evidenceKind`: PROVIDER_PORTAL or PROVIDER_SUPPORT;
- `evidenceReference` (1-255 characters): a stable case/statement/receipt plus
  item reference identifying this exact outcome; not a URL to fetch or raw file;
- `occurredAt`: timezone-qualified provider outcome instant, no later than the
  post-lock database decision time and consistent with attempt/prior receipts;
- `reason` (1-1000 characters) and `finalOutcomeConfirmed: true`.

The financial operator must verify the provider account/environment, capture,
attempt, amount/currency and final outcome in the authenticated provider portal
or a provider support response. FAILED means that exact attempt definitively
did not and will not transfer funds. A missing portal row, pending status,
transport error, generic API rejection or an operator's belief is insufficient.
A provider support confirmation of definitive non-execution must identify the
exact request; absence alone is not that confirmation. If identity/finality or
the actual outcome time cannot be established, leave the incident unresolved.

This is an explicit **operator attestation trust boundary**, similar to existing
manual carrier evidence, with the stronger financial permission. The server
does not pretend it queried the provider. Store immutable evidence with
`source: operator-provider-reconciliation`, evidence kind/reference, canonical
request/intent/refund identity, reported external reference, operator/session
attribution and database recording time. Link the resulting receipt ID in the
same-transaction operator audit. Provider API evidence keeps its distinct
existing source. Authentication/verification timestamps for manual evidence are
server-owned operator verification times, never claims of webhook/API verification
or fields supplied by the browser. Public reads label the verification source.

Canonical provider refund identity is server-resolved: preserve an existing
providerRefundId; otherwise use the actual identifier supported by that adapter.
For Comgate's documented no-refund-ID response, preserve the adapter's existing
attempt-idempotency-key correlation convention. Keep an external portal/support
reference in evidence separately; never replace the canonical identity with it
or fabricate an external provider ID. Future conflicting identity evidence is
an incident, not a silent identity rewrite.

Generate a namespaced providerEventId from the canonical provider/account context,
exact request identity, evidence kind/reference, outcome and occurredAt. Do not
let the client submit an arbitrary internal event UUID. The normalized evidence
fingerprint includes all identity/amount/currency/provenance fields; an existing
event identity with different evidence conflicts, including across attempts.
Use the existing provider/event unique fence and immutable payload hash. This
adds typed evidence in existing JSON/audit storage, not a new receipt table.

Fresh manual recording requires a MANUAL_RECONCILIATION provider attempt with
an existing immutable dispatch claim, or a previously failed/suspended attempt
whose exact late receipt is being reconciled. Never authorize a result for an
unclaimed request, create a claim merely to accept evidence, or race an
IDEMPOTENT provider's automatic re-dispatch. Sandbox tests use an isolated
authoritative provider fixture to supply results; production cannot select a
test mode. Completed replay still precedes fresh state/provider checks.

Result: `REFUND_PROVIDER_RESULT_RECORDED`, with refundTransactionId,
providerResultEventId and the committed refund/payment state; an incident result
also includes its explicit blocking code. It cannot report a transfer as newly
performed. A fresh failure cannot reverse a normal completed SUCCEEDED attempt;
that reversal remains outside this operator contract. Exact duplicate result
replays, late source success and existing SUSPENDED reconciliation are supported.

### Request a failed-refund replacement

`POST refunds/:refundId/retry` accepts only
`{ expectedFailureProviderEventId, reason }`. The source must:

1. Be a root attempt in FAILED with this exact selected, verified REFUND_FAILED
   event, matching payment/provider/canonical refund identity/amount/currency.
2. Have no replacement of any status, no later success, no unresolved ambiguous
   or suspended incident on the payment, and no unsupported historical lineage.
3. Still own the original unpaid refund obligation with unchanged claim,
   adjustment, cancellation, recovery, settlement or compensation scope. The
   current provider must match the payment; no provider switch for this retry.
4. Fit the captured balance after all PENDING, SUSPENDED and SUCCEEDED refunds;
   do not count a failed source as a second allocation or allow a new credit.

Create one new PENDING RefundTransaction with exactly copied payment/provider,
amount/reason/claim/adjustment, source ID and failure-event ID, database request
time and a new server-derived provider command key. Preserve the failed row,
its receipt and dispatch claim forever. Do not reset or resend it. Atomically
persist one `refund_payment:v1:<newRefundId>` outbox message using the existing
payload contract, the operator audit and completed command response.

Return `REFUND_RETRY_PENDING` with sourceRefundTransactionId, refundTransactionId,
failureProviderEventId, amountMinor and currency. This is queued work, not a
refund-success response. Same-key replay returns the original result; another
key cannot create a second child. A failed child is blocked by
REFUND_RETRY_LIMIT_REACHED and remains financially unresolved.

## Transactions, receipts and persistence

Authorization/scope precede replay. New operation-specific idempotency namespaces
and canonical fingerprints use the existing fulfilment conventions. Acquire the
complete rank-0 command/receipt fence, automatic-session/order, phases, affected
slots/claims/jobs/shipments when applicable, all relevant refund rows in stable
order, then Payment as the existing SQL envelope does. Declare additional claim
or completion targets before taking rank-8 locks. Recheck scope and facts after
locking. Do not call a helper which first acquires Order after Payment.

Use existing RefundTransaction, PaymentProviderEvent, RefundDispatchClaim,
AuditEvent, IdempotencyRecord and OutboxMessage storage. Add a forward SQL
migration for a shared receipt applicator and the new-insert retry-depth/sibling
guard. Existing migrations/history stay unchanged; no general workflow table,
amount editing or automatic evidence backfill. Root locking must serialize
competing inserts even when the child set is initially empty. Do not retroactively
rewrite old nested chains; detect them and escalate their specific recovery.

The current `taven_apply_checkout_refund_success` only selects SUCCEEDED and
recalculates payment totals; the SQL constraints require more when a retry
exists. Refine or delegate it to a common result applicator used by both the
dispatcher and operator receipt command. It must implement ADR 0003 atomically:

- Normal exact failure selects FAILED and retains its failure receipt, without
  changing the refund obligation. Derive Payment from the complete refund set;
  no unresolved obligation or incident may disappear from completion barriers.
- Late source success with an unclaimed PENDING replacement supersedes that
  replacement and applies the source success, preventing future dispatch.
- With a claimed PENDING or already-successful replacement, retain the source
  success on the replacement, set SUSPENDED, retain any selected retry-success
  receipt, keep the source selected as FAILED and Payment REFUND_PENDING, and
  reopen completion barriers as required by the existing SQL protocol.
- Exact failure of a suspended replacement selects its failure and applies the
  retained source success together. Exact replacement success retains the
  SUSPENDED double-success incident. Do not use the command as a write-off or
  arbitrary incident-clear action. Unsupported contradictory receipts escalate.
- Apply the same rules in either receipt arrival order, including a source
  success after a child has already failed. Deduplicate receipts/audit/business
  observations and preserve the existing refund metric meaning.

The dispatcher retains its one-time durable claim and Comgate ambiguity fence.
Recheck status after claim acquisition; never send FAILED, SUPERSEDED or
SUSPENDED work. Concurrently invalidated/obsolete outbox delivery must settle
without a provider call or endless resend; an unresolved provider incident must
remain visible separately. A claim obtained before source success can already
have an in-flight request: suspend rather than assume it was cancelled.

OrdersService also creates initial ordinary refunds without the compensation
SQL's outbox enqueue. Complete the existing creation-to-dispatch seam for the
operator cancellation/claim/adjustment/recovery paths in the same PR, using the
same atomic dedupe/payload and no new money policy. Do not duplicate already
enqueued compensation messages. Retained pending rows missing dispatch evidence
need a specific audited repair decision, not a migration which silently sends
old money. No automated backfill or provider request occurs during migration.

## UI, scope and validation

P6a/#255 can finish independent reads/evidence/handling. Until #256 merges,
expose an incident or disabled availability, never an enabled nonexistent route.
#256 extends generated read contracts with exact failure/lineage/claim evidence
and source-labelled provider-result summaries. P6b renders separate reconciliation
and retry forms; both require reason/confirmation and refresh after success/replay.
Permission-filtered RETRY_REFUND and RECORD_REFUND_PROVIDER_RESULT entries use
shared eligibility. Show concrete blockers for missing final evidence, an already
created replacement, retry-depth limit, provider mismatch, inadequate remaining
funds and suspended/ambiguous incidents. Read visibility is not mutation authority.

Use existing error conventions: 400 malformed, 401 unauthenticated, 403 permission
or CSRF, 404 missing/foreign scope, 409 stale state/evidence/idempotency or financial
ineligibility. Do not leak raw provider payloads, credentials, statement contents
or fetch user-supplied URLs. Keep evidence references escaped and bounded.

One separate #256 financial contract PR follows #255 and precedes P6b. Include
producer/receipt application/forward SQL/generated consumers/contracts/runbook
and real API/PostgreSQL tests in that boundary. Required cases include two keys
racing; replay with changed inputs; provider success versus retry/dispatch;
source-first and retry-first success; suspended retry failure; incorrect payment,
currency/amount/request/receipt; timeout/ambiguous PENDING; expired command replay;
permission/CSRF/node denial; new direct-SQL nested/sibling rejection; and the
partial-refund A -> B -> C negative case. Exercise actual command -> outbox ->
provider result -> reconciliation -> retry -> result, not SQL-seeded failed state
as the sole evidence. Cover both order origins, payment roles, claim/adjustment,
cancellation/recovery and compensation; preserve settlement/capture-cutoff tests.

#185 owns final browser proof; #39 owns provider operational reconciliation and
live evidence. No public deployment or real transfer is performed by planning.
SERIAL/max1 remains. New unverifiable identity/finality, multi-hop requirements,
double-success remediation, retained-history corruption, or security/persistence
changes beyond this design require escalation. No production tests were run for
this decision; implementation readiness is not financial acceptance.

## Rejected alternatives and sources

Incident-only handling for every failed refund would omit the approved retry
behavior. Blind resending and timeout-to-failure conversion risk a second
transfer. A retry command requiring an event that no application path can record
would remain unusable. General provider statement ingestion, recursive refund
graphs or automatic double-success repair exceed the smallest correct v0 change.

- [Escalation #254](https://github.com/Studio81Labs/taven/issues/254)
- [Comgate Merchant API refund contract](https://apidoc.comgate.cz/en/api/rest/#tag/refund)
- [ADR 0003](0003-core-transaction-boundaries.md)
- [Implementation #256](https://github.com/Studio81Labs/taven/issues/256)

## Null-intent late-capture states — resolution #258 (2026-09-25)

Inspected main `91d6245c`, PR #257 head `f2b95144`, its real cancellation/intent
race regression, the original capture and refund SQL guards, and specification
§3.3. The intent response can arrive after cancellation: `providerIntentId`
legitimately remains null while an authenticated late capture supplies immutable
`providerCaptureId`, amount/time and a full compensation root. The command's
persisted provider transaction locator is not permission to backfill the missing
intent identity.

The common receipt applicator's aggregate calculation is correct for this case.
The same evidence-then-retry contract applies when an intent-bearing late capture
has a prior PAYMENT_FAILED event: the older blanket prohibition on returning
REFUND_PENDING to CAPTURED also conflicts with the explicit two-command recovery.
Replace that prohibition with the exact compensation/failure guards below;
do not force an automatic retry in the evidence-recording command.

| Final refund-set facts                                                  | Payment state    | Outstanding compensation                              |
| ----------------------------------------------------------------------- | ---------------- | ----------------------------------------------------- |
| Root has selected final failure; no active/suspended attempt or success | `CAPTURED`       | Full captured amount; failure receipt retained        |
| One replacement is pending, or a receipt race is suspended              | `REFUND_PENDING` | Unresolved; apply existing one-edge incident rules    |
| Full compensation succeeds, with no active/suspended incident           | `REFUNDED`       | Zero                                                  |
| Replacement definitively fails, with no source success or active work   | `CAPTURED`       | Full amount; retry limit reached, escalation required |

`CAPTURED` describes retained captured funds, not a valid checkout or a completed
order. Preserve `captureAuthorized = false`, the immutable cutoff/capture
identity, the compensation root and every receipt/claim. Never reopen an order,
phase or resource reservation; never activate production, create a paid-conversion
observation, count these funds as ordinary settlement consideration or change
an immutable settlement. Terminal order badges still show compensation due.

### Narrow database amendment

Add a **new forward migration after PR #257's existing migrations**. Extend
`payments_provider_intent_identity_check`'s existing null-intent post-capture
exception to **CAPTURED and REFUNDED as well as REFUND_PENDING**. Do not remove the
check or permit null intent for ordinary PENDING payments. This decision adds no
null-intent PARTIALLY_REFUNDED route: this compensation refunds the entire capture.
Keep ordinary intent-bearing partial-refund behavior unchanged.

A nonempty capture ID alone is insufficient. Enforce the null-intent captured
states in SQL with row checks plus a deferred cross-row constraint guard (or
reuse an equivalent existing guard where it proves every condition):

- Nonblank immutable capture ID, positive captured amount, captured timestamp,
  closed authorization and nonnull cutoff; capture is on/after cutoff, subject
  to the existing amount/time rules.
- Exact immutable `PAYMENT_CAPTURED` event: same payment/provider/transaction,
  null refund scope, matching captured amount/currency and `verified_at` equal to `captured_at`; retain the existing authenticated/verified timestamp and event
  scope checks. A refund receipt or operator attestation cannot substitute for
  an authenticated capture event.
- Persisted full root `LATE_CAPTURE_COMPENSATION` refund for this same
  payment/provider/captured amount, with its existing scope and immutable
  lineage. A fabricated capture string without capture/root evidence cannot
  commit. Check final transaction state, so receipt → payment → root creation
  in the legitimate atomic capture path remains possible.
- Preserve `taven_validate_payment_refund_status` and captured-budget guards:
  pending means actual PENDING/SUSPENDED work, full refunded means the exact
  successful total and no suspended incident. No fabricated pending attempt.

The existing financial envelope serializes Payment/refund work. Do not add a
late lower-rank lock, network I/O, bypass flag or new lock rank. Retain receipt
and financial-identity immutability so checked evidence cannot later be removed
or changed. Direct inserts/updates must not bypass the invariant.

For the adjacent **intent-bearing failed-source** case, narrowly refine
`payment_failed_late_capture_refund_retry_check` and core
`requireExactRefundFailureRollback`: permit REFUND_PENDING → CAPTURED after
selected final REFUND_FAILED evidence with zero successful and no active or
suspended refunds. Require the exact immutable late capture, full compensation
root/outstanding obligation and unchanged closed cutoff; retain the prior exact
PAYMENT_FAILED evidence. A failed root or the one failed replacement must keep
its verified result and lineage. This explicitly supersedes only the blanket
ban on that refund-failure rollback, not the failed-source capture guard.

Retain FAILED → REFUND_PENDING authentication/failure/capture provenance,
refund-success reversal restrictions, receipt chronology, all amount/identity
checks and suspended/double-success rules. Operator recording still cannot
reverse a successful refund. The adjustment is in the same applicator/financial
PR because leaving the old blanket ban would make #256's approved two-command
late-compensation recovery unusable for another existing origin of the same
obligation. No new general failed-payment activation route is authorized.

### Commands, reads, compatibility and rollout

Keep the existing provider-results/retry DTOs and enum values. Their
`providerIntentId` field denotes the verified provider transaction locator for
this compensation case, not a newly assigned Payment field. Resolve it from the
exact attempt's immutable outbox command plus matching capture evidence; retain
request reference, payment/refund/provider/amount/currency checks, including the
capture timestamp/null refund scope. Copy the same proven locator into the one
replacement command. Missing/conflicting provenance blocks the command; no
client-selected fallback, provider switch or invented capture/intent identity.
Share equivalent checks between action/read projection and execution.

`COMPENSATION_DUE`, unresolved-refund and completion barriers follow the retained
obligation/receipts, not CAPTURED alone. A failed root becomes eligible for the
existing one guarded retry; a failed child remains an incident. Read/command
results must not claim successful payment or refund merely from a state name.
Ordinary refunds, failed-source capture authentication, cutoff, settlement
closure and ADR0003 suspended/double-success behavior remain unchanged; only
the exact failed-refund rollback prohibition is refined above.

No table, enum, public route or queue version is added. Preserve completed
idempotent responses and historical fingerprints. Drain financial writers and
dispatchers, preflight existing null-intent captured rows against the evidence
guard, apply the additive migration and compatible backend, validate, then
resume consumers. Do not manufacture evidence or alter old migrations/receipts.
Invalid retained data stops rollout for a scoped repair decision. Rollback must
not restore the old constraint over newly valid rows: stop affected admissions
and roll forward. No data backfill or live transfer is authorized.

### Required proof and handoff

Continue **#256 / P6a-R / existing PR #257**, preserving its independent
cancellation-scope fix. No new issue, parallel group or PR boundary is needed.
Include this amendment, forward SQL, relevant producer/read/guard changes and
regressions in that financial-contract PR before #34/P6b.

- Extend the real in-flight intent/cancellation regression through authenticated
  capture → selected final failure/CAPTURED → one retry/REFUND_PENDING → real
  result/REFUNDED. Assert intent stays null, locator/history stay exact and
  unpaid barriers survive the failure. Also prove direct successful compensation
  without a retry; a fix tested only through retry creation is incomplete.
- Test failed replacement/disabled third transfer; duplicate results, same-key
  replay and two retry keys; source success before/after claimed replacement,
  suspended replacement failure and double-success receipt ordering. Preserve
  the ordinary cancellation post-void-handoff denial regression.
- Force deferred checks at commit. Reject null-intent ordinary PENDING/CAPTURED
  without compensation, missing/foreign/mismatched capture evidence, altered
  cutoff/identity, incomplete root, fabricated pending state and false REFUNDED
  totals. Negative fixtures may use direct SQL; positive proof uses real
  commands/provider fixtures. No live provider transfer.
- Cover affected FULL/DEPOSIT/BALANCE paths across automatic and individual
  origins, including an intent-bearing PAYMENT_FAILED → late capture → refund
  failure → explicit retry → refund success case. Regress ordinary/partial
  refunds and every retained failed-source/capture guard; test fresh and populated
  migration. Prove no jobs/resources/settlement rewrite,
  false paid conversion or premature financial completion after failure.
- Run affected real PostgreSQL/API/concurrency suites, core/backend tests and
  relevant repository/generated checks, final-head CI and independent review.
  #34/P6b and #185 consume the prominent obligation and add browser proof.

Keeping REFUND_PENDING with no active work would redefine its existing SQL
meaning; creating an automatic replacement would bypass the explicit retry
command. A new state spreads unnecessary changes through contracts/consumers.
Backfilling an intent falsifies write-once history. Guarded existing states are
the smallest compatible solution, including the otherwise-blocked REFUNDED exit.
Architecture is ready; implementation and validation remain required.
