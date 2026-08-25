"""In-process job store + background execution.

Node submits a job and gets an immediate ack; it polls
GET /internal/video/jobs/{job_id} for status instead of blocking on one
long synchronous HTTP request.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

from .providers.base import ProviderError
from .providers.agnes import AgnesProvider
from .providers.ltx import LTXProvider

logger = logging.getLogger("video_engine.jobs")

_PROVIDERS = {
    "ltx": LTXProvider(),
    "agnes": AgnesProvider(),
}

_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="video-job")


@dataclass
class Job:
    job_id: str
    provider: str
    status: str = "queued"
    video_url: Optional[str] = None
    seed: Optional[int] = None
    error: Optional[dict] = None
    progress: Optional[float] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    _cancel: bool = field(default=False, repr=False)

    def public_dict(self) -> dict:
        d = {
            "job_id": self.job_id,
            "status": self.status,
            "provider": self.provider,
            "progress": self.progress,
        }
        if self.status == "completed":
            d["video_url"] = self.video_url
            d["seed"] = self.seed
        if self.status == "failed":
            d["error"] = self.error
        return d


class JobStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}

    def create(self, job_id: str | None, provider: str, params: dict) -> Job:
        jid = job_id or str(uuid.uuid4())
        with self._lock:
            if jid in self._jobs and self._jobs[jid].status in ("queued", "submitting", "running"):
                return self._jobs[jid]
            job = Job(job_id=jid, provider=provider)
            self._jobs[jid] = job
        _executor.submit(self._run, jid, params)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job and job.status in ("queued", "submitting", "running"):
                job._cancel = True
                job.status = "cancelled"
                job.updated_at = time.time()
            return job

    def _update(self, job_id: str, **kwargs) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            for k, v in kwargs.items():
                setattr(job, k, v)
            job.updated_at = time.time()

    def _run(self, job_id: str, params: dict) -> None:
        job = self.get(job_id)
        if not job or job._cancel:
            return

        provider_name = params.get("provider", "ltx")
        provider = _PROVIDERS.get(provider_name)
        if provider is None:
            self._update(job_id, status="failed", error={"message": f"Unknown provider '{provider_name}'", "category": "validation"})
            return

        self._update(job_id, status="submitting")
        if job._cancel:
            return
        self._update(job_id, status="running")

        try:
            common = {
                "job_id": job_id,
                "image_url": params["image_url"],
                "prompt": params["prompt"],
                "duration": float(params.get("duration", 5.0)),
                "width": int(params.get("width", 1024)),
                "height": int(params.get("height", 1536)),
                "seed": params.get("seed"),
                "randomize_seed": bool(params.get("randomize_seed", False)),
                "enhance_prompt": bool(params.get("enhance_prompt", False)),
                "reference_image_urls": params.get("reference_image_urls"),
            }

            # Agnes-only input. LTX never receives or serializes this field.
            if provider_name == "agnes":
                common["negative_prompt"] = params.get("negative_prompt")

            result = provider.generate(**common)

            if self.get(job_id) and self.get(job_id)._cancel:
                return
            self._update(
                job_id,
                status="completed",
                video_url=result.video_url,
                seed=result.seed,
            )
        except ProviderError as exc:
            logger.error("[Jobs] job=%s provider=%s failed category=%s error=%s", job_id, provider_name, exc.category, str(exc))
            self._update(
                job_id,
                status="failed",
                error={
                    "message": str(exc),
                    "category": exc.category,
                    **exc.detail,
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("[Jobs] job=%s unexpected failure", job_id)
            self._update(job_id, status="failed", error={"message": str(exc), "category": "unknown"})


job_store = JobStore()
