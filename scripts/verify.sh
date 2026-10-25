#!/usr/bin/env bash
# make verify: the full manual gate, one stage at a time, with one summary line per stage.
# A failed install or build skips every later stage (they would only fail for that reason); any other failure
# is recorded and the run carries on. Exit status is non-zero if any stage failed or was skipped.
set -uo pipefail
cd "$(dirname "$0")/.."

logs="$(mktemp -d "${TMPDIR:-/tmp}/kampong-verify-XXXXXX")"
summary=()
failed=0
blocked=0

# Test counts out of the stage's own summary lines (vitest "Tests  N passed", Playwright "N passed").
counts() {
  grep -E '^\s*(Tests\s+.*(passed|failed)|[0-9]+ (passed|failed|skipped|flaky|did not run))' "$1" | sed -E 's/^\s+//' | tr '\n' ';' | sed 's/;$//'
}

stage() {
  local name="$1" fatal="$2"
  shift 2
  if [ "$blocked" -eq 1 ]; then
    summary+=("SKIP  $name (an earlier install/build failure)")
    failed=1
    return
  fi
  echo "== $name"
  local log="$logs/$name.log"
  if "$@" >"$log" 2>&1; then
    summary+=("PASS  $name  $(counts "$log")")
  else
    summary+=("FAIL  $name  $(counts "$log")  (log: $log)")
    failed=1
    [ "$fatal" = fatal ] && blocked=1
  fi
}

kill_leaked_exports() {
  pgrep -f "kampong-e2e-export-[A-Za-z0-9]+/node_modules" | xargs -r kill 2>/dev/null || true
}

stage install fatal npm install
stage build fatal npm run build
stage lint warn npm run lint
stage format warn npm run format:check
stage typecheck warn npm run typecheck
stage unit warn npm run test:unit -- --maxWorkers=2
stage integration warn npm run test:integration -- --maxWorkers=2
stage e2e warn npm run test:e2e
kill_leaked_exports
stage e2e-browser warn bash scripts/e2e-browser.sh

echo
echo "verify summary (logs in $logs):"
printf '  %s\n' "${summary[@]}"
exit "$failed"
