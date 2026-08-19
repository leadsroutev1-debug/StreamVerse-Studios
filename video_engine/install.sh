#!/bin/bash
# Installs the Python Video Engine's dependencies.
# Run from the project root (start.sh does this automatically).
set -e
cd "$(dirname "$0")/.."

PYTHON_BIN="${PYTHON_BIN:-python3}"

"$PYTHON_BIN" -m pip install -q --break-system-packages -r video_engine/requirements.txt
