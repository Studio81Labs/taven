#!/usr/bin/env bash
# Superset workspace teardown for Taven.
# Runs when a workspace (git worktree) is deleted.
#
# The Postgres/Redis/MinIO stack is shared by the main checkout and every
# worktree (fixed compose project name, container names, and host ports), so a
# blanket `pnpm infra:down` here would stop services another checkout relies
# on. Only stop the stack when THIS workspace started it (setup.sh records the
# started container id in a marker) and that exact container is still the one
# running. Data volumes are preserved (no `-v`), so re-creating a workspace
# keeps local data. To force-stop the shared stack from any checkout, run
# `pnpm infra:down` directly.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

marker=".superset/.infra-started"

running_postgres_id() {
  docker inspect -f '{{if .State.Running}}{{.Id}}{{end}}' taven-postgres 2>/dev/null || true
}

if [ ! -f "$marker" ]; then
  echo "This workspace did not start the shared Taven infra; leaving it running."
  exit 0
fi

owned_id="$(cat "$marker")"
current_id="$(running_postgres_id)"

if [ -z "$current_id" ]; then
  echo "The infra this workspace started is no longer running; nothing to stop."
  rm -f "$marker"
  exit 0
fi

if [ "$current_id" != "$owned_id" ]; then
  echo "The running Taven infra was (re)started by another checkout; not stopping it."
  rm -f "$marker"
  exit 0
fi

echo "Stopping the Taven infra started by this workspace..."
pnpm infra:down
rm -f "$marker"
printf '  \033[0;32m✔\033[0m %s\n' "pnpm infra:down (data volumes preserved)"
