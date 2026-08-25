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
 *
 * Dialogue integrity is validated twice:
 *   1. Inside ltxVisionDirector while authoring the cinematic description.
 *   2. Here, after prompt preparation and immediately before video submission.
 *
 * A dialogue mismatch is a semantic/model-output failure, NOT a provider/API
 * failure. The vision director owns targeted repair; this layer must not turn
 * every semantic mismatch into an API-key rotation.
 *
 * Diagnostics:
 *   - Logs the vision-director response/result.
 *   - Logs the extracted shot description.
 *   - Logs the final prompt after prompt-engine preparation.
 * ============================================================================
 */

const config = require('./config');
const videoEngineClient = require('../services/videoEngineClient');
const ltxPromptEngine = require('./ltxPromptEngine');
const ltxVisionDirector = require('./ltxVisionDirector');

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
const MAX_VISION_REPAIR_ATTEMPTS = 3;

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
  const maxDuration = Math.max(
    minDuration,
    _getPositiveNumber(config.ltxMaxDuration, DEFAULT_MAX_DURATION)
  );
  const requested = Number(shotMeta.duration);
  const duration = Number.isFinite(requested) ? requested : minDuration;
  return Math.min(maxDuration, Math.max(minDuration, duration));
}

function _quotedDialogue(text) {
  return [...String(text || '').matchAll(/"([^"]+)"|“([^”]+)”/g)]
    .map(match => (match[1] || match[2] || '').trim())
    .filter(Boolean);
}

function _normalizeDialogue(text) {
  return String(text || '')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function _validateAuthoredDialogue(sourceLines, prompt) {
  const normalizedSource = sourceLines.map(_normalizeDialogue);
  if (!normalizedSource.length) {
    return {
      valid: true,
      missingLines: [],
      outputLines: _quotedDialogue(prompt),
    };
  }

  const outputLines = _quotedDialogue(prompt);
  const normalizedOutput = outputLines.map(_normalizeDialogue);
  const missingLines = normalizedSource.filter(
    line => !normalizedOutput.includes(line)
  );

  let cursor = 0;
  const outOfOrder = [];

  for (const required of normalizedSource) {
    const index = normalizedOutput.indexOf(required, cursor);
    if (index === -1) continue;
    if (index !== cursor) outOfOrder.push(required);
    cursor = index + 1;
  }

  return {
    valid: missingLines.length === 0 && outOfOrder.length === 0,
    missingLines,
    outOfOrder,
    outputLines,
  };
}

function _safeDiagnosticValue(value) {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function _extractVisionResult(result) {
  // Backward compatible with the current director, which returns a string.
  // Also supports a richer future director result:
  // {
  //   description / ltx_shot_description: "...",
  //   response / rawResponse / visionResponse: ...
  // }
  if (typeof result === 'string') {
    return {
      description: result,
      visionResponse: result,
    };
  }

  const description = String(
    result?.description ||
    result?.ltx_shot_description ||
    result?.shotDescription ||
    ''
  ).trim();

  const visionResponse =
    result?.visionResponse ??
    result?.rawResponse ??
    result?.response ??
    result;

  return {
    description,
    visionResponse,
  };
}

async function _resolvePrompt(imageBuffer, shotMeta) {
  const override = typeof shotMeta._ltxPromptOverride === 'string'
    ? shotMeta._ltxPromptOverride.trim()
    : '';

  if (override) {
    console.log(
      '[LTXVideoGen] Using explicit human-edited LTX prompt override; ' +
      'vision director bypassed for this regeneration.'
    );
    console.log('[LTXVideoGen] SHOT DESCRIPTION (override):');
    console.log(override);
    return ltxPromptEngine.prepareImageToVideoPrompt(override);
  }

  const visionContext = shotMeta.visionContext || {};
  const authoredIntent =
    typeof shotMeta.videoPrompt === 'string'
      ? shotMeta.videoPrompt.trim()
      : '';

  const visionShot = { ...(visionContext.shot || {}) };
  const sourceLines = _quotedDialogue(authoredIntent);

  if (authoredIntent) {
    visionShot.shot_description = authoredIntent;
    visionShot.authored_ltx_intent = authoredIntent;

    if (sourceLines.length) {
      visionShot.dialogue = sourceLines
        .map(line => `"${line}"`)
        .join(' ');
      visionShot.conversation_reason =
        visionShot.conversation_reason ||
        'Authored shot contains explicit spoken dialogue; preserve it verbatim.';
    }
  }

  let repairInstruction = '';

  for (
    let visionAttempt = 1;
    visionAttempt <= MAX_VISION_REPAIR_ATTEMPTS;
    visionAttempt++
  ) {
    try {
      console.log(
        `[LTXVideoGen] Vision director request ` +
        `attempt=${visionAttempt}/${MAX_VISION_REPAIR_ATTEMPTS}`
      );

      const visionResult = await ltxVisionDirector.describeForLTX({
        imageBuffer,
        imageMime: visionContext.imageMime || 'image/png',
        shot: visionShot,
        scene: visionContext.scene || {},
        characters: visionContext.characters || [],
        repairInstruction,
      });

      const {
        description,
        visionResponse,
      } = _extractVisionResult(visionResult);

      // Requested diagnostic: the vision-director response/result.
      console.log(
        `[LTXVideoGen] VISION RESPONSE ` +
        `attempt=${visionAttempt}:`
      );
      console.log(_safeDiagnosticValue(visionResponse));

      if (!description) {
        throw new LTXGenerationError(
          '[LTXVideoGen] Vision director returned no usable ltx_shot_description.'
        );
      }

      // Requested diagnostic: the actual cinematic shot description extracted
      // from the vision result, before prompt cleanup.
      console.log(
        `[LTXVideoGen] SHOT DESCRIPTION ` +
        `attempt=${visionAttempt}:`
      );
      console.log(description);

      const finalPrompt = ltxPromptEngine.prepareImageToVideoPrompt(description);

      // Diagnostic after prompt preparation, before final validation/submission.
      console.log(
        `[LTXVideoGen] FINAL LTX PROMPT ` +
        `attempt=${visionAttempt}:`
      );
      console.log(finalPrompt);

      const validation = _validateAuthoredDialogue(sourceLines, finalPrompt);

      console.log(
        `[LTXVideoGen] Vision-authored LTX prompt generated ` +
        `(attempt=${visionAttempt} ` +
        `words=${finalPrompt.split(/\s+/).filter(Boolean).length} ` +
        `quotedDialogue=${validation.outputLines.length}/${sourceLines.length} ` +
        `preserved=${sourceLines.length - validation.missingLines.length}/${sourceLines.length}).`
      );

      if (validation.valid) return finalPrompt;

      const missingText = validation.missingLines
        .map(line => `"${line}"`)
        .join('; ');

      const orderText = validation.outOfOrder?.length
        ? ` Dialogue order drift detected for: ${validation.outOfOrder.map(line => `"${line}"`).join('; ')}.`
        : '';

      throw new LTXGenerationError(
        `[LTXVideoGen] Vision director returned a prompt that failed ` +
        `final authored-dialogue integrity. ` +
        `Missing exact line(s): ${missingText || 'none'}.${orderText}`
      );
    } catch (err) {
      if (err instanceof LTXGenerationError) throw err;

      if (visionAttempt >= MAX_VISION_REPAIR_ATTEMPTS) throw err;

      repairInstruction = [
        'The previous vision request failed before producing an acceptable result.',
        'Re-inspect the supplied final still and regenerate the complete cinematic LTX description.',
        'Preserve all authored dialogue and character staging.',
        `Failure detail: ${err.message}`,
      ].join(' ');

      console.warn(
        `[LTXVideoGen] Vision provider/transient attempt ` +
        `${visionAttempt}/${MAX_VISION_REPAIR_ATTEMPTS} failed; ` +
        `requesting another vision-authoring attempt: ${err.message}`
      );
    }
  }

  throw new LTXGenerationError(
    '[LTXVideoGen] Vision prompt resolution exhausted unexpectedly.'
  );
}

async function submitVideoJob(imageBuffer, shotMeta = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new LTXGenerationError(
      '[LTXVideoGen] submitVideoJob received an empty image buffer.'
    );
  }

  let prompt;

  try {
    prompt = await _resolvePrompt(imageBuffer, shotMeta);
  } catch (err) {
    throw err instanceof LTXGenerationError
      ? err
      : new LTXGenerationError(
          `[LTXVideoGen] Failed to author LTX image-to-video prompt: ${err.message}`
        );
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
      throw new LTXGenerationError(
        `[LTXVideoGen] Video engine rejected the internal request (401): ${err.message}`
      );
    }

    throw new LTXGenerationError(
      `[LTXVideoGen] Failed to submit job to video engine: ${err.message}`
    );
  }
}

async function pollVideoJob(jobId, _apiKey) {
  const intervalMs = _getPositiveNumber(config.ltxPollIntervalMs, 15000);
  const maxAttempts = _getPositiveNumber(config.ltxMaxPollAttempts, 80);
  let job;

  try {
    job = await videoEngineClient.pollJob(jobId, {
      intervalMs,
      maxAttempts,
    });
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
    throw new LTXGenerationError(
      `[LTXVideoGen] Job ${jobId} completed with no video_url.`
    );
  }

  return job.video_url;
}

module.exports = {
  submitVideoJob,
  pollVideoJob,
  LTXQuotaExhaustedError,
  LTXGenerationError,
  LTXTransientPollError,
};
