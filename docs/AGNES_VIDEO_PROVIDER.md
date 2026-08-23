# Agnes Video V2.0 provider

StreamVerse can use Agnes as a secondary audiovisual video backend without changing pipeline code.

## Environment

```env
VIDEO_PROVIDER=agnes
AGNES_API_KEYS=<key1>,<key2>,<key3>

# Optional API/model overrides
AGNES_BASE_URL=https://apihub.agnes-ai.com
AGNES_MODEL=agnes-video-v2.0
AGNES_WIDTH=720
AGNES_HEIGHT=1280
AGNES_FRAME_RATE=24

# Reliability
AGNES_KEY_COOLDOWN_SECONDS=120
AGNES_HTTP_TIMEOUT_SECONDS=60
AGNES_SUBMIT_RETRIES=3
AGNES_MAX_POLL_ATTEMPTS=120
AGNES_POLL_INTERVAL_SECONDS=5
AGNES_RETRY_BASE_SECONDS=2
AGNES_RETRY_MAX_SECONDS=30

# Node-side duration policy. Full canvas is the production default.
# Set to preserve to keep an explicitly supplied <=10s duration.
AGNES_DURATION_POLICY=full_canvas
AGNES_DEFAULT_DURATION=18
```

## Runtime behavior

`VIDEO_PROVIDER=ltx` remains the default and continues using the original LTX implementation. `VIDEO_PROVIDER=magichour` remains available for rollback.

When Agnes is active, StreamVerse:

1. Keeps the current authoritative still/image-to-video handoff through Cloudinary.
2. Sends the shot to the Python video engine with provider=`agnes`.
3. Uses Agnes' async `/v1/videos` submission and `video_id` polling flow.
4. Converts the requested duration to Agnes' legal `8n+1` frame count.
5. Keeps API keys in an environment-backed rotating pool with cooldowns and retries.
6. Uploads the completed Agnes video back to Cloudinary so downstream assembly sees the same `video_url` contract as LTX.
7. Does not create a second Deepgram/TTS track; Agnes is treated as the audiovisual generator.

The ScriptWriter remains one shared implementation. A small provider-aware adapter rewrites only the existing LTX temporal rules at the outbound LLM boundary when Agnes is selected, changing the authoring canvas from 10 seconds to 18 seconds and adding Agnes-specific dialogue/performance guidance. LTX and Magic Hour prompts are left unchanged.

## Duration policy

The Node pipeline still has legacy LTX-era 8–10 second semantic values in persisted shot objects. Agnes defaults to `AGNES_DURATION_POLICY=full_canvas`, which expands those legacy values to the 18-second Agnes canvas. Set `AGNES_DURATION_POLICY=preserve` when you explicitly need the submitted shot duration to remain unchanged.

This compatibility layer is intentional: it lets existing persisted scripts generate through Agnes at the longer temporal canvas without forcing a full rewrite of historical checkpoint data.
