'use strict';

/**
 * Select the most useful canonical character reference angle for a shot.
 * The four generated portraits are semantic references, not interchangeable
 * images. Selection is driven by shot framing, body visibility, profile/eyeline
 * needs and action/staging semantics.
 */

const ANGLES = Object.freeze(['front', 'three_quarter', 'profile', 'full_body']);

function _norm(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function inferAngleRequirement({ shot = {}, staging = {}, imagePrompt = '' }) {
  const text = _norm([
    shot.shot_type,
    shot.shot_purpose,
    shot.focal_length_hint,
    shot.shot_description,
    shot.image_prompt,
    shot.pose_state,
    shot.camera_movement,
    staging.facing_toward,
    staging.action,
    staging.pose,
    staging.eyeline,
  ].join(' '));

  if (/full body|full-length|whole body|head to toe|walking away|walking across|run(?:ning)?|fight(?:ing)?|reaching|crouch(?:ing)?|lying/.test(text)) {
    return 'full_body';
  }
  if (/profile|side profile|silhouette|side view|three quarter profile|turn(?:s|ed)? to profile/.test(text)) {
    return 'profile';
  }
  if (/ots|over the shoulder|back three quarter|three-quarter|three quarter|45 degree|angled portrait|diagonal face/.test(text)) {
    return 'three_quarter';
  }
  if (/ecu|extreme close|close up|close-up|cu|face|eyes|mouth|expression|reaction|portrait|dialogue close/.test(text)) {
    return 'front';
  }
  if (/85mm|100mm|macro|telephoto/.test(text)) return 'front';
  return 'three_quarter';
}

function selectReferenceAngles({ characters = [], characterStaging = [], shot = {}, maxReferences = 4 } = {}) {
  const refs = [];
  const byName = new Map((characters || []).map(c => [String(c.name || '').toLowerCase(), c]));
  const wanted = Array.isArray(shot.characters_in_shot) ? shot.characters_in_shot : [];

  for (const name of wanted) {
    const character = byName.get(String(name).toLowerCase());
    if (!character) continue;
    const staging = (characterStaging || []).find(s => String(s?.name || '').toLowerCase() === String(name).toLowerCase()) || {};
    const angle = inferAngleRequirement({ shot, staging, imagePrompt: shot.image_prompt });
    const urls = typeof character.reference_image_urls === 'string'
      ? (() => { try { return JSON.parse(character.reference_image_urls); } catch (_) { return []; } })()
      : (Array.isArray(character.reference_image_urls) ? character.reference_image_urls : []);

    // Legacy rows may have only a primary front portrait.
    const ordered = ANGLES.map(a => urls.find(u => _norm(u?.angle || u?.type || u?.name) === a)?.url || urls.find(u => _norm(u?.angle || u?.type || u?.name) === a)).filter(Boolean);
    const front = character.reference_image_url || character.reference_image_url_primary || null;
    const chosen = {
      full_body: ordered[3] || null,
      profile: ordered[2] || null,
      three_quarter: ordered[1] || null,
      front: ordered[0] || front,
    }[angle] || front;

    if (chosen) refs.push({
      name: character.name,
      angle,
      url: typeof chosen === 'string' ? chosen : chosen.url,
      semantic_reason: angle === 'full_body'
        ? 'body/action visibility'
        : angle === 'profile'
          ? 'profile/eyeline geometry'
          : angle === 'three_quarter'
            ? 'angled face/staging geometry'
            : 'facial identity/expression',
    });

    if (refs.length >= maxReferences) break;
  }

  return refs;
}

module.exports = { ANGLES, inferAngleRequirement, selectReferenceAngles };
