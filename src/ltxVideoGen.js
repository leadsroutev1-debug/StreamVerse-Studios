'use strict';

/**
 * Provider router for the existing video-generation seam.
 *
 * The original LTX implementation lives in ltxVideoGenCore.js. When
 * VIDEO_PROVIDER=agnes, the same submit/poll interface is delegated to Agnes.
 * Provider-specific temporal rules are source-authored in ScriptWriter and the
 * pipeline; this module only selects the provider implementation.
 *
 * The LTX seam also normalizes and carries forward the Vision Director's
 * validated dialogue so the transport layer cannot collapse a multi-turn
 * conversation into stale/legacy metadata or reject smart punctuation.
 */

const config = require('./config');
const ltxCore = require('./ltxVideoGenCore');
const ltxVisionDirector = require('./ltxVisionDirector');
const providerPromptAdapter = require('./providerPromptAdapter');

// Keep the outbound LLM seam provider-aware for any residual legacy prompt text.
// The core production duration contract itself lives directly in source files.
providerPromptAdapter.install();

function _normalizeVisionText(text) {
  return String(text || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function _extractQuotedDialogue(text) {
  const value = String(text || '');
  return [...value.matchAll(/"([^"]+)"|“([^”]+)”/g)]
    .map(match => (match[1] || match[2] || '').trim())
    .filter(Boolean);
}

/*
 * ltxVisionDirector historically returned only the rendered description string.
 * The transport core already supports a richer result carrying
 * authoritativeDialogueBeats, so adapt the legacy string result here.
 *
 * This is intentionally a boundary adapter, not a second dialogue validator:
 * the Vision Director has already completed its hard quoted-dialogue and speaker
 * ownership audits. We simply preserve its complete quoted turn sequence and
 * normalize punctuation before the transport layer validates it again.
 */
const _originalDescribeForLTX = ltxVisionDirector.describeForLTX;
if (typeof _originalDescribeForLTX === 'function' && !ltxVisionDirector.__streamverseDialogueBoundaryAdapterInstalled) {
  ltxVisionDirector.describeForLTX = async function streamVerseDialogueBoundaryAdapter(args) {
    const result = await _originalDescribeForLTX(args);

    if (typeof result === 'string') {
      const description = _normalizeVisionText(result);
      const authoritativeDialogueBeats = _extractQuotedDialogue(description).map(line => ({
        speaker: '',
        line,
      }));

      return {
        description,
        visionResponse: result,
        authoritativeDialogueBeats,
        semanticSpeakerOwnership: null,
      };
    }

    if (result && typeof result === 'object') {
      const description = _normalizeVisionText(
        result.description || result.ltx_shot_description || result.shotDescription || ''
      );
      const beats = Array.isArray(result.authoritativeDialogueBeats)
        ? result.authoritativeDialogueBeats
        : Array.isArray(result.authoritative_dialogue_beats)
          ? result.authoritative_dialogue_beats
          : _extractQuotedDialogue(description).map(line => ({ speaker: '', line }));

      return {
        ...result,
        description,
        authoritativeDialogueBeats: beats.map(beat => ({
          speaker: String(
            beat?.speaker || beat?.character || beat?.character_name || beat?.name || ''
          ).trim(),
          line: _normalizeVisionText(
            beat?.line || beat?.dialogue || beat?.utterance || beat?.text || beat?.spoken_line || ''
          ).replace(/^"+|"+$/g, '').trim(),
        })).filter(beat => beat.line),
      };
    }

    return result;
  };

  Object.defineProperty(ltxVisionDirector, '__streamverseDialogueBoundaryAdapterInstalled', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

if (config.videoProvider !== 'agnes') {
  module.exports = ltxCore;
} else {
  const agnes = require('./agnesVideoGen');

  module.exports = {
    ...agnes,
    // Preserve stable error names expected by existing pipeline diagnostics.
    LTXGenerationError: agnes.AgnesGenerationError,
  };
}
