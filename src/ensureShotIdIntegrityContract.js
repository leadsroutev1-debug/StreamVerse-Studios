'use strict';

/**
 * StreamVerse Studio — shot-ID integrity migration.
 *
 * Never silently renumber model-generated or checkpointed shot IDs.
 * A scene-local mismatch triggers targeted LLM repair and keeps retrying until
 * the exact required scene/shot identifiers are returned. Every failed repair
 * feeds the observed IDs and validation error back to Mistral.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.resolve(__dirname, 'scriptWriter.js');
let text = fs.readFileSync(scriptPath, 'utf8');
let changed = false;

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

const oldShotBlock = `    const result = await callLLM(systemPrompt, userPrompt, undefined, { useStream: false, temperature: 0.2 });
    if (!result || !Array.isArray(result.shots)) {
      throw new Error(\`[ScriptWriter] Shot simulation invalid for S\${seasonNumber}E\${episodeNumber} scene \${sceneNo}: missing shots array\`);
    }
    if (result.shots.length !== target) {
      throw new Error(\`[ScriptWriter] Shot simulation invalid for S\${seasonNumber}E\${episodeNumber} scene \${sceneNo}: expected \${target} shots, got \${result.shots.length}\`);
    }

    const sceneShots = result.shots.map((shot, i) => {
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

const newShotBlock = `    let result = await callLLM(systemPrompt, userPrompt, undefined, { useStream: false, temperature: 0.2 });
    if (!result || !Array.isArray(result.shots)) {
      throw new Error(\`[ScriptWriter] Shot simulation invalid for S\${seasonNumber}E\${episodeNumber} scene \${sceneNo}: missing shots array\`);
    }
    if (result.shots.length !== target) {
      throw new Error(\`[ScriptWriter] Shot simulation invalid for S\${seasonNumber}E\${episodeNumber} scene \${sceneNo}: expected \${target} shots, got \${result.shots.length}\`);
    }

    const idsAreValid = shots => shots.length === target && shots.every((shot, i) =>
      Number(shot?.scene_number) === sceneNo && Number(shot?.shot_index) === i + 1
    );

    if (!idsAreValid(result.shots)) {
      let repairAttempt = 0;
      let lastValidationError = '';
      let repaired = null;

      while (true) {
        repairAttempt += 1;
        const badIds = Array.isArray(result?.shots)
          ? result.shots.map(shot =>
              \`S\${Number.isFinite(Number(shot?.scene_number)) ? Number(shot.scene_number) : 'n/a'}/idx\${Number.isFinite(Number(shot?.shot_index)) ? Number(shot.shot_index) : 'n/a'}\`
            ).join(', ')
          : 'missing shots array';
        lastValidationError =
          \`Expected exactly \${target} shots for S\${sceneNo} with local shot_index 1..\${target}; received [\${badIds}].\`;

        console.warn(
          \`[ScriptWriter] Shot-ID mismatch S\${sceneNo}: \${lastValidationError} Targeted repair attempt \${repairAttempt}; refusing to normalize.\`
        );

        const repairSystem = \`\${DIRECTOR_PERSONA}\nYou are repairing the shot identifiers for ONE already-authored scene simulation. Return JSON only. Preserve every story, action, dialogue, continuity, staging, and ordering field exactly. Only correct the identifiers. Never use episode-global numbering.\`;
        const repairPrompt = \`
EPISODE: S\${seasonNumber}E\${episodeNumber}
SCENE: \${sceneNo}
EXPECTED SHOT COUNT: \${target}

VALIDATION ERROR FROM THE PREVIOUS RESPONSE:
\${lastValidationError}

THE PREVIOUS MODEL RESPONSE WAS:
\${JSON.stringify(result?.shots || null)}

CORRECT IDENTIFIER CONTRACT:
- Every shot MUST have scene_number = \${sceneNo}.
- Local shot_index MUST be exactly 1, 2, 3 ... \${target}.
- Do NOT use episode-global shot numbers.
- Do NOT renumber by inference outside this requested contract.
- Preserve every non-ID field exactly.
- Return the SAME \${target} shot objects in the SAME story order, changing ONLY scene_number and shot_index.

Return exactly:
{
  \"shots\": [
    { \"scene_number\": \${sceneNo}, \"shot_index\": 1, ... },
    { \"scene_number\": \${sceneNo}, \"shot_index\": 2, ... }
  ]
}
\`;

        repaired = await callLLM(repairSystem, repairPrompt, undefined, {
          useStream: false,
          temperature: 0.02,
        });

        if (repaired && Array.isArray(repaired.shots) && idsAreValid(repaired.shots)) {
          result = repaired;
          console.log(
            \`[ScriptWriter] Targeted shot-ID repair succeeded for S\${seasonNumber}E\${episodeNumber} scene \${sceneNo} after \${repairAttempt} attempt(s); exact local IDs verified.\`
          );
          break;
        }

        // Keep the exact bad response in context so the next repair call can correct
        // the specific format error instead of repeating a generic instruction.
        result = repaired && Array.isArray(repaired?.shots) ? repaired : result;
      }
    }

    // IDs have been validated. Never mutate them here.
    const sceneShots = result.shots.map(shot => ({ ...shot }));`;

if (text.includes(oldShotBlock)) {
  text = text.replace(oldShotBlock, newShotBlock, 1);
  changed = true;
}

if (text.includes('Normalizing simulation S${sceneNo}')) {
  throw new Error('[ShotIdIntegrityContract] Legacy shot-ID normalization block is still present');
}
if (!text.includes('Targeted repair attempt ${repairAttempt}; refusing to normalize.')) {
  throw new Error('[ShotIdIntegrityContract] Retry-until-valid shot-ID repair contract was not installed');
}
if (text.includes('could not be repaired. Scene was not checkpointed')) {
  throw new Error('[ShotIdIntegrityContract] Scene-failure fallback is still present');
}

if (changed) {
  fs.writeFileSync(scriptPath, text, 'utf8');
  console.log('[ShotIdIntegrityContract] Shot IDs now validate and retry with exact validation feedback instead of silently renumbering or failing the scene.');
} else {
  console.log('[ShotIdIntegrityContract] Shot-ID integrity contract already present.');
}

const check = spawnSync(process.execPath, ['--check', scriptPath], { stdio: 'inherit' });
if (check.status !== 0) {
  throw new Error(`[ShotIdIntegrityContract] scriptWriter.js syntax check failed with exit code ${check.status}`);
}
