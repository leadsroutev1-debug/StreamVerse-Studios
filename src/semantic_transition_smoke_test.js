'use strict';

const assert = require('assert');
const http = require('http');
const Module = require('module');

const mockedVideoEngineClient = { submitJob: null };
const mockedLtxVisionDirector = {
  describeForLTX: async () => 'Connect the predecessor frame to the current settled frame with grounded causal movement.',
};

// Keep this smoke test dependency-free: it exercises the continuity contract without
// contacting Mistral, Agnes, MySQL, Cloudinary, or any other external service.
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'axios') return { get: async () => { throw new Error('network disabled in smoke test'); } };
  if (request === './config' && /src[\\/]semanticTransitionDirector\.js$/.test(parent?.filename || '')) {
    return { mistralKeys: [] };
  }
  if (request === './config' && /src[\\/]agnesVideoGen\.js$/.test(parent?.filename || '')) {
    return {};
  }
  if (request === './db' && /src[\\/]agnesVideoGen\.js$/.test(parent?.filename || '')) {
    return { execute: async () => {}, queryOne: async () => null };
  }
  if (request === './ltxVisionDirector' && /src[\\/]agnesVideoGen\.js$/.test(parent?.filename || '')) {
    return mockedLtxVisionDirector;
  }
  if (request === '../services/videoEngineClient' && /src[\\/]agnesVideoGen\.js$/.test(parent?.filename || '')) {
    return mockedVideoEngineClient;
  }
  return originalLoad.apply(this, arguments);
};

const semanticTransitionDirector = require('./semanticTransitionDirector');
const ltxVisionDirector = mockedLtxVisionDirector;
const videoEngineClient = mockedVideoEngineClient;

const previousShot = {
  scene_number: 1,
  shot_index: 1,
  characters_in_shot: ['Mara'],
  end_frame_state: 'Mara is standing beside the apartment entrance, left side foreground, facing the street, keys in her right hand.',
  next_shot_continuity: 'Mara departs for the hospital by car.',
  character_staging: [{
    name: 'Mara', screen_position: 'left', depth: 'foreground',
    pose: 'standing', facing: 'toward the street', eyeline: 'the car',
    interaction: 'holding keys', action: 'holds position at the curb',
  }],
};

const currentShot = {
  scene_number: 1,
  shot_index: 2,
  characters_in_shot: ['Mara'],
  start_frame_state: 'Mara sits in the driver seat of her car approaching the hospital entrance, right side midground, hands on the wheel.',
  image_prompt: 'Medium-wide cinematic view of Mara arriving at the hospital entrance.',
  character_staging: [{
    name: 'Mara', screen_position: 'right', depth: 'midground',
    pose: 'seated upright with both hands on the steering wheel', facing: 'forward',
    eyeline: 'hospital entrance', interaction: 'hands on steering wheel',
    action: 'settled in the driver seat',
  }],
};

const plan = semanticTransitionDirector._normalizePlan({
  transition_required: true,
  transition_type: 'drive',
  physical_bridge: 'Mara gets into the car, drives from the apartment to the hospital, and settles into the driver position shown in the target shot.',
  target_opening_state: 'Mara is seated in the driver seat at the hospital entrance, settled and ready for the next beat.',
  target_character_states: [{
    name: 'Mara', screen_position: 'right', depth: 'midground',
    pose: 'seated upright with both hands on the steering wheel', facing: 'forward',
    eyeline: 'hospital entrance', contact: 'both hands on steering wheel',
    settled_action: 'seated and stationary', movement_from_previous: 'drive',
  }],
  character_transitions: [{
    name: 'Mara', from_screen_position: 'left', from_depth: 'foreground',
    from_pose: 'standing', to_screen_position: 'right', to_depth: 'midground',
    causal_action: 'enter car and drive to hospital', reason: 'location and depth change',
  }],
  target_world_state: {
    location: 'Hospital entrance',
    lighting: 'late afternoon daylight',
    environment: 'hospital forecourt and entrance lane',
    active_props: ['car', 'keys'],
  },
  still_generation_directive: 'Freshly render the settled hospital-arrival state.',
  agnes_transition_directive: 'Physically connect the apartment curb state to the hospital driver state through a believable car departure and arrival.',
  teleport_risk: 0.02,
  continuity_notes: ['Mara remains the same person with the same wardrobe.'],
}, {
  previousShot,
  currentShot,
  characters: [{ name: 'Mara' }],
});

assert.strictEqual(plan.transition_type, 'drive');
assert.strictEqual(plan.target_character_states[0].screen_position, 'right');
const stillDirective = semanticTransitionDirector.buildStillTargetDirective(plan);
assert(stillDirective.includes('fresh still'));
assert(stillDirective.includes('Mara at right, midground'));
assert(!/\b(?:drive|walk|travel)\b/i.test(stillDirective), 'Still directive must not turn the target frame into an in-between motion frame');

const currentFrame = Buffer.from('current-shot-still');
const previousFrame = Buffer.from('previous-terminal-frame');
const server = http.createServer((req, res) => {
  if (req.url === '/previous.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(previousFrame);
    return;
  }
  res.writeHead(404);
  res.end();
});

(async () => {
  const previousSubmit = videoEngineClient.submitJob;
  const previousDescribe = ltxVisionDirector.describeForLTX;
  let observed = null;

  server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    try {
      videoEngineClient.submitJob = async args => {
        observed = args;
        return { jobId: 'simulation-job' };
      };
      ltxVisionDirector.describeForLTX = async () => 'Connect the predecessor frame to the current settled frame with grounded causal movement.';

      const agnes = require('./agnesVideoGen');
      const result = await agnes.submitVideoJob(currentFrame, {
        continuityLastFrameUrl: `http://127.0.0.1:${port}/previous.png`,
        visionPreviousEndFrameUrl: `http://127.0.0.1:${port}/previous.png`,
        visionContext: { imageMime: 'image/png', shot: currentShot },
        duration: 4,
        width: 1024,
        height: 1536,
        agnesPrompt: 'Fresh hospital-arrival opening state.',
      });

      assert.strictEqual(result.jobId, 'simulation-job');
      assert(observed, 'Expected mocked Agnes submission to be observed');
      assert.strictEqual(observed.referenceImageBuffers.length, 2, 'Sequential Agnes shot must submit two ordered keyframes');
      assert.strictEqual(observed.referenceImageBuffers[0].toString(), previousFrame.toString(), 'Keyframe A must be the previous terminal frame');
      assert.strictEqual(observed.referenceImageBuffers[1].toString(), currentFrame.toString(), 'Keyframe B must be the fresh current-shot still');
      assert.strictEqual(observed.imageBuffer.toString(), currentFrame.toString(), 'Provider primary image remains the current still');

      console.log('PASS: semantic director maps predecessor geometry to a causal target state');
      console.log('PASS: current still directive is fresh/static and excludes bridge motion');
      console.log('PASS: Agnes receives ordered keyframes [previous_end_frame, current_still]');
      console.log('PASS: provider primary image remains the fresh current-shot still');
    } finally {
      videoEngineClient.submitJob = previousSubmit;
      ltxVisionDirector.describeForLTX = previousDescribe;
      server.close();
    }
  });
})().catch(err => {
  console.error(err);
  server.close();
  process.exitCode = 1;
});
