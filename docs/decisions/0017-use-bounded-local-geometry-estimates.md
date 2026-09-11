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
