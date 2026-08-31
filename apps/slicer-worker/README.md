# `@taven/slicer-worker`

Independent BullMQ consumer for the versioned slicing queue. The foundation
handler is deterministic and fixture-only; it proves the contract seam without
pretending OrcaSlicer is integrated.

The worker is intentionally absent from `pnpm dev`. Start it explicitly with
`pnpm slicer-worker:dev` when Redis is running. The production runtime is
selected in [ADR 0008](../../docs/decisions/0008-pin-orcaslicer-v2-4-2.md):
OrcaSlicer v2.4.2 from a verified upstream AppImage, wrapped in an independently
built OCI image with a resolved profile-bundle hash. The independently built
runtime and its two-run corpus live in
[`tools/slicing-fixtures`](../../tools/slicing-fixtures/README.md). Build and
verify them explicitly with `pnpm slicer-worker:orca:build` and
`pnpm slicer-worker:orca:test`. The fixture-only BullMQ handler still does not
claim the production invocation integration owned by issue #27.
