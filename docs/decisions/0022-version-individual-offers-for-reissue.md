# ADR 0022: Version immutable individual offers for reissue

- **Status:** accepted architecture; implementation required in #152 / PR #158
- **Decision:** [escalation #161](https://github.com/Studio81Labs/taven/issues/161)
- **Amends:** ADR 0020 reissue assumption and ADR 0003 Quote state ownership
- **Inspected baseline:** PR #158 `1ccc427`

## Context

An issued legacy offer cannot be accepted without new legal provenance, yet
Quote.quoteRequestId is unique and issueOffer requires IN_REVIEW. The request
is already QUOTED, so a new idempotency key cannot reissue it. Returning to
review alone would still violate uniqueness. Deleting or modifying the old
Quote would destroy immutable offer and idempotency evidence.

## Decision

Retain the original QuoteRequest, capability/session/handoff, attachments,
privacy acknowledgement and SLA history. Permit multiple immutable Quote rows
with one explicit current offer selected on that request. Reissue is one atomic
QUOTED-to-QUOTED command. It neither recreates customer consent nor reopens an
accepted/rejected/expired request. There is no mutable Quote status or general
quote editing surface.

### Persistence and lifecycle

Remove quotes.quote_request_id uniqueness; keep its request FK. Add unique
(quoteRequestId, version), preserving existing version values and immutable
Quote IDs. Add nullable QuoteRequest.currentQuoteId with a same-request composite
FK to Quote (quoteRequestId, id), backed by a unique target pair. The pointer FK
is initially deferred to permit initial issuance and new-version insertion in
the same transaction. Use RESTRICT deletion. Existing items, shipment plans,
price snapshots/bindings and legal references remain keyed to the exact Quote.

Migrate each existing request with its sole Quote to that exact ID without
changing any Quote, token, accepted Order origin or consent. Leave requests
without a Quote null. Validate anomalies before cutover; do not pick a winner
from inconsistent imported history or rewrite version numbers to make it pass.
New QUOTED requests require a complete current Quote/binding package. The
pointer remains on the accepted/rejected/expired final version for history and
cannot change once terminal. NEW/IN_REVIEW cannot acquire an unrelated current
Quote. Preserve valid legacy rows without manufacturing missing offers.

A reissue holds the request row lock and appends version=current.version+1 with
a new Quote ID, issuance command/result, token hash and full sealed package.
Reject integer exhaustion; never wrap or reuse a version. In the same transaction
switch currentQuoteId, update current-state command/result identity and timestamp,
write an audit event with previous/new Quote IDs and versions plus operator reason,
and enqueue the existing offer-issued notification for the new ID/version.
Preserve the first slaRespondedAt. All previous Quote rows and child snapshots
remain untouched. Reissue does not imply a customer acceptance or a new legal
decision under ADR 0021.

Database enforcement must serialize pointer changes on the request and validate
same request/customer, valid status, monotonic version, sealed price/shipment
package, matching current state command identity and required legal provenance.
A newly inserted application Quote must be the selected current version at
commit; no orphan candidate may commit. Deferred reconciliation permits the
atomic insert/switch sequence. Do not weaken Quote/item/price immutability or
uniqueness of the one accepted Order across all versions of a request.

### Operator command and public behavior

Add `POST /admin/quote-requests/{requestId}/offers/reissue`. It uses the existing
node-scoped QUOTES_WRITE authorization, service enforcement, operator cookie/CSRF
and Idempotency-Key. Request: expectedQuoteId, expectedVersion, required reason
and reasonCode, and `offer` containing the existing full IssueOfferDto. Use a UUID
expectedQuoteId, positive PostgreSQL-integer expectedVersion, nonblank reason
(maximum 1000 characters) and reasonCode matching `^[A-Z][A-Z0-9_]{0,99}$`,
consistent with existing operator reason validation. Keep first
issuance's existing endpoint/DTO and fingerprint unchanged. Reuse all existing
issuance input, pricing, source/model, shipment, retention and publication checks;
new terms/claims text and window come from current approved policy, never copied
from unverifiable legacy prose. Reissue does not waive missing/expired resources.
A legal-only replacement may retain identical valid price inputs; it must not
require changing numerical PriceList coefficients.

Use a dedicated quote-request.reissue-offer idempotency namespace. The fingerprint
contains request, expected Quote/version, reason and full normalized offer input.
Replay precedes fresh gates. Fresh execution takes idempotency, legal-document
locks, then request/business locks in canonical order. Require QUOTED, exact
current Quote/version, unexpired current offer and no accepted Order. If the old
offer is already expired, use the existing expiry path; do not revive it through
reissue. For a still-active missing/stale legal package the operator now has an
executable replacement path. Reissue may also replace an active unaccepted offer
through the same explicit operator command; it never edits an issued snapshot.

Return the existing complete OfferIssuedDto with the new ID, version, token and
legal package (201; completed replay uses the recorded result). Conflicting
current identity/lifecycle returns 409; bad input 400, invalid authentication or
permission 401/403, missing request 404, unavailable legal prerequisite 503.
Regenerate OpenAPI and actual clients. Update operator queue/detail reads to show
the current Quote; document the command and preserved history. No new admin UI,
customer portal or historical-offer browsing API is required.

Public offer capability identity stays (quoteId, token); tokens are not reused
or redirected. Preview and fresh accept/reject require request.currentQuoteId to
equal the authenticated Quote, plus the existing status/expiry/version checks.
A valid superseded token returns 410 with OFFER_SUPERSEDED, without disclosing the
successor token or auto-accepting new terms. Wrong/missing tokens retain 401.
Stale expected version on the current offer retains 409. Keep completed legacy
accept/reject replay before current-eligibility checks after authentication; a
replay cannot act on the new version or create another Order.

Preserve completed issuance results too: the old key returns its original old
Quote/token response and never reissues, changes the pointer or emits another
notification. Remove the instruction to retry first issuance with a new key.
For pre-cutover stored responses, preserve their original safe wire shape rather
than inventing missing legal evidence. Mark newly added OfferIssuedDto legal
fields optional solely for legacy replay compatibility; fresh issuance/reissue
must always supply them, and consumers must treat their absence as non-acceptable
historical data. If the stored response/capability cannot be authentically
reconstructed, fail closed and direct the authorized operator to the dedicated
reissue command; do not overwrite an idempotency record or regenerate a different
token for that recorded result.

### Integration boundaries that must change together

Bind acceptLockedQuoteRequest and the request acceptance/expiry SQL guards to
the exact current Quote ID, not EXISTS(any unexpired Quote for the request).
Integrate ADR 0021's sourceQuote decision: the current pointer, decision.sourceQuoteId,
IndividualOrderOrigin.quoteId, copied items, binding and claims/terms evidence
must agree. The current pointer freezes on acceptance. Individual Order conversion
retains the existing DRAFT/payment lifecycle, with no auto-confirmation.

Audit every singular request.quote use and every SQL join by quote_request_id.
Consequential existing consumers include preview/accept/reject/expiry, operator
queue/detail, the issuance reconciliation trigger, individual-origin ownership
and one-Order guard, upload/photo retention joins in UploadService, and SLA metrics.
Use currentQuote for actionable state and deadlines. Preserve first-response SLA
(use the earliest authentic issue only for existing legacy fallback), not the
latest reissue time. Versioned issuance events must not double-count a new
QuoteRequest or fabricate a customer conversion. Existing insert-time source/photo
retention extension applies to the new expiry without resurrecting deleted assets.
Accepted settlement always follows its exact origin Quote, never a later lookup
of the request's current offer.

### Migration, validation and execution

Deliver this in #152 / PR5b / PR #158 with ADR 0021. First implement trusted
acceptance decisions; then implement version selection/reissue and integrate
its sourceQuote checks. One migration/producer/SQL/generated/client/test boundary;
no separate incomplete merge of #158 that still strands active legacy offers.
Use a forward migration if the current migration has reached retained/shared
data, otherwise the pending disposable-only migration may be amended. Drain
old writers and disable new admissions for the coordinated cutover. Old binaries
assuming one Quote per request cannot write once multiple versions exist.
Roll forward or keep admissions disabled; no destructive down migration.

Require real PostgreSQL/API tests for active unaccepted legacy reissue through
new preview, explicit acceptance, DRAFT Order conversion and initial payment;
legal-only rotation with unchanged numerical inputs; complete preservation of
old Quote/children/token/results; superseded preview/accept/reject and no token
leak; current-only expiry/photo upload/operator reads; old and new idempotent
replays; same-key changed-body conflicts; concurrent reissue/reissue,
reissue/accept, reissue/reject, expiry/reissue and publication/reissue. Exactly
one current version and at most one accepted Order may commit. If acceptance
wins, reissue rejects; if reissue wins, old acceptance cannot create an Order.

Test direct SQL invalid pointer/request/customer/version, orphan Quote, terminal
pointer change and incomplete package rejection; legacy migration with/without
Quote; version overflow; missing source assets; rollback of pointer/audit/outbox;
unchanged SLA/metrics and retained settlement. Run relevant backend/core/DB/e2e,
web consumers and browser acceptance, lint/typecheck/build, generated/format/
boundary checks and independent review. This architecture work implements none
of these changes and claims no implementation test pass.

## Alternatives

Reopening QUOTED to IN_REVIEW does not remove the one-to-one constraint and adds
an avoidable intermediate lifecycle state. Cloning QuoteRequest complicates
consumed handoff/session ownership, attachments, SLA and consent provenance.
Updating/deleting the old Quote or accepting it without legal evidence violates
immutability or legal admission. The current-pointer model uses the existing
Quote version field and exact Order-origin relation while preserving request
identity and all prior evidence.
