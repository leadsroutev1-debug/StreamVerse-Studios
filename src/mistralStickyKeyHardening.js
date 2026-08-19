'use strict';

/**
 * StreamVerse Mistral key-rotation hardening.
 *
 * Sticky policy:
 *   - Keep one key active until an authentication/account failure (401/402/403)
 *     or explicit credential exhaustion forces rotation.
 *   - 429 is NOT a reason to rotate. The same key waits for Retry-After/backoff
 *     and is retried. This prevents a single request burst from consuming the
 *     entire key pool.
 *   - 400/404/422, malformed output, truncation, network errors and 5xx do NOT
 *     rotate credentials.
 */
const Module = require('module');
const previousLoad = Module._load;
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
  return [401, 402, 403].includes(Number(status));
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
  if (isRateLimitedStatus(status)) {
    const delay = retryAfterMs(error, key);
    rateLimitUntilByKey.set(label, Date.now() + delay);
    failureReasonByKey.set(label, true);
    return;
  }
  if (isRotationStatus(status)) {
    failureReasonByKey.set(label, true);
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
      // 429 means temporary provider throttling, never credential exhaustion.
      if (status === 'exhausted' && !isRotationStatus(failureReasonByKey.get(label) ? 401 : null)) {
        if (rateLimitUntilByKey.has(label)) status = 'rate-limited';
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
    if (!pool || pool.length === 0) throw new Error('No keys configured for pool: mistral');

    const health = config.keyHealth?.mistral || [];
    const now = Date.now();
    const currentIdx = mistralCursor.index % pool.length;
    const currentKey = pool[currentIdx];
    const currentLabel = maskKey(currentKey);
    const currentEntry = health.find(item => item.label === currentLabel);
    const currentStatus = String(currentEntry?.status || 'active').toLowerCase();

    // The defining sticky rule: if the current credential is temporarily
    // rate-limited, keep returning THIS key. The Axios wrapper waits for its
    // cooldown; no other key is touched.
    const currentCooldown = rateLimitUntilByKey.get(currentLabel) || 0;
    if (currentCooldown > now && currentStatus !== 'exhausted') {
      console.warn(`[MistralRotation] Sticky key ${currentLabel} retained during 429 cooldown.`);
      return currentKey;
    }

    // If the current key was invalidated by auth/account exhaustion, advance.
    if (currentStatus === 'exhausted') {
      for (let offset = 1; offset <= pool.length; offset += 1) {
        const idx = (currentIdx + offset) % pool.length;
        const key = pool[idx];
        const label = maskKey(key);
        const entry = health.find(item => item.label === label);
        if (String(entry?.status || 'active').toLowerCase() !== 'exhausted') {
          mistralCursor.index = idx;
          console.warn(`[MistralRotation] Rotating from exhausted key ${currentLabel} → ${label}.`);
          return key;
        }
      }
      return currentKey;
    }

    // Healthy/current key stays sticky. Do not round-robin on ordinary calls.
    return currentKey;
  };

  Object.defineProperty(config, PATCHED, { value: true, enumerable: false });
  console.log('[MistralRotation] Sticky key policy enabled: stay on one key; rotate only on 401/402/403/exhaustion; 429 waits and retries same key.');
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
      console.warn(`[MistralRotation] ${label} is rate-limited; waiting ${waitMs}ms before retry on the SAME key.`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    try {
      const response = await originalPost(url, data, options, ...rest);
      rateLimitUntilByKey.delete(label);
      rateLimitCountByKey.delete(label);
      failureReasonByKey.delete(label);
      return response;
    } catch (error) {
      rememberFailure(key, error?.response?.status, error);
      if (isRateLimitedStatus(error?.response?.status)) {
        const until = rateLimitUntilByKey.get(label) || Date.now();
        console.warn(`[MistralRotation] ${label} received 429; sticky cooldown until ${new Date(until).toISOString()}.`);
      }
      throw error;
    }
  };

  Object.defineProperty(axios, PATCHED, { value: true, enumerable: false });
  return axios;
}

Module._load = function streamVerseMistralRotationLoad(request, parent, isMain) {
  const loaded = previousLoad.call(this, request, parent, isMain);
  if (request === 'axios') return patchAxios(loaded);
  if (request === './config' || /[\\/]config\.js$/.test(String(request || ''))) return patchConfig(loaded);
  return loaded;
};

module.exports = { isRotationStatus, maskKey };