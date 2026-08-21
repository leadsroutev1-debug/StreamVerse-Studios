'use strict';

/**
 * Reconcile durable shot rows against the authoritative persisted episode script.
 *
 * The script is the source of truth for the current editorial timeline. The shots
 * table is durable media state, so rows from an older script revision can survive
 * a restart even after the script has been reduced or reshaped. Those stale rows
 * must never count as completed source clips for resume, scene compilation, or the
 * final master merge.
 */

const db = require('./db');

function _authoritativeShotKeys(script) {
  const keys = new Set();
  for (const scene of (script?.scenes || [])) {
    const sceneNumber = Number(scene?.scene_number);
    if (!Number.isFinite(sceneNumber)) continue;
    for (const shot of (scene?.shots || [])) {
      const shotIndex = Number(shot?.shot_index);
      if (!Number.isFinite(shotIndex)) continue;
      keys.add(`${sceneNumber}_${shotIndex}`);
    }
  }
  return keys;
}

async function reconcileDraftShotRows() {
  let episodes;
  try {
    episodes = await db.query(
      `SELECT e.id, e.script, e.shot_count
         FROM episodes e
         JOIN storylines s ON s.id = e.storyline_id
        WHERE e.status IN ('draft','ready')
          AND s.status = 'active'`
    );
  } catch (err) {
    // Schema creation/migrations may not have completed yet. Startup should not
    // fail solely because reconciliation ran before the tables existed.
    console.warn(`[ShotReconcile] Skipping preflight reconciliation: ${err.message}`);
    return;
  }

  let totalStale = 0;
  for (const episode of episodes) {
    let script;
    try {
      script = typeof episode.script === 'string' ? JSON.parse(episode.script) : (episode.script || {});
    } catch (err) {
      console.warn(`[ShotReconcile] Episode ${episode.id}: invalid persisted script JSON — leaving rows untouched`);
      continue;
    }

    const authoritativeKeys = _authoritativeShotKeys(script);
    if (!authoritativeKeys.size) continue;

    const rows = await db.query(
      `SELECT id, scene_number, shot_index, status, enabled
         FROM shots
        WHERE episode_id = ?`,
      [episode.id]
    );

    const staleRows = rows.filter(row =>
      !authoritativeKeys.has(`${Number(row.scene_number)}_${Number(row.shot_index)}`)
    );

    if (staleRows.length) {
      for (const row of staleRows) {
        await db.execute(
          `UPDATE shots
              SET status = 'stale', enabled = 0, mh_job_id = NULL, mh_api_key = NULL
            WHERE id = ?`,
          [row.id]
        );
      }

      totalStale += staleRows.length;
      console.warn(
        `[ShotReconcile] Episode ${episode.id}: marked ${staleRows.length} stale shot row(s) as non-authoritative ` +
        `(script has ${authoritativeKeys.size} shots, DB had ${rows.length}).`
      );
    }

    if (Number(episode.shot_count) !== authoritativeKeys.size) {
      await db.execute(
        `UPDATE episodes SET shot_count = ? WHERE id = ?`,
        [authoritativeKeys.size, episode.id]
      );
      console.log(
        `[ShotReconcile] Episode ${episode.id}: corrected persisted shot_count ` +
        `${episode.shot_count} → ${authoritativeKeys.size}.`
      );
    }
  }

  if (totalStale === 0) {
    console.log('[ShotReconcile] Draft shot state already matches authoritative scripts.');
  } else {
    console.log(`[ShotReconcile] Reconciliation complete: ${totalStale} stale row(s) excluded from production.`);
  }
}

if (require.main === module) {
  reconcileDraftShotRows()
    .catch(err => {
      console.warn(`[ShotReconcile] Preflight failed: ${err.message}`);
    })
    .finally(async () => {
      try { await db.getPool?.()?.end?.(); } catch {}
      process.exit(0);
    });
}

module.exports = { reconcileDraftShotRows };
