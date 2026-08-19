'use strict';

const axios = require('axios');

const config = require('./config');
const db = require('./db');
const memory = require('./agentMemory');
const recovery = require('./autonomousRecovery');

const MODEL = process.env.MISTRAL_AGENT_MODEL || 'mistral-large-latest';
const MAX_TOOL_STEPS = Math.max(4, Number(process.env.MISTRAL_AGENT_MAX_TOOL_STEPS || 12));
const MAX_RECOVERY_ROUNDS = Math.max(1, Math.min(5, Number(process.env.AGENT_MAX_RECOVERY_ROUNDS || 3)));

function tool(name, description, parameters, handler) {
  return {
    schema: {
      type: 'function',
      function: { name, description, parameters: parameters || { type: 'object', properties: {}, additionalProperties: false } },
    },
    handler,
  };
}

function jsonParse(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

async function _safeMemoryCall(label, fn) {
  try { return await fn(); } catch (err) {
    console.warn(`[Agent] Memory ${label} unavailable: ${err.message}`);
    return null;
  }
}

async function _recordLlmCall({ runId, startedAt, status = 'success', error = null }) {
  try {
    await db.execute(
      `INSERT INTO agent_llm_calls
        (run_id,model,tool_count,temperature,duration_ms,status,error_code,error_message)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        runId || null,
        MODEL,
        0,
        0.05,
        Math.max(0, Date.now() - startedAt),
        status,
        error?.code || null,
        error?.message ? String(error.message).slice(0, 1000) : null,
      ],
    );
  } catch (_) {}
}

async function _mistralTools(messages, tools, temperature = 0.05, runId = null, toolChoice = 'auto') {
  if (!Array.isArray(config.mistralKeys) || config.mistralKeys.length === 0) {
    throw new Error('No Mistral keys configured for autonomous agent');
  }

  let lastError = null;
  for (let keyAttempt = 0; keyAttempt < config.mistralKeys.length; keyAttempt++) {
    const key = config.getNextMistralKey();
    if (!key) continue;
    const startedAt = Date.now();
    try {
      const response = await axios.post(
        'https://api.mistral.ai/v1/chat/completions',
        {
          model: MODEL,
          messages,
          tools: tools.map(t => t.schema),
          tool_choice: toolChoice,
          parallel_tool_calls: false,
          temperature,
        },
        {
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          timeout: 600000,
        },
      );
      config.markKeyStatus('mistral', key, 'active');
      await _recordLlmCall({ runId, startedAt });
      return response.data;
    } catch (err) {
      lastError = err;
      const status = err?.response?.status;
      if ([401, 402, 403, 429].includes(status)) {
        config.markKeyStatus('mistral', key, status === 429 ? 'rate-limited' : 'exhausted');
      }
      await _recordLlmCall({ runId, startedAt, status: 'failed', error: err });
      console.warn(`[Agent] Mistral call failed ${keyAttempt + 1}/${config.mistralKeys.length}: ${status || err.message}`);
    }
  }
  throw lastError || new Error('All Mistral agent keys failed');
}

async function _mistralFinal(messages, runId = null) {
  let lastError = null;
  for (let keyAttempt = 0; keyAttempt < config.mistralKeys.length; keyAttempt++) {
    const key = config.getNextMistralKey();
    if (!key) continue;
    const startedAt = Date.now();
    try {
      const response = await axios.post(
        'https://api.mistral.ai/v1/chat/completions',
        {
          model: MODEL,
          messages: [
            ...messages,
            {
              role: 'system',
              content: 'Return ONLY the recovery decision JSON object required by the supervisor contract. No markdown, no commentary.',
            },
          ],
          temperature: 0.0,
          response_format: { type: 'json_object' },
        },
        {
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          timeout: 300000,
        },
      );
      config.markKeyStatus('mistral', key, 'active');
      await _recordLlmCall({ runId, startedAt });
      return response.data;
    } catch (err) {
      lastError = err;
      const status = err?.response?.status;
      if ([401, 402, 403, 429].includes(status)) {
        config.markKeyStatus('mistral', key, status === 429 ? 'rate-limited' : 'exhausted');
      }
      await _recordLlmCall({ runId, startedAt, status: 'failed', error: err });
    }
  }
  throw lastError || new Error('All Mistral final-decision calls failed');
}

function _episodeIdFor(args, fallback) {
  return args?.episode_id || args?.episodeId || fallback || null;
}

function _storylineIdFor(args, fallback) {
  return args?.storyline_id || args?.storylineId || fallback || null;
}

async function _getEpisode({ episodeId, storylineId, season, episode }) {
  if (episodeId) return db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episodeId]);
  if (!storylineId || season == null || episode == null) return null;
  return db.queryOne(
    `SELECT * FROM episodes WHERE storyline_id=? AND season_number=? AND episode_number=? ORDER BY created_at DESC LIMIT 1`,
    [storylineId, Number(season), Number(episode)],
  );
}

function _shotIdArgs(args, defaults = {}) {
  const episodeId = _episodeIdFor(args, defaults.episodeId);
  const scene = Number(args?.scene_number ?? args?.scene ?? defaults.sceneNumber);
  const shot = Number(args?.shot_index ?? args?.shot ?? defaults.shotIndex);
  return { episodeId, sceneNumber: scene, shotIndex: shot };
}

function buildTools({ storylineId, episodeId, runId }) {
  const productionTools = require('./agentProductionTools');
  const tools = [
    tool('db_select_rows', 'Read rows from any table declared by src/db.js using validated table/column names and parameterized equality filters. This is the agent\'s general-purpose read DB tool.', {
      type:'object', properties:{
        table:{type:'string'}, where:{type:'object'}, columns:{type:'array',items:{type:'string'}}, limit:{type:'integer'}, order_by:{type:'string'}, order_direction:{type:'string'}
      }, required:['table'], additionalProperties:false,
    }, async ({table,where={},columns=[],limit=50,order_by=null,order_direction='DESC'}) => {
      const manifest = db.getAuthoritativeDbJsSchema();
      db.assertDbJsSchemaObject(table);
      const declared = new Set(manifest.tables.find(t=>t.table===table).columns ? Object.keys(manifest.tables.find(t=>t.table===table).columns) : []);
      const cols = Array.isArray(columns) && columns.length ? columns : ['*'];
      for (const c of cols) if (c !== '*' && !declared.has(c)) throw new Error(`DB schema authority violation: column '${table}.${c}' is not declared by src/db.js`);
      const pairs = Object.entries(where || {}).slice(0, 10);
      for (const [c] of pairs) if (!declared.has(c)) throw new Error(`DB schema authority violation: column '${table}.${c}' is not declared by src/db.js`);
      const safeLimit = Math.max(1, Math.min(200, Number(limit)||50));
      const safeOrder = order_by ? (declared.has(order_by) ? order_by : null) : null;
      const direction = String(order_direction).toUpperCase()==='ASC' ? 'ASC' : 'DESC';
      const sql = `SELECT ${cols.join(',')} FROM ${table}` +
        (pairs.length ? ` WHERE ${pairs.map(([c])=>`${c}=?`).join(' AND ')}` : '') +
        (safeOrder ? ` ORDER BY ${safeOrder} ${direction}` : '') + ` LIMIT ${safeLimit}`;
      return db.query(sql, pairs.map(([,v])=>v));
    }),

    tool('db_update_fields', 'Update validated columns on a declared DB table using parameterized values. Requires at least one where field and one update field.', {
      type:'object', properties:{table:{type:'string'},where:{type:'object'},updates:{type:'object'}}, required:['table','where','updates'], additionalProperties:false,
    }, async ({table,where,updates}) => {
      const manifest = db.getAuthoritativeDbJsSchema();
      const t = manifest.tables.find(x=>x.table===table);
      if (!t) throw new Error(`DB schema authority violation: table '${table}' is not declared by src/db.js`);
      for (const c of [...Object.keys(where||{}),...Object.keys(updates||{})]) if (!Object.prototype.hasOwnProperty.call(t.columns,c)) throw new Error(`DB schema authority violation: column '${table}.${c}' is not declared by src/db.js`);
      const w = Object.entries(where||{});
      const u = Object.entries(updates||{});
      if (!w.length || !u.length) throw new Error('db_update_fields requires non-empty where and updates');
      const sql = `UPDATE ${table} SET ${u.map(([c])=>`${c}=?`).join(', ')} WHERE ${w.map(([c])=>`${c}=?`).join(' AND ')}`;
      const result = await db.execute(sql,[...u.map(([,v])=>v),...w.map(([,v])=>v)]);
      return {ok:true,affectedRows:result.affectedRows || 0};
    }),

    tool('db_insert_row', 'Insert one row into any table declared by src/db.js. Every supplied column is schema-validated and values are parameterized.', {
      type:'object', properties:{table:{type:'string'},row:{type:'object'}}, required:['table','row'], additionalProperties:false,
    }, async ({table,row}) => {
      const manifest = db.getAuthoritativeDbJsSchema();
      const t = manifest.tables.find(x=>x.table===table);
      if (!t) throw new Error(`DB schema authority violation: table '${table}' is not declared by src/db.js`);
      const entries = Object.entries(row||{});
      if (!entries.length) throw new Error('db_insert_row requires a non-empty row');
      for (const [c] of entries) if (!Object.prototype.hasOwnProperty.call(t.columns,c)) throw new Error(`DB schema authority violation: column '${table}.${c}' is not declared by src/db.js`);
      const sql = `INSERT INTO ${table} (${entries.map(([c])=>c).join(',')}) VALUES (${entries.map(()=>'?').join(',')})`;
      const result = await db.execute(sql,entries.map(([,v])=>v));
      return {ok:true,insertId:result.insertId || null,affectedRows:result.affectedRows || 0};
    }),

    tool('production_state', 'Read the complete durable production state. Use this before deciding what the pipeline should do next.', {
      type:'object', properties:{storyline_id:{type:'string'},episode_id:{type:'string'}}, additionalProperties:false,
    }, async (args) => productionTools.inspectProductionState({
      storyline_id: _storylineIdFor(args,storylineId), episode_id: _episodeIdFor(args,episodeId),
    })),

    tool('initialize_series', 'Create the next series and lock its master story simulation and cast when no active series/draft exists.', {
      type:'object', properties:{genre:{type:'string'}}, additionalProperties:false,
    }, async ({genre}) => productionTools.initializeSeries({genre:genre || null})),

    tool('simulate_season', 'Create or resume the authoritative season trajectory. Never regenerate a complete locked season.', {
      type:'object', properties:{storyline_id:{type:'string'},season_number:{type:'integer'}}, additionalProperties:false,
    }, async (args) => productionTools.simulateSeason({
      storyline_id:_storylineIdFor(args,storylineId), season_number:args.season_number,
    })),

    tool('ensure_episode_draft', 'Create or reuse the durable episode draft for the selected season/episode.', {
      type:'object', properties:{storyline_id:{type:'string'},season_number:{type:'integer'},episode_number:{type:'integer'}}, required:['storyline_id','season_number','episode_number'], additionalProperties:false,
    }, async (args) => productionTools.ensureDraft(args)),

    tool('simulate_episode_scenes', 'Simulate the episode scene chain from the locked episode trajectory and persist scene checkpoints in the DB.', {
      type:'object', properties:{episode_id:{type:'string'}}, required:['episode_id'], additionalProperties:false,
    }, async ({episode_id}) => productionTools.simulateEpisodeScenes({episode_id})),

    tool('write_episode_script', 'Write the episode blueprint and sequential shot simulation from the already locked scene simulation. This tool owns the creative generation for the script/shot layer.', {
      type:'object', properties:{episode_id:{type:'string'}}, required:['episode_id'], additionalProperties:false,
    }, async ({episode_id}) => productionTools.writeEpisodeBlueprintAndShotSimulation({episode_id})),

    tool('prepare_shot_rows', 'Materialize the authoritative shot simulation into the durable shots table. Idempotent.', {
      type:'object', properties:{episode_id:{type:'string'}}, required:['episode_id'], additionalProperties:false,
    }, async ({episode_id}) => productionTools.prepareShotRows({episode_id})),

    tool('generate_episode_media', 'Generate saved stills and video clips for pending/failed shots, optionally limited to one scene or shot. The underlying generation tools handle provider calls and DB checkpoints.', {
      type:'object', properties:{episode_id:{type:'string'},scene_number:{type:'integer'},shot_index:{type:'integer'}}, required:['episode_id'], additionalProperties:false,
    }, async (args) => productionTools.generateMedia(args)),

    tool('compile_episode', 'Compile valid scene clips and assemble the episode video from durable media.', {
      type:'object', properties:{episode_id:{type:'string'}}, required:['episode_id'], additionalProperties:false,
    }, async ({episode_id}) => productionTools.compileEpisode({episode_id})),

    tool('validate_episode', 'Run deterministic episode invariants and media checks before publication. Never bypass validation.', {
      type:'object', properties:{episode_id:{type:'string'}}, required:['episode_id'], additionalProperties:false,
    }, async ({episode_id}) => productionTools.validateEpisode({episode_id})),

    tool('publish_episode', 'Publish an episode only after validation passes. The tool blocks publication when invariants/media are invalid.', {
      type:'object', properties:{episode_id:{type:'string'}}, required:['episode_id'], additionalProperties:false,
    }, async ({episode_id}) => productionTools.publishEpisode({episode_id})),

    tool('checkpoint_production', 'Record an explicit agent checkpoint after a successful stage or deliberate pause.', {
      type:'object', properties:{episode_id:{type:'string'},state_name:{type:'string'},metadata:{type:'object'}}, required:['state_name'], additionalProperties:false,
    }, async (args) => productionTools.recordAgentCheckpoint(args)),
    tool(
      'query_full_database_schema',
      'Read-only authoritative live MySQL schema. Use this before making schema assumptions or schema repairs. Never invent tables or columns.',
      {
        type: 'object',
        properties: {
          include_create_sql: { type: 'boolean' },
          include_triggers: { type: 'boolean' },
          include_views: { type: 'boolean' },
          table_filter: { type: 'string' },
        },
        additionalProperties: false,
      },
      async (args) => recovery.queryFullDatabaseSchema({
        includeCreateSql: args.include_create_sql !== false,
        includeTriggers: args.include_triggers !== false,
        includeViews: args.include_views !== false,
        tableFilter: args.table_filter || null,
      }),
    ),

    tool('query_table_state', 'Inspect one live table: existence, columns, indexes, foreign keys. Read-only.', {
      type:'object', properties:{ table:{type:'string'} }, required:['table'], additionalProperties:false,
    }, async ({ table }) => recovery.queryTableState(table)),

    tool('query_episode_state', 'Inspect the authoritative episode state by ID or by storyline + season + episode.', {
      type:'object', properties:{ episode_id:{type:'string'}, storyline_id:{type:'string'}, season:{type:'integer'}, episode:{type:'integer'} }, additionalProperties:false,
    }, async (args) => {
      const ep = await _getEpisode({ episodeId:_episodeIdFor(args,episodeId), storylineId:_storylineIdFor(args,storylineId), season:args.season, episode:args.episode });
      if (!ep) return { missing:true };
      return {
        id:ep.id, storyline_id:ep.storyline_id, season_number:ep.season_number, episode_number:ep.episode_number,
        status:ep.status, scene_count:ep.scene_count, shot_count:ep.shot_count,
        scene_state:recovery.asJson(ep.scene_state,{}), shot_state:recovery.asJson(ep.shot_state,{}),
        global_continuity_state:recovery.asJson(ep.global_continuity_state,{}),
        paused_reason:ep.paused_reason, ready_at:ep.ready_at, posted_at:ep.posted_at,
        script:recovery.asJson(ep.script,{}),
      };
    }),

    tool('query_scene_state', 'Inspect authoritative scene simulation, blueprint, shot simulation, persisted shots and checkpoint state.', {
      type:'object', properties:{ episode_id:{type:'string'}, scene_number:{type:'integer'} }, required:['scene_number'], additionalProperties:false,
    }, async ({ episode_id, scene_number }) => recovery.diagnoseSceneIntegrity(_episodeIdFor({episode_id},episodeId), scene_number)),

    tool('query_shot_state', 'Inspect one persisted shot, its simulation contract, media URLs, validation state and failure metadata.', {
      type:'object', properties:{ episode_id:{type:'string'}, scene_number:{type:'integer'}, shot_index:{type:'integer'} }, required:['scene_number','shot_index'], additionalProperties:false,
    }, async (args) => recovery.diagnoseShotIntegrity(_episodeIdFor(args,episodeId), args.scene_number, args.shot_index)),

    tool('query_pipeline_state', 'Inspect durable pipeline checkpoint and infer current state without trusting in-memory process state.', {
      type:'object', properties:{ storyline_id:{type:'string'}, episode_id:{type:'string'} }, additionalProperties:false,
    }, async (args) => recovery.queryPipelineState(_storylineIdFor(args,storylineId), _episodeIdFor(args,episodeId))),

    tool('query_active_jobs', 'Find active/pending persisted media jobs so stuck work can be distinguished from valid completed work.', {
      type:'object', properties:{ episode_id:{type:'string'} }, additionalProperties:false,
    }, async ({ episode_id }) => recovery.queryActiveJobs(_episodeIdFor({episode_id},episodeId))),

    tool('query_recent_errors', 'Return a deterministic error feed assembled from durable shot failures and agent events.', {
      type:'object', properties:{ storyline_id:{type:'string'}, episode_id:{type:'string'}, limit:{type:'integer'} }, additionalProperties:false,
    }, async (args) => recovery.queryRecentErrors({
      storylineId:_storylineIdFor(args,storylineId), episodeId:_episodeIdFor(args,episodeId), limit:args.limit || 50,
    })),

    tool('query_recent_llm_calls', 'Inspect durable Mistral agent-call telemetry.', {
      type:'object', properties:{ run_id:{type:'string'}, limit:{type:'integer'} }, additionalProperties:false,
    }, async ({ run_id, limit }) => recovery.queryRecentLlmCalls({ runId:run_id || runId, limit:limit || 50 })),

    tool('query_provider_health', 'Inspect current provider/key-pool health and perform a bounded Mistral API reachability check.', {
      type:'object', properties:{}, additionalProperties:false,
    }, async () => recovery.queryProviderHealth()),

    tool('query_media_assets', 'List all durable image/clip assets for the selected episode.', {
      type:'object', properties:{ episode_id:{type:'string'} }, additionalProperties:false,
    }, async ({ episode_id }) => recovery.queryMediaAssets(_episodeIdFor({episode_id},episodeId))),

    tool('query_cloudinary_asset', 'Verify whether a media URL is reachable and inspect content headers.', {
      type:'object', properties:{ url:{type:'string'} }, required:['url'], additionalProperties:false,
    }, async ({ url }) => recovery.queryCloudinaryAsset(url)),

    tool('query_ffmpeg_job', 'Inspect a persisted media job. This uses the shots job record where possible and optionally probes the output URL.',
      { type:'object', properties:{ episode_id:{type:'string'}, scene_number:{type:'integer'}, shot_index:{type:'integer'}, url:{type:'string'} }, additionalProperties:false },
      async (args) => {
        if (args.url) return recovery.inspectVideo(args.url);
        const shot = await recovery.diagnoseShotIntegrity(_episodeIdFor(args,episodeId), args.scene_number, args.shot_index);
        return { persisted_job:shot.persisted ? { mh_job_id:shot.persisted.mh_job_id, status:shot.persisted.status, ltx_status:shot.persisted.ltx_status } : null };
      }),

    tool('query_checkpoint_history', 'Inspect recovery and agent ledger history for this episode.', {
      type:'object', properties:{ episode_id:{type:'string'}, limit:{type:'integer'} }, additionalProperties:false,
    }, async ({ episode_id, limit=30 }) => {
      const id=_episodeIdFor({episode_id},episodeId);
      return db.query(`SELECT id,plan_id,snapshot_id,action,risk,status,created_at FROM agent_recovery_repairs WHERE episode_id=? ORDER BY created_at DESC LIMIT ${Math.max(1,Math.min(100,Number(limit)||30))}`,[id]);
    }),

    tool('query_event_history', 'Inspect recent pipeline/agent events for causal reconstruction.', {
      type:'object', properties:{ storyline_id:{type:'string'}, episode_id:{type:'string'}, limit:{type:'integer'} }, additionalProperties:false,
    }, async ({ storyline_id, episode_id, limit=50 }) => {
      const sl=_storylineIdFor({storyline_id},storylineId), ep=_episodeIdFor({episode_id},episodeId);
      return db.query(
        `SELECT * FROM pipeline_events
           WHERE (? IS NULL OR storyline_id=?)
             AND (? IS NULL OR episode_id=?)
          ORDER BY created_at DESC LIMIT ${Math.max(1,Math.min(200,Number(limit)||50))}`,
        [sl,sl,ep,ep],
      );
    }),

    tool('diagnose_pipeline_failure', 'Deterministically classify a failure, find first failure, cascades, repeated failures, retry/timeout/rate-limit loops and provider degradation. Do this before LLM speculation.', {
      type:'object', properties:{ message:{type:'string'}, code:{type:'string'}, episode_id:{type:'string'} }, required:['message'], additionalProperties:false,
    }, async ({ message, code, episode_id }) => recovery.diagnosePipelineFailure({ error:message, code, episodeId:_episodeIdFor({episode_id},episodeId), storylineId })),

    tool('diagnose_episode_integrity', 'Run the full machine-readable episode contract/invariant engine.', {
      type:'object', properties:{ episode_id:{type:'string'} }, additionalProperties:false,
    }, async ({ episode_id }) => recovery.diagnoseEpisodeIntegrity(_episodeIdFor({episode_id},episodeId))),

    tool('diagnose_scene_integrity', 'Run deterministic scene-level integrity checks.', {
      type:'object', properties:{ episode_id:{type:'string'}, scene_number:{type:'integer'} }, required:['scene_number'], additionalProperties:false,
    }, async ({ episode_id, scene_number }) => recovery.diagnoseSceneIntegrity(_episodeIdFor({episode_id},episodeId),scene_number)),

    tool('diagnose_shot_integrity', 'Run deterministic shot-level contract checks.', {
      type:'object', properties:{ episode_id:{type:'string'}, scene_number:{type:'integer'}, shot_index:{type:'integer'} }, required:['scene_number','shot_index'], additionalProperties:false,
    }, async (args) => recovery.diagnoseShotIntegrity(_episodeIdFor(args,episodeId),args.scene_number,args.shot_index)),

    tool('diagnose_checkpoint_integrity', 'Verify checkpoint stage consistency and authoritative durable checkpoint contents.', {
      type:'object', properties:{ episode_id:{type:'string'} }, additionalProperties:false,
    }, async ({ episode_id }) => recovery.diagnoseCheckpointIntegrity(_episodeIdFor({episode_id},episodeId))),

    tool('diagnose_database_integrity', 'Check live schema drift, constraints and foreign keys.', {
      type:'object', properties:{}, additionalProperties:false,
    }, async () => recovery.diagnoseDatabaseIntegrity()),

    tool('diagnose_media_integrity', 'Inspect all media contracts for one episode and flag missing/unreachable/corrupt media.', {
      type:'object', properties:{ episode_id:{type:'string'} }, additionalProperties:false,
    }, async ({ episode_id }) => {
      const id=_episodeIdFor({episode_id},episodeId);
      const rows=await recovery.queryMediaAssets(id);
      const checks=[];
      for (const row of rows) {
        if (!row.clip_url) { checks.push({scene_number:row.scene_number,shot_index:row.shot_index,ok:false,reason:'missing_clip'}); continue; }
        const cloud=await recovery.verifyCloudinaryAsset(row.clip_url);
        if (!cloud.ok) { checks.push({scene_number:row.scene_number,shot_index:row.shot_index,ok:false,reason:'unreachable',cloud}); continue; }
        const video=await recovery.inspectVideo(row.clip_url);
        checks.push({scene_number:row.scene_number,shot_index:row.shot_index,ok:video.ok && video.duration>=6 && video.duration<=10,video});
      }
      return { ok:checks.every(x=>x.ok), checks };
    }),

    tool('query_authoritative_dbjs_schema', 'Return the complete database schema contract derived directly from src/db.js. This is the sole authority for what tables and columns the agent may claim are part of the application schema. Never invent objects outside this result.', {
      type:'object', properties:{}, additionalProperties:false,
    }, async () => recovery.queryAuthoritativeDbJsSchema()),

    tool('validate_database_reference', 'Prove that a table or column is declared by src/db.js before it is mentioned in a database repair plan.', {
      type:'object', properties:{table:{type:'string'},column:{type:'string'}}, required:['table'], additionalProperties:false,
    }, async ({table,column}) => recovery.validateDatabaseReference(table,column || null)),

    tool('compare_expected_vs_actual_schema', 'Compare the canonical application schema contract against live information_schema.', {
      type:'object', properties:{}, additionalProperties:false,
    }, async () => recovery.compareExpectedVsActualSchema()),

    tool('trace_foreign_keys', 'Trace live foreign-key relationships.', {
      type:'object', properties:{ table:{type:'string'} }, additionalProperties:false,
    }, async ({ table }) => recovery.traceForeignKeys(table || null)),

    tool('inspect_constraints', 'Inspect live constraints.', {
      type:'object', properties:{ table:{type:'string'} }, additionalProperties:false,
    }, async ({ table }) => recovery.inspectConstraints(table || null)),

    tool('inspect_indexes', 'Inspect live indexes and coverage.', {
      type:'object', properties:{ table:{type:'string'} }, additionalProperties:false,
    }, async ({ table }) => recovery.inspectIndexes(table || null)),

    tool('inspect_triggers', 'Inspect live triggers.', {
      type:'object', properties:{ table:{type:'string'} }, additionalProperties:false,
    }, async ({ table }) => recovery.inspectTriggers(table || null)),

    tool('inspect_views', 'Inspect live views.', {
      type:'object', properties:{}, additionalProperties:false,
    }, async () => recovery.inspectViews()),

    tool('inspect_migrations', 'Inspect migration/version-like tables that actually exist at runtime.', {
      type:'object', properties:{}, additionalProperties:false,
    }, async () => recovery.inspectMigrations()),

    tool('detect_schema_drift', 'Detect schema drift without mutating anything.', {
      type:'object', properties:{}, additionalProperties:false,
    }, async () => recovery.detectSchemaDrift()),

    tool('generate_schema_migration_plan', 'Generate a bounded migration plan. Arbitrary SQL is never returned as an execution authority.', {
      type:'object', properties:{}, additionalProperties:false,
    }, async () => recovery.generateSchemaMigrationPlan()),

    tool('verify_migration', 'Verify the live schema after an application migration.', {
      type:'object', properties:{}, additionalProperties:false,
    }, async () => recovery.verifyMigration()),

    tool('rollback_migration', 'Describe guarded rollback options. Never execute arbitrary destructive SQL.', {
      type:'object', properties:{}, additionalProperties:false,
    }, async () => recovery.rollbackMigration()),

    tool('diagnose_provider_failure', 'Dedicated provider diagnosis. Distinguish auth, rate limits, quota, timeout, network and model failures.', {
      type:'object', properties:{ message:{type:'string'}, code:{type:'string'} }, required:['message'], additionalProperties:false,
    }, async ({message,code}) => {
      const classified=recovery.classifyError({message,code});
      const health=await recovery.queryProviderHealth();
      return {classified,health};
    }),

    tool('validate_state_transition', 'Validate a proposed transition against the authoritative pipeline state graph.', {
      type:'object', properties:{ from:{type:'string'}, to:{type:'string'} }, required:['from','to'], additionalProperties:false,
    }, async ({from,to}) => recovery.validateStateTransition(from,to)),

    tool('validate_current_state', 'Validate a current state against predecessor completion.', {
      type:'object', properties:{ state:{type:'string'}, completed_states:{type:'array',items:{type:'string'}} }, required:['state'], additionalProperties:false,
    }, async ({state,completed_states}) => recovery.validateCurrentState({state,completed_states})),

    tool('find_invalid_transitions', 'Find invalid transitions in an event history.', {
      type:'object', properties:{ episode_id:{type:'string'} }, additionalProperties:false,
    }, async ({episode_id}) => {
      const ep=_episodeIdFor({episode_id},episodeId);
      const events=await db.query(`SELECT pipeline_state,event_type,created_at,payload FROM pipeline_events WHERE episode_id=? ORDER BY created_at ASC`,[ep]);
      const states=events.map(e=>recovery.asJson(e.payload,{}).to_state || e.pipeline_state).filter(Boolean);
      const invalid=[];
      for(let i=1;i<states.length;i++){ const r=recovery.validateStateTransition(states[i-1],states[i]); if(!r.valid) invalid.push({...r,index:i}); }
      return {ok:invalid.length===0,invalid};
    }),

    tool('find_orphaned_work', 'Find durable work that has no valid owning predecessor or is stranded outside the checkpoint chain.', {
      type:'object', properties:{ episode_id:{type:'string'} }, additionalProperties:false,
    }, async ({episode_id}) => {
      const ep=await recovery.diagnoseEpisodeIntegrity(_episodeIdFor({episode_id},episodeId));
      return { orphaned:ep.invariants?.violations?.filter(v=>/missing|orphan|done_shot_without/i.test(String(v.kind))) || [] };
    }),

    tool('find_stuck_work', 'Find jobs submitted/pending beyond the configured stale-work window.', {
      type:'object', properties:{ episode_id:{type:'string'}, age_minutes:{type:'number'} }, additionalProperties:false,
    }, async ({episode_id,age_minutes=30}) => {
      const id=_episodeIdFor({episode_id},episodeId);
      const jobs=await recovery.queryActiveJobs(id);
      const cutoff=Date.now()-Math.max(1,Number(age_minutes)||30)*60*1000;
      return jobs.filter(j=>new Date(j.updated_at).getTime()<cutoff);
    }),

    tool('find_duplicate_work', 'Find duplicate persistent shot records violating the logical unique key.', {
      type:'object', properties:{ episode_id:{type:'string'} }, additionalProperties:false,
    }, async ({episode_id}) => {
      const id=_episodeIdFor({episode_id},episodeId);
      return db.query(`SELECT episode_id,scene_number,shot_index,COUNT(*) AS duplicate_count FROM shots WHERE episode_id=? GROUP BY episode_id,scene_number,shot_index HAVING COUNT(*)>1`,[id]);
    }),

    tool('find_skipped_work', 'Find simulated shots/scenes whose predecessors exist but the layer was skipped or left incomplete.', {
      type:'object', properties:{ episode_id:{type:'string'} }, additionalProperties:false,
    }, async ({episode_id}) => {
      const ep=await recovery.diagnoseEpisodeIntegrity(_episodeIdFor({episode_id},episodeId));
      return { skipped:ep.invariants?.violations?.filter(v=>/gap|missing|out_of_order/i.test(String(v.kind))) || [] };
    }),

    tool('find_out_of_order_work', 'Find scene/shot numbering and checkpoint-order violations.', {
      type:'object', properties:{ episode_id:{type:'string'} }, additionalProperties:false,
    }, async ({episode_id}) => {
      const ep=await recovery.diagnoseEpisodeIntegrity(_episodeIdFor({episode_id},episodeId));
      return { out_of_order:ep.invariants?.violations?.filter(v=>/gap|reorder|order/i.test(String(v.kind))) || [] };
    }),

    tool('classify_error', 'Classify one error deterministically.', {
      type:'object', properties:{message:{type:'string'},code:{type:'string'}}, required:['message'], additionalProperties:false,
    }, async ({message,code}) => recovery.classifyError({message,code})),

    tool('correlate_related_errors', 'Correlate a supplied error set into deterministic clusters.', {
      type:'object', properties:{errors:{type:'array'}}, required:['errors'], additionalProperties:false,
    }, async ({errors}) => recovery.correlateRelatedErrors(errors)),

    tool('find_first_failure', 'Find the chronologically earliest failure in a supplied set.', {
      type:'object', properties:{errors:{type:'array'}}, required:['errors'], additionalProperties:false,
    }, async ({errors}) => recovery.findFirstFailure(errors)),

    tool('find_cascade_failures', 'Separate likely downstream cascade failures from the first observed failure.', {
      type:'object', properties:{errors:{type:'array'}}, required:['errors'], additionalProperties:false,
    }, async ({errors}) => recovery.findCascadeFailures(errors)),

    tool('find_repeated_failure', 'Find the most repeated deterministic failure cluster.', {
      type:'object', properties:{errors:{type:'array'}}, required:['errors'], additionalProperties:false,
    }, async ({errors}) => recovery.findRepeatedFailure(errors)),

    tool('detect_retry_loop', 'Detect repeated retry behavior from a deterministic error set.', {
      type:'object', properties:{errors:{type:'array'}}, required:['errors'], additionalProperties:false,
    }, async ({errors}) => recovery.detectRetryLoop(errors)),

    tool('detect_timeout_loop', 'Detect a repeated timeout loop.', {
      type:'object', properties:{errors:{type:'array'}}, required:['errors'], additionalProperties:false,
    }, async ({errors}) => recovery.detectTimeoutLoop(errors)),

    tool('detect_rate_limit_loop', 'Detect a repeated rate-limit/quota loop.', {
      type:'object', properties:{errors:{type:'array'}}, required:['errors'], additionalProperties:false,
    }, async ({errors}) => recovery.detectRateLimitLoop(errors)),

    tool('detect_provider_degradation', 'Detect provider degradation from recent deterministic failure telemetry.', {
      type:'object', properties:{errors:{type:'array'}}, required:['errors'], additionalProperties:false,
    }, async ({errors}) => recovery.detectProviderDegradation(errors)),

    tool('trace_root_cause', 'Construct a causal chain from durable failure evidence to the narrowest root cause candidate.', {
      type:'object', properties:{message:{type:'string'},code:{type:'string'},episode_id:{type:'string'},scene_number:{type:'integer'},shot_index:{type:'integer'}}, required:['message'], additionalProperties:false,
    }, async (args) => {
      const id=_episodeIdFor(args,episodeId);
      const diagnostic=await recovery.diagnosePipelineFailure({error:args.message,code:args.code,episodeId:id,storylineId});
      const layers=[];
      if(diagnostic.first_failure) layers.push({layer:'first_observed_failure',evidence:diagnostic.first_failure});
      layers.push({layer:'classification',evidence:diagnostic.classified});
      if(diagnostic.provider_degradation?.degraded) layers.push({layer:'provider_degradation',evidence:diagnostic.provider_degradation});
      if(args.scene_number!=null && args.shot_index!=null) {
        layers.push({layer:'shot_integrity',evidence:await recovery.diagnoseShotIntegrity(id,args.scene_number,args.shot_index)});
      } else if(id) {
        layers.push({layer:'episode_integrity',evidence:await recovery.diagnoseEpisodeIntegrity(id)});
      }
      const root = diagnostic.classified.category === 'unknown'
        ? (diagnostic.first_failure?.message || args.message)
        : diagnostic.classified.category;
      return { root_cause_candidate:root, causal_chain:layers };
    }),

    tool('inspect_video', 'Inspect a video with ffprobe.', {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, async ({url})=>recovery.inspectVideo(url)),
    tool('inspect_audio', 'Inspect whether a video contains an audio stream.', {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, async ({url})=>{const i=await recovery.inspectVideo(url);return {ok:i.ok,has_audio:i.has_audio,audio_codec:i.audio_codec};}),
    tool('inspect_duration', 'Read exact media duration.', {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, async ({url})=>recovery.inspectDuration(url)),
    tool('inspect_resolution', 'Read exact media resolution.', {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, async ({url})=>recovery.inspectResolution(url)),
    tool('inspect_fps', 'Read exact video FPS.', {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, async ({url})=>recovery.inspectFps(url)),
    tool('detect_corruption', 'Run ffmpeg decode validation to detect corrupted media.', {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, async ({url})=>recovery.detectCorruption(url)),
    tool('detect_missing_audio', 'Detect missing audio stream.', {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, async ({url})=>recovery.detectMissingAudio(url)),
    tool('detect_black_frames', 'Detect sustained black frames.', {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, async ({url})=>recovery.detectBlackFrames(url)),
    tool('detect_frozen_frames', 'Detect sustained frozen frames.', {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, async ({url})=>recovery.detectFrozenFrames(url)),
    tool('compare_expected_vs_actual_duration', 'Compare media duration against the authoritative shot duration contract.', {
      type:'object',properties:{episode_id:{type:'string'},scene_number:{type:'integer'},shot_index:{type:'integer'},actual_duration:{type:'number'}},required:['actual_duration'],additionalProperties:false,
    }, async ({episode_id,scene_number,shot_index,actual_duration}) => {
      const id=_episodeIdFor({episode_id},episodeId);
      if(id && scene_number!=null && shot_index!=null){const d=await recovery.diagnoseShotIntegrity(id,scene_number,shot_index); const expected=Number(d.simulation?.duration_seconds ?? d.simulation?.duration); return recovery.compareExpectedVsActualDuration(expected,actual_duration);}
      return recovery.compareExpectedVsActualDuration(null,actual_duration);
    }),

    tool('verify_cloudinary_asset', 'Verify a Cloudinary asset URL.', {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, async ({url})=>recovery.verifyCloudinaryAsset(url)),

    tool('validate_all_invariants', 'Run the complete machine-readable contract engine.', {
      type:'object',properties:{episode_id:{type:'string'}},additionalProperties:false,
    }, async ({episode_id}) => recovery.diagnoseEpisodeIntegrity(_episodeIdFor({episode_id},episodeId))),

    tool('validate_actual_coherence', 'Run actual visual coherence QA on the saved shot image using the existing Mistral Vision validator and the authoritative shot contract.', {
      type:'object',properties:{episode_id:{type:'string'},scene_number:{type:'integer'},shot_index:{type:'integer'}},required:['scene_number','shot_index'],additionalProperties:false,
    }, async (args) => {
      const id=_episodeIdFor(args,episodeId);
      const shotDiag=await recovery.diagnoseShotIntegrity(id,args.scene_number,args.shot_index);
      const url=shotDiag.persisted?.image_url;
      if(!url) return {available:false,ok:false,reason:'missing_shot_image'};
      const axiosLocal=axios;
      const imageResp=await axiosLocal.get(url,{responseType:'arraybuffer',timeout:25000});
      const validator=require('./mistralVisionValidator');
      return validator.validateShotImage({imageBuffer:Buffer.from(imageResp.data),shot:{...(shotDiag.simulation||{}),scene_number:args.scene_number,shot_index:args.shot_index},prevShot:null});
    }),

    tool('create_state_snapshot', 'Create a durable rollback snapshot before any repair.', {
      type:'object',properties:{episode_id:{type:'string'},storyline_id:{type:'string'},reason:{type:'string'}},additionalProperties:false,
    }, async ({episode_id,storyline_id,reason}) => recovery.createStateSnapshot({episodeId:_episodeIdFor({episode_id},episodeId),storylineId:_storylineIdFor({storyline_id},storylineId),reason:reason||'agent_plan'})),

    tool('restore_state_snapshot', 'Restore a named durable state snapshot.', {
      type:'object',properties:{snapshot_id:{type:'string'}},required:['snapshot_id'],additionalProperties:false,
    }, async ({snapshot_id})=>recovery.restoreStateSnapshot(snapshot_id)),

    tool('rollback_last_repair', 'Restore the latest snapshot for the current episode/storyline.', {
      type:'object',properties:{episode_id:{type:'string'},storyline_id:{type:'string'}},additionalProperties:false,
    }, async ({episode_id,storyline_id})=>recovery.rollbackLastRepair({episodeId:_episodeIdFor({episode_id},episodeId),storylineId:_storylineIdFor({storyline_id},storylineId)})),

    tool('compare_before_after', 'Compare current durable state to a named pre-repair snapshot.', {
      type:'object',properties:{snapshot_id:{type:'string'},episode_id:{type:'string'}},required:['snapshot_id'],additionalProperties:false,
    }, async ({snapshot_id,episode_id})=>recovery.compareBeforeAfter(snapshot_id,{episodeId:_episodeIdFor({episode_id},episodeId)})),

    tool('build_recovery_plan', 'Produce ranked smallest-scope repairs with evidence, risk and alternatives. This is planning only; it does not mutate state.', {
      type:'object',properties:{diagnostics:{type:'object'},current_state:{type:'string'},scene_number:{type:'integer'},shot_index:{type:'integer'}},required:['diagnostics'],additionalProperties:false,
    }, async ({diagnostics,current_state,scene_number,shot_index}) => {
      const plan=recovery.buildRecoveryPlan(diagnostics,{currentState:current_state});
      if(plan.chosen_repair){
        plan.chosen_repair.scene_number=scene_number;
        plan.chosen_repair.shot_index=shot_index;
      }
      return plan;
    }),

    tool('estimate_recovery_risk', 'Estimate relative repair risk using durable evidence and scope.', {
      type:'object',properties:{plan:{type:'object'}},required:['plan'],additionalProperties:false,
    }, async ({plan}) => {
      const risk=String(plan?.chosen_repair?.risk || 'HIGH');
      const score={LOW:0.1,MEDIUM:0.4,HIGH:0.8}[risk] ?? 0.9;
      return {risk,probability_of_regression:score,explanation:risk==='LOW'?'Small owning-unit repair':risk==='MEDIUM'?'Broader episode regeneration':'High blast-radius repair'};
    }),

    tool('rank_repairs', 'Return deterministic repair candidates ordered by score.', {
      type:'object',properties:{diagnostics:{type:'object'},current_state:{type:'string'}},required:['diagnostics'],additionalProperties:false,
    }, async ({diagnostics,current_state}) => recovery.rankRepairs({diagnostics,currentState:current_state})),

    tool('execute_recovery_plan', 'Execute the selected typed recovery plan through the transactional snapshot/verify/rollback engine. Never executes arbitrary SQL.', {
      type:'object',properties:{plan:{type:'object'},episode_id:{type:'string'},storyline_id:{type:'string'},scene_number:{type:'integer'},shot_index:{type:'integer'}},required:['plan'],additionalProperties:false,
    }, async (args) => recovery.executeRecoveryPlan(args.plan,{
      episodeId:_episodeIdFor(args,episodeId), storylineId:_storylineIdFor(args,storylineId),
      sceneNumber:args.scene_number, shotIndex:args.shot_index,
    })),

    tool('record_recovery_outcome', 'Store the outcome of a repair so repeated failures can improve future repair ranking.', {
      type:'object',properties:{pattern:{type:'string'},repair:{type:'string'},success:{type:'boolean'}},required:['pattern','success'],additionalProperties:false,
    }, async ({pattern,repair,success}) => {
      await recovery.learnRecoveryOutcome({pattern,repair,success,storylineId,episodeId});
      await memory.remember({storylineId,episodeId,scope:'previous_recovery',key:String(pattern).slice(0,180),value:{repair,success,recorded_at:new Date().toISOString()},priority:success?90:60,source:'recovery'});
      return {ok:true};
    }),

    tool('record_agent_memory', 'Persist a structured fact, constraint, provider behavior, successful repair or known failure.', {
      type:'object',properties:{scope:{type:'string'},key:{type:'string'},value:{type:'object'},priority:{type:'integer'}},required:['scope','key','value'],additionalProperties:false,
    }, async ({scope,key,value,priority}) => {
      const isSchemaMemory = /^(schema|schema_fact|database|database_fact)$/i.test(String(scope || '')) || /schema|table|column/i.test(String(key || ''));
      if (isSchemaMemory) {
        const authority = recovery.queryAuthoritativeDbJsSchema();
        if (value?.authority !== 'src/db.js') {
          return {ok:false,reason:'Schema-related memory requires explicit src/db.js authority; historical or inferred schema claims are rejected'};
        }
        if (value?.table) recovery.validateDatabaseReference(value.table,value.column || null);
        if (Array.isArray(value?.tables)) {
          for (const table of value.tables) recovery.validateDatabaseReference(table);
          if (!value.tables.every(t=>authority.tables.some(x=>x.table===t))) return {ok:false,reason:'Schema memory contains an object not declared by src/db.js'};
        }
      }
      await memory.remember({storylineId,episodeId,scope,key,value,priority:Number(priority)||50,source:'agent'});
      return {ok:true};
    }),

    tool('record_recovery_directive', 'Persist the next smallest valid resume directive.', {
      type:'object',properties:{phase:{type:'string'},scene_number:{type:'integer'},shot_index:{type:'integer'},reason:{type:'string'},target:{type:'string'}},required:['phase','reason'],additionalProperties:false,
    }, async ({phase,scene_number,shot_index,reason,target}) => {
      const value={phase,scene_number:scene_number||null,shot_index:shot_index||null,reason,target:target||null,created_at:new Date().toISOString()};
      await memory.remember({storylineId,episodeId,scope:'recovery',key:'pending_directive',value,priority:100,source:'agent'});
      return {ok:true,directive:value};
    }),

    tool('repair_database_schema', 'Perform only the idempotent application schema migration after deterministic confirmation. The migration surface is limited to objects declared by src/db.js; arbitrary SQL and invented tables/columns are forbidden.', {
      type:'object',properties:{reason:{type:'string'}},required:['reason'],additionalProperties:false,
    }, async ({reason}) => {
      if(!db.isSchemaError({message:reason})) return {repaired:false,reason:'Schema repair requires a confirmed schema error'};
      const authority = recovery.queryAuthoritativeDbJsSchema();
      const lower = String(reason || '').toLowerCase();
      const named = lower.match(/(?:table|column)\s+[`\']?([a-z0-9_]+)/i);
      const namedObject = named?.[1] || null;
      if(namedObject && !authority.tables.some(t=>t.table.toLowerCase()===namedObject.toLowerCase())) {
        return {repaired:false,reason:`Refused schema repair: '${namedObject}' is not declared by src/db.js`,authority:authority.authority};
      }
      await db.initSchema();
      await memory.initAgentMemorySchema();
      const verification = await recovery.compareExpectedVsActualSchema();
      return {repaired:verification.ok,authority:authority.authority,verification};
    }),
  ];

  return tools;
}

function _normalizeFinalDecision(final, phase) {
  const action = ['continue','repair','pause'].includes(final?.action) ? final.action : 'continue';
  const confidence = Math.max(0, Math.min(1, Number(final?.confidence) || 0));
  return {
    action,
    phase: final?.phase || phase,
    scene_number: Number.isFinite(Number(final?.scene_number)) ? Number(final.scene_number) : null,
    shot_index: Number.isFinite(Number(final?.shot_index)) ? Number(final.shot_index) : null,
    reason: String(final?.reason || 'No reason supplied').slice(0,3000),
    confidence,
    memory_updates: Array.isArray(final?.memory_updates) ? final.memory_updates : [],
    recovery_plan: final?.recovery_plan || null,
    next_phase: final?.next_phase || phase,
  };
}

async function supervise({ storyline, episode = null, phase, objective, extraContext = {}, maxToolSteps = MAX_TOOL_STEPS }) {
  let runId = null;
  try {
    runId = await memory.startRun({
      storylineId: storyline?.id,
      episodeId: episode?.id,
      seasonNumber: episode?.season_number || storyline?.current_season,
      episodeNumber: episode?.episode_number || storyline?.current_episode,
      phase,
      goal: objective,
    });
  } catch (err) {
    console.warn(`[Agent] Could not start durable supervisor run: ${err.message}`);
    if (db.isSchemaError(err)) {
      await db.initSchema().catch(()=>{});
      await memory.initAgentMemorySchema().catch(()=>{});
      runId = await _safeMemoryCall('startRun retry', () => memory.startRun({
        storylineId: storyline?.id, episodeId: episode?.id,
        seasonNumber: episode?.season_number || storyline?.current_season,
        episodeNumber: episode?.episode_number || storyline?.current_episode,
        phase, goal: objective,
      }));
    }
  }

  const globalMemory = await _safeMemoryCall('snapshot', () => memory.buildGlobalMemorySnapshot({ storyline, episode, phase }))
    || { phase, storyline:{}, memory:[], recent_events:[] };
  const authoritativeDbJsSchema = phase === 'recovery'
    ? await _safeMemoryCall('db.js schema authority', () => recovery.queryAuthoritativeDbJsSchema())
    : null;

  const tools = buildTools({ storylineId:storyline?.id, episodeId:episode?.id, runId });
  const toolByName = new Map(tools.map(t => [t.schema.function.name, t]));

  const system = `You are the StreamVerse Autonomous Production Recovery Agent.

ROLE:
You control recovery of a deterministic media-production pipeline. The database and persisted artifacts are authoritative; your own intuition is not.

MANDATORY PROTOCOL:
1. OBSERVE with deterministic tools first.
2. DIAGNOSE the failure and root cause.
3. PLAN the smallest owning-unit repair.
4. SIMULATE / estimate risk before mutation.
5. APPLY only through typed recovery tools with snapshot/rollback protection.
6. VERIFY hard invariants, media health and actual visual coherence where applicable.
7. COMMIT only after verification. If verification fails, rollback automatically.

NEVER:
- invent database tables, columns, scene storage or state;
- assume a restart is a repair;
- regenerate valid upstream work merely because a downstream projection is incomplete;
- execute arbitrary SQL;
- mark a repair successful without verification;
- ignore real media evidence;
- confuse a cascade failure with the root cause.

DATABASE AUTHORITY — ABSOLUTE RULE:
- src/db.js is the authoritative application schema contract.
- For any database-related claim, repair, table, column, constraint, or migration decision, use query_authoritative_dbjs_schema and/or validate_database_reference first.
- Live information_schema describes what currently exists; it does NOT redefine what the application schema is.
- Agent memory is historical evidence only and can NEVER override src/db.js.
- If an object is not declared by src/db.js, the agent MUST NOT propose creating, querying, repairing, migrating, populating, or referencing it as an application-schema object.
- Never invent SQL, tables, columns, scene storage, or relationships.

CANONICAL DATA MODEL:
- full series simulation: storylines.full_story_simulation
- episode trajectory/simulation/scene/shot simulation: episodes.script
- scene simulation: episodes.script.scene_simulation.scene_beat_plan
- shot simulation: episodes.script.shot_simulation.shots
- compiled scene URLs: episodes.scene_state
- rendered media rows: shots

STATE GRAPH:
${recovery.PIPELINE_STATES.join(' -> ')}

HARD CONTRACT:
shot duration 6..10 seconds; prompt required; scene numbers contiguous; shot indexes contiguous within scene; scenes require opening/closing/handoff states; later layers cannot legitimately claim completion beyond the first incomplete predecessor.

OUTPUT:
Return a single JSON object with action continue|repair|pause, reason, confidence 0..1, optional recovery_plan, and next_phase.`;

  const messages = [
    { role:'system', content:system },
    { role:'user', content:JSON.stringify({objective,phase,extraContext,globalMemory,authoritative_dbjs_schema:authoritativeDbJsSchema}) },
  ];

  let final = null;
  try {
    for (let step=0; step<Math.max(1,maxToolSteps); step++) {
      let toolChoice = 'auto';
      if (phase === 'recovery' && step === 0) toolChoice = { type: 'function', function: { name: 'query_authoritative_dbjs_schema' } };
      else if (phase === 'recovery') toolChoice = 'any';
      const response=await _mistralTools(messages,tools,0.05,runId,toolChoice);
      const msg=response?.choices?.[0]?.message;
      if(!msg) throw new Error('Agent returned no message');
      messages.push(msg);
      const calls=Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if(!calls.length) {
        let finalResponse;
        try {
          finalResponse = await _mistralFinal(messages, runId);
        } catch (_) {
          finalResponse = response;
        }
        const content = typeof finalResponse?.choices?.[0]?.message?.content === 'string'
          ? finalResponse.choices[0].message.content.trim()
          : (typeof msg.content === 'string' ? msg.content.trim() : '');
        final = jsonParse(content, null) || {
          action:'continue',
          phase,
          reason:content || 'deterministic pipeline remains authoritative',
          confidence:0.4,
          next_phase:phase,
        };
        break;
      }

      for(const call of calls){
        const fn=toolByName.get(call?.function?.name);
        let result;
        if(!fn) result={error:`Unknown tool ${call?.function?.name}`};
        else {
          try { result=await fn.handler(jsonParse(call?.function?.arguments,{})); }
          catch(err){ result={error:err.message,code:err.code || null}; }
        }
        messages.push({role:'tool',tool_call_id:call.id,name:call.function.name,content:JSON.stringify(result)});
        await _safeMemoryCall('tool event',()=>memory.rememberEvent({
          runId,storylineId:storyline?.id,episodeId:episode?.id,eventType:'tool_call',
          payload:{tool:call.function.name,arguments:jsonParse(call?.function?.arguments,{}),result},
        }));
      }
    }

    if(!final) final={action:'continue',phase,reason:'Agent inspection limit reached; durable deterministic pipeline remains authoritative',confidence:0.4,next_phase:phase};
    final=_normalizeFinalDecision(final,phase);

    await _safeMemoryCall('run update',()=>memory.updateRun(runId,{cursorState:{phase,objective},lastDecision:final}));
    for(const update of final.memory_updates){
      if(update?.scope && update?.key) {
        await _safeMemoryCall('memory update',()=>memory.remember({
          storylineId:storyline?.id,episodeId:episode?.id,scope:update.scope,key:update.key,value:update.value,source:'agent',
        }));
      }
    }
    await _safeMemoryCall('decision event',()=>memory.rememberEvent({runId,storylineId:storyline?.id,episodeId:episode?.id,eventType:'decision',payload:final}));
    await _safeMemoryCall('run finish',()=>memory.finishRun(runId,'completed',{lastDecision:final}));
    return {...final,run_id:runId};
  } catch(err) {
    await _safeMemoryCall('failed run finish',()=>memory.finishRun(runId,'failed',{errorState:{message:err.message,code:err.code}}));
    console.warn(`[Agent] Supervisor degraded safely: ${err.message}`);
    return {action:'continue',phase,reason:`Supervisor unavailable; deterministic pipeline remains authoritative: ${err.message}`,confidence:0.2,next_phase:phase,run_id:runId};
  }
}

async function runAutonomousRecovery({storyline,episode,error,maxRounds=MAX_RECOVERY_ROUNDS}={}) {
  const episodeId=episode?.id || null;
  const storylineId=storyline?.id || episode?.storyline_id || null;
  const history=[];

  for(let round=1; round<=maxRounds; round++){
    const deterministic=await recovery.diagnosePipelineFailure({
      error:error?.message || error || 'unknown pipeline failure',
      code:error?.pipelineCode || error?.code,
      episodeId,storylineId,
    });
    const integrity=episodeId ? await recovery.diagnoseEpisodeIntegrity(episodeId) : await recovery.diagnoseDatabaseIntegrity();
    const diagnostics={
      ...deterministic,
      pipeline_layer:error?.pipelineLayer || null,
      pipeline_code:error?.pipelineCode || error?.code || null,
      scene_number:error?.sceneNumber ?? null,
      shot_index:error?.shotIndex ?? null,
      invariants:Array.isArray(integrity?.invariants) ? integrity.invariants : (integrity?.invariants?.violations || integrity?.violations || []),
      episode_integrity:integrity,
    };
    history.push({round,diagnostics});

    if(integrity.ok) {
      return {ok:true,healed:true,rounds:round-1,history,action:'none',reason:'Deterministic verification found no remaining invariant violation'};
    }

    const decision=await supervise({
      storyline,episode,phase:'recovery',
      objective:`Autonomously recover the pipeline from this concrete failure: ${error?.message || error}. Round ${round}/${maxRounds}. Deterministic diagnostics have already been collected. Produce the smallest safe typed repair.`,
      extraContext:{error,deterministic,integrity},
      maxToolSteps:Math.min(MAX_TOOL_STEPS,12),
    });

    history.push({round,decision});
    if(decision.action==='pause') return {ok:false,paused:true,rounds:round,history,reason:decision.reason};

    let plan=decision.recovery_plan;
    if(!plan) {
      let currentState=null;
      if (episodeId) {
        try {
          currentState=(await recovery.queryPipelineState(storylineId,episodeId))?.inferred_state || null;
        } catch (_) {}
      }
      plan=recovery.buildRecoveryPlan(diagnostics,{currentState});
    }

    if(decision.scene_number != null && plan?.chosen_repair){
      plan.chosen_repair.scene_number=decision.scene_number;
      plan.chosen_repair.shot_index=decision.shot_index;
    }

    try{
      const result=await recovery.executeRecoveryPlan(plan,{
        episodeId,storylineId,sceneNumber:decision.scene_number ?? diagnostics.scene_number,shotIndex:decision.shot_index ?? diagnostics.shot_index,
        errorMessage:error?.message || null,
      });
      history.push({round,result});
      await recovery.learnRecoveryOutcome({
        pattern:deterministic.classified?.category || 'unknown',
        repair:plan.chosen_repair?.type,
        success:result.ok,
        storylineId,episodeId,
      }).catch(()=>{});

      if(result.ok){
        const verified=await recovery.diagnoseEpisodeIntegrity(episodeId);
        if(verified.ok) return {ok:true,healed:true,rounds:round,history,reason:'Repair committed and verification passed'};
      }
      error={message:`Recovery round ${round} did not restore invariants`,pipelineCode:'RECOVERY_VERIFY_FAILED'};
    } catch(err){
      history.push({round,execution_error:err.message});
      await recovery.learnRecoveryOutcome({
        pattern:deterministic.classified?.category || 'unknown',
        repair:plan?.chosen_repair?.type,
        success:false,
        storylineId,episodeId,
      }).catch(()=>{});
      error=err;
    }
  }

  return {ok:false,healed:false,rounds:maxRounds,history,reason:'Recovery rounds exhausted without verified convergence'};
}



async function runProductionAgent({ storyline = null, episode = null, maxSteps = null } = {}) {
  const limit = Math.max(8, Math.min(60, Number(maxSteps || process.env.MISTRAL_PRODUCTION_AGENT_MAX_STEPS || 30)));
  let currentStoryline = storyline;
  let currentEpisode = episode;
  let runId = null;

  try {
    runId = await memory.startRun({
      storylineId: currentStoryline?.id || null,
      episodeId: currentEpisode?.id || null,
      seasonNumber: currentEpisode?.season_number || currentStoryline?.current_season || null,
      episodeNumber: currentEpisode?.episode_number || currentStoryline?.current_episode || null,
      phase: 'production_agent',
      goal: 'Autonomously produce the next valid StreamVerse episode from durable state to publication.',
    });
  } catch (_) {}

  const productionTools = require('./agentProductionTools');
  const tools = buildTools({ storylineId: currentStoryline?.id || null, episodeId: currentEpisode?.id || null, runId });
  const toolByName = new Map(tools.map(t => [t.schema.function.name, t]));

  const state0 = await productionTools.inspectProductionState({
    storyline_id: currentStoryline?.id || null,
    episode_id: currentEpisode?.id || null,
  }).catch(err => ({ error: err.message }));

  const system = `You are the StreamVerse Autonomous Production Agent.\n\n` +
`You are the PRIMARY ORCHESTRATOR of the entire video-production pipeline, not merely a recovery assistant. The durable database and validated artifacts are the source of truth. You decide which production tool to call next. The tools perform execution.\n\n` +
`YOUR JOB:\n` +
`Take a project from its current durable state through the next valid production milestone, including series creation, season simulation, episode simulation, script/shot generation, media generation, compilation, validation and publication. Resume existing work rather than restarting it.\n\n` +
`MANDATORY BEHAVIOR:\n` +
`1. Always inspect production_state before making a new decision.\n` +
`2. Use the smallest next valid tool action based on durable evidence.\n` +
`3. Never regenerate a locked/complete upstream layer just because a downstream layer is incomplete.\n` +
`4. Never fabricate DB tables, columns, episode IDs, counts, or states. Use DB-backed tools.\n` +
`5. Never publish until validate_episode returns ok=true.\n` +
`6. When a tool fails, diagnose with the recovery tools already available, repair only the owning unit, then re-inspect production_state.\n` +
`7. Preserve locked creative continuity. Locked season trajectories, scene simulations and shot simulations are authoritative.\n` +
`8. You may use ALL database inspection/recovery tools in addition to the production tools.\n\n` +
`NORMAL PRODUCTION ORDER (guide, not a hard-coded workflow):\n` +
`initialize_series -> simulate_season -> ensure_episode_draft -> simulate_episode_scenes -> write_episode_script -> prepare_shot_rows -> generate_episode_media -> compile_episode -> validate_episode -> publish_episode.\n` +
`You are allowed to deviate from this sequence when production_state and validation evidence show another tool is the correct next action.\n\n` +
`RESPONSE CONTRACT:\n` +
`Use tool calls until the current episode is published, or until a genuine unrecoverable/provider-exhaustion condition requires a pause. Then return a concise JSON decision with action=continue|repair|pause, next_phase, reason and confidence.`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({
      mission: 'Run the autonomous production pipeline from the durable current state.',
      current_state: state0,
    }) },
  ];

  let lastDecision = null;
  try {
    for (let step = 0; step < limit; step++) {
      const forced = step === 0 ? { type: 'function', function: { name: 'production_state' } } : 'auto';
      const response = await _mistralTools(messages, tools, 0.08, runId, forced);
      const msg = response?.choices?.[0]?.message;
      if (!msg) throw new Error('Production agent returned no message');
      messages.push(msg);
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!calls.length) {
        const content = typeof msg.content === 'string' ? msg.content.trim() : '';
        lastDecision = jsonParse(content, { action: 'continue', next_phase: 'production_agent', reason: content || 'No final decision supplied', confidence: 0.5 });
        break;
      }

      for (const call of calls) {
        const name = call?.function?.name;
        const fn = toolByName.get(name);
        let result;
        const args = jsonParse(call?.function?.arguments, {});
        if (!fn) result = { error: `Unknown tool ${name}` };
        else {
          try {
            result = await fn.handler(args);
            if (name === 'initialize_series' && result?.storyline) currentStoryline = result.storyline;
            if (name === 'ensure_episode_draft' && result?.id) currentEpisode = result;
            if (result?.episode?.id) currentEpisode = result.episode;
            if (result?.storyline?.id) currentStoryline = result.storyline;
          } catch (err) {
            result = { ok: false, error: err.message, code: err.code || null };
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(result) });
        await _safeMemoryCall('production tool event', () => memory.rememberEvent({
          runId, storylineId: currentStoryline?.id, episodeId: currentEpisode?.id,
          eventType: 'production_tool_call', payload: { tool: name, arguments: args, result },
        }));
        if (name === 'publish_episode' && result?.ok !== false) {
          lastDecision = { action: 'continue', phase: 'published', next_phase: 'published', reason: 'Episode published successfully.', confidence: 1 };
          await _safeMemoryCall('production run finish', () => memory.finishRun(runId, 'completed', { lastDecision }));
          return { ok: true, published: true, decision: lastDecision, run_id: runId, result };
        }
      }
    }

    if (!lastDecision) lastDecision = { action: 'pause', phase: 'production_agent', next_phase: 'production_agent', reason: `Agent step budget exhausted after ${limit} tool steps; durable work remains resumable.`, confidence: 0.7 };
    await _safeMemoryCall('production run update', () => memory.updateRun(runId, { cursorState: { phase: 'production_agent' }, lastDecision }));
    await _safeMemoryCall('production run finish', () => memory.finishRun(runId, lastDecision.action === 'pause' ? 'paused' : 'completed', { lastDecision }));
    return { ok: lastDecision.action !== 'pause', published: false, decision: lastDecision, run_id: runId };
  } catch (err) {
    await _safeMemoryCall('production run failed', () => memory.finishRun(runId, 'failed', { errorState: { message: err.message, code: err.code || null } }));
    return { ok: false, published: false, error: err.message, run_id: runId };
  }
}

module.exports = { MODEL, MAX_TOOL_STEPS, supervise, runAutonomousRecovery, buildTools, runProductionAgent, _mistralTools };
