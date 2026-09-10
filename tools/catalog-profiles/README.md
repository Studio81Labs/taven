# Catalog Orca presets

This is the v0 catalog closure used to seed persisted revision bundles. It is
resolved from the same pinned OrcaSlicer revision as the reproducibility corpus,
but is intentionally outside `tools/slicing-fixtures` and is not copied into the
pinned runtime image.

The closure covers only the seeded Bambu Lab H2S 0.4 mm / STANDARD matrix for
Generic PLA and Generic PETG. The reference and machine bundles both use the
nominal H2S machine and standard process; only the material-specific filament
differs. The nominal machine is a pricing reference, never a machine calibration.

Regenerate or verify it with `pnpm catalog-profiles:update` and
`pnpm catalog-profiles:check`.
