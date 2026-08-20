"""
StreamVerse Studio — Python Video Engine configuration.

All values are sourced from environment variables so the engine can be
deployed alongside the existing Node.js application without hard-coded
secrets or paths.
"""
from __future__ import annotations

import os
from pathlib import Path


def _bool(name: str, default: str) -> bool:
    return (os.environ.get(name, default) or "").strip().lower() == "true"


def _int(name: str, default: str) -> int:
    return int(os.environ.get(name, default))


def _float(name: str, default: str) -> float:
    return float(os.environ.get(name, default))


def _token_pool(name: str) -> list[str]:
    raw = os.environ.get(name, "") or ""
    parts = [p.strip() for p in __import__("re").split(r"[,;\n]+", raw)]
    return [p for p in parts if p]


# ── Service ──────────────────────────────────────────────────────────────
VIDEO_ENGINE_HOST = os.environ.get("VIDEO_ENGINE_HOST", "127.0.0.1")
VIDEO_ENGINE_PORT = _int("VIDEO_ENGINE_PORT", "8000")

# Internal shared-secret header. Node sends this on every request; Python
# rejects requests missing/mismatching it. Never hard-code the value.
INTERNAL_API_KEY = os.environ.get("STREAMVERSE_INTERNAL_KEY", "")

# ── Hugging Face / LTX ───────────────────────────────────────────────────
HF_SPACE = os.environ.get("HF_SPACE", "Lightricks/LTX-2-3")
HF_TOKENS = _token_pool("HF_TOKENS")

# 24h default cooldown for a ZeroGPU-exhausted token, mirrors the Node
# HF_COOLDOWN_MS default so token behavior stays consistent across the
# language boundary.
HF_COOLDOWN_MS = _int("HF_COOLDOWN_MS", str(24 * 60 * 60 * 1000))

LTX_API_NAME = os.environ.get("LTX_API_NAME", "/generate_video")

LTX_WIDTH = _int("LTX_WIDTH", "1024")
LTX_HEIGHT = _int("LTX_HEIGHT", "1536")

LTX_DURATION_MIN = _float("LTX_DURATION_MIN", "1")
LTX_DURATION_MAX = _float("LTX_DURATION_MAX", "10")

LTX_ENHANCE_PROMPT = _bool("LTX_ENHANCE_PROMPT", "false")
LTX_RANDOMIZE_SEED = _bool("LTX_RANDOMIZE_SEED", "false")

# ── Shared filesystem ────────────────────────────────────────────────────
# NOTE: intentionally not used for image/video hand-off anymore — Replit
# Autoscale can run multiple instances, and even within one instance the
# only durable/shareable medium between Node and Python is Cloudinary.
# All media now flows exclusively through Cloudinary uploads/URLs (see
# cloudinary_client.py). A gradio_client version may still write its own
# transient temp files internally, but that's never relied on across a
# request boundary.

# ── Cloudinary ───────────────────────────────────────────────────────────
# Same credentials/env-var names Node's src/config.js uses, so both
# processes share one source of truth.
CLOUDINARY_CLOUD_NAME = os.environ.get("CLOUDINARY_CLOUD_NAME", "")
CLOUDINARY_API_KEY = os.environ.get("CLOUDINARY_API_KEY", "")
CLOUDINARY_API_SECRET = os.environ.get("CLOUDINARY_API_SECRET", "")
CLOUDINARY_SHOTS_ROOT = os.environ.get("CLOUDINARY_SHOTS_ROOT", "streamverse/shots")

# Node's base URL, exposed here only for symmetry/logging — the Python
# service never calls back into Node today.
NODE_INTERNAL_API_URL = os.environ.get("NODE_INTERNAL_API_URL", "")
