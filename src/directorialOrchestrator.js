'use strict';

/**
 * StreamVerse Studios — Directorial Orchestrator
 *
 * The single deterministic bridge between authored story state and downstream
 * production modules.
 */

const directorState = require('./directorState');
const blockingDirector = require('./blockingDirector');
const dialogueDirector = require('./dialogueDirector');
const travel = require('./travelChoreography');
const editorial = require('./editorialDirector');
const audio = require('./audioContinuity');

function clean(value) {
  return directorState.clean(value);
}

function sceneFor(scenes, sceneNumber) {
  return (scenes || []).find(s => Number(s.scene_number) === Number(sceneNumber)) || {};
}

function applyToShotSimulation(shotSimulation, scenes = [], episode = {}) {
  if (!shotSimulation || !Array.isArray(shotSimulation.shots)) return shotSimulation;

  const grouped = new Map();
  for (const shot of shotSimulation.shots) {
    const n = Number(shot.scene_number);
    if (!grouped.has(n)) grouped.set(n, []);
    grouped.get(n).push(shot);
  }

  const final = [];
  let priorShot = null;

  for (const scene of scenes) {
    const n = Number(scene.scene_number);
    let shots = (grouped.get(n) || []).slice().sort((a,b) => Number(a.shot_index) - Number(b.shot_index));
    if (!shots.length) continue;

    const raw = scene.location_transition && String(scene.location_transition).toLowerCase() !== 'none'
      ? scene.location_transition
      : '';
    const previousLocation = clean(priorShot?._director_state?.world?.location);
    const destination = clean(
      scene.destination_location ||
      shots[shots.length - 1].destination_location ||
      scene.location
    );
    const origin = clean(
      scene.origin_location ||
      shots[0].origin_location ||
      previousLocation ||
      scene.location
    );
    const mode = clean(scene.travel_mode || shots.find(s => s.travel_mode)?.travel_mode || 'none');

    const isTravel = (origin && destination && origin.toLowerCase() !== destination.toLowerCase())
      && (Boolean(raw) || mode !== 'none' || Boolean(scene.location_transition));

    if (isTravel) {
      shots = travel.enrichTravelSequence(shots, {
        originLocation: origin,
        destinationLocation: destination,
        travelMode: mode,
      });
    }

    const normalized = directorState.normalizeSequence(shots, {
      scene,
      episode,
      previousState: priorShot?._director_state || null,
    }).map((shot) => {
      const solved = blockingDirector.solveBlocking(shot, priorShot);
      const rebuilt = directorState.attachDirectorState(solved, {
        scene,
        episode,
        previousState: priorShot?._director_state || null,
      });
      rebuilt._conversation_plan = dialogueDirector.buildConversationPlan(rebuilt);
      return rebuilt;
    });

    for (let i = 0; i < normalized.length; i++) {
      const shot = normalized[i];
      if (i > 0) {
        const repaired = travel.repairTravelTeleport(normalized[i - 1], shot);
        normalized[i] = directorState.attachDirectorState(repaired, {
          scene,
          episode,
          previousState: normalized[i - 1]._director_state || null,
        });
      }
      final.push(normalized[i]);
      priorShot = normalized[i];
    }
  }

  return {
    ...shotSimulation,
    shots: final,
    directorial_state_version: 2,
  };
}

function applyToScript(script, { seasonNumber = null, episodeNumber = null } = {}) {
  if (!script || !Array.isArray(script.scenes)) return script;

  let previousShot = null;
  let previousLocation = '';

  for (const scene of script.scenes) {
    let shots = Array.isArray(scene.shots) ? scene.shots.slice() : [];
    const destination = clean(scene.location);
    const origin = previousLocation || destination;

    const sceneSaysTravel = String(scene.location_transition || '').toLowerCase() !== 'none';
    const mode = clean(scene.travel_mode || shots.find(s => s.travel_mode)?.travel_mode || 'none');
    const actualTravel = origin && destination && origin.toLowerCase() !== destination.toLowerCase();

    if (actualTravel || sceneSaysTravel) {
      shots = travel.enrichTravelSequence(shots, {
        originLocation: origin,
        destinationLocation: destination,
        travelMode: mode,
      });
    }

    const normalized = directorState.normalizeSequence(shots, {
      scene,
      episode: {
        season: Number(seasonNumber || script.season_number || 0),
        episode: Number(episodeNumber || script.episode_number || 0),
      },
      previousState: previousShot?._director_state || null,
    });

    const solved = [];
    for (const raw of normalized) {
      let shot = blockingDirector.solveBlocking(raw, solved[solved.length - 1] || previousShot);
      shot = travel.repairTravelTeleport(previousShot || solved[solved.length - 1], shot);
      shot = directorState.attachDirectorState(shot, {
        scene,
        episode: {
          season: Number(seasonNumber || script.season_number || 0),
          episode: Number(episodeNumber || script.episode_number || 0),
        },
        previousState: previousShot?._director_state || solved[solved.length - 1]?._director_state || null,
      });
      shot._conversation_plan = dialogueDirector.buildConversationPlan(shot);
      solved.push(shot);
      previousShot = shot;
    }

    scene.shots = solved;
    previousLocation = destination || previousLocation;
  }

  dialogueDirector.applyConversationDirector(script);
  editorial.applyEditorialContinuity(script);
  audio.applyAudioContinuity(script);
  script.directorial_state_version = 2;
  script.directorial_architecture = {
    source: 'canonical_movie_state',
    layers: ['world', 'blocking', 'performance', 'camera', 'travel', 'editorial', 'audio'],
    no_teleportation: true,
    provider_prompts_render_from_state: true,
  };

  return script;
}

module.exports = {
  applyToShotSimulation,
  applyToScript,
};
