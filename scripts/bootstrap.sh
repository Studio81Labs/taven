#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

# shellcheck source=scripts/lib/common.sh
source "$script_dir/lib/common.sh"

require_command node
require_command corepack
require_command docker

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 24 ]] || fail "Node.js 24 or newer is required (found $(node --version))"

cd "$repo_dir"
corepack pnpm install

for app in backend web admin slicer-worker; do
  env_file="apps/$app/.env"
  if [[ ! -f "$env_file" ]]; then
    cp "$env_file.example" "$env_file"
    printf 'Created %s from its example.\n' "$env_file"
  fi
done

# Prisma gives an ambient DATABASE_URL precedence over apps/backend/.env. Guard
# the effective value before starting services or applying migrations so a
# developer shell configured for production cannot make bootstrap destructive.
node --env-file-if-exists=apps/backend/.env scripts/ci/assert-local-database-url.mjs

docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
corepack pnpm infra:up
corepack pnpm db:migrate:deploy
corepack pnpm openapi:generate

printf 'Taven workspace is ready. Run: pnpm dev\n'
