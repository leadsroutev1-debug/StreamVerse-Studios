 'use strict';

/**
 * StreamVerse Studios — Hard Scene World State
 *
 * Deterministic scene-level environment + persistent-prop authority.
 *
 * This module deliberately does not ask an LLM to decide whether a set changed.
 * It resolves the safest contextual default:
 *   - same location / explicitly reusable setting => reuse prior scene environment;
 *   - explicit new location / explicit environment change => create a new environment;
 *   - declared persistent props inherit until explicitly changed/removed.
 *
 * The resulting state is attached to every shot as `_hard_world_state` and
 * `_hard_world_directive`.
 */

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function key(value) {
  return clean(value).toLowerCase();
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const s = clean(v);
    if (s) return s;
  }
  return '';
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const v of values || []) {
    const s = clean(v);
    const k = key(s);
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(v => {
      if (typeof v === 'string') return [v];
      if (v && typeof v === 'object') return [v.name || v.label || v.prop || v.id || ''];
      return [];
    });
  }
  if (typeof value === 'string') {
    return value.split(/[,\n;|]/g);
  }
  if (typeof value === 'object') return Object.values(value);
  return [];
}

function extractProps(scene = {}, shot = {}) {
  return unique([
    ...asList(scene.persistent_props),
    ...asList(scene.persistentProps),
    ...asList(scene.active_props),
    ...asList(scene.activeProps),
    ...asList(scene.props),
    ...asList(scene.scene_props),
    ...asList(scene.sceneProps),
    ...asList(shot.persistent_props),
    ...asList(shot.persistentProps),
    ...asList(shot.active_props),
    ...asList(shot.activeProps),
    ...asList(shot.props),
    ...asList(shot.carried_props),
    ...asList(shot.carriedProps),
  ]);
}

function extractPropRemovals(scene = {}, shot = {}) {
  return unique([
    ...asList(scene.remove_props),
    ...asList(scene.removeProps),
    ...asList(scene.removed_props),
    ...asList(scene.removedProps),
    ...asList(shot.remove_props),
    ...asList(shot.removeProps),
    ...asList(shot.removed_props),
    ...asList(shot.removedProps),
  ]);
}

function explicitEnvironmentChange(scene = {}, shot = {}) {
  return Boolean(
    scene.environment_change ||
    scene.environmentChange ||
    scene.location_change ||
    scene.locationChange ||
    shot.environment_change ||
    shot.environmentChange ||
    shot.location_change ||
    shot.locationChange ||
    shot.scene_transition_environment ||
    shot.sceneTransitionEnvironment
  );
}

function explicitEnvironmentReuse(scene = {}, shot = {}) {
  return Boolean(
    scene.reuse_previous_environment ||
    scene.reusePreviousEnvironment ||
    scene.same_environment ||
    scene.sameEnvironment ||
    shot.reuse_previous_environment ||
    shot.reusePreviousEnvironment ||
    shot.same_environment ||
    shot.sameEnvironment
  );
}

function sceneLocation(scene = {}) {
  return firstNonEmpty(
    scene.location,
    scene.scene_location,
    scene.setting,
    scene.environment_location
  );
}

function sceneEnvironment(scene = {}) {
  return firstNonEmpty(
    scene.scene_environment,
    scene.environmental_story_beat,
    scene.environment_description,
    scene.environment,
    scene.location_description
  );
}

function sameContext(prevScene, scene) {
  if (!prevScene || !scene) return false;
  const a = key(sceneLocation(scene));
  const b = key(sceneLocation(prevScene));
  if (a && b && a === b) return true;

  const ea = key(sceneEnvironment(scene));
  const eb = key(sceneEnvironment(prevScene));
  if (ea && eb && ea === eb) return true;

  return false;
}

function resolveSceneBackgroundContext({ scene, previousScene = null, previousBackgroundUrl = null } = {}) {
  const change = explicitEnvironmentChange(scene);
  const reuse = explicitEnvironmentReuse(scene);
  const same = sameContext(previousScene, scene);

  if (previousBackgroundUrl && !change && (reuse || same)) {
    return {
      reusePrevious: true,
      backgroundUrl: String(previousBackgroundUrl).trim(),
      reason: reuse ? 'explicit-reuse' : 'same-context',
    };
  }

  return {
    reusePrevious: false,
    backgroundUrl: null,
    reason: change ? 'explicit-change' : 'new-context',
  };
}

function buildWorldStateForScene(scene = {}, previousState = null, previousScene = null) {
  const prev = previousState || { environment: '', activeProps: [] };
  const currentEnvironment = sceneEnvironment(scene);
  const location = sceneLocation(scene);

  let environment = currentEnvironment;
  if (!environment && prev.environment && !explicitEnvironmentChange(scene)) {
    environment = prev.environment;
  }

  const previousProps = Array.isArray(prev.activeProps) ? prev.activeProps : [];
  const declaredProps = extractProps(scene, {});
  const activeProps = declaredProps.length
    ? unique([...previousProps, ...declaredProps])
    : previousProps.slice();

  return {
    scene_number: Number(scene.scene_number || 0),
    location,
    environment,
    activeProps,
    persistentEnvironment: !explicitEnvironmentChange(scene),
    sameAsPreviousContext: sameContext(previousScene, scene),
  };
}

function buildStateForShot(shot = {}, sceneState = {}, previousShotState = null) {
  const prior = previousShotState || {};
  const environment = firstNonEmpty(
    sceneState.environment,
    prior.environment,
    shot._scene_environment,
    shot.scene_environment,
    shot.environmental_story_beat
  );

  const explicitProps = extractProps({}, shot);
  const removals = extractPropRemovals({}, shot);
  const baseProps = explicitProps.length
    ? unique(explicitProps)
    : Array.isArray(sceneState.activeProps)
      ? sceneState.activeProps.slice()
      : Array.isArray(prior.activeProps)
        ? prior.activeProps.slice()
        : [];
  const activeProps = removals.length
    ? baseProps.filter(prop => !removals.some(remove => key(remove) === key(prop)))
    : baseProps;

  return {
    scene_number: Number(shot.scene_number || sceneState.scene_number || 0),
    shot_index: Number(shot.shot_index || 0),
    location: firstNonEmpty(sceneState.location, prior.location, shot._scene_location, shot.location),
    environment,
    activeProps,
    removedProps: removals,
  };
}

function buildDirective(state = {}, { allowExplicitEnvironmentChange = false } = {}) {
  const environment = clean(state.environment);
  const props = unique(state.activeProps || []);
  const envText = environment
    ? `HARD ENVIRONMENT LOCK: Preserve the established scene environment, architecture, spatial geometry, fixed furnishings, persistent surfaces, lighting geography and camera geography: ${environment}.`
    : 'HARD ENVIRONMENT LOCK: Preserve the established physical location and do not invent or redesign the set.';

  const removed = unique(state.removedProps || []);
  const propText = props.length
    ? `HARD PROP LOCK: Persistent props for this scene are: ${props.join(', ')}. Preserve their identity, count, approximate position, ownership and contact state unless the shot explicitly authors a physical prop transfer, removal or introduction.`
    : 'HARD PROP LOCK: No additional persistent props are declared; do not invent persistent props.';
  const removalText = removed.length
    ? `EXPLICIT PROP REMOVAL: ${removed.join(', ')} may be removed only because this shot explicitly authors that removal; otherwise persistent props remain locked.`
    : '';

  const changeText = allowExplicitEnvironmentChange
    ? 'This shot explicitly permits an authored environment transition; make the change physically and contextually explainable rather than an arbitrary set swap.'
    : 'No silent environment change, teleport, prop replacement, prop duplication or set redesign is permitted.';

  return `${envText} ${propText} ${removalText} ${changeText}`.replace(/\s{2,}/g, ' ').trim();
}

function applyHardSceneWorldState(script) {
  if (!script || !Array.isArray(script.scenes)) return script;

  let previousScene = null;
  let previousState = null;

  for (const scene of script.scenes) {
    const sceneState = buildWorldStateForScene(scene, previousState, previousScene);
    const shots = Array.isArray(scene.shots)
      ? scene.shots.slice().sort((a, b) => Number(a.shot_index || 0) - Number(b.shot_index || 0))
      : [];

    let priorShotState = sceneState;
    scene._hard_world_before = JSON.parse(JSON.stringify(sceneState));

    for (const shot of shots) {
      const shotState = buildStateForShot(shot, sceneState, priorShotState);
      const envChanged = explicitEnvironmentChange(scene, shot);

      shot._hard_world_state = JSON.parse(JSON.stringify({
        ...shotState,
        environmentChangeAuthorized: envChanged,
      }));
      shot._hard_world_directive = buildDirective(shot._hard_world_state, {
        allowExplicitEnvironmentChange: envChanged,
      });

      // Never silently inherit a shot-level prop list that omits a persistent
      // scene prop. Additive persistence is intentional; removal requires an
      // explicit authored removal field and remains visible to downstream audit.
      if (!explicitEnvironmentChange(scene, shot)) {
        shot._hard_world_state.activeProps = unique([
          ...(sceneState.activeProps || []),
          ...(shot._hard_world_state.activeProps || []),
        ]);
        shot._hard_world_directive = buildDirective(shot._hard_world_state);
      }

      priorShotState = shot._hard_world_state;
    }

    scene._hard_world_after = JSON.parse(JSON.stringify(
      shots.length
        ? shots[shots.length - 1]._hard_world_state
        : sceneState
    ));

    previousState = scene._hard_world_after;
    previousScene = scene;
  }

  script.hard_scene_world_state = previousState
    ? JSON.parse(JSON.stringify(previousState))
    : { environment: '', activeProps: [] };

  return script;
}

module.exports = {
  clean,
  extractProps,
  extractPropRemovals,
  resolveSceneBackgroundContext,
  buildWorldStateForScene,
  buildStateForShot,
  buildDirective,
  applyHardSceneWorldState,
};
