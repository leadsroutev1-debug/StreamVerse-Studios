'use strict';

/**
 * StreamVerse Mistral key-rotation + production hardening.
 *
 * Mistral policy:
 *   - Round-robin normal requests across every configured Mistral key.
 *   - 429 is temporary provider throttling: mark that key cooling down and
 *     skip it until its cooldown expires instead of hammering it again.
 *   - 401/402/403 are credential/account failures: the key is exhausted and
 *     rotation continues to the next usable key.
 *   - If every key is cooling down, the selector returns the key whose
 *     cooldown expires soonest; the Axios wrapper waits for that key.
 *   - 400/404/422, malformed output, truncation, network errors and 5xx do
 *     not invalidate credentials.
 *
 * Production hardening:
 *   - A locked scene simulation is authoritative. If an LLM blueprint drifts
 *     in scene cardinality, retry the blueprint with an explicit exact-count
 *     contract instead of killing the production stage.
 *   - The autonomous DB tool must not treat episodes.checkpoint_state as a
 *     physical column. It is stored inside episodes.script.checkpoint_state.
 *     The compatibility wrapper maps that legacy agent action into the JSON
 *     document so recovery can continue without inventing schema.
 */
const Module = require('module');
const previousLoad = Module._load;
const PATCHED = Symbol.for('streamverse.mistral.roundrobin.hardened');
const AGENT_PATCHED = Symbol.for('streamverse.agent.production.hardened');
const SCRIPT_PATCHED = Symbol.for('streamverse.script.scene-cardinality.hardened');

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
    failureReasonByKey.set(label, 'rate-limited');
    return;
  }
  if (isRotationStatus(status)) {
    failureReasonByKey.set(label, 'exhausted');
    rateLimitUntilByKey.delete(label);
    rateLimitCountByKey.delete(label);
  }
}

function keyStatus(health, key) {
  const label = maskKey(key);
  const entry = health.find(item => item.label === label);
  return String(entry?.status || 'active').toLowerCase();
}

function patchConfig(config) {
  if (!config || config[PATCHED]) return config;
  if (!Array.isArray(config.mistralKeys) || config.mistralKeys.length === 0) return config;

  const originalMarkKeyStatus = config.markKeyStatus;

  config.markKeyStatus = function hardenedMarkKeyStatus(pool, key, status) {
    if (pool === 'mistral') {
      const label = maskKey(key);
      if (status === 'rate-limited') {
        const until = rateLimitUntilByKey.get(label) || (Date.now() + 2000);
        rateLimitUntilByKey.set(label, until);
        failureReasonByKey.set(label, 'rate-limited');
      } else if (status === 'exhausted') {
        failureReasonByKey.set(label, 'exhausted');
      } else if (status === 'active') {
        failureReasonByKey.delete(label);
        rateLimitUntilByKey.delete(label);
        rateLimitCountByKey.delete(label);
      }
    }
    return typeof originalMarkKeyStatus === 'function'
      ? originalMarkKeyStatus.call(this, pool, key, status)
      : undefined;
  };

  config.getNextMistralKey = function roundRobinMistralKey() {
    const pool = config.mistralKeys;
    if (!pool || pool.length === 0) throw new Error('No keys configured for pool: mistral');

    const health = config.keyHealth?.mistral || [];
    const now = Date.now();
    const start = ((mistralCursor.index % pool.length) + pool.length) % pool.length;
    let soonestKey = null;
    let soonestUntil = Infinity;

    // First pass: choose the next healthy key that is not cooling down.
    for (let offset = 0; offset < pool.length; offset += 1) {
      const idx = (start + offset) % pool.length;
      const key = pool[idx];
      const label = maskKey(key);
      const status = keyStatus(health, key);
      const cooldownUntil = rateLimitUntilByKey.get(label) || 0;

      if (status === 'exhausted' || failureReasonByKey.get(label) === 'exhausted') continue;

      if (cooldownUntil > now) {
        if (cooldownUntil < soonestUntil) {
          soonestUntil = cooldownUntil;
          soonestKey = key;
        }
        continue;
      }

      mistralCursor.index = (idx + 1) % pool.length;
      console.log(`[MistralRotation] Round-robin selected key ${label} (${idx + 1}/${pool.length}).`);
      return key;
    }

    // All usable keys are cooling down. Do not burn requests against a known
    // 429 key; choose the earliest-expiring key and let the Axios wrapper wait.
    if (soonestKey) {
      const idx = pool.indexOf(soonestKey);
      mistralCursor.index = (idx + 1) % pool.length;
      const label = maskKey(soonestKey);
      console.warn(`[MistralRotation] All Mistral keys cooling down; earliest key ${label} retained until ${new Date(soonestUntil).toISOString()}.`);
      return soonestKey;
    }

    throw new Error('All configured Mistral keys are exhausted');
  };

  Object.defineProperty(config, PATCHED, { value: true, enumerable: false });
  console.log(`[MistralRotation] Cooldown-aware round-robin enabled across ${config.mistralKeys.length} configured key(s).`);
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
      console.warn(`[MistralRotation] ${label} is rate-limited; waiting ${waitMs}ms before using this key again.`);
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
        console.warn(`[MistralRotation] ${label} received 429; cooldown until ${new Date(until).toISOString()}.`);
      }
      throw error;
    }
  };

  Object.defineProperty(axios, PATCHED, { value: true, enumerable: false });
  return axios;
}

function patchScriptWriter(scriptWriter) {
  if (!scriptWriter || scriptWriter[SCRIPT_PATCHED] || typeof scriptWriter.writeEpisodeScript !== 'function') return scriptWriter;

  const originalWriteEpisodeScript = scriptWriter.writeEpisodeScript;
  scriptWriter.writeEpisodeScript = async function hardenedWriteEpisodeScript(args = {}) {
    try {
      return await originalWriteEpisodeScript.call(this, args);
    } catch (error) {
      const message = String(error?.message || '');
      const alreadyRetried = String(args.runtimeRetryNote || '').includes('STREAMVERSE_SCENE_CARDINALITY_RETRY');
      const narrativePlan = Array.isArray(args.narrativeSimulation?.scene_beat_plan)
        ? args.narrativeSimulation.scene_beat_plan
        : [];

      if (!alreadyRetried && narrativePlan.length > 0 && /BLUEPRINT_SCENE_COUNT_DRIFT|Blueprint scene count/i.test(message)) {
        const exactCount = narrativePlan.length;
        const retryNote = [
          'STREAMVERSE_SCENE_CARDINALITY_RETRY',
          `The locked episode scene simulation contains EXACTLY ${exactCount} scenes.`,
          `Return exactly ${exactCount} scenes in blueprint.scenes, numbered 1 through ${exactCount}.`,
          'Do not omit, merge, split, reorder, or invent scenes.',
          'Every locked simulated scene must have one corresponding blueprint scene.',
          'This is a hard production contract, not a creative suggestion.',
        ].join(' ');
        console.warn(`[ScriptWriterHardening] Blueprint scene cardinality drift detected; retrying exact ${exactCount}-scene blueprint.`);
        return originalWriteEpisodeScript.call(this, {
          ...args,
          runtimeRetryNote: retryNote,
          existingScript: null,
        });
      }
      throw error;
    }
  };

  Object.defineProperty(scriptWriter, SCRIPT_PATCHED, { value: true, enumerable: false });
  return scriptWriter;
}

function patchAgentOrchestrator(agent) {
  if (!agent || agent[AGENT_PATCHED] || typeof agent.buildTools !== 'function') return agent;

  const originalBuildTools = agent.buildTools;
  agent.buildTools = function hardenedBuildTools(...args) {
    const tools = originalBuildTools.apply(this, args);
    if (!Array.isArray(tools)) return tools;

    const dbTool = tools.find(t => t?.schema?.function?.name === 'db_update_fields');
    if (dbTool && !dbTool.handler.__streamverseCheckpointCompat) {
      const originalHandler = dbTool.handler;
      const wrappedHandler = async function checkpointCompatibleDbUpdate(payload = {}) {
        const table = payload.table;
        const updates = payload.updates && typeof payload.updates === 'object' ? { ...payload.updates } : {};
        const where = payload.where || {};

        if (table === 'episodes' && Object.prototype.hasOwnProperty.call(updates, 'checkpoint_state')) {
          const checkpoint = updates.checkpoint_state;
          delete updates.checkpoint_state;

          if (!where.id && !where.episode_id) {
            return {
              ok: false,
              recoverable: true,
              reason: 'checkpoint_state is embedded in episodes.script; an episode id is required to update it safely.',
            };
          }

          const episodeId = where.id || where.episode_id;
          const dbModule = require('./db');
          const row = await dbModule.queryOne(`SELECT script FROM episodes WHERE id=?`, [episodeId]);
          if (!row) return { ok: false, recoverable: true, reason: `Episode ${episodeId} not found.` };

          let script = row.script;
          if (typeof script === 'string') {
            try { script = JSON.parse(script); } catch (_) { script = {}; }
          }
          if (!script || typeof script !== 'object') script = {};
          script.checkpoint_state = checkpoint && typeof checkpoint === 'object'
            ? { ...(script.checkpoint_state || {}), ...checkpoint }
            : checkpoint;

          await dbModule.execute(`UPDATE episodes SET script=?,updated_at=NOW() WHERE id=?`, [JSON.stringify(script), episodeId]);
          console.log(`[AgentDBHardening] Stored checkpoint_state inside episodes.script for ${episodeId}; no schema column invented.`);

          if (Object.keys(updates).length === 0) return { ok: true, affectedRows: 1, checkpoint_state_embedded: true };
          return originalHandler({ ...payload, updates });
        }

        return originalHandler(payload);
      };
      wrappedHandler.__streamverseCheckpointCompat = true;
      dbTool.handler = wrappedHandler;
    }

    return tools;
  };

  Object.defineProperty(agent, AGENT_PATCHED, { value: true, enumerable: false });
  return agent;
}

Module._load = function streamVerseMistralRotationLoad(request, parent, isMain) {
  const loaded = previousLoad.call(this, request, parent, isMain);
  if (request === 'axios') return patchAxios(loaded);
  if (request === './config' || /[\\/]config\.js$/.test(String(request || ''))) return patchConfig(loaded);
  if (request === './scriptWriter' || /[\\/]scriptWriter\.js$/.test(String(request || ''))) return patchScriptWriter(loaded);
  if (request === './agentOrchestrator' || /[\\/]agentOrchestrator\.js$/.test(String(request || ''))) return patchAgentOrchestrator(loaded);
  return loaded;
};

module.exports = { isRotationStatus, maskKey };
