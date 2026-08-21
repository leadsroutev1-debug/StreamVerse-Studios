'use strict';

/**
 * StreamVerse Studio — shot-ID integrity migration.
 *
 * Never silently renumber model-generated or checkpointed shot IDs.
 * A scene-local mismatch triggers targeted LLM repair; if the repaired scene
 * still returns invalid IDs, the scene fails instead of being persisted with
 * mutated identifiers.
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
      const badIds = result.shots.map(shot =>
        \`S\${Number.isFinite(Number(shot?.scene_number)) ? Number(shot.scene_number) : 'n/a'}/idx\${Number.isFinite(Number(shot?.shot_index)) ? Number(shot.shot_index) : 'n/a'}\`
      ).join(', ');
      console.warn(
        \`[ScriptWriter] Shot-ID mismatch S\${sceneNo}: model returned [\${badIds}], expected local IDs S\${sceneNo}/idx1..idx\${target}. Refusing to normalize; requesting targeted scene-ID repair.\`
      );

      const repairSystem = \`\${DIRECTOR_PERSONA}\nYou are repairing the shot IDs for ONE already-authored scene simulation. Return JSON only. Preserve every story, action, dialogue, continuity, and staging field exactly. Do not rewrite the scene content.\`;
      const repairPrompt = \`
EPISODE: S\${seasonNumber}E\${episodeNumber}
SCENE: \${sceneNo}
EXPECTED SHOT COUNT: \${target}

THE MODEL RETURNED THESE SHOTS WITH INVALID IDENTIFIERS:
\${JSON.stringify(result.shots)}

CORRECT IDENTIFIER CONTRACT:
- Every shot belongs to scene \${sceneNo}.
- Local shot_index MUST be exactly 1, 2, 3 ... \${target}.
- Do not use episode-global shot numbers.
- Do not reorder the story.
- Preserve every non-ID field from the supplied shots exactly.

Return exactly:
{
  \"shots\": [
    // the same \${target} shot objects, with only scene_number and shot_index corrected
  ]
}
\`;

      let repaired = null;
      for (let repairAttempt = 1; repairAttempt <= 2; repairAttempt++) {
        repaired = await callLLM(repairSystem, repairPrompt, undefined, { useStream: false, temperature: 0.05 });
        if (repaired && Array.isArray(repaired.shots) && idsAreValid(repaired.shots)) break;
        console.warn(\`[ScriptWriter] Targeted shot-ID repair S\${sceneNo} attempt \${repairAttempt}/2 still returned invalid IDs; retrying.\`);
      }

      if (!repaired || !Array.isArray(repaired.shots) || !idsAreValid(repaired.shots)) {
        throw new Error(\`[ScriptWriter] Shot-ID mismatch for S\${seasonNumber}E\${episodeNumber} scene \${sceneNo} could not be repaired. Scene was not checkpointed.\`);
      }

      result = repaired;
      console.log(\`[ScriptWriter] Targeted shot-ID repair succeeded for S\${seasonNumber}E\${episodeNumber} scene \${sceneNo}; exact local IDs verified.\`);
    }

    // IDs are already validated; do not mutate them here.
    const sceneShots = result.shots.map(shot => ({ ...shot }));`;

if (text.includes(oldShotBlock)) {
  text = text.replace(oldShotBlock, newShotBlock, 1);
  changed = true;
}

if (text.includes('Normalizing simulation S${sceneNo}')) {
  throw new Error('[ShotIdIntegrityContract] Legacy shot-ID normalization block is still present');
}
if (!text.includes('Refusing to normalize; requesting targeted scene-ID repair.')) {
  throw new Error('[ShotIdIntegrityContract] Shot-ID repair contract was not installed');
}

if (changed) {
  fs.writeFileSync(scriptPath, text, 'utf8');
  console.log('[ShotIdIntegrityContract] Shot IDs now validate/repair instead of silently renumbering.');
} else {
  console.log('[ShotIdIntegrityContract] Shot-ID integrity contract already present.');
}

const check = spawnSync(process.execPath, ['--check', scriptPath], { stdio: 'inherit' });
if (check.status !== 0) {
  throw new Error(`[ShotIdIntegrityContract] scriptWriter.js syntax check failed with exit code ${check.status}`);
}
