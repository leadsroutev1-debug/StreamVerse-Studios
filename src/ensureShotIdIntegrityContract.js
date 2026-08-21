'use strict';

/**
 * Scene/shot integrity contract.
 *
 * The shot_simulation checkpoint is authoritative for scene-local shot identity
 * and order. Scene-shot writing consumes that persisted schema in scene order.
 * Mistral still writes the cinematic shot, but it must return the exact
 * scene_number/shot_index defined by the locked simulation. Invalid IDs are
 * retried with the validation error; they are never silently renumbered.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.resolve(__dirname, 'scriptWriter.js');
let text = fs.readFileSync(scriptPath, 'utf8');
let changed = false;

function replaceByMarkers(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  if (start < 0) return source;
  const end = source.indexOf(endMarker, start);
  if (end < 0) return source;
  return source.slice(0, start) + replacement + source.slice(end);
}

// 1. Restored scene-shot checkpoints are accepted only when their persisted
// IDs already match the authoritative scene-local sequence. Never renumber a
// corrupted checkpoint during resume.
const restoreMapRe = /normalizedExisting\.push\(\.\.\.prior\.map\(\(shot, i\) => \(\{[\s\S]*?\}\)\)\);/m;
if (restoreMapRe.test(text)) {
  text = text.replace(
    restoreMapRe,
    `if (prior.every((shot, i) => Number(shot.scene_number) === sceneNo && Number(shot.shot_index) === i + 1)) {\n        normalizedExisting.push(...prior);\n      } else {\n        console.warn(\`[ScriptWriter] Discarding invalid persisted scene-shot checkpoint S\\${seasonNumber}E\\${episodeNumber} scene \\${sceneNo}; expected local IDs 1..\\${target}. Regenerating from the locked shot simulation.\`);\n      }`,
  );
  changed = true;
}

// 2. Never leak the previous scene's numeric shot index into the next scene.
const inheritedStart = '    const inheritedStateBlock = previousEnd';
const inheritedEnd = "      : '';";
const inheritedPos = text.indexOf(inheritedStart);
if (inheritedPos >= 0) {
  const inheritedEndPos = text.indexOf(inheritedEnd, inheritedPos);
  if (inheritedEndPos >= 0) {
    const replacement = `    const inheritedStateBlock = previousEnd\n      ? \\`\\n═══ INHERITED NARRATIVE/VISUAL STATE FROM PRIOR SCENE — SHOT NUMBERING NOT INHERITED ═══\\n\\${JSON.stringify({\n          prior_scene_number: previousScene.scene_number,\n          end_frame_state: previousEnd.end_frame_state || previousEnd.end_state || '',\n          next_shot_continuity: previousEnd.next_shot_continuity || previousEnd.handoff_to_next || '',\n        })}\\nIMPORTANT: the prior scene's shot numbering is irrelevant. This scene starts a NEW local shot sequence at 1.\\n\\`\n      : '';`;
    text = text.slice(0, inheritedPos) + replacement + text.slice(inheritedEndPos + inheritedEnd.length);
    changed = true;
  }
}

// 3. Replace the old silent-renumbering scene-shot block with validation +
// repair against the exact persisted shot_simulation schema for this scene.
const orderedStart = '      const orderedShots = rawShots.map((shot, shotPos) => {';
const orderedEnd = '      const sceneWithShots = { ...scene, shots: orderedShots };';
const orderedPos = text.indexOf(orderedStart);
if (orderedPos >= 0) {
  const orderedEndPos = text.indexOf(orderedEnd, orderedPos);
  if (orderedEndPos >= 0) {
    const replacement = `      const lockedPlans = simulatedSceneShots.map((plan, i) => ({\n        ...plan,\n        scene_number: Number(scene.scene_number),\n        shot_index: i + 1,\n      }));\n      if (lockedPlans.length !== targetShots) {\n        throw new Error(\`[ScriptWriter] Scene \\${scene.scene_number} cannot be written because the persisted shot_simulation checkpoint contains \\${lockedPlans.length} shots; expected \\${targetShots}.\`);\n      }\n\n      const idsAreValid = shots => Array.isArray(shots) && shots.length === targetShots && shots.every((shot, shotPos) =>\n        Number(shot?.scene_number) === Number(scene.scene_number) && Number(shot?.shot_index) === shotPos + 1\n      );\n\n      let validatedShots = rawShots;\n      let repairAttempt = 0;\n      while (!idsAreValid(validatedShots)) {\n        repairAttempt += 1;\n        const badIds = Array.isArray(validatedShots)\n          ? validatedShots.map(shot => \\`S\\${Number.isFinite(Number(shot?.scene_number)) ? Number(shot.scene_number) : 'n/a'}/idx\\${Number.isFinite(Number(shot?.shot_index)) ? Number(shot.shot_index) : 'n/a'}\\`).join(', ')\n          : 'missing shots array';\n        const lockedIds = lockedPlans.map(plan => \\`S\\${plan.scene_number}/\\${plan.shot_index}\\`).join(', ');\n        const validationError = \\`Scene S\\${scene.scene_number} requires the exact persisted local IDs [\\${lockedIds}]; model returned [\\${badIds}]. The locked shot simulation is authoritative. Correct ONLY the identifiers and preserve every non-ID field and story order exactly.\\`;\n        console.warn(\\`[ScriptWriter] Shot-ID mismatch S\\${scene.scene_number}: \\${validationError} repairAttempt=\\${repairAttempt}\\`);\n\n        const repaired = await callLLM(\n          \\`\\${DIRECTOR_PERSONA}\\nYou are repairing identifiers in ONE already-authored scene-shot response. Return JSON only. The persisted shot simulation is authoritative. Preserve every non-ID field, continuity state, dialogue, staging, and ordering exactly. Correct ONLY scene_number and shot_index.\\`,\n          \\`SCENE: \\${scene.scene_number}\nLOCKED PERSISTED SHOT IDS: \\${lockedIds}\nVALIDATION ERROR: \\${validationError}\nPREVIOUS RESPONSE:\\n\\${JSON.stringify(validatedShots)}\\n\\nReturn the SAME \\${targetShots} shot objects in the SAME order with ONLY the exact persisted IDs restored.\\`,\n          undefined,\n          { useStream: false, temperature: 0.02 }\n        );\n\n        if (Array.isArray(repaired?.shots) && repaired.shots.length > 0) {\n          validatedShots = repaired.shots;\n        } else {\n          console.warn('[ScriptWriter] Shot-ID repair returned no usable shots; preserving the previous response for the next retry.');\n        }\n      }\n\n      const orderedShots = validatedShots.map(shot => {\n        const sanitizedShot = _sanitizeDialogueOrActionSemantics(shot);\n        const normalizedStaging = shotStaging.getShotCharacterStaging(sanitizedShot, []);\n        sanitizedShot.character_staging = normalizedStaging;\n        sanitizedShot.character_positions = normalizedStaging.length\n          ? shotStaging.formatCharacterStagingBlock(normalizedStaging)\n          : (sanitizedShot.character_positions || '');\n        return { ...sanitizedShot };\n      });\n\n`;
    text = text.slice(0, orderedPos) + replacement + text.slice(orderedEndPos);
    changed = true;
  }
}

// 4. Make the scene-shot prompt explicitly expose the persisted IDs and order.
const promptNeedle = 'SHOT-TO-SHOT CONTINUITY: Write the shots as a causal sequence, never independent prompts.';
if (text.includes(promptNeedle) && !text.includes('LOCKED PERSISTED SHOT IDS')) {
  const promptReplacement = `LOCKED PERSISTED SHOT IDS: ${'${simulatedSceneShots.map((s, i) => `S${scene.scene_number}/${i + 1}`).join(\', \')}'}\nThe shot_simulation checkpoint saved immediately before scene-shot writing is authoritative. Write the shots in this exact order and use these exact scene-local identities. Do not continue numbering from any other scene.\n\n${promptNeedle}`;
  text = text.replace(promptNeedle, promptReplacement, 1);
  changed = true;
}

// 5. Remove the old literal renumbering behavior if it survived any earlier patch.
if (text.includes('[ScriptWriter] Normalizing scene-local shot index')) {
  throw new Error('[ShotIdIntegrityContract] Legacy scene-shot silent renumbering block is still present');
}

// 6. The migration itself must be safe on restart: it is allowed to be a no-op
// once the source is already patched. It must NOT abort the application merely
// because an old intermediate pattern is absent.
if (changed) {
  fs.writeFileSync(scriptPath, text, 'utf8');
  console.log('[ShotIdIntegrityContract] Applied ordered scene-shot checkpoint contract.');
} else {
  console.log('[ShotIdIntegrityContract] Ordered scene-shot checkpoint contract already present.');
}

const check = spawnSync(process.execPath, ['--check', scriptPath], { stdio: 'inherit' });
if (check.status !== 0) {
  throw new Error(`[ShotIdIntegrityContract] scriptWriter.js syntax check failed with exit code ${check.status}`);
}
