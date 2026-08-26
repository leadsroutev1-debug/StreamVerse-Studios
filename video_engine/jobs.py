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


# ============================================================================
# PROVIDERS
# ============================================================================

_PROVIDERS = {
    "ltx": LTXProvider(),
    "agnes": AgnesProvider(),
}


_executor = ThreadPoolExecutor(
    max_workers=4,
    thread_name_prefix="video-job",
)


# ============================================================================
# JOB MODEL
# ============================================================================

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


# ============================================================================
# JOB STORE
# ============================================================================

class JobStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}

    # ------------------------------------------------------------------------
    # CREATE
    # ------------------------------------------------------------------------

    def create(
        self,
        job_id: str | None,
        provider: str,
        params: dict,
    ) -> Job:
        jid = job_id or str(uuid.uuid4())

        with self._lock:
            existing = self._jobs.get(jid)

            # Idempotent create:
            # return the already-active job rather than launching a duplicate
            # background generation for the same job id.
            if existing and existing.status in (
                "queued",
                "submitting",
                "running",
            ):
                return existing

            job = Job(
                job_id=jid,
                provider=provider,
            )

            self._jobs[jid] = job

        _executor.submit(self._run, jid, params)

        return job

    # ------------------------------------------------------------------------
    # GET
    # ------------------------------------------------------------------------

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    # ------------------------------------------------------------------------
    # CANCEL
    # ------------------------------------------------------------------------

    def cancel(self, job_id: str) -> Job | None:
        with self._lock:
            job = self._jobs.get(job_id)

            if job and job.status in (
                "queued",
                "submitting",
                "running",
            ):
                job._cancel = True
                job.status = "cancelled"
                job.updated_at = time.time()

            return job

    # ------------------------------------------------------------------------
    # UPDATE
    # ------------------------------------------------------------------------

    def _update(
        self,
        job_id: str,
        **kwargs,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)

            if not job:
                return

            for key, value in kwargs.items():
                setattr(job, key, value)

            job.updated_at = time.time()

    # ------------------------------------------------------------------------
    # RUN
    # ------------------------------------------------------------------------

    def _run(
        self,
        job_id: str,
        params: dict,
    ) -> None:
        job = self.get(job_id)

        if not job or job._cancel:
            return

        # --------------------------------------------------------------------
        # Resolve provider
        # --------------------------------------------------------------------

        provider_name = str(
            params.get("provider") or job.provider or "ltx"
        ).strip().lower()

        provider = _PROVIDERS.get(provider_name)

        if provider is None:
            self._update(
                job_id,
                status="failed",
                error={
                    "message": f"Unknown provider '{provider_name}'",
                    "category": "validation",
                },
            )
            return

        # Keep the job's provider canonical and synchronized with the actual
        # provider used by the worker.
        self._update(
            job_id,
            provider=provider_name,
        )

        # --------------------------------------------------------------------
        # State transition: submitting
        # --------------------------------------------------------------------

        self._update(
            job_id,
            status="submitting",
        )

        current = self.get(job_id)

        if not current or current._cancel:
            return

        # --------------------------------------------------------------------
        # State transition: running
        # --------------------------------------------------------------------

        self._update(
            job_id,
            status="running",
        )

        try:
            # ================================================================
            # SHARED PROVIDER PARAMETERS
            # ================================================================
            #
            # These arguments are supported by the provider contract shared
            # between the current video backends.
            #
            # IMPORTANT:
            # Do NOT put provider-specific arguments into this dictionary.
            # Python will reject unsupported keyword arguments before the
            # provider can do anything with them.
            # ================================================================

            common = {
                "job_id": job_id,
                "image_url": params["image_url"],
                "prompt": params["prompt"],
                "duration": float(
                    params.get("duration", 5.0)
                ),
                "width": int(
                    params.get("width", 1024)
                ),
                "height": int(
                    params.get("height", 1536)
                ),
                "seed": params.get("seed"),
                "randomize_seed": bool(
                    params.get("randomize_seed", False)
                ),
                "enhance_prompt": bool(
                    params.get("enhance_prompt", False)
                ),
            }

            # ================================================================
            # PROVIDER-SPECIFIC PARAMETERS
            # ================================================================

            if provider_name == "agnes":
                # Agnes accepts the additional generation controls below.
                #
                # reference_image_urls belongs here, not in the shared
                # payload. This prevents LTXProvider.generate() from receiving
                # an argument that its signature does not define.
                common["negative_prompt"] = params.get(
                    "negative_prompt"
                )

                common["reference_image_urls"] = params.get(
                    "reference_image_urls"
                )

            # ================================================================
            # GENERATE
            # ================================================================

            result = provider.generate(**common)

            # ================================================================
            # CANCELLATION CHECK AFTER PROVIDER COMPLETES
            # ================================================================

            current = self.get(job_id)

            if current and current._cancel:
                return

            # ================================================================
            # SUCCESS
            # ================================================================

            self._update(
                job_id,
                status="completed",
                video_url=result.video_url,
                seed=result.seed,
            )

        except ProviderError as exc:
            logger.error(
                "[Jobs] job=%s provider=%s failed "
                "category=%s error=%s",
                job_id,
                provider_name,
                exc.category,
                str(exc),
            )

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
            logger.exception(
                "[Jobs] job=%s unexpected failure",
                job_id,
            )

            self._update(
                job_id,
                status="failed",
                error={
                    "message": str(exc),
                    "category": "unknown",
                },
            )


# ============================================================================
# GLOBAL JOB STORE
# ============================================================================

job_store = JobStore()
