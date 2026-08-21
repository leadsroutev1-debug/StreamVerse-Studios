'use strict';

const axios = require('axios');
const config = require('./config');

const DEFAULT_MODEL = process.env.LTX_VISION_MODEL || 'mistral-large-2512';
const MAX_TARGETED_REPAIRS_PER_KEY = 2;

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

function _dialogueIntegrity(sourceLines, description) {
  const required = sourceLines.map(_normalizeDialogue);
  const outputLines = _quotedDialogue(description);
  const output = outputLines.map(_normalizeDialogue);
  const missingLines = required.filter(line => !output.includes(line));

  // Verify the authored lines occur in their original order. Presence by itself
  // would permit Mistral to reorder turns, which changes the dramatic event.
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

function _repairToken(error) {
  return {
    semantic: true,
    message: error?.message || String(error || ''),
  };
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
    'Do not alter, paraphrase, translate, shorten, sanitize, reorder, or replace any authored dialogue line.',
    'Do not invent a new plot event, character, prop, location, wardrobe change, or consequential story fact.',
    'Return the COMPLETE ltx_shot_description as one coherent chronological cinematic description, not a patch, explanation, diff, or commentary.',
    'Every required authored line must appear verbatim inside quotation marks in the original source order.',
  ].filter(Boolean).join(' ');
}

function _buildInitialUser({ intent, scene, characterHints, repairInstruction, previousDescription, sourceLines }) {
  const dialogueRequirement = intent.dialogue || intent.conversation_reason
    ? [
        'THIS IS A CONVERSATIONAL SHOT.',
        'Treat authored dialogue as immutable source material, not optional inspiration.',
        'When exact lines exist, reproduce EVERY exact line verbatim inside quotation marks and in source order.',
        sourceLines.length
          ? `REQUIRED LINES: ${sourceLines.map(line => `"${line}"`).join(' ')}`
          : 'No exact lines were supplied; create only the natural exchange required by the stated conversational beat.',
        'Identify the speaker, place the speaker physically in the scene, describe delivery, and describe listener reactions around each line in chronological order.',
        'The description is invalid if any required authored line is missing, altered, or reordered.',
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
    'Inspect the attached final still and write ONE complete natural chronological cinematic LTX description from the established first frame through the terminal state. Favor concrete observable action and real-time progression. Return only the finished ltx_shot_description JSON object.',
  ].filter(Boolean).join('\n');
}

async function _requestVision({ key, model, system, userText, imageBuffer, imageMime }) {
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

  const raw = response?.data?.choices?.[0]?.message?.content;
  const parsed = _parseContent(raw);
  const description = _cleanText(
    parsed?.ltx_shot_description || parsed?.description || raw
  );

  if (!description) {
    throw new Error('[LTXVision] Vision model returned an empty LTX description');
  }

  return description;
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
    characters_in_shot: Array.isArray(shot.characters_in_shot) ? shot.characters_in_shot : [],
  };

  const characterHints = (characters || [])
    .filter(c => intent.characters_in_shot.some(
      name => String(name).toLowerCase() === String(c.name || '').toLowerCase()
    ))
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
    'Whenever dialogue is present, write the literal spoken words in quotation marks, identify the speaker, place the speaker in the physical scene, describe delivery, and describe listener response or the next conversational beat in chronological order.',
    'Exact authored dialogue is immutable source material. Preserve every exact line verbatim and in the same order. Do not paraphrase, shorten, translate, sanitize, reorder, replace, or omit it.',
    'Use dialogue as visible performance: facial reactions, breathing, gesture, gaze, pauses, interruptions and posture changes should occur around the spoken words in real time.',
    'Do not replace dialogue with abstractions such as "they speak", "she talks", "he responds", "their voices overlap", or "the conversation continues".',
    'Do not invent characters, props, locations, wardrobe changes, or consequential events absent from the supplied image, scene context, or shot intent.',
    'Do not output analysis, labels, shot contracts, spatial maps, metadata, prompt instructions, negative prompts, implementation language, or editing commands.',
    'Return JSON with exactly one field: ltx_shot_description.',
    'The field value must be the actual finished cinematic description that can be sent directly to LTX.',
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

      // One provider request can produce the first description followed by a
      // bounded number of targeted semantic repairs. Semantic mismatch does NOT
      // advance keyIndex because the key is healthy and the request succeeded.
      for (let repairAttempt = 0; repairAttempt <= MAX_TARGETED_REPAIRS_PER_KEY; repairAttempt++) {
        const userText = _buildInitialUser({
          intent,
          scene,
          characterHints,
          repairInstruction: currentRepairInstruction,
          previousDescription,
          sourceLines,
        });

        let description;
        try {
          description = await _requestVision({
            key,
            model,
            system,
            userText,
            imageBuffer,
            imageMime,
          });
        } catch (err) {
          const status = Number(err?.response?.status || 0);
          lastError = err;

          console.warn(
            `[LTXVision] request keyIndex=${keyIndex + 1}/${keys.length} ` +
            `repairAttempt=${repairAttempt}/${MAX_TARGETED_REPAIRS_PER_KEY} failed ` +
            `status=${status || 'n/a'} detail=${err?.response?.data?.message || err.message}`
          );

          // Provider/auth errors belong to the key-rotation layer. Semantic
          // validation errors are handled below without rotating keys.
          if ([400, 401, 403].includes(status)) throw err;
          throw err;
        }

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
        `status=${status || 'n/a'} detail=${err?.response?.data?.message || err.message}`
      );

      // Auth/provider failures can justify trying another configured key.
      // Semantic dialogue failure after targeted repair does not: rotating the
      // key does not change the model behavior and wastes quota unnecessarily.
      if (err?.code === 'LTX_AUTHORED_DIALOGUE_INTEGRITY') {
        throw err;
      }

      if ([400, 401, 403].includes(status)) throw err;

      // Transient/provider failures can advance to another configured key.
      // Reset semantic repair state so the new key gets a clean initial pass.
      currentRepairInstruction = repairInstruction || '';
      previousDescription = '';
    }
  }

  throw lastError || new Error('[LTXVision] Vision description generation failed');
}

module.exports = { describeForLTX };
