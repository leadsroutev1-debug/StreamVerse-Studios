'use strict';

const { randomUUID } = require('crypto');
const db = require('./db');
const config = require('./config');
const state = require('./state');
const scriptWriter = require('./scriptWriter');
const recovery = require('./autonomousRecovery');
const memory = require('./agentMemory');

function json(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function getDraftAny() {
  const row = await db.queryOne(`
    SELECT e.*, s.title, s.genre, s.storyline_id AS slid
    FROM episodes e JOIN storylines s ON s.id=e.storyline_id
    WHERE e.status IN ('draft','paused','ready','generating','error')
    ORDER BY e.updated_at DESC LIMIT 1
  `);
  if (!row) return null;
  return {
    draft: row,
    storyline: await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [row.storyline_id]),
  };
}

async function getActiveStoryline() {
  return db.queryOne(`SELECT * FROM storylines WHERE status='active' ORDER BY updated_at DESC LIMIT 1`);
}

function episodeCoordinates(storyline, draft) {
  const eps = Math.max(1, num(config.episodesPerSeason, 1));
  const seasons = Math.max(1, num(config.seasonsPerSeries, 1));
  const globalEpisode = Number.isInteger(Number(draft?.episode_number)) && Number(draft.episode_number) > 0
    ? Number(draft.episode_number)
    : num(storyline?.episode_count, 0) + 1;
  const season = Math.max(1, num(draft?.season_number, Math.floor((globalEpisode - 1) / eps) + 1));
  const episode = ((globalEpisode - 1) % eps) + 1;
  const isSeasonFinale = episode === eps;
  const isSeriesMovie = season > seasons || (season === seasons && isSeasonFinale);
  const targetMinutes = Math.max(1, Math.round((isSeriesMovie ? num(config.movieMinSeconds, 120) : num(config.targetEpisodeMinSeconds, 120)) / 60));
  return { eps, seasons, globalEpisode, season, episode, isSeasonFinale, isSeriesMovie, targetMinutes };
}

async function inspectProductionState({ storyline_id = null, episode_id = null } = {}) {
  const draftInfo = episode_id
    ? { draft: await db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episode_id]), storyline: null }
    : await getDraftAny();
  if (draftInfo?.draft && !draftInfo.storyline) draftInfo.storyline = await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [draftInfo.draft.storyline_id]);
  const storyline = storyline_id
    ? await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [storyline_id])
    : (draftInfo?.storyline || await getActiveStoryline());
  const draft = draftInfo?.draft || null;
  const coords = episodeCoordinates(storyline, draft);
  const episodeId = draft?.id || episode_id || null;
  const integrity = episodeId ? await recovery.diagnoseEpisodeIntegrity(episodeId) : null;
  return {
    storyline: storyline ? { id: storyline.id, title: storyline.title, genre: storyline.genre, status: storyline.status, episode_count: storyline.episode_count, full_story_simulation: json(storyline.full_story_simulation, {}) } : null,
    episode: draft ? { id: draft.id, season_number: draft.season_number, episode_number: draft.episode_number, status: draft.status, scene_count: draft.scene_count, shot_count: draft.shot_count, script: json(draft.script, {}), paused_reason: draft.paused_reason, video_url: draft.video_url } : null,
    coordinates: coords,
    integrity,
    inferred_state: recovery.queryPipelineState ? (await recovery.queryPipelineState(storyline?.id || storyline_id, episodeId)).inferred_state : null,
  };
}

async function initializeSeries({ genre = null } = {}) {
  const existingDraft = await getDraftAny();
  if (existingDraft) return { ok: true, reused: true, storyline: existingDraft.storyline, episode: existingDraft.draft };
  let storyline = await getActiveStoryline();
  if (storyline) return { ok: true, reused: true, storyline };

  const selectedGenre = genre || config.genrePool?.[Math.floor(Math.random() * config.genrePool.length)] || 'Drama';
  let provisionalId = null;
  let storyMap = null;
  storyMap = await scriptWriter.writeSeriesSummary(selectedGenre, {
    episodesPerSeason: config.episodesPerSeason,
    seasonsPerSeries: config.seasonsPerSeries,
    generateEpisodeTrajectories: false,
    onCheckpoint: async ({ seriesData, fullStorySimulation }) => {
      if (!provisionalId) {
        provisionalId = randomUUID();
        await db.execute(
          `INSERT INTO storylines (id,title,genre,status,character_bible,plot_summary,full_story_simulation,central_theme,tone_manifesto,visual_language,season_arcs,engagement_hook,premiere_announcement,logline,episode_count,current_season,current_episode,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,0,NOW(),NOW())`,
          [provisionalId, seriesData.title, seriesData.genre, 'active', JSON.stringify(seriesData.character_bible || []), seriesData.plot_summary || seriesData.comprehensive_summary || null, JSON.stringify(fullStorySimulation || {}), seriesData.central_theme || null, seriesData.tone_manifesto || null, JSON.stringify(seriesData.visual_language || {}), JSON.stringify(seriesData.season_arcs || []), seriesData.engagement_hook || null, seriesData.premiere_announcement || null, seriesData.logline || null]
        );
      } else {
        await db.execute(`UPDATE storylines SET full_story_simulation=?, character_bible=?, plot_summary=?, central_theme=?, tone_manifesto=?, visual_language=?, season_arcs=?, engagement_hook=?, premiere_announcement=?, logline=?, updated_at=NOW() WHERE id=?`, [JSON.stringify(fullStorySimulation || {}), JSON.stringify(seriesData.character_bible || []), seriesData.plot_summary || seriesData.comprehensive_summary || null, seriesData.central_theme || null, seriesData.tone_manifesto || null, JSON.stringify(seriesData.visual_language || {}), JSON.stringify(seriesData.season_arcs || []), seriesData.engagement_hook || null, seriesData.premiere_announcement || null, seriesData.logline || null, provisionalId]);
      }
    }
  });
  const lockedCast = await scriptWriter.writeCastBible(storyMap);
  storyMap.character_bible = lockedCast;
  const storylineId = provisionalId || randomUUID();
  if (!provisionalId) {
    await db.execute(`INSERT INTO storylines (id,title,genre,status,character_bible,plot_summary,full_story_simulation,central_theme,tone_manifesto,visual_language,season_arcs,engagement_hook,premiere_announcement,logline,episode_count,current_season,current_episode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,0,NOW(),NOW())`, [storylineId, storyMap.title, storyMap.genre, 'active', JSON.stringify(lockedCast || []), storyMap.plot_summary || storyMap.comprehensive_summary || null, JSON.stringify(storyMap.full_story_simulation || {}), storyMap.central_theme || null, storyMap.tone_manifesto || null, JSON.stringify(storyMap.visual_language || {}), JSON.stringify(storyMap.season_arcs || []), storyMap.engagement_hook || null, storyMap.premiere_announcement || null, storyMap.logline || null]);
  } else {
    await db.execute(`UPDATE storylines SET title=?,genre=?,status='active',character_bible=?,plot_summary=?,full_story_simulation=?,central_theme=?,tone_manifesto=?,visual_language=?,season_arcs=?,engagement_hook=?,premiere_announcement=?,logline=?,updated_at=NOW() WHERE id=?`, [storyMap.title, storyMap.genre, JSON.stringify(lockedCast || []), storyMap.plot_summary || storyMap.comprehensive_summary || null, JSON.stringify(storyMap.full_story_simulation || {}), storyMap.central_theme || null, storyMap.tone_manifesto || null, JSON.stringify(storyMap.visual_language || {}), JSON.stringify(storyMap.season_arcs || []), storyMap.engagement_hook || null, storyMap.premiere_announcement || null, storyMap.logline || null, storylineId]);
  }
  // Character images are part of the tool, not the orchestrator.
  const pipeline = require('./pipeline');
  if (typeof pipeline.insertCharactersWithConsistency === 'function') await pipeline.insertCharactersWithConsistency(storylineId, lockedCast || []);
  storyline = await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [storylineId]);
  await memory.rememberEvent({ storylineId, eventType: 'series_initialized_by_agent', payload: { genre: selectedGenre } }).catch(()=>{});
  return { ok: true, created: true, storyline };
}

async function simulateSeason({ storyline_id, season_number = null } = {}) {
  const storyline = await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [storyline_id]);
  if (!storyline) throw new Error('Storyline not found');
  const coords = episodeCoordinates(storyline, null);
  const seasonNumber = Number(season_number || coords.season);
  const characters = await db.query(`SELECT * FROM characters WHERE storyline_id=? ORDER BY created_at`, [storyline.id]);
  const full = json(storyline.full_story_simulation, {});
  const existingSeason = Array.isArray(full.season_simulations) ? full.season_simulations.find(s=>Number(s.season)===seasonNumber) : null;
  if (existingSeason?.simulation_status === 'complete' && Array.isArray(existingSeason.episode_trajectory) && existingSeason.episode_trajectory.length >= coords.eps) return { ok:true, skipped:true, season:existingSeason };
  const previousSeason = Array.isArray(full.season_simulations) ? full.season_simulations.find(s=>Number(s.season)===seasonNumber-1) : null;
  let latest = full;
  const season = await scriptWriter.simulateSeasonStory({ storyline:{...storyline, episodes_per_season:coords.eps, seasons_per_series:coords.seasons}, characters, seasonNumber, episodesPerSeason:coords.eps, masterSimulation:full, existingSeasonSimulation:existingSeason, previousSeasonSimulation:previousSeason, onCheckpoint:async ({simulation})=>{
    const seasonSimulations = Array.isArray(latest.season_simulations)?latest.season_simulations.filter(s=>Number(s.season)!==seasonNumber):[];
    seasonSimulations.push(simulation);
    latest = {...latest, season_simulations:seasonSimulations.sort((a,b)=>Number(a.season)-Number(b.season)), simulation_status:'season_in_progress', active_season_simulation:seasonNumber};
    await db.execute(`UPDATE storylines SET full_story_simulation=?,updated_at=NOW() WHERE id=?`, [JSON.stringify(latest), storyline.id]);
  }});
  const sims = Array.isArray(latest.season_simulations)?latest.season_simulations.filter(s=>Number(s.season)!==seasonNumber):[];
  sims.push(season);
  latest = {...latest, season_simulations:sims.sort((a,b)=>Number(a.season)-Number(b.season)), simulation_status:'season_ready', active_season_simulation:seasonNumber};
  await db.execute(`UPDATE storylines SET full_story_simulation=?,updated_at=NOW() WHERE id=?`,[JSON.stringify(latest),storyline.id]);
  return { ok:true, season };
}

async function ensureDraft({ storyline_id, season_number, episode_number } = {}) {
  const existing = await db.queryOne(`SELECT * FROM episodes WHERE storyline_id=? AND season_number=? AND episode_number=? ORDER BY created_at DESC LIMIT 1`, [storyline_id, Number(season_number), Number(episode_number)]);
  if (existing) return existing;
  const id = randomUUID();
  await db.execute(`INSERT INTO episodes (id,storyline_id,episode_number,season_number,status,scene_count,shot_count,safety_check_passed,script,scene_state,shot_state,global_continuity_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`, [id,storyline_id,Number(episode_number),Number(season_number),'draft',0,0,1,JSON.stringify({}),JSON.stringify({}),JSON.stringify({}),JSON.stringify({})]);
  return db.queryOne(`SELECT * FROM episodes WHERE id=?`, [id]);
}

async function simulateEpisodeScenes({ episode_id } = {}) {
  const episode = await db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episode_id]);
  if (!episode) throw new Error('Episode not found');
  const storyline = await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [episode.storyline_id]);
  const chars = await db.query(`SELECT * FROM characters WHERE storyline_id=? ORDER BY created_at`, [episode.storyline_id]);
  const script = json(episode.script, {});
  const full = json(storyline.full_story_simulation, {});
  const season = (full.season_simulations || []).find(s=>Number(s.season)===Number(episode.season_number));
  const trajectory = (season?.episode_trajectory || []).find(e=>Number(e.episode)===Number(episode.episode_number));
  const existing = script.narrative_simulation || null;
  const expected = Math.max(1, Number(trajectory?.scene_count || trajectory?.sceneCount || trajectory?.scenes?.length || config.scenesPerEpisode || 10));
  if (existing?.simulation_status==='complete' && Array.isArray(existing.scene_beat_plan) && existing.scene_beat_plan.length >= expected) return {ok:true,skipped:true,simulation:existing};
  let current = existing;
  const save = async ({stage,sceneNumber,simulation})=>{
    current=simulation;
    const payload={...script,episode_trajectory:trajectory,narrative_simulation:simulation,checkpoint_state:{...(script.checkpoint_state||{}),stage,last_scene_number:sceneNumber,updated_at:new Date().toISOString()}};
    await db.execute(`UPDATE episodes SET script=?,scene_count=?,shot_count=?,updated_at=NOW() WHERE id=?`,[JSON.stringify(payload),Array.isArray(simulation?.scene_beat_plan)?simulation.scene_beat_plan.length:0,0,episode.id]);
  };
  current = await scriptWriter.simulateEpisodeStory({ storyline, characters:chars, recentEpisodes:await db.query(`SELECT * FROM episodes WHERE storyline_id=? AND status IN ('ready','published') ORDER BY episode_number DESC LIMIT 5`,[storyline.id]), episodeNumber:Number(episode.episode_number), seasonNumber:Number(episode.season_number), isFinale:Number(episode.episode_number)===num(config.episodesPerSeason,1), isSeriesMovie:false, targetMinutes:num(config.targetEpisodeMinSeconds,120)/60, episodeTrajectory:trajectory, existingSimulation:existing, checkpoint:save });
  const scenePlan = Array.isArray(current?.scene_beat_plan) ? current.scene_beat_plan : [];
  const complete = current?.simulation_status === 'complete' && scenePlan.length >= expected;
  if (!complete) {
    return {ok:false,pending:true,reason:'Episode scene simulation is not complete',simulation:current,expected_scene_count:expected,actual_scene_count:scenePlan.length};
  }
  return {ok:true,simulation:current};
}

async function writeEpisodeBlueprintAndShotSimulation({ episode_id } = {}) {
  const episode = await db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episode_id]);
  if (!episode) throw new Error('Episode not found');
  const storyline = await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [episode.storyline_id]);
  const chars = await db.query(`SELECT * FROM characters WHERE storyline_id=? ORDER BY created_at`, [episode.storyline_id]);
  const draftScript = json(episode.script, {});
  const narrative = draftScript.narrative_simulation;
  const expectedScenes = Math.max(1, Number((await db.queryOne(`SELECT scene_count FROM episodes WHERE id=?`,[episode.id]))?.scene_count || config.scenesPerEpisode || 10));
  if (!narrative || narrative.simulation_status !== 'complete' || !Array.isArray(narrative.scene_beat_plan) || narrative.scene_beat_plan.length < expectedScenes) {
    throw new Error(`Episode scene simulation is not complete: ${Array.isArray(narrative?.scene_beat_plan) ? narrative.scene_beat_plan.length : 0}/${expectedScenes}`);
  }
  const full = json(storyline.full_story_simulation, {});
  const targetMinutes = Math.max(1,num(config.targetEpisodeMinSeconds,120)/60);
  const finalScript = await scriptWriter.writeEpisodeScript({
    storyline,
    characters:chars,
    recentEpisodes:await db.query(`SELECT * FROM episodes WHERE storyline_id=? AND id<>? ORDER BY episode_number DESC LIMIT 5`,[storyline.id,episode.id]),
    episodeNumber:Number(episode.episode_number),
    seasonNumber:Number(episode.season_number),
    isFinale:Number(episode.episode_number)===num(config.episodesPerSeason,1),
    isSeriesMovie:false,
    targetMinutes,
    narrativeSimulation:narrative,
    existingScript:draftScript,
    checkpoint:async ({stage,sceneNumber,script})=>{
      const merged={...script,checkpoint_state:{...(script.checkpoint_state||{}),stage,last_scene_number:sceneNumber,updated_at:new Date().toISOString()}};
      await db.execute(`UPDATE episodes SET script=?,scene_count=?,shot_count=?,updated_at=NOW() WHERE id=?`,[JSON.stringify(merged),Array.isArray(merged.scenes)?merged.scenes.length:0,Array.isArray(merged.shot_simulation?.shots)?merged.shot_simulation.shots.length:0,episode.id]);
    }
  });
  const payload={...finalScript,checkpoint_state:{...(finalScript.checkpoint_state||{}),stage:'shot_writing',updated_at:new Date().toISOString()}};
  await db.execute(`UPDATE episodes SET script=?,scene_count=?,shot_count=?,updated_at=NOW() WHERE id=?`,[JSON.stringify(payload),Array.isArray(payload.scenes)?payload.scenes.length:0,Array.isArray(payload.shot_simulation?.shots)?payload.shot_simulation.shots.length:0,episode.id]);
  return {ok:true,script:payload,scene_count:payload.scenes?.length||0,shot_count:payload.shot_simulation?.shots?.length||0};
}

function flattenShots(script) {
  return (script.scenes||[]).flatMap(scene=>(scene.shots||[]).map(shot=>({...shot,scene_number:Number(scene.scene_number),shot_index:Number(shot.shot_index)})));
}

async function prepareShotRows({ episode_id } = {}) {
  const episode = await db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episode_id]);
  if (!episode) throw new Error('Episode not found');
  const script = json(episode.script, {});
  const shots = flattenShots(script);
  for (const shot of shots) {
    await db.execute(`INSERT INTO shots (id,episode_id,scene_number,shot_index,status) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE updated_at=NOW()`,[randomUUID(),episode_id,Number(shot.scene_number),Number(shot.shot_index),'pending']);
  }
  await db.execute(`UPDATE episodes SET shot_count=? WHERE id=?`,[shots.length,episode_id]);
  return {ok:true,shots:shots.length};
}

async function generateMedia({ episode_id, scene_number = null, shot_index = null } = {}) {
  const pipeline = require('./pipeline');
  const episode = await db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episode_id]);
  if (!episode) throw new Error('Episode not found');
  if (typeof pipeline.generateEpisodeMediaAgent === 'function') {
    const result = await pipeline.generateEpisodeMediaAgent(episode_id,{sceneNumber:scene_number,shotIndex:shot_index});
    const activeJobs = await recovery.queryActiveJobs(episode_id).catch(()=>[]);
    if (Array.isArray(activeJobs) && activeJobs.length) return {ok:false,pending:true,reason:'Media generation is still in progress; do not advance the production state yet',active_jobs:activeJobs,result};
    return result;
  }
  if (scene_number != null && shot_index != null) return pipeline.regenerateShot(Number(scene_number),Number(shot_index),{episodeId:episode_id});
  return pipeline.regenerateScene(Number(scene_number || 1));
}

async function compileEpisode({ episode_id } = {}) {
  const pipeline = require('./pipeline');
  if (typeof pipeline.recompileEpisode !== 'function') throw new Error('Episode compiler unavailable');
  return pipeline.recompileEpisode(episode_id);
}

async function validateEpisode({ episode_id } = {}) {
  const episode = await db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episode_id]);
  if (!episode) throw new Error('Episode not found');
  const integrity = await recovery.diagnoseEpisodeIntegrity(episode_id);
  const media = await recovery.queryMediaAssets(episode_id);
  const missing = media.filter(r=>!r.clip_url).map(r=>({scene_number:r.scene_number,shot_index:r.shot_index}));
  return {ok:integrity.ok && missing.length===0,integrity,media:{count:media.length,missing}};
}

async function publishEpisode({ episode_id } = {}) {
  const pipeline = require('./pipeline');
  const valid = await validateEpisode({episode_id});
  if (!valid.ok) throw new Error('Publish blocked: episode validation failed');
  return pipeline.publishEpisode(episode_id);
}

async function recordAgentCheckpoint({ episode_id, state_name, metadata = {} }={}) {
  await db.execute(`UPDATE episodes SET paused_reason=?,updated_at=NOW() WHERE id=?`, [state_name ? `agent:${state_name}` : null, episode_id]);
  await memory.rememberEvent({episodeId:episode_id,eventType:'agent_checkpoint',payload:{state:state_name,metadata}}).catch(()=>{});
  return {ok:true,state:state_name};
}

module.exports = { inspectProductionState, initializeSeries, simulateSeason, ensureDraft, simulateEpisodeScenes, writeEpisodeBlueprintAndShotSimulation, prepareShotRows, generateMedia, compileEpisode, validateEpisode, publishEpisode, recordAgentCheckpoint };
