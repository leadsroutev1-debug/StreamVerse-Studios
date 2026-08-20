'use strict';
/**
 * Google Gemini Image Generation — Primary image generator for StreamVerse.
 *
 * Retry strategy (in order):
 *   1. Round-robin all Google keys directly (one attempt each)
 *   2. Exponential backoff + retry direct keys (up to 4 backoff rounds: 2s→4s→8s→16s)
 *   3. Route through ScrapingBee rotating residential proxy (hides Replit's blocked IP)
 *      — rotates ScrapingBee keys on quota exhaustion (402/403)
 *      — retries all Google keys per ScrapingBee key
 *
 * Configuration:
 *   GOOGLE_KEYS       comma-separated Google AI Studio API keys
 *   SCRAPINGBEE_KEYS  comma-separated ScrapingBee API keys (proxy fallback)
 */
const axios  = require('axios');
const https  = require('https');
const path   = require('path');
const fs     = require('fs');
const sharp  = require('sharp');
const config = require('./config');

// HTTPS agent for ScrapingBee proxy tunnels.
//
// ScrapingBee routes requests through rotating residential IPs using HTTP CONNECT
// tunneling.  Their intermediate SSL certificate sometimes expires before the
// underlying residential pool is rotated, causing certificate errors that are
// unrelated to the actual Google API call.
//
// Set SCRAPINGBEE_SKIP_TLS_VERIFY=false in your environment to re-enable
// full certificate verification once ScrapingBee issues a new cert chain.
// Default is true (skip) so proxy fallback continues to work out of the box.
const _skipTlsVerify  = (process.env.SCRAPINGBEE_SKIP_TLS_VERIFY || 'true').toLowerCase() !== 'false';
const _proxyHttpsAgent = new https.Agent({ rejectUnauthorized: !_skipTlsVerify });

const GOOGLE_IMAGE_MODEL = process.env.GOOGLE_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GOOGLE_API_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── Safety refusal error ──────────────────────────────────────────────────────
/**
 * Thrown when Google Gemini refuses to generate an image due to safety filters.
 * Distinct from transient errors so callers can rewrite the prompt rather than
 * retrying identically (which would just hit the same filter again).
 */
class SafetyRefusalError extends Error {
  constructor(reason, categories = []) {
    super(`Google Gemini safety refusal [${reason}]${categories.length ? ': ' + categories.join(', ') : ''}`);
    this.name             = 'SafetyRefusalError';
    this.safetyReason     = reason;
    this.safetyCategories = categories;
  }
}

// ── Logo — load once at module init ──────────────────────────────────────────
const LOGO_PATH = path.join(__dirname, '..', 'logo', 'Logo.png');
let _logoBuffer = null;
try {
  _logoBuffer = fs.readFileSync(LOGO_PATH);
  console.log('[GoogleImageGen] Logo loaded from', LOGO_PATH);
} catch {
  console.warn('[GoogleImageGen] logo/Logo.png not found — watermark overlay disabled');
}

// ──────────────────────────────────────────────────────────────────────────────
// Logo overlay — bottom-right branding (still images from Google/CF generators)
//
// Heuristic sizing mirrors the Cloudinary video overlay:
//   Logo is 1248×670 px (aspect ≈ 1.86:1, landscape).
//   Target width = 28 % of image width so the logo scales proportionally with
//   the output resolution, matching the same south-east anchor used on videos.
//   Edge padding = 12 px, matching the video overlay's x_12,y_12 offsets.
// ──────────────────────────────────────────────────────────────────────────────

async function _overlayLogo(imgBuffer) {
  if (!_logoBuffer) return imgBuffer;

  try {
    const img  = sharp(imgBuffer);
    const meta = await img.metadata();
    const w    = meta.width  || 1080;
    const h    = meta.height || 1920;

    // 28 % of image width — same proportional heuristic as the Cloudinary overlay
    const logoW = Math.round(w * 0.28);

    const logoResized = await sharp(_logoBuffer)
      .resize(logoW, null, { fit: 'inside' })
      .toBuffer();

    const logoMeta = await sharp(logoResized).metadata();
    const lw = logoMeta.width  || logoW;
    const lh = logoMeta.height || logoW;

    // 12 px edge padding — matches MH watermark's own south-east anchor offset
    const padding = 12;
    const left = Math.max(0, w - lw - padding);
    const top  = Math.max(0, h - lh - padding);

    return await img
      .composite([{ input: logoResized, left, top, blend: 'over' }])
      .png()
      .toBuffer();
  } catch (err) {
    console.warn('[GoogleImageGen] Logo overlay failed:', err.message);
    return imgBuffer;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Core API call — shared by direct and proxy paths
// scrapingBeeKey: if provided, routes the request through ScrapingBee's
//                 residential proxy pool to bypass Replit's blocked IP.
// ──────────────────────────────────────────────────────────────────────────────

async function _callGoogleApi(googleKey, requestBody, scrapingBeeKey) {
  const targetUrl = `${GOOGLE_API_BASE}/${GOOGLE_IMAGE_MODEL}:generateContent?key=${googleKey}`;

  const axiosConfig = { timeout: 120000 };

  if (scrapingBeeKey) {
    // ScrapingBee proxy — residential rotating IPs, hides Replit's blacklisted address.
    // Uses HTTP CONNECT tunneling for HTTPS targets (axios handles this automatically).
    // rejectUnauthorized:false is required because ScrapingBee's intermediate SSL
    // certificate can expire while their residential proxy pool remains functional.
    axiosConfig.proxy      = {
      host: 'proxy.scrapingbee.com',
      port: 8886,
      auth: { username: 'render_js=False', password: scrapingBeeKey },
    };
    axiosConfig.httpsAgent = _proxyHttpsAgent;
  }

  const resp = await axios.post(targetUrl, requestBody, axiosConfig);

  // ── Safety check: prompt blocked before generation ───────────────────────
  const promptFeedback = resp.data?.promptFeedback;
  if (promptFeedback?.blockReason) {
    const blocked = (promptFeedback.safetyRatings || [])
      .filter(r => r.blocked)
      .map(r => r.category);
    throw new SafetyRefusalError(promptFeedback.blockReason, blocked);
  }

  const candidate = resp.data?.candidates?.[0];

  // ── Safety check: generation completed but filtered ──────────────────────
  if (candidate?.finishReason === 'SAFETY') {
    const blocked = (candidate.safetyRatings || [])
      .filter(r => r.blocked || (r.probability && r.probability !== 'NEGLIGIBLE'))
      .map(r => r.category);
    throw new SafetyRefusalError('SAFETY', blocked);
  }

  const parts   = (candidate?.content?.parts) || [];
  const imgPart = parts.find(p => p.inlineData?.data);

  if (!imgPart) {
    const textPart = parts.find(p => p.text);
    const detail   = textPart?.text?.slice(0, 300) || JSON.stringify(resp.data).slice(0, 300);
    throw new Error(`Google API returned no image data. Detail: ${detail}`);
  }

  const buf = Buffer.from(imgPart.inlineData.data, 'base64');
  if (!buf || buf.length < 200) {
    throw new Error(`Google API returned suspiciously small image (${buf?.length ?? 0} bytes)`);
  }

  return buf;
}

// ──────────────────────────────────────────────────────────────────────────────
// Core generation — 3-phase retry strategy
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Generate an image using Google Generative Language API (Gemini image generation).
 *
 * @param {string}   prompt              Full image prompt
 * @param {string[]} referenceImageUrls  Unused by Google API but kept for interface parity
 * @param {number|null} seed             Unused — Gemini does not expose a seed param
 * @param {string|null} negativePrompt   Appended as "AVOID:" instruction in the prompt
 * @returns {Buffer} Raw PNG image bytes with logo overlay applied
 */
async function generateImage(prompt, referenceImageUrls = [], seed = null, negativePrompt = null) {
  const keys = config.googleKeys;
  if (!keys.length) throw new Error('[GoogleImageGen] No Google API keys configured (GOOGLE_KEYS)');

  const parts = [
    'OUTPUT FORMAT: Single photorealistic image, exactly 1080×1920 pixels, 9:16 vertical portrait orientation.',
    'CRITICAL: Produce ONE image only. No film strips, no multiple panels, no horizontal layout, no landscape orientation.',
    prompt,
  ];
  if (negativePrompt) {
    parts.push(`AVOID IN THE IMAGE: ${negativePrompt}`);
  }
  const fullPrompt = parts.join('\n\n');

  const requestBody = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };

  let lastError;

  // ── Phase 1: Try all Google keys directly (round-robin, one pass) ─────────
  for (let i = 0; i < keys.length; i++) {
    const key = config.getNextGoogleKey();
    try {
      const buf = await _callGoogleApi(key, requestBody, null);
      config.markKeyStatus('google', key, 'active');
      console.log(`[GoogleImageGen] Image generated (${buf.length} bytes) — applying logo overlay`);
      return await _overlayLogo(buf);
    } catch (err) {
      lastError = err;
      if (err instanceof SafetyRefusalError) throw err; // prompt issue — don't retry with same prompt

      const status = err.response?.status;
      if (status === 429) {
        config.markKeyStatus('google', key, 'rate-limited');
        console.warn(`[GoogleImageGen] Key ${i + 1}/${keys.length} rate-limited (429), rotating...`);
        continue;
      }
      if (status === 401 || status === 403) {
        config.markKeyStatus('google', key, 'exhausted');
        console.warn(`[GoogleImageGen] Key ${i + 1}/${keys.length} invalid/forbidden (${status}), rotating...`);
        continue;
      }
      console.warn(`[GoogleImageGen] Key ${i + 1}/${keys.length} failed: ${err.message}`);
    }
  }

  // ── Phase 2: Exponential backoff — retry all direct keys with delay ────────
  // When Replit's shared IP hits a quota window, waiting a few seconds reopens slots.
  const BACKOFF_ROUNDS = 4;
  for (let round = 0; round < BACKOFF_ROUNDS; round++) {
    const waitMs = Math.min(2000 * Math.pow(2, round), 30000); // 2s, 4s, 8s, 16s (cap 30s)
    console.log(
      `[GoogleImageGen] All keys rate-limited. Exponential backoff round ${round + 1}/${BACKOFF_ROUNDS}` +
      ` — waiting ${waitMs}ms before retry...`
    );
    await new Promise(r => setTimeout(r, waitMs));

    for (let i = 0; i < keys.length; i++) {
      const key = config.getNextGoogleKey();
      try {
        const buf = await _callGoogleApi(key, requestBody, null);
        config.markKeyStatus('google', key, 'active');
        console.log(`[GoogleImageGen] Backoff round ${round + 1} succeeded — ${buf.length} bytes`);
        return await _overlayLogo(buf);
      } catch (err) {
        lastError = err;
        if (err instanceof SafetyRefusalError) throw err;

        const status = err.response?.status;
        if (status === 429) {
          config.markKeyStatus('google', key, 'rate-limited');
          continue;
        }
        if (status === 401 || status === 403) {
          config.markKeyStatus('google', key, 'exhausted');
          continue;
        }
        console.warn(`[GoogleImageGen] Backoff round ${round + 1} key ${i + 1} failed: ${err.message}`);
      }
    }
  }

  // ── Phase 3: ScrapingBee rotating residential proxy ───────────────────────
  // Routes requests through clean residential IPs that Google has not blocked.
  // Rotates to the next ScrapingBee key when one hits its quota (402/403).
  const sbKeys = config.scrapingBeeKeys;
  if (sbKeys.length > 0) {
    console.log(`[GoogleImageGen] Direct attempts exhausted — trying ScrapingBee proxy (${sbKeys.length} key(s))...`);

    for (let sbRound = 0; sbRound < sbKeys.length; sbRound++) {
      const sbKey = config.getNextScrapingBeeKey();

      for (let i = 0; i < keys.length; i++) {
        const key = config.getNextGoogleKey();
        try {
          const buf = await _callGoogleApi(key, requestBody, sbKey);
          config.markKeyStatus('google', key, 'active');
          config.markKeyStatus('scrapingbee', sbKey, 'active');
          console.log(`[GoogleImageGen] ScrapingBee proxy succeeded (SB key ${sbRound + 1}) — ${buf.length} bytes`);
          return await _overlayLogo(buf);
        } catch (err) {
          lastError = err;
          if (err instanceof SafetyRefusalError) throw err;

          const status = err.response?.status;
          if (status === 429) {
            config.markKeyStatus('google', key, 'rate-limited');
            console.warn(`[GoogleImageGen] [SB proxy] Google key ${i + 1} still rate-limited (429), rotating Google key...`);
            continue;
          }
          if (status === 402 || (status === 403 && sbRound < sbKeys.length - 1)) {
            // ScrapingBee quota exhausted for this key — rotate to next SB key
            config.markKeyStatus('scrapingbee', sbKey, 'exhausted');
            console.warn(`[GoogleImageGen] ScrapingBee key ${sbRound + 1} quota exhausted (${status}) — rotating SB key...`);
            break; // break inner loop, outer loop will try next SB key
          }
          if (status === 401 || status === 403) {
            config.markKeyStatus('google', key, 'exhausted');
            continue;
          }
          console.warn(`[GoogleImageGen] [SB proxy] Key ${i + 1} failed: ${err.message}`);
        }
      }
    }
  } else {
    console.warn('[GoogleImageGen] No SCRAPINGBEE_KEYS configured — proxy fallback unavailable.');
  }

  throw new Error(
    `[GoogleImageGen] All ${keys.length} Google key(s) failed across direct + backoff + proxy attempts. Last error: ${lastError?.message}`
  );
}

module.exports = { generateImage, SafetyRefusalError };
