#!/usr/bin/env bash
set -euo pipefail

# Regenerates the vendored semgrep rules in .semgrep/.
#
# Why they are vendored at all: `--config=p/typescript` is NOT a version pin.
# Semgrep resolves `p/...` from the live Registry on every run, so an upstream
# change can add or remove rules -- and with `--error`, start failing every PR --
# with no diff in this repository and nothing to review or revert. A security
# gate whose contents change without a commit is not a gate you can reason about.
#
# Vendoring turns a Registry update into an ordinary reviewable diff: run this
# script, read what changed, merge it deliberately. The cost is that rules do not
# refresh on their own, so run this periodically -- the diff is the point.
#
# Rules are filtered to the languages this repository actually contains.
# Carrying rules for absent stacks would add a large, inert diff and obscure
# changes to the rules that can actually execute here.
#
# Usage:  scripts/ci/refresh-semgrep-rules.sh
# Then:   git diff .semgrep/   # read it before committing

# Vendored Registry rulesets. Each becomes <name>.yaml in OUT_DIR.
RULESETS=(typescript owasp-top-ten)
OUT_DIR=".semgrep"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
mkdir -p "$OUT_DIR"

for rs in "${RULESETS[@]}"; do
  url="https://semgrep.dev/c/p/${rs}"
  tmp="$(mktemp)"

  echo "Fetching ${url}"
  # Fail loudly on an HTTP error rather than vendoring an error page as rules,
  # which would silently empty the ruleset -- a scanner running zero rules exits
  # 0 and is indistinguishable from a clean repository.
  curl -fsSL "$url" -o "$tmp"

  python3 - "$tmp" "$rs" "$OUT_DIR" <<'PY'
import sys, datetime, hashlib, pathlib

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover
    print(
        "refresh-semgrep-rules: PyYAML is required. Run `pip install pyyaml` "
        "(or `pip3 install --user pyyaml`). CI installs it before invoking "
        "the repository's Python policy scripts.",
        file=sys.stderr,
    )
    raise SystemExit(1)

src, name, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
raw = pathlib.Path(src).read_bytes()
doc = yaml.safe_load(raw)
rules = doc.get("rules") or []
if not rules:
    raise SystemExit(f"refresh-semgrep-rules: p/{name} resolved to zero rules — refusing to vendor")

# Languages present in this repository, checked against `git ls-files` rather
# than assumed. Getting this wrong is a silent coverage loss: an earlier version
# omitted python and dropped 147 rules that the Registry set was actually running
# against scripts/ci/*.py -- release-critical code.
#
# `generic` and the config formats are kept because rules targeting them match
# YAML/JSON/Dockerfiles here. Deliberately absent: java, go, hcl, ruby, php,
# csharp, scala, clojure -- none of those exist in this tree, and their rules can
# never fire. Re-check this set when a language is added.
KEEP = {
    "javascript","js","jsx","typescript","ts","tsx",
    "python","py",
    "json","yaml","generic","dockerfile","bash","sh",
}
kept = [r for r in rules if KEEP & {str(l).lower() for l in (r.get("languages") or [])}]
if not kept:
    raise SystemExit(f"refresh-semgrep-rules: p/{name} has no rules for this repo's languages")

body = yaml.safe_dump({"rules": kept}, sort_keys=False, width=100, allow_unicode=True)
header = (
    f"# GENERATED — do not edit by hand.\n"
    f"# Regenerate with scripts/ci/refresh-semgrep-rules.sh, then review the diff.\n"
    f"#\n"
    f"# source:    https://semgrep.dev/c/p/{name}\n"
    f"# fetched:   {datetime.date.today().isoformat()}\n"
    f"# upstream:  {len(rules)} rules, sha256 {hashlib.sha256(raw).hexdigest()}\n"
    f"# vendored:  {len(kept)} rules, filtered to this repo's languages\n"
    f"#\n"
    f"# The upstream sha256 records exactly what was fetched. It is not an\n"
    f"# integrity guarantee against upstream — the Registry is mutable — it is a\n"
    f"# marker so a later refresh can tell whether upstream actually moved.\n"
)
path = pathlib.Path(out_dir) / f"{name}.yaml"
path.write_text(header + body)
print(f"  {path}: {len(kept)}/{len(rules)} rules vendored")
PY

  rm -f "$tmp"
done

echo
echo "Done. Review with:  git diff ${OUT_DIR}/"
