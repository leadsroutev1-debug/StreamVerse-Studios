'use strict';

/**
 * StreamVerse Studios — Semantic Shot Transition Director
 *
 * This is the pre-still continuity pass used by Agnes production.
 *
 * The predecessor's terminal pixels are evidence, not the canvas for the next
 * still. The director inspects those pixels, weighs the authored predecessor
 * state against the authored current-shot state, and determines the causal
 * movement required to get from A -> B. The still generator then renders only
 * the settled B state. Agnes subsequently receives [A, B] as ordered keyframes.
 */

const axios = require('axios');
const config = require('./config');

const DEFAULT_MODEL = process.env.SEMANTIC_TRANSITION_DIRECTOR_MODEL ||
  process.env.LTX_VISION_MODEL || 'mistral-large-2512';
const REQUEST_TIMEOUT_MS = 180000;

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

function _clean(value, max = 1200) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function _json(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return '{}';
  }
}

async function _downloadImage(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('[SemanticTransitionDirector] Invalid previous end-frame URL');
  }
  const response = await axios.get(target, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: 16 * 1024 * 1024,
    maxBodyLength: 16 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300,
  });
  const buffer = Buffer.from(response.data || '');
  if (!buffer.length) throw new Error('[SemanticTransitionDirector] Previous end frame is empty');
  const mime = String(response.headers?.['content-type'] || 'image/png')
    .split(';')[0].trim() || 'image/png';
  return { buffer, mime };
}

function _dataUrl(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('[SemanticTransitionDirector] Empty previous end frame');
  }
  return `data:${mime || 'image/png'};base64,${buffer.toString('base64')}`;
}

function _compactHistoryShot(shot = {}) {
  const compact = _compactShot(shot);
  return {
    scene_number: compact.scene_number,
    shot_index: compact.shot_index,
    shot_type: compact.shot_type,
    shot_purpose: compact.shot_purpose,
    start_frame_state: compact.start_frame_state,
    end_frame_state: compact.end_frame_state,
    next_shot_continuity: compact.next_shot_continuity,
    location: compact.location,
    travel_stage: compact.travel_stage,
    travel_mode: compact.travel_mode,
    route_beat: compact.route_beat,
    characters_in_shot: compact.characters_in_shot,
    character_staging: compact.character_staging,
  };
}

function _compactShot(shot = {}) {
  const staging = Array.isArray(shot.character_staging)
    ? shot.character_staging.map(row => ({
        name: row?.name || '',
        screen_position: row?.screen_position || '',
        depth: row?.depth || '',
        facing: row?.facing || row?.facing_toward || '',
        pose: row?.pose || '',
        eyeline: row?.eyeline || row?.gaze || '',
        interaction: row?.interaction || '',
        action: row?.action || row?.observable_action || '',
      }))
    : [];

  return {
    scene_number: Number(shot.scene_number || 0),
    shot_index: Number(shot.shot_index || 0),
    shot_type: _clean(shot.shot_type, 160),
    shot_purpose: _clean(shot.shot_purpose || shot.purpose, 500),
    image_prompt: _clean(shot.image_prompt, 900),
    start_frame_state: _clean(shot.start_frame_state || shot.start_state, 900),
    end_frame_state: _clean(shot.end_frame_state || shot.end_state, 900),
    next_shot_continuity: _clean(shot.next_shot_continuity || shot.handoff_to_next, 900),
    temporal_arc: _clean(shot.temporal_arc, 900),
    subject_motion: _clean(shot.subject_motion, 500),
    camera_movement: _clean(shot.camera_movement, 350),
    scene_environment: _clean(shot.scene_environment || shot.environmental_story_beat, 650),
    emotional_subtext: _clean(shot.emotional_subtext, 500),
    location: _clean(shot.current_location || shot.location, 350),
    travel_stage: _clean(shot.travel_stage, 80),
    travel_mode: _clean(shot.travel_mode, 80),
    origin_location: _clean(shot.origin_location, 300),
    destination_location: _clean(shot.destination_location, 300),
    route_beat: _clean(shot.route_beat, 500),
    characters_in_shot: Array.isArray(shot.characters_in_shot) ? shot.characters_in_shot.slice(0, 12) : [],
    character_staging: staging,
  };
}

function _compactCharacter(character = {}) {
  return {
    name: _clean(character.name, 180),
    visual_anchor: _clean(character.visual_anchor, 500),
    wardrobe: _clean(character.visual_profile || character.wardrobe_state, 400),
  };
}

function _extractObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text) throw new Error('[SemanticTransitionDirector] Empty structured model response');

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
  return JSON.parse(candidate);
}

function _normalizePlan(raw, { previousShot, currentShot, characters }) {
  const plan = raw && typeof raw === 'object' ? raw : {};
  const roster = new Map((characters || []).map(c => [String(c.name || '').toLowerCase(), c.name]));
  const currentNames = Array.isArray(currentShot?.characters_in_shot)
    ? currentShot.characters_in_shot.map(name => String(name)).filter(Boolean)
    : [];

  const targetRows = Array.isArray(plan.target_character_states) ? plan.target_character_states : [];
  const rowsByName = new Map(targetRows.map(row => [String(row?.name || '').toLowerCase(), row]));

  const normalizedRows = currentNames.map(name => {
    const row = rowsByName.get(name.toLowerCase()) || {};
    return {
      name: roster.get(name.toLowerCase()) || name,
      screen_position: _clean(row.screen_position || '', 80),
      depth: _clean(row.depth || '', 80),
      pose: _clean(row.pose || '', 250),
      facing: _clean(row.facing || row.facing_toward || '', 250),
      eyeline: _clean(row.eyeline || row.gaze || '', 250),
      contact: _clean(row.contact || row.interaction || '', 350),
      settled_action: _clean(row.settled_action || row.action || '', 350),
      movement_from_previous: _clean(row.movement_from_previous || row.causal_action || '', 500),
    };
  });

  const transitionRows = Array.isArray(plan.character_transitions)
    ? plan.character_transitions.map(row => ({
        name: _clean(row?.name, 180),
        from_screen_position: _clean(row?.from_screen_position, 80),
        from_depth: _clean(row?.from_depth, 80),
        from_pose: _clean(row?.from_pose, 250),
        to_screen_position: _clean(row?.to_screen_position, 80),
        to_depth: _clean(row?.to_depth, 80),
        causal_action: _clean(row?.causal_action, 500),
        reason: _clean(row?.reason, 450),
      }))
    : [];

  const fallbackTargetState = _clean(
    plan.target_opening_state || currentShot?.start_frame_state || currentShot?.start_state || currentShot?.image_prompt,
    1200
  );

  const normalized = {
    version: 1,
    transition_required: plan.transition_required !== false,
    transition_type: _clean(plan.transition_type || 'continuation', 80),
    physical_bridge: _clean(plan.physical_bridge || 'Maintain causal physical continuity into the new shot state.', 900),
    camera_bridge: _clean(plan.camera_bridge || '', 500),
    target_opening_state: fallbackTargetState,
    target_character_states: normalizedRows,
    character_transitions: transitionRows,
    target_world_state: {
      location: _clean(plan.target_world_state?.location || currentShot?.location || currentShot?._scene_location, 350),
      lighting: _clean(plan.target_world_state?.lighting || currentShot?._lighting_design, 350),
      environment: _clean(plan.target_world_state?.environment || currentShot?.scene_environment, 650),
      active_props: Array.isArray(plan.target_world_state?.active_props)
        ? plan.target_world_state.active_props.slice(0, 12).map(v => _clean(v, 140)).filter(Boolean)
        : [],
    },
    still_generation_directive: _clean(
      plan.still_generation_directive || fallbackTargetState,
      1400
    ),
    agnes_transition_directive: _clean(
      plan.agnes_transition_directive || plan.physical_bridge,
      1200
    ),
    teleport_risk: Number.isFinite(Number(plan.teleport_risk)) ? Math.max(0, Math.min(1, Number(plan.teleport_risk))) : 0,
    continuity_notes: Array.isArray(plan.continuity_notes)
      ? plan.continuity_notes.slice(0, 10).map(v => _clean(v, 300)).filter(Boolean)
      : [],
    source: {
      previous_shot: `${Number(previousShot?.scene_number || 0)}/${Number(previousShot?.shot_index || 0)}`,
      current_shot: `${Number(currentShot?.scene_number || 0)}/${Number(currentShot?.shot_index || 0)}`,
    },
  };

  if (!normalized.target_character_states.length && currentNames.length) {
    normalized.target_character_states = currentNames.map(name => {
      const source = (currentShot?.character_staging || []).find(r => String(r?.name || '').toLowerCase() === name.toLowerCase()) || {};
      return {
        name,
        screen_position: _clean(source.screen_position, 80),
        depth: _clean(source.depth, 80),
        pose: _clean(source.pose, 250),
        facing: _clean(source.facing || source.facing_toward, 250),
        eyeline: _clean(source.eyeline || source.gaze, 250),
        contact: _clean(source.interaction, 350),
        settled_action: _clean(source.action || source.observable_action, 350),
        movement_from_previous: '',
      };
    });
  }

  return normalized;
}

async function planSemanticTransition({
  previousEndFrameUrl,
  previousShot = {},
  currentShot = {},
  scene = {},
  episode = {},
  characters = [],
  continuityHistory = [],
  model = DEFAULT_MODEL,
} = {}) {
  const keys = _keys();
  if (!keys.length) {
    const err = new Error('[SemanticTransitionDirector] No Mistral keys configured');
    err.code = 'SEMANTIC_TRANSITION_NO_MISTRAL_KEYS';
    throw err;
  }
  if (!previousEndFrameUrl) {
    const err = new Error('[SemanticTransitionDirector] Previous end frame is required for semantic transition planning');
    err.code = 'SEMANTIC_TRANSITION_NO_PREVIOUS_END_FRAME';
    throw err;
  }

  const image = await _downloadImage(previousEndFrameUrl);
  const current = _compactShot(currentShot);
  const previous = _compactShot(previousShot);
  const history = (continuityHistory || []).map(_compactHistoryShot);
  const cast = (characters || []).slice(0, 12).map(_compactCharacter);

  const system = [
    'You are the continuity director and first assistant director for a photorealistic AI feature-film production.',
    'Your job is to construct a physically causal bridge from the exact terminal pixels of the previous shot into the authored opening state of the current shot.',
    'IMAGE 1 is the authoritative terminal frame of the previous shot. Inspect its actual pixels: identify each visible character, screen position, depth, pose, facing, eyeline, hand/prop contact, location, lighting and relevant objects.',
    'The current shot is NOT generated by transforming IMAGE 1. It will be rendered as a fresh still from text plus canonical character/scene references.',
    'Determine what must physically happen between the two states. Characters may walk, drive, enter, exit, turn, sit, stand, approach, hand off a prop, change depth, or remain stationary when no movement is needed.',
    'Never teleport a character, prop, wardrobe, vehicle or location. When a positional change is required, provide the smallest plausible causal movement that can lead from the predecessor terminal state to the current-shot target state.',
    'The target state is a settled frozen frame for the CURRENT shot. Do not describe the target frame as an in-between motion frame.',
    'The target frame must obey the authored current-shot staging unless that staging is physically impossible; when it is impossible, repair it with the smallest coherent change and state why.',
    'Camera changes are allowed only when motivated by the shot design. Do not use camera movement as a substitute for physically moving a character who actually needs to change position.',
    'For location changes, explicitly decide whether a travel bridge is needed and identify the travel mode/stage.',
    'Return JSON only. Do not return markdown, commentary or prose outside JSON.',
  ].join(' ');

  const user = [
    `EPISODE: ${_clean(episode?.episode_title || episode?.title || '', 260)}`,
    `SCENE CONTEXT: ${_json({
      scene_number: scene?.scene_number || current.scene_number,
      location: scene?.location || current.location,
      description: _clean(scene?.scene_description, 900),
      emotional_beat: _clean(scene?.emotional_beat, 500),
      lighting_design: _clean(scene?.lighting_design, 350),
    })}`,
    `CAST LOCKS: ${_json(cast)}`,
    `RECENT SHOT HISTORY (semantic context only; newest last): ${_json(history)}`,
    `PREVIOUS SHOT: ${_json(previous)}`,
    `CURRENT SHOT: ${_json(current)}`,
    'IMAGE 1 — EXACT PREVIOUS SHOT TERMINAL FRAME:',
    'Inspect this image first, then compare it to the authored current-shot state.',
    '',
    'Return exactly this shape:',
    _json({
      transition_required: true,
      transition_type: 'walk | drive | ride | turn | approach | enter | exit | sit | stand | prop_transfer | camera_reframe | location_bridge | hold | hard_cut',
      physical_bridge: 'One concrete chronological causal bridge from IMAGE 1 to the current shot target.',
      camera_bridge: 'Only the necessary camera continuity/reframe, or empty.',
      character_transitions: [{
        name: 'Character name',
        from_screen_position: 'left|center|right|far-left|far-right|unknown',
        from_depth: 'foreground|midground|background|unknown',
        from_pose: 'Observed terminal pose',
        to_screen_position: 'Target screen position',
        to_depth: 'Target depth',
        causal_action: 'Minimal physical action that connects the states',
        reason: 'Why that action is necessary',
      }],
      target_opening_state: 'One precise frozen visual state for the current shot.',
      target_character_states: [{
        name: 'Character name',
        screen_position: 'left|center|right|far-left|far-right',
        depth: 'foreground|midground|background',
        pose: 'Frozen target pose',
        facing: 'Facing direction or target',
        eyeline: 'Exact gaze target',
        contact: 'Hands/prop/body contact state',
        settled_action: 'Static physical state only',
        movement_from_previous: 'The bridge that produces this state',
      }],
      target_world_state: {
        location: 'Target location',
        lighting: 'Target lighting',
        environment: 'Target environment',
        active_props: ['Prop states that must be preserved'],
      },
      still_generation_directive: 'A still-image-only direction describing the target frame; no motion or temporal instructions.',
      agnes_transition_directive: 'A concise instruction for Agnes to create the physical transition from IMAGE 1 to the current still.',
      teleport_risk: 0.0,
      continuity_notes: ['Important invariants to preserve'],
    }),
  ].join('\n');

  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const response = await axios.post(
        'https://api.mistral.ai/v1/chat/completions',
        {
          model,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                { type: 'text', text: user },
                { type: 'text', text: 'IMAGE 1 is the exact previous-shot terminal frame. Do not infer its geometry from prose when the pixels disagree.' },
                { type: 'image_url', image_url: _dataUrl(image.buffer, image.mime) },
              ],
            },
          ],
          temperature: 0.25,
          response_format: { type: 'json_object' },
        },
        {
          headers: {
            Authorization: `Bearer ${keys[i]}`,
            'Content-Type': 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        }
      );

      const content = response?.data?.choices?.[0]?.message?.content;
      const raw = _extractObject(content);
      const plan = _normalizePlan(raw, { previousShot, currentShot, characters });
      console.log(
        `[SemanticTransitionDirector] Planned ${plan.transition_type} ` +
        `S${previousShot.scene_number || 0}/idx${previousShot.shot_index || 0} → ` +
        `S${currentShot.scene_number || 0}/idx${currentShot.shot_index || 0} ` +
        `(teleportRisk=${plan.teleport_risk.toFixed(2)})`
      );
      return plan;
    } catch (err) {
      lastError = err;
      const status = Number(err?.response?.status || 0);
      console.warn(
        `[SemanticTransitionDirector] key=${i + 1}/${keys.length} failed ` +
        `status=${status || 'n/a'} detail=${err?.response?.data?.message || err.message}`
      );
      if (status === 400 || status === 401 || status === 403) throw err;
    }
  }

  throw lastError || new Error('[SemanticTransitionDirector] Transition planning failed');
}

function buildStillTargetDirective(plan) {
  if (!plan) return '';
  const rows = (plan.target_character_states || []).map(row => {
    const bits = [
      `${row.name} at ${row.screen_position || 'their authored position'}, ${row.depth || 'midground'}`,
      row.pose ? `frozen pose ${row.pose}` : '',
      row.facing ? `facing ${row.facing}` : '',
      row.eyeline ? `eyeline ${row.eyeline}` : '',
      row.contact ? `contact ${row.contact}` : '',
      row.settled_action ? `static physical state ${row.settled_action}` : '',
    ].filter(Boolean);
    return bits.join('; ');
  });

  return [
    'DIRECTOR-COMPOSED TARGET OPENING STATE — this is a fresh still, NOT a transformation of the previous frame.',
    plan.target_opening_state ? `Target state: ${plan.target_opening_state}` : '',
    rows.length ? `Target character staging: ${rows.join('. ')}` : '',
    plan.target_world_state?.location ? `Target location: ${plan.target_world_state.location}` : '',
    plan.target_world_state?.lighting ? `Target lighting: ${plan.target_world_state.lighting}` : '',
    plan.target_world_state?.environment ? `Target environment: ${plan.target_world_state.environment}` : '',
    plan.target_world_state?.active_props?.length ? `Active props: ${plan.target_world_state.active_props.join(', ')}` : '',
    'Render one settled instant only. Do not depict the bridge itself, an in-between pose, motion blur or temporal progression.',
  ].filter(Boolean).join(' ');
}

module.exports = {
  planSemanticTransition,
  buildStillTargetDirective,
  _normalizePlan,
  _compactHistoryShot,
};
