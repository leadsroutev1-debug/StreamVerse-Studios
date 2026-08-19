"""
StreamVerse Studio — Python Video Engine.
Internal service, called only by the Node.js main backend. Owns video
GENERATION EXECUTION ONLY — no project/episode/user state lives here.
"""
from __future__ import annotations

import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("video_engine")

try:
    from fastapi import FastAPI, Header, HTTPException
    from pydantic import BaseModel, Field
    from . import config
    from .jobs import job_store
    from .token_manager import token_manager
except Exception:
    # If startup imports fail, log the full traceback before the process
    # dies, so the real cause shows up in logs instead of a bare uvicorn
    # click/runpy stack with no exception message.
    logger.exception("Fatal error during module import — video engine cannot start")
    raise

app = FastAPI(title="StreamVerse Video Engine", version="1.0.0")


def _check_internal_key(x_streamverse_internal_key: str | None) -> None:
    if config.INTERNAL_API_KEY and x_streamverse_internal_key != config.INTERNAL_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing internal API key")


class VideoJobRequest(BaseModel):
    job_id: str | None = None
    provider: str = "ltx"
    image_url: str
    prompt: str
    duration: float = 5.0
    width: int = Field(default_factory=lambda: config.LTX_WIDTH)
    height: int = Field(default_factory=lambda: config.LTX_HEIGHT)
    seed: int | None = None
    randomize_seed: bool = Field(default_factory=lambda: config.LTX_RANDOMIZE_SEED)
    enhance_prompt: bool = Field(default_factory=lambda: config.LTX_ENHANCE_PROMPT)


@app.get("/")
def root():
    # Platform healthchecks appear to probe "/" directly (see deploy logs:
    # "healthcheck / returned status 500"), not "/health" — keep this in
    # sync with /health so infra checks don't false-fail once the app is up.
    return {"status": "ok", "service": "streamverse-video-engine"}


@app.get("/health")
def health():
    return {"status": "ok", "service": "streamverse-video-engine"}


@app.get("/health/ltx")
def health_ltx(x_streamverse_internal_key: str | None = Header(default=None)):
    """Verifies the LTX client CAN be initialized/reached, without
    consuming a GPU generation."""
    _check_internal_key(x_streamverse_internal_key)
    if not config.HF_TOKENS:
        return {"status": "error", "detail": "No HF_TOKENS configured"}
    try:
        from gradio_client import Client
        from .providers.ltx import _TOKEN_KWARG
        Client(config.HF_SPACE, **{_TOKEN_KWARG: config.HF_TOKENS[0]})
        return {"status": "ok", "space": config.HF_SPACE}
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "detail": str(exc)}


@app.get("/internal/hf-tokens")
def hf_token_status(x_streamverse_internal_key: str | None = Header(default=None)):
    """Sticky/linear HF token pool status for the dashboard — which slot is
    currently in use, which are exhausted/rate-limited/invalid (and for how
    much longer), so the UI can highlight exhausted tokens in red."""
    _check_internal_key(x_streamverse_internal_key)
    return {"tokens": token_manager.snapshot()}


@app.post("/internal/video/jobs")
def create_job(body: VideoJobRequest, x_streamverse_internal_key: str | None = Header(default=None)):
    _check_internal_key(x_streamverse_internal_key)
    job = job_store.create(
        body.job_id,
        body.provider,
        {
            "provider": body.provider,
            "image_url": body.image_url,
            "prompt": body.prompt,
            "duration": body.duration,
            "width": body.width,
            "height": body.height,
            "seed": body.seed,
            "randomize_seed": body.randomize_seed,
            "enhance_prompt": body.enhance_prompt,
        },
    )
    return {"job_id": job.job_id, "status": job.status}


@app.get("/internal/video/jobs/{job_id}")
def get_job(job_id: str, x_streamverse_internal_key: str | None = Header(default=None)):
    _check_internal_key(x_streamverse_internal_key)
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.public_dict()


@app.post("/internal/video/jobs/{job_id}/cancel")
def cancel_job(job_id: str, x_streamverse_internal_key: str | None = Header(default=None)):
    _check_internal_key(x_streamverse_internal_key)
    job = job_store.cancel(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.public_dict()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.VIDEO_ENGINE_HOST, port=config.VIDEO_ENGINE_PORT)