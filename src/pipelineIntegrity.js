'use strict';

/**
 * Durable production-stage integrity.
 * Each stage consumes the immediately previous artifact revision and writes its
 * own revision. A downstream artifact is stale when its parent revision no
 * longer matches the current upstream revision.
 */

const db = require('./db');
const { v4: uuidv4 } = require('uuid');

const STAGES = Object.freeze([
  'season_blueprint',
  'episode_blueprint',
  'scene_simulation',
  'shot_simulation',
  'scene_shot_writing',
  'media_generation',
  'episode_compile',
]);

function _token() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureSchema() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pipeline_artifacts (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      episode_id VARCHAR(36) NOT NULL,
      scene_number INT NULL,
      shot_index INT NULL,
      stage VARCHAR(40) NOT NULL,
      revision VARCHAR(80) NOT NULL,
      parent_stage VARCHAR(40) NULL,
      parent_revision VARCHAR(80) NULL,
      payload JSON NULL,
      status ENUM('active','superseded','rolled_back','invalidated') NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_artifact_owner (episode_id, scene_number, shot_index),
      INDEX idx_artifact_stage (episode_id, stage, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS production_checkpoints (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      episode_id VARCHAR(36) NOT NULL,
      checkpoint_key VARCHAR(120) NOT NULL,
      stage VARCHAR(40) NOT NULL,
      scene_number INT NULL,
      shot_index INT NULL,
      artifact_revision VARCHAR(80) NULL,
      status ENUM('active','rolled_back','superseded') NOT NULL DEFAULT 'active',
      metadata JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_checkpoint_episode (episode_id, created_at),
      INDEX idx_checkpoint_key (episode_id, checkpoint_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `).catch(async err => {
    // Existing installations created the old UNIQUE(ep, checkpoint_key) index.
    // Remove it so each real persisted checkpoint is retained as history.
    const msg = String(err?.message || '').toLowerCase();
    if (!msg.includes('duplicate') && !msg.includes('already exists')) throw err;
  });

  // Migrate the original schema's unique checkpoint key into a normal index.
  try {
    await db.execute(`ALTER TABLE production_checkpoints DROP INDEX uq_episode_checkpoint`);
  } catch (_) {}
  try {
    await db.execute(`ALTER TABLE production_checkpoints ADD INDEX idx_checkpoint_key (episode_id, checkpoint_key)`);
  } catch (_) {}
}

async function latest(episodeId, stage, sceneNumber = null, shotIndex = null) {
  return db.queryOne(
    `SELECT * FROM pipeline_artifacts
     WHERE episode_id=? AND stage=? AND status='active'
       AND (? IS NULL OR scene_number=?)
       AND (? IS NULL OR shot_index=?)
     ORDER BY created_at DESC LIMIT 1`,
    [episodeId, stage, sceneNumber, sceneNumber, shotIndex, shotIndex]
  );
}

async function writeArtifact({ episodeId, stage, payload, sceneNumber = null, shotIndex = null, parentStage = null, parentRevision = null }) {
  if (!STAGES.includes(stage)) throw new Error(`[Integrity] Unknown stage ${stage}`);
  const previous = await latest(episodeId, stage, sceneNumber, shotIndex);
  if (previous) {
    await db.execute(`UPDATE pipeline_artifacts SET status='superseded' WHERE id=?`, [previous.id]);
  }
  const revision = `${stage}:${_token()}`;
  const id = uuidv4();
  await db.execute(
    `INSERT INTO pipeline_artifacts
      (id, episode_id, scene_number, shot_index, stage, revision, parent_stage, parent_revision, payload, status)
     VALUES (?,?,?,?,?,?,?,?,?,'active')`,
    [id, episodeId, sceneNumber, shotIndex, stage, revision, parentStage, parentRevision, JSON.stringify(payload ?? null)]
  );
  return { id, revision };
}

async function requireParent({ episodeId, stage, sceneNumber = null, shotIndex = null }) {
  const index = STAGES.indexOf(stage);
  if (index <= 0) return null;
  const parentStage = STAGES[index - 1];
  const parent = await latest(episodeId, parentStage, sceneNumber, shotIndex);
  if (!parent) throw new Error(`[Integrity] ${stage} blocked: no current ${parentStage} artifact for episode ${episodeId}`);
  return parent;
}

async function invalidateDownstream(episodeId, stage, sceneNumber = null, shotIndex = null) {
  const start = STAGES.indexOf(stage);
  if (start < 0) return;
  const downstream = STAGES.slice(start + 1);
  if (!downstream.length) return;
  await db.execute(
    `UPDATE pipeline_artifacts SET status='invalidated'
     WHERE episode_id=? AND status='active' AND stage IN (${downstream.map(() => '?').join(',')})
       AND (? IS NULL OR scene_number=?) AND (? IS NULL OR shot_index=?)`,
    [episodeId, ...downstream, sceneNumber, sceneNumber, shotIndex, shotIndex]
  );
}

async function createCheckpoint({ episodeId, checkpointKey, stage, sceneNumber = null, shotIndex = null, artifactRevision = null, metadata = {} }) {
  const id = uuidv4();
  await db.execute(
    `INSERT INTO production_checkpoints
      (id, episode_id, checkpoint_key, stage, scene_number, shot_index, artifact_revision, status, metadata)
     VALUES (?,?,?,?,?,?,?,'active',?)`,
    [id, episodeId, checkpointKey, stage, sceneNumber, shotIndex, artifactRevision, JSON.stringify(metadata)]
  );
  return db.queryOne(`SELECT * FROM production_checkpoints WHERE id=?`, [id]);
}

/**
 * Complete durable checkpoint history.
 *
 * A checkpoint is not merely the latest state of a stage. Every persisted
 * artifact revision and every explicit checkpoint event is part of the
 * rollback history, including scene/shot-specific revisions.
 */
async function listCheckpoints(episodeId) {
  await ensureSchema();

  const checkpoints = await db.query(
    `SELECT
       id,
       episode_id,
       checkpoint_key,
       stage,
       scene_number,
       shot_index,
       artifact_revision,
       status,
       metadata,
       created_at,
       'checkpoint' AS source_type,
       id AS source_id
     FROM production_checkpoints
    WHERE episode_id=?`,
    [episodeId]
  );

  const artifacts = await db.query(
    `SELECT
       id,
       episode_id,
       CONCAT('artifact:', stage, ':', revision) AS checkpoint_key,
       stage,
       scene_number,
       shot_index,
       revision AS artifact_revision,
       status,
       payload AS metadata,
       created_at,
       'artifact' AS source_type,
       id AS source_id
     FROM pipeline_artifacts
    WHERE episode_id=?
    ORDER BY created_at DESC`,
    [episodeId]
  );

  return [...checkpoints, ...artifacts].sort((a, b) => {
    const at = new Date(a.created_at || 0).getTime();
    const bt = new Date(b.created_at || 0).getTime();
    return bt - at;
  });
}

async function rollbackToCheckpoint(checkpointId) {
  return db.transaction(async conn => {
    let cp;
    let sourceType = 'checkpoint';

    let [rows] = await conn.execute(`SELECT * FROM production_checkpoints WHERE id=? FOR UPDATE`, [checkpointId]);
    if (rows[0]) {
      cp = { ...rows[0], source_type: 'checkpoint' };
    } else {
      [rows] = await conn.execute(`SELECT * FROM pipeline_artifacts WHERE id=? FOR UPDATE`, [checkpointId]);
      if (rows[0]) {
        sourceType = 'artifact';
        cp = {
          id: rows[0].id,
          episode_id: rows[0].episode_id,
          checkpoint_key: `artifact:${rows[0].stage}:${rows[0].revision}`,
          stage: rows[0].stage,
          scene_number: rows[0].scene_number,
          shot_index: rows[0].shot_index,
          artifact_revision: rows[0].revision,
          status: rows[0].status,
          metadata: rows[0].payload,
          created_at: rows[0].created_at,
          source_type: 'artifact',
        };
      }
    }

    if (!cp) throw new Error('Checkpoint or persisted artifact not found');

    const stageIndex = STAGES.indexOf(cp.stage);
    if (stageIndex < 0) throw new Error(`Unknown checkpoint stage ${cp.stage}`);
    const keepStages = STAGES.slice(0, stageIndex + 1);
    const removeStages = STAGES.slice(stageIndex + 1);

    if (removeStages.length) {
      await conn.execute(
        `UPDATE pipeline_artifacts SET status='rolled_back' WHERE episode_id=? AND status IN ('active','superseded') AND stage IN (${removeStages.map(() => '?').join(',')})`,
        [cp.episode_id, ...removeStages]
      );
    }

    await conn.execute(`UPDATE production_checkpoints SET status='rolled_back' WHERE episode_id=? AND created_at>?`, [cp.episode_id, cp.created_at]);

    if (sourceType === 'checkpoint') {
      await conn.execute(`UPDATE production_checkpoints SET status='active' WHERE id=?`, [checkpointId]);
    } else {
      await conn.execute(`UPDATE pipeline_artifacts SET status='active' WHERE id=?`, [checkpointId]);
    }

    // Remove downstream materialized shot/media rows so the selected revision
    // becomes the actual resume boundary rather than merely a dashboard label.
    if (stageIndex < STAGES.indexOf('scene_shot_writing')) {
      await conn.execute(`DELETE FROM shots WHERE episode_id=?`, [cp.episode_id]);
      await conn.execute(`UPDATE episodes SET shot_count=0, shot_state=NULL, scene_state=NULL, video_url=NULL, ready_at=NULL WHERE id=?`, [cp.episode_id]);
    } else if (stageIndex < STAGES.indexOf('media_generation')) {
      if (cp.scene_number == null) {
        await conn.execute(`DELETE FROM shots WHERE episode_id=?`, [cp.episode_id]);
      } else {
        await conn.execute(`DELETE FROM shots WHERE episode_id=? AND scene_number>=?`, [cp.episode_id, cp.scene_number]);
      }
      await conn.execute(`UPDATE episodes SET video_url=NULL, ready_at=NULL WHERE id=?`, [cp.episode_id]);
    } else if (stageIndex < STAGES.indexOf('episode_compile')) {
      await conn.execute(`UPDATE episodes SET video_url=NULL, ready_at=NULL WHERE id=?`, [cp.episode_id]);
    }

    return { ok: true, checkpoint: cp, source_type: sourceType, resumed_from_stage: keepStages[keepStages.length - 1], removed_stages: removeStages };
  });
}

module.exports = { STAGES, ensureSchema, latest, writeArtifact, requireParent, invalidateDownstream, createCheckpoint, listCheckpoints, rollbackToCheckpoint };