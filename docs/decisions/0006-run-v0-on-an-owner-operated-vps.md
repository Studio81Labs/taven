# ADR 0006: Run v0 on an owner-operated VPS

- **Status:** accepted
- **Date:** 2026-08-31

## Context

Taven must remain viable as a low-volume hobby service. The product constraint
keeps domain, hosting, and payment-gateway idle cost to a few hundred CZK per
month, and the slicer must not run continuously. The owner already operates a
VPS with self-hosted Coolify and wants PostgreSQL, Redis, object storage, and
monitoring kept under owner control where a practical self-hosted
implementation exists. GitHub Actions will gate and initiate deployment, but
application code must not depend on that deployment platform, Coolify, or a
particular VPS vendor.

The repository currently has independently buildable applications and a local
Compose stack, but no production images or deployment workflow. Selecting a
runtime shape now must not create an empty workflow or pretend the production
controls already exist.

## Decision

Run v0 as OCI containers on the existing owner-operated VPS. Self-hosted
Coolify manages the production Docker Compose project; Docker Engine and Compose
remain the portable runtime contract. `apps/backend`, `apps/web`, `apps/admin`,
and `apps/slicer-worker` each receive an independent production image in issue
#39 or #25; PostgreSQL, Redis, Garage, the reverse proxy, and the observability
components also run as containers with explicit immutable image digests.
Application images accept configuration through environment variables or
mounted secret files and do not inspect GitHub, Coolify, Cloudflare, the VPS
vendor, or Docker-specific metadata.

The initial capacity target is an x86-64 Linux host with at least 4 vCPU, 16 GiB
RAM, and 200 GB of persistent SSD storage. Issue #39 must measure the existing
host before production and either demonstrate that this envelope is available
or record a replacement capacity decision. Stateful volumes live under
explicit `/srv/taven` paths and are never anonymous container volumes in
production. PostgreSQL, Redis, and Garage are reachable only on the private
Compose network. Caddy 2 is the selected origin reverse proxy. Only HTTP(S) and
restricted administrative SSH are exposed by the host firewall.

Cloudflare Free provides authoritative DNS, proxying, and edge TLS for
`taven.cz`. The origin uses strict TLS. Public DNS names and certificates are
configuration, not assumptions embedded in application code. Only after issue
#38 completes the required name-clearance gate is the domain registered
separately with WEDOS and delegated to Cloudflare.

GitHub Actions verifies the selected revision and then invokes an authenticated,
deploy-only Coolify webhook. Coolify builds and deploys the repository Compose
project on the VPS. Issue #39 serializes production deployments, proves the
completed Coolify deployment corresponds to the workflow's commit, and records
that commit plus every resulting image digest in a release manifest. The
previous successful revision and digest set remain available for rollback.
Database rollback is forward-fix unless a rehearsed compatible restore is
explicitly chosen. These workflows are implemented only with the real
deployment in issue #39.

PostgreSQL 18, Redis 8, Garage v2.3.0, Caddy 2, and the monitoring stack are
always available within the owner-operated host. Production pins each image by
digest and upgrades it only through a reviewed compatibility, backup, and
restore change. MinIO remains the fast local-development implementation already
present in `infra/docker/docker-compose.yml`; a production-like local Compose
profile must also run Garage so storage contract tests exercise both supported
S3 implementations. The slicer is different: it is started only for queued
work through an explicit command or dispatcher, drains the bounded job set, and
exits. It is not included in the default always-on Compose profile.

Issue #39 adds production Dockerfiles for all four applications and a local
integration Compose profile that builds and runs those same application images
with PostgreSQL, Redis, object storage, and an explicitly enabled slicer. The
existing host-process `pnpm dev` flow remains available for fast iteration.
Running the containerized local stack must not require production credentials,
Cloudflare, Comgate, Resend, GitHub Actions, or access to the production VPS.

Production secrets are separate files under per-service directories in
`/etc/taven/secrets`. Directories are owned by `root:<service-group>` with mode
`0750`; files are owned by `root:<service-group>` with mode `0440`, bind-mounted
read-only only into that service, and the non-root container UID receives only
its mapped supplemental GID. A shared credential is delivered as separate
per-service file copies so one container group does not gain access to another
service directory. Issue #39 adds `*_FILE` configuration support and verifies
effective-UID reads plus cross-service denial. GitHub Environment secrets are
the delivery source for deploy credentials and rotations. The repository
contains names and procedures only, never values. Developers use ignored local
environment files or local-only Compose defaults.

The VPS is one failure domain. Coolify's native scheduled PostgreSQL backup
configuration uploads database backups to a Cloudflare R2 bucket restricted to
the EU jurisdiction; Taven does not own a separate SQL dump script. Garage
metadata and blocks use an encrypted restic repository in R2. A coordinated
write-free recovery window pairs one successful on-demand run of that configured
backup with one atomic read-only Garage filesystem snapshot. Restic
never traverses writable Garage data. Redis is not a system of record: AOF
improves local restart recovery, while durable PostgreSQL state and outbox
records are authoritative for queue reconstruction. The backup, restore,
credential-escrow, retention, and deletion rules are specified in the v0
provider matrix and must be rehearsed in issue #39.

## Consequences

The incremental idle hosting cost is zero while the existing VPS has sufficient
capacity, and all runtime components remain portable OCI workloads. Operations
and patching are owner responsibilities, including host security, volume
capacity, backups, and recovery. A single host does not provide high
availability; v0 accepts that constraint and requires observable failure and a
tested restore instead.

Using Cloudflare, GitHub, the registrar, payment processor, email relay, and an
off-host backup target remains necessary or deliberately selected. None becomes
an application architecture dependency. Moving to another OCI host, Compose
replacement, S3 implementation, payment processor, or email relay must not
require a domain-model change.
