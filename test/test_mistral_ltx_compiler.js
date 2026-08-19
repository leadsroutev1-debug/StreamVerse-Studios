'use strict';
const assert = require('assert');
const axios = require('axios');

let captured;
axios.post = async (_url, body) => {
  captured = body;
  return { data: { choices: [{ message: { content: JSON.stringify({
    prompt: 'Mira stands on the left facing Elias on the right. Mira slowly raises her right hand and demonstrates the sign while Elias tracks her hand and carefully imitates the movement. The camera makes the requested subtle push-in while preserving their screen geography. Mira says "No, Elias. Like this." and Elias responds with a small corrective gesture. The hallway remains stable in the background.',
    observations: 'Mira is left of frame, Elias is right of frame, and Mira has one raised hand.'
  }) } }] } };
};
const validator = require('../src/mistralVisionValidator');

(async () => {
  const image = Buffer.from('synthetic-test-image');
  const result = await validator.compileLtxVideoPrompt({
    imageBuffer: image,
    shot: {
      scene_number: 1, shot_index: 1,
      characters_in_shot: ['Mira Voss','Dr. Elias Voss'],
      dialogue_or_action: 'Mira Voss: "No, Elias. Like this."',
      subject_motion: 'Mira demonstrates the sign; Elias imitates.',
      camera: 'subtle push-in'
    },
    orderedChars: [{name:'Mira Voss',visual_anchor:'early 40s'}, {name:'Dr. Elias Voss',visual_anchor:'mid 40s'}],
    positions: [{name:'Mira Voss',screen_position:'left'}, {name:'Dr. Elias Voss',screen_position:'right'}],
    characterReferenceUrls: [],
    characterReferenceChars: []
  });
  assert.equal(result.available, true);
  assert.equal(result.authoritative, true);
  assert(result.prompt.includes('"No, Elias. Like this."'));
  assert(result.prompt.length >= 40);
  assert.equal(captured.model, process.env.MISTRAL_VISION_MODEL || 'mistral-large-2512');
  assert(captured.messages[0].content.some(x => x.type === 'image_url'));
  assert(captured.messages[0].content.some(x => x.type === 'text' && /CRITICAL OUTPUT CONTRACT/.test(x.text)));
  console.log('PASS: multimodal Mistral compiler request + authoritative output contract');
})();
