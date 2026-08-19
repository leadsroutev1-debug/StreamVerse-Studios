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
 *   Node pipeline → videoEngineClient → Python Video Engine → LTX Space
 *
 * Media hand-off goes through Cloudinary exclusively, in both directions —
 * never a shared/local filesystem. Replit Autoscale gives no guarantee that
 * Node and the Python engine keep seeing the same disk across requests or
 * instances, so the image is uploaded to Cloudinary here and only its URL
 * is sent to Python; the engine likewise uploads the finished clip to
 * Cloudinary and returns its URL (see video_engine/cloudinary_client.py).
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

/**
 * Upload an image buffer to Cloudinary so the Python engine can hand its
 * URL straight to the model (gradio's handle_file() accepts remote URLs
 * directly — the Space fetches it server-side).
 */
async function uploadSharedImage(imageBuffer, jobId) {
  const mime = _detectMime(imageBuffer);
  const publicId = `${config.shotsFolderRoot}/tmp/ltx_input_${jobId}`;
  return cloudinary.uploadImageFromUrl(`data:${mime};base64,${imageBuffer.toString('base64')}`, publicId);
}

/**
 * Submit a video-generation job to the Python engine. Returns immediately
 * with an ack — the engine runs the (potentially multi-minute) generation
 * asynchronously.
 */
async function submitJob({ provider = 'ltx', imageBuffer, prompt, duration, width, height, seed, randomizeSeed, enhancePrompt }) {
  const jobId = uuidv4();
  const imageUrl = await uploadSharedImage(imageBuffer, jobId);

  const resp = await client.post('/internal/video/jobs', {
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
  });

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

/**
 * Sticky/linear HF token pool status, for the dashboard's token panel.
 * Returns [] (rather than throwing) if the video engine is unreachable or
 * not running LTX, so the dashboard can render an empty/greyed panel
 * instead of erroring out the whole status poll.
 */
async function getTokenStatus() {
  try {
    const resp = await client.get('/internal/hf-tokens', { timeout: 8000 });
    return resp.data.tokens || [];
  } catch (err) {
    console.warn('[VideoEngineClient] getTokenStatus failed:', err.message);
    return [];
  }
}

/**
 * Poll a job until it reaches a terminal state.
 * Returns the job's public dict on completion, throws on failure/timeout.
 */
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
