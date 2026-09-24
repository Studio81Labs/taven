# Web integration validation

This is the #144 browser evidence handoff for Epic #9. It separates fixture,
isolated real-API, and staging observations so a passing browser test is not
mistaken for a live provider or fulfilment shakedown. The current suites are
defined in `apps/web/playwright.config.ts` and `.github/workflows/web-ci.yml`.

## Validation profiles

| Profile               | Command / CI job                                                                                                                                                                                                           | What it proves                                                                                                                                                                                                                                         | What it does not prove                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic browser | `pnpm web:test:e2e`; Web CI `web: lint, typecheck, test & build`                                                                                                                                                           | Rendered navigation, forms, accessibility scans, consent and payment states against generated-contract fixtures; a separately launched normal build proves the default closed gate.                                                                    | Real API, database, storage, queues, providers or Orca.                                                                                       |
| Isolated real API     | Web CI `web: isolated real API browser checkout`                                                                                                                                                                           | Production-built Nuxt and Nest processes with PostgreSQL 18, pinned Silo S3 storage, fixture slicing and sandbox payment. Test-only legal revisions are published into that isolated database. Browser actions and database effects are both asserted. | Staging deployment, real Orca, Comgate, carrier, email or manual fulfilment.                                                                  |
| Staging smoke         | `INTEGRATION_TEST=true INTEGRATION_API_URL=https://api-staging.taven.cz INTEGRATION_WEB_URL=https://staging.taven.cz pnpm -C apps/web exec playwright test e2e/integration/real-api-journey.spec.ts --project=integration` | The deployed web/API upload, inspection, estimate and the _actual_ approval-gate state, if the environment is ready.                                                                                                                                   | An enabled checkout unless the staging switches/legal publications actually permit one; never mutate staging documents to make the test pass. |

The isolated job sets `INTEGRATION_REQUIRE_CHECKOUT=true`,
`INTEGRATION_COMPLETE_PAYMENT=true`, `INTEGRATION_COMPLETE_ASSISTED=true`,
`INTEGRATION_MUTABLE_FIXTURES=true` and `INTEGRATION_DATABASE_OUTAGE=true`.
Those mutable test helpers require the isolated CI database; they are not a
staging or production run mode. The default command intentionally skips the
integration profile when `INTEGRATION_TEST` is absent.

## #144 acceptance evidence

| Area                             | Browser and real-effect evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct upload to paid order      | The [real-API journey](../../apps/web/e2e/integration/real-api-journey.spec.ts) drives upload, STANDARD estimate, risk/configuration, binding/delivery, card or bank selection, sandbox webhook capture and server-confirmed order status. The [deterministic direct journey](../../apps/web/e2e/deterministic/direct-journey.spec.ts) and [payment outcomes](../../apps/web/e2e/deterministic/payment-outcomes.spec.ts) cover reload, storage denial, duplicate submit and failure variants.                                                                                                                      |
| Assisted entrance and handoff    | The [real-API assisted suite](../../apps/web/e2e/integration/assisted-real-api.spec.ts) proves one request through failed photo upload retry, retention, fit-sensitive handoff and painted-3MF handoff. The [deterministic assisted suite](../../apps/web/e2e/deterministic/assisted-journey.spec.ts) covers the no-file form, blocked model, capability and validation paths.                                                                                                                                                                                                                                     |
| Configurator and logistics       | The [estimate](../../apps/web/e2e/deterministic/automatic-quote-estimate.spec.ts), [multi-body](../../apps/web/e2e/deterministic/multi-body-configuration.spec.ts) and [delivery](../../apps/web/e2e/deterministic/configuration-delivery.spec.ts) suites cover all three quality choices, selected-quality server authority, stale responses, item quantity, express failure, Packeta cancellation/stale callback, endpoint re-quote and expiry. The real-API two-body case verifies separate configured items, compatible parcels, persisted slot allocation and capture; the direct journey covers no capacity. |
| Legal publication and retry      | [Legal-time browser tests](../../apps/web/e2e/deterministic/legal-time-enforcement.spec.ts) cover UTC eligibility, skew, SSR, exact text/hash and unavailable backend. The real-API suite covers optional photo consent, consent reset, scheduled activation, replacement, frozen accepted retry and a true PostgreSQL outage with zero acceptance/payment side effects after recovery. Backend PostgreSQL E2E supplies the document-lock and direct-SQL evidence under #152.                                                                                                                                      |
| Payment outcomes                 | Real-API card/bank capture, pending, decline, cancellation and retry are asserted through backend/provider-event handling. [Payment-outcome tests](../../apps/web/e2e/deterministic/payment-outcomes.spec.ts) cover forged success URLs, invalid capability, expired/mismatched state and errors. A success URL alone never establishes a paid order.                                                                                                                                                                                                                                                              |
| Accessibility and mobile         | [Accessibility/responsive tests](../../apps/web/e2e/deterministic/accessibility-and-responsive.spec.ts) run axe on critical routes and the configurator, check 375×667 overflow, assisted keyboard traversal and mobile checkout keyboard operation. Manual observations are recorded below. Prepared-design fidelity and numeric Lighthouse budgets are deferred by the owner.                                                                                                                                                                                                                                    |
| Analytics and diagnostic privacy | The real-API journey checks server-truth event deduplication and capture/order counts against PostgreSQL. The [browser diagnostic observer](../../apps/web/e2e/integration/browser-diagnostics.ts) checks URL/console surfaces in memory for known sensitive fixture markers and unexpected origins, and checks observation POST bodies by boolean-only assertions. It does not audit every possible log sink.                                                                                                                                                                                                     |
| Default closed build             | The [normal-build test](../../apps/web/e2e/integration/default-closed-normal-build.spec.ts) runs separately against a normal production build with draft-only content; neither upload-to-quote nor direct checkout becomes available.                                                                                                                                                                                                                                                                                                                                                                              |

The named tests are evidence for their stated boundaries, not substitutes for
the complete #144/#152/Epic acceptance audit. In particular, #152's retained
historical-payment wording must be reconciled with the owner's pre-production
no-new-legacy-work decision and Epic #10/#184's individual-origin payment
bridge; do not infer that a schedule assertion proves that bridge.
The real-API upload traverses signed PUT and confirmation; the
[backend payment E2E](../../apps/backend/test/checkout-payments.e2e.test.ts)
is the late-capture compensation evidence, not a browser/live-provider claim.

## Observed results and manual accessibility notes

On 2026-09-24 at merged commit `7f7ed622`, the final-head Web CI run for
[#244](https://github.com/Studio81Labs/taven/pull/244) passed 197 web unit
tests, the independently launched default-closed normal-build case, 63
deterministic browser cases (14 integration-profile skips), and
[12 isolated real-API browser cases](https://github.com/Studio81Labs/taven/actions/runs/35987883798/job/107594811180).
The same PR's web lint, typecheck, build, formatting and security checks passed.
Prior #243 CI ran backend real-PostgreSQL E2E and the DB-outage browser case;
the parent-run merged-main baseline for root lint/typecheck/test/build/format,
generated/workflow checks and deterministic browser is recorded in #145.

Manual pass on 2026-09-24 used Chrome for Testing 153 and macOS VoiceOver on
`https://staging.taven.cz`, without submitting a request, payment or legal
acceptance. The home accessibility tree exposed the skip-to-content link,
upload control and assisted entrance. The assisted page exposed a level-one
heading, labeled description/dimension/contact fields and separately labeled
required privacy acknowledgement versus optional photo-publication consent.
VoiceOver's caption panel announced the required description text area and
identified the dimension stepper with interaction instructions; keyboard Tab
reached a form stepper. VoiceOver was then turned off, and the Output Device
setting still read “System default,” matching its pre-check value. This is a
bounded screen-reader/focus observation, **not** a claim that every checkout
step was manually narrated or that staging completed payment.

The same staging visit showed the explicit not-yet-approved automatic-quote
message on the home page. The deployed commit/build identity was not checked
during this manual pass. A 2026-09-23 staging smoke reached the real API upload
and STANDARD estimate but stopped at the legal/commercial gate; that historical
result must not be counted as the isolated CI checkout proof above.
The earlier local Lighthouse mobile performance baseline was 88
(accessibility 100, best practices 96); numeric budgets are deferred until
the prepared-design phase and are not a core-functional pass claim.

## #39 / #40 rollout handoff

- For staging, record the deployed web and backend commit/image identities,
  effective legal publication and independent commercial/provider switches
  before claiming an enabled flow. Never promote isolated test-only legal
  publication helpers or mutable fixture flags to staging.
- Repeat the upload, risk, configuration, delivery, checkout and payment-return
  route against the actual deployed services. Preserve server-confirmed payment
  and order evidence, and check that browser/network diagnostics contain no
  customer content or capability tokens.
- #39/#40 own real Orca, payment provider, carrier, email, fulfilment and
  deployment/operations shakedown. Fixture slicing and sandbox capture are
  explicitly narrower. Production legal finalization and public activation
  remain their separate gates.
