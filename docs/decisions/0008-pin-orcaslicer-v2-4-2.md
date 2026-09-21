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
inside a separate network namespace with no outbound access, proven
behaviourally. A network namespace still contains loopback and kernel-created
tunnel devices, so interface presence is not the isolation criterion. The
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
hashes. Any engine, profile, base-image, dependency, or Orca CLI invocation
vector change creates a new engine/profile revision. The old image remains
available until all jobs that reference it have drained or expired.

Confinement around the engine — capabilities, namespaces, LSM posture, rlimits,
and the exec chain — is outside engine/profile identity provided it cannot change
the artifact. A confinement change must demonstrate unchanged normalized output
for at least one corpus fixture and prove its security property behaviourally in
the configured broker runtime. If normalized output changes, it is an identity
change and follows the complete upgrade procedure above.

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
`apparmor=unconfined` for `orca-runner` only. CI exercises the ordinary local
Compose broker on an LSM-enforcing host.
Coolify owns independent staging/production resources and must reproduce the
same identity, capability, mount and LSM boundary; it does not deploy Compose.

This is a narrowly scoped host-confinement exemption, not a relaxation of the
Orca execution boundary. The broker is container UID 0 with GID 10001, not a Docker
`privileged` container. It remains networkless, read-only, and dropped from
every capability except `SYS_ADMIN`, `SETUID`, `SETGID`, and `SETPCAP`; no worker-profile service receives a Docker socket.
Each Orca child still runs as UID/GID 10001 in Bubblewrap with empty effective,
permitted, bounding, inheritable, and ambient capability sets, `no_new_privs`,
isolated pid/ipc/uts and mount namespaces, and no network. A host enforcing SELinux rather than
AppArmor requires the equivalent host-policy exemption; provisioning that
policy belongs to deployment work and must not be replaced by `privileged` or
additional capabilities.

The pinned Bubblewrap binary runs as the root broker during namespace setup; it
does not require globally enabled unprivileged user namespaces. The fixed
inner `setpriv` handoff occurs only after Bubblewrap has created the sandbox.
Granting `privileged` or a Docker socket is not an acceptable workaround.

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

## Root setup and unprivileged engine handoff (2026-09-21, #171)

### Evidence and decision

Escalation #171 concerns PR #170 at `470bff7`; repository baseline is
`04737d0`. The approved isolation goal remains valid, but the proposed
pre-Bubblewrap identity drop is not a supported way to preserve mount authority.
`setpriv --reuid=10001 --bounding-set=-all,+sys_admin` with empty inheritable and
ambient sets does not retain effective/permitted `CAP_SYS_ADMIN` across exec.
The bounding set is a ceiling, not a grant. The reported ordinary-container run
reaches Bubblewrap and fails its private `/proc` mount even after enabling user
namespaces. That error alone does not identify every kernel/LSM restriction;
those remain runtime evidence to collect, not grounds for broadening privileges.

The package lock pins Bubblewrap `0.9.0-1ubuntu0.1` and util-linux
`2.39.3-9ubuntu6.5`. Upstream Bubblewrap 0.9.0 rejects non-root callers with
permitted capabilities in `acquire_privs()`, supports a root caller's existing
capabilities, and only implicitly requests a user namespace for a non-root
caller. See the [pinned upstream source](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c)
and [setpriv capability semantics](https://man7.org/linux/man-pages/man1/setpriv.1.html).
The installed Ubuntu build and target host must still pass the runtime tests.

**Choose the existing root broker setup path, followed by an inner, mandatory
identity/capability drop before Orca.** This explicitly supersedes PR #170's
pre-Bubblewrap UID transition and unprivileged-user-namespace prerequisite.
It clarifies the older word “unprivileged”: the broker container is not Docker
privileged; the trusted setup process is root; the engine is non-root. Main
already configures `user: "0:10001"` and this ordering. Preserve that supported
boundary instead of introducing a new privileged helper or isolation system.

### Required execution boundary

The fixed per-request chain is:

```text
container broker UID 0 / GID 10001
  → prlimit → timeout --signal=KILL
  → unshare --net --
  → bwrap (mount + PID + IPC + UTS isolation; private /proc and /dev)
  → setpriv (UID/GID 10001, no groups, all capability sets empty, no_new_privs)
  → /opt/orca/AppRun (existing immutable argument vector)
```

- Keep exactly `SYS_ADMIN`, `SETUID`, `SETGID`, `SETPCAP` available to trusted
  setup, with `cap_drop: ALL`; no extra capability. `SYS_ADMIN` permits namespace
  setup, the other three permit the final identity/group/bounding-set drop.
  Keep `no-new-privileges` enabled on the container and child. Do not use
  Bubblewrap `--cap-drop ALL` before `setpriv` in a way that removes the
  finalizer's authority to change identity or clear its bounding set.
- Invoke the pinned non-setuid Bubblewrap as root without a new user namespace:
  no `--unshare-user`, `--unshare-all`, user mapping helper, file capabilities,
  ambient-capability bootstrap or setuid installation. Do not use Bubblewrap
  `--uid/--gid` as a replacement; the selected path uses the inner `setpriv`.
  The broker stays in its existing container user namespace; this decision does
  not change any Docker daemon user-namespace configuration.
- Immediately after Bubblewrap finishes setup, exec only the fixed trusted
  `/usr/bin/setpriv` with `--reuid=10001`, `--regid=10001`, `--clear-groups`,
  `--bounding-set=-all`, `--inh-caps=-all`, `--ambient-caps=-all`, and
  `--no-new-privs`, then
  the fixed `/opt/orca/AppRun` with the existing validated arguments. No engine,
  plugin, request-selected executable or shell evaluation runs between setup
  and the completed drop. Preserve the cleared environment and fixed paths.
  A failed namespace/mount/identity/drop operation fails the request closed
  with the existing `ENGINE_UNAVAILABLE` behavior; never fall back to direct
  engine execution. Existing timeout/resource-limit classification is retained.
- At engine entry and in engine descendants, all four UID/GID values must be
  10001, supplementary groups empty, `CapInh`, `CapPrm`, `CapEff`, `CapBnd` and
  `CapAmb` zero, and `NoNewPrivs: 1`. Trust neither UID alone nor bounding-set
  flags as evidence of that state. Setup/monitor processes are trusted broker
  machinery, not engine processes.
- Preserve `network_mode: none` and per-request `unshare --net --`; do not add
  `NET_ADMIN` or replace it with Bubblewrap's loopback-configuring
  `--unshare-net`. Keep PID/IPC/UTS/mount isolation, the existing optional cgroup
  namespace, private `/proc`, minimal `/dev`, read-only root and inputs, hidden
  exchange root, and only the request's writable output and scratch mounts.
- Preserve the bounded 1 GiB exchange, directory ownership/modes, broker GID
  access, worker-identity metadata reads and cleanup from #169, diagnostic
  limits/FIFO permissions, rlimits, deadlines, restart recovery and cancellation.
  No DAC override/read-search capability, world-writable repair, secret mount,
  host Docker socket, host PID/network namespace or Docker privileged mode.
  The Node consumer stays non-root and alone owns Redis/S3 connectivity.

The root setup phase is part of the trusted computing base and already has the
mount authority configured on main. This is an explicit security boundary, not
an assertion that root is harmless. No customer model is executed by Orca until
the drop and sandbox setup have both completed.

### Host policy, validation and delivery

Keep the existing broker-only AppArmor/seccomp exemption (or reviewed SELinux
equivalent). This root path does not require globally enabling unprivileged
user namespaces. Remove PR #170's sysctl changes introduced solely to support
the rejected non-root path; do not alter a shared Coolify host's global policy
as a substitute for the approved service configuration. If the installed host
still denies this path, collect actual capabilities, namespace state and LSM
errors and escalate before changing the security boundary.

Amend existing PR #170 under #39, coordinated by #145 order 8. Incorporate this
ADR, correct the runner ordering/static tests, worker/Coolify documentation,
and CI together; no new implementation issue or PR split. The implementation
orchestrator must establish:

1. Ordinary, non-privileged broker fixtures and the real
   `pnpm slicer-worker:integration` suite pass with the same checked-in runtime
   policy. No privileged probe, skipped integration, alternate execution path,
   unconfined sibling services or CI-only user-namespace launcher is evidence.
2. Observe the actual Orca process credentials, all five capability sets,
   `NoNewPrivs`, namespace identity and request filesystem access. Prove outbound
   connections fail; root/inputs are not writable; another request/exchange is
   hidden; scratch/output remain writable as 10001. Namespace assertions must
   measure the actual namespaces, not merely print labels from command flags.
3. Exercise setup/drop failure without running the engine, timeout/cancellation,
   broker restart and cleanup. Keep these tests in isolated fixtures without
   adding a production bypass or selectable engine command.
4. Run the pinned corpus twice from clean workspaces and existing worker
   lifecycle/integration suites. Compare normalized outputs against the approved
   baseline, including reference/candidate/production vectors. Execute affected
   lint/typecheck/build, identity/stack/CI configuration and formatting checks.
5. Rebuild the final OCI artifact after runner edits; record the actual manifest
   digest and update the lock, environment example and fixture identity fields
   consistently. Do not copy the prior PR head's digest or substitute an image
   config/AppImage digest. A confinement-only change may retain the Orca/profile
   revision only with unchanged normalized artifact evidence; engine/profile/
   invocation/output changes retain the full upgrade policy above.
6. After review/CI and merge, verify Coolify's equivalent service configuration
   and actual deployed image identity, then run the private staging real slice
   through binding quote and sandbox checkout. Local/CI success alone does not
   establish that Coolify applied the settings. Drain active work before broker
   replacement; never run two brokers on one exchange. Preserve lease/stale-result
   fencing, historical results and prior digest availability. On failure stop
   new slicing and use only a previously verified secure runtime; do not lower
   isolation, fabricate success or manually advance an order.

No SQL migration, persisted domain model, public HTTP API, queue-v2 message,
cache algorithm or product/legal policy changes are authorized. Runtime image
identity remains truthful; existing stored results and accepted orders are not
rewritten. The execution strategy stays SERIAL, maximum concurrency one.
Existing #25/#27/#111 work is not reopened. Architectural closure permits
implementation to resume, not merge or public activation. Further capability,
LSM/user-namespace, helper, lifecycle, contract or output changes require renewed
architectural escalation; routine faithful code/tests/runbook fixes do not.

Rejected alternatives: non-root capability retention is unsupported by the
pinned Bubblewrap path; a custom/setuid launcher adds a new privileged component;
a different isolation engine or mandatory nested user namespace adds coupling
without fixing a demonstrated need. Removing private `/proc`, granting Docker
privileged mode/extra capabilities, or accepting a CI-only success weakens the
required security boundary and is not permitted.
