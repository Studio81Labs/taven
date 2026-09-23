# ADR 0017: Use bounded local geometry for immediate estimates

- **Status:** accepted
- **Date:** 2026-09-11
- **Decision authority:** Epic #9 technical implementation plan, issue #141,
  escalation #147

## Context

The direct upload flow can parse safe local STL/3MF geometry before object
storage, inspection, reference slicing, or a quote session exists. Customers
need an immediate monetary indication, but neither browser geometry nor a
rough calculation can establish final production fit, delivery, resources, or
a binding price.

## Decision

Expose a stateless `POST /automatic-quote-estimates` command accepting only a
bounded volume, bounding box, material, required `quality: "STANDARD"`, named
infill preset, and quantity. It rejects unknown fields, source identifiers,
prices, contacts, DRAFT/FINE quality requests, and unrepresentable geometry or
money. The backend selects an active matching STANDARD configuration and the
active v0 price list, reuses the existing rough material and extrusion
calculation plus provisional public price projection, and returns the selected
revisions as observable assumptions.

Escalation #147 established this narrow contract because the rough estimator
has one extrusion-rate input and no approved quality-sensitive time or pricing
factor. It must not invent a quality multiplier or silently coerce a requested
quality. This restriction applies only to the immediate estimate: the existing
configurator and slicing flow continue to expose DRAFT, STANDARD, and FINE,
where quality prices are slice-derived.

The command creates no session, upload, order, slice, reservation, payment,
idempotency, or business-event record. Its only write is a separately
namespaced, short-lived anonymous rate-limit counter. It remains behind the
same default-closed commercial approval gate as binding quote publication.

The browser starts the request after successful local parsing while hashing
continues. A request-specific abort controller and selection-generation fence
discard stale, cancelled, or unmounted responses. The result is visibly
non-binding, excludes delivery, cannot make checkout available, and is cleared
when a server rough or binding quote becomes authoritative.

## Consequences

The estimate does not expose internal cost or margin coefficients and does not
make geometry or availability promises. It is unavailable rather than guessing
when the exact default configuration is not active. Server inspection and the
existing configuration/revision-bound quote remain authoritative. A scale
conversion, mesh repair, or acknowledgement that bypasses blocking findings is
outside this decision.

Latency and accuracy are measured against representative STANDARD fixtures;
an unmet target requires the Epic escalation process rather than a
customer-facing claim or a second pricing calculator.

## Amendment: browser timing and request scheduling (#190)

Architecture resolution: [#190](https://github.com/Studio81Labs/taven/issues/190),
2026-09-23. This defines the previously unspecified warm reference environment
without changing the STANDARD-only price contract or the 200 ms target.

### Measurement and acceptance

The core acceptance run uses a production-built Nuxt application and Nest API
on loopback on the documented reference workstation (the existing Mac Studio
Mac13,1 or an explicitly recorded comparable machine), with real PostgreSQL,
normal approval/catalog reads and the normal anonymous limiter. Use an isolated
non-production database, the authorized development baseline and commercial
configuration, foreground Chromium Desktop at 1280 x 800, no CPU/network
throttling, and warmed application/browser/database connections. Record exact
browser/Node versions, hardware, commits/builds, fixture hash and active pricing
and profile revisions. No mock estimate response, cached monetary result,
limiter bypass or alternate fast pricing implementation may satisfy this gate.

Use the existing 20 mm PLA cube with STANDARD quality/infill and quantity one.
After one excluded warm-up selection, record four consecutive successful
selections, including all samples and their median and maximum. The warm median
from successful geometry parse completion to the first rendered matching monetary
estimate must be at most 200 ms. Four observations are a reference check, not a
population percentile or a customer SLA. Preserve the same-assumption sliced
accuracy evidence and the existing +/-20% target; do not use minimum-price
floors to hide error.

Timestamp in the browser's single monotonic clock: parser start/completion,
request dispatch, complete response consumption, and the first rendering
opportunity after the current selection's numeric price and assumptions have
been committed to visible DOM. A DOM observer plus animation-frame boundary is
a conservative rendering proxy, not proof of physical screen paint. Report parse,
post-parse scheduling, request/response (including preflight and decoding), and
response-to-render durations separately. Include scheduling and rendering in the
200 ms total. Do not subtract the coalescing delay, begin at request dispatch,
stop at HTTP success or a loading label, or timestamp when a Playwright polling
assertion finally resolves. Automation may await browser-recorded marks but must
not define their clock. Correlate marks to the selected geometry/generation and
successful response so an old price cannot satisfy a sample. Instrumentation
must not alter the production scheduling/network path or disclose filenames,
geometry, contacts, tokens or pricing internals.

Run the same measurement against remote staging and retain its real total and
breakdown with deployed versions. Remote Internet/ingress latency is diagnostic
for this core gate, not a requirement to meet 200 ms over arbitrary networks.
Do not describe a local pass as staging or customer-wide 200 ms compliance.
A remote functional failure remains actionable; a numeric remote miss alone
neither blocks core completion nor authorizes a new, looser product target.
Further launch/performance observations stay with #39/#40. No new remote budget
is invented from the four reported samples.

The reported 805.98 ms staging median is not a local-reference pass. The
uncommitted timing harness named in #190 was unavailable in the inspected
investigation worktree; its endpoint/clock method and reported rendering cost
must be verified before attributing a dominant cause. Reconstruct or recover
and commit that evidence rather than treating assertion wait time as rendering.

### Scheduling and invariants

The fixed 100 ms selection-settle timer is not a required domain or security
invariant. Remove the unconditional delay from the first estimate for the
current successfully parsed selection; dispatch in the same turn or next
microtask, with a current-generation/disposed check immediately before dispatch.
Same-turn superseded work may be coalesced. Do not wait for file hashing, upload,
preview decoration or slicing. Preserve generation and AbortController checks
before applying every result/error/finalizer; a superseded parse must not replace
current geometry or initiate an estimate. Cancelling, replacing, leaving the
page or receiving an authoritative quote cancels queued/in-flight work and
prevents late results from changing the displayed price.

At most one automatic dispatch is allowed per accepted selection generation.
An explicit user retry remains possible; deduplicate concurrent retries and keep
429/503 as unavailable states without automatic loops. Replacement after dispatch
may already have consumed a server allowance: abort does not promise a quota
refund. Keep the existing five/client and 100/global per 15-minute estimate
namespace limits and separate session/request limits unchanged. Never spoof a
new client identity to benchmark. One warm-up plus four samples fits a fresh
isolated allowance; other suites must not share its mutable limiter state.
Remote runs must respect available quota or wait for expiry; failed/gated/rate-
limited responses are incomplete measurements, not successful timing samples.

Profile before any additional optimization. Local scheduling, rendering or
query improvements preserving existing semantics may be resolved in #141.
Browser pricing/cost disclosure, cross-request catalog/price caching, limiter or
approval changes, persistence/contract changes, and an unmet correctly measured
local target require architectural escalation. No migration, endpoint/DTO, event,
provider, legal-revision or pricing-coefficient change is authorized here.

Deliver the harness, narrow scheduling correction, stale/replacement/retry
regressions and truthful benchmark report in one #141 follow-up PR coordinated
by #145 (SERIAL, maximum one implementation agent). #144 reuses the harness and
retains its functional browser/API matrix. Resolve this architecture escalation
before implementation; closing #190 does not mark #141 or Epic #9 complete.
