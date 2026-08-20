'use strict';
/**
 * Cloudflare Worker AI — Image generation via custom multipart Worker.
 *
 * FLUX.2 [klein] 9B multi-reference contract:
 *   - up to 4 input reference images;
 *   - every input reference must be smaller than 512x512;
 *   - output width/height are independent of reference dimensions.
 *
 * StreamVerse therefore keeps the final generated image at the production
 * portrait target 1024x1536 while resizing only the supplied reference images
 * to fit entirely inside a 511x511 bounding box without distorting them.
 */
const axios    = require('axios');
const FormData = require('form-data');
const sharp    = require('sharp');
const config   = require('./config');

const FLUX_REFERENCE_MAX_DIM = 511;
const OUTPUT_WIDTH = 1024;
const OUTPUT_HEIGHT = 1536;

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
function _checkNotJsonError(buf) {
  if (!buf || buf.length < 2) return;
  if (buf[0] !== 0x7B) return;
  try {
    const text   = buf.toString('utf8').slice(0, 600);
    const parsed = JSON.parse(text);
    if (parsed.error) {
      throw new Error(`CF Worker returned JSON error: ${parsed.error}`);
    }
  } catch (e) {
    if (e.message?.startsWith('CF Worker returned JSON error')) throw e;
  }
}

/**
 * Resize a reference image for FLUX.2 Klein multi-reference input.
 *
 * Cloudflare's current Workers AI documentation requires each reference image
 * to be smaller than 512x512. We preserve aspect ratio and fit the image inside
 * 511x511, so neither dimension can reach 512. The original high-resolution
 * generated output is never passed through this function.
 */
async function _prepareReferenceImage(buffer, index) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error(`[CFImageGen] Reference image ${index} is empty`);
  }

  const metadata = await sharp(buffer).metadata();
  const sourceWidth = Number(metadata.width || 0);
  const sourceHeight = Number(metadata.height || 0);
  if (!sourceWidth || !sourceHeight) {
    throw new Error(`[CFImageGen] Reference image ${index} has unreadable dimensions`);
  }

  const prepared = await sharp(buffer)
    .rotate()
    .resize({
      width: FLUX_REFERENCE_MAX_DIM,
      height: FLUX_REFERENCE_MAX_DIM,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  console.log(
    `[CFImageGen] Reference ${index + 1}: ${sourceWidth}x${sourceHeight} -> ` +
    `${prepared.info.width}x${prepared.info.height} (<512x512)`
  );

  return prepared.data;
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
 *   from whichever characters are actually present in the current scene.
 * @returns {Buffer} Raw image bytes (JPEG/PNG/WebP)
 */
async function generateImage(prompt, referenceImageUrls = [], seed = null, negativePrompt = null, characterMap = []) {
  const urlCount = config.cfWorkerUrls.length;
  const keyCount = config.cfWorkerKeys.length;

  if (urlCount === 0) throw new Error('[CFImageGen] No Cloudflare Worker URLs configured (CF_WORKER_URL)');
  if (keyCount === 0) throw new Error('[CFImageGen] No Cloudflare Worker keys configured (CF_WORKER_KEYS)');

  // Pre-fetch and normalize reference images (up to 4). Failures remain
  // non-fatal so another available reference can still be used.
  const refBuffers = [];
  for (const [index, url] of (referenceImageUrls || []).slice(0, 4).entries()) {
    try {
      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
      refBuffers.push(await _prepareReferenceImage(Buffer.from(r.data), index));
    } catch (e) {
      console.warn(`[CFImageGen] Skipping reference image ${index + 1}: ${e.message}`);
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
        // FLUX.2 Klein generates the production portrait at 1024x1536.
        // Reference dimensions are independent and are normalized above.
        form.append('width', String(OUTPUT_WIDTH));
        form.append('height', String(OUTPUT_HEIGHT));
        form.append('aspect_ratio', '9:16');

        if (Array.isArray(characterMap) && characterMap.length > 0) {
          form.append('characters', JSON.stringify(characterMap));
        }

        for (let i = 0; i < refBuffers.length; i++) {
          form.append(`input_image_${i}`, refBuffers[i], {
            filename: `ref_${i}.jpg`,
            contentType: 'image/jpeg',
          });
        }

        const resp = await axios.post(workerUrl, form, {
          headers: {
            ...form.getHeaders(),
            'Authorization': `Bearer ${key}`,
          },
          responseType: 'arraybuffer',
          timeout: 90000,
        });

        const buf = Buffer.from(resp.data);
        _checkNotJsonError(buf);

        if (buf.length < 100) {
          throw new Error(`CF Worker returned suspiciously small response (${buf.length} bytes)`);
        }

        config.markKeyStatus('cf', key, 'active');
        console.log(
          `[CFImageGen] Image generated (${buf.length} bytes, ${refBuffers.length} normalized ref image(s), ` +
          `output=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT})`
        );
        return buf;

      } catch (err) {
        lastError = err;

        if (err.message?.startsWith('CF Worker returned JSON error')) {
          const errText = err.message;
          if (errText.includes('3030')) {
            throw new CFSafetyRefusalError(`CF Worker content flagged (3030): ${errText}`);
          }
          if (errText.includes('4006')) {
            config.markKeyStatus('cfurl', workerUrl, 'exhausted');
            console.warn(`[CFImageGen] Quota exhausted (4006) on ${workerUrl} — rotating to next URL`);
            break;
          }
          throw err;
        }

        if (err.response) {
          const status  = err.response.status;
          const errText = _parseErrorBody(err.response.data) || '';

          if (errText.includes('3030')) {
            throw new CFSafetyRefusalError(`CF Worker content flagged (3030): ${errText}`);
          }

          if (errText.includes('4006')) {
            config.markKeyStatus('cfurl', workerUrl, 'exhausted');
            console.warn(`[CFImageGen] Quota exhausted (4006) on ${workerUrl} — rotating to next URL`);
            break;
          }

          if (status === 429) {
            config.markKeyStatus('cf', key, 'rate-limited');
            console.warn('[CFImageGen] Key rate-limited (429), rotating...');
            continue;
          }
          if (status === 401 || status === 403) {
            config.markKeyStatus('cf', key, 'exhausted');
            console.warn(`[CFImageGen] Key invalid/forbidden (${status}), rotating...`);
            continue;
          }

          console.warn(`[CFImageGen] HTTP ${status} from ${workerUrl}: ${errText.slice(0, 200)}`);
          throw err;
        }

        throw err;
      }
    }
    console.warn(`[CFImageGen] All keys failed for ${workerUrl}, trying next URL...`);
  }

  throw new Error(`[CFImageGen] All CF Worker URLs and keys exhausted. Last error: ${lastError?.message}`);
}

module.exports = {
  generateImage,
  CFSafetyRefusalError,
  FLUX_REFERENCE_MAX_DIM,
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
};
