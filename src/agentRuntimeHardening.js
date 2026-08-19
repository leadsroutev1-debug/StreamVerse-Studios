'use strict';

/**
 * Runtime hardening for the autonomous production agent.
 *
 * This module is preloaded before index.js. It deliberately sits at the
 * runtime boundary instead of duplicating the orchestrator. It protects two
 * failure classes that are otherwise easy for an LLM orchestrator to trigger:
 *
 *  1. multiple production-agent runs acting on the same durable episode;
 *  2. the media tool returning "pipeline is running; wait" and the agent
 *     immediately advancing to the next production stage.
 *
 * It also applies the Mistral API settings documented for reliable tool use:
 * single-tool execution and reasoning prompt mode. Transient HTTP/network
 * failures receive a small bounded retry before the existing key-rotation
 * logic gets control back.
 */

const Module = require('module');
const originalLoad = Module._load;
const wrapped = new WeakSet();
const activeProductionRuns = new Set();
const mediaLocks = new Map();

const WAIT_MS = Math.max(1000, Number(process.env.AGENT_MEDIA_WAIT_POLL_MS || 5000));
const MAX_WAIT_MS = Math.max(WAIT_MS, Number(process.env.AGENT_MEDIA_WAIT_TIMEOUT_MS || 15 * 60 * 1000));
const MISTRAL_RETRIES = Math.max(0, Math.min(2, Number(process.env.MISTRAL_AGENT_TRANSIENT_RETRIES || 1)));

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isMistralChatUrl(url) {
  return typeof url === 'string' && /api\.mistral\.ai\/v1\/chat\/completions/i.test(url);
}

function isTransient(error) {
  const status = Number(error?.response?.status || 0);
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500 ||
    ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_NETWORK'].includes(error?.code);
}

function retryDelay(error, attempt) {
  const retryAfter = Number(error?.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(10000, retryAfter * 1000);
  return Math.min(8000, 1000 * (2 ** attempt) + Math.floor(Math.random() * 250));
}

function patchAxios(axios) {
  if (!axios || axios.__streamverseAgentHardening) return axios;
  const originalPost = axios.post.bind(axios);

  axios.post = async function hardenedPost(url, data, options, ...rest) {
    if (!isMistralChatUrl(url) || !data || typeof data !== 'object') {
      return originalPost(url, data, options, ...rest);
    }

    const body = { ...data };
    // Mistral's official function-calling guidance supports explicitly
    // disabling parallel calls. Production media stages are stateful and
    // therefore must never race each other.
    body.parallel_tool_calls = false;

    // Mistral's current Chat API exposes prompt_mode="reasoning". This asks
    // the model to spend its inference budget in reasoning mode without
    // pretending that every model supports the separate reasoning_effort
    // parameter.
    if (body.prompt_mode == null) body.prompt_mode = 'reasoning';

    let lastError;
    for (let attempt = 0; attempt <= MISTRAL_RETRIES; attempt++) {
      try {
        return await originalPost(url, body, options, ...rest);
      } catch (error) {
        lastError = error;
        if (attempt >= MISTRAL_RETRIES || !isTransient(error)) throw error;
        await sleep(retryDelay(error, attempt));
      }
    }
    throw lastError;
  };

  Object.defineProperty(axios, '__streamverseAgentHardening', { value: true });
  return axios;
}

function extractEpisodeId(args) {
  return args?.episode_id || args?.episodeId || null;
}

function isWaitResult(result) {
  const text = JSON.stringify(result || {});
  return /pipeline\s+is\s+currently\s+running|wait[^\n]{0,80}finish|still\s+(?:running|processing)|media[^\n]{0,80}in\s+progress/i.test(text);
}

async function waitForMediaToSettle(originalTools, args, initialResult) {
  if (!isWaitResult(initialResult)) return initialResult;

  const episodeId = extractEpisodeId(args);
  if (!episodeId) {
    return {
      ok: false,
      blocked: true,
      code: 'AGENT_MEDIA_WAIT_NO_EPISODE',
      error: 'Media generation reported an active pipeline but no episode_id was supplied; refusing to advance blindly.',
      initial: initialResult,
    };
  }

  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    await sleep(WAIT_MS);

    let state = null;
    let jobs = null;
    try {
      state = await originalTools.inspectProductionState({ episode_id: episodeId });
    } catch (error) {
      state = { error: error.message };
    }

    try {
      const recovery = require('./autonomousRecovery');
      jobs = await recovery.queryActiveJobs(episodeId);
    } catch (error) {
      jobs = { error: error.message };
    }

    const activeJobs = Array.isArray(jobs) ? jobs : [];
    if (activeJobs.length === 0) {
      // No active durable jobs means the asynchronous media stage has either
      // completed or failed. Return the evidence to the orchestrator rather
      // than guessing that it succeeded.
      return {
        ok: true,
        waited: true,
        media_settled: true,
        elapsed_ms: Date.now() - started,
        initial: initialResult,
        production_state: state,
        active_jobs: activeJobs,
      };
    }
  }

  return {
    ok: false,
    blocked: true,
    pending: true,
    code: 'AGENT_MEDIA_WAIT_TIMEOUT',
    error: `Media pipeline did not settle within ${MAX_WAIT_MS}ms; production advancement is blocked.`,
    initial: initialResult,
  };
}

function wrapProductionTools(exports) {
  if (!exports || wrapped.has(exports)) return exports;
  wrapped.add(exports);

  if (typeof exports.generateMedia === 'function') {
    const originalGenerateMedia = exports.generateMedia.bind(exports);
    exports.generateMedia = async function hardenedGenerateMedia(args = {}) {
      const episodeId = extractEpisodeId(args) || '__global__';
      const previous = mediaLocks.get(episodeId) || Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      mediaLocks.set(episodeId, current);
      try {
        // Serialize media generation calls for the same episode. This is a
        // local safety net in addition to Mistral parallel_tool_calls=false.
        await previous;
        const result = await originalGenerateMedia(args);
        return await waitForMediaToSettle(exports, args, result);
      } finally {
        release();
        if (mediaLocks.get(episodeId) === current) mediaLocks.delete(episodeId);
      }
    };
  }

  return exports;
}

function wrapOrchestrator(exports) {
  if (!exports || wrapped.has(exports)) return exports;
  wrapped.add(exports);

  if (typeof exports.runProductionAgent === 'function') {
    const originalRun = exports.runProductionAgent.bind(exports);
    exports.runProductionAgent = async function hardenedRunProductionAgent(options = {}) {
      const episodeId = extractEpisodeId(options) || options?.episode?.id || '__global__';
      if (activeProductionRuns.has(episodeId)) {
        return {
          ok: false,
          published: false,
          paused: true,
          code: 'AGENT_RUN_ALREADY_ACTIVE',
          error: `A production-agent run is already active for ${episodeId}; refusing concurrent orchestration.`,
        };
      }
      activeProductionRuns.add(episodeId);
      try {
        return await originalRun(options);
      } finally {
        activeProductionRuns.delete(episodeId);
      }
    };
  }

  return exports;
}

Module._load = function hardenedModuleLoad(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);

  // Axios is shared through Node's module cache, so patching it here protects
  // every Mistral call made by the agent without changing provider contracts.
  if (request === 'axios') return patchAxios(loaded);

  if (request === './agentProductionTools' && parent?.filename?.endsWith('agentOrchestrator.js')) {
    return wrapProductionTools(loaded);
  }

  if (request === './src/agentOrchestrator' && parent?.filename?.endsWith(`${require('path').sep}index.js`)) {
    return wrapOrchestrator(loaded);
  }

  return loaded;
};

module.exports = { WAIT_MS, MAX_WAIT_MS, MISTRAL_RETRIES };
