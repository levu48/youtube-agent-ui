#!/usr/bin/env bash
# Run the REQUIRED real-engine tests against the pinned youtube-agent revision (ENGINE_REF).
#
#   scripts/test-real-engine.sh                  # clone the engine from ENGINE_SOURCE at ENGINE_REF
#   ENGINE_DIR=/path/to/checkout scripts/...     # use an existing checkout (must be at ENGINE_REF)
#
# ENGINE_SOURCE defaults to the sibling ../youtube-agent repository (cloned read-only into a
# temporary directory, so your working engine checkout is never modified). CI passes
# ENGINE_DIR after checking out the pinned revision.
#
# Fails unless: the engine is at ENGINE_REF, every backend real-engine integration test ran
# and passed (none skipped), and real-engine Playwright passed with no skips other than the
# known slow-job cancel test. Offline: the engine's fixture provider, no Ollama, no network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$(tr -d '[:space:]' < "$ROOT/ENGINE_REF")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/yta-real-engine.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if [[ -z "${ENGINE_DIR:-}" ]]; then
  SOURCE="${ENGINE_SOURCE:-$ROOT/../youtube-agent}"
  echo "==> Cloning engine from $SOURCE at $REF"
  git clone --quiet --no-local "$SOURCE" "$WORK/youtube-agent"
  git -C "$WORK/youtube-agent" -c advice.detachedHead=false checkout --quiet "$REF"
  ENGINE_DIR="$WORK/youtube-agent"
fi
ENGINE_DIR="$(cd "$ENGINE_DIR" && pwd)"

HEAD="$(git -C "$ENGINE_DIR" rev-parse HEAD)"
if [[ "$HEAD" != "$REF" ]]; then
  echo "error: engine at $HEAD, expected pinned $REF (ENGINE_REF)" >&2
  exit 1
fi
echo "==> Engine $ENGINE_DIR @ $HEAD"
(cd "$ENGINE_DIR" && uv sync --frozen --quiet && uv run --no-sync ytagent --version)

echo "==> Backend real-engine integration tests (required)"
(cd "$ROOT/backend" && uv sync --frozen --quiet &&
  YTA_REQUIRE_ENGINE=1 YTA_TEST_ENGINE_REPO="$ENGINE_DIR" \
    uv run pytest -q -m engine tests/integration --junitxml="$WORK/integration.xml")
python3 - "$WORK/integration.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
s = root if root.tag == "testsuite" else root.find("testsuite")
tests, skipped = int(s.get("tests")), int(s.get("skipped"))
bad = int(s.get("failures")) + int(s.get("errors"))
print(f"integration: {tests} tests, {skipped} skipped, {bad} failed/errored")
if tests < 10 or skipped or bad:
    sys.exit("error: real-engine integration tests did not all run and pass")
PY

echo "==> Playwright against the real engine (required)"
(cd "$ROOT/frontend" &&
  { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } &&
  E2E_ENGINE=real YTA_ENGINE_REPO="$ENGINE_DIR" PLAYWRIGHT_JSON_OUTPUT_NAME="$WORK/e2e.json" \
    npx playwright test --reporter=list,json)
python3 - "$WORK/e2e.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
stats = report["stats"]
skipped = []
def walk(suite):
    for spec in suite.get("specs", []):
        for t in spec.get("tests", []):
            if t.get("status") == "skipped":
                skipped.append(spec["title"])
    for child in suite.get("suites", []):
        walk(child)
for s in report["suites"]:
    walk(s)
print(f"e2e: {stats['expected']} passed, {len(skipped)} skipped, {stats['unexpected']} failed")
allowed = [t for t in skipped if t.startswith("cancel a running job")]
if stats["unexpected"] or stats["expected"] < 18 or len(skipped) != len(allowed):
    sys.exit(f"error: real-engine E2E did not run as required (skipped: {skipped})")
PY
echo "==> Real-engine tests passed against youtube-agent @ $REF"
