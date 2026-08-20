'use strict';
const axios      = require('axios');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const FormData   = require('form-data');
const config     = require('./config');

function _authHeader() {
  const creds = Buffer.from(`${config.cloudinaryApiKey}:${config.cloudinaryApiSecret}`).toString('base64');
  return `Basic ${creds}`;
}

/**
 * Build a signed upload parameter set.
 * Cloudinary requires a SHA-1 signature over sorted params (excluding file,
 * api_key, resource_type, and cloud_name) appended with the api_secret.
 * This lets us set any public_id, overwrite, etc. regardless of preset restrictions.
 */
function _buildSignedParams(extraParams) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signable  = { ...extraParams, timestamp };
  // Sort keys alphabetically and build the string to sign
  const toSign = Object.keys(signable)
    .sort()
    .map(k => `${k}=${signable[k]}`)
    .join('&');
  const signature = crypto
    .createHash('sha1')
    .update(toSign + config.cloudinaryApiSecret)
    .digest('hex');
  return { ...signable, api_key: config.cloudinaryApiKey, signature };
}

/**
 * Upload a video from a URL or base64 data URI to Cloudinary using a signed request.
 * Signed uploads work regardless of upload-preset restrictions on public_id / overwrite.
 * Returns the secure_url of the uploaded resource.
 */
async function uploadVideoFromUrl(sourceUrl, publicId) {
  const signed = _buildSignedParams({ public_id: publicId, overwrite: 'true' });
  const params = new URLSearchParams({ file: sourceUrl, resource_type: 'video', ...signed });
  const resp = await axios.post(
    `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/video/upload`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 120000 }
  );
  if (!resp.data?.secure_url) {
    throw new Error(`Cloudinary video upload failed: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  return resp.data.secure_url;
}

/**
 * Upload a video from a raw buffer to Cloudinary using the signed upload.
 */
async function uploadVideoBuffer(buffer, publicId) {
  const dataUri = `data:video/mp4;base64,${buffer.toString('base64')}`;
  return uploadVideoFromUrl(dataUri, publicId);
}

/**
 * Upload an image from URL or data URI using a signed request.
 * Signed uploads work regardless of upload-preset restrictions on public_id / overwrite.
 */
async function uploadImageFromUrl(sourceUrl, publicId) {
  const signed = _buildSignedParams({ public_id: publicId, overwrite: 'true' });
  const params = new URLSearchParams({ file: sourceUrl, resource_type: 'image', ...signed });
  const resp = await axios.post(
    `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/image/upload`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 60000 }
  );
  if (!resp.data?.secure_url) {
    throw new Error(`Cloudinary image upload failed: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }
  return resp.data.secure_url;
}

/**
 * List all video resources under a folder prefix.
 * Returns sorted array of { public_id, secure_url }.
 */
async function listFolder(folderPrefix) {
  const resp = await axios.get(
    `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/resources/video/upload`,
    {
      params:  { prefix: folderPrefix, type: 'upload', max_results: 500 },
      headers: { Authorization: _authHeader() },
      timeout: 30000,
    }
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Cloudinary folder list failed: ${JSON.stringify(resp.data)}`);
  }
  return (resp.data.resources || [])
    .sort((a, b) => a.public_id.localeCompare(b.public_id));
}

/**
 * Delete a resource by public_id.
 */
async function deleteResource(publicId, resourceType = 'video') {
  try {
    await axios.delete(
      `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/resources/${resourceType}/upload`,
      {
        params:  { public_ids: [publicId] },
        headers: { Authorization: _authHeader() },
        timeout: 30000,
      }
    );
  } catch (err) {
    console.warn(`[Cloudinary] Failed to delete ${publicId}:`, err.message);
  }
}

/**
 * Build the public_id for the persistent scene background reference image.
 * Stored outside the tmp/ folder so it is NOT deleted by the episode cleanup loop.
 * Pattern: {shotsFolderRoot}/{storylineId}/ep{NNNN}/scene_{NN}/bg_ref
 *
 * storylineId is included so assets from different storylines with the same
 * episode number never share a path (globalEpisodeNumber is per-storyline, so
 * two active storylines can legitimately both be on episode 1).
 */
function sceneBgPublicId(storylineId, episodeNumber, sceneNumber) {
  return [
    config.shotsFolderRoot,
    storylineId,
    `ep${String(episodeNumber).padStart(4, '0')}`,
    `scene_${String(sceneNumber).padStart(2, '0')}`,
    'bg_ref',
  ].join('/');
}

/**
 * Build the public_id for a shot clip.
 * Pattern: {shotsFolderRoot}/ep{NNNN}/scene_{NN}/shot_{NN}
 * Human-readable: e.g. streamverse/shots/ep0003/scene_02/shot_04
 */
function shotPublicId(storylineId, episodeNumber, sceneNumber, shotIndex) {
  return [
    config.shotsFolderRoot,
    `ep${String(episodeNumber).padStart(4, '0')}`,
    `scene_${String(sceneNumber).padStart(2, '0')}`,
    `shot_${String(shotIndex).padStart(2, '0')}`,
  ].join('/');
}

/**
 * Build the permanent public_id for a shot's generated still image.
 * These stills are retained so a resumed/failed shot can reuse its existing
 * image instead of calling the CF Worker again.
 */
function shotImagePublicId(storylineId, episodeNumber, sceneNumber, shotIndex) {
  return [
    config.shotsFolderRoot,
    storylineId,
    `ep${String(episodeNumber).padStart(4, '0')}`,
    `scene_${String(sceneNumber).padStart(2, '0')}`,
    `shot_${String(shotIndex).padStart(2, '0')}`,
    'still',
  ].join('/');
}

/**
 * Build the public_id for a compiled scene video.
 * Pattern: {shotsFolderRoot}/ep{NNNN}/scene_{NN}/compiled
 */
function scenePublicId(episodeNumber, sceneNumber) {
  return [
    config.shotsFolderRoot,
    `ep${String(episodeNumber).padStart(4, '0')}`,
    `scene_${String(sceneNumber).padStart(2, '0')}`,
    'compiled',
  ].join('/');
}

/**
 * Build the public_id for a final episode video.
 * Pattern: {episodeFolderRoot}/ep{NNNN}
 */
function episodePublicId(storylineId, episodeNumber) {
  return `${config.episodeFolderRoot}/ep${String(episodeNumber).padStart(4, '0')}`;
}

/**
 * Build a deliverable Cloudinary image URL from a public_id.
 * Used to turn a stored imageTmpPublicId back into a URL that can be
 * passed as a reference image to the CF Worker for scene-BG consistency.
 */
function imageDeliveryUrl(publicId) {
  if (!publicId) return null;
  return `https://res.cloudinary.com/${config.cloudinaryCloudName}/image/upload/${publicId}`;
}

/**
 * Build a frontend-safe thumbnail URL for a video, given its (server-side
 * only) Cloudinary video URL. This is the only Cloudinary-derived value that
 * should ever reach the public API/frontend — never the raw playable video
 * URL, which stays behind the ad-gated streaming gateway.
 */
function videoThumbnailUrl(cloudinaryVideoUrl) {
  if (!cloudinaryVideoUrl || !cloudinaryVideoUrl.includes('/video/upload/')) return null;
  return cloudinaryVideoUrl.replace('/video/upload/', '/video/upload/so_2,w_640,h_360,c_fill,f_jpg/');
}

module.exports = {
  uploadVideoFromUrl,
  uploadVideoBuffer,
  uploadImageFromUrl,
  listFolder,
  deleteResource,
  sceneBgPublicId,
  shotPublicId,
  shotImagePublicId,
  scenePublicId,
  episodePublicId,
  imageDeliveryUrl,
  videoThumbnailUrl,
  trimVideoUrl,
};
/**
 * Return a Cloudinary video delivery URL trimmed to [start,end] seconds.
 * This is a non-destructive transformation; the original uploaded asset
 * remains untouched. Cloudinary evaluates the temporal transformation at
 * delivery time, so HIL can change the trim without re-uploading the source.
 */
function trimVideoUrl(videoUrl, startSeconds, endSeconds) {
  if (!videoUrl || !videoUrl.includes('/video/upload/')) return videoUrl || null;

  const start = Number(startSeconds);
  const end = Number(endSeconds);
  if (!Number.isFinite(start) || start < 0) return videoUrl;
  if (Number.isFinite(end) && end > start) {
    return videoUrl.replace('/video/upload/', `/video/upload/so_${start},eo_${end}/`);
  }
  return videoUrl.replace('/video/upload/', `/video/upload/so_${start}/`);
}


