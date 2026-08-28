'use strict';

const assert = require('assert');
const wardrobe = require('./hardWardrobeState');

const characters = [
  { name: 'Javier Morales', wardrobe: 'dark rain-soaked jacket, charcoal shirt, black trousers' },
  { name: 'Eleanor Voss', wardrobe: 'fitted black turtleneck, dark trousers' },
];

const script = {
  scenes: [{
    scene_number: 1,
    shots: [
      { scene_number: 1, shot_index: 1, characters_in_shot: ['Javier Morales', 'Eleanor Voss'] },
      { scene_number: 1, shot_index: 2, characters_in_shot: ['Javier Morales'], wardrobe_states: {
        'Javier Morales': 'navy wool coat, pale blue shirt, black trousers'
      }, wardrobe_change: {
        character: 'Javier Morales',
        from: 'dark rain-soaked jacket, charcoal shirt, black trousers',
        to: 'navy wool coat, pale blue shirt, black trousers',
        action: 'Javier visibly removes the rain-soaked jacket and dons the navy wool coat.'
      } },
      { scene_number: 1, shot_index: 3, characters_in_shot: ['Javier Morales'] },
    ],
  }],
};

wardrobe.applyHardWardrobeState(script, characters);
const changeShot = script.scenes[0].shots[1];
const nextShot = script.scenes[0].shots[2];

assert.strictEqual(changeShot._hard_wardrobe_state.characters['Javier Morales'], characters[0].wardrobe);
assert.strictEqual(changeShot._hard_wardrobe_state.after_characters['Javier Morales'], 'navy wool coat, pale blue shirt, black trousers');
assert.strictEqual(nextShot._hard_wardrobe_state.characters['Javier Morales'], 'navy wool coat, pale blue shirt, black trousers');
assert.match(changeShot._hard_wardrobe_directive, /opening frame must show the FROM wardrobe/i);

let threw = false;
try {
  wardrobe.applyHardWardrobeState({
    scenes: [{ scene_number: 1, shots: [
      { scene_number: 1, shot_index: 1, characters_in_shot: ['Javier Morales'] },
      { scene_number: 1, shot_index: 2, characters_in_shot: ['Javier Morales'], wardrobe_states: { 'Javier Morales': 'white suit' } },
    ] }],
  }, characters);
} catch (err) {
  threw = true;
  assert.match(err.message, /dedicated live wardrobe-change shot/i);
}
assert.strictEqual(threw, true);

console.log('[HardWardrobeSmoke] PASS');
