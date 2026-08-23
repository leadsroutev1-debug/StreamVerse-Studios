'use strict';

/**
 * Provider router for the existing video-generation seam.
 *
 * The original LTX implementation lives in ltxVideoGenCore.js unchanged.
 * When VIDEO_PROVIDER=agnes, the same submit/poll interface is delegated to
 * Agnes. All other providers continue to use the original LTX implementation;
 * this preserves LTX behavior byte-for-byte while making Agnes a true secondary
 * provider selectable entirely through environment configuration.
 */

const config = require('./config');
const ltxCore = require('./ltxVideoGenCore');

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
