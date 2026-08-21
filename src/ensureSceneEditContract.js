'use strict';

/**
 * StreamVerse Studio — scene editing contract.
 *
 * Editorial boundary rules:
 *   - inside a compiled scene: every adjacent shot boundary uses a short fade;
 *   - between already-compiled scenes: final master uses a hard cut.
 *
 * The migration is idempotent and validates pipeline.js after patching.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pipelinePath = path.resolve(__dirname, 'pipeline.js');
let text = fs.readFileSync(pipelinePath, 'utf8');
let changed = false;

// Normal scene/early scene compilation: force the shot-boundary transition to fade.
const oldEffectsMap = `  const sceneMeta     = Object.fromEntries(scenes.map(s => [s.scene_number, s.composition || 'cut']));\n  const sceneEffectsMap = Object.fromEntries(\n    scenes.map(s => [s.scene_number, s.ffmpeg_effects || {}])\n  );`;
const newEffectsMap = `  const sceneMeta     = Object.fromEntries(scenes.map(s => [s.scene_number, s.composition || 'cut']));\n  // Shot-to-shot boundaries inside a scene are deliberately soft. The final\n  // scene-to-scene master remains a separate hard-cut operation.\n  const sceneEffectsMap = Object.fromEntries(\n    scenes.map(s => [s.scene_number, {\n      ...(s.ffmpeg_effects || {}),\n      transition: 'fade',\n      transitionDuration: s.transition_duration ?? s.ffmpeg_effects?.transitionDuration ?? 0.4,\n    }])\n  );`;

if (text.includes(oldEffectsMap)) {
  text = text.replace(oldEffectsMap, newEffectsMap, 1);
  changed = true;
}

// Individual-scene/recompile path: do not silently revert to a hard cut.
const oldIndividual = `  const pubId = cloudinary.scenePublicId(storylineId, globalEpisodeNumber, sceneNum);\n  const rawUrl = await compiler.composeSceneSmartAndWait(plainClips, 'cut', {});\n  return await cloudinary.uploadVideoFromUrl(rawUrl, pubId);`;
const newIndividual = `  const pubId = cloudinary.scenePublicId(storylineId, globalEpisodeNumber, sceneNum);\n  const sceneEffects = plainClips.length > 1\n    ? { transition: 'fade', transitionDuration: 0.4 }\n    : {};\n  const rawUrl = await compiler.composeSceneSmartAndWait(plainClips, 'cut', sceneEffects);\n  return await cloudinary.uploadVideoFromUrl(rawUrl, pubId);`;

if (text.includes(oldIndividual)) {
  text = text.replace(oldIndividual, newIndividual, 1);
  changed = true;
}

// Final-master merge: compiled scenes are joined by cut. Do not forward an episode
// transition here; that would force another filtered/re-encode pass over the scenes.
const oldMaster = `  const episodeTransition = episodeScript?.episode_transition || null;\n  const mergeJobId = await compiler.mergeScenes(orderedSceneUrls, {\n    introBumperUrl: process.env.INTRO_BUMPER_URL || null,\n    outroBumperUrl: process.env.OUTRO_BUMPER_URL || null,\n    transition: episodeTransition,\n  });`;
const newMaster = `  const mergeJobId = await compiler.mergeScenes(orderedSceneUrls, {\n    introBumperUrl: process.env.INTRO_BUMPER_URL || null,\n    outroBumperUrl: process.env.OUTRO_BUMPER_URL || null,\n    // Explicitly omit transition: compiled scenes meet at a hard cut.\n  });`;

if (text.includes(oldMaster)) {
  text = text.replace(oldMaster, newMaster, 1);
  changed = true;
}

if (!text.includes("transition: 'fade'")) {
  throw new Error('[SceneEditContract] Fade transition contract was not installed');
}

if (text.includes('transition: episodeTransition')) {
  throw new Error('[SceneEditContract] Final master still carries an episode transition');
}

if (changed) {
  fs.writeFileSync(pipelinePath, text, 'utf8');
  console.log('[SceneEditContract] Scene shot boundaries = fade; compiled scene master boundaries = cut.');
} else {
  console.log('[SceneEditContract] Scene editing contract already present.');
}

const check = spawnSync(process.execPath, ['--check', pipelinePath], { stdio: 'inherit' });
if (check.status !== 0) {
  throw new Error(`[SceneEditContract] pipeline.js syntax check failed with exit code ${check.status}`);
}
