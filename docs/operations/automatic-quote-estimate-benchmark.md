# Automatic estimate calibration and browser-timing record

This record documents the immediate STANDARD estimate's accuracy evidence and
the browser-visible timing protocol for #141 without changing the estimate
contract or pricing policy. The HTTP samples below are useful operational
evidence, but they do not substitute for the browser parse-complete → visible
estimate measurement.

## Representative run

Run date: 2026-09-22 (Europe/Prague)

Host/device: Mac Studio Mac13,1, arm64, Node.js v24.15.0. The API ran as a
warm local Nest backend against the repository's PostgreSQL/Redis development
services. The comparison slice is the reviewed Linux/amd64 OrcaSlicer 2.4.2
corpus result; the benchmark does not substitute a browser mock for slicer
output.

Fixture and assumptions:

- `tools/slicing-fixtures/fixtures/single-pla/cube.stl` (20 × 20 × 20 mm,
  8,000 mm³, fixture SHA-256 `25180bbac89a3ad812538e23447b6556c9684b278aec45ca7e015eef21730120`)
- material `PLA`, quality `STANDARD`, infill `STANDARD`, quantity `1`
- price list `automatic-v0-czk`
- selected print configuration revision
  `92222222-2222-4222-8222-222222222222`
- selected STANDARD reference profile
  `61111111-1111-4111-8111-111111111111`
- OrcaSlicer 2.4.2, profile bundle
  `80de8b9bfffe3452b8202ed76e3a4bba73b2108e436900930c46a032e3481962`,
  runtime image `sha256:9b2d78073d052b6caa31303c21bf1da88201ec73ef0a523ded078c655c847953`

The reproducible slice evidence is recorded in
`tools/benchmarks/standard-cube-slice.json`: 1,262 seconds and 3.93 g of PLA,
with normalized G-code hash
`f1f03d6131d662aacde05abc34947d79f977ac84ae9e4bb76182637c43736257`. The
slice uses the checked-in cube and OrcaSlicer 2.4.2 runtime, with the resolved
process profile's brim width set to 0 and sparse infill density set to 20% to
match seeded print configuration revision
`92222222-2222-4222-8222-222222222222`. The benchmark feeds those
immutable slice metrics through the same `prepareAutomaticQuote` path used by
the automatic binding price, so the comparison does not introduce a second
pricing formula.

The effective process profile is reproducible from the checked-in resolved
profile by changing only `brim_width` from `5` to `0` and
`sparse_infill_density` from `15%` to `20%`. The
fixture records the source digest, effective digest, override, and exact
generation command. The runtime profile bundle itself remains unchanged.

## Results

The estimate returned `30,000` minor units (300 CZK), including the configured
minimum-print and small-order floor. The accuracy comparison therefore uses
the non-floor `ITEM_PRODUCTION` component: the estimate returned `4,066` minor
units and the same-assumption slice-derived production component was `4,787`
minor units, delta `-15.06%`, within the ±20% target. The customer totals are
also recorded for checkout context but are not used to hide estimator error
behind the order floor.

Four warm HTTP samples after one warm-up request measured 127.22, 130.53,
147.15 and 133.99 ms. Median warm latency was 132.26 ms; this is network
evidence only. It is not a browser parse-complete → visible
acceptance result and must not be read as passing that gate. The p95 of this
small sample was 145.18 ms and is retained as an operational observation, not
as a customer-facing performance promise.

## Browser-visible measurement

The reference acceptance gate is a warm median ≤200 ms from browser-recorded
geometry parser completion to the first animation-frame opportunity after the
matching numeric estimate and assumptions are committed to the visible DOM. The
run uses the same cube and STANDARD assumptions as the calibration above, one
excluded warm-up selection, then four consecutive successful selections on a
foreground Chromium Desktop profile at 1280 × 800. It must use a production
build of Nuxt and Nest on loopback, real isolated PostgreSQL/catalog/limiter
state, and no mock response or quota bypass. The test records parser,
post-parse scheduling, request/response, response-to-render, total and maximum
for every sample using the browser's monotonic clock; Playwright assertion
polling is not part of the measured interval.

The opt-in harness is
`apps/web/e2e/integration/automatic-quote-estimate-timing.spec.ts`. Start the
production web and API on loopback with the isolated development database, then
run:

```bash
INTEGRATION_TEST=true \
INTEGRATION_BENCHMARK=true \
INTEGRATION_BENCHMARK_LOCAL=true \
INTEGRATION_WEB_URL=http://127.0.0.1:3000 \
INTEGRATION_BENCHMARK_SAMPLES=4 \
pnpm -C apps/web exec playwright test \
  e2e/integration/automatic-quote-estimate-timing.spec.ts --project=integration
```

The same command against `https://staging.taven.cz` is a separate operational
observation: omit `INTEGRATION_BENCHMARK_LOCAL=true` so the run reports remote
latency without enforcing the local gate. Remote ingress/network latency is
reported honestly and is not used as the local ≤200 ms acceptance gate or a
customer-wide SLA. Failed, gated, rate-limited or incomplete runs are not timing
samples.

## Reproduction

Start the local backend on port 3011 with the development database, then run:

```bash
DATABASE_URL=postgresql://taven:taven@127.0.0.1:5435/taven \
TAVEN_ESTIMATE_URL=http://127.0.0.1:3011/automatic-quote-estimates \
TAVEN_BENCHMARK_SAMPLES=4 \
pnpm exec tsx tools/benchmarks/automatic-quote-estimate.mts
```

The HTTP harness is intentionally read-only apart from the endpoint's existing
anonymous estimate limiter. It reports the selected profile/configuration,
latency samples, estimate amount, slice-derived amount and percentage delta. The
browser harness likewise uses the normal limiter; an aborted transmitted
request may consume allowance and is never treated as refunded.
