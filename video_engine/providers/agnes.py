"""Agnes Video V2.0 provider.

Production adapter for Agnes' asynchronous video API.

The Node pipeline remains the canonical Cloudinary uploader. Agnes receives
its final Vision Director prompt plus either a single image-to-video source
or, for sequential shots, two ordered keyframes:
  1) exact last frame of the previous shot;
  2) authored/current shot still.
"""
from __future__ import annotations

import logging
import os
import random
import threading
import time
from typing import Any

import requests

from .. import config
from .base import GenerationResult, ProviderError, VideoProvider

logger = logging.getLogger("video_engine.agnes")

TRANSIENT_STATUS = frozenset({408, 429, 500, 502, 503, 504, 520, 522, 524})
AUTH_STATUS = frozenset({401, 403})
VALIDATION_STATUS = frozenset({400})
QUOTA_STATUS = frozenset({402})

DEFAULT_NEGATIVE_PROMPT = (
    # Text / overlay suppression
    "garbled text, gibberish, misspelled words, distorted lettering, unreadable text, "
    "random symbols, fake subtitles, subtitles, captions, closed captions, dialogue captions, "
    "text overlays, UI overlays, title cards, watermarks, logos, extra typography, floating text, "
    "duplicated text, malformed signs, malformed labels, screen text, extra written words, "
    "on-screen graphics, words appearing from nowhere, "
    # Character identity / morphology suppression
    "character morphing, face morphing, identity drift, identity swapping, face swapping, "
    "hybrid faces, merged faces, duplicated faces, age drift, age changing, body-shape drift, "
    "hairstyle changes, hair color changes, skin-tone drift, wardrobe changes, costume changes, "
    "extra people, duplicate people, vanishing characters, character cloning, character replacement, "
    # Anatomy / temporal artifacts
    "extra arms, extra legs, extra hands, extra fingers, missing fingers, fused fingers, "
    "fused hands, malformed hands, rubbery limbs, stretched limbs, warped anatomy, "
    "deformed face, melted facial features, distorted teeth, crossed eyes, eye drift, "
    "wandering eyes, unnatural blinking, random mouth movement, mouth deformation, teeth popping, "
    "lip-sync drift, wrong-character lip-sync, ghosting, temporal smear, double exposure, "
    "frame flicker, texture swimming, background warping, geometry drift, object duplication, "
    "prop morphing, floating props, disappearing props, phantom objects, "
    # Artificial performance suppression
    "robotic movement, mechanical movement, puppet-like motion, mannequin movement, "
    "rubber-like motion, sliding feet, foot skating, weightless motion, teleporting, "
    "instant pose changes, unmotivated gestures, synchronized character motion, "
    "identical reactions, random secondary-character motion, random background activity, "
    "camera jitter, unmotivated camera shake, excessive zoom, excessive camera movement, "
    "motion blur, smearing, low-detail faces"
)

_QUOTA_PATTERNS = (
    "quota", "daily quota", "daily limit", "seconds per day", "500 seconds",
    "insufficient quota", "quota exceeded", "quota exhausted", "usage limit",
    "subscription quota",
)


def _configured_keys() -> list[str]:
    keys = getattr(config, "AGNES_API_KEYS", []) or []
    if keys:
        return keys
    explicit = str(os.environ.get("AGNES_API_KEY", "") or "").strip()
    return [explicit] if explicit else []


def _cooldown_seconds() -> float:
    try:
        return max(60.0, float(os.environ.get("AGNES_KEY_COOLDOWN_SECONDS", "86400")))
    except (TypeError, ValueError):
        return 86400.0


class _AgnesKeyPool:
    def __init__(self, keys: list[str], cooldown_seconds: float) -> None:
        self._keys = list(dict.fromkeys(k.strip() for k in keys if k and k.strip()))
        self._cooldown_seconds = max(60.0, float(cooldown_seconds))
        self._cooldown_until: dict[str, float] = {}
        self._cursor = 0
        self._lock = threading.Lock()

    def current(self) -> tuple[str, int]:
        with self._lock:
            if not self._keys:
                raise ProviderError("No AGNES_API_KEYS configured", category="auth")
            now = time.time()
            for offset in range(len(self._keys)):
                idx = (self._cursor + offset) % len(self._keys)
                key = self._keys[idx]
                if self._cooldown_until.get(key, 0) <= now:
                    self._cursor = idx
                    return key, idx
            soonest = min(self._cooldown_until.values()) if self._cooldown_until else now
            raise ProviderError(
                "All Agnes API keys are cooling down after quota exhaustion",
                category="quota",
                detail={"retry_after_seconds": max(0, int(soonest - now))},
            )

    def rotate_after_quota(self, key: str) -> tuple[str, int]:
        with self._lock:
            if not self._keys:
                raise ProviderError("No AGNES_API_KEYS configured", category="auth")
            try:
                current_idx = self._keys.index(key)
            except ValueError:
                current_idx = self._cursor
            self._cooldown_until[key] = time.time() + self._cooldown_seconds
            now = time.time()
            for offset in range(1, len(self._keys) + 1):
                idx = (current_idx + offset) % len(self._keys)
                candidate = self._keys[idx]
                if self._cooldown_until.get(candidate, 0) <= now:
                    self._cursor = idx
                    return candidate, idx
            soonest = min(self._cooldown_until.values()) if self._cooldown_until else now
            raise ProviderError(
                "All Agnes API keys are cooling down after quota exhaustion",
                category="quota",
                detail={"retry_after_seconds": max(0, int(soonest - now))},
            )


_KEYS = _AgnesKeyPool(_configured_keys(), _cooldown_seconds())


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


def _is_quota_exhausted(status: int, body: str) -> bool:
    if status in QUOTA_STATUS:
        return True
    if status != 429:
        return False
    lowered = (body or "").lower()
    return any(pattern in lowered for pattern in _QUOTA_PATTERNS)


def _safe(value: Any) -> Any:
    if isinstance(value, dict):
        clean = dict(value)
        if "api_key" in clean:
            clean["api_key"] = "***"
        return clean
    return str(value)[:2000]


def _dim(value: int) -> int:
    n = max(8, int(value))
    return n - (n % 8)


def _frames(seconds: float, fps: int, max_frames: int) -> int:
    target = max(9, int(round(seconds * fps)))
    max_legal = max(9, max_frames - ((max_frames - 1) % 8))
    candidates = [
        f for f in range(max(9, target - 32), min(max_legal, target + 32) + 1)
        if (f - 1) % 8 == 0
    ]
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
        negative_prompt: str | None = None,
        reference_image_urls: list[str] | None = None,
    ) -> GenerationResult:
        if not image_url:
            raise ProviderError("Agnes requires a reference image URL", category="validation")
        if not prompt or not prompt.strip():
            raise ProviderError("Agnes requires the final Vision Director prompt", category="validation")

        keys = _configured_keys()
        if not keys:
            raise ProviderError("No AGNES_API_KEYS configured", category="auth")

        fps = max(1, min(60, int(config.AGNES_FRAME_RATE)))
        seconds = max(config.AGNES_DURATION_MIN, min(config.AGNES_DURATION_MAX, float(duration or 1)))
        frames = _frames(seconds, fps, config.AGNES_MAX_FRAMES)
        resolved_negative_prompt = str(
            negative_prompt
            or os.environ.get("AGNES_NEGATIVE_PROMPT", "")
            or DEFAULT_NEGATIVE_PROMPT
        ).strip()

        refs = [str(url).strip() for url in (reference_image_urls or []) if str(url).strip()]
        use_keyframes = len(refs) >= 2

        payload = {
            "model": config.AGNES_MODEL,
            "prompt": prompt.strip(),
            "image": image_url,
            "width": _dim(width or config.AGNES_WIDTH),
            "height": _dim(height or config.AGNES_HEIGHT),
            "num_frames": frames,
            "frame_rate": fps,
            "negative_prompt": resolved_negative_prompt,
        }
        if seed is not None:
            payload["seed"] = int(seed)

        if use_keyframes:
            # Agnes V2.0 keyframes mode: the ordered list is authoritative.
            # refs[0] = previous last frame; refs[1] = current authored still.
            payload.pop("image", None)
            payload["extra_body"] = {
                "image": refs,
                "mode": "keyframes",
            }

        max_key_attempts = max(1, len(keys))
        last_error: ProviderError | None = None

        for key_attempt in range(1, max_key_attempts + 1):
            api_key, key_slot = _KEYS.current()
            logger.info(
                "[Agnes] job=%s key_slot=%s/%s attempt=%s/%s mode=%s refs=%s frames=%s fps=%s size=%sx%s",
                job_id,
                key_slot + 1,
                len(keys),
                key_attempt,
                max_key_attempts,
                "keyframes" if use_keyframes else "img2video",
                len(refs),
                frames,
                fps,
                payload["width"],
                payload["height"],
            )

            try:
                response = self._request(
                    "POST",
                    f"{config.AGNES_BASE_URL}/v1/videos",
                    api_key,
                    operation=f"submit job={job_id}",
                    json=payload,
                    max_attempts=max(1, int(config.AGNES_SUBMIT_RETRIES)),
                )
                created = _json(response, "Agnes video submission")
                video_id = created.get("video_id")
                if not video_id:
                    raise ProviderError(
                        "Agnes submission returned no video_id",
                        category="model",
                        detail={"response": _safe(created)},
                    )

                result = self._poll(api_key, str(video_id), job_id)
                video_url = result.get("url") or result.get("video_url")
                if not isinstance(video_url, str) or not video_url.startswith(("http://", "https://")):
                    raise ProviderError(
                        "Agnes completed without a usable video URL",
                        category="model",
                        detail={"video_id": video_id, "response": _safe(result)},
                    )

                logger.info(
                    "[Agnes] job=%s completed video_id=%s mode=%s refs=%s duration=%.3fs",
                    job_id,
                    video_id,
                    "keyframes" if use_keyframes else "img2video",
                    len(refs),
                    frames / fps,
                )
                return GenerationResult(
                    video_url=video_url,
                    seed=result.get("seed", seed),
                    raw={
                        "provider": "agnes",
                        "video_id": video_id,
                        "status": result.get("status"),
                        "requested_seconds": seconds,
                        "actual_frame_seconds": frames / fps,
                        "frames": frames,
                        "fps": fps,
                        "mode": "keyframes" if use_keyframes else "img2video",
                        "reference_count": len(refs),
                        "key_slot": key_slot,
                        "canonical_uploader": "node",
                    },
                )
            except ProviderError as exc:
                last_error = exc
                if exc.category == "quota":
                    try:
                        _, next_slot = _KEYS.rotate_after_quota(api_key)
                        logger.warning(
                            "[Agnes] job=%s key_slot=%s quota exhausted; rotating to key_slot=%s",
                            job_id,
                            key_slot + 1,
                            next_slot + 1,
                        )
                        continue
                    except ProviderError:
                        raise exc
                raise

        raise last_error or ProviderError("Agnes generation failed", category="unknown")

    def _poll(self, api_key: str, video_id: str, job_id: str) -> dict[str, Any]:
        max_polls = max(1, int(config.AGNES_MAX_POLL_ATTEMPTS))
        current_key = api_key

        for poll_number in range(1, max_polls + 1):
            try:
                response = self._request(
                    "GET",
                    f"{config.AGNES_BASE_URL}/agnesapi",
                    current_key,
                    operation=f"poll video_id={video_id}",
                    params={"video_id": video_id, "model_name": config.AGNES_MODEL},
                    max_attempts=max(1, int(config.AGNES_SUBMIT_RETRIES)),
                    allow_404=True,
                )
            except ProviderError as exc:
                if exc.category == "quota":
                    current_key, next_slot = _KEYS.rotate_after_quota(current_key)
                    logger.warning(
                        "[Agnes] job=%s poll quota exhausted for video_id=%s; rotating polling key to slot=%s",
                        job_id,
                        video_id,
                        next_slot + 1,
                    )
                    continue
                raise

            data = _json(response, "Agnes video poll")
            status = str(data.get("status") or "").lower()
            logger.info(
                "[Agnes] job=%s video_id=%s poll=%s/%s status=%s progress=%s",
                job_id,
                video_id,
                poll_number,
                max_polls,
                status,
                data.get("progress"),
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
                raise ProviderError(
                    "Agnes generation was cancelled",
                    category="model",
                    detail={"video_id": video_id},
                )
            if poll_number < max_polls:
                time.sleep(max(0.5, float(config.AGNES_POLL_INTERVAL_SECONDS)))

        raise ProviderError(
            f"Agnes video_id {video_id} did not complete after {max_polls} polls",
            category="network",
            detail={"video_id": video_id},
        )

    def _request(
        self,
        method: str,
        url: str,
        api_key: str,
        *,
        operation: str,
        max_attempts: int,
        allow_404: bool = False,
        **kwargs,
    ) -> requests.Response:
        for attempt in range(1, max_attempts + 1):
            try:
                response = requests.request(
                    method,
                    url,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    timeout=config.AGNES_HTTP_TIMEOUT_SECONDS,
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
                logger.warning(
                    "[Agnes] %s network error attempt=%s/%s; retrying in %.2fs",
                    operation,
                    attempt,
                    max_attempts,
                    delay,
                )
                time.sleep(delay)
                continue

            status = int(response.status_code)
            body = response.text[:4000]
            if status < 400:
                return response

            if _is_quota_exhausted(status, body):
                raise ProviderError(
                    f"Agnes {operation} daily quota exhausted (HTTP {status})",
                    category="quota",
                    detail={"status": status, "body": body, "daily_quota_exhausted": True},
                )

            if status in TRANSIENT_STATUS:
                if attempt >= max_attempts:
                    raise ProviderError(
                        f"Agnes {operation} exhausted transient HTTP {status} retries",
                        category="network",
                        detail={"status": status, "body": body},
                    )
                delay = _retry_delay(attempt, response)
                logger.warning(
                    "[Agnes] %s HTTP %s attempt=%s/%s; retrying in %.2fs",
                    operation,
                    status,
                    attempt,
                    max_attempts,
                    delay,
                )
                time.sleep(delay)
                continue

            if status in AUTH_STATUS:
                raise ProviderError(
                    f"Agnes {operation} authentication failed (HTTP {status})",
                    category="auth",
                    detail={"status": status, "body": body},
                )

            if status in VALIDATION_STATUS:
                raise ProviderError(
                    f"Agnes {operation} rejected request (HTTP 400)",
                    category="validation",
                    detail={"status": status, "body": body},
                )

            if status == 404 and allow_404:
                if attempt < max_attempts:
                    delay = _retry_delay(attempt, response)
                    logger.warning(
                        "[Agnes] %s returned 404 during polling; retrying in %.2fs",
                        operation,
                        delay,
                    )
                    time.sleep(delay)
                    continue

            raise ProviderError(
                f"Agnes {operation} failed with HTTP {status}",
                category="model",
                detail={"status": status, "body": body},
            )

        raise ProviderError(f"Agnes {operation} exhausted request attempts", category="network")
