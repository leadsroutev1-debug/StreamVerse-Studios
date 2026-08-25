'use strict';

/**
 * StreamVerse Studios — Director Blocking Engine
 *
 * Deterministic blocking solver. It does not invent story events; it turns the
 * existing authored character/staging information into an explicit spatial
 * contract and detects teleport-like changes between adjacent shots.
 */

const { clean, normalizeSequence, normalizeTravelStage, normalizeTravelMode } = require('./directorState');

const SCREEN_ORDER = ['far-left', 'left', 'center', 'right', 'far-right'];

function rankPosition(value) {
  const text = clean(value).toLowerCase();
  const idx = SCREEN_ORDER.indexOf(text);
  return idx >= 0 ? idx : 2;
}

function normalizePosition(value, fallback = 'center') {
  const raw = clean(value).toLowerCase();
  const aliases = {
    'screen-left': 'left',
    'screen-center': 'center',
    'screen-right': 'right',
    'foreground-left': 'left',
    'foreground-right': 'right',
    'mid-left': 'left',
    'mid-right': 'right',
  };
  if (aliases[raw]) return aliases[raw];
  if (SCREEN_ORDER.includes(raw)) return raw;
  return fallback;
}

function deriveStaging(characters, priorRows = []) {
  const prior = new Map(priorRows.map(r => [clean(r.name), r]));
  const names = characters.map(clean).filter(Boolean);
  const rows = [];

  names.forEach((name, index) => {
    const old = prior.get(name);
    rows.push({
      name,
      screen_position: normalizePosition(
        old?.screen_position,
        names.length === 1 ? 'center' : SCREEN_ORDER[Math.min(index, SCREEN_ORDER.length - 1)]
      ),
      depth: clean(old?.depth) || (index === 0 ? 'midground' : 'midground'),
      facing: clean(old?.facing || old?.facing_toward) || 'toward the story focus',
      facing_toward: clean(old?.facing_toward || old?.facing) || 'the story focus',
      action: clean(old?.action || old?.observable_action) || 'holds the established position',
      observable_action: clean(old?.observable_action || old?.action) || 'holds the established position',
      pose: clean(old?.pose) || 'grounded natural posture',
      eyeline: clean(old?.eyeline || old?.gaze) || 'the immediate story focus',
      gaze: clean(old?.gaze || old?.eyeline) || 'the immediate story focus',
      interaction: clean(old?.interaction) || 'none beyond established scene relationship',
      speaking: Boolean(old?.speaking),
      visual_identity: clean(old?.visual_identity) || 'preserve locked cast identity',
    });
  });

  return rows;
}

function solveBlocking(shot, previousShot = null) {
  const out = { ...shot };
  const visible = Array.isArray(out.characters_in_shot) ? out.characters_in_shot.map(clean).filter(Boolean) : [];
  const previousRows = Array.isArray(previousShot?.character_staging) ? previousShot.character_staging : [];
  const existingRows = Array.isArray(out.character_staging) ? out.character_staging : [];

  const baseRows = existingRows.length
    ? existingRows
    : deriveStaging(visible, previousRows);

  // Preserve authored screen geography. Only apply movement when the shot itself
  // explicitly says the body physically moved.
  const rows = baseRows.map(row => {
    const name = clean(row.name);
    const prior = previousRows.find(r => clean(r.name) === name);
    const movementText = `${clean(row.action)} ${clean(out.route_beat)} ${clean(out.subject_motion)} ${clean(out.action_arc)}`.toLowerCase();
    const physicallyMoving = /\b(walk|run|step|cross|approach|enter|exit|leave|sit|stand|drive|ride|move|turn)\b/.test(movementText);

    let position = normalizePosition(row.screen_position);
    if (!physicallyMoving && prior) {
      position = normalizePosition(prior.screen_position, position);
    }

    return {
      ...row,
      name,
      screen_position: position,
      depth: clean(row.depth) || clean(prior?.depth) || 'midground',
      action: clean(row.action) || clean(prior?.action) || 'holds the established position',
      observable_action: clean(row.observable_action || row.action) || clean(prior?.observable_action || prior?.action) || 'holds the established position',
    };
  });

  out.character_staging = rows;
  out.character_positions = rows
    .map(r => `${r.name}: ${r.screen_position}, ${r.depth}, ${r.pose}, facing ${r.facing_toward}, eyeline ${r.eyeline}, action ${r.observable_action}.`)
    .join(' ');
  out._blocking_state = {
    characters: rows,
    preserve_screen_geography: true,
    movement_requires_explicit_cause: true,
  };

  return out;
}

function detectTeleport(prevShot, nextShot) {
  const violations = [];
  if (!prevShot || !nextShot) return violations;

  const prevRows = new Map((prevShot.character_staging || []).map(r => [clean(r.name), r]));
  const nextRows = nextShot.character_staging || [];

  for (const next of nextRows) {
    const prior = prevRows.get(clean(next.name));
    if (!prior) continue;

    const priorPos = normalizePosition(prior.screen_position);
    const nextPos = normalizePosition(next.screen_position);
    const positionDelta = Math.abs(rankPosition(priorPos) - rankPosition(nextPos));
    const actionText = `${clean(next.action)} ${clean(next.observable_action)} ${clean(nextShot.action_arc)} ${clean(nextShot.route_beat)}`.toLowerCase();
    const explicitMove = /\b(walk|run|cross|approach|enter|exit|leave|drive|ride|move|sit|stand)\b/.test(actionText);

    if (positionDelta >= 2 && !explicitMove) {
      violations.push({
        type: 'blocking_teleport',
        severity: 'high',
        character: clean(next.name),
        message: `${next.name} jumps from ${priorPos} to ${nextPos} without an explicit physical movement.`,
        correction: `${next.name} must retain ${priorPos} until an observable movement changes screen geography.`,
      });
    }
  }

  return violations;
}

function applyBlockingToEpisode(script) {
  if (!script || !Array.isArray(script.scenes)) return script;
  let previousSceneLast = null;

  for (const scene of script.scenes) {
    const shots = Array.isArray(scene.shots) ? scene.shots : [];
    const normalized = [];

    for (const shot of shots) {
      const solved = solveBlocking(shot, normalized[normalized.length - 1] || previousSceneLast);
      solved._blocking_violations = detectTeleport(
        normalized[normalized.length - 1] || previousSceneLast,
        solved
      );
      normalized.push(solved);
    }

    scene.shots = normalized;
    previousSceneLast = normalized[normalized.length - 1] || previousSceneLast;
  }

  return script;
}

module.exports = {
  solveBlocking,
  detectTeleport,
  deriveStaging,
  applyBlockingToEpisode,
};
