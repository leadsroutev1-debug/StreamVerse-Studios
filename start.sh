#!/bin/bash
# ============================================================================
# StreamVerse Studio — combined startup
# ============================================================================
# Starts the Python Video Engine (internal, port 8000 by default) as a
# background sidecar, waits for it to report healthy, then execs the Node
# main application in the FOREGROUND on $PORT (default 5000 — this is the
# port Replit's autoscale deployment / port-forwarding watches).
#
# The Node process preloads the autonomous-agent runtime hardening layer,
# shared sticky Mistral key rotation, and deterministic production-readiness
# guards. The LLM may propose actions; readiness invariants decide whether
# those actions are allowed to execute.
# ============================================================================
set -e

VIDEO_ENGINE_HOST="${VIDEO_ENGINE_HOST:-127.0.0.1}"
VIDEO_ENGINE_PORT="${VIDEO_ENGINE_PORT:-8000}"

echo "[start.sh] Installing Python video engine dependencies..."
bash video_engine/install.sh
echo "[start.sh] Starting Python Video Engine on ${VIDEO_ENGINE_HOST}:${VIDEO_ENGINE_PORT}..."
bash video_engine/run.sh &
VIDEO_ENGINE_PID=$!

cleanup() {
  echo "[start.sh] Shutting down video engine (pid $VIDEO_ENGINE_PID)..."
  kill "$VIDEO_ENGINE_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[start.sh] Waiting for video engine health check..."
for i in $(seq 1 30); do
  if curl -sf "http://${VIDEO_ENGINE_HOST}:${VIDEO_ENGINE_PORT}/health" >/dev/null 2>&1; then
    echo "[start.sh] Video engine is healthy."
    break
  fi
  if ! kill -0 "$VIDEO_ENGINE_PID" 2>/dev/null; then
    echo "[start.sh] ERROR: video engine process exited during startup."
    exit 1
  fi
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "[start.sh] WARNING: video engine did not report healthy after 30s — starting Node anyway."
  fi
done

echo "[start.sh] Starting StreamVerse Node backend on port ${PORT:-5000}..."
exec node \
  --require ./src/mistralStickyKeyHardening.js \
  --require ./src/agentRuntimeHardening.js \
  --require ./src/productionReadinessGuard.js \
  index.js
