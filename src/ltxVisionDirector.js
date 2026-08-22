'use strict';

const axios = require('axios');
const config = require('./config');

const DEFAULT_MODEL = process.env.LTX_VISION_MODEL || 'mistral-large-2512';
const MAX_TARGETED_REPAIRS_PER_KEY = 2;

function _keys() {
  if (Array.isArray(config.mistralKeys) && config.mistralKeys.length) {
    return config.mistralKeys;
  }
  if (process.env.MISTRAL_KEYS) {
    return process.env.MISTRAL_KEYS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (process.env.MISTRAL_API_KEY) {
    return [process.env.MISTRAL_API_KEY];
  }
  return [];
}

function _imageDataUrl(buffer, mime = 'image/png') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('[LTXVision] Empty image buffer');
  }
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function _cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function _parseStructuredContent(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return content;
  }

  const text = String(content || '').trim();
  if (!text) {
    throw new Error('[LTXVision] Vision model returned empty message.content');
  }

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON root is not an object');
    }
    return parsed;
  } catch (err) {
    const parseError = new Error(
      `[LTXVision] Vision model returned non-JSON structured content: ${err.message}`
    );
    parseError.code = 'LTX_VISION_INVALID_STRUCTURED_OUTPUT';
    parseError.rawContent = text;
    throw parseError;
  }
}

function _isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function _sentence(value) {
  const text = _cleanText(value);
  if (!text) return '';
  return /[.!?]["”']?$/.test(text) ? text : `${text}.`;
}

function _flattenValue(value) {
  if (value == null) return '';

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
      .map(([key, child]) => _flattenField(key, child))
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function _flattenDialogueNode(node) {
  if (!_isPlainObject(node)) return _flattenValue(node);

  const speaker = _cleanText(node.speaker || '');
  const spokenWords = _cleanText(
    node.spoken_words ||
    node.spokenWords ||
    node.dialogue ||
    node.line ||
    ''
  );
  const delivery = _cleanText(node.delivery || '');
  const placement = _cleanText(node.placement || '');
  const listenerReaction =
    node.listener_reaction ||
    node.listenerReaction ||
    '';

  const parts = [];

  if (spokenWords) {
    const cleanWords = spokenWords.replace(/^["“]|["”]$/g, '').trim();
    if (speaker) {
      parts.push(
        `${speaker}${placement ? ` ${_sentence(placement)}` : ''} ` +
        `${_sentence(delivery || 'speaks')} ` +
        `"${cleanWords}"`
      );
    } else {
      parts.push(`"${cleanWords}"`);
    }
  }

  if (listenerReaction) {
    parts.push(`The listener reacts: ${_flattenValue(listenerReaction)}`);
  }

  const handled = new Set([
    'speaker',
    'spoken_words',
    'spokenWords',
    'dialogue',
    'line',
    'delivery',
    'placement',
    'listener_reaction',
    'listenerReaction',
  ]);

  for (const [key, value] of Object.entries(node)) {
    if (handled.has(key)) continue;
    const rendered = _flattenField(key, value);
    if (rendered) parts.push(rendered);
  }

  return parts.join(' ');
}

function _flattenField(key, value) {
  const normalizedKey = String(key || '');
  const lowerKey = normalizedKey.toLowerCase();

  if (value == null) return '';

  if (
    lowerKey === 'dialogue_initiation' ||
    lowerKey === 'dialogue' ||
    lowerKey === 'spoken_dialogue' ||
    lowerKey === 'conversation'
  ) {
    if (_isPlainObject(value)) return _flattenDialogueNode(value);
    if (Array.isArray(value)) {
      return value.map(_flattenDialogueNode).filter(Boolean).join(' ');
    }
    return _sentence(value);
  }

  if (
    lowerKey === 'action_sequence' ||
    lowerKey === 'actions'
  ) {
    if (Array.isArray(value)) {
      return value.map(item => {
        if (_isPlainObject(item) && item.moment) {
          const duration = item.duration ? ` It lasts ${item.duration}.` : '';
          return `${_sentence(item.moment)}${duration}`;
        }
        return _flattenValue(item);
      }).filter(Boolean).join(' ');
    }
  }

  if (lowerKey === 'action_progression') {
    if (_isPlainObject(value)) {
      return Object.entries(value)
        .map(([childKey, childValue]) => _flattenField(childKey, childValue))
        .filter(Boolean)
        .join(' ');
    }
  }

  if (lowerKey === 'opening_state' || lowerKey === 'initial_state') {
    return `At the beginning, ${_flattenValue(value)}`;
  }

  if (lowerKey === 'terminal_state' || lowerKey === 'final_state') {
    return `By the end of the shot, ${_flattenValue(value)}`;
  }

  if (lowerKey === 'camera_movement' || lowerKey === 'camera') {
    return `The camera ${_flattenValue(value)}`;
  }

  if (lowerKey === 'lighting_evolution') {
    return `The lighting changes as follows: ${_flattenValue(value)}`;
  }

  if (lowerKey === 'sound' || lowerKey === 'ambience' || lowerKey === 'atmosphere') {
    return `The sound and atmosphere are ${_flattenValue(value)}`;
  }

  if (_isPlainObject(value)) {
    return Object.entries(value)
      .map(([childKey, childValue]) => _flattenField(childKey, childValue))
      .filter(Boolean)
      .join(' ');
  }

  if (Array.isArray(value)) {
    return value.map(_flattenValue).filter(Boolean).join(' ');
  }

  return _sentence(value);
}

function _serializeStructuredShot(value) {
  if (typeof value === 'string') {
    const description = _cleanText(value);
    if (!description) {
      throw new Error('[LTXVision] ltx_shot_description string was empty');
    }
    return description;
  }

  if (!_isPlainObject(value)) {
    const error = new Error(
      '[LTXVision] ltx_shot_description must be a string or structured object'
    );
    error.code = 'LTX_VISION_INVALID_STRUCTURED_OUTPUT';
    throw error;
  }

  // Preserve the model's chronological section order when present.
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
    if (!Object.prototype.hasOwnProperty.call(value, section)) continue;
    const rendered = _flattenField(section, value[section]);
    if (rendered) parts.push(rendered);
    consumed.add(section);
  }

  for (const [key, child] of Object.entries(value)) {
    if (consumed.has(key)) continue;
    const rendered = _flattenField(key, child);
    if (rendered) parts.push(rendered);
  }

  const description = _cleanText(parts.join(' '));

  if (!description) {
    const error = new Error(
      '[LTXVision] Structured ltx_shot_description could not be serialized'
    );
    error.code = 'LTX_VISION_INVALID_STRUCTURED_OUTPUT';
    error.structuredResponse = value;
    throw error;
  }

  return description;
}

function _extractDescription(parsed, sourceLines = []) {
  if (!Object.prototype.hasOwnProperty.call(parsed || {}, 'ltx_shot_description')) {
    const error = new Error(
      '[LTXVision] Vision model returned structured JSON without ltx_shot_description'
    );
    error.code = 'LTX_VISION_INVALID_STRUCTURED_OUTPUT';
    error.structuredResponse = parsed;
    throw error;
  }

  const serialized = _serializeStructuredShot(parsed.ltx_shot_description);
  return _sanitizeDialogueQuotes(serialized, sourceLines);
}

function _quotedDialogue(text) {
  return [...String(text || '').matchAll(/"([^"]+)"|“([^”]+)”/g)]
    .map(match => (match[1] || match[2] || '').trim())
    .filter(Boolean);
}

function _normalizeDialogue(text) {
  return String(text || '')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}


function _quoteNormalize(value) {
  return String(value || '')
    .replace(/[“”]/g, '"')
    .replace(/\\(["“”])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * LTX quote-channel hardening.
 *
 * Quotation marks are reserved exclusively for words that are actually spoken
 * aloud. LTX can interpret quoted material as vocalized speech, so visible
 * labels ("ON AIR", "LINE 1"), written text, internal thoughts, actions,
 * emotions, camera directions, sound effects and other non-speech material
 * must never remain quoted.
 *
 * Authored dialogue is protected exactly. Newly generated dialogue is retained
 * in quotes only when the surrounding sentence clearly marks it as spoken.
 */
function _sanitizeDialogueQuotes(description, requiredSourceLines = []) {
  const input = String(description || '');
  if (!input) return input;

  const protectedLines = new Map();
  for (const line of requiredSourceLines) {
    const normalized = _quoteNormalize(line);
    if (normalized) protectedLines.set(normalized, line.trim());
  }

  const speechCue = /\b(?:says?|said|saying|speaks?|spoke|speaking|whisper(?:s|ed|ing)?|murmur(?:s|ed|ing)?|mutters?|utters?|answers?|answered|answers|replies?|replied|responds?|responded|asks?|asked|shouts?|shouted|yells?|yelled|calls?|called|exclaims?|exclaimed|cries?|cried|declares?|declared|warns?|warned|orders?|ordered|tells?|told|voice|voices|caller|caller's|over the line|through the microphone|into the microphone|on the phone|over the radio|over the headset)\b/i;

  const nonSpeechCue = /\b(?:internal voice|inner voice|thought|thinks?|thoughts?|written|text|label|sign|display|screen|monitor|caption|title|nameplate|badge|logo|watermark|on air|line \d+|radio text|console text|printed|reads? the words?|visible words?|the word|the words|the letters|sound effect|sfx|onomatopoeia|stage direction)\b/i;

  let quoteIndex = 0;
  const placeholders = new Map();

  // First protect required authored dialogue exactly, regardless of model typography.
  let working = input;
  for (const [normalized, authored] of protectedLines.entries()) {
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const curlyEscaped = escaped.replace(/"/g, '[\"“”]');
    const re = new RegExp(`[\"“”]${curlyEscaped}[\"“”]`, 'g');
    working = working.replace(re, () => {
      const token = `@@SV_SPOKEN_${quoteIndex++}@@`;
      placeholders.set(token, `"${authored}"`);
      return token;
    });
  }

  // Process all remaining quoted spans.
  working = working.replace(/"([^"]+)"|“([^”]+)”/g, (full, straight, curly, offset, whole) => {
    const inner = _quoteNormalize(straight || curly || '');
    if (!inner) return '';

    const alreadyProtected = placeholders.get(full);
    if (alreadyProtected) return full;

    const before = whole.slice(Math.max(0, Number(offset) - 180), Number(offset));
    const speech = speechCue.test(before) && !nonSpeechCue.test(before);

    if (speech) {
      const token = `@@SV_SPOKEN_${quoteIndex++}@@`;
      placeholders.set(token, `"${inner}"`);
      return token;
    }

    // Not spoken aloud: remove quotation marks entirely.
    return inner;
  });

  // Also remove markdown emphasis that can surround spoken dialogue in model output.
  working = working.replace(/\\\*([^*]+)\\\*/g, '$1');

  for (const [token, quoted] of placeholders.entries()) {
    working = working.split(token).join(quoted);
  }

  return _cleanText(working);
}

function _dialogueIntegrity(sourceLines, description) {
  const required = sourceLines.map(_normalizeDialogue);
  const outputLines = _quotedDialogue(description);
  const output = outputLines.map(_normalizeDialogue);
  const missingLines = required.filter(line => !output.includes(line));

  let cursor = 0;
  const outOfOrder = [];

  for (const line of required) {
    const index = output.indexOf(line, cursor);
    if (index === -1) continue;
    if (index !== cursor) outOfOrder.push(line);
    cursor = index + 1;
  }

  return {
    outputLines,
    missingLines,
    outOfOrder,
    valid: missingLines.length === 0 && outOfOrder.length === 0,
  };
}

function _safeLog(label, value) {
  console.log(label);
  try {
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } catch (_) {
    console.log(String(value));
  }
}

function _buildTargetedRepairInstruction({
  previousDescription,
  missingLines,
  outOfOrder,
}) {
  const missing = missingLines.length
    ? `Restore these exact missing line(s) verbatim: ${missingLines.map(line => `"${line}"`).join(' ')}`
    : 'No authored line is missing; correct the dialogue order without changing the authored wording.';

  const order = outOfOrder.length
    ? `These authored lines were detected out of order and must be restored to source order: ${outOfOrder.map(line => `"${line}"`).join(' ')}`
    : '';

  return [
    'TARGETED DIALOGUE REPAIR ONLY.',
    'The previous cinematic description is structurally useful and must be preserved wherever possible.',
    `PREVIOUS DESCRIPTION: ${previousDescription}`,
    missing,
    order,
    'Do not rewrite the shot from scratch unless necessary to make the exact dialogue occur naturally.',
    'Keep the established opening composition, character identity, staging, physical action, camera movement, environment, lighting progression, emotional beat, and ending state intact.',
    'Do not alter, paraphrase, translate, shorten, sanitize, reorder, replace, or omit any authored spoken dialogue line.',
    'Quotation marks are reserved EXCLUSIVELY for words actually spoken aloud. Remove quotation marks from every non-speech element.',
    'Never quote visible labels, signs, written text, console text, screen text, titles, names, internal thoughts, actions, emotions, camera directions, ambience, or sound effects.',
    'Do not invent a new plot event, character, prop, location, wardrobe change, or consequential story fact.',
    'Return the COMPLETE ltx_shot_description as one coherent chronological cinematic description, not a patch, explanation, diff, or commentary.',
    'Every required authored spoken line must appear verbatim inside quotation marks in the original source order.',
  ].filter(Boolean).join(' ');
}

function _buildInitialUser({
  intent,
  scene,
  characterHints,
  repairInstruction,
  previousDescription,
  sourceLines,
}) {
  const dialogueRequirement = intent.dialogue || intent.conversation_reason
    ? [
        'THIS IS A CONVERSATIONAL SHOT.',
        'Treat authored dialogue as immutable source material, not optional inspiration.',
        'When exact lines exist, reproduce EVERY exact spoken line verbatim inside quotation marks and in source order.',
        sourceLines.length
          ? `REQUIRED SPOKEN LINES: ${sourceLines.map(line => `"${line}"`).join(' ')}`
          : 'No exact lines were supplied; create only the natural exchange required by the stated conversational beat.',
        'Identify the speaker, place the speaker physically in the scene, describe delivery, and describe listener reactions around each spoken line in chronological order.',
        'QUOTATION SAFETY: every quotation mark in the final description must correspond to audible speech. Never quote labels, signs, UI text, written words, internal thoughts, actions, emotions, camera directions, ambience, or sound effects.',
        'The description is invalid if any required authored spoken line is missing, altered, or reordered, or if non-speech material is presented as quoted dialogue.',
      ].join(' ')
    : 'No dialogue intent is supplied. Keep the shot visually expressive and do not invent consequential dialogue.';

  return [
    'AUTHORITATIVE SHOT INTENT:',
    JSON.stringify(intent),
    'SCENE CONTEXT:',
    JSON.stringify({
      location: scene.location || '',
      lighting_design: scene.lighting_design || '',
      emotional_beat: scene.emotional_beat || '',
    }),
    'LOCKED CHARACTER HINTS:',
    JSON.stringify(characterHints),
    'DIALOGUE REQUIREMENT:',
    dialogueRequirement,
    repairInstruction ? `REPAIR INSTRUCTION: ${repairInstruction}` : '',
    previousDescription ? `PREVIOUS DESCRIPTION TO PRESERVE: ${previousDescription}` : '',
    'Inspect the attached final still and write ONE complete natural chronological cinematic LTX description from the established first frame through the terminal state. Favor concrete observable action and real-time progression.',
    'FINAL QUOTE CONTRACT: only audible spoken dialogue may contain quotation marks. Everything else must be unquoted plain prose.',
    'Return only the finished ltx_shot_description JSON object.',
  ].filter(Boolean).join('\n');
}

async function _requestVision({
  key,
  model,
  system,
  userText,
  imageBuffer,
  imageMime,
  attemptLabel,
  requiredDialogueLines = [],
}) {
  const response = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: _imageDataUrl(imageBuffer, imageMime) },
          ],
        },
      ],
      temperature: 0.55,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      timeout: 180000,
    }
  );

  const message = response?.data?.choices?.[0]?.message;
  const rawContent = message?.content;

  _safeLog(
    `[LTXVision] VISION RESPONSE ${attemptLabel}:`,
    rawContent
  );

  const parsed = _parseStructuredContent(rawContent);

  _safeLog(
    `[LTXVision] PARSED VISION OBJECT ${attemptLabel}:`,
    parsed
  );

  const description = _extractDescription(parsed, requiredDialogueLines);

  _safeLog(
    `[LTXVision] SHOT DESCRIPTION ${attemptLabel}:`,
    description
  );

  return {
    description,
    rawContent,
    parsed,
    response,
  };
}

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
    throw new Error('[LTXVision] No Mistral keys configured');
  }

  const intent = {
    shot_purpose: shot.shot_purpose || shot.purpose || '',
    shot_description: shot.shot_description || shot.ltx_shot_description || '',
    action_arc: shot.temporal_arc || shot.action_arc || shot.subject_motion || '',
    end_state: shot.end_frame_state || shot.end_frame_transition || shot.next_shot_continuity || '',
    camera: shot.camera_movement || shot.camera_type || shot.framing || '',
    lighting: shot.lighting || scene.lighting_design || '',
    environment: shot.scene_environment || scene.location || scene.scene_environment || '',
    dialogue: shot.dialogue_or_action || shot.dialogue || shot.conversation || '',
    conversation_reason: shot.conversation_reason || '',
    characters_in_shot: Array.isArray(shot.characters_in_shot)
      ? shot.characters_in_shot
      : [],
  };

  const characterHints = (characters || [])
    .filter(c =>
      intent.characters_in_shot.some(
        name => String(name).toLowerCase() === String(c.name || '').toLowerCase()
      )
    )
    .map(c => ({
      name: c.name,
      visual_anchor: c.visual_anchor || c.description || '',
    }));

  const system = [
    'You are the visual director for a feature-film-quality LTX-2.3 image-to-video shot.',
    'The supplied image is the exact first frame. Inspect the actual pixels and treat them as the visual ground truth.',
    'The authored shot intent is the narrative target: preserve what the shot is supposed to accomplish while respecting what is visibly present in the image.',
    'Write ONE complete, natural, chronological cinematic description of the shot unfolding in real time.',
    'Do not summarize the shot. Stage it as something the viewer experiences from the opening frame through the final state.',
    'Cover visible character identity and staging, physical action and reactions, camera movement, environmental change, lighting evolution, ambience or music when supported, dialogue or vocal performance, and the terminal visual state.',
    'Use the image to establish the opening composition. Describe motion as changes from that established image rather than pretending the starting frame is unknown.',
    'Dialogue is a first-class dramatic event whenever the authored intent contains dialogue or conversational purpose.',
    'QUOTATION-MARK RULE: quotation marks are an exclusive spoken-dialogue channel. LTX may interpret quoted text as words to vocalize, so quotation marks are forbidden around anything that is not actually spoken aloud.',
    'Use quotation marks ONLY around exact words that a character, caller, voice, or other audible speaker actually speaks aloud.',
    'NEVER quote visible text, signs, labels, screens, console markings, titles, names, logos, written notes, captions, sound effects, actions, emotions, camera behavior, staging, internal thoughts, memories, or narrative descriptions.',
    'Do NOT use Markdown emphasis such as *...* around dialogue or any other text.',
    'Internal monologue and unspoken thoughts must be described as internal/mental voice in plain unquoted prose; they are not spoken dialogue.',
    'Exact authored dialogue is immutable source material. Preserve every exact line verbatim and in the same order. Do not paraphrase, shorten, translate, sanitize, reorder, replace, or omit it.',
    'Use dialogue as visible performance: facial reactions, breathing, gesture, gaze, pauses, interruptions and posture changes should occur around the spoken words in real time.',
    'Do not replace dialogue with abstractions such as "they speak", "she talks", "he responds", "their voices overlap", or "the conversation continues".',
    'Do not invent characters, props, locations, wardrobe changes, or consequential events absent from the supplied image, scene context, or shot intent.',
    'Do not output analysis, labels, shot contracts, spatial maps, metadata, prompt instructions, negative prompts, implementation language, or editing commands.',
    'Return JSON with exactly one field: ltx_shot_description.',
    'The value of ltx_shot_description MUST be a STRING containing one complete chronological cinematic description.',
    'Never return an object, array, scene graph, nested timeline, or structured outline inside ltx_shot_description.',
    'The string must be directly usable by the LTX image-to-video prompt pipeline.',
  ].join(' ');

  const sourceLines = _quotedDialogue(intent.dialogue || '');
  let currentRepairInstruction = repairInstruction || '';
  let previousDescription = '';
  let lastError = null;

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const key = keys[keyIndex];

    try {
      console.log(
        `[LTXVision] request keyIndex=${keyIndex + 1}/${keys.length} model=${model}` +
        `${currentRepairInstruction ? ' mode=targeted-repair' : ' mode=initial'}`
      );

      for (
        let repairAttempt = 0;
        repairAttempt <= MAX_TARGETED_REPAIRS_PER_KEY;
        repairAttempt++
      ) {
        const userText = _buildInitialUser({
          intent,
          scene,
          characterHints,
          repairInstruction: currentRepairInstruction,
          previousDescription,
          sourceLines,
        });

        let vision;
        try {
          vision = await _requestVision({
            key,
            model,
            system,
            userText,
            imageBuffer,
            imageMime,
            requiredDialogueLines: sourceLines,
            attemptLabel:
              `keyIndex=${keyIndex + 1}/${keys.length} ` +
              `repairAttempt=${repairAttempt}/${MAX_TARGETED_REPAIRS_PER_KEY}`,
          });
        } catch (err) {
          const status = Number(err?.response?.status || 0);
          lastError = err;

          console.warn(
            `[LTXVision] request keyIndex=${keyIndex + 1}/${keys.length} ` +
            `repairAttempt=${repairAttempt}/${MAX_TARGETED_REPAIRS_PER_KEY} failed ` +
            `status=${status || 'n/a'} ` +
            `code=${err.code || 'n/a'} ` +
            `detail=${err?.response?.data?.message || err.message}`
          );

          throw err;
        }

        const description = vision.description;
        const integrity = _dialogueIntegrity(sourceLines, description);

        if (integrity.valid) {
          console.log(
            `[LTXVision] completed keyIndex=${keyIndex + 1} ` +
            `repairAttempt=${repairAttempt} ` +
            `quotedSpeech=${integrity.outputLines.length} ` +
            `conversation=${Boolean(intent.dialogue || intent.conversation_reason)} ` +
            `preserved=${sourceLines.length}/${sourceLines.length}`
          );

          return description;
        }

        previousDescription = description;

        const missingText = integrity.missingLines.length
          ? integrity.missingLines.map(line => `"${line}"`).join('; ')
          : 'none';
        const orderText = integrity.outOfOrder.length
          ? integrity.outOfOrder.map(line => `"${line}"`).join('; ')
          : 'none';

        const semanticError = new Error(
          `[LTXVision] Required authored dialogue missing or altered: ${missingText}. ` +
          `outOfOrder=${orderText}`
        );
        semanticError.code = 'LTX_AUTHORED_DIALOGUE_INTEGRITY';
        semanticError.missingLines = integrity.missingLines;
        semanticError.outOfOrder = integrity.outOfOrder;
        semanticError.previousDescription = previousDescription;

        if (repairAttempt >= MAX_TARGETED_REPAIRS_PER_KEY) {
          lastError = semanticError;
          console.warn(
            `[LTXVision] targeted repair exhausted keyIndex=${keyIndex + 1}/${keys.length} ` +
            `missing=${missingText} outOfOrder=${orderText}`
          );
          break;
        }

        currentRepairInstruction = _buildTargetedRepairInstruction({
          previousDescription,
          missingLines: integrity.missingLines,
          outOfOrder: integrity.outOfOrder,
        });

        console.warn(
          `[LTXVision] authored dialogue integrity failed; targeted repair ` +
          `attempt=${repairAttempt + 1}/${MAX_TARGETED_REPAIRS_PER_KEY} ` +
          `missing=${missingText} outOfOrder=${orderText}`
        );
      }
    } catch (err) {
      lastError = err;

      const status = Number(err?.response?.status || 0);
      console.warn(
        `[LTXVision] attempt keyIndex=${keyIndex + 1}/${keys.length} failed ` +
        `status=${status || 'n/a'} code=${err.code || 'n/a'} ` +
        `detail=${err?.response?.data?.message || err.message}`
      );

      // A semantic dialogue failure must never rotate keys. All repair attempts
      // for the current healthy key are exhausted before the error propagates.
      if (err?.code === 'LTX_AUTHORED_DIALOGUE_INTEGRITY') {
        throw err;
      }

      // Malformed/wrong-schema model output is also a model-output failure, not
      // evidence that the configured key is bad. Propagate it rather than
      // pretending the next key will fix a deterministic response-contract bug.
      if (err?.code === 'LTX_VISION_INVALID_STRUCTURED_OUTPUT') {
        throw err;
      }

      if ([400, 401, 403].includes(status)) {
        throw err;
      }

      // Only genuine transient/provider failures advance to another key.
      currentRepairInstruction = repairInstruction || '';
      previousDescription = '';
    }
  }

  throw lastError || new Error('[LTXVision] Vision description generation failed');
}

module.exports = { describeForLTX };
