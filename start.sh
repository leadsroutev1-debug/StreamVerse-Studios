#!/bin/bash
# ============================================================================
# StreamVerse Studio — combined startup
# ============================================================================
# Starts the Python Video Engine (internal, port 8000 by default) as a
# background sidecar, waits for it to report healthy, applies the idempotent
# LTX/movie and scene-transition pipeline contract migrations before Node
# loads src/pipeline.js, reconciles stale persisted shot rows, then starts
# the Node application in the FOREGROUND.
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

echo "[start.sh] Applying idempotent LTX/movie pipeline contracts..."
node src/ensureLtxPipelineContracts.js
echo "[start.sh] Applying scene transition contract..."
node src/ensureSceneTransitionContract.js
echo "[start.sh] Applying scene fade/master cut editing contract..."
node src/ensureSceneEditContract.js
echo "[start.sh] Applying shot-ID integrity contract..."
node src/ensureShotIdIntegrityContract.js
echo "[start.sh] Reconciling stale persisted shot rows before backend resume..."
node src/reconcileShotState.js || true
echo "[start.sh] Starting StreamVerse Node backend on port ${PORT:-5000}..."
exec node index.js
