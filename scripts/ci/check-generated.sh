#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"

pnpm openapi:generate

if ! git diff --exit-code -- \
  packages/openapi/openapi.json \
  packages/openapi-client/generated/schema.ts; then
  printf '%s\n' 'Generated API artifacts are stale. Run pnpm openapi:generate and commit the result.' >&2
  exit 1
fi

printf '%s\n' 'Generated API artifacts are current.'
