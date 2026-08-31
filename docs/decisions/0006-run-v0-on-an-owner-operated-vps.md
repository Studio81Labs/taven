# ADR 0006: Run v0 on an owner-operated VPS

- **Status:** accepted
- **Date:** 2026-08-31

## Context

Taven must remain viable as a low-volume hobby service. The product constraint
keeps domain, hosting, and payment-gateway idle cost to a few hundred CZK per
month, and the slicer must not run continuously. The owner already operates a
VPS and wants PostgreSQL, Redis, object storage, and monitoring kept under
owner control where a practical self-hosted implementation exists. GitHub
Actions will perform deployment, but application code must not depend on that
deployment platform or on a particular VPS vendor.

The repository currently has independently buildable applications and a local
Compose stack, but no production images or deployment workflow. Selecting a
runtime shape now must not create an empty workflow or pretend the production
controls already exist.

## Decision

Run v0 as OCI containers on the existing owner-operated VPS. Docker Engine and
Docker Compose are the initial orchestrator. `apps/backend`, `apps/web`,
`apps/admin`, and `apps/slicer-worker` each receive an independent production
image in issue #39 or #25; PostgreSQL, Redis, Garage, the reverse proxy, and the
observability components also run as containers with explicit immutable image
digests. Application images accept configuration through environment variables
or mounted secret files and do not inspect GitHub, Cloudflare, the VPS vendor,
or Docker-specific metadata.

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
configuration, not assumptions embedded in application code. The domain is
registered separately with WEDOS and delegated to Cloudflare.

GitHub Actions builds and verifies the images, exports OCI archives and a
checksummed release manifest, and transfers them directly over a restricted SSH
account.
The VPS loads and deploys the explicit digest set and retains at least the prior
release locally for rollback. This avoids adding a registry service or another
runtime dependency. Database rollback is forward-fix unless a rehearsed
compatible restore is explicitly chosen. These workflows are implemented only
with the real deployment in issue #39.

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

The VPS is one failure domain. Nightly encrypted PostgreSQL and object-storage
backups therefore leave the host for a Cloudflare R2 bucket restricted to the
EU jurisdiction. Restic never traverses writable Garage metadata and blocks:
storage mutations are quiesced while one atomic read-only filesystem snapshot
is created over both paths, then Garage restarts before the snapshot is copied
off-host. Redis is not a system of record: AOF improves local restart recovery,
while durable PostgreSQL state and outbox records are authoritative for queue
reconstruction. The backup, restore, retention, and deletion rules are specified
in the v0 provider matrix and must be rehearsed in issue #39.

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
