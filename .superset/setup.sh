#!/usr/bin/env bash
# Superset workspace setup for Taven.
# Runs every time a new workspace (git worktree) is created.
#
# Gets the worktree from "freshly created" to "ready to run":
#   1. provision per-app .env files (root checkout first, example fallback)
#   2. run the repository bootstrap: install, infra:up, migrations, codegen
#   3. remember whether THIS workspace started the shared local infra, so
#      teardown only stops what setup actually started
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=scripts/lib/common.sh
source scripts/lib/common.sh

ok()   { printf '  \033[0;32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$1"; }

marker=".superset/.infra-started"

# infra/docker/docker-compose.yml pins the compose project name (taven-dev),
# the container names, and the host ports, so the main checkout and every
# worktree share ONE Postgres/Redis/MinIO stack. Echo the id of the running
# taven-postgres container, or nothing when it is absent or stopped.
running_postgres_id() {
  docker inspect -f '{{if .State.Running}}{{.Id}}{{end}}' taven-postgres 2>/dev/null || true
}

require_command pnpm

# ── 1. Per-app env files ─────────────────────────────────────────────
# Prefer the real .env from the root checkout so local overrides carry over
# to the worktree; fall back to the committed example otherwise (bootstrap.sh
# only knows the example fallback).
echo "Setting up per-app .env files..."
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
before_id="$(running_postgres_id)"

echo "Running pnpm bootstrap..."
pnpm bootstrap
ok "pnpm bootstrap"

# ── 3. Infra ownership ───────────────────────────────────────────────
after_id="$(running_postgres_id)"
if [ -z "$before_id" ] && [ -n "$after_id" ]; then
  printf '%s\n' "$after_id" > "$marker"
  ok "shared infra started by this workspace (teardown will stop it)"
else
  rm -f "$marker"
  ok "shared infra was already running (teardown will leave it alone)"
fi

echo ""
ok "Workspace ready — start backend/web/admin with the Run button (pnpm dev)."
echo "  Ports 3001/3000/3002 are fixed; stop another checkout's dev servers first."
