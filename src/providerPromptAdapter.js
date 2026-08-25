'use strict';

/**
 * StreamVerse Studios — Provider-Aware LLM Prompt Adapter
 *
 * This module is a defensive outbound LLM compatibility seam. The production
 * duration and continuity contracts are authored directly in the source files;
 * this adapter only normalizes residual provider-specific wording on outbound
 * messages when Agnes is selected.
 *
 * Design goals:
 *   1. Agnes receives a real audiovisual/dialogue-directing contract.
 *   2. Existing authored dialogue is protected from duplicate downstream lines.
 *   3. Agnes receives an 18-second temporal canvas instead of the LTX 10-second
 *      default contract.
 *   4. Previous-frame continuity, physical travel, blocking, and performance
 *      rules survive every outbound ScriptWriter/Vision Director request.
 *   5. LTX and Magic Hour requests remain untouched.
 *   6. The adapter is idempotent: a prompt is patched at most once.
 *
 * The interceptor intentionally operates at the Axios request boundary so it
 * covers the same production path during:
 *   full-series simulation -> episode trajectory -> scene simulation ->
 *   pre-generation shot simulation -> scene-shot writing -> Vision Director.
 */

const axios = require('axios');

const AGNES_MARKER = '[[STREAMVERSE_AGNES_PROVIDER_RULES_V4]]';
const AGNES_TEMPORAL_MARKER = '[[STREAMVERSE_AGNES_TEMPORAL_RULES_V4]]';
const AGNES_DIRECTORIAL_MARKER = '[[STREAMVERSE_AGNES_DIRECTORIAL_RULES_V4]]';

const DEFAULT_PROVIDER = 'ltx';
const DEFAULT_AGNES_MAX_DURATION = 18;
const DEFAULT_AGNES_MIN_DURATION = 1;

function isAgnes() {
  return String(process.env.VIDEO_PROVIDER || DEFAULT_PROVIDER)
    .trim()
    .toLowerCase() === 'agnes';
}

function _envNumber(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function getAgnesDurationConfig() {
  const maxDuration = _envNumber(
    'AGNES_MAX_DURATION',
    DEFAULT_AGNES_MAX_DURATION,
    1,
    DEFAULT_AGNES_MAX_DURATION
  );

  const minDuration = Math.min(
    _envNumber(
      'AGNES_MIN_DURATION',
      Math.min(8, maxDuration),
      DEFAULT_AGNES_MIN_DURATION,
      DEFAULT_AGNES_MAX_DURATION
    ),
    maxDuration
  );

  return { minDuration, maxDuration };
}

const AGNES_CONVERSATIONAL_CONTRACT = `
═══ AGNES CONVERSATIONAL FEATURE-FILM CONTRACT — MANDATORY ═══

The active video provider is AGNES. Treat the output as a live-action feature-film
performance in which dialogue, blocking, facial acting, physical action, and camera
language occur as one continuous audiovisual event.

Do not write an episode as a silent montage and do not satisfy a dialogue requirement
with narration. Do not add duplicate dialogue simply because another layer is validating
or enriching the scene.

GLOBAL STORY / PERFORMANCE RULES
- Every character-led episode should contain meaningful interpersonal exchanges whenever
  the situation naturally supports speech: questions, objections, revelations, decisions,
  interruptions, challenges, confessions, threats, negotiations, admissions, refusals,
  reversals, or emotionally consequential responses.
- Dialogue must advance plot AND character relationships. Avoid filler greetings, generic
  acknowledgements, exposition dumps, repetitive statements, and lines that merely repeat
  visible action.
- Preserve each character's distinct voice. A character speaks from their knowledge,
  objective, fear, wound, leverage, social position, and emotional state.
- Existing authored dialogue is authoritative. Downstream layers must preserve it rather
  than inventing a second paraphrase of the same dramatic beat.
- When two or more visible characters are together and a believable exchange is possible,
  prefer direct interaction over internal monologue. Internal monologue is a fallback only
  when visible spoken exchange would be unnatural.
- Spoken words are the only material that may be placed inside quotation marks.
- Actions, emotions, delivery notes, pauses, camera movement, staging, and environmental
  details remain ordinary unquoted prose.

EPISODE SIMULATION CONTRACT
- Plan the episode around a sequence of dramatic conversational beats, not isolated lines.
- Track who wants what from whom, who has information, who withholds it, who learns it,
  who gains or loses leverage, and what changes after each consequential exchange.
- Major turning points should be caused, revealed, challenged, or emotionally reinterpreted
  through character interaction whenever the story context supports it.
- Build a conversational arc where appropriate:
    setup/exchange -> disagreement or discovery -> escalation -> consequential exchange ->
    decision/reversal -> resolution or unresolved hook.
- Do not allow an episode containing several available characters to become a sequence of
  disconnected one-person speaking beats unless the story explicitly requires separation.

SCENE SIMULATION CONTRACT
- A scene containing two or more available characters should contain real multi-character
  interaction whenever physically and dramatically plausible.
- Identify at least two distinct speakers when the cast and situation permit it.
- Prefer at least three meaningful spoken turns for a true conversational scene, with clear
  speaker attribution and response relationships. Fewer turns are acceptable when the scene
  naturally resolves sooner.
- Conversation must have consequence: one character says something, another receives it,
  the relationship/power/information state changes, and the next action follows from that change.
- Silent reaction shots, environmental beats, and physical action are welcome when they support
  the exchange rather than merely replacing it.

SHOT SIMULATION CONTRACT
- For scenes containing sustained dialogue, either:
  (a) preserve a natural multi-speaker exchange in one composition, or
  (b) distribute the conversation across multiple shots while preserving exact chronology.
- Do not split a natural exchange merely to force one speaker into each shot.
- Keep speaker order chronological. Listener reactions occur between lines without changing
  who actually spoke.
- Every dialogue beat should have a performance intention: listening, gaze shift, interruption,
  hesitation, defensive movement, approach, withdrawal, touch, object interaction, or spatial
  reorientation.
- The final dialogue shot should land on the consequence of what was said rather than simply
  ending on another interchangeable line.

DIRECTORIAL BLOCKING CONTRACT
- The canonical blocking/state object is authoritative when present. Do not invent a competing
  spatial map in the provider adapter.
- Preserve every character's established screen position, depth, facing, eyeline, pose, interaction,
  and movement route.
- A character may change position only through described physical action. Never replace a character's
  prior position with a destination pose without an intervening movement.
- Entering, approaching, crossing, sitting, standing, leaving, opening a door, getting into a vehicle,
  and stepping out of a vehicle are physical events. Treat them as part of the performance.
- Listeners should remain physically responsive while someone else speaks. Do not make all visible
  characters stare motionlessly at the speaker.

TRAVEL / NO-TELEPORT CONTRACT
- A meaningful location change follows:
    ORIGIN -> DEPARTURE -> TRANSIT / ROUTE -> ARRIVAL -> DESTINATION STATE.
- The beginning of a travel sequence must describe the real state at departure, not the future destination.
- Transit must show or semantically encode physical progress when the journey matters: walking, corridor
  movement, driving, riding, climbing stairs, crossing a street, entering a vehicle, approaching a doorway,
  or another route-specific movement.
- The destination must not appear as the opening state of a transit shot unless that shot is explicitly
  an arrival/reveal shot.
- Preserve wardrobe, carried props, weather, lighting, injuries, emotional state, and relevant vehicle/seat
  geography throughout transit unless the story explicitly changes them.
- The previous shot's terminal state is the next shot's authoritative opening state.
- Never teleport a character from an origin to a destination merely because the scene/location field changed.

AGNES VIDEO PERFORMANCE CONTRACT
- The supplied reference image is authoritative for the opening visual state of the shot.
- When the reference is the previous shot's final frame, begin from that exact physical and visual state before
  introducing newly authored movement.
- Preserve character identity, wardrobe, props, environment, lighting, blocking, gaze, emotional state,
  and screen geography unless the new action explicitly changes them.
- Agnes should render natural mouth movement for the correct speaker while listeners remain responsive without
  randomly mouthing unassigned dialogue.
- Dialogue should feel acted: interruptions, hesitation, breath, emotional strain, overlapping attention,
  glances, posture shifts, and physical business may accompany speech when the scene supports them.
- No subtitles, captions, title cards, explanatory narration, or invented dialogue.

MULTI-CHARACTER QUALITY BAR
The target is a strong live-action movie conversation: people listen, interrupt, challenge, reconsider,
withhold, reveal, and react. The audience should be able to understand relationship dynamics from blocking
and facial performance even without sound. Avoid turning every exchange into a static talking head.
`;

const AGNES_DIRECTORIAL_CONTRACT = `
═══ AGNES DIRECTORIAL STATE CONSUMPTION CONTRACT — MANDATORY ═══

When these fields exist in the outbound prompt or serialized production state, treat them as the canonical
production plan rather than reconstructing them independently:

- world_state
- narrative_state
- character_state / character_states
- spatial_state
- blocking_plan / blocking_state
- performance_state
- conversation_arc / dialogue_plan
- cinematic_state / camera_intent
- travel_plan / travel_choreography
- editorial_handoff / transition_intent
- audio_state / audio_continuity
- start_frame_state
- end_frame_state
- handoff_to_next / next_shot_continuity

PRIORITY ORDER
1. Existing authored dramatic content and exact quoted dialogue.
2. Canonical world/directorial state supplied by StreamVerse.
3. Previous-frame / end-state continuity.
4. Current shot action and performance direction.
5. Provider-specific audiovisual rendering language.

Do not downgrade structured state into a generic destination pose or generic talking-head description.
The provider prompt is the rendering expression of the directorial plan, not a second independent screenplay.
`;

function _replaceAll(text, patterns) {
  let result = text;
  for (const [pattern, replacement] of patterns) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function _hasAgnesTemporalContent(content) {
  return /(?:SEMANTIC\s+10-SECOND|HARD\s+MAXIMUM\s+OF\s+10\s+SECONDS|8[–-]10\s+seconds|8[–-]10\s+second\s+shots|8[–-]10\s+second\s+visual\s+event|duration\s+must\s+be\s+an\s+integer\s+from\s+8\s+to\s+10|Use\s+10\s+as\s+the\s+raw\s+intended\s+duration|LTX-first\s+production|resulting\s+LTX\s+duration|"(?:duration|clip_duration)"\s*:\s*(?:9|10))/i.test(content);
}

function _patchAgnesTemporalContract(content) {
  if (typeof content !== 'string' || !_hasAgnesTemporalContent(content)) return content;

  const { maxDuration } = getAgnesDurationConfig();

  return _replaceAll(content, [
    [/SEMANTIC\s+10-SECOND\s+CINEMATIC\s+SHOT\s+RULES/gi, `SEMANTIC ${maxDuration}-SECOND CINEMATIC SHOT RULES`],
    [/HARD\s+MAXIMUM\s+OF\s+10\s+SECONDS\s+PER\s+SHOT/gi, `HARD MAXIMUM OF ${maxDuration} SECONDS PER SHOT`],
    [/8–10\s+seconds/gi, `8–${maxDuration} seconds`],
    [/8-10\s+seconds/gi, `8-${maxDuration} seconds`],
    [/8–10\s+second\s+shots/gi, `8–${maxDuration} second shots`],
    [/8-10\s+second\s+shots/gi, `8-${maxDuration} second shots`],
    [/8–10\s+second\s+visual\s+event/gi, `8–${maxDuration} second visual event`],
    [/8-10\s+second\s+visual\s+event/gi, `8-${maxDuration} second visual event`],
    [/duration\s+must\s+be\s+an\s+integer\s+from\s+8\s+to\s+10\s+for\s+LTX-first\s+production/gi, `duration should be planned within an 8–${maxDuration} second cinematic canvas for Agnes production`],
    [/Use\s+10\s+as\s+the\s+raw\s+intended\s+duration\s+because\s+the\s+backend\s+is\s+LTX-first\s+and\s+the\s+pipeline\s+will\s+clamp\s+safely\./gi, `Use ${maxDuration} as the maximum raw intended duration for Agnes; shorter durations remain valid when the shot is semantically complete.`],
    [/The\s+resulting\s+LTX\s+duration\s+will\s+normally\s+be\s+8\.0[–-]10\.0\s+seconds\s+and\s+can\s+reach\s+the\s+full\s+10\.0\s+seconds\s+for\s+rich\s+narrative\s+beats\./gi, `The resulting Agnes duration should normally occupy the available 8.0–${maxDuration}.0 second canvas, reaching ${maxDuration}.0 seconds when the narrative beat benefits from the additional temporal room.`],
    [/The\s+resulting\s+LTX\s+duration\s+will\s+normally\s+be\s+8\.0-10\.0\s+seconds\s+and\s+can\s+reach\s+the\s+full\s+10\.0\s+seconds\s+for\s+rich\s+narrative\s+beats\./gi, `The resulting Agnes duration should normally occupy the available 8.0-${maxDuration}.0 second canvas, reaching ${maxDuration}.0 seconds when the narrative beat benefits from the additional temporal room.`],
    [/("(?:duration|clip_duration)"\s*:\s*)10\b/gi, `$1${maxDuration}`],
    [/("clip_duration"\s*:\s*)9\b/gi, `$1${maxDuration}`],
    [/LTX\s+can\s+receive\s+the\s+complete\s+composition\s+plus\s+multiple\s+speaker\s+lines\s+in\s+chronological\s+order\./gi, 'Agnes can receive the complete composition plus multiple speaker lines in chronological order and generate audiovisual performance natively.'],
    [/MULTI-SPEAKER\s+LTX\s+DIALOGUE/gi, 'MULTI-SPEAKER AUDIOVISUAL DIALOGUE'],
    [/LTX\s+SHOT\s+DESCRIPTION\s+—\s+REQUIRED\s+OUTPUT\s+STYLE/gi, 'AUDIOVISUAL SHOT DESCRIPTION — REQUIRED OUTPUT STYLE'],
    [/LTX\s+image-to-video\s+model/gi, 'active video generation model'],
    [/LTX-ready\s+semantics/gi, 'provider-ready cinematic semantics'],
  ]);
}

function _hasDirectorialSignals(content) {
  return /\b(?:world_state|narrative_state|character_state|character_states|spatial_state|blocking_plan|blocking_state|performance_state|conversation_arc|dialogue_plan|cinematic_state|camera_intent|travel_plan|travel_choreography|editorial_handoff|transition_intent|audio_state|audio_continuity|start_frame_state|end_frame_state|handoff_to_next|next_shot_continuity)\b/i.test(content);
}

function _shouldPatchConversation(content) {
  return /\b(?:series|episode|scene|shot|dialogue|speaker|trajectory|showrunner|scriptwriter|vision\s+director|pre-generation|blocking|continuity|travel|camera|performance)\b/i.test(content);
}

function patchContent(content) {
  if (!isAgnes() || typeof content !== 'string') return content;

  // Idempotency: an already-patched message should never accumulate the contract again.
  if (content.includes(AGNES_MARKER)) return content;

  const temporal = _patchAgnesTemporalContract(content);
  const shouldPatch = _shouldPatchConversation(content) || temporal !== content || _hasDirectorialSignals(content);

  if (!shouldPatch) return content;

  const { minDuration, maxDuration } = getAgnesDurationConfig();

  const suffix = [
    AGNES_MARKER,
    AGNES_CONVERSATIONAL_CONTRACT,
    AGNES_DIRECTORIAL_MARKER,
    AGNES_DIRECTORIAL_CONTRACT,
    AGNES_TEMPORAL_MARKER,
    `═══ AGNES TEMPORAL / CONTINUITY RULES ═══

The Agnes temporal canvas is ${minDuration}–${maxDuration} seconds per shot, with ${maxDuration} seconds as the
maximum intended planning duration. Prefer the full canvas for a rich conversational or physical-performance beat
when the story benefits from sustained action. Do not compress a meaningful exchange into a thin fragment merely to
imitate the LTX 10-second contract. A shorter duration is valid when the dramatic beat is genuinely complete.

Every shot is a temporal progression, not a still image held in place. The opening frame establishes the current state;
the middle develops performance, physical action, environmental response, or dialogue; the ending lands on a readable
consequence and a concrete continuity handoff.

When a shot follows another shot, the previous shot's terminal state is the authoritative opening state. Start from the
same character identity, wardrobe, props, lighting, geography, blocking, gaze, emotional state, and physical relation.
Then describe the causal movement into the new beat. Never teleport a character, reset the scene, or jump directly from
origin to destination without a physical transition when the journey matters.

For travel, preserve this causal order whenever applicable:
ORIGIN -> DEPARTURE -> TRANSIT / ROUTE -> ARRIVAL -> DESTINATION STATE.

For dialogue, preserve exact authored speaker order. Do not invent a second version of an existing line, do not turn
action into speech, and do not add narrator text to satisfy the conversational contract.`,
  ].join('\n\n');

  return `${temporal}\n\n${suffix}`;
}

let installed = false;
let interceptorId = null;

/**
 * Install exactly one Axios request interceptor.
 *
 * Axios request bodies are only touched for object-shaped requests containing
 * an OpenAI-compatible `messages` array. Other requests, providers, headers,
 * media payloads, and response paths remain untouched.
 */
function install() {
  if (installed) return interceptorId;

  installed = true;
  interceptorId = axios.interceptors.request.use((request) => {
    if (!isAgnes() || !request?.data || typeof request.data !== 'object') {
      return request;
    }

    if (!Array.isArray(request.data.messages)) {
      return request;
    }

    request.data.messages = request.data.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;

      return {
        ...message,
        content: patchContent(message.content),
      };
    });

    return request;
  });

  return interceptorId;
}

module.exports = {
  AGNES_MARKER,
  AGNES_TEMPORAL_MARKER,
  AGNES_DIRECTORIAL_MARKER,
  AGNES_CONVERSATIONAL_CONTRACT,
  AGNES_DIRECTORIAL_CONTRACT,
  getAgnesDurationConfig,
  install,
  isAgnes,
  patchContent,
};
