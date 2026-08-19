'use strict';

const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const config = require('./config');

/**
 * Cloudflare Workers AI — FLUX.2 [klein] 9B image generation/editing.
 *
 * Production contract:
 *   - prompt is the cinematic scene-image prompt
 *   - input_image_0..3 are binary reference images
 *   - reference images are resized to <=512x512 before transmission
 *   - output is a 9:16 high-resolution image for the LTX I2V stage
 *   - seed and guidance are passed through for reproducibility/control
 *   - characterMap is metadata used by the custom Worker to bind reference
 *     indices to character identities
 *
 * FLUX.2 klein 9B supports up to four reference images, but the reference
 * inputs must be named explicitly and kept below 512x512. The model's
 * distilled sampler has fixed steps, so this client deliberately does not
 * expose or invent a steps parameter.
 */

class CFSafetyRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CFSafetyRefusalError';
  }
}

function _parseErrorBody(data) {
  if (!data) return null;
  try {
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : (data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : String(data));
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      return parsed.error || trimmed;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function _checkNotJsonError(buf) {
  if (!buf || buf.length < 2 || buf[0] !== 0x7B) return;
  try {
    const parsed = JSON.parse(buf.toString('utf8').slice(0, 600));
    if (parsed.error) throw new Error(`CF Worker returned JSON error: ${parsed.error}`);
  } catch (e) {
    if (e.message?.startsWith('CF Worker returned JSON error')) throw e;
  }
}

/**
 * Resize a reference image to the Workers AI multi-reference limit without
 * changing its semantic framing. Contain preserves the whole character
 * reference and pads transparent/empty areas rather than cropping faces.
 * JPEG is used because the Worker only needs a compact binary reference.
 */
async function _prepareReferenceImage(buffer) {
  return sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(512, 512, { fit: 'contain', withoutEnlargement: true })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}

function _generationFingerprint(prompt, referenceImageUrls, seed, negativePrompt, characterMap) {
  return crypto.createHash('sha256').update(JSON.stringify({
    prompt: String(prompt || ''),
    refs: Array.isArray(referenceImageUrls) ? referenceImageUrls : [],
    seed: seed ?? null,
    negativePrompt: String(negativePrompt || ''),
    characterMap: Array.isArray(characterMap) ? characterMap : [],
    width: Number(process.env.CF_IMAGE_WIDTH || 1024),
    height: Number(process.env.CF_IMAGE_HEIGHT || 1536),
    guidance: Number(process.env.CF_IMAGE_GUIDANCE || 3.5),
  })).digest('hex');
}

function _resolveGuidance() {
  const value = Number(process.env.CF_IMAGE_GUIDANCE || 3.5);
  return Number.isFinite(value) ? Math.max(0, Math.min(20, value)) : 3.5;
}

function _resolveDimension(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value >= 256 && value <= 1920 ? Math.floor(value) : fallback;
}

async function _generateImageOnce(prompt, referenceImageUrls = [], seed = null, negativePrompt = null, characterMap = []) {
  const urlCount = config.cfWorkerUrls.length;
  const keyCount = config.cfWorkerKeys.length;
  if (urlCount === 0) throw new Error('[CFImageGen] No Cloudflare Worker URLs configured (CF_WORKER_URL)');
  if (keyCount === 0) throw new Error('[CFImageGen] No Cloudflare Worker keys configured (CF_WORKER_KEYS)');

  const width = _resolveDimension('CF_IMAGE_WIDTH', 1024);
  const height = _resolveDimension('CF_IMAGE_HEIGHT', 1536);
  const guidance = _resolveGuidance();

  const refBuffers = [];
  for (const url of (referenceImageUrls || []).slice(0, 4)) {
    try {
      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
      refBuffers.push(await _prepareReferenceImage(Buffer.from(r.data)));
    } catch (e) {
      console.warn(`[CFImageGen] Skipping reference image (fetch/resize failed): ${e.message}`);
    }
  }

  let lastError;
  for (let urlAttempt = 0; urlAttempt < urlCount; urlAttempt++) {
    const workerUrl = config.getNextCfUrl();
    for (let keyAttempt = 0; keyAttempt < keyCount; keyAttempt++) {
      const key = config.getNextCfKey();
      try {
        const form = new FormData();
        form.append('prompt', String(prompt || '').trim());
        form.append('width', String(width));
        form.append('height', String(height));
        form.append('guidance', String(guidance));
        if (Number.isInteger(Number(seed)) && Number(seed) >= 0) {
          form.append('seed', String(Math.min(2147483647, Number(seed))));
        }
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
          headers: { ...form.getHeaders(), Authorization: `Bearer ${key}` },
          responseType: 'arraybuffer',
          timeout: 120000,
        });

        const buf = Buffer.from(resp.data);
        _checkNotJsonError(buf);
        if (buf.length < 100) throw new Error(`CF Worker returned suspiciously small response (${buf.length} bytes)`);

        config.markKeyStatus('cf', key, 'active');
        console.log(`[CFImageGen] Image generated (${buf.length} bytes, ${refBuffers.length} prepared refs, ${width}x${height}, guidance=${guidance})`);
        return buf;
      } catch (err) {
        lastError = err;
        if (err.message?.startsWith('CF Worker returned JSON error')) {
          const errText = err.message;
          if (errText.includes('3030')) throw new CFSafetyRefusalError(`CF Worker content flagged (3030): ${errText}`);
          if (errText.includes('4006')) {
            config.markKeyStatus('cfurl', workerUrl, 'exhausted');
            console.warn(`[CFImageGen] Quota exhausted (4006) on ${workerUrl} — rotating to next URL`);
            break;
          }
          throw err;
        }
        if (err.response) {
          const status = err.response.status;
          const errText = _parseErrorBody(err.response.data) || '';
          if (errText.includes('3030')) throw new CFSafetyRefusalError(`CF Worker content flagged (3030): ${errText}`);
          if (errText.includes('4006')) {
            config.markKeyStatus('cfurl', workerUrl, 'exhausted');
            console.warn(`[CFImageGen] Quota exhausted (4006) on ${workerUrl} — rotating to next URL`);
            break;
          }
          if (status === 429) {
            config.markKeyStatus('cf', key, 'rate-limited');
            continue;
          }
          if (status === 401 || status === 403) {
            config.markKeyStatus('cf', key, 'exhausted');
            continue;
          }
          console.warn(`[CFImageGen] HTTP ${status} from ${workerUrl}: ${errText.slice(0, 200)}`);
          throw err;
        }
        throw err;
      }
    }
  }

  throw new Error(`[CFImageGen] All CF Worker URLs and keys exhausted. Last error: ${lastError?.message}`);
}

const _inFlightGenerations = new Map();

async function generateImage(prompt, referenceImageUrls = [], seed = null, negativePrompt = null, characterMap = []) {
  const fingerprint = _generationFingerprint(prompt, referenceImageUrls, seed, negativePrompt, characterMap);
  const existing = _inFlightGenerations.get(fingerprint);
  if (existing) {
    console.warn(`[CFImageGen] Reusing identical in-flight generation ${fingerprint.slice(0, 12)} — duplicate request suppressed`);
    return Buffer.from(await existing);
  }

  const promise = _generateImageOnce(prompt, referenceImageUrls, seed, negativePrompt, characterMap);
  _inFlightGenerations.set(fingerprint, promise);
  try {
    return Buffer.from(await promise);
  } finally {
    if (_inFlightGenerations.get(fingerprint) === promise) _inFlightGenerations.delete(fingerprint);
  }
}

module.exports = { generateImage, CFSafetyRefusalError };
