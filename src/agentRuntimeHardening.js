'use strict';

const Module = require('module');
const path = require('path');
const originalLoad = Module._load;
const wrapped = new WeakSet();
const activeProductionRuns = new Set();
const mediaLocks = new Map();

const WAIT_MS = Math.max(1000, Number(process.env.AGENT_MEDIA_WAIT_POLL_MS || 5000));
const MAX_WAIT_MS = Math.max(WAIT_MS, Number(process.env.AGENT_MEDIA_WAIT_TIMEOUT_MS || 15 * 60 * 1000));
const STALE_JOB_MS = Math.max(60_000, Number(process.env.AGENT_STALE_JOB_MS || 30 * 60 * 1000));
const MISTRAL_RETRIES = Math.max(0, Math.min(2, Number(process.env.MISTRAL_AGENT_TRANSIENT_RETRIES || 1)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isMistralChatUrl(url) { return typeof url === 'string' && /api\.mistral\.ai\/v1\/chat\/completions/i.test(url); }
function isTransient(error) {
  const status = Number(error?.response?.status || 0);
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500 || ['ECONNABORTED','ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','ERR_NETWORK'].includes(error?.code);
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
    if (!isMistralChatUrl(url) || !data || typeof data !== 'object') return originalPost(url, data, options, ...rest);
    const body = { ...data, parallel_tool_calls: false };
    if (body.prompt_mode == null) body.prompt_mode = 'reasoning';
    let lastError;
    for (let attempt = 0; attempt <= MISTRAL_RETRIES; attempt++) {
      try { return await originalPost(url, body, options, ...rest); }
      catch (error) { lastError = error; if (attempt >= MISTRAL_RETRIES || !isTransient(error)) throw error; await sleep(retryDelay(error, attempt)); }
    }
    throw lastError;
  };
  Object.defineProperty(axios, '__streamverseAgentHardening', { value: true });
  return axios;
}
function extractEpisodeId(args) { return args?.episode_id || args?.episodeId || null; }
function parseJson(value, fallback = {}) { if (value == null) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch (_) { return fallback; } }
function expectedSceneCount(episode, config) {
  const script = parseJson(episode?.script, {}), trajectory = script?.episode_trajectory;
  return Math.max(1, Number(trajectory?.scene_count || trajectory?.sceneCount || trajectory?.scenes?.length || config?.scenesPerEpisode || episode?.scene_count || 1));
}
function sceneSimulationComplete(episode, config) {
  const sim = parseJson(episode?.script, {})?.narrative_simulation;
  return sim?.simulation_status === 'complete' && Array.isArray(sim.scene_beat_plan) && sim.scene_beat_plan.length >= expectedSceneCount(episode, config);
}
function shotSimulationComplete(episode) {
  const shots = parseJson(episode?.script, {})?.shot_simulation?.shots;
  return Array.isArray(shots) && shots.length > 0 && shots.every(s => String(s?.prompt || s?.image_prompt || s?.video_prompt || '').trim());
}
async function loadEpisode(args) {
  const id = extractEpisodeId(args);
  if (!id) return null;
  try { return await require('./db').queryOne('SELECT * FROM episodes WHERE id=?', [id]); } catch (_) { return null; }
}
function guardResult(code, error, extra = {}) { return { ok:false, blocked:true, code, error, ...extra }; }

async function deterministicProductionGuard(stage, args) {
  const episode = await loadEpisode(args);
  if (!episode) return guardResult('AGENT_EPISODE_NOT_FOUND', 'The requested episode does not exist in durable storage.');
  const config = require('./config');
  const db = require('./db');

  if (stage === 'simulate_episode_scenes') {
    if (sceneSimulationComplete(episode, config)) return guardResult('AGENT_STAGE_ALREADY_COMPLETE', 'Scene simulation is already complete; do not regenerate a locked upstream layer.');
    if (!parseJson(episode.script, {}).episode_trajectory) return guardResult('AGENT_MISSING_TRAJECTORY', 'Episode trajectory is missing; scene simulation cannot proceed safely.');
  }
  if (stage === 'write_episode_script' && !sceneSimulationComplete(episode, config)) return guardResult('AGENT_PRECONDITION_SCENE_SIMULATION', 'Episode scene simulation is not complete; script/shot writing is blocked until the scene simulation postcondition passes.');
  if (stage === 'prepare_shot_rows' && !shotSimulationComplete(episode)) return guardResult('AGENT_PRECONDITION_SHOT_SIMULATION', 'Shot simulation is incomplete or contains shots without authoritative prompts.');
  if (stage === 'generate_episode_media') {
    const rows = await db.query('SELECT * FROM shots WHERE episode_id=? ORDER BY scene_number,shot_index', [episode.id]);
    if (!rows.length) return guardResult('AGENT_PRECONDITION_NO_SHOTS', 'No persisted shot rows exist; media generation cannot manufacture production work.');
    const invalid = rows.filter(r => !String(r.last_prompt || '').trim() && !r.image_url && !r.clip_url);
    if (invalid.length) return guardResult('AGENT_PRECONDITION_INVALID_SHOTS', 'One or more persisted shots have no usable prompt or media source.', { invalid_shots:invalid.map(r=>({scene_number:r.scene_number,shot_index:r.shot_index})) });
  }
  if (['compile_episode','validate_episode','publish_episode'].includes(stage)) {
    const rows = await db.query('SELECT scene_number,shot_index,status,clip_url,last_error,ltx_status FROM shots WHERE episode_id=? ORDER BY scene_number,shot_index', [episode.id]);
    const failed = rows.filter(r => r.status === 'failed' || ['failed','zero_gpu_exhausted'].includes(String(r.ltx_status || '').toLowerCase()));
    const incomplete = rows.filter(r => r.status !== 'done' || !r.clip_url);
    if (failed.length || incomplete.length) return guardResult('AGENT_MEDIA_CONTRACT_FAILED', 'Episode cannot advance because durable media has not reached all-success state.', { failed:failed.map(r=>({scene_number:r.scene_number,shot_index:r.shot_index,status:r.status,ltx_status:r.ltx_status,error:r.last_error})), incomplete:incomplete.map(r=>({scene_number:r.scene_number,shot_index:r.shot_index,status:r.status})) });
  }
  return null;
}

function classifyMediaRows(rows) {
  const list = Array.isArray(rows) ? rows : [], now = Date.now();
  const active=[], success=[], retryable=[], terminal=[], orphaned=[];
  for (const row of list) {
    const status=String(row.status||'').toLowerCase(), ltx=String(row.ltx_status||'').toLowerCase();
    const age=now-new Date(row.updated_at||row.created_at||0).getTime(), hasClip=Boolean(String(row.clip_url||'').trim());
    if (status==='done' && hasClip) { success.push(row); continue; }
    if (status==='failed' || ['failed','zero_gpu_exhausted'].includes(ltx)) {
      const retryableFailure=['zero_gpu_exhausted','timeout','rate_limit','network','transient'].includes(ltx) || /429|timeout|network|econn|zerogpu|quota/i.test(String(row.last_error||''));
      (retryableFailure?retryable:terminal).push(row); continue;
    }
    if (['pending','mh_submitted','submitted','generating'].includes(status) || ['submitted','generating'].includes(ltx)) {
      if (age>STALE_JOB_MS && !row.mh_job_id) orphaned.push(row); else active.push(row); continue;
    }
    terminal.push(row);
  }
  const required=list.length;
  return { state:required>0&&success.length===required?'SUCCEEDED':active.length?'ACTIVE':orphaned.length?'ORPHANED':retryable.length?'FAILED_RETRYABLE':terminal.length?'FAILED_TERMINAL':'EMPTY', allSuccessful:required>0&&success.length===required, counts:{required,success:success.length,active:active.length,retryable:retryable.length,terminal:terminal.length,orphaned:orphaned.length}, active,success,retryable,terminal,orphaned };
}
async function waitForMediaToSettle(args, initialResult) {
  const episodeId=extractEpisodeId(args);
  if (!episodeId) return guardResult('AGENT_MEDIA_WAIT_NO_EPISODE','Media generation requires an episode_id so settlement can be proven.');
  const db=require('./db'), started=Date.now();
  while (Date.now()-started<MAX_WAIT_MS) {
    const lifecycle=classifyMediaRows(await db.query('SELECT * FROM shots WHERE episode_id=? ORDER BY scene_number,shot_index',[episodeId]));
    if (lifecycle.state==='SUCCEEDED') return {ok:true,media_settled:true,media_state:lifecycle.state,elapsed_ms:Date.now()-started,initial:initialResult,counts:lifecycle.counts};
    if (lifecycle.state==='FAILED_TERMINAL') return {ok:false,pending:false,media_settled:true,media_state:lifecycle.state,error:'Media generation reached a terminal failure; production advancement is blocked.',failed:lifecycle.terminal.map(r=>({id:r.id,scene_number:r.scene_number,shot_index:r.shot_index,error:r.last_error,ltx_status:r.ltx_status}))};
    if (lifecycle.state==='ORPHANED') return {ok:false,pending:false,media_settled:true,media_state:lifecycle.state,error:'Media job is orphaned/stale and cannot be treated as successful.',orphaned:lifecycle.orphaned.map(r=>({id:r.id,scene_number:r.scene_number,shot_index:r.shot_index,last_error:r.last_error}))};
    if (lifecycle.state==='FAILED_RETRYABLE') return {ok:false,pending:false,media_settled:true,media_state:lifecycle.state,error:'Media generation failed in a retryable/provider-specific state; recovery must handle the failed shots before advancing.',retryable:lifecycle.retryable.map(r=>({id:r.id,scene_number:r.scene_number,shot_index:r.shot_index,error:r.last_error,ltx_status:r.ltx_status}))};
    await sleep(WAIT_MS);
  }
  const lifecycle=classifyMediaRows(await db.query('SELECT * FROM shots WHERE episode_id=? ORDER BY scene_number,shot_index',[episodeId]));
  return {ok:false,blocked:true,pending:true,media_settled:false,media_state:lifecycle.state,code:'AGENT_MEDIA_WAIT_TIMEOUT',error:`Media pipeline did not reach a proven terminal state within ${MAX_WAIT_MS}ms; production advancement remains blocked.`,counts:lifecycle.counts};
}

function wrapProductionTools(exports) {
  if (!exports || wrapped.has(exports)) return exports;
  wrapped.add(exports);
  const mapping={
    simulateEpisodeScenes:'simulate_episode_scenes',
    writeEpisodeBlueprintAndShotSimulation:'write_episode_script',
    prepareShotRows:'prepare_shot_rows',
    generateMedia:'generate_episode_media',
    compileEpisode:'compile_episode',
    validateEpisode:'validate_episode',
    publishEpisode:'publish_episode',
  };
  for (const [exportName,stage] of Object.entries(mapping)) {
    if (typeof exports[exportName] !== 'function') continue;
    const original=exports[exportName].bind(exports);
    exports[exportName]=async function hardenedProductionTool(args={}) {
      const guard=await deterministicProductionGuard(stage,args);
      if (guard) return guard;
      if (exportName!=='generateMedia') return original(args);
      const episodeId=extractEpisodeId(args)||'__global__';
      const previous=mediaLocks.get(episodeId)||Promise.resolve();
      let release; const current=new Promise(resolve=>{release=resolve}); mediaLocks.set(episodeId,current);
      try { await previous; const result=await original(args); return await waitForMediaToSettle(args,result); }
      finally { release(); if(mediaLocks.get(episodeId)===current) mediaLocks.delete(episodeId); }
    };
  }
  return exports;
}

function wrapOrchestrator(exports) {
  if (!exports || wrapped.has(exports)) return exports;
  wrapped.add(exports);
  if (typeof exports.runProductionAgent==='function') {
    const original=exports.runProductionAgent.bind(exports);
    exports.runProductionAgent=async function hardenedRunProductionAgent(options={}) {
      const episodeId=extractEpisodeId(options)||options?.episode?.id||'__global__';
      if(activeProductionRuns.has(episodeId)) return guardResult('AGENT_RUN_ALREADY_ACTIVE',`A production-agent run is already active for ${episodeId}; refusing concurrent orchestration.`,{published:false,paused:true});
      activeProductionRuns.add(episodeId); try{return await original(options)}finally{activeProductionRuns.delete(episodeId)}
    };
  }
  return exports;
}

async function ensureCriticalSchema(db) {
  const exists=await db.queryOne(`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='shots' AND COLUMN_NAME='updated_at'`);
  if(!exists){await db.execute(`ALTER TABLE shots ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);console.log('[SchemaHardening] Added missing shots.updated_at to existing installation');}
}
function wrapDb(exports) {
  if (!exports || wrapped.has(exports)) return exports;
  wrapped.add(exports);
  if(typeof exports.initSchema==='function'){
    const original=exports.initSchema.bind(exports);
    exports.initSchema=async function hardenedInitSchema(...args){const result=await original(...args);await ensureCriticalSchema(exports);return result;};
  }
  return exports;
}

Module._load=function hardenedModuleLoad(request,parent,isMain){
  const loaded=originalLoad.call(this,request,parent,isMain);
  if(request==='axios') return patchAxios(loaded);
  if(request==='./agentProductionTools' && parent?.filename?.endsWith('agentOrchestrator.js')) return wrapProductionTools(loaded);
  if(request==='./src/agentOrchestrator' && parent?.filename?.endsWith(`${path.sep}index.js`)) return wrapOrchestrator(loaded);
  if(request==='./db' && parent?.filename?.endsWith(`${path.sep}index.js`)) return wrapDb(loaded);
  return loaded;
};

module.exports={WAIT_MS,MAX_WAIT_MS,STALE_JOB_MS,MISTRAL_RETRIES,classifyMediaRows};
