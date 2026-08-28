'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pipeline = fs.readFileSync(path.join(__dirname, 'pipeline.js'), 'utf8');
const vision = fs.readFileSync(path.join(__dirname, 'ltxVisionDirector.js'), 'utf8');

assert.match(
  pipeline,
  /Still continuity audit FAILED[\s\S]*imageReuseUrl = null[\s\S]*pendingContinuityRepair = corrected \|\| reasons/s,
  'A failed still continuity audit must clear image reuse and carry an explicit continuity repair.'
);
assert.match(
  pipeline,
  /continuityRepairInstruction: continuityRepair/,
  'Continuity repairs must re-enter multimodal still authoring.'
);
assert.match(
  pipeline,
  /onImageGenerated\(imageBuffer, imageReuseUrl\)/,
  'Successful stills must remain persisted through the existing callback.'
);
assert.match(
  pipeline,
  /Persist the current still only AFTER continuity passes/,
  'Rejected continuity frames must not become stored anchors.'
);
assert.match(
  vision,
  /When invalid, corrected_prompt is REQUIRED/,
  'The continuity auditor must provide an explicit targeted correction when it fails.'
);

console.log('[ContinuityRegenerationSmoke] PASS');
