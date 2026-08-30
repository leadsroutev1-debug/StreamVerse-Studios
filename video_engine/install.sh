#!/bin/bash
# Verifies that the Python Video Engine's dependencies are available.
# The runtime provides these through replit.nix. Do not download packages
# during application boot: published runtimes may not have PyPI access.
set -e
cd "$(dirname "$0")/.."

PYTHON_BIN="${PYTHON_BIN:-python3}"

if "$PYTHON_BIN" - <<'PY'
import importlib

required = {
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "gradio_client": "gradio_client",
    "pydantic": "pydantic",
    "requests": "requests",
}

missing = []
for package, module in required.items():
    try:
        importlib.import_module(module)
    except Exception as exc:
        missing.append(f"{package} ({exc})")

if missing:
    print("Missing video engine dependencies: " + ", ".join(missing))
    raise SystemExit(1)

print("Video engine dependencies are available.")
PY
then
  exit 0
fi

echo "[video_engine/install.sh] ERROR: required Python packages are not available in the runtime."
echo "[video_engine/install.sh] Add them to replit.nix before starting the application."
exit 1
