'use strict';

const axios = require('axios');
const config = require('./config');
const db = require('./db');

const DEFAULT_MODEL =
  process.env.LTX_VISION_MODEL || 'mistral-large-2512';

const MAX_TARGETED_REPAIRS_PER_KEY = 2;
const REQUEST_TIMEOUT_MS = 600000;
const DIALOGUE_MIN_SEMANTIC_SIMILARITY = 0.72;
const DIALOGUE_STRONG_SEMANTIC_SIMILARITY = 0.86;
const DIALOGUE_SHORT_EXACT_THRESHOLD = 0.99;

/* ============================================================================
 * STILL-FRAME AUTHORING + CONTINUITY AUDIT
 * ========================================================================== */

function _buildStillAuthoringSystem() {
  return [
    'You are the multimodal still-frame continuity director for a feature-film production pipeline.',
    'Your job is to author the EXACT prompt for generating the current shot opening still.',
    'The current still must be one frozen cinematic frame, never a video prompt.',
    'IMAGE 1, when supplied, is the exact terminal frame of the immediately preceding shot and is the primary continuity bridge.',
    'SCENE ANCHOR IMAGE, when supplied, is the first shot still of the current scene and is the scene visual baseline for identity, wardrobe, environment, props, palette, geography and persistent spatial facts.',
    'For every authoring pass after a failed continuity audit, re-inspect BOTH continuity anchors before rewriting the prompt: IMAGE 1 is the exact previous-shot terminal frame, and the SCENE ANCHOR IMAGE is the exact first still of the current scene.',
    'Inspect the actual pixels of every supplied image. Do not rely on textual assumptions when the pixels contradict them.',
    'Preserve immutable character identity, age, face, hair, body proportions and established signature traits.',
    'Preserve wardrobe exactly unless the shot explicitly contains a physically visible wardrobe-change action.',
    'A wardrobe change is NOT allowed to appear as a silent costume jump. The opening frame of the change shot must show the FROM wardrobe; only a visible changing/dressing action may lead to the TO wardrobe later in the video.',
    'Preserve environment architecture, spatial geometry, fixed props and persistent objects unless the shot context explicitly requires a real environmental change.',
    'Do not invent props, remove persistent props, redesign the location or silently relocate characters.',
    'The output must be a static opening composition: no motion verbs, no temporal progression, no dialogue, no sound, no camera movement.',
    'Return JSON with exactly one field: image_prompt.',
  ].join('\n');
}

function _buildStillAuthoringUser({
  shot = {},
  scene = {},
  characters = [],
  previousShot = null,
  previousEndFrameAvailable = false,
  sceneAnchorAvailable = false,
  hardWardrobeDirective = '',
  hardWorldDirective = '',
  priorStillDescription = '',
  continuityRepairInstruction = '',
}) {
  const visible = Array.isArray(shot.characters_in_shot)
    ? shot.characters_in_shot
    : [];

  return [
    'CURRENT SHOT TARGET:',
    JSON.stringify({
      scene_number: shot.scene_number || scene.scene_number || null,
      shot_index: shot.shot_index || null,
      shot_type: shot.shot_type || '',
      purpose: shot.shot_purpose || shot.purpose || '',
      image_prompt_intent: shot.image_prompt || '',
      framing: shot.framing || '',
      start_frame_state: shot.start_frame_state || shot._start_frame_handoff || '',
      environment_change: shot.environment_change || shot.scene_transition || '',
      props: shot.active_props || shot.props || shot.carried_props || [],
      visible_characters: visible,
    }, null, 2),

    'SCENE CONTEXT:',
    JSON.stringify({
      location: scene.location || shot._scene_location || '',
      scene_description: scene.scene_description || shot._scene_description || '',
      lighting_design: scene.lighting_design || shot._lighting_design || '',
      emotional_beat: scene.emotional_beat || shot._scene_emotion || '',
    }, null, 2),

    'LOCKED CHARACTERS:',
    JSON.stringify(
      (characters || []).filter(c => {
        const name = String(c?.name || '').toLowerCase();
        return visible.some(v =>
          String(typeof v === 'object' ? v?.name || v?.character || '' : v || '').toLowerCase() === name
        );
      }).map(c => ({
        name: c.name,
        visual_profile: c.visual_profile || '',
        wardrobe: c.wardrobe || c.wardrobe_state || c.costume || c.clothing || '',
        signature_clothing: c.signature_clothing || '',
      })),
      null,
      2
    ),

    'HARD WARDROBE STATE:',
    hardWardrobeDirective || 'No separate wardrobe directive supplied; preserve what is visible and canonically established.',

    'HARD WORLD / ENVIRONMENT / PROP STATE:',
    hardWorldDirective || 'Preserve the established environment and persistent props unless explicitly changed.',

    previousShot
      ? `PREVIOUS SHOT TEXTUAL END STATE:\n${JSON.stringify({
          end_frame_state: previousShot.end_frame_state || '',
          end_frame_transition: previousShot.end_frame_transition || '',
          next_shot_continuity: previousShot.next_shot_continuity || '',
        }, null, 2)}`
      : '',

    priorStillDescription
      ? `PREVIOUSLY AUTHORED STILL PROMPT FOR THIS SHOT (reference only; repair rather than blindly copy): ${priorStillDescription}`
      : '',

    continuityRepairInstruction
      ? `TARGETED CONTINUITY REPAIR FROM THE PREVIOUS FAILED STILL AUDIT (apply only the identified correction; preserve everything else already correct): ${continuityRepairInstruction}`
      : '',

    previousEndFrameAvailable
      ? 'IMAGE 1 — PREVIOUS SHOT TERMINAL FRAME. Determine the smallest physically plausible continuity bridge from this exact endpoint into the requested current opening state.'
      : 'No predecessor frame is available. Establish the current shot opening from the authored shot state and scene baseline.',

    sceneAnchorAvailable
      ? 'SCENE ANCHOR IMAGE — FIRST SHOT STILL OF THIS SCENE. Use it as the visual baseline for wardrobe, environment, persistent props, identity, lighting language and spatial facts unless an explicit story event changes them.'
      : 'No scene anchor still is available; rely on the locked structured continuity state.',

    'AUTHORING RULE:',
    'Write one complete frozen still-image prompt that a diffusion image model can use directly.',
    'The generated image MUST depict the requested CURRENT opening state, not a transition between frames.',
    'When the predecessor frame conflicts with an explicitly authored current state, preserve the current authored state while making the difference physically explainable in the subsequent video rather than creating an impossible hybrid frame.',
    'Never silently change a character wardrobe. Never silently change the scene environment. Never silently remove or invent a persistent prop.',
    'State each visible character separately with identity, wardrobe, screen position, depth, pose, facing, eyeline and relevant prop contact.',
  ].filter(Boolean).join('\n\n');
}

async function _requestVisionJson({
  key,
  model,
  system,
  userText,
  images = [],
  attemptLabel,
}) {
  const content = [{ type: 'text', text: userText }];
  for (const image of images) {
    if (!image?.buffer) continue;
    content.push({
      type: 'text',
      text: image.label || 'REFERENCE IMAGE',
    });
    content.push({
      type: 'image_url',
      image_url: _imageDataUrl(image.buffer, image.mime || 'image/png'),
    });
  }

  const response = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      temperature: 0.15,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  const rawContent = response?.data?.choices?.[0]?.message?.content;
  const parsed = _parseStructuredContent(rawContent);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`[LTXVision] Invalid structured still-authoring response ${attemptLabel}`);
  }
  return {
    response,
    rawContent,
    parsed,
  };
}

async function authorStillPrompt({
  shot = {},
  scene = {},
  characters = [],
  previousShot = null,
  previousEndFrameUrl = '',
  sceneAnchorStillUrl = '',
  hardWardrobeDirective = '',
  hardWorldDirective = '',
  priorStillDescription = '',
  continuityRepairInstruction = '',
}) {
  const keys = _keys();
  if (!keys.length) throw new Error('[LTXVision] No Mistral keys configured');

  const images = [];
  if (previousEndFrameUrl) {
    const previous = await _downloadImageBuffer(previousEndFrameUrl, 'previous shot end frame');
    images.push({
      label: 'IMAGE 1 — PREVIOUS SHOT TERMINAL / END FRAME',
      ...previous,
    });
  }
  if (sceneAnchorStillUrl) {
    const anchor = await _downloadImageBuffer(sceneAnchorStillUrl, 'scene anchor still');
    images.push({
      label: 'SCENE ANCHOR IMAGE — FIRST SHOT STILL OF THIS SCENE',
      ...anchor,
    });
  }

  const userText = _buildStillAuthoringUser({
    shot,
    scene,
    characters,
    previousShot,
    previousEndFrameAvailable: Boolean(previousEndFrameUrl),
    sceneAnchorAvailable: Boolean(sceneAnchorStillUrl),
    hardWardrobeDirective,
    hardWorldDirective,
    priorStillDescription,
    continuityRepairInstruction,
  });

  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const key = keys[i];
      const result = await _requestVisionJson({
        key,
        model: DEFAULT_MODEL,
        system: _buildStillAuthoringSystem(),
        userText,
        images,
        attemptLabel: `still-authoring attempt=${i + 1}/${keys.length} S${shot.scene_number || 0}/idx${shot.shot_index || 0}`,
      });
      const prompt = String(
        result.parsed?.image_prompt ||
        result.parsed?.still_prompt ||
        result.parsed?.prompt ||
        ''
      ).trim();
      if (!prompt) throw new Error('[LTXVision] Still-authoring response contained no image_prompt');
      console.log(`[LTXVision] STILL IMAGE PROMPT authored S${shot.scene_number || 0}/idx${shot.shot_index || 0} chars=${prompt.length}`);
      console.log(prompt);
      return {
        prompt,
        rawContent: result.rawContent,
        parsed: result.parsed,
        response: result.response,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[LTXVision] Still-authoring attempt ${i + 1}/${keys.length} failed: ${err.message}`);
    }
  }
  throw lastError || new Error('[LTXVision] Still-authoring failed');
}

async function auditGeneratedStillContinuity({
  shot = {},
  scene = {},
  characters = [],
  currentStillUrl = '',
  previousEndFrameUrl = '',
  sceneAnchorStillUrl = '',
  hardWardrobeDirective = '',
  hardWorldDirective = '',
}) {
  const keys = _keys();
  if (!keys.length) throw new Error('[LTXVision] No Mistral keys configured');
  if (!currentStillUrl) throw new Error('[LTXVision] Generated still URL is required for continuity audit');

  const images = [];
  const current = await _downloadImageBuffer(currentStillUrl, 'generated current still');
  images.push({ label: 'CURRENT SHOT STILL — AUDIT TARGET', ...current });

  if (sceneAnchorStillUrl) {
    const anchor = await _downloadImageBuffer(sceneAnchorStillUrl, 'scene anchor still');
    images.push({ label: 'SCENE ANCHOR IMAGE — FIRST SHOT STILL OF THIS SCENE', ...anchor });
  }

  if (previousEndFrameUrl) {
    const previous = await _downloadImageBuffer(previousEndFrameUrl, 'previous shot end frame');
    images.push({ label: 'PREVIOUS SHOT TERMINAL FRAME', ...previous });
  }

  const userText = [
    'Audit the generated CURRENT SHOT STILL against the locked production state.',
    'Do not judge artistic quality. Judge continuity only.',
    'Return JSON with exactly: valid, wardrobe, environment, props, identity, reasons, corrected_prompt.',
    'valid is true only when every visible character has the expected wardrobe and identity, the environment is consistent with the scene anchor or explicitly authorized change, and persistent props are preserved.',
    'Wardrobe may differ from the scene anchor only when the current shot is an explicitly authorized live wardrobe-change shot; such a shot must still open in the FROM wardrobe, so the generated opening still itself must show FROM wardrobe.',
    'Never treat a scene anchor difference as an approved change merely because the generated still differs.',
    'The previous terminal frame is the immediate continuity predecessor; the scene anchor is the scene-level baseline.',
    JSON.stringify({
      scene: {
        scene_number: scene.scene_number || shot.scene_number || null,
        location: scene.location || shot._scene_location || '',
        description: scene.scene_description || shot._scene_description || '',
      },
      shot: {
        shot_index: shot.shot_index || null,
        characters_in_shot: shot.characters_in_shot || [],
        wardrobe_change: shot.wardrobe_change || shot.wardrobeChange || shot.wardrobe_transition || null,
      },
      hardWardrobeDirective,
      hardWorldDirective,
      characters: (characters || []).map(c => ({
        name: c?.name,
        wardrobe: c?.wardrobe || c?.wardrobe_state || c?.costume || c?.clothing || '',
        visual_profile: c?.visual_profile || '',
      })),
    }, null, 2),
  ].join('\n\n');

  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const result = await _requestVisionJson({
        key: keys[i],
        model: DEFAULT_MODEL,
        system: [
          'You are a strict continuity auditor for a film production pipeline.',
          'Inspect actual pixels, not just text.',
          'Wardrobe, environment, props and identity are hard continuity constraints.',
          'Do not excuse unexplained changes.',
          'A valid result must be conservative and evidence-based.',
          'When invalid, corrected_prompt is REQUIRED and must be a targeted repair that explicitly fixes only the failed continuity dimensions while preserving all dimensions that already pass.',
        ].join('\n'),
        userText,
        images,
        attemptLabel: `still-audit attempt=${i + 1}/${keys.length} S${shot.scene_number || 0}/idx${shot.shot_index || 0}`,
      });
      const p = result.parsed || {};
      const valid = p.valid === true &&
        p.wardrobe === true &&
        p.environment === true &&
        p.props === true &&
        p.identity === true;
      return {
        valid,
        parsed: p,
        response: result.response,
        rawContent: result.rawContent,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[LTXVision] Still continuity audit attempt ${i + 1}/${keys.length} failed: ${err.message}`);
    }
  }
  throw lastError || new Error('[LTXVision] Still continuity audit failed');
}


/* ============================================================================
 * CONFIG / KEYS
 * ========================================================================== */

function _keys() {
  if (
    Array.isArray(config.mistralKeys) &&
    config.mistralKeys.length
  ) {
    return config.mistralKeys;
  }

  if (process.env.MISTRAL_KEYS) {
    return process.env.MISTRAL_KEYS
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  if (process.env.MISTRAL_API_KEY) {
    return [process.env.MISTRAL_API_KEY];
  }

  return [];
}

/* ============================================================================
 * BASIC HELPERS
 * ========================================================================== */

function _imageDataUrl(buffer, mime = 'image/png') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const error = new Error(
      '[LTXVision] Empty image buffer'
    );

    error.code = 'LTX_VISION_EMPTY_IMAGE';

    throw error;
  }

  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function _downloadImageBuffer(url, label = 'image') {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error(`[LTXVision] Invalid ${label} URL`);
  }

  const response = await axios.get(target, {
    responseType: 'arraybuffer',
    timeout: Math.min(30000, REQUEST_TIMEOUT_MS),
    maxContentLength: 16 * 1024 * 1024,
    maxBodyLength: 16 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300,
  });

  const buffer = Buffer.from(response.data || '');
  if (!buffer.length) {
    throw new Error(`[LTXVision] Downloaded ${label} is empty`);
  }

  return {
    buffer,
    mime: String(response.headers?.['content-type'] || 'image/png')
      .split(';')[0]
      .trim() || 'image/png',
  };
}

/**
 * Resolve the exact terminal image of the immediately preceding shot.
 *
 * Priority:
 *   1. Pipeline-supplied authoritative URL.
 *   2. Agnes continuity table keyed by the exact previous shot.
 *
 * Never substitute a current still, character portrait, scene background,
 * thumbnail, or arbitrary latest frame.
 */
async function _resolvePreviousEndFrame({
  shot = {},
  explicitUrl = '',
} = {}) {
  const supplied = String(
    explicitUrl ||
    shot.visionPreviousEndFrameUrl ||
    shot.continuityLastFrameUrl ||
    ''
  ).trim();

  if (supplied) {
    return _downloadImageBuffer(supplied, 'previous shot end frame');
  }

  const previous = shot.visionPreviousShot;
  const episodeId = shot._episode_id || shot.episode_id || shot.episodeId;

  if (!episodeId || !previous) return null;

  try {
    const row = await db.queryOne(
      `SELECT last_frame_url
         FROM shot_continuity_frames
        WHERE episode_id = ?
          AND scene_number = ?
          AND shot_index = ?
        LIMIT 1`,
      [
        episodeId,
        Number(previous.scene_number),
        Number(previous.shot_index),
      ]
    );

    const url = String(row?.last_frame_url || '').trim();
    if (!url) return null;

    return _downloadImageBuffer(url, 'previous shot end frame');
  } catch (err) {
    console.warn(
      `[LTXVision] Could not resolve previous shot end frame from continuity store: ${err.message}`
    );
    return null;
  }
}

function _cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function _escapeRegex(value) {
  return String(value || '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function _safeLog(label, value) {
  console.log(label);

  try {
    console.log(
      typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2)
    );
  } catch (_) {
    console.log(String(value));
  }
}

/* ============================================================================
 * STRUCTURED MODEL OUTPUT
 * ========================================================================== */

function _parseStructuredContent(content) {
  if (
    content &&
    typeof content === 'object' &&
    !Array.isArray(content)
  ) {
    return content;
  }

  const text = String(content || '').trim();

  if (!text) {
    const error = new Error(
      '[LTXVision] Vision model returned empty message.content'
    );

    error.code =
      'LTX_VISION_INVALID_STRUCTURED_OUTPUT';

    throw error;
  }

  try {
    const parsed = JSON.parse(text);

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        'JSON root is not an object'
      );
    }

    return parsed;
  } catch (err) {
    const parseError = new Error(
      `[LTXVision] Vision model returned non-JSON structured content: ${err.message}`
    );

    parseError.code =
      'LTX_VISION_INVALID_STRUCTURED_OUTPUT';

    parseError.rawContent = text;

    throw parseError;
  }
}

/* ============================================================================
 * NATURAL-LANGUAGE SERIALIZATION
 * ========================================================================== */

function _sentence(value) {
  const text = _cleanText(value);

  if (!text) {
    return '';
  }

  return /[.!?]["”']?$/.test(text)
    ? text
    : `${text}.`;
}

function _flattenValue(value) {
  if (value == null) {
    return '';
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return _cleanText(String(value));
  }

  if (Array.isArray(value)) {
    return value
      .map(item => _flattenValue(item))
      .filter(Boolean)
      .join(' ');
  }

  if (_isPlainObject(value)) {
    return Object.entries(value)
      .map(([key, child]) =>
        _flattenField(key, child)
      )
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function _flattenDialogueNode(node) {
  if (!_isPlainObject(node)) {
    return _flattenValue(node);
  }

  const speaker = _cleanText(
    node.speaker ||
    node.character ||
    node.character_name ||
    node.name ||
    ''
  );

  const spokenWords = _cleanText(
    node.spoken_words ||
    node.spokenWords ||
    node.dialogue ||
    node.line ||
    node.text ||
    ''
  );

  const delivery = _cleanText(
    node.delivery || ''
  );

  const placement = _cleanText(
    node.placement || ''
  );

  const listenerReaction = _cleanText(
    node.listener_reaction ||
    node.listenerReaction ||
    ''
  );

  const parts = [];

  if (spokenWords) {
    const cleanWords = spokenWords
      .replace(/^["“]/, '')
      .replace(/["”]$/, '')
      .replace(/\*+/g, '')
      .trim();

    const deliveryText = delivery
      ? _sentence(delivery)
      : 'speaks';

    const placementText = placement
      ? ` ${_sentence(placement)}`
      : '';

    if (speaker) {
      parts.push(
        `${speaker}${placementText} ` +
        `${deliveryText} "${cleanWords}"`
      );
    } else {
      parts.push(`"${cleanWords}"`);
    }
  }

  if (listenerReaction) {
    parts.push(
      `The listener reacts: ${_sentence(listenerReaction)}`
    );
  }

  const handled = new Set([
    'speaker',
    'character',
    'character_name',
    'name',
    'spoken_words',
    'spokenWords',
    'dialogue',
    'line',
    'text',
    'delivery',
    'placement',
    'listener_reaction',
    'listenerReaction',
  ]);

  for (const [key, value] of Object.entries(node)) {
    if (handled.has(key)) {
      continue;
    }

    const rendered =
      _flattenField(key, value);

    if (rendered) {
      parts.push(rendered);
    }
  }

  return parts.join(' ');
}

function _flattenField(key, value) {
  const normalizedKey = String(key || '');
  const lowerKey =
    normalizedKey.toLowerCase();

  if (value == null) {
    return '';
  }

  if (
    lowerKey === 'dialogue_initiation' ||
    lowerKey === 'dialogue' ||
    lowerKey === 'spoken_dialogue' ||
    lowerKey === 'spoken_words' ||
    lowerKey === 'conversation'
  ) {
    if (_isPlainObject(value)) {
      return _flattenDialogueNode(value);
    }

    if (Array.isArray(value)) {
      return value
        .map(item =>
          _flattenDialogueNode(item)
        )
        .filter(Boolean)
        .join(' ');
    }

    return _sentence(value);
  }

  if (
    lowerKey === 'action_sequence' ||
    lowerKey === 'actions'
  ) {
    if (Array.isArray(value)) {
      return value
        .map(item => {
          if (
            _isPlainObject(item) &&
            item.moment
          ) {
            const duration =
              item.duration
                ? ` It lasts ${item.duration}.`
                : '';

            return (
              `${_sentence(item.moment)}` +
              `${duration}`
            );
          }

          return _flattenValue(item);
        })
        .filter(Boolean)
        .join(' ');
    }

    return _flattenValue(value);
  }

  if (lowerKey === 'action_progression') {
    if (_isPlainObject(value)) {
      return Object.entries(value)
        .map(
          ([childKey, childValue]) =>
            _flattenField(
              childKey,
              childValue
            )
        )
        .filter(Boolean)
        .join(' ');
    }

    return _flattenValue(value);
  }

  if (
    lowerKey === 'opening_state' ||
    lowerKey === 'initial_state'
  ) {
    return (
      `At the beginning, ` +
      `${_flattenValue(value)}`
    );
  }

  if (
    lowerKey === 'terminal_state' ||
    lowerKey === 'final_state'
  ) {
    return (
      `By the end of the shot, ` +
      `${_flattenValue(value)}`
    );
  }

  if (
    lowerKey === 'camera_movement' ||
    lowerKey === 'camera'
  ) {
    const cameraText =
      _flattenValue(value);

    if (!cameraText) {
      return '';
    }

    return `The camera ${cameraText}`;
  }

  if (lowerKey === 'lighting_evolution') {
    const lightingText =
      _flattenValue(value);

    if (!lightingText) {
      return '';
    }

    return (
      `The lighting changes as follows: ` +
      `${lightingText}`
    );
  }

  if (
    lowerKey === 'sound' ||
    lowerKey === 'ambience' ||
    lowerKey === 'atmosphere'
  ) {
    const atmosphereText =
      _flattenValue(value);

    if (!atmosphereText) {
      return '';
    }

    return (
      `The sound and atmosphere are ` +
      `${atmosphereText}`
    );
  }

  if (_isPlainObject(value)) {
    return Object.entries(value)
      .map(
        ([childKey, childValue]) =>
          _flattenField(
            childKey,
            childValue
          )
      )
      .filter(Boolean)
      .join(' ');
  }

  if (Array.isArray(value)) {
    return value
      .map(item => _flattenValue(item))
      .filter(Boolean)
      .join(' ');
  }

  return _sentence(value);
}

function _serializeStructuredShot(value) {
  if (typeof value === 'string') {
    const description =
      _cleanText(value);

    if (!description) {
      const error = new Error(
        '[LTXVision] ltx_shot_description string was empty'
      );

      error.code =
        'LTX_VISION_INVALID_STRUCTURED_OUTPUT';

      throw error;
    }

    return description;
  }

  if (!_isPlainObject(value)) {
    const error = new Error(
      '[LTXVision] ltx_shot_description must be a string or structured object'
    );

    error.code =
      'LTX_VISION_INVALID_STRUCTURED_OUTPUT';

    throw error;
  }

  const orderedSections = [
    'opening_state',
    'action_sequence',
    'action_progression',
    'camera_movement',
    'lighting_evolution',
    'terminal_state',
  ];

  const consumed = new Set();
  const parts = [];

  for (const section of orderedSections) {
    if (
      !Object.prototype.hasOwnProperty.call(
        value,
        section
      )
    ) {
      continue;
    }

    const rendered =
      _flattenField(
        section,
        value[section]
      );

    if (rendered) {
      parts.push(rendered);
    }

    consumed.add(section);
  }

  for (const [key, child] of Object.entries(value)) {
    if (consumed.has(key)) {
      continue;
    }

    const rendered =
      _flattenField(
        key,
        child
      );

    if (rendered) {
      parts.push(rendered);
    }
  }

  const description =
    _cleanText(
      parts.join(' ')
    );

  if (!description) {
    const error = new Error(
      '[LTXVision] Structured ltx_shot_description could not be serialized'
    );

    error.code =
      'LTX_VISION_INVALID_STRUCTURED_OUTPUT';

    error.structuredResponse =
      value;

    throw error;
  }

  return description;
}

function _extractDescription(parsed) {
  if (
    !Object.prototype.hasOwnProperty.call(
      parsed || {},
      'ltx_shot_description'
    )
  ) {
    const error = new Error(
      '[LTXVision] Vision model returned structured JSON without ltx_shot_description'
    );

    error.code =
      'LTX_VISION_INVALID_STRUCTURED_OUTPUT';

    error.structuredResponse =
      parsed;

    throw error;
  }

  /*
   * Never run semantic dialogue rewriting here.
   *
   * The generated cinematic text must be inspected first, then authored
   * dialogue can be normalized/enforced exactly once.
   */
  return _serializeStructuredShot(
    parsed.ltx_shot_description
  );
}

/* ============================================================================
 * DIALOGUE EXTRACTION / NORMALIZATION
 * ========================================================================== */

function _normalizeDialogue(text) {
  return String(text || '')
    .replace(/[“”]/g, '"')
    .replace(/\\"/g, '"')
    .replace(/\*+/g, '')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function _normalizeDialogueForMatch(text) {
  return _normalizeDialogue(text)
    .replace(
      /\s+([,.!?;:])/g,
      '$1'
    )
    .replace(
      /([,.!?;:])\s+/g,
      '$1 '
    )
    .trim()
    .toLowerCase();
}

/*
 * SEMANTIC DIALOGUE MATCHING
 *
 * The Vision Director should validate the SPOKEN MEANING, not fail a correct
 * shot because the model changed punctuation, contractions, quote style,
 * apostrophes, capitalization, or made a very small natural-language
 * variation.
 *
 * Exact matches remain the strongest signal. For non-exact matches we compare
 * normalized lexical content while deliberately requiring high overlap so we
 * do not accidentally accept unrelated speech.
 */
function _semanticDialogueTokens(value) {
  let normalized = _normalizeDialogueForMatch(value)
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\b(?:uh|um|erm|hmm|well)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return [];

  /*
   * Normalize common spoken contractions so:
   *   "you're" ≈ "you are"
   *   "don't"  ≈ "do not"
   *   "can't"  ≈ "cannot"
   * and similar model paraphrase variants remain semantically matchable.
   */
  const contractions = [
    [/\byou're\b/g, 'you are'],
    [/\byou've\b/g, 'you have'],
    [/\byou'll\b/g, 'you will'],
    [/\byou'd\b/g, 'you would'],
    [/\bi'm\b/g, 'i am'],
    [/\bi've\b/g, 'i have'],
    [/\bi'll\b/g, 'i will'],
    [/\bi'd\b/g, 'i would'],
    [/\bhe's\b/g, 'he is'],
    [/\bshe's\b/g, 'she is'],
    [/\bit's\b/g, 'it is'],
    [/\bthat's\b/g, 'that is'],
    [/\bwhat's\b/g, 'what is'],
    [/\bwho's\b/g, 'who is'],
    [/\bwhere's\b/g, 'where is'],
    [/\bthere's\b/g, 'there is'],
    [/\bthey're\b/g, 'they are'],
    [/\bthey've\b/g, 'they have'],
    [/\bthey'll\b/g, 'they will'],
    [/\bthey'd\b/g, 'they would'],
    [/\bwe're\b/g, 'we are'],
    [/\bwe've\b/g, 'we have'],
    [/\bwe'll\b/g, 'we will'],
    [/\bwe'd\b/g, 'we would'],
    [/\bdon't\b/g, 'do not'],
    [/\bdoesn't\b/g, 'does not'],
    [/\bdidn't\b/g, 'did not'],
    [/\bisn't\b/g, 'is not'],
    [/\baren't\b/g, 'are not'],
    [/\bwasn't\b/g, 'was not'],
    [/\bweren't\b/g, 'were not'],
    [/\bwon't\b/g, 'will not'],
    [/\bwouldn't\b/g, 'would not'],
    [/\bcan't\b/g, 'cannot'],
    [/\bcouldn't\b/g, 'could not'],
    [/\bshouldn't\b/g, 'should not'],
    [/\bhadn't\b/g, 'had not'],
    [/\bhasn't\b/g, 'has not'],
    [/\bhaven't\b/g, 'have not'],
    [/\blet's\b/g, 'let us'],
  ];

  for (const [pattern, expansion] of contractions) {
    normalized = normalized.replace(pattern, expansion);
  }

  /* Small, conservative semantic-equivalence map. This is intentionally not a
   * free-form paraphrase engine: it only collapses common cinematic/dialogue
   * equivalents so validation can survive natural model wording variation. */
  const semanticAliases = [
    [/\bheard\b/g, 'listen'],
    [/\blistened\b/g, 'listen'],
    [/\blistening\b/g, 'listen'],
    [/\btape\b/g, 'recording'],
    [/\brecorded\b/g, 'recording'],
    [/\bremembered\b/g, 'recall'],
    [/\bremember\b/g, 'recall'],
    [/\bforgot\b/g, 'forget'],
    [/\bstop\b/g, 'prevent'],
    [/\bstopped\b/g, 'prevent'],
    [/\bstopping\b/g, 'prevent'],
    [/\bknew\b/g, 'aware'],
    [/\bknow\b/g, 'aware'],
  ];

  for (const [pattern, replacement] of semanticAliases) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized
    .split(/\s+/)
    .map(token => token.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

function _semanticDialogueKey(value) {
  return _semanticDialogueTokens(value).join(' ');
}

function _dialogueTokenOverlap(a, b) {
  const aTokens = _semanticDialogueTokens(a);
  const bTokens = _semanticDialogueTokens(b);

  if (!aTokens.length || !bTokens.length) return 0;

  const aCounts = new Map();
  const bCounts = new Map();

  for (const token of aTokens) {
    aCounts.set(token, (aCounts.get(token) || 0) + 1);
  }

  for (const token of bTokens) {
    bCounts.set(token, (bCounts.get(token) || 0) + 1);
  }

  let intersection = 0;

  for (const [token, count] of aCounts) {
    intersection += Math.min(
      count,
      bCounts.get(token) || 0
    );
  }

  const precision = intersection / Math.max(1, aTokens.length);
  const recall = intersection / Math.max(1, bTokens.length);
  const f1 = precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;

  return f1;
}

function _levenshteinSimilarity(a, b) {
  const x = _semanticDialogueKey(a);
  const y = _semanticDialogueKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const rows = x.length + 1;
  const cols = y.length + 1;
  if (rows * cols > 90000) return 0;
  let prev = Array(cols).fill(0).map((_, i) => i);
  for (let i = 1; i < rows; i++) {
    const cur = [i];
    const ca = x[i - 1];
    for (let j = 1; j < cols; j++) {
      const cost = ca === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return 1 - prev[cols - 1] / Math.max(x.length, y.length, 1);
}

function _semanticDialogueSimilarity(source, candidate) {
  const exactSource = _normalizeDialogueForMatch(source);
  const exactCandidate = _normalizeDialogueForMatch(candidate);
  if (!exactSource || !exactCandidate) return 0;
  if (exactSource === exactCandidate) return 1;
  /* Never treat a larger quoted sentence as the authored line merely because
   * it contains the authored words. Quoted dialogue is an atomic speech channel.
   * A quoted span may differ in punctuation/contractions, but it must remain
   * approximately the same utterance rather than wrapping narration around it. */
  const sourceTokens = _semanticDialogueTokens(exactSource);
  const candidateTokens = _semanticDialogueTokens(exactCandidate);
  if (!sourceTokens.length || !candidateTokens.length) return 0;

  const tokenRatio = candidateTokens.length / Math.max(1, sourceTokens.length);
  if (tokenRatio > 1.25 || tokenRatio < 0.75) return 0;

  const lexical = _dialogueTokenOverlap(exactSource, exactCandidate);
  const charSim = _levenshteinSimilarity(exactSource, exactCandidate);
  return Math.max(lexical, charSim * 0.94);
}

function _isSemanticallySameDialogue(source, candidate) {
  const a = _semanticDialogueTokens(source);
  const b = _semanticDialogueTokens(candidate);
  if (!a.length || !b.length) return false;
  const similarity = _semanticDialogueSimilarity(source, candidate);
  if (Math.max(a.length, b.length) <= 3) {
    return similarity >= DIALOGUE_SHORT_EXACT_THRESHOLD;
  }
  return similarity >= DIALOGUE_MIN_SEMANTIC_SIMILARITY;
}

function _bestSemanticDialogueOccurrence(
  description,
  sourceLine,
  {
    quotedOnly = false,
    startIndex = 0,
  } = {}
) {
  const source = _canonicalDialogueLine(sourceLine);
  if (!source) return null;

  const quotedMatches = _scanQuotedDialogue(description)
    .filter(match => match.index >= startIndex);

  let best = null;

  for (const match of quotedMatches) {
    const similarity =
      _semanticDialogueSimilarity(
        source,
        match.text
      );

    if (
      similarity >= 0.86 &&
      (!best || similarity > best.similarity)
    ) {
      best = {
        ...match,
        mode: 'quoted-semantic',
        similarity,
        sourceText: source,
      };
    }
  }

  if (best) {
    return best;
  }

  if (quotedOnly) {
    return null;
  }

  /*
   * Preserve the old flexible unquoted fallback, but only after quoted speech
   * has been searched semantically.
   */
  return null;
}

function _canonicalDialogueLine(value) {
  return _normalizeDialogue(value)
    .replace(/^["“]+/, '')
    .replace(/["”]+$/, '')
    .trim();
}

function _quotedDialogue(text) {
  return [
    ...String(text || '').matchAll(
      /(?:\*{1,3})?"([^"]*)"(?:\*{1,3})?|(?:\*{1,3})?“([^”]*)”(?:\*{1,3})?/g
    ),
  ]
    .map(match =>
      _canonicalDialogueLine(
        match[1] != null
          ? match[1]
          : match[2]
      )
    )
    .filter(Boolean);
}

function _dedupePreserveOrder(lines) {
  const result = [];
  const seen = new Set();

  for (const line of lines || []) {
    const canonical =
      _canonicalDialogueLine(line);

    if (!canonical) {
      continue;
    }

    const key =
      _normalizeDialogueForMatch(
        canonical
      );

    if (!seen.has(key)) {
      seen.add(key);
      result.push(canonical);
    }
  }

  return result;
}

/*
 * Extract authoritative dialogue from the upstream shot intent.
 *
 * Crucially:
 * - quoted strings remain individual authored utterances;
 * - arrays remain individual utterances;
 * - screenplay "CHARACTER: line" syntax remains separated;
 * - a plain unquoted string is kept as ONE authored utterance.
 */

/*
 * Build an authoritative dialogue-beat registry without throwing away speaker
 * identity.  The older dialogue extractor intentionally returned only text,
 * which was sufficient for quote validation but insufficient for directing
 * image-to-video models.  LTX needs to know exactly WHO performs each line.
 */
/*
 * QUOTE-CHANNEL SANITIZATION
 *
 * Quotation marks belong exclusively to spoken dialogue in the final LTX
 * description. Models frequently use quotes for labels, emphasis, memories,
 * sound cues or screenplay fragments. Those are not dialogue and must never
 * poison the dialogue validator.
 */
function _sanitizeNonDialogueQuotes(description, authoritativeLines = []) {
  const text = String(description || '');
  if (!text) return '';

  const auth = (authoritativeLines || [])
    .map(_canonicalDialogueLine)
    .filter(Boolean);

  const matches = _scanQuotedDialogue(text);
  if (!matches.length) {
    return text
      .replace(/[“”"]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  const replacements = matches.map(match => {
    const isAuth = auth.some(line =>
      _isSemanticallySameDialogue(line, match.text)
    );

    return {
      index: match.index,
      length: match.length,
      replacement: isAuth
        ? `"${_canonicalDialogueLine(match.text)}"`
        : match.text,
    };
  });

  replacements.sort((a, b) => b.index - a.index);

  let working = text;
  for (const replacement of replacements) {
    working =
      working.slice(0, replacement.index) +
      replacement.replacement +
      working.slice(replacement.index + replacement.length);
  }

  /* Paired quote spans have already been normalized above. Keep the authored
   * speech delimiters intact and only clean whitespace/punctuation. */
  return working
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function _inferSpeakerBeforeQuote(text, quoteIndex, inheritedSpeaker = '') {
  const before = String(text || '')
    .slice(Math.max(0, quoteIndex - 260), quoteIndex)
    .replace(/\*+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const patterns = [
    /([A-Za-z][A-Za-z0-9 ._'’\-]{1,90})\s*(?:\([^)]{0,180}\))?\s*,?\s*(?:speaks?|says?|replies?|answers?|asks?)\s*:\s*$/i,
    /([A-Za-z][A-Za-z0-9 ._'’\-]{1,80})\s*:\s*$/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(before);
    if (match) {
      const speaker = _cleanText(match[1])
        .replace(/^.*?\b(?:and|then|next|again)\s+/i, '');
      if (speaker && speaker.length <= 100) return speaker;
    }
  }

  return _cleanText(inheritedSpeaker);
}

function _extractAtomicQuotedBeats(raw, inheritedSpeaker = '') {
  const text = String(raw || '');
  if (!text) return [];
  const beats = [];

  /* First collect every quoted utterance. Do NOT require a speaker label to be
   * adjacent to the quote: LLMs often put descriptive prose between the label
   * and the speech. Speaker inference is performed from the nearby staging. */
  const quoteRegex = /"([^"]*)"|“([^”]*)”|‘([^’]*)’/g;
  let match;
  while ((match = quoteRegex.exec(text))) {
    const line = _canonicalDialogueLine(
      match[1] != null ? match[1] :
      match[2] != null ? match[2] :
      match[3] != null ? match[3] : match[4]
    );
    if (!line) continue;

    const speaker = _inferSpeakerBeforeQuote(
      text,
      match.index,
      inheritedSpeaker
    );

    beats.push({ speaker, line });
  }

  if (beats.length) return beats;

  return [];
}


/*
 * Some upstream shot contracts overload dialogue_or_action with cinematic
 * narration such as sound design, ambience or physical action. Those strings
 * are not spoken dialogue and must never enter the speaker registry.
 */
function _looksLikeCinematicNarration(value) {
  const text = _cleanText(value);
  if (!text) return false;

  // Explicit quotes / screenplay labels are stronger evidence of actual speech.
  if (/["“”‘’]/.test(text)) return false;
  if (/^[A-Z][A-Za-z0-9 ._'’()\-]{1,80}\s*:\s*\S/.test(text)) return false;

  const strongNarrationSignals = [
    /\b(?:is|are) audible\b/i,
    /\bcreating\s+(?:a|an)\b/i,
    /\boverlaps?\s+with\b/i,
    /\bcacophony\b/i,
    /\bstatic\b/i,
    /\b(?:sound|noise|radio|chatter|ambience|footsteps?)\b.*\b(?:as|while)\b/i,
    /\bas\s+(?:he|she|they|e?lias|maya|daniel|rose|lena)\s+(?:steps?|walks?|moves?|turns?|enters?|breathes?|looks?|stares?|reaches?)\b/i,
    /\b(?:steps?|walks?|moves?|turns?|enters?)\s+(?:into|toward|towards)\s+the\b/i,
  ];

  return strongNarrationSignals.some(re => re.test(text));
}

function _collectSpeakerCandidates({ intent = {}, characters = [] } = {}) {
  const out = [];
  const seen = new Set();

  const add = value => {
    const name = _cleanText(value);
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };

  const addMany = value => {
    if (Array.isArray(value)) {
      value.forEach(addMany);
      return;
    }
    if (_isPlainObject(value)) {
      add(
        value.name ||
        value.character ||
        value.character_name ||
        value.characterName ||
        value.speaker ||
        value.speaker_name ||
        value.speakerName ||
        ''
      );
      return;
    }
    add(value);
  };

  // Frame-level authority first. These are the characters actually declared
  // for the current shot, not the entire episode cast.
  addMany(intent.characters_in_shot || []);
  addMany(intent.speakers_in_shot || []);
  addMany(intent.character_staging || []);

  // Persisted conversation plans are stronger than free-form prose because
  // they contain the canonical chronological speaker ownership of each turn.
  if (_isPlainObject(intent.conversation_plan)) {
    addMany(intent.conversation_plan.speakers || []);
    addMany((intent.conversation_plan.turns || []).map(turn => turn?.speaker || ''));
  }
  addMany(intent.conversation_speakers || []);

  // Direct shot-level speaker metadata remains authoritative when present.
  addMany(intent.speaker || intent.speaker_name || intent.speakerName || '');
  addMany(intent.dialogue_speaker || intent.dialogueSpeaker || '');

  // Only use the full cast as a final candidate source. It gives the resolver
  // legal names without making the entire cast look visibly staged.
  addMany(characters || []);
  addMany(intent.character_positions || '');

  return out;
}

function _conversationTurnSpeakers(intent = {}, characters = []) {
  const turns = Array.isArray(intent?.conversation_plan?.turns)
    ? intent.conversation_plan.turns
    : [];

  return turns
    .map(turn => _cleanText(turn?.speaker || ''))
    .filter(Boolean)
    .map(speaker => {
      const catalogMatch = (Array.isArray(characters) ? characters : [])
        .find(character => String(character?.name || '').trim().toLowerCase() === speaker.toLowerCase());
      return _cleanText(catalogMatch?.name || speaker);
    });
}

function _applyConversationTurnOwnership(dialogueBeats, intent = {}, characters = []) {
  const turnSpeakers = _conversationTurnSpeakers(intent, characters);
  if (!dialogueBeats.length || !turnSpeakers.length) return dialogueBeats;

  return dialogueBeats.map((beat, index) => {
    if (beat.speaker) return { ...beat };
    const expected = turnSpeakers[index];
    if (!expected) return { ...beat };
    return { ...beat, speaker: expected, speakerSource: 'persisted_conversation_turn' };
  });
}

function _findExplicitSpeakerHint(text, candidates = []) {
  const raw = _cleanText(text);
  if (!raw || !candidates.length) return '';

  for (const candidate of candidates) {
    const escaped = _escapeRegex(candidate);
    const patterns = [
      new RegExp(`\\b${escaped}\\b\\s*(?:says?|speaks?|replies?|answers?|asks?|whispers?|shouts?|calls?)\\b`, 'i'),
      new RegExp(`\\b${escaped}\\b\\s*:\\s*`, 'i'),
    ];
    if (patterns.some(re => re.test(raw))) return candidate;
  }

  return '';
}

function _applyDeterministicSpeakerResolution(dialogueBeats, {
  intent = {},
  characters = [],
} = {}) {
  const candidates = _collectSpeakerCandidates({ intent, characters });
  if (!dialogueBeats.length || !candidates.length) {
    return { beats: dialogueBeats, unresolved: dialogueBeats.filter(b => !b.speaker), candidates };
  }

  const contextualText = [
    intent.shot_purpose,
    intent.shot_description,
    intent.action_arc,
    intent.end_state,
    intent.conversation_reason,
  ].filter(Boolean).join(' ');

  const contextSpeaker = _findExplicitSpeakerHint(contextualText, candidates);

  const ownedByConversation = _applyConversationTurnOwnership(dialogueBeats, intent, characters);

  const resolved = ownedByConversation.map(beat => {
    if (beat.speaker) return { ...beat };

    // A candidate mentioned directly in the authored line is a stronger cue
    // than a global shot-level default.
    const direct = candidates.find(candidate =>
      new RegExp(`\\b${_escapeRegex(candidate)}\\b`, 'i').test(beat.line || '')
    );
    if (direct) return { ...beat, speaker: direct };

    // Strong explicit context cue from the shot intent.
    if (contextSpeaker) return { ...beat, speaker: contextSpeaker };

    // A single staged character is the only deterministic assignment possible.
    if (candidates.length === 1) return { ...beat, speaker: candidates[0] };

    return { ...beat };
  });

  return {
    beats: resolved,
    unresolved: resolved.filter(b => !b.speaker),
    candidates,
  };
}

async function _resolveSpeakersWithVision({
  dialogueBeats = [],
  candidates = [],
  intent = {},
  characterHints = [],
  imageBuffer,
  imageMime,
  previousEndFrameBuffer = null,
  previousEndFrameMime = 'image/png',
  model,
  key,
} = {}) {
  const unresolved = (dialogueBeats || []).filter(beat => !beat.speaker);
  if (!unresolved.length) return dialogueBeats;
  if (!candidates.length) return dialogueBeats;

  const candidateSet = new Set(candidates.map(name => name.toLowerCase()));

  const system = [
    'You are a constrained dialogue-speaker resolver for a cinematic image-to-video pipeline.',
    'Your job is ONLY to assign each unresolved authored spoken line to exactly one speaker from the supplied candidate list.',
    'Use the current shot still as visual ground truth. When a previous end frame is supplied, use it only as continuity context.',
    'Use shot intent, conversation reason, character hints, wording semantics, character position, gaze and visible staging.',
    'NEVER invent a speaker name. NEVER choose anyone outside the candidate list.',
    'If the evidence is insufficient, return speaker as an empty string for that line.',
    'Return JSON with exactly one field: assignments.',
    'assignments must be an array of objects with exactly: line, speaker, confidence.',
    'confidence must be a number from 0 to 1.',
  ].join(' ');

  const userPayload = {
    candidates,
    unresolved_lines: unresolved.map(beat => ({ line: beat.line })),
    shot_intent: intent,
    character_hints: characterHints,
  };

  const content = [
    { type: 'text', text: JSON.stringify(userPayload, null, 2) },
    ...(previousEndFrameBuffer ? [
      { type: 'text', text: 'IMAGE 1 — PREVIOUS SHOT TERMINAL / END FRAME.' },
      { type: 'image_url', image_url: _imageDataUrl(previousEndFrameBuffer, previousEndFrameMime) },
    ] : []),
    { type: 'text', text: previousEndFrameBuffer
      ? 'IMAGE 2 — CURRENT SHOT AUTHORED STILL / OPENING FRAME.'
      : 'CURRENT SHOT AUTHORED STILL / OPENING FRAME.' },
    { type: 'image_url', image_url: _imageDataUrl(imageBuffer, imageMime) },
  ];

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
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  const parsed = _parseStructuredContent(response?.data?.choices?.[0]?.message?.content);
  const assignments = Array.isArray(parsed?.assignments) ? parsed.assignments : [];
  const byLine = new Map(
    assignments.map(item => [
      _normalizeDialogueForMatch(item?.line || ''),
      _cleanText(item?.speaker || ''),
    ])
  );

  const out = dialogueBeats.map(beat => {
    if (beat.speaker) return { ...beat };
    const speaker = byLine.get(_normalizeDialogueForMatch(beat.line)) || '';
    const validSpeaker = candidateSet.has(speaker.toLowerCase()) ? speaker : '';
    return validSpeaker ? { ...beat, speaker: validSpeaker } : { ...beat, speaker: '' };
  });

  _safeLog('[LTXVision] SPEAKER RESOLUTION RESULT:', out);
  return out;
}

/*
 * Dialogue-input contract.
 *
 * `dialogue_or_action` is a mixed upstream field. A plain prose string in that
 * field is NOT safe to interpret as speech because it can contain action,
 * ambience, sound design, blocking, camera direction or environment notes.
 * Only explicit speech syntax is authoritative there:
 *   - quoted utterance
 *   - SPEAKER: utterance
 *   - an object carrying an explicit speaker + line/text
 *
 * Pure `dialogue` / `spoken_*` fields remain allowed to contain a single plain
 * utterance because the field itself already declares speech semantics.
 */
function _extractDialogueBeatsFromMixedInput(value, inheritedSpeaker = '') {
  if (value == null) return [];

  if (Array.isArray(value)) {
    return value.flatMap(item =>
      _extractDialogueBeatsFromMixedInput(item, inheritedSpeaker)
    );
  }

  if (_isPlainObject(value)) {
    const speaker = _cleanText(
      value.speaker || value.character || value.character_name ||
      value.characterName || value.name || inheritedSpeaker || ''
    );

    const explicitDialogueKeys = [
      'lines',
      'dialogue',
      'spoken_dialogue',
      'spoken_words',
      'spokenWords',
      'dialogue_lines',
      'dialogueLines',
      'conversation',
      'exchange',
      'dialogue_or_action',
    ];

    for (const key of explicitDialogueKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const nested = _extractDialogueBeatsFromMixedInput(value[key], speaker);
        if (nested.length) return nested;
      }
    }

    /* A structured node with an explicit speaker may safely use `line` or
     * `text`; the speaker field turns those properties into an authored speech
     * beat instead of generic prose. */
    if (speaker && (Object.prototype.hasOwnProperty.call(value, 'line') ||
                    Object.prototype.hasOwnProperty.call(value, 'text'))) {
      const line = _canonicalDialogueLine(value.line || value.text || '');
      if (line) return [{ speaker, line }];
    }

    return [];
  }

  const raw = _cleanText(value);
  if (!raw) return [];

  const labelled = _splitEmbeddedSpeakerLabels(raw);
  if (labelled.length) return labelled;

  const atomic = _extractAtomicQuotedBeats(raw, inheritedSpeaker);
  if (atomic.length) return atomic;

  /* Critical safety rule: never promote unquoted mixed prose to speech. */
  return [];
}

function _normalizeAuthoredDialogueInput(value, { mixedInput = false } = {}) {
  if (mixedInput) {
    const mixedBeats = _extractDialogueBeatsFromMixedInput(value);
    const seen = new Set();
    return mixedBeats
      .map(beat => ({
        speaker: _cleanText(beat.speaker),
        line: _canonicalDialogueLine(beat.line),
      }))
      .filter(beat => {
        if (!beat.line) return false;
        const key = `${beat.speaker.toLowerCase()}|${_normalizeDialogueForMatch(beat.line)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  const beats = [];
  const visit = (node, inheritedSpeaker = '') => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, inheritedSpeaker);
      return;
    }
    if (_isPlainObject(node)) {
      const speaker = _cleanText(
        node.speaker || node.character || node.character_name ||
        node.characterName || node.name || inheritedSpeaker || ''
      );
      const keys = [
        'lines','dialogue','spoken_dialogue','spoken_words','spokenWords',
        'dialogue_lines','dialogueLines','conversation','exchange'
      ];
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          const before = beats.length;
          visit(node[key], speaker);
          if (beats.length > before) return;
        }
      }

      if (speaker && (Object.prototype.hasOwnProperty.call(node, 'line') ||
                      Object.prototype.hasOwnProperty.call(node, 'text'))) {
        const line = _canonicalDialogueLine(node.line || node.text || '');
        if (line) beats.push({ speaker, line });
      }
      return;
    }

    const raw = String(node).trim();
    if (!raw) return;

    const atomic = _extractAtomicQuotedBeats(raw, inheritedSpeaker);
    if (atomic.length) {
      beats.push(...atomic);
      return;
    }

    /* Screenplay fallback: one physical line per speaker. */
    const screenplay = /(?:^|[\r\n])\s*([A-Z][A-Za-z0-9 ._'’\-]{1,80})\s*:\s*([^\r\n]+)\s*(?=[\r\n]|$)/g;
    let matched = false;
    let m;
    while ((m = screenplay.exec(raw))) {
      matched = true;
      const line = _canonicalDialogueLine(m[2]);
      if (line) beats.push({ speaker: _cleanText(m[1]), line });
    }
    if (matched) return;

    const line = _canonicalDialogueLine(raw);
    if (!mixedInput && line && !_looksLikeCinematicNarration(line)) {
      beats.push({ speaker: _cleanText(inheritedSpeaker), line });
    }
  };

  visit(value);

  const out = [];
  const seen = new Set();
  for (const beat of beats) {
    const speaker = _cleanText(beat.speaker);
    const line = _canonicalDialogueLine(beat.line);
    if (!line) continue;
    const key = `${speaker.toLowerCase()}|${_normalizeDialogueForMatch(line)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ speaker, line });
  }
  return out;
}

function _extractDialogueBeats(value, inheritedSpeaker = '') {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(item =>
      _extractDialogueBeats(item, inheritedSpeaker)
    );
  }

  if (_isPlainObject(value)) {
    const speaker = _cleanText(
      value.speaker ||
      value.character ||
      value.character_name ||
      value.characterName ||
      value.name ||
      inheritedSpeaker ||
      ''
    );

    const preferredKeys = [
      'lines',
      'dialogue',
      'spoken_dialogue',
      'spoken_words',
      'spokenWords',
      'dialogue_lines',
      'dialogueLines',
      'conversation',
      'exchange',
      'text',
      'line',
    ];

    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const beats = _extractDialogueBeats(
          value[key],
          speaker
        );

        if (beats.length) {
          return beats;
        }
      }
    }

    const spoken = _canonicalDialogueLine(
      value.spoken_words ||
      value.spokenWords ||
      value.dialogue ||
      value.line ||
      value.text ||
      ''
    );

    return spoken
      ? [{ speaker, line: spoken }]
      : [];
  }

  const raw = String(value).trim();

  if (!raw) {
    return [];
  }

  const beats = [];

  /*
   * Explicit speaker-labelled dialogue is the strongest source of speaker
   * identity.  The old parser only handled screenplay labels at the start of
   * a line, which meant inputs such as:
   *
   *   Tape recorder (ambient): 'Subject E.V. ...'
   *   Javi Morales's radio (PHONE): 'Phase one...'
   *
   * could be captured as one giant dialogue line containing narration and the
   * next speaker.  That poisoned the authored-dialogue integrity checker and
   * produced false duplicate reports.
   *
   * Parse labelled quoted utterances first, allowing single or double quotes
   * and allowing multiple labelled beats to occur in one paragraph.
   */
  const labelledQuotedRegex =
    /(?:^|[\r\n]|[.;])\s*([A-Za-z][A-Za-z0-9 ._'’()\-]{1,100})\s*:\s*(?:\"([^\"]*)\"|'([^']*)'|“([^”]*)”|‘([^’]*)’)/g;

  let match;
  let hadLabelledQuotedSyntax = false;

  while ((match = labelledQuotedRegex.exec(raw)) !== null) {
    hadLabelledQuotedSyntax = true;

    const line = _canonicalDialogueLine(
      match[2] != null
        ? match[2]
        : match[3] != null
          ? match[3]
          : match[4] != null
            ? match[4]
            : match[5]
    );

    if (line) {
      beats.push({
        speaker: _cleanText(match[1]),
        line,
      });
    }
  }

  if (hadLabelledQuotedSyntax && beats.length) {
    return beats;
  }

  /*
   * Preserve the original line-oriented screenplay format as a fallback for
   * unquoted speaker lines such as `ELENA: Get out.`
   */
  const screenplayRegex =
    /(?:^|[\r\n])\s*([A-Z][A-Za-z0-9 ._'’-]{1,80})\s*:\s*([^\r\n]+)\s*(?=[\r\n]|$)/g;

  let hadScreenplaySyntax = false;

  while ((match = screenplayRegex.exec(raw)) !== null) {
    hadScreenplaySyntax = true;
    const line = _canonicalDialogueLine(match[2]);

    if (line) {
      beats.push({
        speaker: _cleanText(match[1]),
        line,
      });
    }
  }

  if (hadScreenplaySyntax && beats.length) {
    return beats;
  }

  const quoted = _quotedDialogue(raw);

  if (quoted.length) {
    return quoted.map(line => ({
      speaker: _cleanText(inheritedSpeaker),
      line,
    }));
  }

  const line = _canonicalDialogueLine(raw);

  return line && !_looksLikeCinematicNarration(line)
    ? [{
        speaker: _cleanText(inheritedSpeaker),
        line,
      }]
    : [];
}

function _splitEmbeddedSpeakerLabels(text) {
  const raw = _cleanText(text);
  if (!raw) return [];

  const labelledQuotedRegex =
    /(?:^|[\r\n]|[.;])\s*([A-Za-z][A-Za-z0-9 ._'’()\-]{1,100})\s*:\s*(?:\"([^\"]*)\"|'([^']*)'|“([^”]*)”|‘([^’]*)’)/g;

  const out = [];
  let match;

  while ((match = labelledQuotedRegex.exec(raw)) !== null) {
    const line = _canonicalDialogueLine(
      match[2] != null ? match[2] :
      match[3] != null ? match[3] :
      match[4] != null ? match[4] :
      match[5]
    );

    if (line) {
      out.push({
        speaker: _cleanText(match[1]),
        line,
      });
    }
  }

  return out;
}

function _dialogueBeatRegistry(value, options = {}) {
  return _normalizeAuthoredDialogueInput(value, options);
}

function _formatDialogueBeatRegistry(beats, visibleCharacters = []) {
  if (!beats.length) {
    return 'No speaker identity was explicitly supplied. Infer the intended speaker from the shot intent and visible staging, but assign each authored line to ONE character only.';
  }

  const visible = [...new Set(
    (Array.isArray(visibleCharacters) ? visibleCharacters : [])
      .map(value => _isPlainObject(value)
        ? _cleanText(value.name || value.character || value.character_name || '')
        : _cleanText(value)
      )
      .filter(Boolean)
  )];

  return beats.map((beat, index) => {
    const speaker = beat.speaker
      ? beat.speaker
      : 'SPEAKER NOT EXPLICITLY NAMED — infer exactly one intended speaker from shot intent';

    const listeners = visible.filter(
      name => !_speakerNameMatches(name, beat.speaker || '')
    );

    return [
      `${index + 1}. ACTIVE SPEAKER: ${speaker}.`,
      `SPOKEN LINE: "${beat.line}".`,
      'ONLY THIS CHARACTER MAY ARTICULATE, MOUTH, OR LIP-SYNC THIS EXACT LINE.',
      listeners.length ? `SILENT LISTENERS FOR THIS BEAT: ${listeners.join(', ')}.` : '',
      'KEEP THIS TURN DISTINCT FROM THE NEXT SPEAKER TURN.',
    ].filter(Boolean).join(' ');
  }).join(' ');
}

function _extractAuthoredDialogueLines(value) {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    const lines = [];

    for (const item of value) {
      lines.push(
        ..._extractAuthoredDialogueLines(item)
      );
    }

    return _dedupePreserveOrder(
      lines
    );
  }

  if (_isPlainObject(value)) {
    const preferredKeys = [
      'lines',
      'dialogue',
      'spoken_dialogue',
      'spoken_words',
      'spokenWords',
      'dialogue_lines',
      'dialogueLines',
      'conversation',
      'exchange',
      'text',
      'line',
    ];

    for (const key of preferredKeys) {
      if (
        Object.prototype.hasOwnProperty.call(
          value,
          key
        )
      ) {
        const extracted =
          _extractAuthoredDialogueLines(
            value[key]
          );

        if (extracted.length) {
          return extracted;
        }
      }
    }

    const nodeLine =
      _canonicalDialogueLine(
        value.spoken_words ||
        value.spokenWords ||
        value.dialogue ||
        value.line ||
        value.text ||
        ''
      );

    return nodeLine
      ? [nodeLine]
      : [];
  }

  const raw =
    String(value).trim();

  if (!raw) {
    return [];
  }

  /*
   * Reuse the speaker-aware parser so authored dialogue extraction and speaker
   * assignment cannot disagree about where an utterance starts and ends.
   * This is especially important for labelled single-quoted beats embedded in
   * a prose paragraph.
   */
  const parsedBeats =
    _extractDialogueBeats(raw);

  if (parsedBeats.length) {
    const parsedLines =
      parsedBeats
        .map(beat => _canonicalDialogueLine(beat.line))
        .filter(Boolean);

    if (parsedLines.length) {
      return _dedupePreserveOrder(parsedLines);
    }
  }

  const quoted =
    _quotedDialogue(raw);

  if (quoted.length) {
    return _dedupePreserveOrder(
      quoted
    );
  }

  return [
    _canonicalDialogueLine(raw),
  ].filter(Boolean);
}

/* ============================================================================
 * DIALOGUE OCCURRENCE SCANNING
 * ========================================================================== */

function _scanQuotedDialogue(description) {
  const matches = [];

  const regex =
    /(?:\*{1,3})?"([^"]*)"(?:\*{1,3})?|(?:\*{1,3})?“([^”]*)”(?:\*{1,3})?|(?:\*{1,3})?'([^'\r\n]+)'(?:\*{1,3})?/g;

  let match;

  while (
    (match = regex.exec(
      description
    )) !== null
  ) {
    const text =
      _canonicalDialogueLine(
        match[1] != null
          ? match[1]
          : match[2] != null
            ? match[2]
            : match[3]
      );

    if (!text) {
      continue;
    }

    matches.push({
      text,
      normalized:
        _normalizeDialogueForMatch(
          text
        ),
      index: match.index,
      length: match[0].length,
      end:
        match.index +
        match[0].length,
    });
  }

  return matches;
}

/*
 * Locate an authored utterance in the generated description.
 *
 * Quote variants and apostrophe variants are normalized.
 */
function _findDialogueOccurrence(
  description,
  sourceLine
) {
  const source =
    _canonicalDialogueLine(
      sourceLine
    );

  const normalizedSource =
    _normalizeDialogueForMatch(
      source
    );

  if (!source || !normalizedSource) {
    return null;
  }

  /*
   * First and highest-priority rule:
   * if the actual cinematic description already contains a quoted utterance
   * that semantically represents the authored line, PASS IT.
   *
   * This prevents a correct shot from being invalidated merely because the
   * model used different punctuation, capitalization, contractions, or a
   * very small natural-language variation.
   */
  const semanticQuoted =
    _bestSemanticDialogueOccurrence(
      description,
      source,
      {
        quotedOnly: true,
      }
    );

  if (semanticQuoted) {
    return {
      index: semanticQuoted.index,
      length: semanticQuoted.length,
      mode: semanticQuoted.similarity === 1
        ? 'quoted'
        : 'quoted-semantic',
      text: semanticQuoted.text,
      similarity: semanticQuoted.similarity,
    };
  }

  /*
   * Exact / flexible unquoted match remains as a recovery path. It is never
   * preferred over a semantically valid quoted utterance.
   */
  /* Unquoted recovery must never search inside a quoted span that failed the
   * atomic dialogue test. Otherwise a quote such as `\"Stay here, before the lights change.\"`
   * can still expose `Stay here` to the unquoted fallback and cause the whole
   * sentence to be re-quoted as speech. Mask all quoted spans before fallback. */
  let unquotedDescription = String(description || '');
  const quotedSpansForFallback = _scanQuotedDialogue(unquotedDescription);
  if (quotedSpansForFallback.length) {
    const chars = Array.from(unquotedDescription);
    const masked = new Uint8Array(chars.length);
    for (const span of quotedSpansForFallback) {
      for (let i = span.index; i < Math.min(span.end, chars.length); i++) {
        masked[i] = 1;
      }
    }
    for (let i = 0; i < chars.length; i++) {
      if (masked[i]) chars[i] = ' ';
    }
    unquotedDescription = chars.join('');
  }

  const sourceWords =
    normalizedSource
      .split(/\s+/)
      .filter(Boolean);

  if (!sourceWords.length) {
    return null;
  }

  const flexiblePattern =
    sourceWords
      .map(word =>
        _escapeRegex(word)
      )
      .join('\\s+');

  let flexibleRegex;

  try {
    flexibleRegex =
      new RegExp(
        `(?<![\\p{L}\\p{N}_])${flexiblePattern}(?![\\p{L}\\p{N}_])`,
        'iu'
      );
  } catch (_) {
    flexibleRegex =
      new RegExp(
        `(?:^|[^A-Za-z0-9_])(${flexiblePattern})(?![A-Za-z0-9_])`,
        'i'
      );
  }

  const match =
    flexibleRegex.exec(
      unquotedDescription
    );

  if (match) {
    return {
      index:
        match.index +
        (
          match[1]
            ? match[0].length -
              match[1].length
            : 0
        ),
      length:
        match[1]
          ? match[1].length
          : match[0].length,
      mode: 'unquoted',
      text: source,
      similarity: 1,
    };
  }

  /*
   * Robust unquoted recovery.
   *
   * The old fallback above builds a regex from the punctuation-preserving
   * normalized source line. That is fragile for perfectly valid cinematic text
   * containing em-dashes, curly punctuation, apostrophes, or punctuation that
   * Mistral has placed differently around the same words. The failure observed
   * in production is exactly this class of problem: the complete authored line
   * is visibly present in the model output, but quote enforcement reports it as
   * missing because the punctuation-sensitive regex cannot locate it.
   *
   * Build a second-pass regex from semantic dialogue tokens instead. Tokens are
   * already normalized for contractions and conservative semantic aliases.
   * Between tokens we allow whitespace/punctuation/symbols, while preserving
   * token order. This locates the existing authored utterance without inventing
   * or appending text.
   */
  const semanticTokens = _semanticDialogueTokens(source);

  if (semanticTokens.length) {
    const tokenPattern = semanticTokens
      .map(token => _escapeRegex(token))
      .join('[\\s\\p{P}\\p{S}]+');

    try {
      const semanticRegex = new RegExp(
        `(?<![\\p{L}\\p{N}_])(${tokenPattern})(?![\\p{L}\\p{N}_])`,
        'iu'
      );
      const semanticMatch = semanticRegex.exec(unquotedDescription);

      if (semanticMatch) {
        return {
          index: semanticMatch.index,
          length: semanticMatch[0].length,
          mode: 'unquoted-semantic',
          text: semanticMatch[0],
          similarity: _semanticDialogueSimilarity(source, semanticMatch[0]),
        };
      }
    } catch (_) {
      /* Fall through to the bounded lexical-window recovery below. */
    }
  }

  /*
   * Final bounded lexical-window recovery. This is deliberately conservative:
   * it searches only sentence-like spans and accepts a span when the semantic
   * similarity is strong enough. It is a locator only; the enforcement layer
   * still replaces the located span with the immutable authored wording.
   */
  const sentenceRegex = /[^.!?\n]+[.!?]?/g;
  let sentenceMatch;
  while ((sentenceMatch = sentenceRegex.exec(unquotedDescription)) !== null) {
    const candidate = sentenceMatch[0];
    const similarity = _semanticDialogueSimilarity(source, candidate);

    if (similarity >= DIALOGUE_STRONG_SEMANTIC_SIMILARITY) {
      return {
        index: sentenceMatch.index,
        length: candidate.length,
        mode: 'unquoted-semantic-span',
        text: candidate,
        similarity,
      };
    }
  }

  return null;
}

/* ============================================================================
 * AUTHORED DIALOGUE NORMALIZATION
 * ========================================================================== */

/*
 * Restore missing quotation boundaries only.
 *
 * We NEVER append authored dialogue here.
 *
 * This is critical:
 *
 * BEFORE:
 *   Model generated:
 *     Elena says What if it's him?
 *
 * AFTER:
 *     Elena says "What if it's him?"
 *
 * We do NOT do:
 *     ... existing sentence ...
 *     Elena says "What if it's him?"
 *
 * because that causes duplicate speech.
 */
function _enforceAuthoredDialogueQuotes(
  description,
  sourceLines
) {
  let working =
    String(description || '');

  if (
    !working ||
    !sourceLines.length
  ) {
    return {
      description: working,
      restored: [],
      missing: [...sourceLines],
    };
  }

  const restored = [];
  const missing = [];

  /*
   * Work backwards when modifying string offsets so later replacements don't
   * invalidate earlier match positions.
   */
  const replacements = [];

  for (
    const sourceLine of sourceLines
  ) {
    const occurrence =
      _findDialogueOccurrence(
        working,
        sourceLine
      );

    if (!occurrence) {
      missing.push(
        _canonicalDialogueLine(
          sourceLine
        )
      );
      continue;
    }

    if (
      occurrence.mode ===
      'quoted' ||
      occurrence.mode ===
      'quoted-semantic'
    ) {
      restored.push(
        _canonicalDialogueLine(
          sourceLine
        )
      );

      continue;
    }

    replacements.push({
      index:
        occurrence.index,
      length:
        occurrence.length,
      replacement:
        `"${_canonicalDialogueLine(
          sourceLine
        )}"`,
      sourceLine:
        _canonicalDialogueLine(
          sourceLine
        ),
    });

    restored.push(
      _canonicalDialogueLine(
        sourceLine
      )
    );
  }

  replacements.sort(
    (a, b) =>
      b.index - a.index
  );

  for (
    const replacement of replacements
  ) {
    working =
      working.slice(
        0,
        replacement.index
      ) +
      replacement.replacement +
      working.slice(
        replacement.index +
        replacement.length
      );
  }

  return {
    description:
      working.trim(),
    restored:
      _dedupePreserveOrder(
        restored
      ),
    missing:
      _dedupePreserveOrder(
        missing
      ),
  };
}

/* ============================================================================
 * DUPLICATE AUTHORED-DIALOGUE REMOVAL
 * ========================================================================== */

/*
 * Exact authored dialogue must occur ONCE.
 *
 * If Mistral produces:
 *
 *   "Elena, listen to me."
 *
 * and later repeats:
 *
 *   "Elena, listen to me."
 *
 * the second occurrence is redundant.
 *
 * We keep the first because it is the earliest semantic placement in the
 * generated chronological description.
 */
function _removeDuplicateAuthoredDialogue(
  description,
  sourceLines
) {
  let working =
    String(description || '');

  if (
    !working ||
    !sourceLines.length
  ) {
    return {
      description: working,
      removed: [],
    };
  }

  const authoredSet =
    new Set(
      sourceLines
        .map(
          _normalizeDialogueForMatch
        )
        .filter(Boolean)
    );

  const seen =
    new Set();

  const matches =
    _scanQuotedDialogue(
      working
    );

  const removals = [];
  const removed = [];

  for (
    const match of matches
  ) {
    if (
      !authoredSet.has(
        match.normalized
      )
    ) {
      continue;
    }

    if (
      !seen.has(
        match.normalized
      )
    ) {
      seen.add(
        match.normalized
      );

      continue;
    }

    removals.push({
      index:
        match.index,
      end:
        match.end,
    });

    removed.push(
      match.text
    );
  }

  /*
   * Remove from right to left.
   *
   * We remove only the duplicate quoted speech itself, not the surrounding
   * cinematic prose.
   */
  removals.sort(
    (a, b) =>
      b.index - a.index
  );

  for (
    const removal of removals
  ) {
    working =
      working.slice(
        0,
        removal.index
      ) +
      working.slice(
        removal.end
      );
  }

  /*
   * Clean punctuation/whitespace left by removal without rewriting semantics.
   */
  working =
    working
      .replace(/\s{2,}/g, ' ')
      .replace(
        /\s+([,.!?;:])/g,
        '$1'
      )
      .trim();

  return {
    description: working,
    removed:
      _dedupePreserveOrder(
        removed
      ),
  };
}

/* ============================================================================
 * DIALOGUE INTEGRITY
 * ========================================================================== */

/*
 * Compare authored lines against the final spoken channel.
 *
 * Rules:
 *
 * 1. Every authored line must exist.
 * 2. Every authored line must appear in source order.
 * 3. An authored line may be split into contiguous quoted segments.
 * 4. The same authored line may NOT appear twice.
 * 5. Unrelated/generated dialogue may occur before or between authored lines.
 */

function _speakerMentionedNear(description, speaker, quoteIndex, windowSize = 420) {
  const before = String(description || '')
    .slice(Math.max(0, Number(quoteIndex) - windowSize), Number(quoteIndex))
    .replace(/\s+/g, ' ')
    .trim();

  for (const alias of _speakerAliases(speaker)) {
    if (new RegExp(`\\b${_escapeRegex(alias)}\\b`, 'i').test(before)) return true;
  }
  return false;
}


function _normalizeSpeakerForValidation(value) {
  return _cleanText(value)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _speakerNameMatches(actual, expected) {
  const a = _normalizeSpeakerForValidation(actual);
  const e = _normalizeSpeakerForValidation(expected);
  if (!a || !e) return false;
  if (a === e) return true;
  return a.includes(e) || e.includes(a);
}

function _speakerAliases(name) {
  const raw = _cleanText(name);
  if (!raw) return [];
  const parts = raw.split(/\s+/).filter(Boolean);
  const set = new Set([raw]);
  if (parts.length >= 2) {
    set.add(parts[0]);
    set.add(parts[parts.length - 1]);
  }
  return [...set];
}

function _speakerPerformanceNear(description, speaker, quoteIndex) {
  const before = String(description || '')
    .slice(Math.max(0, Number(quoteIndex) - 520), Number(quoteIndex))
    .replace(/\s+/g, ' ')
    .trim();

  const aliases = _speakerAliases(speaker);
  const actionWords = '(?:says?|speaks?|replies?|responds?|answers?|asks?|whispers?|shouts?|calls?|mutters?|murmurs?|declares?|insists?|interrupts?|articulates?|speaking|talks?|talking|retorts?|snaps?|demands?|argues?|admits?|warns?|pleads?|insists?|continues?)';
  for (const alias of aliases) {
    const escaped = _escapeRegex(alias);
    const patterns = [
      new RegExp(`\\b${escaped}\\b[^.!?]{0,300}\\b${actionWords.replace('(?:','').replace(')','')}\\b[^.!?]{0,180}$`, 'i'),
      new RegExp(`\\b${escaped}\\b\\s*:\s*[^\\n]{0,260}$`, 'i'),
    ];
    if (patterns.some(re => re.test(before))) return true;
  }
  return false;
}

function _listenerSpeakingNear(description, listener, quoteStart, quoteEnd, authoritativeSpeaker) {
  const region = String(description || '').slice(
    Math.max(0, Number(quoteStart) - 420),
    Math.min(String(description || '').length, Number(quoteEnd) + 220)
  );

  for (const alias of _speakerAliases(listener)) {
    const escaped = _escapeRegex(alias);
    const speaking = new RegExp(
      `\\b${escaped}\\b[^.!?]{0,240}\\b(?:says?|speaks?|replies?|answers?|asks?|whispers?|shouts?|calls?|mutters?|murmurs?|declares?|insists?|interrupts?|articulates?|speaking|speaks|talks?|talking)\\b`,
      'i'
    );
    if (!speaking.test(region)) continue;

    // If the authoritative speaker is clearly named around the same beat,
    // listener speech is still a contradiction because this line has one owner.
    const ownerClear = _speakerPerformanceNear(region, authoritativeSpeaker, region.length);
    if (!ownerClear || !_speakerNameMatches(listener, authoritativeSpeaker)) {
      return true;
    }
  }
  return false;
}

function _extractSpeakerPosition(description, speaker) {
  const opening = String(description || '').slice(0, 1800).replace(/\s+/g, ' ').trim();
  const aliases = _speakerAliases(speaker);
  const positionRegex = /\b(?:screen[-\s]?(?:left|right|center|centre)|left|right|center|centre)\b(?:\s+|,\s*)\b(?:foreground|midground|background)\b|\b(?:foreground|midground|background)\b(?:\s+|,\s*)\b(?:screen[-\s]?(?:left|right|center|centre)|left|right|center|centre)\b/i;

  for (const alias of aliases) {
    const m = new RegExp(`\\b${_escapeRegex(alias)}\\b`, 'i').exec(opening);
    if (!m) continue;
    const sentenceStart = Math.max(
      opening.lastIndexOf('.', m.index) + 1,
      opening.lastIndexOf(':', m.index) + 1,
      opening.lastIndexOf(';', m.index) + 1,
      opening.lastIndexOf('Opening frame:', m.index) + 'Opening frame:'.length
    );
    const nextStops = ['.', ';', ':'].map(ch => {
      const i = opening.indexOf(ch, m.index + alias.length);
      return i < 0 ? opening.length : i + 1;
    });
    const sentenceEnd = Math.min(...nextStops);
    const sentence = opening.slice(sentenceStart, sentenceEnd);
    const pm = sentence.match(positionRegex);
    if (pm) return pm[0].replace(/\s+/g, ' ').trim();
  }
  return 'in the established opening position';
}

function _bindAuthoredDialogueSpeakers(description, dialogueBeats = [], visibleCharacters = []) {
  let working = String(description || '');
  const beats = (dialogueBeats || []).filter(beat => beat?.speaker && beat?.line);
  if (!beats.length) return working;
  const edits = [];
  let searchFrom = 0;
  for (const beat of beats) {
    const occurrence = _bestSemanticDialogueOccurrence(working, beat.line, { quotedOnly: true, startIndex: searchFrom });
    if (!occurrence) continue;
    const before = working.slice(Math.max(0, occurrence.index - 420), occurrence.index).replace(/\s+/g, ' ').trim();
    const speaker = _cleanText(beat.speaker);
    const explicit = new RegExp(`\\b${_escapeRegex(speaker)}\\b[^.!?]{0,300}\\b(?:says?|speaks?|replies?|answers?|asks?|whispers?|shouts?|calls?|mutters?|murmurs?|declares?|insists?|interrupts?|articulates?|speaking|talks?|talking)\\b[^.!?]{0,180}$`, 'i').test(before);
    if (!explicit) {
      const position = _extractSpeakerPosition(working, speaker);
      const listeners = (Array.isArray(visibleCharacters) ? visibleCharacters : [])
        .map(v => _isPlainObject(v) ? _cleanText(v.name || v.character || v.character_name || '') : _cleanText(v))
        .filter(Boolean)
        .filter(name => !_speakerNameMatches(name, speaker));
      const listenerText = listeners.length
        ? ` ${listeners.map(name => `${name} remains silent in the established opening position, mouth closed and listening.`).join(' ')}`
        : '';
      edits.push({ index: occurrence.index, text: `${speaker}, ${position}, is the only active speaker for this beat.${listenerText} ` });
    }
    searchFrom = occurrence.index + occurrence.length;
  }
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    working = working.slice(0, edit.index) + edit.text + working.slice(edit.index);
  }
  return working;
}

function _speakerAttributionDiagnostics(description, dialogueBeats, visibleCharacters = []) {
  const visible = [...new Set(
    (Array.isArray(visibleCharacters) ? visibleCharacters : [])
      .map(value => _isPlainObject(value)
        ? _cleanText(value.name || value.character || value.character_name || '')
        : _cleanText(value))
      .filter(Boolean)
  )];

  const diagnostics = [];
  for (const beat of dialogueBeats || []) {
    if (!beat?.speaker || !beat?.line) continue;

    const occurrence = _bestSemanticDialogueOccurrence(
      description,
      beat.line,
      { quotedOnly: true }
    );

    if (!occurrence) continue;

    const speakerFound = _speakerMentionedNear(
      description,
      beat.speaker,
      occurrence.index,
      420
    );

    const speakerPerformanceFound = _speakerPerformanceNear(
      description,
      beat.speaker,
      occurrence.index
    );

    const listenerContradictions = visible
      .filter(name => !_speakerNameMatches(name, beat.speaker))
      .filter(name =>
        _listenerSpeakingNear(
          description,
          name,
          occurrence.index,
          occurrence.index + occurrence.length,
          beat.speaker
        )
      );

    diagnostics.push({
      speaker: beat.speaker,
      line: beat.line,
      speakerFound,
      speakerPerformanceFound,
      listenerContradictions,
      valid: speakerPerformanceFound && listenerContradictions.length === 0,
    });
  }

  return {
    diagnostics,
    invalid: diagnostics.filter(d => !d.valid),
    valid: diagnostics.every(d => d.valid),
  };
}

function _speakerAttributionRepairInstruction(diagnostics, visibleCharacters = []) {
  const invalid = (diagnostics || []).filter(d => !d.valid);
  if (!invalid.length) return '';

  const visible = [...new Set(
    (Array.isArray(visibleCharacters) ? visibleCharacters : [])
      .map(value => _isPlainObject(value)
        ? _cleanText(value.name || value.character || value.character_name || '')
        : _cleanText(value))
      .filter(Boolean)
  )];

  const corrections = invalid.map((d, i) => {
    const listenerText = d.listenerContradictions?.length
      ? ` These characters were incorrectly described as speaking during the same beat: ${d.listenerContradictions.join(', ')}.`
      : '';

    return [
      `ATTRIBUTION ERROR ${i + 1}.`,
      `The exact authored line "${d.line}" belongs ONLY to ${d.speaker}.`,
      d.speakerPerformanceFound
        ? ''
        : `${d.speaker} must be explicitly named immediately before or during the speaking action.`,
      listenerText,
      `${d.speaker} is the only character permitted to articulate, mouth, or lip-sync that line.`,
      `Every other visible character must be explicitly silent for that beat, with mouths closed or naturally still.`,
    ].filter(Boolean).join(' ');
  }).join(' ');

  return [
    'TARGETED SPEAKER-ATTRIBUTION RETRY.',
    'This is NOT a request to remove or split a legitimate multi-speaker exchange.',
    'Preserve all authored lines, their original order, the existing camera/composition, character identities, wardrobe, props, lighting and physical blocking.',
    'Repair only the speaker-to-line performance mapping.',
    'Each authored line has exactly one active speaker.',
    'A later authored line may belong to another character; preserve the turn-taking sequence.',
    'Never use vague pronouns such as they, both, the pair, or the characters for a speaking action.',
    'Name the active speaker, give their frame position/orientation, bind the exact spoken words to them, then explicitly describe the other visible characters as silent listeners/reactions.',
    corrections,
    'Return the complete ltx_shot_description as one natural chronological description.',
  ].filter(Boolean).join(' ');
}


function _positionFirstDiagnostics(description, visibleCharacters = []) {
  const text = String(description || '').trim();
  const opening = text.slice(0, 1400);
  const lowerOpening = opening.toLowerCase();

  const names = [...new Set(
    (Array.isArray(visibleCharacters) ? visibleCharacters : [])
      .map(value => _isPlainObject(value)
        ? _cleanText(value.name || value.character || value.character_name || '')
        : _cleanText(value)
      )
      .filter(Boolean)
  )];

  const positionPattern =
    /\b(?:screen[-\s]?(?:left|right|center|centre)|left|right|center|centre|foreground|midground|background|upper|lower|near[-\s]?foreground|far[-\s]?background)\b/i;

  const missingFromOpening = names.filter(name =>
    !lowerOpening.includes(name.toLowerCase())
  );

  const missingPositionAnchors = names.filter(name => {
    const idx = lowerOpening.indexOf(name.toLowerCase());
    if (idx < 0) return true;

    const context = opening.slice(
      Math.max(0, idx - 180),
      Math.min(opening.length, idx + name.length + 240)
    );

    return !positionPattern.test(context);
  });

  const startsWithMap = /^(?:opening frame|opening visual map|opening composition|current opening frame)\s*:/i.test(text);

  const firstQuote = text.indexOf('\"');
  const allNamesBeforeFirstQuote = names.length === 0 || firstQuote < 0 || names.every(name => { const i = text.toLowerCase().indexOf(name.toLowerCase()); return i >= 0 && i < firstQuote; });

  const valid =
    names.length === 0
      ? startsWithMap || text.length === 0
      : startsWithMap &&
        missingFromOpening.length === 0 &&
        missingPositionAnchors.length === 0 &&
        allNamesBeforeFirstQuote;

  return {
    valid,
    startsWithMap,
    openingCharacterMap: names.length > 0
      ? valid
      : startsWithMap,
    missingFromOpening,
    missingPositionAnchors,
    allNamesBeforeFirstQuote,
    visibleCharacterNames: names,
  };
}

function _positionFirstRepairInstruction(diagnostics) {
  if (!diagnostics || diagnostics.valid) return '';

  const missingNames = diagnostics.missingFromOpening || [];
  const missingPositions = diagnostics.missingPositionAnchors || [];

  return [
    'POSITION-FIRST OUTPUT CONTRACT FAILED.',
    'Rewrite the COMPLETE ltx_shot_description, do not patch only one sentence.',
    'The very first paragraph MUST begin exactly with "Opening frame:".',
    'Before describing any motion, dialogue, camera movement, reaction, transition, or atmosphere, identify EVERY visible character from the current authored image one by one.',
    'For each visible character, state: exact character name, screen position (screen-left/screen-center/screen-right), depth (foreground/midground/background), visible crop/extent, body orientation, head direction, eyeline, posture, wardrobe/identity anchors, and current interaction or prop contact.',
    'Keep each character as a separate named subject. Never introduce a visible character only later in the paragraph.',
    missingNames.length
      ? `These visible characters are missing from the opening map and MUST be included there: ${missingNames.join(', ')}.`
      : '',
    missingPositions.length
      ? `These characters appear without a nearby explicit screen-position anchor and MUST be rewritten with one: ${missingPositions.join(', ')}.`
      : '',
    'After the complete opening character map is established, continue with the chronological cinematic action.',
    'Do not begin with "The shot opens with..." followed by one character and then introduce the others later.',
    'The opening map is not optional metadata; it is the first visual description of the current image and must remain faithful to the pixels.',
  ].filter(Boolean).join(' ');
}


/* ============================================================================
 * HARD LTX DIALOGUE SUBMISSION GATE
 * ========================================================================== */

function _strictQuotedDialogueSpans(description) {
  const matches = [];
  const text = String(description || '');
  const regex = /"([^"]*)"|“([^”]*)”/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const utterance = _canonicalDialogueLine(
      match[1] != null ? match[1] : match[2]
    );
    if (!utterance) continue;

    matches.push({
      text: utterance,
      normalized: _normalizeDialogueForMatch(utterance),
      strictNormalized: _normalizeDialogueForMatch(utterance),
      index: match.index,
      length: match[0].length,
      end: match.index + match[0].length,
    });
  }

  return matches;
}

function _strictSpeakerPerformanceNear(description, speaker, quoteIndex) {
  const before = String(description || '')
    .slice(Math.max(0, Number(quoteIndex) - 700), Number(quoteIndex))
    .replace(/\s+/g, ' ')
    .trim();

  const escaped = _escapeRegex(speaker);
  if (!escaped) return false;

  const actionWords = '(?:says?|speaks?|replies?|responds?|answers?|asks?|whispers?|shouts?|calls?|mutters?|murmurs?|declares?|insists?|interrupts?|articulates?|speaking|talks?|talking|retorts?|snaps?|demands?|argues?|admits?|warns?|pleads?|insists?|continues?)';

  /* The active speaker must be named in the actual speaking clause. Merely
   * mentioning the character somewhere earlier in the shot is not enough. */
  const patterns = [
    new RegExp(`\\b${escaped}\\b[^.!?]{0,360}\\b${actionWords}\\b[^.!?]{0,220}$`, 'i'),
    new RegExp(`\\b${escaped}\\b\\s*,[^.!?]{0,220}\\b${actionWords}\\b[^.!?]{0,220}$`, 'i'),
    new RegExp(`\\b${escaped}\\b\\s*:\\s*[^\\n]{0,320}$`, 'i'),
  ];

  return patterns.some(re => re.test(before));
}

function _strictSpeakerPositionNear(description, speaker, quoteIndex) {
  const before = String(description || '')
    .slice(Math.max(0, Number(quoteIndex) - 1100), Number(quoteIndex))
    .replace(/\s+/g, ' ')
    .trim();

  for (const alias of _speakerAliases(speaker)) {
    const escaped = _escapeRegex(alias);
    if (!escaped) continue;

    const position = new RegExp(
      `\\b(?:screen[-\\s]?(?:left|right|center|centre)|left|right|center|centre)\\b(?:\\s+|,\\s*)\\b(?:foreground|midground|background)\\b|\\b(?:foreground|midground|background)\\b(?:\\s+|,\\s*)\\b(?:screen[-\\s]?(?:left|right|center|centre)|left|right|center|centre)\\b`,
      'i'
    );

    const idx = before.search(new RegExp(`\\b${escaped}\\b`, 'i'));
    if (idx < 0) continue;

    const local = before.slice(idx, Math.min(before.length, idx + 420));
    if (position.test(local)) return true;
  }

  return false;
}

async function _semanticSpeakerOwnershipAudit(description, dialogueBeats = [], visibleCharacters = [], model = DEFAULT_MODEL) {
  const beats = (Array.isArray(dialogueBeats) ? dialogueBeats : [])
    .filter(beat => beat && beat.line && beat.speaker)
    .map((beat, index) => ({
      turn: index + 1,
      speaker: _cleanText(beat.speaker),
      line: _canonicalDialogueLine(beat.line),
    }))
    .filter(beat => beat.speaker && beat.line);

  if (!beats.length) {
    return {
      valid: true,
      evaluations: [],
      unresolved: [],
      invalid: [],
      reason: 'no_named_dialogue_beats',
    };
  }

  const candidateSpeakerMap = new Map();
  for (const value of [
    ...(Array.isArray(visibleCharacters) ? visibleCharacters : []),
    ...beats.map(beat => beat.speaker),
  ]) {
    const name = _cleanText(_isPlainObject(value)
      ? value.name || value.character || value.character_name || value.speaker || value.speaker_name || ''
      : value);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!candidateSpeakerMap.has(key)) {
      candidateSpeakerMap.set(key, name);
    }
  }
  const candidateSpeakers = [...candidateSpeakerMap.values()];

  const system = [
    'You are the semantic dialogue-ownership judge for a cinematic LTX image-to-video pipeline.',
    'Read the COMPLETE generated shot description for meaning, chronology, dialogue context, character actions, reactions, voice attribution, pronouns, turn order, and staging.',
    'Do NOT use rigid proximity rules, fixed word windows, punctuation patterns, or exact grammar templates.',
    'Do NOT require the speaker name to appear immediately before the quotation.',
    'Determine semantically whether each AUTHORITATIVE dialogue line is clearly spoken by its assigned character.',
    'Equivalent constructions are valid: the character speaks, answers, responds, replies, mutters, whispers, their voice sounds, they say the words, the character delivers the line, etc.',
    'Pronouns may establish ownership when the surrounding chronology makes the referent unambiguous.',
    'A speaker may be established earlier and continue speaking across subsequent dialogue turns when there is no competing speaker cue.',
    'Conversational turn order, listener reactions, gaze, body language, and explicit scene geography are valid semantic evidence.',
    'Do not invent a speaker. Use only the candidate speakers supplied by the caller.',
    'A line is invalid only when its ownership is genuinely ambiguous, contradictory, assigned to another character, or absent from the narrative.',
    'Do not require a speaker name to appear near the quote. Semantic continuity across sentences and turns is sufficient when unambiguous.',
    'For each authoritative turn, explicitly decide WHO is performing the quoted line from the complete meaning of the description, then compare that performer with the assigned speaker.',
    'Return JSON only with: evaluations, valid.',
    'Each evaluation must contain line, assigned_speaker, confident, confidence, evidence, contradiction.',
    'confidence must be from 0 to 1.',
  ].join(' ');

  const userText = JSON.stringify({
    candidate_speakers: candidateSpeakers,
    authoritative_dialogue_turns: beats,
    generated_shot_description: String(description || ''),
    instruction: 'Judge ownership by semantic meaning of the complete description. Do not reject merely because the speaker name is not syntactically adjacent to the quote.',
  }, null, 2);

  const keys = _keys();
  if (!keys.length) {
    throw new Error('[LTXVision] No Mistral keys configured for semantic dialogue audit');
  }

  const response = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
      temperature: 0.0,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${keys[0]}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  const parsed = _parseStructuredContent(
    response?.data?.choices?.[0]?.message?.content
  );

  const evaluations = Array.isArray(parsed?.evaluations)
    ? parsed.evaluations
    : [];

  const byLine = new Map(
    evaluations.map(item => [
      _normalizeDialogueForMatch(item?.line || ''),
      item,
    ])
  );

  const invalid = [];
  const unresolved = [];

  for (const beat of beats) {
    const evaluation = byLine.get(_normalizeDialogueForMatch(beat.line));
    const speaker = _cleanText(evaluation?.assigned_speaker || '');
    const confidence = Number(evaluation?.confidence);
    const confident =
      evaluation?.confident === true ||
      (Number.isFinite(confidence) && confidence >= 0.70);
    const speakerAllowed = candidateSpeakers.some(name =>
      name.toLowerCase() === speaker.toLowerCase()
    );

    if (!evaluation || !speaker || !speakerAllowed || !confident) {
      const row = {
        line: beat.line,
        speaker: beat.speaker,
        assignedSpeaker: speaker,
        confidence: Number.isFinite(confidence) ? confidence : null,
        evidence: _cleanText(evaluation?.evidence || ''),
        contradiction: _cleanText(evaluation?.contradiction || ''),
      };
      invalid.push(row);
      if (!evaluation || !speaker) unresolved.push(row);
    }
  }

  return {
    valid: invalid.length === 0 && evaluations.length >= beats.length,
    evaluations,
    unresolved,
    invalid,
  };
}

async function _hardDialogueSubmissionAudit(description, sourceLines, dialogueBeats = [], visibleCharacters = [], model = DEFAULT_MODEL) {
  const required = _dedupePreserveOrder(sourceLines || []);
  const spans = _strictQuotedDialogueSpans(description);

  if (!required.length) {
    return {
      valid: true,
      required: 0,
      quoted: spans.length,
      missingQuoted: [],
      duplicateQuoted: [],
      outOfOrder: [],
      speakerFailures: [],
      unownedQuotedSpeech: [],
    };
  }

  const speakerByLine = new Map(
    (dialogueBeats || [])
      .filter(beat => beat?.line)
      .map(beat => [
        _normalizeDialogueForMatch(beat.line),
        _cleanText(beat.speaker || ''),
      ])
  );

  const matched = [];
  const missingQuoted = [];
  const duplicateQuoted = [];
  const outOfOrder = [];
  const speakerFailures = [];
  const usedSpanIndexes = new Set();

  for (let r = 0; r < required.length; r++) {
    const line = _canonicalDialogueLine(required[r]);
    const normalized = _normalizeDialogueForMatch(line);
    const candidates = spans
      .map((span, index) => ({ span, index }))
      .filter(({ span }) => span.strictNormalized === normalized);

    if (candidates.length === 0) {
      missingQuoted.push(line);
      continue;
    }

    if (candidates.length > 1) {
      duplicateQuoted.push(line);
    }

    const chosen = candidates.find(({ index }) => !usedSpanIndexes.has(index)) || candidates[0];
    usedSpanIndexes.add(chosen.index);
    matched.push({ source: line, span: chosen.span, index: chosen.index });

    const beat = (dialogueBeats || []).find(item =>
      _normalizeDialogueForMatch(item?.line || '') === normalized
    );
    const speaker = _cleanText(beat?.speaker || speakerByLine.get(normalized) || '');

    if (!speaker) {
      speakerFailures.push({
        line,
        reason: 'missing_named_speaker',
        quoteIndex: chosen.span.index,
      });
      continue;
    }

    // Speaker ownership is adjudicated semantically below from the complete
    // generated description. Do not apply lexical proximity/position heuristics here.
  }

  let previousIndex = -1;
  for (const match of matched) {
    if (match.index < previousIndex) {
      outOfOrder.push(match.source);
    }
    previousIndex = match.index;
  }

  const unownedQuotedSpeech = spans.filter((span, index) => {
    if (usedSpanIndexes.has(index)) return false;
    return required.every(line =>
      _normalizeDialogueForMatch(line) !== span.strictNormalized
    );
  }).map(span => span.text);

  const semantic = await _semanticSpeakerOwnershipAudit(
    description,
    dialogueBeats,
    visibleCharacters,
    model
  );

  for (const item of semantic.invalid || []) {
    speakerFailures.push({
      line: item.line,
      speaker: item.speaker,
      reason: item.contradiction
        ? `semantic_speaker_ownership_failed: ${item.contradiction}`
        : 'semantic_speaker_ownership_failed',
      confidence: item.confidence,
      evidence: item.evidence,
    });
  }

  return {
    valid:
      missingQuoted.length === 0 &&
      duplicateQuoted.length === 0 &&
      outOfOrder.length === 0 &&
      speakerFailures.length === 0,
    required: required.length,
    quoted: spans.length,
    missingQuoted: _dedupePreserveOrder(missingQuoted),
    duplicateQuoted: _dedupePreserveOrder(duplicateQuoted),
    outOfOrder: _dedupePreserveOrder(outOfOrder),
    speakerFailures,
    unownedQuotedSpeech: _dedupePreserveOrder(unownedQuotedSpeech),
    matched,
  };
}

function _buildHardDialogueRepairInstruction(audit) {
  if (!audit || audit.valid) return '';

  const missing = audit.missingQuoted?.length
    ? `MISSING QUOTED LINES: ${audit.missingQuoted.map(line => `"${line}"`).join(' ')}`
    : '';
  const duplicate = audit.duplicateQuoted?.length
    ? `DUPLICATE QUOTED LINES: ${audit.duplicateQuoted.map(line => `"${line}"`).join(' ')}`
    : '';
  const order = audit.outOfOrder?.length
    ? `OUT-OF-ORDER LINES: ${audit.outOfOrder.map(line => `"${line}"`).join(' ')}`
    : '';
  const speakerFailures = audit.speakerFailures?.length
    ? `SPEAKER-BINDING FAILURES: ${audit.speakerFailures.map(item => {
        const speaker = item.speaker ? ` assigned speaker=${item.speaker};` : '';
        return `line="${item.line}"${speaker} reason=${item.reason}`;
      }).join(' | ')}`
    : '';

  return [
    'HARD DIALOGUE SUBMISSION GATE FAILED.',
    'The shot MUST NOT be considered complete until every authoritative dialogue line is present as its own exact quoted utterance.',
    'Quotation marks are mandatory around every authored spoken line. Do not rely on semantic recovery for submission.',
    'Every authored line must occur exactly once in straight double quotes in the final ltx_shot_description.',
    'Every authored line must be semantically and unambiguously owned by its named speaker. Evaluate the whole chronological description, not speaker-name proximity or a fixed wording pattern.',
    'Pronouns and indirect speaker references are allowed when the surrounding meaning makes the speaker unambiguous; reject only genuinely ambiguous or contradictory ownership.',
    'Do not put narration, actions, labels, written text, sound effects, ambience or internal thoughts inside quotation marks.',
    'Do not append a dialogue block. Integrate the quoted line into the chronological action.',
    missing,
    duplicate,
    order,
    speakerFailures,
    'REWRITE THE COMPLETE ltx_shot_description and return only that field.',
  ].filter(Boolean).join(' ');
}

function _dialogueIntegrity(sourceLines, description, dialogueBeats = [], visibleCharacters = []) {
  const required = (sourceLines || [])
    .map(_canonicalDialogueLine)
    .filter(Boolean);
  const output = _scanQuotedDialogue(description || '');

  const matchedRequired = [];
  const used = new Set();
  const missingLines = [];
  const outOfOrder = [];
  const duplicateLines = [];

  for (let r = 0; r < required.length; r++) {
    const line = required[r];
    let best = null;
    for (let i = 0; i < output.length; i++) {
      if (used.has(i)) continue;
      const sim = _semanticDialogueSimilarity(line, output[i].text);
      if (_isSemanticallySameDialogue(line, output[i].text) && (!best || sim > best.similarity)) {
        best = { outputIndex: i, similarity: sim, text: output[i].text };
      }
    }
    if (best) {
      used.add(best.outputIndex);
      matchedRequired.push({ source: line, output: best.text, outputIndex: best.outputIndex, similarity: best.similarity });
    } else {
      const anyIndex = output.findIndex(item => _isSemanticallySameDialogue(line, item.text));
      if (anyIndex >= 0) outOfOrder.push(line);
      else missingLines.push(line);
    }
  }

  /* Duplicate only when the same authored utterance has two or more distinct
   * semantic occurrences in the actual final spoken channel. */
  for (const line of required) {
    const occurrences = output.filter(item => _isSemanticallySameDialogue(line, item.text));
    if (occurrences.length > 1) duplicateLines.push(line);
  }

  let previous = -1;
  for (const match of matchedRequired) {
    if (match.outputIndex < previous) outOfOrder.push(match.source);
    previous = Math.max(previous, match.outputIndex);
  }

  const missing = _dedupePreserveOrder(missingLines);
  const order = _dedupePreserveOrder(outOfOrder);
  const duplicates = _dedupePreserveOrder(duplicateLines);

  /*
   * Speaker ownership is NOT adjudicated here.
   *
   * There must be one authoritative semantic speaker gate. The hard submission
   * audit above/before this recovery path calls _semanticSpeakerOwnershipAudit(),
   * which reads the complete cinematic description and judges each authoritative
   * turn by meaning, chronology, pronoun continuity, reactions, staging and voice
   * attribution.
   *
   * This integrity function therefore handles only deterministic speech-channel
   * integrity: exact authored-line preservation, ordering and duplicate control.
   * Keeping a second lexical speaker veto here would reintroduce the false
   * negatives that this semantic layer was specifically designed to remove.
   */
  return {
    outputLines: output.map(m => m.text),
    missingLines: missing,
    outOfOrder: order,
    duplicateLines: duplicates,
    speakerDiagnostics: [],
    speakerAttributionInvalid: [],
    speakerAttributionValid: true,
    authoredOutputPositions: matchedRequired.map(m => ({
      line: m.output,
      index: m.outputIndex,
      similarity: m.similarity,
      source: m.source,
    })),
    matchedLines: matchedRequired,
    valid: missing.length === 0 && order.length === 0 && duplicates.length === 0,
  };
}

/* Never let a malformed repair response terminate the pipeline merely because
 * it uses screenplay/meta prose inside the quoted repair text. The final shot
 * is accepted only when all authored beats are semantically recoverable. */
function _recoverDialogueIntegrity(sourceLines, description, dialogueBeats = [], visibleCharacters = []) {
  const cleaned = _sanitizeNonDialogueQuotes(description, sourceLines);
  const integrity = _dialogueIntegrity(sourceLines, cleaned, dialogueBeats, visibleCharacters);
  if (integrity.valid) return { accepted: true, description: cleaned, integrity };

  /* A common Mistral failure is a single quoted block containing all authored
   * lines embedded in stage directions. Split those authored utterances out of
   * the block, then re-check against atomic source beats. */
  const semanticHits = [];
  for (const line of sourceLines) {
    const occurrence = _bestSemanticDialogueOccurrence(cleaned, line, { quotedOnly: true });
    if (occurrence) semanticHits.push(occurrence);
  }
  if (semanticHits.length === sourceLines.length) {
    const rechecked = _dialogueIntegrity(sourceLines, cleaned, dialogueBeats, visibleCharacters);
    if (rechecked.missingLines.length === 0 && rechecked.outOfOrder.length === 0) {
      return { accepted: true, description: cleaned, integrity: rechecked };
    }
  }
  return { accepted: false, description: cleaned, integrity };
}

/* ============================================================================
 * TARGETED REPAIR
 * ========================================================================== */

function _buildTargetedRepairInstruction({
  previousDescription,
  missingLines,
  outOfOrder,
  duplicateLines,
}) {
  const missing =
    missingLines.length
      ? [
          'These authored lines are genuinely missing and must be integrated:',
          missingLines
            .map(
              line => `"${line}"`
            )
            .join(' '),
        ].join(' ')
      : '';

  const order =
    outOfOrder.length
      ? [
          'These authored lines are incorrectly ordered:',
          outOfOrder
            .map(
              line => `"${line}"`
            )
            .join(' '),
        ].join(' ')
      : '';

  const duplicates =
    duplicateLines.length
      ? [
          'These authored lines are duplicated and MUST occur only once:',
          duplicateLines
            .map(
              line => `"${line}"`
            )
            .join(' '),
        ].join(' ')
      : '';

  return [
    'TARGETED SEMANTIC DIALOGUE REPAIR ONLY.',

    'The previous cinematic description is the working draft.',
    'Preserve its visual staging, action, camera, lighting, environment, character identity, individual character motion and emotional progression.',
    'When repairing, do not collapse secondary/background characters back into static poses. Preserve or strengthen each visible character’s distinct motion beat.',
    'Preserve or strengthen explicit speaker identity, exact character frame positions, facing directions and silent-listener behavior. Repair any ambiguity that could cause multiple characters to lip-sync the same line.',

    `PREVIOUS DESCRIPTION: ${previousDescription}`,

    missing,
    order,
    duplicates,

    'CRITICAL DIALOGUE RULE: EACH AUTHORED DIALOGUE BEAT MUST APPEAR ONCE.',
    'Do NOT create a second copy of any authored line.',
    'Do NOT append an authored line after already preserving the same line elsewhere.',
    'Do NOT restate authored dialogue in narration.',
    'Do NOT paraphrase authored dialogue as a second spoken line.',
    'Do NOT create a duplicate conversational beat using the same words.',

    'Integrate each authored line into the existing action as one natural spoken event.',
    'If the previous description already contains an authored line correctly, KEEP THAT OCCURRENCE and repair only what is necessary around it.',
    'If a line is missing, place it naturally at the correct chronological point instead of appending a dialogue block at the end.',

    'Authored dialogue wording is immutable.',
    'Preserve exact wording and source order.',

    'Quotation marks are reserved exclusively for audible spoken dialogue.',
    'Never quote labels, signs, screens, written text, internal thoughts, actions, emotions, camera directions, ambience or sound effects.',

    'Return the COMPLETE ltx_shot_description as one coherent chronological cinematic description.',
    'Do not return a patch, explanation, diff, list or commentary.',
  ]
    .filter(Boolean)
    .join(' ');
}

/* ============================================================================
 * INITIAL USER PROMPT
 * ========================================================================== */

function _buildInitialUser({
  intent,
  scene,
  characterHints,
  visibleCharacterNames = [],
  repairInstruction,
  previousDescription,
  sourceLines,
  dialogueBeats = [],
  hasPreviousEndFrame = false,
}) {
  const hasConversation =
    Boolean(
      intent.dialogue ||
      intent.conversation_reason
    );

  const dialogueRequirement =
    hasConversation
      ? [
          'THIS IS A CONVERSATIONAL SHOT.',

          'The authored dialogue is a fixed dramatic beat.',
          'Each authored line must appear EXACTLY ONCE.',

          sourceLines.length
            ? [
                'AUTHORITATIVE SPOKEN LINES:',
                sourceLines
                  .map(
                    line => `"${line}"`
                  )
                  .join(' '),
              ].join(' ')
            : 'No exact authored lines were supplied.',

          'Integrate the supplied lines naturally into the action.',
          'Do not reproduce the same line twice.',
          'Do not first write the line as dialogue and then restate the same words in narration.',
          'Do not invent another spoken line that repeats or paraphrases an authored line.',
          'Do not create a separate dialogue list or dialogue block in addition to the cinematic action.',

          'Each authored line belongs to exactly ONE named speaker. Never let two characters share, echo, lip-sync, mouth, or visibly perform the same line.',
          'MULTI-SPEAKER SHOTS ARE VALID AND EXPECTED: when the authoritative speaker registry contains multiple speakers, keep all authored turns in the same shot unless the shot intent explicitly requires a cut. Preserve chronological turn-taking: speaker A performs line A, speaker B performs line B, speaker A may then perform line C, and so on.',
          'For every authored line, the sentence immediately containing the spoken quote MUST name the speaker explicitly and include that speaker’s frame position before the speaking verb. Never use only pronouns such as he, she, his voice, her voice, they, or the character for the active speaker.',
          'Describe the speaker’s exact screen position and orientation at the moment of speech (for example: left foreground, center-right midground, seated behind the table, three-quarter profile facing camera-left), plus the listener positions around them.',
          'Describe each visible character separately: identity, screen position, body orientation, head direction, eyeline, posture, and whether they are SPEAKING or LISTENING.',
          'Only the speaking character may have visible mouth movement or lip-sync during that line. All listeners must remain silent with mouths closed or naturally still, even when they face the camera.',
          'A character looking toward the camera is NOT automatically the speaker. Speaker identity is controlled by the authored speaker assignment, not by camera-facing orientation.',
          'Never write ambiguous phrases such as "they speak," "the characters speak," "both speak," "they exchange words," or "the two lip-sync." Replace them with one explicit speaker and explicit silent listener behavior.',
          'When multiple characters are visible, anchor them left/right/foreground/background relative to the frame so their identities cannot be swapped during generation.',

          'AUTHORITATIVE SPEAKER-BEAT REGISTRY:',
          _formatDialogueBeatRegistry(dialogueBeats, visibleCharacterNames),

          'Quotation marks may surround only audible speech.',
          'Do not quote written text, labels, screens, UI, names, captions, internal thoughts, actions, emotions, camera movement, atmosphere or sound effects.',
        ].join(' ')
      : [
          'No authored dialogue is supplied.',
          'Keep the shot visually expressive.',
          'Do not invent consequential dialogue.',
          'Quotation marks may only surround actual audible speech.',
        ].join(' ');

  return [
    'AUTHORITATIVE SHOT INTENT:',
    JSON.stringify(intent),

    'SCENE CONTEXT:',
    JSON.stringify({
      location:
        scene.location || '',

      lighting_design:
        scene.lighting_design || '',

      emotional_beat:
        scene.emotional_beat || '',
    }),

    'LOCKED CHARACTER HINTS — EXHAUSTIVE PER-CHARACTER MAP:',
    JSON.stringify(characterHints, null, 2),

    'CHARACTER-BY-CHARACTER PERFORMANCE MAP:',
    JSON.stringify({
      visible_characters: visibleCharacterNames,
      character_staging: intent.character_staging || [],
      character_positions: intent.character_positions || '',
      speakers_in_shot: intent.speakers_in_shot || [],
      rule: 'Describe every visible character separately. State identity, hair/face-defining traits, wardrobe, accessories, carried props, screen position, depth, facing, eyeline, posture, interaction, and whether that character is SPEAKING or LISTENING for each dialogue beat.'
    }, null, 2),

    'DIALOGUE REQUIREMENT:',
    dialogueRequirement,

    repairInstruction
      ? `REPAIR INSTRUCTION: ${repairInstruction}`
      : '',

    previousDescription
      ? [
          'PREVIOUS WORKING DESCRIPTION:',
          previousDescription,
          'Use this as the existing scene draft.',
          'Do not duplicate dialogue already present in it.',
        ].join(' ')
      : '',

    hasPreviousEndFrame
      ? 'VISUAL CONTINUITY INPUT: Two images are attached in order. IMAGE 1 is the exact terminal/end frame of the immediately preceding shot. IMAGE 2 is the exact authored still for the current shot and therefore the current shot opening state.'
      : 'VISUAL CONTINUITY INPUT: Only the current authored still is available. Treat it as the exact opening frame of this shot.',

    hasPreviousEndFrame
      ? 'Compare IMAGE 1 and IMAGE 2 semantically before writing the prompt. Identify the concrete visual state that changes between them — character positions, pose, gaze, hand/prop contact, wardrobe, lighting, environment, screen geography, camera composition, emotional state and spatial relationships — and describe a physically plausible causal transition from IMAGE 1 into IMAGE 2. Do not invent an unexplained teleport, cut, mirror, identity swap, wardrobe jump, prop jump or impossible movement.'
      : 'Use the current still to establish the opening composition and describe visible motion as changes from that exact state.',

    hasPreviousEndFrame
      ? 'The transition analysis is a continuity bridge, not a replacement for the current still. The generated prompt MUST make the current still the settled opening state of the new shot before the new shot action unfolds.'
      : 'The current still is the authoritative opening state of the shot.',

    'Write ONE complete natural chronological cinematic LTX image-to-video description that preserves this visual continuity and then carries the current shot through its terminal state.',

    'POSITION-FIRST HARD CONTRACT: the first paragraph is a visual identity and screen-geography map of the CURRENT AUTHORED IMAGE. It MUST begin exactly with "Opening frame:".',
    'In that first paragraph, enumerate EVERY visible character one by one before describing ANY motion, dialogue, camera movement, reaction, transition, sound, atmosphere or later action.',
    'For EVERY visible character in the opening map, state the exact character name, screen position (screen-left/screen-center/screen-right), depth (foreground/midground/background), visible crop/extent, body orientation, head direction, eyeline, posture, distinctive identity anchors, wardrobe and any prop contact visible in the current image.',
    'Do not introduce one character later after starting the action. The full visible-character roster MUST be established first so the video model can independently identify who is where.',
    'When a character is only partially visible, explicitly say so and state where that visible portion sits in frame, for example "Eleanor Voss is screen-left foreground, only her right shoulder and upper back visible".',
    'Use the CURRENT IMAGE 2 pixels as the authoritative source for positions. Do not borrow positions from IMAGE 1 when the current image differs.',
    'After the opening map is complete, continue in chronological order with the current-shot action and dialogue while preserving those locked screen positions unless an authored movement explicitly changes them.',

    'The authored dialogue must be embedded once into the unfolding action, not copied into a separate dialogue section.',

    'Describe only the observable change that the authored shot actually calls for: physical action, expression, gaze, gesture, posture, camera movement, environmental change, lighting, sound, spoken performance and terminal visual state as supported by the shot intent.',
    'AUTHORED-MOTION-ONLY RULE: do NOT manufacture a motion beat for every visible person. Animate only characters whose motion is explicitly authored, clearly implied by the dialogue/action, or minimally required for a natural response.',
    'SILENT LISTENER RULE: a listener may remain largely still. Add only a restrained reaction when the shot intent supports it. Do not invent breathing choreography, blinking patterns, eye darts, head turns, finger movement, clothing movement, prop interaction or background activity merely to create liveliness.',
    'BACKGROUND RESTRAINT: background people should remain stable unless their movement is narratively relevant or clearly visible in the authored still. Never turn every background person into an autonomous performer.',
    'MOTION VARIETY WITHOUT SYNCHRONY: when multiple characters do move, do not mirror, synchronize or duplicate the same gesture across them unless coordination is authored.',
    'IDENTITY PRESERVATION: character identity is continuous throughout the clip. Never swap, merge, clone, age, de-age, recolor, redesign, or morph a face, hair style, wardrobe, body proportions or carried prop.',
    'BODY-MECHANICS GUARDRAIL: preserve grounded weight, believable foot contact, stable joints and realistic body mechanics. No sliding feet, rubber limbs, puppet-like motion, mannequin movement, sudden pose snaps, teleportation or impossible hand/prop contact.',
    'For every dialogue beat, the sentence immediately containing the spoken quote MUST name the speaker explicitly and include that speaker’s frame position before the speaking verb. Use a structure such as: \"Javier Morales, screen-right background, speaks: \\\"Exact line.\\\"\". Never use his voice, her voice, he says, she says, they speak, or an unnamed voice for an authored line.',
    'When more than one character is visible, maintain persistent left/right/foreground/background identity throughout the description so LTX does not swap which character is speaking.',
    'Do not use vague dialogue staging such as "they face the camera and speak." State exactly which character speaks and that every other visible character remains silent.',

    'Do not summarize the shot.',
    'Do not output analysis, commentary, scene graphs, shot contracts, spatial maps, metadata, negative prompts or implementation instructions.',

    'FINAL QUOTE CONTRACT: quotation marks may surround only audible spoken dialogue.',
    'Never quote or speak descriptive action, sound, ambience, environment, screen text, labels, internal thoughts or camera instructions.',
    'If the source contains dialogue_or_action prose without explicit speech syntax, treat that prose as visual/action description and do not put it in the speech channel.',

    'Return JSON with exactly one field: ltx_shot_description.',
    'The ltx_shot_description value MUST be one string containing the complete cinematic description.',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ============================================================================
 * MODEL REQUEST
 * ========================================================================== */

async function _requestVision({
  key,
  model,
  system,
  userText,
  imageBuffer,
  imageMime,
  previousEndFrameBuffer = null,
  previousEndFrameMime = 'image/png',
  attemptLabel,
}) {
  const response =
    await axios.post(
      'https://api.mistral.ai/v1/chat/completions',
      {
        model,

        messages: [
          {
            role: 'system',
            content: system,
          },

          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: userText,
              },

              ...(previousEndFrameBuffer
                ? [
                    {
                      type: 'text',
                      text: 'IMAGE 1 — PREVIOUS SHOT TERMINAL / END FRAME. This is the exact visual endpoint of the immediately preceding shot.',
                    },
                    {
                      type: 'image_url',
                      image_url:
                        _imageDataUrl(
                          previousEndFrameBuffer,
                          previousEndFrameMime
                        ),
                    },
                  ]
                : []),

              {
                type: 'text',
                text: previousEndFrameBuffer
                  ? 'IMAGE 2 — CURRENT SHOT AUTHORED STILL / OPENING FRAME. This is the exact visual state at which the new shot begins after the continuity bridge.'
                  : 'CURRENT SHOT AUTHORED STILL / OPENING FRAME.',
              },

              {
                type: 'image_url',
                image_url:
                  _imageDataUrl(
                    imageBuffer,
                    imageMime
                  ),
              },
            ],
          },
        ],

        temperature: 0.25,

        response_format: {
          type: 'json_object',
        },
      },
      {
        headers: {
          Authorization:
            `Bearer ${key}`,

          'Content-Type':
            'application/json',
        },

        timeout:
          REQUEST_TIMEOUT_MS,
      }
    );

  const message =
    response?.data?.choices?.[0]?.message;

  const rawContent =
    message?.content;

  _safeLog(
    `[LTXVision] VISION RESPONSE ${attemptLabel}:`,
    rawContent
  );

  const parsed =
    _parseStructuredContent(
      rawContent
    );

  _safeLog(
    `[LTXVision] PARSED VISION OBJECT ${attemptLabel}:`,
    parsed
  );

  const description =
    _extractDescription(
      parsed
    );

  _safeLog(
    `[LTXVision] RAW SHOT DESCRIPTION ${attemptLabel}:`,
    description
  );

  return {
    description,
    rawContent,
    parsed,
    response,
  };
}

/* ============================================================================
 * INTENT NORMALIZATION
 * ========================================================================== */

function _buildIntent({
  shot,
  scene,
}) {
  return {
    shot_purpose:
      shot.shot_purpose ||
      shot.purpose ||
      '',

    shot_description:
      shot.shot_description ||
      shot.ltx_shot_description ||
      '',

    action_arc:
      shot.temporal_arc ||
      shot.action_arc ||
      shot.subject_motion ||
      '',

    end_state:
      shot.end_frame_state ||
      shot.end_frame_transition ||
      shot.next_shot_continuity ||
      '',

    camera:
      shot.camera_movement ||
      shot.camera_type ||
      shot.framing ||
      '',

    lighting:
      shot.lighting ||
      scene.lighting_design ||
      '',

    environment:
      shot.scene_environment ||
      scene.location ||
      scene.scene_environment ||
      '',

    dialogue:
      shot.dialogue_or_action ||
      shot.dialogue ||
      shot.conversation ||
      '',

    dialogue_source:
      shot.dialogue_or_action
        ? 'dialogue_or_action'
        : shot.dialogue
          ? 'dialogue'
          : shot.conversation
            ? 'conversation'
            : '',

    conversation_reason:
      shot.conversation_reason ||
      '',

    speaker:
      shot.speaker ||
      shot.speaker_name ||
      shot.speakerName ||
      '',

    dialogue_speaker:
      shot.dialogue_speaker ||
      shot.dialogueSpeaker ||
      '',

    characters_in_shot:
      Array.isArray(
        shot.characters_in_shot
      )
        ? shot.characters_in_shot
        : [],

    character_staging:
      Array.isArray(shot.character_staging)
        ? shot.character_staging
        : [],

    character_positions:
      shot.character_positions || '',

    speakers_in_shot:
      Array.isArray(shot.speakers_in_shot)
        ? shot.speakers_in_shot
        : [],

    conversation_plan:
      _isPlainObject(shot._conversation_plan)
        ? shot._conversation_plan
        : (_isPlainObject(shot.conversation_plan) ? shot.conversation_plan : null),

    conversation_speakers:
      Array.isArray(shot.conversation_speakers)
        ? shot.conversation_speakers
        : [],

    start_frame_state:
      shot.start_frame_state || '',

    end_frame_state:
      shot.end_frame_state || '',

    temporal_arc:
      shot.temporal_arc || '',

    subject_motion:
      shot.subject_motion || '',

    ambient_motion:
      shot.ambient_motion || '',

    pose_state:
      shot.pose_state || '',
  };
}

/* ============================================================================
 * MAIN GENERATOR
 * ========================================================================== */

async function describeForLTX({
  imageBuffer,
  imageMime = 'image/png',
  shot = {},
  scene = {},
  characters = [],
  model = DEFAULT_MODEL,
  repairInstruction = '',
}) {
  const keys = _keys();

  if (!keys.length) {
    const error = new Error(
      '[LTXVision] No Mistral keys configured'
    );

    error.code =
      'LTX_VISION_NO_MISTRAL_KEYS';

    throw error;
  }

  const intent =
    _buildIntent({
      shot,
      scene,
    });

  /*
   * Resolve the previous shot's actual terminal pixels. This happens inside
   * the Vision Director so the multimodal model sees the exact predecessor
   * image rather than a textual approximation of end_frame_state.
   */
  let previousEndFrameBuffer = null;
  let previousEndFrameMime = 'image/png';

  try {
    const previousEndFrame = await _resolvePreviousEndFrame({
      shot,
      explicitUrl: shot.visionPreviousEndFrameUrl || '',
    });

    if (previousEndFrame) {
      previousEndFrameBuffer = previousEndFrame.buffer;
      previousEndFrameMime = previousEndFrame.mime;
      console.log(
        `[LTXVision] Previous terminal frame loaded for ` +
        `S${shot.scene_number || '0'}/idx${shot.shot_index || '0'} ` +
        `(bytes=${previousEndFrameBuffer.length})`
      );
    } else if (shot.visionPreviousShot) {
      const wrapped = new Error(
        `[LTXVision] Previous shot exists for ` +
        `S${shot.scene_number || '0'}/idx${shot.shot_index || '0'} ` +
        `but its exact terminal frame could not be resolved.`
      );
      wrapped.code = 'LTX_VISION_PREVIOUS_END_FRAME_UNAVAILABLE';
      throw wrapped;
    }
  } catch (err) {
    /*
     * Do not silently substitute a different image. If a predecessor was
     * explicitly identified but its exact visual endpoint cannot be loaded,
     * fail closed for that continuity comparison.
     */
    if (shot.visionPreviousShot) {
      const wrapped = new Error(
        `[LTXVision] Previous shot end frame unavailable: ${err.message}`
      );
      wrapped.code = 'LTX_VISION_PREVIOUS_END_FRAME_UNAVAILABLE';
      wrapped.cause = err;
      throw wrapped;
    }
    console.warn(`[LTXVision] Previous terminal frame load skipped: ${err.message}`);
  }

  const hasPreviousEndFrame = Boolean(previousEndFrameBuffer);

  /*
   * Only send visual anchors for characters actually staged in the shot.
   */
  const characterHints =
    (characters || [])
      .filter(character => {
        const name = String(character.name || '').toLowerCase();
        return intent.characters_in_shot.some(requested =>
          String(_isPlainObject(requested)
            ? requested.name || requested.character || requested.character_name || ''
            : requested || ''
          ).toLowerCase() === name
        );
      })
      .map(character => {
        const staging = (intent.character_staging || []).find(item =>
          _isPlainObject(item) &&
          String(item.name || '').toLowerCase() === String(character.name || '').toLowerCase()
        ) || {};

        return {
          name: character.name,
          visual_anchor: character.visual_anchor || character.visual_profile || character.description || '',
          visual_profile: character.visual_profile || character.visual_anchor || character.description || '',
          appearance: character.appearance || character.physical_description || character.description || '',
          wardrobe: character.wardrobe || character.costume || character.clothing || '',
          signature_features: character.signature_features || character.distinguishing_features || '',
          carried_props: character.carried_props || character.props || '',
          voice_identity: character.voice_identity || character.voice_profile || '',
          shot_staging: staging,
        };
      });

  const visibleCharacterMap = new Map();
  for (const value of [
    ...(intent.characters_in_shot || []),
    ...(intent.speakers_in_shot || []),
    ...(intent.character_staging || []),
    ...(intent.conversation_speakers || []),
    ...(Array.isArray(intent.conversation_plan?.speakers) ? intent.conversation_plan.speakers : []),
    ...(Array.isArray(intent.conversation_plan?.turns)
      ? intent.conversation_plan.turns.map(turn => turn?.speaker || '')
      : []),
  ]) {
    const name = _cleanText(_isPlainObject(value)
      ? value.name || value.character || value.character_name || value.speaker || ''
      : value);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!visibleCharacterMap.has(key)) {
      visibleCharacterMap.set(key, name);
    }
  }
  const visibleCharacterNames = [...visibleCharacterMap.values()];


  /*
   * AUTHORITATIVE DIALOGUE REGISTRY.
   *
   * Created once.
   * Never modified by model output.
   */
  let dialogueBeats =
    _dialogueBeatRegistry(
      intent.dialogue,
      { mixedInput: intent.dialogue_source === 'dialogue_or_action' }
    );
  console.log(
    `[LTXVision] Visible character attribution set | ` +
    `S${shot.scene_number || '0'}/idx${shot.shot_index || '0'} ` +
    `count=${visibleCharacterNames.length} ` +
    `names=${visibleCharacterNames.join(', ')}`
  );


  // First resolve speakers deterministically from explicit source/context cues.
  // Only unresolved beats go through the constrained multimodal resolver.
  const deterministicSpeakerResolution = _applyDeterministicSpeakerResolution(
    dialogueBeats,
    { intent, characters }
  );
  dialogueBeats = deterministicSpeakerResolution.beats;

  if (deterministicSpeakerResolution.unresolved.length) {
    const speakerKeys = _keys();
    const resolverKey = speakerKeys[0];
    if (resolverKey) {
      try {
        dialogueBeats = await _resolveSpeakersWithVision({
          dialogueBeats,
          candidates: deterministicSpeakerResolution.candidates,
          intent,
          characterHints,
          imageBuffer,
          imageMime,
          previousEndFrameBuffer,
          previousEndFrameMime,
          model,
          key: resolverKey,
        });
      } catch (err) {
        console.warn(
          `[LTXVision] constrained speaker resolution failed: ${err.message}`
        );
      }
    }
  }

  // Use the exact same resolved beat registry for authored lines.
  const sourceLines =
    _dedupePreserveOrder(
      dialogueBeats
        .map(beat => _canonicalDialogueLine(beat.line))
        .filter(Boolean)
    );

  _safeLog(
    '[LTXVision] AUTHORITATIVE DIALOGUE LINES:',
    sourceLines
  );

  _safeLog(
    '[LTXVision] AUTHORITATIVE SPEAKER BEATS:',
    dialogueBeats
  );

  const unnamedSpeakerBeats = dialogueBeats.filter(beat => !beat.speaker);
  if (unnamedSpeakerBeats.length && dialogueBeats.length) {
    const error = new Error(
      '[LTXVision] Authoritative dialogue could not be deterministically assigned to a named staged character.'
    );
    error.code = 'LTX_VISION_UNNAMED_SPEAKER_BEATS';
    error.beats = unnamedSpeakerBeats;
    error.candidates = deterministicSpeakerResolution.candidates;
    throw error;
  }

  /*
   * Global system contract.
   */
  const system = [
    'You are the visual director for a feature-film-quality LTX-2.3 image-to-video shot.',

    'The current authored still is the exact opening frame of the current shot.',
    'Inspect the actual pixels of every supplied image and treat them as visual ground truth.',
    'When a previous end frame is supplied, IMAGE 1 is the immediately preceding shot terminal state and IMAGE 2 is the current shot opening state. They are separate continuity anchors, not interchangeable references.',

    'Write ONE complete natural chronological cinematic description of the shot unfolding in real time.',
    'Do not summarize the shot.',

    'NON-NEGOTIABLE OUTPUT ORDER: FIRST establish the CURRENT IMAGE visually, THEN describe motion.',
    'The output MUST begin exactly with "Opening frame:".',
    'The FIRST PARAGRAPH is a complete visible-character identity and screen-geography map of the CURRENT AUTHORED IMAGE.',
    'Before any action, dialogue, camera movement, transition, atmosphere or reaction, enumerate EVERY visible character separately with exact name + screen-left/screen-center/screen-right position + foreground/midground/background depth + visible crop/extent + body orientation + head direction + eyeline + posture + identity/wardrobe anchors + prop contact.',
    'Do not start the narrative with one character and introduce the other visible characters later. No character may first appear after the opening map.',
    'If only part of a person is visible, explicitly identify the visible portion and its screen position instead of treating the person as an unnamed shoulder, silhouette or generic figure.',
    'Use CURRENT IMAGE 2 as the authoritative source for this opening map whenever a previous end frame is also supplied. IMAGE 1 is continuity context only.',
    'After the complete opening map, continue with the natural chronological cinematic description while preserving the established screen geography unless authored motion explicitly changes it.',

    'Use the current authored still to establish the exact opening composition.',
    'When a previous end frame is supplied, first reason about the visual delta from the previous terminal frame to the current authored still and make that transition physically and cinematographically coherent before describing the current-shot motion.',
    'Treat the previous end frame as the continuity predecessor, not as the current shot opening image.',
    'The final prompt must preserve the current authored still as the settled opening state of the new shot. Do not replace the authored still with the previous frame or blend the two into one impossible composition.',

    'Cover character identity and staging, physical action, reactions, camera movement, environmental change, lighting evolution, sound or ambience when supported, vocal performance and the terminal visual state.',
    'EXHAUSTIVE CHARACTER DESCRIPTION RULE: for every visible character, separately state identity-defining face/hair traits, wardrobe and dressing, accessories, carried/touched props, screen position, depth, body orientation, head direction, eyeline, posture and interaction. Never merge two visible people into one generic subject description.',
    'The locked character profile and shot-specific staging are authoritative. Do not invent alternate wardrobe, accessories, hair, physical traits or props.',

    'MULTI-CHARACTER CONTROL: inspect the actual pixels and identify visible humans, but only animate those with authored or clearly supported motion. Do not infer a requirement to animate every visible person.',
    'For each character who is actually moving, state the exact authored action and keep all other characters stable or minimally reactive.',
    'NO ARTIFICIAL-LIVENESS RULE: never add motion solely because a person is visible. A still listener, seated extra or background person can remain nearly unchanged for the full clip when that is the natural state.',
    'SECONDARY CHARACTER RESTRAINT: if a secondary character reacts, keep it small, non-synchronized and directly motivated by the current dramatic beat.',
    'CHARACTER-COUNT CHECK: account for every visible person so identities remain separate, but do not manufacture motion for omitted or background people.',
    'CONTINUITY OF MOTION: when a previous end frame is supplied, preserve only physically necessary changes between IMAGE 1 and IMAGE 2 and then apply the authored current-shot motion. Do not invent additional transitions.',

    'CHARACTER STAGING IS AUTHORITATIVE: for every visible character, state their stable frame position (left/center/right; foreground/midground/background), body orientation, head direction and eyeline. Do not leave character positions ambiguous when more than one person is present.',
    'SPEAKER IDENTITY IS AUTHORITATIVE: every authored spoken line must be assigned to exactly one character. Identify that character by name and physical position in the frame at the moment the line is spoken.',
    'If an authored dialogue input contains multiple labelled utterances in one prose string, split them into separate speaker beats before directing the shot. Never treat the entire paragraph as one speaker or one dialogue line.',
    'NEVER leave an authored speaker unnamed when a speaker label is present in the source dialogue. The authoritative speaker registry is the source of truth.',
    'NON-SPEAKER LOCK: every character who is not the current speaker is silent during that line. Their mouth stays closed or naturally still; no lip-sync, no speaking animation, no synchronized mouth movement, no accidental dialogue performance.',
    'CAMERA-FACING DOES NOT MEAN SPEAKING: a listener may face the camera, but must still remain silent unless they are the explicitly assigned speaker for that exact line.',
    'For conversational shots, write the staging so an animator can distinguish each person without relying on vague pronouns such as "they," "them," "both," or "the pair."',

    'AUTHORED DIALOGUE IS A SINGLE-USE DRAMATIC RESOURCE.',
    'Every authored dialogue beat must appear once. Preserve the authored wording whenever possible; validation recognizes semantically equivalent quoted delivery when punctuation, contractions, or minor natural-language formatting differs.',
    'Never repeat an authored line unless the validator is only observing a formatting artifact; formatting-only duplication is not a semantic failure.',
    'Never paraphrase an authored line into a second spoken line.',
    'Never restate an authored line in narration after speaking it.',
    'Never create a second conversational beat containing the same authored words.',

    'Integrate each authored line naturally into the chronological action.',
    'The authored line should be performed once by its intended speaker with the surrounding expression, gesture, gaze, breathing and listener reaction carrying the drama.',

    'If the working description already contains an authored line, preserve that occurrence rather than generating another copy.',

    'Quotation marks are exclusively the spoken-dialogue channel.',
    'Use quotation marks only for audible speech.',


    'DIALOGUE CHANNEL HARD LOCK: Only text that is actual audible speech may ever be enclosed in quotation marks.',
    'Never turn physical action, blocking, facial expression, emotion, camera direction, environment, ambience, sound design, radio noise, captions, written words or internal thoughts into spoken words.',
    'The field named dialogue_or_action is mixed input: treat unquoted action/narration in that field as DESCRIPTION, not speech. Only explicit quoted utterances or explicit speaker-labelled lines from that field are spoken dialogue.',
    'When describing anything that is not spoken, use descriptive declarative prose with NO quotation marks.',
    'Do not place quotation marks around descriptive fragments merely to emphasize them.',

    'Never quote signs, labels, screen text, UI, names, written notes, captions, logos, internal thoughts, memories, actions, emotions, camera behavior, staging, ambience or sound effects.',

    'Do not use Markdown emphasis around speech.',

    'Do not invent characters, props, locations, wardrobe changes or consequential events absent from the supplied image, scene context or shot intent.',

    'Do not output analysis, commentary, shot contracts, spatial maps, metadata, negative prompts or implementation instructions.',

    'Return JSON with exactly one field: ltx_shot_description.',
    'ltx_shot_description MUST be one string.',
    'Never return a nested scene graph, array, outline or timeline.',
  ].join(' ');

  let currentRepairInstruction =
    repairInstruction || '';

  let previousDescription = '';
  let lastError = null;

  for (
    let keyIndex = 0;
    keyIndex < keys.length;
    keyIndex++
  ) {
    const key =
      keys[keyIndex];

    try {
      console.log(
        `[LTXVision] request keyIndex=${keyIndex + 1}/${keys.length} ` +
        `model=${model}` +
        ` visualAnchors=${hasPreviousEndFrame ? 'previous_end_frame+current_still' : 'current_still'}` +
        `${
          currentRepairInstruction
            ? ' mode=targeted-repair'
            : ' mode=initial'
        }`
      );

      for (
        let repairAttempt = 0;
        repairAttempt <=
        MAX_TARGETED_REPAIRS_PER_KEY;
        repairAttempt++
      ) {
        const userText =
          _buildInitialUser({
            intent,
            scene,
            characterHints,
            visibleCharacterNames,
            repairInstruction:
              currentRepairInstruction,
            previousDescription,
            sourceLines,
            dialogueBeats,
            hasPreviousEndFrame,
          });

        let vision;

        try {
          vision =
            await _requestVision({
              key,
              model,
              system,
              userText,
              imageBuffer,
              imageMime,
              previousEndFrameBuffer,
              previousEndFrameMime,
              attemptLabel:
                `keyIndex=${keyIndex + 1}/${keys.length} ` +
                `repairAttempt=${repairAttempt}/${MAX_TARGETED_REPAIRS_PER_KEY}`,
            });
        } catch (err) {
          const status =
            Number(
              err?.response?.status || 0
            );

          lastError = err;

          console.warn(
            `[LTXVision] request keyIndex=${keyIndex + 1}/${keys.length} ` +
            `repairAttempt=${repairAttempt}/${MAX_TARGETED_REPAIRS_PER_KEY} ` +
            `failed status=${status || 'n/a'} ` +
            `code=${err.code || 'n/a'} ` +
            `detail=${err?.response?.data?.message || err.message}`
          );

          throw err;
        }

        let description =
          vision.description;

        _safeLog(
          '[LTXVision] MODEL DESCRIPTION BEFORE DIALOGUE NORMALIZATION:',
          description
        );

        /*
         * Step 1:
         * Restore quote boundaries where the model preserved the exact
         * authored words but forgot the quotation marks.
         */
        const enforcement =
          _enforceAuthoredDialogueQuotes(
            description,
            sourceLines
          );

        description =
          enforcement.description;

        /*
         * Step 2:
         * Remove exact duplicate authored speech.
         *
         * This is the important new layer.
         *
         * The model can still accidentally produce:
         *
         *   "Hello."
         *   ...
         *   "Hello."
         *
         * We retain the first natural occurrence and remove the duplicate.
         */
        const dedupe =
          _removeDuplicateAuthoredDialogue(
            description,
            sourceLines
          );

        description =
          dedupe.description;

        /*
         * Step 3:
         * Re-run quote enforcement after duplicate removal.
         *
         * This ensures the first surviving authored occurrence remains properly
         * quoted if the generated response used an unusual formatting pattern.
         */
        const postDedupeEnforcement =
          _enforceAuthoredDialogueQuotes(
            description,
            sourceLines
          );

        description =
          postDedupeEnforcement.description;

        if (sourceLines.length) {
          console.log(
            `[LTXVision] Authored dialogue normalization ` +
            `required=${sourceLines.length} ` +
            `restored=${enforcement.restored.length} ` +
            `duplicatesRemoved=${dedupe.removed.length} ` +
            `stillMissing=${postDedupeEnforcement.missing.length} ` +
            `outputQuotes=${_quotedDialogue(description).length}`
          );

          if (
            dedupe.removed.length
          ) {
            console.warn(
              `[LTXVision] duplicate authored dialogue removed: ` +
              `${dedupe.removed.map(
                line => `"${line}"`
              ).join('; ')}`
            );
          }
        }

        description = _bindAuthoredDialogueSpeakers(
          description,
          dialogueBeats,
          visibleCharacterNames
        );

        const hardDialogueAudit = await _hardDialogueSubmissionAudit(
          description,
          sourceLines,
          dialogueBeats,
          visibleCharacterNames,
          model
        );

        _safeLog(
          '[LTXVision] HARD DIALOGUE SUBMISSION AUDIT:',
          hardDialogueAudit
        );
        _safeLog(
          '[LTXVision] SEMANTIC SPEAKER OWNERSHIP:',
          {
            valid: hardDialogueAudit.valid,
            failures: hardDialogueAudit.speakerFailures,
          }
        );

        if (!hardDialogueAudit.valid) {
          const hardRepairInstruction = _buildHardDialogueRepairInstruction(
            hardDialogueAudit
          );

          previousDescription = description;
          currentRepairInstruction = [
            currentRepairInstruction,
            hardRepairInstruction,
          ].filter(Boolean).join(' ');

          console.warn(
            '[LTXVision] HARD dialogue submission gate failed | ' +
            `missingQuoted=${hardDialogueAudit.missingQuoted.length} ` +
            `duplicateQuoted=${hardDialogueAudit.duplicateQuoted.length} ` +
            `speakerFailures=${hardDialogueAudit.speakerFailures.length}`
          );

          if (repairAttempt < MAX_TARGETED_REPAIRS_PER_KEY) {
            continue;
          }

          const hardError = new Error(
            '[LTXVision] HARD_DIALOGUE_SUBMISSION_GATE_FAILED: generated LTX prompt did not contain every authoritative dialogue line as a properly quoted, explicitly speaker-bound utterance.'
          );
          hardError.code = 'LTX_HARD_DIALOGUE_SUBMISSION_GATE';
          hardError.audit = hardDialogueAudit;
          hardError.previousDescription = description;
          throw hardError;
        }

        _safeLog(
          '[LTXVision] FINAL CANDIDATE AFTER DIALOGUE NORMALIZATION:',
          description
        );

        const positionDiagnostics =
          _positionFirstDiagnostics(
            description,
            visibleCharacterNames
          );

        _safeLog(
          '[LTXVision] POSITION-FIRST DIAGNOSTICS:',
          positionDiagnostics
        );

        if (!positionDiagnostics.valid) {
          const positionRetryInstruction =
            _positionFirstRepairInstruction(
              positionDiagnostics
            );

          previousDescription = description;
          currentRepairInstruction = [
            currentRepairInstruction,
            positionRetryInstruction,
          ].filter(Boolean).join(' ');

          console.warn(
            '[LTXVision] position-first contract failed | ' +
            `missingCharacters=${positionDiagnostics.missingFromOpening.length} ` +
            `missingPositionAnchors=${positionDiagnostics.missingPositionAnchors.length} ` +
            `startsWithMap=${positionDiagnostics.startsWithMap}`
          );

          if (repairAttempt < MAX_TARGETED_REPAIRS_PER_KEY) {
            continue;
          }

          const error = new Error(
            '[LTXVision] POSITION_FIRST_CONTRACT_FAILED: generated shot did not establish all visible characters and their screen positions before motion.'
          );
          error.code = 'LTX_VISION_POSITION_FIRST_CONTRACT';
          error.diagnostics = positionDiagnostics;
          throw error;
        }

        /*
         * Final deterministic integrity check.
         *
         * Speaker ownership has already been decided by the semantic hard
         * dialogue audit above. Do not run a second lexical speaker veto here.
         */
        const recovery =
          _recoverDialogueIntegrity(
            sourceLines,
            description,
            dialogueBeats,
            visibleCharacterNames
          );

        description = recovery.description;
        const integrity = recovery.integrity;

        if (
          recovery.accepted || integrity.valid
        ) {
          console.log(
            `[LTXVision] completed ` +
            `keyIndex=${keyIndex + 1} ` +
            `repairAttempt=${repairAttempt} ` +
            `quotedSpeech=${integrity.outputLines.length} ` +
            `conversation=${Boolean(
              intent.dialogue ||
              intent.conversation_reason
            )} ` +
            `preserved=${sourceLines.length}/${sourceLines.length} ` +
            `duplicates=0`
          );

          return description;
        }

        previousDescription =
          description;

        const missingText =
          integrity.missingLines.length
            ? integrity.missingLines
                .map(
                  line => `"${line}"`
                )
                .join('; ')
            : 'none';

        const orderText =
          integrity.outOfOrder.length
            ? integrity.outOfOrder
                .map(
                  line => `"${line}"`
                )
                .join('; ')
            : 'none';

        const duplicateText =
          integrity.duplicateLines.length
            ? integrity.duplicateLines
                .map(
                  line => `"${line}"`
                )
                .join('; ')
            : 'none';

        const semanticError =
          new Error(
            '[LTXVision] Authored dialogue integrity failed: ' +
            `missing=${missingText} ` +
            `outOfOrder=${orderText} ` +
            `duplicates=${duplicateText}`
          );

        semanticError.code =
          'LTX_AUTHORED_DIALOGUE_INTEGRITY';

        semanticError.missingLines =
          integrity.missingLines;

        semanticError.outOfOrder =
          integrity.outOfOrder;

        semanticError.duplicateLines =
          integrity.duplicateLines;

        semanticError.previousDescription =
          previousDescription;

        /*
         * If deterministic duplicate removal should already have solved the
         * problem, this branch is normally reached only for genuine semantic
         * ordering or missing-content failures.
         */
        if (
          repairAttempt >=
          MAX_TARGETED_REPAIRS_PER_KEY
        ) {
          /* Fail closed only for genuine missing/order failures. A duplicate
           * diagnostic by itself must never kill an otherwise complete shot: we
           * deterministically retain the earliest occurrence and continue. */
          const semanticallyComplete =
            integrity.missingLines.length === 0 &&
            integrity.outOfOrder.length === 0;

          if (semanticallyComplete) {
            const cleaned = _sanitizeNonDialogueQuotes(description, sourceLines);
            const finalIntegrity = _dialogueIntegrity(sourceLines, cleaned, dialogueBeats, visibleCharacterNames);
            if (finalIntegrity.missingLines.length === 0 && finalIntegrity.outOfOrder.length === 0) {
              console.warn('[LTXVision] duplicate-only validation warning recovered; accepting semantic-complete shot');
              return cleaned;
            }
          }

          lastError = semanticError;
          console.warn(
            `[LTXVision] targeted repair exhausted ` +
            `keyIndex=${keyIndex + 1}/${keys.length} ` +
            `missing=${missingText} ` +
            `outOfOrder=${orderText} ` +
            `duplicates=${duplicateText}`
          );
          break;
        }

        currentRepairInstruction =
          _buildTargetedRepairInstruction({
            previousDescription,
            missingLines:
              integrity.missingLines,
            outOfOrder:
              integrity.outOfOrder,
            duplicateLines:
              integrity.duplicateLines,
          });

        console.warn(
          `[LTXVision] authored dialogue integrity failed; ` +
          `targeted semantic repair ` +
          `attempt=${repairAttempt + 1}/${MAX_TARGETED_REPAIRS_PER_KEY} ` +
          `missing=${missingText} ` +
          `outOfOrder=${orderText} ` +
          `duplicates=${duplicateText}`
        );
      }
    } catch (err) {
      lastError = err;

      const status =
        Number(
          err?.response?.status || 0
        );

      console.warn(
        `[LTXVision] attempt keyIndex=${keyIndex + 1}/${keys.length} failed ` +
        `status=${status || 'n/a'} ` +
        `code=${err.code || 'n/a'} ` +
        `detail=${err?.response?.data?.message || err.message}`
      );

      if (
        err?.code ===
        'LTX_AUTHORED_DIALOGUE_INTEGRITY'
      ) {
        throw err;
      }

      if (
        err?.code ===
        'LTX_HARD_DIALOGUE_SUBMISSION_GATE'
      ) {
        throw err;
      }

      if (
        err?.code ===
        'LTX_VISION_INVALID_STRUCTURED_OUTPUT'
      ) {
        throw err;
      }

      if (
        err?.code ===
        'LTX_VISION_EMPTY_IMAGE'
      ) {
        throw err;
      }

      if (
        [400, 401, 403].includes(
          status
        )
      ) {
        throw err;
      }

      /*
       * Only transient provider/network failures rotate keys.
       */
      currentRepairInstruction =
        repairInstruction || '';

      previousDescription = '';
    }
  }

  throw (
    lastError ||
    new Error(
      '[LTXVision] Vision description generation failed'
    )
  );
}

/* ============================================================================
 * EXPORT
 * ========================================================================== */

module.exports = {
  describeForLTX,
  authorStillPrompt,
  auditGeneratedStillContinuity,

  // Regression-testable dialogue validation helpers.
  _normalizeDialogueForMatch,
  _semanticDialogueSimilarity,
  _isSemanticallySameDialogue,
  _bestSemanticDialogueOccurrence,
  _findDialogueOccurrence,
  _dialogueIntegrity,
  _hardDialogueSubmissionAudit,
  _buildHardDialogueRepairInstruction,
  _dialogueBeatRegistry,
  _speakerAttributionDiagnostics,
  _speakerAttributionRepairInstruction,
  _formatDialogueBeatRegistry,
  _extractAtomicQuotedBeats,
  _normalizeAuthoredDialogueInput,
  _looksLikeCinematicNarration,
  _collectSpeakerCandidates,
  _applyDeterministicSpeakerResolution,
  _sanitizeNonDialogueQuotes,
  _recoverDialogueIntegrity,
  _positionFirstDiagnostics,
  _positionFirstRepairInstruction,
  _bindAuthoredDialogueSpeakers,
  _extractSpeakerPosition,
};
