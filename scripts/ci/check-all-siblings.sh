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
trap 'rm -r "$report_dir"' EXIT

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to run the sibling drift check." >&2
  exit 1
fi

# Keep the command self-contained on fresh checkouts. Installing into the
# temporary report tree avoids changing the developer's global Python while
# the exact version and accepted wheels remain locked beside the checker.
python_deps="$report_dir/python-deps"
python3 -m pip install \
  --quiet \
  --disable-pip-version-check \
  --no-deps \
  --only-binary=:all: \
  --require-hashes \
  --target "$python_deps" \
  --requirement scripts/ci/sibling-drift-requirements.txt

for sibling in nexcue tarmoto tabletap poker-hero; do
  PYTHONPATH="$python_deps" SIBLING_TOKEN="$token" SIBLING_REPO="Studio81Labs/$sibling" \
    python3 scripts/ci/check-sibling-drift.py --out "$report_dir/$sibling.md"
  printf '\n## vs %s\n\n' "$sibling"
  cat "$report_dir/$sibling.md"
done
