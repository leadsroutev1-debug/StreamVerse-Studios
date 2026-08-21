'use strict';

const axios = require('axios');
const config = require('./config');

const DEFAULT_MODEL = process.env.LTX_VISION_MODEL || 'mistral-large-2512';

function _keys() {
  if (Array.isArray(config.mistralKeys) && config.mistralKeys.length) return config.mistralKeys;
  if (process.env.MISTRAL_KEYS) {
    return process.env.MISTRAL_KEYS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (process.env.MISTRAL_API_KEY) return [process.env.MISTRAL_API_KEY];
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

function _parseContent(content) {
  if (typeof content === 'object' && content !== null) return content;
  const text = String(content || '').trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { ltx_shot_description: text };
  }
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

function _buildVisionRepairInstruction({
  description,
  intent,
  sourceLines,
  repairInstruction,
}) {
  const authoredDialogue = sourceLines.length
    ? `Preserve these exact authored lines verbatim and in order: ${sourceLines.map(line => `"${line}"`).join(' ')}`
    : 'No authored dialogue lines were supplied; do not invent consequential plot facts.';

  return [
    'Previous LTX description:',
    description || '(none)',
    '',
    'Correction required:',
    repairInstruction || 'The previous description did not fully realize the supplied shot intent.',
    '',
    'Rewrite the complete description from the image and intent.',
    authoredDialogue,
    'Keep the supplied visual identity, staging, action, camera, environment and ending state coherent.',
    'Return only the finished ltx_shot_description JSON object.',
    '',
    `AUTHORITATIVE INTENT: ${JSON.stringify(intent)}`,
  ].join('\n');
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
  if (!keys.length) throw new Error('[LTXVision] No Mistral keys configured');

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
    'Cover every element that matters to the shot: visible character identity and staging, physical action and reactions, camera movement, environmental change, lighting evolution, ambience or music when supported, dialogue or vocal performance, and the terminal visual state.',
    'Use the image to establish the opening composition. Describe motion as changes from that established image rather than pretending the starting frame is unknown.',
    'Dialogue is a first-class dramatic event whenever the authored intent contains dialogue or conversational purpose.',
    'Whenever dialogue is present, write the literal spoken words in quotation marks, identify the speaker, place the speaker in the physical scene, describe the delivery, and describe the listener response or next conversational beat in chronological order.',
    'If exact dialogue lines are supplied, preserve them verbatim and in the same order. Do not paraphrase, shorten, translate, sanitize, reorder, or replace them.',
    'If conversational intent is supplied without exact dialogue, write a natural short exchange that serves only the stated dramatic beat and does not invent new consequential plot facts.',
    'Use dialogue as visible performance: facial reactions, breathing, gesture, gaze, pauses, interruptions and posture changes should occur around the spoken words in real time.',
    'Do not replace dialogue with abstractions such as "they speak", "she talks", "he responds", "their voices overlap", or "the conversation continues".',
    'Do not invent characters, props, locations, wardrobe changes, or consequential events absent from the supplied image, scene context, or shot intent.',
    'Do not output analysis, labels, shot contracts, spatial maps, metadata, prompt instructions, negative prompts, implementation language, or editing commands.',
    'Return JSON with exactly one field: ltx_shot_description.',
    'The final value must be the actual finished cinematic description that can be sent directly to LTX.',
  ].join(' ');

  const sourceLines = _quotedDialogue(intent.dialogue || '');
  let activeRepairInstruction = repairInstruction || '';
  let previousDescription = '';

  const buildUser = (extraRepair = '') => [
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
    intent.dialogue || intent.conversation_reason
      ? [
          'THIS IS A CONVERSATIONAL SHOT. SPOKEN WORDS ARE MANDATORY WHEN AUTHORED DIALOGUE IS PRESENT.',
          'Treat authored dialogue as immutable source material, not optional inspiration.',
          'Reproduce every supplied exact dialogue line verbatim inside quotation marks.',
          'Do not summarize, paraphrase, shorten, replace, sanitize, or omit any supplied line.',
          sourceLines.length
            ? `REQUIRED LINES — EACH ONE MUST APPEAR VERBATIM IN THE FINAL OUTPUT: ${sourceLines.map(line => `"${line}"`).join(' ')}`
            : 'No exact lines were supplied; create only the natural exchange required by the supplied conversational beat.',
          'Place each spoken line at the moment it is performed, identify the speaker, and describe the listener reaction and next turn around it.',
          'The final LTX description is incomplete if any required authored line is absent.',
        ].join(' ')
      : 'No dialogue intent is supplied. Keep the shot visually expressive and do not invent consequential dialogue.',
    extraRepair ? `REPAIR INSTRUCTION: ${extraRepair}` : '',
    previousDescription ? `PREVIOUS ATTEMPT TO PRESERVE: ${previousDescription}` : '',
    'Now inspect the attached final still and write the complete cinematic LTX image-to-video description. Favor concrete, observable detail and a clear beginning-to-end progression. Do not return a terse label or summary.',
  ].filter(Boolean).join('\n');

  const buildRepairInstruction = (missingLines) => {
    if (!missingLines.length) return activeRepairInstruction || '';
    return [
      'The previous response omitted authored dialogue that is mandatory for this shot.',
      `Restore these exact missing line(s) verbatim: ${missingLines.map(line => `"${line}"`).join(' ')}`,
      'Keep the existing visual action, staging, camera, environment and ending state unless changing them is necessary to naturally place the dialogue.',
      'Return the COMPLETE rewritten ltx_shot_description, not a patch, summary, explanation, or abbreviated replacement.',
      'Do not drop any previously supplied dialogue line while fixing the missing ones.',
    ].join(' ');
  };

  const makeContent = () => [
    { type: 'text', text: buildUser(activeRepairInstruction || '') },
    { type: 'image_url', image_url: _imageDataUrl(imageBuffer, imageMime) },
  ];

  let lastError = null;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];

    try {
      console.log(
        `[LTXVision] request keyIndex=${i + 1}/${keys.length} model=${model}` +
        `${repairInstruction ? ' repair=true' : ''}`
      );

      const response = await axios.post(
        'https://api.mistral.ai/v1/chat/completions',
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: makeContent() },
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

      const raw = response?.data?.choices?.[0]?.message?.content;
      const parsed = _parseContent(raw);
      const description = _cleanText(
        parsed?.ltx_shot_description || parsed?.description || raw
      );

      if (!description) {
        throw new Error('[LTXVision] Vision model returned an empty LTX description');
      }

      const outputLines = _quotedDialogue(description);
      const normalizedOutput = outputLines.map(_normalizeDialogue);
      const missing = sourceLines
        .map(_normalizeDialogue)
        .filter(line => !normalizedOutput.includes(line));

      if (missing.length) {
        previousDescription = description;
        activeRepairInstruction = buildRepairInstruction(missing);
        throw new Error(
          `[LTXVision] Required authored dialogue missing or altered: ` +
          `${missing.map(line => `"${line}"`).join('; ')}`
        );
      }

      console.log(
        `[LTXVision] completed quotedSpeech=${outputLines.length} ` +
        `conversation=${Boolean(intent.dialogue || intent.conversation_reason)} ` +
        `preserved=${sourceLines.length - missing.length}/${sourceLines.length}`
      );

      return description;
    } catch (err) {
      lastError = err;

      const status = Number(err?.response?.status || 0);
      console.warn(
        `[LTXVision] attempt ${i + 1}/${keys.length} failed ` +
        `status=${status || 'n/a'} detail=${err?.response?.data?.message || err.message}`
      );

      if ([400, 401, 403].includes(status)) throw err;
    }
  }

  throw lastError || new Error('[LTXVision] Vision description generation failed');
}

module.exports = { describeForLTX };
