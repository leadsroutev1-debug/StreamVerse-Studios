'use strict';

function _norm(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function _lookupCharacterName(value, characters) {
  const needle = _norm(value);
  if (!needle) return null;
  const exact = (characters || []).find(c => _norm(c?.name) === needle);
  if (exact) return exact.name;
  const loose = (characters || []).find(c => {
    const a = _norm(c?.name);
    return a && (a.includes(needle) || needle.includes(a));
  });
  return loose?.name || String(value).trim();
}

function defaultScreenPositions(count) {
  if (count <= 1) return Array.from({ length: count }, () => 'screen-center');
  if (count === 2) return ['screen-left', 'screen-right'];
  if (count === 3) return ['far-left', 'center', 'far-right'];
  return Array.from({ length: count }, (_, i) => {
    const pct = i / Math.max(1, count - 1);
    if (pct < 0.25) return 'far-left';
    if (pct < 0.5) return 'left-of-center';
    if (pct < 0.75) return 'right-of-center';
    return 'far-right';
  });
}

function _normalizePosition(raw, fallback) {
  const text = _norm(raw);
  if (!text) return fallback;
  if (text.includes('far left')) return 'far-left';
  if (text.includes('left') && text.includes('center')) return 'left-of-center';
  if (text === 'left' || text.includes('screen-left') || text.includes('on the left')) return 'screen-left';
  if (text.includes('far right')) return 'far-right';
  if (text.includes('right') && text.includes('center')) return 'right-of-center';
  if (text === 'right' || text.includes('screen-right') || text.includes('on the right')) return 'screen-right';
  if (text === 'center' || text.includes('screen-center') || text.includes('middle')) return 'screen-center';
  return String(raw).trim();
}

function _normalizeDepth(raw) {
  const text = _norm(raw);
  if (!text) return 'midground';
  if (text.includes('foreground') || text === 'front') return 'foreground';
  if (text.includes('background') || text === 'back') return 'background';
  return 'midground';
}

function _stagingIndex(staging, name) {
  const needle = _norm(name);
  return (staging || []).findIndex(s => {
    const n = _norm(s?.name);
    return n && (n === needle || n.includes(needle) || needle.includes(n));
  });
}

function getShotCharacterStaging(shot = {}, characters = []) {
  const visibleNames = Array.isArray(shot.characters_in_shot) && shot.characters_in_shot.length
    ? shot.characters_in_shot.map(n => _lookupCharacterName(n, characters)).filter(Boolean)
    : (characters || []).map(c => c?.name).filter(Boolean);

  const uniqueNames = [...new Map(visibleNames.map(name => [_norm(name), name])).values()];
  const fallbackPositions = defaultScreenPositions(uniqueNames.length);
  const rawStaging = Array.isArray(shot.character_staging) ? shot.character_staging : [];

  return uniqueNames.map((name, i) => {
    const idx = _stagingIndex(rawStaging, name);
    const raw = idx >= 0 ? rawStaging[idx] : {};
    return {
      name,
      screen_position: _normalizePosition(raw.screen_position || raw.position, fallbackPositions[i]),
      depth: _normalizeDepth(raw.depth),
      facing: String(raw.facing || raw.facing_toward || '').trim(),
      action: String(raw.action || raw.observable_action || '').trim(),
      pose: String(raw.pose || '').trim(),
      eyeline: String(raw.eyeline || raw.gaze || '').trim(),
      interaction: String(raw.interaction || '').trim(),
      speaking: Boolean(raw.speaking),
      visual_identity: String(raw.visual_identity || '').trim(),
    };
  });
}

function formatPositionForPrompt(row) {
  const details = [
    row.facing ? `facing ${row.facing}` : '',
    row.pose ? `pose ${row.pose}` : '',
    row.action ? `visible action ${row.action}` : '',
    row.eyeline ? `eyeline ${row.eyeline}` : '',
    row.interaction ? `interaction ${row.interaction}` : '',
  ].filter(Boolean);
  return `${row.screen_position}, ${row.depth}${details.length ? `; ${details.join('; ')}` : ''}`;
}

function formatCharacterStagingBlock(staging, { includeIdentity = true } = {}) {
  return (staging || []).map(row => {
    const identity = includeIdentity ? `CHARACTER ${row.name}: ` : '';
    return `${identity}${formatPositionForPrompt(row)}.`;
  }).join(' ');
}

function findStagingRow(staging, name) {
  const needle = _norm(name);
  return (staging || []).find(row => _norm(row.name) === needle) || null;
}

module.exports = {
  defaultScreenPositions,
  getShotCharacterStaging,
  formatPositionForPrompt,
  formatCharacterStagingBlock,
  findStagingRow,
};
