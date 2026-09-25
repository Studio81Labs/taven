# Final website design implementation plan

Planning baseline: merged `main` at
`1bc351508074127189aa2e24b6df3a9bf1d828f0` (2026-09-25).
[Design Epic #264](https://github.com/Studio81Labs/taven/issues/264) is the persistent
source of truth; [orchestration #271](https://github.com/Studio81Labs/taven/issues/271)
coordinates execution. This document mirrors the initial technical plan.
Subsequent approved issue amendments take precedence.

Implementation children: UI1 #265, UI2 #266 (two PRs), UI3 #267, UI4 #268,
UI5 #269 and UI6 #270. #271 is the orchestration child, not another feature.

## Outcome and scope

Apply the owner's supplied final visual system to the working customer website.
The owner has now authorized starting visual work alongside backend work; the
earlier requirement to wait until all core work finishes is superseded for this
workstream. Epic #9/#145 retain their existing functional closure obligations.
This design Epic does not make unfinished v1 features into new v0 blockers.

Deliver the public, legal, assisted-request, automatic-order and payment surfaces,
then style the individual-offer consumer owned by #35. Preserve existing routes,
API contracts and state machines. Every supplied screen is mapped below;
tracking/accounts remain feature-dependent deliverables under #41/#48, not mock
production pages. Public launch and final legal approval remain #38/#39/#40.

## Technical Implementation Plan

### 1. Current-state analysis

- Nuxt/Vue SSR with Tailwind Vite integration and locally packaged IBM Plex Sans
  and Mono. `apps/web/layouts/public.vue` owns navigation, footer, deployment and
  network status, and skip navigation. Public pages use utility styles while the
  order/request flows share `apps/web/assets/css/application.css`.
- `/` already uploads and hands session state to `/objednavka`. That single route
  owns upload, geometry, slicing, configuration, Packeta selection and checkout;
  screens 08/09 are views of this existing flow, not a new router/state machine.
- `QuoteConfigurator.vue`, `CheckoutPanel.client.vue`,
  `DeliveryPointPicker.client.vue`, `ModelPreview.client.vue` and
  `PaymentReturnPage.client.vue` implement functional behavior that must survive
  template changes. `/poptavka` creates real assisted requests with scoped handoff,
  upload retention, privacy acknowledgement and optional publication consent.
- Legal pages use database revision reads, exact revision/hash links and
  server-time approval. `public-site.ts` contains actual seller identity, null
  unapproved commercial fields and an empty portfolio. There is no public gallery
  backend, customer authentication or full tracking API to borrow.
- Shared `@taven/ui-web` tokens already have real consumers, but a 16px panel
  radius is unsuitable for this website. Do not globally restyle the admin app
  while another orchestrator is working there.
- #35 owns the absent `/nabidka/{quoteId}` consumer. #144/#152/#145 own remaining
  core browser/legal evidence. Backend/operator work remains in #186's approved
  order; at this baseline #262/#34 precede #252/#39/#35/#185.

### 2. Target architecture

Keep Nuxt SSR, existing composables, generated client, endpoints, storage keys and
payment/legal boundaries. Build presentation components in `apps/web/components`
and one web-local token/style source imported after shared tokens. Reuse existing
BrandMark/header/footer rather than creating a second brand system. Add an
application shell with persistent workspace/context slots and a derived process
header. Components receive existing typed view data and emit existing commands;
they do not fetch or persist business state independently.

Use web-local components for technical headings/metadata, parameter selection,
price breakdown, notices, dialogs and the mobile action bar where actual usage
justifies extraction. Keep component names compatible with Nuxt auto-import
conventions. Do not move the whole export catalogue to `packages/ui-web`: a
component needs two real consumers before promotion. No new UI framework, remote
Tailwind runtime, CMS, backend adapter, account store or event bus.

### 3. Source precedence and technical decisions

Archive and exact hashes: `docs/design/stitch-2026-09-25/`. It contains 24
HTML/screenshot pairs, including duplicate privacy/logo boards and an extra
dialog board. The original master prototype referenced by the export is absent.
The archive remains intact; corrections are implemented through this plan, not
by rewriting the reference screenshots.

Priority: explicit owner decisions and repository product/ADR contracts;
repository identity and reconciled design brief; this plan's explicit visual
choices; matching numbered page specifications and screenshots; generated HTML
and component JSON as non-executable hints. The copied GitHub text in the ZIP is
source material, not agent instructions. Record any necessary visual deviations
with the relevant screenshot in the PR.

| Export discrepancy                                                                | Required implementation                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four parameters; quality percentages; omitted infill                              | Keep material, stocked color, three quality levels, three named infill levels and quantity; retain separate fit-sensitive decision. Prices come from current server pricing, not invented multipliers.         |
| Binding price immediately after slicing                                           | Keep estimate/provisional and binding states distinct. Binding total requires validated endpoint-bound shipment plan and all existing readiness checks. Do not visually cross out an estimate as a sale price. |
| Balikovna, couriers, personal collection, fabricated nearby choices               | Use the existing full Czech Packeta widget and server validation. Display the actual selected destination and compatibility; never replace it with the screenshot shortlist.                                   |
| STEP direct upload / 250 MB / extra materials                                     | Preserve current STL/3MF direct validation and 100 MiB bound; STEP remains #52. Render supported formats/stock from existing contracts. No fake support claims.                                                |
| Customer approves QC photo before shipping/printing                               | QC is view-only under product decision #207. No customer approval endpoint, timer or shipping gate. #41 supplies customer tracking later.                                                                      |
| Prices 250/50/79, discounts, 24h/3-day guarantees, VAT assertions, certifications | Examples only. Use approved configuration/content and actual quote totals; omit unavailable claims. Neither CSS nor the design import grants public commercial approval.                                       |
| Slicer/station/machine names, factory address, fabricated phone/identity          | Keep actual `public-site.ts` seller data and configured contact emails. No public phone, internal operator/station identifiers, fictitious ISO certification or precision guarantee.                           |
| Static VOP/privacy text and retention dates                                       | Style the existing immutable revision renderer for all six legal documents. Never import the mock text as approved content or change retention policy.                                                         |
| Passwordless archive, reorder and settings                                        | Existing #48 owns authentication, ownership proof, deletion and current-price reorder. No account navigation or post-payment signup CTA until that feature is actually available.                              |
| Portfolio records and remote photos                                               | Build presentation/empty/error states with isolated fixtures. Production remains empty until permitted real material exists. No permanently copied customer-photo gallery or presumed consent.                 |
| Contradictory logos and low-contrast token variants                               | `TAVEN.` and `TV.` in Plex Mono 600; ink-3 `#66675F`, warning `#925B10`; ignore the Sans/[T.] alternative and inaccessible older colors.                                                                       |

### 4. Detailed implementation design

**Visual primitives.** Use paper `#EFEFEA`, surface `#FFFFFF`, context surface
`#F7F7F4`, preview `#F7F7F3`, field `#FCFCFB`, ink `#1A1A16`, secondary ink
`#54554C`, tertiary ink `#66675F`, rule `#D9D9D2`, strong rule `#C9C9C1`, accent
`#1B44E8`, accent hover `#1236C4`, warning `#925B10`, stop `#B4441A`, success
`#25705A`. These keep the repository's accessible corrections and existing hover.
Use semantic CSS variables, mapped to existing aliases while components migrate.
Override web panel radius to zero locally; do not mutate admin's global token
contract. All owned form/dialog/card corners are square. Use borders and planes
instead of shadows; selected controls combine accent border, inset 2px left mark,
text and native checked/selected semantics.

Plex Sans 400/600 handles prose; Plex Mono 400/600 and tabular figures handle
amounts, dimensions and metadata. H1 maximum 38px desktop / 28px mobile; body
15px/24px; legal 15px/25px with approximately 660px reading width. Use at least
12px for functional labels/metadata, correcting the export's 9–10px labels.
Spacing is a 4px scale. Tap targets are at least 44px, primary buttons 48px.
Validate actual contrast/focus rather than relying on the reference token names.

**Layout.** Cap the main sheet at 1440px. Public pages use upload-first asymmetry,
indexed navigation and the full title-block footer. Order screens retain a
stable two-column shell above 960px, with the screenshot's approximately 7:5
workspace/context proportion (`minmax(0,7fr) minmax(320px,5fr)`). Context uses one
continuous `surface-2` plane across upload/configuration/checkout; reserve space
for loading to avoid removing/reinserting the entire panel. At 960px and below,
place model above controls. At 640px and below use the compact indexed menu,
`02 KONFIGURACE / 05` context, compact footer and safe-area-aware sticky action
bar. Use a 260px mobile preview at 390px; allow it to grow for zoom/long metadata
without hiding controls. Test 320/375, 390, 768 and 1440px. Grid 16/80px is limited
to the model drawing surface and removed on narrow mobile; never under legal
prose. Dimension annotations must come from real geometry, not fake tolerances.

**Shell state.** Derive active step, item count and summary from the existing
flow. Never create an Order number before one exists. Completed steps may invoke
only existing safe edit actions; future steps are not arbitrary navigation.
The menu supports Escape, focus return and keyboard access. Moving templates
must not remount the model viewer or duplicate polling/upload watchers. A mobile
CTA invokes the same guarded function as the desktop CTA, with one visible
interaction target per layout and the same pending/disabled state.

**Upload/configuration.** Preserve empty, parsing, estimate, uploading, queued,
slicing, ready, blocked mesh, units/preflight question, multi-body/item grouping,
expiry and recoverable-error states. Progress is real; no simulated slicer clock
or fabricated geometry diagnostics. Keep selected-quality server-price priority,
generation/abort guards, retry identity and storage-denial recovery. Show all
required server findings with explicit unchecked decisions; do not truncate
blocking findings merely to fit a three-card mock. Unsupported geometry/unit
transformation still follows existing handoff; a visual modal does not authorize
new model mutation. Keep unavailable stock/Express hidden and no-capacity paths
actionable. Quantities and item comparisons retain actual server semantics.

**Checkout/payment.** Style the existing picker/summary/contact/billing/legal
form. Do not reduce billing to the screenshot's three fields or add Apple/Google
Pay as independent methods absent from the provider contract. Preserve quote
expiry/requote, destination invalidation, full billing validation, explicit terms
and withdrawal acknowledgement, independent optional photo consent, pending
submission guards and frozen retry body. Capture—not the success URL or a local
timer—authorizes paid copy. Keep pending, declined/retry, cancelled, unavailable,
late-compensation and reload states. A paid state must not claim production,
email delivery, shipment or account creation beyond available server evidence.
Do not add fetches to operator fulfilment endpoints to fill a receipt mock.

**Public/legal/assisted.** Keep route paths and metadata. Restructure existing
content into the supplied visual hierarchy while retaining accurate current
claims and closed-gate messaging. `LegalPlaceholderPage.vue` may retain its name;
style it without renaming its revision/approval behavior. Legal TOC anchors derive
from the loaded revision sections; draft/historical/unavailable labels remain.
The three extra legal routes absent from the ZIP use the same document template.
Complaints support copy may link existing contact/legal guidance; no new claims
submission backend is implied. `/poptavka` keeps its actual fields, supported
attachments/limits, inline errors, handoff, submitted reference and safe retry.
Do not add the mock's unsupported PDF/ten-attachment contract or response SLA.

**Portfolio.** Use presentational list/filter/detail components with explicit
props: public display ID, title, optional human description, material/category,
optional approved manufacturing metadata, and images with alt text and dimensions.
No private IDs, customer identity, retention holds or consent evidence belongs in
public props. Filters operate on supplied permitted entries; hide unsupported
filters rather than fabricate taxonomy. Use a 4:3 card image and 16:10 detail
image, 3/2/1-column responsive list, empty result and unavailable image states.
Test those components via isolated test mounting/fixtures, not a public demo route
or a production fixture flag. Keep the live `/ukazky` empty state; no source photos
were supplied. A future public detail `/ukazky/[slug]` must resolve only permitted
entries and return 404 otherwise. Customer-derived assets cannot be statically
exported until expiry/revocation removal is designed and approved; source consent
alone is insufficient. This work adds presentation readiness, not a publishing
service. Approved owner-created non-customer assets may be added through explicit
content review without inventing a customer-order publication path.

**Dialogs/feedback.** Reuse existing inline errors as the primary failure message.
Introduce an accessible dialog only for a real current action, with labelled
title, trapped focus, safe initial focus, Escape and focus return. Notifications
must not be the sole place to report a blocking/legal/payment failure. Polite
live regions announce status once; critical errors stay visible. Reduced motion
disables nonessential animation. Account deletion/QC controls shown on board22
are not authorized implementations in this phase.

### 5. Screen and component map

| Reference                      | Target / owner                                                | Delivery boundary                                                                             |
| ------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 01                             | `/`, `HeroUpload.vue`, public shell                           | UI1/UI2; preserve upload session handoff                                                      |
| 02/03/07                       | `/jak-to-funguje`, `/cenik`, `/kontakt`                       | UI2; approved content only                                                                    |
| 04/05                          | `/ukazky`, list/filter/detail presentation                    | UI2; real empty state plus isolated populated fixtures; public assets remain separately gated |
| 06                             | `/poptavka`, existing assisted composables                    | UI2b; real submit/partial failure/reference                                                   |
| 08                             | `/objednavka`, QuoteConfigurator/ModelPreview                 | UI3; all live states, not only the ready screenshot                                           |
| 09                             | Same route, CheckoutPanel/DeliveryPointPicker                 | UI4; keep one state machine and full Czech Packeta                                            |
| 10                             | `/checkout/payment/{success,pending,cancelled}`               | UI4; server-confirmed result and honest unavailable states                                    |
| 11                             | Customer tracking                                             | #41 owns contracts and working page; view-only QC design handoff, no v0 route now             |
| 12–15                          | Login/activation/history/settings                             | #48 owns contracts/routes; preserve guest access; no v0 mock account portal                   |
| 16/17/18 both variants         | `/vop`, `/reklamace`, `/ochrana-soukromi`                     | UI2; DB text, common legal template                                                           |
| Extra legal routes             | `/fotografie-a-duvernost`, `/uchovani-dat`, `/zakazany-obsah` | UI2; same template, preserve links                                                            |
| 19/20 both logo boards/21/22   | Responsive, brand, tokens, actual dialogs/status              | UI1–UI6 cross-screen requirements; not public catalogue routes                                |
| No exact supplied offer screen | `/nabidka/{quoteId}` from #35                                 | UI5; compose same process/price/legal patterns after functional consumer merges               |

### 6. Data and persistence

No database migration, new persistence model or legal-content import is required
for UI1–UI6. Preserve exact legal revision references, timestamps, quote/payment
identities and session handoff keys. Do not persist new customer models, tokens,
account data or fixture approvals. Screens cannot mutate accepted legal text.
Do not treat `Customer` contact rows as authenticated accounts. #41/#48 own their
future models and security planning before connecting those screens.

### 7. APIs, contracts and events

Keep generated OpenAPI untouched unless an independently approved feature changes
it. Adapt existing typed responses to view props without losing null/error states.
No new server endpoint or slicer contract is planned. Price, stock, eligibility,
Packeta validity, legal effectiveness and payment state remain server-owned.
Keep existing analytics event meanings and deduplication; header/footer remounts
must not double-count flow events. No new third-party analytics/fonts/images.
Do not expose bearer fragments or customer content in URLs, logs or screenshots.

### 8. Dependencies and integration boundaries

- UI1–UI4 may start immediately; no dependency on #38 production text, #39 public
  activation, #41, #48 or completion of #145.
- UI5 waits for #35's functional customer offer page. #35 is not reassigned and
  the admin/backend sequence is not reordered. Its owner may use merged UI1
  primitives; only one writer at a time touches the offer consumer/payment helpers.
- UI6 can validate the automatic/public surfaces before #35 arrives. Its offer
  portion and final current-scope design closure follow UI5. #144/#152 keep their
  existing integration obligations; link shared evidence instead of duplicating
  a competing browser harness or closing those issues automatically.
- #41/#48/#52/#42 retain their existing authorization/dependency gates. Missing
  v1 routes do not block this bounded design phase. Record this scope explicitly
  on closure; never claim every screenshot's business feature is operational.

### 9. Execution strategy

**HYBRID, maximum two useful implementation writers across coordinated streams:**
one serial website-design writer plus the independent backend/admin writer.
Within the design stream use **SERIAL/max1**, because shells, global CSS,
configuration and checkout are tightly coupled. Parallel frontend implementers
would add merge/review cost without stable enough file boundaries. Read-only
investigations/reviews may run concurrently under AGENTS.md model tiers.

Reserve `apps/web` visual components/styles and this design plan for the design
writer. Backend/admin owns its existing files, generated contracts and #35
consumer until handoff. Coordinate changes to shared tokens, generated clients,
payment helpers, CI and shared browser fixtures before editing. Do not reset,
rebase or deploy another session's worktree. PRs branch from current main and
merge serially after review; re-check actual API contracts at each handoff.

### 10. Dependency / execution graph

```text
UI1 foundation
  -> UI2a public/legal/portfolio presentation
  -> UI2b assisted request
  -> UI3 upload/configurator
  -> UI4 checkout/payment returns
  -> UI6 automatic/public validation checkpoint

existing #186 producer sequence -> #35 functional offer page
UI4 + #35 -> UI5 offer presentation
UI5 + earlier UI6 checkpoint -> UI6 final design validation

#41 tracking / #48 accounts / #52 STEP / #42 sample-batch
  consume design references within their own later feature plans
```

### 11. Implementation phases

1. Merge the planning/reference artifact; implement UI1 primitives/shells against
   current pages and capture baseline screenshots before visual changes.
2. Apply UI2 public/legal content and assisted forms; develop missing portfolio
   presentations using isolated fixtures without needing real customer assets.
3. Apply UI3 across upload/configuration states, then UI4 checkout/returns, keeping
   functional tests passing per increment.
4. Run UI6's ready-surface validation; do not wait idle for backend work. After
   #35 merges, apply UI5 and finish UI6 integrated acceptance.
5. Record #41/#48 design handoffs and production-content limits. Design completion
   does not authorize public launch or close Epic #9/#145 automatically.

### 12. PR boundaries

| Unit | Focused PR(s)                                                                                  | Main file ownership                                                        |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| UI1  | Tokens, logo, public/application shells, responsive navigation, footer and feedback primitives | web styles/layouts/components; no business composable rewrite              |
| UI2a | Public, pricing, contact, legal, portfolio presentation and visual fixtures                    | public pages/content rendering/components; no legal text/approval mutation |
| UI2b | Assisted-request visual form and states                                                        | `/poptavka`, form-specific presentation/tests                              |
| UI3  | Upload/configurator, model drawing frame, items/risk/quantity, responsive context              | `/objednavka`, QuoteConfigurator, ModelPreview and local styles/tests      |
| UI4  | Packeta checkout, contact/billing/consent, result states and mobile CTA                        | CheckoutPanel, DeliveryPointPicker wrapper, PaymentReturnPage              |
| UI5  | Adapt merged #35 offer consumer to the same final design                                       | offer presentation; retain #35 business logic/contracts                    |
| UI6  | Cross-screen visual/a11y/performance evidence and CI enforcement                               | existing E2E harness, Lighthouse runner/workflow, validation documentation |

Do not combine these into one page-rewrite PR. Include focused behavioral and
visual checks with every PR; UI6 is reconciliation, not permission to defer all
tests until the end. A small extra PR is acceptable for a directly exposed defect
without changing the approved scope or dependency order.

### 13. Testing strategy

- Preserve current Vitest/composable and deterministic browser tests. Add
  component/interaction checks when markup changes keyboard behavior, selection,
  dialogs or idempotent actions; avoid tests that only mirror class names.
- Review and capture 390/768/1440 screenshots for each implemented route and
  critical state. Exercise 320/375px overflow, 200% zoom, keyboard-only operation,
  reduced motion, long Czech names/prices/errors and empty/loading/offline states.
  Screenshots compare hierarchy, typography, spacing, planes and geometry;
  documented contract-driven copy differences are expected.
- Use deterministic fixture data and pinned fonts/browser/viewport. Disable only
  nonessential animation and mask unstable sensitive values, never a missing
  component or functional error. Baseline updates require visual review against
  the supplied screen, not automatic acceptance of every new screenshot.
- axe: no unresolved serious/critical findings on public, loaded configurator,
  consent/checkout, payment and actual dialogs; document manual canvas/Packeta
  limitations and focus behavior. Keep legal links reachable, mobile CTA clear
  of content/keyboard and selection understandable without color.
- Per increment: `pnpm web:test`, `pnpm web:lint`, `pnpm web:typecheck`,
  `pnpm web:build`, relevant `pnpm web:test:e2e`, changed-file formatting. Run
  `pnpm ci:config:check` for workflow changes and `pnpm generated:check` when
  integrating a contract producer. Use the existing harness, not a second runner.
- UI6 re-enables the previously deferred homepage Lighthouse gate: performance,
  accessibility, best practices and SEO each >=90 in both mobile and desktop
  profiles using `TAVEN_LIGHTHOUSE_ENFORCE_BUDGETS=true pnpm web:lighthouse` on
  the documented production build. The current runner targets `/` with fixture
  API; report it honestly. Dynamic private/noindex pages get functional/a11y and
  visual checks, not misleading public SEO targets. Preserve #141/#190's distinct
  real-API estimate latency contract; Lighthouse is not its replacement.

### 14. Integration validation and rollout

Orchestrator personally runs the decisive checks on merged main: meaningful root
lint/typecheck/test/build/format/boundary checks, deterministic browser suite,
normal default-closed build and isolated real-API automatic upload/configure/
delivery/consent/payment flow. Coordinate shared #144/#152 offer/legal runs once
#35/UI5 are present. Record exact commits, commands, fixture/real profiles and
skips; production provider shakedown remains #39/#40. Reuse backend evidence only
with attribution, not as a new parent-executed pass.

Develop with approved immutable v0.1 legal content and authorized private
commercial configuration. Missing production text/assets is not a coding gate;
production approval stays closed. Keep deployment banners and noindex behavior.
No production demo switch or fabricated effective record is allowed.

Preview each merged visual increment in the existing deployment workflow and
verify responsive screenshots there. No new topology is needed: Compose is local
development; staging/production remain Coolify-managed. Roll back a visual release
by redeploying the previous reviewed web image; there are no migrations or new
stored-state formats to undo. Do not roll back backend legal/payment invariants.

### 15. Escalation and local discretion

Resolve component naming, scoped CSS, spacing within the chosen scale, line
wrapping, accessible focus details, fixture construction and faithful Czech copy
locally. Record screenshot corrections and unverified content as omissions or
honest states. No further owner input is required to begin UI1–UI4.

Escalate before changing architecture, domain invariants, persistence, public API,
security, concurrency/lifecycle, backward compatibility or core behavior. In
particular: new customer authentication/tracking authorization; publishing
customer assets without revocation/expiry; new currencies/tax/delivery/price
rules; QC approval; units mutation; account deletion; stored-token changes;
reorder from retained claim artifacts; any need to bypass content gates or alter
the #35 contract. A reproducible Lighthouse/estimate target miss that needs a
budget change also requires explicit resolution, not disabled assertions.

### 16. Definition of done

- [ ] UI1–UI6 delivered through reviewed focused PRs with no blocking review
      threads and required CI passing; final-head Codex approval recorded.
- [ ] Every current-scope route/state mapped to screenshots and behavior evidence;
      all reference variants reconciled using the explicit decisions above.
- [ ] Core upload, multi-item, Packeta, legal, payment and assisted flows remain
      real and pass relevant regression/integration checks; #35 offer design is
      validated after its producer handoff.
- [ ] Final design/mobile accessibility/Lighthouse evidence is attached; no
      runtime result is claimed by the planning-only reference PR.
- [ ] No fabricated marketing/legal/portfolio facts, mock accounts, external
      image dependencies, private factory details or unsupported controls published.
- [ ] #41/#48/#52/#42 retain explicit future feature ownership; the handoff says
      which screens are reference-only and which routes actually work.
- [ ] #9/#145 core closure and #38/#39/#40 production activation remain distinct.
      Completing this phase does not claim all v1 features or public launch are done.
