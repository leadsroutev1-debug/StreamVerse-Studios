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

# ── Agnes Video V2.0 ─────────────────────────────────────────────────────
# Agnes accepts a model/prompt plus image-to-video reference and video-native
# parameters. Duration is NOT sent to Agnes directly; the provider converts
# seconds -> legal 8n+1 frame count.
AGNES_API_KEYS = _token_pool("AGNES_API_KEYS")
AGNES_BASE_URL = os.environ.get("AGNES_BASE_URL", "https://apihub.agnes-ai.com").rstrip("/")
AGNES_MODEL = os.environ.get("AGNES_MODEL", "agnes-video-v2.0")
# StreamVerse portrait production default: 9:16, 1024x1536.
# Both dimensions satisfy Agnes' documented multiple-of-8 requirement.
AGNES_WIDTH = _int("AGNES_WIDTH", "1024")
AGNES_HEIGHT = _int("AGNES_HEIGHT", "1536")
AGNES_FRAME_RATE = _int("AGNES_FRAME_RATE", "24")
AGNES_DURATION_MIN = _float("AGNES_DURATION_MIN", "1")
AGNES_DURATION_MAX = 18.0  # authoritative Agnes temporal ceiling
AGNES_MAX_FRAMES = 441  # 24fps x 18s, legal 8n+1 ceiling
AGNES_HTTP_TIMEOUT_SECONDS = _float("AGNES_HTTP_TIMEOUT_SECONDS", "60")
AGNES_SUBMIT_RETRIES = _int("AGNES_SUBMIT_RETRIES", "5")
AGNES_MAX_POLL_ATTEMPTS = _int("AGNES_MAX_POLL_ATTEMPTS", "120")
AGNES_POLL_INTERVAL_SECONDS = _float("AGNES_POLL_INTERVAL_SECONDS", "5")
AGNES_RETRY_BASE_SECONDS = _float("AGNES_RETRY_BASE_SECONDS", "2")
AGNES_RETRY_MAX_SECONDS = _float("AGNES_RETRY_MAX_SECONDS", "30")

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
