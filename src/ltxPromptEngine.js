'use strict';

/**
 * LTX-2.3 image-to-video prompt contract.
 *
 * The supplied image is the authoritative first frame. This module does not
 * invent story content or add production-control instructions. It normalizes
 * the authored prompt into the form recommended by the LTX documentation:
 * one continuous chronological description focused on observable change,
 * with camera, environment, lighting, and synchronized sound described in the
 * same flow. The prompt is deliberately bounded at 200 words.
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

function _singleParagraph(text) {
  return _normalizeWhitespace(text).replace(/\s{2,}/g, ' ').trim();
}

function prepareImageToVideoPrompt(rawPrompt) {
  const original = String(rawPrompt || '').trim();
  if (!original) throw new Error('[LTXPrompt] Empty image-to-video prompt');

  let prompt = _stripControlLanguage(original);
  prompt = _stripLeadingMetaLabel(prompt);
  prompt = _singleParagraph(prompt);

  const words = _wordCount(prompt);
  if (words > MAX_WORDS) {
    throw new Error(`[LTXPrompt] Image-to-video prompt exceeds ${MAX_WORDS} words (${words}); shorten the authored LTX shot description instead of truncating its ending state.`);
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
