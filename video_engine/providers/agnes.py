"""Agnes Video V2.0 provider.

Production adapter for Agnes AI's async image-to-video API.

Reliability policy:
- one server-side AGNES_API_KEY for all requests; no key rotation;
- retry transient HTTP failures (408, 429, 500, 502, 503, 504, 520, 522, 524)
  with exponential backoff, jitter, and Retry-After support;
- retry network/timeout failures;
- keep polling through transient poll failures without creating duplicate videos;
- fail fast on deterministic authentication/validation failures (400/401/403);
- retry poll-side 404 briefly because a just-created video resource may not be
  immediately visible, then surface the actual failure;
- upload the completed result to Cloudinary so Node never depends on local files.
"""
from __future__ import annotations

import logging
import random
import time
from typing import Any

import requests

from .. import config
from ..cloudinary_client import upload_video
from .base import GenerationResult, ProviderError, VideoProvider

logger = logging.getLogger("video_engine.agnes")

_TRANSIENT_STATUS_CODES = frozenset({408, 429, 500, 502, 503, 504, 520, 522, 524})
_AUTH_STATUS_CODES = frozenset({401, 403})
_VALIDATION_STATUS_CODES = frozenset({400})


def _api_key() -> str:
    # Prefer the explicit singular production secret. Keep AGNES_API_KEYS as a
    # backwards-compatible fallback for existing environments, but never rotate it.
    explicit = str(getattr(config, "AGNES_API_KEY", "") or "").strip()
    if explicit:
        return explicit
    legacy = getattr(config, "AGNES_API_KEYS", []) or []
    return str(legacy[0]).strip() if legacy else ""


def _backoff_seconds(attempt: int, *, retry_after: float | None = None) -> float:
    if retry_after is not None:
        return min(max(float(retry_after), 0.5), config.AGNES_RETRY_MAX_SECONDS)
    base = max(0.25, float(config.AGNES_RETRY_BASE_SECONDS))
    cap = max(base, float(config.AGNES_RETRY_MAX_SECONDS))
    raw = min(cap, base * (2 ** max(0, attempt - 1)))
    jitter = random.uniform(0, min(1.0, raw * 0.25))
    return min(cap, raw + jitter)


def _retry_after_seconds(response: requests.Response) -> float | None:
    raw = response.headers.get("Retry-After")
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _safe_response(value: Any) -> Any:
    if isinstance(value, dict):
        clean = dict(value)
        for key in ("video_url", "url", "remixed_from_video_id"):
            if key in clean and isinstance(clean[key], str):
                clean[key] = clean[key][:300]
        return clean
    return str(value)[:2000]


def _normalize_dimension(value: int) -> int:
    # Agnes documentation/examples use dimensions divisible by 8.
    n = max(8, int(value))
    return n - (n % 8)


def _duration_to_frames(seconds: float, frame_rate: int, max_frames: int) -> int:
    # Agnes V2.0 requires num_frames = 8n + 1.
    target = max(9, int(round(seconds * frame_rate)))
    max_legal = max(9, max_frames - ((max_frames - 1) % 8))
    target = min(target, max_legal)
    candidates = [f for f in range(max(9, target - 16), min(max_legal, target + 16) + 1) if (f - 1) % 8 == 0]
    return min(candidates or [9], key=lambda f: abs((f / frame_rate) - seconds))


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
            raise ProviderError("Agnes requires a non-empty final Vision Director prompt", category="validation")

        api_key = _api_key()
        if not api_key:
            raise ProviderError("No AGNES_API_KEY configured", category="auth")

        width = _normalize_dimension(width or config.AGNES_WIDTH)
        height = _normalize_dimension(height or config.AGNES_HEIGHT)
        frame_rate = max(1, min(60, int(config.AGNES_FRAME_RATE)))
        seconds = max(
            config.AGNES_DURATION_MIN,
            min(config.AGNES_DURATION_MAX, float(duration or 5.0)),
        )
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

        max_submit_attempts = max(1, int(config.AGNES_SUBMIT_RETRIES))

        response = self._request_with_retry(
            "POST",
            f"{config.AGNES_BASE_URL}/v1/videos",
            api_key,
            json=payload,
            timeout=config.AGNES_HTTP_TIMEOUT_SECONDS,
            max_attempts=max_submit_attempts,
            operation=f"submit job={job_id}",
        )
        data = _json_response(response, "Agnes video submission")

        video_id = data.get("video_id") or data.get("id") or data.get("task_id")
        if not video_id:
            raise ProviderError(
                "Agnes submission returned no video_id/task id",
                category="model",
                detail={"response": _safe_response(data)},
            )

        result = self._poll_result(api_key, str(video_id), job_id)
        video_url = result.get("url") or result.get("video_url")
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
                "status": result.get("status"),
                "retry_policy": sorted(_TRANSIENT_STATUS_CODES),
            },
        )

    def _poll_result(self, api_key: str, video_id: str, job_id: str) -> dict[str, Any]:
        last_error: Exception | None = None
        for poll_number in range(1, int(config.AGNES_MAX_POLL_ATTEMPTS) + 1):
            response = self._request_with_retry(
                "GET",
                f"{config.AGNES_BASE_URL}/agnesapi",
                api_key,
                params={"video_id": video_id, "model_name": config.AGNES_MODEL},
                timeout=config.AGNES_HTTP_TIMEOUT_SECONDS,
                max_attempts=max(1, int(config.AGNES_REQUEST_RETRIES)),
                operation=f"poll video_id={video_id}",
                allow_poll_404=True,
            )
            try:
                data = _json_response(response, "Agnes video poll")
            except ProviderError as exc:
                last_error = exc
                if poll_number >= int(config.AGNES_MAX_POLL_ATTEMPTS):
                    raise
                time.sleep(max(0.5, float(config.AGNES_POLL_INTERVAL_SECONDS)))
                continue

            status = str(data.get("status") or "").lower()
            progress = data.get("progress")
            logger.info(
                "[Agnes] job=%s video_id=%s poll=%s/%s status=%s progress=%s",
                job_id,
                video_id,
                poll_number,
                config.AGNES_MAX_POLL_ATTEMPTS,
                status,
                progress,
            )

            if status == "completed":
                return data
            if status == "failed":
                raise ProviderError(
                    str(data.get("error") or "Agnes reported generation failure"),
                    category="model",
                    detail={"video_id": video_id, "response": _safe_response(data)},
                )
            if status in {"cancelled", "canceled"}:
                raise ProviderError(
                    "Agnes generation was cancelled",
                    category="model",
                    detail={"video_id": video_id},
                )

            if poll_number < int(config.AGNES_MAX_POLL_ATTEMPTS):
                time.sleep(max(0.5, float(config.AGNES_POLL_INTERVAL_SECONDS)))

        raise ProviderError(
            f"Agnes video_id {video_id} did not complete after {config.AGNES_MAX_POLL_ATTEMPTS} polls",
            category="network" if last_error else "model",
            detail={"video_id": video_id, "last_error": str(last_error) if last_error else None},
        )

    def _request_with_retry(
        self,
        method: str,
        url: str,
        api_key: str,
        *,
        max_attempts: int,
        operation: str,
        allow_poll_404: bool = False,
        **kwargs,
    ) -> requests.Response:
        last_error: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                response = requests.request(
                    method,
                    url,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    **kwargs,
                )
            except requests.RequestException as exc:
                last_error = exc
                if attempt >= max_attempts:
                    raise ProviderError(
                        f"Agnes {operation} network failure after {attempt} attempts: {exc}",
                        category="network",
                        detail={"exception": type(exc).__name__},
                    ) from exc
                delay = _backoff_seconds(attempt)
                logger.warning("[Agnes] %s network failure attempt=%s/%s; retrying in %.2fs: %s", operation, attempt, max_attempts, delay, exc)
                time.sleep(delay)
                continue

            status = int(response.status_code)
            if status < 400:
                return response

            body = response.text[:2000]

            if status in _TRANSIENT_STATUS_CODES:
                if attempt >= max_attempts:
                    category = "quota" if status == 429 else "network"
                    raise ProviderError(
                        f"Agnes {operation} failed with transient HTTP {status} after {attempt} attempts",
                        category=category,
                        detail={"status": status, "body": body},
                    )
                retry_after = _retry_after_seconds(response) if status == 429 else None
                delay = _backoff_seconds(attempt, retry_after=retry_after)
                logger.warning("[Agnes] %s HTTP %s attempt=%s/%s; retrying in %.2fs", operation, status, attempt, max_attempts, delay)
                time.sleep(delay)
                continue

            if status in _AUTH_STATUS_CODES:
                raise ProviderError(
                    f"Agnes {operation} authentication failure HTTP {status}",
                    category="auth",
                    detail={"status": status, "body": body},
                )

            if status in _VALIDATION_STATUS_CODES:
                raise ProviderError(
                    f"Agnes {operation} invalid request HTTP 400",
                    category="validation",
                    detail={"status": status, "body": body},
                )

            if status == 404 and allow_poll_404 and attempt < max_attempts:
                delay = _backoff_seconds(attempt)
                logger.warning("[Agnes] %s poll returned 404; retrying in %.2fs", operation, delay)
                time.sleep(delay)
                continue

            raise ProviderError(
                f"Agnes {operation} failed HTTP {status}",
                category="validation" if status in {404, 422} else "model",
                detail={"status": status, "body": body},
            )

        raise ProviderError(
            f"Agnes {operation} exhausted retries",
            category="network",
            detail={"last_error": str(last_error) if last_error else None},
        )


def _json_response(response: requests.Response, operation: str) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError as exc:
        raise ProviderError(
            f"{operation} returned invalid JSON",
            category="model",
            detail={"body": response.text[:2000]},
        ) from exc
    if not isinstance(body, dict):
        raise ProviderError(f"{operation} returned a non-object response", category="model")
    return body
