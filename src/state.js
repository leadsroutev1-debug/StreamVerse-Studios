'use strict';
/**
 * In-memory pipeline state shared between the pipeline engine and the
 * dashboard SSE endpoint. Durable agent activity is mirrored here so the
 * dashboard remains connected even when the autonomous orchestrator works
 * through DB-backed tools rather than the legacy pipeline state helpers.
 */

const EventEmitter = require('events');
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const STATES = {
  IDLE:           'Idle',
  WRITING:        'Writing Script',
  GENERATING:     'Generating Shots',
  COMPILING:      'Compiling Video',
  UPLOADING_FB:   'Posting to Discord',
  AGENT:          'Agent Working',
  PAUSED:         'Paused',
  ERROR:          'Error',
};

let _state = {
  status: STATES.IDLE,
  runStartedAt: null,
  progress: { current: 0, total: 0, label: '' },
  shotsDone: 0,
  shotsTotal: 0,
  currentEpisode: null,
  lastError: null,
  history: [],
  diskUsageMB: 0,
  apiTest: null,
};

function getState() { return JSON.parse(JSON.stringify(_state)); }
function setState(partial) { Object.assign(_state, partial); emitter.emit('update', getState()); }

function setStatus(status, label = '') {
  _state.status = status;
  if (status !== STATES.IDLE && ! _state.runStartedAt) _state.runStartedAt = new Date().toISOString();
  if (status === STATES.IDLE || status === STATES.ERROR) _state.progress = { current: 0, total: 0, label: '' };
  if (label) _state.progress.label = label;
  emitter.emit('update', getState());
}
function setProgress(current, total, label) { _state.progress = { current, total, label }; emitter.emit('update', getState()); }
function setShotProgress(done, total) { _state.shotsDone = done; _state.shotsTotal = total; emitter.emit('update', getState()); }
function setCurrentEpisode(info) { _state.currentEpisode = info; emitter.emit('update', getState()); }
function setError(message) { _state.status = STATES.ERROR; _state.lastError = { message, at: new Date().toISOString() }; _state.runStartedAt = null; emitter.emit('update', getState()); }
function addHistory(entry) { _state.history.unshift(entry); if (_state.history.length > 10) _state.history = _state.history.slice(0, 10); emitter.emit('update', getState()); }
function resetForRun() { _state.status = STATES.IDLE; _state.runStartedAt = null; _state.progress = { current: 0, total: 0, label: '' }; _state.shotsDone = 0; _state.shotsTotal = 0; _state.lastError = null; emitter.emit('update', getState()); }
function updateDiskUsage(mb) { _state.diskUsageMB = mb; emitter.emit('update', getState()); }
function setApiTest(data) { _state.apiTest = data; emitter.emit('update', getState()); }

const TOOL_LABELS = {
  initialize_series: 'Initializing series',
  simulate_season: 'Simulating season',
  ensure_episode_draft: 'Preparing episode draft',
  simulate_episode_scenes: 'Simulating episode scenes',
  write_episode_script: 'Writing episode script',
  prepare_shot_rows: 'Preparing shot rows',
  generate_episode_media: 'Generating episode media',
  compile_episode: 'Compiling episode',
  validate_episode: 'Validating episode',
  publish_episode: 'Publishing episode',
};

function _agentStatusForTool(tool) {
  if (tool === 'generate_episode_media' || tool === 'prepare_shot_rows') return STATES.GENERATING;
  if (tool === 'compile_episode') return STATES.COMPILING;
  if (tool === 'publish_episode') return STATES.UPLOADING_FB;
  if (tool === 'validate_episode') return STATES.AGENT;
  if (tool === 'initialize_series' || tool === 'simulate_season' || tool === 'ensure_episode_draft' || tool === 'simulate_episode_scenes' || tool === 'write_episode_script') return STATES.WRITING;
  return STATES.AGENT;
}

let _syncBusy = false;
let _lastAgentFingerprint = null;

async function syncDurableAgentActivity() {
  if (_syncBusy) return;
  _syncBusy = true;
  try {
    const db = require('./db');
    const run = await db.queryOne(`
      SELECT ar.id, ar.storyline_id, ar.episode_id, ar.season_number, ar.episode_number,
             ar.phase, ar.status, ar.started_at, ar.updated_at,
             s.title AS storyline_title,
             e.id AS episode_row_id, e.episode_number AS episode_row_number,
             e.season_number AS episode_row_season
      FROM agent_runs ar
      LEFT JOIN storylines s ON s.id=ar.storyline_id
      LEFT JOIN episodes e ON e.id=ar.episode_id
      ORDER BY ar.updated_at DESC LIMIT 1
    `);
    if (!run) return;

    const event = await db.queryOne(`
      SELECT id, event_type, payload, created_at
      FROM agent_events WHERE run_id=? ORDER BY created_at DESC LIMIT 1
    `, [run.id]);

    let payload = {};
    try { payload = typeof event?.payload === 'object' ? event.payload : JSON.parse(event?.payload || '{}'); } catch (_) {}

    const tool = payload?.tool || null;
    const label = TOOL_LABELS[tool] || (tool ? `Agent: ${tool}` : `Agent phase: ${run.phase}`);
    const active = run.status === 'running';
    const terminalError = run.status === 'failed';
    const status = terminalError
      ? STATES.ERROR
      : active
        ? _agentStatusForTool(tool)
        : (run.status === 'paused' ? STATES.PAUSED : STATES.IDLE);

    const episodeId = run.episode_id || run.episode_row_id || null;
    const episodeNumber = run.episode_number ?? run.episode_row_number ?? null;
    const seasonNumber = run.season_number ?? run.episode_row_season ?? null;
    const episode = episodeId ? {
      id: episodeId,
      title: run.storyline_title ? `${run.storyline_title} S${seasonNumber || 1}E${episodeNumber || 0}` : '',
      episodeNumber,
      seasonNumber,
      draftEpisodeId: episodeId,
    } : null;

    const fingerprint = `${run.id}:${run.status}:${event?.id || 0}:${run.updated_at || ''}`;
    if (active || terminalError || fingerprint !== _lastAgentFingerprint) {
      _lastAgentFingerprint = fingerprint;
      _state.status = status;
      _state.currentEpisode = episode;
      _state.runStartedAt = active ? (run.started_at ? new Date(run.started_at).toISOString() : _state.runStartedAt) : null;
      _state.progress = { current: active ? 1 : 0, total: active ? 1 : 0, label: terminalError ? 'Agent failed' : label };
      if (terminalError) _state.lastError = { message: payload?.result?.error || 'Autonomous agent run failed', at: new Date().toISOString() };
      if (!terminalError && !active) _state.lastError = null;
      emitter.emit('update', getState());
    }
  } catch (_) {
    // Durable activity mirroring is best-effort and must never affect production.
  } finally { _syncBusy = false; }
}

setInterval(syncDurableAgentActivity, 2000);

module.exports = { STATES, emitter, getState, setState, setStatus, setProgress, setShotProgress, setCurrentEpisode, setError, addHistory, resetForRun, updateDiskUsage, setApiTest, syncDurableAgentActivity };
