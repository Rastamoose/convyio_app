#!/usr/bin/env bash
# Container entrypoint: always the server, plus the agent when it has a key.
# Either child dying takes the container down (wait -n) so the platform
# restarts it whole instead of limping along half-up.
set -euo pipefail

node_modules/.bin/tsx packages/server/src/index.ts &
pids=($!)

if [ -n "${GEMINI_API_KEY:-}" ]; then
  # The agent shares the container, so it reaches the server over loopback.
  # DATA_DIR must be re-pointed per-process: the inherited /data is the
  # server's root; agent state belongs under /data/agents/<name>.
  WS_URL="ws://localhost:${PORT:-3001}" \
  DATA_DIR="/data/agents/${AGENT_NAME:-noodle}" \
    node_modules/.bin/tsx packages/agent/src/index.ts &
  pids+=($!)
else
  echo "[start] GEMINI_API_KEY not set: starting without the agent"
fi

trap 'kill "${pids[@]}" 2>/dev/null' TERM INT
status=0
wait -n "${pids[@]}" || status=$?
kill "${pids[@]}" 2>/dev/null || true
wait || true
exit "$status"
