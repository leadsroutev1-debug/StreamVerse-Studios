'use strict';

/**
 * Episode-level character reconciliation.
 *
 * The series cast is authoritative for recurring characters, but an episode
 * may introduce a legitimate supporting/background speaking character that
 * was not part of the original cast bible. Those names must become real DB
 * characters before still/video generation so the normal identity pipeline can
 * generate anchors, reference portraits, voice data and stable seeds.
 */

function _norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[“”’']/g, '')
    .replace(/\b(?:dr|mr|mrs|ms|prof|sir|lady)\b\.?\s*/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _matches(a, b) {
  const left = _norm(a);
  const right = _norm(b);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;

  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  for (const token of leftTokens) {
    if (token.length >= 3 && rightTokens.has(token)) return true;
  }
  return false;
}

function _speakerNames(dialogue) {
  const text = String(dialogue || '');
  const pattern = /([A-Za-z][A-Za-z0-9.'’-]*(?:\s+[A-Za-z][A-Za-z0-9.'’-]*){0,4})\s*:\s+/g;
  const names = [];
  let match;
  while ((match = pattern.exec(text))) {
    const raw = String(match[1] || '').trim();
    const lower = raw.toLowerCase();
    if (/^(note|cut to|fade|smash cut|int|ext|scene|action)$/.test(lower)) continue;
    if (!names.some(name => _matches(name, raw))) names.push(raw);
  }
  return names;
}

async function reconcileMissingEpisodeCharacters({
  storyline,
  episodeScript,
  characterList,
  insertCharactersWithConsistency,
  getCharacters,
}) {
  if (!storyline?.id || !episodeScript || !Array.isArray(characterList)) return characterList;
  if (typeof insertCharactersWithConsistency !== 'function' || typeof getCharacters !== 'function') {
    throw new Error('[CharRecovery] Canonical character persistence functions are unavailable.');
  }

  const requested = new Map();
  const addRequested = (rawName, context = '') => {
    const name = String(rawName || '').trim();
    const key = _norm(name);
    if (!name || !key) return;
    let entry = requested.get(key);
    if (!entry) {
      entry = { name, contexts: [] };
      requested.set(key, entry);
    }
    if (context) entry.contexts.push(context);
  };

  for (const scene of episodeScript.scenes || []) {
    const sceneContext = [
      scene.location,
      scene.scene_description,
      scene.visual_description,
      scene.emotional_beat,
    ].filter(Boolean).join(' ');

    for (const name of scene.characters_present || []) addRequested(name, sceneContext);

    for (const shot of scene.shots || []) {
      const shotContext = [
        sceneContext,
        shot.shot_description,
        shot.image_prompt,
        shot.dialogue_or_action,
        shot.emotional_subtext,
        shot.character_positions,
      ].filter(Boolean).join(' ');

      for (const name of shot.characters_in_shot || []) addRequested(name, shotContext);
      for (const name of shot.speakers_in_shot || []) addRequested(name, shotContext);
      if (shot.speaker_name) addRequested(shot.speaker_name, shotContext);
      for (const name of _speakerNames(shot.dialogue_or_action)) addRequested(name, shotContext);
    }
  }

  const missing = [];
  for (const entry of requested.values()) {
    const exists = characterList.some(character => _matches(entry.name, character?.name));
    if (!exists) missing.push(entry);
  }

  if (!missing.length) return characterList;

  console.warn(
    `[CharRecovery] Missing episode character(s): ${missing.map(item => item.name).join(', ')} — creating canonical character records before media generation.`
  );

  const newCharacters = missing.map(entry => {
    const context = [...new Set(entry.contexts.filter(Boolean))].join(' | ').slice(0, 2500);
    return {
      name: entry.name,
      role: 'episode_supporting_character',
      description: [
        `${entry.name} is a supporting on-screen character introduced by the locked episode script.`,
        context ? `Episode production context: ${context}` : 'Use the role/name context to establish a coherent fictional casting identity.',
      ].join(' '),
      visual_profile: {},
    };
  });

  await insertCharactersWithConsistency(storyline.id, newCharacters);

  const refreshed = await getCharacters(storyline.id);
  characterList.length = 0;
  characterList.push(...refreshed);

  for (const entry of missing) {
    const created = refreshed.find(character => _matches(entry.name, character?.name));
    console.log(
      `[CharRecovery] ${entry.name}: ${created?.reference_image_url ? 'canonical reference portrait ready' : 'DB character created; reference portrait unavailable'}`
    );
  }

  return characterList;
}

module.exports = { reconcileMissingEpisodeCharacters };
