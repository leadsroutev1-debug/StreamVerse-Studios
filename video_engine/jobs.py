"""In-process job store + background execution.

Node submits a job and gets an immediate ack; it polls
GET /internal/video/jobs/{job_id} for status instead of blocking on one
long synchronous HTTP request.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
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


_MAX_WORKERS = max(1, int(os.environ.get("VIDEO_ENGINE_MAX_WORKERS", "2")))
_executor = ThreadPoolExecutor(
    max_workers=_MAX_WORKERS,
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
    params: dict = field(default_factory=dict, repr=False)
    recovery_count: int = field(default=0, repr=False)
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
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._db_path = os.environ.get(
            "VIDEO_JOB_DB_PATH",
            os.path.join(os.path.dirname(__file__), "video_jobs.sqlite3"),
        )
        self._init_db()
        self._load_persisted_jobs()

    def _connect(self):
        conn = sqlite3.connect(self._db_path, timeout=30)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_db(self):
        directory = os.path.dirname(os.path.abspath(self._db_path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        with self._connect() as conn:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS video_jobs (
                    job_id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    status TEXT NOT NULL,
                    video_url TEXT,
                    seed INTEGER,
                    error_json TEXT,
                    progress REAL,
                    params_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    recovery_count INTEGER NOT NULL DEFAULT 0
                )
                '''
            )
            conn.commit()

    def _persist(self, job: Job) -> None:
        with self._connect() as conn:
            conn.execute(
                '''
                INSERT INTO video_jobs (
                    job_id, provider, status, video_url, seed, error_json,
                    progress, params_json, created_at, updated_at, recovery_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    provider=excluded.provider,
                    status=excluded.status,
                    video_url=excluded.video_url,
                    seed=excluded.seed,
                    error_json=excluded.error_json,
                    progress=excluded.progress,
                    params_json=excluded.params_json,
                    updated_at=excluded.updated_at,
                    recovery_count=excluded.recovery_count
                ''',
                (
                    job.job_id,
                    job.provider,
                    job.status,
                    job.video_url,
                    job.seed,
                    json.dumps(job.error) if job.error is not None else None,
                    job.progress,
                    json.dumps(job.params),
                    job.created_at,
                    job.updated_at,
                    job.recovery_count,
                ),
            )
            conn.commit()

    def _load_persisted_jobs(self) -> None:
        with self._connect() as conn:
            rows = conn.execute(
                '''
                SELECT job_id, provider, status, video_url, seed, error_json,
                       progress, params_json, created_at, updated_at, recovery_count
                FROM video_jobs
                ORDER BY created_at ASC
                '''
            ).fetchall()

        for row in rows:
            (
                jid, provider, status, video_url, seed, error_json,
                progress, params_json, created_at, updated_at, recovery_count,
            ) = row
            try:
                params = json.loads(params_json or "{}")
            except json.JSONDecodeError:
                params = {}

            error = None
            if error_json:
                try:
                    error = json.loads(error_json)
                except json.JSONDecodeError:
                    error = {"message": error_json, "category": "unknown"}

            job = Job(
                job_id=jid,
                provider=provider,
                status=status,
                video_url=video_url,
                seed=seed,
                error=error,
                progress=progress,
                created_at=created_at,
                updated_at=updated_at,
                params=params,
                recovery_count=int(recovery_count or 0),
            )
            self._jobs[jid] = job

        # A process restart cannot resume Python's call stack, but queued and
        # previously active jobs must never disappear. Requeue them with the
        # exact original deterministic payload and same job_id. Agnes/LTX may
        # create a duplicate provider-side job only if the old process died after
        # remote submission but before checkpointing completion; deterministic seed
        # makes the retry reproducible and the Node shot ledger remains the source
        # of truth for final asset selection.
        recover = []
        with self._lock:
            for job in self._jobs.values():
                if job.status in {"queued", "submitting", "running"}:
                    job.status = "queued"
                    job.recovery_count += 1
                    job.updated_at = time.time()
                    self._persist(job)
                    recover.append((job.job_id, dict(job.params)))

        for jid, params in recover:
            _executor.submit(self._run, jid, params)
        if recover:
            logger.warning("[Jobs] Recovered %s durable video job(s) after process restart", len(recover))

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
                params=dict(params or {}),
            )

            self._jobs[jid] = job
            self._persist(job)

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
                self._persist(job)

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
            self._persist(job)

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
