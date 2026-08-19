#!/bin/bash
# Runs the StreamVerse Python Video Engine.
# Not intended to be exposed publicly — see config.INTERNAL_API_KEY.
set -e
cd "$(dirname "$0")/.."

PYTHON_BIN="${PYTHON_BIN:-python3}"
HOST="${VIDEO_ENGINE_HOST:-127.0.0.1}"
PORT="${VIDEO_ENGINE_PORT:-8000}"

exec "$PYTHON_BIN" -m uvicorn video_engine.main:app --host "$HOST" --port "$PORT"
