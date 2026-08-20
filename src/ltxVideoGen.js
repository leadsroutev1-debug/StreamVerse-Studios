'use strict';

/**
 * ============================================================================
 * StreamVerse Studio — LTX-2.3 Image-to-Video Integration
 * ============================================================================
 *
 * Backend:
 *   Lightricks/LTX-2-3 Hugging Face Space, executed by the Python Video
 *   Engine (video_engine/) via gradio_client — NOT reimplemented here.
 *
 * Architecture:
 *
 *   Character References
 *          ↓
 *   Cloudflare Image Worker
 *          ↓
 *   FINAL MULTI-CHARACTER SCENE IMAGE
 *          ↓
 *   THIS MODULE (Node control plane)
 *          ↓
 *   services/videoEngineClient.js
 *          ↓
 *   Python Video Engine (internal HTTP API, separate port)
 *          ↓
 *   gradio_client → LTX-2.3 Space
 *          ↓
 *   Generated MP4
 *          ↓
 *   Existing StreamVerse pipeline
 *
 * IMPORTANT:
 *
 * This module NEVER sends individual character reference images to LTX.
 * Character references are used upstream by the Cloudflare image-generation
 * stage to construct the final multi-character scene. LTX receives ONLY the
 * final composed scene image.
 *
 * LTX-2.3 prompt contract:
 *   - image-to-video: treat the supplied image as the authoritative first frame;
 *   - describe observable changes rather than rebuilding the still frame;
 *   - use one continuous chronological paragraph;
 *   - include concrete action, environment, camera, lighting, and synchronized
 *     sound when present;
 *   - keep the prompt below 200 words;
 *   - do not send production-control labels or spatial-map instructions to LTX.
 *
 * The public interface is preserved (submitVideoJob / pollVideoJob / error
 * classes) so downstream callers do not need provider-specific changes.
 * ============================================================================
 */

const config = require('./config');
const videoEngineClient = require('../services/videoEngineClient');
const ltxPromptEngine = require('./ltxPromptEngine');

// ============================================================================
// TYPED ERRORS
// ============================================================================

class LTXQuotaExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LTXQuotaExhaustedError';
    this.zeroGpuExhausted = true;
    Error.captureStackTrace?.(this, LTXQuotaExhaustedError);
  }
}

class LTXGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LTXGenerationError';
    Error.captureStackTrace?.(this, LTXGenerationError);
  }
}

/**
 * A temporary problem talking to the Python video engine (not the same as
 * the remote LTX generation failing). The caller should keep polling.
 */
class LTXTransientPollError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LTXTransientPollError';
    Error.captureStackTrace?.(this, LTXTransientPollError);
  }
}

// ============================================================================
// CONFIG-DERIVED DEFAULTS
// ============================================================================

const DEFAULT_MIN_DURATION = 1;
const DEFAULT_MAX_DURATION = 10;
const HIGH_RES_WIDTH = 1024;
const HIGH_RES_HEIGHT = 1536;
const MAX_SEED = 2 ** 31 - 1;

function _getPositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _resolveResolution(shotMeta = {}) {
  const configuredWidth = _getPositiveNumber(config.ltxWidth, HIGH_RES_WIDTH);
  const configuredHeight = _getPositiveNumber(config.ltxHeight, HIGH_RES_HEIGHT);
  return {
    width: Math.floor(_getPositiveNumber(shotMeta.width, configuredWidth)),
    height: Math.floor(_getPositiveNumber(shotMeta.height, configuredHeight)),
  };
}

function _resolveSeed(shotMeta = {}) {
  const suppliedSeed = Number(shotMeta.seed);
  if (Number.isFinite(suppliedSeed) && suppliedSeed >= 0) {
    return Math.min(MAX_SEED, Math.floor(suppliedSeed));
  }
  return Math.floor(Math.random() * MAX_SEED);
}

function _resolveDuration(shotMeta = {}) {
  const minDuration = _getPositiveNumber(config.ltxMinDuration, DEFAULT_MIN_DURATION);
  const maxDuration = Math.max(minDuration, _getPositiveNumber(config.ltxMaxDuration, DEFAULT_MAX_DURATION));
  const requested = Number(shotMeta.duration);
  const duration = Number.isFinite(requested) ? requested : minDuration;
  return Math.min(maxDuration, Math.max(minDuration, duration));
}

// ============================================================================
// SUBMIT VIDEO JOB
// ============================================================================

/**
 * Submit an image-to-video job. Returns immediately once the Python video
 * engine has queued it — this call does NOT block for the full generation.
 *
 * @returns {{ jobId: string, apiKey: string }} apiKey is retained for
 *   interface compatibility with the previous implementation and callers
 *   that pass it straight through to pollVideoJob(); token management now
 *   lives entirely in the Python engine, so this is just an opaque marker.
 */
async function submitVideoJob(imageBuffer, shotMeta = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new LTXGenerationError('[LTXVideoGen] submitVideoJob received an empty image buffer.');
  }

  const rawPrompt = typeof shotMeta.videoPrompt === 'string' ? shotMeta.videoPrompt.trim() : '';
  if (!rawPrompt) {
    throw new LTXGenerationError('[LTXVideoGen] submitVideoJob called with no videoPrompt.');
  }

  let prompt;
  try {
    // Final source-level contract enforcement. We intentionally reject an
    // overlong prompt rather than truncating it, because truncation can remove
    // the shot's terminal state and break causal continuity into the next shot.
    prompt = ltxPromptEngine.prepareImageToVideoPrompt(rawPrompt);
  } catch (err) {
    throw new LTXGenerationError(`[LTXVideoGen] Invalid LTX image-to-video prompt: ${err.message}`);
  }

  const validation = ltxPromptEngine.validateImageToVideoPrompt(prompt);
  if (!validation.valid) {
    throw new LTXGenerationError(
      `[LTXVideoGen] LTX prompt contract violation: ${validation.violations.join(', ')}`
    );
  }

  const duration = _resolveDuration(shotMeta);
  const { width, height } = _resolveResolution(shotMeta);
  const seed = _resolveSeed(shotMeta);
  const randomizeSeed = Boolean(config.ltxRandomizeSeed);
  // Prompt enhancement is intentionally disabled for the authored deterministic
  // LTX shot contract. The source prompt already contains chronological action,
  // camera, environment, lighting and synchronized sound; a second enhancer
  // could paraphrase away exact continuity or speaker geography.
  const enhancePrompt = false;

  try {
    const { jobId } = await videoEngineClient.submitJob({
      provider: 'ltx',
      imageBuffer,
      prompt,
      duration,
      width,
      height,
      seed,
      randomizeSeed,
      enhancePrompt,
    });
    return { jobId, apiKey: 'video-engine-managed' };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      throw new LTXGenerationError(`[LTXVideoGen] Video engine rejected the internal request (401): ${err.message}`);
    }
    throw new LTXGenerationError(`[LTXVideoGen] Failed to submit job to video engine: ${err.message}`);
  }
}

// ============================================================================
// POLL VIDEO JOB
// ============================================================================

/**
 * Poll the Python video engine until the job completes. The engine already
 * uploads the finished clip to Cloudinary itself (see
 * video_engine/cloudinary_client.py) and returns its secure_url directly —
 * this function just waits for that and hands it back. No local disk is
 * ever touched by either process; the caller (pipeline.js) is the one that
 * moves this tmp Cloudinary asset to its final permanent public_id.
 *
 * apiKey is accepted for interface compatibility but unused — see
 * submitVideoJob() above.
 */
async function pollVideoJob(jobId, _apiKey) {
  const intervalMs = _getPositiveNumber(config.ltxPollIntervalMs, 15000);
  const maxAttempts = _getPositiveNumber(config.ltxMaxPollAttempts, 80);

  let job;
  try {
    job = await videoEngineClient.pollJob(jobId, { intervalMs, maxAttempts });
  } catch (err) {
    if (err.category === 'quota') {
      throw new LTXQuotaExhaustedError(err.message);
    }
    if (err.message?.includes('did not complete after')) {
      throw new LTXTransientPollError(err.message);
    }
    throw new LTXGenerationError(err.message);
  }

  if (!job.video_url) {
    throw new LTXGenerationError(`[LTXVideoGen] Job ${jobId} completed with no video_url.`);
  }

  return job.video_url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  submitVideoJob,
  pollVideoJob,
  LTXQuotaExhaustedError,
  LTXGenerationError,
  LTXTransientPollError,
};
