'use strict';

const coreConfig = require('./configCore');
const providerPromptAdapter = require('./providerPromptAdapter');

// Install once at application startup. It only mutates outbound LLM messages
// when VIDEO_PROVIDER=agnes and only when they contain the existing shot/pacing
// contracts. LTX and Magic Hour requests are untouched.
providerPromptAdapter.install();

module.exports = coreConfig;
