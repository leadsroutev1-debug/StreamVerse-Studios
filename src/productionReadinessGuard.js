'use strict';

/**
 * Deterministic production-readiness guard for the autonomous agent.
 *
 * This is intentionally outside the LLM/orchestrator: the model may propose
 * actions, but it cannot bypass series/season/scene prerequisites.
 *
 * Guarded invariants:
 *   series -> real titled storyline
 *   season -> authoritative season simulation + episode trajectory
 *   episode -> complete narrative scene simulation before scriptwriting
 *
 * Invalid legacy placeholder storylines are retired, not deleted, so the
 * production database remains auditable while placeholders can never become
 * the active production target again.
 */
const Module = require('module');
const path = require('path');

const originalLoad = Module._load;
let wrappedProductionTools = null;
let initializationPromise = null;

const PLACEHOLDER_RE = /^(placeholder(?:[-_ ]storyline)?|placeholder storyline|untitled|test)$/i;

function json(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function isPlaceholderStoryline(row) {
  if (!row) return true;
  const title = String(row.title || '').trim();
  const id = String(row.id || '').trim();
  const simulation = json(row.full_story_simulation, {});
  const hasSimulation = simulation && typeof simulation === 'object' && (
    Array.isArray(simulation.episode_trajectory) ||
    Array.isArray(simulation.season_simulations) ||
    Object.keys(simulation).length > 2
  );
  return PLACEHOLDER_RE.test(title) || /^placeholder[-_]/i.test(id) ||
    (((!title || !String(row.logline || row.plot_summary || '').trim()) && Number(row.episode_count || 0) === 0) && !hasSimulation);
}

async function retirePlaceholders(db) {
  const rows = await db.query(`
    SELECT id,title,genre,status,logline,plot_summary,episode_count,full_story_simulation
    FROM storylines
    WHERE status='active'
    ORDER BY updated_at DESC
  `);
  let retired = 0;
  for (const row of rows) {
    if (!isPlaceholderStoryline(row)) continue;
    await db.execute(
      `UPDATE storylines SET status='completed', updated_at=NOW() WHERE id=? AND status='active'`,
      [row.id],
    );
    await db.execute(
      `UPDATE episodes SET status='error', paused_reason=?
       WHERE storyline_id=? AND status IN ('draft','paused','ready','generating')`,
      ['Retired invalid placeholder storyline before production initialization', row.id],
    ).catch(() => {});
    retired++;
    console.warn(`[ProductionGuard] Retired invalid placeholder storyline ${row.id} (${row.title || 'untitled'})`);
  }
  return retired;
}

async function assertRealSeries(db, storylineId, { requireSimulation = false, season = null, episode = null } = {}) {
  const row = await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [storylineId]);
  if (!row) throw new Error(`Production invariant failed: storyline '${storylineId}' does not exist`);
  if (isPlaceholderStoryline(row)) throw new Error(`Production invariant failed: placeholder storyline '${row.id}' cannot enter production`);
  if (String(row.status) !== 'active') throw new Error(`Production invariant failed: storyline '${row.id}' is not active`);
  if (!String(row.title || '').trim()) throw new Error('Production invariant failed: storyline has no title');

  if (requireSimulation) {
    const full = json(row.full_story_simulation, {});
    if (!Array.isArray(full.season_simulations) || !full.season_simulations.length) {
      throw new Error(`Production invariant failed: series simulation is missing for '${row.title}'`);
    }
    if (season != null) {
      const seasonSim = full.season_simulations.find(s => Number(s.season) === Number(season));
      if (!seasonSim || !Array.isArray(seasonSim.episode_trajectory) || !seasonSim.episode_trajectory.length ||
          !['complete', 'season_ready'].includes(String(seasonSim.simulation_status || ''))) {
        throw new Error(`Production invariant failed: Season ${season} simulation is not ready for '${row.title}'`);
      }
      if (episode != null) {
        const trajectory = seasonSim.episode_trajectory.find(e => Number(e.episode) === Number(episode));
        if (!trajectory) throw new Error(`Production invariant failed: S${season}E${episode} trajectory is missing for '${row.title}'`);
      }
    }
  }
  return row;
}

function wrapProductionTools(original) {
  if (wrappedProductionTools) return wrappedProductionTools;
  const wrapped = { ...original };

  const originalInitializeSeries = original.initializeSeries;
  wrapped.initializeSeries = async (args = {}) => {
    if (initializationPromise) return initializationPromise;
    initializationPromise = (async () => {
      const db = originalLoad(path.join(__dirname, 'db.js'), module, false);
      await retirePlaceholders(db);
      const result = await originalInitializeSeries(args);
      const storyline = result?.storyline;
      if (!storyline || isPlaceholderStoryline(storyline)) {
        throw new Error('Production initialization refused: no real titled storyline was created');
      }
      await assertRealSeries(db, storyline.id);
      console.log(`[ProductionGuard] Series initialized/selected: ${storyline.title} (${storyline.id})`);
      return result;
    })();
    try {
      return await initializationPromise;
    } finally {
      initializationPromise = null;
    }
  };

  const originalSimulateSeason = original.simulateSeason;
  wrapped.simulateSeason = async (args = {}) => {
    const db = originalLoad(path.join(__dirname, 'db.js'), module, false);
    await assertRealSeries(db, args.storyline_id);
    return originalSimulateSeason(args);
  };

  const originalEnsureDraft = original.ensureDraft;
  wrapped.ensureDraft = async (args = {}) => {
    const db = originalLoad(path.join(__dirname, 'db.js'), module, false);
    await assertRealSeries(db, args.storyline_id);
    return originalEnsureDraft(args);
  };

  const originalSimulateEpisodeScenes = original.simulateEpisodeScenes;
  wrapped.simulateEpisodeScenes = async ({ episode_id, ...rest } = {}) => {
    const db = originalLoad(path.join(__dirname, 'db.js'), module, false);
    const episode = await db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episode_id]);
    if (!episode) throw new Error(`Episode '${episode_id}' not found`);
    const storyline = await assertRealSeries(db, episode.storyline_id);
    let full = json(storyline.full_story_simulation, {});
    let seasonSim = Array.isArray(full.season_simulations)
      ? full.season_simulations.find(s => Number(s.season) === Number(episode.season_number))
      : null;

    if (!seasonSim || !Array.isArray(seasonSim.episode_trajectory) || !seasonSim.episode_trajectory.length) {
      console.log(`[ProductionGuard] Season ${episode.season_number} simulation missing; completing it before scene simulation.`);
      await originalSimulateSeason({ storyline_id: storyline.id, season_number: Number(episode.season_number) });
      const refreshed = await db.queryOne(`SELECT full_story_simulation FROM storylines WHERE id=?`, [storyline.id]);
      full = json(refreshed?.full_story_simulation, {});
      seasonSim = Array.isArray(full.season_simulations)
        ? full.season_simulations.find(s => Number(s.season) === Number(episode.season_number))
        : null;
    }

    await assertRealSeries(db, storyline.id, {
      requireSimulation: true,
      season: episode.season_number,
      episode: episode.episode_number,
    });
    return originalSimulateEpisodeScenes({ episode_id, ...rest });
  };

  const originalWriteScript = original.writeEpisodeBlueprintAndShotSimulation;
  wrapped.writeEpisodeBlueprintAndShotSimulation = async ({ episode_id, ...rest } = {}) => {
    const db = originalLoad(path.join(__dirname, 'db.js'), module, false);
    const episode = await db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episode_id]);
    if (!episode) throw new Error(`Episode '${episode_id}' not found`);

    const storyline = await assertRealSeries(db, episode.storyline_id);
    let full = json(storyline.full_story_simulation, {});
    let seasonSim = Array.isArray(full.season_simulations)
      ? full.season_simulations.find(s => Number(s.season) === Number(episode.season_number))
      : null;

    if (!seasonSim || !Array.isArray(seasonSim.episode_trajectory) || !seasonSim.episode_trajectory.length ||
        !['complete', 'season_ready'].includes(String(seasonSim.simulation_status || ''))) {
      console.log(`[ProductionGuard] BLOCKING scriptwriting until Season ${episode.season_number} simulation is complete.`);
      await originalSimulateSeason({ storyline_id: storyline.id, season_number: Number(episode.season_number) });
      const refreshed = await db.queryOne(`SELECT full_story_simulation FROM storylines WHERE id=?`, [storyline.id]);
      full = json(refreshed?.full_story_simulation, {});
      seasonSim = Array.isArray(full.season_simulations)
        ? full.season_simulations.find(s => Number(s.season) === Number(episode.season_number))
        : null;
    }

    await assertRealSeries(db, storyline.id, {
      requireSimulation: true,
      season: episode.season_number,
      episode: episode.episode_number,
    });

    const currentScript = json(episode.script, {});
    const narrative = currentScript.narrative_simulation;
    if (!narrative || narrative.simulation_status !== 'complete') {
      console.log(`[ProductionGuard] BLOCKING scriptwriting until S${episode.season_number}E${episode.episode_number} scene simulation is complete.`);
      const simulationResult = await originalSimulateEpisodeScenes({ episode_id });
      if (!simulationResult?.ok) {
        throw new Error(`Production invariant failed: S${episode.season_number}E${episode.episode_number} scene simulation did not complete`);
      }
    }

    return originalWriteScript({ episode_id, ...rest });
  };

  wrapped.__productionReadinessGuard = true;
  wrapped.__isPlaceholderStoryline = isPlaceholderStoryline;
  wrapped.__assertRealSeries = assertRealSeries;
  wrappedProductionTools = wrapped;
  return wrapped;
}

Module._load = function(request, parent, isMain) {
  if (request === './agentProductionTools' && parent && parent.filename && path.basename(parent.filename) === 'agentOrchestrator.js') {
    const originalPath = path.join(__dirname, 'agentProductionTools.js');
    const original = originalLoad(originalPath, parent, isMain);
    return wrapProductionTools(original);
  }
  return originalLoad(request, parent, isMain);
};

console.log('[ProductionGuard] Deterministic series/season/scene readiness guard loaded.');
