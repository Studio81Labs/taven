#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

# shellcheck source=scripts/lib/common.sh
source "$script_dir/lib/common.sh"

require_command node
require_command corepack

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 24 ]] || fail "Node.js 24 or newer is required (found $(node --version))"

cd "$repo_dir"
corepack pnpm install
corepack pnpm openapi:generate

printf 'Taven workspace is ready. Run: pnpm dev\n'
