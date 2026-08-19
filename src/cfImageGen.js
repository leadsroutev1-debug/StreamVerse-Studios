'use strict';

const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const config = require('./config');

/**
 * Cloudflare Workers AI — FLUX.2 [klein] 9B image generation/editing.
 *
 * Production media contract:
 *   - input_image_0..3 are binary character/style references only.
 *   - ONLY those reference inputs are normalized for Cloudflare's documented
 *     multi-reference constraint: BOTH dimensions must be strictly < 512px.
 *   - The generated cinematic frame is NEVER resized, cropped, padded or
 *     recompressed after generation.
 *   - The canonical generated scene frame is ALWAYS exactly 1024x1536.
 *   - width/height are sent as explicit multipart fields on every request.
 *   - A provider returning another geometry is a provider-contract failure;
 *     it is retried once before the key/worker is rotated. It is NEVER repaired
 *     locally because doing so would violate the LTX first-frame contract.
 */

const CF_OUTPUT_WIDTH = 1024;
const CF_OUTPUT_HEIGHT = 1536;
const CF_MAX_REFERENCE_DIMENSION = 511;
const CF_GEOMETRY_RETRIES = 1;

class CFSafetyRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CFSafetyRefusalError';
  }
}

class CFOutputValidationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CFOutputValidationError';
    this.detail = detail;
    this.retryable = true;
    this.providerContractFailure = true;
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
 * Prepare ONLY a reference image for FLUX.2's multi-reference input
 * constraint. Preserve the entire reference with aspect-ratio-safe scaling.
 * Never use this helper on the generated cinematic frame.
 */
async function _prepareReferenceImage(buffer) {
  return sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({
      width: CF_MAX_REFERENCE_DIMENSION,
      height: CF_MAX_REFERENCE_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
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
    width: CF_OUTPUT_WIDTH,
    height: CF_OUTPUT_HEIGHT,
    guidance: Number(process.env.CF_IMAGE_GUIDANCE || 3.5),
  })).digest('hex');
}

function _resolveGuidance() {
  const value = Number(process.env.CF_IMAGE_GUIDANCE || 3.5);
  return Number.isFinite(value) ? Math.max(0, Math.min(20, value)) : 3.5;
}

async function _validateGeneratedSceneImage(buf) {
  let metadata;
  try {
    metadata = await sharp(buf, { failOn: 'none' }).metadata();
  } catch (err) {
    throw new CFOutputValidationError(`Generated CF image is not a decodable image: ${err.message}`);
  }

  if (metadata.width !== CF_OUTPUT_WIDTH || metadata.height !== CF_OUTPUT_HEIGHT) {
    throw new CFOutputValidationError(
      `Cloudflare returned ${metadata.width || '?'}x${metadata.height || '?'}; expected ${CF_OUTPUT_WIDTH}x${CF_OUTPUT_HEIGHT}. Refusing to resize/crop the cinematic frame before LTX I2V.`,
      {
        actualWidth: metadata.width,
        actualHeight: metadata.height,
        expectedWidth: CF_OUTPUT_WIDTH,
        expectedHeight: CF_OUTPUT_HEIGHT,
      },
    );
  }

  return metadata;
}

function _geometryContractPrompt(prompt) {
  // Geometry is controlled by the API fields, not by natural-language prompt
  // text. This reminder is intentionally short and does not attempt to make
  // the model choose a resolution itself.
  return String(prompt || '').trim();
}

async function _generateImageOnce(prompt, referenceImageUrls = [], seed = null, negativePrompt = null, characterMap = []) {
  const urlCount = config.cfWorkerUrls.length;
  const keyCount = config.cfWorkerKeys.length;
  if (urlCount === 0) throw new Error('[CFImageGen] No Cloudflare Worker URLs configured (CF_WORKER_URL)');
  if (keyCount === 0) throw new Error('[CFImageGen] No Cloudflare Worker keys configured (CF_WORKER_KEYS)');

  // Production output geometry is intentionally NOT configurable. The LTX
  // layer consumes this image unchanged as its first-frame condition.
  const width = CF_OUTPUT_WIDTH;
  const height = CF_OUTPUT_HEIGHT;
  const guidance = _resolveGuidance();
  const finalPrompt = _geometryContractPrompt(prompt);

  const refs = (referenceImageUrls || []).slice(0, 4);
  const refBuffers = [];
  for (const url of refs) {
    try {
      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
      const prepared = await _prepareReferenceImage(Buffer.from(r.data));
      const meta = await sharp(prepared, { failOn: 'none' }).metadata();
      if (!meta.width || !meta.height || meta.width >= 512 || meta.height >= 512) {
        throw new Error(`prepared reference is ${meta.width || '?'}x${meta.height || '?'}; both dimensions must be <512`);
      }
      refBuffers.push(prepared);
    } catch (e) {
      console.warn(`[CFImageGen] Skipping reference image (fetch/preparation failed): ${e.message}`);
    }
  }

  let lastError;
  for (let urlAttempt = 0; urlAttempt < urlCount; urlAttempt++) {
    const workerUrl = config.getNextCfUrl();
    for (let keyAttempt = 0; keyAttempt < keyCount; keyAttempt++) {
      const key = config.getNextCfKey();
      let geometryRetry = 0;

      while (true) {
        try {
          const form = new FormData();
          // Cloudflare's official REST contract uses multipart fields named
          // exactly prompt/width/height/guidance/seed/input_image_0..3.
          form.append('prompt', finalPrompt);
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

          console.log(`[CFImageGen] Requesting ${width}x${height} | refs=${refBuffers.length}/${refs.length} | worker=${urlAttempt + 1}/${urlCount} key=${keyAttempt + 1}/${keyCount}`);

          const resp = await axios.post(workerUrl, form, {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${key}` },
            responseType: 'arraybuffer',
            timeout: 120000,
          });

          const buf = Buffer.from(resp.data);
          _checkNotJsonError(buf);
          if (buf.length < 100) throw new Error(`CF Worker returned suspiciously small response (${buf.length} bytes)`);

          await _validateGeneratedSceneImage(buf);

          config.markKeyStatus('cf', key, 'active');
          console.log(`[CFImageGen] Image generated (${buf.length} bytes, ${refBuffers.length}/${refs.length} refs prepared, references<512=true, output=${width}x${height}, guidance=${guidance})`);
          return buf;
        } catch (err) {
          lastError = err;

          if (err instanceof CFOutputValidationError) {
            const actual = `${err.detail?.actualWidth || '?'}x${err.detail?.actualHeight || '?'}`;
            console.warn(`[CFImageGen] PROVIDER GEOMETRY MISMATCH: requested ${width}x${height}, received ${actual} from ${workerUrl}. No resize/crop will be attempted.`);
            if (geometryRetry < CF_GEOMETRY_RETRIES) {
              geometryRetry += 1;
              await new Promise(resolve => setTimeout(resolve, 750));
              console.warn(`[CFImageGen] Retrying exact ${width}x${height} request (${geometryRetry}/${CF_GEOMETRY_RETRIES}) before rotating credentials.`);
              continue;
            }
            // The provider contract is still wrong after a targeted retry.
            // Rotate to the next credential/worker rather than deadlocking the
            // production state machine on one malformed response.
            break;
          }

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
              break;
            }
            if (status === 401 || status === 403) {
              config.markKeyStatus('cf', key, 'exhausted');
              break;
            }
            console.warn(`[CFImageGen] HTTP ${status} from ${workerUrl}: ${errText.slice(0, 200)}`);
            break;
          }

          break;
        }
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

module.exports = { generateImage, CFSafetyRefusalError, CFOutputValidationError };