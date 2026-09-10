# ADR 0016: Persist catalog settings as versioned preset bundles

- **Status:** accepted
- **Date:** 2026-09-10
- **Related:** Epic #8 revision 3, issues #110 and #119, ADRs 0008, 0012, and 0015

## Context

Catalog revision settings are immutable snapshots consumed by the slicer worker.
They need an explicit shape, deterministic validation, and a security boundary
that prevents presets from requesting host-side execution.

Taven is fresh and undeployed. The owner-confirmed state in #103, ADR 0012, and
ADR 0015 has no historical revisions, snapshots, jobs, or object keys. There is
therefore no pre-bundle persisted data to preserve.

## Decision

1. Persisted catalog revision settings use only
   `{ "bundleVersion": 1, "presets": [...] }`.
2. Reference and machine bundles contain machine, process, then ordered
   filament presets. Print-config and calibration bundles contain overrides.
3. Bootstrap repairs canonical immutable snapshot bytes without executing the
   bundle validator. Activation provisioning and pre-enqueue dispatch validate
   bundles, and the worker validates them again before Orca is invoked.
4. The validator rejects `post_process`, `print_host`, `bbl_use_printhost`, and
   the `printhost_*` prefix. No unversioned decoder bypasses that single
   security boundary.
5. There is no legacy tier, migration, or seed revision-ID rotation. The seed
   defines the deterministic initial catalog; a changed fixture payload requires
   resetting a disposable local database. Engine identity remains governed by
   ADR 0008.

## Consequences

All executable persisted settings cross the same versioned validation boundary
before queueing and again in the worker. A malformed draft cannot prevent API
startup, but it cannot be activated or dispatched. A future persisted-shape
change after durable data exists requires its own compatibility decision.
