'use strict';

/**
 * StreamVerse Studios — Physical Travel Choreography
 *
 * Guarantees that meaningful location changes have an observable route:
 * origin -> departure -> transit -> approach -> arrival.
 *
 * The module does not create a whole new story. It creates the minimum
 * physical bridge required to make authored location changes filmable.
 */

const { clean, normalizeTravelMode } = require('./directorState');

const STAGE_ORDER = Object.freeze({
  none: 0,
  prepare: 1,
  depart: 2,
  in_transit: 3,
  approach: 4,
  arrive: 5,
});

function locationOf(shot) {
  return clean(
    shot?.current_location ||
    shot?.location ||
    shot?._director_state?.world?.location
  );
}

function needsTravelBridge(previousShot, shot) {
  const prev = locationOf(previousShot);
  const next = locationOf(shot);
  if (!prev || !next || prev.toLowerCase() === next.toLowerCase()) return false;

  const mode = normalizeTravelMode(shot?.travel_mode);
  const stage = clean(shot?.travel_stage).toLowerCase();
  if (mode !== 'none') return true;
  if (['prepare','depart','in_transit','approach','arrive'].includes(stage)) return true;
  return false;
}

function stageForIndex(index, count) {
  if (count <= 1) return 'arrive';
  if (count === 2) return index === 0 ? 'depart' : 'arrive';
  if (index === 0) return 'depart';
  if (index === count - 1) return 'arrive';
  return index === count - 2 && count >= 4 ? 'approach' : 'in_transit';
}

function routeBeatFor(stage, mode, origin, destination, priorBeat = '') {
  if (stage === 'prepare') return `The character prepares to leave ${origin} while retaining the established wardrobe, props and emotional state.`;
  if (stage === 'depart') {
    if (mode === 'drive') return `The character gets into the vehicle, closes the door, starts the engine and begins leaving ${origin}.`;
    if (mode === 'ride') return `The character boards the vehicle at ${origin} and settles into the established seat as it begins moving.`;
    if (mode === 'walk') return `The character leaves ${origin} and takes the first visible steps toward ${destination}.`;
    return `The character physically departs ${origin} and begins the journey toward ${destination}.`;
  }
  if (stage === 'in_transit') {
    if (mode === 'drive') return `The vehicle is visibly moving along the route toward ${destination}.`;
    return priorBeat || `The character is visibly in transit between ${origin} and ${destination}.`;
  }
  if (stage === 'approach') {
    if (mode === 'drive') return `The vehicle turns onto the final approach to ${destination} and the destination begins to enter the character's world.`;
    return priorBeat || `The character closes the remaining distance to ${destination}.`;
  }
  if (stage === 'arrive') {
    if (mode === 'drive') return `The vehicle slows, reaches ${destination}, and stops at the arrival point.`;
    return `The character reaches ${destination} and completes the physical journey.`;
  }
  return priorBeat || `The character is visibly in transit between ${origin} and ${destination}.`;
}

function enrichTravelSequence(shots, { originLocation = '', destinationLocation = '', travelMode = 'none' } = {}) {
  const ordered = Array.isArray(shots) ? shots.slice() : [];
  if (!ordered.length) return ordered;

  const origin = clean(originLocation || ordered[0].origin_location || locationOf(ordered[0]));
  const destination = clean(destinationLocation || ordered[ordered.length - 1].destination_location || locationOf(ordered[ordered.length - 1]));
  const mode = normalizeTravelMode(travelMode || ordered.find(s => s.travel_mode)?.travel_mode);

  if (!origin || !destination || origin.toLowerCase() === destination.toLowerCase()) return ordered;

  return ordered.map((shot, index) => {
    const stage = clean(shot.travel_stage).toLowerCase();
    const effectiveStage = STAGE_ORDER[stage] ? stage : stageForIndex(index, ordered.length);
    const enriched = {
      ...shot,
      origin_location: origin,
      destination_location: destination,
      travel_mode: mode,
      travel_stage: effectiveStage,
      location_transition: 'travel',
    };

    const beat = routeBeatFor(
      effectiveStage,
      mode,
      origin,
      destination,
      shot.route_beat
    );

    enriched.route_beat = beat;
    enriched.travel_choreography = {
      stage: effectiveStage,
      mode,
      origin,
      destination,
      start_geometry: index === 0
        ? `true origin state at ${origin}`
        : `inherits the previous shot's terminal travel state`,
      movement_requirement: effectiveStage === 'in_transit' || effectiveStage === 'approach'
        ? 'visible positional change over time'
        : 'visible causal beginning or ending of movement',
    };

    if (effectiveStage !== 'arrive' && /arrive|destination/i.test(clean(enriched.start_state || enriched.image_prompt || ''))) {
      enriched.start_state = `${enriched.start_state || ''} Do not pre-show the destination; remain in the true ${effectiveStage} state of the journey.`.trim();
    }

    return enriched;
  });
}

function repairTravelTeleport(prevShot, nextShot) {
  if (!needsTravelBridge(prevShot, nextShot)) return nextShot;

  const prevLocation = locationOf(prevShot);
  const nextLocation = locationOf(nextShot);
  const stage = clean(nextShot.travel_stage).toLowerCase();

  if (stage === 'none') {
    return {
      ...nextShot,
      location_transition: 'travel',
      travel_stage: 'in_transit',
      origin_location: prevLocation,
      destination_location: nextLocation,
      travel_mode: normalizeTravelMode(nextShot.travel_mode),
      route_beat: `Physical travel continues from ${prevLocation} toward ${nextLocation}; the character has not yet arrived.`,
      start_state: `Continue from the previous terminal state while physically traveling from ${prevLocation}.`,
      end_state: `The journey remains in progress toward ${nextLocation}; arrival has not occurred yet.`,
      handoff_to_next: `Continue the physical journey toward ${nextLocation} from the current travel state.`,
    };
  }

  return nextShot;
}

module.exports = {
  STAGE_ORDER,
  needsTravelBridge,
  stageForIndex,
  enrichTravelSequence,
  repairTravelTeleport,
};
