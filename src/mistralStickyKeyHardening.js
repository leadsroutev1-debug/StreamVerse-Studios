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
 *   - 429 is treated as a temporary rate-limit cooldown, not a permanent
 *     credential failure. The same key is not hammered while its cooldown is
 *     active, and the retry path honors Retry-After when the provider sends it.
 *   - If every key is rate-limited, the runtime waits for the earliest
 *     cooldown instead of immediately cycling through the whole pool.
 */

const Module = require('module');
const originalLoad = Module._load;
const PATCHED = Symbol.for('streamverse.mistral.sticky.hardened');
const failureReasonByKey = new Map();
const rateLimitUntilByKey = new Map();
const rateLimitCountByKey = new Map();
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

function isRateLimitedStatus(status) {
  return Number(status) === 429;
}

function retryAfterMs(error, key) {
  const header = error?.response?.headers?.['retry-after'] ?? error?.response?.headers?.['Retry-After'];
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120000, seconds * 1000);

  const count = (rateLimitCountByKey.get(maskKey(key)) || 0) + 1;
  rateLimitCountByKey.set(maskKey(key), count);
  return Math.min(60000, 2000 * (2 ** Math.min(count - 1, 5)));
}

function rememberFailure(key, status, error) {
  if (!key) return;
  const label = maskKey(key);
  const rotation = isRotationStatus(status);
  failureReasonByKey.set(label, rotation);

  if (isRateLimitedStatus(status)) {
    const delay = retryAfterMs(error, key);
    rateLimitUntilByKey.set(label, Date.now() + delay);
  } else if (rotation) {
    rateLimitUntilByKey.delete(label);
    rateLimitCountByKey.delete(label);
  }
}

function patchConfig(config) {
  if (!config || config[PATCHED]) return config;
  if (!Array.isArray(config.mistralKeys) || config.mistralKeys.length === 0) return config;

  const originalMarkKeyStatus = config.markKeyStatus;

  config.markKeyStatus = function hardenedMarkKeyStatus(pool, key, status) {
    if (pool === 'mistral') {
      const label = maskKey(key);
      const actualFailureJustifiesRotation = failureReasonByKey.get(label);

      if (status === 'exhausted' && actualFailureJustifiesRotation === false) {
        status = 'active';
      }

      if (status === 'active') {
        failureReasonByKey.delete(label);
        rateLimitUntilByKey.delete(label);
        rateLimitCountByKey.delete(label);
      }
    }

    return originalMarkKeyStatus.call(this, pool, key, status);
  };

  config.getNextMistralKey = function stickyMistralKey() {
    const pool = config.mistralKeys;
    if (!pool || pool.length === 0) {
      throw new Error('No keys configured for pool: mistral');
    }

    const health = config.keyHealth?.mistral || [];
    const now = Date.now();
    let earliestCooldown = Infinity;
    let earliestIndex = mistralCursor.index % pool.length;

    for (let offset = 0; offset < pool.length; offset += 1) {
      const idx = (mistralCursor.index + offset) % pool.length;
      const key = pool[idx];
      const label = maskKey(key);
      const entry = health.find(item => item.label === label);
      const status = String(entry?.status || 'active').toLowerCase();
      const cooldownUntil = rateLimitUntilByKey.get(label) || 0;

      if (status === 'exhausted') continue;
      if (cooldownUntil > now) {
        if (cooldownUntil < earliestCooldown) {
          earliestCooldown = cooldownUntil;
          earliestIndex = idx;
        }
        continue;
      }

      if (status === 'rate-limited') {
        // Cooldown expired: make the key usable again without pretending the
        // credential itself was invalid.
        if (config.markKeyStatus) config.markKeyStatus('mistral', key, 'active');
      }

      mistralCursor.index = idx;
      return key;
    }

    // All keys are temporarily unavailable. Keep the rotation sticky and
    // return the earliest key; the Axios wrapper below will sleep until its
    // cooldown expires before actually making the request.
    mistralCursor.index = earliestIndex;
    return pool[earliestIndex];
  };

  Object.defineProperty(config, PATCHED, { value: true, enumerable: false });
  console.log('[MistralRotation] Sticky key policy enabled: rotate only on 401/402/403/429, with 429 backoff.');
  return config;
}

function patchAxios(axios) {
  if (!axios || axios[PATCHED]) return axios;
  const originalPost = axios.post.bind(axios);

  axios.post = async function hardenedMistralPost(url, data, options, ...rest) {
    if (!isMistralUrl(url)) return originalPost(url, data, options, ...rest);

    const authorization = options?.headers?.Authorization || options?.headers?.authorization || '';
    const key = String(authorization).replace(/^Bearer\s+/i, '').trim();
    const label = maskKey(key);
    const cooldownUntil = rateLimitUntilByKey.get(label) || 0;
    const waitMs = Math.max(0, cooldownUntil - Date.now());

    if (waitMs > 0) {
      console.warn(`[MistralRotation] ${label} is rate-limited; waiting ${waitMs}ms before retry.`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    try {
      const response = await originalPost(url, data, options, ...rest);
      rateLimitUntilByKey.delete(label);
      rateLimitCountByKey.delete(label);
      return response;
    } catch (error) {
      rememberFailure(key, error?.response?.status, error);
      if (isRateLimitedStatus(error?.response?.status)) {
        const until = rateLimitUntilByKey.get(label) || Date.now();
        console.warn(`[MistralRotation] ${label} received 429; cooldown until ${new Date(until).toISOString()}.`);
      }
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
