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
 */
function _buildSignedParams(extraParams) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signable  = { ...extraParams, timestamp };
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

function _isTransientUploadError(err) {
  const status = Number(err?.response?.status);
  return [408, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)
    || ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(err?.code);
}

function _uploadError(prefix, err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const body = data
    ? (typeof data === 'string' ? data : JSON.stringify(data))
    : err?.message || 'unknown error';
  const out = new Error(
    `${prefix}${status ? ` HTTP ${status}` : ''}: ${body.slice(0, 1000)}`
  );
  out.code = err?.code;
  out.status = status;
  out.cause = err;
  return out;
}

async function _postSignedUpload(resourceType, sourceUrl, publicId, timeoutMs) {
  const signed = _buildSignedParams({ public_id: publicId, overwrite: 'true' });
  const params = new URLSearchParams({ file: sourceUrl, resource_type: resourceType, ...signed });
  const endpoint = `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/${resourceType}/upload`;
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.post(
        endpoint,
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: timeoutMs,
          validateStatus: () => true,
        }
      );

      if (resp.status >= 200 && resp.status < 300) {
        return resp;
      }

      const err = new Error(`Cloudinary upload HTTP ${resp.status}`);
      err.response = resp;
      throw err;
    } catch (err) {
      if (!_isTransientUploadError(err) || attempt >= maxAttempts) {
        throw err;
      }

      const retryAfter = Number(err?.response?.headers?.['retry-after']);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30000)
        : Math.min(30000, 1000 * (2 ** (attempt - 1)));

      console.warn(
        `[Cloudinary] ${resourceType} upload transient failure ` +
        `attempt ${attempt}/${maxAttempts} — retrying in ${delay}ms ` +
        `(status=${err?.response?.status || 'network'}, code=${err?.code || 'n/a'})`
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Cloudinary upload exhausted retries');
}

/**
 * Upload a video from a URL or base64 data URI to Cloudinary using a signed request.
 * Node is the canonical shot-video uploader for all video providers.
 */
async function uploadVideoFromUrl(sourceUrl, publicId) {
  try {
    const resp = await _postSignedUpload('video', sourceUrl, publicId, 120000);
    if (!resp.data?.secure_url) {
      throw new Error(`Cloudinary video upload returned no secure_url: ${JSON.stringify(resp.data).slice(0, 500)}`);
    }
    console.log(`[Cloudinary] Video uploaded | publicId=${publicId}`);
    return resp.data.secure_url;
  } catch (err) {
    throw _uploadError(`[Cloudinary] Video upload failed for ${publicId}`, err);
  }
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
 */
async function uploadImageFromUrl(sourceUrl, publicId) {
  try {
    const resp = await _postSignedUpload('image', sourceUrl, publicId, 60000);
    if (!resp.data?.secure_url) {
      throw new Error(`Cloudinary image upload returned no secure_url: ${JSON.stringify(resp.data).slice(0, 500)}`);
    }
    return resp.data.secure_url;
  } catch (err) {
    throw _uploadError(`[Cloudinary] Image upload failed for ${publicId}`, err);
  }
}

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

function sceneBgPublicId(storylineId, episodeNumber, sceneNumber) {
  return [
    config.shotsFolderRoot,
    storylineId,
    `ep${String(episodeNumber).padStart(4, '0')}`,
    `scene_${String(sceneNumber).padStart(2, '0')}`,
    'bg_ref',
  ].join('/');
}

function shotPublicId(storylineId, episodeNumber, sceneNumber, shotIndex) {
  return [
    config.shotsFolderRoot,
    `ep${String(episodeNumber).padStart(4, '0')}`,
    `scene_${String(sceneNumber).padStart(2, '0')}`,
    `shot_${String(shotIndex).padStart(2, '0')}`,
  ].join('/');
}

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

function scenePublicId(episodeNumber, sceneNumber) {
  return [
    config.shotsFolderRoot,
    `ep${String(episodeNumber).padStart(4, '0')}`,
    `scene_${String(sceneNumber).padStart(2, '0')}`,
    'compiled',
  ].join('/');
}

function episodePublicId(storylineId, episodeNumber) {
  return `${config.episodeFolderRoot}/ep${String(episodeNumber).padStart(4, '0')}`;
}

function imageDeliveryUrl(publicId) {
  if (!publicId) return null;
  return `https://res.cloudinary.com/${config.cloudinaryCloudName}/image/upload/${publicId}`;
}

function videoThumbnailUrl(cloudinaryVideoUrl) {
  if (!cloudinaryVideoUrl || !cloudinaryVideoUrl.includes('/video/upload/')) return null;
  return cloudinaryVideoUrl.replace('/video/upload/', '/video/upload/so_2,w_640,h_360,c_fill,f_jpg/');
}

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
