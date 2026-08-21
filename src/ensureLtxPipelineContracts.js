'use strict';

/**
 * StreamVerse Studio — startup migration for the LTX/movie pipeline contract.
 *
 * The main pipeline file is intentionally kept large and stable, so this small
 * migration applies two deterministic source-level repairs before Node loads it:
 *   1. never hard-truncate conversational LTX prompts;
 *   2. make compiled scene outputs the final episode master boundary.
 *
 * The migration is idempotent. Once the corrected blocks are present, it does
 * nothing except validate the resulting JavaScript syntax.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pipelinePath = path.resolve(__dirname, 'pipeline.js');
const source = fs.readFileSync(pipelinePath, 'utf8');
let text = source;
let changed = false;

const oldPromptCap = `  // LTX guidance recommends staying within 200 words; keep a little headroom
  // so the prompt remains information-dense rather than turning into a contract.
  const words = finalPrompt.split(/\\s+/).filter(Boolean);
  if (words.length > 190) {
    finalPrompt = words.slice(0, 190).join(' ');
    finalPrompt = finalPrompt.replace(/[,;:]?\\s*[^.!?]*$/, '').trim();
  }
  return finalPrompt;`;

const newPromptContract = `  // Do not hard-truncate conversational LTX prompts. The official LTX guidance
  // supports longer screenplay-style prompts for dialogue and multi-beat scenes.
  // Word-count truncation can amputate quoted dialogue, reaction beats, camera
  // progression, or the outgoing state needed by the next shot.
  return finalPrompt;`;

if (text.includes(oldPromptCap)) {
  text = text.replace(oldPromptCap, newPromptContract, 1);
  changed = true;
} else if (!text.includes('Do not hard-truncate conversational LTX prompts.')) {
  throw new Error('[LTXContract] Legacy prompt cap block not found and corrected block is absent');
}

const masterStart = '  // ── 8. Merge the original shot assets → final master ──────────────────────';
const masterEnd = '  const finalVideoUrl = await compiler.pollFFmpegJob(mergeJobId);';
const masterReplacement = `  // ── 8. Merge compiled scene outputs → final master ───────────────────────
  // Scene compilation is the editorial boundary for the movie. The final master
  // consumes the already-compiled scene assets, not individual shot clips. This
  // preserves scene-level pacing/transitions and reduces merge fan-out from O(shots)
  // to O(scenes).
  state.setStatus(state.STATES.COMPILING, 'Merging compiled scenes into final episode...');

  const orderedSceneUrls = sceneNums
    .map(sceneNum => savedSceneState[sceneNum] || null)
    .filter(Boolean);

  if (!orderedSceneUrls.length) {
    const reason = 'No compiled scene assets are available for the final master merge.';
    console.error(\\`[Pipeline] \\${reason}\\`);
    await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
    state.setStatus(state.STATES.PAUSED, \\`⏸ \\${reason}\\`);
    await telegram.sendTelegram(\\`⏸ <b>Episode paused — no compiled scene assets for master merge</b>\\`).catch(() => {});
    return;
  }

  if (orderedSceneUrls.length !== sceneNums.length) {
    const reason = \\`Final scene merge mismatch: found \\${orderedSceneUrls.length}/\\${sceneNums.length} compiled scenes. Refusing to build an incomplete final episode.\\`;
    console.error(\\`[Pipeline] \\${reason}\\`);
    await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
    state.setStatus(state.STATES.PAUSED, \\`⏸ \\${reason}\\`);
    await telegram.sendTelegram(\\`⏸ <b>Episode paused — compiled scene source mismatch</b>\\n\\${reason}\\`).catch(() => {});
    return;
  }

  console.log(\\`[Pipeline] Final master source = \\${orderedSceneUrls.length} compiled scenes (not \\${allShots.length} individual shots)\\`);
  const episodeTransition = episodeScript?.episode_transition || null;
  const mergeJobId = await compiler.mergeScenes(orderedSceneUrls, {
    introBumperUrl: process.env.INTRO_BUMPER_URL || null,
    outroBumperUrl: process.env.OUTRO_BUMPER_URL || null,
    transition: episodeTransition,
  });
  const finalVideoUrl = await compiler.pollFFmpegJob(mergeJobId);`;

const masterStartIndex = text.indexOf(masterStart);
if (masterStartIndex >= 0) {
  const masterEndIndex = text.indexOf(masterEnd, masterStartIndex);
  if (masterEndIndex < 0) throw new Error('[LTXContract] Final-master block end not found');
  const endExclusive = masterEndIndex + masterEnd.length;
  text = text.slice(0, masterStartIndex) + masterReplacement + text.slice(endExclusive);
  changed = true;
} else if (!text.includes('Merge compiled scene outputs → final master')) {
  throw new Error('[LTXContract] Legacy shot-level final-master block not found and corrected block is absent');
}

if (changed) {
  fs.writeFileSync(pipelinePath, text, 'utf8');
  console.log('[LTXContract] Applied conversational-prompt and scene-master contract fixes.');
} else {
  console.log('[LTXContract] Corrected pipeline contracts already present.');
}

const check = spawnSync(process.execPath, ['--check', pipelinePath], { stdio: 'inherit' });
if (check.status !== 0) {
  throw new Error(`[LTXContract] pipeline.js syntax check failed with exit code ${check.status}`);
}
