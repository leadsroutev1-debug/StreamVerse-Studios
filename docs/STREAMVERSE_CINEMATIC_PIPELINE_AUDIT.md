# StreamVerse Studio — Cinematic Pipeline Upgrade Audit

Date: 2026-08-28

## Executive result

The original pipeline had strong authored still-frame continuity, but the provider video artifact was effectively treated as the final deliverable. The upgraded path is now:

`authored still + continuity evidence -> LTX/Agnes base video -> spatial reconstruction -> motion-compensated temporal interpolation -> restrained SDR grade + grain + metadata -> canonical Cloudinary clip`

The provider output is checkpointed before any local finishing pass. A finishing failure therefore cannot masquerade as a successfully published cinematic master.

## 1. Generation payload audit

### LTX

The current LTX-2.3 public Space contract is positional and expects:

1. input image
2. prompt
3. duration
4. enhance-prompt flag
5. seed
6. randomize-seed flag
7. height
8. width

The StreamVerse Python adapter preserves that exact order. It intentionally leaves `enhance_prompt=false` because the pipeline already constructs a detailed director prompt. The adapter does not invent undocumented camera-control fields.

The actual visual continuity mechanism is not a latent “same seed” guarantee. StreamVerse now records a deterministic per-shot seed plus the authoritative current-shot still, predecessor terminal-frame URL, and scene-anchor URL in a persisted generation contract.

### Agnes Video 2.0

The Agnes adapter already had the stronger temporal conditioning architecture: for continuity shots it submits the previous terminal frame followed by the fresh current-shot still as ordered keyframes. It also derives legal `num_frames = 8n+1` values from duration/fps and preserves requested duration/fps when resolution tier fallback is required.

The adapter exposes `seed`, `negative_prompt`, `num_frames`, `frame_rate`, and keyframe mode to the Agnes boundary. Resolution fallback changes spatial dimensions only when Agnes reports that the selected resolution tier cannot sustain the requested frame count.

## 2. Continuity failure repaired

The previous shot seed was derived only from the ordered character roster. That made all shots containing the same cast share one stochastic seed, which is not the desired continuity model and can unnecessarily couple unrelated shots.

The upgrade derives the seed from:

`episode_id + scene_number + shot_index + roster_seed`

Continuity itself is enforced through the actual image-conditioning chain: predecessor terminal frame + fresh target still + immutable character/scene anchors. The seed is deterministic/reproducible, while visual state travels through explicit conditioning artifacts.

## 3. Multi-pass finishing

`src/cinematicRefinement.js` is now a production hook with three executable passes:

### Pass 1 — Spatial

Lanczos reconstruction to `CINEMATIC_UPSCALE_FACTOR` (default 1.5x). Each stage writes a new artifact, so the provider master is never overwritten.

### Pass 2 — Temporal

FFmpeg `minterpolate` motion-compensated interpolation is applied only when the requested target cadence exceeds the source cadence. Default target is 48 fps.

This is deliberately deterministic CPU finishing, not an undocumented claim of AI interpolation. An optional RIFE/AI interpolator can be inserted later behind the same stage contract without changing the upstream orchestration.

### Pass 3 — Color / Grain / Metadata

A restrained `eq` grade is followed by seeded temporal/uniform grain. The output is explicitly tagged for SDR BT.709 (`colorspace`, `color_primaries`, `color_trc`, `color_range`) and receives StreamVerse provenance metadata.

Default grain was set to 0.006 normalized strength to avoid artificial-looking noise over detailed generated imagery.

## 4. Queue and failure hardening

The video-engine queue was previously process-memory-only. A process restart could therefore make active jobs disappear from the Python service even though the Node shot ledger still referenced them.

`video_engine/jobs.py` now persists job state in SQLite with WAL mode and reloads/requeues `queued`, `submitting`, and `running` jobs on process start using the original deterministic payload and job ID.

The executor default was reduced to two concurrent provider jobs (`VIDEO_ENGINE_MAX_WORKERS=2`) to avoid GPU/provider stampedes while retaining throughput. This remains configurable.

Important limitation: if the worker dies after remote provider submission but before the provider task has been checkpointed, a restart can re-submit the deterministic generation. This is the remaining duplicate-submit edge. The durable Node shot ledger and deterministic seed keep the final asset selection recoverable.

## 5. Polling hardening

### Video engine

Node polling now tolerates transient 404/408/429/5xx/network faults, applies adaptive backoff, and uses a bounded 45-minute elapsed window instead of a short fixed-attempt loop.

### FFmpeg service

The compiler poller now has the same transient-error treatment and a 45-minute elapsed safety window, preventing long high-resolution compositions from being killed solely by an arbitrary short polling budget.

## 6. Persisted checkpoints

The `shots` table now records:

- `provider_video_url` — immutable provider-complete base artifact
- `refinement_stage` — current finishing stage
- `generation_contract` — deterministic seed/resolution/continuity handoff
- `refinement_manifest` — actual finishing-pass results

This makes the cinematic pipeline observable and restart-aware rather than opaque.

## 7. Configuration added

### Node finishing

- `CINEMATIC_REFINEMENT_ENABLED=true`
- `CINEMATIC_UPSCALE_FACTOR=1.5`
- `CINEMATIC_TARGET_FPS=48`
- `CINEMATIC_GRAIN_AMOUNT=0.006`
- `CINEMATIC_GRAIN_SEED=4242`
- `CINEMATIC_SATURATION=1.02`
- `CINEMATIC_CONTRAST=1.015`
- `CINEMATIC_GAMMA=1.0`
- `CINEMATIC_CRF=15`
- `CINEMATIC_PRESET=medium`
- `CINEMATIC_CONCURRENCY=1`
- `CINEMATIC_TIMEOUT_MS=1200000`

### Video engine

- `VIDEO_ENGINE_MAX_WORKERS=2`
- `VIDEO_JOB_DB_PATH=/persistent/path/video_jobs.sqlite3`

### Compiler

- `FFMPEG_MAX_POLL_ELAPSED_MS=2700000`

For multi-instance deployment, put `VIDEO_JOB_DB_PATH` on persistent shared storage or replace the SQLite `JobStore` with the deployment's durable queue/database while preserving the same JobStore interface.

## 8. Validation performed

- Node syntax checks passed for the upgraded JavaScript modules.
- Python bytecode compilation passed for the upgraded video-engine modules.
- A synthetic 12 fps, 320x480 input was processed through all finishing stages successfully, producing 24 fps, 480x720 output with BT.709 metadata.
- No provider/API endpoint was fabricated for camera control; motion remains encoded through the authored prompt/motion contract at the provider boundary.

## 9. LTX keyframe gap — runtime continuity bridging (new)

**The gap:** the LTX public Space contract this project calls accepts exactly one conditioning image (positional args: image, prompt, duration, enhance_prompt, seed, randomize_seed, height, width) — no multi-frame/keyframe input. Agnes already solves this at the conditioning layer by submitting an ordered `[previous terminal frame, fresh current still]` keyframe pair (`agnesVideoGen.js`). LTX has no equivalent input, so it depends entirely on the opening still + prompt to imply motion. Before this change, the existing `auditGeneratedStillContinuity` check (`ltxVisionDirector.js`) only validated wardrobe/environment/props/identity on the *already-generated* still and, on failure, forced a re-authored still through the same single-image bottleneck — it never had the option to say "this gap needs its own shot."

**The fix — `src/continuityGapBridge.js` (new):** a runtime pre-flight that runs only on the LTX path, only for a shot with a real predecessor, and only once per shot pair (never on a resumed/cached shot):

1. `evaluateContinuityGap()` — downloads the ACTUAL previous shot's terminal frame (ground-truth pixels, not the authored plan) and sends it to the vision model (Mistral, same key-rotation pattern as the rest of `ltxVisionDirector.js`) alongside the next shot's authored target. The model judges one narrow question: can a single direct LTX clip plausibly carry this frame into that target, or is the gap unbridgeable (unexplained location jump, unexplained wardrobe change, implausible travel for the shot's duration, etc.)? Fails open (`needs_bridge:false`) on any key/network/parse failure so a vision outage never blocks generation.
2. `synthesizeBridgeShot()` — when a gap is confirmed, builds one short (2.5s), silent, connective shot object in the exact same shape the pipeline already produces for its existing reaction-shot insert (`_applyCinematicShotSelection`), tagged `_is_continuity_bridge_insert: true` with the model's stated `bridge_action` and `bridge_shot_type` (travel | turn | establishing | reaction | temporal_cut), so it needs no special-casing downstream in `generateShot()`, DB persistence, or scene compilation.
3. `maybeInsertContinuityBridgeShot()` — the combined entry point wired into `pipeline.js`'s main sequential shot loop: on a confirmed gap it splices the bridge shot into `allShots` immediately before the shot that triggered it, inserts its DB row via the existing `upsertShotRows()`, bumps `sceneShotTotalCount` for the scene so early-compile/progress accounting stays correct, and re-enters the loop so the bridge generates first — the originally-planned shot then continues from the *bridge's own* terminal frame on the next iteration, exactly like any other predecessor.

This means the pipeline can now decide, per shot pair, to insert an extra shot between two authored shots when the gap between them is too large for a single-image model to sell — rather than forcing a bad direct cut or relying on the still-continuity audit to catch it after the fact.

Configuration: `LTX_CONTINUITY_BRIDGE_ENABLED` (default `true`; set to `false` to disable), `LTX_VISION_MODEL` (shared with the existing still-continuity audit, default `mistral-large-2512`).

Limitation: this is a semantic judgment call by an LLM, not a formal guarantee — it is deliberately conservative in its prompt ("only flag a genuine unbridgeable gap") to avoid inserting a bridge shot on every ordinary cut. It also runs once per shot pair; it does not currently re-evaluate after the bridge shot itself generates (the bridge shot's own opening still still goes through the standard `auditGeneratedStillContinuity` check like any other shot).

## Files changed

- `src/cinematicRefinement.js` — new finishing engine
- `src/pipeline.js` — generation contract, per-shot seed, finishing orchestration/checkpoints, LTX continuity gap pre-flight wiring
- `src/continuityGapBridge.js` — new LTX runtime continuity gap evaluator + bridge-shot synthesis
- `src/configCore.js` — finishing and poller configuration
- `src/compiler.js` — resilient long-running FFmpeg polling
- `src/db.js` — cinematic checkpoint/manifest columns
- `src/ltxVideoGenCore.js` — generation contract propagation
- `src/agnesVideoGen.js` — generation contract propagation
- `services/videoEngineClient.js` — resilient video-job polling
- `video_engine/jobs.py` — durable job store + restart recovery
