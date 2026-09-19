# Development legal baseline v0.1

Status: owner-approved for implementation, development and staging only.
Counsel status: **NOT YET REVIEWED**. This is not a production legal release.

Source: [explicit owner decision in #38](https://github.com/Studio81Labs/taven/issues/38#issuecomment-5744707749).
It supersedes the earlier production-approval prerequisite for #143 / PR5c.
#38 remains open for production readiness; #39 owns public activation.

## Approved package

Approved by Studio81 Labs, s.r.o., product owner, for development/staging use.
Permanent document IDs and existing API keys remain unchanged.

| API key           | Permanent document ID             | Development revision code                 |
| ----------------- | --------------------------------- | ----------------------------------------- |
| terms             | terms-of-service                  | terms-of-service-cs-v0.1                  |
| claims            | complaints-policy                 | complaints-policy-cs-v0.1                 |
| privacy           | privacy-policy                    | privacy-policy-cs-v0.1                    |
| prohibitedContent | prohibited-content-policy         | prohibited-content-policy-cs-v0.1         |
| retention         | retention-policy                  | retention-policy-cs-v0.1                  |
| photoConsent      | photo-consent-and-confidentiality | photo-consent-and-confidentiality-cs-v0.1 |

Use the current repository draft text, frozen into the exact package committed
for PR5c. The inspected source is `apps/web/content/legal-drafts.ts` at main
`e2343c42290feef1ff1ef45da1694106906b59e3`; reconcile intervening edits and record
the actual source and package commit. Mechanical conversion to the existing
structured content format is allowed; it does not authorize rewriting legal
substance or inventing missing values. Record title, summary, sections and each
canonical content hash. Resolve the immutable commit before performing import;
do not refer to a moving branch as the content identity.

The owner authorizes assigning an actual timezone-aware effectiveAt during
import into each development/staging environment. Normalize the instant to UTC
without changing it, record it in the import receipt, and retain it on replay.
No timestamp is assigned by this document; the owner's example is illustrative.
Separate environments may have different recorded import/effective instants.
No counsel evidence is inferred. Approval evidence identifies the owner decision,
exact package/hash, target environment and development/staging-only scope;
the actual authenticated operator and database approval time remain recorded.

Once approved, the v0.1 text, code, hash and evidence are immutable. Subsequent
changes use new records/codes. Historical acceptances and order references keep
their exact original revisions. Preserve the existing purpose-specific pinning
and acceptance times: this decision does not move acceptance to Order creation,
attach all six policies to every Order, or backfill historical evidence.

## PR5c implementation boundary

Continue #143 / PR5c after merged #152 / PR #158. Reuse the protected management
API's ordinary create/read/approve/publish commands, idempotency, expected
hash/generation checks and immutable audit trail. No schema change, new public
contract, automatic approval seed, NODE_ENV-based approval, trigger bypass or
weakened server-time rule is authorized. Ordinary migrations/seeds still create
only unapproved drafts. A database APPROVED state records the supplied scoped
owner approval in the explicitly selected environment; it is not counsel or
production approval.

Import is explicit and restricted to an isolated development/staging target.
Any convenience command must require the target/environment explicitly, verify
it against configured non-production destinations, reject unknown/production
targets before writes, and never log credentials. Do not classify an environment
from NODE_ENV alone: a staging application may run a production build. Use the
existing authentication/CSRF/permissions; do not fabricate an approver identity.
If a real target is not provisioned, deliver and validate the reproducible
workflow against an isolated local target and leave actual staging execution to
its authorized operator; no production credentials are needed to implement PR5c.

Record a per-document receipt containing environment identity (no secrets),
source/package commit, code, revision UUID, hash, effectiveAt, approval actor/time,
publication result and audit references. Idempotent retry reuses the recorded
payload/result; it never resamples effectiveAt or overwrites an approved code.
If partially completed, reconcile each document and resume only missing steps.
Do not enable affected test journeys until their complete required package and
independent configuration are ready.

Keep development/staging access restricted, display its non-production scope,
and prevent indexing. Existing fail-closed production defaults remain. Before
production activation, #39 must verify the selected/current and scheduled legal
package is the separately approved production release and reject these six
v0.1 codes as production policy. A build mode, APPROVED flag or valid effective
instant alone cannot satisfy that release gate. Do not promote development
DBs, credentials or commercial settings into production as a shortcut.

Current commercial configuration is authorized for development/staging tests
of pricing/explanations, lead times, shipping, Express and permission handling.
Keep those values configuration-driven where practical. This does not change
production marketing approval, grant asset-publication permission, or authorize
live customer/provider side effects; retain isolated test identities/providers
and the existing confidentiality and permission checks.

## Validation and handoff

PR5c proves the actual six-document baseline import, repeat/partial-failure
recovery, immutable content/hash, exact served/accepted references, timezone and
future-time enforcement, and replacement by a distinct later test revision while
old order/acceptance links remain resolvable. Test wrong-environment refusal,
production defaults/readiness rejection, staging identification/noindex, public
text/checkbox behavior, and existing settlement/replay and portfolio-permission
rules. No production v1.0 approval fixture may escape the isolated test database.
Run relevant backend/API/DB and web/browser checks plus repository validation
for changed surfaces and independent review. Record actual outcomes.

#143 may close after its baseline and integration acceptance criteria pass;
production legal release is no longer its completion prerequisite. #145 remains
SERIAL, maximum implementation concurrency 1. Follow-on implementation is not
blocked by production review. Public launch and remaining legal approval stay
open in #38/#39.

## Production release

Before #39 authorizes public activation, all six documents receive final review;
new production text contains no unresolved placeholders/development notes; new
immutable revision records/codes (expected v1.0) have their own actual effective
timestamps and required owner/counsel evidence; production commercial claims
are explicitly approved; asset publication has recorded permission and honors
confidentiality. Never edit or relabel v0.1 into v1.0. Use the existing publication
replacement lifecycle and retain historical evidence. New legal requirements
that change contracts, consent or lifecycle still require architectural escalation.
