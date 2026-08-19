'use strict';
/**
 * Voice/dialogue helpers for StreamVerse shots.
 *
 * All spoken audio is now generated natively by LTX-2.3 as part of video
 * generation — the model produces synchronized dialogue, lip-sync, ambient
 * sound, and music directly from the video prompt in a single pass. There is
 * no separate TTS provider or API call: this module only extracts dialogue
 * text from the script and derives a per-character voice DESCRIPTION (gender,
 * age range, delivery style) that gets written into the LTX video prompt so
 * each character's voice stays consistent across every shot and episode.
 *
 * (Historical note: this module previously called Deepgram's TTS API and fed
 * the resulting audio into Magic Hour's ai-talking-photo endpoint. That
 * integration has been removed — LTX-2.3 replaces it entirely for both video
 * and audio.)
 */
const { safeJsonParse } = require('./util');

// Shot pacing types that contain spoken dialogue
const DIALOGUE_PACING_TYPES = new Set(['dialogue_mid', 'dialogue_full']);

// Shot types where a face is large enough for lip-sync to look good
const CLOSE_UP_SHOT_TYPES = new Set(['ECU', 'CU', 'MCU', 'OTS']);

/**
 * Derive a small stable integer from a character's name for deterministic
 * fallback-style selection (used only when no descriptive keywords match).
 */
function _nameHash(name) {
  if (!name) return 0;
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h) ^ name.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h;
}

/**
 * Detect the gender of a character from their description and visual_profile.
 * Uses pronoun and keyword frequency — reliable for LLM-generated character
 * bibles that always include he/she pronouns.
 *
 * Returns 'male', 'female', or 'unknown'.
 */
function detectCharacterGender(character) {
  if (!character) return 'unknown';

  // Check visual_profile for an explicit gender field first
  try {
    const vp = typeof character.visual_profile === 'string'
      ? safeJsonParse(character.visual_profile, {})
      : (character.visual_profile || {});
    const explicit = (vp.gender || vp.sex || '').toLowerCase();
    if (explicit === 'male' || explicit === 'm') return 'male';
    if (explicit === 'female' || explicit === 'f') return 'female';
  } catch {}

  // Pronoun/keyword counting in description + visual_anchor
  const text = [
    character.description || '',
    character.visual_anchor || '',
    character.name || '',
  ].join(' ').toLowerCase();

  const maleMatches = (text.match(
    /\b(he|his|him|man|men|boy|male|masculine|gentleman|father|brother|son|uncle|husband|boyfriend)\b/g
  ) || []).length;

  const femaleMatches = (text.match(
    /\b(she|her|hers|woman|women|girl|female|feminine|lady|mother|sister|daughter|aunt|wife|girlfriend)\b/g
  ) || []).length;

  if (maleMatches > femaleMatches) return 'male';
  if (femaleMatches > maleMatches) return 'female';
  return 'unknown';
}

/**
 * Return true when this shot's speaking character should get a tight,
 * lip-sync-friendly close-up framing. LTX-2.3 lip-syncs natively from the
 * video prompt for any close-framed speaking shot — this just tells the
 * pipeline/motion system when that framing applies.
 * Internal monologue (V.O.) shots do NOT count — the character's lips
 * aren't moving.
 */
function shouldUseTalkingPhoto(shot) {
  // V.O. / internal monologue → ambient audio, no lip-sync
  if (shot.tts_mode === 'internal_monologue' || shot.tts_mode === 'ambient') {
    return false;
  }
  // Phone call handling:
  //   - _phone_speaker_visible === true → the visible character IS speaking
  //     into the phone, so lip-sync SHOULD apply (close-up framing).
  //   - _phone_speaker_visible === false (or unset) → the remote caller's
  //     voice plays as VO; the visible character is listening and must NOT
  //     lip-sync.
  if (shot.tts_mode === 'phone_vo') {
    return shot._phone_speaker_visible === true &&
           DIALOGUE_PACING_TYPES.has(shot.shot_pacing_type) &&
           CLOSE_UP_SHOT_TYPES.has(shot.shot_type);
  }
  return DIALOGUE_PACING_TYPES.has(shot.shot_pacing_type) &&
         CLOSE_UP_SHOT_TYPES.has(shot.shot_type);
}

/**
 * Parse the speaker name prefix from dialogue_or_action when the script
 * writer emits the "NAME: text" format used for multi-character scenes.
 *
 * Examples:
 *   "ELENA: I never meant to hurt you."     → "Elena"
 *   "DR. HAYES: We need to talk."           → "Dr. Hayes"
 *   "Elena's mother: Come home."            → "Elena's Mother"
 *   "She turns and walks away."             → null  (no speaker prefix)
 *
 * The regex accepts:
 *   • All-caps names (ELENA, DR. HAYES)
 *   • Mixed-case names (Elena's mother, young detective)
 *   • Names with apostrophes and dots (Dr., Elena's)
 *   • Up to 5 words in the name token
 *   • 1–5 word names — avoids matching stage directions with colons
 *
 * Returns the speaker name string (Title-cased), or null when no prefix present.
 */
function extractSpeakerName(dialogueOrAction) {
  if (!dialogueOrAction || typeof dialogueOrAction !== 'string') return null;

  // Pattern: optional leading quote, then a name (1-5 words, first word starts with
  // any letter case, subsequent words may be any case), followed by colon + space.
  // We allow apostrophes and dots inside name tokens.
  const trimmed = dialogueOrAction.trim();

  // Explicit remote caller speaker form: REMOTE CALLER (PHONE): words
  const phoneMatch = trimmed.match(
    /^["\'\']*([A-Za-z][A-Za-z .'-]{0,78})\s*\(PHONE\)\s*:\s+/i
  );

  // Explicit internal voice-over speaker form: NAME (V.O.): thought
  // Parentheses are part of the semantic speaker marker and must not be mistaken
  // for stage directions.
  const voMatch = trimmed.match(
    /^["\'\']*([A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*(?:\s+[A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*){0,4})\s*\(V\.O\.\)\s*:\s+/i
  );
  const match = phoneMatch || voMatch || trimmed.match(
    /^["\'\']*([A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*(?:\s+[A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*){0,4})\s*:\s+/
  );
  if (!match) return null;

  // Guard: don't match common stage direction phrases that happen to have colons
  const raw = match[1].trim().toLowerCase();
  const STAGE_DIRECTION_STARTS = ['note', 'cut to', 'fade', 'smash cut', 'int', 'ext', 'scene', 'action'];
  if (STAGE_DIRECTION_STARTS.some(s => raw.startsWith(s))) return null;

  // Normalise to Title Case (each word capitalised)
  return match[1].trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Extract the spoken words from dialogue_or_action, stripping:
 *   1. The speaker prefix ("ELENA: " or "Elena's mother: ")
 *   2. Parenthetical subtext "(but she knows it's goodbye)"
 *   3. Leading/trailing quote characters
 *
 * "ELENA: I love you — always have. (but she knows it's goodbye)" → "I love you — always have."
 * "Elena's mother: Come back to me. (desperate)" → "Come back to me."
 *
 * Returns null when the text is empty or reads as a pure stage direction.
 */
function extractDialogueText(dialogueOrAction) {
  if (!dialogueOrAction || typeof dialogueOrAction !== 'string') return null;

  let text = dialogueOrAction.trim();

  // Strip speaker prefix — spoken words remain after the colon.
  const voPrefix = text.match(/^\s*[A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*(?:\s+[A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*){0,6}\s*\(V\.O\.\)\s*:\s+/i);
  const isVoiceOver = !!voPrefix;
  text = text.replace(
    /^\s*[A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*(?:\s+[A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*){0,6}\s*(?:\(V\.O\.\)\s*)?:\s+/,
    ''
  ).trim();

  if (isVoiceOver) {
    const thought = text.replace(/^["“”]+|["“”]+$/g, '').replace(/\([^)]*\)\s*$/g, '').trim();
    if (!thought || thought.length < 3) return null;
    return thought;
  }

  // Only quoted spans are eligible for spoken dialogue. This guard ensures
  // unquoted visual descriptions cannot become spoken audio.
  const quotedSpans = text.match(/["“”][^"“”]*["“”]/g) || [];
  if (quotedSpans.length === 0) return null;

  // Ignore quoted third-person stage directions masquerading as dialogue.
  const actionLike = /^(?:the\s+)?(?:[A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,4})\s+(?:looks?|stares?|glances?|watches?|turns?|walks?|steps?|moves?|reaches?|holds?|opens?|closes?|checks?|reads?|types?|sits?|stands?|leans?|smiles?|frowns?|nods?|shakes?|breathes?|pauses?|grips?|clenches?|raises?|lowers?|takes?|puts?|pulls?|pushes?|enters?|leaves?|crosses?)\b/i;
  const candidates = quotedSpans
    .map(q => q.slice(1, -1).trim())
    .filter(t => {
      if (!t) return false;
      // Normal conversational starts such as "I...", "we...", "you..." and
      // question/interjection forms are overwhelmingly speech, not stage directions.
      if (/^(?:I|me|my|mine|we|our|ours|you|your|yours|he|she|they|them|it|this|that|these|those|why|what|when|where|who|how|can|could|will|would|should|please|yes|no|let|don't|do not)\b/i.test(t)) return true;
      return !actionLike.test(t);
    });
  if (!candidates.length) return null;

  // Last quoted span is the authoritative spoken line if multiple quoted
  // fragments remain. Parenthetical delivery notes never enter this channel.
  text = candidates[candidates.length - 1]
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();

  if (!text || text.length < 3) return null;
  return text || null;
}

/**
 * Extract every speaker/line pair out of a shot's dialogue_or_action when it
 * contains MULTIPLE characters speaking (one "NAME: text" per line). This is
 * the multi-character counterpart to extractSpeakerName/extractDialogueText —
 * those two only ever resolve a single leading speaker, which is what forced
 * shots to be single-speaker-only. LTX can animate independent per-character
 * dialogue in one shot, so the pipeline needs the full set, not just the first.
 *
 * Returns an array of { speaker, text }, in written order. Falls back to a
 * single-entry array (using extractSpeakerName/extractDialogueText) when the
 * text is a single line, so existing single-speaker shots behave identically.
 */
/**
 * Strict extraction for LTX native speech. Only an explicit speaker-prefixed
 * quoted line is treated as spoken dialogue. Narrative prose, quoted stage
 * directions, scene descriptions and character names alone are never promoted
 * to speech. Internal/phone voice-over may use their explicit mode markers.
 */
function extractStrictSpokenDialogue(dialogueOrAction, options = {}) {
  if (!dialogueOrAction || typeof dialogueOrAction !== 'string') return [];
  const lines = dialogueOrAction.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];

  for (const line of lines) {
    // Phone: REMOTE CALLER (PHONE): "exact words"
    // This must be checked before the generic NAME: matcher because the
    // generic form intentionally permits parenthetical speaker labels.
    let m = line.match(/^\s*([^:]{1,80}\(PHONE\))\s*:\s*["“]([^"”]+)["”](?:\s+.*)?$/i);
    if (m) {
      const speaker = m[1].replace(/\(PHONE\)/i, '').trim();
      const text = m[2].trim();
      if (text) out.push({ speaker, text, mode: 'phone_vo' });
      continue;
    }

    // Spoken: NAME: "exact words" [optional unquoted delivery note]
    // The capture boundary is deliberately tied to the closing quote so the
    // spoken payload is preserved byte-for-byte apart from surrounding space.
    m = line.match(/^\s*([^:]{1,80}):\s*["“]([^"”]+)["”](?:\s+.*)?$/);
    if (m) {
      const speaker = m[1].trim();
      const text = m[2].trim();
      if (text) out.push({ speaker, text, mode: 'spoken' });
      continue;
    }

    // Internal voice-over is deliberately unquoted. It is still extracted
    // exactly when requested, but it is never promoted to spoken lip-sync.
    if (options.allowUnquotedVO) {
      m = line.match(/^\s*([^:]{1,80})\s*\(V\.O\.\)\s*:\s*(.+)$/i);
      if (m) {
        const speaker = m[1].trim();
        const text = m[2].trim().replace(/^["“”']+|["“”']+$/g, '').trim();
        if (text) out.push({ speaker, text, mode: 'internal_monologue' });
      }
    }
  }

  return out;
}

function extractMultiSpeakerDialogue(dialogueOrAction) {
  if (!dialogueOrAction || typeof dialogueOrAction !== 'string') return [];

  const lines = dialogueOrAction.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1) {
    const speaker = extractSpeakerName(dialogueOrAction);
    const text = extractDialogueText(dialogueOrAction);
    return text ? [{ speaker, text }] : [];
  }

  const out = [];
  for (const line of lines) {
    const speaker = extractSpeakerName(line);
    const text = extractDialogueText(line);
    if (text) out.push({ speaker, text });
  }
  return out;
}

// ── Voice profile derivation (age/gender/style) ─────────────────────────────
// Used to auto-assign a distinct spoken "voice" description per character for
// providers (like LTX) that generate audio natively from the prompt rather
// than from a separately-synthesised audio track. Deterministic — same
// character always gets the same profile.
const AGE_KEYWORDS = [
  { re: /\b(child|kid|little\s+(boy|girl)|preteen)\b/i,               range: 'child' },
  { re: /\b(teen|teenager|adolescent|high[- ]school)\b/i,             range: 'teen' },
  { re: /\b(elderly|old\s+man|old\s+woman|senior|grandfather|grandmother|in\s+(his|her)\s+(6|7|8)0s)\b/i, range: 'elderly' },
  { re: /\bmiddle[- ]aged\b/i,                                        range: 'middle-aged' },
];
const STYLE_KEYWORDS = [
  { re: /\b(gruff|rough|hardened|weathered)\b/i,       style: 'gruff, weathered' },
  { re: /\b(warm|kind|gentle|nurturing)\b/i,            style: 'warm, gentle' },
  { re: /\b(sharp|cold|calculating|clipped)\b/i,        style: 'sharp, clipped' },
  { re: /\b(nervous|anxious|timid|shy)\b/i,             style: 'nervous, hesitant' },
  { re: /\b(confident|commanding|authoritative)\b/i,    style: 'confident, commanding' },
  { re: /\b(playful|witty|sarcastic)\b/i,               style: 'playful, wry' },
];

// Role → delivery-style hints, checked BEFORE the free-text style keywords
// above. A character's narrative role (protagonist/antagonist/mentor/etc.)
// is a stronger, more deliberate signal than incidental description text,
// so it takes priority when present. Falls through to STYLE_KEYWORDS, then
// the deterministic fallback, exactly as before.
const ROLE_STYLE_KEYWORDS = [
  { re: /\b(antagonist|villain|rival|enemy)\b/i,                 style: 'cold, commanding' },
  { re: /\b(protagonist|hero|lead|main\s+character)\b/i,         style: 'warm, grounded' },
  { re: /\b(mentor|elder|guide|authority\s+figure)\b/i,          style: 'measured, deliberate' },
  { re: /\b(comic\s+relief|sidekick|best\s+friend)\b/i,          style: 'playful, wry' },
  { re: /\b(love\s+interest|romantic\s+lead)\b/i,                style: 'warm, expressive' },
  { re: /\b(narrator|voiceover)\b/i,                             style: 'crisp, direct' },
];

/**
 * Derive a deterministic, descriptive voice profile — { gender, ageRange,
 * style, role } — from a character's gender, age, and narrative role.
 *
 * This is the ONLY voice-assignment mechanism in the app: there is no
 * external TTS provider or fixed voice-ID pool to select from. LTX-2.3
 * reads this description straight out of the video prompt and performs the
 * dialogue itself, so "assigning a voice" here just means writing down how
 * this character should sound — the same character always gets the same
 * description, and different characters reliably get different ones.
 */
function deriveVoiceProfile(character) {
  const gender = detectCharacterGender(character);
  const text = [character?.description || '', character?.visual_anchor || ''].join(' ');
  const roleText = character?.role || '';

  let ageRange = 'adult';
  for (const { re, range } of AGE_KEYWORDS) {
    if (re.test(text)) { ageRange = range; break; }
  }

  let style = null;

  // 1. Narrative role (protagonist/antagonist/mentor/...) — the most
  //    deliberate, director-intentional signal.
  for (const { re, style: s } of ROLE_STYLE_KEYWORDS) {
    if (re.test(roleText)) { style = s; break; }
  }

  // 2. Free-text description/visual-anchor keywords.
  if (!style) {
    for (const { re, style: s } of STYLE_KEYWORDS) {
      if (re.test(text)) { style = s; break; }
    }
  }

  // 3. Deterministic fallback so every character still gets a distinct,
  //    consistent delivery style even without descriptive keywords.
  if (!style) {
    const FALLBACK_STYLES = ['natural, conversational', 'measured, deliberate', 'warm, expressive', 'crisp, direct'];
    style = FALLBACK_STYLES[_nameHash(character?.name) % FALLBACK_STYLES.length];
  }

  return {
    gender: gender === 'unknown' ? 'neutral' : gender,
    ageRange,
    style,
    role: roleText || undefined,
  };
}

/**
 * Render a voice profile object as a short human-readable phrase, e.g.
 * "female, adult, warm and gentle" — used anywhere a single display string
 * is needed (logs, the legacy voice_id column, prompt injection) instead of
 * a provider-specific voice ID.
 */
function describeVoiceProfile(profile) {
  if (!profile) return 'unassigned';
  const style = (profile.style || '').replace(/,\s*/g, ' and ');
  return [profile.gender, profile.ageRange, style].filter(Boolean).join(', ');
}

/**
 * Generate TTS audio for `text` via Deepgram's TTS API,
 * upload the MP3 to Cloudinary, and return { audioUrl, durationSeconds }.
 *
 * Rotates through DEEPGRAK_KEYS on quota / rate-limit errors (402, 429, 401).
 * Throws KeyPoolExhaustedError when ALL keys are depleted — the pipeline
 * catches this and pauses gracefully.
 *
 * @param {string}      text       Dialogue text to synthesise
 * @param {string}      publicId   Cloudinary public_id for the audio asset
 * @param {object|null} character  Character object (for voice selection); null → default voice
 */
async function generateAndUploadTTS(text, publicId, character = null) {
  const keys = config.deepgramKeys;
  if (!keys.length) {
    throw new Error('[TTS] No Deepgram keys configured — set DEEPGRAK_KEYS env var');
  }

  const voice  = character ? selectVoiceForCharacter(character) : DEFAULT_VOICE;
  const gender = character ? detectCharacterGender(character) : 'unknown';
  console.log(
    `[TTS] Voice selected: ${voice} (${gender}) for ${character?.name || 'unknown character'}`
  );

  let lastError;
  let allExhausted = true;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = config.getNextDeepgramKey();
    try {
      const resp = await axios.post(
        `https://api.deepgram.com/v1/speak?model=${voice}`,
        { text },
        {
          headers: {
            'Authorization': `Token ${key}`,
            'Content-Type':  'application/json',
          },
          responseType: 'arraybuffer',
          timeout:      30000,
        }
      );

      const buf = Buffer.from(resp.data);
      if (!buf || buf.length < 200) {
        throw new Error(`[TTS] Empty audio response (${buf?.length ?? 0} bytes)`);
      }

      // Upload as a Cloudinary video resource (Cloudinary stores audio under the video type)
      const audioUrl = await cloudinary.uploadVideoFromUrl(
        `data:audio/mpeg;base64,${buf.toString('base64')}`,
        publicId
      );

      // Estimate duration from MP3 byte length: ~16 bytes/ms for 128kbps MP3 → ÷16000 = seconds
      // Use a more accurate estimate based on typical Deepgram output bitrates (~32kbps Aura)
      // 32kbps = 4000 bytes/sec → buf.length / 4000
      const durationSeconds = Math.min(15, Math.max(2, Math.ceil(buf.length / 4000)));

      config.markKeyStatus('deepgram', key, 'active');
      allExhausted = false;
      console.log(
        `[TTS] Deepgram (${voice}): "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}" ` +
        `→ ${buf.length} bytes, ~${durationSeconds}s — ${audioUrl}`
      );
      return { audioUrl, durationSeconds };

    } catch (err) {
      lastError = err;
      const status = err.response?.status;

      if (status === 402 || status === 429 || status === 401) {
        config.markKeyStatus('deepgram', key, status === 429 ? 'rate-limited' : 'exhausted');
        console.warn(`[TTS] Deepgram key failed (HTTP ${status}), rotating to next key...`);
        continue; // try next key
      }

      // Non-quota error — propagate immediately (rotating keys won't help)
      allExhausted = false;
      const body = err.response?.data
        ? Buffer.from(err.response.data).toString('utf8').slice(0, 200)
        : err.message;
      throw new Error(`[TTS] Deepgram failed: ${body}`);
    }
  }

  if (allExhausted) {
    const err = new Error(`[TTS] All Deepgram keys exhausted. Last: ${lastError?.message}`);
    err.deepgramExhausted = true;
    throw err;
  }

  throw new Error(`[TTS] All Deepgram keys exhausted. Last: ${lastError?.message}`);
}

/**
 * Calculate the expected spoken duration of a text string in seconds.
 * Used by the pipeline for dynamic shot duration calculation.
 *
 * Deepgram Aura voices speak at ~2.5 words/second (150 wpm) for natural delivery.
 * Add 0.5s lead-in and 0.5s tail for natural pacing.
 */
function estimateSpokenDuration(text) {
  if (!text || typeof text !== 'string') return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Math.round((words / 2.5 + 1.0) * 10) / 10; // round to 0.1s
}

module.exports = {
  extractStrictSpokenDialogue,
  extractMultiSpeakerDialogue,
  deriveVoiceProfile,
  shouldUseTalkingPhoto,
  extractDialogueText,
  extractSpeakerName,
  generateAndUploadTTS,
  detectCharacterGender,
  estimateSpokenDuration,
  // Exported for testing / pipeline reference
  DIALOGUE_PACING_TYPES,
  CLOSE_UP_SHOT_TYPES,
};