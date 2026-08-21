'use strict';

const axios = require('axios');
const config = require('./config');

const DEFAULT_MODEL = process.env.LTX_VISION_MODEL || 'mistral-large-2512';

function _keys() {
  if (Array.isArray(config.mistralKeys) && config.mistralKeys.length) return config.mistralKeys;
  if (process.env.MISTRAL_KEYS) return process.env.MISTRAL_KEYS.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.MISTRAL_API_KEY) return [process.env.MISTRAL_API_KEY];
  return [];
}

function _imageDataUrl(buffer, mime = 'image/png') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('[LTXVision] Empty image buffer');
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
  try { return JSON.parse(text); } catch (_) { return { ltx_shot_description: text }; }
}

function _quotedDialogue(text) {
  return [...String(text || '').matchAll(/"([^"]+)"|“([^”]+)”/g)]
    .map(match => (match[1] || match[2] || '').trim())
    .filter(Boolean);
}

function _normalizeDialogue(text) {
  return String(text || '').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

async function describeForLTX({ imageBuffer, imageMime = 'image/png', shot = {}, scene = {}, characters = [], model = DEFAULT_MODEL, repairInstruction = '' }) {
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
    .filter(c => intent.characters_in_shot.some(name => String(name).toLowerCase() === String(c.name || '').toLowerCase()))
    .map(c => ({ name: c.name, visual_anchor: c.visual_anchor || c.description || '' }));

  const system = [
    'You are the visual director for a feature-film-quality LTX-2.3 image-to-video shot.',
    'The supplied image is the exact first frame. Inspect the actual pixels before writing the description and use the image as the visual ground truth.',
    'Use the authored shot intent as the narrative target. The intent is authoritative for what must happen; the image is authoritative for who and what is visibly present and where they are positioned.',
    'Treat every named character as a distinct identity. State who is visible, their exact screen position, depth, orientation, eyeline, posture, wardrobe, expression, and relationship to the other characters before describing movement.',
    'Write one rich, continuous, chronological, ultra-cinematic description in real time. Do not summarize. Describe the shot unfolding second by second: opening state, first action, response, escalation, camera behavior, environmental evolution, lighting changes, and ending state.',
    'THIS IS A CONVERSATIONAL MOVIE. Dialogue is a first-class visual event. Whenever dialogue, conversation_reason, quoted speech, or speaking intent is present, the final prompt MUST contain actual spoken words, not a summary of speech.',
    'Never replace dialogue with "they speak", "she talks", "he responds", "their voices overlap", "the conversation continues", "he says something", or similar abstractions. Every audible line must identify the speaker by name or unmistakable role and include the literal spoken words in quotation marks.',
    'Preserve every supplied exact dialogue line verbatim. Do not paraphrase, shorten, translate, sanitize, reorder, or replace supplied dialogue. If a conversational intent is supplied without exact words, creatively write a short, natural, context-appropriate exchange that advances only the supplied beat and does not invent new plot facts.',
    'For each conversational turn, explicitly describe speaker position, delivery, exact words, listener reaction, pause or interruption, and the next speaker. Make the turn-taking chronological and physically grounded in the frame.',
    'Use dialogue as physical action: facial reactions, breathing, gestures, eyeline changes, posture shifts, pauses, interruptions and emotional responses must occur around the words in real time.',
    'Include camera movement, environmental evolution, lighting changes, ambience, music or sound effects when supported by the intent, but never let them replace the human dramatic action or dialogue.',
    'Be creatively descriptive and cinematic while staying faithful to the supplied image and intent. Expand sparse intent into a vivid scene rather than compressing it into a summary.',
    'Do not invent characters, props, locations, or consequential story events unrelated to the supplied image or shot intent. Creative expansion should clarify performance, timing and cinematic movement.',
    'Do not output analysis, labels, shot contracts, spatial maps, metadata, prompt instructions, negative prompts or implementation language.',
    'Return JSON with exactly one field named ltx_shot_description containing the complete final LTX prompt.',
  ].join(' ');

  const sourceLines = _quotedDialogue(intent.dialogue || '');
  const repairText = repairInstruction ? `REPAIR WARNING FROM THE LTX BOUNDARY: ${repairInstruction} You MUST repair the previous omission and preserve every required dialogue line exactly.` : '';

  const user = [
    'AUTHORITATIVE SHOT INTENT:',
    JSON.stringify(intent),
    'SCENE CONTEXT:',
    JSON.stringify({ location: scene.location || '', lighting_design: scene.lighting_design || '', emotional_beat: scene.emotional_beat || '' }),
    'LOCKED CHARACTER HINTS:',
    JSON.stringify(characterHints),
    'DIALOGUE REQUIREMENT:',
    intent.dialogue || intent.conversation_reason
      ? `This is a conversational shot. Audible speech is mandatory. Preserve supplied lines exactly when present; otherwise create a concise, natural exchange from the supplied beat. Identify every speaker, exact spoken words, delivery, listener reaction, and turn order. Required exact lines: ${sourceLines.map(line => `"${line}"`).join(' ')}`
      : 'No dialogue intent is supplied. Keep the shot visually expressive and do not invent consequential story dialogue.',
    repairText,
    'Inspect the attached final still and author the complete cinematic LTX image-to-video description.',
  ].filter(Boolean).join('\n');

  const content = [
    { type: 'text', text: user },
    { type: 'image_url', image_url: _imageDataUrl(imageBuffer, imageMime) },
  ];

  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      console.log(`[LTXVision] request keyIndex=${i + 1}/${keys.length} model=${model}${repairInstruction ? ' repair=true' : ''}`);
      const response = await axios.post(
        'https://api.mistral.ai/v1/chat/completions',
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content },
          ],
          temperature: 0.55,
          response_format: { type: 'json_object' },
        },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 180000 }
      );

      const raw = response?.data?.choices?.[0]?.message?.content;
      const parsed = _parseContent(raw);
      const description = _cleanText(parsed?.ltx_shot_description || parsed?.description || raw);
      if (!description) throw new Error('[LTXVision] Vision model returned an empty LTX description');

      const wordCount = description.split(/\s+/).filter(Boolean).length;
      const outputLines = _quotedDialogue(description);
      const conversational = Boolean(intent.dialogue || intent.conversation_reason);
      const normalizedOutput = outputLines.map(_normalizeDialogue);
      const missing = sourceLines.map(_normalizeDialogue).filter(line => !normalizedOutput.includes(line));
      const hasSpeech = outputLines.length > 0;

      if (conversational && (!hasSpeech || wordCount < 40)) {
        throw new Error(`[LTXVision] Conversational shot description is under-specified (words=${wordCount}, hasQuotedSpeech=${hasSpeech})`);
      }
      if (missing.length) {
        throw new Error(`[LTXVision] Required authored dialogue missing or altered: ${missing.map(line => `"${line}"`).join('; ')}`);
      }

      console.log(`[LTXVision] completed words=${wordCount} quotedSpeech=${outputLines.length} conversation=${conversational} preserved=${sourceLines.length - missing.length}/${sourceLines.length}`);
      return description;
    } catch (err) {
      lastError = err;
      const status = Number(err?.response?.status || 0);
      console.warn(`[LTXVision] attempt ${i + 1}/${keys.length} failed status=${status || 'n/a'} detail=${err?.response?.data?.message || err.message}`);
      if ([400, 401, 403].includes(status)) throw err;
    }
  }

  throw lastError || new Error('[LTXVision] Vision description generation failed');
}

module.exports = { describeForLTX };