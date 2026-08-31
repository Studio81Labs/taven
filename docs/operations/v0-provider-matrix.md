# V0 provider and operations matrix

- **Status:** selected for v0
- **Decision date:** 2026-08-31
- **Owner:** `@akadlec` for every production account and provisioning action
- **Related decisions:** [ADR 0006](../decisions/0006-run-v0-on-an-owner-operated-vps.md),
  [ADR 0007](../decisions/0007-keep-v0-providers-behind-ports.md),
  [ADR 0008](../decisions/0008-pin-orcaslicer-v2-4-2.md)

This is the configuration matrix required by issue #37. It selects concrete v0
services while keeping application contracts portable. Prices are public list
prices reviewed on the decision date; actual checkout, tax, exchange rate, and
contract terms win. No value in this document is a credential.

## Selected services

| Capability                                | Selected v0 plan and runtime                                                                                                                                                                                                                                                                                                                                                                           | Test or credential path                                                                                                                                                                                                                                                    | Idle and usage cost                                                                                                                                                                                | Exit or fallback                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime host                              | Existing owner-operated x86-64 Linux VPS; Docker Engine and Compose; minimum target 4 vCPU, 16 GiB RAM, 200 GB SSD                                                                                                                                                                                                                                                                                     | GitHub `staging`/`production` Environment secrets: `TAVEN_DEPLOY_HOST`, `TAVEN_DEPLOY_USER`, `TAVEN_DEPLOY_SSH_KEY`; runtime files under `/etc/taven/secrets`                                                                                                              | CZK 0 incremental while existing capacity is sufficient; no per-request fee                                                                                                                        | Move the same OCI images and mounted volumes to any Docker/OCI host; restore from the documented off-host backup                                                                                                                |
| Builds and image delivery                 | GitHub Actions builds verified OCI archives and a release manifest, transfers them over restricted SSH, and deploys only the recorded digests; the VPS keeps the current and previous releases                                                                                                                                                                                                         | Workflow `GITHUB_TOKEN` plus `TAVEN_DEPLOY_HOST`, `TAVEN_DEPLOY_USER`, and `TAVEN_DEPLOY_SSH_KEY`; no registry credential                                                                                                                                                  | CZK 0 while this repository remains public and uses standard runners; #39 sets a usage budget and removes short-lived artifacts after transfer                                                     | Run the same build on a self-hosted runner, add an owner-operated OCI registry, or use GHCR explicitly if direct transfer becomes operationally inadequate                                                                      |
| Local development and integration testing | Existing dependency Compose stack for PostgreSQL 18, Redis 8, and MinIO plus a required #39 integration profile that builds and runs backend, web, admin, worker, and pinned Garage; the worker remains opt-in                                                                                                                                                                                         | Local-only values copied from each app's `.env.example`; no production/provider credential is required; `pnpm dev` remains the fast host-process path                                                                                                                      | CZK 0; developer machine resources only                                                                                                                                                            | Run applications on the host against the dependency stack, or replace Docker Compose with any OCI-compatible local runtime                                                                                                      |
| PostgreSQL                                | Self-hosted PostgreSQL 18 container; persistent `/srv/taven/postgres`; private network only                                                                                                                                                                                                                                                                                                            | Local ignored `apps/backend/.env`; GitHub Environment secret `DATABASE_URL`; production file `/etc/taven/secrets/database-url`                                                                                                                                             | CZK 0 license/incremental host cost; disk and backup usage only                                                                                                                                    | Standard `pg_dump`/restore into any PostgreSQL 18-compatible host; rehearse before changing major version                                                                                                                       |
| Redis/BullMQ                              | Self-hosted Redis 8 container with AOF; private network only; Redis is not authoritative business storage                                                                                                                                                                                                                                                                                              | Local ignored `apps/backend/.env`; GitHub Environment secret `TAVEN_REDIS_URL`; production file `/etc/taven/secrets/redis-url`                                                                                                                                             | CZK 0 license/incremental host cost                                                                                                                                                                | Rebuild queues from PostgreSQL/outbox state or move to another Redis-compatible deployment after BullMQ contract tests                                                                                                          |
| Live object storage                       | Self-hosted Garage v2.3.0, source commit `7b119c0b4fa58ab3cb6d5db435fe52d990f6a7aa`; OCI index `sha256:866bd13ed2038ba7e7190e840482bc27234c4afaf77be8cfa439ae088c1e4690`, linux/amd64 manifest `sha256:dac0c92add4f1a0b41035e94b41036a270ffbe88a37c7ac9c3f19e6dc5bdccf2`; single-node replication factor 1 with private S3 API on `/srv/taven/garage`; application retention jobs remain authoritative | Existing generic `TAVEN_S3_ENDPOINT`, `TAVEN_S3_REGION`, `TAVEN_S3_BUCKET`, `TAVEN_S3_ACCESS_KEY_ID`, and `TAVEN_S3_SECRET_ACCESS_KEY`; local MinIO and Garage test values stay in ignored `.env`; #39 must pass the common S3 contract suite against both implementations | CZK 0 license/incremental host cost                                                                                                                                                                | Change the S3 endpoint to Cloudflare R2 EU, local MinIO, or another tested S3-compatible store; reconcile durable retention state, copy/checksum only live referenced objects, and verify expired-object absence before cutover |
| Off-host backup and object-store fallback | Cloudflare R2 Standard bucket with the immutable `eu` jurisdiction; client-side encrypted restic repository                                                                                                                                                                                                                                                                                            | GitHub Environment secrets `CLOUDFLARE_ACCOUNT_ID`, `TAVEN_BACKUP_R2_ACCESS_KEY_ID`, `TAVEN_BACKUP_R2_SECRET_ACCESS_KEY`; root-owned backup files on the VPS                                                                                                               | First 10 GB-month, 1m Class A, and 10m Class B operations per month included; then USD 0.015/GB-month, USD 4.50/m Class A, USD 0.36/m Class B; egress free                                         | Restore to Garage, use R2 as the live generic S3 endpoint, or copy the restic repository to another S3-compatible target                                                                                                        |
| Payment                                   | Comgate Start as the first adapter with `country=CZ`, `curr=CZK`, and enabled methods discovered from the Merchant API; CZK settlement account                                                                                                                                                                                                                                                         | Comgate merchant and secret from Client Portal > Integration > Shop settings in GitHub `staging` secrets `TAVEN_COMGATE_MERCHANT_ID` and `TAVEN_COMGATE_SECRET`; test payments use the documented `test=true` virtual provider; separate production values in `production` | No setup, monthly, cancellation, or CZK payout fee on published Start tariff; cards free through CZK 50,000 monthly then 0.98%; Czech/SK/PL bank transfers 0.98%; refund CZK 2; chargeback CZK 990 | ThePay adapter when Czech bank buttons are mandatory; Stripe adapter for card checkout. Stripe Czech domestic EEA cards are 1.5% + CZK 6.50 at the reviewed price                                                               |
| Transactional email                       | Resend Free, one authenticated `taven.cz` sending domain; provider-neutral outbox adapter                                                                                                                                                                                                                                                                                                              | Resend test key in GitHub `staging` secret `TAVEN_RESEND_API_KEY`; independent production key in `production`; production file `/etc/taven/secrets/resend-api-key`                                                                                                         | USD 0 for 3,000 emails/month and 100/day; Pro is USD 20/month for 50,000 with USD 0.90/1,000 overage when the free quota is intentionally left                                                     | SMTP adapter targeting an owner-operated Postfix relay or another transactional provider; templates and outbox identities stay provider-neutral                                                                                 |
| DNS, proxy, and edge TLS                  | Cloudflare Free authoritative DNS and proxy for `taven.cz`; Caddy 2 provides strict-TLS origin termination                                                                                                                                                                                                                                                                                             | Scoped Cloudflare DNS token in `CLOUDFLARE_API_TOKEN`; no global API key; Caddy origin material under `/etc/taven/secrets/caddy`                                                                                                                                           | CZK 0 on Free; no paid edge add-on selected                                                                                                                                                        | Export DNS records, change authoritative nameservers, and expose the same Caddy origin through another DNS/CDN provider                                                                                                         |
| Domain registration                       | Register `taven.cz` with WEDOS, then delegate authoritative DNS to Cloudflare; WHOIS returned no entry on 2026-08-31, but checkout is authoritative                                                                                                                                                                                                                                                    | Registrar login and recovery material live in the owner's password manager, not GitHub or the repository                                                                                                                                                                   | CZK 160/year excluding VAT, CZK 193.60/year including VAT at the reviewed price; about CZK 16.13/month amortized                                                                                   | Any CZ.NIC-accredited registrar; transfer does not change application or Cloudflare configuration                                                                                                                               |
| Error, resource, and uptime monitoring    | Self-hosted Grafana, Prometheus, Alertmanager, Loki, and Alloy containers; external 15-minute GitHub Actions readiness check for whole-host failure                                                                                                                                                                                                                                                    | Monitoring admin secret `TAVEN_GRAFANA_ADMIN_PASSWORD`; on-host alerts use Resend; the external check calls the non-sensitive readiness endpoint and alerts `@akadlec` through GitHub workflow-failure notifications                                                       | CZK 0 license/incremental host cost; logs/metrics and scheduled CI usage are bounded below and must stay within the GitHub allowance                                                               | Export OpenMetrics/logs to another compatible stack; a second owner-controlled host may replace the GitHub smoke check                                                                                                          |
| Slicing engine                            | OrcaSlicer v2.4.2 official x86-64 AppImage, verified by the SHA-256 in ADR 0008, wrapped in a separately pinned OCI image and started only for queued work                                                                                                                                                                                                                                             | No provider credential or Orca account; fixture inputs and expected results live in Git; final image digest is recorded by #25                                                                                                                                             | CZK 0 license; VPS CPU/RAM only while a worker is running                                                                                                                                          | Retain the previous image/profile revision; any replacement engine requires a reviewed fixture comparison and ADR                                                                                                               |
| Runtime secrets                           | Root-owned `0600` files under `/etc/taven/secrets`, delivered or rotated from protected GitHub Environment secrets                                                                                                                                                                                                                                                                                     | Environment approval and least-privilege deploy credentials; local values only in Git-ignored files copied from `.env.example`                                                                                                                                             | CZK 0                                                                                                                                                                                              | Age-encrypted owner-controlled delivery or a self-hosted secret manager; application containers continue consuming files/environment values                                                                                     |

## Cost envelope

The expected idle direct cost is **CZK 193.60/year**, or **CZK 16.13/month
amortized**, for the domain. Hosting, gateway, DNS, self-hosted data services,
monitoring, Resend, and expected low-volume R2 backup usage add CZK 0 while the
existing VPS and published free allowances are sufficient. Payment, storage,
email, and CI costs then scale with actual use.

The existing VPS bill is a disclosed shared/sunk owner cost, not proof that
hosting is intrinsically free. For v0, the owner explicitly accepts using its
currently unused allocation at **CZK 0 incremental project cost**; the existing
base bill is outside Taven's direct idle-cost envelope. Issue #39 must record the
host provider, EU/EEA location, contracted plan, actual bill, DPA, and measured
available capacity before customer data enters it. If Taven requires a larger
plan or dedicated host, that incremental cost enters the envelope. A total above
a few hundred CZK per month requires a new explicit owner exception before
production.

The following are deliberately not idle subscriptions: Resend Pro is enabled
only after volume needs it; R2 overage is usage-based; the slicer runs only for
queued work; no paid monitoring, secrets, Cloudflare, or registry plan is
selected.

## Production provisioning checklist

### Host and containers

- [ ] Confirm the existing VPS is in the EU/EEA, has the target CPU/RAM/disk
      available, and has a provider DPA if a third party owns the physical
      infrastructure. Owner-operated physical infrastructure has no processor
      DPA, but its location still must be recorded privately.
- [ ] Install supported Docker Engine and Compose versions; pin every production
      image and base image by digest; enable unattended host security updates
      with a documented reboot window.
- [ ] Create `/srv/taven` state paths and `/etc/taven/secrets`; set least-privilege
      ownership, `0600` secret permissions, disk alerts, and tested volume
      capacity limits.
- [ ] Keep PostgreSQL, Redis, Garage, and monitoring ports private. Expose only
      Caddy HTTPS and source-restricted SSH. Restrict the origin to Cloudflare
      address ranges where operational access permits it.
- [ ] Build independent production images for backend, web, admin, and worker.
      Record one release manifest containing every image digest. Add a local
      integration Compose profile that builds those same images with local
      dependencies and no production credentials. Prove both the local stack
      and rollback to the prior production manifest without reversing a
      migrated schema.
- [ ] Give every container CPU/memory limits and health checks. Keep the slicer
      outside the default Compose profile, allow only bounded job input/output
      mounts, disable its network, and prove it exits after draining work.

### PostgreSQL, Redis, object storage, and backups

- [ ] Create separate least-privilege database and S3 credentials for the
      application, migrations, retention worker, and backup process where their
      operations differ. Do not use Garage administrative credentials in an app
      container.
- [ ] Put PostgreSQL data, Redis AOF, and Garage data on explicit persistent
      volumes. Run database migrations once per release under an advisory lock.
- [ ] Create private live, quarantine, and backup scopes or prefixes. Apply
      abort-incomplete-multipart and quarantine lifecycle rules as
      defense-in-depth; do not replace database retention deadlines with bucket
      age alone.
- [ ] Upgrade Garage only by explicit release, source commit, and OCI digest.
      Before promotion, run the common S3 compatibility suite against both
      Garage and local MinIO: signed upload/download with a signed checksum
      header, HEAD checksum, range read, copy, list, retention deletion/HEAD,
      encrypted backup, and restore. Retain the prior digest and a compatible
      backup until rollback is no longer needed.
- [ ] Create the R2 bucket with the immutable `eu` jurisdiction, not a best-effort
      location hint. Accept Cloudflare's DPA before customer data enters it.
- [ ] Run a nightly consistent PostgreSQL dump plus encrypted restic backup of
      database dumps and Garage data to R2. Keep seven daily and four weekly
      snapshots, prune daily, and cap the oldest recoverable customer-content
      copy at 35 days unless a legal hold is documented.
- [ ] Keep every not-yet-expired live object in Garage for its full application
      retention or hold. Because it remains live, each new backup continues to
      include it throughout that period; the 35-day backup history limits only
      how long an already-deleted or superseded copy remains recoverable.
- [ ] Treat v0 backup objectives as RPO 24 hours and best-effort RTO 4 hours.
      Test checksum verification monthly and a full non-production restore at
      least quarterly and before a major database or storage change.
- [ ] On restore, keep public traffic disabled until migrations, the durable
      retention/deletion reconciliation, and object absence verification have
      completed. A live deletion is verified with S3 HEAD; encrypted backup
      copies become irrecoverable no later than snapshot pruning and R2 object
      deletion. Application reads never access backup buckets.
- [ ] Rebuild Redis/BullMQ work from authoritative PostgreSQL and outbox state
      after disaster recovery instead of trusting stale queue state.

### Payment

- [ ] Complete Comgate merchant onboarding for the Start tariff and obtain the
      merchant ID and secret. The same connection creates isolated test
      payments through `test=true` and the virtual provider; production never
      reuses test transaction identities. Confirm the contracted price,
      settlement cadence/cutoff, API rate limits, and controller/DPA roles.
- [ ] At provisioning, query the Merchant API's allowed-method list and fail the
      launch check unless the required Czech bank buttons and cards are enabled
      for CZK. Keep the returned capability snapshot as launch evidence.
- [ ] Configure the HTTPS push endpoint on `api.taven.cz` and allow only the
      adapter to parse provider payloads. A push is a wake-up signal, not proof
      of payment: always read `/2.0/status` with Merchant API credentials before
      mutation. Never put a provider secret, result, or callback body into a
      browser URL or log.
- [ ] Contract-test create, authoritative read, cancel/void, full refund, decline,
      delayed result, duplicate/out-of-order callback, invalid authentication,
      timeout, and provider outage. Persist Taven's command idempotency identity
      before calling Comgate.
- [ ] Reconcile provider settlement against Taven payments before launch. Keep a
      manual compensation/refund runbook and prove that retries cannot create a
      second intent or refund.
- [ ] If Comgate cannot confirm the gate, do not weaken it silently. Select ThePay
      for Czech bank buttons or Stripe for cards, implement that adapter, and
      update this matrix with the accepted commercial difference.

### Email

- [ ] Create separate Resend test and production API keys with the least
      available scope. Authenticate `taven.cz` using SPF and DKIM; publish a
      monitored DMARC policy and dedicated bounce/return path where supported.
- [ ] Send only rendered transactional content and short-lived links. Do not
      attach customer models or photographs. Accept and retain the Resend DPA;
      document that EU-only processing is not guaranteed by the selected plan.
- [ ] Authenticate and deduplicate delivery/bounce webhooks, enforce the
      100-email daily Free limit before enqueue, alert before exhaustion, and
      upgrade intentionally rather than dropping mail.
- [ ] Prove outbox replay, provider timeout, duplicate delivery result, permanent
      bounce, admin resend, and switch to a test SMTP adapter.

### Domain, DNS, secrets, and monitoring

- [ ] Recheck availability and register `taven.cz`; enable registrar lock,
      automatic renewal, recovery codes, and multi-factor authentication. Keep
      the registrant and billing evidence in the owner's records.
- [ ] Add the domain to Cloudflare Free, delegate nameservers, enable DNSSEC, and
      create only reviewed `taven.cz`, `www`, and `api` records. Keep admin
      access non-public or separately protected until its authentication is
      production-ready.
- [ ] Use strict TLS from Cloudflare to Caddy, redirect HTTP, configure CORS and
      security headers, and test certificate renewal and a Cloudflare-bypass
      attempt.
- [ ] Protect GitHub production Environment changes with owner approval. Rotate
      deploy, database, Redis, S3, payment, email, monitoring, and Cloudflare
      credentials independently and record the rotation date outside Git.
- [ ] Retain searchable application logs for 14 days and metrics for 30 days,
      bounded by disk quotas. Never log secrets, raw capability tokens, model or
      photo contents, full payment callback bodies, or email bodies.
- [ ] Alert on public health, host/disk pressure, PostgreSQL/Redis/Garage health,
      queue age/dead letters, slice errors, payment mismatches/refunds, email
      failures, retention failures, and backup freshness. Exercise every alert
      and link it to the issue #39 runbook.
- [ ] Run the external GitHub readiness check every 15 minutes with a 10-second
      connection timeout, 30-second overall timeout, and one retry. A failure
      fails the workflow and reaches `@akadlec` through GitHub notifications,
      independent of Taven and Resend. Exercise it by targeting a non-production
      unavailable origin. A same-host dashboard is not evidence that the host
      is externally reachable.

### OrcaSlicer

- [ ] Follow ADR 0008 and issue #25: verify the upstream AppImage size and
      SHA-256 before extraction, pin the final OCI digest, and retain license,
      source, and profile provenance.
- [ ] Run the clean fixture corpus twice, review normalized output and profile
      hashes, and record CPU/platform assumptions before any quote consumes the
      result.
- [ ] Keep the previous engine/profile revision deployable until its referenced
      jobs have drained. Never replace an image under an existing version tag.

## Data location, contracts, and operational limits

- The live database, queue, object store, logs, and metrics stay on the selected
  EU/EEA VPS. The R2 backup bucket uses Cloudflare's `eu` jurisdiction, which is
  a guarantee rather than the non-binding Western/Eastern Europe location hint.
- Comgate's published terms describe merchant and gateway as controllers for
  relevant payer data. Onboarding must confirm the exact production roles and
  documents; code must minimize the shared fields either way.
- Resend supplies a DPA with SCCs. The Free plan has 30-day service data
  retention, 3,000 emails/month, and a hard 100/day limit. Taven stores its own
  outbox and does not depend on Resend history as the audit record.
- Cloudflare R2 Standard has no minimum storage duration and DeleteObject is a
  free operation. The live application does not use R2 until fallback; backup
  deletion is bounded by the 35-day encrypted snapshot policy.
- An object-store migration enters maintenance mode, snapshots the durable
  object references, retention deadlines, and holds, runs deletion
  reconciliation, copies and verifies only still-live referenced objects, then
  switches the generic S3 endpoint. A second reconciliation runs before traffic
  resumes; expired or unreferenced objects must not be resurrected at the new
  provider.
- Self-hosted services do not sleep. This avoids production cold starts but
  consumes the existing host allocation. The slicer is the only scale-to-zero
  component and must have a start/drain/exit controller implemented in #39.
- A single VPS has no high-availability SLA. The selected v0 guarantee is a
  tested restore and externally observable failure, not uninterrupted service.

## Required follow-up implementation

- [Issue #21](https://github.com/Studio81Labs/taven/issues/21) implements and
  tests the provider-neutral payment port and the gated Comgate adapter.
- [Issue #25](https://github.com/Studio81Labs/taven/issues/25) builds the pinned
  Orca runtime, records its final OCI digest, and establishes the fixture corpus.
- [Issue #39](https://github.com/Studio81Labs/taven/issues/39) adds the real
  production containers, a local full-stack integration Compose profile,
  Compose/release manifests, GitHub deployment, the provider-neutral S3
  presigner adjustment and MinIO/Garage contract matrix, self-hosted
  observability, Resend/SMTP adapters, retention, backups, restore drill,
  secrets rotation, and runbooks. It must not add unselected provider
  placeholders.

## Reviewed primary sources

- [Comgate Start tariff](https://www.comgate.cz/files/start-pb-cz-2024v2.pdf)
  and [Comgate terms](https://www.comgate.cz/files/obchodni-podminky-comgate-as-od-23-08-2024.pdf),
  [Merchant API](https://apidoc.comgate.cz/en/api/rest/),
  [push notifications](https://apidoc.comgate.cz/en/push-notifikace/), and
  [test-payment portal](https://help.comgate.cz/v1/docs/sk/navod-na-pouzitie)
- [Stripe Czech pricing](https://stripe.com/en-cz/pricing) and
  [payment-method support](https://docs.stripe.com/payments/payment-method-support)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/),
  [S3 compatibility](https://developers.cloudflare.com/r2/get-started/s3/), and
  [EU jurisdiction](https://developers.cloudflare.com/r2/reference/data-location/)
- [Garage v2.3.0 source tag](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.3.0),
  [quick start](https://garagehq.deuxfleurs.fr/documentation/quick-start/), and
  [S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)
- [Resend pricing and quotas](https://resend.com/docs/knowledge-base/what-is-resend-pricing)
  and [Resend DPA](https://resend.com/legal/dpa)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [CZ.NIC registrar list](https://www.nic.cz/whois/registrars/) and
  [WEDOS domain price](https://hosting.vedos.cz/domeny/)
- [OrcaSlicer v2.4.2 release](https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.4.2)
  and [AGPL-3.0 license](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/LICENSE.txt)
