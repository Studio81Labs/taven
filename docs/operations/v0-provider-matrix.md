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

| Capability                                | Selected v0 plan and runtime                                                                                                                                                                                                                                                                                                                                                                           | Test or credential path                                                                                                                                                                                                                                                                                                                                                                                | Idle and usage cost                                                                                                                                                                                | Exit or fallback                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime host                              | Existing owner-operated x86-64 Linux VPS; self-hosted Coolify manages Docker Engine and the production Compose project in a dedicated Taven team; minimum target 4 vCPU, 16 GiB RAM, 200 GB SSD                                                                                                                                                                                                        | Coolify owner account and recovery material stay in the owner's password manager; runtime files remain under `/etc/taven/secrets`                                                                                                                                                                                                                                                                      | CZK 0 incremental while existing capacity and the self-hosted Coolify plan are sufficient; no per-request fee                                                                                      | Deploy the same repository Compose project and mounted volumes directly on any Docker/OCI host or through another control plane; restore from the documented off-host backup                                                    |
| Builds and image delivery                 | Coolify automatic Git deployment is disabled. GitHub Actions serializes production, verifies the workflow SHA, writes and reads back that exact `git_commit_sha`, then invokes the deploy-only webhook; Coolify builds the pinned Compose revision; the release manifest records the commit and resulting image digests, and the prior successful revision remains rollback-ready                      | Workflow `GITHUB_TOKEN`; protected production variables `TAVEN_COOLIFY_API_URL` and `TAVEN_COOLIFY_APPLICATION_UUID`; team-scoped `TAVEN_COOLIFY_PIN_TOKEN` with only `read` + `write`; separate `TAVEN_COOLIFY_DEPLOY_WEBHOOK` and `TAVEN_COOLIFY_DEPLOY_TOKEN` with only `deploy`                                                                                                                    | CZK 0 while this repository remains public, standard runners suffice, and Coolify remains self-hosted                                                                                              | Run the same exact-revision Compose build/deploy directly over restricted SSH, on a self-hosted runner, or through another OCI-compatible control plane                                                                         |
| Local development and integration testing | Existing dependency Compose stack for PostgreSQL 18, Redis 8, and MinIO plus a required #39 integration profile that builds and runs backend, web, admin, worker, and pinned Garage; the worker remains opt-in                                                                                                                                                                                         | Local-only values copied from each app's `.env.example`; no production/provider credential is required; `pnpm dev` remains the fast host-process path                                                                                                                                                                                                                                                  | CZK 0; developer machine resources only                                                                                                                                                            | Run applications on the host against the dependency stack, or replace Docker Compose with any OCI-compatible local runtime                                                                                                      |
| PostgreSQL                                | Self-hosted PostgreSQL 18 container; persistent `/srv/taven/postgres`; private network only; Coolify's database-backup configuration creates and uploads the selected database backup                                                                                                                                                                                                                  | Local ignored `apps/backend/.env`; GitHub Environment secret `DATABASE_URL`; least-privilege copies at `/etc/taven/secrets/backend/database-url` and `/etc/taven/secrets/migrator/database-url`; Coolify owns the configured backup execution                                                                                                                                                          | CZK 0 license/incremental host cost; disk and backup usage only                                                                                                                                    | Restore Coolify's PostgreSQL custom-format artifact with `pg_restore` into any compatible PostgreSQL host; rehearse before changing major version                                                                               |
| Redis/BullMQ                              | Self-hosted Redis 8 container with AOF; private network only; Redis is not authoritative business storage                                                                                                                                                                                                                                                                                              | Local ignored app `.env` files; GitHub Environment secret `TAVEN_REDIS_URL`; separate least-privilege copies under `/etc/taven/secrets/backend` and `/etc/taven/secrets/slicer-worker`                                                                                                                                                                                                                 | CZK 0 license/incremental host cost                                                                                                                                                                | Rebuild queues from PostgreSQL/outbox state or move to another Redis-compatible deployment after BullMQ contract tests                                                                                                          |
| Live object storage                       | Self-hosted Garage v2.3.0, source commit `7b119c0b4fa58ab3cb6d5db435fe52d990f6a7aa`; OCI index `sha256:866bd13ed2038ba7e7190e840482bc27234c4afaf77be8cfa439ae088c1e4690`, linux/amd64 manifest `sha256:dac0c92add4f1a0b41035e94b41036a270ffbe88a37c7ac9c3f19e6dc5bdccf2`; single-node replication factor 1 with private S3 API on `/srv/taven/garage`; application retention jobs remain authoritative | Generic `TAVEN_S3_*` inputs; local MinIO/Garage values stay in ignored `.env`; production uses separate least-privilege S3 files under `/etc/taven/secrets/backend`, `/retention-worker`, and `/slicer-worker`; #39 runs the common contract suite against both implementations                                                                                                                        | CZK 0 license/incremental host cost                                                                                                                                                                | Change the S3 endpoint to Cloudflare R2 EU, local MinIO, or another tested S3-compatible store; reconcile durable retention state, copy/checksum only live referenced objects, and verify expired-object absence before cutover |
| Off-host backup and object-store fallback | Cloudflare R2 Standard storage with the immutable `eu` jurisdiction; Coolify PostgreSQL backups and client-side-encrypted restic Garage snapshots use separate private buckets                                                                                                                                                                                                                         | The Coolify DB bucket credential is configured only in Coolify and the owner's password manager. Separate restic `CLOUDFLARE_ACCOUNT_ID`, `TAVEN_BACKUP_R2_ACCESS_KEY_ID`, `TAVEN_BACKUP_R2_SECRET_ACCESS_KEY`, and `TAVEN_BACKUP_RESTIC_PASSWORD` values are escrowed in that password manager and the protected GitHub production Environment; runtime copies stay under `/etc/taven/secrets/backup` | First 10 GB-month, 1m Class A, and 10m Class B operations per month included; then USD 0.015/GB-month, USD 4.50/m Class A, USD 0.36/m Class B; egress free                                         | Restore to Garage, use R2 as the live generic S3 endpoint, or copy both backup buckets to another S3-compatible target                                                                                                          |
| Payment                                   | Comgate Start as the first adapter with `country=CZ`, `curr=CZK`, and enabled methods discovered from the Merchant API; CZK settlement account                                                                                                                                                                                                                                                         | Comgate merchant and secret from Client Portal > Integration > Shop settings in GitHub `staging` secrets `TAVEN_COMGATE_MERCHANT_ID` and `TAVEN_COMGATE_SECRET`; test payments use the documented `test=true` virtual provider; separate production values in `production`                                                                                                                             | No setup, monthly, cancellation, or CZK payout fee on published Start tariff; cards free through CZK 50,000 monthly then 0.98%; Czech/SK/PL bank transfers 0.98%; refund CZK 2; chargeback CZK 990 | ThePay adapter when Czech bank buttons are mandatory; Stripe adapter for card checkout. Stripe Czech domestic EEA cards are 1.5% + CZK 6.50 at the reviewed price                                                               |
| Transactional email                       | Resend Free, one authenticated `taven.cz` sending domain; provider-neutral outbox adapter                                                                                                                                                                                                                                                                                                              | Separate GitHub `staging` and `production` Environment secrets `TAVEN_RESEND_API_KEY` and `TAVEN_RESEND_WEBHOOK_SIGNING_SECRET`; production copies `/etc/taven/secrets/backend/resend-api-key` and `/etc/taven/secrets/backend/resend-webhook-signing-secret`                                                                                                                                          | USD 0 for 3,000 emails/month and 100/day; Pro is USD 20/month for 50,000 with USD 0.90/1,000 overage when the free quota is intentionally left                                                     | SMTP adapter targeting an owner-operated Postfix relay or another transactional provider; templates and outbox identities stay provider-neutral                                                                                 |
| DNS, proxy, and edge TLS                  | Cloudflare Free authoritative DNS and proxy for `taven.cz`; Caddy 2 provides strict-TLS origin termination                                                                                                                                                                                                                                                                                             | Scoped Cloudflare DNS token in `CLOUDFLARE_API_TOKEN`; no global API key; Caddy origin material under `/etc/taven/secrets/caddy`                                                                                                                                                                                                                                                                       | CZK 0 on Free; no paid edge add-on selected                                                                                                                                                        | Export DNS records, change authoritative nameservers, and expose the same Caddy origin through another DNS/CDN provider                                                                                                         |
| Domain registration                       | After issue #38 records successful four-step name clearance and final approval, register `taven.cz` with WEDOS and delegate authoritative DNS to Cloudflare; WHOIS returned no entry on 2026-08-31, but checkout is authoritative                                                                                                                                                                      | Clearance evidence is attached to issue #38; registrar login and recovery material live in the owner's password manager, not GitHub or the repository                                                                                                                                                                                                                                                  | CZK 160/year excluding VAT, CZK 193.60/year including VAT at the reviewed price; about CZK 16.13/month amortized                                                                                   | Any CZ.NIC-accredited registrar; transfer does not change application or Cloudflare configuration                                                                                                                               |
| Error, resource, and uptime monitoring    | Self-hosted Grafana, Prometheus, Alertmanager, Loki, and Alloy containers; external Cloudflare Workers Free cron checks public web and API readiness every 5 minutes; Worker KV stores transition/reminder state and a fixed-destination Email Service binding alerts the owner independently of Taven and Resend                                                                                      | Monitoring admin secret `TAVEN_GRAFANA_ADMIN_PASSWORD`; separate scoped GitHub Environment secret `TAVEN_MONITOR_CLOUDFLARE_API_TOKEN` deploys the Worker; the email binding can send only to the verified owner destination and exposes no runtime mail credential                                                                                                                                    | CZK 0 license/incremental host cost; 288 scheduled checks/day and low transition-state KV usage fit the reviewed Workers Free allowances                                                           | Run the same runtime-neutral check from a second owner-controlled host; export OpenMetrics/logs to another compatible stack                                                                                                     |
| Slicing engine                            | OrcaSlicer v2.4.2 official x86-64 AppImage, verified by the SHA-256 in ADR 0008, wrapped in a separately pinned OCI image and started only for queued work                                                                                                                                                                                                                                             | No provider credential or Orca account; fixture inputs and expected results live in Git; final image digest is recorded by #25                                                                                                                                                                                                                                                                         | CZK 0 license; VPS CPU/RAM only while a worker is running                                                                                                                                          | Retain the previous image/profile revision; any replacement engine requires a reviewed fixture comparison and ADR                                                                                                               |
| Runtime secrets                           | Per-service directories `root:<service-group>` mode `0750` and secret files `root:<service-group>` mode `0440` under `/etc/taven/secrets`; each non-root container receives only its mapped supplemental GID and read-only service mounts                                                                                                                                                              | Environment approval and least-privilege deploy credentials; issue #39 adds `*_FILE` inputs and effective-UID read/cross-service-denial tests; local values stay only in Git-ignored files copied from `.env.example`                                                                                                                                                                                  | CZK 0                                                                                                                                                                                              | Age-encrypted owner-controlled delivery or a self-hosted secret manager; application containers continue consuming provider-neutral file inputs                                                                                 |

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
- [ ] Verify the existing self-hosted Coolify installation, Docker Engine, and
      Compose versions; pin third-party production and base images by digest;
      enable unattended host security updates with a documented reboot window.
- [ ] Create `/srv/taven` state paths and `/etc/taven/secrets`; set least-privilege
      ownership, disk alerts, and tested volume capacity limits. Create one
      `root:<service-group>` mode-`0750` directory per service and mode-`0440`
      files within it; map only that supplemental GID into the non-root
      container and mount the directory read-only. Duplicate shared credential
      values into separately permissioned files instead of sharing groups.
- [ ] Keep PostgreSQL, Redis, Garage, and monitoring ports private. Expose only
      Caddy HTTPS and source-restricted SSH. Restrict the origin to Cloudflare
      address ranges where operational access permits it.
- [ ] Build independent production images for backend, web, admin, and worker.
      Put the application in a dedicated Coolify team and disable automatic Git
      deployment. Make GitHub Actions serialize the production workflow and,
      only after required checks, PATCH the Coolify application
      `git_commit_sha` to `GITHUB_SHA` with the `read` + `write` pin token. Read
      it back and stop before deployment on any mismatch. Then call the separate
      deploy-only webhook and verify the completed deployment record reports the
      same commit and healthy applications. Record one release manifest
      containing that commit and every resulting image digest. Add a local
      integration Compose profile that builds those same images with local
      dependencies and no production credentials. Prove both the local stack
      and rollback to the prior production manifest without reversing a migrated
      schema.
- [ ] Give every container CPU/memory limits and health checks. Keep the slicer
      outside the default Compose profile, allow only bounded job input/output
      mounts, and prove it exits after draining work. Keep the BullMQ wrapper on
      the private network for Redis and object storage, but run each Orca child
      in a distinct network namespace with no outbound access. Interface
      presence is not the criterion because namespaces naturally include
      loopback and kernel-created tunnel devices; prove isolation
      behaviorally without mounting the host Docker socket.

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
- [ ] Use Coolify's native database-backup configuration for PostgreSQL and
      its validated R2 destination; do not add a Taven-owned SQL dump script.
      Configure the database scope, nightly cadence, timeout, separate local and
      S3 retention, and alerts. A valid execution is `Success`, names the expected
      database, has non-zero size, and confirms the R2 upload.
- [ ] Make the nightly full recovery point a single write-free maintenance
      epoch. Acquire a global backup lock; reject state-changing application
      requests and new signed-upload grants; block public object-store writes;
      and drain in-flight database transactions, uploads, slices, retention
      deletions, and outbox dispatch. While that gate remains closed, trigger the
      configured Coolify PostgreSQL backup on demand and wait for
      its verified R2 artifact. Then stop Garage and create one read-only
      filesystem snapshot that atomically covers both metadata and block-data
      paths. Record an immutable pending manifest that pairs the Coolify
      execution ID and artifact checksum with the frozen Garage snapshot ID,
      then restart Garage and reopen writes. Encrypted restic reads only that
      frozen snapshot into R2; after upload verification, promote the off-host
      manifest with the restic snapshot ID. If either side fails, do not promote
      the pair and keep the previous recovery point. If the host cannot provide
      an atomic LVM, Btrfs, or ZFS snapshot, keep Garage quiesced until a complete
      staged copy finishes; never traverse its live writable volume. Keep seven
      daily and four weekly recovery points, prune daily, and cap the oldest
      recoverable customer-content copy at 35 days unless a legal hold is
      documented.
- [ ] Keep every not-yet-expired live object in Garage for its full application
      retention or hold. Because it remains live, each new backup continues to
      include it throughout that period; the 35-day backup history limits only
      how long an already-deleted or superseded copy remains recoverable.
- [ ] Treat v0 backup objectives as RPO 24 hours and best-effort RTO 4 hours.
      Test checksum verification monthly and a full non-production restore of
      the paired Coolify PostgreSQL artifact plus Garage metadata/blocks snapshot
      at least quarterly and before a major database or storage change. The
      bare-host drill must retrieve the R2 credentials and restic decryption
      password from the separately protected owner password-manager escrow,
      without reading the lost VPS or depending on GitHub secret-value export.
      Run Garage table and block repair/verification after restore before traffic
      resumes.
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
      available scope and separate webhook endpoints/signing secrets. Mount each
      environment's signing secret only into its backend. Authenticate
      `taven.cz` using SPF and DKIM; publish a monitored DMARC policy and
      dedicated bounce/return path where supported.
- [ ] Send only rendered transactional content and short-lived links. Do not
      attach customer models or photographs. Accept and retain the Resend DPA;
      document that EU-only processing is not guaranteed by the selected plan.
- [ ] Authenticate delivery/bounce webhooks against the raw request bytes,
      endpoint-specific signing secret, and required Svix headers before parsing;
      deduplicate the verified `svix-id`. Enforce the 100-email daily Free limit
      in the dispatcher and alert before exhaustion. Every business transition
      first commits its deduplicated email outbox row atomically. A dispatcher
      that has no daily capacity leaves the row durable, advances `availableAt`
      to after the provider reset with jitter, and makes no provider call; a
      provider quota response follows the same retryable path. Upgrade
      intentionally when backlog threatens the notification SLA rather than
      rejecting a business transition or dropping mail.
- [ ] Prove outbox replay, provider timeout, duplicate delivery result, permanent
      bounce, admin resend, and switch to a test SMTP adapter.

### Domain, DNS, secrets, and monitoring

- [ ] Before registering any domain, profile, or handle, issue #38 must record
      successful completion of all four name-clearance steps: no conflicting
      Czech 3D-printing, maker, or manufacturing entity with the same first
      syllable; TMview/ÚPV/EUIPO searches in classes 40 and 42 plus adjacent 35,
      7, and 20 using the required wildcards and phonetic neighbors; simultaneous
      `.cz` and handle availability; and the phone test. The owner must record
      final approval of the name. Until then, create no public Cloudflare domain
      resources.
- [ ] After that gate passes, recheck checkout availability and register
      `taven.cz` and the approved handles together; enable registrar lock,
      automatic renewal, recovery codes, and multi-factor authentication. Keep
      clearance, registrant, and billing evidence in the owner's records.
- [ ] Add the domain to Cloudflare Free, delegate nameservers, enable DNSSEC, and
      create only reviewed `taven.cz`, `www`, and `api` records. Keep admin
      access non-public or separately protected until its authentication is
      production-ready.
- [ ] Use strict TLS from Cloudflare to Caddy, redirect HTTP, configure CORS and
      security headers, and test certificate renewal and a Cloudflare-bypass
      attempt.
- [ ] Protect GitHub production Environment changes with owner approval. Rotate
      Coolify deploy, database, Redis, S3, restic, payment, email, monitoring,
      and Cloudflare credentials independently and record the rotation date
      outside Git. Test the owner password-manager recovery item after each
      backup-credential rotation.
- [ ] Add provider-neutral `*_FILE` configuration for every runtime secret and
      fail when both the direct value and file form are set. In the production
      Compose test, prove each application can read its own files as its final
      non-root UID and cannot read a sibling service directory.
- [ ] Retain searchable application logs for 14 days and metrics for 30 days,
      bounded by disk quotas. Never log secrets, raw capability tokens, model or
      photo contents, full payment callback bodies, or email bodies.
- [ ] Alert on public health, host/disk pressure, PostgreSQL/Redis/Garage health,
      queue age/dead letters, slice errors, payment mismatches/refunds, email
      failures, retention failures, and backup freshness. Exercise every alert
      and link it to the issue #39 runbook.
- [ ] Deploy the runtime-neutral readiness checker as a Cloudflare Worker Free
      cron every 5 minutes. Check both the public web route and a non-sensitive
      API readiness endpoint with a 10-second connection timeout, 30-second
      overall timeout, and one retry. After two consecutive failures, send the
      first alert, at most one six-hour reminder, and a recovery message through
      a fixed verified-destination Cloudflare Email Service binding. Store only
      monitor state and timestamps in Worker KV. The binding must not send to an
      arbitrary recipient.
- [ ] Exercise the Worker against a non-production unavailable origin and prove
      alert, reminder suppression, and recovery delivery. Monitor the Worker
      cron itself with a daily expected-heartbeat check from the VPS; absence is
      locally actionable while the Worker remains the off-host outage signal.
      Document GitHub scheduled workflows as unsuitable for the sole check
      because public-repository schedules can be disabled after 60 days without
      repository activity. A same-host dashboard is not evidence that the host
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
  deletion is bounded by the 35-day recovery-point policy.
- The external Worker fetches only public health routes. Its KV state contains
  only outcome, consecutive-failure count, and alert timestamps; no customer,
  request, model, payment, log, or response-body data is stored at the edge.
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
  Compose/release manifests, GitHub-gated Coolify deployment, the
  provider-neutral S3 presigner adjustment and MinIO/Garage contract matrix,
  self-hosted observability, Resend/SMTP adapters, retention, Coolify/R2 backup
  orchestration, restore drill, secrets rotation, and runbooks. It must not add
  unselected provider placeholders.

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
- [Cloudflare Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/),
  [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
  [Email Service](https://developers.cloudflare.com/email-service/), and
  [restricted email bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)
- [GitHub scheduled-workflow inactivity behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)
- [Coolify database backups](https://next.coolify.io/docs/databases/backups),
  [database-backup CLI trigger](https://next.coolify.io/docs/cli/database-backups),
  [PostgreSQL restore](https://next.coolify.io/docs/databases/restore),
  [Cloudflare R2 storage](https://next.coolify.io/docs/core/s3-storage/r2), and
  [deploy webhooks](https://next.coolify.io/docs/core/automation/deploy-webhooks),
  [application commit pinning](https://next.coolify.io/docs/api/endpoints/applications/update-application-by-uuid),
  and [API token permissions](https://next.coolify.io/docs/core/security/credentials/api-tokens)
- [Garage v2.3.0 source tag](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.3.0),
  [quick start](https://garagehq.deuxfleurs.fr/documentation/quick-start/), and
  [S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/),
  plus the [failure-recovery and metadata-snapshot guidance](https://garagehq.deuxfleurs.fr/documentation/operations/recovering/)
- [Resend pricing and quotas](https://resend.com/docs/knowledge-base/what-is-resend-pricing),
  [webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests),
  and [Resend DPA](https://resend.com/legal/dpa)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [CZ.NIC registrar list](https://www.nic.cz/whois/registrars/) and
  [WEDOS domain price](https://hosting.vedos.cz/domeny/)
- [OrcaSlicer v2.4.2 release](https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.4.2)
  and [AGPL-3.0 license](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/LICENSE.txt)
