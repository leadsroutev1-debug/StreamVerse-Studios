# Agnes Video V2.0 provider

StreamVerse can use Agnes as a secondary audiovisual video backend while keeping LTX as the default.

## Environment

```env
VIDEO_PROVIDER=agnes
AGNES_API_KEY=<single-server-side-key>

AGNES_BASE_URL=https://apihub.agnes-ai.com
AGNES_MODEL=agnes-video-v2.0
AGNES_WIDTH=720
AGNES_HEIGHT=1280
AGNES_FRAME_RATE=24

# Reliability
AGNES_HTTP_TIMEOUT_SECONDS=60
AGNES_SUBMIT_RETRIES=5
AGNES_MAX_POLL_ATTEMPTS=120
AGNES_POLL_INTERVAL_SECONDS=5
AGNES_RETRY_BASE_SECONDS=2
AGNES_RETRY_MAX_SECONDS=30

# Existing legacy variable is tolerated only as a single-key fallback;
# it is NOT rotated.
# AGNES_API_KEYS=<single-key-only legacy fallback>
```

## Vision Director path

For every Agnes shot, StreamVerse uses the authoritative generated still as the exact first frame and sends that still plus the authored shot intent through the existing Vision Director. The Vision Director inspects the actual pixels, preserves authored dialogue integrity, and returns the final chronological cinematic description. **That returned Vision Director description is the prompt submitted to Agnes.** Agnes does not receive a separate raw ScriptWriter prompt in place of the Vision Director result.

Agnes is treated as a native audiovisual generator, so StreamVerse does not create a second Deepgram/TTS track for Agnes shots.

## Reliability behavior

Agnes uses one API key for all requests. There is no Agnes key rotation or key cooldown system.

The provider retries transient HTTP responses documented by Agnes: `408`, `429`, `500`, `502`, `503`, `504`, `520`, `522`, and `524`. Network failures and request timeouts are retried as well. `429` honors the `Retry-After` header when supplied; other transient failures use exponential backoff with jitter and a bounded maximum delay.

`400` validation failures and `401/403` authentication failures fail fast because retrying the identical request cannot repair a deterministic request/authentication problem. A polling `404` receives bounded retries because a newly created video resource may not be immediately visible; after the retry budget is exhausted it is surfaced as an error.

The poller uses the documented `video_id` endpoint and maintains a deliberately non-tight polling interval. A completed Agnes URL is uploaded to Cloudinary, preserving StreamVerse's existing downstream `video_url` contract.

## Duration

Agnes receives an 18-second-capable temporal canvas. The provider converts the requested duration to a legal `8n+1` frame count for Agnes V2.0. Existing LTX-era persisted shot durations remain compatible, while Agnes-selected authoring is provider-aware and no longer constrained by the LTX 10-second ceiling.
