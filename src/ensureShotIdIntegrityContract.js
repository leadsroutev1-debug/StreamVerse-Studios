'use strict';

/**
 * Ordered scene-shot contract.
 *
 * The durable shot_simulation checkpoint is the authoritative per-scene shot
 * plan. Scene-shot writing consumes one persisted scene at a time, in order.
 * Mistral writes the cinematic realization, but IDs are validated against the
 * persisted plan and are repaired without replacing the original shot payload.
 *
 * This migration is intentionally conservative and idempotent. It must never
 * abort startup because an earlier source pattern is already absent.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.resolve(__dirname, 'scriptWriter.js');
const text0 = fs.readFileSync(scriptPath, 'utf8');
let text = text0;
let changed = false;
const bt = String.fromCharCode(96);

function replaceSection(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  if (start < 0) return source;
  const end = source.indexOf(endMarker, start);
  if (end < 0) return source;
  return source.slice(0, start) + replacement + source.slice(end);
}

// 1) Restore persisted shot-simulation checkpoints only when their IDs are
// already correct. Never renumber persisted IDs during resume.
const oldRestoreStart = '    if (prior.length === target) {';
const oldRestoreEnd = '  }\n\n  const working = {';
const restorePos = text.indexOf(oldRestoreStart);
if (restorePos >= 0) {
  const restoreEndPos = text.indexOf(oldRestoreEnd, restorePos);
  if (restoreEndPos >= 0) {
    const restoreBlock = [
      '    const checkpointIdsValid = prior.length === target && prior.every((shot, i) =>',
      '      Number(shot.scene_number) === sceneNo && Number(shot.shot_index) === i + 1',
      '    );',
      '',
      '    if (checkpointIdsValid) {',
      '      normalizedExisting.push(...prior);',
      '      console.log(' + bt + '[ScriptWriter] ↺ Restored shot simulation checkpoint S${seasonNumber}E${episodeNumber} scene ${sceneNo} (${target}/${target} shots)' + bt + ');',
      '    } else if (prior.length) {',
      '      console.warn(' + bt + '[ScriptWriter] Discarding invalid persisted shot-simulation IDs for S${seasonNumber}E${episodeNumber} scene ${sceneNo}; regenerating this scene from its scene simulation.' + bt + ');',
      '    }',
      '',
      '  }',
      ''
    ].join('\n');
    text = text.slice(0, restorePos) + restoreBlock + text.slice(restoreEndPos);
    changed = true;
  }
}

// 2) The scene-shot pass does not need the whole episode memory/state payload.
// It consumes the locked persisted scene plan plus only the immediately prior
// scene terminal state. This removes the 65k-character all-episode prompt.
const memoryStart = '    const memoryBlock = memory.length';
const memoryEnd = '    const shotSimulationBlock = ';
const memPos = text.indexOf(memoryStart);
if (memPos >= 0) {
  const memEndPos = text.indexOf(memoryEnd, memPos);
  if (memEndPos >= 0) {
    const compactContext = [
      '    const memoryBlock = \'\';',
      '    const continuityJson = \'{}\';',
      ''
    ].join('\n');
    text = text.slice(0, memPos) + compactContext + text.slice(memEndPos);
    changed = true;
  }
}

// 3) Remove previous-scene numeric shot identity from the inherited prompt.
const inheritedStart = '    const inheritedStateBlock = previousEnd';
const inheritedEnd = "      : '';";
const inhPos = text.indexOf(inheritedStart);
if (inhPos >= 0) {
  const inhEndPos = text.indexOf(inheritedEnd, inhPos);
  if (inhEndPos >= 0) {
    const inheritedReplacement = [
      '    const inheritedStateBlock = previousEnd',
      '      ? ' + bt + '\\n═══ INHERITED NARRATIVE/VISUAL STATE FROM PRIOR SCENE ═══\\n${JSON.stringify({',
      '          prior_scene_number: previousScene.scene_number,',
      "          end_frame_state: previousEnd.end_frame_state || previousEnd.end_state || '',",
      "          next_shot_continuity: previousEnd.next_shot_continuity || previousEnd.handoff_to_next || '',",
      '        })}\\nIMPORTANT: prior scene shot numbering is NOT inherited. This scene uses ONLY its persisted local shot IDs.\\n' + bt,
      "      : '';",
      ''
    ].join('\n');
    text = text.slice(0, inhPos) + inheritedReplacement + text.slice(inhEndPos + inheritedEnd.length);
    changed = true;
  }
}

// 4) Make the locked scene simulation the explicit identity source in the prompt.
const simBlockOld = "    const shotSimulationBlock = `\\n═══ LOCKED SHOT SIMULATION — DO NOT CONTRADICT ═══\\n${JSON.stringify(simulatedSceneShots)}\\nUse this as the causal blueprint for every shot in this scene. Preserve its start/end states, handoffs, character changes, dialogue intent, and order.\\n`;";
const simBlockNew = [
  '    const lockedShotIds = simulatedSceneShots.map(s => `S${s.scene_number}/${s.shot_index}`).join(\', \');',
  '    const shotSimulationBlock = `\\n═══ LOCKED PERSISTED SHOT SIMULATION — AUTHORITATIVE ═══\\n${JSON.stringify(simulatedSceneShots)}\\nLOCKED PERSISTED SHOT IDS: ${lockedShotIds}\\nUse this exact scene-local plan, exact ID order, start/end states, handoffs, character changes, dialogue intent, and causal order. Do not continue numbering from any other scene and do not invent a different shot sequence.\\n`;' 
].join('\n');
if (text.includes(simBlockOld)) {
  text = text.replace(simBlockOld, simBlockNew, 1);
  changed = true;
}

// 5) Replace silent scene-shot renumbering with exact-ID validation and a
// compact ID-only repair request. The original cinematic response remains
// untouched while Mistral is asked to correct only its identifiers.
const orderedStart = '      const orderedShots = rawShots.map((shot, shotPos) => {';
const orderedEnd = '      const sceneWithShots = { ...scene, shots: orderedShots };';
const ordPos = text.indexOf(orderedStart);
if (ordPos >= 0) {
  const ordEndPos = text.indexOf(orderedEnd, ordPos);
  if (ordEndPos >= 0) {
    const replacement = [
      '      const lockedPlans = simulatedSceneShots.slice().sort((a, b) => Number(a.shot_index) - Number(b.shot_index));',
      '      if (lockedPlans.length !== targetShots) {',
      '        throw new Error(`Scene ${scene.scene_number} cannot be written because the persisted shot_simulation checkpoint has ${lockedPlans.length} shots; expected ${targetShots}.`);',
      '      }',
      '',
      '      const idsAreValid = shots => Array.isArray(shots) && shots.length === targetShots && shots.every((shot, shotPos) => {',
      '        const locked = lockedPlans[shotPos];',
      '        return Number(shot?.scene_number) === Number(locked?.scene_number) && Number(shot?.shot_index) === Number(locked?.shot_index);',
      '      });',
      '',
      '      let validatedShots = rawShots;',
      '      let repairAttempt = 0;',
      '      while (!idsAreValid(validatedShots)) {',
      '        repairAttempt += 1;',
      '        const expectedIds = lockedPlans.map(p => `S${p.scene_number}/${p.shot_index}`);',
      '        const returnedIds = Array.isArray(validatedShots)',
      "          ? validatedShots.map(s => `S${Number.isFinite(Number(s?.scene_number)) ? Number(s.scene_number) : 'n/a'}/${Number.isFinite(Number(s?.shot_index)) ? Number(s.shot_index) : 'n/a'}`)",
      "          : ['missing shots array'];",
      '        const validationError = `Scene ${scene.scene_number} requires exact persisted shot IDs ${JSON.stringify(expectedIds)} in this order; model returned ${JSON.stringify(returnedIds)}. Correct ONLY the IDs. Do not rewrite the cinematic content.`;',
      '        console.warn(`[ScriptWriter] Shot-ID mismatch S${scene.scene_number}: ${validationError} repairAttempt=${repairAttempt}`);',
      '',
      '        const repaired = await callLLM(',
      '          `${DIRECTOR_PERSONA}\\nYou are repairing ONLY shot identifiers for one already-authored scene. The persisted shot_simulation checkpoint is authoritative. Return JSON only. Do not rewrite, summarize, or omit cinematic content.`,',
      '          `SCENE: ${scene.scene_number}\\nEXPECTED PERSISTED IDS: ${JSON.stringify(expectedIds)}\\nVALIDATION ERROR: ${validationError}\\nRETURNED IDS: ${JSON.stringify(returnedIds)}\\n\\nReturn ONLY {"corrected_ids":[{"position":1,"scene_number":${scene.scene_number},"shot_index":1}, ...]} with one entry for each shot position, matching the persisted IDs exactly.`,',
      '          undefined,',
      '          { useStream: false, temperature: 0.02 }',
      '        );',
      '',
      '        const corrected = Array.isArray(repaired?.corrected_ids) ? repaired.corrected_ids : [];',
      '        if (corrected.length === targetShots && corrected.every((id, i) =>',
      '          Number(id?.position) === i + 1 &&',
      '          Number(id?.scene_number) === Number(lockedPlans[i]?.scene_number) &&',
      '          Number(id?.shot_index) === Number(lockedPlans[i]?.shot_index)',
      '        )) {',
      '          validatedShots = validatedShots.map((shot, i) => ({',
      '            ...shot,',
      '            scene_number: Number(corrected[i].scene_number),',
      '            shot_index: Number(corrected[i].shot_index),',
      '          }));',
      '        } else {',
      "          console.warn('[ScriptWriter] Shot-ID repair returned unusable corrected_ids; preserving the original cinematic response for the next retry.');",
      '        }',
      '      }',
      '',
      '      const orderedShots = validatedShots.map(shot => {',
      '        const sanitizedShot = _sanitizeDialogueOrActionSemantics(shot);',
      '        const normalizedStaging = shotStaging.getShotCharacterStaging(sanitizedShot, []);',
      '        sanitizedShot.character_staging = normalizedStaging;',
      "        sanitizedShot.character_positions = normalizedStaging.length",
      '          ? shotStaging.formatCharacterStagingBlock(normalizedStaging)',
      "          : (sanitizedShot.character_positions || '');",
      '        return { ...sanitizedShot };',
      '      });',
      '',
      ''
    ].join('\n');
    text = text.slice(0, ordPos) + replacement + text.slice(ordEndPos);
    changed = true;
  }
}

// 6) If the source still contains the old silent normalization text, do not let
// that behavior survive a restart.
if (text.includes('[ScriptWriter] Normalizing scene-local shot index')) {
  const legacyStart = '      const orderedShots = rawShots.map((shot, shotPos) => {';
  const legacyEnd = '      const sceneWithShots = { ...scene, shots: orderedShots };';
  const p = text.indexOf(legacyStart);
  const e = text.indexOf(legacyEnd, p);
  if (p >= 0 && e > p) {
    text = text.slice(0, p) + text.slice(e);
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(scriptPath, text, 'utf8');
  console.log('[ShotIdIntegrityContract] Applied ordered persisted scene-shot contract: scene-local DB checkpoint → one scene → one cinematic Mistral pass.');
} else {
  console.log('[ShotIdIntegrityContract] Ordered persisted scene-shot contract already present.');
}

const check = spawnSync(process.execPath, ['--check', scriptPath], { stdio: 'inherit' });
if (check.status !== 0) {
  throw new Error(`[ShotIdIntegrityContract] scriptWriter.js syntax check failed with exit code ${check.status}`);
}
