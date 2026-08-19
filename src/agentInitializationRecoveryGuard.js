'use strict';

/**
 * StreamVerse production guard: series initialization must be resumable.
 * Composes with productionReadinessGuard and makes canonical character
 * references a deterministic prerequisite for season/episode production.
 *
 * IMPORTANT: this guard deliberately keeps the master series plan canonical,
 * but prevents the production agent from precomputing/advancing through an
 * entire season and prevents it from creating a later episode while an earlier
 * episode is still incomplete. The live production unit is the next missing
 * episode; trajectory simulation is a rolling 3-episode horizon.
 */
const Module = require('module');
const path = require('path');
const previousLoad = Module._load;
let wrapped = null;

function json(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function isPlaceholder(row) {
  if (!row) return true;
  const title = String(row.title || '').trim();
  const id = String(row.id || '').trim();
  return /^(placeholder(?:[-_ ]storyline)?|untitled|test)$/i.test(title) || /^placeholder[-_]/i.test(id);
}

function isCharacterReferenceError(err) {
  return /CFOutputValidationError|Cloudflare returned .*expected 1024x1536|CHARACTER_REFERENCE_INCOMPLETE|reference.*(incomplete|missing|failed)|portrait/i.test(String(err?.message || err || ''));
}

async function referenceStatus(db, storylineId) {
  const rows = await db.query(`SELECT id,name,reference_status,reference_image_url,reference_image_urls,reference_image_meta FROM characters WHERE storyline_id=? ORDER BY created_at`, [storylineId]);
  const required = ['front','three_quarter','profile','full_body'];
  const missing = [];
  for (const row of rows) {
    const meta = json(row.reference_image_meta, {});
    const angles = meta.angles && typeof meta.angles === 'object' ? { ...meta.angles } : {};
    const urls = Array.isArray(row.reference_image_urls) ? row.reference_image_urls : json(row.reference_image_urls, []);
    if (row.reference_image_url && !angles.front) angles.front = row.reference_image_url;
    if (Array.isArray(urls)) required.forEach((a, i) => { if (urls[i] && !angles[a]) angles[a] = urls[i]; });
    for (const angle of required) if (!angles[angle]) missing.push({ character_id: row.id, character: row.name, angle });
  }
  return { ok: rows.length > 0 && missing.length === 0, character_count: rows.length, missing };
}

async function getRecoverableStoryline(db, genre) {
  const rows = await db.query(
    `SELECT * FROM storylines WHERE status='active' ${genre ? 'AND genre=?' : ''} ORDER BY updated_at DESC LIMIT 10`,
    genre ? [genre] : [],
  );
  return rows.find(row => !isPlaceholder(row)) || null;
}

/**
 * Find the canonical next production coordinate.
 *
 * The master simulation may contain future trajectories, but production must
 * never create or render SxE(n+1) while SxE(n) is unfinished. This guard is
 * intentionally DB-derived so a restarted agent cannot "remember" the wrong
 * episode number from an old tool message.
 */
async function nextProductionCoordinate(db, storylineId) {
  const storyline = await db.queryOne(`SELECT id,current_season,current_episode,episode_count FROM storylines WHERE id=?`, [storylineId]);
  if (!storyline) throw new Error('Storyline not found while resolving next production coordinate');

  const episodes = await db.query(
    `SELECT season_number,episode_number,status FROM episodes WHERE storyline_id=? ORDER BY season_number ASC, episode_number ASC, created_at ASC`,
    [storylineId],
  );

  const epsPerSeason = Math.max(1, Number(process.env.EPISODES_PER_SEASON || 20));
  const seasons = Math.max(1, Number(process.env.SEASONS_PER_SERIES || 4));
  const completeStatuses = new Set(['published', 'ready']);

  for (let global = 1; global <= epsPerSeason * seasons; global++) {
    const season = Math.floor((global - 1) / epsPerSeason) + 1;
    const episode = ((global - 1) % epsPerSeason) + 1;
    const rows = episodes.filter(e => Number(e.season_number) === season && Number(e.episode_number) === episode);
    if (!rows.length || !rows.some(e => completeStatuses.has(String(e.status || '').toLowerCase()))) {
      return {
        global_episode: global,
        season_number: season,
        episode_number: episode,
        storyline_current_season: Number(storyline.current_season || 1),
        storyline_current_episode: Number(storyline.current_episode || 0),
        existing_statuses: rows.map(e => String(e.status || '')),
      };
    }
  }

  return null;
}

async function resolveRollingTrajectory({ db, storylineId, seasonNumber, episodeNumber }) {
  const storyline = await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [storylineId]);
  if (!storyline) throw new Error('Storyline not found while resolving rolling trajectory');

  const full = json(storyline.full_story_simulation, {});
  const chars = await db.query(`SELECT * FROM characters WHERE storyline_id=? ORDER BY created_at`, [storylineId]);
  const epsPerSeason = Math.max(1, Number(process.env.EPISODES_PER_SEASON || 20));
  const seasons = Math.max(1, Number(process.env.SEASONS_PER_SERIES || 4));
  const startGlobal = (Number(seasonNumber) - 1) * epsPerSeason + Number(episodeNumber);
  const remaining = epsPerSeason * seasons - startGlobal + 1;
  const windowSize = Math.max(1, Math.min(3, remaining));

  const existing = Array.isArray(full.episode_trajectory)
    ? full.episode_trajectory.filter(ep => {
        const g = Number(ep?.global_episode || 0);
        return g >= startGlobal && g < startGlobal + windowSize;
      })
    : [];

  const trajectories = await scriptWriter.simulateEpisodeTrajectoryWindow({
    storyline: {
      ...storyline,
      episodes_per_season: epsPerSeason,
      seasons_per_series: seasons,
    },
    characters: chars,
    startGlobalEpisode: startGlobal,
    windowSize,
  });

  const byGlobal = new Map(trajectories.map(ep => [Number(ep.global_episode), ep]));
  const target = byGlobal.get(startGlobal);
  if (!target) throw new Error(`Rolling trajectory window did not produce S${seasonNumber}E${episodeNumber}`);

  const mergedTrajectory = Array.isArray(full.episode_trajectory) ? full.episode_trajectory.slice() : [];
  const byKey = new Map(mergedTrajectory.map(ep => [`${Number(ep.season)}:${Number(ep.episode)}`, ep]));
  for (const ep of trajectories) byKey.set(`${Number(ep.season)}:${Number(ep.episode)}`, ep);

  const updated = {
    ...full,
    episode_trajectory: [...byKey.values()].sort((a, b) => Number(a.global_episode) - Number(b.global_episode)),
    simulation_status: 'rolling_window',
    simulation_total_episodes: epsPerSeason * seasons,
    simulation_completed_episodes: [...byKey.values()].length,
    simulation_window_start: startGlobal,
    simulation_window_end: startGlobal + windowSize - 1,
  };

  await db.execute(`UPDATE storylines SET full_story_simulation=?,updated_at=NOW() WHERE id=?`, [JSON.stringify(updated), storylineId]);
  return { storyline, full: updated, trajectory: target, window: trajectories };
}

function wrapProductionTools(original) {
  if (wrapped) return wrapped;
  const out = { ...original };
  const db = previousLoad(path.join(__dirname, 'db.js'), module, false);
  const scriptWriter = previousLoad(path.join(__dirname, 'scriptWriter.js'), module, false);

  const originalInitialize = original.initializeSeries;
  out.initializeSeries = async (args = {}) => {
    try {
      const result = await originalInitialize(args);
      if (result?.storyline?.id) {
        const refs = await referenceStatus(db, result.storyline.id);
        if (!refs.ok) return { ...result, ok: true, pending: true, phase: 'character_references', code: 'CHARACTER_REFERENCE_INCOMPLETE', character_references: refs, reason: 'Series is durably initialized, but canonical character references are incomplete. Retry the character-reference stage before episode production.' };
      }
      return result;
    } catch (err) {
      if (!isCharacterReferenceError(err)) throw err;
      const storyline = await getRecoverableStoryline(db, args.genre || null);
      if (!storyline) throw err;
      const refs = await referenceStatus(db, storyline.id);
      console.warn(`[ProductionGuard] Recoverable series initialization failure retained durable series ${storyline.title}; missing canonical angles=${refs.missing.length}`);
      return { ok: true, created: true, pending: true, phase: 'character_references', code: 'CHARACTER_REFERENCE_INCOMPLETE', storyline, character_references: refs, reason: `Character reference generation is incomplete: ${refs.missing.length} canonical angle(s) still missing.`, error: String(err.message || err) };
    }
  };

  const originalSimulateSeason = original.simulateSeason;
  out.simulateSeason = async (args = {}) => {
    const storylineId = args.storyline_id;
    const row = storylineId ? await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [storylineId]) : null;
    if (!row || isPlaceholder(row)) throw new Error('Production invariant failed: real storyline required before episode trajectory simulation');

    let refs = await referenceStatus(db, storylineId);
    if (!refs.ok) {
      console.log(`[ProductionGuard] CHARACTER_REFERENCE_INCOMPLETE — targeted canonical-angle regeneration before episode trajectory simulation (${refs.missing.length} missing).`);
      try {
        const pipeline = previousLoad(path.join(__dirname, 'pipeline.js'), module, false);
        if (typeof pipeline.ensureCharacterConsistency !== 'function') throw new Error('Character consistency engine is not available');
        await pipeline.ensureCharacterConsistency(storylineId);
      } catch (err) {
        refs = await referenceStatus(db, storylineId);
        const e = new Error(`CHARACTER_REFERENCE_INCOMPLETE: ${refs.missing.length} canonical character angle(s) remain missing after targeted regeneration. ${err.message}`);
        e.code = 'CHARACTER_REFERENCE_INCOMPLETE';
        e.retryable = true;
        throw e;
      }
      refs = await referenceStatus(db, storylineId);
      if (!refs.ok) {
        const e = new Error(`CHARACTER_REFERENCE_INCOMPLETE: ${refs.missing.length} canonical character angle(s) remain missing after targeted regeneration.`);
        e.code = 'CHARACTER_REFERENCE_INCOMPLETE';
        e.retryable = true;
        throw e;
      }
    }

    const next = await nextProductionCoordinate(db, storylineId);
    if (!next) return { ok: true, skipped: true, reason: 'Series has no unfinished production episodes.' };

    const requestedSeason = args.season_number != null ? Number(args.season_number) : next.season_number;
    if (requestedSeason !== next.season_number) {
      throw new Error(`EPISODE_SEQUENCE_GUARD: next production coordinate is S${next.season_number}E${next.episode_number}; requested season S${requestedSeason}`);
    }

    // Do NOT call original.simulateSeason(): that legacy path simulates the entire
    // season in 4-episode chunks and is exactly what produced the observed S1 20/20
    // checkpoint before E1 production. Replace it with the rolling trajectory window.
    const result = await resolveRollingTrajectory({
      db,
      storylineId,
      seasonNumber: next.season_number,
      episodeNumber: next.episode_number,
    });

    return {
      ok: true,
      season: {
        season: next.season_number,
        simulation_status: 'rolling_window',
        episode_trajectory: result.window,
        next_production: next,
        window_start: result.window[0]?.global_episode || next.global_episode,
        window_end: result.window[result.window.length - 1]?.global_episode || next.global_episode,
      },
      rolling_window: result.window,
      next_production: next,
      replaced_legacy_full_season_simulation: true,
    };
  };

  const originalEnsureDraft = original.ensureDraft;
  out.ensureDraft = async (args = {}) => {
    const storylineId = args.storyline_id;
    if (!storylineId) throw new Error('EPISODE_SEQUENCE_GUARD: storyline_id is required');
    const next = await nextProductionCoordinate(db, storylineId);
    if (!next) throw new Error('EPISODE_SEQUENCE_GUARD: series has no unfinished production episode');

    const requestedSeason = Number(args.season_number);
    const requestedEpisode = Number(args.episode_number);
    if (requestedSeason !== next.season_number || requestedEpisode !== next.episode_number) {
      throw new Error(
        `EPISODE_SEQUENCE_GUARD: refusing out-of-order draft S${requestedSeason}E${requestedEpisode}. ` +
        `The canonical next production episode is S${next.season_number}E${next.episode_number} (global ${next.global_episode}). ` +
        `Complete/publish that episode before advancing.`
      );
    }
    return originalEnsureDraft(args);
  };

  out.__characterReferenceRecoveryGuard = true;
  out.__episodeSequenceGuard = true;
  out.__rollingTrajectoryGuard = true;
  wrapped = out;
  return out;
}

Module._load = function(request, parent, isMain) {
  if (request === './agentProductionTools' && parent && parent.filename && path.basename(parent.filename) === 'agentOrchestrator.js') {
    return wrapProductionTools(previousLoad(request, parent, isMain));
  }
  return previousLoad(request, parent, isMain);
};

console.log('[ProductionGuard] Resumable series initialization + canonical character-reference + sequential episode guard loaded.');
