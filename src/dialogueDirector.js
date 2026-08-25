'use strict';

/**
 * StreamVerse Studios — Conversation / Performance Director
 *
 * Turns authored dialogue into a structured performance plan. It does not
 * invent lines. It extracts speaker turns, intent and reaction opportunities
 * from the already-authored shot dialogue and exposes that structure to the
 * camera/video/validation stages.
 */

const { clean } = require('./directorState');

function parseTurns(value) {
  const text = clean(value);
  if (!text) return [];

  const lines = String(value).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const turns = [];

  for (const line of lines) {
    const m = line.match(/^([^:()]{1,80})\s*(?:\(V\.O\.\)|\(VO\))?\s*:\s*(.*)$/i);
    if (m) {
      const speaker = clean(m[1]);
      const words = clean(m[2]);
      if (speaker && words) turns.push({ speaker, text: words });
      continue;
    }

    const quoted = line.match(/^([A-Za-z][A-Za-z0-9 .,'’'-]{1,70})\s*\(\s*said|^([A-Za-z][A-Za-z0-9 .,'’'-]{1,70})\s*:\s*(.*)$/i);
    if (quoted) {
      const speaker = clean(quoted[1] || quoted[2]);
      const words = clean(quoted[3] || '');
      if (speaker && words) turns.push({ speaker, text: words });
      continue;
    }
  }

  if (!turns.length) {
    const speaker = clean(value.speaker_name || '');
    if (speaker) turns.push({ speaker, text: text });
  }

  return turns;
}

function inferTurnIntent(text, previousText = '') {
  const t = clean(text).toLowerCase();
  if (/\?/.test(t)) return 'question / pressure';
  if (/\b(because|actually|truth|fact|know|found out|discovered)\b/.test(t)) return 'revelation / information';
  if (/\b(no|never|won't|cannot|can't|stop|leave me|don't)\b/.test(t)) return 'refusal / boundary';
  if (/\b(wait|listen|look|please)\b/.test(t)) return 'interruption / redirect';
  if (/\b(i will|i am going|we need|let's|do it|come with me)\b/.test(t)) return 'decision / action';
  if (/\b(sorry|forgive|love|miss|afraid|scared|hurt)\b/.test(t)) return 'emotional exposure';
  if (previousText && /\b(and|but|then|so)\b/.test(t)) return 'counter / response';
  return 'dramatic continuation';
}

function buildConversationPlan(shot) {
  const turns = parseTurns(shot.dialogue_or_action || shot.dialogue || '');
  const speakers = [...new Set(turns.map(t => t.speaker).filter(Boolean))];

  const planTurns = turns.map((turn, index) => ({
    index: index + 1,
    speaker: turn.speaker,
    intent: inferTurnIntent(turn.text, turns[index - 1]?.text || ''),
    text: turn.text,
    reaction_required_after: index < turns.length - 1,
  }));

  const multiSpeaker = speakers.length >= 2 || planTurns.length >= 2;

  return {
    multi_speaker: multiSpeaker,
    speakers,
    turn_count: planTurns.length,
    turns: planTurns,
    shared_composition_preferred: multiSpeaker,
    reaction_points: planTurns.filter(t => t.reaction_required_after).map(t => t.index),
    subtext: clean(shot.subtext || shot.emotional_subtext || ''),
    dialogue_purpose: clean(shot.dialogue_purpose || shot.dialogue_intent || ''),
  };
}

function applyConversationDirector(script) {
  if (!script || !Array.isArray(script.scenes)) return script;

  for (const scene of script.scenes) {
    for (const shot of scene.shots || []) {
      const plan = buildConversationPlan(shot);
      shot._conversation_plan = plan;
      shot.reaction_points = plan.reaction_points;
      shot.speakers_in_shot = plan.speakers.length
        ? plan.speakers
        : (Array.isArray(shot.speakers_in_shot) ? shot.speakers_in_shot : []);
      if (plan.multi_speaker) {
        shot.dialogue_directorial_note =
          'Keep visible listeners engaged in the same chronological performance; reactions and interruptions remain in the same spatial geography unless the authored action moves them.';
      }
    }
  }
  return script;
}

module.exports = { parseTurns, buildConversationPlan, applyConversationDirector };
