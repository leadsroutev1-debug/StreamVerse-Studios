'use strict';

const assert = require('assert');
const world = require('./hardSceneWorldState');

const scene1 = {
  scene_number: 1,
  location: 'Eleanor Voss brownstone',
  scene_environment: 'dim brownstone foyer with rain outside',
  persistent_props: ['scuffed cardboard box', 'brass doorknob'],
};

const scene2 = {
  scene_number: 2,
  location: 'Eleanor Voss brownstone',
  scene_environment: 'dim brownstone foyer with rain outside',
};

const scene3 = {
  scene_number: 3,
  location: 'city archive reading room',
  scene_environment: 'quiet archive with long wood tables',
};

const reuse = world.resolveSceneBackgroundContext({
  scene: scene2,
  previousScene: scene1,
  previousBackgroundUrl: 'https://example.com/scene1.jpg',
});
assert.strictEqual(reuse.reusePrevious, true);
assert.strictEqual(reuse.backgroundUrl, 'https://example.com/scene1.jpg');

const change = world.resolveSceneBackgroundContext({
  scene: scene3,
  previousScene: scene2,
  previousBackgroundUrl: 'https://example.com/scene2.jpg',
});
assert.strictEqual(change.reusePrevious, false);

const script = {
  scenes: [
    {
      ...scene1,
      shots: [
        {
          shot_index: 1,
          characters_in_shot: ['Javier Morales'],
        },
      ],
    },
    {
      ...scene2,
      shots: [
        {
          shot_index: 1,
          characters_in_shot: ['Javier Morales'],
        },
      ],
    },
  ],
};

world.applyHardSceneWorldState(script);
assert.ok(script.scenes[0].shots[0]._hard_world_directive.includes('scuffed cardboard box'));
assert.ok(script.scenes[1].shots[0]._hard_world_directive.includes('HARD ENVIRONMENT LOCK'));

console.log('[HardSceneWorldSmoke] PASS');
