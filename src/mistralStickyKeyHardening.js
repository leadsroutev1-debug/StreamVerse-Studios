'use strict';

/**
 * StreamVerse Mistral key-rotation hardening.
 *
 * Policy:
 *   - Stay on the current Mistral key while it is healthy.
 *   - Rotate only for provider/account conditions that justify rotation:
 *       401 / 402 / 403 / 429.
 *   - 400/404/422 request-contract errors, malformed JSON, truncation,
 *     network errors and 5xx responses must NOT burn the current key.
 *   - The existing callers may still call markKeyStatus('exhausted') for
 *     generic failures; this preload normalizes that status using the actual
 *     HTTP failure observed by Axios so healthy keys remain sticky.
 *
 * This is intentionally a runtime policy layer so all existing Mistral
 * callers share the same behavior without duplicating rotation logic.
 */

const Module = require('module');
const originalLoad = Module._load;
const PATCHED = Symbol.for('streamverse.mistral.sticky.hardened');
const failureReasonByKey = new Map();
const mistralCursor = { index: 0 };

function maskKey(key) {
  const value = String(key || '');
  if (value.length < 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isMistralUrl(url) {
  return typeof url === 'string' && /api\.mistral\.ai\/v1\/chat\/completions/i.test(url);
}

function isRotationStatus(status) {
  return [401, 402, 403, 429].includes(Number(status));
}

function rememberFailure(key, status) {
  if (!key) return;
  failureReasonByKey.set(maskKey(key), isRotationStatus(status));
}

function patchConfig(config) {
  if (!config || config[PATCHED]) return config;
  if (!Array.isArray(config.mistralKeys) || config.mistralKeys.length === 0) return config;

  const originalMarkKeyStatus = config.markKeyStatus;

  config.markKeyStatus = function hardenedMarkKeyStatus(pool, key, status) {
    if (pool === 'mistral') {
      const label = maskKey(key);
      const actualFailureJustifiesRotation = failureReasonByKey.get(label);

      // Existing callers historically treated generic failures as
      // "exhausted". Do not let that silently rotate a healthy key.
      if (status === 'exhausted' && actualFailureJustifiesRotation === false) {
        status = 'active';
      }

      if (status === 'active') failureReasonByKey.delete(label);
    }

    return originalMarkKeyStatus.call(this, pool, key, status);
  };

  config.getNextMistralKey = function stickyMistralKey() {
    const pool = config.mistralKeys;
    if (!pool || pool.length === 0) {
      throw new Error('No keys configured for pool: mistral');
    }

    const health = config.keyHealth?.mistral || [];

    // Keep the cursor on the same key until its health explicitly becomes
    // exhausted/rate-limited. This is deliberately not round-robin.
    for (let offset = 0; offset < pool.length; offset += 1) {
      const idx = (mistralCursor.index + offset) % pool.length;
      const key = pool[idx];
      const label = maskKey(key);
      const entry = health.find(item => item.label === label);
      const status = String(entry?.status || 'active').toLowerCase();

      if (!['exhausted', 'rate-limited'].includes(status)) {
        mistralCursor.index = idx;
        return key;
      }
    }

    // Every key is unavailable. Preserve the old behavior as a last-resort
    // attempt rather than silently throwing away the configured pool.
    const key = pool[mistralCursor.index % pool.length];
    mistralCursor.index = (mistralCursor.index + 1) % pool.length;
    return key;
  };

  Object.defineProperty(config, PATCHED, { value: true, enumerable: false });
  console.log('[MistralRotation] Sticky key policy enabled: rotate only on 401/402/403/429.');
  return config;
}

function patchAxios(axios) {
  if (!axios || axios[PATCHED]) return axios;
  const originalPost = axios.post.bind(axios);

  axios.post = async function hardenedMistralPost(url, data, options, ...rest) {
    if (!isMistralUrl(url)) return originalPost(url, data, options, ...rest);

    const authorization = options?.headers?.Authorization || options?.headers?.authorization || '';
    const key = String(authorization).replace(/^Bearer\s+/i, '').trim();

    try {
      return await originalPost(url, data, options, ...rest);
    } catch (error) {
      rememberFailure(key, error?.response?.status);
      throw error;
    }
  };

  Object.defineProperty(axios, PATCHED, { value: true, enumerable: false });
  return axios;
}

Module._load = function streamVerseMistralRotationLoad(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);

  if (request === 'axios') return patchAxios(loaded);
  if (request === './config' || /[\\/]config\.js$/.test(String(request || ''))) return patchConfig(loaded);

  return loaded;
};

module.exports = { isRotationStatus, maskKey };
