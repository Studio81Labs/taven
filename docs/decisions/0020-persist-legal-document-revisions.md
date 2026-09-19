# ADR 0020: Persist legal documents and immutable revisions

- **Status:** accepted design; implementation pending #151 and #152
- **Decision authority:** owner instruction to update the database-backed versioning plan; Epic #9
- **Supersedes:** ADR 0019 ownership/storage/selector model; preserves its server-time and settlement requirements
- **Implementation baseline:** main `e0f9a75aaa513858295701b7e016976916da42f7`

## Context

The owner requires database-backed legal text with replacement and archival of
prior versions. Legal approval remains external: all six supplied document
identities are DRAFT / NOT_EFFECTIVE, with final codes, effective instants and
approval evidence unassigned. Repository deployments should no longer select
the legal text for new transactions. Old acceptances must remain tied to the
exact immutable text that was accepted.

GitHub Epic #9 is the persistent execution-plan source of truth. This ADR
records the approved database and contract decisions; it does not migrate data,
create production approvals, or authorize launch. PR4/#144 can finish on the
existing merged mechanism before the two new implementation increments.

## Subsequent acceptance and reissue decisions

[ADR 0021](0021-own-legal-acceptance-decision-time.md) / #159 replaces the
implicit timestamp-provenance assumption with a DB-owned first-acceptance
decision shared by the subject and ledger. It also replaces the independent
individual statement clock while preserving one authoritative instant.
[ADR 0022](0022-version-individual-offers-for-reissue.md) / #161 makes the
previously assumed reissue path executable through immutable Quote versions
and a current pointer. These amendments belong to #152 / PR #158 before merge.
All other approval, settlement and launch constraints below remain binding.

## Decision

**Owner-approved amendment:** legal text, immutable approved revisions and publication history move to PostgreSQL. This replaces ADR 0019/#150's checked-in catalog and web-text ownership decision, while preserving trusted server time, fail-closed approval, exact acceptance, and settlement/replay guarantees. Baseline: merged PR #149, `e0f9a75`. ADR 0020 records the new decision. Existing PR4/#144 continues unchanged; the following two serial implementation increments precede final #143 content import. No legal approval is conferred by this architecture change.

**Scope and current evidence.** `LegalApprovalsService.evaluateAt` currently reads process configuration; `apps/web/content/launch-manifest.ts` owns text. `Order` records accepted revision strings, `Quote` records a string plus operator-supplied `termsSnapshot`, and `PriceList.termsRevision` is immutable and used by SQL checkout/balance guards. The admin app currently contains a health/status shell. This increment provides protected operator management APIs and a documented request workflow; a document-management UI is separate future scope. Reuse existing operator authentication, CSRF, idempotency and audit facilities. No general CMS, rich HTML editor, legal AI, new identity system or deployment work is included.

**Storage model.** Add `LegalDocument` with the six fixed existing API keys and the owner's stable document IDs: terms→terms-of-service; claims→complaints-policy; privacy→privacy-policy; prohibitedContent→prohibited-content-policy; retention→retention-policy; photoConsent→photo-consent-and-confidentiality. A monotonic document generation detects stale approval/publication commands. Stable public routes remain web-owned. These identities are not final legal revision IDs.

Add `LegalDocumentRevision`: UUID identity, document FK, internal sequence, optimistic `editVersion`, structured content version 1 (`title`, `summary`, `sections` with heading/paragraphs/items/note), content SHA-256, DRAFT/APPROVED status, nullable unique `revisionCode` (max 100 characters), nullable `effectiveAt`, approval evidence reference, approver identity and database `approvedAt`, plus creation/update audit times. Draft UUIDs/sequences may be assigned; final revision codes, effective instants and evidence stay null until actually supplied. Drafts are editable using expected editVersion; approved content, hash, code, effective instant, evidence and approval attribution become immutable under database triggers. An edit to an approved document creates a new draft revision. Validate non-empty operative text, strict structured fields and a 256 KiB UTF-8 payload bound; render strings as escaped text. Do not accept arbitrary HTML, remote source URLs or files as executable content. Reuse canonical JSON hashing conventions; the backend computes hashes, never trusts a client digest as content.

Approval requires all four #38 items: complete approved text, unique immutable revision ID, exact timezone-aware effective instant and recorded owner and/or Czech counsel approval evidence. An ADMIN records that external approval; an API call itself is not legal review. Normalize a supplied offset timestamp to UTC without changing its instant. Approved metadata can have a future effective instant; approval alone does not publish it. No migration, seed or environment variable invents these fields. The evidence wording follows the [explicit owner instruction recorded in #38](https://github.com/Studio81Labs/taven/issues/38#issuecomment-5647592443), which is newer than the 2026-09-04 launch registry. Do not silently replace its “owner and/or Czech legal counsel” rule with mandatory counsel evidence. Owner evidence does not establish that counsel review occurred, close outstanding #38 work, or authorize #39 public activation; record only the approval actually supplied.

Add `LegalDocumentPublication`: document/revision FK, `startsAt`, nullable `endsAt`, nullable `cancelledAt`, publishing actor and reason, and timestamps. It stores public validity intervals `[startsAt, endsAt)`, separate from immutable approved content. Publish under the document lock, with `startsAt = max(revision.effectiveAt, database decision time)`. Immediate replacement closes the prior active interval at that same instant; future replacement closes it at the new start, so the prior text remains current until then. Allow at most one future publication per document; a second schedule conflicts until the first is cancelled. Require an APPROVED revision of the same document and prohibit overlaps for non-cancelled intervals with a PostgreSQL exclusion constraint. A revision may have at most one non-cancelled publication, including ended history; enforce a partial unique index on revisionId WHERE cancelledAt IS NULL. Never-started cancelled attempts do not consume that slot. Approval and publication are separately audited actions. While any non-cancelled publication has startsAt greater than the locked decision instant, reject every new publish command (immediate or future) with 409 before changing intervals. The operator must explicitly cancel that schedule before publishing another revision; never implicitly cancel it or insert an interim publication. At startsAt equality the scheduled revision is current, so normal replacement rules apply, including rejection of empty intervals. Test rejection with and without a current predecessor, unchanged intervals on failure, cancel-then-publish, and exact-boundary behavior.

Archive the current publication by closing its interval at database time; without a replacement, new actions fail closed and never fall back to an older version. Cancelling a not-yet-started publication is allowed under the same lock: set cancelledAt and restore the predecessor's scheduled end only if that end still equals this publication's start and has not passed. Do not reopen a predecessor explicitly archived in the meantime. Past interval boundaries cannot be rewritten. Reject invalid/empty intervals. Historical approved revisions/publications remain readable; no delete endpoint or cascading deletion of revision evidence. Public state CURRENT/SCHEDULED/ARCHIVED is derived from intervals and server time, not a second mutable status. Archiving/supersession does not change accepted contracts or withdraw previously recorded photo permission; publication of customer assets remains governed by the separate recorded permission/confidentiality rules.

**Republishing after pre-start cancellation (#151).** A cancelled publication row is permanent history: cancelledAt cannot be cleared and its interval/actor/audit are not reused. A fresh call to the existing revision publish endpoint may create a new publication ID for the same immutable approved revision if every prior attempt was cancelled strictly before its startsAt. Use a new idempotency key and current document generation, and apply the ordinary document lock, pending-schedule conflict, interval/no-overlap and startsAt=max(effectiveAt, DB decision time) rules. No revision code, text, effectiveAt or approval changes/reapproval are needed. An old idempotency replay still returns its original publication result; it never schedules again. A revision that became public, including an archived one, remains ineligible for another publication.

The DB cancellation guard must require decision time < startsAt and persist cancelledAt at that decision time; equal/after-start cancellation is rejected. Keep cancelledAt/startsAt evidence immutable after cancellation so a previously public row cannot be relabelled as never-started. Test A current/B scheduled → cancel B → publish urgent C → publish B again before B's effective instant: the new B attempt starts at the original effective instant and ends C then, while old cancelled B history stays intact. Also test scheduling again after the approved instant (starts now, no backdating), repeated cancellations, same-key replay, concurrent publish attempts, exact-boundary rejection, and archived/current revision republication rejection. This refines #151's existing publish/cancel lifecycle and migration constraints, with no new endpoint or PR boundary.

**Time, locking and atomicity.** Replace synchronous in-memory `evaluateAt` with an asynchronous transaction-aware DB reader accepting the caller's Prisma transaction and decision instant. Add a legal-document lock rank between idempotency and QuoteRequest/Order locks in the core lock-order contract and ADR 0003. Fresh commands acquire shared locks on their required document rows in canonical key order before business/resource locks; management takes exclusive locks in that order. Publication/archival never locks orders or rewrites their evidence. Replay lookup remains before legal eligibility. Acquire every required legal lock up front; do not acquire a lower-ranked legal lock from a late pricing/acceptance helper. Read publication intervals and revisions within that transaction and evaluate at the existing post-lock instant; offer acceptance keeps its existing SQL `accepted_at` decision instant. Scheduled boundaries are evaluated on reads, so no activation worker is required. Publication racing acceptance serializes on the document rows; a scheduled time boundary is decided by the command's recorded instant. Public availability/content queries use one consistent DB snapshot and server instant; no process cache may authorize a write.

**Bind terms to offers/prices and preserve acceptance.** New `Quote.legalTermsRevisionId` and `OrderPriceBinding.legalTermsRevisionId` nullable-for-legacy FKs identify the exact immutable terms text. New individual issuance selects effective DB terms and generates `termsSnapshot` from that revision; operator-provided prose is not authoritative. Retain the old input field only as deprecated optional data that must match canonical text if supplied. New automatic binding preparation pins the current effective terms revision; individual conversion copies the issued quote reference. Repricing before acceptance creates a fresh binding/reference using the existing reprepare/reacceptance flow. Once accepted, references remain immutable. A legal-only edit requires no change to numerical price coefficients or a clone of the PriceList. `PriceList.termsRevision` remains historical legacy provenance; new bindings use their explicit FK as legal authority. Immediate non-binding estimation needs no accepted legal revision and retains #147's scope.

Keep current accepted-code/claim-window/withdrawal/photo scalar fields for compatibility. Add append-only `LegalAcceptance` rows: exactly one Order or QuoteRequest subject FK, document revision FK, purpose (TERMS_ACCEPTED, CLAIM_POLICY_ACCEPTED, PRIVACY_NOTICE_ACKNOWLEDGED, PHOTO_PUBLICATION_GRANTED), database decision instant and source command identity. Use typed subject FKs, purpose/document checks and uniqueness per subject/purpose to prevent duplicate first acceptance. Exact immutable text is reachable through the revision; do not overwrite it with the current version. Checkout creates terms/claims and optional-photo rows in the same staging transaction as existing frozen evidence; individual acceptance creates terms and claims rows plus the frozen Order claims code/window at the existing accepted_at (see individual-offer design below). Assisted creation records the exact acknowledged privacy revision and optional photo revision in its existing atomic transaction. Privacy notice acknowledgement is not relabeled as blanket GDPR consent. Missing photo permission creates no grant. This does not add a portfolio publishing pipeline or revoke/expand permissions implicitly.

Extend `CreateQuoteRequestDto` with privacyNoticeRevision, privacyAcknowledged and optional photoConsentRevision. Require exact active privacy revision plus explicit true acknowledgement on a _fresh_ request; require photo revision only when granting publication. Existing completed requests still replay: preserve old canonical fingerprints for absent fields and perform new semantic requirements only after replay lookup. Checkout's existing revision-code request fields remain sufficient because approved codes are globally unique and immutable. Keep checkbox reset and stale-response rules. Global payment capabilities describe new-acceptance eligibility; the scoped retry context below describes frozen-acceptance payment recovery.

Update application and database evidence checks together. For new acceptance require binding/quote FK, code equality and matching immutable acceptance rows; protect these with FKs, cross-record checks and append-only triggers. Amend `taven_order_accepts_bound_price_list_terms`, its acceptance trigger and inline legacy comparisons, including `taven_balance_timeout_earned_amount`, QC/balance and capture/fulfilment callers. Preserve a clearly isolated legacy branch for already accepted bindings without new FKs; do not disable those integrity checks. Newly committing checkout/offer acceptance must have DB revision provenance even on a pre-migration draft. Existing accepted legacy orders retain their strings/snapshots and remain able to settle. New balance attempts, webhook capture, refunds, expiry and fulfilment under an accepted contract validate its frozen legal evidence rather than requiring today's current terms; existing independent flow/payment gates and business deadlines remain. A first checkout acceptance against stale terms fails closed and needs reprepare/reissue; it cannot silently accept the new text. Do not backfill inferred consent or fabricate historical approved revisions.

**Individual offer claims (#152).** Issuance pins `Quote.legalClaimsRevisionId` (LegalDocumentRevision FK) and `Quote.claimWindowDays` alongside terms. Both columns are nullable only for pre-migration compatibility; new issued offers require an approved effective claims revision and the valid positive approved claim-window configuration. Read terms/claims under the legal locks at the issuance decision instant; snapshot the window once. Freeze these fields with the issued offer/version using DB constraints/triggers. Do not derive accepted claim windows from today's configuration at delivery or parse numbers from legal prose.

Extend OfferPreviewDto with claimPolicyRevision, claimWindowDays and the pinned claims text/version/hash reference, generated from that same immutable offer. AcceptOfferDto version + termsRevision identifies the immutable offer package, including claims; no separate claims-consent field is needed. Fresh acceptance additionally requires the explicit withdrawal acknowledgement below; rejection semantics remain unchanged. Show the claims text/window as part of the offer package before acceptance; preserve exact historical links. At fresh acceptance validate the pinned terms/claims references and window against the currently approved selected policy/configuration at the same SQL accepted_at instant. Changed or missing claims provenance/window requires reissue; never silently substitute a newer policy. Preserve expiry results, pre-acquired legal lock order, capability checks and completed idempotent replay.

In the conversion transaction copy the pinned claims code/window into Order.acceptedClaimPolicyRevision and Order.acceptedClaimWindowDays, alongside accepted terms and binding; insert both TERMS_ACCEPTED and CLAIM_POLICY_ACCEPTED ledger rows at accepted_at. Enforce agreement among source Quote, Order scalars and ledger revision with DB checks and immutable evidence. Neither a newly accepted individual Order nor an old unaccepted offer may use the accepted-legacy exception. Existing already accepted legacy Orders retain their actual evidence; missing historical windows require explicit escalation/remediation, never fabricated backfill or removal of the delivery guard.

#152 owns the Quote migration, issuance/preview/acceptance producers and generated contracts, existing consumer/fixture adaptations, atomic SQL checks and tests. Verify fresh individual acceptance → fulfilment → DELIVERY_SCAN computes claim_until from its frozen window, including after policy/config changes. Test absent/invalid issuance policy, preview agreement, policy/window change before acceptance, exact-time boundary, rollback without partial Order/ledger, concurrent acceptance/publication, replay and unaccepted legacy reissue. Do not add a speculative offer UI where no consumer exists; expose the complete preview contract and update actual consumers/tests. These are PR5b requirements, with no new PR boundary.

**Individual withdrawal acknowledgement (#152).** Add acknowledgeWithdrawalException to AcceptOfferDto, with the same meaning as checkout. Its wire field is optional solely for completed legacy replay compatibility: on every fresh acceptance require explicit boolean true, otherwise 400 before acceptance/business effects. Present the custom-goods withdrawal notice in the pinned approved terms before the acknowledgement; a consumer must use an initially unchecked control and cannot infer true from opening or accepting an offer, restoring storage, or ordinary terms acceptance. Tests must exercise a direct API call omitting/denying acknowledgement as well as the explicit customer action. No new legal prose or approval is supplied by this plan.

Separate shared version/terms parsing from acceptance-specific acknowledgement parsing. Include the acknowledgement in the accept fingerprint only when present, preserving the exact old fingerprint when absent; after authenticated completed-idempotency lookup return old responses unchanged, without synthesizing acknowledgement. Validate fresh requests in the idempotent callback. RejectOfferDto currently extends AcceptOfferDto: extract the shared expected-offer fields or otherwise preserve its existing wire shape, validation and rejection fingerprint; rejecting an offer must never require acknowledgement. Old unaccepted offers are not eligible for a legacy bypass.

Write Order.withdrawalExceptionAcknowledgedAt = accepted_at in the same conversion transaction as accepted binding/terms/claims and ledger rows; make it immutable with the existing evidence triggers. A separate ledger purpose is unnecessary: the existing timestamp plus pinned accepted terms records this acknowledgement. Keep payment_terms_acceptance_check intact. #152 must validate fresh individual acceptance through the initial payment (or deposit where configured) and delivery/claim deadline, along with missing/false/null/malformed acknowledgement, unchanged reject requests, old completed replay, new-key attempts without acknowledgement, immutable timestamps, rollback and concurrent acceptance. Generated contracts and actual consumer/fixture changes ship in PR5b; no extra migration column or PR boundary beyond the already planned Quote/Order evidence changes.

**Accepted checkout retry (#152).** A fresh idempotency key is not necessarily new legal acceptance. At preflight and again after locks, classify from server-owned Order/binding/evidence and prior Payment: no acceptance follows current-publication checks; a complete frozen acceptance with a prior attempt follows historical-evidence checks. For an otherwise retryable initial payment after FAILED, permit the same accepted binding/terms/claims/claim window/withdrawal/photo choice despite replacement or archival of current documents. Keep contact equality, session expiry, topology, provider/flow gates, active-payment uniqueness and capture/deadline rules. Never change the binding, acceptance rows/timestamps or photo choice. Partial evidence fails closed; preserve the explicit accepted-legacy branch. Completed idempotent replay still comes first. Customer cancellation/VOIDED or expired/terminal orders retain existing new-quote behavior; do not revive them. Only unaccepted stale terms require reprepare/reissue.

Add bearer-scoped, no-store `GET /automatic-quote-sessions/{sessionId}/checkout/retry-context` in #152: `{retryAllowed, methods, acceptedEvidence}`. acceptedEvidence is null without acceptance, otherwise frozen binding ID, terms/claims codes, claim window, withdrawal acknowledgement, optional-photo choice/code, legacy flag and exact-version text references/hashes (null only for unavailable legacy text). Never expose contacts, approval references or tokens. Derive eligibility using the same retry policy, not global current-approval capabilities; errors/partial evidence close retry. #152 specifies DTO/error details. The existing checkout POST and request fields remain; validate them against frozen evidence for retries. Expose retry on the existing payment-return journey even when new-acquisition gates are closed. Render prior acceptance read-only with historical links; server evidence, never local storage, determines the mode. An explicit retry click submits frozen evidence without new consent or changing old permission. Recheck at commit; failed context reads disable retry while preserving status/replay. Tests cover terms/claims/photo rotation or archival after failure, reload, legacy/missing evidence, changed input, races, disabled providers/flows, deadlines and terminal cancellation; assert unchanged evidence and no duplicate capture.

For the scoped read, authenticate the existing session capability and restrict lookup to its Order; use one consistent DB snapshot/time. Return 200 with retryAllowed=false when the valid session has no accepted attempt or is not retryable; acceptedEvidence may still describe its complete historical acceptance. Invalid capability 401, missing session 404, invalid sessionId 400, unavailable DB or incomplete/inconsistent evidence 503. Provider outage reports retryAllowed=false with empty methods; independent checkout flow disablement likewise. methods contains current provider-supported checkout methods only when retry is eligible; never source it from the globally legal-gated capability method. The response is presentation, not a bearer permission to write. Include acceptedOrderPriceBindingId, termsRevision, claimPolicyRevision, claimWindowDays, withdrawalExceptionAcknowledged, photoPublicationConsent, nullable photoConsentRevision, legacy and version references (key/code/hash) in the generated acceptedEvidence DTO; nullable legacy hashes do not imply fabricated content. No new persistence table is needed beyond the planned #152 provenance.

At staging, re-read the classification/evidence under the existing ordered locks. A retry requires complete matching accepted evidence plus a prior initial-payment attempt for that binding; a bare accepted pointer or client mode flag cannot bypass current-publication checks. A non-legacy acceptance requires its existing ledger rows; never insert duplicate LegalAcceptance rows or refresh acceptance/grant times on retry. Split current legal selection out of shared flow-flag helpers so retry still enforces independent flags/provider configuration but uses the frozen claim window/codes. Keep existing active CREATED/PENDING/CAPTURED replay/conflict behavior and new-key retry rules; unresolved provider intent is not permission to create another payment. Verify accepted legacy with original immutable evidence, not inferred new records. Cancellation/expiry remains terminal according to taven_close_initial_checkout_payment; no change to those SQL transitions.

On browser reload, obtain scoped server evidence before selecting retry mode. Preserve the current contact/billing request and server equality validation: recover local input or ask the customer to re-enter it; the scoped read adds no personal-data read API. Build existing POST booleans/codes from verified prior acceptance only after the explicit retry action, with a new key for a genuinely new attempt. Show recorded consent as historical information, not newly checked consent controls; do not reset/regrant photo permission when today's optional policy changes. Fresh checkout still requires the normal unchecked consent UI and current text. Keep retained payment-return access separate from acquisition middleware. Generated backend/web changes and real API/browser retry tests ship together in PR5b.

**HTTP and public web.** Retain `GET /legal-documents/availability` schemaVersion 1 and its six-key shape; add `contentHash: string | null` and evaluate publication intervals from DB. `policyRevision` becomes an opaque digest of selected publication/revision identities and availability state, so a scheduled transition changes it without a worker. No active publication projects effective=false; preserve a non-effective draft projection for empty installations. Add `GET /legal-documents/{key}/revisions/{revisionCode}` returning bounded escaped-content data (content schema version, revision/code/key, hash, effective instant, title/summary/sections) for a revision that has actually been public; drafts and not-yet-published revisions return 404. Archived public text remains accessible through this exact-version URL. Internal evidence references and draft content require operator authorization. Availability/current decisions remain no-store; immutable public revision responses may use their content hash as ETag. No endpoint response authorizes a mutation.

Web fetches content for the exact revision/hash advertised by availability, retaining stable Czech legal page URLs. Match key, revision, hash and effective instant before enabling acceptance. A publication change during separate reads triggers refresh and clears consent; immutable version URLs prevent displaying new text under an old code. Fetch required checkout text before presenting the checkbox and link to the pinned historical revision URL through a web version query/route. SSR renders supplied DB content with the current escaped section component, then hydrates the same request-scoped snapshot. API failure preserves page shell/input and a clearly non-effective local draft fallback where useful; it must not claim a previously bundled version is current. Retain noindex for drafts/unknown/current-unavailable pages, historical versions noindex with their explicit archival label, bounded refresh and browser-clock resistance. Frontend source files are no longer the production text authority. Preserve public commercial gating independently.

**Operator workflow and security.** In `apps/backend` add `/admin/legal-documents` list/detail/history and bounded revision read, draft create/update, approve, publish, cancel-publication and archive commands. All use existing cookie authentication and unsafe-method CSRF, plus new seller-global `legal:read` and `legal:write` permissions granted only to ADMIN initially. Enforce permissions in service methods too; do not grant legal writes through operations/payments/catalog permissions or invent a node-scoped legal policy. Every mutation has Idempotency-Key, expected document/revision generation, and an explicit reason; approval additionally supplies expected content hash and all #38 metadata. Stale edits/schedules return 409; invalid input 400; unauthorized/forbidden 401/403; unavailable legal prerequisites 503. Audit actor, subject UUIDs, previous/new revision or publication IDs, hash and reason in the same transaction, without copying entire legal documents, credentials or customer data into logs. Document authenticated API usage; no admin UI is required for these increments. Approval evidence is private to permitted operators.

**Node-free legal ADMIN sessions (#151).** Amend both OperatorAuthService.createSession and authenticateRequest: ADMIN may have zero or one active node grant; OPERATOR/VIEWER still require exactly one, and multiple active grants remain invalid for every role in v0. Recompute active grants, role and permissions on each request as today. For zero-node ADMIN, return nodeIds=[] and only legal:read, legal:write and audit:read; one-node ADMIN retains existing permissions. Never manufacture a grant or choose a fallback node. A role change away from ADMIN with no grant denies the next request; restoring/removing a grant updates scope on the next request. Cookie/token hashing, authentication-method checks, credential version/revocation, idle/absolute expiry, last-seen handling, login throttling, GitHub/development restrictions and CSRF remain unchanged.

Move the universal one-node route prerequisite to OperatorAccessGuard as a default, with explicit AllowNodeFreeAdmin metadata on the legal management/audit controllers and on GET /admin/auth/session and DELETE /admin/auth/session handlers only; permission and unsafe-method CSRF checks still run. GET session must return the authenticated node-free context and CSRF token; DELETE session must still validate that token, revoke the session and clear its cookie. Do not apply the exception to the entire auth controller or alter login/callback protections. All other protected routes retain the one-node requirement. Keep operatorNode/assertOperationalOrderScope and audit node-grant enforcement; add the same one-node prerequisite to the existing AuditService.list so audit:read cannot expose legacy node-scoped history through a direct service call with zero grants. Operational service permissions remain unavailable in the zero-node context. The new legal audit reader alone accepts that context with legal:read + audit:read. Do not add a blanket ADMIN scope bypass.

#151 owns auth/session tests, guard/permission contracts, any DTO/generated-client documentation required to permit an empty nodeIds array, and existing admin-session consumer checks; no new auth provider, session schema or provisioning UI is needed. Use real session creation and authentication in tests, not only fabricated OperatorContext objects: zero-node ADMIN completes the GitHub callback using the isolated provider fixture, reads GET session for its CSRF token, reaches legal reads/writes/audit, then logs out through DELETE session; missing/wrong-CSRF logout is rejected without revocation and valid logout prevents further use. It cannot reach operational routes or legacy audit, and missing CSRF still fails; zero-node non-ADMIN and multi-node sessions fail. Cover revocation/expiry, role/grant changes and unchanged one-node operator/admin behavior. Provisioning an actual account remains outside this planning PR.

**Seller-global legal audit (#151).** The existing `AuditService.recordOperator` requires a granted node, its reader filters by node/legacy scope, and SQL requires an operational subject. Extend the existing AuditEvent table with nullable `legalDocumentId` (RESTRICT FK) and a `(legalDocumentId, createdAt, id)` index. Reserve schemaVersion 3 for legal operator events: require that FK, OPERATOR actor, matching non-null actorId/operatorIdentityId and paired reasonCode/reason; require nodeId and all operational subject FKs to be null. Extend schema-version, actor and scope constraints with this explicit branch; preserve every v1/v2 rule and require their legalDocumentId to be null. Preserve append-only enforcement and existing rows; no fake node or legacy-schema bypass.

Add a transaction-aware `recordLegalOperator` writer enforcing legal:write, using the mutation's DB decision instant and correlation/idempotency identity. Add `GET /admin/legal-documents/{key}/audit-events`, requiring both legal:read and audit:read at HTTP and service layers, independent of node grants. Query only schemaVersion 3 for that document; leave existing `/admin/audit-events` node/legacy visibility unchanged. Reuse bounded descending (createdAt,id) pagination (default 25, maximum 100); bind cursors to legal scope, document and normalized eventType/operatorIdentityId filters. Return the existing audit summary/page shape with an additive optional legalDocumentId; the legal-only payload projector allowlists operation, document/revision/publication UUIDs (including previous/new references) and content hash. Do not expose prose, approval-evidence references or arbitrary payload fields. Record one event in the legal mutation transaction; rollback and completed replay must not produce extra events. #151 includes migration, producer/generated contracts and API workflow documentation. Validate global ADMIN access without a granted operational node, non-ADMIN denial, cursor/document isolation, redaction, rollback/replay, DB rejection of mixed or missing scope, and unchanged v1/v2 node/legacy visibility.

**Migration and rollout.** #151 adds new legal tables, constraints, protected management/read APIs and DB reader tests while existing production admission stays on the already shipped implementation. #152 adds binding/acceptance relations, SQL guard changes, wires all backend/web consumers to DB, removes process-catalog authorization (including NODE_ENV-generated approval fallback), and deprecates legal revision environment selectors. After cutover the DB publication is the selector; keeping a pinned environment revision would prevent runtime replacement. Retain independent commercial/provider flags and claim-window policy; document obsolete selector configuration removal. Seed only the six document identities and actual known repository draft text with internal draft identities, null final codes/times/evidence, and no publication/acceptance rows. The owner-reported document list is not supplied text or approval; import newer drafts only from actual supplied files. Tests explicitly seed an isolated database, never a normal runtime approval switch.

Add nullable legacy references without changing existing strings or snapshots. Inventory old accepted Orders/Quotes before cutover; leave missing historical text unlinked and visibly legacy, never synthesize it. New acceptance cannot take the legacy fallback. Include migration tests with accepted/unaccepted legacy records and accepted-contract downstream operations. Drain old writers and disable affected new admissions during the cutover migration/deploy; mixed old/new writers are unsupported. Deploy the compatible enforcing backend and generated web together, verify DB restore includes revision history, and enable flows only through #39 after #38. Roll forward or disable new admissions if cutover fails; no destructive down migration and no rollback to a static-authority binary with new flows enabled. Archived legal text remains retained with referenced evidence; retention of customer data still follows its existing rules.

**Execution and validation.** SERIAL / maximum implementation concurrency 1: finish existing #144 PR4 → #151 (PR5a) → #152 (PR5b, including browser regression extensions) → #143 final approved package (PR5c, when #38 is ready). Infrastructure-only increments may merge without real approvals; final #143 acceptance remains open. Test DB immutability/deletion/FK/purpose constraints, duplicate revision codes, approval without text/evidence, exact timezone boundaries, current/future replacement, cancellation/archive/no fallback, concurrent publication/acceptance and draft edits, permissions/CSRF/idempotency, real legacy migration, immutable accepted history, stale text/checkboxes, direct API bypass, public/private version reads, unavailable DB, and pending/captured/refunded/balance flows after a terms change. Include a legal-only replacement with identical pricing inputs to prove the PriceList decoupling. Parent executes relevant backend/web/core tests, new browser scenarios, lint/typecheck/build, migration/DB suites, generated and format checks, then independent review. No production approval or publication is part of this planning task.

### Event-time legal audit hash evidence — escalation #156

Decision: [#156](https://github.com/Studio81Labs/taven/issues/156), discovered
in PR #155 at `c6630f0`. This amends #151 / PR5a only. Draft content remains
editable; approved content remains immutable. The append-only audit event
owns its verified mutation-time hash. Reading an old event must not compare
that hash with the draft's current content.

Add nullable typed `AuditEvent.legalRevisionId` (UUID, RESTRICT FK to
LegalDocumentRevision) and `legalContentHash` (64 lowercase hex characters).
Both must be null for schema v1/v2, and either both null or both present for
v3. A database INSERT trigger requires both for every newly inserted v3 event;
null pairs exist only for pre-amendment history, if any. Do not add a separate
audit table, immutable draft-text snapshots, an edit-history API, or a new
schema version. Different events may legitimately record the same hash.

At insertion, the trigger loads the referenced revision with `FOR SHARE`,
checks its document equals the event's legalDocumentId, and verifies the typed
hash equals the stored canonical content hash. The existing revision-content
SQL hash constraint remains mandatory. Reject missing, foreign, malformed or
mismatched evidence, including direct SQL inserts. If JSON payload revisionId,
documentId or contentHash is present, require it to agree with the typed
subject/hash; it never supplies proof by itself. Preserve revision id and
documentId on all updates, including DRAFT updates, so the verified ownership
cannot later change. The RESTRICT FK prevents deletion of an audited draft.
The existing AuditEvent append-only trigger protects the evidence columns too;
never introduce a later evidence update or backfill bypass.

`recordLegalOperator` takes required typed revision/hash arguments from the
mutation result, independently of arbitrary JSON payload. All six existing
legal mutation callers supply them after the mutation, in the same transaction
and with its existing actor, reason, database decision instant and command
identity. Approval uses its final persisted content hash, including any
normalization already performed by the approved workflow. Failed evidence
validation rolls back the mutation and its idempotency result; completed
replay creates no new event.

Keep lock ordering: command idempotency lock, exclusive LegalDocument lock,
then revision row locks within that document aggregate. The audit insert must
not acquire the parent document lock after locking a revision. The revision
`FOR SHARE` lock lasts until transaction end and conflicts with ordinary draft
updates/deletes, so direct concurrent SQL writers cannot invalidate the
insertion-time check. It is not `FOR KEY SHARE`. If a competing edit commits
first, stale evidence rejects (or the enclosing serializable command retries);
if the event inserts first, its verified hash survives the later edit. No new
cross-aggregate lock rank, external I/O or background worker is introduced.

The legal-only projector emits documentId/revisionId/contentHash from the
validated typed event fields, scoped to the event's document. It does not
compare historical hashes with the current revision hash or fall back to JSON
hashes. Keep bounded same-document validation for other revision/publication
references and the existing strict operation allowlist. No prose, approval
references, operational identifiers or arbitrary payload data may leak through.
An old event without typed evidence retains its other safe fields but omits
contentHash; absence means unverifiable, never an approval or current hash.
Keep the current HTTP summary/page shape, permissions and cursor contract;
the typed persistence fields are not additional public response fields.

This proves that a hash matched real revision content at database insertion,
not that a privileged database importer received external legal approval or
performed the claimed historical action at a supplied timestamp. Normal imports
must pass the same constraints and cannot load an arbitrary past hash as verified
evidence. An old JSON hash cannot be upgraded from a current-row match, shape,
operator assertion or inferred edit version. Authentic database backup/restore
must preserve already verified events and their references together. Database
superusers disabling enforcement and fabricated full backups are outside this
existing database trust boundary; no signing/key-management system is added.

PR #155 is unmerged. Amend its pending migration only if it has run exclusively
in disposable development/test databases, which may be rebuilt. If applied to
any retained/shared database, preserve migration checksums and add a forward
migration in PR5a: leave existing evidence null, enforce evidence on all new
v3 inserts, and retain old audit rows unchanged. Do not rewrite old event hashes
or manufacture historical evidence. Escalate if actual retained history must
be recovered and no authentic evidence source exists. No production approval,
publication, acceptance backfill or public activation is authorized.

Validation in #151 must cover create H1 → update H2 → update H3 → approval,
with every earlier event still returning its own hash, including paginated
reads and identical-content edits. Cover all six mutation producers, rollback,
same-key replay, wrong same-document hash, cross-document/operational/missing
revision, missing evidence, conflicting JSON evidence, immutable evidence and
revision ownership/deletion, and both concurrent insert/edit orderings in real
PostgreSQL. Preserve node-free ADMIN/CSRF checks, private-field redaction and
v1/v2 behavior. Exercise fresh migration and the applicable retained-history
upgrade path; use isolated fixtures only. Run relevant backend/core tests,
DB/e2e, lint/typecheck/build, generated and format/boundary checks, then independent
review. Do not resolve the PR review thread solely because #156 is resolved.

Execution remains SERIAL, concurrency 1: #151 / PR5a (PR #155) → #152 / PR5b
→ #143 / PR5c after #38. Record this ADR amendment in the implementation branch
before changing production code. #152's acceptance/settlement contracts and
#38/#39's legal/public-launch gates are unchanged.

### Publication update entry and defensive locking — escalation #157

Decision: [#157](https://github.com/Studio81Labs/taven/issues/157), PR #155 at
`1d334c6`. Keep document-scoped serialization and the existing publication
lifecycle. Supported API and maintenance writers must acquire every required
LegalDocument lock before any publication row lock or mutation. A publication
UPDATE row trigger cannot establish that order: PostgreSQL already holds its
target tuple lock. Replace its blocking parent acquisition with a nonblocking
`FOR UPDATE NOWAIT` integrity guard. This follows the existing resource/price
binding trigger pattern; it does not introduce a new command service or global
publication mutex.

**Supported entry protocol.** Normal operator changes continue through the
existing authenticated, CSRF-protected, idempotent management APIs. Their
transaction acquires idempotency first, then the document `FOR UPDATE`, checks
expected generation, and only then touches publications. Controlled SQL
maintenance/backfill uses an explicit transaction and a separate, completed
`SELECT ... FROM legal_documents ... ORDER BY key FOR UPDATE` before any
publication `SELECT ... FOR UPDATE`, INSERT or UPDATE. A batch must know and
lock all affected document keys in canonical order up front; do not add parent
locks after child locks. Plain nonlocking reads may discover immutable subject
IDs, which must be revalidated after locking. Do not rely on CTE evaluation
order to establish the protocol.

After locking, obtain the database decision instant, revalidate current
lifecycle/generation, perform the transition and maintain its generation and
typed actor/reason/audit/command evidence atomically. Use the same transaction
through commit/rollback. Live historical backdating and fabricated approvals
remain forbidden; authentic offline restore is a separate operational process.
Document the SQL protocol as an administrative contract, not a new unauthenticated
HTTP route or a permission bypass.

**Database fallback.** In the publication BEFORE UPDATE path, reject immutable
identity/ownership changes first, then acquire the unchanged parent row with
`FOR UPDATE NOWAIT` before checking mutable interval/lifecycle facts or
performing predecessor effects. Missing parents still fail. A compliant writer
already holds that lock, so this adds no wait. An uncoordinated single-row
statement may succeed if uncontended, but that is not the supported maintenance
entry contract. If another transaction owns the conflicting parent lock,
reject immediately with SQLSTATE `55P03` and a stable legal-publication-specific
error identifier. Do not swallow the conflict, skip the locked row, return
success, retry within the trigger, or continue a partially failed transaction.

Keep the INSERT path's document-first acquisition: it runs before touching an
existing predecessor row. Its nested predecessor UPDATE uses the same NOWAIT
guard against the already held parent. Cancellation's AFTER trigger likewise
operates under that parent lock. Preserve every interval, no-overlap,
pending-schedule, pre-start cancellation, archive, predecessor-restoration and
immutable-history check. Keep the post-lock database clock and the actual
persisted transition instant used by audit; do not introduce a caller-controlled
clock. Delete remains forbidden. No blocking parent acquisition may remain on
the UPDATE trigger path, including nested predecessor updates.

**Failure contract.** Translate this specific guard conflict to HTTP 409 at the
legal command boundary if it reaches the API, after transaction rollback. Do
not translate all database failures, deadlocks or constraint violations to 409;
preserve unavailable-store 503 and existing validation/lifecycle errors. A
maintenance writer receiving the conflict must roll back the whole transaction
and re-enter through parent-first locking with freshly validated generation and
time. The API never reports a committed success or leaves audit/idempotency
residue from a rejected attempt. Completed replay remains unchanged. Routine
API-vs-API and compliant maintenance-vs-API contention waits at the document
entry lock; it should not depend on deadlock detection/retry.

This removes the publication-row → waiting-document edge that caused #157.
It is a defined protocol and defensive rejection, not a claim that arbitrary
multi-statement SQL, reversed cross-document lock acquisition, table-locking
DDL, disabled triggers or privileged restore can never deadlock. Those operations
must obey the declared lock order or run offline. There is no lock-ownership
inference from pg_locks, advisory-lock substitution, SECURITY DEFINER procedure,
role-provisioning migration or new public API.

**Validation and delivery.** #151 / PR5a / PR #155 owns the trigger, narrowly
scoped error mapping, SQL workflow documentation and real PostgreSQL tests.
Use coordinated independent connections/barriers rather than timing-only
sleeps. Reproduce the old cycle, then prove: an API-held document causes an
unordered direct UPDATE to fail with the identified 55P03 and the API can
finish; both parent-first API/maintenance arrival orders serialize; same- and
cross-publication cancellation/archive/replacement races cannot deadlock;
predecessor close/restore, missing/changed identity, exact-time boundaries,
rollback, generation, typed audit, replay and redaction retain their semantics.
Cover multi-document maintenance with canonical prelocking and independent
documents without global serialization. An expected 409 must not become 500,
and an unavailable database remains 503. Prove no partial intervals/audits or
idempotency completion after failure. Inspect all updated/nested SQL paths.

Amend the pending migration only if applied exclusively to disposable
local/test databases; otherwise append a forward migration without rewriting
checksums or retained data, as required by #156. There is no new table, column,
backfill, publication state or approval requirement. Update ADR and workflow
docs in the same existing PR; run relevant backend/core, DB/e2e, lint/typecheck/
build, generated, format/boundary checks and independent review. The isolated
architecture lock experiment is not a substitute for these implementation tests.

Resume orchestration #145 order 5, Epic phase 6: incorporate this ADR amendment
and implement the #157 fix in #151 / PR5a. Closing the escalation is architectural
resolution, not proof that PR #155 is fixed or merge-ready. Resolve its review
thread only with implementation evidence; merge after normal review/CI gates,
then begin #152 / PR5b. SERIAL/max1 and #38/#39 launch gates are unchanged.

## Alternatives and consequences

Keeping text in Git preserves revision history but requires deployments to
replace the active legal package. Updating one database document row would
destroy the text behind earlier acceptances. A generic CMS/editor and a
separate identity system would expand this request unnecessarily. The chosen
model uses the existing backend security and transaction conventions, with
immutable text and separate public validity intervals.

This introduces real migrations, protected management contracts, consumer
changes and an explicit legal-document lock rank. It also removes the
incidental coupling between new terms acceptance and immutable numerical
PriceList policy. These costs are necessary for safe version replacement;
they must ship with legacy, concurrency and settlement regression coverage.

No approval, effective instant, permission to publish customer work or
commercial promise is inferred from storage. Final #38 content remains the
external gate; #39 owns public activation.
