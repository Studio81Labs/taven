# `@taven/slicer-worker`

Independent BullMQ consumer for the versioned slicing queue. The foundation
handler is deterministic and fixture-only; it proves the contract seam without
pretending OrcaSlicer is integrated.

The worker is intentionally absent from `pnpm dev`. Start it explicitly with
`pnpm slicer-worker:dev` when Redis is running. Container and pinned Orca image
work waits for the explicit Orca version and fixture-corpus decision recorded
in the repository foundation plan.
