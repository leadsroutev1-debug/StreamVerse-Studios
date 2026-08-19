'use strict';

const db = require('./db');
const { v4: uuidv4 } = require('uuid');

function asJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function pushDashboardActivity(activity) {
  try {
    const state = require('./state');
    state.setAgentActivity(activity);
  } catch (_) {
    // Dashboard telemetry is optional and must never affect the production agent.
  }
}

async function initAgentMemorySchema() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      storyline_id VARCHAR(36) NULL,
      episode_id VARCHAR(36) NOT NULL DEFAULT '',
      season_number INT NULL,
      episode_number INT NULL,
      phase VARCHAR(40) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'running',
      goal TEXT NULL,
      cursor_state JSON NULL,
      last_decision JSON NULL,
      error_state JSON NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_agent_runs_storyline (storyline_id, updated_at),
      INDEX idx_agent_runs_episode (episode_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      storyline_id VARCHAR(36) NOT NULL,
      episode_id VARCHAR(36) NOT NULL DEFAULT '',
      memory_scope VARCHAR(40) NOT NULL,
      memory_key VARCHAR(180) NOT NULL,
      memory_value JSON NOT NULL,
      priority INT NOT NULL DEFAULT 50,
      source VARCHAR(60) NOT NULL DEFAULT 'pipeline',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_agent_memory (storyline_id, episode_id, memory_scope, memory_key),
      INDEX idx_agent_memory_scope (storyline_id, memory_scope, priority, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      run_id VARCHAR(36) NULL,
      storyline_id VARCHAR(36) NULL,
      episode_id VARCHAR(36) NOT NULL DEFAULT '',
      event_type VARCHAR(60) NOT NULL,
      payload JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_agent_events_run (run_id, created_at),
      INDEX idx_agent_events_storyline (storyline_id, created_at),
      INDEX idx_agent_events_episode (episode_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function startRun({ storylineId, episodeId = null, seasonNumber = null, episodeNumber = null, phase, goal }) {
  const id = uuidv4();
  const startedAt = new Date().toISOString();
  await db.execute(
    `INSERT INTO agent_runs (id, storyline_id, episode_id, season_number, episode_number, phase, goal, cursor_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, storylineId || null, episodeId || '', seasonNumber ?? null, episodeNumber ?? null, phase, goal || null, JSON.stringify({})]
  );
  pushDashboardActivity({
    runId: id,
    storylineId: storylineId || null,
    tool: null,
    phase,
    status: 'running',
    label: `Agent: ${phase || 'working'}`,
    startedAt,
    episode: episodeId ? { id: episodeId, episodeNumber, seasonNumber } : null,
  });
  return id;
}

async function updateRun(runId, patch = {}) {
  if (!runId) return;
  const fields = [];
  const values = [];
  for (const key of ['phase', 'status', 'goal']) {
    if (patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(patch[key]); }
  }
  if (patch.cursorState !== undefined) { fields.push('cursor_state = ?'); values.push(JSON.stringify(patch.cursorState)); }
  if (patch.lastDecision !== undefined) { fields.push('last_decision = ?'); values.push(JSON.stringify(patch.lastDecision)); }
  if (patch.errorState !== undefined) { fields.push('error_state = ?'); values.push(JSON.stringify(patch.errorState)); }
  if (!fields.length) return;
  values.push(runId);
  await db.execute(`UPDATE agent_runs SET ${fields.join(', ')} WHERE id = ?`, values);
  if (patch.status) {
    pushDashboardActivity({
      runId,
      phase: patch.phase,
      status: patch.status,
      error: patch.errorState?.message || null,
      label: patch.status === 'failed' ? 'Agent failed' : patch.status === 'paused' ? 'Agent paused' : undefined,
    });
  }
}

async function finishRun(runId, status = 'completed', patch = {}) {
  await updateRun(runId, { ...patch, status });
}

async function remember({ storylineId, episodeId = null, scope, key, value, priority = 50, source = 'pipeline' }) {
  if (!storylineId || !scope || !key) return;
  await db.execute(
    `INSERT INTO agent_memory (storyline_id, episode_id, memory_scope, memory_key, memory_value, priority, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE memory_value = VALUES(memory_value), priority = VALUES(priority), source = VALUES(source), updated_at = NOW()`,
    [storylineId, episodeId || '', scope, key, JSON.stringify(value == null ? null : value), priority, source]
  );
}

async function rememberEvent({ runId = null, storylineId = null, episodeId = null, eventType, payload }) {
  await db.execute(
    `INSERT INTO agent_events (run_id, storyline_id, episode_id, event_type, payload) VALUES (?, ?, ?, ?, ?)`,
    [runId || null, storylineId || null, episodeId || '', eventType, JSON.stringify(payload || {})]
  );

  if (eventType === 'production_tool_call' || eventType === 'tool_call') {
    const tool = payload?.tool || null;
    const result = payload?.result || {};
    const failed = Boolean(result?.error || result?.ok === false);
    pushDashboardActivity({
      runId,
      storylineId,
      tool,
      status: failed ? 'failed' : 'completed',
      label: failed ? `Failed: ${tool || 'agent action'}` : undefined,
      error: failed ? result.error : null,
      result: failed ? undefined : result,
      episode: episodeId ? { id: episodeId } : null,
    });
  }
}

async function loadMemory({ storylineId, episodeId = null, scope = null, limit = 60 }) {
  const params = [storylineId];
  let where = 'storyline_id = ?';
  if (episodeId) { where += " AND (episode_id = ? OR episode_id = '')"; params.push(episodeId); }
  if (scope) { where += ' AND memory_scope = ?'; params.push(scope); }
  const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 60));
  return db.query(`SELECT * FROM agent_memory WHERE ${where} ORDER BY priority DESC, updated_at DESC LIMIT ${safeLimit}`, params);
}

async function loadRecentEvents({ storylineId, episodeId = null, limit = 50 }) {
  const params = [storylineId];
  let where = 'storyline_id = ?';
  if (episodeId) { where += " AND (episode_id = ? OR episode_id = '')"; params.push(episodeId); }
  const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  return db.query(`SELECT * FROM agent_events WHERE ${where} ORDER BY created_at DESC LIMIT ${safeLimit}`, params);
}

async function buildGlobalMemorySnapshot({ storyline, episode = null, phase = null }) {
  const storylineId = storyline?.id;
  if (!storylineId) return { storyline: {}, memory: [], events: [] };
  const [memory, events] = await Promise.all([
    loadMemory({ storylineId, episodeId: episode?.id, limit: 80 }),
    loadRecentEvents({ storylineId, episodeId: episode?.id, limit: 50 }),
  ]);
  return {
    phase,
    storyline: {
      id: storyline.id,
      title: storyline.title,
      genre: storyline.genre,
      status: storyline.status,
      current_season: Number(storyline.current_season || 1),
      current_episode: Number(storyline.current_episode || 0),
      episode_count: Number(storyline.episode_count || 0),
      logline: storyline.logline || '',
      central_theme: storyline.central_theme || '',
      season_arcs: asJson(storyline.season_arcs, []),
    },
    memory: memory.map(row => ({ scope: row.memory_scope, key: row.memory_key, value: asJson(row.memory_value, null), priority: row.priority, updated_at: row.updated_at })),
    recent_events: events.map(row => ({ type: row.event_type, payload: asJson(row.payload, {}), created_at: row.created_at })),
  };
}

module.exports = { initAgentMemorySchema, startRun, updateRun, finishRun, remember, rememberEvent, loadMemory, loadRecentEvents, buildGlobalMemorySnapshot };
