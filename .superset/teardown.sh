#!/usr/bin/env bash
# Superset workspace teardown for Taven.
# Runs when a workspace (git worktree) is deleted.
#
# Deliberately leaves the local Postgres/Redis/MinIO stack running. It is a
# machine-level singleton shared by the main checkout and every worktree
# (infra/docker/docker-compose.yml pins the compose project name, container
# names, and host ports, and its services restart unless stopped), and no
# checkout can tell whether another one still depends on it. Everything else
# that setup produced lives inside the worktree and disappears with it.
#
# Stop the stack explicitly, from any checkout, when you no longer need it:
#   pnpm infra:down
set -euo pipefail

echo "Leaving the shared Taven infra (Postgres/Redis/MinIO) running; stop it with 'pnpm infra:down' when no checkout needs it."
