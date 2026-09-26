# `@taven/web`

Nuxt/Vue 3 public application for acquisition pages and the customer journey.
It consumes the generated API client and keeps informational pages server
rendered without an API dependency.

## Public content and launch boundaries

The target visual design is defined by the
[final website design plan](../../docs/plans/2026-09-25-final-web-design.md) and its
numbered references. [ADR 0030](../../docs/decisions/0030-use-nuxt-ui-for-presentation.md)
approves Nuxt UI for standard elements with a Taven theme and custom product
components/layouts. Adoption is pending implementation; existing Tailwind/CSS
and mock-era structure are not the target-design contract. Necessary replacement
of presentation is in scope for assigned design work, while functional contracts
remain intact. Approved identity, seller details,
navigation, legal placeholders, and unset launch values live in
`content/public-site.ts`; the typed draft/approved legal manifest lives in
`content/launch-manifest.ts`; owner-supplied non-effective legal draft text lives
in `content/legal-drafts.ts`. Approved public contacts use Nuxt runtime
configuration so deployments can change them without rebuilding the image:

- `NUXT_PUBLIC_CUSTOMER_CONTACT_EMAIL` defaults to `zakaznici@taven.cz`;
- `NUXT_PUBLIC_DATA_CONTROLLER_EMAIL` defaults to `legal@taven.cz`.
- `NUXT_PUBLIC_AUTOMATIC_QUOTE_ENABLED` defaults to `false`.

Both values must be valid email addresses. Taven intentionally publishes no
customer phone number and uses electronic contact channels.

Until launch approvals are complete:

- all six legal routes are visibly marked as non-production placeholders, carry
  no effective date or acceptance control, are `noindex`, and are excluded from
  the sitemap; their escaped static draft text is for development and legal
  review only;
- public price-from, lead-time, and portfolio values remain unset;
- analytics is disabled. No analytics provider or script may be added until a
  consent boundary and approved privacy text are implemented;
- production must set `NUXT_PUBLIC_SITE_URL` to the cleared canonical origin.

The automatic checkout renders only the backend's binding price and selected
delivery endpoint. It remains disabled until the API exposes the same approved
terms and claim-policy revisions as the typed manifest. The acquisition gate
requires both those approved manifest inputs and runtime boolean `true` (or the
exact environment override string `true`); an environment value alone cannot
publish a draft build. It is separate from the backend's binding-quote,
photo-upload, and checkout-payment gates.
Recoverable
contact and billing input plus the exact idempotency/payment handoff are kept in
the current tab's session storage; card data is never collected by Taven.

## Performance and accessibility budget

The server-rendered landing page targets at least 90 in each Lighthouse
category—performance, accessibility, best practices, and SEO—under both the
default mobile profile and desktop profile. Numeric budgets are deferred until
the prepared design phase; the reproducible local audit reports scores and
warnings by default:

```bash
pnpm web:lighthouse
```

The script starts the built Nuxt server and a local API fixture on loopback,
audits both profiles with headless Chrome, and shuts the servers down. Enforce
the 90-point budgets explicitly with
`TAVEN_LIGHTHOUSE_ENFORCE_BUDGETS=true pnpm web:lighthouse`.
