# Coolify service layout

Production and staging are managed by Coolify as independent resources. This
repository does not provide a production/staging Compose project, and
application containers must not rely on Compose networking, Traefik labels, or
shared `.env` interpolation.

Create the resources separately in each Coolify environment:

- backend API from `apps/backend/Dockerfile` (`runtime` target);
- public web from `apps/web/Dockerfile` (`runtime` target);
- operator admin from `apps/admin/Dockerfile` (`runtime` target);
- each required backend worker from the backend runtime image with its worker
  command; and
- the opt-in slicer worker and pinned Orca runtime from their worker Dockerfiles.

The backend runtime entrypoint writes the optional PostgreSQL CA certificate and
runs `prisma migrate deploy` before starting the API. Coolify should deploy the
backend resource with that default command; a separate production/staging
migration resource is not required. The local Compose stack retains its
one-shot migration service because it models local dependency ordering.

PostgreSQL, Redis, and object storage remain separate Coolify-managed resources
with environment-specific credentials and private connectivity. Staging and
production must never share application credentials or databases.

## Environment configuration

Configure each Coolify resource explicitly. At minimum, the backend and its
workers receive the environment variables documented by their `.env.example`
files, including an exact `TAVEN_ENVIRONMENT` of `staging` or `production`.
For Coolify-managed PostgreSQL with a private CA, also set
`TAVEN_DATABASE_CA_CERT_B64` to the base64-encoded CA PEM,
`TAVEN_DATABASE_CA_CERT_PATH=/etc/secrets/postgres-ca.crt`, and make
`DATABASE_URL` include
`sslmode=verify-full&sslrootcert=/etc/secrets/postgres-ca.crt`. The CA path is
writable by the non-root runtime user and is used by the backend, migrations,
and workers.
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
