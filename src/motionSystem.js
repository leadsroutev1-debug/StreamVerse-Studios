'use strict';

/**
 * StreamVerse Studios — Semantic Motion System
 *
 * This module turns raw shot intent into structured motion that behaves more
 * like a film director's blocking plan than a generic "add movement" hint.
 *
 * Core goals:
 *   1. Preserve the existing `_motion_params` contract.
 *   2. Distinguish camera motion from CHARACTER / VEHICLE / PROP motion.
 *   3. Treat travel as a causal sequence:
 *        origin → departure → transit → approach → arrival
 *      instead of teleporting a character directly to the destination.
 *   4. Preserve conversational performance when multiple characters share a shot.
 *   5. Keep dialogue, listening, reactions, eye-lines and physical blocking alive
 *      during movement.
 *   6. Produce a provider-safe `videoPrompt` that downstream Agnes/LTX adapters
 *      can use without needing to infer the semantic action from scratch.
 *
 * The system remains deliberately backward compatible:
 *   - Existing motionType / motionDirection / motionSpeed / motionEasing remain.
 *   - `subjectMotion`, `ambientMotion`, `lipSync`, `mhMotionLevel` remain.
 *   - New semantic fields are additive and attached to `_motion_params`.
 */

const ttsGen = require('./ttsGen');

// =============================================================================
// NORMALIZATION HELPERS
// =============================================================================

function _text(value) {
  return String(value == null ? '' : value).trim();
}

function _norm(value) {
  return _text(value).toLowerCase().replace(/\s+/g, ' ');
}

function _hasAny(text, needles) {
  const value = _norm(text);
  return needles.some(needle => value.includes(needle));
}

function _firstNonEmpty(...values) {
  for (const value of values) {
    const text = _text(value);
    if (text) return text;
  }
  return '';
}

function _getShotText(shot = {}) {
  return [
    shot.dialogue_or_action,
    shot.subject_motion,
    shot.action_sequence,
    shot.action_progression,
    shot.temporal_arc,
    shot.end_frame_state,
    shot.end_frame_transition,
    shot.next_shot_continuity,
    shot.shot_description,
    shot.scene_environment,
    shot.image_prompt,
    shot._scene_description,
    shot._scene_location,
    shot.location,
  ].filter(Boolean).join(' ');
}

// =============================================================================
// MOTION INTENSITY
// =============================================================================

/**
 * Map motion_level into a 0..1 intensity.
 */
function _levelToIntensity(level) {
  const l = _norm(level || 'medium');

  if (l === 'low') return 0.25;
  if (l === 'medium') return 0.5;
  if (l === 'high') return 0.8;

  const n = Number.parseFloat(l);
  if (Number.isFinite(n)) {
    return Math.min(Math.max(n, 0), 1);
  }

  return 0.5;
}

/**
 * Map numeric intensity to a provider-compatible motion level.
 */
function _intensityToMHLevel(intensity) {
  const n = Number.isFinite(Number(intensity)) ? Number(intensity) : 0.5;
  if (n <= 0.33) return 'low';
  if (n <= 0.66) return 'medium';
  return 'high';
}

// =============================================================================
// CAMERA MOTION
// =============================================================================

function _classifyMotion(cameraMovement) {
  const cm = _norm(cameraMovement || 'static');

  if (!cm || cm === 'static' || cm === 'none' || cm === 'locked') {
    return { type: 'static', direction: 'none' };
  }

  if (_hasAny(cm, ['push in', 'push-in', 'dolly in', 'move toward', 'creep forward'])) {
    return { type: 'dolly', direction: 'forward' };
  }

  if (_hasAny(cm, ['pull out', 'pull-out', 'dolly out', 'move away', 'back away'])) {
    return { type: 'dolly', direction: 'backward' };
  }

  if (_hasAny(cm, ['zoom in', 'zoom-in'])) {
    return { type: 'zoom', direction: 'forward' };
  }

  if (_hasAny(cm, ['zoom out', 'zoom-out'])) {
    return { type: 'zoom', direction: 'backward' };
  }

  if (_hasAny(cm, ['pan left'])) {
    return { type: 'pan', direction: 'left' };
  }

  if (_hasAny(cm, ['pan right'])) {
    return { type: 'pan', direction: 'right' };
  }

  if (_hasAny(cm, ['tilt up', 'tilt-up'])) {
    return { type: 'tilt', direction: 'up' };
  }

  if (_hasAny(cm, ['tilt down', 'tilt-down'])) {
    return { type: 'tilt', direction: 'down' };
  }

  if (_hasAny(cm, ['crane up', 'crane-up', 'rise'])) {
    return { type: 'crane', direction: 'up' };
  }

  if (_hasAny(cm, ['crane down', 'crane-down', 'descend'])) {
    return { type: 'crane', direction: 'down' };
  }

  if (_hasAny(cm, ['handheld', 'drift', 'floating', 'organic handheld'])) {
    return { type: 'handheld', direction: 'organic' };
  }

  if (_hasAny(cm, ['orbit left', 'arc left'])) {
    return { type: 'orbit', direction: 'left' };
  }

  if (_hasAny(cm, ['orbit right', 'arc right'])) {
    return { type: 'orbit', direction: 'right' };
  }

  if (_hasAny(cm, ['track left', 'tracking left', 'truck left'])) {
    return { type: 'tracking', direction: 'left' };
  }

  if (_hasAny(cm, ['track right', 'tracking right', 'truck right'])) {
    return { type: 'tracking', direction: 'right' };
  }

  if (_hasAny(cm, ['track forward', 'follow forward', 'follow subject', 'tracking forward'])) {
    return { type: 'tracking', direction: 'forward' };
  }

  if (_hasAny(cm, ['track backward', 'follow backward', 'tracking backward'])) {
    return { type: 'tracking', direction: 'backward' };
  }

  return { type: 'static', direction: 'none' };
}

function _deriveMotionSpeed(shotPacingType, intensity, semanticMotion = 'none') {
  const pt = _norm(shotPacingType || 'action');

  if (semanticMotion === 'driving_fast' || semanticMotion === 'running') {
    return 'fast';
  }

  if (semanticMotion === 'driving' || semanticMotion === 'walking' || semanticMotion === 'approaching') {
    return pt === 'slow_dramatic' ? 'slow' : intensity >= 0.65 ? 'fast' : 'medium';
  }

  if (pt === 'hook' || pt === 'action') return 'fast';
  if (pt === 'slow_dramatic' || pt === 'establishing') return 'slow';
  if (pt === 'reaction' || pt === 'broll_cutaway') return 'medium';
  if (pt === 'dialogue_mid' || pt === 'dialogue_full') return 'slow';

  if (intensity >= 0.7) return 'fast';
  if (intensity <= 0.3) return 'slow';
  return 'medium';
}

function _deriveEasing(motionType, motionDirection) {
  if (motionType === 'static') return 'none';
  if (motionType === 'handheld') return 'none';

  if (motionDirection === 'forward') return 'easeOut';
  if (motionDirection === 'backward') return 'easeIn';

  if (['pan', 'tilt', 'crane', 'tracking', 'orbit'].includes(motionType)) {
    return 'easeInOut';
  }

  return 'easeInOut';
}

// =============================================================================
// SEMANTIC SUBJECT / TRAVEL CLASSIFICATION
// =============================================================================

const WALK_WORDS = [
  'walk', 'walking', 'walks', 'stroll', 'strolling', 'step', 'steps',
  'crosses', 'crossing', 'heads toward', 'heads to', 'makes his way',
  'makes her way', 'moves toward', 'moves to', 'approaches on foot',
];

const RUN_WORDS = [
  'run', 'running', 'runs', 'sprints', 'sprinting', 'rushes', 'rushing',
  'hurries', 'hurrying', 'flees', 'fleeing', 'chases', 'chasing',
];

const DRIVE_WORDS = [
  'drive', 'driving', 'drives', 'car', 'vehicle', 'taxi', 'cab',
  'steering wheel', 'engine', 'pulls away', 'pulling away', 'gets behind the wheel',
  'starts the car', 'starts the engine', 'drives toward', 'drives to',
];

const RIDE_WORDS = [
  'rides', 'riding', 'bus', 'train', 'subway', 'tram', 'motorcycle',
  'bike', 'bicycle', 'passenger seat', 'aboard', 'inside the train',
];

const ENTER_WORDS = [
  'enters', 'entering', 'gets into', 'get into', 'steps inside',
  'boards', 'boarding', 'climbs into', 'climbs aboard',
];

const EXIT_WORDS = [
  'exits', 'exiting', 'gets out', 'get out', 'steps out', 'leaves the car',
  'leaves the vehicle', 'disembarks', 'gets off', 'steps onto the platform',
];

const APPROACH_WORDS = [
  'approaches', 'approach', 'draws near', 'comes closer', 'moves closer',
  'walks toward', 'walks to', 'drives toward', 'heads toward',
];

const DEPART_WORDS = [
  'leaves', 'leaving', 'departs', 'departure', 'walks away',
  'drives away', 'pulls away', 'heads out', 'heads off', 'sets off',
];

const WAIT_WORDS = [
  'waits', 'waiting', 'stands by', 'stays', 'remains',
];

const INTERACT_WORDS = [
  'opens', 'closes', 'grabs', 'takes', 'picks up', 'puts down',
  'touches', 'holds', 'hands', 'passes', 'hands over', 'turns the key',
  'pulls the lever', 'presses', 'pushes', 'unlocks', 'locks',
];

function _hasTravelLanguage(text) {
  return _hasAny(text, [
    ...WALK_WORDS,
    ...RUN_WORDS,
    ...DRIVE_WORDS,
    ...RIDE_WORDS,
    ...ENTER_WORDS,
    ...EXIT_WORDS,
    ...APPROACH_WORDS,
    ...DEPART_WORDS,
  ]);
}

function _containsDeparture(text) {
  return _hasAny(text, DEPART_WORDS);
}

function _containsApproach(text) {
  return _hasAny(text, APPROACH_WORDS);
}

function _containsArrival(text) {
  return _hasAny(text, [
    'arrives', 'arrival', 'reaches the destination', 'reaches the station',
    'reaches the office', 'reaches the building', 'arrives at',
    'arrives outside', 'pulls up', 'parks', 'stops at',
  ]);
}

function _inferTravelStage(shot = {}) {
  const explicitStage = _norm(
    _firstNonEmpty(
      shot.travel_stage,
      shot.location_transition_stage,
      shot.motion_stage,
      shot._travel_stage
    )
  );

  if (explicitStage) {
    if (['origin', 'departure', 'transit', 'approach', 'arrival', 'completed'].includes(explicitStage)) {
      return explicitStage;
    }
  }

  const text = _getShotText(shot);

  if (_containsArrival(text)) return 'arrival';
  if (_containsApproach(text)) return 'approach';
  if (_containsDeparture(text) || _hasAny(text, ENTER_WORDS) || _hasAny(text, EXIT_WORDS)) return 'departure';
  if (_hasTravelLanguage(text)) return 'transit';

  return 'none';
}

function _inferTravelMode(shot = {}, text = '') {
  const explicit = _norm(_firstNonEmpty(
    shot.travel_mode,
    shot.transport_mode,
    shot.vehicle_motion
  ));

  if (explicit) {
    if (explicit.includes('drive') || explicit.includes('car') || explicit.includes('vehicle')) {
      return 'driving';
    }
    if (explicit.includes('run')) return 'running';
    if (explicit.includes('walk') || explicit.includes('foot')) return 'walking';
    if (explicit.includes('train') || explicit.includes('bus') || explicit.includes('ride') || explicit.includes('transit')) {
      return 'riding';
    }
    if (explicit.includes('enter')) return 'entering';
    if (explicit.includes('exit')) return 'exiting';
    if (explicit.includes('approach')) return 'approaching';
    if (explicit.includes('wait')) return 'waiting';
  }

  if (_hasAny(text, DRIVE_WORDS)) {
    if (_hasAny(text, ['fast', 'speeding', 'races', 'accelerates', 'slams the accelerator'])) {
      return 'driving_fast';
    }
    return 'driving';
  }

  if (_hasAny(text, RUN_WORDS)) return 'running';
  if (_hasAny(text, RIDE_WORDS)) return 'riding';
  if (_hasAny(text, ENTER_WORDS)) return 'entering';
  if (_hasAny(text, EXIT_WORDS)) return 'exiting';
  if (_hasAny(text, APPROACH_WORDS)) return 'approaching';
  if (_hasAny(text, WALK_WORDS)) return 'walking';
  if (_hasAny(text, WAIT_WORDS)) return 'waiting';

  return 'none';
}

function _inferSemanticMotion(shot = {}) {
  const text = _getShotText(shot);
  const stage = _inferTravelStage(shot);
  const mode = _inferTravelMode(shot, text);

  // More specific semantic states win over generic travel.
  if (mode === 'entering') return 'entering';
  if (mode === 'exiting') return 'exiting';
  if (mode === 'driving_fast') return 'driving_fast';
  if (mode === 'driving') return 'driving';
  if (mode === 'running') return 'running';
  if (mode === 'riding') return 'riding';
  if (mode === 'walking') return 'walking';
  if (mode === 'approaching') return 'approaching';

  if (stage === 'departure') return 'departing';
  if (stage === 'transit') return 'transit';
  if (stage === 'approach') return 'approaching';
  if (stage === 'arrival') return 'arriving';

  if (_hasAny(text, INTERACT_WORDS)) return 'interacting';
  if (_hasAny(text, WAIT_WORDS)) return 'waiting';

  return 'none';
}

function _deriveSubjectMotion(shot) {
  const pt = _norm(shot.shot_pacing_type || 'action');
  const hasDialogue = _hasAny(shot.dialogue_or_action || '', ['"']);
  const emotion = _norm(shot.emotional_subtext || '');
  const semanticMotion = _inferSemanticMotion(shot);

  // Semantic locomotion always takes precedence over generic dialogue motion.
  if (['walking', 'approaching', 'departing', 'transit', 'arriving'].includes(semanticMotion)) {
    return 'active';
  }

  if (semanticMotion === 'running' || semanticMotion === 'driving' || semanticMotion === 'driving_fast') {
    return 'intense';
  }

  if (semanticMotion === 'riding') {
    return 'active';
  }

  if (semanticMotion === 'entering' || semanticMotion === 'exiting') {
    return 'active';
  }

  if (hasDialogue && ['dialogue_mid', 'dialogue_full'].includes(pt)) {
    return 'subtle';
  }

  if (pt === 'action' || pt === 'hook') {
    if (_hasAny(emotion, ['rage', 'panic', 'fight', 'chase', 'terror', 'desperate'])) {
      return 'intense';
    }
    return 'active';
  }

  if (pt === 'reaction') return 'subtle';
  if (pt === 'slow_dramatic') return 'still';
  if (pt === 'establishing') return 'still';

  return 'subtle';
}

// =============================================================================
// ENVIRONMENTAL MOTION
// =============================================================================

function _deriveAmbientMotion(shot) {
  const pt = _norm(shot.shot_pacing_type || 'action');
  const env = [
    shot._scene_description || '',
    shot._scene_location || '',
    shot.scene_environment || '',
    shot.image_prompt || '',
    shot.environmental_story_beat || '',
  ].join(' ').toLowerCase();

  if (_hasAny(env, ['storm', 'thunderstorm', 'heavy rain', 'windstorm', 'snowstorm'])) {
    return 'dynamic';
  }

  if (_hasAny(env, ['rain', 'wind', 'waves', 'ocean', 'river', 'waterfall', 'traffic', 'crowd', 'cars passing'])) {
    return 'dynamic';
  }

  if (_hasAny(env, ['water', 'lake', 'fog', 'mist', 'smoke', 'steam', 'trees', 'leaves', 'curtain'])) {
    return 'gentle';
  }

  if (_hasAny(env, ['candle', 'fire', 'flame', 'neon flicker', 'fluorescent flicker'])) {
    return 'gentle';
  }

  if (['driving', 'driving_fast', 'running', 'transit'].includes(_inferSemanticMotion(shot))) {
    return 'dynamic';
  }

  if (pt === 'action' || pt === 'hook') return 'gentle';

  return 'still';
}

// =============================================================================
// DIALOGUE / CONVERSATIONAL PERFORMANCE
// =============================================================================

function _extractDialogueEntries(shot) {
  const raw = _text(shot.dialogue_or_action);
  if (!raw) return [];

  try {
    return ttsGen.extractMultiSpeakerDialogue(raw) || [];
  } catch (err) {
    console.warn(`[MotionSystem] dialogue extraction warning: ${err.message}`);
    return [];
  }
}

function _distinctSpeakers(entries) {
  const names = [];

  for (const entry of entries || []) {
    const name = _text(entry?.speaker);
    if (!name) continue;

    const key = name.toLowerCase();
    if (!names.some(existing => existing.toLowerCase() === key)) {
      names.push(name);
    }
  }

  return names;
}

function _hasMultipleSpeakers(shot) {
  const entries = _extractDialogueEntries(shot);
  return _distinctSpeakers(entries).length >= 2;
}

function _deriveLipSync(shot) {
  const entries = _extractDialogueEntries(shot);
  if (!entries.length) return false;

  const pacing = _norm(shot.shot_pacing_type);
  const phoneVoice = _norm(shot.tts_mode) === 'phone_vo';
  const phoneVisible = shot._phone_speaker_visible;

  if (phoneVoice && phoneVisible !== true) {
    return false;
  }

  // Spoken dialogue is sufficient. The old implementation required a very
  // specific pacing type, which incorrectly disabled mouth animation on
  // conversational multi-character shots.
  if (entries.length > 0 && !phoneVoice) {
    return pacing !== 'internal_monologue';
  }

  return false;
}

function _deriveConversationPerformance(shot) {
  const entries = _extractDialogueEntries(shot);
  const speakers = _distinctSpeakers(entries);

  if (!entries.length) {
    return {
      mode: 'silent',
      speakerCount: 0,
      speakers: [],
      performanceDirective: 'No dialogue. Preserve natural breathing and physical behavior; do not invent speech.',
    };
  }

  if (speakers.length >= 2) {
    return {
      mode: 'multi_character_dialogue',
      speakerCount: speakers.length,
      speakers,
      performanceDirective:
        'Real live-action conversation. Preserve chronological speaker turns. ' +
        'The speaking character visibly articulates the exact quoted words while listeners maintain eye-lines, ' +
        'natural facial reactions, weight shifts and responsive body language. Allow interruptions, pauses and ' +
        'overlapping reactions when authored. Do not narrate the scene and do not turn staging into speech.',
    };
  }

  return {
    mode: 'single_character_dialogue',
    speakerCount: speakers.length,
    speakers,
    performanceDirective:
      'Natural live-action speech. The identified speaker visibly articulates the exact quoted words with ' +
      'believable breathing, facial acting and body movement. Listening characters react naturally if present.',
  };
}

// =============================================================================
// SPATIAL / TRAVEL CONTINUITY
// =============================================================================

function _stagingRows(shot) {
  try {
    return shotStaging.getShotCharacterStaging
      ? shotStaging.getShotCharacterStaging(shot, shot.characters || shot._characters || [])
      : [];
  } catch (_) {
    return [];
  }
}

function _extractCharacterNames(shot) {
  const names = [];

  const candidates = [
    ...(Array.isArray(shot.characters_in_shot) ? shot.characters_in_shot : []),
    ...(Array.isArray(shot.character_staging) ? shot.character_staging.map(row => row?.name) : []),
  ];

  for (const raw of candidates) {
    const name = _text(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!names.some(existing => existing.toLowerCase() === key)) {
      names.push(name);
    }
  }

  return names;
}

function _buildTravelDirective(shot, semanticMotion, travelStage, travelMode) {
  const origin = _firstNonEmpty(
    shot.origin_location,
    shot.travel_origin,
    shot.from_location,
    shot.previous_location
  );

  const destination = _firstNonEmpty(
    shot.destination_location,
    shot.travel_destination,
    shot.to_location,
    shot.next_location
  );

  const routeBeat = _firstNonEmpty(
    shot.route_beat,
    shot.travel_route_beat,
    shot.transition_action,
    shot.spatial_transition
  );

  const actionText = _firstNonEmpty(
    shot.subject_motion,
    shot.action_sequence,
    shot.action_progression,
    shot.temporal_arc,
    shot.dialogue_or_action
  );

  const pieces = [];

  if (travelStage !== 'none' || semanticMotion !== 'none') {
    pieces.push(`Travel stage: ${travelStage}.`);
  }

  if (travelMode !== 'none') {
    pieces.push(`Travel mode: ${travelMode}.`);
  }

  if (origin) {
    pieces.push(`Origin: ${origin}.`);
  }

  if (destination) {
    pieces.push(`Destination: ${destination}.`);
  }

  if (routeBeat) {
    pieces.push(`Route beat: ${routeBeat}.`);
  }

  if (actionText && ['transit', 'walking', 'running', 'driving', 'driving_fast', 'riding', 'approaching', 'departing', 'entering', 'exiting', 'arriving'].includes(semanticMotion)) {
    pieces.push(`Visible progression: ${actionText}.`);
  }

  if (['transit', 'walking', 'running', 'driving', 'driving_fast', 'riding'].includes(semanticMotion)) {
    pieces.push(
      'Do not teleport the character or vehicle. Show continuous physical progression through the space; ' +
      'movement must visibly carry the subject from the established position toward the destination.'
    );
  }

  if (semanticMotion === 'approaching' || semanticMotion === 'arriving') {
    pieces.push(
      'Approach the destination progressively. Do not begin with the subject already occupying the destination state.'
    );
  }

  if (semanticMotion === 'departing') {
    pieces.push(
      'Begin from the established origin state, show the departure action, then carry the subject physically away from that state.'
    );
  }

  if (semanticMotion === 'entering') {
    pieces.push(
      'Show the transition into the vehicle/building/space rather than placing the character already inside.'
    );
  }

  if (semanticMotion === 'exiting') {
    pieces.push(
      'Show the character completing the exit from the established vehicle/building/space into the next spatial state.'
    );
  }

  return pieces.join(' ');
}

function _deriveContinuityEnvelope(shot, semanticMotion, travelStage, travelMode) {
  const previous = _firstNonEmpty(
    shot.previous_shot_continuity,
    shot.start_frame_state,
    shot.next_shot_continuity,
    shot._previous_end_frame_state
  );

  const current = _firstNonEmpty(
    shot.end_frame_state,
    shot.end_frame_transition
  );

  const handoff = _firstNonEmpty(
    shot.end_frame_transition,
    shot.next_shot_continuity
  );

  return {
    startState: previous,
    endState: current,
    handoff,
    requiresTravelContinuity: ['transit', 'walking', 'running', 'driving', 'driving_fast', 'riding', 'approaching', 'departing', 'entering', 'exiting', 'arriving'].includes(semanticMotion),
    travelStage,
    travelMode,
  };
}

// =============================================================================
// VIDEO PROMPT ASSEMBLY
// =============================================================================

function _buildVideoPrompt(motionParams, shot, cameraSimData) {
  const parts = [];

  const conversation = motionParams.conversation;
  const dialogueEntries = motionParams.dialogueEntries;

  // ---------------------------------------------------------------------------
  // 1. Highest-priority conversational contract
  // ---------------------------------------------------------------------------

  if (dialogueEntries.length) {
    for (const { speaker, text } of dialogueEntries) {
      if (!text) continue;

      const who = speaker || 'Speaker';

      parts.push(
        `${who} visibly speaks the exact quoted words naturally and conversationally: "${text}".`
      );
    }

    if (conversation.mode === 'multi_character_dialogue') {
      parts.push(
        `MULTI-CHARACTER CONVERSATION: ${conversation.speakers.join(' and ')} remain visibly present where staged; ` +
        'preserve chronological turns, listening reactions, eye-lines and body language. ' +
        'Do not replace this exchange with narration.'
      );
    } else {
      parts.push(conversation.performanceDirective);
    }
  } else {
    parts.push(
      'No dialogue. No speech. No mouth movement beyond natural breathing or non-speech facial expression.'
    );
  }

  parts.push(
    'NO captions, subtitles, title cards, watermarks, logos, or on-screen text.'
  );

  // ---------------------------------------------------------------------------
  // 2. Semantic story-world movement
  // ---------------------------------------------------------------------------

  if (motionParams.semanticMotion !== 'none') {
    parts.push(motionParams.semanticMotionDirective);
  }

  if (motionParams.continuity.requiresTravelContinuity) {
    parts.push(
      'CONTINUITY RULE: start from the established opening geography and animate the physical cause-and-effect ' +
      'between the opening and ending states. Never cut the subject across space inside the same continuous shot.'
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Camera movement
  // ---------------------------------------------------------------------------

  if (motionParams.motionType === 'static') {
    if (motionParams.subjectMotion === 'still') {
      parts.push('Camera locked. Preserve the composed frame while subtle human/environmental motion remains alive.');
    } else {
      parts.push('Camera mostly locked. Let the subjects and environment provide the primary movement.');
    }
  } else {
    const dir = motionParams.motionDirection !== 'none'
      ? ` ${motionParams.motionDirection}`
      : '';

    parts.push(
      `Camera motion: ${motionParams.motionType}${dir}, ${motionParams.motionSpeed} speed, ${motionParams.motionEasing} easing.`
    );
  }

  // ---------------------------------------------------------------------------
  // 4. Subject motion
  // ---------------------------------------------------------------------------

  switch (motionParams.subjectMotion) {
    case 'still':
      parts.push(
        'Subject remains physically settled; allow only breathing, blinking, eye movement and subtle micro-expression.'
      );
      break;

    case 'subtle':
      parts.push(
        'Subject performs natural small-scale movement: breathing, blinking, head turns, weight shifts, gestures and responsive listening.'
      );
      break;

    case 'active':
      parts.push(
        'Subject performs purposeful continuous movement: stepping, walking, turning, reaching, approaching, entering or interacting as established by the scene.'
      );
      break;

    case 'intense':
      parts.push(
        'Subject performs sustained full-body movement with believable momentum, balance, acceleration and deceleration.'
      );
      break;
  }

  // ---------------------------------------------------------------------------
  // 5. Ambient motion
  // ---------------------------------------------------------------------------

  switch (motionParams.ambientMotion) {
    case 'still':
      parts.push('Environment remains mostly still; preserve continuity of static architecture and props.');
      break;

    case 'gentle':
      parts.push('Environment has gentle natural motion such as light flicker, subtle wind, drifting vapor or small background activity.');
      break;

    case 'dynamic':
      parts.push('Environment has coherent dynamic motion such as rain, traffic, crowd flow, moving water or vehicle movement.');
      break;
  }

  // ---------------------------------------------------------------------------
  // 6. Dialogue body performance
  // ---------------------------------------------------------------------------

  if (motionParams.lipSync) {
    parts.push(
      'Lip-sync active. Mouth shapes, jaw movement and facial muscles must visibly match the correct speaker and spoken words.'
    );
  }

  if (conversation.mode === 'multi_character_dialogue') {
    parts.push(
      'During dialogue, listening characters remain alive: eye contact, small reactions, breathing, posture shifts, ' +
      'glances, interruptions and emotional response should continue rather than freezing into a talking photograph.'
    );
  }

  // ---------------------------------------------------------------------------
  // 7. Music / camera metadata
  // ---------------------------------------------------------------------------

  if (shot._music_direction) {
    parts.push(
      `MUSIC (same episode direction; do not change genre/instrumentation): ${shot._music_direction}`
    );
  }

  if (cameraSimData?.focalLength) {
    const fl = cameraSimData.focalLength;
    parts.push(
      `Lens: ${fl.focalLengthMm}mm, ${fl.dof}.`
    );
  }

  if (cameraSimData?.movementCurve && cameraSimData.movementCurve.type !== 'static') {
    parts.push(
      cameraSimData.movementCurve.description
    );
  }

  // ---------------------------------------------------------------------------
  // 8. Visual opening-frame support
  // ---------------------------------------------------------------------------
  //
  // The image prompt is ONLY supporting context. We deliberately avoid letting
  // it dominate the movement instruction because it represents a frozen image.
  //
  const rawPrompt = _text(shot.image_prompt);

  if (rawPrompt) {
    parts.push(
      `OPENING VISUAL STATE (visual only, never spoken): ${rawPrompt.slice(0, 500)}`
    );
  }

  // ---------------------------------------------------------------------------
  // 9. Explicit terminal handoff
  // ---------------------------------------------------------------------------

  if (motionParams.continuity.endState) {
    parts.push(
      `TERMINAL VISUAL STATE: ${motionParams.continuity.endState}`
    );
  }

  if (motionParams.continuity.handoff) {
    parts.push(
      `HANDOFF: ${motionParams.continuity.handoff}`
    );
  }

  return parts.join(' ');
}

// =============================================================================
// APPLY SYSTEM
// =============================================================================

function applyMotionSystem(script) {
  if (!script || !Array.isArray(script.scenes)) {
    return script;
  }

  let totalShots = 0;
  let travelShots = 0;
  let dialogueShots = 0;
  let multiSpeakerShots = 0;

  for (const scene of script.scenes) {
    const shots = Array.isArray(scene?.shots) ? scene.shots : [];

    for (const shot of shots) {
      const cameraClassification = _classifyMotion(shot.camera_movement);

      const intensity = _levelToIntensity(shot.motion_level);

      const semanticMotion = _inferSemanticMotion(shot);
      const travelStage = _inferTravelStage(shot);
      const travelMode = _inferTravelMode(shot, _getShotText(shot));

      const speed = _deriveMotionSpeed(
        shot.shot_pacing_type,
        intensity,
        semanticMotion
      );

      const easing = _deriveEasing(
        cameraClassification.type,
        cameraClassification.direction
      );

      const subjectMotion = _deriveSubjectMotion(shot);
      const ambientMotion = _deriveAmbientMotion(shot);

      const dialogueEntries = _extractDialogueEntries(shot);
      const conversation = _deriveConversationPerformance(shot);
      const lipSync = _deriveLipSync(shot);

      const charactersInShot = _extractCharacterNames(shot);
      const staging = Array.isArray(shot.character_staging)
        ? shot.character_staging
        : [];

      const continuity = _deriveContinuityEnvelope(
        shot,
        semanticMotion,
        travelStage,
        travelMode
      );

      const semanticMotionDirective = _buildTravelDirective(
        shot,
        semanticMotion,
        travelStage,
        travelMode
      );

      const motionParams = {
        // Existing contract
        motionIntensity: intensity,
        motionType: cameraClassification.type,
        motionDirection: cameraClassification.direction,
        motionSpeed: speed,
        motionEasing: easing,
        subjectMotion,
        ambientMotion,
        lipSync,
        mhMotionLevel: _intensityToMHLevel(intensity),

        // New semantic travel / action contract
        semanticMotion,
        semanticMotionDirective,
        travelStage,
        travelMode,
        originLocation: _firstNonEmpty(
          shot.origin_location,
          shot.travel_origin,
          shot.from_location,
          shot.previous_location
        ),
        destinationLocation: _firstNonEmpty(
          shot.destination_location,
          shot.travel_destination,
          shot.to_location,
          shot.next_location
        ),
        routeBeat: _firstNonEmpty(
          shot.route_beat,
          shot.travel_route_beat,
          shot.transition_action,
          shot.spatial_transition
        ),

        // Conversation contract
        conversation,
        dialogueEntries,
        charactersInShot,
        characterStaging: staging,

        // Start/end continuity
        continuity,

        // Provider-oriented flags
        isTravelShot: continuity.requiresTravelContinuity,
        isConversationalShot: dialogueEntries.length > 0,
        isMultiSpeakerShot: conversation.mode === 'multi_character_dialogue',

        // Final assembled provider prompt
        videoPrompt: '',
      };

      motionParams.videoPrompt = _buildVideoPrompt(
        motionParams,
        shot,
        shot._camera_sim
      );

      shot._motion_params = motionParams;

      // Keep a directly-addressable field for providers that already look for
      // `videoPrompt` instead of `_motion_params.videoPrompt`.
      shot.videoPrompt = motionParams.videoPrompt;

      totalShots++;

      if (motionParams.isTravelShot) travelShots++;
      if (motionParams.isConversationalShot) dialogueShots++;
      if (motionParams.isMultiSpeakerShot) multiSpeakerShots++;
    }
  }

  console.log(
    `[MotionSystem] Applied semantic motion to ${totalShots} shots | ` +
    `travel=${travelShots} | dialogue=${dialogueShots} | multiSpeaker=${multiSpeakerShots}`
  );

  return script;
}

// =============================================================================
// TEST HELPERS / EXPORTS
// =============================================================================

module.exports = {
  applyMotionSystem,

  _levelToIntensity,
  _intensityToMHLevel,
  _classifyMotion,
  _deriveMotionSpeed,
  _deriveEasing,
  _deriveSubjectMotion,
  _deriveAmbientMotion,
  _buildVideoPrompt,

  // Semantic motion helpers are exported for regression testing.
  _inferTravelStage,
  _inferTravelMode,
  _inferSemanticMotion,
  _buildTravelDirective,
  _deriveContinuityEnvelope,
  _extractDialogueEntries,
  _deriveConversationPerformance,
  _deriveLipSync,
};
