# Agnes Video V2.0 provider

StreamVerse can use Agnes as a secondary audiovisual video backend while keeping LTX as the default.

## Environment

```env
VIDEO_PROVIDER=agnes
AGNES_API_KEYS=<key1>,<key2>,<key3>

AGNES_BASE_URL=https://apihub.agnes-ai.com
AGNES_MODEL=agnes-video-v2.0
AGNES_WIDTH=1024
AGNES_HEIGHT=1536
AGNES_FRAME_RATE=24

# Optional override. A strong default is used when this is omitted.
AGNES_NEGATIVE_PROMPT=garbled text, gibberish, misspelled words, distorted lettering, unreadable text, random symbols, subtitles, captions, closed captions, dialogue captions, text overlays, UI overlays, title cards, watermarks, logos, extra typography, floating text, duplicated text, malformed signs, malformed labels, screen text, extra written words, on-screen graphics, words appearing from nowhere

# Reliability
AGNES_HTTP_TIMEOUT_SECONDS=60
AGNES_SUBMIT_RETRIES=5
AGNES_MAX_POLL_ATTEMPTS=120
AGNES_POLL_INTERVAL_SECONDS=5
AGNES_RETRY_BASE_SECONDS=2
AGNES_RETRY_MAX_SECONDS=30
# Optional quota cooldown override; default is 24 hours.
AGNES_KEY_COOLDOWN_SECONDS=86400
```

`AGNES_API_KEYS` accepts comma-, semicolon-, or newline-separated values. `AGNES_API_KEY` remains a backwards-compatible single-key fallback.

## Provider contract

The Node pipeline and ScriptWriter may reason about a shot duration in seconds, but Agnes does not receive LTX-specific fields such as `duration`, `enhance_prompt`, or `randomize_seed`.

The Python Agnes provider translates the internal duration to Agnes' native `num_frames` using the documented `8n+1` constraint and submits Agnes-supported generation fields: `model`, `prompt`, single-reference `image`, `width`, `height`, `num_frames`, `frame_rate`, `negative_prompt`, and optional `seed`. Agnes officially documents `negative_prompt` as a supported video-create parameter.

The production portrait default is **1024×1536 (9:16)**. Both dimensions are multiples of 8, satisfying Agnes' documented dimension constraint.

## Negative prompt

Agnes receives a default negative prompt on every generation. It explicitly suppresses:

- garbled or gibberish text;
- misspelled/distorted/unreadable lettering;
- random symbols;
- subtitles, captions, and dialogue captions;
- text overlays and UI overlays;
- title cards, watermarks, logos, and extra typography;
- malformed signs/labels and unexplained on-screen writing.

The negative prompt is applied at the Agnes provider boundary, so it is always present even when upstream shot metadata does not contain one. `AGNES_NEGATIVE_PROMPT` can override the default for a different production policy.

The Vision Director prompt also remains responsible for explicitly saying that the model must preserve the supplied visual scene and must not invent written overlays. The negative prompt is a second protection layer, not a replacement for the final cinematic prompt.

## Vision Director path

For every Agnes shot, StreamVerse first builds the authoritative current-shot still from the exact previous shot end frame plus the canonical character references required for the current shot (when a predecessor exists). That re-anchored still is then the single authoritative Agnes I2V opening image and is sent through the Vision Director with the predecessor frame available only as continuity context. The Vision Director inspects the actual pixels, preserves authored dialogue integrity, and returns the final chronological cinematic description. **That returned Vision Director description is the prompt submitted to Agnes.** Agnes does not receive a separate raw ScriptWriter prompt in place of the Vision Director result.

Agnes is treated as a native audiovisual generator, so StreamVerse does not create a second Deepgram/TTS track for Agnes shots.

## Reliability and quota behavior

Normal transient errors stay on the current key and retry with exponential backoff, jitter, and `Retry-After` handling for `429`. The transient set is `408`, `429`, `500`, `502`, `503`, `504`, `520`, `522`, and `524`, plus network/timeouts.

A quota-specific `429` (for example a response mentioning the daily quota/usage limit/500-second allowance), or a documented `402` insufficient-quota response, is treated as **daily quota exhaustion**. The exhausted key is cooled down for 24 hours by default and the next configured key is tried.

Important: Agnes' current Token Plan documentation states that the **500 seconds/day video quota is shared across keys of the same key type**. Multiple Token Plan keys therefore do not create extra 500-second pools. Rotation is still useful when the configured keys belong to different limit pools or when a specific credential becomes quota-exhausted independently, but it is not a guaranteed way to increase account-wide quota.

A quota response during result polling rotates only the polling credential; StreamVerse does **not** resubmit the already-created video job, preventing duplicate video generation.

`400` validation failures and `401/403` authentication/permission failures fail fast. Polling `404` receives bounded retries because a newly-created resource may not be immediately visible.

## Duration and simulation

Agnes has an **18-second maximum shot canvas**, and that maximum is part of the ScriptWriter's expected-duration contract when `VIDEO_PROVIDER=agnes`. During episode scene simulation and pre-generation shot simulation, the LLM receives Agnes-specific pacing rules and shot-schema duration values so the simulated shot plan is built around an expected duration of **18 seconds**, unless the shot semantics genuinely call for less. This is applied before the actual video-generation call; it is not merely a final provider clamp.

The provider then converts the requested internal duration to a legal `8n+1` frame count for Agnes V2.0. Existing LTX-era persisted shot durations remain compatible, while newly simulated Agnes shots are no longer authored around LTX's 10-second ceiling.
