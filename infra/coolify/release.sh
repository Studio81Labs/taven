#!/bin/sh
set -eu

# Coolify executes this from the repository root, after writing runtime .env.
# Do not source .env: Compose handles quoting/interpolation without shell eval.
compose() {
  # Coolify's build-secret helper exports prequoted values. Shell environment
  # takes precedence over --env-file, so never inherit application variables.
  env -i PATH="$PATH" HOME="${HOME:-/root}" DOCKER_HOST=unix:///var/run/docker.sock \
    docker compose --project-directory "$PWD" --env-file .env \
    -f infra/coolify/docker-compose.yml "$@"
}

# A failure must stop here, before any new API or worker is activated.
compose run --rm --no-deps migration
compose up -d --no-build --force-recreate --wait --wait-timeout 180
