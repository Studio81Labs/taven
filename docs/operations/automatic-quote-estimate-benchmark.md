# Automatic estimate calibration record

This record closes the measurement obligation for #141 without changing the
estimate contract or pricing policy. It compares the immediate STANDARD
estimate with a real OrcaSlicer reference result generated from the exact
STANDARD 20% process configuration selected by the estimate endpoint.

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
  `00451f99-2f50-4358-8015-bbce478db957`
- selected STANDARD reference profile
  `61111111-1111-4111-8111-111111111111`
- OrcaSlicer 2.4.2, profile bundle
  `80de8b9bfffe3452b8202ed76e3a4bba73b2108e436900930c46a032e3481962`,
  runtime image `sha256:9b2d78073d052b6caa31303c21bf1da88201ec73ef0a523ded078c655c847953`

The reproducible slice evidence is recorded in
`tools/benchmarks/standard-cube-slice.json`: 1,262 seconds and 3.93 g of PLA,
with normalized G-code hash
`e9132ced540121135e8eb50c35226656ed93eb3315efd9486ac48116a3b5738b`. The
slice uses the checked-in cube and OrcaSlicer 2.4.2 runtime, with the resolved
process profile's sparse infill density set to 20% to match print configuration
revision `00451f99-2f50-4358-8015-bbce478db957`. The benchmark feeds those
immutable slice metrics through the same `prepareAutomaticQuote` path used by
the automatic binding price, so the comparison does not introduce a second
pricing formula.

## Results

The estimate returned `30,000` minor units (300 CZK). The same-assumption
slice-derived price was `30,000` minor units: delta `0.00%`, within the ±20%
target.

Four warm HTTP samples after one warm-up request measured 230.91, 149.41,
149.56 and 143.60 ms. Median warm latency was 149.56 ms, meeting the ≤200 ms
post-parse target. The first sample includes connection/pool warm-up; the
reported target is the median of the subsequent warm path. The p95 of this
small sample was 230.91 ms and is retained as an operational observation, not
as a customer-facing performance promise.

## Reproduction

Start the local backend on port 3011 with the development database, then run:

```bash
DATABASE_URL=postgresql://taven:taven@127.0.0.1:5435/taven \
TAVEN_ESTIMATE_URL=http://127.0.0.1:3011/automatic-quote-estimates \
TAVEN_BENCHMARK_SAMPLES=4 \
pnpm exec tsx tools/benchmarks/automatic-quote-estimate.mts
```

The harness is intentionally read-only apart from the endpoint's existing
anonymous estimate limiter. It reports the selected profile/configuration,
latency samples, estimate amount, slice-derived amount and percentage delta.
