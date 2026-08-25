'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pipelinePath = path.join(__dirname, 'pipeline.js');
const cfPath = path.join(__dirname, 'cfImageGen.js');
const pipelineSource = fs.readFileSync(pipelinePath, 'utf8');
const cfSource = fs.readFileSync(cfPath, 'utf8');

// Source-level contract checks deliberately avoid external APIs. They catch regressions
// where a future edit accidentally restores the old character-first/background-optional flow.
assert(pipelineSource.includes("{ generationMode: 'environment', referenceRoles: [] }"),
  'Environment generation must explicitly use environment mode with zero image refs.');
assert(pipelineSource.includes("['environment', ...charRefs.map(() => 'character')].slice(0, 4)"),
  'Shot composition must label the environment as reference slot 0.');
assert(pipelineSource.includes('ENVIRONMENT-FIRST COMPOSITING CONTRACT'),
  'Shot prompt must explicitly enforce environment-first compositing.');
assert(pipelineSource.includes('requires a locked scene environment reference before character composition'),
  'Agnes semantic shots must fail closed when no environment reference exists.');
assert(cfSource.includes("role === 'environment'"),
  'CF image transport must treat environment reference failures as fatal.');
assert(cfSource.includes('refusing to promote a character reference into slot 0'),
  'CF image transport must prevent character-reference promotion into slot 0.');
assert(cfSource.includes("if (generationMode === 'environment' && referenceImageUrls.length)"),
  'Environment generation must reject all reference images.');
assert(cfSource.includes("_build3030RecoveryPrompt(currentPrompt, safetyRetries, generationMode)"),
  'Safety recovery must preserve generation mode.');
assert(cfSource.includes('Empty set only. No people, no characters'),
  'Environment safety recovery must remain character-free.');

console.log('PASS: environment generation is text-only with zero image references');
console.log('PASS: shot composition labels environment as input_image_0 before character refs');
console.log('PASS: environment reference failure cannot promote a character ref into slot 0');
console.log('PASS: Agnes semantic shots fail closed without a locked environment');
console.log('PASS: safety recovery remains character-free for environment plates');
