'use strict';

/**
 * StreamVerse Studios — Editorial Continuity Director
 *
 * Makes the reason for the cut explicit. FFmpeg still performs only the
 * provider-approved basic assembly; this module supplies narrative continuity
 * metadata to the scene/shot compiler.
 */

const { clean } = require('./directorState');

function chooseTransition(prevShot, shot) {
  if (!prevShot) return {
    type: 'opening',
    reason: 'establish the scene geography and dramatic state',
  };

  const prevEnd = clean(prevShot.end_frame_state || prevShot.end_state || prevShot.handoff_to_next);
  const currentStart = clean(shot.start_frame_state || shot.start_state);
  const sameLocation =
    clean(prevShot._director_state?.world?.location).toLowerCase() ===
    clean(shot._director_state?.world?.location).toLowerCase();

  if (clean(shot.travel_stage).toLowerCase() === 'arrive') {
    return {
      type: 'arrival_match',
      reason: 'complete the physical journey before handing control to the destination scene',
    };
  }

  if (clean(shot.travel_stage).toLowerCase() === 'in_transit') {
    return {
      type: 'action_match',
      reason: 'continue the same physical journey from the previous terminal travel state',
    };
  }

  if (prevShot.speaker && shot.speaker && clean(prevShot.speaker) !== clean(shot.speaker)) {
    return {
      type: 'eyeline_cut',
      reason: 'transfer audience attention through the established conversation and listener reaction',
    };
  }

  if (sameLocation && /\b(hand|reach|open|close|turn|stand|sit|walk|move)\b/i.test(currentStart)) {
    return {
      type: 'match_on_action',
      reason: 'preserve continuous physical action across the cut',
    };
  }

  if (!sameLocation) {
    return {
      type: 'spatial_reveal',
      reason: 're-establish the new geography only after the causal transition is complete',
    };
  }

  return {
    type: 'causal_cut',
    reason: clean(prevEnd || currentStart) || 'advance the dramatic beat while retaining continuity',
  };
}

function applyEditorialContinuity(script) {
  if (!script || !Array.isArray(script.scenes)) return script;
  let previous = null;

  for (const scene of script.scenes) {
    for (const shot of scene.shots || []) {
      const transition = chooseTransition(previous, shot);
      shot.editorial_transition = transition.type;
      shot.editorial_transition_reason = transition.reason;
      shot._transition_state = {
        ...shot._transition_state,
        type: transition.type,
        editorial_reason: transition.reason,
        from_state: previous ? clean(previous.end_state || previous.handoff_to_next) : '',
        to_state: clean(shot.start_state || shot.start_frame_state),
      };
      previous = shot;
    }
  }
  return script;
}

module.exports = { chooseTransition, applyEditorialContinuity };
