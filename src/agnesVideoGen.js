'use strict';

/**
 * StreamVerse Studio — Agnes Video V2.0 image-to-video integration.
 *
 * Agnes uses the SAME authoritative final still and the SAME Vision Director
 * used by the LTX path. The Vision Director inspects the actual first-frame
 * pixels and returns the final chronological cinematic prompt; that exact
 * returned description is then submitted to Agnes.
 *
 * Agnes is native audiovisual generation, so no external TTS track is created.
 */

const config = require('./config');
const videoEngineClient = require('../services/videoEngineClient');
const ltxVisionDirector = require('./ltxVisionDirector');

const DEFAULT_MIN_DURATION = 1;
const DEFAULT_MAX_DURATION = 18;

function _positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _resolveDuration(shotMeta = {}) {
  const requested = Number(shotMeta.duration);
  const duration = Number.isFinite(requested) ? requested : DEFAULT_MIN_DURATION;
  return Math.min(DEFAULT_MAX_DURATION, Math.max(DEFAULT_MIN_DURATION, duration));
}

function _extractSourceDialogue(shotMeta = {}) {
  const text = String(shotMeta.dialogue_or_action || shotMeta.videoPrompt || '').trim();
  return text;
}

async function _buildFinalAgnesPrompt(imageBuffer, shotMeta = {}) {
  const authoredIntent = String(
    shotMeta._agnesPromptOverride ||
    shotMeta.agnesPrompt ||
    shotMeta.videoPrompt ||
    ''
  ).trim();

  const shot = {
    ...(shotMeta.visionContext?.shot || {}),
    ...shotMeta,
  };

  if (authoredIntent) {
    shot.ltx_shot_description = authoredIntent;
    shot.shot_description = shot.shot_description || authoredIntent;
    shot.authored_ltx_intent = authoredIntent;
  }

  const result = await ltxVisionDirector.describeForLTX({
    imageBuffer,
    imageMime: shotMeta.visionContext?.imageMime || 'image/png',
    shot,
    scene: shotMeta.visionContext?.scene || {},
    characters: shotMeta.visionContext?.characters || [],
    repairInstruction: '',
  });

  const finalPrompt = String(result || '').trim();
  if (!finalPrompt) {
    throw new Error('[AgnesVideoGen] Vision Director returned an empty final Agnes prompt');
  }

  console.log('[AgnesVideoGen] FINAL VISION-DIRECTOR PROMPT:');
  console.log(finalPrompt);
  return finalPrompt;
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

  const prompt = await _buildFinalAgnesPrompt(imageBuffer, shotMeta);
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
      randomizeSeed: false,
      enhancePrompt: false,
    });

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
