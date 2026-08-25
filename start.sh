#!/bin/bash
# ============================================================================
# StreamVerse Studio — combined startup
# ============================================================================
# Starts the Python Video Engine, waits for health, validates provider/service
# configuration, reconciles stale persisted shot rows, then starts Node in the
# FOREGROUND.
#
# IMPORTANT: application source is authoritative. This script does NOT rewrite
# pipeline.js or any provider source file at startup.
# ============================================================================
set -e

export PATH="${HOME:-/opt/render}/.local/bin:${PATH}"

VIDEO_ENGINE_HOST="${VIDEO_ENGINE_HOST:-127.0.0.1}"
VIDEO_ENGINE_PORT="${VIDEO_ENGINE_PORT:-8000}"

EFFECTIVE_VIDEO_PROVIDER="$(printf '%s' "${VIDEO_PROVIDER:-ltx}" | tr '[:upper:]' '[:lower:]' | xargs)"
echo "[start.sh] VIDEO_PROVIDER=${VIDEO_PROVIDER:-<unset>}"
echo "[start.sh] Effective video provider=${EFFECTIVE_VIDEO_PROVIDER}"
echo "[start.sh] Python user scripts PATH=${HOME:-/opt/render}/.local/bin"

case "$EFFECTIVE_VIDEO_PROVIDER" in
  ltx|agnes|magichour) ;;
  *)
    echo "[start.sh] ERROR: Unsupported VIDEO_PROVIDER='$EFFECTIVE_VIDEO_PROVIDER'. Expected ltx, agnes, or magichour."
    exit 1
    ;;
esac

if [ "$EFFECTIVE_VIDEO_PROVIDER" = "agnes" ]; then
  if [ -z "${AGNES_API_KEYS:-}" ]; then
    echo "[start.sh] ERROR: VIDEO_PROVIDER=agnes but AGNES_API_KEYS is empty."
    exit 1
  fi
  if [ -z "${FFMPEG_SERVICE_URL:-}" ]; then
    echo "[start.sh] ERROR: VIDEO_PROVIDER=agnes requires FFMPEG_SERVICE_URL for mandatory continuity-frame extraction."
    exit 1
  fi

  AGNES_FFMPEG_API_KEY="${FFMPEG_SERVICE_API_KEY:-${FFMPEG_API_KEY:-}}"
  if [ -z "$AGNES_FFMPEG_API_KEY" ]; then
    echo "[start.sh] ERROR: VIDEO_PROVIDER=agnes requires FFMPEG_API_KEY (preferred) or FFMPEG_SERVICE_API_KEY for mandatory continuity-frame extraction."
    exit 1
  fi
  export FFMPEG_SERVICE_API_KEY="$AGNES_FFMPEG_API_KEY"
  echo "[start.sh] Agnes continuity FFmpeg credential resolved from configured secret."
fi

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

echo "[start.sh] Video engine is healthy."
echo "[start.sh] Source-authoritative startup: no runtime source patchers will run."
echo "[start.sh] Video provider = ${EFFECTIVE_VIDEO_PROVIDER}"
if [ "$EFFECTIVE_VIDEO_PROVIDER" = "agnes" ]; then
  echo "[start.sh] Agnes backend = src/agnesVideoGen.js"
  echo "[start.sh] Agnes continuity = current-shot still re-anchored from previous-shot end frame + needed character references"
  echo "[start.sh] Agnes temporal ceiling = 18s"
elif [ "$EFFECTIVE_VIDEO_PROVIDER" = "ltx" ]; then
  echo "[start.sh] LTX backend = src/ltxVideoGen.js"
else
  echo "[start.sh] Magic Hour backend = src/videoGen.js"
fi

echo "[start.sh] Reconciling stale persisted shot rows before backend resume..."
node src/reconcileShotState.js || true

echo "[start.sh] Starting StreamVerse Node backend on port ${PORT:-5000}..."
exec node index.js
