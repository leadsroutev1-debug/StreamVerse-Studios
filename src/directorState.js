'use strict';

/**
 * StreamVerse Studios — Canonical Movie / Director State
 *
 * Deterministic state layer shared by continuity, blocking, camera, motion,
 * dialogue, image validation and editorial stages.
 *
 * Design rule:
 *   authored narrative -> directorial state -> provider-specific rendering
 *
 * This module never calls an LLM. It normalizes what the existing planner
 * already authored and makes that state explicit enough for downstream
 * systems to validate instead of re-interpreting.
 */

const TRAVEL_STAGES = Object.freeze([
  'none',
  'prepare',
  'depart',
  'in_transit',
  'approach',
  'arrive',
]);

const TRAVEL_MODES = Object.freeze([
  'walk', 'drive', 'ride', 'train', 'bus', 'bike', 'boat',
  'aircraft', 'stairs', 'elevator', 'none',
]);

const DIRECTORIAL_ACTIONS = Object.freeze([
  'observe',
  'pursue',
  'reveal',
  'conceal',
  'trap',
  'distance',
  'join',
  'witness',
  'follow',
  'discover',
  'confront',
  'transition',
  'arrive',
]);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return '';
}

function normalizeList(value, limit = 12) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(clean).filter(Boolean))].slice(0, limit);
}

function normalizeTravelStage(value) {
  const stage = clean(value).toLowerCase().replace(/\s+/g, '_');
  return TRAVEL_STAGES.includes(stage) ? stage : 'none';
}

function normalizeTravelMode(value) {
  const mode = clean(value).toLowerCase().replace(/\s+/g, '_');
  return TRAVEL_MODES.includes(mode) ? mode : 'none';
}

function inferTravelStage(shot = {}, index = 0, total = 1) {
  const explicit = normalizeTravelStage(shot.travel_stage);
  if (explicit !== 'none') return explicit;

  const transition = clean(shot.location_transition).toLowerCase();
  const hasDistinctLocations = Boolean(
    clean(shot.origin_location) &&
    clean(shot.destination_location) &&
    clean(shot.origin_location).toLowerCase() !== clean(shot.destination_location).toLowerCase()
  );
  const hasTravelMode = normalizeTravelMode(shot.travel_mode) !== 'none';
  const hasTravel = hasDistinctLocations || hasTravelMode ||
    ['travel', 'departure', 'transit', 'arrival'].includes(transition);

  if (!hasTravel) return 'none';
  if (index <= 0) return total <= 2 ? 'depart' : 'prepare';
  if (index >= total - 1) return 'arrive';
  if (index >= Math.max(1, total - 2)) return 'approach';
  return 'in_transit';
}

function inferDirectorialAction(shot = {}) {
  const raw = clean(
    shot.directorial_action ||
    shot.camera_motivation ||
    shot.shot_purpose ||
    shot.purpose ||
    shot.action_arc
  ).toLowerCase();

  if (/\b(arrive|arrival|destination)\b/.test(raw)) return 'arrive';
  if (/\b(confront|confrontation|challenge)\b/.test(raw)) return 'confront';
  if (/\b(reveal|discover|discovery)\b/.test(raw)) return 'reveal';
  if (/\b(hide|conceal|withhold|mystery)\b/.test(raw)) return 'conceal';
  if (/\b(follow|pursue|chase|track)\b/.test(raw)) return 'pursue';
  if (/\b(join|enter|approach)\b/.test(raw)) return 'join';
  if (/\b(distance|isolate|alone)\b/.test(raw)) return 'distance';
  if (/\b(witness|observe|watch)\b/.test(raw)) return 'witness';
  if (/\b(transition|depart|travel|move)\b/.test(raw)) return 'transition';
  if (/\b(trap|confine|corner)\b/.test(raw)) return 'trap';
  return 'observe';
}

function normalizeStaging(shot = {}) {
  const rows = Array.isArray(shot.character_staging) ? shot.character_staging : [];
  return rows.map((row) => ({
    name: clean(row.name),
    screen_position: firstNonEmpty(row.screen_position, 'screen-center'),
    depth: firstNonEmpty(row.depth, 'midground'),
    facing: firstNonEmpty(row.facing, row.facing_toward, 'toward the immediate story focus'),
    facing_toward: firstNonEmpty(row.facing_toward, row.facing, 'the immediate story focus'),
    action: firstNonEmpty(row.action, row.observable_action, 'holds established position'),
    observable_action: firstNonEmpty(row.observable_action, row.action, 'holds established position'),
    pose: firstNonEmpty(row.pose, shot.pose_state, 'natural grounded posture'),
    eyeline: firstNonEmpty(row.eyeline, row.gaze, 'the immediate story focus'),
    gaze: firstNonEmpty(row.gaze, row.eyeline, 'the immediate story focus'),
    interaction: firstNonEmpty(row.interaction, 'none beyond the established scene relationship'),
    speaking: Boolean(row.speaking),
    visual_identity: firstNonEmpty(row.visual_identity, 'preserve locked cast identity'),
  })).filter(row => row.name);
}

function buildWorldState({ previous = null, scene = null, shot = null } = {}) {
  const prev = previous || {};
  const sourceScene = scene || {};
  const sourceShot = shot || {};

  const stage = inferTravelStage(
    sourceShot,
    Math.max(0, Number(sourceShot.shot_index || 1) - 1),
    Math.max(1, Number(sourceShot.scene_shot_count || 1))
  );

  const origin = firstNonEmpty(
    sourceShot.origin_location,
    prev.location,
    sourceScene.location
  );
  const destination = firstNonEmpty(
    sourceShot.destination_location,
    sourceScene.location,
    sourceShot.location,
    prev.location
  );

  const location = firstNonEmpty(
    sourceShot.current_location,
    ['prepare', 'depart', 'in_transit', 'approach'].includes(stage) ? origin : '',
    sourceShot.location,
    destination,
    prev.location
  );

  return {
    time: firstNonEmpty(sourceShot.time, sourceScene.time_of_day, prev.time, 'continuous'),
    time_of_day: firstNonEmpty(sourceShot.time_of_day, sourceScene.time_of_day, prev.time_of_day),
    location,
    origin_location: origin,
    destination_location: destination,
    travel_stage: stage,
    travel_mode: normalizeTravelMode(sourceShot.travel_mode || prev.travel_mode),
    weather: firstNonEmpty(sourceShot.weather, sourceScene.weather, prev.weather),
    lighting: firstNonEmpty(sourceShot.lighting, sourceScene.lighting_design, prev.lighting),
    environment: firstNonEmpty(
      sourceShot.scene_environment,
      sourceShot.environmental_story_beat,
      sourceScene.scene_environment,
      prev.environment
    ),
    active_props: normalizeList(
      sourceShot.active_props || sourceShot.props || sourceShot.active_prop || prev.active_props
    ),
    audio: {
      environment: firstNonEmpty(sourceShot.environment_sound, sourceScene.environment_sound, prev.audio?.environment),
      music: firstNonEmpty(sourceShot.music_cue, sourceScene.music_cue, prev.audio?.music),
      bridge: firstNonEmpty(sourceShot.sound_bridge, prev.audio?.bridge),
    },
  };
}

function buildCharacterState(name, shot = {}, prior = {}) {
  const staging = normalizeStaging(shot).find(row => row.name === name);
  const location = firstNonEmpty(
    shot.character_locations?.[name],
    staging?.location,
    shot.current_location,
    shot.location,
    prior.location
  );

  return {
    location,
    screen_position: firstNonEmpty(staging?.screen_position, prior.screen_position),
    depth: firstNonEmpty(staging?.depth, prior.depth),
    pose: firstNonEmpty(staging?.pose, shot.pose_state, prior.pose),
    action: firstNonEmpty(staging?.action, shot.subject_motion, shot.action_arc, prior.action),
    gaze: firstNonEmpty(staging?.gaze, staging?.eyeline, shot.character_positions, prior.gaze),
    emotional_state: firstNonEmpty(shot.emotional_subtext, shot.emotional_state, prior.emotional_state),
    physical_state: firstNonEmpty(shot.physical_state, shot.pose_state, prior.physical_state),
    wardrobe: firstNonEmpty(shot.wardrobe_state, prior.wardrobe),
    injuries: firstNonEmpty(shot.injury_state, prior.injuries),
    carried_props: normalizeList(shot.carried_props?.[name] || prior.carried_props),
    knowledge_delta: normalizeList(shot.character_knowledge_changes?.[name] || prior.knowledge_delta),
    objective: firstNonEmpty(shot.character_objectives?.[name], prior.objective),
  };
}

function createDirectorState({ episode = {}, scene = {}, shot = {}, previousState = null } = {}) {
  const previous = previousState || {};
  const world = buildWorldState({ previous: previous.world, scene, shot });
  const staging = normalizeStaging(shot);

  const visibleCharacters = normalizeList(
    shot.characters_in_shot || staging.map(row => row.name)
  );

  const previousCharacters = previous.characters || {};
  const characters = {};

  for (const name of visibleCharacters) {
    characters[name] = buildCharacterState(name, shot, previousCharacters[name] || {});
  }

  const travelStage = normalizeTravelStage(
    shot.travel_stage || inferTravelStage(shot, Number(shot.shot_index || 1) - 1, Number(shot.scene_shot_count || 1))
  );

  const startState = firstNonEmpty(
    shot.start_frame_state,
    shot.start_state,
    previous.terminal?.handoff_to_next,
    previous.terminal?.end_state
  );

  const endState = firstNonEmpty(
    shot.end_frame_state,
    shot.end_state,
    shot.end_frame_transition
  );

  const directorialAction = inferDirectorialAction(shot);
  const cameraMotivation = firstNonEmpty(
    shot.camera_motivation,
    shot.directorial_reason,
    `${directorialAction} the story beat`
  );

  return {
    version: 2,
    episode: {
      season: Number(episode.season || episode.season_number || 0),
      episode: Number(episode.episode || episode.episode_number || 0),
    },
    scene: {
      scene_number: Number(scene.scene_number ?? shot.scene_number ?? 0),
      purpose: firstNonEmpty(scene.scene_description, scene.purpose, shot.purpose),
      emotional_beat: firstNonEmpty(scene.emotional_beat, shot.emotional_subtext),
    },
    world,
    characters,
    spatial: {
      blocking: staging,
      screen_geography_rule: 'preserve established left/right/depth relationships unless physical action changes them',
      route: firstNonEmpty(shot.route_beat, shot.action_arc),
    },
    performance: {
      dialogue_mode: firstNonEmpty(shot.tts_mode, shot.dialogue_intent, 'ambient'),
      speakers: normalizeList(shot.speakers_in_shot || (shot.speaker ? [shot.speaker] : [])),
      dialogue_purpose: firstNonEmpty(shot.dialogue_purpose, shot.dialogue_intent),
      subtext: firstNonEmpty(shot.subtext, shot.emotional_subtext),
      reaction_points: normalizeList(shot.reaction_points),
    },
    camera: {
      directorial_action: directorialAction,
      motivation: cameraMotivation,
      framing: firstNonEmpty(shot.shot_type, 'MS'),
      movement: firstNonEmpty(shot.camera_movement, 'static'),
      focus_subject: firstNonEmpty(shot.focus_subject, shot.speaker, visibleCharacters[0]),
    },
    transition: {
      type: firstNonEmpty(shot.transition_type, 'cut'),
      editorial_reason: firstNonEmpty(
        shot.editorial_transition_reason,
        shot.end_frame_transition,
        'continue the established causal state'
      ),
      from_state: firstNonEmpty(previous.terminal?.handoff_to_next, previous.terminal?.end_state),
      to_state: endState,

      /*
       * VISUAL CONTINUITY CONTRACT
       *
       * The previous shot's terminal image and the current shot's authored
       * still are two distinct visual anchors. Downstream visual direction
       * must compare them as a transition pair rather than treating the
       * current still as an isolated frame.
       */
      visual_handoff: {
        mode: previous?.terminal
          ? 'semantic_previous_end_frame_to_fresh_current_still'
          : 'current_still_only',
        previous_end_frame_required: Boolean(previous?.terminal),
        current_still_required: true,
        relationship: previous?.terminal
          ? 'previous_shot_terminal_visual_to_current_shot_opening_visual'
          : 'current_shot_opening_visual',
        preserve: [
          'character_identity',
          'wardrobe',
          'props',
          'environment',
          'lighting',
          'screen_geography',
          'eyelines',
          'contact_points',
          'emotional_state',
        ],
      },
    },
    terminal: {
      end_state: endState,
      handoff_to_next: firstNonEmpty(shot.handoff_to_next, shot.next_shot_continuity, endState),
    },
    directorial_action: directorialAction,
    travel: {
      stage: travelStage,
      mode: normalizeTravelMode(shot.travel_mode),
      origin: firstNonEmpty(shot.origin_location, world.origin_location),
      destination: firstNonEmpty(shot.destination_location, world.destination_location),
      route_beat: firstNonEmpty(shot.route_beat, shot.action_arc),
      must_change_position: ['depart', 'in_transit', 'approach', 'arrive'].includes(travelStage),
    },
    invariants: [
      'no-teleportation',
      'previous-terminal-state-drives-next-opening-state',
      'fresh-still-is-constructed-from-the-target-opening-state',
      'preserve-screen-geography',
      'preserve-wardrobe-and-props-unless-explicitly-changed',
      'still-image-is-opening-frame-only',
      'agnes-sequential-shots-use-previous-end-frame-and-fresh-current-still-as-ordered-keyframes',
      'vision-director-compares-previous-end-frame-to-current-still',
    ],
  };
}

function attachDirectorState(shot, { scene = {}, episode = {}, previousState = null } = {}) {
  const out = { ...shot };
  const state = createDirectorState({ episode, scene, shot: out, previousState });

  out._director_state = state;
  out._world_state = state.world;
  out._blocking_state = state.spatial;
  out._performance_state = state.performance;
  out._transition_state = state.transition;
  out.directorial_action = state.directorial_action;
  out.camera_motivation = state.camera.motivation;
  out.travel_stage = state.travel.stage;
  out.travel_mode = state.travel.mode;

  if (!out.start_state) out.start_state = state.terminal.from_state || state.world.location;
  if (!out.start_frame_state) out.start_frame_state = out.start_state;
  if (!out.end_state) out.end_state = state.terminal.end_state || out.start_state;
  if (!out.end_frame_state) out.end_frame_state = out.end_state;
  if (!out.handoff_to_next) out.handoff_to_next = state.terminal.handoff_to_next;
  if (!out.next_shot_continuity) out.next_shot_continuity = state.terminal.handoff_to_next;

  return out;
}

function normalizeSequence(shots, { scene = {}, episode = {}, previousState = null } = {}) {
  const ordered = Array.isArray(shots)
    ? shots.slice().sort((a, b) => Number(a.shot_index || 0) - Number(b.shot_index || 0))
    : [];

  const result = [];
  let prior = previousState || null;

  ordered.forEach((shot, idx) => {
    const copy = {
      ...shot,
      scene_number: Number(shot.scene_number ?? scene.scene_number ?? 0),
      shot_index: Number(shot.shot_index ?? idx + 1),
      scene_shot_count: ordered.length,
    };

    if (prior?.terminal) {
      if (!clean(copy.start_state)) copy.start_state = prior.terminal.handoff_to_next || prior.terminal.end_state;
      if (!clean(copy.start_frame_state)) copy.start_frame_state = copy.start_state;
      copy.handoff_source = firstNonEmpty(
        copy.handoff_source,
        `inherits terminal state from S${prior.episode?.scene_number || prior.scene?.scene_number || copy.scene_number}/${prior.shot_index || copy.shot_index - 1}`
      );
    }

    const directorState = attachDirectorState(copy, { scene, episode, previousState: prior });
    result.push(directorState);
    prior = directorState._director_state;
  });

  return result;
}

function validateTransition(prevShot, nextShot) {
  const violations = [];
  if (!nextShot) return violations;

  if (prevShot) {
    const required = firstNonEmpty(prevShot.handoff_to_next, prevShot.end_state, prevShot.end_frame_state);
    const actual = firstNonEmpty(nextShot.start_state, nextShot.start_frame_state);
    if (required && actual && !actual.toLowerCase().includes(required.toLowerCase().slice(0, Math.min(40, required.length)))) {
      // Long LLM states are semantically similar but not string-identical. Escalate only
      // when the next shot is a clearly different location/pose without inheritance cues.
      const prevLoc = clean(prevShot._director_state?.world?.location).toLowerCase();
      const nextLoc = clean(nextShot._director_state?.world?.location).toLowerCase();
      const changedLocation = prevLoc && nextLoc && prevLoc !== nextLoc;
      const hasTravel = ['depart', 'in_transit', 'approach', 'arrive'].includes(clean(nextShot.travel_stage).toLowerCase());
      if (changedLocation && !hasTravel) {
        violations.push({
          type: 'teleport',
          severity: 'high',
          message: `Location changes from "${prevLoc}" to "${nextLoc}" without a travel/arrival stage.`,
          correction: `The next shot must inherit the previous terminal state or explicitly show physical travel from ${prevLoc} to ${nextLoc}.`,
        });
      }
    }
  }

  const stage = normalizeTravelStage(nextShot.travel_stage);
  if (stage === 'arrive') {
    const origin = clean(nextShot.origin_location);
    const destination = clean(nextShot.destination_location);
    if (origin && destination && origin === destination) {
      violations.push({
        type: 'travel',
        severity: 'medium',
        message: 'Arrival shot has identical origin and destination locations.',
        correction: 'Set a distinct origin/destination or remove the travel stage.',
      });
    }
  }

  return violations;
}

module.exports = {
  TRAVEL_STAGES,
  TRAVEL_MODES,
  DIRECTORIAL_ACTIONS,
  clean,
  normalizeTravelStage,
  normalizeTravelMode,
  inferTravelStage,
  inferDirectorialAction,
  createDirectorState,
  attachDirectorState,
  normalizeSequence,
  validateTransition,
};
