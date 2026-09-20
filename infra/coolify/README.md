# Coolify environment preparation

`docker-compose.coolify.yml` prepares the application side of two independent
Coolify environments, `staging` and `production`. It is **not a completed
production rollout or deployment workflow**. Both application resources are
created stopped, automatic Git deployment is off, public ingress is off, and
commercial launch flags are hard-disabled in this preparation configuration.
Issue #39 still owns the launch and operational acceptance criteria.

## Resource layout

Each environment has native Coolify PostgreSQL 18 and Redis 8 resources plus
one Git-backed Compose application. Native databases keep Coolify's database
backup integration available. Each has its own credentials, host paths, and
external Docker network named `taven-staging` or `taven-production`.

The Compose application contains a one-shot migration, API, Nuxt web, Vite
admin, checkout reconciliation, operator-session expiry, balance-payment
deadlines, reservation expiry, and retention workers. API and web use Docker
health checks. Every backend process depends on successful migration.

The optional `slicing` profile contains the slicing dispatcher, Node consumer,
private exchange initializer, and networkless Orca runner. It is deliberately
not active during preparation. The consumer and runner use `restart: "no"`
so a host reboot does not implicitly enable manually started slicing. The
current consumer runs until stopped; this configuration does not claim to
implement the bounded drain-and-exit controller required by ADR 0006. Do not
turn on slicing until that controller and failure monitoring are implemented.
Do not run both environments' slicing profiles together on an unqualified host.

One Garage 2.3.0 service, shown under production as `taven-garage-shared`, joins
both environment networks with the alias `taven-garage`. It has separate
`taven-staging` and `taven-production` buckets and credentials restricted to
read/write on their own bucket. There is no S3 host port or public domain yet.
Neither environment may delete this shared resource during ordinary teardown.

## Host storage

- PostgreSQL: `/srv/taven/<environment>/postgres`, mounted at
  `/var/lib/postgresql` for PostgreSQL 18.
- Redis AOF: `/srv/taven/<environment>/redis`, mounted at `/data`, with
  `maxmemory-policy noeviction` for BullMQ.
- Garage: `/srv/taven/storage`, a bind mount of the attached data volume's
  separate `taven` directory. Tarmoto's directory is not reused.
- Garage configuration: `/etc/taven/garage.toml`, root-readable only.
- Docker requires the data volume mount before starting.
- The Orca exchange remains a bounded, private tmpfs per Compose project; it is
  scratch space, not object storage or shared cross-environment state.

The initial Bravo allocation is 4 vCPU / 8 GiB RAM with an already shared 20 GB
attached volume. This is below ADR 0006's 16 GiB / 200 GB capacity target. Resource
limits bound the prepared containers; their sum is not a guarantee that every
container can run at its limit simultaneously. Load testing or a recorded
capacity revision is required before launch alongside Tarmoto.

## Coolify application settings

- Git repository: `Studio81Labs/taven`.
- During review: preparation branch, pinned to its reviewed commit. After merge,
  select `main` and pin the release commit through the deployment controller.
- Build pack: Docker Compose; file `/docker-compose.coolify.yml`; base `/`.
- Enable Raw Compose and Preserve Repository. Relative configs and build
  contexts are resolved against the repository root.
- Enable source commit in build; disable automatic build-ARG injection.
- Disable auto-deploy and preview deployments.
- Keep one image revision for staging; retain rollback candidates for production.
- Keep runtime secrets runtime-only. Only environment, source commit, public API
  URL, website URL and ingress host/configuration values are build-time inputs.

The Compose file intentionally permits empty runtime variables during build-time
interpolation. Backend/worker validation rejects missing runtime credentials;
required missing values are also marked in Coolify. Do not substitute local
credentials or `TAVEN_ENVIRONMENT=development` to bypass that validation.

All secrets are selected explicitly in Compose. Do not switch to Coolify's
managed Compose mode that injects one shared `.env` into every service: that
would expose backend credentials to the public frontend containers. Backend
background processes currently boot the full AppModule and therefore still need
its authentication/storage configuration. Service-specific `*_FILE` support and
narrower worker configuration remain production-hardening work under #39.

## GitHub environments

`staging` and `production` accept deployment jobs from `main` only. Each contains
its own `COOLIFY_API_TOKEN`, database/Redis URLs, S3 credentials, and generated
authentication/capability keys. No secret values are in this repository.

Environment variables include:

- `COOLIFY_API_BASE_URL`, `COOLIFY_APPLICATION_UUID`, `COOLIFY_POSTGRES_UUID`,
  `COOLIFY_REDIS_UUID`, `COOLIFY_GARAGE_UUID`, `COOLIFY_SERVER_UUID`.
- `TAVEN_ENVIRONMENT`, S3 endpoint/region/bucket and path-style selection.
- `TAVEN_DEPLOYMENT_ENABLED=false`, `TAVEN_PUBLIC_INGRESS_ENABLED=false`, and
  commercial flow flags set to `false`.

For the approved development/staging exercise only, the staging environment
may set `TAVEN_BINDING_QUOTE_FLOWS_ENABLED=true`,
`TAVEN_QUOTE_PHOTO_UPLOADS_ENABLED=true`,
`TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED=true`,
`TAVEN_CLAIM_WINDOW_DAYS=30`, and
`NUXT_PUBLIC_AUTOMATIC_QUOTE_ENABLED=true`. It must also set
`TAVEN_PAYMENT_PROVIDER=sandbox` and
`TAVEN_PAYMENT_SANDBOX_PUBLIC_URL` to the reachable staging API origin (never
the localhost default). Set `TAVEN_API_PUBLIC_URL` to the same public HTTPS
origin; the backend verifies the two origins match. Use the development/staging legal baseline
imported through the protected admin workflow. Keep these variables unset or
`false` for production; this Compose file defaults to the fail-closed values.
The web runtime receives `TAVEN_ENVIRONMENT` as its public deployment identity;
staging pages emit `noindex, nofollow` and `/robots.txt` disallows the whole
site, while production keeps normal indexing behavior.
Every optional router is also behind a Traefik IP allowlist. The default
`TAVEN_INGRESS_ACCESS_CIDRS=127.0.0.1/32` denies public access; configure an
explicit trusted CIDR list only after the proxy source address and staging
access procedure have been verified. Do not enable staging ingress without it.

`TAVEN_DEPLOYMENT_ENABLED` is a handoff flag for the future workflow, not an
existing enforcement mechanism. Current enforcement is stopped applications,
disabled auto-deploy, no public ingress, and missing required configuration.
Coolify's current tokens are team-scoped, not limited to one application UUID;
keep them in the protected GitHub environments and rotate/revoke them there and
in Coolify together.

## Planned domains

The owner selected `taven.cz`; it is not registered yet. The following planned
URLs are stored in Coolify and GitHub environment variables, with public ingress
and automatic deployment still disabled. No DNS or certificates are provisioned.

| Service            | Production               | Staging                          |
| ------------------ | ------------------------ | -------------------------------- |
| Web                | `https://taven.cz`       | `https://staging.taven.cz`       |
| API                | `https://api.taven.cz`   | `https://api-staging.taven.cz`   |
| Admin              | `https://admin.taven.cz` | `https://admin-staging.taven.cz` |
| Shared S3 endpoint | `https://s3.taven.cz`    | `https://s3.taven.cz`            |

GitHub login callbacks use each API origin plus `/admin/auth/github/callback`;
completion URLs use the corresponding admin origin. Browser CORS origins are
the web and admin origins of the same environment. Garage still has no public
route; its planned S3 hostname does not change bucket or credential isolation.

## Required before first application deployment

1. Register the selected domain and configure DNS, verified API/web/admin/S3
   HTTPS routing, and narrowly trusted proxy addresses. Public
   ingress stays off until verified TLS and DNS are ready.
2. Register/configure separate environment login callbacks and supply
   `TAVEN_GITHUB_APP_CLIENT_ID` and `TAVEN_GITHUB_APP_CLIENT_SECRET`. These are
   application login credentials, not the Coolify repository integration.
3. Configure real delivery endpoints (`CONFIGURED` plus non-empty
   `TAVEN_DELIVERY_ENDPOINTS_JSON`) or `PACKETA` plus its widget account ID.
   No fake production endpoint is provisioned.
4. Complete #39's reviewed-SHA deployment serialization/pin/readback, migration
   failure handling, smoke tests, release manifest and rollback procedure.
   This change does not introduce an automatic deploy workflow.
5. Verify the exact Orca image digest and fixture corpus before enabling the
   slicing profile. The read-only broker config is versioned with the pinned
   Git commit and must match the runtime-lock invocation identity. No Docker
   socket, privileged container, or extra network is supplied to Orca.
6. Configure and rehearse native PostgreSQL backups, coordinated Garage
   backups, retention, monitoring and credential recovery. Backups are not
   enabled by this preparation because the approved off-host target is missing.
7. Validate resource usage and pending launch requirements. Enabling paid flows,
   legal publication or provider credentials is outside preparation scope.

## Configuration validation

With non-secret placeholder public URLs, validate both configurations without
starting containers:

```sh
TAVEN_ENVIRONMENT=staging SOURCE_COMMIT=$(git rev-parse HEAD) \
  TAVEN_API_URL=https://api.example.test \
  TAVEN_PUBLIC_SITE_URL=https://web.example.test \
  docker compose -f docker-compose.coolify.yml config --quiet

TAVEN_ENVIRONMENT=production SOURCE_COMMIT=$(git rev-parse HEAD) \
  TAVEN_API_URL=https://api.example.test \
  TAVEN_PUBLIC_SITE_URL=https://web.example.test \
  docker compose -f docker-compose.coolify.yml --profile slicing config --quiet
```

These checks validate Compose structure, not application startup, image
reproducibility, end-to-end storage behavior, or production readiness.
