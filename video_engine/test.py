"""
Manual end-to-end smoke test for the video engine.

Submits ONE real image-to-video job to the running Python video engine
(over HTTP, exactly like Node's videoEngineClient.js does) using an image
that already exists in shared/streamverse/images, then polls until the
job finishes and prints the resulting video path.

If the engine isn't already running, this script starts it itself (in the
background, via video_engine/run.sh) and stops it again when done — so you
don't need a separate terminal.

USAGE
-----
  python video_engine/test_manual.py <image_filename> [prompt]

  <image_filename> is just the filename inside shared/streamverse/images
  (e.g. "scene1.jpg") — OR a full/relative path to any image on disk.

  Example:
    python video_engine/test_manual.py scene1.jpg "slow push-in, cinematic lighting"
"""
from __future__ import annotations

import atexit
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
BASE_URL = os.environ.get("VIDEO_ENGINE_URL", "http://127.0.0.1:8000")
INTERNAL_KEY = os.environ.get("STREAMVERSE_INTERNAL_KEY", "")
IMAGES_DIR = Path(
    os.environ.get("STREAMVERSE_SHARED_MEDIA_DIR", "./shared/streamverse")
).resolve() / "images"

HEADERS = {"X-StreamVerse-Internal-Key": INTERNAL_KEY} if INTERNAL_KEY else {}

DEFAULT_PROMPT = "subtle camera drift, cinematic motion, natural movement"

_engine_proc: subprocess.Popen | None = None


def _is_up() -> bool:
    try:
        return requests.get(f"{BASE_URL}/health", timeout=3).ok
    except requests.RequestException:
        return False


def _start_engine_in_background() -> None:
    """Launch the same run.sh production uses, in the background, and wait
    for /health to come up. Killed automatically when this script exits."""
    global _engine_proc
    run_sh = REPO_ROOT / "video_engine" / "run.sh"
    print(f"[test] video engine not reachable at {BASE_URL} — starting it via {run_sh}")

    log_path = REPO_ROOT / "video_engine_test.log"
    log_file = open(log_path, "ab")
    _engine_proc = subprocess.Popen(
        ["bash", str(run_sh)],
        cwd=REPO_ROOT,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,  # own process group, so Ctrl-C here doesn't nuke it mid-wait
    )
    atexit.register(_stop_engine)
    print(f"[test] engine starting (pid={_engine_proc.pid}), logs → {log_path}")

    for _ in range(60):  # ~30s
        if _engine_proc.poll() is not None:
            raise SystemExit(
                f"[test] Video engine process exited early (code={_engine_proc.returncode}). "
                f"Check {log_path} for the traceback."
            )
        if _is_up():
            print("[test] engine is up.")
            return
        time.sleep(0.5)

    raise SystemExit(f"[test] Video engine did not become healthy in time. Check {log_path}.")


def _stop_engine() -> None:
    if _engine_proc and _engine_proc.poll() is None:
        print(f"[test] stopping video engine (pid={_engine_proc.pid})")
        _engine_proc.terminate()
        try:
            _engine_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _engine_proc.kill()


def resolve_image_path(arg: str) -> Path:
    """Accept either a bare filename (looked up inside the shared images
    dir) or a direct path to any image file."""
    direct = Path(arg)
    if direct.is_file():
        return direct.resolve()
    candidate = IMAGES_DIR / arg
    if candidate.is_file():
        return candidate.resolve()
    raise SystemExit(
        f"Could not find image '{arg}'.\n"
        f"  Checked: {direct.resolve()}\n"
        f"  Checked: {candidate}\n"
        f"Put the image in {IMAGES_DIR} or pass a full path."
    )


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(
            "Usage: python video_engine/test_manual.py <image_filename> [prompt]\n"
            f"  (looks for the image inside {IMAGES_DIR} if a bare filename is given)"
        )

    image_path = resolve_image_path(sys.argv[1])
    prompt = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_PROMPT

    print(f"[test] video engine:  {BASE_URL}")
    print(f"[test] image:         {image_path}")
    print(f"[test] prompt:        {prompt}")

    # 1) Make sure the engine is up — auto-start it in the background (same
    #    as run.sh) if nothing answers /health yet. If it's already running
    #    (started by you separately), this is a no-op and we just use it.
    if not _is_up():
        _start_engine_in_background()
    print(f"[test] health:        {requests.get(f'{BASE_URL}/health', timeout=5).json()}")

    # 2) Upload the test image to Cloudinary (the engine only accepts a
    #    hosted image_url now — see video_engine/cloudinary_client.py) and
    #    submit the job.
    from video_engine.cloudinary_client import upload_video  # noqa: F401 (imported for parity/reference)
    from video_engine import config as engine_config
    import base64
    image_bytes = image_path.read_bytes()
    b64 = base64.b64encode(image_bytes).decode("ascii")
    data_uri = f"data:image/jpeg;base64,{b64}"
    import time as _time
    import hashlib as _hashlib
    _timestamp = int(_time.time())
    _public_id = f"{engine_config.CLOUDINARY_SHOTS_ROOT}/tmp/test_input_{_timestamp}"
    _params = {"public_id": _public_id, "overwrite": "true", "timestamp": _timestamp}
    _to_sign = "&".join(f"{k}={_params[k]}" for k in sorted(_params))
    _sig = _hashlib.sha1((_to_sign + engine_config.CLOUDINARY_API_SECRET).encode()).hexdigest()
    _upload_resp = requests.post(
        f"https://api.cloudinary.com/v1_1/{engine_config.CLOUDINARY_CLOUD_NAME}/image/upload",
        data={**_params, "api_key": engine_config.CLOUDINARY_API_KEY, "signature": _sig, "file": data_uri},
        timeout=60,
    )
    _upload_resp.raise_for_status()
    image_url = _upload_resp.json()["secure_url"]
    print(f"[test] image_url:     {image_url}")

    resp = requests.post(
        f"{BASE_URL}/internal/video/jobs",
        headers=HEADERS,
        json={
            "provider": "ltx",
            "image_url": image_url,
            "prompt": prompt,
            "duration": 4,
        },
        timeout=20,
    )
    if resp.status_code == 401:
        raise SystemExit(
            "[test] 401 Unauthorized — set STREAMVERSE_INTERNAL_KEY in your env "
            "to match the video engine's configured internal key."
        )
    resp.raise_for_status()
    job = resp.json()
    job_id = job["job_id"]
    print(f"[test] job submitted: {job_id} (status={job['status']})")

    # 3) Poll until terminal.
    interval_s = 5
    max_attempts = 120  # ~10 minutes
    for attempt in range(1, max_attempts + 1):
        time.sleep(interval_s)
        poll = requests.get(f"{BASE_URL}/internal/video/jobs/{job_id}", headers=HEADERS, timeout=10)
        poll.raise_for_status()
        data = poll.json()
        status = data["status"]
        print(f"[test] poll {attempt:>3}/{max_attempts}  status={status}  progress={data.get('progress')}")

        if status == "completed":
            print("\n✅ SUCCESS")
            print(f"   video_url:  {data.get('video_url')}")
            print(f"   seed:       {data.get('seed')}")
            return

        if status == "failed":
            err = data.get("error") or {}
            print("\n❌ FAILED")
            print(f"   category: {err.get('category')}")
            print(f"   message:  {err.get('message')}")
            raise SystemExit(1)

        if status == "cancelled":
            raise SystemExit("[test] Job was cancelled.")

    raise SystemExit(f"[test] Timed out after {max_attempts * interval_s}s waiting for job {job_id}.")


if __name__ == "__main__":
    main()