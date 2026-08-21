'use strict';

/**
 * StreamVerse Studios — shot-ID integrity migration.
 *
 * Shot IDs are scene-local identity. Never silently renumber them. Invalid
 * model output is repaired until the exact local IDs are returned. A failed
 * repair response must NEVER replace the last non-empty response, because the
 * next retry needs the original authored shots and the exact validation error.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.resolve(__dirname, 'scriptWriter.js');
let text = fs.readFileSync(scriptPath, 'utf8');
let changed = false;

// Remove the previous-scene numeric shot index from the next-scene prompt.
const leakedPriorIndex = /last_shot_index:\s*previousEnd\.shot_index,\s*/m;
if (leakedPriorIndex.test(text)) {
  text = text.replace(leakedPriorIndex, '');
  text = text.replace(
    /═══ INHERITED STATE FROM PRIOR SCENE ═══/g,
    '═══ INHERITED NARRATIVE\/VISUAL STATE FROM PRIOR SCENE — SHOT NUMBERING NOT INHERITED ═══'
  );
  changed = true;
}

// Never overwrite the current valid/non-empty repair input with an empty repair response.
// This affects the actual scene-shot writer.
const oldSceneRepairAssign = /\n\s*validatedShots = Array\.isArray\(repaired\?\.shots\) \? repaired\.shots : \[\];/m;
const newSceneRepairAssign = `
        if (Array.isArray(repaired?.shots) && repaired.shots.length > 0) {
          validatedShots = repaired.shots;
        } else {
          console.warn(
            '[ScriptWriter] Shot-ID repair returned no usable shots; preserving the previous response for the next retry.'
          );
        }`;
if (oldSceneRepairAssign.test(text)) {
  text = text.replace(oldSceneRepairAssign, newSceneRepairAssign);
  changed = true;
}

// Do the same for the pre-generation shot simulation repair loop if present.
const oldSimulationRepairAssign = /\n\s*validatedResult = await callLLM\(([^]*?)\n\s*\);/m;
if (oldSimulationRepairAssign.test(text) && !text.includes('preserving the previous response for the next simulation retry')) {
  text = text.replace(oldSimulationRepairAssign, (match, args) => `
      const repairedResult = await callLLM(${args}
      );
      if (repairedResult && Array.isArray(repairedResult.shots) && repairedResult.shots.length > 0) {
        validatedResult = repairedResult;
      } else {
        console.warn('[ScriptWriter] Shot-ID simulation repair returned no usable shots; preserving the previous response for the next simulation retry.');
      }`, 1);
  changed = true;
}

// Add a durable assertion against the exact regression we just observed.
if (!text.includes('preserving the previous response for the next retry')) {
  throw new Error('[ShotIdIntegrityContract] Repair-state preservation guard was not installed');
}
if (text.includes('validatedShots = Array.isArray(repaired?.shots) ? repaired.shots : [];')) {
  throw new Error('[ShotIdIntegrityContract] Empty repair response can still erase the previous shot sequence');
}

if (changed) {
  fs.writeFileSync(scriptPath, text, 'utf8');
  console.log('[ShotIdIntegrityContract] Preserved original shot sequence across invalid/empty repair responses.');
} else {
  console.log('[ShotIdIntegrityContract] Shot-ID repair-state preservation already present.');
}

const check = spawnSync(process.execPath, ['--check', scriptPath], { stdio: 'inherit' });
if (check.status !== 0) {
  throw new Error(`[ShotIdIntegrityContract] scriptWriter.js syntax check failed with exit code ${check.status}`);
}
