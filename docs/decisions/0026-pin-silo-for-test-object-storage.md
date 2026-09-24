# ADR 0026: Pin Silo for CI and fresh local object storage

- **Status:** accepted architecture; implementation and compatibility validation required
- **Date:** 2026-09-24
- **Authority:** [escalation #248](https://github.com/Studio81Labs/taven/issues/248),
  Epic #10 / #186, coordinated with Epic #9 / #145
- **Inspected baseline:** main `f92b7e40`, payment bridge PR #247
- **Amends:** ADR 0006 and ADR 0007's local MinIO selection only

## Context

Required backend and browser integration CI stopped before tests because the
pinned Quay MinIO artifact became unavailable. A cached old image can support
local investigation but cannot establish clean-runner reproducibility. The
upstream MinIO repository is archived and describes source-only distribution.

PR #246 independently moved web CI to a digest-pinned Silo image and bundled
client. Its passing browser job is evidence for that consumer, not approval for
the backend, local data format or production. The repository already owns a
provider-neutral S3 port and a contract suite shared with Garage.

## Decision and artifact identity

Approve the publisher-maintained **classic** image for isolated CI and **fresh**
local development:

```text
docker.io/pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46
```

Use its bundled `mcli` for initialization, eliminating the independent Quay `mc`
image. Keep the server and initializer on that exact index digest; do not use a
floating tag, distroless substitute, downloaded executable or unrelated mirror.
Keep #246's web pin and adopt the same artifact in backend CI and local Compose
through one focused prerequisite PR before #247 merges.

Verified artifact identities:

| Identity             | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| Source repository    | `pgsty/silo`                                                              |
| Source commit        | `2a4d51406b7ed87af5fe6fe0f801f3290f96eb3c`                                |
| Signer workflow      | `pgsty/silo/.github/workflows/docker-release.yml`                         |
| Source/signer ref    | `refs/tags/RELEASE.2026-09-16T00-00-00Z`                                  |
| amd64 image manifest | `sha256:39aab3c365848e32aca7b76c5b57f86d1cbca02d7b8f24e1fd1feff9fedddae5` |
| arm64 image manifest | `sha256:1ff329e4507f742a8437f1773d43cf6adb0131477074dd45c770d1a1db19e99c` |

The planner retrieved the OCI index and inspected the cached arm64 source/version
labels. Cryptographic verification of the index succeeded using:

```bash
gh attestation verify \
  oci://docker.io/pgsty/silo@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46 \
  --repo pgsty/silo \
  --signer-workflow pgsty/silo/.github/workflows/docker-release.yml \
  --source-digest 2a4d51406b7ed87af5fe6fe0f801f3290f96eb3c \
  --format json
```

The verified identity names the release tag and
[publisher workflow run 35122716861](https://github.com/pgsty/silo/actions/runs/35122716861).
The annotated Git tag itself is unsigned; the verified Sigstore build attestation
is the source-binding evidence, not a claim of a signed tag. The
[publisher release](https://github.com/pgsty/silo/releases/tag/RELEASE.2026-09-16T00-00-00Z)
records this exact index and coordinated client; the workflow verifies release
archives before assembly and attests the resulting index. Preserve provenance
results and the actual bundled client version in the implementation evidence.
Attestation establishes origin/integrity, not absence of vulnerabilities or S3
compatibility. Review publisher advisories/SBOM or an image vulnerability report
and escalate an unmitigated issue relevant to the approved test use.

The #249 adoption check on 2026-09-24 independently verified the expected
source, workflow, tag and index subject with the command above. The native
linux/arm64 image reports server `RELEASE.2026-09-16T00-00-00Z` at source
`2a4d51406b7ed87af5fe6fe0f801f3290f96eb3c` and bundled `mcli` at the
same release, client commit `e952aa78f10a2b77dd525a2b7e3143bcda0cd377`.
The [publisher release](https://github.com/pgsty/silo/releases/tag/RELEASE.2026-09-16T00-00-00Z)
records its passed Go VulnCheck and downloadable SPDX 2.3 package SBOM. An
arm64 Docker Scout image scan reported seven high findings and no critical
findings. Its two server-module matches, CVE-2018-1000538 and
CVE-2026-39414, refer to behavior fixed before this release (the latter in
June 2026). The other five matches concern OS `acl`, `attr`, `pcre2` and
`glibc`; the server and bundled client are static executables, and the
reported exploit conditions are outside the isolated local/CI S3 test path.
The scan is retained as adoption evidence, not a claim that the image is free
of vulnerabilities. Reassess it with each reviewed image update.

## Application, runtime and data boundaries

Production/staging Garage v2.3.0 and R2 choices remain unchanged. No deployment
or remote volume change is authorized. Silo is a real alternative S3 test server,
not a response mock; evidence must name the provider actually exercised.

Keep `ObjectStorage`, `S3ObjectStorageAdapter`, `TAVEN_S3_*`, object keys, signing,
checksums, immutable writes, retention and legal holds unchanged. No application
or SQL migration, HTTP/OpenAPI/event or queue contract change is needed. Do not
make checksums optional or relax signatures, deadlines or deletion checks to
accommodate a replacement provider.

Preserve local service/DNS aliases, host ports and app configuration to avoid
unrelated churn; `minio` service names and `stack:storage:test:minio` may remain
explicitly documented compatibility aliases. Use the selected image for both
server and bundled-client initialization, with explicit entrypoints as needed.
Initialization must fail on health timeout or bucket-command failure. Preserve
private buckets, narrow development CORS and loopback host bindings; add no
privileged mode, Docker socket, host filesystem access or production credentials.

Use fresh isolated CI state and a new complete local Compose project with a
separate Silo volume and database for acceptance. Do not attach Silo to retained
MinIO data directories, automatically replace an existing local dataset, or
remove old volumes. Existing DB records cannot be paired with an empty new store
and called a migration. Existing retained local data stays with its old artifact
until an explicitly scoped transfer/backup/verification plan exists; this decision
requires none for the fresh development baseline. No claim of disk-format or
downgrade compatibility is made. Roll back only by selecting a previously
reviewed artifact on a fresh compatible dataset; no silent provider fallback.

## Compatibility and required validation

The adopting implementation PR must prove:

- Exact digest clean pulls on hosted linux/amd64 and native local linux/arm64;
  server readiness, explicit bundled-client initialization and private bucket.
- Existing storage contract and relevant adapter tests: header-bound SHA-256 PUT,
  tampering/missing checksum denial, HEAD checksum/type/length, scoped expiring
  GET, bounded ranges, immutable conditional creation/replay/conflict, copy
  metadata, bounded listing and batch deletion verification. Reuse existing
  cases and add only missing assertions needed for this contract.
- Quarantine/confirmation, source/photo/derived retention, legal holds,
  partial/failed deletion and idempotent retry. A health endpoint or bucket
  creation alone cannot close this requirement.
- The same existing Garage contract profile, with results named separately;
  Silo results cannot stand in for the production provider.
- Required backend PostgreSQL E2E and isolated real-API browser jobs on clean
  runners, followed by PR #247's actual connected payment/resource/worker
  regressions on its final head. Cached MinIO or #246's previous green result
  cannot replace those runs.
- `pnpm ci:config:check`, `pnpm stack:config:check`, format/diff checks and the
  affected integration commands, independent review and required final-head CI.

The implementation owns exact commands/artifacts and must report skipped or
unavailable services as unvalidated. It may not seed fake financial states or
weaken a test to make storage replacement pass. No planner-run compatibility,
vulnerability-scan or payment pass is claimed here.

## Maintenance, ownership and execution

Taven maintainers under `@akadlec` own adoption, pin consistency and future
updates; PGSTY owns publishing the upstream artifact. Updates require a reviewed
PR recording release/source/client, immutable index and platform manifests,
expected-identity attestation verification, relevant security review and the
contract/integration results. No automatically merged floating upgrades. Routine
updates within this supplier/contract are implementation work; supplier changes,
failed provenance, security/semantic weakening, retained-data migration or a
production-provider change require escalation. Pull/provenance failures stop
the gate rather than selecting another registry or relying on a runner cache.

Use one focused infrastructure/configuration/docs PR as a P5b prerequisite,
coordinated by #186; #145 consumes it without a parallel pin change. After merge,
update #247 to include it, rerun required checks/review, then resume P5c and the
existing Epic #10 sequence. Record actual individual-payment evidence in
#152/#144/#145 before the Epic #9 closure audit. Both epics remain open.

## Alternatives

Mirroring the cached old MinIO image can preserve bytes but leaves an archived
upstream and creates registry/provenance ownership work for both server/client.
Building old source adds an unnecessary build/patch supply chain. Waiting for
Quay recovery leaves the same availability dependency. Using only Garage removes
the existing fast second-provider test target; retain its independent contract
profile instead. Arbitrary mirrors, floating Silo tags, skipped CI or mock-only
storage are not acceptable substitutes.
