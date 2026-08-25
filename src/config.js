'use strict';

const coreConfig = require('./configCore');
const providerPromptAdapter = require('./providerPromptAdapter');

// Install once at application startup. It only mutates outbound LLM messages
// when VIDEO_PROVIDER=agnes and only when they contain the existing shot/pacing
// contracts. LTX and Magic Hour requests are untouched.
providerPromptAdapter.install();

// The active provider owns the production temporal contract. Agnes explicitly
// uses an 18-second ceiling; LTX keeps its configured LTX ceiling.
if (coreConfig.videoProvider === 'agnes') {
  // Agnes owns the temporal contract; legacy LTX-era env values cannot cap it.
  const agnesMax = 18;
  coreConfig.ltxMaxDuration = agnesMax;
  coreConfig.ltxMinDuration = Math.min(coreConfig.ltxMinDuration, agnesMax);
  console.log(`[Config] Agnes temporal canvas enabled: max=${agnesMax}s (authoritative)`);
}

module.exports = coreConfig;
