'use strict';

/**
 * StreamVerse Studios — Audio Continuity Director
 *
 * Keeps ambience, music and dialogue continuity explicit across cuts without
 * asking the current FFmpeg compiler to perform audio synthesis.
 */

const { clean } = require('./directorState');

function buildAudioState(shot, previous = null) {
  const environment = clean(shot.environment_sound || shot.audio_environment || previous?.environment);
  const music = clean(shot.music_cue || shot.audio_music || previous?.music);
  const bridge = clean(shot.sound_bridge || previous?.bridge);

  return {
    environment,
    music,
    bridge,
    dialogue_mode: clean(shot.tts_mode || shot.dialogue_intent || 'ambient'),
    dialogue_present: Boolean(clean(shot.dialogue_or_action || shot.dialogue)),
  };
}

function applyAudioContinuity(script) {
  if (!script || !Array.isArray(script.scenes)) return script;

  let previous = null;
  for (const scene of script.scenes) {
    for (const shot of scene.shots || []) {
      const audio = buildAudioState(shot, previous);
      if (!audio.bridge && previous?.environment && audio.environment === previous.environment) {
        audio.bridge = previous.environment;
      }
      shot._audio_state = audio;
      shot.audio_continuity = {
        preserve_room_tone: Boolean(previous?.environment && audio.environment),
        preserve_music: Boolean(previous?.music && audio.music && previous.music === audio.music),
        use_sound_bridge: Boolean(audio.bridge),
      };
      previous = audio;
    }
  }
  return script;
}

module.exports = { buildAudioState, applyAudioContinuity };
