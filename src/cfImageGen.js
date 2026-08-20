'use strict';
/**
 * Cloudflare Worker AI — Image generation via custom multipart Worker.
 *
 * Worker protocol:
 *   POST  multipart/form-data
 *     prompt         : string
 *     input_image_0  : binary file  (optional, up to 4 reference images)
 *     …
 *     input_image_3  : binary file
 *   Auth: Bearer <CF_WORKER_KEYS>
 *
 * Success response : binary image (JPEG/PNG/WebP), Content-Type: image/jpeg
 * Error response   : JSON { error: "…" }, HTTP 500
 *
 * Known error codes:
 *   4006 — daily free-tier quota exhausted → rotate to next CF_WORKER_URL
 *   3030 — output flagged by content policy → throw CFSafetyRefusalError
 *
 * CF_WORKER_URL : comma-separated list of worker deployment URLs.
 *                 Rotated round-robin; advances to next on 4006 quota error.
 * CF_WORKER_KEYS: comma-separated auth tokens (Bearer).
 *                 Rotated round-robin; skipped on 429/401/403.
 */
const axios    = require('axios');
const FormData = require('form-data');
const config   = require('./config');

// ── Typed error for content policy refusals ───────────────────────────────────
class CFSafetyRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CFSafetyRefusalError';
  }
}

// ── Parse an error body (arraybuffer or string) into a plain string ───────────
function _parseErrorBody(data) {
  if (!data) return null;
  try {
    const text = Buffer.isBuffer(data) ? data.toString('utf8')
               : (data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8')
               : String(data));
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      return parsed.error || trimmed;
    }
    return trimmed;
  } catch { return null; }
}

// ── Check if a successful (2xx) response body is actually a JSON error ─────────
// The worker should return non-2xx on error, but guard against it anyway.
function _checkNotJsonError(buf) {
  if (!buf || buf.length < 2) return;
  // If first byte is '{' this is likely JSON, not image data
  if (buf[0] !== 0x7B) return; // not '{'
  try {
    const text   = buf.toString('utf8').slice(0, 600);
    const parsed = JSON.parse(text);
    if (parsed.error) {
      throw new Error(`CF Worker returned JSON error: ${parsed.error}`);
    }
  } catch (e) {
    if (e.message?.startsWith('CF Worker returned JSON error')) throw e;
    // JSON parse failed — not JSON, ignore
  }
}

/**
 * Generate an image via the Cloudflare Worker AI endpoint.
 *
 * @param {string}   prompt              Full image prompt
 * @param {string[]} referenceImageUrls  Character reference portrait URLs (up to 4)
 * @param {number|null} seed             Unused — worker handles internally
 * @param {string|null} negativePrompt   Unused — not supported by worker protocol
 * @param {Array<{name:string, reference_index:number, position?:string, action?:string}>} [characterMap]
 *   Dynamic reference-index → character identity mapping, built by the caller
 *   from whichever characters are actually present in the current scene (no
 *   fixed cast, no hardcoded names/count). Forwarded to the Worker as the
 *   `characters` field so it can build its REFERENCE IMAGE N = <name>
 *   identity-preservation instructions. Optional — omitted safely if empty.
 * @returns {Buffer} Raw image bytes (JPEG/PNG/WebP)
 */
async function generateImage(prompt, referenceImageUrls = [], seed = null, negativePrompt = null, characterMap = []) {
  const urlCount = config.cfWorkerUrls.length;
  const keyCount = config.cfWorkerKeys.length;

  if (urlCount === 0) throw new Error('[CFImageGen] No Cloudflare Worker URLs configured (CF_WORKER_URL)');
  if (keyCount === 0) throw new Error('[CFImageGen] No Cloudflare Worker keys configured (CF_WORKER_KEYS)');

  // Pre-fetch reference images as buffers (up to 4, failures are non-fatal)
  const refBuffers = [];
  for (const url of (referenceImageUrls || []).slice(0, 4)) {
    try {
      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
      refBuffers.push(Buffer.from(r.data));
    } catch (e) {
      console.warn(`[CFImageGen] Skipping reference image (fetch failed): ${e.message}`);
    }
  }

  let lastError;

  // Outer loop: rotate through worker URLs on quota exhaustion
  for (let urlAttempt = 0; urlAttempt < urlCount; urlAttempt++) {
    const workerUrl = config.getNextCfUrl();

    // Inner loop: rotate through auth keys on 429/401/403
    for (let keyAttempt = 0; keyAttempt < keyCount; keyAttempt++) {
      const key = config.getNextCfKey();

      try {
        const form = new FormData();
        form.append('prompt', prompt);
        // Vertical 9:16 portrait — matches CF Worker flux-2-klein-9b native resolution
        form.append('width',        '768');
        form.append('height',       '1365');
        form.append('aspect_ratio', '9:16');
        // Dynamic reference→character identity mapping (0..N characters — never
        // hardcoded). Only sent when the caller actually supplied one; the
        // Worker treats a missing/empty `characters` field as "no metadata".
        if (Array.isArray(characterMap) && characterMap.length > 0) {
          form.append('characters', JSON.stringify(characterMap));
        }
        for (let i = 0; i < refBuffers.length; i++) {
          form.append(`input_image_${i}`, refBuffers[i], {
            filename:    `ref_${i}.jpg`,
            contentType: 'image/jpeg',
          });
        }

        const resp = await axios.post(workerUrl, form, {
          headers: {
            ...form.getHeaders(),
            'Authorization': `Bearer ${key}`,
          },
          responseType: 'arraybuffer',
          timeout:      90000,
        });

        const buf = Buffer.from(resp.data);

        // Guard: 2xx but body is a JSON error
        _checkNotJsonError(buf);

        if (buf.length < 100) {
          throw new Error(`CF Worker returned suspiciously small response (${buf.length} bytes)`);
        }

        config.markKeyStatus('cf', key, 'active');
        console.log(`[CFImageGen] Image generated (${buf.length} bytes, ${refBuffers.length} ref image(s))`);
        return buf;

      } catch (err) {
        lastError = err;

        // ── JSON error embedded in a thrown message (from _checkNotJsonError) ──
        if (err.message?.startsWith('CF Worker returned JSON error')) {
          const errText = err.message;
          if (errText.includes('3030')) {
            throw new CFSafetyRefusalError(`CF Worker content flagged (3030): ${errText}`);
          }
          if (errText.includes('4006')) {
            config.markKeyStatus('cfurl', workerUrl, 'exhausted');
            console.warn(`[CFImageGen] Quota exhausted (4006) on ${workerUrl} — rotating to next URL`);
            break; // break key loop → outer loop tries next URL
          }
          // Other JSON error — propagate
          throw err;
        }

        // ── HTTP error response ────────────────────────────────────────────────
        if (err.response) {
          const status  = err.response.status;
          const errText = _parseErrorBody(err.response.data) || '';

          // Content flagged (3030) — don't retry; caller should rewrite prompt
          if (errText.includes('3030')) {
            throw new CFSafetyRefusalError(`CF Worker content flagged (3030): ${errText}`);
          }

          // Quota exhausted (4006) — rotate to next URL (key stays active for other URLs)
          if (errText.includes('4006')) {
            config.markKeyStatus('cfurl', workerUrl, 'exhausted');
            console.warn(`[CFImageGen] Quota exhausted (4006) on ${workerUrl} — rotating to next URL`);
            break; // break key loop → outer loop tries next URL
          }

          // Auth / rate-limit — rotate key
          if (status === 429) {
            config.markKeyStatus('cf', key, 'rate-limited');
            console.warn(`[CFImageGen] Key rate-limited (429), rotating...`);
            continue;
          }
          if (status === 401 || status === 403) {
            config.markKeyStatus('cf', key, 'exhausted');
            console.warn(`[CFImageGen] Key invalid/forbidden (${status}), rotating...`);
            continue;
          }

          console.warn(`[CFImageGen] HTTP ${status} from ${workerUrl}: ${errText.slice(0, 200)}`);
          throw err; // unexpected HTTP error — propagate
        }

        // Network / timeout error — propagate immediately (no rotation helps)
        throw err;
      }
    }
    // URL exhausted all keys — log and try next URL
    console.warn(`[CFImageGen] All keys failed for ${workerUrl}, trying next URL...`);
  }

  throw new Error(`[CFImageGen] All CF Worker URLs and keys exhausted. Last error: ${lastError?.message}`);
}

module.exports = { generateImage, CFSafetyRefusalError };
