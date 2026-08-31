# OrcaSlicer runtime and reproducibility corpus

This directory is the reviewed runtime lock for OrcaSlicer v2.4.2. It keeps
three identities separate:

1. the verified upstream AppImage and source revision in `runtime.lock.json`;
2. the OCI manifest digest produced by the reviewed Docker build; and
3. the resolved H2S profile revision and complete closure digest in
   `profiles/manifest.json`.

The runtime is Linux x86-64, independently built from the Node BullMQ worker,
non-root, and exposes no port. The AppImage is extracted without FUSE. Ubuntu
packages come from a dated, signed snapshot, and the resulting image records
every installed package version. The build checks that inventory against the
reviewable `ubuntu-packages.lock`; dependency drift therefore fails the image
build. The fixture harness runs the image with no
network, a read-only root filesystem, no capabilities, no-new-privileges, and
fresh temporary data directories. Issue #27 owns applying equivalent namespace
isolation to each production subprocess without mounting the Docker socket.

## Commands

The locked OCI digest is produced by an explicit OCI-layout export with the
workflow's `docker-container` builder: Buildx v0.36.1 and
`moby/buildkit:v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8`.
The host Docker Engine's `--load` serialization is used only to execute the
corpus and is not the locked identity. Docker's built-in driver is rejected.
For local reproduction, create a dedicated builder once and select it through
Buildx's standard environment variable:

```bash
docker buildx create --name taven-orca-repro --driver docker-container \
  --driver-opt image=moby/buildkit:v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8 \
  --bootstrap
export BUILDX_BUILDER=taven-orca-repro
```

Then build and verify the corpus:

```bash
pnpm slicer-worker:profiles:check
pnpm slicer-worker:orca:build
pnpm slicer-worker:orca:test
```

The corpus covers a single-material PLA cube, two arranged copies, an
Orca-recognized painted two-material 3MF, and open invalid geometry. Each case
runs twice from clean directories. Normalized result metadata, diagnostics,
plate decisions, estimated time/material, and timestamp-normalized G-code
hashes must match both runs and the reviewed JSON under `expected/`.

## Deliberate upgrades

An upgrade must change the explicit source/version/asset/base/package inputs,
retain the license and source notice, regenerate the exact reviewed profile
closure with `pnpm slicer-worker:profiles:update`, and build both the old and
new revisions. Run each corpus twice and review the JSON diff before replacing
the expected files. Finally run `pnpm slicer-worker:orca:digest`, review the
image contents and package lock, and update the OCI digest in
`runtime.lock.json`. Never substitute the AppImage digest for the OCI digest or
use a floating `latest` reference.
