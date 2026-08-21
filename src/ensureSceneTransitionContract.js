'use strict';

/**
 * StreamVerse Studio — scene transition contract migration.
 *
 * The normal scene compilation path already passes sceneEffectsMap into the
 * compiler. The individual-scene/recompile path was the outlier: it supplied
 * an empty effects object, which turned the scene into a hard cut even when
 * the compiler's transition resolver would have safely produced a fade.
 *
 * This migration makes that path explicitly use a short fade between shots.
 * The normal scene path remains responsible for authored transitions, and the
 * compiler still downgrades unsupported transition expressions to fade.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pipelinePath = path.resolve(__dirname, 'pipeline.js');
let text = fs.readFileSync(pipelinePath, 'utf8');
let changed = false;

const oldBlock = `  const pubId = cloudinary.scenePublicId(storylineId, globalEpisodeNumber, sceneNum);\n  const rawUrl = await compiler.composeSceneSmartAndWait(plainClips, 'cut', {});\n  return await cloudinary.uploadVideoFromUrl(rawUrl, pubId);`;

const newBlock = `  // Individual scene/recompile path: preserve the same editorial feel as the\n  // normal scene compiler instead of silently reverting to a hard cut. The\n  // normal scene path may carry an authored transition; this fallback path\n  // deliberately guarantees a safe fade between adjacent shots.\n  const sceneEffects = plainClips.length > 1\n    ? { transition: 'fade', transitionDuration: 0.4 }\n    : {};\n\n  const pubId = cloudinary.scenePublicId(storylineId, globalEpisodeNumber, sceneNum);\n  console.log(\n    \`[Pipeline] Scene \${sceneNum} individual compile transition = \${sceneEffects.transition || 'none'}\` +\n    (sceneEffects.transitionDuration != null ? \` (\${sceneEffects.transitionDuration}s)\` : '')\n  );\n  const rawUrl = await compiler.composeSceneSmartAndWait(plainClips, 'cut', sceneEffects);\n  return await cloudinary.uploadVideoFromUrl(rawUrl, pubId);`;

if (text.includes(oldBlock)) {
  text = text.replace(oldBlock, newBlock, 1);
  changed = true;
} else if (!text.includes('Individual scene/recompile path: preserve the same editorial feel')) {
  throw new Error('[SceneTransitionContract] individual scene/recompile compose call not found');
}

if (changed) {
  fs.writeFileSync(pipelinePath, text, 'utf8');
  console.log('[SceneTransitionContract] Enabled fade transitions for individual scene compilation.');
} else {
  console.log('[SceneTransitionContract] Individual-scene fade contract already present.');
}

const check = spawnSync(process.execPath, ['--check', pipelinePath], { stdio: 'inherit' });
if (check.status !== 0) {
  throw new Error(`[SceneTransitionContract] pipeline.js syntax check failed with exit code ${check.status}`);
}
