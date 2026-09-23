# `@taven/admin`

Vue 3 + Vite internal administration application. It consumes only the
generated API client and shared visual foundation. Maker-facing functions stay
inside this app until observed demand justifies extraction.

The shell uses the backend's operator cookie session and generated HTTP client.
Configure `VITE_API_BASE_URL` as the exact API origin and `VITE_APP_ENV` as
`local`, `staging`, or `production`. Staging and production require HTTPS. The
admin Docker build requires both values as build arguments. The
API must include the exact admin origin in `TAVEN_ADMIN_ORIGINS`, with the admin
and API on the same HTTPS site for the existing SameSite cookie. GitHub login
returns to the backend-configured `TAVEN_ADMIN_COMPLETION_URL`.

The page checks `/admin/auth/session` before showing protected routes. A
node-free administrator sees the scoped-unavailable page; operational views
require one granted node. The backend remains authoritative for every action.
The current feature routes are shell placeholders for the later Epic #10 PRs.

Run `pnpm admin:test`, `pnpm admin:test:e2e`, `pnpm admin:typecheck`, and
`pnpm admin:build` from the repository root. The initial browser suite uses a
mock authentication API and exercises the shell; connected operator journeys
belong to issue #185.
