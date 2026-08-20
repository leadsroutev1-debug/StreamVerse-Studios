'use strict';
/**
 * Real Camera Simulation
 *
 * Simulates real-world camera physics to produce cinematically accurate
 * image and video generation parameters:
 *
 *   1. Focal length logic — maps shot_type to a realistic focal length
 *      (mm) and derives the resulting field of view, depth of field,
 *      and compression characteristics
 *   2. Camera movement curves — generates smooth interpolation curves
 *      (ease-in, ease-out, linear) for camera movements so motion is
 *      physically plausible, not instant teleport
 *   3. Depth layering — creates foreground/midground/background layer
 *      directives with depth-of-field and focus plane instructions
 *
 * Attaches `_camera_sim` to each shot with structured camera parameters
 * that the image prompt builder and video generator consume.
 */

// ── Focal length mapping ───────────────────────────────────────────────────────

/**
 * Maps shot types to realistic 35mm-equivalent focal lengths.
 * Based on standard cinematography:
 *   - ECU / CU: 85-100mm (portrait telephoto, shallow DOF)
 *   - MCU: 50-85mm (short telephoto)
 *   - MS: 35-50mm (normal to short tele)
 *   - MWS: 28-35mm (wide-normal)
 *   - WS: 24-28mm (wide)
 *   - XWS: 14-24mm (ultra-wide)
 *   - OTS: 50-85mm (short tele for OTS compression)
 *   - POV: 24-35mm (wide-ish for subjective POV)
 *   - AERIAL: 24-35mm (wide for aerial scope)
 *   - INSERT: 100mm (macro-ish for detail)
 */
const FOCAL_LENGTH_MAP = {
  ECU:     { min: 85,  max: 100, default: 85 },
  CU:      { min: 50,  max: 100, default: 85 },
  MCU:     { min: 50,  max: 85,  default: 50 },
  MS:      { min: 35,  max: 50,  default: 35 },
  MWS:     { min: 28,  max: 35,  default: 28 },
  WS:      { min: 24,  max: 28,  default: 24 },
  XWS:     { min: 14,  max: 24,  default: 18 },
  OTS:     { min: 50,  max: 85,  default: 50 },
  POV:     { min: 24,  max: 35,  default: 28 },
  AERIAL:  { min: 24,  max: 35,  default: 24 },
  INSERT:  { min: 85,  max: 100, default: 100 },
};

/**
 * Derive focal length characteristics from the shot type.
 * Returns: { focalLengthMm, fov, dof, compression, aperture }
 */
function _deriveFocalLength(shotType) {
  const st = (shotType || 'MS').toUpperCase();
  const range = FOCAL_LENGTH_MAP[st] || FOCAL_LENGTH_MAP.MS;
  const focalLength = range.default;

  // Field of view (horizontal, approximate for 35mm sensor)
  let fov;
  if (focalLength <= 16) fov = 'ultra-wide 100°+';
  else if (focalLength <= 24) fov = 'wide 84°';
  else if (focalLength <= 28) fov = 'wide 75°';
  else if (focalLength <= 35) fov = 'wide-normal 63°';
  else if (focalLength <= 50) fov = 'normal 47°';
  else if (focalLength <= 85) fov = 'short telephoto 28°';
  else fov = 'telephoto 24°';

  // Depth of field: longer focal length = shallower DOF
  let dof;
  if (focalLength >= 85) dof = 'shallow — subject in focus, background blurred (bokeh)';
  else if (focalLength >= 50) dof = 'moderate — subject sharp, background slightly soft';
  else if (focalLength >= 35) dof = 'medium — most of frame in focus';
  else dof = 'deep — everything from foreground to background in focus';

  // Compression: longer focal length = more background compression
  let compression;
  if (focalLength >= 85) compression = 'high compression — background appears closer to subject';
  else if (focalLength >= 50) compression = 'moderate compression — natural perspective';
  else if (focalLength >= 28) compression = 'low compression — expansive background';
  else compression = 'minimal compression — distant background appears far';

  // Suggested aperture (f-stop) based on focal length and shot type
  let aperture;
  if (focalLength >= 85) aperture = 'f/2.0';
  else if (focalLength >= 50) aperture = 'f/2.8';
  else if (focalLength >= 35) aperture = 'f/4.0';
  else aperture = 'f/5.6';

  return { focalLengthMm: focalLength, fov, dof, compression, aperture };
}

// ── Camera movement curves ──────────────────────────────────────────────────────

/**
 * Easing functions for camera movement interpolation.
 * These generate the curve profile that describes how the camera moves
 * over the duration of the shot.
 */
const EASING = {
  linear:      (t) => t,
  easeIn:      (t) => t * t,
  easeOut:     (t) => t * (2 - t),
  easeInOut:   (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t) => t * t * t,
  easeOutCubic:(t) => 1 - Math.pow(1 - t, 3),
};

/**
 * Map camera_movement from the script to a structured movement curve.
 * Returns: { type, easing, intensity, direction, description }
 */
function _deriveMovementCurve(cameraMovement, shotType, motionLevel) {
  const cm = (cameraMovement || 'static').toLowerCase();

  // Static shot — no movement
  if (cm === 'static' || cm === 'none') {
    return {
      type: 'static',
      easing: null,
      intensity: 0,
      direction: null,
      description: 'Locked-off tripod shot, no camera movement. Any motion comes from subject or environment only.',
    };
  }

  // Slow push-in — gradual dolly forward
  if (cm.includes('push') || cm.includes('dolly in') || cm.includes('zoom in')) {
    return {
      type: 'dolly_in',
      easing: 'easeOut',
      intensity: motionLevel === 'high' ? 0.8 : motionLevel === 'low' ? 0.3 : 0.5,
      direction: 'forward',
      description: 'Slow dolly push-in toward subject. Camera moves forward on a smooth track, decelerating as it approaches. Use ease-out curve — starts with momentum, settles into the final framing.',
    };
  }

  // Pull back — dolly backward
  if (cm.includes('pull') || cm.includes('dolly out') || cm.includes('zoom out')) {
    return {
      type: 'dolly_out',
      easing: 'easeIn',
      intensity: motionLevel === 'high' ? 0.7 : 0.4,
      direction: 'backward',
      description: 'Camera pulls back from subject on a smooth dolly track. Accelerating retreat — starts slow, builds momentum. Use ease-in curve.',
    };
  }

  // Pan — horizontal rotation
  if (cm.includes('pan left')) {
    return {
      type: 'pan',
      easing: 'easeInOut',
      intensity: 0.5,
      direction: 'left',
      description: 'Horizontal pan to the left. Camera rotates on its vertical axis. Smooth ease-in-out curve — starts slow, accelerates through the middle, decelerates to settle.',
    };
  }
  if (cm.includes('pan right')) {
    return {
      type: 'pan',
      easing: 'easeInOut',
      intensity: 0.5,
      direction: 'right',
      description: 'Horizontal pan to the right. Camera rotates on its vertical axis. Smooth ease-in-out curve.',
    };
  }

  // Tilt — vertical rotation
  if (cm.includes('tilt up')) {
    return {
      type: 'tilt',
      easing: 'easeOut',
      intensity: 0.4,
      direction: 'up',
      description: 'Tilt up — camera rotates upward on its horizontal axis. Starts with intent, settles at the final framing. Use ease-out.',
    };
  }
  if (cm.includes('tilt down')) {
    return {
      type: 'tilt',
      easing: 'easeOut',
      intensity: 0.4,
      direction: 'down',
      description: 'Tilt down — camera rotates downward. Ease-out curve for a deliberate reveal.',
    };
  }

  // Crane — vertical movement
  if (cm.includes('crane up') || cm.includes('crane')) {
    return {
      type: 'crane',
      easing: 'easeInOut',
      intensity: 0.6,
      direction: 'up',
      description: 'Crane shot — camera rises vertically on a jib arm. Smooth, sweeping ascent with ease-in-out. Reveals scale and geography.',
    };
  }

  // Handheld — organic shake
  if (cm.includes('handheld') || cm.includes('drift')) {
    return {
      type: 'handheld',
      easing: null,
      intensity: motionLevel === 'high' ? 0.8 : 0.5,
      direction: 'organic',
      description: 'Handheld camera — organic micro-movements, slight sway and breath. Not locked off but not chaotic. Human-operated feel with naturalistic drift.',
    };
  }

  return {
    type: 'static',
    easing: null,
    intensity: 0,
    direction: null,
    description: 'Static camera. No movement.',
  };
}

// ── Depth layering ─────────────────────────────────────────────────────────────

/**
 * Build depth layer directives for a shot.
 * Creates foreground / midground / background layer descriptions with
 * focus plane and depth-of-field instructions.
 */
function _deriveDepthLayers(shot, focalLengthData) {
  const st = (shot.shot_type || 'MS').toUpperCase();
  const cameraType = (shot.camera_type || '').toLowerCase();

  // Determine focus plane based on shot type
  let focusPlane = 'subject';
  if (st === 'ECU' || st === 'CU' || st === 'INSERT') {
    focusPlane = 'subject face — eyes are the sharpest point in the frame';
  } else if (st === 'WS' || st === 'XWS' || st === 'AERIAL') {
    focusPlane = 'midground — everything is in acceptable focus (deep DOF)';
  } else if (cameraType === 'over-the-shoulder') {
    focusPlane = 'the facing character (the listener) — the foreground shoulder is blurred';
  }

  // Depth layers based on focal length
  const isShallowDOF = focalLengthData.focalLengthMm >= 50;

  const layers = {
    foreground: isShallowDOF
      ? 'Foreground elements (if any) are out of focus, creating depth and bokeh. Soft, blurred shapes frame the edges.'
      : 'Foreground elements are in acceptable focus, establishing spatial depth.',
    midground: `Subject occupies the midground at the focus plane. ${focalLengthData.dof}.`,
    background: isShallowDOF
      ? `Background is blurred with smooth bokeh. ${focalLengthData.compression}. Background is a soft wash of color and shape, not a distraction.`
      : `Background is in focus and visible. ${focalLengthData.compression}.`,
  };

  return {
    focusPlane,
    layers,
    shallowDOF: isShallowDOF,
  };
}

// ── Main: apply camera simulation to all shots ─────────────────────────────────

/**
 * Apply real camera simulation parameters to every shot in every scene.
 * Attaches `_camera_sim` to each shot with:
 *   - focalLength: { focalLengthMm, fov, dof, compression, aperture }
 *   - movementCurve: { type, easing, intensity, direction, description }
 *   - depthLayers: { focusPlane, layers, shallowDOF }
 *   - promptFragment: a text fragment for the image prompt
 *
 * @param {Object} script - The episode script (mutated in place)
 * @returns {Object} The mutated script
 */
function applyCameraSimulation(script) {
  if (!script || !script.scenes) return script;

  let totalShots = 0;

  for (const scene of script.scenes) {
    const shots = scene.shots || [];

    for (const shot of shots) {
      const focalLength = _deriveFocalLength(shot.shot_type);
      const movementCurve = _deriveMovementCurve(
        shot.camera_movement,
        shot.shot_type,
        shot.motion_level
      );
      const depthLayers = _deriveDepthLayers(shot, focalLength);

      shot._camera_sim = {
        focalLength,
        movementCurve,
        depthLayers,
        promptFragment: _buildCameraSimPrompt(focalLength, movementCurve, depthLayers),
      };

      totalShots++;
    }
  }

  console.log(`[CameraSim] Applied camera simulation to ${totalShots} shots`);
  return script;
}

/**
 * Build a text fragment from camera simulation data for injection into image prompts.
 */
function _buildCameraSimPrompt(focalLength, movement, depth) {
  const parts = [];

  // Focal length
  parts.push(`Shot on ${focalLength.focalLengthMm}mm lens, ${focalLength.fov}, aperture ${focalLength.aperture}. ${focalLength.dof}. ${focalLength.compression}.`);

  // Depth layers
  parts.push(`Focus plane: ${depth.focusPlane}. ${depth.layers.foreground} ${depth.layers.midground} ${depth.layers.background}`);

  // Movement (for video — tells the video model what motion to apply)
  if (movement.type !== 'static') {
    parts.push(`Camera movement: ${movement.description}`);
  }

  return parts.join(' ');
}

module.exports = {
  applyCameraSimulation,
  FOCAL_LENGTH_MAP,
  EASING,
  // Exported for testing
  _deriveFocalLength,
  _deriveMovementCurve,
  _deriveDepthLayers,
  _buildCameraSimPrompt,
};
