#!/usr/bin/env bash
# Start the local backend (FastAPI, 127.0.0.1:8000) and frontend (Next.js, 127.0.0.1:3000).
# Configuration comes from ./.env (see .env.example). Ctrl-C stops both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

BACKEND_PORT="${YTA_BACKEND_PORT:-8000}"
FRONTEND_PORT="${YTA_FRONTEND_PORT:-3000}"
export YTA_BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
export NEXT_TELEMETRY_DISABLED=1

command -v uv >/dev/null || { echo "error: uv is required (brew install uv)" >&2; exit 1; }
command -v npm >/dev/null || { echo "error: Node.js/npm is required" >&2; exit 1; }

echo "==> Backend dependencies"
(cd backend && uv sync --frozen --quiet)
if [[ ! -d frontend/node_modules ]]; then
  echo "==> Frontend dependencies"
  (cd frontend && npm ci --no-audit --no-fund)
fi

pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in ${pids[@]+"${pids[@]}"}; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Backend  http://127.0.0.1:${BACKEND_PORT}/api/v1/health"
(cd backend && exec uv run --frozen uvicorn --factory app.main:factory \
  --host 127.0.0.1 --port "$BACKEND_PORT" --no-access-log) &
pids+=($!)

echo "==> Frontend http://127.0.0.1:${FRONTEND_PORT}"
(cd frontend && exec npx next dev --hostname 127.0.0.1 --port "$FRONTEND_PORT") &
pids+=($!)

# Exit (and stop the other) as soon as either process stops. Works with macOS bash 3.2.
while kill -0 "${pids[0]}" 2>/dev/null && kill -0 "${pids[1]}" 2>/dev/null; do
  sleep 1
done
