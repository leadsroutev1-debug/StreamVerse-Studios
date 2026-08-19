"""In-process job store + background execution.

Node submits a job and gets an immediate ack; the engine runs the generation
asynchronously. The video-engine boundary enforces the same production media
contract as Node so a malformed or stale caller cannot silently submit a
wrong-resolution I2V request.
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
from .providers.ltx import LTXProvider

logger = logging.getLogger("video_engine.jobs")

_PROVIDERS = {
    "ltx": LTXProvider(),
}

# LTX-2.3 production portrait contract used by StreamVerse. This is deliberately
# fixed here as a second boundary check; callers cannot override it accidentally.
PRODUCTION_LTX_WIDTH = 1024
PRODUCTION_LTX_HEIGHT = 1536

_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="video-job")


@dataclass
class Job:
    job_id: str
    provider: str
    status: str = "queued"  # queued|submitting|running|completed|failed|cancelled
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
                # Idempotent resubmission of an in-flight job id.
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

        # Hard production boundary. The Node client already validates the
        # source image bytes; this prevents stale/manual callers from changing
        # the LTX geometry downstream.
        try:
            width = int(params.get("width", PRODUCTION_LTX_WIDTH))
            height = int(params.get("height", PRODUCTION_LTX_HEIGHT))
        except (TypeError, ValueError) as exc:
            self._update(job_id, status="failed", error={"message": f"Invalid LTX dimensions: {exc}", "category": "validation"})
            return

        if provider_name == "ltx" and (width != PRODUCTION_LTX_WIDTH or height != PRODUCTION_LTX_HEIGHT):
            self._update(
                job_id,
                status="failed",
                error={
                    "message": f"Production LTX I2V requires {PRODUCTION_LTX_WIDTH}x{PRODUCTION_LTX_HEIGHT}; received {width}x{height}",
                    "category": "validation",
                    "expected_width": PRODUCTION_LTX_WIDTH,
                    "expected_height": PRODUCTION_LTX_HEIGHT,
                    "received_width": width,
                    "received_height": height,
                },
            )
            return

        self._update(job_id, status="submitting")
        if job._cancel:
            return
        self._update(job_id, status="running")

        try:
            result = provider.generate(
                job_id=job_id,
                image_url=params["image_url"],
                prompt=params["prompt"],
                duration=float(params.get("duration", 5.0)),
                width=width,
                height=height,
                seed=params.get("seed"),
                randomize_seed=bool(params.get("randomize_seed", False)),
                enhance_prompt=bool(params.get("enhance_prompt", False)),
            )
            if self.get(job_id) and self.get(job_id)._cancel:
                return
            self._update(
                job_id,
                status="completed",
                video_url=result.video_url,
                seed=result.seed,
            )
        except ProviderError as exc:
            logger.error("[Jobs] job=%s failed category=%s error=%s", job_id, exc.category, str(exc))
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
