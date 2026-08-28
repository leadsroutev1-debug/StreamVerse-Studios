'use strict';

/**
 * StreamVerse Studios — Hard Wardrobe State
 *
 * Deterministic wardrobe continuity ledger. This is intentionally NOT an LLM
 * and does not reinterpret story prose. It establishes one canonical wardrobe
 * state per character and scene/shot, then makes any legitimate wardrobe change
 * explicit and physically visible.
 *
 * Rules:
 *   1. A character inherits the last canonical wardrobe until an explicit change.
 *   2. A wardrobe change MUST occur in a dedicated live-change shot for each
 *      affected character. The change shot must identify who changes, the prior
 *      state, the new state, and a visible changing/dressing action.
 *   3. A downstream shot may not silently introduce a different wardrobe.
 *   4. The resulting state is attached to every shot as `_hard_wardrobe_state`
 *      and `_hard_wardrobe_directive` for provider-neutral consumption.
 */

const CHANGE_KEYS = Object.freeze([
  'wardrobe_change',
  'wardrobeChange',
  'wardrobe_transition',
  'wardrobeTransition',
  'change_wardrobe',
  'changeWardrobe',
]);

const STATE_KEYS = Object.freeze([
  'wardrobe_state',
  'wardrobeState',
  'wardrobe',
  'costume',
  'clothing',
  'attire',
]);

const CHANGE_ACTION_RE = /\b(change(?:s|d|ing)?|changed|changing|dress(?:es|ed|ing)?|dressed|redress(?:es|ed|ing)?|redresses|puts on|put on|takes off|take off|remove(?:s|d)?|removes|switch(?:es|ed|ing)?|switches|don(?:s|ned|ning)?|dons|undress(?:es|ed|ing)?)\b/i;

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function nameKey(value) {
  return clean(value).toLowerCase();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return '';
}

function uniqueNames(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const name = clean(value);
    const key = nameKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function getCharacterCanonicalWardrobe(character = {}) {
  const visual = character?.visual_profile && typeof character.visual_profile === 'object'
    ? character.visual_profile
    : {};

  return firstNonEmpty(
    character.wardrobe,
    character.wardrobe_state,
    character.costume,
    character.clothing,
    character.attire,
    visual.wardrobe,
    visual.wardrobe_state,
    visual.costume,
    character.signature_clothing
  );
}

function extractStagedNames(scene = {}) {
  const names = [];
  for (const shot of Array.isArray(scene.shots) ? scene.shots : []) {
    if (Array.isArray(shot.characters_in_shot)) names.push(...shot.characters_in_shot);
    if (Array.isArray(shot.character_staging)) {
      names.push(...shot.character_staging.map(row => row?.name));
    }
  }
  return uniqueNames(names);
}

function allCharacters(characters = [], scene = {}) {
  const fromCharacters = (Array.isArray(characters) ? characters : []).map(c => c?.name);
  return uniqueNames([...fromCharacters, ...extractStagedNames(scene)]);
}

function normalizeWardrobeMap(value) {
  if (!value) return {};
  if (typeof value === 'string') return {};
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .filter(Boolean)
        .map(item => [
          clean(item?.character || item?.name || item?.speaker),
          firstNonEmpty(item?.wardrobe, item?.wardrobe_state, item?.costume, item?.clothing, item?.attire),
        ])
        .filter(([name, wardrobe]) => name && wardrobe)
    );
  }
  if (typeof value === 'object') return value;
  return {};
}

function extractExplicitStateMap(scene = {}, shot = {}) {
  const candidates = [
    shot.wardrobe_states,
    shot.wardrobeStates,
    shot.character_wardrobe,
    shot.characterWardrobe,
    scene.wardrobe_states,
    scene.wardrobeStates,
    scene.character_wardrobe,
    scene.characterWardrobe,
    scene.wardrobe_context,
    scene.wardrobeContext,
  ];

  for (const candidate of candidates) {
    const map = normalizeWardrobeMap(candidate);
    if (Object.keys(map).length) return map;
  }
  return {};
}

function getSingleWardrobeValue(shot, name) {
  const map = extractExplicitStateMap({}, shot);
  const key = nameKey(name);
  for (const [candidate, wardrobe] of Object.entries(map)) {
    if (nameKey(candidate) === key && clean(wardrobe)) return clean(wardrobe);
  }

  for (const keyName of STATE_KEYS) {
    const raw = shot?.[keyName];
    if (typeof raw === 'string' && clean(raw)) return clean(raw);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [candidate, wardrobe] of Object.entries(raw)) {
        if (nameKey(candidate) === key && clean(wardrobe)) return clean(wardrobe);
      }
    }
  }
  return '';
}

function extractChangeRecords(shot = {}) {
  const records = [];
  for (const key of CHANGE_KEYS) {
    const raw = shot?.[key];
    if (!raw) continue;

    if (Array.isArray(raw)) {
      for (const item of raw) records.push(normalizeChangeRecord(item, shot));
    } else if (typeof raw === 'object') {
      if (Array.isArray(raw.characters)) {
        for (const item of raw.characters) records.push(normalizeChangeRecord({ ...raw, ...(typeof item === 'object' ? item : { character: item }) }, shot));
      } else if (Array.isArray(raw.character_names)) {
        for (const name of raw.character_names) records.push(normalizeChangeRecord({ ...raw, character: name }, shot));
      } else {
        records.push(normalizeChangeRecord(raw, shot));
      }
    } else {
      records.push(normalizeChangeRecord({ description: raw }, shot));
    }
  }

  const legacyFlags = [
    shot.changing_clothes,
    shot.changingClothes,
    shot.wardrobe_change_shot,
    shot.wardrobeChangeShot,
  ].filter(Boolean);
  for (const flag of legacyFlags) {
    if (typeof flag === 'object') records.push(normalizeChangeRecord(flag, shot));
    else records.push(normalizeChangeRecord({ description: String(flag) }, shot));
  }

  return records.filter(Boolean);
}

function normalizeChangeRecord(raw = {}, shot = {}) {
  const character = clean(
    raw.character || raw.character_name || raw.characterName || raw.name || raw.speaker || ''
  );
  const from = firstNonEmpty(raw.from, raw.from_wardrobe, raw.previous_wardrobe, raw.previousWardrobe, raw.current, '');
  const to = firstNonEmpty(raw.to, raw.to_wardrobe, raw.new_wardrobe, raw.newWardrobe, getSingleWardrobeValue(shot, character));
  const action = firstNonEmpty(
    raw.action,
    raw.visible_action,
    raw.change_action,
    raw.description,
    shot.wardrobe_change_action,
    shot.wardrobeChangeAction,
    shot.subject_motion,
    shot.action_arc
  );
  return {
    character,
    from,
    to,
    action,
    visible: raw.visible !== false,
  };
}

function hasExplicitChangeShot(shot, characterName) {
  const records = extractChangeRecords(shot);
  const key = nameKey(characterName);
  return records.some(record =>
    (!record.character || nameKey(record.character) === key) &&
    record.visible !== false &&
    CHANGE_ACTION_RE.test(record.action || '')
  );
}

function resolveCharacterName(name, knownNames) {
  const key = nameKey(name);
  return knownNames.find(candidate => nameKey(candidate) === key) || clean(name);
}

function initialSceneState(scene, previousAfter = {}, characters = []) {
  const names = allCharacters(characters, scene);
  const priorChars = previousAfter?.characters || {};
  const sceneMap = normalizeWardrobeMap(
    scene.wardrobe_states || scene.wardrobeStates || scene.character_wardrobe || scene.characterWardrobe ||
    scene.wardrobe_context || scene.wardrobeContext
  );

  const state = {};
  const requestedSceneState = {};
  for (const name of names) {
    const key = nameKey(name);
    const canonicalChar = (characters || []).find(c => nameKey(c?.name) === key) || {};
    const explicitSceneWardrobe = Object.entries(sceneMap).find(([candidate]) => nameKey(candidate) === key)?.[1];
    const inherited = clean(priorChars[name]?.wardrobe);
    const canonical = getCharacterCanonicalWardrobe(canonicalChar);
    state[name] = firstNonEmpty(inherited, canonical, explicitSceneWardrobe);
    requestedSceneState[name] = firstNonEmpty(explicitSceneWardrobe, inherited);
  }
  return { state, requestedSceneState };
}

function buildStateSignature(wardrobe) {
  return clean(wardrobe).toLowerCase().replace(/[“”'`]/g, '"').replace(/\s+/g, ' ').trim();
}

function differentWardrobe(a, b) {
  const aa = buildStateSignature(a);
  const bb = buildStateSignature(b);
  return Boolean(aa && bb && aa !== bb);
}

function buildDirectiveForShot(shot, openingState) {
  const visibleNames = uniqueNames([
    ...(Array.isArray(shot?.characters_in_shot) ? shot.characters_in_shot : []),
    ...(Array.isArray(shot?.character_staging) ? shot.character_staging.map(row => row?.name) : []),
  ]);
  const scopedEntries = visibleNames.length
    ? visibleNames.map(name => [name, wardrobeForMap(openingState, name)]).filter(([, wardrobe]) => clean(wardrobe))
    : Object.entries(openingState || {}).filter(([, wardrobe]) => clean(wardrobe));
  const lines = scopedEntries.map(([name, wardrobe]) => `${name}: ${wardrobe}`).join('; ');
  const records = extractChangeRecords(shot);

  if (records.length) {
    const changeText = records.map(r => {
      const from = clean(r.from) || 'the established wardrobe';
      const to = clean(r.to) || 'the explicitly authored new wardrobe';
      return `${r.character || 'the named character'} visibly removes and/or dons clothing during this shot, changing from ${from} to ${to}`;
    }).join('; ');
    return `HARD WARDROBE OPENING STATE: ${lines || 'preserve the visibly established wardrobe'}. ${changeText}. The opening frame must show the FROM wardrobe. The wardrobe change must happen visibly and physically on-screen; do not cut or morph directly to the TO wardrobe. After the live change completes, the TO wardrobe becomes canonical for subsequent shots.`;
  }

  return `HARD WARDROBE STATE: ${lines || 'preserve the visibly established wardrobe'}. These wardrobe states are locked for this shot and may not change during the shot. No spontaneous outfit, costume, clothing, hairstyle or accessory substitution.`;
}

function wardrobeForMap(state, characterName) {
  const key = nameKey(characterName);
  for (const [name, wardrobe] of Object.entries(state || {})) {
    if (nameKey(name) === key) return clean(wardrobe);
  }
  return '';
}

/**
 * Apply the hard wardrobe ledger to a full episode script.
 * Throws only on a NEW conflicting wardrobe state that is not accompanied by a
 * valid live wardrobe-change shot. Existing/legacy shots without wardrobe data
 * inherit state silently, which keeps old drafts backward compatible.
 */
function applyHardWardrobeState(script, characters = []) {
  if (!script || !Array.isArray(script.scenes)) return script;

  const episodeState = {
    characters: {},
    scene_number: null,
  };

  let previousAfter = { characters: {} };

  for (const scene of script.scenes) {
    const names = allCharacters(characters, scene);
    const sceneInitialization = initialSceneState(scene, previousAfter, characters);
    const before = sceneInitialization.state;
    const requestedSceneState = sceneInitialization.requestedSceneState;
    const state = { characters: {} };

    for (const name of names) {
      state.characters[name] = before[name] || '';
      const requested = requestedSceneState[name] || '';
      if (
        requested && before[name] && differentWardrobe(before[name], requested) &&
        Number(scene.scene_number || 0) > 1
      ) {
        // A scene-level wardrobe declaration may announce an intended context,
        // but it cannot silently become the worn state. A dedicated shot must
        // perform the visible change before the new state is adopted.
        state.requestedSceneChanges = state.requestedSceneChanges || [];
        state.requestedSceneChanges.push({
          character: name,
          from: before[name],
          to: requested,
        });
      }
    }

    scene._hard_wardrobe_before = JSON.parse(JSON.stringify(state));
    scene.hard_wardrobe_state = JSON.parse(JSON.stringify(state));

    let prior = JSON.parse(JSON.stringify(state.characters));
    const shots = Array.isArray(scene.shots) ? scene.shots.slice().sort((a, b) => Number(a.shot_index || 0) - Number(b.shot_index || 0)) : [];

    if (Array.isArray(state.requestedSceneChanges) && state.requestedSceneChanges.length) {
      for (const requested of state.requestedSceneChanges) {
        const firstChangeShot = shots.find(shot => hasExplicitChangeShot(shot, requested.character));
        if (!firstChangeShot) {
          throw new Error(
            `[HardWardrobe] Scene ${scene.scene_number} requests a new wardrobe for ${requested.character} ` +
            `from "${requested.from}" to "${requested.to}" but no dedicated live wardrobe-change shot exists. ` +
            `The character must visibly change clothes on-screen before the new wardrobe becomes active.`
          );
        }
      }
    }

    delete state.requestedSceneChanges;

    for (const shot of shots) {
      const shotChanges = extractChangeRecords(shot);
      const opening = { ...prior };
      const closing = { ...prior };
      const shotNames = uniqueNames([
        ...(Array.isArray(shot.characters_in_shot) ? shot.characters_in_shot : []),
        ...(Array.isArray(shot.character_staging) ? shot.character_staging.map(row => row?.name) : []),
        ...Object.keys(shot.wardrobe_states || shot.wardrobeStates || shot.character_wardrobe || shot.characterWardrobe || {}),
      ]);

      for (const name of shotNames) {
        const canonicalName = resolveCharacterName(name, names);
        const explicit = getSingleWardrobeValue(shot, name);
        if (!explicit) continue;
        const priorWardrobe = opening[canonicalName] || '';
        if (differentWardrobe(priorWardrobe, explicit)) {
          const approved = hasExplicitChangeShot(shot, canonicalName);
          if (!approved) {
            throw new Error(
              `[HardWardrobe] Unapproved wardrobe change in S${scene.scene_number}/idx${shot.shot_index || '?'} for ${canonicalName}. ` +
              `Previous state="${priorWardrobe || 'unknown'}" new state="${explicit}". ` +
              `A dedicated live wardrobe-change shot must show ${canonicalName} visibly changing clothes before the new wardrobe becomes canonical.`
            );
          }
        }
      }

      const records = shotChanges.map(record => ({ ...record }));
      for (const record of records) {
        const canonicalName = resolveCharacterName(record.character, names);
        if (!canonicalName) {
          throw new Error(`[HardWardrobe] Wardrobe change shot S${scene.scene_number}/idx${shot.shot_index || '?'} names no known character.`);
        }
        const visibleNames = new Set(shotNames.map(nameKey));
        if (record.character && !visibleNames.has(nameKey(canonicalName))) {
          throw new Error(`[HardWardrobe] Wardrobe change for ${canonicalName} in S${scene.scene_number}/idx${shot.shot_index || '?'} requires that character to be visible in the shot.`);
        }
        record.from = firstNonEmpty(record.from, opening[canonicalName]);
        record.to = firstNonEmpty(record.to, getSingleWardrobeValue(shot, canonicalName));
        if (!record.from || !record.to) {
          throw new Error(`[HardWardrobe] Wardrobe change shot S${scene.scene_number}/idx${shot.shot_index || '?'} for ${canonicalName} must identify both from and to wardrobe states.`);
        }
        if (!CHANGE_ACTION_RE.test(record.action || '')) {
          throw new Error(`[HardWardrobe] Wardrobe change shot S${scene.scene_number}/idx${shot.shot_index || '?'} for ${canonicalName} must contain a visible live changing/dressing action.`);
        }
        closing[canonicalName] = clean(record.to);
      }

      const hasChange = records.length > 0;
      for (const name of names) {
        const explicit = getSingleWardrobeValue(shot, name);
        if (explicit && !hasChange && differentWardrobe(opening[name], explicit)) {
          // Defensive check: a different explicit wardrobe without a change
          // record was already rejected above; never let it become state.
          throw new Error(`[HardWardrobe] Wardrobe state drift detected for ${name} in S${scene.scene_number}/idx${shot.shot_index || '?'} without a dedicated change shot.`);
        }
      }

      shot._hard_wardrobe_state = {
        scene_number: Number(scene.scene_number || 0),
        shot_index: Number(shot.shot_index || 0),
        characters: JSON.parse(JSON.stringify(opening)),
        after_characters: JSON.parse(JSON.stringify(closing)),
        change_records: records,
      };
      shot._hard_wardrobe_directive = buildDirectiveForShot(shot, opening);
      shot.wardrobe_state = shot.wardrobe_state || JSON.parse(JSON.stringify(opening));

      prior = closing;
    }

    state.characters = prior;
    scene._hard_wardrobe_after = JSON.parse(JSON.stringify(state));
    previousAfter = state;
    episodeState.characters = prior;
    episodeState.scene_number = Number(scene.scene_number || 0);
  }

  script.hard_wardrobe_state = {
    ...episodeState,
    characters: JSON.parse(JSON.stringify(episodeState.characters || {})),
  };

  return script;
}

function wardrobeForCharacter(shot, characterName) {
  const state = shot?._hard_wardrobe_state?.characters || {};
  const key = nameKey(characterName);
  for (const [name, wardrobe] of Object.entries(state)) {
    if (nameKey(name) === key) return clean(wardrobe);
  }
  return getSingleWardrobeValue(shot, characterName);
}

function buildCharacterWardrobeLines(shot, characters = []) {
  const names = uniqueNames([
    ...(Array.isArray(shot?.characters_in_shot) ? shot.characters_in_shot : []),
    ...(Array.isArray(characters) ? characters.map(c => c?.name) : []),
  ]);
  return names
    .map(name => {
      const wardrobe = wardrobeForCharacter(shot, name);
      return wardrobe ? `${name}: ${wardrobe}` : '';
    })
    .filter(Boolean);
}

module.exports = {
  clean,
  getCharacterCanonicalWardrobe,
  applyHardWardrobeState,
  wardrobeForCharacter,
  buildCharacterWardrobeLines,
  extractChangeRecords,
  hasExplicitChangeShot,
};
