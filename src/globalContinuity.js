'use strict';

/**
 * Global Continuity Engine
 *
 * Maintains a lightweight episode-wide continuity ledger in addition to the
 * per-scene Scene State engine. It is intentionally deterministic: no extra
 * LLM call is required. The ledger is derived from the director's existing
 * scene/shot semantics and is injected into downstream prompts as descriptive
 * story-world context, never as model instructions.
 */

function _clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildGlobalContinuityState(script) {
  const scenes = script?.scenes || [];
  const state = {
    location: null,
    timeOfDay: null,
    lighting: null,
    weather: null,
    activeProps: [],
    characterStates: {},
    unresolvedThreads: [],
    lastEndState: '',
    lastSceneNumber: null,
  };

  for (const scene of scenes) {
    const location = _clean(scene.location);
    const lighting = _clean(scene.lighting_design);
    const description = _clean(scene.scene_description);
    const beat = _clean(scene.emotional_beat);

    if (location) state.location = location;
    if (lighting) state.lighting = lighting;

    const sceneShots = scene.shots || [];
    for (const shot of sceneShots) {
      for (const c of shot.characters_in_shot || []) {
        const name = _clean(c);
        if (!name) continue;
        state.characterStates[name] = {
          emotionalState: _clean(shot.emotional_subtext),
          physicalState: _clean(shot.pose_state),
          eyeline: _clean(shot.character_positions),
          lastBeat: _clean(shot.temporal_arc),
        };
      }

      const env = _clean(shot.scene_environment || shot.environmental_story_beat);
      if (env) state.environment = env;

      const props = _clean(shot.scene_environment);
      if (props) state.activeProps = [props].slice(0, 3);

      const end = _clean(shot.end_frame_transition);
      if (end) state.lastEndState = end;
    }

    const finalShot = sceneShots[sceneShots.length - 1];
    if (finalShot) {
      const inherit = _clean(finalShot.next_shot_continuity);
      if (inherit) state.lastEndState = inherit;
    }

    if (scene.location) state.lastSceneNumber = scene.scene_number;
    if (beat && sceneShots.length === 0) state.unresolvedThreads.push(beat);
    if (description && sceneShots.length === 0) state.unresolvedThreads.push(description);
  }

  state.unresolvedThreads = state.unresolvedThreads.slice(-5);
  return state;
}

function _stateSentence(state) {
  const parts = [];
  if (state.location) parts.push(`The story remains in ${state.location}.`);
  if (state.lighting) parts.push(`The lighting remains ${state.lighting}.`);
  if (state.weather) parts.push(`Weather remains ${state.weather}.`);
  if (state.environment) parts.push(`The surrounding environment retains ${state.environment}.`);
  if (state.lastEndState) parts.push(`${state.lastEndState}.`);

  const chars = Object.entries(state.characterStates || {}).slice(-6);
  if (chars.length) {
    parts.push(chars.map(([name, v]) => {
      const bits = [v.emotionalState, v.physicalState, v.eyeline].filter(Boolean);
      return bits.length ? `${name} remains in a state of ${bits.join(', ')}.` : `${name} remains present and visually continuous.`;
    }).join(' '));
  }

  return parts.join(' ').trim();
}

function applyGlobalContinuity(script) {
  if (!script || !Array.isArray(script.scenes)) return script;

  const state = {
    location: null,
    timeOfDay: null,
    lighting: null,
    weather: null,
    environment: null,
    activeProps: [],
    characterStates: {},
    unresolvedThreads: [],
    lastEndState: '',
    lastSceneNumber: null,
    activeScene: null,
  };

  for (const scene of script.scenes) {
    const priorState = JSON.parse(JSON.stringify(state));
    const inherited = _stateSentence(priorState);

    scene._global_continuity_state = priorState;

    for (const shot of (scene.shots || [])) {
      shot._global_continuity_directive = inherited
        ? `${inherited} The moment continues naturally from this established state.`
        : 'The current moment establishes the episode continuity from its opening state.';
    }

    if (scene.location) state.location = _clean(scene.location);
    if (scene.time_of_day) state.timeOfDay = _clean(scene.time_of_day);
    if (scene.lighting_design) state.lighting = _clean(scene.lighting_design);
    if (scene.weather) state.weather = _clean(scene.weather);
    if (scene.scene_number != null) state.lastSceneNumber = scene.scene_number;

    for (const thread of (scene.unresolved_threads || scene.unresolvedThreads || [])) {
      const cleanThread = _clean(thread);
      if (cleanThread) state.unresolvedThreads.push(cleanThread);
    }

    for (const shot of (scene.shots || [])) {
      const env = _clean(shot.scene_environment || shot.environmental_story_beat);
      if (env) state.environment = env;
      const prop = _clean(shot.active_prop || shot.prop_continuity || shot.scene_prop);
      if (prop && !state.activeProps.includes(prop)) state.activeProps.push(prop);

      for (const c of shot.characters_in_shot || []) {
        const name = _clean(c);
        if (!name) continue;
        state.characterStates[name] = {
          emotionalState: _clean(shot.emotional_subtext),
          physicalState: _clean(shot.pose_state),
          eyeline: _clean(shot.character_positions),
        };
      }

      const end = _clean(shot.end_frame_transition || shot.next_shot_continuity);
      if (end) state.lastEndState = end;
    }

    state.activeScene = scene.scene_number;
    scene._global_continuity_after = JSON.parse(JSON.stringify(state));
  }

  const derived = buildGlobalContinuityState(script);
  script.global_continuity_state = {
    ...derived,
    ...state,
    activeProps: [...new Set([...(derived.activeProps || []), ...(state.activeProps || [])])].slice(-6),
    unresolvedThreads: [...new Set([...(derived.unresolvedThreads || []), ...(state.unresolvedThreads || [])])].slice(-5),
    characterStates: { ...(derived.characterStates || {}), ...(state.characterStates || {}) },
    lastSceneNumber: state.lastSceneNumber ?? derived.lastSceneNumber ?? null,
  };
  return script;
}

module.exports = { applyGlobalContinuity, buildGlobalContinuityState };
