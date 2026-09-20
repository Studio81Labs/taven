# Coolify service layout

Production and staging are managed by Coolify as independent resources. This
repository does not provide a production/staging Compose project, and
application containers must not rely on Compose networking, Traefik labels, or
shared `.env` interpolation.

Create the resources separately in each Coolify environment:

- backend API from `apps/backend/Dockerfile` (`runtime` target);
- one-shot migration from the same Dockerfile (`migration` target), completed
  once for the release before activating the API and workers;
- public web from `apps/web/Dockerfile` (`runtime` target);
- operator admin from `apps/admin/Dockerfile` (`runtime` target);
- each required backend worker from the backend runtime image with its worker
  command; and
- the opt-in slicing dispatcher from the backend runtime image;
- the opt-in slicer consumer from `apps/slicer-worker/Dockerfile`;
- the pinned Orca runner from `apps/slicer-worker/Orca.Dockerfile`; and
- a one-shot volume initializer for the private slicer exchange.

The backend and migration entrypoints write the optional PostgreSQL and Redis CA
certificates before connecting. For `rediss://`, set the Redis CA pair on the
backend and every backend worker resource (or reuse the PostgreSQL pair when
Coolify uses one CA for both services). Coolify should run the migration
resource once per release under the release workflow's migration credential,
then activate the backend and workers. The backend runtime command is
application-only and does not rerun migrations on container restart. The local
Compose stack retains its one-shot migration service because it models local
dependency ordering.

The slicing dispatcher, slicer consumer, Orca runner, and volume initializer
are an opt-in group for real automatic quotes. The slicer consumer and Orca
runner must mount the same private exchange volume at `/var/run/taven-orca`.
Initialize that volume to owner `10001:10001`, mode `0770`, before starting the
runner or consumer. The one-shot initializer must mount the exchange volume,
run as `0:0`, override its entrypoint to `/bin/sh`, and run the ownership
command with `CHOWN` capability only:

```sh
chown 0:0 /var/run/taven-orca && chmod 0770 /var/run/taven-orca
for request in /var/run/taven-orca/request-*; do
  [ -d "$request" ] || continue
  chown 0:0 "$request" && chown -R 0:0 "$request" && rm -rf "$request"
done
chown 10001:10001 /var/run/taven-orca
```

The Orca runner must mount that initialized volume, set its user to `0:10001`,
override the image entrypoint to `/bin/sh`, and set the command to
`/usr/local/bin/taven-orca-runner` (entrypoint and command are separate Coolify
settings). It also needs `network_mode: none`, a read-only root, the bounded
`/tmp` and `/work` tmpfs mounts, and the capabilities/security profile
documented in the slicer worker README. It must not receive Redis, S3, database,
or other application credentials.

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
fail-closed.

Coolify owns each resource's health check, restart policy, and private network
attachment. Configure domains, the selected origin proxy/TLS boundary, and
restricted staging access through the Coolify/host operations path; do not add
proxy or ingress labels to application Compose files. Public production
activation remains gated by the approved legal and operational release criteria
in #39.

## Local development

Use `infra/docker/docker-compose.yml` with the local overlay for local
development and integration tests. That Compose stack is intentionally
separate from Coolify and is the only place where the repository supplies a
multi-container application topology.

Validate local configuration with:

```sh
docker compose -f infra/docker/docker-compose.yml \
  -f infra/docker/docker-compose.local.yml --profile app --profile worker \
  config --quiet
```

Do not use the local Compose files as a production/staging deployment
definition.
