# ADR 0023: Use Coolify-managed Traefik for origin ingress

- **Status:** accepted; implementation required in #39 / PR #162
- **Date:** 2026-09-20
- **Decision:** [escalation #164](https://github.com/Studio81Labs/taven/issues/164)
- **Amends:** ADR 0006's Caddy selection and the v0 provider matrix
- **Inspected baseline:** main `1629d51`, PR #162 `94b3834`

## Context and decision

PR #162 prepares explicit Traefik router/TLS labels on the external `coolify`
network, but ADR 0006 selected Caddy before an origin configuration existed.
The review finding is valid: implementation cannot silently replace that choice.
The product requirement is an owner-operated, portable OCI service with strict
origin TLS and controlled exposure; it does not require Caddy specifically.

Use **Coolify-managed Traefik as the single origin reverse proxy and TLS
terminator**, for staging and eventual production. Replace the Caddy selection;
do not add Caddy in front of or behind Traefik. Coolify remains deployment control
plane, Cloudflare remains DNS/edge proxy, and application code remains portable.
[Coolify documents Traefik as its default integrated proxy](https://coolify.io/docs/core/networking/proxy/traefik/overview).
This is a bounded choice to use the prepared platform, not a new ingress platform.

## Topology and TLS ownership

```text
browser/tester -- HTTPS --> Cloudflare -- HTTPS Full (strict) -->
Coolify-managed Traefik -- private Docker HTTP --> web:3000 / backend:3001 / admin:8080
```

Cloudflare owns the browser-facing edge certificate. Traefik owns the origin
certificate/key and renewal; neither the app containers nor a second proxy own
origin TLS. [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
remains mandatory. Do not use Flexible mode, plaintext origin transport, default
self-signed certificates, or insecure certificate validation.

Use Let's Encrypt ACME DNS-01 against the authorized Cloudflare zone, with a
Taven-specific resolver `taven-dns` and persistent ACME state in the proxy's
existing protected storage. DNS-01 avoids opening a certificate-challenge path
through the restricted application routers. Scope the DNS credential to required
zone/record permissions; supply it as the proxy-only `CF_DNS_API_TOKEN` (or its
installed provider-supported secret-file form), never through app labels,
frontend build arguments or Git. Record expiry/renewal monitoring and restore of
the protected ACME state. Follow the installed version's syntax and
[Coolify DNS challenge workflow](https://next.coolify.io/docs/core/networking/proxy/traefik/dns-challenge).

Before any shared-host change, inspect the actual Coolify/proxy version, image
digest, entrypoints, existing certificate resolvers, credentials and routes.
Add the Taven resolver/configuration without overwriting another application's
resolver, certificate state or DNS credential. If credentials cannot coexist
safely in the installed shared proxy, escalate that specific conflict instead of
changing another service silently. No shared proxy restart or live provisioning
is performed by this architecture task. Preserve the existing reviewed-release
and image-digest requirements; do not invent an unverified proxy pin.

Keep the existing external `coolify` proxy network and distinct environment
networks. Only intended HTTP-facing app services join the proxy network; no host
ports for app backends, database, Redis, workers or management endpoints. Do not
add a public Garage route as part of this repair: its existing browser-storage
integration remains separately owned by #39. Explicit Host rules, environment-
namespaced router/service names and declared internal service ports prevent
cross-environment routing. Verify there are no automatic duplicate Coolify
routes exposing the same app without its middleware. The shared Docker network
is a trusted host-infrastructure boundary, not tenant isolation.

Expose origin 443 only as required for Cloudflare; optional 80 serves redirects,
not application plaintext. Preserve source-restricted administrative SSH and
private control-plane/monitoring access. Apply host/Docker-aware firewall rules;
do not assume host INPUT rules cover Docker-published traffic. On this shared
host, preserve unrelated service access and enforce the Taven-specific source
restriction at its routers even where a global firewall restriction is not
possible. Do not change other applications' routes/firewall policies implicitly.

## Restricted staging and forwarded address contract

The prepared `sourceRange` middleware alone checks the peer address, which behind
Cloudflare is an edge address rather than the tester. Do not add Cloudflare's
ranges to the tester allowlist to make it work: that would admit all edge users.
Implement two distinct gates on every enabled Taven HTTPS router:

1. **Origin-source gate:** accept only actual Cloudflare edge peer addresses,
   using its reviewed current IPv4/IPv6 ranges and the default RemoteAddr
   strategy. This gate does not trust a supplied header. Direct-origin requests
   and local/shared-network requests that try to impersonate Cloudflare fail.
2. **Restricted-client gate:** for staging web/API/admin (and production admin),
   allow only explicitly configured tester/operator egress CIDRs from
   `TAVEN_INGRESS_ACCESS_CIDRS`. Select the rightmost edge-appended visitor from
   `X-Forwarded-For` with `ipStrategy.depth=1` for the specified single-Cloudflare
   hop. Attach this after the origin-source gate. Empty/missing/malformed client
   identity fails closed. Missing tester configuration remains deny-by-default;
   no all-address CIDR or Cloudflare-edge substitution is an acceptable fix.

The Traefik HTTPS entrypoint trusts forwarded headers only from actual Cloudflare
ranges (`forwardedHeaders.trustedIPs`), never `forwardedHeaders.insecure` or
all-address trust. Preserve Cloudflare visitor headers and disable settings that
replace the visitor with a pseudonymous IPv4 address for this route. The current
Cloudflare path must append/produce the authentic visitor as the final XFF item;
verify it before enabling ingress. No Worker/extra proxy that rewrites this chain
is part of this topology. A changed hop chain requires a new validated strategy,
not blindly increasing depth. The behavior is documented by
[Traefik IPAllowList](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ipallowlist/)
and [Cloudflare request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

The backend's existing `TAVEN_TRUSTED_PROXY_CIDRS` must match its actual trusted
Traefik peer and the verified forwarded proxy chain (including Cloudflare hops
where appended by Traefik). Do not trust all private networks or all callers.
Check actual `request.ip` for rate limits/audit and HTTPS/origin behavior; preserve
CORS, cookie, CSRF and operator authorization. Only the proxy/infrastructure
configuration changes; no application-wide trust bypass is authorized.

The source gate applies to production too. Public production web/API can omit
the restricted-client gate only at their separately authorized activation;
production admin stays restricted and authenticated. Staging always keeps both
gates, noindex and its visible staging marker. Do not open webhook/callback paths
broadly to bypass staging access: the current exercise uses sandbox payments and
browser-return GitHub login. Any required service caller needs an explicit narrow
rule and verification within its existing integration scope.

## Delivery, validation and resume point

Amend **PR #162**, owned by #39; do not split a second proxy implementation PR or
reopen delivered legal work. Incorporate this ADR and provider-matrix amendment,
then update Compose labels, named TLS resolver, the two middleware chains,
trusted-proxy inputs and `infra/coolify/README.md` together. The runbook must
separate local/private runtime startup from remote ingress prerequisites and
later production launch. `TAVEN_PUBLIC_INGRESS_ENABLED` remains false by default;
staging may enable it after its technical DNS/TLS/access checks. Final legal
review is not a prerequisite: use the delivered v0.1 development baseline.

For the stopped/preparation PR, require resolved Compose checks for staging and
production, default-disabled ingress, exact backend ports/networks, no extra
public routes/ports/secrets, and executable isolated proxy tests using the
installed-compatible Traefik version. Tests cover allowed/denied clients, missing
and spoofed XFF, direct-origin denial, IPv4/IPv6, wrong Host/environment, middleware
coverage, HTTP redirect and production-admin restriction. Prove valid TLS and
upstream routing in an isolated harness; synthetic test certificates/proxy peers
stay in that harness. Required CI and independent review still apply. A parser
or Compose check alone is not runtime access-control evidence.

Live Cloudflare/DNS credentials are not required to merge a preparation change
with ingress disabled. Before enabling actual staging ingress, #39 additionally
verifies DNS-01 issuance/renewal, Full (strict), actual edge/XFF chain, allowed and
denied clients, header spoofing/direct-IP bypass, all web/API/admin hosts, backend
client address, GitHub callback, CORS/CSRF and sandbox return. Verify neighboring
applications are unchanged. Record actual checks; do not claim host/TLS readiness
from this decision. Missing remote configuration blocks only remote ingress;
local build, baseline import, application runtime and integration work continue.

Rollback removes/disables only Taven routes and restores their prior reviewed
configuration/certificate state. No database migration, domain/API/event change,
customer-record rewrite or new platform subscription is introduced. No broad
proxy swap on an occupied host. Escalate a conflict with shared services, a new
proxy hop, missing compatible trust controls or a required security-boundary
change. Routine variable names, per-environment hostnames and verified image
versions are implementation/provisioning details within this decision.

## Rejected alternatives

Adding a standalone Caddy duplicates proxy/certificate/network operations on a
shared host. Caddy in front of Traefik creates two trust/configuration layers
without a product need. Switching the host's Coolify proxy to Caddy could affect
unrelated applications and discards the prepared integration. Keeping Traefik
without an explicit ADR amendment would leave the accepted contract inconsistent.
This decision preserves strict TLS and access boundaries while changing the
origin proxy implementation to the existing platform integration.
