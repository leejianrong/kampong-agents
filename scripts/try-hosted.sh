#!/usr/bin/env bash
# make try-hosted: the hosted server (the browser-e2e harness: fake model, offline) on a throwaway Postgres.
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/pg-throwaway.sh
. scripts/pg-throwaway.sh

[ -f apps/canvas/dist/index.html ] || { echo "try-hosted: run 'npm run build' first" >&2; exit 1; }
trap stop_pg EXIT
start_pg || exit 1
port="$(node scripts/pick-port.mjs 8099)"
echo "try-hosted: http://127.0.0.1:$port (sign up with any email and password; Ctrl+C to stop)"
PORT="$port" npx tsx e2e/browser/harness/server.ts
