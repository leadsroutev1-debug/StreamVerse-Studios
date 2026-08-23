'use strict';

/**
 * Provider-aware LLM prompt adapter.
 *
 * ScriptWriter is intentionally large and provider-agnostic. Rather than
 * duplicating it for every video backend, this adapter rewrites only the
 * provider-specific temporal rules at the outbound LLM boundary when Agnes
 * is selected. LTX and Magic Hour prompts remain untouched.
 */

const axios = require('axios');

const AGNES_MARKER = '[[STREAMVERSE_AGNES_PROVIDER_RULES_V1]]';

function isAgnes() {
  return String(process.env.VIDEO_PROVIDER || 'ltx').trim().toLowerCase() === 'agnes';
}

function patchContent(content) {
  if (!isAgnes() || typeof content !== 'string' || content.includes(AGNES_MARKER)) {
    return content;
  }

  const pacingSensitive = /SEMANTIC 10-SECOND CINEMATIC SHOT RULES|HARD MAXIMUM OF 10 SECONDS PER SHOT|8[–-]10 seconds|8[–-]10 second shots|8[–-]10 second visual event|duration must be an integer from 8 to 10|Use 10 as the raw intended duration|backend is LTX-first|LTX duration will normally be 8\.0[–-]10\.0/i.test(content);
  const repairSensitive = /duration must be an integer from 8 to 10 for LTX-first production/i.test(content);
  const ltxShotSensitive = /LTX SHOT DESCRIPTION|LTX image-to-video model|LTX-ready semantics/i.test(content);

  if (!pacingSensitive && !repairSensitive && !ltxShotSensitive) return content;

  let out = content
    .replace(/SEMANTIC 10-SECOND CINEMATIC SHOT RULES/g, 'SEMANTIC 18-SECOND CINEMATIC SHOT RULES')
    .replace(/HARD MAXIMUM OF 10 SECONDS PER SHOT/g, 'HARD MAXIMUM OF 18 SECONDS PER SHOT')
    .replace(/8–10 seconds/g, '8–18 seconds')
    .replace(/8-10 seconds/g, '8-18 seconds')
    .replace(/8–10 second shots/g, '8–18 second shots')
    .replace(/8-10 second shots/g, '8-18 second shots')
    .replace(/8–10 second visual event/g, '8–18 second visual event')
    .replace(/8-10 second visual event/g, '8-18 second visual event')
    .replace(/duration must be an integer from 8 to 10 for LTX-first production/g, 'duration should be planned within an 8–18 second cinematic canvas for Agnes production')
    .replace(/Use 10 as the raw intended duration because the backend is LTX-first and the pipeline will clamp safely\./g, 'Use 18 as the maximum raw intended duration for Agnes; shorter durations remain valid when the shot is semantically complete.')
    .replace(/The resulting LTX duration will normally be 8\.0–10\.0 seconds/g, 'The resulting Agnes duration should normally occupy 8.0–18.0 seconds')
    .replace(/The resulting LTX duration will normally be 8\.0-10\.0 seconds/g, 'The resulting Agnes duration should normally occupy 8.0-18.0 seconds')
    .replace(/LTX can receive the complete composition plus multiple speaker lines in chronological order\./g, 'Agnes can receive the complete composition plus multiple speaker lines in chronological order and generate audiovisual performance natively.')
    .replace(/MULTI-SPEAKER LTX DIALOGUE/g, 'MULTI-SPEAKER AUDIOVISUAL DIALOGUE')
    .replace(/LTX SHOT DESCRIPTION — REQUIRED OUTPUT STYLE/g, 'AUDIOVISUAL SHOT DESCRIPTION — REQUIRED OUTPUT STYLE')
    .replace(/LTX image-to-video model/g, 'active video generation model')
    .replace(/LTX-ready semantics/g, 'provider-ready cinematic semantics');

  out += `\n\n${AGNES_MARKER}\n═══ AGNES VIDEO V2.0 PROVIDER RULES ═══\n\nAgnes Video V2.0 is the active audiovisual image-to-video backend. The shot-writing temporal canvas is up to 18 seconds, not 10 seconds. Design each shot as a complete cinematic micro-scene with a clear opening state, continuous development, and deliberate end state. Use the longer canvas to support meaningful dialogue, natural pauses, facial performance, environmental reaction, camera progression, and spatial continuity rather than padding.\n\nThe supplied still is the authoritative first frame. Preserve established character identity, wardrobe, set geography, lighting, props, and screen relationships. Do not invent prominent written text or subtitles. When dialogue exists, put only exact audible words in the dialogue field and keep speaker order chronological. Agnes generates audiovisual speech natively; do not design around an external TTS track.\n\nFor multi-character dialogue, keep all visible speakers/listeners in one coherent composition whenever the scene naturally calls for it. Explicitly preserve screen geography, eyelines, gestures, and interaction so the resulting audiovisual performance remains grounded in the supplied still.\n${AGNES_MARKER}`;

  return out;
}

let installed = false;

function install() {
  if (installed) return;
  installed = true;
  axios.interceptors.request.use((request) => {
    if (!isAgnes() || !request?.data || typeof request.data !== 'object') return request;
    if (!Array.isArray(request.data.messages)) return request;

    request.data.messages = request.data.messages.map((message) => ({
      ...message,
      content: patchContent(message.content),
    }));
    return request;
  });
}

module.exports = { install, patchContent, isAgnes, AGNES_MARKER };
