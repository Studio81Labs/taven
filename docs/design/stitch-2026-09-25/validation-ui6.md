# UI6 final-design validation — ready-surface checkpoint

This is the first #270 checkpoint after UI1–UI4 on `main` at
`a4c44e626b42120a82e82b3ecbaca66c784e1abc`. It does not complete UI6 or
Epic #264. The functional `/nabidka/{quoteId}` consumer is still owned by #35;
UI5/#269 and the final offer evidence follow that merge. The numbered screenshots
are the visual lock. Product, API, legal and security corrections listed in the
[approved plan](../../plans/2026-09-25-final-web-design.md) are not optional
alternative layouts.

## Current route and reference matrix

The deterministic browser suite attaches full-page 390/768/1440 px screenshots
for the public rows below and tests 320 px overflow. Its fixture data is never
part of the normal default-closed build. The CI HTML report is retained as a
short-lived artifact; it is evidence for review, not public content.

| Reference             | Current route/state                                                                            | Implementation                                 | Evidence and intentional correction                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 landing            | `/`, empty upload                                                                              | UI1 #273, UI2a #275                            | `public-presentation.spec.ts`, `design-shell.spec.ts`; no fictitious instant binding price or public launch claim                                                                |
| 02 process            | `/jak-to-funguje`                                                                              | UI2a #275                                      | `public-presentation.spec.ts`; actual inspection, slicing, delivery and payment sequence                                                                                         |
| 03 pricing            | `/cenik`                                                                                       | UI2a #275                                      | `public-presentation.spec.ts`; no unapproved tariffs, discounts or delivery promises                                                                                             |
| 04–05 examples/detail | `/ukazky`, honestly empty; populated card/filter/detail in isolated component fixtures         | UI2a #275                                      | `public-presentation.spec.ts`, `PortfolioGallery.test.ts`; no stock photos or fabricated printed parts                                                                           |
| 06 assisted request   | `/poptavka`, form, photo, legal unavailable/draft, success                                     | UI2b #276                                      | `assisted-journey.spec.ts`, `accessibility-and-responsive.spec.ts`; human review, no automatic binding price                                                                     |
| 07 contact            | `/kontakt`                                                                                     | UI2a #275                                      | `public-presentation.spec.ts`; actual seller and contact details                                                                                                                 |
| 08 configurator       | `/objednavka`, upload, inspection, reference slicing, configuration, blocked/error states      | UI3 #277                                       | `configurator-presentation.spec.ts`, `automatic-quote-estimate.spec.ts`, `multi-body-configuration.spec.ts`; true server prices and infill, not mock prices                      |
| 09 checkout           | `/objednavka`, binding total, delivery, consent, payment choice                                | UI4 #278                                       | `accessibility-and-responsive.spec.ts`, `configuration-delivery.spec.ts`, `legal-time-enforcement.spec.ts`; Packeta and current legal revisions, no invented carrier or approval |
| 10 received/payment   | `/checkout/payment/{success,pending,cancelled}`, confirmed, pending, failure and refund states | UI4 #278                                       | `payment-outcomes.spec.ts`; server-verified payment state, no assertion from redirect alone                                                                                      |
| 16 terms              | `/vop`, actual draft/approved revision                                                         | UI2a #275                                      | `public-presentation.spec.ts`, `legal-time-enforcement.spec.ts`; draft is marked and fail-closed                                                                                 |
| 17 complaints         | `/reklamace`, actual draft/approved revision                                                   | UI2a #275                                      | `public-presentation.spec.ts`, `legal-time-enforcement.spec.ts`; no fabricated final approval                                                                                    |
| 18 privacy            | `/ochrana-soukromi`, actual draft/approved revision                                            | UI2a #275                                      | `public-presentation.spec.ts`, `assisted-journey.spec.ts`; immutable revision and visible draft state                                                                            |
| 19–22 system boards   | both shells, logo, tokens, actual menus/dialogs/status                                         | UI1 #273, UI2a/b #275/#276, UI3 #277, UI4 #278 | `design-shell.spec.ts`, `configurator-presentation.spec.ts`, `payment-outcomes.spec.ts`; real controls only                                                                      |

Other implemented policy pages (`/zakazany-obsah`, `/uchovani-dat`,
`/fotografie-a-duvernost`) use the same legal presentation, but do not have a
separate supplied numbered screen. Screen 05's populated public example detail
awaits approved public examples and assets (#38/#40); its component presentation
is exercised only with isolated fixtures. #42's sample/batch workflow and #52's
STEP capability retain their separate feature owners. Screens 11–15 remain
reference-only: tracking #41 and customer accounts #48 own those product
capabilities. The individual-offer
page has no exact supplied numbered screen; #35 must first provide the working
consumer, then UI5 #269 applies the same process/price/legal patterns.

## Checkpoint execution and limitations

- Browser: Playwright 1.63.0, pinned Chromium 153.0.0.0; fixture web/API on
  loopback. `pnpm web:test:e2e`: 88 passed, 14 real-API integration cases skipped
  by the deterministic profile. The skipped cases are not claimed as passed.
- `pnpm web:test`: 204 passed in 21 files. Web lint (zero errors, 493
  pre-existing Vue warnings), typecheck and build passed. The worktree-level
  root `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm boundaries:check`, `pnpm generated:check`, `pnpm format:check` and
  `pnpm ci:config:check` passed. The final merged-main rerun and isolated
  real-API journey remain for the final UI6 evidence after UI5.
- Keyboard/focus evidence: the mobile menu moves focus to its first link and
  restores the trigger on Escape; skip links focus main content; the assisted
  form and mobile checkout traverse and submit by keyboard. The loaded canvas
  has an accessible image label and accepts arrow-key focus while radio
  selection stays intact. Checkout consent and payment controls remain
  reachable at 375 px. These are automated checks, supplemented by visual
  inspection of the 1440 and 390 px landing in the shared browser.
- Public, assisted, configurator and checkout tests cover 320/375 px reflow.
  The 320 px viewport is the reflow equivalent of 200% zoom from a 640 px CSS
  viewport; literal browser zoom, manual screen-reader interaction, canvas
  semantics beyond its keyboard contract, Packeta's third-party widget and
  sticky-action interaction remain review limitations. Automated axe scans
  report no serious/critical findings on the public, loaded configurator and
  checkout states exercised by these tests. Real payment states and their
  screenshots are separately covered in `payment-outcomes.spec.ts`.
- The homepage Lighthouse runner uses a production-indexable **local fixture
  preview**, not a public deployment or provider shakedown. Its gate is 90 in
  each of performance, accessibility, best practices and SEO for mobile and
  desktop. Chrome 153/Lighthouse 13.4.1 local runs have varied: mobile
  performance 85–93, while all other category scores were 100 and desktop
  performance 99–100. The local Mac has not shown a repeatable mobile pass; no
  budget is lowered or success claimed from the best run. CI will enforce the
  unchanged target and publish its exact scores. Lighthouse is not the
  #141/#190 real-API estimate timing benchmark.

The owner-approved v0.1 legal baseline permits private testing, not public
commercial activation. Production content and launch approval remain #38/#39/#40;
this design checkpoint does not close Epic #9/#145. After #35/UI5, UI6 must run
the isolated automatic, assisted and offer real-API journey, reconcile #144/#152
coverage, complete manual interaction review, and record the final-head CI and
Codex-review result before closing #270.
