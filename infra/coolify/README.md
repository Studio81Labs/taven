# Coolify service layout

Production and staging are managed by Coolify. The backend API and every
backend-image worker are maintained together in
`infra/coolify/docker-compose.yml`; Coolify should deploy that file as the
backend application resource. The web site, operator admin, PostgreSQL, Redis,
Garage/object storage, slicer consumer, Orca runner, and slicer exchange
initializer remain separate Coolify resources.

The backend Compose resource contains:

- `backend` (`apps/backend/Dockerfile`, `runtime` target);
- `balance-payment-worker`;
- `checkout-payment-worker`;
- `resource-reservation-worker`;
- `retention-worker`;
- `operator-auth-expiry-worker`; and
- `slicing-dispatcher`.

All worker services use the same backend runtime image, but each receives only
the database, payment, operator, queue, or object-storage configuration needed
by its dedicated bootstrap module. Their commands are kept in the Compose file
so adding or changing a Coolify worker does not require manually reconstructing
a command in the dashboard.

The release workflow must run `prisma migrate deploy` once for the release
before activating this Compose resource. The Compose file intentionally does
not keep a long-running migration service or make workers depend on Compose
service names; PostgreSQL, Redis, and object storage are independently managed
Coolify resources addressed through their configured URLs.

The backend entrypoint writes the PostgreSQL and Redis CA certificates before
connecting. For `rediss://`, the shared Compose environment passes the Redis CA
pair to the backend and every backend-image worker. Coolify should run the
migration target once per release, then activate the backend and workers. The
backend runtime command is application-only and does not rerun migrations on
container restart.

The slicing dispatcher, slicer consumer, Orca runner, and volume initializer
are an opt-in group for real automatic quotes. The slicer consumer and Orca
runner must mount the same private exchange volume at `/var/run/taven-orca`.
Use a bounded 1 GiB tmpfs for that mount (or an equivalent filesystem quota no
larger than 1 GiB); do not use an unbounded persistent volume. The per-process
file-size limit does not bound aggregate request-directory growth.
Initialize that volume to owner `10001:10001`, mode `0770`, before starting the
runner or consumer. The one-shot initializer must mount the exchange volume,
run as `0:0`, override its entrypoint to `/bin/sh -c`, and run the ownership
command with `CHOWN` capability only:

```sh
chown 0:0 /var/run/taven-orca && chmod 0770 /var/run/taven-orca
for request in /var/run/taven-orca/request-*; do
  [ -d "$request" ] || continue
  chown 0:0 "$request" && chown -R 0:0 "$request" && rm -rf "$request"
done
chown 10001:10001 /var/run/taven-orca
```

Before enabling automatic quotes, verify the identity of the image actually
deployed for the Orca runner. A Coolify Dockerfile build can have a different
OCI manifest digest from the canonical digest in
`tools/slicing-fixtures/runtime.lock.json`; the Docker image/config ID and the
upstream AppImage digest are not substitutes for that manifest digest. Resolve
the deployed runner's immutable `linux/amd64` manifest digest from the registry
or Coolify deployment metadata and compare it with the lock. If it matches,
leave `TAVEN_ORCA_IMAGE_SHA256` at the lock value. If it differs, do not use
the default silently: either publish the reviewed canonical OCI artifact, or
set `TAVEN_ORCA_IMAGE_SHA256` on the slicer consumer to the verified deployed
manifest digest (without the `sha256:` prefix) and record that value with the
release. Never set this variable to an image config ID or an AppImage digest.
The runner and consumer must be promoted together after this identity check.

The Orca runner must mount that initialized volume, set its user to `0:10001`,
override the image entrypoint to `/bin/sh`, and set the command to
`/usr/local/bin/taven-orca-runner` (entrypoint and command are separate Coolify
settings). It also needs `network_mode: none`, a read-only root, the bounded
`/tmp` and `/work` tmpfs mounts, and the capabilities/security profile
documented in the slicer worker README. It must not receive Redis, S3, database,
or other application credentials.

Bubblewrap setup runs as the broker's container UID 0/GID 10001 with only
`SYS_ADMIN`, `SETUID`, `SETGID`, and `SETPCAP`; the container is never Docker
privileged. The fixed inner `setpriv` drops to UID/GID 10001 and empties every
capability set before Orca runs. Match the broker-only LSM/security settings
from ADR 0008 and verify the actual engine state and a real slice after deploy.
Do not enable global unprivileged-user-namespace sysctls to support a
pre-Bubblewrap identity drop. The [#171 ADR amendment](../../docs/decisions/0008-pin-orcaslicer-v2-4-2.md#root-setup-and-unprivileged-engine-handoff-2026-09-21-171)
defines the fail-closed boundary, runtime validation and rollout requirements.

PostgreSQL, Redis, and object storage remain separate Coolify-managed resources
with environment-specific credentials and private connectivity. Staging and
production must never share application credentials or databases.

## Environment configuration

Configure each Coolify resource explicitly. At minimum, the backend and its
workers receive the environment variables documented by their `.env.example`
files, including an exact `TAVEN_ENVIRONMENT` of `staging` or `production`.
For Coolify-managed PostgreSQL with a private CA, also set
`TAVEN_DATABASE_CA_CERT_B64` to the base64-encoded PostgreSQL CA PEM,
`TAVEN_DATABASE_CA_CERT_PATH=/etc/secrets/postgres-ca.crt`, and make
`DATABASE_URL` include
`sslmode=verify-full&sslrootcert=/etc/secrets/postgres-ca.crt`. The CA path is
written by the non-root runtime user and is used by the backend, migrations,
and backend workers. For a distinct Redis CA, also set
`TAVEN_REDIS_CA_CERT_B64` and `TAVEN_REDIS_CA_CERT_PATH=/etc/secrets/redis-ca.crt`
on those resources; the backend entrypoint combines both PEMs before Node
starts. The slicer consumer follows the same Redis CA rule through its own
entrypoint. Keep
`TAVEN_REDIS_URL` a root URL with no database path or query string.
The web resource receives:

- `NUXT_API_BASE_URL` for its private backend URL;
- `NUXT_PUBLIC_API_BASE_URL` and `NUXT_PUBLIC_SITE_URL` for the public origins;
- `NUXT_PUBLIC_DEPLOYMENT_ENVIRONMENT` set to the same environment identity; and
- `NUXT_PUBLIC_AUTOMATIC_QUOTE_ENABLED` only for the approved staging exercise.

For private development/staging testing, enable the existing quote, upload,
checkout, and sandbox-payment switches in the staging resources only. The
payment sandbox URL and `TAVEN_API_PUBLIC_URL` must be the same reachable HTTPS
API origin, and `TAVEN_PAYMENT_SANDBOX_WEBHOOK_SECRET` must be an explicit
staging-only secret of at least 32 characters; production keeps these switches
fail-closed. If Comgate is selected, set `TAVEN_COMGATE_TEST_MODE` explicitly
(`true` for staging and `false` for production); the Compose file passes an
empty value through for sandbox or disabled payment deployments, where the
setting is not used. Configure
`TAVEN_RETENTION_S3_ACCESS_KEY_ID` and `TAVEN_RETENTION_S3_SECRET_ACCESS_KEY`
as a separate least-privilege pair for the retention worker, and set
`TAVEN_RETENTION_DATABASE_URL` to its separate database role. All other
backend-image services use scoped configuration for their dedicated bootstrap:
payment credentials only go to the checkout worker, operator credentials only
go to the operator-expiry worker, and
`TAVEN_SLICER_S3_ACCESS_KEY_ID`/
`TAVEN_SLICER_S3_SECRET_ACCESS_KEY` plus Redis go only to the slicing
dispatcher. The retention worker receives only its database and object-storage
configuration through a minimal environment and uses a dedicated bootstrap
module, so it does not receive payment, quote, OAuth, or other request-time
application secrets and does not initialize slicing-profile snapshots.

Set `TAVEN_DELIVERY_SELECTOR_MODE` explicitly. `CONFIGURED` requires a non-empty
`TAVEN_DELIVERY_ENDPOINTS_JSON`; `PACKETA` requires the Packeta widget account
and may omit configured endpoints. The Compose file uses an empty JSON array as
the Packeta-compatible fallback, while the backend rejects that value if
`CONFIGURED` is selected.

Coolify owns each resource's health check, restart policy, and private network
attachment. Configure domains, the selected origin proxy/TLS boundary, and
restricted staging access through the Coolify/host operations path; do not add
proxy or ingress labels to application Compose files. Public production
activation remains gated by the approved legal and operational release criteria
in #39.

## Local development

Use only `infra/docker/docker-compose.yml` for local development and
integration tests. It contains the local PostgreSQL, Redis, MinIO, Garage
contract, backend, web, admin, slicer, and all backend-image worker services.
Its local-only defaults enable the private test flows. `garage.toml` is used
only by the local Garage contract service; it is not a Coolify deployment
definition.

Validate local configuration with:

```sh
docker compose -f infra/docker/docker-compose.yml \
  --profile app --profile worker \
  config --quiet
```

Do not use the local Compose file as a production/staging deployment
definition; use `infra/coolify/docker-compose.yml` for the backend resource.
