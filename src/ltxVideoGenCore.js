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
// This core is retained for the LTX backend, whose native maximum remains 10s.
// Agnes has its own provider adapter (`src/agnesVideoGen.js`) with an 18s ceiling.
// Keep this fallback provider-aware so a missing config value cannot silently
// reintroduce an LTX-era 10s default into an Agnes-configured runtime.
const DEFAULT_LTX_MAX_DURATION = 10;
const DEFAULT_AGNES_MAX_DURATION = 18;
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
  const requested = Number(shotMeta.duration);

  // Provider-aware fallback:
  // - LTX stays capped at its verified 10s maximum.
  // - Agnes is allowed up to its 18s maximum if this legacy core is ever
  //   reached with Agnes selected, preventing an accidental 10s fallback.
  const isAgnes = String(config.videoProvider || '').toLowerCase() === 'agnes';
  const fallbackMaxDuration = isAgnes
    ? DEFAULT_AGNES_MAX_DURATION
    : DEFAULT_LTX_MAX_DURATION;

  const configuredMinDuration = _getPositiveNumber(
    config.ltxMinDuration,
    DEFAULT_MIN_DURATION
  );

  const configuredMaxDuration = _getPositiveNumber(
    config.ltxMaxDuration,
    fallbackMaxDuration
  );

  const providerMaxDuration = isAgnes
    ? DEFAULT_AGNES_MAX_DURATION
    : DEFAULT_LTX_MAX_DURATION;

  const minDuration = Math.min(
    configuredMinDuration,
    providerMaxDuration
  );

  const maxDuration = Math.max(
    minDuration,
    Math.min(configuredMaxDuration, providerMaxDuration)
  );

  const duration = Number.isFinite(requested)
    ? requested
    : minDuration;

  return Math.min(
    maxDuration,
    Math.max(minDuration, duration)
  );
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

function _normalizeName(value) {
  return String(value || '')
    .trim()
    .replace(/\\s+/g, ' ')
    .toLowerCase();
}

function _cleanAuthoritativeLine(value) {
  return String(value || '')
    .replace(/[“”]/g, '"')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\\s+/g, ' ')
    .trim();
}

function _speakerNameFromValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  return String(
    value.name ||
    value.character ||
    value.character_name ||
    value.characterName ||
    value.speaker ||
    value.speaker_name ||
    value.speakerName ||
    ''
  ).trim();
}

function _normalizeAuthoritativeBeat(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const match = value.match(
      /^\\s*(.+?)\\s*:\\s*["“](.*?)["”]\\s*$/
    );
    if (match) {
      const speaker = _speakerNameFromValue(match[1]);
      const line = _cleanAuthoritativeLine(match[2]);
      return line ? { speaker, line } : null;
    }

    const line = _cleanAuthoritativeLine(value);
    return line ? { speaker: '', line } : null;
  }

  const speaker = _speakerNameFromValue(value);
  const line = _cleanAuthoritativeLine(
    value.line ||
    value.dialogue ||
    value.utterance ||
    value.text ||
    value.spoken_line ||
    value.spokenLine ||
    ''
  );

  return line ? { speaker, line } : null;
}

function _extractQuotedTurns(value) {
  if (value == null) return [];

  if (Array.isArray(value)) {
    return value
      .flatMap(item => _extractQuotedTurns(item))
      .filter(Boolean);
  }

  if (typeof value === 'object') {
    const beat = _normalizeAuthoritativeBeat(value);
    return beat ? [beat] : [];
  }

  const raw = String(value || '').trim();
  if (!raw) return [];

  const labelled = [];
  const labelledRegex =
    /(?:^|[\\r\\n.;])\\s*([^:]{1,120}?)\\s*:\\s*["“]([^"”]+)["”]/g;
  let match;
  while ((match = labelledRegex.exec(raw)) !== null) {
    const line = _cleanAuthoritativeLine(match[2]);
    if (line) {
      labelled.push({
        speaker: _speakerNameFromValue(match[1]),
        line,
      });
    }
  }

  if (labelled.length) return labelled;

  return [...raw.matchAll(/["“]([^"”]+)["”]/g)]
    .map(match => ({
      speaker: '',
      line: _cleanAuthoritativeLine(match[1]),
    }))
    .filter(beat => beat.line);
}

function _dedupeAuthoritativeBeats(beats) {
  const out = [];
  const seen = new Set();

  for (const beat of beats || []) {
    if (!beat?.line) continue;
    const line = _cleanAuthoritativeLine(beat.line);
    if (!line) continue;

    // Preserve chronological turns. The same line is only one authored turn.
    const key = `${_normalizeName(beat.speaker)}::${line.toLowerCase()}`;
    if (seen.has(key)) continue;

    seen.add(key);
    out.push({
      speaker: _speakerNameFromValue(beat.speaker),
      line,
    });
  }

  return out;
}

/**
 * Build the authoritative dialogue registry BEFORE the vision director is called.
 *
 * IMPORTANT:
 * `videoPrompt` is a rendered prompt/input string, not the source of truth.
 * The authoritative registry must come from structured shot metadata and the
 * persisted conversation plan. This prevents the downstream core from
 * silently collapsing a 3-turn conversation into one quoted line.
 */
function _buildAuthoritativeDialogueRegistry(shotMeta = {}, visionContext = {}, visionShot = {}) {
  const candidateSources = [
    shotMeta.authoritativeDialogueBeats,
    shotMeta.authoritative_dialogue_beats,
    visionContext.authoritativeDialogueBeats,
    visionContext.authoritative_dialogue_beats,
    visionShot.authoritativeDialogueBeats,
    visionShot.authoritative_dialogue_beats,
    visionShot._conversation_plan?.turns,
    visionShot.conversation_plan?.turns,
    visionShot.dialogue_beats,
    visionShot.dialogueBeats,
    visionShot.speaker_turns,
    visionShot.speakerTurns,
  ];

  for (const source of candidateSources) {
    const beats = _dedupeAuthoritativeBeats(_extractQuotedTurns(source));
    if (beats.length) return beats;
  }

  const structuredDialogueSources = [
    visionShot.dialogue_or_action,
    visionShot.dialogue,
    visionShot.conversation,
    shotMeta.dialogue_or_action,
    shotMeta.dialogue,
    shotMeta.conversation,
  ];

  for (const source of structuredDialogueSources) {
    const beats = _dedupeAuthoritativeBeats(_extractQuotedTurns(source));
    if (beats.length) return beats;
  }

  const authoredIntent =
    typeof shotMeta.videoPrompt === 'string'
      ? shotMeta.videoPrompt.trim()
      : '';

  return _dedupeAuthoritativeBeats(_extractQuotedTurns(authoredIntent));
}

function _extractVisionResult(result) {
  // Backward compatible with the current director, which returns a string.
  // Also supports a richer result carrying the resolved dialogue registry.
  if (typeof result === 'string') {
    return {
      description: result,
      visionResponse: result,
      authoritativeDialogueBeats: [],
      semanticSpeakerOwnership: null,
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

  const authoritativeDialogueBeats = _dedupeAuthoritativeBeats(
    result?.authoritativeDialogueBeats ||
    result?.authoritative_dialogue_beats ||
    result?.dialogueBeats ||
    result?.dialogue_beats ||
    []
  );

  return {
    description,
    visionResponse,
    authoritativeDialogueBeats,
    semanticSpeakerOwnership:
      result?.semanticSpeakerOwnership ??
      result?.semantic_speaker_ownership ??
      result?.speakerAudit ??
      result?.speaker_audit ??
      null,
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

  /*
   * AUTHORITATIVE DIALOGUE REGISTRY
   *
   * This is the single source of truth for downstream LTX validation.
   * Never reconstruct it from the rendered `videoPrompt`, because that field
   * can legitimately contain only a partial/legacy rendering of a conversation.
   */
  let authoritativeDialogueBeats =
    _buildAuthoritativeDialogueRegistry(
      shotMeta,
      visionContext,
      visionShot
    );

  const sourceLines = authoritativeDialogueBeats
    .map(beat => beat.line)
    .filter(Boolean);

  if (authoritativeDialogueBeats.length) {
    visionShot.authoritativeDialogueBeats = authoritativeDialogueBeats;
    visionShot.authoritative_dialogue_beats = authoritativeDialogueBeats;
    visionShot.conversation_turn_speakers = authoritativeDialogueBeats
      .map(beat => beat.speaker)
      .filter(Boolean);
    visionShot.conversation_plan = {
      ...(visionShot.conversation_plan || {}),
      turns: authoritativeDialogueBeats,
      speakers: [...new Set(
        authoritativeDialogueBeats
          .map(beat => _speakerNameFromValue(beat.speaker))
          .filter(Boolean)
      )],
    };
    visionShot.dialogue = sourceLines
      .map(line => `"${line}"`)
      .join(' ');
    visionShot.conversation_reason =
      visionShot.conversation_reason ||
      'Authoritative authored dialogue registry supplied by the production shot contract; preserve every turn verbatim and in order.';
  }

  if (authoredIntent) {
    visionShot.shot_description = authoredIntent;
    visionShot.authored_ltx_intent = authoredIntent;
  }

  console.log(
    `[LTXVideoGen] AUTHORITATIVE DIALOGUE REGISTRY ` +
    `turns=${authoritativeDialogueBeats.length} ` +
    `speakers=${[...new Set(authoritativeDialogueBeats.map(beat => beat.speaker).filter(Boolean))].join(', ')}`
  );

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
        authoritativeDialogueBeats: directorDialogueBeats,
        semanticSpeakerOwnership,
      } = _extractVisionResult(visionResult);

      /*
       * If the Vision Director returns its own structured authoritative beat
       * registry, it becomes the canonical downstream registry — but only when
       * it contains at least as many turns as the source registry. Otherwise
       * retain the production shot registry and do not let a renderer collapse
       * a conversation.
       */
      if (
        directorDialogueBeats.length >= authoritativeDialogueBeats.length &&
        directorDialogueBeats.length > 0
      ) {
        authoritativeDialogueBeats = directorDialogueBeats;
      }

      const finalSourceLines = authoritativeDialogueBeats
        .map(beat => beat.line)
        .filter(Boolean);

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

      const validation = _validateAuthoredDialogue(
        finalSourceLines,
        finalPrompt
      );

      console.log(
        `[LTXVideoGen] Vision-authored LTX prompt generated ` +
        `(attempt=${visionAttempt} ` +
        `words=${finalPrompt.split(/\s+/).filter(Boolean).length} ` +
        `quotedDialogue=${validation.outputLines.length}/${finalSourceLines.length} ` +
        `preserved=${finalSourceLines.length - validation.missingLines.length}/${finalSourceLines.length}).`
      );

      if (validation.valid) {
        if (semanticSpeakerOwnership) {
          console.log(
            '[LTXVideoGen] Inherited Vision Director semantic speaker ownership ' +
            'without re-evaluating it in the transport layer.'
          );
        }
        return finalPrompt;
      }

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

  console.log(
    `[LTXVideoGen] Effective duration=${duration}s ` +
    `provider=${String(config.videoProvider || 'ltx').toLowerCase()} ` +
    `requested=${Number.isFinite(Number(shotMeta.duration)) ? Number(shotMeta.duration) : 'default'}`
  );
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
