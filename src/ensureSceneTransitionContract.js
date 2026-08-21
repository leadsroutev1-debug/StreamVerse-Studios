'use strict';

/**
 * StreamVerse Studio — scene transition contract migration.
 *
 * Scene compilation must be more than a raw cut/join. The existing compiler
 * already knows how to safely normalize authored transition expressions (for
 * example, a complex glitch/smush expression becomes a safe fade). The bug was
 * that _compileOneScene() never passed a transition into the compiler.
 *
 * This idempotent migration repairs that call before the main pipeline loads:
 *   - use a scene-authored transition when present;
 *   - otherwise use a short fade for multi-shot scenes;
 *   - preserve authored transition duration when present, otherwise 0.4s;
 *   - let compiler.resolveTransition() safely downgrade unsupported expressions.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pipelinePath = path.resolve(__dirname, 'pipeline.js');
let text = fs.readFileSync(pipelinePath, 'utf8');
let changed = false;

const oldBlock = `  const pubId = cloudinary.scenePublicId(storylineId, globalEpisodeNumber, sceneNum);\n  const rawUrl = await compiler.composeSceneSmartAndWait(plainClips, 'cut', {});\n  return await cloudinary.uploadVideoFromUrl(rawUrl, pubId);`;

const newBlock = `  // Scene-level editorial transition: prefer the scene's authored choice,\n  // then the episode default, and finally a short fade so multi-shot scenes do\n  // not feel like disconnected hard cuts. Complex expressions are still passed\n  // to compiler.resolveTransition(), which safely degrades unsupported syntax to fade.\n  const sceneForNumber = (script?.scenes || [])\n    .find(sc => Number(sc?.scene_number) === Number(sceneNum)) || {};\n  const sceneTransition =\n    sceneForNumber.transition ||\n    sceneForNumber.scene_transition ||\n    script?.scene_transition ||\n    script?.default_scene_transition ||\n    'fade';\n  const sceneTransitionDuration =\n    sceneForNumber.transition_duration ??\n    sceneForNumber.scene_transition_duration ??\n    script?.scene_transition_duration ??\n    0.4;\n\n  const pubId = cloudinary.scenePublicId(storylineId, globalEpisodeNumber, sceneNum);\n  const sceneEffects = plainClips.length > 1\n    ? { transition: sceneTransition, transitionDuration: sceneTransitionDuration }\n    : {};\n\n  console.log(\n    \`[Pipeline] Scene \${sceneNum} editorial transition = \${sceneEffects.transition || 'none'}\` +\n    (sceneEffects.transitionDuration != null ? \` (\${sceneEffects.transitionDuration}s)\` : '')\n  );\n\n  const rawUrl = await compiler.composeSceneSmartAndWait(plainClips, 'cut', sceneEffects);\n  return await cloudinary.uploadVideoFromUrl(rawUrl, pubId);`;

if (text.includes(oldBlock)) {
  text = text.replace(oldBlock, newBlock, 1);
  changed = true;
} else if (!text.includes('Scene-level editorial transition: prefer the scene\'s authored choice')) {
  throw new Error('[SceneTransitionContract] _compileOneScene transition call not found');
}

if (changed) {
  fs.writeFileSync(pipelinePath, text, 'utf8');
  console.log('[SceneTransitionContract] Enabled scene-level fade/transition compilation.');
} else {
  console.log('[SceneTransitionContract] Scene transition contract already present.');
}

const check = spawnSync(process.execPath, ['--check', pipelinePath], { stdio: 'inherit' });
if (check.status !== 0) {
  throw new Error(`[SceneTransitionContract] pipeline.js syntax check failed with exit code ${check.status}`);
}
