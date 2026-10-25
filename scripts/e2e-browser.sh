#!/usr/bin/env bash
# make e2e-browser: every Playwright spec. The local ones run on playwright.local.config.ts (no database); the
# hosted-flow spec needs a throwaway Postgres, so it runs only if Docker works, and says so if it can't.
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/pg-throwaway.sh
. scripts/pg-throwaway.sh
trap stop_pg EXIT

status=0
npx playwright test --config playwright.local.config.ts || status=1

if start_pg; then
  npx playwright test hosted-flow || status=1
else
  echo "e2e-browser: hosted-flow NOT RUN (see the reason above); CI runs it" >&2
  status=1
fi
exit "$status"
