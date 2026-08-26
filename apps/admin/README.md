# `@taven/admin`

Vue 3 + Vite internal administration application. It consumes only the
generated API client and shared visual foundation. Maker-facing functions stay
inside this app until observed demand justifies extraction.

The foundation screen checks `GET /health`; it contains no product or auth flow.
