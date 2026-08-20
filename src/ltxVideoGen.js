'use strict';

/**
 * ============================================================================
 * StreamVerse Studio — LTX-2.3 Image-to-Video Integration
 * ============================================================================
 *
 * The final composed still is the authoritative first frame.
 * Normal LTX generation uses:
 *
 *   final still + authored shot intent
 *        ↓
 *   vision director describes what is actually visible and how it should change
 *        ↓
 *   LTX-2.3 image-to-video prompt
 *
 * The prompt engine performs cleanup only. It does not truncate or summarize.
 * ============================================================================
 */

const config = require('./config');
const videoEngineClient = require('../services/videoEngineClient');
const ltxPromptEngine = require('./ltxPromptEngine');
const ltxVisionDirector = require('./ltxVisionDirector');

class LTXQuotaExhaustedError extends Error {
  constructor(message) { super(message); this.name = 'LTXQuotaExhaustedError'; this.zeroGpuExhausted = true; Error.captureStackTrace?.(this, LTXQuotaExhaustedError); }
}
class LTXGenerationError extends Error {
  constructor(message) { super(message); this.name = 'LTXGenerationError'; Error.captureStackTrace?.(this, LTXGenerationError); }
}
class LTXTransientPollError extends Error {
  constructor(message) { super(message); this.name = 'LTXTransientPollError'; Error.captureStackTrace?.(this, LTXTransientPollError); }
}

const DEFAULT_MIN_DURATION = 1;
const DEFAULT_MAX_DURATION = 10;
const HIGH_RES_WIDTH = 1024;
const HIGH_RES_HEIGHT = 1536;
const MAX_SEED = 2 ** 31 - 1;

function _getPositiveNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function _resolveResolution(shotMeta = {}) {
  const configuredWidth = _getPositiveNumber(config.ltxWidth, HIGH_RES_WIDTH);
  const configuredHeight = _getPositiveNumber(config.ltxHeight, HIGH_RES_HEIGHT);
  return { width: Math.floor(_getPositiveNumber(shotMeta.width, configuredWidth)), height: Math.floor(_getPositiveNumber(shotMeta.height, configuredHeight)) };
}
function _resolveSeed(shotMeta = {}) {
  const suppliedSeed = Number(shotMeta.seed);
  if (Number.isFinite(suppliedSeed) && suppliedSeed >= 0) return Math.min(MAX_SEED, Math.floor(suppliedSeed));
  return Math.floor(Math.random() * MAX_SEED);
}
function _resolveDuration(shotMeta = {}) {
  const minDuration = _getPositiveNumber(config.ltxMinDuration, DEFAULT_MIN_DURATION);
  const maxDuration = Math.max(minDuration, _getPositiveNumber(config.ltxMaxDuration, DEFAULT_MAX_DURATION));
  const requested = Number(shotMeta.duration);
  const duration = Number.isFinite(requested) ? requested : minDuration;
  return Math.min(maxDuration, Math.max(minDuration, duration));
}

async function _resolvePrompt(imageBuffer, shotMeta) {
  const override = typeof shotMeta._ltxPromptOverride === 'string' ? shotMeta._ltxPromptOverride.trim() : '';
  if (override) {
    console.log('[LTXVideoGen] Using explicit human-edited LTX prompt override; vision director bypassed for this regeneration.');
    return ltxPromptEngine.prepareImageToVideoPrompt(override);
  }

  const visionContext = shotMeta.visionContext || {};
  // The existing pipeline already supplies videoPrompt as the authored shot
  // description. Feed it into the vision director as intent while the actual
  // final still remains the visual ground truth.
  const authoredIntent = typeof shotMeta.videoPrompt === 'string' ? shotMeta.videoPrompt : '';
  const visionShot = { ...(visionContext.shot || {}) };
  if (authoredIntent && !visionShot.shot_description) visionShot.shot_description = authoredIntent;

  const description = await ltxVisionDirector.describeForLTX({
    imageBuffer,
    imageMime: visionContext.imageMime || 'image/png',
    shot: visionShot,
    scene: visionContext.scene || {},
    characters: visionContext.characters || [],
  });

  console.log(`[LTXVideoGen] Vision-authored LTX prompt generated (${description.split(/\s+/).filter(Boolean).length} words).`);
  return ltxPromptEngine.prepareImageToVideoPrompt(description);
}

async function submitVideoJob(imageBuffer, shotMeta = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) throw new LTXGenerationError('[LTXVideoGen] submitVideoJob received an empty image buffer.');

  let prompt;
  try { prompt = await _resolvePrompt(imageBuffer, shotMeta); }
  catch (err) { throw new LTXGenerationError(`[LTXVideoGen] Failed to author LTX image-to-video prompt: ${err.message}`); }

  const validation = ltxPromptEngine.validateImageToVideoPrompt(prompt);
  if (!validation.valid) throw new LTXGenerationError(`[LTXVideoGen] LTX prompt contract violation: ${validation.violations.join(', ')}`);

  const duration = _resolveDuration(shotMeta);
  const { width, height } = _resolveResolution(shotMeta);
  const seed = _resolveSeed(shotMeta);
  const randomizeSeed = Boolean(config.ltxRandomizeSeed);
  const enhancePrompt = false;

  try {
    const { jobId } = await videoEngineClient.submitJob({ provider: 'ltx', imageBuffer, prompt, duration, width, height, seed, randomizeSeed, enhancePrompt });
    return { jobId, apiKey: 'video-engine-managed' };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) throw new LTXGenerationError(`[LTXVideoGen] Video engine rejected the internal request (401): ${err.message}`);
    throw new LTXGenerationError(`[LTXVideoGen] Failed to submit job to video engine: ${err.message}`);
  }
}

async function pollVideoJob(jobId, _apiKey) {
  const intervalMs = _getPositiveNumber(config.ltxPollIntervalMs, 15000);
  const maxAttempts = _getPositiveNumber(config.ltxMaxPollAttempts, 80);
  let job;
  try {
    job = await videoEngineClient.pollJob(jobId, { intervalMs, maxAttempts });
  } catch (err) {
    if (err.category === 'quota') throw new LTXQuotaExhaustedError(err.message);
    if (err.message?.includes('did not complete after')) throw new LTXTransientPollError(err.message);
    throw new LTXGenerationError(err.message);
  }
  if (!job.video_url) throw new LTXGenerationError(`[LTXVideoGen] Job ${jobId} completed with no video_url.`);
  return job.video_url;
}

module.exports = { submitVideoJob, pollVideoJob, LTXQuotaExhaustedError, LTXGenerationError, LTXTransientPollError };
