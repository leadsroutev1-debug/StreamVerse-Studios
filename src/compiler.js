'use strict';
const axios = require('axios');
const config = require('./config');

function _ffmpegHeaders() {
  return {
    'x-api-key':    config.ffmpegApiKey,
    'Content-Type': 'application/json',
  };
}

/**
 * Wait until the FFmpeg service is actually reachable and its HTTP server is
 * responding to /health. This is readiness-based rather than sleep-based:
 * waking a Replit service can take an unpredictable amount of time, so a
 * fixed "wake and wait N seconds" is never used as proof of availability.
 */
async function waitForFFmpeg({
  timeoutMs = config.ffmpegReadyTimeoutMs,
  initialDelayMs = config.ffmpegReadyInitialDelayMs,
  maxDelayMs = config.ffmpegReadyMaxDelayMs,
} = {}) {
  const startedAt = Date.now();
  let delayMs = Math.max(0, Number(initialDelayMs) || 0);
  let attempt = 0;
  let lastError = null;

  while (true) {
    attempt += 1;

    try {
      const resp = await axios.get(config.ffmpegServiceUrl + '/health', {
        headers: _ffmpegHeaders(),
        timeout: Math.min(10000, Math.max(3000, Number(config.ffmpegHealthRequestTimeoutMs) || 5000)),
        validateStatus: () => true,
      });

      if (resp.status >= 200 && resp.status < 300 && resp.data?.ok === true) {
        const elapsedMs = Date.now() - startedAt;
        console.log(`[Compiler] FFmpeg ready after ${elapsedMs}ms (health attempt ${attempt}).`);
        return resp.data;
      }

      lastError = new Error(`FFmpeg health returned HTTP ${resp.status}`);
    } catch (err) {
      lastError = err;
    }

    const elapsedMs = Date.now() - startedAt;
    if (timeoutMs > 0 && elapsedMs >= timeoutMs) {
      throw new Error(
        `[Compiler] FFmpeg service did not become ready within ${timeoutMs}ms. ` +
        `Last health error: ${lastError?.message || 'unknown error'}`
      );
    }

    console.log(
      `[Compiler] FFmpeg not ready yet (attempt ${attempt}, elapsed ${elapsedMs}ms). ` +
      `Retrying health check in ${delayMs}ms...`
    );

    if (delayMs > 0) await sleep(delayMs);
    delayMs = Math.min(
      Math.max(0, Number(maxDelayMs) || 5000),
      Math.max(250, delayMs > 0 ? delayMs * 1.5 : 250)
    );
  }
}

/**
 * Compatibility wrapper retained for callers that explicitly wake the service.
 * It now waits for an actual successful health response instead of treating a
 * single request or a fixed delay as proof that FFmpeg is ready.
 */
async function wakeFFmpeg() {
  try {
    await waitForFFmpeg();
    console.log('[Compiler] FFmpeg service is ready.');
    return true;
  } catch (err) {
    console.warn('[Compiler] FFmpeg readiness check failed:', err.message);
    return false;
  }
}

// Only "cut" is used now — all visual effects come from Magic Hour's video
// generation. The FFmpeg service is used solely for basic concatenation and
// simple fade transitions during merge.
const VALID_LAYOUTS = new Set(['cut']);
const LAYOUT_FALLBACK_MAP = {
  dissolve: 'cut',
  fade:     'cut',
  crossfade:'cut',
  wipe:     'cut',
  overlay:  'cut',
  split:    'cut',
  zoom:     'cut',
  grid4:    'cut',
  triptych: 'cut',
  pip:      'cut',
};

function resolveLayout(raw) {
  if (!raw) return 'cut';
  const lower = String(raw).toLowerCase();
  if (VALID_LAYOUTS.has(lower)) return lower;
  const mapped = LAYOUT_FALLBACK_MAP[lower];
  if (mapped) {
    console.log(`[Compiler] Layout "${raw}" mapped to "${mapped}" (effects handled by Magic Hour)`);
    return 'cut';
  }
  console.warn(`[Compiler] Unknown layout "${raw}" — defaulting to "cut"`);
  return 'cut';
}

// Only safe transitions that the FFmpeg service can apply during a basic
// concat merge. These are simple cross-fades that don't require complex
// filter chains.
const SAFE_TRANSITIONS = new Set([
  'fade', 'fadeblack', 'fadewhite', 'dissolve',
]);

function resolveTransition(raw) {
  if (!raw) return null;
  const lower = String(raw).toLowerCase();
  if (SAFE_TRANSITIONS.has(lower)) return lower;
  // Map complex transitions to simple fade
  console.log(`[Compiler] Transition "${raw}" simplified to "fade" (complex transitions disabled to prevent corruption)`);
  return 'fade';
}

/**
 * Submit a scene composition job to the FFmpeg microservice.
 *
 * Only plain clip URLs are sent — no per-clip motion/colorGrade/overlays.
 * Shot-to-shot semantic handoffs are authored in the director shot fields
 * (end_frame_transition / next_shot_continuity) and are realized by the generated
 * end/start visual states; FFmpeg remains a simple concatenation layer.
 * All visual effects are handled by Magic Hour's video generation.
 * The FFmpeg service only does basic concatenation ("cut" layout).
 *
 * Returns jobId.
 */
async function composeScene(clips, composition = 'cut', sceneEffects = {}) {
  const layout = resolveLayout(composition);

  const clipPayload = (clips || [])
    .map(c => {
      if (typeof c === 'string') return c;
      if (!c?.url) return null;
      return c.url;
    })
    .filter(Boolean);

  if (!clipPayload.length) {
    throw new Error('[Compiler] composeScene called with no valid clips');
  }

  // Replit may suspend the FFmpeg service between scene jobs. Never submit
  // until the actual health endpoint proves the service is ready.
  await waitForFFmpeg();

  const body = { clips: clipPayload, layout };

  if (layout === 'cut' && sceneEffects.transition) {
    const safeTransition = resolveTransition(sceneEffects.transition);
    if (safeTransition) {
      body.transition = safeTransition;
      if (sceneEffects.transitionDuration != null) {
        body.transitionDuration = sceneEffects.transitionDuration;
      }
    }
  }

  const resp = await axios.post(
    config.ffmpegServiceUrl + '/compose',
    body,
    { headers: _ffmpegHeaders(), timeout: 30000 }
  );
  if (!resp.data?.jobId) {
    throw new Error(`[Compiler] /compose bad response: ${JSON.stringify(resp.data)}`);
  }
  return resp.data.jobId;
}

/**
 * Submit a final episode/master merge job to the FFmpeg microservice.
 * clips: ordered source video URLs (plain strings).
 *
 * The final master should receive the original shot assets whenever possible,
 * not already-encoded scene outputs. That avoids cascading re-encodes.
 * introBumperUrl / outroBumperUrl: optional StreamVerse Studio bumpers.
 * mergeEffects: optional { transition, transitionDuration }
 *   — only safe transitions (fade/dissolve) are forwarded. No color grades,
 *     overlays, or text overlays are sent to the FFmpeg service.
 * Returns jobId.
 */
async function mergeScenes(clips, { introBumperUrl, outroBumperUrl, ...mergeEffects } = {}) {
  const mergeClips = [
    ...(introBumperUrl ? [introBumperUrl] : []),
    ...(clips || []),
    ...(outroBumperUrl ? [outroBumperUrl] : []),
  ].filter(Boolean);

  // Same readiness gate for the final master. The Replit service may have
  // spun down while shot/scene generation was running.
  await waitForFFmpeg();

  const body = { clips: mergeClips };

  if (mergeEffects.transition) {
    const safeTransition = resolveTransition(mergeEffects.transition);
    if (safeTransition) {
      body.transition = safeTransition;
      if (mergeEffects.transitionDuration != null) {
        body.transitionDuration = mergeEffects.transitionDuration;
      }
    }
  }

  const resp = await axios.post(
    config.ffmpegServiceUrl + '/merge',
    body,
    { headers: _ffmpegHeaders(), timeout: 30000 }
  );
  if (!resp.data?.jobId) {
    throw new Error(`[Compiler] /merge bad response: ${JSON.stringify(resp.data)}`);
  }
  return resp.data.jobId;
}

/**
 * Poll an FFmpeg job until it returns a download URL.
 * Uses /status/:id — the single-job status endpoint on the FFmpeg service.
 * Returns the final video URL on success.
 */
async function pollFFmpegJob(jobId) {
  const maxAttempts = config.ffmpegMaxPollAttempts;
  const intervalMs  = config.ffmpegPollIntervalMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(intervalMs);
    const resp = await axios.get(
      `${config.ffmpegServiceUrl}/status/${jobId}`,
      { headers: _ffmpegHeaders(), timeout: 20000 }
    );
    const job = resp.data;
    if (job.status === 'complete' || job.status === 'done') {
      const url = job.url || job.output_url || job.download_url;
      if (!url) throw new Error(`[Compiler] FFmpeg job complete but no URL: ${JSON.stringify(job)}`);
      return url;
    }
    if (['error', 'failed'].includes(job.status)) {
      throw new Error(`[Compiler] FFmpeg job ${jobId} failed: ${job.error || JSON.stringify(job)}`);
    }
    console.log(`[Compiler] FFmpeg job ${jobId} status=${job.status} (${attempt}/${maxAttempts})`);
  }
  throw new Error(`[Compiler] FFmpeg job ${jobId} timed out after ${maxAttempts} polling attempts`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function composeSceneSmartAndWait(clips, composition = 'cut', sceneEffects = {}) {
  const plainClips = (clips || [])
    .map(c => (typeof c === 'string' ? c : c?.url))
    .filter(Boolean);

  if (plainClips.length === 1) {
    console.log('[Compiler] Scene has a single shot — skipping FFmpeg compilation, using the clip directly.');
    return plainClips[0];
  }

  const jobId = await composeScene(clips, composition, sceneEffects);
  return pollFFmpegJob(jobId);
}

module.exports = {
  wakeFFmpeg,
  waitForFFmpeg,
  composeScene,
  mergeScenes,
  pollFFmpegJob,
  composeSceneSmartAndWait,
};
