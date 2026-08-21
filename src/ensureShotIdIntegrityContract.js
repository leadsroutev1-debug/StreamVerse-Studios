'use strict';

/**
 * StreamVerse Studio — shot-ID integrity migration.
 *
 * Shot IDs are scene-local identity, never a value the pipeline is allowed to
 * infer or renumber. This migration patches the source script itself so the
 * production code validates IDs, removes cross-scene numbering from prompts,
 * and retries malformed model output with the exact validation error.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.resolve(__dirname, 'scriptWriter.js');
let text = fs.readFileSync(scriptPath, 'utf8');
let changed = false;

// 1) Restore persisted shot simulations only when their stored IDs are already
// exactly valid. Never rewrite a persisted 5,6,7,8 into 1,2,3,4.
const oldRestore = `  const normalizedExisting = [];
  for (const scene of plannedScenes) {
    const sceneNo = Number(scene.scene_number);
    const target = counts[sceneNo];
    const prior = existingShots
      .filter(s => Number(s.scene_number) === sceneNo)
      .sort((a, b) => Number(a.shot_index) - Number(b.shot_index));

    if (prior.length === target) {
      normalizedExisting.push(...prior.map((shot, i) => ({
        ...shot,
        scene_number: sceneNo,
        shot_index: i + 1,
      })));
      console.log(\`[ScriptWriter] ↺ Restored shot simulation checkpoint S\${seasonNumber}E\${episodeNumber} scene \${sceneNo} (\${target}/\${target} shots)\`);
    }
  }`;
const newRestore = `  const normalizedExisting = [];
  for (const scene of plannedScenes) {
    const sceneNo = Number(scene.scene_number);
    const target = counts[sceneNo];
    const prior = existingShots
      .filter(s => Number(s.scene_number) === sceneNo)
      .sort((a, b) => Number(a.shot_index) - Number(b.shot_index));

    const checkpointIsValid = prior.length === target && prior.every((shot, i) =>
      Number(shot.scene_number) === sceneNo && Number(shot.shot_index) === i + 1
    );

    if (checkpointIsValid) {
      normalizedExisting.push(...prior);
      console.log(\`[ScriptWriter] ↺ Restored shot simulation checkpoint S\${seasonNumber}E\${episodeNumber} scene \${sceneNo} (\${target}/\${target} shots)\`);
    } else if (prior.length) {
      console.warn(\`[ScriptWriter] Discarding invalid shot checkpoint S\${seasonNumber}E\${episodeNumber} scene \${sceneNo}: expected local IDs 1..\${target}; found \${prior.map(s => \`S\${Number(s.scene_number)}/idx\${Number(s.shot_index)}\`).join(', ')}. Regenerating this scene instead of renumbering it.\`);
    }
  }`;
if (text.includes(oldRestore)) {
  text = text.replace(oldRestore, newRestore, 1);
  changed = true;
}

// 2) PRE-GENERATION shot simulation: validate/repair model IDs instead of
// silently rewriting them.
const oldShotSimulation = `    const sceneShots = result.shots.map((shot, i) => {
      const rawScene = Number(shot?.scene_number);
      const rawIndex = Number(shot?.shot_index);
      const expectedIndex = i + 1;
      if (rawScene !== sceneNo || rawIndex !== expectedIndex) {
        console.warn(
          \`[ScriptWriter] Normalizing simulation S\${sceneNo}: model returned S\${Number.isFinite(rawScene) ? rawScene : 'n/a'}/idx\${Number.isFinite(rawIndex) ? rawIndex : 'n/a'}, expected S\${sceneNo}/idx\${expectedIndex}\`
        );
      }
      return {
        ...shot,
        scene_number: sceneNo,
        shot_index: expectedIndex,
      };
    });`;
const newShotSimulation = `    const idsAreValid = shots => shots.length === target && shots.every((shot, i) =>
      Number(shot?.scene_number) === sceneNo && Number(shot?.shot_index) === i + 1
    );

    let validatedResult = result;
    let repairAttempt = 0;
    while (!idsAreValid(validatedResult.shots)) {
      repairAttempt += 1;
      const badIds = (validatedResult?.shots || []).map(shot =>
        \`S\${Number.isFinite(Number(shot?.scene_number)) ? Number(shot.scene_number) : 'n/a'}/idx\${Number.isFinite(Number(shot?.shot_index)) ? Number(shot.shot_index) : 'n/a'}\`
      ).join(', ');
      const validationError =
        \`Scene S\${sceneNo} requires local shot IDs 1..\${target}; model returned [\${badIds}]. Do not renumber silently.\`;
      console.warn(\`[ScriptWriter] Shot-ID mismatch S\${sceneNo}: \${validationError} repairAttempt=\${repairAttempt}\`);

      validatedResult = await callLLM(
        \`\${DIRECTOR_PERSONA}\\nYou are repairing ONLY the identifiers of an already-authored shot sequence. Preserve every non-ID field and story order exactly.\`,
        \`Scene S\${sceneNo}, expected \${target} local shots.\\nVALIDATION ERROR: \${validationError}\\nPREVIOUS RESPONSE: \${JSON.stringify(validatedResult?.shots || null)}\\nReturn the same shots with ONLY scene_number and shot_index corrected to S\${sceneNo}/1..\${target}. Never use episode-global numbering.\`,
        undefined,
        { useStream: false, temperature: 0.02 }
      );
    }

    const sceneShots = validatedResult.shots.map(shot => ({ ...shot }));`;
if (text.includes(oldShotSimulation)) {
  text = text.replace(oldShotSimulation, newShotSimulation, 1);
  changed = true;
}

// 3) ACTUAL scene shot-writing prompt: inherit narrative state, but NEVER the
// previous scene's numeric shot index. Shot numbering restarts at 1 per scene.
const oldInherited = `    const inheritedStateBlock = previousEnd
      ? \`\\n═══ INHERITED STATE FROM PRIOR SCENE ═══\\n\${JSON.stringify({
          scene_number: previousScene.scene_number,
          last_shot_index: previousEnd.shot_index,
          end_frame_state: previousEnd.end_frame_state || previousEnd.end_state || '',
          next_shot_continuity: previousEnd.next_shot_continuity || previousEnd.handoff_to_next || '',
        })}\\n\`
      : '';`;
const newInherited = `    const inheritedStateBlock = previousEnd
      ? \`\\n═══ INHERITED NARRATIVE/VISUAL STATE FROM PRIOR SCENE ═══\\n\${JSON.stringify({
          prior_scene_number: previousScene.scene_number,
          end_frame_state: previousEnd.end_frame_state || previousEnd.end_state || '',
          next_shot_continuity: previousEnd.next_shot_continuity || previousEnd.handoff_to_next || '',
        })}\\nIMPORTANT: the prior scene's shot numbering is NOT inherited. This scene starts a NEW local shot sequence at 1.\n\`
      : '';`;
if (text.includes(oldInherited)) {
  text = text.replace(oldInherited, newInherited, 1);
  changed = true;
}

const oldSceneWriter = `      const orderedShots = rawShots.map((shot, shotPos) => {
        const expectedIndex = shotPos + 1;
        const rawIndex = Number(shot?.shot_index);
        if (rawIndex !== expectedIndex) {
          console.warn(
            \`[ScriptWriter] Normalizing scene-local shot index S\${scene.scene_number}: model returned idx=\${Number.isFinite(rawIndex) ? rawIndex : 'n/a'}, expected idx=\${expectedIndex}\`
          );
        }
        const sanitizedShot = _sanitizeDialogueOrActionSemantics(shot);
        const normalizedStaging = shotStaging.getShotCharacterStaging(sanitizedShot, []);
        sanitizedShot.character_staging = normalizedStaging;
        sanitizedShot.character_positions = normalizedStaging.length
          ? shotStaging.formatCharacterStagingBlock(normalizedStaging)
          : (sanitizedShot.character_positions || '');
        return {
          ...sanitizedShot,
          scene_number: Number(scene.scene_number),
          shot_index: expectedIndex,
        };
      });`;
const newSceneWriter = `      const idsAreValid = shots => shots.length === targetShots && shots.every((shot, shotPos) =>
        Number(shot?.scene_number) === Number(scene.scene_number) && Number(shot?.shot_index) === shotPos + 1
      );

      let validatedShots = rawShots;
      let repairAttempt = 0;
      while (!idsAreValid(validatedShots)) {
        repairAttempt += 1;
        const badIds = validatedShots.map(shot =>
          \`S\${Number.isFinite(Number(shot?.scene_number)) ? Number(shot.scene_number) : 'n/a'}/idx\${Number.isFinite(Number(shot?.shot_index)) ? Number(shot.shot_index) : 'n/a'}\`
        ).join(', ');
        const validationError =
          \`Scene S\${scene.scene_number} requires exactly \${targetShots} local shot IDs 1..\${targetShots}; model returned [\${badIds}].\`;
        console.warn(\`[ScriptWriter] Shot-ID mismatch S\${scene.scene_number}: \${validationError} repairAttempt=\${repairAttempt}\`);

        const repaired = await callLLM(
          \`\${DIRECTOR_PERSONA}\\nYou are repairing the identifiers for ONE already-authored scene. Preserve every non-ID field, story beat, dialogue, staging and ordering exactly. Only correct scene_number and shot_index.\`,
          \`SCENE: \${scene.scene_number}\\nVALIDATION ERROR: \${validationError}\\nPREVIOUS RESPONSE: \${JSON.stringify(validatedShots)}\\nThe prior scene's shot numbering is irrelevant. This scene MUST use local shot_index 1..\${targetShots}. Return the same \${targetShots} shots in the same order.\`,
          undefined,
          { useStream: false, temperature: 0.02 }
        );
        validatedShots = Array.isArray(repaired?.shots) ? repaired.shots : [];
      }

      const orderedShots = validatedShots.map(shot => {
        const sanitizedShot = _sanitizeDialogueOrActionSemantics(shot);
        const normalizedStaging = shotStaging.getShotCharacterStaging(sanitizedShot, []);
        sanitizedShot.character_staging = normalizedStaging;
        sanitizedShot.character_positions = normalizedStaging.length
          ? shotStaging.formatCharacterStagingBlock(normalizedStaging)
          : (sanitizedShot.character_positions || '');
        return {
          ...sanitizedShot,
          scene_number: Number(scene.scene_number),
          shot_index: Number(shot.shot_index),
        };
      });`;
if (text.includes(oldSceneWriter)) {
  text = text.replace(oldSceneWriter, newSceneWriter, 1);
  changed = true;
}

if (text.includes('last_shot_index: previousEnd.shot_index')) {
  throw new Error('[ShotIdIntegrityContract] Prior scene shot index is still leaked into the next-scene prompt');
}
if (text.includes('Normalizing scene-local shot index')) {
  throw new Error('[ShotIdIntegrityContract] Legacy scene-shot renumbering block remains');
}
if (text.includes('Normalizing simulation S${sceneNo}')) {
  throw new Error('[ShotIdIntegrityContract] Legacy shot-simulation renumbering block remains');
}
if (!text.includes('prior scene\'s shot numbering is NOT inherited')) {
  throw new Error('[ShotIdIntegrityContract] Scene-local numbering boundary was not installed');
}

if (changed) {
  fs.writeFileSync(scriptPath, text, 'utf8');
  console.log('[ShotIdIntegrityContract] Applied direct source fix: scene-local IDs, no cross-scene numbering leakage, retry-until-valid Mistral repair.');
} else {
  console.log('[ShotIdIntegrityContract] Shot-ID source contract already present.');
}

const check = spawnSync(process.execPath, ['--check', scriptPath], { stdio: 'inherit' });
if (check.status !== 0) {
  throw new Error(`[ShotIdIntegrityContract] scriptWriter.js syntax check failed with exit code ${check.status}`);
}
