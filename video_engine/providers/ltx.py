"""
LTX-2.3 provider — Lightricks/LTX-2-3 Hugging Face Space.

Uses gradio_client (the known-good Python integration) instead of manually
reproducing the Gradio HTTP/SSE protocol.

CRITICAL — positional argument order (verified against the live Space's
generate_btn.click() wiring):

    1. image
    2. prompt
    3. duration
    4. enhance_prompt
    5. seed
    6. randomize_seed
    7. height
    8. width

Do NOT reorder these. Do NOT swap height/width. See §17 of the refactor
spec and test_param_order.py, which regression-tests this exact order.
"""
from __future__ import annotations

import inspect
import logging
import time
import traceback
from pathlib import Path

from gradio_client import Client, handle_file

from .. import config
from ..cloudinary_client import upload_video
from ..token_manager import token_manager, is_zero_gpu_quota_error, is_blank_or_boilerplate_error
from .base import GenerationResult, ProviderError, VideoProvider

logger = logging.getLogger("video_engine.ltx")

_client_cache: dict[str, Client] = {}

# gradio_client renamed the Client() constructor's HF-token kwarg from
# hf_token -> token in newer releases (both still appear in the wild
# depending on what's pinned). Detect which one the installed version
# actually accepts instead of hard-coding a name that can break on upgrade.
_TOKEN_KWARG = "token" if "token" in inspect.signature(Client.__init__).parameters else "hf_token"


def _get_client(token: str) -> Client:
    """Reuse one gradio_client.Client per active token instead of
    reconnecting for every shot."""
    client = _client_cache.get(token)
    if client is None:
        client = Client(config.HF_SPACE, **{_TOKEN_KWARG: token})
        _client_cache[token] = client
    return client


def build_predict_args(
    image_url: str,
    prompt: str,
    duration: float,
    enhance_prompt: bool,
    seed: int,
    randomize_seed: bool,
    height: int,
    width: int,
):
    """Isolated so it can be unit-tested for positional-order regressions
    without needing a live Gradio client / network access.

    handle_file() accepts a remote https:// URL directly (it's the same
    helper gradio_client uses for local paths) — the Space fetches it
    server-side, so this process never downloads or writes the input image
    itself.
    """
    return (
        handle_file(image_url),
        prompt,
        duration,
        enhance_prompt,
        seed,
        randomize_seed,
        height,
        width,
    )


class LTXProvider(VideoProvider):
    name = "ltx"

    def generate(
        self,
        *,
        job_id: str,
        image_url: str,
        prompt: str,
        duration: float,
        width: int,
        height: int,
        seed: int | None,
        randomize_seed: bool,
        enhance_prompt: bool,
    ) -> GenerationResult:
        duration = max(config.LTX_DURATION_MIN, min(config.LTX_DURATION_MAX, duration))
        seed_value = seed if seed is not None else 0

        last_error: ProviderError | None = None
        attempts = max(1, len(config.HF_TOKENS))

        for _ in range(attempts):
            token = token_manager.get_active_token()
            slot = token_manager.slot_index(token)
            try:
                client = _get_client(token)
                args = build_predict_args(
                    image_url,
                    prompt,
                    duration,
                    enhance_prompt,
                    seed_value,
                    randomize_seed,
                    height,
                    width,
                )
                result = client.predict(*args, api_name=config.LTX_API_NAME)

                video_info, returned_seed = _unpack_result(result)

                # This process never writes the generated clip to disk on
                # purpose (Replit Autoscale gives no filesystem guarantee
                # across instances/requests). Whether gradio_client hands
                # back a hosted `url` or only a local temp path, both cases
                # go straight to Cloudinary — from a URL server-side fetch
                # in the first case, or a one-shot multipart upload of the
                # temp file gradio_client itself created in the second
                # (that file is never referenced again after this call).
                hosted_url = _resolve_video_url(video_info)
                public_id = f"{config.CLOUDINARY_SHOTS_ROOT}/tmp/ltx_{job_id}"
                if hosted_url:
                    video_url = upload_video(public_id=public_id, source_url=hosted_url)
                else:
                    local_path = _resolve_video_path(video_info)
                    video_url = upload_video(public_id=public_id, file_path=str(local_path))

                # Success — the token stays active for the NEXT shot too;
                # we do not rotate it here.
                token_manager.mark_active(token)

                return GenerationResult(
                    video_url=video_url,
                    seed=returned_seed,
                    raw={"token_slot": slot},
                )
            except Exception as exc:  # noqa: BLE001 — must inspect broadly to classify
                err_text = f"{exc}"
                tb = traceback.format_exc()
                category = _classify_error(exc, err_text)

                logger.error(
                    "[LTX] job=%s token_slot=%s space=%s api_name=%s category=%s error=%s\n%s",
                    job_id, slot, config.HF_SPACE, config.LTX_API_NAME, category, err_text, tb,
                )

                if category == "quota":
                    token_manager.mark_exhausted(token, err_text)
                    last_error = ProviderError(
                        f"LTX ZeroGPU quota exhausted for token slot {slot}: {err_text}",
                        category="quota",
                        detail={"token_slot": slot, "traceback": tb},
                    )
                    continue  # try next token
                if category == "auth":
                    token_manager.mark_invalid(token, err_text)
                    last_error = ProviderError(
                        f"LTX authentication failed for token slot {slot}: {err_text}",
                        category="auth",
                        detail={"token_slot": slot, "traceback": tb},
                    )
                    continue  # try next token

                # Ordinary failure (validation/model/network/HTTP 500, etc.)
                # — do NOT mark the token exhausted. Surface the real error.
                raise ProviderError(
                    err_text,
                    category=category,
                    detail={
                        "job_id": job_id,
                        "provider": self.name,
                        "space": config.HF_SPACE,
                        "api_name": config.LTX_API_NAME,
                        "token_slot": slot,
                        "params": {
                            "duration": duration,
                            "width": width,
                            "height": height,
                            "seed": seed_value,
                            "randomize_seed": randomize_seed,
                            "enhance_prompt": enhance_prompt,
                        },
                        "traceback": tb,
                    },
                ) from exc

        raise last_error or ProviderError("LTX generation failed: all tokens exhausted", category="quota")


def _classify_error(exc: Exception, text: str) -> str:
    if is_zero_gpu_quota_error(text):
        return "quota"
    lowered = text.lower()
    if any(k in lowered for k in ("401", "unauthorized", "invalid token", "authentication")):
        return "auth"
    if any(k in lowered for k in ("timeout", "connection", "network", "dns")):
        return "network"
    if any(k in lowered for k in ("resolution", "height", "width", "duration", "validation", "invalid input")):
        return "validation"
    if "500" in lowered or "internal server error" in lowered:
        return "model"
    # The /gradio_api/call/{api_name} REST path (used by gradio_client under
    # the hood) is known to drop session context on some Spaces and relay a
    # blank or boilerplate SSE error instead of the real exception message —
    # a plumbing quirk, not evidence the job actually failed for a real
    # reason. Treat that specific shape as presumed-quota so the caller
    # rotates to the next token and retries instead of surfacing a fatal
    # alert for what is usually just a quota cutoff mid-stream. Any real,
    # distinctly-worded error (network/validation/model/auth, matched above)
    # is unaffected and still goes to the alert path.
    if is_blank_or_boilerplate_error(text):
        return "quota"
    return "unknown"


def _unpack_result(result):
    """The Space returns [output_video, seed]. output_video may be a dict
    (FileData) or a plain path string depending on gradio_client version."""
    if isinstance(result, (list, tuple)):
        video_info = result[0]
        seed = result[1] if len(result) > 1 else None
        try:
            seed = int(seed) if seed is not None else None
        except (TypeError, ValueError):
            seed = None
        return video_info, seed
    return result, None


def _resolve_video_url(video_info) -> str | None:
    """Extract the hosted HTTP(S) URL for the generated clip from the
    Space's FileData response, if one is present.

    gradio_client's FileData dict shape is typically:
        {"path": "/tmp/gradio/<hash>/tmp....mp4",
         "url": "https://<space>.hf.space/gradio_api/file=/tmp/gradio/...",
         ...}

    `path` is a *local* path — either on the Space's own filesystem, or
    (after gradio_client's automatic download) a local temp path on this
    machine — never a fetchable URL. `url` is the actual hosted download
    link. When present it's used for a server-side Cloudinary fetch
    (fastest, no bytes pass through this process); when absent, `generate()`
    falls back to uploading the local temp file's bytes to Cloudinary
    directly instead.
    """
    if isinstance(video_info, dict):
        url = video_info.get("url")
        if not url:
            nested = video_info.get("video")
            if isinstance(nested, dict):
                url = nested.get("url")
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            return url
        return None
    if isinstance(video_info, str) and video_info.startswith(("http://", "https://")):
        return video_info
    return None


def _resolve_video_path(video_info) -> Path:
    if isinstance(video_info, dict):
        path = video_info.get("video") or video_info.get("path") or video_info.get("url")
        if isinstance(path, dict):
            path = path.get("path") or path.get("url")
    else:
        path = video_info
    if not path:
        raise ProviderError("LTX response did not contain a video path", category="model")
    return Path(path)