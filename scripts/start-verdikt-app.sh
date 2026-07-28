#!/usr/bin/env sh
set -eu

PORT="${VERDIKT_PORT:-3849}"
RESTART_DELAY="${VERDIKT_RESTART_DELAY_SECONDS:-2}"
MAX_RESTARTS="${VERDIKT_MAX_RESTARTS:-0}"
NO_RESTART="${VERDIKT_NO_RESTART:-0}"
NO_OPEN="${VERDIKT_NO_OPEN:-0}"
SKIP_BUILD="${VERDIKT_SKIP_BUILD:-0}"

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required" >&2; exit 1; }
[ -d node_modules ] || pnpm install
[ "$SKIP_BUILD" = "1" ] || pnpm build

restarts=0
while :; do
  if [ "$NO_OPEN" = "1" ] || [ "$restarts" -gt 0 ]; then
    node dist/index.js app --port="$PORT" --no-open && exit 0
  else
    node dist/index.js app --port="$PORT" && exit 0
  fi
  code=$?
  [ "$NO_RESTART" = "1" ] && exit "$code"
  if [ "$MAX_RESTARTS" -gt 0 ] && [ "$restarts" -ge "$MAX_RESTARTS" ]; then
    echo "Verdikt reached the restart limit." >&2
    exit "$code"
  fi
  restarts=$((restarts + 1))
  echo "Verdikt exited with code $code. Restarting in ${RESTART_DELAY}s (attempt $restarts)." >&2
  sleep "$RESTART_DELAY"
done
