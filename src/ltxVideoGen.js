'use strict';

/**
 * Provider router for the existing video-generation seam.
 *
 * The original LTX implementation lives in ltxVideoGenCore.js. When
 * VIDEO_PROVIDER=agnes, the same submit/poll interface is delegated to Agnes.
 * Provider-specific temporal rules are source-authored in ScriptWriter and the
 * pipeline; this module only selects the provider implementation.
 */

const config = require('./config');
const ltxCore = require('./ltxVideoGenCore');
const providerPromptAdapter = require('./providerPromptAdapter');

// Keep the outbound LLM seam provider-aware for any residual legacy prompt text.
// The core production duration contract itself lives directly in source files.
providerPromptAdapter.install();

if (config.videoProvider !== 'agnes') {
  module.exports = ltxCore;
} else {
  const agnes = require('./agnesVideoGen');

  module.exports = {
    ...agnes,
    // Preserve stable error names expected by existing pipeline diagnostics.
    LTXGenerationError: agnes.AgnesGenerationError,
  };
}
