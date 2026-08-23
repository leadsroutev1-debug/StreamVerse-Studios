'use strict';

/**
 * StreamVerse Studio — Agnes Video V2.0 image-to-video integration.
 *
 * Agnes is deliberately kept behind the same submit/poll contract as LTX.
 * The Python video engine owns the provider HTTP API, key rotation, retries,
 * frame-constraint handling, and Cloudinary upload. Node only supplies the
 * authoritative still plus a cinematic prompt and requested duration.
 *
 * Agnes natively produces audiovisual clips, including generated speech/audio,
 * so this adapter never invokes the external Deepgram/TTS path.
 */

const config = require('./config');
const videoEngineClient = require('../services/videoEngineClient');

const DEFAULT_MIN_DURATION = 1;
const DEFAULT_MAX_DURATION = 18;
const DEFAULT_CANVAS_DURATION = 18;
const LEGACY_LTX_MAX_DURATION = 10;

function _positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _resolveDuration(shotMeta = {}) {
  const requested = Number(shotMeta.duration);
  const preserveExplicit = String(process.env.AGNES_DURATION_POLICY || 'full_canvas').toLowerCase() === 'preserve';

  // The legacy Node pipeline can still hand the provider an LTX-era 8–10s
  // semantic duration. Agnes has an 18s temporal canvas, so by default we
  // expand that legacy cap to the full Agnes canvas. Set
  // AGNES_DURATION_POLICY=preserve to retain the exact requested duration.
  if (!preserveExplicit && (!Number.isFinite(requested) || requested <= LEGACY_LTX_MAX_DURATION)) {
    return _positive(process.env.AGNES_DEFAULT_DURATION, DEFAULT_CANVAS_DURATION);
  }

  const duration = Number.isFinite(requested) ? requested : DEFAULT_MIN_DURATION;
  return Math.min(DEFAULT_MAX_DURATION, Math.max(DEFAULT_MIN_DURATION, duration));
}

function _buildPrompt(shotMeta = {}) {
  const explicit = String(shotMeta._agnesPromptOverride || shotMeta.agnesPrompt || '').trim();
  if (explicit) return explicit;

  const fallback = String(
    shotMeta.videoPrompt || shotMeta.prompt || shotMeta.image_prompt || ''
  ).trim();
  if (!fallback) {
    throw new Error('[AgnesVideoGen] No Agnes cinematic prompt supplied for shot');
  }
  return fallback;
}

class AgnesGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgnesGenerationError';
    Error.captureStackTrace?.(this, AgnesGenerationError);
  }
}

async function submitVideoJob(imageBuffer, shotMeta = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new AgnesGenerationError('[AgnesVideoGen] submitVideoJob received an empty image buffer.');
  }

  const prompt = _buildPrompt(shotMeta);
  const duration = _resolveDuration(shotMeta);
  const width = Math.floor(_positive(shotMeta.width, 720));
  const height = Math.floor(_positive(shotMeta.height, 1280));
  const seed = Number.isFinite(Number(shotMeta.seed)) ? Math.floor(Number(shotMeta.seed)) : null;

  try {
    const { jobId } = await videoEngineClient.submitJob({
      provider: 'agnes',
      imageBuffer,
      prompt,
      duration,
      width,
      height,
      seed,
      randomizeSeed: Boolean(config.ltxRandomizeSeed),
      enhancePrompt: false,
    });

    console.log(`[AgnesVideoGen] Submitted audiovisual shot | duration=${duration}s width=${width} height=${height}`);
    return { jobId, apiKey: 'video-engine-managed' };
  } catch (err) {
    const status = err.response?.status;
    throw new AgnesGenerationError(
      `[AgnesVideoGen] Failed to submit job to video engine${status ? ` (${status})` : ''}: ${err.message}`
    );
  }
}

async function pollVideoJob(jobId, _apiKey) {
  const intervalMs = _positive(process.env.AGNES_POLL_INTERVAL_MS, 5000);
  const maxAttempts = _positive(process.env.AGNES_MAX_POLL_ATTEMPTS, 120);

  try {
    const job = await videoEngineClient.pollJob(jobId, { intervalMs, maxAttempts });
    if (!job.video_url) {
      throw new AgnesGenerationError(`[AgnesVideoGen] Job ${jobId} completed with no video_url.`);
    }
    return job.video_url;
  } catch (err) {
    if (err instanceof AgnesGenerationError) throw err;
    const detail = err.detail ? JSON.stringify(err.detail) : '';
    throw new AgnesGenerationError(
      `[AgnesVideoGen] Job ${jobId} failed: ${err.message}${detail ? ` ${detail}` : ''}`
    );
  }
}

module.exports = {
  submitVideoJob,
  pollVideoJob,
  AgnesGenerationError,
};
