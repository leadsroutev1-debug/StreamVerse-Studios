"""Agnes Video V2.0 provider.

Production adapter for Agnes AI's async image-to-video API. The provider
keeps API keys server-side, rotates keys on authentication/quota failures,
uses Agnes' current video_id polling endpoint, converts requested duration
to Agnes' legal 8n+1 frame constraint, and uploads the finished clip to
Cloudinary so the Node/Python boundary never depends on local files.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

import requests

from .. import config
from ..cloudinary_client import upload_video
from .base import GenerationResult, ProviderError, VideoProvider

logger = logging.getLogger("video_engine.agnes")


class _KeyPool:
    def __init__(self, keys: list[str], cooldown_seconds: float = 60.0):
        self._keys = list(keys)
        self._cooldown_seconds = max(5.0, cooldown_seconds)
        self._cooldown_until: dict[str, float] = {}
        self._cursor = 0
        self._lock = threading.Lock()

    def __len__(self) -> int:
        return len(self._keys)

    def next(self) -> tuple[str, int]:
        with self._lock:
            now = time.time()
            for offset in range(len(self._keys)):
                idx = (self._cursor + offset) % len(self._keys)
                key = self._keys[idx]
                if self._cooldown_until.get(key, 0) <= now:
                    self._cursor = (idx + 1) % len(self._keys)
                    return key, idx
        raise ProviderError(
            "All Agnes API keys are temporarily cooling down",
            category="quota",
        )

    def cooldown(self, key: str) -> None:
        with self._lock:
            self._cooldown_until[key] = time.time() + self._cooldown_seconds


_KEYS = _KeyPool(config.AGNES_API_KEYS, config.AGNES_KEY_COOLDOWN_SECONDS)
_SESSION = requests.Session()


class AgnesProvider(VideoProvider):
    name = "agnes"

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
        if not image_url:
            raise ProviderError("Agnes requires a reference image URL", category="validation")
        if not prompt or not prompt.strip():
            raise ProviderError("Agnes requires a non-empty prompt", category="validation")
        if not len(_KEYS):
            raise ProviderError("No AGNES_API_KEYS configured", category="auth")

        width = _normalize_dimension(width or config.AGNES_WIDTH)
        height = _normalize_dimension(height or config.AGNES_HEIGHT)
        frame_rate = max(1, min(60, int(config.AGNES_FRAME_RATE)))
        seconds = max(config.AGNES_DURATION_MIN, min(config.AGNES_DURATION_MAX, float(duration or 5.0)))
        num_frames = _duration_to_frames(seconds, frame_rate, config.AGNES_MAX_FRAMES)
        seed_value = int(seed) if seed is not None else None

        payload = {
            "model": config.AGNES_MODEL,
            "prompt": prompt.strip(),
            "image": image_url,
            "width": width,
            "height": height,
            "num_frames": num_frames,
            "frame_rate": frame_rate,
        }
        if seed_value is not None:
            payload["seed"] = seed_value

        max_submit_attempts = max(1, config.AGNES_SUBMIT_RETRIES)
        last_error: ProviderError | None = None

        for attempt in range(1, max_submit_attempts + 1):
            try:
                api_key, key_slot = _KEYS.next()
                logger.info(
                    "[Agnes] job=%s submit attempt=%s/%s key_slot=%s frames=%s fps=%s seconds=%.3f size=%sx%s",
                    job_id, attempt, max_submit_attempts, key_slot, num_frames, frame_rate,
                    num_frames / frame_rate, width, height,
                )
                response = _request_with_retry(
                    "POST",
                    f"{config.AGNES_BASE_URL}/v1/videos",
                    api_key,
                    json=payload,
                    timeout=config.AGNES_HTTP_TIMEOUT_SECONDS,
                )
                data = _json_response(response, "Agnes video submission")

                video_id = data.get("video_id") or data.get("id") or data.get("task_id")
                if not video_id:
                    raise ProviderError(
                        "Agnes submission returned no video_id/task id",
                        category="model",
                        detail={"response": _safe_response(data)},
                    )

                result = _poll_result(api_key, video_id, job_id)
                video_url = (
                    result.get("url")
                    or result.get("remixed_from_video_id")
                    or result.get("video_url")
                )
                if not isinstance(video_url, str) or not video_url.startswith(("http://", "https://")):
                    raise ProviderError(
                        "Agnes completed without a usable video URL",
                        category="model",
                        detail={"video_id": video_id, "response": _safe_response(result)},
                    )

                public_id = f"{config.CLOUDINARY_SHOTS_ROOT}/tmp/agnes_{job_id}"
                uploaded_url = upload_video(public_id=public_id, source_url=video_url)

                return GenerationResult(
                    video_url=uploaded_url,
                    seed=result.get("seed", seed_value),
                    raw={
                        "provider": "agnes",
                        "video_id": video_id,
                        "requested_seconds": seconds,
                        "actual_frame_seconds": num_frames / frame_rate,
                        "width": width,
                        "height": height,
                        "frame_rate": frame_rate,
                        "key_slot": key_slot,
                        "status": result.get("status"),
                    },
                )
            except ProviderError as exc:
                last_error = exc
                if exc.category in {"auth", "quota"} and 'api_key' in locals():
                    _KEYS.cooldown(api_key)
                if attempt >= max_submit_attempts or exc.category not in {"auth", "quota", "network", "model"}:
                    raise
                delay = min(config.AGNES_RETRY_MAX_SECONDS, config.AGNES_RETRY_BASE_SECONDS * attempt)
                logger.warning("[Agnes] job=%s recoverable submit failure category=%s; retrying in %.1fs: %s", job_id, exc.category, delay, exc)
                time.sleep(delay)
            except Exception as exc:  # noqa: BLE001
                last_error = ProviderError(
                    str(exc),
                    category="unknown",
                    detail={"job_id": job_id, "provider": self.name},
                )
                if attempt >= max_submit_attempts:
                    raise last_error from exc
                time.sleep(min(config.AGNES_RETRY_MAX_SECONDS, config.AGNES_RETRY_BASE_SECONDS * attempt))

        raise last_error or ProviderError("Agnes generation failed", category="unknown")


def _poll_result(api_key: str, video_id: str, job_id: str) -> dict[str, Any]:
    last_transient: Exception | None = None
    for attempt in range(1, config.AGNES_MAX_POLL_ATTEMPTS + 1):
        try:
            response = _request_with_retry(
                "GET",
                f"{config.AGNES_BASE_URL}/agnesapi",
                api_key,
                params={"video_id": video_id, "model_name": config.AGNES_MODEL},
                timeout=config.AGNES_HTTP_TIMEOUT_SECONDS,
                max_request_retries=2,
            )
            data = _json_response(response, "Agnes video poll")
            status = str(data.get("status") or "").lower()
            progress = data.get("progress")
            logger.info("[Agnes] job=%s video_id=%s poll=%s/%s status=%s progress=%s", job_id, video_id, attempt, config.AGNES_MAX_POLL_ATTEMPTS, status, progress)

            if status == "completed":
                return data
            if status == "failed":
                detail = data.get("error") or "Agnes reported generation failure"
                raise ProviderError(str(detail), category="model", detail={"video_id": video_id, "response": _safe_response(data)})
            if status in {"cancelled", "canceled"}:
                raise ProviderError("Agnes generation was cancelled", category="model", detail={"video_id": video_id})

            time.sleep(config.AGNES_POLL_INTERVAL_SECONDS)
        except ProviderError:
            raise
        except requests.RequestException as exc:
            last_transient = exc
            if attempt >= config.AGNES_MAX_POLL_ATTEMPTS:
                break
            time.sleep(min(config.AGNES_RETRY_MAX_SECONDS, config.AGNES_RETRY_BASE_SECONDS * 2))

    raise ProviderError(
        f"Agnes video_id {video_id} did not complete after {config.AGNES_MAX_POLL_ATTEMPTS} polls",
        category="network" if last_transient else "model",
        detail={"video_id": video_id, "last_error": str(last_transient) if last_transient else None},
    )


def _request_with_retry(method: str, url: str, api_key: str, *, max_request_retries: int = 3, **kwargs):
    last_exc: Exception | None = None
    for attempt in range(1, max_request_retries + 1):
        try:
            response = _SESSION.request(
                method,
                url,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                **kwargs,
            )
        except requests.RequestException as exc:
            last_exc = exc
            if attempt >= max_request_retries:
                raise ProviderError(str(exc), category="network") from exc
            time.sleep(min(config.AGNES_RETRY_MAX_SECONDS, config.AGNES_RETRY_BASE_SECONDS * attempt))
            continue

        if response.status_code < 400:
            return response

        body = response.text[:2000]
        if response.status_code in {401, 403}:
            raise ProviderError(
                f"Agnes authentication failed ({response.status_code})",
                category="auth",
                detail={"status": response.status_code, "body": body},
            )
        if response.status_code == 429:
            if attempt < max_request_retries:
                retry_after = _retry_after_seconds(response)
                time.sleep(retry_after)
                continue
            raise ProviderError(
                "Agnes rate limit/quota response (429)",
                category="quota",
                detail={"status": 429, "body": body},
            )
        if response.status_code >= 500:
            if attempt < max_request_retries:
                time.sleep(min(config.AGNES_RETRY_MAX_SECONDS, config.AGNES_RETRY_BASE_SECONDS * attempt))
                continue
            raise ProviderError(
                f"Agnes server error ({response.status_code})",
                category="model",
                detail={"status": response.status_code, "body": body},
            )
        raise ProviderError(
            f"Agnes request failed ({response.status_code})",
            category="validation",
            detail={"status": response.status_code, "body": body},
        )

    if last_exc:
        raise ProviderError(str(last_exc), category="network") from last_exc
    raise ProviderError("Agnes request failed", category="unknown")


def _json_response(response: requests.Response, operation: str) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError as exc:
        raise ProviderError(f"{operation} returned invalid JSON", category="model", detail={"body": response.text[:2000]}) from exc
    if not isinstance(body, dict):
        raise ProviderError(f"{operation} returned a non-object response", category="model")
    return body


def _retry_after_seconds(response: requests.Response) -> float:
    raw = response.headers.get("Retry-After")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = config.AGNES_RETRY_BASE_SECONDS
    return min(max(value, 0.5), config.AGNES_RETRY_MAX_SECONDS)


def _normalize_dimension(value: int) -> int:
    n = max(8, int(value))
    return n - (n % 8)


def _duration_to_frames(seconds: float, frame_rate: int, max_frames: int) -> int:
    target = max(9, int(round(seconds * frame_rate)))
    max_legal = max_frames - ((max_frames - 1) % 8)
    target = min(target, max_legal)
    remainder = (target - 1) % 8
    lower = target - remainder
    upper = lower + 8
    candidates = [f for f in (lower, upper) if 9 <= f <= max_legal and (f - 1) % 8 == 0]
    return min(candidates or [9], key=lambda f: abs((f / frame_rate) - seconds))


def _safe_response(value: Any) -> Any:
    if isinstance(value, dict):
        clean = dict(value)
        for key in ("video_url", "url", "remixed_from_video_id"):
            if key in clean and isinstance(clean[key], str):
                clean[key] = clean[key][:300]
        return clean
    return str(value)[:2000]
