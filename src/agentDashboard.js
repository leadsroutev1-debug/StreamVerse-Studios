'use strict';
const db = require('./db');
const state = require('./state');

function json(v, fallback = {}) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

async function getAgentObservability({ storylineId = null, episodeId = null, runId = null, limit = 200 } = {}) {
  const safe = Math.min(500, Math.max(10, Number.parseInt(limit, 10) || 200));
  const params = [];
  const filters = [];
  if (storylineId) { filters.push('storyline_id=?'); params.push(storylineId); }
  if (episodeId) { filters.push('episode_id=?'); params.push(episodeId); }
  if (runId) { filters.push('run_id=?'); params.push(runId); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const [runs, events, calls] = await Promise.all([
    db.query(`SELECT * FROM agent_runs ${where} ORDER BY updated_at DESC LIMIT ${safe}`, params),
    db.query(`SELECT * FROM agent_events ${where} ORDER BY created_at DESC LIMIT ${safe}`, params),
    db.query(`SELECT * FROM agent_llm_calls ${where} ORDER BY created_at DESC LIMIT ${safe}`).catch(() => []),
  ]);
  const toolEvents = events.filter(e => ['production_tool_call','tool_call','tool_result','agent_decision','agent_diagnostic','agent_recovery'].includes(e.event_type));
  const failed = toolEvents.filter(e => {
    const p = json(e.payload, {}); return Boolean(p.error || p.result?.error || p.result?.ok === false);
  }).length;
  const durations = calls.map(c => Number(c.duration_ms || 0)).filter(Boolean);
  const stats = {
    runs: runs.length,
    events: events.length,
    toolEvents: toolEvents.length,
    failures: failed,
    llmCalls: calls.length,
    llmSuccesses: calls.filter(c => c.status === 'success').length,
    llmFailures: calls.filter(c => c.status !== 'success').length,
    avgLlmMs: durations.length ? Math.round(durations.reduce((a,b)=>a+b,0) / durations.length) : 0,
    activeRuns: runs.filter(r => ['running','paused'].includes(r.status)).length,
  };
  return {
    ok: true,
    live: state.getState().agentActivity || null,
    stats,
    runs: runs.map(r => ({...r, cursor_state:json(r.cursor_state,{}), last_decision:json(r.last_decision,{}), error_state:json(r.error_state,{})})),
    events: events.map(e => ({...e, payload:json(e.payload,{})})),
    llmCalls: calls,
    note: 'Decision rationale shown here is the agent\'s recorded action/decision summary, not private chain-of-thought.',
  };
}

async function pruneAgentMemory({ storylineId = null, episodeId = null, keepPriorityAtLeast = 70, olderThanDays = 14, dryRun = false } = {}) {
  const clauses = [];
  const params = [];
  if (storylineId) { clauses.push('storyline_id=?'); params.push(storylineId); }
  if (episodeId) { clauses.push('episode_id=?'); params.push(episodeId); }
  clauses.push('priority < ?'); params.push(Math.max(0, Math.min(100, Number(keepPriorityAtLeast) || 70)));
  clauses.push('updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)'); params.push(Math.max(1, Number(olderThanDays) || 14));
  const where = clauses.join(' AND ');
  const countRows = await db.query(`SELECT COUNT(*) AS count FROM agent_memory WHERE ${where}`, params);
  const count = Number(countRows[0]?.count || 0);
  if (dryRun || count === 0) return { ok:true, dryRun:Boolean(dryRun), pruned:0, eligible:count };
  const result = await db.execute(`DELETE FROM agent_memory WHERE ${where}`, params);
  return { ok:true, dryRun:false, pruned:Number(result.affectedRows || 0), eligible:count };
}

/**
 * Reset agent state without touching studio production data.
 * This removes the agent's resumable runs, episodic memory and telemetry.
 * Storylines, episodes, scripts, shots, characters and media are deliberately
 * left intact so the agent can rediscover the current production state.
 */
async function resetAgentState({ storylineId = null, episodeId = null, includeEvents = true, includeLlmCalls = true } = {}) {
  const scope = [];
  const params = [];
  if (storylineId) { scope.push('storyline_id=?'); params.push(storylineId); }
  if (episodeId) { scope.push('episode_id=?'); params.push(episodeId); }
  const where = scope.length ? `WHERE ${scope.join(' AND ')}` : '';

  return db.transaction(async (conn) => {
    const deleted = { runs: 0, memory: 0, events: 0, llmCalls: 0 };
    const [runsResult] = await conn.execute(`DELETE FROM agent_runs ${where}`, params);
    deleted.runs = Number(runsResult.affectedRows || 0);
    const [memoryResult] = await conn.execute(`DELETE FROM agent_memory ${where}`, params);
    deleted.memory = Number(memoryResult.affectedRows || 0);
    if (includeEvents) {
      const [eventsResult] = await conn.execute(`DELETE FROM agent_events ${where}`, params);
      deleted.events = Number(eventsResult.affectedRows || 0);
    }
    if (includeLlmCalls) {
      try {
        const [llmResult] = await conn.execute(`DELETE FROM agent_llm_calls ${where}`, params);
        deleted.llmCalls = Number(llmResult.affectedRows || 0);
      } catch (err) {
        // Older deployments may not have the optional LLM telemetry table.
        if (!/doesn't exist|unknown table|ER_NO_SUCH_TABLE/i.test(String(err.message || ''))) throw err;
      }
    }
    try { state.setAgentActivity(null); } catch (_) {}
    return { ok: true, scope: { storylineId, episodeId }, deleted, productionDataUntouched: true };
  });
}

module.exports = { getAgentObservability, pruneAgentMemory, resetAgentState };