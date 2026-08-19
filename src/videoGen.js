'use strict';
const axios = require('axios');
const config = require('./config');

/**
 * Submit an image-to-video job to Magic Hour.
 * imageBuffer: Buffer of the source image.
 * Returns { jobId, apiKey } on success, or throws.
 *
 * Rotates through magicHourKeys if submission fails.
 *
 * shotMeta fields:
 *   motionLevel  — 'low'|'medium'|'high'
 *   duration     — raw generation seconds (4 or 5)
 *   talkingPhoto — { audioUrl, durationSeconds } | null
 *   imagePrompt  — the shot's image_prompt, passed to MH for expressive animation
 *   shotPacingType    — used to choose safe motion defaults (dialogue shots = low motion)
 *   motionParams      — structured motion control from the Motion System Upgrade:
 *                       { motionIntensity, motionType, motionDirection, motionSpeed,
 *                         motionEasing, subjectMotion, ambientMotion, lipSync, videoPrompt }
 *                       When present, motionParams.mhMotionLevel overrides motionLevel and
 *                       motionParams.videoPrompt overrides imagePrompt.
 *
 * ── Magic Hour artifact reduction ──────────────────────────────────────────────
 * Artifacts arise when MH over-animates a subtle moment. We suppress them by:
 *   1. Forcing motionLevel to 'low' for ALL talking-photo (dialogue close-up) shots.
 *      The person is already animated by lip-sync — extra body motion fights it.
 *   2. Capping the prompt sent to MH at 300 chars for talking-photo (shorter = more faithful).
 *   3. For image-to-video, keeping motionLevel at the script's value ('low'/'medium')
 *      but clamping 'high' down to 'medium' on dialogue pacing types to avoid jitter.
 * ───────────────────────────────────────────────────────────────────────────────
 */
async function submitVideoJob(imageBuffer, shotMeta) {
  const keyCount = config.magicHourKeys.length;
  if (keyCount === 0) throw new Error('[VideoGen] No Magic Hour keys configured');

  // Upload image to Cloudinary first (Magic Hour needs a URL, not a buffer)
  const cloudinary = require('./cloudinary');
  const tmpPublicId = `${config.shotsFolderRoot}/tmp/img_${Date.now()}`;

  function _detectMime(buf) {
    if (!buf || buf.length < 12) return 'image/png';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)                      return 'image/jpeg';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10]=== 0x42 && buf[11]=== 0x50)  return 'image/webp';
    return 'image/png';
  }
  const mime = _detectMime(imageBuffer);
  const imageUrl = await cloudinary.uploadImageFromUrl(
    `data:${mime};base64,${imageBuffer.toString('base64')}`,
    tmpPublicId
  );

  let lastError;
  let hadCreditError = false;

  // ── Determine effective motion level based on shot type ──────────────────────
  // Dialogue / close-up pacing types → force 'low' to minimise facial artifacts.
  // Action / hook shots → honour the script's level (default 'medium').
  const DIALOGUE_PACING = new Set(['dialogue_mid', 'dialogue_full', 'slow_dramatic']);
  const mp = shotMeta.motionParams || null; // structured motion params from Motion System Upgrade
  const rawMotion = (mp?.mhMotionLevel || shotMeta.motionLevel || 'medium').toLowerCase();
  const isDialoguePacing = DIALOGUE_PACING.has(shotMeta.shotPacingType || '');
  const talkingPhoto = shotMeta.talkingPhoto; // { audioUrl, durationSeconds } | null

  let effectiveMotion = rawMotion;
  if (talkingPhoto?.audioUrl) {
    // Talking-photo: lip-sync drives animation — lock body motion to 'low'
    effectiveMotion = 'low';
  } else if (isDialoguePacing && rawMotion === 'high') {
    // Non-talking dialogue shot — clamp 'high' to 'medium' to reduce jitter
    effectiveMotion = 'medium';
  }

  // Prompt selection: structured videoPrompt from Motion System takes priority.
  // Prompt length: shorter for talking-photo (more faithful to source image),
  // full prompt for image-to-video (MH uses it to guide ambient motion + audio).
  const MAX_PROMPT_TALKING = 300;
  const MAX_PROMPT_VIDEO   = 500;
  const rawPrompt = (mp?.videoPrompt || shotMeta.imagePrompt || '').trim();

  for (let attempt = 0; attempt < keyCount; attempt++) {
    const key = config.getNextMagicHourKey();
    try {
      let endpoint, body;

      if (talkingPhoto?.audioUrl) {
        // ── AI Talking Photo ──────────────────────────────────────────────────
        // Uses 'prompted' generation mode (formerly 'expressive').
        // aspect_ratio: "9:16" forces vertical portrait output for Facebook Reels.
        // motionLevel is locked to 'low' above to prevent over-animation artifacts.
        // Prompt is capped shorter so MH doesn't drift away from the source face.
        endpoint = 'https://api.magichour.ai/v1/ai-talking-photo';
        body = {
          start_seconds: 0,
          end_seconds:   talkingPhoto.durationSeconds,
          assets: {
            image_file_path: imageUrl,
            audio_file_path: talkingPhoto.audioUrl,
          },
          style: {
            aspect_ratio:   '9:16',
            generationMode: 'prompted',
            ...(rawPrompt
              ? { prompt: rawPrompt.slice(0, MAX_PROMPT_TALKING) }
              : {}),
          },
        };
      } else {
        // ── Image-to-Video ────────────────────────────────────────────────────
        // audio: true enables Magic Hour's AI-generated ambient audio.
        // motion_level is respected from the shot script but dialled back for
        // dialogue pacing types to reduce unwanted artefacts.
        endpoint = 'https://api.magichour.ai/v1/image-to-video';
        body = {
          end_seconds:  shotMeta.duration || 5,
          audio:        true,
          assets: { image_file_path: imageUrl },
          style: {
            aspect_ratio:  '9:16',
            motion_level:  effectiveMotion,
            ...(rawPrompt
              ? { prompt: rawPrompt.slice(0, MAX_PROMPT_VIDEO) }
              : {}),
          },
        };
      }

      const resp = await axios.post(endpoint, body, {
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type':  'application/json',
        },
        timeout: 30000,
      });
      if (resp.data?.id) {
        config.markKeyStatus('magicHour', key, 'active');
        return { jobId: resp.data.id, apiKey: key, imageTmpPublicId: tmpPublicId };
      }
      throw new Error(`Unexpected response: ${JSON.stringify(resp.data)}`);
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (status === 402) {
        hadCreditError = true;
        config.markKeyStatus('magicHour', key, 'exhausted');
        console.warn(`[VideoGen] Magic Hour key credits depleted (402), advancing to next key...`);
        config.advanceMagicHourKey();
        continue;
      }
      if (status === 401) {
        config.markKeyStatus('magicHour', key, 'exhausted');
        console.warn(`[VideoGen] Magic Hour key unauthorized (401), advancing to next key...`);
        config.advanceMagicHourKey();
        continue;
      }
      if (status === 429) {
        config.markKeyStatus('magicHour', key, 'rate-limited');
        console.warn(`[VideoGen] Magic Hour key rate-limited (429), advancing to next key for this attempt...`);
        config.advanceMagicHourKey();
        continue;
      }
      throw err;
    }
  }

  const finalErr = new Error(`[VideoGen] All Magic Hour keys exhausted. Last: ${lastError?.message}`);
  if (hadCreditError) finalErr.mhExhausted = true;
  throw finalErr;
}

/**
 * Poll a Magic Hour job until completion or exhaustion.
 * Returns the video download URL on success, throws on failure.
 */
async function pollVideoJob(jobId, apiKey) {
  const maxAttempts = config.magicHourMaxPollAttempts;
  const intervalMs  = config.magicHourPollIntervalMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(intervalMs);
    try {
      const resp = await axios.get(
        `https://api.magichour.ai/v1/video-projects/${jobId}`,
        {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          timeout: 20000,
        }
      );
      const proj = resp.data;
      if (proj.status === 'complete') {
        const videoUrl = proj?.downloads?.[0]?.url;
        if (!videoUrl) throw new Error('Magic Hour: complete but no video URL in response');
        config.markKeyStatus('magicHour', apiKey, 'active');
        return videoUrl;
      }
      if (['error', 'canceled'].includes(proj.status)) {
        throw new Error(`Magic Hour job ${jobId} failed: ${proj?.error?.message || proj.status}`);
      }
      console.log(`[VideoGen] Job ${jobId} still pending (attempt ${attempt}/${maxAttempts})`);
    } catch (err) {
      if (err.response?.status === 429) {
        config.markKeyStatus('magicHour', apiKey, 'rate-limited');
        console.warn('[VideoGen] Rate-limited during poll, will retry...');
        continue;
      }
      throw err;
    }
  }
  throw new Error(`[VideoGen] Job ${jobId} did not complete after ${maxAttempts} attempts`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { submitVideoJob, pollVideoJob };
