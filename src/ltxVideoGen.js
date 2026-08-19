'use strict';

/**
 * StreamVerse Studio — LTX-2.3 Image-to-Video control-plane integration.
 *
 * The final scene image is generated upstream, then LTX-2.3 receives that
 * image as the first-frame condition plus a motion/performance prompt.
 * Character references are never sent directly to LTX; identity is already
 * resolved in the scene image stage.
 */

const config = require('./config');
const videoEngineClient = require('../services/videoEngineClient');

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

class LTXTransientPollError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LTXTransientPollError';
    Error.captureStackTrace?.(this, LTXTransientPollError);
  }
}

const DEFAULT_MIN_DURATION = 1;
const DEFAULT_MAX_DURATION = 10;
const HIGH_RES_WIDTH = 1024;
const HIGH_RES_HEIGHT = 1536;
const MAX_SEED = 2 ** 31 - 1;

function _getPositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _snapDimension(value, fallback) {
  const n = Math.floor(_getPositiveNumber(value, fallback));
  // LTX requires width/height to be divisible by 32. Never silently send an
  // invalid geometry to the Space.
  const snapped = Math.floor(n / 32) * 32;
  return Math.max(32, snapped || fallback);
}

function _resolveResolution(shotMeta = {}) {
  const configuredWidth = _snapDimension(config.ltxWidth, HIGH_RES_WIDTH);
  const configuredHeight = _snapDimension(config.ltxHeight, HIGH_RES_HEIGHT);
  return {
    width: _snapDimension(shotMeta.width, configuredWidth),
    height: _snapDimension(shotMeta.height, configuredHeight),
  };
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

/**
 * LTX-2.3's official guidance favors one flowing, present-tense prompt with
 * explicit motion, camera, performance and audio beats. I2V already receives
 * the visual starting state, so this function removes accidental formatting
 * noise without rewriting the director's words or dialogue.
 */
function _normalizeI2VPrompt(rawPrompt) {
  return String(rawPrompt || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function submitVideoJob(imageBuffer, shotMeta = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new LTXGenerationError('[LTXVideoGen] submitVideoJob received an empty image buffer.');
  }

  const prompt = _normalizeI2VPrompt(shotMeta.videoPrompt);
  if (!prompt) throw new LTXGenerationError('[LTXVideoGen] submitVideoJob called with no videoPrompt.');

  const duration = _resolveDuration(shotMeta);
  const { width, height } = _resolveResolution(shotMeta);
  const seed = _resolveSeed(shotMeta);
  const randomizeSeed = Boolean(config.ltxRandomizeSeed);
  const enhancePrompt = Boolean(config.ltxEnhancePrompt) && !Boolean(shotMeta.lockPrompt);

  console.log(`[LTXVideoGen] I2V submit duration=${duration}s resolution=${width}x${height} seed=${seed} randomize=${randomizeSeed} enhance=${enhancePrompt}`);

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

module.exports = {
  submitVideoJob,
  pollVideoJob,
  LTXQuotaExhaustedError,
  LTXGenerationError,
  LTXTransientPollError,
};
