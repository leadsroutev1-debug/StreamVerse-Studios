'use strict';

/**
 * StreamVerse Studio — Agnes Video V2.0 image-to-video integration.
 *
 * Agnes uses the re-anchored current-shot still as its single authoritative
 * I2V opening image. For continuity, the current-shot still has already been
 * generated from the exact previous-shot terminal frame plus the canonical
 * character references needed by the shot. The predecessor frame is never sent
 * as a competing Agnes keyframe.
 */

const config = require('./config');
const db = require('./db');
const videoEngineClient = require('../services/videoEngineClient');
const ltxVisionDirector = require('./ltxVisionDirector');

const DEFAULT_MIN_DURATION = 1;
const DEFAULT_MAX_DURATION = 18;
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1536;
const DEFAULT_NEGATIVE_PROMPT = [
  'garbled text','gibberish','misspelled words','distorted lettering','unreadable text',
  'random symbols','subtitles','captions','closed captions','dialogue captions',
  'text overlays','UI overlays','title cards','watermarks','logos','extra typography',
  'floating text','duplicated text','malformed signs','malformed labels','screen text',
  'extra written words','on-screen graphics','words appearing from nowhere',
].join(', ');
const CONTINUITY_FOLDER = process.env.AGNES_CONTINUITY_FRAME_FOLDER || 'ai-movies/continuity-frames';

let _continuitySchemaReady = false;
const _continuityFrameCache = new Map();

function _positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _resolveDuration(shotMeta = {}) {
  const requested = Number(shotMeta.duration);
  const duration = Number.isFinite(requested) ? requested : DEFAULT_MIN_DURATION;
  // Agnes owns an 18-second ceiling. Ignore legacy AGNES_MAX_DURATION values.
  const maxDuration = DEFAULT_MAX_DURATION;
  return Math.min(maxDuration, Math.max(DEFAULT_MIN_DURATION, duration));
}

function _resolveDimensions(shotMeta = {}) {
  return {
    width: Math.floor(_positive(shotMeta.width, _positive(process.env.AGNES_WIDTH, DEFAULT_WIDTH))),
    height: Math.floor(_positive(shotMeta.height, _positive(process.env.AGNES_HEIGHT, DEFAULT_HEIGHT))),
  };
}

function _resolveNegativePrompt(shotMeta = {}) {
  return String(
    shotMeta.negativePrompt ||
    shotMeta.agnesNegativePrompt ||
    process.env.AGNES_NEGATIVE_PROMPT ||
    DEFAULT_NEGATIVE_PROMPT
  ).trim();
}

async function _ensureContinuitySchema() {
  if (_continuitySchemaReady) return;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS shot_continuity_frames (
      episode_id VARCHAR(191) NOT NULL,
      scene_number INT NOT NULL,
      shot_index INT NOT NULL,
      video_url TEXT NULL,
      first_frame_url TEXT NULL,
      last_frame_url TEXT NULL,
      duration_seconds DOUBLE NULL,
      last_frame_timestamp DOUBLE NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (episode_id, scene_number, shot_index),
      KEY idx_shot_continuity_order (episode_id, scene_number, shot_index)
    )
  `);
  _continuitySchemaReady = true;
}

async function _latestDraftEpisode() {
  return db.queryOne(`SELECT id FROM episodes WHERE status = 'draft' ORDER BY created_at DESC LIMIT 1`);
}

async function _currentShotContext() {
  const episode = await _latestDraftEpisode();
  if (!episode?.id) return null;
  return db.queryOne(
    `SELECT episode_id, scene_number, shot_index, image_url, mh_job_id
       FROM shots
      WHERE episode_id = ?
        AND status IN ('pending', 'mh_submitted', 'failed')
      ORDER BY scene_number ASC, shot_index ASC
      LIMIT 1`,
    [episode.id]
  );
}

async function _latestCompletedShot() {
  await _ensureContinuitySchema();
  const current = await _currentShotContext();
  if (!current?.episode_id) return null;

  return db.queryOne(
    `SELECT s.episode_id, s.scene_number, s.shot_index, s.clip_url,
            c.first_frame_url, c.last_frame_url,
            c.duration_seconds, c.last_frame_timestamp
       FROM shots s
       LEFT JOIN shot_continuity_frames c
         ON c.episode_id = s.episode_id
        AND c.scene_number = s.scene_number
        AND c.shot_index = s.shot_index
      WHERE s.episode_id = ?
        AND s.status = 'done'
        AND s.clip_url IS NOT NULL
        AND (s.scene_number < ? OR (s.scene_number = ? AND s.shot_index < ?))
      ORDER BY s.scene_number DESC, s.shot_index DESC
      LIMIT 1`,
    [current.episode_id, Number(current.scene_number), Number(current.scene_number), Number(current.shot_index)]
  );
}

function _resolveFrameServiceCredentials() {
  const serviceUrl = String(process.env.FFMPEG_SERVICE_URL || config.ffmpegServiceUrl || '').replace(/\/+$/, '');
  const apiKey = String(
    process.env.FFMPEG_SERVICE_API_KEY ||
    config.ffmpegApiKey ||
    process.env.FFMPEG_API_KEY ||
    ''
  ).trim();
  return { serviceUrl, apiKey };
}

async function retrieveContinuityFrames(videoUrl) {
  const { serviceUrl, apiKey } = _resolveFrameServiceCredentials();
  if (!serviceUrl) throw new Error('[AgnesVideoGen] FFMPEG_SERVICE_URL is required for Agnes shot continuity frames.');
  if (!apiKey) throw new Error('[AgnesVideoGen] No FFmpeg service API key configured. Set FFMPEG_API_KEY (existing StreamVerse secret) or FFMPEG_SERVICE_API_KEY.');
  if (!videoUrl) throw new Error('[AgnesVideoGen] Cannot extract continuity frames without a completed video URL.');

  const cached = _continuityFrameCache.get(videoUrl);
  if (cached?.lastFrameUrl) return cached;

  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(`${serviceUrl}/frames`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ videoUrl, folder: CONTINUITY_FOLDER }),
      });
      const raw = await response.text();
      let result = {};
      try { result = raw ? JSON.parse(raw) : {}; } catch (_) {}
      if (!response.ok) throw new Error(`Frame retrieval failed: ${result.error || response.statusText || `HTTP ${response.status}`}`);
      if (!result.firstFrameUrl || !result.lastFrameUrl) throw new Error('Frame retrieval response is missing firstFrameUrl or lastFrameUrl.');

      const continuity = {
        firstFrameUrl: String(result.firstFrameUrl),
        lastFrameUrl: String(result.lastFrameUrl),
        durationSeconds: Number(result.durationSeconds) || null,
        lastFrameTimestamp: Number(result.lastFrameTimestamp) || null,
      };
      _continuityFrameCache.set(videoUrl, continuity);
      return continuity;
    } catch (err) {
      lastError = err;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, Math.min(8000, 1000 * (2 ** (attempt - 1)))));
    }
  }
  throw lastError || new Error('Continuity frame extraction failed.');
}

async function _persistContinuityFrames(videoUrl, continuity, jobId = null) {
  await _ensureContinuitySchema();
  const current = jobId
    ? await db.queryOne(`SELECT episode_id, scene_number, shot_index, image_url FROM shots WHERE mh_job_id = ? ORDER BY updated_at DESC LIMIT 1`, [jobId])
    : await _currentShotContext();
  if (!current?.episode_id) throw new Error('[AgnesVideoGen] Could not identify the exact shot row for completed Agnes job continuity persistence.');

  await db.execute(
    `INSERT INTO shot_continuity_frames
      (episode_id, scene_number, shot_index, video_url, first_frame_url, last_frame_url, duration_seconds, last_frame_timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE video_url=VALUES(video_url), first_frame_url=VALUES(first_frame_url), last_frame_url=VALUES(last_frame_url), duration_seconds=VALUES(duration_seconds), last_frame_timestamp=VALUES(last_frame_timestamp), updated_at=NOW()`,
    [current.episode_id, Number(current.scene_number), Number(current.shot_index), videoUrl, continuity.firstFrameUrl, continuity.lastFrameUrl, continuity.durationSeconds, continuity.lastFrameTimestamp]
  );
  console.log(`[AgnesVideoGen] Continuity frames persisted | S${current.scene_number}/idx${current.shot_index} first=${continuity.firstFrameUrl} last=${continuity.lastFrameUrl}`);
  return continuity;
}

async function _resolveAgnesStartingImage(imageBuffer, shotMeta = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error('[AgnesVideoGen] Current shot image is empty.');
  }

  // Continuity has already been resolved in the still-generation stage. Agnes
  // must receive exactly one opening image so the provider cannot reinterpret
  // the predecessor frame as a second competing composition.
  return {
    imageBuffer,
    referenceImageBuffers: [imageBuffer],
    usedContinuityFrame: false,
    continuityLastFrameUrl: null,
    predecessor: null,
  };
}

async function _buildFinalAgnesPrompt(imageBuffer, shotMeta = {}, continuity = {}) {
  const authoredIntent = String(shotMeta._agnesPromptOverride || shotMeta.agnesPrompt || shotMeta.videoPrompt || '').trim();
  const visionContext = shotMeta.visionContext || {};
  const shot = { ...(visionContext.shot || {}), ...shotMeta };
  if (authoredIntent) {
    shot.ltx_shot_description = authoredIntent;
    shot.shot_description = shot.shot_description || authoredIntent;
    shot.authored_ltx_intent = authoredIntent;
  }

  const continuityInstruction = continuity.usedContinuityFrame
    ? 'The previous-shot terminal frame is available only as continuity context. The supplied current-shot image is the authoritative opening frame. Preserve the inherited physical state, identity, wardrobe, props, lighting, geography, eyelines and emotional state that were re-anchored into this image, then perform the new shot action. Do not reset, teleport, swap, mirror, or replace characters.'
    : 'The supplied image is the authoritative authored opening still for this shot. Begin from that exact visual state and perform the new shot action.';

  const dialogueInstruction = /(?:dialogue|speaker|speaking|"|“|”|tts_mode)/i.test(String(shot.dialogue_or_action || shot.videoPrompt || shot.agnesPrompt || ''))
    ? 'This is a live-action conversational performance. Preserve exact speaker attribution, let the correct speaker visibly articulate the words, and give listening characters natural reactive facial and body performance without inventing extra dialogue.'
    : '';

  const result = await ltxVisionDirector.describeForLTX({
    imageBuffer,
    imageMime: visionContext.imageMime || 'image/png',
    shot,
    scene: visionContext.scene || {},
    characters: visionContext.characters || [],
    repairInstruction: `${continuityInstruction}${dialogueInstruction ? ` ${dialogueInstruction}` : ''}`,
  });
  const finalPrompt = String(result || '').trim();
  if (!finalPrompt) throw new Error('[AgnesVideoGen] Vision Director returned an empty final Agnes prompt');

  const providerPrompt = `${continuityInstruction} ${dialogueInstruction ? `${dialogueInstruction} ` : ''}${finalPrompt}`.trim();

  // Persist the EXACT string that will be passed to the Agnes HTTP request.
  // This is intentionally after all Vision Director/continuity composition.
  if (typeof shotMeta._promptCapture === 'function') {
    try {
      await shotMeta._promptCapture(providerPrompt);
    } catch (captureErr) {
      console.warn(`[AgnesVideoGen] Exact prompt persistence failed (non-fatal): ${captureErr.message}`);
    }
  }

  console.log('[AgnesVideoGen] FINAL VISION-DIRECTOR PROMPT:');
  console.log(providerPrompt);
  return providerPrompt;
}

class AgnesGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgnesGenerationError';
    Error.captureStackTrace?.(this, AgnesGenerationError);
  }
}

async function submitVideoJob(imageBuffer, shotMeta = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) throw new AgnesGenerationError('[AgnesVideoGen] submitVideoJob received an empty image buffer.');

  let startingImage;
  try {
    startingImage = await _resolveAgnesStartingImage(imageBuffer, shotMeta);
  } catch (err) {
    if (err instanceof AgnesGenerationError) throw err;
    throw new AgnesGenerationError(`[AgnesVideoGen] Failed to resolve shot continuity start frame: ${err.message}`);
  }

  const prompt = await _buildFinalAgnesPrompt(startingImage.imageBuffer, shotMeta, startingImage);
  const duration = _resolveDuration(shotMeta);
  const { width, height } = _resolveDimensions(shotMeta);
  const negativePrompt = _resolveNegativePrompt(shotMeta);
  const seed = Number.isFinite(Number(shotMeta.seed)) ? Math.floor(Number(shotMeta.seed)) : null;

  try {
    const { jobId } = await videoEngineClient.submitJob({
      provider: 'agnes',
      imageBuffer: startingImage.imageBuffer,
      referenceImageBuffers: [startingImage.imageBuffer],
      prompt,
      duration,
      width,
      height,
      seed,
      negativePrompt,
      randomizeSeed: false,
      enhancePrompt: false,
    });
    console.log('[AgnesVideoGen] Agnes I2V starting from the continuity-re-anchored current-shot still (single keyframe).');
    return { jobId, apiKey: '... (redacted)' };
  } catch (err) {
    throw err instanceof AgnesGenerationError ? err : new AgnesGenerationError(`[AgnesVideoGen] Submission failed: ${err.message}`);
  }
}

async function pollVideoJob(jobId) {
  const result = await videoEngineClient.pollJob(jobId);
  const videoUrl = typeof result === 'string'
    ? result.trim()
    : String(result?.video_url || result?.videoUrl || result?.url || '').trim();

  if (!videoUrl) {
    throw new AgnesGenerationError(
      `[AgnesVideoGen] Job ${jobId} completed without a usable video_url`
    );
  }

  const continuity = await retrieveContinuityFrames(videoUrl);
  await _persistContinuityFrames(videoUrl, continuity, jobId);

  // Provider contract: pollVideoJob() returns the finished video URL, not the
  // transport/job response object. The pipeline passes this value directly to
  // Cloudinary's uploadVideoFromUrl(). Returning the whole object here causes
  // Cloudinary to receive "[object Object]" as its source URL.
  return videoUrl;
}

module.exports = {
  submitVideoJob,
  pollVideoJob,
  retrieveContinuityFrames,
  AgnesGenerationError,
  providerName: 'agnes',
};
