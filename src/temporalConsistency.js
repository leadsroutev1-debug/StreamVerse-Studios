'use strict';
/**
 * Temporal Consistency Layer
 *
 * Ensures visual continuity across consecutive frames within a scene:
 *   1. Same face across frames — enforces character identity consistency
 *      by tracking reference image usage and injecting identity lock directives
 *   2. Same pose progression — ensures a character's body posture evolves
 *      naturally from shot to shot (no teleporting, no sudden pose resets)
 *   3. No visual resets per shot — prevents the environment, costume, and
 *      lighting from changing unexpectedly between shots in the same scene
 *
 * This layer runs after the Scene State Engine and before image prompt building.
 * It attaches a `_temporal_directive` to each shot with explicit continuity
 * constraints the image generator must follow.
 */

// ── Pose tracking ─────────────────────────────────────────────────────────────

/**
 * Pose state: body orientation, posture, and action state.
 * Tracks progression so shot N+1 starts from shot N's ending pose.
 */
const POSE_STATES = {
  STANDING: 'standing',
  SITTING: 'sitting',
  WALKING: 'walking',
  RUNNING: 'running',
  LEANING: 'leaning',
  CROUCHING: 'crouching',
  LYING: 'lying',
  TURNING: 'turning',
  REACHING: 'reaching',
  FIGHTING: 'fighting',
};

/**
 * Infer a character's pose from the shot's dialogue_or_action and image_prompt.
 */
function _inferPose(shot, charName) {
  const text = [
    shot.dialogue_or_action || '',
    shot.image_prompt || '',
    shot.shot_description || '',
  ].join(' ').toLowerCase();

  const name = (charName || '').toLowerCase();
  if (!name) {
    // General shot — infer from overall text
    if (text.includes('run')) return POSE_STATES.RUNNING;
    if (text.includes('walk') || text.includes('strut') || text.includes('stroll')) return POSE_STATES.WALKING;
    if (text.includes('sit') || text.includes('seated') || text.includes('chair')) return POSE_STATES.SITTING;
    if (text.includes('lean')) return POSE_STATES.LEANING;
    if (text.includes('crouch') || text.includes('kneel')) return POSE_STATES.CROUCHING;
    if (text.includes('lie') || text.includes('lying') || text.includes('bed')) return POSE_STATES.LYING;
    if (text.includes('fight') || text.includes('punch') || text.includes('attack')) return POSE_STATES.FIGHTING;
    if (text.includes('reach') || text.includes('grab')) return POSE_STATES.REACHING;
    if (text.includes('turn') || text.includes('spin')) return POSE_STATES.TURNING;
    return POSE_STATES.STANDING;
  }

  // Character-specific: look for the character's name near an action verb
  const nameIdx = text.indexOf(name);
  if (nameIdx >= 0) {
    const context = text.slice(nameIdx, nameIdx + 200);
    if (context.includes('run')) return POSE_STATES.RUNNING;
    if (context.includes('walk') || context.includes('step') || context.includes('strut')) return POSE_STATES.WALKING;
    if (context.includes('sit') || context.includes('seated') || context.includes('chair')) return POSE_STATES.SITTING;
    if (context.includes('lean')) return POSE_STATES.LEANING;
    if (context.includes('crouch') || context.includes('kneel')) return POSE_STATES.CROUCHING;
    if (context.includes('lie') || context.includes('lying') || context.includes('bed')) return POSE_STATES.LYING;
    if (context.includes('reach') || context.includes('grab') || context.includes('extend')) return POSE_STATES.REACHING;
    if (context.includes('turn') || context.includes('spin')) return POSE_STATES.TURNING;
  }

  return POSE_STATES.STANDING;
}

/**
 * Build a pose progression map for each character across all shots in a scene.
 * Returns: { characterName: [{ shotIndex, pose, isContinuation }] }
 */
function _buildPoseProgression(scene) {
  const shots = scene.shots || [];
  const progression = {};

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const chars = shot.characters_in_shot || [];

    for (const charName of chars) {
      const key = String(charName).toLowerCase();
      if (!progression[key]) progression[key] = [];

      const pose = _inferPose(shot, charName);
      const prevEntry = progression[key][progression[key].length - 1];
      const isContinuation = prevEntry && prevEntry.pose === pose;

      progression[key].push({
        shotIndex: i,
        pose,
        isContinuation,
        prevPose: prevEntry?.pose || null,
      });
    }
  }

  return progression;
}

// ── Visual reset detection ─────────────────────────────────────────────────────

/**
 * Detect potential visual resets between consecutive shots in the same scene.
 * A visual reset is any discontinuity in:
 *   - Location (should never change within a scene)
 *   - Lighting (should remain consistent unless a narrative reason exists)
 *   - Costume (characters don't change clothes mid-scene)
 *   - Time of day (doesn't change within a single scene)
 *
 * Returns an array of warnings for shots that have reset risk.
 */
function _detectVisualResets(scene) {
  const shots = scene.shots || [];
  const warnings = [];

  const baseLocation = scene.location || '';
  const baseLighting = scene.lighting_design || '';

  for (let i = 1; i < shots.length; i++) {
    const shot = shots[i];
    const prevShot = shots[i - 1];

    // Check for environment description changes
    const shotEnv = (shot.image_prompt || '').toLowerCase();
    const prevEnv = (prevShot.image_prompt || '').toLowerCase();

    // Detect costume changes (color words that differ)
    const costumeKeywords = ['wearing', 'dress', 'shirt', 'jacket', 'coat', 'uniform', 'suit'];
    const shotCostume = costumeKeywords.filter(k => shotEnv.includes(k));
    const prevCostume = costumeKeywords.filter(k => prevEnv.includes(k));

    if (shotCostume.length > 0 && prevCostume.length > 0) {
      const shotColors = _extractColorWords(shotEnv);
      const prevColors = _extractColorWords(prevEnv);
      const colorDiff = shotColors.filter(c => !prevColors.includes(c));
      if (colorDiff.length > 0) {
        warnings.push({
          shotIndex: i,
          type: 'costume_change',
          message: `Potential costume color change from shot ${i} to ${i + 1}: new colors ${colorDiff.join(', ')}`,
        });
      }
    }

    // Detect lighting changes
    const shotLighting = _extractLightingWords(shotEnv);
    const prevLighting = _extractLightingWords(prevEnv);
    if (shotLighting.length > 0 && prevLighting.length > 0) {
      const lightDiff = shotLighting.filter(l => !prevLighting.includes(l));
      if (lightDiff.length > 0) {
        warnings.push({
          shotIndex: i,
          type: 'lighting_change',
          message: `Lighting shift detected from shot ${i} to ${i + 1}: new lighting ${lightDiff.join(', ')}`,
        });
      }
    }
  }

  return warnings;
}

function _extractColorWords(text) {
  const colors = [
    'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'black',
    'white', 'gray', 'grey', 'brown', 'navy', 'crimson', 'teal', 'gold',
    'silver', 'beige', 'maroon', 'olive', 'cyan', 'magenta',
  ];
  return colors.filter(c => new RegExp(`\\b${c}\\b`, 'i').test(text));
}

function _extractLightingWords(text) {
  const lightingTerms = [
    'bright', 'dark', 'shadow', 'glow', 'dim', 'harsh', 'soft light',
    'candlelight', 'moonlight', 'sunlight', 'neon', 'fluorescent',
    'firelight', 'lamp', 'overhead',
  ];
  return lightingTerms.filter(l => text.includes(l));
}

// ── Face identity enforcement ───────────────────────────────────────────────────

/**
 * Build face identity directives for each shot.
 * Ensures the same character uses the same reference image and identity lock
 * across all shots in a scene.
 *
 * Returns a directive string injected into the image prompt that tells the
 * generator: "This is the SAME person as the previous shot — same face,
 * same hair, same clothing. Do not regenerate a different person."
 */
function _buildFaceIdentityDirective(shot, prevShot, charName) {
  const parts = [];

  if (prevShot) {
    const prevChars = (prevShot.characters_in_shot || []).map(c => String(c).toLowerCase());
    if (prevChars.includes(String(charName).toLowerCase())) {
      parts.push(`SAME PERSON as previous shot — identical face, hair, skin tone, and clothing as ${charName} in the prior frame. No identity drift. No new person.`);
    }
  }

  // Pose progression directive
  const currentPose = _inferPose(shot, charName);
  if (prevShot) {
    const prevPose = _inferPose(prevShot, charName);
    if (currentPose === prevPose) {
      parts.push(`${charName} maintains the same ${currentPose} pose from the previous shot — natural micro-movement only, no pose reset.`);
    } else {
      parts.push(`${charName} transitions from ${prevPose} to ${currentPose} — show natural pose progression, not an instant teleport.`);
    }
  }

  return parts.join(' ');
}

// ── Main: apply temporal consistency to all scenes ─────────────────────────────

/**
 * Apply temporal consistency directives to every shot in every scene.
 * Attaches `_temporal_directive` to each shot.
 *
 * @param {Object} script - The episode script (mutated in place)
 * @returns {Object} The mutated script
 */
function applyTemporalConsistency(script) {
  if (!script || !script.scenes) return script;

  let totalDirectives = 0;
  let totalWarnings = 0;

  for (const scene of script.scenes) {
    const shots = scene.shots || [];
    if (shots.length === 0) continue;

    // Build pose progression for this scene
    const poseProgression = _buildPoseProgression(scene);

    // Detect visual resets
    const resetWarnings = _detectVisualResets(scene);
    totalWarnings += resetWarnings.length;

    // Log warnings
    for (const w of resetWarnings) {
      console.warn(`[TemporalConsistency] Scene ${scene.scene_number} shot ${w.shotIndex + 1}: ${w.message}`);
    }

    // Attach temporal directives to each shot
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const prevShot = i > 0 ? shots[i - 1] : null;
      const chars = shot.characters_in_shot || [];

      const directives = [];

      // Face identity + pose progression for each character
      for (const charName of chars) {
        const faceDirective = _buildFaceIdentityDirective(shot, prevShot, charName);
        if (faceDirective) directives.push(faceDirective);
      }

      // Environment continuity (no visual resets)
      if (prevShot) {
        directives.push('Same environment, same location, same time of day, same background as the previous shot. No visual reset. No environment change.');
      }

      // Visual reset warning (if detected)
      const shotWarning = resetWarnings.find(w => w.shotIndex === i);
      if (shotWarning) {
        directives.push(`WARNING: ${shotWarning.message} — maintain continuity from the previous shot unless the script explicitly calls for a change.`);
      }

      if (directives.length > 0) {
        shot._temporal_directive = directives.join(' ');
        totalDirectives++;
      }
    }
  }

  console.log(
    `[TemporalConsistency] Applied ${totalDirectives} temporal directives, detected ${totalWarnings} visual reset warnings`
  );
  return script;
}

module.exports = {
  applyTemporalConsistency,
  POSE_STATES,
  // Exported for testing
  _inferPose,
  _buildPoseProgression,
  _detectVisualResets,
  _buildFaceIdentityDirective,
};
