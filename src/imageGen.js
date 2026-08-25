'use strict';
/**
 * StreamVerse Image Generation Router
 *
 * All image generation — shots, character portraits, scene images — is routed
 * exclusively through the Cloudflare Worker AI endpoint.
 *
 * CFSafetyRefusalError is re-thrown immediately so the caller (pipeline) can
 * rewrite the prompt instead of retrying the same flagged text.
 */
const config     = require('./config');
const cfImageGen = require('./cfImageGen');
const { CFSafetyRefusalError } = cfImageGen;

async function generateImage(prompt, referenceImageUrls = [], seed = null, negativePrompt = null, characterMap = []) {
  if (config.cfWorkerUrls.length === 0 || config.cfWorkerKeys.length === 0) {
    throw new Error('[ImageGen] No image generation backend configured (CF_WORKER_URL + CF_WORKER_KEYS required)');
  }

  return cfImageGen.generateImage(prompt, referenceImageUrls, seed, negativePrompt, characterMap);
}

module.exports = { generateImage, CFSafetyRefusalError };
