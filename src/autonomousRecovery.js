'use strict';

const axios = require('axios');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');

const execFileAsync = promisify(execFile);

const db = require('./db');
const config = require('./config');

const PIPELINE_STATES = Object.freeze([
  'SEASON_SIMULATION',
  'SEASON_LOCKED',
  'EPISODE_SELECTED',
  'EPISODE_SIMULATION',
  'SCENE_SIMULATION',
  'SHOT_SIMULATION',
  'MEDIA_GENERATION',
  'COMPOSITION',
  'VALIDATION',
  'PUBLISHED',
]);

const STATE_ORDER = Object.freeze(Object.fromEntries(PIPELINE_STATES.map((s, i) => [s, i])));

const STATE_GRAPH = Object.freeze({
  SEASON_SIMULATION: ['SEASON_LOCKED'],
  SEASON_LOCKED: ['EPISODE_SELECTED'],
  EPISODE_SELECTED: ['EPISODE_SIMULATION'],
  EPISODE_SIMULATION: ['SCENE_SIMULATION'],
  SCENE_SIMULATION: ['SHOT_SIMULATION'],
  SHOT_SIMULATION: ['MEDIA_GENERATION'],
  MEDIA_GENERATION: ['COMPOSITION'],
  COMPOSITION: ['VALIDATION'],
  VALIDATION: ['PUBLISHED'],
  PUBLISHED: [],
});

const CONTRACTS = Object.freeze({
  shot: {
    minDuration: 6,
    maxDuration: 10,
    mustHavePrompt: true,
    mustBelongToScene: true,
    mustHaveRenderableAsset: true,
  },
  scene: {
    mustBeSequential: true,
    mustHaveShots: true,
    mustHaveOpeningState: true,
    mustHaveClosingState: true,
    mustHaveHandoff: true,
  },
  episode: {
    mustHaveTrajectory: true,
    mustHaveSceneSimulation: true,
    mustHaveShotSimulation: true,
    mustRespectCheckpointOrder: true,
  },
});



function asJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function clamp(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function normalizeState(state) {
  const s = String(state || '').trim().toUpperCase();
  if (STATE_ORDER[s] !== undefined) return s;
  return null;
}

function validateStateTransition(from, to) {
  const f = normalizeState(from);
  const t = normalizeState(to);
  if (!f || !t) return { valid: false, reason: 'Unknown pipeline state', from: f, to: t };
  if (f === t) return { valid: true, same_state: true, from: f, to: t };
  const valid = STATE_GRAPH[f]?.includes(t) === true;
  return { valid, from: f, to: t, reason: valid ? 'Allowed transition' : `Transition ${f} -> ${t} is not in the authoritative graph` };
}

function validateCurrentState(context = {}) {
  const actual = normalizeState(context.state || context.current_state);
  const completed = Array.isArray(context.completed_states) ? context.completed_states.map(normalizeState).filter(Boolean) : [];
  if (!actual) return { valid: false, reason: 'No recognizable current state', state: null };
  const expectedPredecessor = STATE_ORDER[actual] > 0 ? PIPELINE_STATES[STATE_ORDER[actual] - 1] : null;
  const predecessorSatisfied = !expectedPredecessor || completed.includes(expectedPredecessor) || actual === PIPELINE_STATES[0];
  return { valid: predecessorSatisfied, state: actual, expected_predecessor: expectedPredecessor, completed_states: completed };
}

function classifyError(error) {
  const text = `${error?.code || ''} ${error?.message || error || ''}`.toLowerCase();
  let category = 'unknown';
  if (/429|rate.?limit|quota|zerogpu|credits? exhausted/.test(text)) category = 'rate_limit';
  else if (/timeout|timed out|etimedout|econnreset|socket hang up/.test(text)) category = 'timeout';
  else if (/401|403|unauthori[sz]|forbidden|invalid.*key|authentication/.test(text)) category = 'auth';
  else if (/no such table|unknown column|unknown table|schema|constraint|foreign key|duplicate key/.test(text)) category = 'database';
  else if (/ffmpeg|composition|compose|mux|codec|moov atom|invalid data/.test(text)) category = 'media';
  else if (/cloudinary|cdn|upload/.test(text)) category = 'cloudinary';
  else if (/mistral|llm|model|tool call|json/.test(text)) category = 'llm';
  else if (/safety|content flagged|policy/.test(text)) category = 'safety';
  else if (/network|dns|enotfound|eai_again/.test(text)) category = 'network';
  return { category, transient: ['rate_limit', 'timeout', 'network'].includes(category), raw: String(error?.message || error || '').slice(0, 1000) };
}

function correlateRelatedErrors(errors = []) {
  const list = Array.isArray(errors) ? errors : [];
  const groups = new Map();
  for (const e of list) {
    const c = classifyError(e);
    const key = `${c.category}:${e?.phase || e?.pipeline_layer || 'unknown'}`;
    const arr = groups.get(key) || [];
    arr.push(e);
    groups.set(key, arr);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, count: items.length, first: items[items.length - 1] || null, latest: items[0] || null }));
}

function findFirstFailure(errors = []) {
  return [...(Array.isArray(errors) ? errors : [])]
    .sort((a, b) => new Date(a?.created_at || a?.at || 0) - new Date(b?.created_at || b?.at || 0))[0] || null;
}

function findCascadeFailures(errors = []) {
  const sorted = [...(Array.isArray(errors) ? errors : [])].sort((a, b) => new Date(a?.created_at || 0) - new Date(b?.created_at || 0));
  const first = sorted[0];
  if (!first) return [];
  const firstClass = classifyError(first);
  return sorted.slice(1).filter(e => classifyError(e).category !== firstClass.category);
}

function findRepeatedFailure(errors = []) {
  const groups = correlateRelatedErrors(errors).sort((a, b) => b.count - a.count);
  return groups[0] || null;
}

function detectLoop(errors = [], type) {
  const sorted = [...(Array.isArray(errors) ? errors : [])].sort((a, b) => new Date(a?.created_at || 0) - new Date(b?.created_at || 0));
  if (sorted.length < 3) return { detected: false, count: sorted.length };
  const matches = sorted.filter(e => classifyError(e).category === type);
  return { detected: matches.length >= 3, count: matches.length, type };
}

async function queryFullDatabaseSchema({ includeCreateSql = true, includeTriggers = true, includeViews = true, tableFilter = null } = {}) {
  const databaseName = (await db.queryOne('SELECT DATABASE() AS database_name'))?.database_name;
  if (!databaseName) throw new Error('No active MySQL database selected');

  const tableClause = tableFilter ? ' AND TABLE_NAME = ?' : '';
  const params = tableFilter ? [tableFilter] : [];
  const tables = await db.query(
    `SELECT TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_COLLATION,CREATE_OPTIONS,TABLE_ROWS
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE()${tableClause}
      ORDER BY TABLE_NAME`, params);
  const columns = await db.query(
    `SELECT TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,COLUMN_DEFAULT,IS_NULLABLE,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,
            NUMERIC_PRECISION,NUMERIC_SCALE,DATETIME_PRECISION,COLUMN_TYPE,COLUMN_KEY,EXTRA,COLUMN_COMMENT,GENERATION_EXPRESSION
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE()${tableClause}
      ORDER BY TABLE_NAME,ORDINAL_POSITION`, params);
  const indexes = await db.query(
    `SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,COLLATION,CARDINALITY,SUB_PART,INDEX_TYPE,INDEX_COMMENT
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE()${tableClause}
      ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`, params);
  const foreignKeys = await db.query(
    `SELECT kcu.CONSTRAINT_NAME,kcu.TABLE_NAME,kcu.COLUMN_NAME,kcu.REFERENCED_TABLE_NAME,kcu.REFERENCED_COLUMN_NAME,
            rc.UPDATE_RULE,rc.DELETE_RULE,rc.MATCH_OPTION
       FROM information_schema.KEY_COLUMN_USAGE kcu
       LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
        AND rc.TABLE_NAME=kcu.TABLE_NAME
      WHERE kcu.CONSTRAINT_SCHEMA=DATABASE()
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
        ${tableFilter ? 'AND kcu.TABLE_NAME = ?' : ''}
      ORDER BY kcu.TABLE_NAME,kcu.CONSTRAINT_NAME,kcu.ORDINAL_POSITION`, params);

  const result = { database: databaseName, generated_at: new Date().toISOString(), tables, columns, indexes, foreign_keys: foreignKeys };
  if (includeCreateSql) {
    result.create_statements = {};
    for (const table of tables) {
      if (table.TABLE_TYPE !== 'BASE TABLE') continue;
      const safe = String(table.TABLE_NAME).replace(/`/g, '``');
      const row = await db.queryOne(`SHOW CREATE TABLE \`${safe}\``);
      result.create_statements[table.TABLE_NAME] = row?.['Create Table'] || null;
    }
  }
  if (includeViews) {
    result.views = await db.query(
      `SELECT TABLE_NAME,VIEW_DEFINITION,CHECK_OPTION,IS_UPDATABLE,SECURITY_TYPE
         FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE()${tableFilter ? ' AND TABLE_NAME = ?' : ''}
        ORDER BY TABLE_NAME`, params);
  }
  if (includeTriggers) {
    result.triggers = await db.query(
      `SELECT TRIGGER_NAME,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_TIMING,ACTION_STATEMENT
         FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()${tableFilter ? ' AND EVENT_OBJECT_TABLE = ?' : ''}
        ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME`, params);
  }
  return result;
}

async function queryTableState(table) {
  const name = String(table || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('Invalid table name');
  const exists = await db.queryOne(
    `SELECT TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_ROWS,TABLE_COLLATION,CREATE_OPTIONS
       FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [name]);
  if (!exists) return { table: name, exists: false };
  const columns = await db.query(
    `SELECT COLUMN_NAME,ORDINAL_POSITION,DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLUMN_KEY,EXTRA
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
      ORDER BY ORDINAL_POSITION`, [name]);
  const indexes = await db.query(
    `SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,INDEX_TYPE
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
      ORDER BY INDEX_NAME,SEQ_IN_INDEX`, [name]);
  const foreignKeys = await db.query(
    `SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION`, [name]);
  return { table: name, exists: true, columns, indexes, foreign_keys: foreignKeys };
}

async function compareExpectedVsActualSchema() {
  const authority = db.getAuthoritativeDbJsSchema();
  const actual = await queryFullDatabaseSchema({ includeCreateSql: false, includeViews: true, includeTriggers: true });
  const actualMap = new Map(actual.tables.map(t => [t.TABLE_NAME, t]));
  const actualCols = new Set(actual.columns.map(c => `${c.TABLE_NAME}.${c.COLUMN_NAME}`));
  const missingTables = [];
  const missingColumns = [];
  const typeMismatches = [];

  for (const spec of authority.tables) {
    const table = spec.table;
    if (!actualMap.has(table)) {
      missingTables.push(table);
      continue;
    }
    for (const [column, expectedDefinition] of Object.entries(spec.columns)) {
      const c = actual.columns.find(x => x.TABLE_NAME === table && x.COLUMN_NAME === column);
      if (!c) missingColumns.push({ table, column, expectedDefinition });
      else {
        const expectedBase = String(expectedDefinition || '').trim().split(/\s+/)[0].replace(/[(),].*$/, '').toUpperCase();
        const actualType = String(c.DATA_TYPE || '').toUpperCase();
        if (expectedBase && !actualType.includes(expectedBase)) {
          typeMismatches.push({ table, column, expectedDefinition, actualType: c.DATA_TYPE, columnType: c.COLUMN_TYPE });
        }
      }
    }
  }

  return {
    ok: !missingTables.length && !missingColumns.length && !typeMismatches.length,
    authority: {
      source: authority.authority,
      source_file: authority.source_file,
      source_mtime_ms: authority.source_mtime_ms,
      table_count: authority.table_count,
    },
    missingTables,
    missingColumns,
    typeMismatches,
    actual_table_count: actual.tables.length,
    checked_at: new Date().toISOString(),
    actual_column_count: actualCols.size,
  };
}

async function traceForeignKeys(table = null) {
  const where = table ? ' AND kcu.TABLE_NAME = ?' : '';
  return db.query(
    `SELECT kcu.TABLE_NAME,kcu.CONSTRAINT_NAME,kcu.COLUMN_NAME,kcu.REFERENCED_TABLE_NAME,kcu.REFERENCED_COLUMN_NAME,
            rc.UPDATE_RULE,rc.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE kcu
       LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
        AND rc.TABLE_NAME=kcu.TABLE_NAME
      WHERE kcu.CONSTRAINT_SCHEMA=DATABASE()
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL${where}
      ORDER BY kcu.TABLE_NAME,kcu.CONSTRAINT_NAME,kcu.ORDINAL_POSITION`, table ? [table] : []);
}

async function inspectConstraints(table = null) {
  const where = table ? ' AND tc.TABLE_NAME = ?' : '';
  return db.query(
    `SELECT tc.TABLE_NAME,tc.CONSTRAINT_NAME,tc.CONSTRAINT_TYPE,kcu.COLUMN_NAME,kcu.REFERENCED_TABLE_NAME,kcu.REFERENCED_COLUMN_NAME
       FROM information_schema.TABLE_CONSTRAINTS tc
       LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND kcu.TABLE_NAME=tc.TABLE_NAME
        AND kcu.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA=DATABASE()${where}
      ORDER BY tc.TABLE_NAME,tc.CONSTRAINT_NAME`, table ? [table] : []);
}

async function inspectIndexes(table = null) {
  const where = table ? ' AND TABLE_NAME=?' : '';
  return db.query(`SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,INDEX_TYPE,CARDINALITY FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()${where} ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`, table ? [table] : []);
}

async function inspectTriggers(table = null) {
  const where = table ? ' AND EVENT_OBJECT_TABLE=?' : '';
  return db.query(`SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,EVENT_MANIPULATION,ACTION_TIMING,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()${where} ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME`, table ? [table] : []);
}

async function inspectViews() {
  return db.query(`SELECT TABLE_NAME,VIEW_DEFINITION,CHECK_OPTION,IS_UPDATABLE,SECURITY_TYPE FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`);
}

async function inspectMigrations() {
  const tables = await db.query(`SHOW TABLES`);
  const names = tables.map(row => Object.values(row)[0]).filter(Boolean);
  return names.filter(n => /migration|schema|version/i.test(n)).map(name => ({ table: name }));
}

async function detectSchemaDrift() {
  const comparison = await compareExpectedVsActualSchema();
  const authority = db.getAuthoritativeDbJsSchema();
  const authoritativeNames = new Set(authority.tables.map(t => t.table));
  const customTables = (await queryFullDatabaseSchema({ includeCreateSql: false })).tables
    .map(t => t.TABLE_NAME).filter(name => !authoritativeNames.has(name) && !/^analytics_|^users$|^announcements$|^user_/i.test(name));
  return { ...comparison, unexpected_coreish_tables: customTables };
}

async function generateSchemaMigrationPlan() {
  const drift = await compareExpectedVsActualSchema();
  return {
    safe_to_apply: drift.missingTables.length > 0 || drift.missingColumns.length > 0,
    actions: [
      ...drift.missingTables.map(table => ({ type: 'ensure_application_schema', table, risk: 'low', reason: 'Canonical application table is missing' })),
      ...drift.missingColumns.map(x => ({ type: 'ensure_application_schema_column', ...x, risk: 'low', reason: 'Canonical application column is missing' })),
      ...drift.typeMismatches.map(x => ({ type: 'manual_schema_review', ...x, risk: 'high', reason: 'Existing column type differs from canonical expectation; no automatic destructive change is permitted' })),
    ],
    note: 'The agent never receives arbitrary SQL execution authority. Schema changes are applied only through idempotent application migrations.',
  };
}

async function verifyMigration() {
  const drift = await compareExpectedVsActualSchema();
  return { verified: drift.ok, drift };
}

async function rollbackMigration() {
  return { rolled_back: false, reason: 'Schema rollback is intentionally not an arbitrary SQL operation. Use a recorded migration inverse from the recovery ledger or restore the pre-repair state snapshot for data changes.' };
}

function normalizeSceneShots(script) {
  const shots = Array.isArray(script?.shot_simulation?.shots) ? script.shot_simulation.shots : [];
  return shots.slice().sort((a, b) => Number(a?.scene_number) - Number(b?.scene_number) || Number(a?.shot_index) - Number(b?.shot_index));
}

function validateAllInvariants(script, persistedShots = []) {
  const violations = [];
  const scenes = Array.isArray(script?.scene_simulation?.scene_beat_plan) ? script.scene_simulation.scene_beat_plan.slice().sort((a,b) => Number(a.scene_number)-Number(b.scene_number)) : [];
  if (CONTRACTS.episode.mustHaveSceneSimulation && !scenes.length) violations.push({ kind: 'missing_scene_simulation' });
  for (let i=0;i<scenes.length;i++) {
    const n = Number(scenes[i]?.scene_number);
    if (n !== i+1) violations.push({ kind: 'scene_gap_or_reorder', expected: i+1, actual: n });
    if (CONTRACTS.scene.mustHaveShots) {
      const sceneShots = normalizeSceneShots(script).filter(s => Number(s.scene_number) === n);
      if (!sceneShots.length) violations.push({ kind: 'scene_has_no_shots', scene_number: n });
    }
    for (const k of ['opening_state','closing_state','handoff_to_next_scene']) {
      if (!String(scenes[i]?.[k] || '').trim()) violations.push({ kind: `scene_missing_${k}`, scene_number: n });
    }
  }
  const shots = normalizeSceneShots(script);
  if (CONTRACTS.episode.mustHaveShotSimulation && !shots.length) violations.push({ kind: 'missing_shot_simulation' });
  const perScene = new Map();
  for (const shot of shots) {
    const sceneNumber = Number(shot?.scene_number);
    const idx = Number(shot?.shot_index);
    const arr = perScene.get(sceneNumber) || [];
    arr.push(shot);
    perScene.set(sceneNumber, arr);
    const duration = Number(shot?.duration_seconds ?? shot?.duration ?? shot?.clip_duration);
    if (!Number.isFinite(duration)) violations.push({ kind: 'shot_missing_duration', scene_number: sceneNumber, shot_index: idx });
    else if (duration < CONTRACTS.shot.minDuration || duration > CONTRACTS.shot.maxDuration) violations.push({ kind: 'shot_duration_out_of_range', scene_number: sceneNumber, shot_index: idx, duration });
    if (CONTRACTS.shot.mustHavePrompt && !String(shot?.prompt || shot?.image_prompt || shot?.video_prompt || '').trim()) violations.push({ kind: 'shot_missing_prompt', scene_number: sceneNumber, shot_index: idx });
    if (CONTRACTS.shot.mustBelongToScene && !Number.isFinite(sceneNumber)) violations.push({ kind: 'shot_missing_scene', shot_index: idx });
  }
  for (const [sceneNumber, arr] of perScene.entries()) {
    arr.sort((a,b) => Number(a.shot_index)-Number(b.shot_index));
    for (let i=0;i<arr.length;i++) if (Number(arr[i]?.shot_index) !== i+1) violations.push({ kind: 'shot_gap_or_reorder', scene_number: sceneNumber, expected: i+1, actual: Number(arr[i]?.shot_index) });
  }
  const persisted = Array.isArray(persistedShots) ? persistedShots : [];
  const durableMissingMedia = persisted.filter(row => row.status === 'done' && !row.clip_url);
  for (const row of durableMissingMedia) violations.push({ kind: 'done_shot_missing_clip', scene_number: row.scene_number, shot_index: row.shot_index });
  return { ok: violations.length === 0, violations, contracts: CONTRACTS };
}

async function diagnoseDatabaseIntegrity() {
  const schema = await compareExpectedVsActualSchema();
  const fk = await traceForeignKeys();
  const constraints = await inspectConstraints();
  return { ok: schema.ok, schema, foreign_keys: fk, constraints_count: constraints.length };
}

async function diagnoseEpisodeIntegrity(episodeId) {
  const row = await db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episodeId]);
  if (!row) return { ok: false, missing: true, episode_id: episodeId };
  const script = asJson(row.script, {});
  const shots = await db.query(`SELECT * FROM shots WHERE episode_id=? ORDER BY scene_number,shot_index`, [episodeId]);
  const invariants = validateAllInvariants(script, shots);
  return {
    ok: invariants.ok,
    episode_id: episodeId,
    status: row.status,
    checkpoint_state: asJson(script.checkpoint_state, {}),
    invariants,
    counts: { declared_scenes: Number(row.scene_count || 0), declared_shots: Number(row.shot_count || 0), persisted_shots: shots.length },
  };
}

async function diagnoseSceneIntegrity(episodeId, sceneNumber) {
  const row = await db.queryOne(`SELECT id,script FROM episodes WHERE id=?`, [episodeId]);
  if (!row) return { ok: false, missing_episode: true };
  const script = asJson(row.script, {});
  const n = Number(sceneNumber);
  const scene = (script?.scene_simulation?.scene_beat_plan || []).find(x => Number(x.scene_number) === n);
  const blueprint = (script?.scenes || []).find(x => Number(x.scene_number) === n);
  const shots = (script?.shot_simulation?.shots || []).filter(x => Number(x.scene_number) === n);
  const persisted = await db.query(`SELECT * FROM shots WHERE episode_id=? AND scene_number=? ORDER BY shot_index`, [episodeId,n]);
  const violations = [];
  if (!scene) violations.push({ kind:'missing_scene_simulation' });
  if (scene && !String(scene.opening_state || '').trim()) violations.push({ kind:'missing_opening_state' });
  if (scene && !String(scene.closing_state || '').trim()) violations.push({ kind:'missing_closing_state' });
  if (scene && !String(scene.handoff_to_next_scene || '').trim()) violations.push({ kind:'missing_handoff' });
  if (!shots.length) violations.push({ kind:'missing_shots' });
  const local = validateAllInvariants({ ...script, scene_simulation: { ...(script.scene_simulation || {}), scene_beat_plan: scene ? [scene] : [] }, shot_simulation: { shots } }, persisted);
  return { ok: violations.length === 0 && local.ok, scene_number:n, scene, blueprint, shots, persisted_shots:persisted, violations:[...violations,...local.violations] };
}

async function diagnoseShotIntegrity(episodeId, sceneNumber, shotIndex) {
  const row = await db.queryOne(`SELECT * FROM shots WHERE episode_id=? AND scene_number=? AND shot_index=?`, [episodeId,sceneNumber,shotIndex]);
  const ep = await db.queryOne(`SELECT script,status FROM episodes WHERE id=?`, [episodeId]);
  if (!ep) return { ok:false, missing_episode:true };
  const script = asJson(ep.script, {});
  const spec = (script?.shot_simulation?.shots || []).find(s => Number(s.scene_number)===Number(sceneNumber) && Number(s.shot_index)===Number(shotIndex));
  const violations = [];
  if (!spec) violations.push({ kind:'missing_shot_simulation' });
  if (!row) violations.push({ kind:'missing_persisted_shot_row' });
  if (spec) {
    const d = Number(spec.duration_seconds ?? spec.duration);
    if (!Number.isFinite(d) || d < 6 || d > 10) violations.push({ kind:'duration_contract_violation', duration:d });
    if (!String(spec.prompt || spec.image_prompt || spec.video_prompt || '').trim()) violations.push({kind:'missing_prompt'});
  }
  if (row?.status === 'done' && !row.clip_url) violations.push({kind:'done_without_media'});
  return { ok: violations.length === 0, episode_id:episodeId, scene_number:Number(sceneNumber), shot_index:Number(shotIndex), simulation:spec, persisted:row, violations };
}

async function diagnoseCheckpointIntegrity(episodeId) {
  const row = await db.queryOne(`SELECT id,script,status FROM episodes WHERE id=?`, [episodeId]);
  if (!row) return { ok:false, missing:true };
  const script = asJson(row.script,{});
  const stage = String(script?.checkpoint_state?.stage || '').toLowerCase();
  const allowed = new Set(['blueprint','scene_simulation','shot_simulation','shot_writing','render','ready']);
  const violations = [];
  if (stage && !allowed.has(stage)) violations.push({kind:'unknown_checkpoint_stage',stage});
  const inv = validateCurrentState({ state: stage === 'ready' ? 'VALIDATION' : stage === 'render' ? 'MEDIA_GENERATION' : stage === 'shot_writing' ? 'SHOT_SIMULATION' : stage === 'shot_simulation' ? 'SHOT_SIMULATION' : stage === 'scene_simulation' ? 'SCENE_SIMULATION' : 'EPISODE_SIMULATION', completed_states: [] });
  return { ok: violations.length===0, episode_id:episodeId, checkpoint:script?.checkpoint_state || null, status:row.status, state_validation:inv, violations };
}

async function diagnosePipelineFailure(input = {}) {
  const error = input.error || input.message || '';
  const classified = classifyError({ message:error, code:input.code });
  const errors = await queryRecentErrors({ storylineId:input.storylineId || null, episodeId:input.episodeId || null, limit:30 });
  return {
    classified,
    first_failure: findFirstFailure(errors),
    cascade_failures: findCascadeFailures(errors),
    repeated_failure: findRepeatedFailure(errors),
    retry_loop: detectRetryLoop(errors),
    timeout_loop: detectTimeoutLoop(errors),
    rate_limit_loop: detectRateLimitLoop(errors),
    provider_degradation: detectProviderDegradation(errors),
  };
}

async function queryPipelineState(storylineId = null, episodeId = null) {
  const ep = episodeId ? await db.queryOne(`SELECT id,status,episode_number,season_number,scene_count,shot_count,paused_reason,ready_at,posted_at,updated_at,script FROM episodes WHERE id=?`,[episodeId]) : null;
  const sl = storylineId ? await db.queryOne(`SELECT id,status,current_season,current_episode,episode_count,updated_at,full_story_simulation FROM storylines WHERE id=?`,[storylineId]) : null;
  const script = asJson(ep?.script,{});
  const checkpoint = script?.checkpoint_state || {};
  const activeStage = checkpoint.stage || (ep?.status === 'ready' ? 'ready' : 'unknown');
  return { storyline:sl, episode:ep ? { ...ep, script:undefined } : null, checkpoint, inferred_state: activeStage, state_graph: PIPELINE_STATES };
}

async function queryActiveJobs(episodeId = null) {
  const where = episodeId ? " WHERE episode_id=? AND status IN ('pending','mh_submitted')" : " WHERE status IN ('pending','mh_submitted')";
  return db.query(`SELECT id,episode_id,scene_number,shot_index,status,mh_job_id,ltx_status,updated_at,last_error FROM shots${where} ORDER BY updated_at DESC`, episodeId ? [episodeId] : []);
}

async function queryRecentErrors({ storylineId=null, episodeId=null, limit=50 }={}) {
  const safeLimit = clamp(limit,1,200);
  const params = [];
  const filters = [];
  if (episodeId) { filters.push('s.episode_id=?'); params.push(episodeId); }
  const shotRows = await db.query(
    `SELECT 'shot' AS source,s.episode_id,s.scene_number,s.shot_index,s.last_error AS message,s.failure_reason,s.updated_at AS created_at,s.status
       FROM shots s
      WHERE s.last_error IS NOT NULL ${filters.length ? 'AND '+filters.join(' AND ') : ''}
      ORDER BY s.updated_at DESC LIMIT ${Math.floor(safeLimit)}`, params);
  let eventParams=[];
  const ef=[];
  if (storylineId) { ef.push('storyline_id=?'); eventParams.push(storylineId); }
  if (episodeId) { ef.push('episode_id=?'); eventParams.push(episodeId); }
  const eventRows = await db.query(
    `SELECT 'agent_event' AS source,episode_id,NULL AS scene_number,NULL AS shot_index,
            CONCAT(event_type, ": ", JSON_UNQUOTE(JSON_EXTRACT(payload,'$.message'))) AS message,
            event_type AS failure_reason,created_at
       FROM agent_events ${ef.length ? 'WHERE '+ef.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT ${Math.floor(safeLimit)}`, eventParams);
  return [...shotRows,...eventRows].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,Math.floor(safeLimit));
}

async function queryRecentLlmCalls({ runId=null, limit=50 }={}) {
  const safeLimit = Math.floor(clamp(limit,1,200));
  const rows = await db.query(
    `SELECT * FROM agent_llm_calls ${runId ? 'WHERE run_id=?' : ''}
     ORDER BY created_at DESC LIMIT ${safeLimit}`, runId ? [runId] : []);
  return rows;
}

async function queryProviderHealth() {
  const result = { mistral: config.keyHealth?.mistral || [], video_provider: config.videoProvider, ltx: { tokens: (config.hfTokens || []).length }, observed_at:new Date().toISOString() };
  try {
    const response = await axios.get('https://api.mistral.ai/v1/models', {
      headers: config.mistralKeys?.[0] ? { Authorization:`Bearer ${config.mistralKeys[0]}` } : {},
      timeout: 12000,
    });
    result.mistral_api = { ok: response.status >= 200 && response.status < 300, status: response.status };
  } catch (err) {
    result.mistral_api = { ok:false, status:err?.response?.status || null, error:String(err?.message || err).slice(0,300) };
  }
  return result;
}

async function queryMediaAssets(episodeId) {
  if (!episodeId) return [];
  return db.query(`SELECT id,scene_number,shot_index,status,image_url,clip_url,clip_duration,editorial_url,updated_at FROM shots WHERE episode_id=? ORDER BY scene_number,shot_index`,[episodeId]);
}

async function queryCloudinaryAsset(url) {
  if (!url) return { ok:false, reason:'missing_url' };
  try {
    const r = await axios.head(url,{timeout:15000,validateStatus:()=>true});
    return { ok:r.status >= 200 && r.status < 400, status:r.status, contentType:r.headers['content-type'] || null, contentLength:r.headers['content-length'] || null, url };
  } catch (err) {
    return { ok:false, error:err.message, url };
  }
}

async function inspectVideo(url) {
  if (!url) return { ok:false, reason:'missing_url' };
  const { path } = await downloadAssetToTemp(url,'video');
  try {
    const { stdout } = await execFileAsync('ffprobe',['-v','error','-print_format','json','-show_format','-show_streams',path],{timeout:30000});
    const info = JSON.parse(stdout);
    const video = (info.streams||[]).find(s=>s.codec_type==='video') || null;
    const audio = (info.streams||[]).find(s=>s.codec_type==='audio') || null;
    return {
      ok:true,
      format:info.format||null,
      duration:Number(info.format?.duration||0),
      resolution:video ? { width:video.width, height:video.height } : null,
      fps:video ? evalFps(video.avg_frame_rate || video.r_frame_rate) : null,
      video_codec:video?.codec_name || null,
      audio_codec:audio?.codec_name || null,
      has_audio:!!audio,
      streams:(info.streams||[]).map(s=>({codec_type:s.codec_type,codec_name:s.codec_name,width:s.width,height:s.height,duration:s.duration})),
    };
  } finally { await safeUnlink(path); }
}

function evalFps(value) {
  const [a,b]=String(value||'').split('/').map(Number);
  if (Number.isFinite(a)&&Number.isFinite(b)&&b) return a/b;
  const n=Number(value); return Number.isFinite(n)?n:null;
}

async function inspectDuration(url) { const i=await inspectVideo(url); return { ok:i.ok, duration:i.duration }; }
async function inspectResolution(url) { const i=await inspectVideo(url); return { ok:i.ok, resolution:i.resolution }; }
async function inspectFps(url) { const i=await inspectVideo(url); return { ok:i.ok, fps:i.fps }; }

async function detectCorruption(url) {
  if (!url) return { corrupted:true, reason:'missing_url' };
  const { path } = await downloadAssetToTemp(url,'video');
  try {
    await execFileAsync('ffmpeg',['-v','error','-i',path,'-f','null','-'],{timeout:90000});
    return { corrupted:false };
  } catch (err) {
    return { corrupted:true, reason:String(err?.stderr || err?.message || err).slice(0,1000) };
  } finally { await safeUnlink(path); }
}

async function detectMissingAudio(url) { const i=await inspectVideo(url); return { ok:i.ok, missing_audio:i.ok ? !i.has_audio : null }; }

async function detectBlackFrames(url) {
  const { path } = await downloadAssetToTemp(url,'video');
  try {
    const { stdout } = await execFileAsync('ffmpeg',['-v','error','-i',path,'-vf','blackdetect=d=0.5:pix_th=0.98','-an','-f','null','-'],{timeout:90000,maxBuffer:2*1024*1024});
    return { ok:true, detected:/black_start:/.test(stdout), raw:stdout.slice(0,2000) };
  } catch (err) { return { ok:false, error:String(err?.stderr || err?.message || err).slice(0,1000) }; }
  finally { await safeUnlink(path); }
}

async function detectFrozenFrames(url) {
  const { path } = await downloadAssetToTemp(url,'video');
  try {
    const { stdout } = await execFileAsync('ffmpeg',['-v','error','-i',path,'-vf','freezedetect=n=-60dB:d=1','-an','-f','null','-'],{timeout:90000,maxBuffer:2*1024*1024});
    return { ok:true, detected:/freeze_start:/.test(stdout), raw:stdout.slice(0,2000) };
  } catch (err) { return { ok:false, error:String(err?.stderr || err?.message || err).slice(0,1000) }; }
  finally { await safeUnlink(path); }
}

async function downloadAssetToTemp(url, prefix) {
  const path = `/tmp/streamverse_${prefix}_${uuidv4()}`;
  const response = await axios.get(url,{responseType:'arraybuffer',timeout:30000});
  require('fs').writeFileSync(path,Buffer.from(response.data));
  return { path };
}

async function safeUnlink(path) {
  try { require('fs').unlinkSync(path); } catch {}
}

async function compareExpectedVsActualDuration(expected, actual) {
  const e=Number(expected), a=Number(actual);
  const delta=(Number.isFinite(e)&&Number.isFinite(a)) ? a-e : null;
  return { expected:e, actual:a, delta, within_tolerance:delta!=null ? Math.abs(delta)<=0.25 : false };
}

async function verifyCloudinaryAsset(url) { return queryCloudinaryAsset(url); }

function detectRetryLoop(errors) {
  const arr=Array.isArray(errors)?errors:[];
  const norm=new Map();
  for(const e of arr){
    const key=String(e?.message || e?.last_error || '').toLowerCase().replace(/\d+/g,'#').replace(/\s+/g,' ').trim().slice(0,240);
    if(!key) continue;
    norm.set(key,(norm.get(key)||0)+1);
  }
  const repeated=[...norm.entries()].sort((a,b)=>b[1]-a[1])[0];
  return repeated && repeated[1] >= 3
    ? {detected:true,count:repeated[1],signature:repeated[0],type:'retry_loop'}
    : {detected:false,count:arr.length,type:'retry_loop'};
}
function detectTimeoutLoop(errors) { return detectLoop(errors,'timeout'); }
function detectRateLimitLoop(errors) { return detectLoop(errors,'rate_limit'); }
function detectProviderDegradation(errors) {
  const arr=Array.isArray(errors)?errors:[];
  const providerErrors=arr.filter(e=>['rate_limit','timeout','network','auth'].includes(classifyError(e).category));
  return { degraded:providerErrors.length>=3, samples:providerErrors.slice(0,10).map(e=>({at:e.created_at,message:e.message,category:classifyError(e).category})) };
}

async function createStateSnapshot({ storylineId=null, episodeId=null, reason='recovery' }={}) {
  const snapshotId=uuidv4();
  const data={};
  if (storylineId) data.storyline=await db.queryOne(`SELECT * FROM storylines WHERE id=?`,[storylineId]);
  if (episodeId) {
    data.episode=await db.queryOne(`SELECT * FROM episodes WHERE id=?`,[episodeId]);
    data.shots=await db.query(`SELECT * FROM shots WHERE episode_id=? ORDER BY scene_number,shot_index`,[episodeId]);
  }
  await db.execute(`INSERT INTO agent_recovery_snapshots (id,storyline_id,episode_id,reason,snapshot_payload) VALUES (?,?,?,?,?)`,
    [snapshotId,storylineId||null,episodeId||null,reason,JSON.stringify(data)]);
  return { snapshot_id:snapshotId, created_at:new Date().toISOString(), summary:{has_storyline:!!data.storyline,has_episode:!!data.episode,shots:data.shots?.length||0} };
}

async function restoreStateSnapshot(snapshotId) {
  const snap=await db.queryOne(`SELECT * FROM agent_recovery_snapshots WHERE id=?`,[snapshotId]);
  if (!snap) throw new Error(`Snapshot ${snapshotId} not found`);
  const payload=asJson(snap.snapshot_payload,{});
  await db.transaction(async conn=>{
    const q=(sql,params=[])=>conn.execute(sql,params);
    if (payload.storyline) {
      const keys=Object.keys(payload.storyline).filter(k=>!['id','created_at','updated_at'].includes(k));
      if (keys.length) {
        await q(
          `UPDATE storylines SET ${keys.map(k=>`\`${k}\`=?`).join(',')} WHERE id=?`,
          [...keys.map(k => payload.storyline[k]), payload.storyline.id],
        );
      }
    }
    if (payload.episode) {
      const keys=Object.keys(payload.episode).filter(k=>!['id','created_at','updated_at'].includes(k));
      if (keys.length) {
        await q(
          `UPDATE episodes SET ${keys.map(k => `\`${k}\`=?`).join(',')} WHERE id=?`,
          [...keys.map(k => payload.episode[k]), payload.episode.id],
        );
      }
      await q(`DELETE FROM shots WHERE episode_id=?`,[payload.episode.id]);
      for (const shot of payload.shots||[]) {
        const cols=Object.keys(shot).filter(k=>!['created_at','updated_at'].includes(k));
        const vals=cols.map(k=>shot[k]);
        await q(`INSERT INTO shots (${cols.map(k=>`\`${k}\``).join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,vals);
      }
    }
  });
  return { restored:true, snapshot_id:snapshotId };
}

async function rollbackLastRepair({ episodeId=null, storylineId=null }={}) {
  const snap=await db.queryOne(`SELECT id FROM agent_recovery_snapshots WHERE (? IS NULL OR episode_id=?) AND (? IS NULL OR storyline_id=?) ORDER BY created_at DESC LIMIT 1`,[episodeId,episodeId,storylineId,storylineId]);
  if (!snap) return { restored:false, reason:'No snapshot found' };
  return restoreStateSnapshot(snap.id);
}

async function compareBeforeAfter(snapshotId, { episodeId=null }={}) {
  const snap=await db.queryOne(`SELECT snapshot_payload FROM agent_recovery_snapshots WHERE id=?`,[snapshotId]);
  if (!snap) return { ok:false, reason:'snapshot_not_found' };
  const before=asJson(snap.snapshot_payload,{});
  const after={ episode: episodeId ? await db.queryOne(`SELECT * FROM episodes WHERE id=?`,[episodeId]) : null };
  const diffs=[];
  if (before.episode && after.episode) {
    for (const k of new Set([...Object.keys(before.episode),...Object.keys(after.episode)])) {
      const a=JSON.stringify(before.episode[k] ?? null), b=JSON.stringify(after.episode[k] ?? null);
      if (a!==b) diffs.push({field:k,before:before.episode[k],after:after.episode[k]});
    }
  }
  return { ok:true, snapshot_id:snapshotId, diffs };
}

function rankRepairs({ diagnostics, currentState }) {
  const candidates=[];
  const inv=Array.isArray(diagnostics?.invariants) ? diagnostics.invariants : (diagnostics?.invariants?.violations || diagnostics?.violations || []);
  const errorCat=diagnostics?.classified?.category;
  const shotIssues=inv.filter(v=>String(v.kind||'').includes('shot'));
  const mediaIssues=inv.filter(v=>/media|clip|audio|duration/i.test(String(v.kind||'')));
  const pipelineLayer = String(diagnostics?.pipeline_layer || '').toLowerCase();
  const pipelineCode = String(diagnostics?.pipeline_code || '');
  if (pipelineLayer === 'scene_simulation' || pipelineCode.startsWith('SCENE_SIMULATION_')) {
    candidates.push({type:'repair_scene_simulation',target:'failed_scene',risk:'LOW',score:96,reason:'Scene-simulation contract failure belongs to exactly one persisted scene; repair only that owning scene'});
  }
  if (errorCat==='database') candidates.push({type:'schema_repair',target:'database',risk:'LOW',score:95,reason:'Confirmed database/schema fault'});
  if (mediaIssues.length || errorCat==='media' || errorCat==='cloudinary') candidates.push({type:'repair_media',target:'smallest_invalid_media_unit',risk:'LOW',score:90,reason:'Media is the owning failure domain'});
  if (shotIssues.length) candidates.push({type:'regenerate_shot',target:'failed_or_invalid_shot',risk:'LOW',score:88,reason:'Shot contract/invariant failure can be repaired without rewriting higher layers'});
  if (String(currentState||'').toUpperCase()==='COMPOSITION') candidates.push({type:'recompile_scene_or_episode',target:'stale_composition',risk:'LOW',score:80,reason:'Upstream media appears valid; composition can be rebuilt'});
  candidates.push({type:'resume_pipeline',target:'next_valid_checkpoint',risk:'LOW',score:70,reason:'Durable state may already be sufficient'});
  candidates.push({type:'regenerate_episode',target:'episode',risk:'MEDIUM',score:30,reason:'Fallback only if narrower repair cannot restore integrity'});
  return candidates.sort((a,b)=>b.score-a.score);
}

function buildRecoveryPlan(diagnostics, context={}) {
  const ranked=rankRepairs({diagnostics,currentState:context.currentState});
  const primary=ranked[0];
  return {
    plan_id:uuidv4(),
    problem:diagnostics,
    chosen_repair:primary,
    alternatives:ranked.slice(1,4),
    risk:primary?.risk||'HIGH',
    preconditions:[
      'Create a durable state snapshot before mutation',
      'Validate the repair against current schema and pipeline invariants',
      'Verify after mutation; rollback automatically on failed verification',
    ],
  };
}

async function waitForShotCompletion(episodeId, sceneNumber, shotIndex, timeoutMs = 15 * 60 * 1000) {
  if (!episodeId) return { ok:false, reason:'missing_episode_id' };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await db.queryOne(
      `SELECT status,clip_url,last_error,failure_reason,updated_at FROM shots
        WHERE episode_id=? AND scene_number=? AND shot_index=?`,
      [episodeId, sceneNumber, shotIndex],
    );
    if (!row) return { ok:false, reason:'shot_row_missing' };
    if (row.status === 'done' && row.clip_url) return { ok:true, status:'done', clip_url:row.clip_url };
    if (row.status === 'failed') return { ok:false, status:'failed', error:row.last_error, failure_reason:row.failure_reason };
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  return { ok:false, reason:'timeout_waiting_for_shot_completion' };
}

async function executeRecoveryPlan(plan, context={}) {
  if (!plan?.chosen_repair) throw new Error('Recovery plan has no chosen repair');
  const storylineId=context.storylineId || null;
  const episodeId=context.episodeId || null;
  const snapshot=await createStateSnapshot({storylineId,episodeId,reason:`recovery:${plan.plan_id}`});
  let applied=null;
  try {
    const repair=plan.chosen_repair;

    if (repair.type==='schema_repair') {
      await db.initSchema();
      applied={type:repair.type,ok:true};

    } else if (repair.type==='repair_scene_simulation') {
      const scene=Number(context.sceneNumber ?? repair.scene_number);
      if (!Number.isFinite(scene)) throw new Error('Scene-simulation repair requires scene_number');
      const pipeline=require('./pipeline');
      applied=await pipeline.repairSceneSimulationForRecovery(episodeId, scene, context.errorMessage || 'Scene simulation contract failure');

    } else if (repair.type==='repair_media' || repair.type==='regenerate_shot') {
      const scene=Number(context.sceneNumber ?? repair.scene_number);
      const shot=Number(context.shotIndex ?? repair.shot_index);
      if (!Number.isFinite(scene) || !Number.isFinite(shot)) throw new Error('Shot repair requires scene and shot');

      const pipeline=require('./pipeline');
      const queued=await pipeline.regenerateShot(scene,shot,{episodeId,autonomousRecovery:true});
      const completion=await waitForShotCompletion(episodeId,scene,shot);
      applied={type:repair.type,queued,completion};

    } else if (repair.type==='recompile_scene_or_episode') {
      const pipeline=require('./pipeline');
      const scene=Number(context.sceneNumber);
      applied=Number.isFinite(scene)
        ? await pipeline.recompileScene(scene)
        : await pipeline.recompileEpisode(episodeId);

    } else if (repair.type==='regenerate_episode') {
      const pipeline=require('./pipeline');
      applied=await pipeline.regenerateEpisodeVideos(episodeId);

    } else if (repair.type==='resume_pipeline') {
      applied={type:'resume_pipeline',ok:true};

    } else {
      throw new Error(`Unsupported recovery action: ${repair.type}`);
    }

    const verification=episodeId
      ? await diagnoseEpisodeIntegrity(episodeId)
      : await diagnoseDatabaseIntegrity();
    const verified=verification.ok===true;

    await db.execute(
      `INSERT INTO agent_recovery_repairs
        (id,plan_id,snapshot_id,storyline_id,episode_id,action,risk,status,before_payload,after_payload)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        uuidv4(),plan.plan_id,snapshot.snapshot_id,storylineId,episodeId,
        repair.type,repair.risk,verified?'verified':'failed',
        JSON.stringify(plan),JSON.stringify({applied,verification}),
      ],
    );

    if (!verified) {
      await restoreStateSnapshot(snapshot.snapshot_id);
      return {ok:false,rolled_back:true,snapshot_id:snapshot.snapshot_id,applied,verification};
    }

    return {ok:true,committed:true,snapshot_id:snapshot.snapshot_id,applied,verification};

  } catch (err) {
    await restoreStateSnapshot(snapshot.snapshot_id).catch(()=>{});
    await db.execute(
      `INSERT INTO agent_recovery_repairs
        (id,plan_id,snapshot_id,storyline_id,episode_id,action,risk,status,before_payload,after_payload)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        uuidv4(),plan.plan_id,snapshot.snapshot_id,storylineId,episodeId,
        plan.chosen_repair.type,plan.chosen_repair.risk,'rolled_back',
        JSON.stringify(plan),JSON.stringify({error:err.message}),
      ],
    ).catch(()=>{});
    throw err;
  }
}

function queryAuthoritativeDbJsSchema() {
  return db.getAuthoritativeDbJsSchema();
}

function validateDatabaseReference(table, column = null) {
  const cleanTable = String(table || '').trim();
  const cleanColumn = column == null ? null : String(column).trim();
  const authority = db.assertDbJsSchemaObject(cleanTable, cleanColumn);
  return { ok: true, authority: 'src/db.js', ...authority };
}

async function learnRecoveryOutcome({ pattern, repair, success, storylineId=null, episodeId=null }) {
  const key=String(pattern||'unknown').slice(0,180);
  await db.execute(
    `INSERT INTO agent_failure_patterns (pattern_key,successful_repair,confidence,success_count,failure_count,last_outcome,storyline_id,episode_id)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       confidence = LEAST(0.999, GREATEST(0.001, ((confidence * (success_count + failure_count)) + ?) / (success_count + failure_count + 1))),
       success_count = success_count + ?,
       failure_count = failure_count + ?,
       last_outcome = VALUES(last_outcome),
       storyline_id = VALUES(storyline_id),
       episode_id = VALUES(episode_id),
       updated_at = NOW()`,
    [key, repair||null, success?0.5:0.5, success?1:0, success?0:1, success?'success':'failure', storylineId, episodeId, success?1:0, success?1:0, success?0:1]
  );
}

module.exports = {
  PIPELINE_STATES, STATE_GRAPH, STATE_ORDER, CONTRACTS,
  asJson, validateStateTransition, validateCurrentState,
  classifyError, correlateRelatedErrors, findFirstFailure, findCascadeFailures, findRepeatedFailure,
  detectRetryLoop, detectTimeoutLoop, detectRateLimitLoop, detectProviderDegradation,
  queryFullDatabaseSchema, queryTableState, compareExpectedVsActualSchema, traceForeignKeys,
  inspectConstraints, inspectIndexes, inspectTriggers, inspectViews, inspectMigrations,
  detectSchemaDrift, generateSchemaMigrationPlan, verifyMigration, rollbackMigration,
  validateAllInvariants, diagnosePipelineFailure, diagnoseEpisodeIntegrity,
  diagnoseSceneIntegrity, diagnoseShotIntegrity, diagnoseCheckpointIntegrity, diagnoseDatabaseIntegrity,
  queryAuthoritativeDbJsSchema, validateDatabaseReference,
  queryPipelineState, queryActiveJobs, queryRecentErrors, queryRecentLlmCalls, queryProviderHealth,
  queryMediaAssets, queryCloudinaryAsset, inspectVideo, inspectDuration, inspectResolution, inspectFps,
  detectCorruption, detectMissingAudio, detectBlackFrames, detectFrozenFrames, compareExpectedVsActualDuration,
  verifyCloudinaryAsset,
  createStateSnapshot, restoreStateSnapshot, rollbackLastRepair, compareBeforeAfter,
  rankRepairs, buildRecoveryPlan, executeRecoveryPlan, learnRecoveryOutcome,
};
