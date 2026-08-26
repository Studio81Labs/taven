#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

token="${SIBLING_TOKEN:-}"
if [[ -z "$token" ]] && command -v gh >/dev/null 2>&1; then
  token="$(gh auth token 2>/dev/null || true)"
fi
if [[ -z "$token" ]]; then
  echo "SIBLING_TOKEN is required (or authenticate the GitHub CLI with gh auth login)." >&2
  exit 1
fi

report_dir="$(mktemp -d)"
trap 'rm -rf "$report_dir"' EXIT

for sibling in nexcue tarmoto tabletap; do
  SIBLING_TOKEN="$token" SIBLING_REPO="Studio81Labs/$sibling" \
    python3 scripts/ci/check-sibling-drift.py --out "$report_dir/$sibling.md"
done
