'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMediaRows } = require('../src/agentRuntimeHardening');

test('media lifecycle requires every shot to be durably successful', () => {
  const result = classifyMediaRows([
    { id:'a', status:'done', clip_url:'https://cdn/a.mp4', updated_at:new Date().toISOString() },
    { id:'b', status:'pending', clip_url:null, mh_job_id:'job-b', updated_at:new Date().toISOString() },
  ]);
  assert.equal(result.state, 'ACTIVE');
  assert.equal(result.allSuccessful, false);
});

test('failed media is never treated as settled success', () => {
  const result = classifyMediaRows([
    { id:'a', status:'done', clip_url:'https://cdn/a.mp4', updated_at:new Date().toISOString() },
    { id:'b', status:'failed', clip_url:null, ltx_status:'failed', last_error:'provider rejected generation', updated_at:new Date().toISOString() },
  ]);
  assert.equal(result.state, 'FAILED_TERMINAL');
  assert.equal(result.allSuccessful, false);
});

test('ZeroGPU/quota failure is classified as retryable', () => {
  const result = classifyMediaRows([
    { id:'a', status:'failed', clip_url:null, ltx_status:'zero_gpu_exhausted', last_error:'ZeroGPU exhausted', updated_at:new Date().toISOString() },
  ]);
  assert.equal(result.state, 'FAILED_RETRYABLE');
});
