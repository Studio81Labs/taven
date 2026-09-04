# `@taven/web`

Nuxt/Vue 3 public application for acquisition pages and the customer journey.
It consumes the generated API client and keeps informational pages server
rendered without an API dependency.

## Public content and launch boundaries

The public landing and static pages use basic Tailwind utilities. The final
visual design is intentionally deferred. Approved identity, seller details,
navigation, legal placeholders, and unset launch values live in
`content/public-site.ts` so they can be replaced without restructuring pages.

Until launch approvals are complete:

- legal routes are visibly marked as non-production placeholders, carry no
  effective date or acceptance control, are `noindex`, and are excluded from the
  sitemap;
- public price-from, lead-time, email, phone, and portfolio values remain unset;
- analytics is disabled. No analytics provider or script may be added until a
  consent boundary and approved privacy text are implemented;
- production must set `NUXT_PUBLIC_SITE_URL` to the cleared canonical origin.

## Performance and accessibility budget

The server-rendered landing page must score at least 90 in each Lighthouse
category—performance, accessibility, best practices, and SEO—under both the
default mobile profile and desktop profile. Run the reproducible local audit
after a production build:

```bash
pnpm web:lighthouse
```

The script starts the built Nuxt server on loopback, audits both profiles with
headless Chrome, enforces the budgets, and shuts the server down.
