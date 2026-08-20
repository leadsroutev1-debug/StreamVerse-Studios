'use strict';
/**
 * In-memory pipeline state shared between the pipeline engine and the
 * dashboard SSE endpoint. All mutations go through the exported helpers so
 * SSE subscribers are notified automatically.
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
  PAUSED:         'Paused',
  ERROR:          'Error',
};

let _state = {
  status:       STATES.IDLE,
  runStartedAt: null,
  progress: {
    current:  0,
    total:    0,
    label:    '',
  },
  shotsDone:      0,   // successful shots this run (live counter)
  shotsTotal:     0,   // total shots this episode
  currentEpisode: null,   // { title, episodeNumber, seasonNumber }
  lastError: null,
  history: [],            // last 10 posted episodes
  diskUsageMB: 0,
  apiTest: null,          // { running, results: [{name,status,message,latencyMs}], startedAt }
};

function getState() {
  return JSON.parse(JSON.stringify(_state));
}

function setState(partial) {
  Object.assign(_state, partial);
  emitter.emit('update', getState());
}

function setStatus(status, label = '') {
  _state.status = status;
  if (status !== STATES.IDLE && !_state.runStartedAt) {
    _state.runStartedAt = new Date().toISOString();
  }
  if (status === STATES.IDLE || status === STATES.ERROR) {
    _state.progress = { current: 0, total: 0, label: '' };
  }
  if (label) _state.progress.label = label;
  emitter.emit('update', getState());
}

function setProgress(current, total, label) {
  _state.progress = { current, total, label };
  emitter.emit('update', getState());
}

function setShotProgress(done, total) {
  _state.shotsDone  = done;
  _state.shotsTotal = total;
  emitter.emit('update', getState());
}

function setCurrentEpisode(info) {
  _state.currentEpisode = info;
  emitter.emit('update', getState());
}

function setError(message) {
  _state.status = STATES.ERROR;
  _state.lastError = { message, at: new Date().toISOString() };
  _state.runStartedAt = null;
  emitter.emit('update', getState());
}

function addHistory(entry) {
  _state.history.unshift(entry);
  if (_state.history.length > 10) _state.history = _state.history.slice(0, 10);
  emitter.emit('update', getState());
}

function resetForRun() {
  _state.status      = STATES.IDLE;
  _state.runStartedAt = null;
  _state.progress    = { current: 0, total: 0, label: '' };
  _state.shotsDone   = 0;
  _state.shotsTotal  = 0;
  _state.lastError   = null;
  emitter.emit('update', getState());
}

function updateDiskUsage(mb) {
  _state.diskUsageMB = mb;
  emitter.emit('update', getState());
}

function setApiTest(data) {
  _state.apiTest = data;
  emitter.emit('update', getState());
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
};
