'use strict';

/**
 * ============================================================================
 * StreamVerse Studio — Node → Python Video Engine Client
 * ============================================================================
 *
 * The ONLY place in the Node app that talks HTTP to the Python video
 * engine. Nothing else in StreamVerse should call the video engine
 * directly — this keeps the language boundary contained to one file.
 *
 *   Node pipeline → videoEngineClient → Python Video Engine → LTX/Agnes
 *
 * Media hand-off goes through Cloudinary exclusively, in both directions —
 * never a shared/local filesystem. Replit Autoscale gives no guarantee that
 * Node and the Python engine keep seeing the same disk across requests or
 * instances, so the image is uploaded to Cloudinary here and only its URL
 * is sent to Python; the engine likewise uploads the finished clip to
 * Cloudinary and returns its URL.
 * ============================================================================
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const config = require('../src/config');
const cloudinary = require('../src/cloudinary');

const client = axios.create({
  baseURL: config.videoEngineUrl,
  timeout: 20000,
  headers: config.videoEngineInternalKey
    ? { 'X-StreamVerse-Internal-Key': config.videoEngineInternalKey }
    : {},
});

function _detectMime(buf) {
  if (!buf || buf.length < 12) return 'image/png';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/png';
}

async function uploadSharedImage(imageBuffer, jobId, suffix = '') {
  const mime = _detectMime(imageBuffer);
  const safeSuffix = suffix ? `_${suffix}` : '';
  const publicId = `${config.shotsFolderRoot}/tmp/ltx_input_${jobId}${safeSuffix}`;
  return cloudinary.uploadImageFromUrl(`data:${mime};base64,${imageBuffer.toString('base64')}`, publicId);
}

/**
 * Submit a video-generation job to the Python engine.
 * Provider-specific fields are transported through this internal contract;
 * the Python provider decides which fields are legal for the external model.
 */
async function submitJob({
  provider = 'ltx',
  imageBuffer,
  prompt,
  duration,
  width,
  height,
  seed,
  randomizeSeed,
  enhancePrompt,
  negativePrompt,
  referenceImageBuffers = null,
}) {
  const jobId = uuidv4();
  const buffers = Array.isArray(referenceImageBuffers) && referenceImageBuffers.length
    ? referenceImageBuffers.filter(Buffer.isBuffer)
    : [imageBuffer];
  const referenceImageUrls = [];
  for (let i = 0; i < buffers.length; i++) {
    referenceImageUrls.push(await uploadSharedImage(buffers[i], jobId, `ref_${i}`));
  }
  // Keep image_url pointed at the authored/current still. Agnes keyframe mode
  // receives the complete ordered reference_image_urls array separately.
  const imageUrl = referenceImageUrls[referenceImageUrls.length - 1];

  const payload = {
    job_id: jobId,
    provider,
    image_url: imageUrl,
    prompt,
    duration,
    width,
    height,
    seed,
    randomize_seed: randomizeSeed,
    enhance_prompt: enhancePrompt,
    reference_image_urls: referenceImageUrls,
  };

  // Agnes-only field. Do not add this to LTX requests at the model boundary.
  if (provider === 'agnes' && typeof negativePrompt === 'string' && negativePrompt.trim()) {
    payload.negative_prompt = negativePrompt.trim();
  }

  const resp = await client.post('/internal/video/jobs', payload);

  return { jobId: resp.data.job_id, status: resp.data.status };
}

async function getJob(jobId) {
  const resp = await client.get(`/internal/video/jobs/${jobId}`);
  return resp.data;
}

async function cancelJob(jobId) {
  const resp = await client.post(`/internal/video/jobs/${jobId}/cancel`);
  return resp.data;
}

async function health() {
  const resp = await client.get('/health', { timeout: 5000 });
  return resp.data;
}

async function getTokenStatus() {
  try {
    const resp = await client.get('/internal/hf-tokens', { timeout: 8000 });
    return resp.data.tokens || [];
  } catch (err) {
    console.warn('[VideoEngineClient] getTokenStatus failed:', err.message);
    return [];
  }
}

async function pollJob(jobId, { intervalMs = 5000, maxAttempts = 180 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const job = await getJob(jobId);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') {
      const err = new Error(`[VideoEngine] Job ${jobId} failed: ${job.error?.message || 'unknown error'}`);
      err.category = job.error?.category;
      err.detail = job.error;
      throw err;
    }
    if (job.status === 'cancelled') {
      throw new Error(`[VideoEngine] Job ${jobId} was cancelled`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`[VideoEngine] Job ${jobId} did not complete after ${maxAttempts} polling attempts`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  submitJob,
  getJob,
  cancelJob,
  pollJob,
  health,
  uploadSharedImage,
  getTokenStatus,
};
