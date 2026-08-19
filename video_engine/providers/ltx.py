"""
LTX-2.3 provider — Lightricks/LTX-2-3 Hugging Face Space.

Uses gradio_client (the known-good Python integration) instead of manually
reproducing the Gradio HTTP/SSE protocol.

CRITICAL — positional argument order verified against the live official Space:

    1. image
    2. prompt
    3. duration
    4. enhance_prompt
    5. seed
    6. randomize_seed
    7. height
    8. width

The official Space's high-resolution portrait preset is 1024x1536 (width x
height), with 1–10 second duration, 24 fps output, and first-frame image
conditioning at strength 1.0. StreamVerse therefore treats 1024x1536 as a
hard production contract and never silently resizes the canonical FLUX frame.
"""
from __future__ import annotations

import inspect
import logging
import traceback
from pathlib import Path

from gradio_client import Client, handle_file

from .. import config
from ..cloudinary_client import upload_video
from ..token_manager import token_manager, is_zero_gpu_quota_error, is_blank_or_boilerplate_error
from .base import GenerationResult, ProviderError, VideoProvider

logger = logging.getLogger("video_engine.ltx")

_client_cache: dict[str, Client] = {}

PRODUCTION_WIDTH = 1024
PRODUCTION_HEIGHT = 1536
PRODUCTION_MIN_DURATION = 1.0
PRODUCTION_MAX_DURATION = 10.0

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
    """Build the exact positional contract of the official LTX-2.3 Space.

    Kept isolated so tests can catch positional regressions without network
    access. ``handle_file`` accepts the Cloudinary HTTPS URL directly.
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


def _validate_generation_contract(width: int, height: int, duration: float) -> None:
    if int(width) != PRODUCTION_WIDTH or int(height) != PRODUCTION_HEIGHT:
        raise ProviderError(
            f"Production LTX-2.3 I2V requires {PRODUCTION_WIDTH}x{PRODUCTION_HEIGHT}; received {width}x{height}",
            category="validation",
            detail={
                "expected_width": PRODUCTION_WIDTH,
                "expected_height": PRODUCTION_HEIGHT,
                "received_width": width,
                "received_height": height,
            },
        )
    if not (PRODUCTION_MIN_DURATION <= float(duration) <= PRODUCTION_MAX_DURATION):
        raise ProviderError(
            f"LTX-2.3 Space duration must be {PRODUCTION_MIN_DURATION}–{PRODUCTION_MAX_DURATION}s; received {duration}",
            category="validation",
            detail={"duration": duration},
        )
    if PRODUCTION_WIDTH % 32 or PRODUCTION_HEIGHT % 32:
        raise ProviderError("Internal LTX production geometry is not divisible by 32", category="validation")


def _normalize_prompt(prompt: str) -> str:
    """Normalize transport noise without rewriting the director's prompt.

    LTX's official prompting guidance favors present-tense cinematic prose,
    explicit action/camera/audio, and quoted dialogue. Those semantics are
    authored upstream; this boundary must not paraphrase or invent them.
    """
    return (
        str(prompt or '')
        .replace('\x00', ' ')
        .replace('\r\n', '\n')
        .replace('\r', '\n')
        .strip()
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
        # Do not clamp/repair dimensions. A repaired frame would violate the
        # canonical FLUX→LTX contract; reject it and let the agent correct the
        # source rather than producing a degraded shot.
        _validate_generation_contract(width, height, duration)
        duration = float(duration)
        prompt = _normalize_prompt(prompt)
        if not prompt:
            raise ProviderError("LTX I2V prompt is empty", category="validation")

        seed_value = int(seed) if seed is not None else 0
        if seed_value < 0 or seed_value > 2**31 - 1:
            raise ProviderError(f"Invalid LTX seed: {seed_value}", category="validation")

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
                    bool(enhance_prompt),
                    seed_value,
                    bool(randomize_seed),
                    PRODUCTION_HEIGHT,
                    PRODUCTION_WIDTH,
                )
                result = client.predict(*args, api_name=config.LTX_API_NAME)

                video_info, returned_seed = _unpack_result(result)
                hosted_url = _resolve_video_url(video_info)
                public_id = f"{config.CLOUDINARY_SHOTS_ROOT}/tmp/ltx_{job_id}"
                if hosted_url:
                    video_url = upload_video(public_id=public_id, source_url=hosted_url)
                else:
                    local_path = _resolve_video_path(video_info)
                    video_url = upload_video(public_id=public_id, file_path=str(local_path))

                token_manager.mark_active(token)

                logger.info(
                    "[LTX] completed job=%s token_slot=%s resolution=%sx%s duration=%ss randomize=%s enhance=%s",
                    job_id, slot, PRODUCTION_WIDTH, PRODUCTION_HEIGHT, duration,
                    bool(randomize_seed), bool(enhance_prompt),
                )
                return GenerationResult(
                    video_url=video_url,
                    seed=returned_seed,
                    raw={
                        "token_slot": slot,
                        "width": PRODUCTION_WIDTH,
                        "height": PRODUCTION_HEIGHT,
                        "duration": duration,
                        "frame_conditioning": "first_frame_strength_1.0",
                    },
                )
            except ProviderError:
                raise
            except Exception as exc:  # noqa: BLE001 — inspect broadly to classify
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
                    continue
                if category == "auth":
                    token_manager.mark_invalid(token, err_text)
                    last_error = ProviderError(
                        f"LTX authentication failed for token slot {slot}: {err_text}",
                        category="auth",
                        detail={"token_slot": slot, "traceback": tb},
                    )
                    continue

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
                            "width": PRODUCTION_WIDTH,
                            "height": PRODUCTION_HEIGHT,
                            "seed": seed_value,
                            "randomize_seed": bool(randomize_seed),
                            "enhance_prompt": bool(enhance_prompt),
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
    if is_blank_or_boilerplate_error(text):
        return "quota"
    return "unknown"


def _unpack_result(result):
    """The official Space returns [output_video, seed]."""
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
