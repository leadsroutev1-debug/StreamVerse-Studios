"""
Minimal Cloudinary signed-upload client for the Python video engine.

Mirrors the signing logic in src/cloudinary.js exactly (SHA-1 over sorted
params + api_secret) so both languages produce identical signatures against
the same Cloudinary account. This is the ONLY hand-off medium between Node
and the Python engine for media — no shared/local filesystem involved,
which matters because Replit Autoscale gives no guarantee that the same
disk is available across instances or even across the lifetime of one
instance.
"""
from __future__ import annotations

import hashlib
import time

import requests

from . import config
from .providers.base import ProviderError


def _sign(params: dict) -> str:
    to_sign = "&".join(f"{k}={params[k]}" for k in sorted(params))
    return hashlib.sha1((to_sign + config.CLOUDINARY_API_SECRET).encode("utf-8")).hexdigest()


def _require_config() -> None:
    if not (config.CLOUDINARY_CLOUD_NAME and config.CLOUDINARY_API_KEY and config.CLOUDINARY_API_SECRET):
        raise ProviderError(
            "Cloudinary is not configured for the video engine "
            "(CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET missing)",
            category="model",
        )


def upload_video(*, public_id: str, source_url: str | None = None, file_path: str | None = None) -> str:
    """Upload a video to Cloudinary via a signed request and return its
    secure_url. Exactly one of source_url (Cloudinary fetches it
    server-side) or file_path (uploaded as multipart bytes) must be given.
    """
    _require_config()
    if not source_url and not file_path:
        raise ProviderError("upload_video requires source_url or file_path", category="model")

    timestamp = int(time.time())
    params = {"public_id": public_id, "overwrite": "true", "timestamp": timestamp}
    signature = _sign(params)
    data = {**params, "api_key": config.CLOUDINARY_API_KEY, "signature": signature}

    url = f"https://api.cloudinary.com/v1_1/{config.CLOUDINARY_CLOUD_NAME}/video/upload"

    try:
        if source_url:
            data["file"] = source_url
            resp = requests.post(url, data=data, timeout=120)
        else:
            with open(file_path, "rb") as f:
                resp = requests.post(url, data=data, files={"file": f}, timeout=120)
    except requests.RequestException as exc:
        raise ProviderError(f"Cloudinary video upload request failed: {exc}", category="network") from exc

    try:
        payload = resp.json()
    except ValueError:
        payload = {"raw": resp.text[:300]}

    if not resp.ok or not payload.get("secure_url"):
        raise ProviderError(
            f"Cloudinary video upload failed ({resp.status_code}): {str(payload)[:300]}",
            category="model",
            detail={"status_code": resp.status_code, "public_id": public_id},
        )

    return payload["secure_url"]
