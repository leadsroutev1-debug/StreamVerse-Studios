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

async function describeForLTX({ imageBuffer, imageMime = 'image/png', shot = {}, scene = {}, characters = [], model = DEFAULT_MODEL }) {
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
    dialogue: shot.dialogue_or_action || '',
    characters_in_shot: Array.isArray(shot.characters_in_shot) ? shot.characters_in_shot : [],
  };

  const characterHints = (characters || [])
    .filter(c => intent.characters_in_shot.some(name => String(name).toLowerCase() === String(c.name || '').toLowerCase()))
    .map(c => ({ name: c.name, visual_anchor: c.visual_anchor || c.description || '' }));

  const system = [
    'You are the visual director for an LTX-2.3 image-to-video shot.',
    'The supplied image is the exact first frame. Inspect the actual pixels before writing the description.',
    'Use the authored shot intent as the narrative target, but treat the supplied image as the visual ground truth.',
    'Identify who is actually visible, where each visible character is positioned, what they are doing, their eyelines, wardrobe, environment, lighting and current composition.',
    'Then describe the shot as one continuous, ultra-cinematic, chronological progression from the supplied first frame into the intended end state.',
    'Use concrete present-tense visual language and real-time temporal progression. Describe what changes first, what happens next, and how the shot resolves.',
    'Include camera movement, environmental evolution, lighting changes and synchronized dialogue, ambience, music or sound effects when the shot calls for them.',
    'Do not output analysis, labels, shot contracts, spatial maps, metadata, prompt instructions, negative prompts or implementation language.',
    'Do not invent a character, prop, location or action that is not visually supported by the first frame or explicitly required by the shot intent.',
    'Do not convert the visual description into a short summary. Preserve cinematic detail and chronology.',
    'Return JSON with exactly one field named ltx_shot_description containing the complete final LTX prompt.',
  ].join(' ');

  const user = [
    'AUTHORITATIVE SHOT INTENT:',
    JSON.stringify(intent),
    'SCENE CONTEXT:',
    JSON.stringify({ location: scene.location || '', lighting_design: scene.lighting_design || '', emotional_beat: scene.emotional_beat || '' }),
    'LOCKED CHARACTER HINTS:',
    JSON.stringify(characterHints),
    'Inspect the attached final still and author the complete cinematic LTX image-to-video description.',
  ].join('\n');

  const content = [
    { type: 'text', text: user },
    { type: 'image_url', image_url: _imageDataUrl(imageBuffer, imageMime) },
  ];

  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      console.log(`[LTXVision] request keyIndex=${i + 1}/${keys.length} model=${model}`);
      const response = await axios.post(
        'https://api.mistral.ai/v1/chat/completions',
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content },
          ],
          temperature: 0.35,
          response_format: { type: 'json_object' },
        },
        {
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          timeout: 180000,
        }
      );

      const raw = response?.data?.choices?.[0]?.message?.content;
      const parsed = _parseContent(raw);
      const description = _cleanText(parsed?.ltx_shot_description || parsed?.description || raw);
      if (!description) throw new Error('[LTXVision] Vision model returned an empty LTX description');
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
