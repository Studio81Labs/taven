# Web integration validation

The browser integration profile runs the real Nuxt site against the real API;
it does not start the deterministic mock backend or fixture web server. The
test inspects the checked-in STL through the public page, waits for the API
estimate, verifies the STANDARD assumption, and asserts that the server's
checkout approval state is represented by either an enabled proceed action or
the explicit approval gate. With `INTEGRATION_REQUIRE_CHECKOUT=true`, it also
clicks through the real storage upload and asserts the configurator route.

Run against staging with:

```bash
INTEGRATION_TEST=true \
INTEGRATION_API_URL=https://api-staging.taven.cz \
INTEGRATION_WEB_URL=https://staging.taven.cz \
pnpm -C apps/web exec playwright test --project=integration
```

`INTEGRATION_REQUIRE_CHECKOUT=true` additionally requires the live environment
to expose the configurator proceed action. Without it, the test records the
legitimate server-side approval gate instead of treating a draft/legal
activation state as a browser failure.

On 2026-09-23 the staging run reached the real API upload and estimate path;
the page displayed the 300 CZK STANDARD estimate and the explicit
“Kalkulace čeká na schválení” disabled gate. API `/health` and legal-document
availability both returned 200. This is real staging evidence, not a mock
fixture result; final payment and checkout proof remains gated until the
staging legal activation is enabled.

The local Lighthouse run also reports the existing mobile performance baseline
of 88 (accessibility 100, best practices 96). Core functional closure does not
enforce the deferred numeric budgets; use
`TAVEN_LIGHTHOUSE_ENFORCE_BUDGETS=true pnpm web:lighthouse` when the
prepared design phase reopens the numeric budget.
