"""Agnes Video V2.0 provider with single-key resilient retries."""
from __future__ import annotations

import logging
import os
import random
import time
from typing import Any

import requests

from .. import config
from ..cloudinary_client import upload_video
from .base import GenerationResult, ProviderError, VideoProvider

logger = logging.getLogger("video_engine.agnes")

TRANSIENT_STATUS = frozenset({408, 429, 500, 502, 503, 504, 520, 522, 524})
AUTH_STATUS = frozenset({401, 403})
VALIDATION_STATUS = frozenset({400})


def _api_key() -> str:
    explicit = str(os.environ.get("AGNES_API_KEY", "") or "").strip()
    if explicit:
        return explicit
    legacy = getattr(config, "AGNES_API_KEYS", []) or []
    return str(legacy[0]).strip() if legacy else ""


def _retry_delay(attempt: int, response: requests.Response | None = None) -> float:
    retry_after = response.headers.get("Retry-After") if response is not None else None
    try:
        if retry_after is not None:
            return min(max(float(retry_after), 0.5), config.AGNES_RETRY_MAX_SECONDS)
    except (TypeError, ValueError):
        pass
    base = max(0.25, float(config.AGNES_RETRY_BASE_SECONDS))
    cap = max(base, float(config.AGNES_RETRY_MAX_SECONDS))
    raw = min(cap, base * (2 ** max(0, attempt - 1)))
    return min(cap, raw + random.uniform(0, min(1.0, raw * 0.25)))


def _safe(value: Any) -> Any:
    if isinstance(value, dict):
        return dict(value)
    return str(value)[:2000]


def _dim(value: int) -> int:
    n = max(8, int(value))
    return n - (n % 8)


def _frames(seconds: float, fps: int, max_frames: int) -> int:
    target = max(9, int(round(seconds * fps)))
    max_legal = max(9, max_frames - ((max_frames - 1) % 8))
    candidates = [f for f in range(max(9, target - 32), min(max_legal, target + 32) + 1) if (f - 1) % 8 == 0]
    return min(candidates or [9], key=lambda f: abs(f / fps - seconds))


def _json(response: requests.Response, operation: str) -> dict[str, Any]:
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


class AgnesProvider(VideoProvider):
    name = "agnes"

    def generate(self, *, job_id: str, image_url: str, prompt: str, duration: float,
                 width: int, height: int, seed: int | None, randomize_seed: bool,
                 enhance_prompt: bool) -> GenerationResult:
        if not image_url:
            raise ProviderError("Agnes requires a reference image URL", category="validation")
        if not prompt or not prompt.strip():
            raise ProviderError("Agnes requires the final Vision Director prompt", category="validation")

        api_key = _api_key()
        if not api_key:
            raise ProviderError("No AGNES_API_KEY configured", category="auth")

        fps = max(1, min(60, int(config.AGNES_FRAME_RATE)))
        seconds = max(config.AGNES_DURATION_MIN, min(config.AGNES_DURATION_MAX, float(duration or 5)))
        frames = _frames(seconds, fps, config.AGNES_MAX_FRAMES)
        payload = {
            "model": config.AGNES_MODEL,
            "prompt": prompt.strip(),
            "image": image_url,
            "width": _dim(width or config.AGNES_WIDTH),
            "height": _dim(height or config.AGNES_HEIGHT),
            "num_frames": frames,
            "frame_rate": fps,
        }
        if seed is not None:
            payload["seed"] = int(seed)

        response = self._request(
            "POST",
            f"{config.AGNES_BASE_URL}/v1/videos",
            api_key,
            operation=f"submit job={job_id}",
            json=payload,
            max_attempts=max(1, int(config.AGNES_SUBMIT_RETRIES)),
        )
        created = _json(response, "Agnes video submission")
        video_id = created.get("video_id") or created.get("id") or created.get("task_id")
        if not video_id:
            raise ProviderError("Agnes submission returned no video_id", category="model", detail={"response": _safe(created)})

        result = self._poll(api_key, str(video_id), job_id)
        video_url = result.get("url") or result.get("video_url")
        if not isinstance(video_url, str) or not video_url.startswith(("http://", "https://")):
            raise ProviderError(
                "Agnes completed without a usable video URL",
                category="model",
                detail={"video_id": video_id, "response": _safe(result)},
            )

        cloudinary_url = upload_video(
            public_id=f"{config.CLOUDINARY_SHOTS_ROOT}/tmp/agnes_{job_id}",
            source_url=video_url,
        )
        return GenerationResult(
            video_url=cloudinary_url,
            seed=result.get("seed", seed),
            raw={
                "provider": "agnes",
                "video_id": video_id,
                "status": result.get("status"),
                "requested_seconds": seconds,
                "actual_frame_seconds": frames / fps,
                "frames": frames,
                "fps": fps,
            },
        )

    def _poll(self, api_key: str, video_id: str, job_id: str) -> dict[str, Any]:
        max_polls = max(1, int(config.AGNES_MAX_POLL_ATTEMPTS))
        for poll_number in range(1, max_polls + 1):
            response = self._request(
                "GET",
                f"{config.AGNES_BASE_URL}/agnesapi",
                api_key,
                operation=f"poll video_id={video_id}",
                params={"video_id": video_id, "model_name": config.AGNES_MODEL},
                max_attempts=max(1, int(config.AGNES_SUBMIT_RETRIES)),
                allow_404=True,
            )
            data = _json(response, "Agnes video poll")
            status = str(data.get("status") or "").lower()
            logger.info(
                "[Agnes] job=%s video_id=%s poll=%s/%s status=%s progress=%s",
                job_id, video_id, poll_number, max_polls, status, data.get("progress"),
            )
            if status == "completed":
                return data
            if status == "failed":
                raise ProviderError(
                    str(data.get("error") or "Agnes reported generation failure"),
                    category="model",
                    detail={"video_id": video_id, "response": _safe(data)},
                )
            if status in {"cancelled", "canceled"}:
                raise ProviderError("Agnes generation was cancelled", category="model", detail={"video_id": video_id})
            if poll_number < max_polls:
                time.sleep(max(0.5, float(config.AGNES_POLL_INTERVAL_SECONDS)))

        raise ProviderError(
            f"Agnes video_id {video_id} did not complete after {max_polls} polls",
            category="network",
            detail={"video_id": video_id},
        )

    def _request(self, method: str, url: str, api_key: str, *, operation: str,
                 max_attempts: int, allow_404: bool = False, **kwargs) -> requests.Response:
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
                if attempt >= max_attempts:
                    raise ProviderError(
                        f"Agnes {operation} network failure after {attempt} attempts: {exc}",
                        category="network",
                        detail={"exception": type(exc).__name__},
                    ) from exc
                delay = _retry_delay(attempt)
                logger.warning("[Agnes] %s network error attempt=%s/%s; retrying in %.2fs", operation, attempt, max_attempts, delay)
                time.sleep(delay)
                continue

            status = int(response.status_code)
            if status < 400:
                return response

            if status in TRANSIENT_STATUS:
                if attempt >= max_attempts:
                    raise ProviderError(
                        f"Agnes {operation} exhausted transient HTTP {status} retries",
                        category="quota" if status == 429 else "network",
                        detail={"status": status, "body": response.text[:2000]},
                    )
                delay = _retry_delay(attempt, response if status == 429 else None)
                logger.warning("[Agnes] %s HTTP %s attempt=%s/%s; retrying in %.2fs", operation, status, attempt, max_attempts, delay)
                time.sleep(delay)
                continue

            if status in AUTH_STATUS:
                raise ProviderError(
                    f"Agnes {operation} authentication failure HTTP {status}",
                    category="auth",
                    detail={"status": status, "body": response.text[:2000]},
                )

            if status in VALIDATION_STATUS:
                raise ProviderError(
                    f"Agnes {operation} invalid request HTTP 400",
                    category="validation",
                    detail={"status": status, "body": response.text[:2000]},
                )

            if status == 404 and allow_404 and attempt < max_attempts:
                delay = _retry_delay(attempt)
                logger.warning("[Agnes] %s poll HTTP 404; retrying in %.2fs", operation, delay)
                time.sleep(delay)
                continue

            raise ProviderError(
                f"Agnes {operation} failed HTTP {status}",
                category="validation" if status in {404, 422} else "model",
                detail={"status": status, "body": response.text[:2000]},
            )

        raise ProviderError(f"Agnes {operation} retry loop exhausted", category="network")
