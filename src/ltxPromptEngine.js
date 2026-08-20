'use strict';

/**
 * LTX-2.3 image-to-video prompt contract.
 *
 * The supplied image is the authoritative first frame. This module does not
 * invent story content or add production-control instructions. It normalizes
 * the authored prompt into the form recommended by the LTX documentation:
 * one continuous chronological description focused on observable change,
 * with camera, environment, lighting, and synchronized sound described in the
 * same flow. The prompt is bounded at 200 words without blindly cutting away
 * the terminal state.
 */

const MAX_WORDS = 200;

const CONTROL_PATTERNS = [
  /\bLTX\s+SHOT\s+CONTRACT\b\s*:?/gi,
  /\bLOCKED\s+SPATIAL\s+MAP\b[^.]*\.?/gi,
  /\bAudio\/text\s+boundary\b[^.]*\.?/gi,
  /\b(?:do not|don't) narrate or speak the prompt\b[^.]*\.?/gi,
  /\bpreserve the established (?:set|wardrobe|character identity|screen geography|spatial relationships)\b[^.]*\.?/gi,
  /\buse this exact map throughout the entire clip\b[^.]*\.?/gi,
  /\bno random new characters, props, locations, identity swaps, spatial swaps, mirrored placement, or merged faces\b[^.]*\.?/gi,
  /\b(?:output|return|write) (?:only )?(?:the )?(?:prompt|description)\b\.?/gi,
  /\b(?:negative prompt|production control|control language|metadata block|shot contract)\b[^.]*\.?/gi,
];

const REDUNDANT_I2V_PATTERNS = [
  /^(?:[A-Za-z][A-Za-z.'’-]*(?:\s+[A-Za-z][A-Za-z.'’-]*){0,3})\s+(?:remains|stays)\s+(?:at|in)\s+(?:far-left|far-right|screen-left|screen-right|left-of-center|right-of-center|screen-center|center)\b.*$/i,
  /\b(?:far-left|far-right|screen-left|screen-right|left-of-center|right-of-center|screen-center)\b.*\b(?:foreground|midground|background)\b/i,
  /\b(?:locked spatial map|screen geography|spatial relationships|exact screen position|exact screen geography)\b/i,
];

function _wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function _stripControlLanguage(text) {
  let value = String(text || '');
  for (const pattern of CONTROL_PATTERNS) value = value.replace(pattern, ' ');
  return value;
}

function _normalizeWhitespace(text) {
  return String(text || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function _stripLeadingMetaLabel(text) {
  return String(text || '').replace(
    /^(?:prompt|video prompt|ltx prompt|shot description|camera|audio|timing)\s*:\s*/i,
    ''
  ).trim();
}

function _sentenceSplit(text) {
  return String(text || '').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
}

function _isRedundantI2VSentence(sentence) {
  const value = String(sentence || '').trim();
  return REDUNDANT_I2V_PATTERNS.some(pattern => pattern.test(value));
}

function _dedupeSpeech(sentenceList) {
  const seenQuotes = new Set();
  return sentenceList.filter(sentence => {
    const quotes = String(sentence).match(/["“”]([^"“”]+)["“”]/g) || [];
    if (!quotes.length) return true;
    for (const quote of quotes) {
      const normalized = quote.replace(/["“”]/g, '').trim().toLowerCase();
      if (!normalized) continue;
      if (seenQuotes.has(normalized)) return false;
      seenQuotes.add(normalized);
    }
    return true;
  });
}

function _compressToWordLimit(text, maxWords = MAX_WORDS) {
  let sentences = _sentenceSplit(text).map(s => _normalizeWhitespace(s)).filter(Boolean);
  sentences = sentences.filter(s => !_isRedundantI2VSentence(s));
  sentences = _dedupeSpeech(sentences);

  if (_wordCount(sentences.join(' ')) <= maxWords) return sentences.join(' ');

  // Keep the authored chronological flow first, but reserve room for the
  // terminal visual/audio state instead of blindly cutting the prompt at N words.
  const kept = [];
  let remaining = maxWords;
  const tail = sentences.length > 1 ? sentences[sentences.length - 1] : '';
  const tailWords = _wordCount(tail);

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (i === sentences.length - 1 && kept.length) continue;
    const words = _wordCount(sentence);
    const reserve = tailWords && i < sentences.length - 1 ? Math.min(tailWords, 24) : 0;
    if (words <= remaining - reserve) {
      kept.push(sentence);
      remaining -= words;
    }
  }

  if (tail && kept.join(' ').includes(tail) === false && remaining >= tailWords) {
    kept.push(tail);
  } else if (tail && kept.length && !kept.includes(tail)) {
    const tailBudget = Math.min(tailWords, Math.max(8, remaining));
    const tailTokens = tail.split(/\s+/).slice(-tailBudget);
    if (tailTokens.length) kept.push(tailTokens.join(' '));
  }

  let result = _normalizeWhitespace(kept.join(' '));
  if (_wordCount(result) > maxWords) {
    const tokens = result.split(/\s+/);
    result = tokens.slice(0, maxWords).join(' ');
    if (!/[.!?]$/.test(result)) result += '.';
  }
  return result;
}

function _singleParagraph(text) {
  return _normalizeWhitespace(text).replace(/\s{2,}/g, ' ').trim();
}

function prepareImageToVideoPrompt(rawPrompt) {
  const original = String(rawPrompt || '').trim();
  if (!original) throw new Error('[LTXPrompt] Empty image-to-video prompt');

  let prompt = _stripControlLanguage(original);
  prompt = _stripLeadingMetaLabel(prompt);
  prompt = _singleParagraph(prompt);
  prompt = _compressToWordLimit(prompt, MAX_WORDS);

  const words = _wordCount(prompt);
  if (words > MAX_WORDS) {
    throw new Error(`[LTXPrompt] Image-to-video prompt normalization failed: ${words} words remain after compression`);
  }
  return prompt;
}

function validateImageToVideoPrompt(prompt) {
  const value = String(prompt || '').trim();
  const words = _wordCount(value);
  const violations = [];

  if (!value) violations.push('empty_prompt');
  if (words > MAX_WORDS) violations.push('over_200_words');
  if (/\r|\n|\t/.test(value)) violations.push('not_single_paragraph');
  if (/\bLTX\s+SHOT\s+CONTRACT\b|\bLOCKED\s+SPATIAL\s+MAP\b|Audio\/text\s+boundary/i.test(value)) {
    violations.push('production_control_language');
  }

  return {
    valid: violations.length === 0,
    words,
    violations,
  };
}

module.exports = {
  MAX_WORDS,
  prepareImageToVideoPrompt,
  validateImageToVideoPrompt,
};
