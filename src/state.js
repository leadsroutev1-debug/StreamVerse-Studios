'use strict';
/**
 * In-memory pipeline state shared with the dashboard SSE endpoint.
 * Agent activity is pushed here directly by the autonomous agent/memory layer;
 * the database remains the durable history, not the live transport.
 */

const EventEmitter = require('events');
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const STATES = {
  IDLE: 'Idle',
  WRITING: 'Writing Script',
  GENERATING: 'Generating Shots',
  COMPILING: 'Compiling Video',
  UPLOADING_FB: 'Posting to Discord',
  AGENT: 'Agent Working',
  PAUSED: 'Paused',
  ERROR: 'Error',
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
  agentActivity: null,
};

function getState() { return JSON.parse(JSON.stringify(_state)); }
function emit() { emitter.emit('update', getState()); }
function setState(partial) { Object.assign(_state, partial); emit(); }

function setStatus(status, label = '') {
  _state.status = status;
  if (status !== STATES.IDLE && !_state.runStartedAt) _state.runStartedAt = new Date().toISOString();
  if (status === STATES.IDLE || status === STATES.ERROR) _state.progress = { current: 0, total: 0, label: '' };
  if (label) _state.progress.label = label;
  emit();
}
function setProgress(current, total, label) { _state.progress = { current, total, label }; emit(); }
function setShotProgress(done, total) { _state.shotsDone = done; _state.shotsTotal = total; emit(); }
function setCurrentEpisode(info) { _state.currentEpisode = info; emit(); }
function setError(message) { _state.status = STATES.ERROR; _state.lastError = { message, at: new Date().toISOString() }; _state.runStartedAt = null; emit(); }
function addHistory(entry) { _state.history.unshift(entry); if (_state.history.length > 10) _state.history = _state.history.slice(0, 10); emit(); }
function resetForRun() { _state.status = STATES.IDLE; _state.runStartedAt = null; _state.progress = { current: 0, total: 0, label: '' }; _state.shotsDone = 0; _state.shotsTotal = 0; _state.lastError = null; _state.agentActivity = null; emit(); }
function updateDiskUsage(mb) { _state.diskUsageMB = mb; emit(); }
function setApiTest(data) { _state.apiTest = data; emit(); }

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
  if (['initialize_series', 'simulate_season', 'ensure_episode_draft', 'simulate_episode_scenes', 'write_episode_script'].includes(tool)) return STATES.WRITING;
  return STATES.AGENT;
}

/**
 * Push one autonomous-agent activity update directly to the live dashboard.
 * This is intentionally synchronous and in-memory: the caller already owns
 * the durable DB write and should never wait on dashboard delivery.
 */
function setAgentActivity(activity = {}) {
  const now = new Date().toISOString();
  const tool = activity.tool || null;
  const status = activity.status || 'running';
  const terminal = status === 'failed' || status === 'error';
  const completed = status === 'completed' || status === 'paused';

  _state.agentActivity = {
    ...(_state.agentActivity || {}),
    ...activity,
    tool,
    label: activity.label || TOOL_LABELS[tool] || (tool ? `Agent: ${tool}` : 'Agent Working'),
    status,
    at: now,
  };

  if (status === 'running') {
    _state.status = _agentStatusForTool(tool);
    _state.runStartedAt = activity.startedAt || _state.runStartedAt || now;
    _state.progress = { current: 1, total: 1, label: _state.agentActivity.label };
  } else if (terminal) {
    _state.status = STATES.ERROR;
    _state.lastError = { message: activity.error || 'Autonomous agent action failed', at: now };
    _state.runStartedAt = null;
    _state.progress = { current: 0, total: 0, label: _state.agentActivity.label };
  } else if (completed) {
    _state.status = status === 'paused' ? STATES.PAUSED : STATES.AGENT;
    _state.progress = { current: 1, total: 1, label: _state.agentActivity.label };
  }

  if (activity.episode) _state.currentEpisode = activity.episode;
  emit();
}

function clearAgentActivity() {
  _state.agentActivity = null;
  emit();
}

module.exports = {
  STATES,
  emitter,
  getState,
  setState,
  setStatus,
  setProgress,
  setShotProgress,
  setCurrentEpisode,
  setError,
  addHistory,
  resetForRun,
  updateDiskUsage,
  setApiTest,
  setAgentActivity,
  clearAgentActivity,
  TOOL_LABELS,
};
