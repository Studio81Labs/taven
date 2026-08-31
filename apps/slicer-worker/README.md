# `@taven/slicer-worker`

Independent BullMQ consumer for the versioned slicing queue. The foundation
handler is deterministic and fixture-only; it proves the contract seam without
pretending OrcaSlicer is integrated.

The worker is intentionally absent from `pnpm dev`. Start it explicitly with
`pnpm slicer-worker:dev` when Redis is running. The production runtime is
selected in [ADR 0008](../../docs/decisions/0008-pin-orcaslicer-v2-4-2.md):
OrcaSlicer v2.4.2 from a verified upstream AppImage, wrapped in an independently
built OCI image with a resolved profile-bundle hash. Issue #25 owns that image
and its reproducibility corpus; this fixture-only worker does not claim the
integration is complete.
