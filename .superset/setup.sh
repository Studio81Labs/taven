#!/usr/bin/env bash
# Superset workspace setup for Taven.
# Runs every time a new workspace (git worktree) is created.
#
# Gets the worktree from "freshly created" to "ready to run":
#   1. provision the ignored env files (root checkout first, example fallback)
#   2. run the repository bootstrap: install, infra:up, migrations, codegen
#
# The local Postgres/Redis/MinIO stack is a machine-level singleton shared by
# the main checkout and every worktree: infra/docker/docker-compose.yml pins the
# compose project name, container names, and host ports, and its services
# restart unless stopped. Setup only makes sure it is up; teardown never stops
# it (see teardown.sh). Use `pnpm infra:down` explicitly when you want it gone.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=scripts/lib/common.sh
source scripts/lib/common.sh

ok()   { printf '  \033[0;32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$1"; }

require_command pnpm

# ── 1. Env files ─────────────────────────────────────────────────────
# Compose reads its overrides (TAVEN_POSTGRES_PORT, POSTGRES_USER, POSTGRES_DB,
# ...) from infra/docker/.env, next to the compose file. Carry the root
# checkout's copy over first so this worktree renders the same Compose identity
# that the copied apps/backend/.env DATABASE_URL was written against;
# bootstrap.sh refuses to migrate when the two disagree. Shell-level overrides
# apply to both checkouts already and need no copying.
echo "Setting up env files..."
if [ -f infra/docker/.env ]; then
  ok "infra/docker/.env already exists"
elif [ -n "${SUPERSET_ROOT_PATH:-}" ] && [ -f "${SUPERSET_ROOT_PATH}/infra/docker/.env" ]; then
  cp "${SUPERSET_ROOT_PATH}/infra/docker/.env" infra/docker/.env
  ok "infra/docker/.env copied from root checkout (Compose overrides)"
else
  ok "no Compose overrides in the root checkout; using the compose defaults"
fi

# Per-app files: prefer the real .env from the root checkout so local overrides
# carry over to the worktree; fall back to the committed example otherwise
# (bootstrap.sh only knows the example fallback).
for app in backend web admin slicer-worker; do
  target="apps/${app}/.env"
  if [ -f "$target" ]; then
    ok "${target} already exists"
  elif [ -n "${SUPERSET_ROOT_PATH:-}" ] && [ -f "${SUPERSET_ROOT_PATH}/${target}" ]; then
    cp "${SUPERSET_ROOT_PATH}/${target}" "$target"
    ok "${target} copied from root checkout"
  elif [ -f "${target}.example" ]; then
    cp "${target}.example" "$target"
    ok "${target} created from .env.example"
  else
    warn "no ${target} source found — skipping"
  fi
done

# ── 2. Repository bootstrap ──────────────────────────────────────────
# scripts/bootstrap.sh is the maintained fresh-checkout path: corepack pnpm
# install, the local DATABASE_URL identity check, infra:up (Postgres, Redis,
# MinIO and bucket init), prisma migrate deploy, and Prisma client + OpenAPI
# generation. It is idempotent, so it is safe when the shared infra is
# already running.
echo "Running pnpm bootstrap..."
pnpm bootstrap
ok "pnpm bootstrap"

echo ""
ok "Workspace ready — start backend/web/admin with the Run button (pnpm dev)."
echo "  Ports 3001/3000/3002 are fixed; stop another checkout's dev servers first."
