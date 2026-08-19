'use strict';

/**
 * Semantic character-reference selection.
 *
 * Each canonical character can have up to four reference images:
 *   front, three_quarter, profile, full_body
 *
 * This module chooses the best reference FOR THE CURRENT SHOT rather than
 * blindly using array index 0. The selector is deterministic, cheap, and
 * based on the shot's semantic intent: framing, facing, pose/action, camera
 * language, eyeline, speaker focus and continuity.
 *
 * It never changes identity. It only chooses which already-locked portrait
 * best teaches the image model the character's appearance for this shot.
 */

const ANGLES = Object.freeze(['front', 'three_quarter', 'profile', 'full_body']);

const ANGLE_ALIASES = Object.freeze({
  front: ['front', 'frontal', 'head on', 'straight on', 'facing camera', 'looking into camera', 'direct to camera'],
  three_quarter: ['three quarter', 'three-quarter', '3/4', 'three fourth', 'angled', 'over shoulder', 'ots', 'over-the-shoulder'],
  profile: ['profile', 'side profile', 'side-profile', 'side view', 'side-view', 'lateral', 'silhouette'],
  full_body: ['full body', 'full-body', 'full length', 'full-length', 'wide shot', 'long shot', 'establishing', 'walking', 'standing full'],
});

function norm(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textOf(...values) {
  return norm(values.filter(v => v != null).map(v => {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  }).join(' | '));
}

function hasAny(text, terms) {
  const t = norm(text);
  return terms.some(term => t.includes(norm(term)));
}

function scoreAngle(angle, shot, char, stagingRow, previousSelection = null) {
  const framing = textOf(shot?.shot_type, shot?.framing, shot?.shot_description, shot?.shot_purpose);
  const camera = textOf(shot?.camera_type, shot?.camera_movement, shot?.focal_length_hint, shot?.camera_language);
  const action = textOf(shot?.dialogue_or_action, shot?.pose_state, stagingRow?.pose, stagingRow?.action, shot?.image_prompt);
  const facing = textOf(stagingRow?.facing, stagingRow?.eyeline, shot?.character_positions);
  const speaker = textOf(shot?.dialogue_or_action, shot?.speaker, shot?.speaking_character);
  const combined = `${framing} | ${camera} | ${action} | ${facing}`;

  let score = 0;
  const reasons = [];

  // Framing is the strongest signal because it determines how much of the
  // character should be visible in the final composition.
  if (angle === 'full_body') {
    if (hasAny(framing, ['full body', 'full-body', 'full length', 'full-length', 'long shot', 'wide shot', 'establishing', 'medium wide', 'medium-long', 'wide framing'])) {
      score += 48; reasons.push('full-body/wide framing');
    }
    if (hasAny(action, ['walk', 'walking', 'run', 'running', 'stands', 'standing', 'sit', 'sitting', 'kneel', 'kneeling', 'turn around', 'enters', 'exits'])) {
      score += 10; reasons.push('body-action benefits from full-body view');
    }
  }

  if (angle === 'front') {
    if (hasAny(framing, ['front-facing', 'head-on', 'head on', 'frontal', 'portrait', 'close-up', 'close up', 'extreme close', 'ecu', 'medium close', 'mcu'])) {
      score += 40; reasons.push('front-facing/portrait framing');
    }
    if (hasAny(facing, ['camera', 'toward camera', 'to camera', 'looking at camera', 'front'])) {
      score += 20; reasons.push('character faces camera');
    }
    if (hasAny(speaker, ['speaks', 'speaking', 'dialogue', 'says', 'replies', 'answers'])) {
      score += 6; reasons.push('speaker clarity');
    }
  }

  if (angle === 'three_quarter') {
    if (hasAny(framing, ['three quarter', 'three-quarter', '3/4', 'medium shot', 'medium close', 'mcu', 'two shot', 'shared composition', 'over shoulder', 'ots'])) {
      score += 42; reasons.push('angled/shared composition');
    }
    if (hasAny(facing, ['left', 'right', 'toward', 'towards', 'looking at', 'looks at', 'facing'])) {
      score += 16; reasons.push('directional eyeline');
    }
    if (hasAny(action, ['interacts', 'interaction', 'talks to', 'speaks to', 'listens', 'listening'])) {
      score += 8; reasons.push('interaction benefits from angled identity cue');
    }
  }

  if (angle === 'profile') {
    if (hasAny(framing, ['profile', 'side profile', 'side-profile', 'side view', 'side-view', 'lateral', 'silhouette', 'profile close-up'])) {
      score += 52; reasons.push('explicit profile framing');
    }
    if (hasAny(facing, ['left', 'right', 'side', 'profile', 'away from camera', 'toward background'])) {
      score += 22; reasons.push('side-facing staging');
    }
    if (hasAny(camera, ['side', 'lateral'])) {
      score += 8; reasons.push('side camera language');
    }
  }

  // Camera vocabulary can imply the useful face orientation even when the
  // script does not explicitly name the angle.
  if (angle === 'profile' && hasAny(camera, ['side angle', 'side angle shot', '90 degree', '90°'])) {
    score += 18; reasons.push('side-angle camera');
  }
  if (angle === 'three_quarter' && hasAny(camera, ['45 degree', '45°', 'diagonal'])) {
    score += 18; reasons.push('45-degree camera');
  }
  if (angle === 'front' && hasAny(camera, ['centered', 'symmetrical', 'straight-on', 'straight on'])) {
    score += 15; reasons.push('centered camera');
  }

  // Semantic actions with visible face orientation.
  if (angle === 'profile' && hasAny(action, ['phone call', 'on the phone', 'phone', 'looking out window', 'looks away', 'watching someone offscreen'])) {
    score += 7; reasons.push('side-oriented action');
  }
  if (angle === 'three_quarter' && hasAny(action, ['turns toward', 'turn toward', 'glances toward', 'looks toward', 'faces someone'])) {
    score += 11; reasons.push('turning interaction');
  }
  if (angle === 'front' && hasAny(action, ['confession', 'announcement', 'addresses camera', 'direct address'])) {
    score += 11; reasons.push('direct-address performance');
  }

  // Continuity should matter, but never override an explicit framing cue.
  if (previousSelection && previousSelection === angle) {
    score += 4;
    reasons.push('continuity with previous selected angle');
  }

  // Prefer three-quarter as a neutral general-purpose fallback, then front,
  // then profile, then full_body. This only decides ambiguous ties.
  const neutralBonus = { three_quarter: 3, front: 2, profile: 1, full_body: 0 };
  score += neutralBonus[angle] || 0;

  return { angle, score, reasons };
}

function getReferenceAngles(character) {
  const meta = character?.reference_image_meta;
  let parsed = meta;
  if (typeof meta === 'string') {
    try { parsed = JSON.parse(meta); } catch { parsed = null; }
  }

  const fromMeta = parsed?.angles && typeof parsed.angles === 'object' ? parsed.angles : {};
  const urls = Array.isArray(character?.reference_image_urls) ? character.reference_image_urls : [];
  const out = {};

  for (let i = 0; i < ANGLES.length; i++) {
    const angle = ANGLES[i];
    const url = fromMeta[angle] || urls[i] || (angle === 'front' ? character?.reference_image_url : null);
    if (url) out[angle] = url;
  }

  return out;
}

function selectCharacterReference({ character, shot, stagingRow = null, previousSelection = null }) {
  const references = getReferenceAngles(character);
  const available = Object.keys(references).filter(angle => ANGLES.includes(angle));
  if (!available.length) {
    return { url: null, angle: null, score: 0, confidence: 0, reason: 'no canonical reference image available', candidates: [] };
  }

  const scored = available
    .map(angle => scoreAngle(angle, shot, character, stagingRow, previousSelection))
    .sort((a, b) => b.score - a.score || ANGLES.indexOf(a.angle) - ANGLES.indexOf(b.angle));

  const winner = scored[0];
  const runnerUp = scored[1] || null;
  const margin = runnerUp ? winner.score - runnerUp.score : winner.score;
  const maxScore = Math.max(1, winner.score);
  const confidence = Math.max(0, Math.min(1, 0.55 + (margin / Math.max(20, maxScore)) * 0.45));

  return {
    url: references[winner.angle],
    angle: winner.angle,
    score: winner.score,
    confidence: Number(confidence.toFixed(3)),
    reason: winner.reasons.length ? winner.reasons.join('; ') : 'semantic default for current shot',
    candidates: scored.map(x => ({ angle: x.angle, score: x.score, reasons: x.reasons })),
  };
}

function buildReferenceDecisionLedger({ characters, shot, stagingRows = [], previousSelections = {} }) {
  const ledger = {};
  for (const character of Array.isArray(characters) ? characters : []) {
    const key = norm(character?.name);
    if (!key) continue;
    const stagingRow = stagingRows.find(row => norm(row?.name) === key) || null;
    ledger[key] = selectCharacterReference({
      character,
      shot,
      stagingRow,
      previousSelection: previousSelections[key] || null,
    });
  }
  return ledger;
}

module.exports = {
  ANGLES,
  getReferenceAngles,
  selectCharacterReference,
  buildReferenceDecisionLedger,
};
