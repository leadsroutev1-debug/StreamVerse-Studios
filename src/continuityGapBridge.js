'use strict';

/**
 * StreamVerse — LTX continuity gap bridging.
 *
 * WHY THIS EXISTS
 * ----------------
 * The public LTX Space contract StreamVerse calls against accepts exactly
 * ONE conditioning image (see docs/AGNES_VIDEO_PROVIDER.md — positional
 * args: image, prompt, duration, enhance_prompt, seed, randomize_seed,
 * height, width). There is no multi-frame / keyframe input on that
 * endpoint, unlike the Agnes adapter, which already submits an ordered
 * [previous terminal frame, fresh current still] keyframe pair for
 * continuity shots (see agnesVideoGen.js).
 *
 * That means every LTX shot has to imply its motion from a SINGLE opening
 * still + text prompt. When the physical/temporal distance between "where
 * the previous shot actually ended" (its real terminal frame — ground
 * truth pixels, not the authored plan) and "where the next shot needs to
 * begin" is small, a direct LTX clip sells it fine. When the distance is
 * large — a location change with no travel beat, a big time skip, a
 * costume change with no visible action, two characters suddenly in a new
 * spatial relationship — a single LTX clip cannot cover it credibly and
 * either hallucinates a warped, morphing pseudo-transition or silently
 * ignores the previous frame.
 *
 * Rather than let that happen, or forcing the still-authoring prompt to
 * paper over it, this module runs a semantic pre-flight: it shows the
 * vision model the ACTUAL previous terminal frame (not a text summary of
 * it) alongside the current shot's authored target, and asks a narrow
 * question: can one LTX clip plausibly carry this, or does the pipeline
 * need to insert one short connective shot first? When a bridge is
 * needed, this module synthesizes that shot in the same object shape the
 * rest of the pipeline already uses (see the reaction-shot insert in
 * `_applyCinematicShotSelection`, src/pipeline.js), so it flows through
 * generation, DB persistence, and compilation unmodified.
 *
 * This is intentionally LTX-only. Agnes already solves this at the
 * conditioning layer via ordered keyframes and does not need a synthetic
 * shot inserted to cover the same gap.
 */

const axios = require('axios');
const config = require('./config');

const DEFAULT_MODEL = process.env.LTX_VISION_MODEL || 'mistral-large-2512';
const REQUEST_TIMEOUT_MS = 120000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;

function _keys() {
  if (Array.isArray(config.mistralKeys) && config.mistralKeys.length) {
    return config.mistralKeys;
  }
  if (process.env.MISTRAL_KEYS) {
    return process.env.MISTRAL_KEYS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (process.env.MISTRAL_API_KEY) return [process.env.MISTRAL_API_KEY];
  return [];
}

async function _downloadImageBuffer(url, label = 'image') {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error(`[ContinuityGapBridge] Invalid ${label} URL`);
  }
  const response = await axios.get(target, {
    responseType: 'arraybuffer',
    timeout: IMAGE_DOWNLOAD_TIMEOUT_MS,
    maxContentLength: 16 * 1024 * 1024,
    maxBodyLength: 16 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300,
  });
  const buffer = Buffer.from(response.data || '');
  if (!buffer.length) throw new Error(`[ContinuityGapBridge] Downloaded ${label} is empty`);
  return {
    buffer,
    mime: String(response.headers?.['content-type'] || 'image/png').split(';')[0].trim() || 'image/png',
  };
}

function _imageDataUrl(buffer, mime) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function _parseStructuredContent(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch (_) { /* fall through */ }
    }
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch (_) { /* fall through */ }
    }
  }
  return null;
}

async function _requestVisionJson({ key, model, system, userText, images = [], attemptLabel }) {
  const content = [{ type: 'text', text: userText }];
  for (const image of images) {
    if (!image?.buffer) continue;
    content.push({ type: 'text', text: image.label || 'REFERENCE IMAGE' });
    content.push({ type: 'image_url', image_url: _imageDataUrl(image.buffer, image.mime || 'image/png') });
  }

  const response = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  const rawContent = response?.data?.choices?.[0]?.message?.content;
  const parsed = _parseStructuredContent(rawContent);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`[ContinuityGapBridge] Invalid structured response ${attemptLabel}`);
  }
  return parsed;
}

const VALID_BRIDGE_TYPES = new Set(['travel', 'turn', 'establishing', 'reaction', 'temporal_cut']);

/**
 * Ask the vision model whether a single direct LTX clip can plausibly
 * carry the pipeline from the previous shot's REAL terminal frame into
 * the current shot's authored target, or whether a short connective shot
 * must be inserted first.
 *
 * Fails open: any evaluation error (no keys, network failure, bad JSON
 * after exhausting all keys) returns needs_bridge=false so a transient
 * vision outage never blocks generation — the existing still-continuity
 * audit later in generateShot() remains the hard backstop for wardrobe/
 * environment/identity drift either way.
 */
async function evaluateContinuityGap({ prevShot, shot, previousEndFrameUrl, scene = {}, characters = [] }) {
  if (!previousEndFrameUrl || !prevShot || !shot) {
    return { needs_bridge: false, reasoning: 'no predecessor terminal frame available' };
  }

  const keys = _keys();
  if (!keys.length) {
    return { needs_bridge: false, reasoning: 'no vision keys configured' };
  }

  let previous;
  try {
    previous = await _downloadImageBuffer(previousEndFrameUrl, 'previous shot terminal frame');
  } catch (err) {
    console.warn(`[ContinuityGapBridge] Could not download terminal frame, skipping gap check: ${err.message}`);
    return { needs_bridge: false, reasoning: 'terminal frame unavailable' };
  }

  const images = [{ label: 'PREVIOUS SHOT — ACTUAL TERMINAL FRAME (ground truth pixels, not the authored plan)', ...previous }];

  const system = [
    'You are a continuity-editing judge for a single-conditioning-image AI video model (LTX).',
    'This model generates one clip from exactly ONE opening still plus a text prompt — it has no keyframe or multi-frame input.',
    'You are shown the REAL terminal frame of the previous shot and the authored target of the NEXT shot.',
    'Judge one narrow question: can a single direct clip, opening on a still that resembles the previous terminal frame, plausibly and non-jarringly arrive at the next shot\'s target state within a few seconds of screen time?',
    'Say needs_bridge=true only when the gap is large enough that a direct clip would require an impossible jump cut, an unexplained location change, an unexplained wardrobe change, unexplained new characters entering, or an implausible amount of physical travel/action for the shot\'s implied duration.',
    'Do not flag ordinary continuity (same or adjacent camera angle, same beat continuing, small natural movement) — only flag a genuine unbridgeable gap.',
    'When needs_bridge is true, bridge_action must be ONE concrete, short, silent physical beat (e.g. "character exits the room and crosses the hallway to the next door") that closes the gap — do not describe an entire new scene.',
    'bridge_shot_type must be exactly one of: travel, turn, establishing, reaction, temporal_cut.',
    'Return JSON with exactly: needs_bridge (boolean), gap_severity ("none"|"moderate"|"large"), reasoning (one or two sentences), bridge_action (string, empty if needs_bridge is false), bridge_shot_type (string, empty if needs_bridge is false).',
  ].join('\n');

  const userText = [
    'PREVIOUS SHOT (terminal frame shown above):',
    JSON.stringify({
      scene_number: prevShot.scene_number,
      shot_index: prevShot.shot_index,
      end_frame_state: prevShot.end_frame_state || '',
      dialogue_or_action: (prevShot.dialogue_or_action || '').slice(0, 300),
    }, null, 2),
    'NEXT SHOT TARGET (what the pipeline needs to open on / play out):',
    JSON.stringify({
      scene_number: shot.scene_number,
      shot_index: shot.shot_index,
      shot_purpose: shot.shot_purpose || shot.purpose || '',
      start_frame_state: shot.start_frame_state || shot._start_frame_handoff || '',
      environment_change: shot.environment_change || shot.scene_transition || '',
      dialogue_or_action: (shot.dialogue_or_action || '').slice(0, 300),
      clip_duration: shot.clip_duration || shot.duration || 4,
      characters_in_shot: shot.characters_in_shot || [],
    }, null, 2),
    'SCENE CONTEXT:',
    JSON.stringify({
      location: scene.location || shot._scene_location || '',
      scene_description: (scene.scene_description || shot._scene_description || '').slice(0, 400),
    }, null, 2),
  ].join('\n\n');

  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const parsed = await _requestVisionJson({
        key: keys[i],
        model: DEFAULT_MODEL,
        system,
        userText,
        images,
        attemptLabel: `gap-eval attempt=${i + 1}/${keys.length} S${shot.scene_number}/idx${shot.shot_index}`,
      });

      const bridgeType = VALID_BRIDGE_TYPES.has(parsed.bridge_shot_type) ? parsed.bridge_shot_type : 'travel';
      return {
        needs_bridge: Boolean(parsed.needs_bridge),
        gap_severity: ['none', 'moderate', 'large'].includes(parsed.gap_severity) ? parsed.gap_severity : (parsed.needs_bridge ? 'moderate' : 'none'),
        reasoning: String(parsed.reasoning || '').slice(0, 500),
        bridge_action: String(parsed.bridge_action || '').slice(0, 400),
        bridge_shot_type: bridgeType,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[ContinuityGapBridge] gap eval key ${i + 1}/${keys.length} failed: ${err.message}`);
    }
  }

  console.warn(`[ContinuityGapBridge] gap evaluation exhausted all keys — failing open (no bridge). Last error: ${lastError?.message}`);
  return { needs_bridge: false, reasoning: 'evaluation unavailable, failed open' };
}

/**
 * Build a synthetic connective shot object in the same shape the rest of
 * the pipeline already produces (see the reaction-shot insert in
 * `_applyCinematicShotSelection`, src/pipeline.js), so it needs no special
 * casing downstream in generateShot(), DB persistence, or compilation.
 *
 * shot_index is the previous shot's index + 0.5 so it sorts correctly
 * between the two real shots; the caller (pipeline.js) re-splices it into
 * the flat allShots array and re-resolves indices for DB/UI display the
 * same way the existing reaction-insert path already does.
 */
function synthesizeBridgeShot({ prevShot, shot, evaluation, previousEndFrameUrl }) {
  const bridgeIndex = Number(prevShot.shot_index) + 0.5;
  const isEstablishing = evaluation.bridge_shot_type === 'establishing';
  const action = evaluation.bridge_action || 'characters complete the physical transition implied by the previous shot';

  return {
    scene_number: shot.scene_number,
    shot_index: bridgeIndex,
    _original_shot_index: null,
    characters_in_shot: shot.characters_in_shot || prevShot.characters_in_shot || [],
    speaker_name: null,
    speakers_in_shot: [],
    tts_mode: 'ambient',
    shot_pacing_type: 'bridge',
    shot_type: isEstablishing ? 'WS' : 'MS',
    camera_type: isEstablishing ? 'wide-shot' : 'medium',
    dialogue_or_action: '',
    framing: `${action}, continuing directly from the immediately preceding frame, no dialogue`,
    image_prompt: `Continuation beat: ${action}. One settled cinematic composition, photorealistic, no motion blur, no temporal progression.`,
    clip_duration: 2.5,
    duration: 2.5,
    motion_level: evaluation.bridge_shot_type === 'temporal_cut' ? 'low' : 'medium',
    _is_continuity_bridge_insert: true,
    _bridge_shot_type: evaluation.bridge_shot_type,
    _bridge_gap_severity: evaluation.gap_severity,
    _bridge_reasoning: evaluation.reasoning || '',
    _bridge_source_frame_url: previousEndFrameUrl,
    _one_speaker_note: 'No dialogue in this shot — silent connective beat.',
    _cinematic_note: `LTX continuity bridge (${evaluation.gap_severity}) — inserted because a single direct clip could not plausibly cover the gap into S${shot.scene_number}/idx${shot.shot_index}: ${evaluation.reasoning}`,
    _continuity_bridge_target_shot_index: shot.shot_index,
  };
}

/**
 * Convenience wrapper: evaluate, and synthesize only if needed.
 * Returns null when no bridge is required.
 */
async function maybeInsertContinuityBridgeShot({ prevShot, shot, previousEndFrameUrl, scene, characters }) {
  const evaluation = await evaluateContinuityGap({ prevShot, shot, previousEndFrameUrl, scene, characters });
  if (!evaluation.needs_bridge) return null;
  console.log(
    `[ContinuityGapBridge] Gap detected (${evaluation.gap_severity}) before S${shot.scene_number}/idx${shot.shot_index}: ${evaluation.reasoning}`
  );
  return synthesizeBridgeShot({ prevShot, shot, evaluation, previousEndFrameUrl });
}

module.exports = {
  evaluateContinuityGap,
  synthesizeBridgeShot,
  maybeInsertContinuityBridgeShot,
};
