# `@taven/slicer-worker`

Independent BullMQ consumer for the versioned slicing queue. The v2 processor
downloads immutable inputs by generated object key and checksum, inspects STL
and 3MF sources, writes selected canonical geometries, reuses machine-occupancy
metric caches, and invokes the pinned OrcaSlicer runtime. The legacy v1 queue
retains its fixture drain handler only.

The worker is intentionally absent from `pnpm dev`. Start the Compose worker
profile explicitly with `pnpm stack:worker` when local slicing is required.
The worker requires its isolated Orca sidecar and does not execute an Orca
binary directly on the host. The production runtime is selected in
[ADR 0008](../../docs/decisions/0008-pin-orcaslicer-v2-4-2.md):
OrcaSlicer v2.4.2 from a verified upstream AppImage, wrapped in an independently
built OCI image with a resolved profile-bundle hash. The independently built
runtime and its two-run corpus live in
[`tools/slicing-fixtures`](../../tools/slicing-fixtures/README.md). Build and
verify them explicitly with `pnpm slicer-worker:orca:build` and
`pnpm slicer-worker:orca:test`.

`pnpm stack:worker` builds the backend outbox dispatcher, separate Node worker,
and exact-Orca containers without a Docker socket. The Node consumer is the
only process with private Redis and S3 access. It passes checksummed geometry
and profile bytes through a private volume to the isolated Orca sidecar, which
has `network_mode: none`, a read-only root, no credentials, and per-process
`prlimit` and deadline enforcement. Its minimal root broker owns only the mount
namespace capabilities needed to create a fresh sandbox; every Orca child runs
as UID 10001 with no capabilities, a cleared environment, and only its own
read-only inputs plus writable output and temporary directories. The shared
exchange is a 1 GiB Compose-managed tmpfs, bounding aggregate scratch, output,
and request data even if Orca creates many individually small files. Both sides
reclaim every job workspace after its terminal result or lease expiry. The
one-shot volume initializer has only `CHOWN`; it exits before either app starts.
All worker services remain opt-in.

Profile and configuration revisions are provider-neutral immutable S3 objects
at `slicer-revisions/<content-sha256>/settings.json`. Their bytes must hash to
the settings-snapshot digest carried by the v2 job; this is intentionally
separate from the database revision-identity digest. Every snapshot is a
`{ "bundleVersion": 1, "presets": [...] }` bundle. The backend validates it at
activation and before enqueue, while bootstrap repairs canonical snapshot bytes
without executing the bundle validator; the worker validates it again before use.

Reference and machine bundles order a machine preset, a process preset, then
one or more filament presets. Print-config and calibration bundles contain only
override presets. The worker passes settings as machine, process, print-config,
then calibration and preserves filament bundle order. It rejects ten or more
settings presets because the broker's C-locale filename ordering is only
unambiguous below that bound. `post_process`, `print_host`, `printhost_*`, and
`bbl_use_printhost` are rejected; printer G-code fields remain valid preset
content.
Candidate jobs upload metrics-only
JSON under `slice-metrics/`; only reference jobs write non-production reference
G-code and only contract-authorized production jobs write under `gcode/`.
The pinned Orca runtime emits plain G-code and Bambu G-code 3MF packages.
Because upstream OrcaSlicer 2.4.2 has no native binary-G-code exporter, a Prusa
`bgcode` request returns a typed unsupported result instead of relabeling plain
G-code as a production artifact.
