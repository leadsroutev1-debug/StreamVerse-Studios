'use strict';
/**
 * Scene State Engine
 *
 * Tracks the physical and cinematic state of every scene across an episode:
 *   - Character positions (left/center/right, foreground/midground/background)
 *   - Lighting (key direction, intensity, color temperature, quality)
 *   - Camera angle history (shot type, height, distance, screen direction)
 *   - Environmental continuity (time of day, weather, props)
 *
 * The engine builds a per-scene state object from the script's scenes, then
 * injects continuity directives into each shot so the image generator
 * reproduces the same spatial and lighting setup across consecutive shots.
 *
 * Used after _applyCinematicShotSelection and before image prompt building.
 */

// ── Position tracking ─────────────────────────────────────────────────────────

/**
 * Infer a character's screen position from the shot's framing and camera type.
 * Maintains left/right consistency for shot-reverse-shot grammar.
 *
 * @param {Object} shot       - The shot object
 * @param {Object} prevState  - Previous shot's scene state (for continuity)
 * @returns {{position: string, depth: string}}
 */
function _inferPosition(shot, prevState) {
  const cameraType = shot.camera_type || '';
  const screenDir = shot._screen_direction || null;

  // Shot-reverse-shot: alternate sides based on screen direction
  if (screenDir === 'left')  return { position: 'screen-left',  depth: 'foreground' };
  if (screenDir === 'right') return { position: 'screen-right', depth: 'foreground' };

  // OTS: speaker in foreground, listener in background
  if (cameraType === 'over-the-shoulder') {
    return { position: 'center', depth: 'foreground' };
  }

  // Wide / establishing: characters spread across frame
  if (cameraType === 'wide-shot' || shot.shot_type === 'WS' || shot.shot_type === 'XWS') {
    return { position: 'center', depth: 'midground' };
  }

  // Default: center foreground for close-ups
  return { position: 'center', depth: 'foreground' };
}

/**
 * Track all character positions within a scene.
 * Returns a map of characterName → { position, depth, lastSeenShotIndex }.
 */
function _buildPositionMap(scene) {
  const shots = scene.shots || [];
  const positionMap = {};

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const chars = shot.characters_in_shot || [];
    const prevShotState = i > 0 ? shots[i - 1] : null;

    for (const charName of chars) {
      const key = String(charName).toLowerCase();
      const pos = _inferPosition(shot, prevShotState);
      positionMap[key] = {
        name: charName,
        position: pos.position,
        depth: pos.depth,
        lastSeenShotIndex: i,
      };
    }
  }

  return positionMap;
}

// ── Lighting tracking ──────────────────────────────────────────────────────────

/**
 * Extract lighting state from a scene's lighting_design field.
 * Normalizes into a structured object the image prompt builder can use.
 */
function _parseLighting(lightingDesign) {
  if (!lightingDesign) {
    return {
      keyDirection: 'unknown',
      intensity: 'medium',
      colorTemp: 'neutral',
      quality: 'soft',
    };
  }

  const text = String(lightingDesign).toLowerCase();

  // Direction
  let keyDirection = 'unknown';
  if (text.includes('side') || text.includes('raking')) keyDirection = 'side';
  else if (text.includes('back') || text.includes('silhouette') || text.includes('rim')) keyDirection = 'back';
  else if (text.includes('top') || text.includes('overhead')) keyDirection = 'top';
  else if (text.includes('front') || text.includes('direct')) keyDirection = 'front';
  else if (text.includes('natural') || text.includes('window')) keyDirection = 'natural';
  else if (text.includes('low') || text.includes('under')) keyDirection = 'low';

  // Intensity
  let intensity = 'medium';
  if (text.includes('harsh') || text.includes('bright') || text.includes('strong')) intensity = 'high';
  else if (text.includes('dim') || text.includes('low') || text.includes('dark') || text.includes('shadow')) intensity = 'low';

  // Color temperature
  let colorTemp = 'neutral';
  if (text.includes('warm') || text.includes('golden') || text.includes('amber') || text.includes('orange')) colorTemp = 'warm';
  else if (text.includes('cool') || text.includes('blue') || text.includes('cold') || text.includes('icy')) colorTemp = 'cool';
  else if (text.includes('green') || text.includes('fluorescent')) colorTemp = 'green';
  else if (text.includes('red') || text.includes('crimson')) colorTemp = 'red';

  // Quality
  let quality = 'soft';
  if (text.includes('hard') || text.includes('harsh') || text.includes('direct')) quality = 'hard';
  else if (text.includes('diffused') || text.includes('soft') || text.includes('gentle')) quality = 'soft';

  return { keyDirection, intensity, colorTemp, quality };
}


function _safeText(value, fallback = '') {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(v => _safeText(v, '')).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const preferredKeys = [
      'text', 'description', 'value', 'label', 'name',
      'framing', 'camera_type', 'shot_type', 'prompt',
    ];
    for (const key of preferredKeys) {
      if (value[key] != null) {
        const text = _safeText(value[key], '');
        if (text) return text;
      }
    }
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

// ── Camera angle history ────────────────────────────────────────────────────────

/**
 * Build a camera angle history for a scene.
 * Tracks: shot_type, camera_type, screen_direction, shot_index.
 * Used to prevent angle repetition and ensure progressive coverage.
 */
function _buildCameraHistory(scene) {
  const shots = scene.shots || [];
  const history = [];

  for (const shot of shots) {
    history.push({
      shotIndex: shot.shot_index,
      shotType: shot.shot_type || 'MS',
      cameraType: shot.camera_type || 'medium',
      screenDirection: shot._screen_direction || null,
      height: _inferCameraHeight(shot),
      distance: _inferCameraDistance(shot),
    });
  }

  return history;
}

function _inferCameraHeight(shot) {
  const st = _safeText(shot.shot_type, '').toUpperCase();
  const cameraType = _safeText(shot.camera_type, '').toLowerCase();

  if (st === 'AERIAL' || cameraType.includes('crane')) return 'high';
  if (st === 'ECU' || st === 'CU' || st === 'INSERT') return 'eye-level';
  if (cameraType.includes('dutch')) return 'dutch';
  if (cameraType.includes('low')) return 'low';

  // Infer from framing description
  const framing = _safeText(shot.framing, '').toLowerCase();
  if (framing.includes('looking up') || framing.includes('low angle')) return 'low';
  if (framing.includes('looking down') || framing.includes('high angle') || framing.includes('bird')) return 'high';

  return 'eye-level';
}

function _inferCameraDistance(shot) {
  const st = _safeText(shot.shot_type, '').toUpperCase();
  switch (st) {
    case 'ECU': return 'extreme-close';
    case 'CU':  return 'close';
    case 'MCU': return 'medium-close';
    case 'MS':  return 'medium';
    case 'MWS': return 'medium-wide';
    case 'WS':  return 'wide';
    case 'XWS': return 'extreme-wide';
    case 'OTS': return 'medium';
    case 'POV': return 'subjective';
    default:   return 'medium';
  }
}

// ── Environmental continuity ───────────────────────────────────────────────────

/**
 * Extract environmental state from a scene.
 * Tracks: location, time_of_day, weather, props.
 */
function _parseEnvironment(scene) {
  const location = _safeText(scene.location, '');
  const locText = location.toLowerCase();

  let timeOfDay = 'unspecified';
  if (locText.includes('night')) timeOfDay = 'night';
  else if (locText.includes('dawn') || locText.includes('sunrise')) timeOfDay = 'dawn';
  else if (locText.includes('morning')) timeOfDay = 'morning';
  else if (locText.includes('noon') || locText.includes('midday')) timeOfDay = 'noon';
  else if (locText.includes('afternoon')) timeOfDay = 'afternoon';
  else if (locText.includes('dusk') || locText.includes('sunset') || locText.includes('golden hour')) timeOfDay = 'dusk';
  else if (locText.includes('evening')) timeOfDay = 'evening';

  let weather = 'clear';
  if (locText.includes('rain') || locText.includes('storm')) weather = 'rain';
  else if (locText.includes('snow') || locText.includes('blizzard')) weather = 'snow';
  else if (locText.includes('fog') || locText.includes('mist')) weather = 'fog';
  else if (locText.includes('overcast') || locText.includes('cloudy')) weather = 'overcast';

  return {
    location: scene.location || 'unknown',
    timeOfDay,
    weather,
    props: _extractProps(scene),
  };
}

function _extractProps(scene) {
  const props = new Set();
  const text = [
    scene.scene_description || '',
    scene.scene_description_ext || '',
  ].join(' ');

  // Common prop keywords
  const propPatterns = [
    /\b(phone|cellphone|smartphone)\b/gi,
    /\b(gun|pistol|rifle|knife|weapon|sword)\b/gi,
    /\b(cup|glass|bottle|wine|mug)\b/gi,
    /\b(book|letter|note|document|file|folder)\b/gi,
    /\b(keys|key|card|badge)\b/gi,
    /\b(bag|briefcase|backpack|suitcase)\b/gi,
    /\b(laptop|computer|tablet|monitor|screen)\b/gi,
    /\b(ring|necklace|watch|jewelry)\b/gi,
    /\b(car|vehicle|truck|motorcycle)\b/gi,
    /\b(flower|rose|bouquet)\b/gi,
    /\b(mirror|window|door)\b/gi,
    /\b(food|plate|dinner|breakfast)\b/gi,
  ];

  for (const pattern of propPatterns) {
    const matches = text.match(pattern);
    if (matches) for (const m of matches) props.add(m.toLowerCase());
  }

  return [...props];
}

// ── Main: build scene state for all scenes ──────────────────────────────────────

/**
 * Build the full Scene State Engine output for an episode script.
 * Attaches a `_scene_state` object to each scene and a `_continuity_directive`
 * to each shot with position, lighting, camera, and environment context.
 *
 * @param {Object} script - The episode script (mutated in place)
 * @returns {Object} The mutated script
 */
function applySceneState(script) {
  if (!script || !script.scenes) return script;

  for (const scene of script.scenes) {
    const lighting = _parseLighting(scene.lighting_design);
    const environment = _parseEnvironment(scene);
    const positionMap = _buildPositionMap(scene);
    const cameraHistory = _buildCameraHistory(scene);

    scene._scene_state = {
      lighting,
      environment,
      positionMap,
      cameraHistory,
    };

    // Inject continuity directives into each shot
    const shots = scene.shots || [];
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const prevShot = i > 0 ? shots[i - 1] : null;

      shot._continuity_directive = _buildContinuityDirective(
        shot, prevShot, lighting, environment, positionMap, cameraHistory, i
      );
    }
  }

  console.log(`[SceneState] Built state for ${(script.scenes || []).length} scenes`);
  return script;
}

/**
 * Build a continuity directive string injected into the image prompt.
 * Tells the image generator: where characters are, what the lighting is,
 * what the camera angle is, and what the environment looks like.
 */
function _buildContinuityDirective(shot, prevShot, lighting, environment, positionMap, cameraHistory, shotIdx) {
  const parts = [];

  // Lighting continuity
  if (lighting.keyDirection !== 'unknown') {
    parts.push(`Lighting: ${lighting.keyDirection} key light, ${lighting.intensity} intensity, ${lighting.colorTemp} temperature, ${lighting.quality} quality`);
  }

  // Environment continuity
  if (environment.timeOfDay !== 'unspecified') {
    parts.push(`Time of day: ${environment.timeOfDay}`);
  }
  if (environment.weather !== 'clear') {
    parts.push(`Weather: ${environment.weather}`);
  }
  if (environment.props.length > 0) {
    parts.push(`Props visible: ${environment.props.join(', ')}`);
  }

  // Position continuity for characters in this shot
  const chars = shot.characters_in_shot || [];
  const positionParts = [];
  for (const charName of chars) {
    const key = String(charName).toLowerCase();
    const pos = positionMap[key];
    if (pos) {
      positionParts.push(`${charName} at ${pos.position} ${pos.depth}`);
    }
  }
  if (positionParts.length > 0) {
    parts.push(`Character positions: ${positionParts.join('; ')}`);
  }

  // Camera angle — avoid repeating the exact same angle as previous shot
  const currentAngle = cameraHistory[shotIdx];
  if (currentAngle && prevShot) {
    const prevAngle = cameraHistory[shotIdx - 1];
    if (prevAngle && currentAngle.height === prevAngle.height && currentAngle.distance === prevAngle.distance) {
      parts.push('Vary camera angle from previous shot — do not repeat exact framing');
    }
  }

  return parts.join('. ');
}

module.exports = {
  applySceneState,
  // Exported for testing
  _parseLighting,
  _parseEnvironment,
  _buildPositionMap,
  _buildCameraHistory,
  _safeText,
};
