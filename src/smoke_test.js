'use strict';

const assert = require('assert');
const orchestrator = require('./directorialOrchestrator');
const constraintEnforcer = require('./constraintEnforcer');

const scene1 = {
  scene_number: 1,
  location: 'Apartment',
  shots: [{
    scene_number: 1,
    shot_index: 1,
    characters_in_shot: ['Mara'],
    start_state: 'Mara stands in the apartment with the keys.',
    end_state: 'Mara reaches the car door outside.',
  }],
};

const scene2 = {
  scene_number: 2,
  location: 'Hospital',
  origin_location: 'Apartment',
  destination_location: 'Hospital',
  location_transition: 'travel',
  travel_mode: 'drive',
  shots: [
    { scene_number: 2, shot_index: 1, characters_in_shot: ['Mara'] },
    { scene_number: 2, shot_index: 2, characters_in_shot: ['Mara'] },
    { scene_number: 2, shot_index: 3, characters_in_shot: ['Mara'] },
  ],
};

const simulation = orchestrator.applyToShotSimulation(
  { shots: [...scene1.shots, ...scene2.shots] },
  [scene1, scene2],
  { season: 1, episode: 1 }
);

const travelShots = simulation.shots.filter(s => s.scene_number === 2);
assert.deepStrictEqual(
  travelShots.map(s => s.travel_stage),
  ['depart', 'in_transit', 'arrive']
);
assert.strictEqual(travelShots[0]._director_state.world.location, 'Apartment');
assert.strictEqual(travelShots[1]._director_state.world.location, 'Apartment');
assert.strictEqual(travelShots[2]._director_state.world.location, 'Hospital');

const mismatch = {
  ...travelShots[1],
  travel_stage: 'none',
};

const violations = constraintEnforcer._validateDirectorialState(mismatch, travelShots[0]);
assert(
  violations.some(v => v.type === 'directorial_state' && v.severity === 'high'),
  'Expected contradictory travel state to be rejected'
);

console.log('PASS: StreamVerse directorial continuity smoke test');
console.log('PASS: travel trajectory = depart -> in_transit -> arrive');
console.log('PASS: origin retained until arrival');
console.log('PASS: contradictory canonical state rejected');
