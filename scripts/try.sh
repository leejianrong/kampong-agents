#!/usr/bin/env bash
# make try / make try-demo: run `kampong dev` on a throwaway folder under .try/, no Docker, no keys.
# Usage: scripts/try.sh blank|demo
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-blank}"
cli=packages/cli/dist/cli.js
canvas=apps/canvas/dist/index.html

# Rebuild only when a source file is newer than the last build this script ran. (tsc -b leaves unchanged outputs
# alone, so cli.js's own mtime can't say whether the build is current.)
stamp=.try/.built
stale() {
  [ -f "$cli" ] && [ -f "$canvas" ] && [ -f "$stamp" ] || return 0
  [ -n "$(find packages/*/src apps/canvas/src -type f -newer "$stamp" -print -quit 2>/dev/null)" ]
}
if stale; then
  echo "try: build output is missing or stale, building..."
  npm run build
  mkdir -p .try && touch "$stamp"
fi

dir=".try/$mode"
case "$mode" in
  blank) mkdir -p "$dir" ;;
  demo)
    if [ ! -f "$dir/agent.yaml" ]; then
      mkdir -p "$dir"
      cp packages/cli/templates/market-etl/agent.yaml "$dir/"
      cp -r packages/cli/templates/market-etl/fixtures "$dir/"
    fi
    ;;
  *) echo "usage: $0 blank|demo" >&2; exit 2 ;;
esac

port="$(node scripts/pick-port.mjs 4310)"
echo "try: $dir on http://127.0.0.1:$port (Ctrl+C to stop)"
# An empty environment, as the browser specs use, so Replay proves it needs no keys. exec so Ctrl+C reaches node.
exec env -i PATH="$PATH" HOME="$HOME" node "$cli" dev "$dir" --port "$port"
