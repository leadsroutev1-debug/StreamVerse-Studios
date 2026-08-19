'use strict';
/**
 * Motion System Upgrade
 *
 * Moves from "describe motion" (natural language hints to the video model)
 * to "control motion parameters" (structured, numeric, and directive-based
 * parameters that the video generator translates into exact API calls).
 *
 * This module takes each shot's raw motion fields (camera_movement,
 * motion_level, shot_pacing_type, emotional_subtext) and produces a
 * structured `motion_params` object:
 *
 *   - motionIntensity: 0.0–1.0 numeric scale (maps to MH motion_level)
 *   - motionType: dolly|pan|tilt|crane|handheld|static|zoom
 *   - motionDirection: forward|backward|left|right|up|down|organic|none
 *   - motionSpeed: slow|medium|fast (derived from pacing + intensity)
 *   - motionEasing: easeIn|easeOut|easeInOut|linear|none
 *   - subjectMotion: still|subtle|active|intense (character body motion)
 *   - ambientMotion: still|gentle|dynamic (environmental motion)
 *   - lipSync: boolean (whether lip-sync animation is active)
 *   - videoPrompt: assembled directive string for the video model
 *
 * Attaches `_motion_params` to each shot.
 */

const ttsGen = require('./ttsGen');

// ── Motion intensity mapping ────────────────────────────────────────────────────

/**
 * Map a motion_level string to a numeric intensity.
 * "low" → 0.25, "medium" → 0.5, "high" → 0.8
 */
function _levelToIntensity(level) {
  const l = (level || 'medium').toLowerCase();
  if (l === 'low') return 0.25;
  if (l === 'high') return 0.8;
  if (l === 'medium') return 0.5;
  // Numeric passthrough
  const n = parseFloat(l);
  if (!isNaN(n)) return Math.min(Math.max(n, 0), 1);
  return 0.5;
}

/**
 * Map a numeric intensity to a Magic Hour motion_level string.
 * MH accepts: 'low', 'medium', 'high'
 */
function _intensityToMHLevel(intensity) {
  if (intensity <= 0.33) return 'low';
  if (intensity <= 0.66) return 'medium';
  return 'high';
}

// ── Motion type classification ──────────────────────────────────────────────────

/**
 * Parse the raw camera_movement string into a structured motion type.
 */
function _classifyMotion(cameraMovement) {
  const cm = (cameraMovement || 'static').toLowerCase();

  if (cm === 'static' || cm === 'none') {
    return { type: 'static', direction: 'none' };
  }
  if (cm.includes('push') || cm.includes('dolly in')) {
    return { type: 'dolly', direction: 'forward' };
  }
  if (cm.includes('pull') || cm.includes('dolly out')) {
    return { type: 'dolly', direction: 'backward' };
  }
  if (cm.includes('zoom in')) {
    return { type: 'zoom', direction: 'forward' };
  }
  if (cm.includes('zoom out')) {
    return { type: 'zoom', direction: 'backward' };
  }
  if (cm.includes('pan left')) {
    return { type: 'pan', direction: 'left' };
  }
  if (cm.includes('pan right')) {
    return { type: 'pan', direction: 'right' };
  }
  if (cm.includes('tilt up')) {
    return { type: 'tilt', direction: 'up' };
  }
  if (cm.includes('tilt down')) {
    return { type: 'tilt', direction: 'down' };
  }
  if (cm.includes('crane up')) {
    return { type: 'crane', direction: 'up' };
  }
  if (cm.includes('crane down')) {
    return { type: 'crane', direction: 'down' };
  }
  if (cm.includes('handheld') || cm.includes('drift')) {
    return { type: 'handheld', direction: 'organic' };
  }

  return { type: 'static', direction: 'none' };
}

// ── Motion speed derivation ────────────────────────────────────────────────────

/**
 * Derive motion speed from pacing type and intensity.
 * Fast-paced shots (hook, action) get fast camera motion.
 * Slow shots (slow_dramatic, establishing) get slow camera motion.
 */
function _deriveMotionSpeed(shotPacingType, intensity) {
  const pt = (shotPacingType || 'action').toLowerCase();

  if (pt === 'hook' || pt === 'action') return 'fast';
  if (pt === 'slow_dramatic' || pt === 'establishing') return 'slow';
  if (pt === 'reaction' || pt === 'broll_cutaway') return 'medium';
  if (pt === 'dialogue_mid' || pt === 'dialogue_full') return 'slow';

  // Fall back to intensity
  if (intensity >= 0.7) return 'fast';
  if (intensity <= 0.3) return 'slow';
  return 'medium';
}

// ── Easing derivation ───────────────────────────────────────────────────────────

/**
 * Derive the easing curve from motion type and direction.
 */
function _deriveEasing(motionType, motionDirection) {
  if (motionType === 'static') return 'none';
  if (motionType === 'handheld') return 'none'; // handheld has no easing — organic

  // Forward movements (dolly in, zoom in) → easeOut (decelerate into frame)
  if (motionDirection === 'forward') return 'easeOut';
  // Backward movements (dolly out, zoom out) → easeIn (accelerate away)
  if (motionDirection === 'backward') return 'easeIn';
  // Pans and tilts → easeInOut (smooth in, through, and out)
  if (motionType === 'pan' || motionType === 'tilt') return 'easeInOut';
  // Crane → easeInOut for sweeping feel
  if (motionType === 'crane') return 'easeInOut';

  return 'easeInOut';
}

// ── Subject and ambient motion ─────────────────────────────────────────────────

/**
 * Derive how much the subject (character) should be moving.
 * Based on pacing type, emotional subtext, and whether they're speaking.
 */
function _deriveSubjectMotion(shot) {
  const pt = (shot.shot_pacing_type || 'action').toLowerCase();
  const hasDialogue = !!(shot.dialogue_or_action || '').trim();
  const emotion = (shot.emotional_subtext || '').toLowerCase();

  // Talking-photo shots: subject is speaking — subtle body motion only
  if (hasDialogue && (pt === 'dialogue_mid' || pt === 'dialogue_full')) {
    return 'subtle';
  }

  // Action shots: active or intense body motion
  if (pt === 'action' || pt === 'hook') {
    if (emotion.includes('rage') || emotion.includes('panic') || emotion.includes('fight')) return 'intense';
    return 'active';
  }

  // Reaction shots: subtle facial/body motion
  if (pt === 'reaction') return 'subtle';

  // Slow dramatic: still or subtle
  if (pt === 'slow_dramatic') return 'still';

  // Establishing: environment is the focus, subject is still
  if (pt === 'establishing') return 'still';

  return 'subtle';
}

/**
 * Derive ambient environmental motion.
 * Based on scene context and shot type.
 */
function _deriveAmbientMotion(shot) {
  const pt = (shot.shot_pacing_type || 'action').toLowerCase();
  const env = [
    shot._scene_description || '',
    shot._scene_location || '',
    shot.image_prompt || '',
  ].join(' ').toLowerCase();

  // Check for environmental motion cues
  if (env.includes('wind') || env.includes('storm') || env.includes('rain')) return 'dynamic';
  if (env.includes('water') || env.includes('river') || env.includes('ocean') || env.includes('waves')) return 'gentle';
  if (env.includes('crowd') || env.includes('city') || env.includes('traffic')) return 'dynamic';
  if (env.includes('candle') || env.includes('fire') || env.includes('flame')) return 'gentle';
  if (env.includes('forest') || env.includes('trees') || env.includes('leaves')) return 'gentle';

  // Action/hook shots: more ambient energy
  if (pt === 'action' || pt === 'hook') return 'gentle';

  // Default: still environment
  return 'still';
}

// ── Video prompt assembly ───────────────────────────────────────────────────────

/**
 * Assemble a directive video prompt from structured motion parameters.
 * This replaces the old "just pass image_prompt and hope" approach with
 * explicit, parameterized motion instructions the video model can follow.
 */
function _buildVideoPrompt(motionParams, shot, cameraSimData) {
  // NOTE on ordering: the talking-photo endpoint caps this whole string to
  // 300 chars (see videoGen.js MAX_PROMPT_TALKING), so the highest-priority
  // behavioural instructions — how dialogue is delivered, and the caption
  // ban — go FIRST. Anything truncated off the end should be the least
  // important part (camera/ambient flavour), not the "don't narrate the
  // stage directions" instruction that was getting cut before.
  const parts = [];

  // ── Dialogue — spoken naturally, never narrated ────────────────────────────
  // Previously this function just appended the raw (visual) image_prompt as
  // the only text the model saw, so Magic Hour's talking-photo audio had
  // nothing telling it dialogue should sound like two people talking — it
  // read the scene description text back like narration instead. Extract the
  // actual quoted dialogue (same helper the LTX prompt path uses) and give an
  // explicit natural-delivery instruction, isolated from the staging text.
  const dialogueEntries = ttsGen.extractMultiSpeakerDialogue(shot.dialogue_or_action);
  if (dialogueEntries.length) {
    for (const { speaker, text } of dialogueEntries) {
      if (!text) continue;
      const who = speaker || 'Speaker';
      parts.push(`${who} speaks naturally, conversationally, like real speech — not read aloud, not narrated: "${text}"`);
    }
    parts.push('Only the quoted words are spoken. No names, no stage directions, no other text spoken.');
  } else {
    parts.push('No dialogue — silent, no speech, no mouth movement.');
  }

  // ── Captions — off, always ─────────────────────────────────────────────────
  parts.push('NO captions, subtitles, or on-screen text anywhere in frame.');

  // Motion directive
  if (motionParams.motionType === 'static') {
    parts.push('Camera locked off — motion comes from subject/environment only.');
  } else {
    const dir = motionParams.motionDirection !== 'none' ? ` ${motionParams.motionDirection}` : '';
    parts.push(`Camera motion: ${motionParams.motionType}${dir}, ${motionParams.motionSpeed} speed, ${motionParams.motionEasing} easing.`);
  }

  // Subject motion directive
  switch (motionParams.subjectMotion) {
    case 'still':
      parts.push('Subject still — only breathing and micro-expressions.');
      break;
    case 'subtle':
      parts.push('Subject subtle natural movement — head turns, breathing, blinking, weight shifts.');
      break;
    case 'active':
      parts.push('Subject actively moving — purposeful gestures, stepping, turning.');
      break;
    case 'intense':
      parts.push('Subject motion intense — rapid, forceful, full body.');
      break;
  }

  // Ambient motion directive
  switch (motionParams.ambientMotion) {
    case 'still':
      parts.push('Environment still — no ambient motion.');
      break;
    case 'gentle':
      parts.push('Environment gentle ambient motion — subtle sway, soft light shift.');
      break;
    case 'dynamic':
      parts.push('Environment dynamic ambient motion — active background elements.');
      break;
  }

  // Lip-sync directive
  if (motionParams.lipSync) {
    parts.push('Lip-sync active — natural mouth shapes, no over-articulation.');
  } else {
    parts.push('No lip-sync — mouth stays closed.');
  }

  // ── Music — one coherent direction for the whole episode ──────────────────
  if (shot._music_direction) {
    parts.push(`MUSIC (same as every other shot this episode — do not change track/genre/instrumentation): ${shot._music_direction}`);
  }

  // Camera simulation data (focal length, DOF) if available
  if (cameraSimData?.focalLength) {
    const fl = cameraSimData.focalLength;
    parts.push(`Lens: ${fl.focalLengthMm}mm, ${fl.dof}.`);
  }

  // Camera movement curve description from camera sim
  if (cameraSimData?.movementCurve && cameraSimData.movementCurve.type !== 'static') {
    parts.push(cameraSimData.movementCurve.description);
  }

  // ── Staging/description — visual instruction only, never voiced ───────────
  const rawPrompt = (shot.image_prompt || '').trim();
  if (rawPrompt) {
    parts.push(`SCENE DIRECTION (visual only, never spoken/narrated): ${rawPrompt.slice(0, 150)}`);
  }

  return parts.join(' ');
}

// ── Main: apply motion system to all shots ──────────────────────────────────────

/**
 * Apply structured motion parameters to every shot in every scene.
 * Attaches `_motion_params` to each shot.
 *
 * Also produces a `videoPrompt` field that replaces the raw image_prompt
 * passed to Magic Hour, giving the video model explicit motion directives
 * instead of a vague natural-language description.
 *
 * @param {Object} script - The episode script (mutated in place)
 * @returns {Object} The mutated script
 */
function applyMotionSystem(script) {
  if (!script || !script.scenes) return script;

  let totalShots = 0;

  for (const scene of script.scenes) {
    const shots = scene.shots || [];

    for (const shot of shots) {
      const motionClassification = _classifyMotion(shot.camera_movement);
      const intensity = _levelToIntensity(shot.motion_level);
      const speed = _deriveMotionSpeed(shot.shot_pacing_type, intensity);
      const easing = _deriveEasing(motionClassification.type, motionClassification.direction);
      const subjectMotion = _deriveSubjectMotion(shot);
      const ambientMotion = _deriveAmbientMotion(shot);

      // Lip-sync: active for talking-photo shots with dialogue
      const hasDialogue = !!(shot.dialogue_or_action || '').trim();
      const isDialoguePacing = ['dialogue_mid', 'dialogue_full'].includes(shot.shot_pacing_type);
      const isPhoneVO = shot.tts_mode === 'phone_vo';
      const lipSync = hasDialogue && isDialoguePacing && !isPhoneVO && !shot._phone_speaker_visible === false;

      const motionParams = {
        motionIntensity: intensity,
        motionType: motionClassification.type,
        motionDirection: motionClassification.direction,
        motionSpeed: speed,
        motionEasing: easing,
        subjectMotion,
        ambientMotion,
        lipSync,
        // Magic Hour API motion_level mapping
        mhMotionLevel: _intensityToMHLevel(intensity),
      };

      // Build the video prompt from structured params + camera sim data
      motionParams.videoPrompt = _buildVideoPrompt(motionParams, shot, shot._camera_sim);

      shot._motion_params = motionParams;
      totalShots++;
    }
  }

  console.log(`[MotionSystem] Applied structured motion params to ${totalShots} shots`);
  return script;
}

module.exports = {
  applyMotionSystem,
  // Exported for testing
  _levelToIntensity,
  _intensityToMHLevel,
  _classifyMotion,
  _deriveMotionSpeed,
  _deriveEasing,
  _deriveSubjectMotion,
  _deriveAmbientMotion,
  _buildVideoPrompt,
};
