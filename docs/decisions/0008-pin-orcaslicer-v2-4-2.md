# ADR 0008: Pin OrcaSlicer v2.4.2

- **Status:** accepted
- **Date:** 2026-08-31

## Context

OrcaSlicer output affects resource estimates and binding price. An automatic
binary or vendor-profile update would silently change the commercial result.
The slicer worker therefore needs an exact upstream source, verified artifact,
immutable runtime identity, and a reviewable upgrade policy before issue #25
can build the production image and fixture corpus.

OrcaSlicer provides a Linux desktop distribution rather than a formally stable
headless service API. Its AGPL-3.0 license and inherited profile files also need
to remain visible when a runtime image is built or distributed.

## Decision

The first supported engine is the official OrcaSlicer v2.4.2 release:

- release: <https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.4.2>
- source tag commit: `8500fcdccaa10b5099ac20d252af3a7c560046f1`
- Linux x86-64 Ubuntu 24.04 AppImage:
  `OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage`
- upstream asset size: `137759224` bytes
- upstream asset digest:
  `sha256:d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd`
- upstream license: AGPL-3.0

Issue #25 downloads that exact HTTPS asset during a reproducible image build,
verifies both size and SHA-256 before extraction, and extracts the AppImage at
build time instead of requiring FUSE at runtime. The Ubuntu 24.04-compatible
base image and every installed package are also pinned. The worker runs as a
non-root user with a fresh per-job data directory, a read-only runtime
filesystem except for bounded work/output mounts, no Orca account, and no Bambu
network plug-in. The BullMQ wrapper remains connected to the private Compose
network so it can consume Redis jobs and transfer input/output through the
configured object store; it exposes no public port. Each Orca subprocess runs
inside a separate network namespace with no interfaces or outbound access. The
isolation must be enforced and tested without mounting the host Docker socket.
If the selected CLI path still requires a display, the wrapper supplies a
private Xvfb display; it must not depend on an interactive desktop.

Vendor profiles originate from the same source commit, initially from
`resources/profiles/BBL`. Issue #25 copies only the reviewed profiles required
for the supported v0 machines, resolves inheritance, and records a hash of the
complete resolved profile bundle. Hashing one leaf JSON file is insufficient.

The runtime identity has three independent parts:

1. upstream Orca version and verified AppImage digest;
2. final OCI image digest produced by the reviewed build; and
3. resolved profile-bundle revision and SHA-256.

The final OCI digest cannot exist until issue #25 builds the image. That issue
must record it in a reviewed lock or release manifest, expose it through the
slicer result's existing engine identity, and deploy only by digest. The
upstream asset digest above is the immutable input and must never be substituted
for the final image digest.

No Orca or profile update is automatic. An upgrade PR changes the explicit
version/digests, retains license and source notices, builds both old and new
runtimes, and runs a license-safe corpus twice from clean directories. The
minimum corpus covers single-material PLA, quantity or multi-plate arrangement,
painted or multi-material 3MF, and invalid geometry. Review compares normalized
metadata, warnings/errors, plate decisions, estimated time/material, and output
hashes. Any engine, profile, base-image, dependency, or invocation change creates
a new engine/profile revision. The old image remains available until all jobs
that reference it have drained or expired.

## Consequences

Issue #25 can build the first immutable runtime without choosing an Orca release
or download source. Reproduction requires both the image digest and resolved
profile revision; a human-readable version alone is never sufficient.

The AppImage's CLI behavior remains an integration risk and must be proven by
the fixture corpus before pricing consumes it. If v2.4.2 cannot meet the
headless, deterministic, or supported-format contract, changing engines is a
new ADR and fixture comparison, not an unreviewed image edit. Distribution of
the runtime image must retain the applicable licenses, notices, and source offer
required by AGPL-3.0 and the bundled profiles.

## Deterministic profile-bundle provenance (2026-09-10)

The profile-bundle digest includes canonically serialized provenance and uses
the ADR 0015 UTF-16 code-unit comparator. A resulting bundle-digest change is a
determinism correction, not a substantive upgrade, only when it provably leaves
`profiles/resolved/**` and `image.ociDigest` unchanged. It does not require
building old and new runtimes. The complete upgrade procedure above still
applies to every engine, profile-content, base-image, package, or invocation
change.

## Bubblewrap host-LSM requirement (2026-09-11)

The `orca-runner` broker must create a fresh Bubblewrap mount namespace for
each request. Its first bind-mount operation needs `CAP_SYS_ADMIN` and is not
permitted by Docker's default AppArmor profile, even when its seccomp profile
is unconfined. On an AppArmor host the Compose service therefore sets
`apparmor=unconfined` for `orca-runner` only. The same Compose configuration is
used in CI and production so the broker is proven on an LSM-enforcing host.

This is a narrowly scoped host-confinement exemption, not a relaxation of the
Orca execution boundary. The broker remains unprivileged, networkless,
read-only, and dropped from every capability except `SYS_ADMIN`, `SETUID`,
`SETGID`, and `SETPCAP`; no worker-profile service receives a Docker socket.
Each Orca child still runs as UID 10001 in Bubblewrap with empty bounding,
inheritable, and ambient capability sets, `no_new_privs`, isolated pid/ipc/uts
and mount namespaces, and no network. A host enforcing SELinux rather than
AppArmor requires the equivalent host-policy exemption; provisioning that
policy belongs to deployment work and must not be replaced by `privileged` or
additional capabilities.

## Child network namespace (2026-09-11)

Each Orca child receives a separate network namespace through
`/usr/bin/unshare --net --` immediately before Bubblewrap. Bubblewrap's
`--unshare-net` is deliberately not used: it always configures loopback, which
requires `CAP_NET_ADMIN`. The pinned `util-linux` `unshare(1)` creates the
namespace without that setup, so the broker retains exactly `SYS_ADMIN`,
`SETUID`, `SETGID`, and `SETPCAP`; no capability or Compose posture changes.

A separate namespace is not evidence that no interfaces exist, so the runtime
suite proves the required property behaviorally: an outbound connection from
the real sandbox must fail. `unshare(1)` execs into Bubblewrap, leaving the
existing `prlimit` and timeout chain, including Bubblewrap's
`--die-with-parent`, unchanged.
