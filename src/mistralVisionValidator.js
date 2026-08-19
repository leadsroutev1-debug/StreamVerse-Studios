'use strict';
/**
 * Mistral Large 3 multimodal visual QA layer.
 *
 * This is a semantic visual check after image generation. It is deliberately
 * score-driven and confidence-aware so harmless visual variation does not
 * consume another Cloudflare image generation.
 */

const axios = require('axios');
const sharp = require('sharp');
const config = require('./config');

const MODEL = process.env.MISTRAL_VISION_MODEL || 'mistral-large-2512';

const WEIGHTS = Object.freeze({
  identity: 25,
  location: 20,
  action_prop: 20,
  spatial_composition: 15,
  continuity: 10,
  lighting: 5,
  cinematic: 5,
});

const THRESHOLDS = Object.freeze({
  accept: 86,
  monitor: 75,
  retry: 65,
});

const CRITICAL_CONFIDENCE = 0.88;
const MAX_VISION_RETRIES_PER_SHOT = Number.isFinite(Number(process.env.MAX_VISION_RETRIES_PER_SHOT))
  ? Math.max(1, Math.min(3, Number(process.env.MAX_VISION_RETRIES_PER_SHOT)))
  : 2;
const MAX_REFERENCE_IMAGES = 3;
const MAX_IMAGE_WIDTH = 1024;
const JPEG_QUALITY = 72;

function _clamp01(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function _clamp100(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
}

function _normaliseCategory(category) {
  const key = String(category || '').trim().toLowerCase();
  if (WEIGHTS[key] != null) return key;
  if (key.includes('identity') || key.includes('character')) return 'identity';
  if (key.includes('location') || key.includes('environment')) return 'location';
  if (key.includes('prop') || key.includes('action')) return 'action_prop';
  if (key.includes('spatial') || key.includes('composition') || key.includes('framing')) return 'spatial_composition';
  if (key.includes('continuity') || key.includes('state') || key.includes('temporal')) return 'continuity';
  if (key.includes('light') || key.includes('colour') || key.includes('color')) return 'lighting';
  return 'cinematic';
}

async function _prepareImageBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  try {
    const out = await sharp(buffer)
      .rotate()
      .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString('base64')}`;
  } catch (err) {
    console.warn(`[MistralVision] Candidate image preparation failed: ${err.message}`);
    return null;
  }
}

async function _fetchAndPrepare(url) {
  if (!url || !/^https?:\/\//i.test(String(url))) return null;
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    return await _prepareImageBuffer(Buffer.from(resp.data));
  } catch (err) {
    console.warn(`[MistralVision] Reference fetch failed: ${err.message}`);
    return null;
  }
}

function _buildShotContract(shot, prevShot) {
  return {
    shot_id: `S${shot?.scene_number ?? '?'}_SH${shot?.shot_index ?? '?'}`,
    characters: Array.isArray(shot?.characters_in_shot) ? shot.characters_in_shot : [],
    location: shot?._scene_state?.location || shot?.location || '',
    action: shot?.dialogue_or_action || shot?.subject_motion || shot?.shot_purpose || '',
    image_prompt: shot?.image_prompt || '',
    start_frame_state: shot?.start_frame_state || shot?._scene_state?.visible_state || '',
    end_frame_state: shot?.end_frame_state || shot?.end_frame_transition || '',
    continuity_from_previous: prevShot?.end_frame_state || prevShot?.end_frame_transition || prevShot?.handoff_to_next_scene || '',
    camera: shot?.camera_language || shot?.camera_movement || shot?.camera || '',
    lighting: shot?._scene_state?.lighting || shot?.lighting || '',
    environment: shot?.environmental_story_beat || shot?._scene_state?.environment || '',
    tone: shot?.emotional_beat || shot?.emotional_state || shot?.tone || '',
  };
}

function _buildVisionPrompt(shot, prevShot) {
  const contract = _buildShotContract(shot, prevShot);
  return `You are StreamVerse Studios' visual continuity supervisor. Analyze the candidate frame against the authoritative shot contract below.

Do NOT reject harmless cinematic variation. A small wardrobe difference, slight expression change, tiny background-object movement, subtle colour variation, or imperfect pose is not enough to trigger regeneration.

REGENERATION-WORTHY errors are only meaningful continuity failures such as:
- wrong character identity or wrong character count when identity/count is essential;
- wrong location or clearly incompatible environment;
- central required prop/action missing or contradicted;
- impossible spatial relationship or major composition contradiction;
- strong continuity break with the prior shot/state;
- a major lighting condition that contradicts a stated must-have visual state.

Score each category 0-100, based only on visible evidence. Report issues with category, severity (critical|major|minor), confidence 0-1, and a concise evidence statement. Do not invent what cannot be seen.

Return JSON with exactly these top-level keys:
{
  "category_scores": {
    "identity": 0,
    "location": 0,
    "action_prop": 0,
    "spatial_composition": 0,
    "continuity": 0,
    "lighting": 0,
    "cinematic": 0
  },
  "issues": [
    {"category":"identity|location|action_prop|spatial_composition|continuity|lighting|cinematic","severity":"critical|major|minor","confidence":0.0,"evidence":"...","expected":"...","observed":"..."}
  ],
  "observations": "brief objective summary"
}

AUTHORITATIVE SHOT CONTRACT:
${JSON.stringify(contract, null, 2)}`;
}

async function _postVision(messages, key, { compact = false } = {}) {
  const bodyMessages = Array.isArray(messages) ? messages.map(m => ({ ...m })) : messages;
  if (compact && Array.isArray(bodyMessages)) {
    const last = bodyMessages.length - 1;
    if (last >= 0 && typeof bodyMessages[last]?.content === 'string') {
      bodyMessages[last] = {
        ...bodyMessages[last],
        content: `${bodyMessages[last].content}\n\nSTRICT COMPACT RETRY: Return ONLY valid JSON. No markdown, no preamble, no prose. Keep observations under 20 words. Keep at most 4 issues. Keep every evidence/expected/observed string under 25 words. Use numeric scores only. Do not emit any extra keys.`,
      };
    }
  }

  const resp = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model: MODEL,
      messages: bodyMessages,
      temperature: 0.0,
      max_tokens: compact ? 850 : 900,
      response_format: { type: 'json_object' },
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 180000,
    }
  );

  const choice = resp.data?.choices?.[0];
  let content = choice?.message?.content;
  if (!content) throw new Error('Empty Mistral vision response');
  if (Array.isArray(content)) {
    content = content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('');
  }
  if (content && typeof content === 'object') return content;
  content = String(content).trim();
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const tryParse = (text) => {
    try { return JSON.parse(text); } catch { return null; }
  };

  const direct = tryParse(content);
  if (direct && typeof direct === 'object') return direct;

  const start = content.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < content.length; i++) {
      const ch = content[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = tryParse(content.slice(start, i + 1));
          if (candidate && typeof candidate === 'object') return candidate;
          break;
        }
      }
    }
  }

  const err = new Error(`Mistral returned malformed/truncated JSON: ${content.slice(0, 500)}`);
  err.code = 'MISTRAL_VISION_JSON_PARSE';
  err.rawContent = content.slice(0, 4000);
  throw err;
}


async function _callWithMistralKeyRotation(messages) {
  if (!Array.isArray(config.mistralKeys) || config.mistralKeys.length === 0) {
    throw new Error('No Mistral keys configured');
  }

  let lastError;
  for (let i = 0; i < config.mistralKeys.length; i++) {
    const key = config.getNextMistralKey();
    if (!key) continue;

    // A parser failure means the key worked and the model response was malformed
    // or truncated. Do NOT burn/rotate a healthy key for that. Retry the same key
    // once with a deliberately compact JSON contract.
    try {
      const result = await _postVision(messages, key, { compact: false });
      config.markKeyStatus('mistral', key, 'active');
      return result;
    } catch (err) {
      lastError = err;
      if (err?.code === 'MISTRAL_VISION_JSON_PARSE') {
        console.warn(`[MistralVision] key ${i + 1}/${config.mistralKeys.length} returned malformed/truncated JSON — retrying SAME key with compact schema`);
        try {
          const result = await _postVision(messages, key, { compact: true });
          config.markKeyStatus('mistral', key, 'active');
          return result;
        } catch (compactErr) {
          lastError = compactErr;
          if (compactErr?.code === 'MISTRAL_VISION_JSON_PARSE') {
            console.warn(`[MistralVision] key ${i + 1}/${config.mistralKeys.length} still returned malformed JSON after compact retry — rotating key`);
            continue;
          }
          const compactStatus = compactErr?.response?.status;
          if ([401, 402, 403, 429].includes(compactStatus)) {
            config.markKeyStatus('mistral', key, compactStatus === 429 ? 'rate-limited' : 'exhausted');
          }
          continue;
        }
      }

      const status = err?.response?.status;
      if ([401, 402, 403, 429].includes(status)) {
        config.markKeyStatus('mistral', key, status === 429 ? 'rate-limited' : 'exhausted');
      }
      console.warn(`[MistralVision] key ${i + 1}/${config.mistralKeys.length} failed: ${err.message}`);
    }
  }
  throw lastError || new Error('All Mistral vision keys exhausted');
}

function _scoreFromCategories(categoryScores) {
  let weighted = 0;
  let totalWeight = 0;
  for (const [category, weight] of Object.entries(WEIGHTS)) {
    const score = _clamp100(categoryScores?.[category], 80);
    weighted += score * weight;
    totalWeight += weight;
  }
  return Math.round(weighted / totalWeight);
}

function _analyseDecision(categoryScores, issues, localScore = null, visionRetryUsed = 0) {
  const visionScore = _scoreFromCategories(categoryScores);
  const confidenceAdjustedPenalties = issues.reduce((sum, issue) => {
    const category = _normaliseCategory(issue.category);
    const weight = WEIGHTS[category] || 5;
    const confidence = _clamp01(issue.confidence, 0.5);
    const severityMultiplier = issue.severity === 'critical' ? 1 : issue.severity === 'major' ? 0.55 : 0.15;
    return sum + (weight * confidence * severityMultiplier);
  }, 0);

  // Vision score is the main semantic signal. Local score remains a guardrail
  // for structural checks already performed by the existing constraint engine.
  const adjustedVisionScore = Math.max(0, Math.min(100, Math.round(visionScore - Math.min(20, confidenceAdjustedPenalties * 0.25))));
  const combinedScore = Number.isFinite(Number(localScore))
    ? Math.round((adjustedVisionScore * 0.65) + (_clamp100(localScore, 85) * 0.35))
    : adjustedVisionScore;

  const critical = issues.some(issue =>
    issue.severity === 'critical' && _clamp01(issue.confidence, 0) >= CRITICAL_CONFIDENCE
  );
  const majorHighConfidence = issues.some(issue =>
    issue.severity === 'major' && _clamp01(issue.confidence, 0) >= 0.93 &&
    ['identity', 'location', 'action_prop', 'continuity'].includes(_normaliseCategory(issue.category))
  );

  let action = 'accept';
  let reason = 'visual_drift_within_tolerance';
  const retryWorthy = critical || majorHighConfidence || combinedScore < THRESHOLDS.retry;

  if (retryWorthy && visionRetryUsed < MAX_VISION_RETRIES_PER_SHOT) {
    action = 'retry_once';
    reason = critical ? 'high_confidence_critical_drift' : majorHighConfidence ? 'high_confidence_major_drift' : 'low_weighted_score';
  } else if (retryWorthy && visionRetryUsed >= MAX_VISION_RETRIES_PER_SHOT) {
    // A rejected candidate must NEVER proceed to video generation merely because
    // the vision retry budget was exhausted. The caller must persist the rejection
    // and leave the shot retryable instead of animating a known-bad frame.
    action = 'reject_after_vision_retry_budget';
    reason = 'vision_retry_budget_exhausted';
  } else if (combinedScore < THRESHOLDS.monitor) {
    action = 'accept_monitor';
    reason = 'borderline_but_not_worth_cf_retry';
  } else if (combinedScore < THRESHOLDS.accept) {
    action = 'accept_soft_drift';
    reason = 'minor_or_medium_drift';
  }

  return {
    visionScore: adjustedVisionScore,
    combinedScore,
    action,
    reason,
    critical,
    majorHighConfidence,
    confidenceAdjustedPenalty: Math.round(confidenceAdjustedPenalties * 100) / 100,
  };
}

function _buildCorrectionPrompt(shot, issues, categoryScores = {}) {
  const actionable = issues
    .filter(i => i.severity === 'critical' || i.severity === 'major' || (i.severity === 'minor' && Number(categoryScores?.[_normaliseCategory(i.category)]) < 65))
    .slice(0, 8)
    .map(i => {
      const expected = i.expected ? `Expected: ${i.expected}` : '';
      const observed = i.observed ? `Observed: ${i.observed}` : '';
      const evidence = i.evidence ? `Evidence: ${i.evidence}` : '';
      return `MANDATORY VISUAL REPAIR [${i.severity.toUpperCase()} / ${i.category}] ${expected} ${observed} ${evidence}`.trim();
    });
  const lowCategories = Object.entries(categoryScores || {})
    .filter(([, score]) => Number.isFinite(Number(score)) && Number(score) < 65)
    .map(([category, score]) => `CATEGORY REPAIR [${category}] Current Vision score ${score}/100. Strengthen this requirement visibly in the new image.`);

  if (!actionable.length && !lowCategories.length) return shot?.image_prompt || '';

  const chars = Array.isArray(shot?.characters_in_shot) ? shot.characters_in_shot.filter(Boolean) : [];
  const identityLock = chars.length
    ? `IDENTITY LOCK: Render exactly these declared characters and preserve their established identity from the supplied reference images: ${chars.join(', ')}. Do not substitute, merge, duplicate, or omit them.`
    : '';

  return [
    shot?.image_prompt || '',
    'VISUAL QA REGENERATION CONTRACT:',
    identityLock,
    'Fix EVERY listed critical/major defect in the NEW IMAGE. Preserve all requirements that were not flagged. The next candidate will be re-inspected against the same contract; do not merely describe the fix — visibly render it.',
    actionable.join('\n'),
    lowCategories.join('\n'),
  ].filter(Boolean).join('\n\n').trim();
}

/**
 * Analyze one generated frame. Provider outages are fail-open, but an actual
 * successful Vision inspection that flags a critical/major defect is NOT fail-open:
 * the caller must regenerate and re-validate the candidate before video submission.
 */
async function validateShotImage({
  imageBuffer,
  shot,
  prevShot = null,
  characterReferenceUrls = [],
  sceneBackgroundUrl = null,
  localScore = null,
  visionRetryUsed = 0,
}) {
  const candidate = await _prepareImageBuffer(imageBuffer);
  if (!candidate) {
    return {
      available: false,
      action: 'accept_no_vision',
      reason: 'candidate_image_unavailable_for_vision',
    };
  }

  const content = [
    { type: 'text', text: _buildVisionPrompt(shot, prevShot) },
    { type: 'text', text: 'IMAGE 1 — CANDIDATE GENERATED SHOT. This is the image that will be rendered into the episode.' },
    { type: 'image_url', image_url: candidate },
  ];

  // Optional references improve identity/location checks. They are supporting
  // evidence, not additional pass/fail requirements.
  const refUrls = [];
  for (const url of Array.isArray(characterReferenceUrls) ? characterReferenceUrls : []) {
    if (!url || refUrls.includes(url)) continue;
    refUrls.push(url);
    if (refUrls.length >= MAX_REFERENCE_IMAGES) break;
  }
  if (sceneBackgroundUrl && refUrls.length < MAX_REFERENCE_IMAGES && !refUrls.includes(sceneBackgroundUrl)) {
    refUrls.push(sceneBackgroundUrl);
  }

  for (let i = 0; i < refUrls.length; i++) {
    const prepared = await _fetchAndPrepare(refUrls[i]);
    if (!prepared) continue;
    content.push({ type: 'text', text: `REFERENCE IMAGE ${i + 2} — supporting visual reference only; do not require pixel-level matching.` });
    content.push({ type: 'image_url', image_url: prepared });
  }

  try {
    const analysis = await _callWithMistralKeyRotation([
      { role: 'user', content },
    ]);

    if (!analysis || typeof analysis !== 'object' || !analysis.category_scores || typeof analysis.category_scores !== 'object') {
      throw new Error('Mistral Vision response missing category_scores object');
    }
    for (const category of Object.keys(WEIGHTS)) {
      const rawScore = Number(analysis.category_scores[category]);
      if (!Number.isFinite(rawScore)) {
        throw new Error(`Mistral Vision response missing numeric category score: ${category}`);
      }
    }
    if (!Array.isArray(analysis.issues)) {
      throw new Error('Mistral Vision response missing issues array');
    }
    const categoryScores = {};
    for (const category of Object.keys(WEIGHTS)) {
      categoryScores[category] = _clamp100(analysis.category_scores[category], 80);
    }
    const issues = analysis.issues.map(issue => ({
      ...issue,
      category: _normaliseCategory(issue.category),
      severity: ['critical', 'major', 'minor'].includes(issue.severity) ? issue.severity : 'minor',
      confidence: _clamp01(issue.confidence, 0.5),
    }));

    const decision = _analyseDecision(categoryScores, issues, localScore, visionRetryUsed);
    const correction = decision.action === 'retry_once' ? _buildCorrectionPrompt(shot, issues, categoryScores) : null;

    console.log(
      `[MistralVision] S${shot?.scene_number}/idx${shot?.shot_index}: ` +
      `vision=${decision.visionScore}/100 combined=${decision.combinedScore}/100 ` +
      `action=${decision.action} reason=${decision.reason} issues=${issues.length}`
    );

    return {
      available: true,
      model: MODEL,
      ...decision,
      categoryScores,
      issues,
      observations: String(analysis?.observations || '').slice(0, 1200),
      correctedPrompt: correction,
      retryBudget: { max: MAX_VISION_RETRIES_PER_SHOT, used: visionRetryUsed },
      validatedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err?.code === 'MISTRAL_VISION_JSON_PARSE') {
      // The model/provider answered, but QA could not be interpreted safely.
      // Never fail-open on this path: an unvalidated frame must not reach LTX.
      console.error(`[MistralVision] QA response malformed after key retries — HARD REJECT candidate: ${err.message}`);
      return {
        available: true,
        model: MODEL,
        action: 'reject_unparseable',
        reason: 'vision_response_unparseable',
        error: err.message,
        retryBudget: { max: MAX_VISION_RETRIES_PER_SHOT, used: visionRetryUsed },
        validatedAt: new Date().toISOString(),
      };
    }
    console.warn(`[MistralVision] Visual QA unavailable/faulted — provider failure: ${err.message}`);
    return {
      available: false,
      action: 'accept_no_vision',
      reason: 'vision_provider_unavailable',
      error: err.message,
      validatedAt: new Date().toISOString(),
    };
  }
}


const LTX_PROMPT_MAX_WORDS = 200;
const MAX_LTX_REFERENCE_IMAGES = 6;

function _extractDialogueEntries(shot) {
  const raw = String(shot?.dialogue_or_action || '').trim();
  const out = [];
  const re = /(?:^|\n|\s)(?:([A-Za-z][A-Za-z0-9 .'-]{1,80})\s*:\s*)?"([^"]+)"/g;
  let m;
  while ((m = re.exec(raw))) {
    const text = String(m[2] || '').trim();
    if (!text) continue;
    out.push({ speaker: String(m[1] || '').trim(), text });
  }
  return out;
}

function _singleParagraph(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:Prompt|LTX Prompt)\s*:\s*/i, '')
    .trim();
}

function _capWords(text, maxWords = LTX_PROMPT_MAX_WORDS) {
  const words = _singleParagraph(text).split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? words.join(' ') : words.slice(0, maxWords).join(' ');
}

function _ensureExactDialogue(prompt, shot) {
  let result = _singleParagraph(prompt);
  const entries = _extractDialogueEntries(shot);
  for (const entry of entries) {
    if (!result.includes(`"${entry.text}"`)) {
      const speaker = entry.speaker ? `${entry.speaker} ` : '';
      result = `${result} ${speaker}speaks naturally: "${entry.text}".`.trim();
    }
  }
  return result;
}

function _buildLtxCompilerContract(shot, prevShot, orderedChars, positions, motionParams) {
  const staging = _buildShotContract(shot, prevShot);
  return {
    shot_id: staging.shot_id,
    characters: staging.characters,
    observed_character_roles: (orderedChars || []).map((c, i) => ({
      name: c.name,
      reference_slot: i + 1,
      visual_anchor: String(c.visual_anchor || c.description || '').slice(0, 900),
    })),
    declared_screen_positions: (positions || []).map((p, i) => ({
      name: orderedChars?.[i]?.name || p?.name || `character_${i + 1}`,
      ...p,
    })),
    location: staging.location,
    start_frame_state: staging.start_frame_state,
    continuity_from_previous: staging.continuity_from_previous,
    action: staging.action,
    camera: staging.camera,
    lighting: staging.lighting,
    environment: staging.environment,
    end_frame_state: staging.end_frame_state,
    temporal_arc: shot?.temporal_arc || '',
    subject_motion: shot?.subject_motion || '',
    opening_frame_transition: shot?.opening_frame_transition || '',
    dialogue_or_action: shot?.dialogue_or_action || '',
    motion_parameters: motionParams || {},
  };
}

function _buildLtxCompilerPrompt(shot, prevShot, orderedChars, positions, motionParams) {
  const contract = _buildLtxCompilerContract(shot, prevShot, orderedChars, positions, motionParams);
  return `You are the AUTHORITATIVE LTX-2.3 IMAGE-TO-VIDEO DIRECTOR for StreamVerse Studios.

You are multimodal. You MUST inspect the pixels of IMAGE 1 before composing the prompt. IMAGE 1 is the exact first frame that LTX will animate and is the visual ground truth. Reference images are supporting identity evidence only. Never pretend to see something that is not visible.

Your job is NOT to rewrite the screenplay and NOT to validate the still. Your job is to convert the ACTUAL visible starting state into a physically coherent temporal instruction for LTX-2.3. First determine the real screen geography: who is where, left/right/foreground/background/depth, facing direction, pose, gaze, hands, props, wardrobe, visible environment and framing. Then describe how those visible elements evolve over time.

Write ONE production-ready LTX-2.3 image-to-video prompt as one flowing paragraph. Concentrate on CHANGE FROM THE FIRST FRAME: chronological body motion, gestures, gaze, interaction, object motion, environmental motion, requested camera movement, lighting changes, dialogue delivery, and the final readable state. Preserve the actual observed spatial relationships. A subject must move from its observed position, not from a textual assumption about where it should have been.

For dialogue, use the exact supplied spoken words and keep every supplied spoken phrase inside quotation marks. Never invent, paraphrase, shorten, or reorder supplied dialogue. Put physical acting between dialogue beats when appropriate. Actions, staging, camera behavior and environment never go inside quotation marks. Express emotion through visible physical behavior.

Do not re-describe static visual details unless needed to explain motion or continuity. Do not invent characters, props, locations, camera moves, actions or spatial relationships. Do not use headings, bullets, JSON in the prompt itself, negative prompts, control labels, spatial-map declarations, meta-instructions, or narration about prompting. Target 120–220 words. Make the chronology clear from beginning to end.

CRITICAL OUTPUT CONTRACT:
Return JSON with EXACTLY these top-level keys:
{
  "prompt": "the single flowing LTX-2.3 prompt",
  "observations": "brief factual description of what you actually observed in IMAGE 1"
}
The "prompt" value MUST be non-empty and MUST contain the final production prompt. Do not put the prompt under any other key.

AUTHORITATIVE SHOT CONTRACT:
${JSON.stringify(contract, null, 2)}`;
}

async function compileLtxVideoPrompt({
  imageBuffer,
  shot,
  prevShot = null,
  orderedChars = [],
  positions = [],
  motionParams = null,
  characterReferenceChars = [],
  characterReferenceUrls = [],
  sceneBackgroundUrl = null,
}) {
  const candidate = await _prepareImageBuffer(imageBuffer);
  if (!candidate) {
    return { available: false, prompt: null, reason: 'candidate_image_unavailable_for_ltx_compiler' };
  }

  const content = [
    { type: 'text', text: _buildLtxCompilerPrompt(shot, prevShot, orderedChars, positions, motionParams) },
    { type: 'text', text: 'IMAGE 1 — EXACT FIRST FRAME FOR LTX. Treat this image as visual ground truth.' },
    { type: 'image_url', image_url: candidate },
  ];

  const refs = [];
  for (let i = 0; i < Math.min(orderedChars.length, MAX_LTX_REFERENCE_IMAGES); i++) {
    const url = characterReferenceUrls[i];
    if (!url || refs.includes(url)) continue;
    refs.push(url);
    const prepared = await _fetchAndPrepare(url);
    if (!prepared) continue;
    content.push({
      type: 'text',
      text: `REFERENCE IMAGE ${refs.length + 1} — character identity reference for ${characterReferenceChars[i]?.name || orderedChars[i]?.name || 'the corresponding character'}. Supporting identity evidence only.`,
    });
    content.push({ type: 'image_url', image_url: prepared });
  }

  if (sceneBackgroundUrl && refs.length < MAX_LTX_REFERENCE_IMAGES && !refs.includes(sceneBackgroundUrl)) {
    const prepared = await _fetchAndPrepare(sceneBackgroundUrl);
    if (prepared) {
      content.push({ type: 'text', text: 'REFERENCE IMAGE — scene/location reference. Supporting continuity evidence only.' });
      content.push({ type: 'image_url', image_url: prepared });
    }
  }

  try {
    const analysis = await _callWithMistralKeyRotation([
      { role: 'user', content },
    ]);
    const rawPrompt = analysis?.prompt || analysis?.ltx_prompt || analysis?.video_prompt || '';
    const exactPrompt = _ensureExactDialogue(_capWords(rawPrompt), shot);
    if (!exactPrompt || exactPrompt.length < 40) {
      throw new Error('Mistral LTX compiler returned an empty or unusably short prompt');
    }
    // Do not allow meta-output to leak into LTX.
    if (/\b(?:AUTHORITATIVE SHOT CONTRACT|LOCKED SPATIAL MAP|LTX SHOT CONTRACT|prompt instructions|do not narrate the prompt)\b/i.test(exactPrompt)) {
      throw new Error('Mistral LTX compiler returned prompt meta-language');
    }

    console.log(
      `[MistralVision] LTX compiler S${shot?.scene_number}/idx${shot?.shot_index}: ` +
      `compiled=${exactPrompt.split(/\s+/).length} words from candidate-frame vision`
    );

    return {
      available: true,
      authoritative: true,
      model: MODEL,
      prompt: exactPrompt,
      observations: String(analysis?.observations || '').slice(0, 1200),
      validatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[MistralVision] LTX prompt compiler unavailable — deterministic fallback will be used: ${err.message}`);
    return {
      available: false,
      authoritative: false,
      prompt: null,
      reason: 'ltx_prompt_compiler_unavailable',
      error: err.message,
      validatedAt: new Date().toISOString(),
    };
  }
}

module.exports = {
  MODEL,
  WEIGHTS,
  THRESHOLDS,
  MAX_VISION_RETRIES_PER_SHOT,
  validateShotImage,
  compileLtxVideoPrompt,
  _scoreFromCategories,
  _analyseDecision,
};
