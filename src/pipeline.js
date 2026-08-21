'use strict';
const { v4: uuidv4 } = require('uuid');
const axios          = require('axios');
const config         = require('./config');
const db             = require('./db');
const state          = require('./state');
const telegram       = require('./telegram');
const cloudinary     = require('./cloudinary');
const imageGen                       = require('./imageGen');
const { CFSafetyRefusalError }       = require('./cfImageGen');
const ttsGen                         = require('./ttsGen');
// Video backend is selected by config.videoProvider (env VIDEO_PROVIDER,
// default 'ltx'). Both modules expose the same submitVideoJob/pollVideoJob
// interface, so nothing else in the pipeline needs to know which one is
// active. Set VIDEO_PROVIDER=magichour to roll back without a code change.
const videoGen        = config.videoProvider === 'magichour'
  ? require('./videoGen')
  : require('./ltxVideoGen');
const compiler       = require('./compiler');
const discord        = require('./discord');
const scriptWriter   = require('./scriptWriter');
const sceneState          = require('./sceneState');
const globalContinuity     = require('./globalContinuity');
const temporalConsistency = require('./temporalConsistency');
const cameraSim          = require('./cameraSim');
const motionSystem       = require('./motionSystem');
const shotStaging         = require('./shotStaging');
const constraintEnforcer = require('./constraintEnforcer');
const hardControl       = require('./hardControlLayers');
const { safeJsonParse } = require('./util');
const os             = require('os');
const fs             = require('fs');

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PIPELINE_CHECKPOINT_STAGE_ORDER = Object.freeze({
  blueprint: 10, shot_simulation: 20, shot_simulation_complete: 30,
  scene_shot_writing: 40, script_complete: 50, script_ready_for_processing: 60,
  simulation_chain_locked: 70, media_generation_ready: 80,
});
function _pipelineCheckpointRank(stage) {
  return PIPELINE_CHECKPOINT_STAGE_ORDER[String(stage || '').toLowerCase()] || 0;
}


/**
 * Pick a genre for a new series from the configured pool. Keep this helper local
 * to the pipeline so GENRE_POOL remains the single source of truth.
 */
function _pickRandomGenre() {
  const pool = Array.isArray(config.genrePool)
    ? config.genrePool.map(g => String(g || '').trim()).filter(Boolean)
    : [];
  if (!pool.length) return 'drama';
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Stable deterministic seed for a character reference identity. Uses the
 * character UUID when available so legacy/back-filled characters retain a
 * repeatable seed even when their name changes.
 */
function _charSeed(identity) {
  const value = String(identity || 'character');
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 9999999;
}

/**
 * Stable combined seed for a shot's character roster. The same ordered cast
 * should produce the same seed across retries/runs so identity references stay
 * deterministic without relying on a missing global helper.
 */
function _combinedSeed(chars) {
  const roster = (Array.isArray(chars) ? chars : [])
    .map(c => {
      const identity = c && (c.id || c.name || c.character_id || c.characterId);
      const seed = c && c.seed != null ? String(c.seed) : '';
      return `${String(identity || 'character')}|${seed}`;
    })
    .join('||') || 'empty-roster';
  return _charSeed(roster);
}

/**
 * Conservative negative prompt for still-frame generation. Keep it purely
 * visual; speech/audio/motion controls belong in the LTX prompt, not here.
 */
function _buildCharacterNegativePrompt(charsInShot) {
  const base = [
    'deformed face', 'duplicate person', 'merged faces', 'extra limbs',
    'extra fingers', 'missing fingers', 'distorted hands', 'bad anatomy',
    'wrong character identity', 'inconsistent face', 'inconsistent hair',
    'inconsistent wardrobe', 'duplicate characters', 'text', 'logo',
    'watermark', 'blurry face', 'low detail', 'cropped head'
  ];
  const names = (Array.isArray(charsInShot) ? charsInShot : [])
    .map(c => c?.name).filter(Boolean);
  return [...base, names.length ? `do not replace or invent characters: ${names.join(', ')}` : '']
    .filter(Boolean).join(', ');
}

/**
 * Detect MIME type from buffer magic bytes.
 * CF Worker AI can return PNG, JPEG, or WebP depending on model version.
 * Hardcoding "image/png" causes Cloudinary to reject or misclassify other formats.
 */
function _detectMime(buf) {
  if (!buf || buf.length < 12) return 'image/png';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)                      return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10]=== 0x42 && buf[11]=== 0x50)  return 'image/webp';
  // Unknown format: throw so the caller can handle it explicitly rather than uploading garbage
  throw new Error(`[_detectMime] Unrecognised image format — magic bytes: ${buf.slice(0,4).toString('hex')}`);
}

function diskUsageMB() {
  try {
    const stats = fs.statfsSync ? fs.statfsSync('/') : null;
    if (stats) return Math.round((stats.blocks - stats.bfree) * stats.bsize / 1024 / 1024);
    return Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);
  } catch { return 0; }
}

// ──────────────────────────────────────────────────────────────────────────────
// DB helpers (all ? placeholders — never string interpolation)
// ──────────────────────────────────────────────────────────────────────────────

function _continuityStateForScript(script) {
  const derived = globalContinuity.buildGlobalContinuityState(script || {});
  const supplied = script?.global_continuity_state;
  if (!supplied || typeof supplied !== 'object') return derived;

  return {
    ...derived,
    ...supplied,
    activeProps: [...new Set([...(derived.activeProps || []), ...(supplied.activeProps || [])])].slice(-6),
    unresolvedThreads: [...new Set([...(derived.unresolvedThreads || []), ...(supplied.unresolvedThreads || [])])].slice(-5),
    characterStates: { ...(derived.characterStates || {}), ...(supplied.characterStates || {}) },
    lastSceneNumber: supplied.lastSceneNumber ?? derived.lastSceneNumber ?? null,
  };
}

function _continuityJsonForScript(script) {
  return JSON.stringify(_continuityStateForScript(script));
}

async function getActiveStoryline() {
  return db.queryOne(`SELECT * FROM storylines WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`);
}

async function getRecentEpisodes(storylineId, limit = 5) {
  const safeLimit = parseInt(limit, 10) || 5;
  return db.query(
    `SELECT episode_number, script FROM episodes WHERE storyline_id = ? AND status = 'posted'
     ORDER BY episode_number DESC LIMIT ${safeLimit}`,
    [storylineId]
  );
}

async function getCharacters(storylineId) {
  return db.query(`SELECT * FROM characters WHERE storyline_id = ?`, [storylineId]);
}

async function insertStoryline(data) {
  const id = uuidv4();
  await db.execute(
    `INSERT INTO storylines
       (id, title, genre, character_bible, plot_summary, full_story_simulation, central_theme, tone_manifesto,
        visual_language, season_arcs, engagement_hook, premiere_announcement, logline,
        status, episode_count, current_season, current_episode, facebook_playlist_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 1, 0, ?)`,
    [
      id,
      data.title,
      data.genre,
      JSON.stringify(data.character_bible || []),
      data.plot_summary   || null,
      JSON.stringify(data.full_story_simulation || null),
      data.central_theme  || null,
      data.tone_manifesto || null,
      JSON.stringify(data.visual_language  || null),
      JSON.stringify(data.season_arcs      || []),
      data.engagement_hook          || null,
      data.premiere_announcement    || null,
      data.logline                  || null,
      data.facebook_playlist_id     || null,
    ]
  );
  return id;
}

/**
 * Adaptive character-reference portrait generation.
 *
 * Unlike the shot generator, canonical portraits used to have no intelligent retry path:
 * a CF 3030 content flag simply caused that angle to be skipped. This helper preserves the
 * deterministic character seed, asks the director/casting model to rewrite flagged prompts,
 * retries transient failures, and finishes with a conservative casting-photo prompt.
 */
async function _generateCharacterPortraitWithRecovery({ char, visualAnchor, angle, seed }) {
  const maxRetries = Math.max(2, Number(config.charRefMaxRetries || 5));
  let prompt = _buildCharacterPortraitPrompt(char, visualAnchor, angle);
  const negativePrompt = 'motion blur, text, watermark, logo, props, other people, bad anatomy, distorted face, extra limbs';
  let lastError = null;

  const conservativePrompt = () => {
    const safeAnchor = String(visualAnchor || char.description || '')
      .replace(/\b(?:blood|gore|wound|stab|shoot|shooting|gun|pistol|rifle|weapon|weapons|knife|knives|sword|dead|death|corpse|kill|killing|violent|violence|explosion|explode|fire|burning|fight|punch|attack|murder|war|combat|nude|naked|explicit|sexual|erotic|intimate|sensual|undress|lingerie|drug|drugs|poison|toxic|illegal|narcotic|injury|injured|abuse|assault|hostage|captivity)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const angleText = {
      front: 'front-facing head-and-shoulders adult casting portrait',
      three_quarter: 'three-quarter head-and-shoulders adult casting portrait, approximately 45 degrees',
      profile: 'clean left side-profile adult casting portrait',
      full_body: 'full-length adult casting portrait, neutral standing pose, both hands visible',
    }[angle] || 'front-facing adult casting portrait';

    return [
      'Professional actor casting reference photograph',
      'ONE fictional adult person only',
      char.name,
      safeAnchor,
      angleText,
      'neutral resting expression, mouth closed, eyes clearly visible',
      'plain dark neutral studio background',
      'soft studio key light and subtle fill light',
      'photorealistic natural skin and hair texture, crisp facial detail',
      '9:16 vertical portrait, single frame',
      'no other people, no props, no text, no logo, no watermark',
    ].filter(Boolean).join(', ');
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const imageBuffer = await imageGen.generateImage(prompt, [], seed, negativePrompt);
      console.log(`[Consistency] Portrait (${angle}) generated for ${char.name} on attempt ${attempt}/${maxRetries}`);
      return { imageBuffer, prompt, attempt };
    } catch (err) {
      lastError = err;
      const message = String(err?.message || '');
      const isSafety = err instanceof imageGen.CFSafetyRefusalError || err?.name === 'CFSafetyRefusalError' || /3030|content flagged/i.test(message);
      const isExhausted = /All CF Worker URLs and keys exhausted/i.test(message);
      const isTransient = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(err?.code) || /timeout|network|socket/i.test(message);

      if (isExhausted) throw err;
      if (attempt >= maxRetries) break;

      // First response to a safety refusal is always a fresh director rewrite.
      // After repeated failures, rewrite again so the next request is materially different.
      if (isSafety || attempt >= 2) {
        try {
          console.warn(`[Consistency] Portrait (${angle}) for ${char.name}: rewriting prompt after ${isSafety ? 'CF safety refusal' : 'generation failure'} (retry ${attempt + 1}/${maxRetries})`);
          prompt = await scriptWriter.rewriteCharacterPortraitPrompt({
            character: char,
            visualAnchor,
            angle,
            failedPrompt: prompt,
            reason: message,
            attempt: attempt + 1,
            maxRetries,
          });
        } catch (rewriteErr) {
          console.warn(`[Consistency] Portrait rewrite failed for ${char.name} (${angle}): ${rewriteErr.message}`);
          prompt = conservativePrompt();
        }
      } else if (isTransient) {
        await new Promise(resolve => setTimeout(resolve, Math.min(4000, 1000 * attempt)));
      }
    }
  }

  // Final deterministic fallback: a deliberately plain casting photograph with only safe identity traits.
  prompt = conservativePrompt();
  try {
    const imageBuffer = await imageGen.generateImage(prompt, [], seed, negativePrompt);
    console.log(`[Consistency] Portrait (${angle}) for ${char.name} generated on conservative final retry`);
    return { imageBuffer, prompt, attempt: maxRetries + 1 };
  } catch (finalErr) {
    lastError = finalErr;
  }

  throw lastError || new Error(`[Consistency] Portrait generation failed for ${char.name} (${angle})`);
}

/**
 * Insert characters and generate/store their visual anchors + reference portrait images.
 * This is the backbone of character consistency — runs once per new series.
 */
async function insertCharactersWithConsistency(storylineId, characterBible) {
  const results = [];
  for (const char of (characterBible || [])) {
    const existing = await db.queryOne(
      `SELECT id, visual_anchor, reference_image_url FROM characters WHERE storyline_id = ? AND name = ?`,
      [storylineId, char.name]
    );
    if (existing) {
      results.push({ ...char, ...existing });
      continue;
    }

    // 1. Generate immutable visual anchor string via LLM
    console.log(`[Consistency] Generating visual anchor for ${char.name}...`);
    let visualAnchor = null;
    try {
      visualAnchor = await scriptWriter.generateCharacterVisualAnchor(char);
    } catch (err) {
      console.warn(`[Consistency] Visual anchor generation failed for ${char.name}:`, err.message);
      visualAnchor = `${char.name}: ${char.description}`;
    }

    // 2. Generate canonical reference portrait images via CF Worker AI.
    // Multiple angles improve reference signal; the primary (front) portrait goes in
    // reference_image_url for backwards compat; all angles go in reference_image_urls JSON array.
    const charId = uuidv4();
    console.log(`[Consistency] Generating reference portrait(s) for ${char.name}...`);

    const angleCount  = Math.min(Math.max(config.charRefImageCount || 1, 1), 4);
    const angles      = ['front', 'three_quarter', 'profile', 'full_body'].slice(0, angleCount);
    const allPortraitUrls = [];
    // Negative prompt for portrait generation
    const portraitNeg = 'motion blur, text, watermark, logo, background elements, props, other people, bad anatomy, distorted face, extra limbs';

    for (const angle of angles) {
      try {
        const portraitSeed = char.seed != null ? char.seed : _charSeed(charId);
        const generated = await _generateCharacterPortraitWithRecovery({ char, visualAnchor, angle, seed: portraitSeed });
        const imageBuffer = generated.imageBuffer;
        const nameSlug       = char.name.replace(/\s+/g, '_').toLowerCase();
        const pubId          = `${config.charRefFolderRoot}/${storylineId}/${nameSlug}_${angle}`;
        const mime           = _detectMime(imageBuffer);
        const url = await cloudinary.uploadImageFromUrl(
          `data:${mime};base64,${imageBuffer.toString('base64')}`,
          pubId
        );
        allPortraitUrls.push(url);
        console.log(`[Consistency] Portrait (${angle}) for ${char.name} [${mime}] → ${url}`);
      } catch (err) {
        console.warn(`[Consistency] Portrait (${angle}) failed for ${char.name}:`, err.message);
      }
    }

    const referenceImageUrl  = allPortraitUrls[0] || null;
    const referenceImageUrls = JSON.stringify(allPortraitUrls);

    // Use the locked seed and voice_id from writeCastBible if available;
    // fall back to deterministic derivation from the character UUID.
    const charSeed = char.seed != null ? char.seed : _charSeed(charId);
    const voiceId  = char.voice_id || scriptWriter.assignVoiceForCharacter(char);
    // Deterministic age/gender/style voice profile for LTX's native audio
    // generation — assigned once here and reused in every LTX video prompt
    // (see pipeline.js _buildLtxVideoPrompt) so this character's spoken
    // delivery is consistent across every episode without an external TTS call.
    const voiceProfile = ttsGen.deriveVoiceProfile({ ...char, visual_anchor: visualAnchor });

    await db.execute(
      `INSERT INTO characters (id, storyline_id, name, description, visual_profile, visual_anchor, reference_image_url, reference_image_urls, voice_id, seed, voice_profile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        charId,
        storylineId,
        char.name,
        char.description || '',
        JSON.stringify(char.visual_profile || {}),
        visualAnchor,
        referenceImageUrl,
        referenceImageUrls,
        voiceId,
        charSeed,
        JSON.stringify(voiceProfile),
      ]
    );
    results.push({ id: charId, ...char, visual_anchor: visualAnchor, reference_image_url: referenceImageUrl, reference_image_urls: referenceImageUrls, voice_id: voiceId, seed: charSeed, voice_profile: voiceProfile });
  }
  return results;
}

/**
 * Ensure every existing character has a visual anchor and reference image.
 * Called when resuming an existing series that may have been created before this feature.
 */
async function ensureCharacterConsistency(storylineId) {
  const chars = await getCharacters(storylineId);
  for (const char of chars) {
    const needsAnchor = !char.visual_anchor;
    const needsPortrait = !char.reference_image_url;
    const needsVoiceProfile = !char.voice_profile;
    if (!needsAnchor && !needsPortrait && !needsVoiceProfile) continue;

    console.log(`[Consistency] Back-filling consistency data for ${char.name}...`);
    const updates = {};

    if (needsVoiceProfile) {
      updates.voice_profile = JSON.stringify(ttsGen.deriveVoiceProfile(char));
    }

    if (needsAnchor) {
      try {
        updates.visual_anchor = await scriptWriter.generateCharacterVisualAnchor({
          name:          char.name,
          description:   char.description,
          visual_profile: safeJsonParse(char.visual_profile, {}),
        });
      } catch (e) {
        console.warn(`[Consistency] Anchor back-fill failed for ${char.name}:`, e.message);
      }
    }

    if (needsPortrait) {
      const anchor    = updates.visual_anchor || char.visual_anchor || char.description;
      const nameSlug  = char.name.replace(/\s+/g, '_').toLowerCase();
      const angleCount = Math.min(Math.max(config.charRefImageCount || 1, 1), 4);
      const angles     = ['front', 'three_quarter', 'profile', 'full_body'].slice(0, angleCount);
      const portraitNeg = 'motion blur, text, watermark, logo, background elements, props, other people, bad anatomy, distorted face, extra limbs';
      const backfillUrls = [];

      for (const angle of angles) {
        try {
          const generated = await _generateCharacterPortraitWithRecovery({ char, visualAnchor: anchor, angle, seed: char.seed != null ? char.seed : _charSeed(char.id) });
          const imgBuffer = generated.imageBuffer;
          const pubId     = `${config.charRefFolderRoot}/${storylineId}/${nameSlug}_${angle}`;
          const mime      = _detectMime(imgBuffer);
          const url = await cloudinary.uploadImageFromUrl(
            `data:${mime};base64,${imgBuffer.toString('base64')}`,
            pubId
          );
          backfillUrls.push(url);
        } catch (e) {
          console.warn(`[Consistency] Portrait (${angle}) back-fill failed for ${char.name}:`, e.message);
        }
      }

      if (backfillUrls.length) {
        updates.reference_image_url  = backfillUrls[0];
        updates.reference_image_urls = JSON.stringify(backfillUrls);
      }
    }

    if (Object.keys(updates).length) {
      const sets  = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const vals  = [...Object.values(updates).map(v => v ?? null), char.id];
      await db.execute(`UPDATE characters SET ${sets} WHERE id = ?`, vals);
    }
  }
  // Return refreshed characters
  return getCharacters(storylineId);
}

async function updateStorylineAfterEpisode(storylineId, { plotSummary, episodeCount, currentSeason, currentEpisode, isCompleted }) {
  await db.execute(
    `UPDATE storylines SET plot_summary = ?, episode_count = ?, current_season = ?,
       current_episode = ?, status = ?,
       next_episode_due_date = DATE_ADD(NOW(), INTERVAL 1 DAY), updated_at = NOW()
     WHERE id = ?`,
    [plotSummary, episodeCount, currentSeason, currentEpisode,
     isCompleted ? 'completed' : 'active', storylineId]
  );
}

async function insertEpisode(data) {
  await db.execute(
    `INSERT INTO episodes
       (id, storyline_id, episode_number, season_number, script, scene_count, shot_count,
        video_url, facebook_video_link, status, safety_check_passed, safety_notes,
        global_continuity_state, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, NOW())`,
    [
      uuidv4(), data.storyline_id, data.episode_number, data.season_number,
      JSON.stringify(data.script), data.scene_count, data.shot_count,
      data.video_url || null, data.facebook_video_link || null,
      data.safety_check_passed ? 1 : 0, data.safety_notes || null,
      _continuityJsonForScript(data.script)
    ]
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Draft episode persistence — enables resume after Magic Hour credit exhaustion
// ──────────────────────────────────────────────────────────────────────────────

/** Return the most recent draft episode for a storyline (if any). */
async function getDraftEpisode(storylineId) {
  return db.queryOne(
    `SELECT * FROM episodes WHERE storyline_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`,
    [storylineId]
  );
}

/**
 * Return the most recent draft episode across ALL active storylines, plus its parent storyline.
 * Used at the top of _runPipeline to ensure a paused episode is always resumed before
 * starting new work — even if getActiveStoryline() would return a different series.
 */
async function getDraftEpisodeAny() {
  const draft = await db.queryOne(
    `SELECT e.* FROM episodes e
     JOIN storylines s ON e.storyline_id = s.id
     WHERE e.status IN ('draft','ready') AND s.status = 'active'
     ORDER BY e.created_at DESC LIMIT 1`
  );
  if (!draft) return null;
  const storyline = await db.queryOne(`SELECT * FROM storylines WHERE id = ?`, [draft.storyline_id]);
  return storyline ? { draft, storyline } : null;
}

/** Insert a new draft episode row and return its UUID. */
async function createDraftEpisode(data) {
  const id = uuidv4();
  await db.execute(
    `INSERT INTO episodes
       (id, storyline_id, episode_number, season_number, script, scene_count, shot_count,
        status, safety_check_passed, safety_notes, shot_state, scene_state, global_continuity_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, '{}', '{}', ?)`,
    [
      id, data.storyline_id, data.episode_number, data.season_number,
      JSON.stringify(data.script), data.scene_count, data.shot_count,
      data.safety_check_passed ? 1 : 0, data.safety_notes || null,
      _continuityJsonForScript(data.script),
    ]
  );
  return id;
}

/**
 * Persist scene compilation state and optional paused reason for a draft episode.
 * Shot state is now stored in the dedicated `shots` table (one row per shot) —
 * this function only handles scene_state and paused_reason.
 * Pass pausedReason to record why it stopped; pass null to clear it.
 */
async function saveDraftProgress(episodeId, sceneState, pausedReason) {
  await db.execute(
    `UPDATE episodes SET scene_state = ?, paused_reason = ? WHERE id = ?`,
    [JSON.stringify(sceneState), pausedReason ?? null, episodeId]
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Shot-table helpers — replace the old shot_state JSON blob
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Insert a pending row for every shot in allShots.
 * Uses INSERT IGNORE so it is safe to call on both fresh episodes and resumes.
 */
async function upsertShotRows(episodeId, allShots) {
  for (const shot of allShots) {
    const id = uuidv4();
    const motionParams = shot._motion_params ? JSON.stringify(shot._motion_params) : null;
    const constraintCheck = shot._constraint_check ? JSON.stringify(shot._constraint_check) : null;
    const hardControlData = shot._hard_control_result ? JSON.stringify(shot._hard_control_result) : null;
    const renderPass = shot._render_pass || 'draft';
    await db.execute(
      `INSERT IGNORE INTO shots (id, episode_id, scene_number, shot_index, status, motion_params, constraint_check, hard_control_data, render_pass)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [id, episodeId, shot.scene_number, shot.shot_index, motionParams, constraintCheck, hardControlData, renderPass]
    );
  }
}

/**
 * Update specific columns on a shot row.
 * Accepts a plain object of { column: value } pairs.
 */
async function updateShotRow(episodeId, sceneNumber, shotIndex, updates) {
  const keys = Object.keys(updates);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = [...keys.map(k => updates[k] ?? null), episodeId, sceneNumber, shotIndex];
  await db.execute(
    `UPDATE shots SET ${sets} WHERE episode_id = ? AND scene_number = ? AND shot_index = ?`,
    vals
  );
}

/**
 * Fetch all shot rows for an episode, ordered by scene then shot index.
 * Returns a Map keyed by `"${scene_number}_${shot_index}"` for O(1) lookup.
 */
async function getShotRowMap(episodeId) {
  const rows = await db.query(
    `SELECT * FROM shots WHERE episode_id = ? ORDER BY scene_number, shot_index`,
    [episodeId]
  );
  return new Map(rows.map(r => [`${r.scene_number}_${r.shot_index}`, r]));
}

/**
 * Save the final generated video URL to a draft without finalising it.
 * Used when the video is fully built but Discord publishing failed —
 * the episode stays as a draft so Resume can retry only the Discord step.
 */
async function saveDraftVideoUrl(episodeId, videoUrl, pausedReason) {
  await db.execute(
    `UPDATE episodes SET video_url = ?, paused_reason = ? WHERE id = ? AND status = 'draft'`,
    [videoUrl, pausedReason ?? null, episodeId]
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Pacing enforcement — validate / clamp scene durations after LLM generation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Validate and enforce semantic LTX pacing on the generated episode script.
 * Every LTX shot gets an 8–10s semantic temporal canvas; dialogue length is only one input.
 * Environmental storytelling and within-shot progression contribute to the duration.
 *
 * Returns the modified script object.
 */
// Non-dialogue pacing base durations (seconds). These are starting points
// only — the final clip_duration is adjusted by narrative_complexity.
const _SEMANTIC_MIN_DURATION = 8.0;
const _SEMANTIC_TARGET_DURATION = 9.25;
const _SEMANTIC_MAX_DURATION = 10.0;

const _PACING_BONUS = {
  hook: 0.25, action: 0.35, reaction: 0.45, broll_cutaway: 0.35,
  establishing: 0.65, slow_dramatic: 0.9, dialogue_mid: 0.35, dialogue_full: 0.7,
};
const _COMPLEXITY_WEIGHT = { low: 0.15, medium: 0.45, high: 0.8 };
const MAX_SHOT_DURATION = 10.0;

function _wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function _calculateDynamicDuration(shot) {
  const pacingType = shot.shot_pacing_type || 'action';
  const complexity = shot.narrative_complexity || 'medium';
  const ttsMode = shot.tts_mode || '';
  const spokenText = ttsGen.extractDialogueText(shot.dialogue_or_action);
  const spokenDuration = spokenText ? ttsGen.estimateSpokenDuration(spokenText) : 0;
  const semanticText = [
    shot.shot_description, shot.shot_purpose, shot.emotional_subtext, shot.pose_state,
    shot.subject_motion, shot.ambient_motion, shot.camera_movement,
    shot.environmental_story_beat, shot.temporal_arc, shot.scene_environment, shot.dialogue_or_action,
  ].filter(Boolean).join(' ');
  const semanticWords = _wordCount(semanticText);
  const semanticWeight = Math.min(1, semanticWords / 85);
  const environmentWords = _wordCount(shot.environmental_story_beat || shot.scene_environment);
  const environmentWeight = Math.min(1, environmentWords / 35);
  const progressionWeight = shot.temporal_arc ? Math.min(1, _wordCount(shot.temporal_arc) / 24) : 0;
  const complexityWeight = _COMPLEXITY_WEIGHT[complexity] ?? _COMPLEXITY_WEIGHT.medium;
  const pacingBonus = _PACING_BONUS[pacingType] || 0.35;

  let target = _SEMANTIC_TARGET_DURATION
    + semanticWeight * 0.55
    + environmentWeight * 0.7
    + progressionWeight * 0.45
    + complexityWeight * 0.55
    + pacingBonus;

  if ((ttsMode === 'spoken' || ttsMode === 'internal_monologue' || ttsMode === 'phone_vo' || spokenText) && spokenDuration > 0) {
    target = Math.max(target, spokenDuration + 1.25);
  }
  target = Math.max(_SEMANTIC_MIN_DURATION, Math.min(_SEMANTIC_MAX_DURATION, target));
  return {
    duration: Math.round(target * 10) / 10,
    source: `semantic:${semanticWords}w|env:${environmentWords}w|progression:${progressionWeight.toFixed(2)}|spoken:${spokenDuration.toFixed(1)}s|complexity:${complexity}|pacing:${pacingType}`,
  };
}

/**
 * Normalize multi-speaker shots — the hard programmatic backstop.
 *
 * Fast video models (ltx-2.3-fast) cannot handle multiple characters speaking
 * in the same shot. This causes voice blending and broken lip sync. Even with
 * LLM instructions, the model occasionally produces multi-speaker shots. This
 * function detects and splits them.
 *
 * Detection: parse `dialogue_or_action` for multiple speaker prefixes
 * (e.g. "MAYA: ... ELIJAH: ..."). If found, split into N separate shots, one
 * per speaker. Each split shot inherits the scene context but gets its own
 * shot_index, image_prompt (annotated with speaker/silent status), and
 * characters_in_shot (reduced to just the speaker).
 *
 * Also detects shots where characters_in_shot lists multiple characters AND
 * the dialogue_or_action has no clear single speaker — in that case, keeps
 * only the first character and marks the rest as silent.
 */

/**
 * Normalize LLM-produced shot/scene scalar fields before downstream
 * cinematic/state engines consume them. LLM structured output can legally
 * return an object/array where a prose field was expected; downstream
 * engines must never crash on such shape drift.
 */
function _coerceProductionText(value, fallback = '') {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(v => _coerceProductionText(v, '')).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const preferredKeys = [
      'text', 'description', 'value', 'label', 'name',
      'framing', 'camera_type', 'shot_type', 'prompt',
    ];
    for (const key of preferredKeys) {
      if (value[key] != null) {
        const text = _coerceProductionText(value[key], '');
        if (text) return text;
      }
    }
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function _normalizeProductionSchemaTypes(script) {
  if (!script || !Array.isArray(script.scenes)) return script;

  let normalizedFields = 0;
  const noteNormalization = (field, before, after) => {
    if (before !== after) normalizedFields++;
  };

  const shotTextFields = [
    'shot_type',
    'shot_purpose',
    'shot_description',
    'camera_type',
    'camera_movement',
    'focal_length_hint',
    'depth_layering',
    'character_positions',
    'start_frame_state',
    'end_frame_state',
    'emotional_subtext',
    'environmental_story_beat',
    'temporal_arc',
    'end_frame_transition',
    'next_shot_continuity',
    'scene_environment',
    'pose_state',
    'image_prompt',
    'shot_pacing_type',
    'narrative_complexity',
    'motion_level',
    'subject_motion',
    'ambient_motion',
    'music_cue',
    'music_reason',
    'tts_mode',
    'dialogue_or_action',
    'framing',
    'emotional_intensity',
    'music_direction',
  ];

  for (const scene of script.scenes) {
    if (!scene || typeof scene !== 'object') continue;

    const sceneTextFields = [
      'location',
      'lighting_design',
      'scene_description',
      'emotional_beat',
      'director_note',
      'visual_description',
    ];

    for (const field of sceneTextFields) {
      if (scene[field] != null) {
        const before = scene[field];
        scene[field] = _coerceProductionText(scene[field], '');
        noteNormalization(field, before, scene[field]);
      }
    }

    if (!Array.isArray(scene.shots)) {
      scene.shots = [];
      continue;
    }

    for (const shot of scene.shots) {
      if (!shot || typeof shot !== 'object') continue;

      for (const field of shotTextFields) {
        if (shot[field] != null) {
          const before = shot[field];
          shot[field] = _coerceProductionText(shot[field], '');
          noteNormalization(field, before, shot[field]);
        }
      }

      if (!Array.isArray(shot.characters_in_shot)) {
        shot.characters_in_shot = shot.characters_in_shot == null
          ? []
          : [_coerceProductionText(shot.characters_in_shot, '')].filter(Boolean);
      } else {
        shot.characters_in_shot = shot.characters_in_shot
          .map(name => _coerceProductionText(name, ''))
          .filter(Boolean);
      }

      if (!Array.isArray(shot.speakers_in_shot)) {
        shot.speakers_in_shot = shot.speakers_in_shot == null
          ? []
          : [_coerceProductionText(shot.speakers_in_shot, '')].filter(Boolean);
      } else {
        shot.speakers_in_shot = shot.speakers_in_shot
          .map(name => _coerceProductionText(name, ''))
          .filter(Boolean);
      }

      // Numeric production fields: preserve valid numbers, coerce numeric strings.
      for (const field of [
        'shot_index',
        'scene_number',
        'duration',
        'clip_duration',
        'motion_intensity',
      ]) {
        if (shot[field] == null || typeof shot[field] === 'number') continue;
        const n = Number(shot[field]);
        if (Number.isFinite(n)) shot[field] = n;
      }

      // Never allow a non-finite / object duration to escape downstream.
      if (!Number.isFinite(Number(shot.clip_duration))) {
        shot.clip_duration = null;
      }
      if (!Number.isFinite(Number(shot.duration))) {
        shot.duration = null;
      }
    }
  }

  if (normalizedFields > 0) {
    console.warn(`[Pipeline] Normalized ${normalizedFields} LLM production field shape(s) before cinematic post-processing`);
  }
  return script;
}

function _normalizeMultiSpeakerShots(script) {
  if (!script || !script.scenes) return script;
  for (const scene of script.scenes) {
    for (const shot of scene.shots || []) {
      const speakers = _detectMultipleSpeakers(shot.dialogue_or_action || '');
      if (speakers.length) {
        shot.speakers_in_shot = speakers;
        shot.speaker_name = speakers.length === 1 ? speakers[0] : null;
        const current = Array.isArray(shot.characters_in_shot) ? [...shot.characters_in_shot] : [];
        for (const speaker of speakers) if (!current.some(name => _namesMatch(name, speaker))) current.push(speaker);
        shot.characters_in_shot = current;
        if (speakers.length > 1) {
          shot._multi_speaker = true;
          shot._multi_speaker_note = `Shared composition: ${speakers.join(' and ')} remain visible in declared positions and exchange spoken lines chronologically.`;
        }
      } else shot.speakers_in_shot = Array.isArray(shot.speakers_in_shot) ? shot.speakers_in_shot : [];
    }
  }
  return script;
}

function _applyShotFrameHandoffs(script) {
  if (!script?.scenes) return script;
  for (const scene of script.scenes) {
    const shots = scene.shots || [];
    for (let i = 1; i < shots.length; i++) {
      const prev = shots[i - 1], shot = shots[i];
      const prevLoc = String(prev._scene_location || scene.location || '').trim().toLowerCase();
      const shotLoc = String(shot._scene_location || scene.location || '').trim().toLowerCase();
      const handoff = String(prev.end_frame_state || prev.end_frame_transition || prev.next_shot_continuity || '').trim();
      if (handoff && prevLoc === shotLoc) {
        shot.start_frame_state = handoff;
        shot._start_frame_handoff = handoff;
        shot._continuity_transition = 'direct_end_frame_handoff';
      } else if (prevLoc !== shotLoc) shot._continuity_transition = 'context_change';
    }
  }
  return script;
}
/**
 * Detect multiple speaker prefixes in a dialogue_or_action string.
 * Returns an array of speaker names (deduplicated, preserving order).
 *
 * "MAYA: I can't. ELIJAH: You must." → ["Maya", "Elijah"]
 * "She walks to the door." → []
 */
function _detectMultipleSpeakers(dialogue) {
  if (!dialogue || typeof dialogue !== 'string') return [];

  // Match speaker prefixes: "NAME: text" where NAME is 1-5 words
  // Reuse the same permissive pattern as ttsGen.extractSpeakerName
  const speakerPattern = /([A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*(?:\s+[A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*){0,4})\s*:\s+/g;

  const speakers = [];
  let match;
  while ((match = speakerPattern.exec(dialogue)) !== null) {
    const raw = match[1].trim().toLowerCase();
    // Skip stage direction phrases
    const STAGE_STARTS = ['note', 'cut to', 'fade', 'smash cut', 'int', 'ext', 'scene', 'action'];
    if (STAGE_STARTS.some(s => raw.startsWith(s))) continue;

    const name = match[1].trim()
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');

    // Deduplicate (case-insensitive)
    if (!speakers.some(s => s.toLowerCase() === name.toLowerCase())) {
      speakers.push(name);
    }
  }

  return speakers;
}

/**
 * Split a multi-speaker dialogue_or_action into individual speaker lines.
 * Returns [{ speaker, text }, ...]
 *
 * "MAYA: I can't believe this. ELIJAH: Neither can I." →
 *   [{ speaker: "Maya", text: "I can't believe this." },
 *    { speaker: "Elijah", text: "Neither can I." }]
 */
function _splitDialogueBySpeaker(dialogue, speakers) {
  if (!dialogue || speakers.length === 0) return [];

  // Build a regex that splits on any speaker prefix
  const speakerPattern = /([A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*(?:\s+[A-Za-záéíóúÁÉÍÓÚ][A-Za-záéíóúÁÉÍÓÚ'.]*){0,4})\s*:\s+/g;

  const segments = [];
  let lastIndex = 0;
  let lastSpeaker = null;
  let match;

  // Find all speaker prefixes and extract the text between them
  const matches = [...dialogue.matchAll(speakerPattern)];
  if (matches.length === 0) return [{ speaker: speakers[0], text: dialogue.trim() }];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const raw = m[1].trim().toLowerCase();
    const STAGE_STARTS = ['note', 'cut to', 'fade', 'smash cut', 'int', 'ext', 'scene', 'action'];
    if (STAGE_STARTS.some(s => raw.startsWith(s))) continue;

    const speaker = m[1].trim()
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');

    if (lastSpeaker) {
      const text = dialogue.slice(lastIndex, m.index).trim();
      if (text) segments.push({ speaker: lastSpeaker, text });
    }
    lastSpeaker = speaker;
    lastIndex = m.index + m[0].length;
  }

  // Push the last segment
  if (lastSpeaker) {
    const text = dialogue.slice(lastIndex).trim();
    if (text) segments.push({ speaker: lastSpeaker, text });
  }

  return segments;
}

/**
 * Check if two names refer to the same character (case-insensitive, partial match).
 */
function _namesMatch(a, b) {
  if (!a || !b) return false;
  const an = a.toLowerCase().trim();
  const bn = b.toLowerCase().trim();
  return an === bn || an.includes(bn) || bn.includes(an);
}

/**
 * Apply cinematic shot-reverse-shot grammar to each scene.
 *
 * Runs AFTER _normalizeMultiSpeakerShots so every shot has at most one speaker.
 * This function transforms flat dialogue sequences into natural film-style
 * shot patterns using close-ups, reverse close-ups, over-the-shoulder (OTS)
 * reaction shots, and optional emotional reaction inserts.
 *
 * Rules:
 *   1. SPEAKING SHOT → close-up, face-focused
 *   2. SPEAKER CHANGE → reverse close-up, eyeline continuity maintained
 *   3. LISTENER / REACTION → over-the-shoulder, listener face visible
 *   4. HIGH EMOTIONAL INTENSITY → insert a silent reaction shot
 *   5. Visual continuity: consistent screen direction, eyeline matching
 */
function _applyCinematicShotSelection(script) {
  if (!script || !script.scenes) return script;

  let totalInserts = 0;

  for (const scene of script.scenes) {
    const shots = scene.shots || [];
    if (shots.length === 0) continue;

    const newShots = [];
    let prevSpeaker = null;
    let prevScreenDirection = null; // 'left' or 'right'

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const speaker = shot.speaker_name || _detectMultipleSpeakers(shot.dialogue_or_action || '')[0] || null;
      const isDialogue = shot.tts_mode === 'spoken' ||
                         shot.shot_pacing_type === 'dialogue_mid' ||
                         shot.shot_pacing_type === 'dialogue_full';
      const isPhoneVO = shot.tts_mode === 'phone_vo';

      // ── Phone call handling ───────────────────────────────────────────
      // A phone_vo shot can be either:
      //   (a) VISIBLE character speaking INTO the phone — needs a close-up
      //       so lip-sync works (talking-photo path).
      //   (b) REMOTE caller speaking (VO) — the visible character is
      //       listening, must NOT lip-sync. Medium shot, no mouth movement.
      // We distinguish by checking whether the speaker matches a character
      // actually in the shot (characters_in_shot). If the speaker is NOT
      // visible, it's case (b) — the remote caller's voice plays as VO.
      if (isPhoneVO) {
        const visibleChars = (shot.characters_in_shot || []).map(n => String(n).toLowerCase());
        const speakerIsVisible = speaker && visibleChars.some(vc => _namesMatch(vc, speaker));

        if (speakerIsVisible) {
          // ── (a) Visible character speaks into phone → close-up, lip-sync ON ──
          const speakerChanged = prevSpeaker && speaker &&
            !_namesMatch(prevSpeaker, speaker);
          const screenDirection = speakerChanged
            ? (prevScreenDirection === 'left' ? 'right' : 'left')
            : (prevScreenDirection || 'left');
          prevScreenDirection = screenDirection;

          shot.camera_type = 'close-up';
          shot.shot_type = 'CU'; // ensure shouldUseTalkingPhoto permits lip-sync
          shot.shot_pacing_type = shot.shot_pacing_type || 'dialogue_mid';
          shot.framing = `tight close-up of ${speaker} on the phone, face-focused, emotional clarity, mouth open mid-word as if caught mid-sentence, facing ${screenDirection === 'left' ? 'screen-left' : 'screen-right'}`;
          shot._cinematic_note = `Phone close-up — ${speaker} speaks into the phone. Lip-sync active.`;
          shot._one_speaker_note = shot._one_speaker_note ||
            `${speaker} is speaking into the phone. All other characters are silent with no mouth movement.`;
          shot._screen_direction = screenDirection;
          // Keep tts_mode as phone_vo so TTS audio generates, but mark that
          // the visible character IS the speaker so shouldUseTalkingPhoto
          // knows to enable lip-sync.
          shot._phone_speaker_visible = true;
          newShots.push(shot);
          prevSpeaker = speaker;
          continue;
        } else {
          // ── (b) Remote caller speaks (VO) → visible character silent ──
          shot.camera_type = 'medium';
          shot.framing = 'visible character listening to phone, no lip movement, mouth closed, reacting to the remote voice';
          shot._cinematic_note = `${speaker || 'Remote caller'} is on the phone (VO). Visible character is silent, listening — no lip movement.`;
          shot._one_speaker_note = shot._one_speaker_note ||
            `Phone call VO — remote speaker is heard, visible character is silent with no mouth movement.`;
          shot._phone_speaker_visible = false;
          newShots.push(shot);
          prevSpeaker = speaker;
          continue;
        }
      }

      const shotSpeakers = Array.isArray(shot.speakers_in_shot) ? shot.speakers_in_shot.filter(Boolean) : _detectMultipleSpeakers(shot.dialogue_or_action || '');
      if (isDialogue && shotSpeakers.length > 1) {
        shot._multi_speaker = true;
        shot.camera_type = shot.camera_type || 'medium two-shot';
        shot.framing = shot.framing || shot.character_positions || `shared composition of ${shotSpeakers.join(' and ')}`;
        shot._cinematic_note = `Shared dialogue composition — ${shotSpeakers.join(', ')} remain visible in their declared positions and exchange lines chronologically.`;
        newShots.push(shot);
        prevSpeaker = shotSpeakers[shotSpeakers.length - 1] || speaker;
        continue;
      }

      if (!isDialogue || !speaker) {
        // Non-dialogue shot — keep as-is, assign a default camera if none
        if (!shot.camera_type) {
          shot.camera_type = shot.shot_type === 'ECU' ? 'extreme-close-up' :
                             shot.shot_type === 'CU' ? 'close-up' :
                             shot.shot_type === 'MCU' ? 'medium-close-up' :
                             shot.shot_type === 'WS' ? 'wide-shot' :
                             shot.shot_type === 'OTS' ? 'over-the-shoulder' :
                             'medium';
        }
        if (!shot.framing) {
          shot.framing = 'standard framing for scene action';
        }
        newShots.push(shot);
        prevSpeaker = speaker;
        continue;
      }

      // ── Dialogue shot — apply shot-reverse-shot grammar ────────────────
      const speakerChanged = prevSpeaker && speaker &&
        !_namesMatch(prevSpeaker, speaker);

      // Determine screen direction for eyeline continuity
      // Alternate left/right on speaker change for natural conversation geometry
      const screenDirection = speakerChanged
        ? (prevScreenDirection === 'left' ? 'right' : 'left')
        : (prevScreenDirection || 'left');
      prevScreenDirection = screenDirection;

      if (speakerChanged) {
        // ── Rule 2: SPEAKER CHANGE → reverse close-up ──
        shot.camera_type = 'reverse-close-up';
        shot.framing = `tight close-up of ${speaker}, delivering dialogue, facing ${screenDirection === 'left' ? 'screen-right' : 'screen-left'}`;
        shot._cinematic_note = `Reverse close-up — ${speaker} responds. Eyeline matches previous shot.`;
      } else {
        // ── Rule 1: SPEAKING SHOT → close-up ──
        shot.camera_type = 'close-up';
        shot.framing = `tight close-up of ${speaker}, face-focused, emotional clarity, facing ${screenDirection === 'left' ? 'screen-left' : 'screen-right'}`;
        shot._cinematic_note = `Close-up — ${speaker} speaks.`;
      }
      shot._screen_direction = screenDirection;

      // ── Rule 3: If next shot is a different speaker, convert current to OTS ──
      // When the next shot is a speaker change, make the current shot an OTS
      // so the transition to the reverse feels natural.
      const nextShot = shots[i + 1];
      const nextSpeaker = nextShot
        ? (nextShot.speaker_name || _detectMultipleSpeakers(nextShot.dialogue_or_action || '')[0] || null)
        : null;
      if (nextShot && nextSpeaker && !_namesMatch(nextSpeaker, speaker) &&
          (nextShot.tts_mode === 'spoken' || nextShot.shot_pacing_type === 'dialogue_mid' || nextShot.shot_pacing_type === 'dialogue_full')) {
        // Convert to OTS looking toward the next speaker
        shot.camera_type = 'over-the-shoulder';
        shot.framing = `over-the-shoulder shot from ${speaker} toward ${nextSpeaker}, ${speaker}'s shoulder blurred in foreground, ${nextSpeaker} visible in background`;
        shot._cinematic_note = `OTS — ${speaker} speaks, ${nextSpeaker} visible as listener. Sets up reverse cut.`;
        shot._ots_speaker = speaker;
        shot._ots_listener = nextSpeaker;
      }

      newShots.push(shot);

      // ── Rule 4: Optional reaction insert after high-emotion dialogue ──
      // Insert a silent reaction shot when emotional intensity is high and
      // the next shot is a speaker change (the reaction beat lives between them).
      const emotionIntensity = (shot.emotional_intensity || '').toLowerCase();
      const isHighEmotion = emotionIntensity === 'high' ||
                            (shot.narrative_complexity === 'high' && isDialogue);
      if (isHighEmotion && nextShot && nextSpeaker && !_namesMatch(nextSpeaker, speaker)) {
        const reactionShot = {
          shot_index: shot.shot_index + 0.5,
          scene_number: shot.scene_number,
          dialogue_or_action: '',
          characters_in_shot: [nextSpeaker],
          speaker_name: null,
          tts_mode: 'ambient',
          shot_pacing_type: 'reaction',
          shot_type: 'CU',
          camera_type: 'close-up',
          framing: `tight close-up of ${nextSpeaker} reacting silently, emotional response visible on face`,
          clip_duration: 1.5,
          duration: 4,
          motion_level: 'low',
          image_prompt: `Silent reaction shot — ${nextSpeaker}'s face, emotional response, no dialogue, lips closed, no mouth movement. Close-up, cinematic.`,
          _cinematic_note: `Reaction insert — ${nextSpeaker} reacts silently to ${speaker}'s line.`,
          _one_speaker_note: `${nextSpeaker} is silent, no mouth movement. No one is speaking in this shot.`,
          _is_reaction_insert: true,
          _screen_direction: screenDirection === 'left' ? 'right' : 'left',
        };
        newShots.push(reactionShot);
        totalInserts++;
      }

      prevSpeaker = speaker;
    }

    // Re-index shots sequentially after inserts
    let idx = 0;
    for (const s of newShots) {
      s._original_shot_index = s.shot_index;
      s.shot_index = ++idx;
    }
    scene.shots = newShots;
  }

  if (totalInserts > 0) {
    console.log(`[CinematicShots] Inserted ${totalInserts} reaction shot(s) across scenes`);
  }

  return script;
}

/**
 * Attach a single, episode-wide background-music/score description to every
 * shot in every scene, so the video model gets the SAME music direction for
 * the whole episode instead of inventing a new mood/instrumentation per shot
 * (which is what caused the background music to jump between unrelated
 * tracks from shot to shot). The director (scriptWriter) writes one
 * `music_direction` string for the whole episode; this just fans it out.
 */
function _attachMusicDirection(script) {
  const musicDirection = (script?.music_direction || '').trim()
    || 'A restrained cinematic score palette used selectively for moments that genuinely benefit from music; sparse instrumentation, subtle dynamics, and no constant underscore.';

  script.music_direction = musicDirection; // normalize so it is persisted with the saved script too

  for (const scene of script?.scenes || []) {
    for (const shot of scene.shots || []) {
      // Keep the episode-wide composer reference available, but DO NOT automatically turn
      // it into per-shot music. The director controls usage with music_cue.
      shot.music_cue = String(shot.music_cue || 'none').toLowerCase();
      if (!['none', 'subtle', 'prominent'].includes(shot.music_cue)) shot.music_cue = 'none';
      shot._music_direction = musicDirection;
      if (shot.music_cue !== 'none' && !shot.music_reason) {
        shot.music_reason = 'Story context calls for selective background score.';
      }
    }
  }
  return script;
}

function _enforcePacingRules(script) {
  const scenes = script?.scenes || [];

  for (const scene of scenes) {
    const shots = scene.shots || [];

    for (const shot of shots) {
      // ── Dynamic duration calculation ───────────────────────────────────
      // clip_duration is computed from spoken text length + narrative complexity,
      // NOT from a static time block. Capped at 12 seconds.
      const { duration: dynDuration, source } = _calculateDynamicDuration(shot);
      shot.clip_duration = dynDuration;
      shot.duration_source = source;

      // ── Raw generation duration sent to the video backend ────────────────
      // Previously hardcoded to 4–5s (Magic Hour's practical window). LTX has
      // no such fixed constraint, so the raw generation duration now IS the
      // weighted, human-paced duration computed above — just clamped into
      // whatever range the active backend can actually accept
      // (config.ltxMinDuration/ltxMaxDuration for LTX; Magic Hour still gets
      // its historical 4–5s clamp when VIDEO_PROVIDER=magichour).
      if (config.videoProvider === 'magichour') {
        if (!shot.duration || shot.duration < 4) shot.duration = 5;
        if (shot.duration > 5) shot.duration = 5;
      } else {
        shot.duration = Math.min(
          config.ltxMaxDuration,
          Math.max(config.ltxMinDuration, dynDuration)
        );
      }
    }

    // ── Scene total — informational log only, no cap enforced ────────────
    const sceneTotal = shots.reduce((s, sh) => s + (sh.clip_duration || 4), 0);
    if (sceneTotal > 20) {
      console.log(
        `[Pacing] Scene ${scene.scene_number}: ${sceneTotal.toFixed(1)}s — director's choice kept`
      );
    }
  }

  // Opening hooks stay compelling but use the same full LTX temporal canvas.
  if (scenes.length > 0) {
    for (const firstShot of (scenes[0].shots || []).slice(0, 2)) {
      if (firstShot.clip_duration < 8) {
        firstShot.clip_duration = 8.0;
        firstShot.duration = 8.0;
        firstShot.duration_source = `${firstShot.duration_source || 'semantic'}|opening_hook_floor`;
      }
    }
  }

  return script;
}

/** Convert a completed draft to posted status, clearing transient state columns. */
async function markEpisodeReady(episodeId, data) {
  await db.execute(`UPDATE episodes SET status='ready', video_url=?, ready_at=NOW(), paused_reason=NULL, facebook_video_link=NULL, posted_at=NULL WHERE id=?`, [data.video_url || null, episodeId]);
}

async function publishEpisode(episodeId) {
  if (_recompileRunning) return { ok: false, error: 'Another recompile/regenerate is running' };
  const episode = await db.queryOne(`SELECT * FROM episodes WHERE id=?`, [episodeId]);
  if (!episode) return { ok:false, error:'Episode not found' };
  if (episode.status !== 'ready' || !episode.video_url) return { ok:false, error:'Episode must be READY with a final video' };
  const storyline = await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [episode.storyline_id]);
  if (!storyline) return { ok:false, error:'Storyline not found' };
  const script = safeJsonParse(episode.script, {});
  const title = `${storyline.title} — S${episode.season_number}E${String(episode.episode_number).padStart(2,'0')} — ${script.episode_title || ''}`;
  const caption = script.caption || script.synopsis || script.logline || '';
  const hashtags = `#StreamVerseStudios #AIFilm #${String(storyline.genre || '').replace(/[^a-z0-9]/gi,'')}`;
  try {
    state.setStatus(state.STATES.UPLOADING_FB, `Publishing ${title}...`);
    const publishResult = await discord.postEpisode({ videoUrl: episode.video_url, title, caption, hashtags });
    if (!publishResult) throw new Error('Discord publication did not complete: WEBHOOK_URL is missing or publish returned no URL');
    const nextGlobalEpisodeNumber = (storyline.episode_count || 0) + 1;
    const isSeriesMovie = episode.season_number > config.seasonsPerSeries || (episode.season_number === config.seasonsPerSeries && episode.episode_number === config.episodesPerSeason);
    await updateStorylineAfterEpisode(storyline.id, { plotSummary: script.updated_plot_summary || storyline.plot_summary, episodeCount: nextGlobalEpisodeNumber, currentSeason: episode.season_number, currentEpisode: episode.episode_number, isCompleted: isSeriesMovie });
    await db.execute(`UPDATE episodes SET status='posted', facebook_video_link=?, posted_at=NOW(), paused_reason=NULL, shot_state=NULL WHERE id=?`, [publishResult || episode.video_url, episodeId]);
    state.setStatus(state.STATES.IDLE); state.setCurrentEpisode(null);
    await telegram.sendTelegram(`✅ <b>Published S${episode.season_number}E${String(episode.episode_number).padStart(2,'0')}</b> of "<b>${storyline.title}</b>"`).catch(()=>{});
    return { ok:true, episodeId, status:'posted', videoUrl:episode.video_url, publishResult };
  } catch (err) {
    state.setStatus(state.STATES.ERROR, `Publish failed — ${err.message}`);
    return { ok:false, error:err.message };
  }
}
// ──────────────────────────────────────────────────────────────────────────────
// Shot generation with retry
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Sanitise a shot image_prompt that triggered a Google Gemini safety filter.
 * Strips known trigger terms and appends safety-friendly qualifiers so the
 * retry has a real chance of passing without losing the cinematic intent.
 */
/**
 * Filmmaker-style prompt rewriter for content-flagged prompts.
 *
 * Instead of blindly deleting flagged words, this uses the LLM (Mistral/Groq)
 * to rewrite the prompt the way a human film director would: preserve the
 * dramatic intent and visual storytelling while eliminating any elements
 * that trigger content filters. The director thinks in cinematic language —
 * implication, suggestion, reaction shots — rather than explicit depiction.
 *
 * Falls back to the old sanitizer if the LLM is unavailable.
 */
async function _rewriteFlaggedPrompt(imagePrompt, shot, storyline, reason) {
  if (!imagePrompt) return 'cinematic portrait, neutral expression, professional studio lighting, 9:16 vertical';

  const sceneNum = shot?.scene_number ?? '?';
  const shotIdx  = shot?.shot_index  ?? '?';
  const chars   = (shot?.characters_in_shot || []).join(', ') || 'unknown';
  const genre   = storyline?.genre || 'drama';

  const systemPrompt = `You are a team of experienced human filmmakers — a director, cinematographer, and script supervisor — working together to rewrite an AI image generation prompt that was flagged by a content safety filter.

Your collective mindset:
- Directors think in emotional beats and dramatic subtext, not literal depictions.
- Cinematographers think in light, shadow, composition, and implication.
- Script supervisors think in continuity and character consistency.

When a scene is flagged, you NEVER drop the shot. Instead you find a tasteful, cinematic way to convey the SAME dramatic moment through:
  • Implication (show the aftermath, not the act)
  • Reaction shots (show faces reacting to what happened off-frame)
  • Symbolic imagery (objects, shadows, environmental details that carry the emotion)
  • Suggestion (tension in posture, fear in eyes, hands gripping, bodies recoiling)
  • Creative framing (close-up on hands, wide shot from a distance, silhouette)

You keep the scene's characters, location, lighting, and emotional tone intact.
You describe an ordinary, benign cinematic still image as clearly and concretely as possible. The scene is fictional and presented as a professional film frame; describe only visible people, clothing, setting, pose, expression, lighting, composition, and atmosphere. Do not include graphic detail, sexualized detail, or instructions to bypass a safety system. The goal is a truthful, non-ambiguous visual description that a still-image generator can safely interpret.
You output ONLY the rewritten image prompt text — no JSON, no explanation, no meta-commentary.`;

  const userPrompt = `Original flagged prompt (Scene ${sceneNum}, Shot ${shotIdx}, Genre: ${genre}, Characters: ${chars}):
"""
${imagePrompt}
"""

Flag reason: ${reason || 'Content safety filter triggered (code 3030)'}

Rewrite this prompt as a team of filmmakers would. Preserve:
1. The same characters and their positions in the frame
2. The same location and lighting
3. The same emotional beat and dramatic tension
4. The same cinematic style and genre aesthetic

Rewrite the scene as a concrete description of a single safe cinematic frame. Describe visible wardrobe, posture, facial expression, environment, lighting, composition, and atmosphere. Preserve the narrative context without depicting graphic or sexualized detail. Avoid labels, stage directions, metadata, policy language, or instructions addressed to the model.

Output the rewritten prompt directly, ready to be sent to an image generator. No JSON, no quotes around it, just the prompt text.`;

  try {
    // Use callLLM with a JSON wrapper since callLLM expects JSON output
    // We ask the LLM to wrap the rewritten prompt in a simple JSON object
    const wrappedSystemPrompt = systemPrompt + '\n\nYou must return your rewritten prompt as a JSON object with this exact shape: {"rewritten_prompt": "the rewritten prompt text here"}';
    const result = await scriptWriter.callLLM(wrappedSystemPrompt, userPrompt, 1024);
    const rewritten = result?.rewritten_prompt;
    if (rewritten && typeof rewritten === 'string' && rewritten.trim().length > 20) {
      console.log(`[Pipeline] Filmmaker prompt rewrite succeeded for S${sceneNum}/idx${shotIdx} (${rewritten.length} chars)`);
      return rewritten.trim();
    }
    console.warn(`[Pipeline] Filmmaker rewrite returned empty/short — falling back to sanitizer`);
  } catch (err) {
    console.warn(`[Pipeline] Filmmaker rewrite LLM failed: ${err.message} — falling back to sanitizer`);
  }

  // Fallback: old sanitizer
  return _sanitizeShotPromptFallback(imagePrompt, []);
}

/**
 * Fallback sanitizer — simple word replacement when the LLM rewriter is unavailable.
 */
function _sanitizeShotPromptFallback(imagePrompt, safetyCategories = []) {
  if (!imagePrompt) return 'cinematic portrait, neutral expression, professional studio lighting, 9:16 vertical';

  let cleaned = imagePrompt
    .replace(/\b(blood|gore|wound|stab|shoot|shooting|gun|pistol|rifle|weapon|weapons|knife|knives|sword|dead|death|corpse|kill|killing|violent|violence|explosion|explode|fire|burning|fight|punch|attack|murder|war|combat)\b/gi, '')
    .replace(/\b(nude|naked|explicit|sexual|erotic|intimate|sensual|undress|lingerie)\b/gi, '')
    .replace(/\b(drug|drugs|poison|toxic|illegal|narcotic)\b/gi, '')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();

  cleaned += ', safe for all audiences, professional cinematic, tasteful, no graphic content';

  return cleaned || 'professional cinematic portrait, neutral mood, natural lighting, 9:16 vertical';
}

/**
 * Generate image → submit MH job → poll → upload to Cloudinary.
 * Retries up to config.shotMaxRetries times on any failure.
 * On a Google Gemini safety refusal the prompt is rewritten before each retry
 * instead of submitting the same blocked text again.
 *
 * onMhSubmitted: optional async callback(jobId, apiKey, imageTmpPublicId) called
 * immediately after the MH job is submitted and before polling begins.  Used by
 * the pipeline to persist the in-flight job so a poll interruption can be resumed
 * without regenerating the image.
 *
 * Returns { clipUrl, imageTmpPublicId } on success, or throws after all retries.
 */
/**
 * Detect MIME type from image buffer magic bytes.
 * CF Worker can return PNG, JPEG, or WebP.
 */
function _detectImageMime(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)                      return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10]=== 0x42 && buf[11]=== 0x50)  return 'image/webp';
  return 'image/jpeg';
}

function _storedShotImageUrl(imageValue) {
  if (!imageValue) return null;
  const value = String(imageValue).trim();
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : cloudinary.imageDeliveryUrl(value);
}

/**
 * Persist a generated still under a stable per-shot Cloudinary public_id before
 * video generation starts. The returned URL is also used by later retries.
 * This is deliberately separate from the temporary image returned by the
 * video provider, which may not exist on the LTX path.
 */
function _makeShotImagePersistenceCallback({ episodeId, shot, storyline, globalEpisodeNumber, logLabel = '' }) {
  return async (imageBuffer, reusedImageUrl = null) => {
    let imageUrl = reusedImageUrl || null;
    if (!imageUrl) {
      const imagePublicId = cloudinary.shotImagePublicId(storyline.id, globalEpisodeNumber, shot.scene_number, shot.shot_index);
      const mime = _detectImageMime(imageBuffer);
      imageUrl = await cloudinary.uploadImageFromUrl(`data:${mime};base64,${imageBuffer.toString('base64')}`, imagePublicId);
      await updateShotRow(episodeId, shot.scene_number, shot.shot_index, { image_url:imagePublicId });
      console.log(`[Pipeline] Shot S${shot.scene_number}/idx${shot.shot_index} still persisted${logLabel ? ` (${logLabel})` : ''} → ${imagePublicId}`);
    }
    return imageUrl;
  };
}

function _buildSceneBackgroundPrompt(scene, storyline) {
  return `Establish the reusable empty-set master background for this ${storyline.genre || 'cinematic'} scene. Location: ${scene.location || 'unspecified'}. ${scene.scene_description || ''} Lighting: ${scene.lighting_design || 'natural cinematic lighting'}. Build the exact architecture, furniture, doors, windows, props, surfaces, spatial depth, practical lights and time-of-day evidence required for later character placement. No people, no characters, no silhouettes, no human figures. Photorealistic cinematic 9:16 vertical environment plate, stable geography, no text, logo or watermark.`;
}

async function _ensureSceneBackground({ episodeId, storyline, globalEpisodeNumber, scene, savedState }) {
  const key = String(scene.scene_number);
  if (savedState[key]) return savedState[key];
  const prompt = _buildSceneBackgroundPrompt(scene, storyline);
  const generated = await imageGen.generateImage(prompt, [], Math.abs(`${storyline.id}:${globalEpisodeNumber}:${key}`.split('').reduce((h,c)=>((h<<5)-h+c.charCodeAt(0))|0,0)) % 2147483647, 'people, character, human, face, body, silhouette, crowd, text, logo, watermark', []);
  const pubId = cloudinary.sceneBgPublicId(storyline.id, globalEpisodeNumber, scene.scene_number);
  let url = null;
  if (Buffer.isBuffer(generated) || generated instanceof Uint8Array) {
    const buf=Buffer.from(generated), mime=_detectImageMime(buf);
    url = await cloudinary.uploadImageFromUrl(`data:${mime};base64,${buf.toString('base64')}`, pubId);
  } else url = await cloudinary.uploadImageFromUrl(generated, pubId);
  savedState[key] = url || cloudinary.imageDeliveryUrl(pubId);
  if (episodeId) await db.execute(`UPDATE episodes SET scene_background_state=? WHERE id=?`, [JSON.stringify(savedState), episodeId]);
  return savedState[key];
}
function _attachLtxPromptCapture(shot, { episodeId, sceneNumber, shotIndex }) {
  const base = shot && typeof shot === 'object' ? shot : {};
  return {
    ...base,
    _promptCapture: typeof episodeId === 'string' && episodeId
      ? async (prompt) => {
          const exact = typeof prompt === 'string' ? prompt : String(prompt || '');
          await updateShotRow(episodeId, sceneNumber, shotIndex, {
            last_prompt: exact,
          });
          console.log(
            `[Pipeline] EXACT LTX PROMPT persisted | S${sceneNumber}/idx${shotIndex} ` +
            `chars=${exact.length}`
          );
        }
      : null,
  };
}

async function generateShot(shot, storyline, characterList, globalEpisodeNumber, onMhSubmitted, prevShot = null, sceneBgImageUrl = null, onImageGenerated = null, reuseImageUrl = null, faceLockRegistry = new Map()) {
  const maxRetries  = config.shotMaxRetries;  // per-attempt retries inside generateShot
  let   lastError;
  let   currentShot = shot; // may be replaced by a sanitised copy on safety refusal
  let   imageReuseUrl = reuseImageUrl;
  // Carries the constraint-corrected prompt across retry attempts. Without this,
  // each attempt rebuilt imagePrompt from scratch from currentShot.image_prompt,
  // silently discarding the correction (e.g. "force cool lighting") that was
  // computed right before the previous attempt threw — so the retry sent the
  // exact same prompt back to the CF Worker and failed the same way again.
  let   pendingCorrectedPrompt = null;
  // Keep the exact last image prompt outside the per-attempt try scope so
  // catch/retry handling can always surface it without a ReferenceError.
  let   lastAttemptImagePrompt = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Build prompt with character visual anchors + reference images
      const charsInShot    = _getCharsInShot(currentShot, characterList);

      // ── Reference image strategy (identity-consistent, anti-blend) ─────────
      // Pass ALL characters in the shot as reference images (up to 4 total
      // including scene background). One URL per character so each input_image_N
      // slot maps 1:1 to a single character — this gives the model the best
      // chance to reproduce every face faithfully.
      //
      // Slot allocation (CF Worker allows input_image_0 .. input_image_3):
      //   input_image_0 = scene background (when available)
      //   input_image_1..N = character portraits, speaker first
      //
      // The prompt's REFERENCE IMAGE MAP tells the model which photo is which
      // person, and a SPEAKER DOMINANCE directive pushes non-speakers to the
      // background/edges of the frame so they produce fewer artifacts.
      // ── Speaker-only mode for talking-photo shots ────────────────────────────
      // Magic Hour's AI Talking Photo API animates "a face" in the image but has
      // no parameter to specify WHICH face. With multiple faces in the image, MH
      // may animate the wrong character. To eliminate this ambiguity, when a shot
      // will use the talking-photo path (dialogue + close-up + TTS), we generate a
      // close-up of ONLY the speaker — one face, zero confusion for MH.
      //
      // LTX-2.3 has no such limitation — it receives the FULL composed
      // multi-character scene and animates every character independently
      // (including independent per-character dialogue/lip-sync), so this
      // crop-to-one-face workaround only applies to the Magic Hour path.
      const _willUseTalkingPhoto = ttsGen.shouldUseTalkingPhoto(currentShot)
        && !!(ttsGen.extractDialogueText(currentShot.dialogue_or_action));
      const _speakerOnlyMode = config.videoProvider === 'magichour'
        && _willUseTalkingPhoto && charsInShot.length >= 2;

      // When speaker-only, we only pass the speaker's ref image (+ scene bg) so
      // the CF Worker generates just the speaker's face. The ref image map and
      // prompt also switch to speaker-only framing.
      const speakerNameForRef = ttsGen.extractSpeakerName(currentShot.dialogue_or_action)
        || (currentShot.characters_in_shot || [])[0]
        || '';
      const focusChar = charsInShot.length <= 1
        ? charsInShot[0]
        : (charsInShot.find(c => {
            const dbT = _nameTokens(c.name);
            const spT = _nameTokens(speakerNameForRef);
            for (const t of spT) if (dbT.has(t)) return true;
            for (const t of dbT) if (spT.has(t)) return true;
            return false;
          }) || charsInShot[0]);

      // Order: speaker first, then remaining characters in their original order.
      // This ensures the speaker's ref image gets the strongest weight slot.
      const otherChars = charsInShot.filter(c => c !== focusChar);
      const orderedChars = _speakerOnlyMode
        ? [focusChar].filter(Boolean)
        : [focusChar, ...otherChars].filter(Boolean);

      // Collect ONE reference URL per character (first available angle).
      // Using a single URL per char keeps the 1:1 slot→character mapping clean.
      const charRefs = orderedChars.map(c => {
        try {
          const multi = safeJsonParse(c.reference_image_urls, []);
          if (Array.isArray(multi) && multi.length) return multi[0];
        } catch {}
        return c.reference_image_url || null;
      }).filter(Boolean);

      // Build the final reference URL list: bg first (if present), then chars.
      // Cap at 4 total (CF Worker maximum). In speaker-only mode, only the
      // speaker's ref is passed — no other character refs to avoid confusion.
      const referenceUrls = sceneBgImageUrl
        ? [sceneBgImageUrl, ...charRefs].slice(0, 4)
        : charRefs.slice(0, 4);

      // Build a parallel array of {char, refSlotIndex} for the ref image map.
      // refSlotIndex is the input_image_N index the model will see.
      const refSlotStart = sceneBgImageUrl ? 1 : 0;
      const charRefSlots = orderedChars
        .slice(0, 4 - refSlotStart)
        .map((c, i) => ({ char: c, slotIndex: refSlotStart + i }));

      const shotSeed = _combinedSeed(orderedChars);

      // Dynamic reference→character identity map for the CF Worker's
      // REFERENCE IMAGE N = <name> instructions (see cfImageGen.js /
      // _buildCharacterReferenceMap). Positions are computed once and reused
      // by the LTX video prompt below so the image and video stay consistent
      // about who is where.
      const characterPositions = _assignCharacterPositions(orderedChars);
      const characterRefMap = _buildCharacterReferenceMap(charRefSlots, characterPositions, currentShot);

      // Use the corrected prompt carried over from a previous failed attempt
      // (hard-control / lighting / face-lock corrections) instead of rebuilding
      // a fresh, uncorrected prompt every retry.
      const promptSource = pendingCorrectedPrompt || null;
      let imagePrompt = promptSource
        || _buildShotImagePrompt(currentShot, storyline, charsInShot, prevShot, sceneBgImageUrl, focusChar, charRefSlots, _speakerOnlyMode);
      lastAttemptImagePrompt = imagePrompt;
      pendingCorrectedPrompt = null;
      if (promptSource) {
        console.log(`[Pipeline] S${shot.scene_number}/idx${shot.shot_index}: using corrected image prompt on retry ${attempt}`);
      }
      const negativePrompt = _buildCharacterNegativePrompt(charsInShot);

      // Build a speaker-aware prompt for Magic Hour so it knows which character
      // is speaking and keeps the others still — reduces animation artifacts on
      // non-speaking characters.
      //
      // In speaker-only mode (talking-photo with 2+ chars), the image has only
      // ONE face (the speaker), so the MH prompt is name-agnostic: it just says
      // "animate the face in this image." This avoids confusing MH with names it
      // can't resolve to a face.
      const _hasDialogue = !!(currentShot.dialogue_or_action || '').trim();
      const mhSpeakerName = _hasDialogue
        ? (speakerNameForRef || focusChar?.name || '')
        : '';
      const mhListenerNames = otherChars.map(c => c.name).filter(n =>
        n && !_namesMatch(n, mhSpeakerName)
      );
      const mhPromptParts = [];
      if (_speakerOnlyMode) {
        // Image has exactly one face — MH doesn't need names, just animate it.
        mhPromptParts.push('This image contains a single person speaking — animate their face and lips to match the audio.');
      } else if (mhSpeakerName) {
        mhPromptParts.push(`${mhSpeakerName} is speaking — animate their face and lips only.`);
      } else if (charsInShot.length > 0) {
        mhPromptParts.push('No one is speaking in this shot — do not animate any mouth or lip movement.');
      }
      if (!_speakerOnlyMode) {
        for (const ln of mhListenerNames) {
          mhPromptParts.push(`${ln} is silent — keep them still, no mouth movement.`);
        }
      }
      mhPromptParts.push(currentShot.image_prompt || '');
      const mhImagePrompt = mhPromptParts.join(' ').trim();

      // 1. Generate image — or reuse an existing image if the pipeline determined
      //    this shot's visual context matches a previously generated image.
      //    This avoids unnecessary CF Worker calls for shots that don't need
      //    a new image (same character, same environment, different dialogue).
      let imageBuffer;
      if (imageReuseUrl) {
        console.log(`[Pipeline] Shot S${shot.scene_number}/idx${shot.shot_index} reusing existing image → ${imageReuseUrl.slice(-60)}`);
        try {
          const imgResp = await axios.get(imageReuseUrl, { responseType: 'arraybuffer', timeout: 30000 });
          imageBuffer = Buffer.from(imgResp.data);
        } catch (reuseErr) {
          // A legacy temporary Cloudinary image may have been cleaned up.
          // Fall back to one fresh image rather than retrying the dead URL forever.
          console.warn(`[Pipeline] Saved image for S${shot.scene_number}/idx${shot.shot_index} is unavailable (${reuseErr.message}) — regenerating once`);
          imageReuseUrl = null;
          imageBuffer = await imageGen.generateImage(imagePrompt, referenceUrls, shotSeed, negativePrompt, characterRefMap);
        }
      } else {
        imageBuffer = await imageGen.generateImage(imagePrompt, referenceUrls, shotSeed, negativePrompt, characterRefMap);
      }

      // ── Constraint Enforcement + Hard Control Layers: multi-pass validation ──
      // After generation, validate the image against scene state, temporal
      // consistency, camera simulation directives, AND hard control layers
      // (face-lock, pose tracking, scene graph). Uses a draft → refine → final
      // multi-pass rendering pipeline:
      //   - Draft pass: structural checks only (framing, aspect ratio)
      //   - Refine pass: full validation (lighting, face-lock, pose, spatial)
      // If any check fails, build a corrected prompt and regenerate.
      if (!imageReuseUrl) {
        const currentPass = hardControl.getCurrentPass(currentShot);
        const passConfig  = hardControl.getPassValidationConfig(currentPass.name);

        let allViolations = [];
        let correctedPrompt = imagePrompt;

        // ── Structural validation (draft + refine passes) ──
        if (passConfig.checkStructure) {
          const constraintResult = await constraintEnforcer.validateImage(
            imageBuffer, currentShot, imagePrompt, prevShot,
            {
              checkLighting: !!passConfig.checkLighting,
              checkDirectives: !!passConfig.checkDirectives,
            }
          );
          if (!constraintResult.passed) {
            // Draft uses score gating: cosmetic misses no longer burn a CF URL.
            const actionable = constraintResult.violations.filter(v => v.severity === 'high' || v.severity === 'medium');
            allViolations.push(...actionable);
            correctedPrompt = constraintResult.correctedPrompt;
            currentShot._draft_score = constraintResult.score;
            currentShot._draft_decision = constraintResult.decision;
          } else {
            currentShot._draft_score = constraintResult.score;
            currentShot._draft_decision = constraintResult.decision;
          }
          if (constraintResult.decision === 'accept') {
            allViolations = [];
          } else if (constraintResult.decision === 'retry_once' && attempt >= 2) {
            // Borderline images are accepted after one correction pass; do not loop indefinitely.
            allViolations = [];
            console.warn(`[Pipeline] S${shot.scene_number}/idx${shot.shot_index}: borderline draft score ${constraintResult.score}/100 accepted after one correction opportunity`);
          }
        }

        // ── Hard control: face-lock validation (refine pass) ──
        if (passConfig.checkFaceLock && allViolations.length === 0) {
          const faceLockResult = hardControl.validateFaceLock(currentShot, faceLockRegistry);
          if (!faceLockResult.passed) {
            allViolations.push(...faceLockResult.results
              .filter(r => !r.passed)
              .map(r => ({ type: 'face_lock', severity: 'high', message: `Face drift: ${r.character} similarity ${r.similarity.toFixed(3)} < ${r.threshold}` })));
            correctedPrompt = `${correctedPrompt}\n\n${faceLockResult.directive}`;
          }
        }

        // ── Hard control: pose tracking validation (refine pass) ──
        if (passConfig.checkPoseTracking && allViolations.length === 0) {
          const sceneTraj = episodeScript.scenes
            ?.find(s => s.scene_number === currentShot.scene_number)?._pose_trajectory;
          if (sceneTraj) {
            const poseResult = hardControl.validatePoseTracking(currentShot, sceneTraj);
            if (!poseResult.passed) {
              allViolations.push(...poseResult.results
                .filter(r => !r.isPossible)
                .map(r => ({ type: 'pose_tracking', severity: 'high', message: `Impossible pose: ${r.character} ${r.transition}` })));
              correctedPrompt = `${correctedPrompt}\n\n${poseResult.directive}`;
            }
          }
        }

        // ── Hard control: scene graph / spatial map validation (refine pass) ──
        if (passConfig.checkSceneGraph && allViolations.length === 0) {
          const sceneGraph = sceneGraphs.get(currentShot.scene_number);
          if (sceneGraph) {
            const graphResult = hardControl.validateSceneGraph(currentShot, sceneGraph);
            if (!graphResult.passed) {
              allViolations.push(...graphResult.violations.map(v => ({ type: 'spatial', severity: 'medium', message: v.message })));
              correctedPrompt = `${correctedPrompt}\n\n${graphResult.directive}`;
            }
          }
        }

        // ── Decide: regenerate or advance pass ──
        if (allViolations.length > 0) {
          const violationSummary = allViolations.map(v => `${v.type}: ${v.message}`).join('; ');
          console.warn(
            `[Pipeline] ${currentPass.name.toUpperCase()} pass FAILED on S${shot.scene_number}/idx${shot.shot_index} ` +
            `(attempt ${attempt}/${maxRetries}): ${violationSummary} — regenerating with corrected prompt`
          );
          telegram.sendTelegram(
            `🔧 <b>${currentPass.name.charAt(0).toUpperCase() + currentPass.name.slice(1)} pass violation</b> — S${shot.scene_number}/idx${shot.shot_index}\n` +
            `${violationSummary}\nScore: ${currentShot._draft_score ?? '?'} / 100\nRegenerating with corrected prompt (attempt ${attempt + 1}/${maxRetries})…`
          ).catch(() => {});

          imagePrompt = correctedPrompt;
          pendingCorrectedPrompt = correctedPrompt;

          const hardErr = new Error(`Hard control ${currentPass.name} pass: ${violationSummary}`);
          hardErr.constraintViolation = true;
          throw hardErr;
        }

        // ── Passed current pass — advance to next render pass ──
        const advanceResult = hardControl.advancePass(currentShot, { passed: true });

        if (advanceResult.shouldRegenerate) {
          // Draft passed → upgrade to refine pass with full-quality generation
          console.log(
            `[Pipeline] S${shot.scene_number}/idx${shot.shot_index}: DRAFT pass passed → upgrading to REFINE pass (full quality)`
          );
          imageBuffer = await imageGen.generateImage(imagePrompt, referenceUrls, shotSeed, negativePrompt, characterRefMap);

          // Re-validate structure on the refined image
          const refineStructResult = await constraintEnforcer.validateImage(
            imageBuffer, currentShot, imagePrompt, prevShot,
            { checkLighting: false, checkDirectives: false }
          );
          if (!refineStructResult.passed) {
            const violationSummary = refineStructResult.violations.filter(v => v.severity !== 'low').map(v => `${v.type}: ${v.message}`).join('; ');
            console.warn(`[Pipeline] REFINE structural check FAILED: ${violationSummary}`);
            imagePrompt = refineStructResult.correctedPrompt;
            pendingCorrectedPrompt = refineStructResult.correctedPrompt;
            const refineErr = new Error(`Refine structural check: ${violationSummary}`);
            refineErr.constraintViolation = true;
            throw refineErr;
          }
        }

        // ── All passes passed — store results for DB persistence ──
        currentShot._constraint_check = {
          passed: true,
          renderPass: hardControl.getCurrentPass(currentShot).name,
          violations: [],
          validatedAt: new Date().toISOString(),
        };
        currentShot._hard_control_result = {
          faceLock: currentShot._hard_control?.faceLock || [],
          renderPass: hardControl.getCurrentPass(currentShot).name,
          validatedAt: new Date().toISOString(),
        };

      }

      // 1a. Notify caller immediately after image generation — BEFORE Magic Hour submission.
      //     This is the earliest safe point to establish a scene background reference; doing
      //     it here ensures the reference persists even if MH submission or polling fails.
      if (onImageGenerated) {
        try {
          const persistedImageUrl = await onImageGenerated(imageBuffer, imageReuseUrl);
          if (persistedImageUrl) imageReuseUrl = persistedImageUrl;
        }
        catch (cbErr) { console.warn('[Pipeline] onImageGenerated callback failed (non-fatal):', cbErr.message); }
      }

      // 1b. Deepgram TTS + Magic Hour's ai-talking-photo path (audio synthesised
      //     separately, lip-synced onto a single-face crop). LTX-2.3 generates
      //     synchronized audio (including multi-character dialogue/lip-sync)
      //     natively from the video prompt, so this step is Magic-Hour-only —
      //     skipped entirely on the LTX path (no Deepgram dependency, no
      //     external TTS call).
      let talkingPhoto = null;
      if (config.videoProvider === 'magichour' && ttsGen.shouldUseTalkingPhoto(currentShot)) {
        const dialogueText = ttsGen.extractDialogueText(currentShot.dialogue_or_action);
        if (dialogueText) {
          try {
            const audioPubId = `${config.shotsFolderRoot}/tmp/tts_${Date.now()}`;
            // Identify the speaking character for voice selection.
            // Prefer an explicit "NAME: text" speaker prefix parsed from the dialogue;
            // fall back to the first name listed in characters_in_shot.
            const parsedSpeakerName = ttsGen.extractSpeakerName(currentShot.dialogue_or_action);
            const speakerName = parsedSpeakerName || (currentShot.characters_in_shot || [])[0];
            if (parsedSpeakerName && parsedSpeakerName !== (currentShot.characters_in_shot || [])[0]) {
              console.log(`[Pipeline] Speaker override from dialogue prefix: "${parsedSpeakerName}" (was "${(currentShot.characters_in_shot || [])[0] || 'none'}")`);
            }
            const speakingChar = speakerName
              ? characterList.find(c =>
                  c.name === speakerName ||
                  c.name?.toLowerCase() === speakerName?.toLowerCase()
                ) || null
              : null;
            const { audioUrl, durationSeconds } = await ttsGen.generateAndUploadTTS(
              dialogueText, audioPubId, speakingChar
            );
            talkingPhoto = { audioUrl, durationSeconds };
          } catch (ttsErr) {
            console.warn(`[Pipeline] TTS failed for S${currentShot.scene_number}/idx${currentShot.shot_index} — using image-to-video+audio: ${ttsErr.message}`);
          }
        }
      }

      // 2. Submit the video-generation job.
      const motionParams = currentShot._motion_params || null;
      let submitMeta;
      if (config.videoProvider === 'magichour') {
        submitMeta = {
          motionLevel:    motionParams?.mhMotionLevel || currentShot.motion_level    || 'medium',
          duration:       currentShot.duration        || 5,
          talkingPhoto,   // null → image-to-video+audio; set → ai-talking-photo
          imagePrompt:    motionParams?.videoPrompt || mhImagePrompt || currentShot.image_prompt || '',
          shotPacingType: currentShot.shot_pacing_type || '',
          motionParams,   // structured motion control from the Motion System Upgrade
        };
      } else {
        // LTX-2.3 — full multi-character prompt with independent per-character
        // action + dialogue, built from the actual scene/script data. Receives
        // the already-composed final scene image (imageBuffer), never the raw
        // per-character reference images.
        submitMeta = {
          duration:    currentShot.duration || config.ltxMinDuration,
          // HIL manual edit: if the operator hand-edited the exact LTX prompt
          // in the dashboard's shot editor, send that literal text instead of
          // rebuilding it — otherwise build it fresh as usual.
          videoPrompt: currentShot._ltxPromptOverride || _buildLtxVideoPrompt(currentShot, storyline, orderedChars, characterPositions, motionParams),
          _promptCapture: typeof currentShot._promptCapture === 'function' ? currentShot._promptCapture : null,
          lockPrompt:  true,
          width:       config.ltxWidth,
          height:      config.ltxHeight,
          seed:        shotSeed,
        };
      }
      const { jobId, apiKey, imageTmpPublicId } = await videoGen.submitVideoJob(imageBuffer, submitMeta);

      // Persist the in-flight video-generation job immediately so a poll
      // interruption can be resumed (column names are historical — mh_job_id /
      // mh_api_key now hold the LTX event_id / HF token when VIDEO_PROVIDER=ltx).
      if (onMhSubmitted) {
        try { await onMhSubmitted(jobId, apiKey, imageTmpPublicId); }
        catch (cbErr) { console.warn('[Pipeline] onMhSubmitted callback failed (non-fatal):', cbErr.message); }
      }

      // 3. Poll until video is ready
      const videoUrl = await videoGen.pollVideoJob(jobId, apiKey);

      // 4. Upload clip to Cloudinary
      const shotPubId = cloudinary.shotPublicId(
        storyline.id, globalEpisodeNumber, shot.scene_number, shot.shot_index
      );
      const clipUrl = await cloudinary.uploadVideoFromUrl(videoUrl, shotPubId);

      if (attempt > 1) {
        console.log(`[Pipeline] Shot S${shot.scene_number}/idx${shot.shot_index} succeeded on attempt ${attempt}/${maxRetries}`);
      }
      return { clipUrl, imageTmpPublicId };

    } catch (err) {
      lastError = err;

      // ── Magic Hour credit exhaustion — pause gracefully ──────────────────
      if (err.mhExhausted) break;

      // ── LTX / ZeroGPU quota exhaustion — all HF tokens are cooling down.
      // Don't blindly retry: rotation + 24h cooldown already happened inside
      // ltxVideoGen; breaking here lets the pipeline pause/notify instead of
      // burning through retries against a backend with no quota left.
      if (err.zeroGpuExhausted) break;

      // ── CF Worker exhaustion — all URLs and keys depleted ────────────────
      // The CF worker module throws a generic Error with this message when
      // every URL/key has been rotated through. We tag it so the pipeline
      // can pause and notify via Telegram instead of silently failing.
      if (err.message?.includes('All CF Worker URLs and keys exhausted')) {
        err.cfExhausted = true;
        break;
      }

      // ── Google Gemini safety refusal — rewrite prompt like a filmmaker ──────
      if (err.name === 'SafetyRefusalError') {
        const cats = (err.safetyCategories || []).join(', ') || 'unspecified';
        console.warn(
          `[Pipeline] Safety refusal on S${shot.scene_number}/idx${shot.shot_index} ` +
          `(attempt ${attempt}/${maxRetries}): ${err.safetyReason} [${cats}] — filmmaker rewrite`
        );
        telegram.sendTelegram(
          `⚠️ <b>Safety refusal</b> — S${shot.scene_number}/idx${shot.shot_index}\n` +
          `Category: ${cats}\n` +
          `Filmmaker team rewriting prompt for retry ${attempt + 1}/${maxRetries}…`
        ).catch(() => {});
        const cleanedPrompt = await _rewriteFlaggedPrompt(
          lastAttemptImagePrompt || currentShot.image_prompt, shot, storyline, err.message
        );
        currentShot = { ...currentShot, image_prompt: cleanedPrompt };
        pendingCorrectedPrompt = cleanedPrompt;
      }

      // ── CF Worker content flag — rewrite prompt like a filmmaker, not a sanitizer ─
      if (err instanceof CFSafetyRefusalError) {
        console.warn(
          `[Pipeline] CF Worker content flag on S${shot.scene_number}/idx${shot.shot_index} ` +
          `(attempt ${attempt}/${maxRetries}) — filmmaker rewrite`
        );
        telegram.sendTelegram(
          `⚠️ <b>CF Worker content flag</b> — S${shot.scene_number}/idx${shot.shot_index}\n` +
          `Filmmaker team rewriting prompt for retry ${attempt + 1}/${maxRetries}…`
        ).catch(() => {});
        const cleanedPrompt = await _rewriteFlaggedPrompt(
          lastAttemptImagePrompt || currentShot.image_prompt, shot, storyline, err.message
        );
        currentShot = { ...currentShot, image_prompt: cleanedPrompt };
        pendingCorrectedPrompt = cleanedPrompt;
      }

      // ── Constraint enforcement violation — retry immediately with corrected prompt
      // The enforcer already replaced imagePrompt with the corrected version before
      // throwing, so we just continue to the next attempt without back-off.
      if (err.constraintViolation) {
        console.warn(`[Pipeline] Constraint violation on S${shot.scene_number}/idx${shot.shot_index} (attempt ${attempt}/${maxRetries}) — routing through director repair before retry`);
      }

      // ── Director-driven retry repair ─────────────────────────────────────
      // Every recoverable retry returns to the director first. The director is
      // given the exact failed shot + runtime error and may repair or complete
      // any missing semantic fields (image prompt, dialogue/action, temporal
      // arc, environment beat, duration, end-frame handoff, etc.) before the
      // next provider attempt. Provider/quota exhaustion still breaks above.
      if (attempt < maxRetries && scriptWriter?.repairShotForRetry) {
        try {
          const repaired = await scriptWriter.repairShotForRetry({
            shot: currentShot,
            storyline,
            previousShot: prevShot,
            error: err.message,
            failedPrompt: lastAttemptImagePrompt || currentShot.image_prompt || null,
            attempt,
            maxRetries,
          });
          if (repaired && typeof repaired === 'object') {
            currentShot = { ...currentShot, ...repaired };
            if (repaired.image_prompt) {
              pendingCorrectedPrompt = repaired.image_prompt;
              lastAttemptImagePrompt = repaired.image_prompt;
              console.log(`[Pipeline] Director repaired S${shot.scene_number}/idx${shot.shot_index} for retry ${attempt + 1}/${maxRetries}`);
            }
          }
        } catch (directorErr) {
          console.warn(`[Pipeline] Director retry repair failed for S${shot.scene_number}/idx${shot.shot_index}: ${directorErr.message}`);
        }
      }

      console.warn(`[Pipeline] Shot S${shot.scene_number}/idx${shot.shot_index} attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) await sleep(3000 * attempt); // back-off
    }
  }
  // Surface the exact prompt this shot was last attempted with, and a coarse
  // failure category, so a caller that marks the shot 'failed' can persist
  // both — the dashboard needs the prompt itself to offer manual edit+retry
  // for content-flagged shots, and the category to decide whether to show
  // that editable-prompt UI at all.
  if (lastError) {
    lastError.lastPrompt = pendingCorrectedPrompt || lastAttemptImagePrompt || currentShot.image_prompt || shot.image_prompt || null;
    lastError.failureReason =
      lastError instanceof CFSafetyRefusalError || lastError.name === 'SafetyRefusalError'
        ? 'content_flag'
        : (lastError.zeroGpuExhausted || lastError.mhExhausted || lastError.cfExhausted)
          ? 'quota'
          : 'transient';
  }
  throw lastError;
}

// ──────────────────────────────────────────────────────────────────────────────
// Core pipeline
// ──────────────────────────────────────────────────────────────────────────────

let _pipelineRunning = false;

// ── Manual pause support ──────────────────────────────────────────────────
// Set by the /api/pause dashboard action. The running pipeline consumes this
// flag at safe checkpoints (between shots, between retry rounds) so it never
// interrupts an in-flight API call — it always finishes the current shot,
// persists it, then pauses cleanly the same way an exhausted-credits pause
// works. Resume picks up exactly where it left off.
let _pauseRequested = false;

function requestPause() {
  if (!_pipelineRunning) return { ok: false, error: 'Pipeline is not currently running' };
  _pauseRequested = true;
  console.log('[Pipeline] Manual pause requested — will pause after the current shot finishes.');
  return { ok: true };
}

function isPauseRequested() {
  return _pauseRequested;
}

async function runStreamVersePipeline() {
  if (_pipelineRunning) {
    console.log('[Pipeline] Already running, skipping trigger.');
    return;
  }
  _pipelineRunning = true;
  _pauseRequested = false;
  state.resetForRun();
  state.updateDiskUsage(diskUsageMB());

  try {
    await _runPipeline();
  } catch (err) {
    console.error('[Pipeline] Fatal error:', err);
    state.setError(err.message);
    await telegram.sendTelegram(`❌ StreamVerse pipeline crashed:\n${err.message}`);
  } finally {
    _pipelineRunning = false;
    state.updateDiskUsage(diskUsageMB());
  }
}

async function _runPipeline() {
  // ── 1. Wake FFmpeg (anti cold-start) ──────────────────────────────────────
  console.log('[Pipeline] Waking FFmpeg service...');
  await compiler.wakeFFmpeg();
  await sleep(15000);

  // ── 2. Get / create storyline ──────────────────────────────────────────────
  state.setStatus(state.STATES.WRITING, 'Querying database...');

  // Always check for a paused draft first — across ALL active storylines.
  // Without this, getActiveStoryline() could return a different series and the
  // paused episode would be orphaned instead of resumed.
  const anyDraftInfo = await getDraftEpisodeAny();
  let storyline;
  if (anyDraftInfo) {
    storyline = anyDraftInfo.storyline;
    if (anyDraftInfo.draft.status === 'ready') {
      state.setStatus(state.STATES.IDLE, 'Episode READY for manual review — automatic generation paused');
      state.setCurrentEpisode({ title: storyline.title, seasonNumber: anyDraftInfo.draft.season_number, episodeNumber: anyDraftInfo.draft.episode_number, globalEpisodeNumber: storyline.episode_count || anyDraftInfo.draft.episode_number, draftEpisodeId: anyDraftInfo.draft.id });
      await telegram.sendTelegram(`⏸ <b>Episode awaiting manual publication</b>\n${storyline.title} S${anyDraftInfo.draft.season_number}E${anyDraftInfo.draft.episode_number}\nReview it in the dashboard and click <b>Publish Episode</b>.`).catch(()=>{});
      return;
    }
    console.log(`[Pipeline] ↺ Draft found for "${storyline.title}" — resuming instead of starting new work`);
  } else {
    storyline = await getActiveStoryline();
  }

  if (!storyline && !anyDraftInfo) {
    const genre = _pickRandomGenre();
    console.log(`[Pipeline] No active storyline — premiering new ${genre} series`);
    state.setStatus(state.STATES.WRITING, `Creating new ${genre} series bible...`);

    let storyMap;
    let provisionalStorylineId = null;
    try {
      // ── CAST-FIRST ARCHITECTURE ──
      // Step 1: Simulate the full series internally — comprehensive summary,
      // every character role, the beginning and end of the movie.
      // IMPORTANT: the master plan and every locked trajectory chunk are
      // durably checkpointed into the storyline row before generation continues.
      storyMap = await scriptWriter.writeSeriesSummary(genre, {
        episodesPerSeason: config.episodesPerSeason,
        seasonsPerSeries: config.seasonsPerSeries,
        generateEpisodeTrajectories: false,
        onCheckpoint: async ({ seriesData, fullStorySimulation, stage, completedTrajectories }) => {
          if (!provisionalStorylineId) {
            provisionalStorylineId = await insertStoryline({
              ...seriesData,
              character_bible: seriesData.character_bible || [],
              full_story_simulation: fullStorySimulation,
              facebook_playlist_id: null,
            });
            console.log(`[Pipeline] 💾 Series simulation checkpoint row created: ${provisionalStorylineId} (${stage}, ${completedTrajectories?.length || 0} trajectories)`);
          } else {
            await db.execute(
              `UPDATE storylines SET full_story_simulation = ?, character_bible = COALESCE(?, character_bible),
               plot_summary = COALESCE(?, plot_summary), central_theme = COALESCE(?, central_theme),
               tone_manifesto = COALESCE(?, tone_manifesto), visual_language = COALESCE(?, visual_language),
               season_arcs = COALESCE(?, season_arcs), engagement_hook = COALESCE(?, engagement_hook),
               premiere_announcement = COALESCE(?, premiere_announcement), logline = COALESCE(?, logline),
               updated_at = NOW() WHERE id = ?`,
              [
                JSON.stringify(fullStorySimulation),
                seriesData.character_bible ? JSON.stringify(seriesData.character_bible) : null,
                seriesData.plot_summary || seriesData.comprehensive_summary || null,
                seriesData.central_theme || null,
                seriesData.tone_manifesto || null,
                seriesData.visual_language ? JSON.stringify(seriesData.visual_language) : null,
                seriesData.season_arcs ? JSON.stringify(seriesData.season_arcs) : null,
                seriesData.engagement_hook || null,
                seriesData.premiere_announcement || null,
                seriesData.logline || null,
                provisionalStorylineId,
              ]
            );
            console.log(`[Pipeline] 💾 Series simulation checkpoint persisted: ${stage} (${completedTrajectories?.length || 0} trajectories)`);
          }
        },
      });

      // Step 2: Generate and lock the cast BEFORE episode generation.
      state.setStatus(state.STATES.WRITING, 'Generating and locking cast...');
      const lockedCast = await scriptWriter.writeCastBible(storyMap);
      storyMap.character_bible = lockedCast;

      console.log(`[Pipeline] Cast locked: ${lockedCast.length} characters with voice_id + seed`);
      for (const c of lockedCast) {
        console.log(`[Pipeline]   ${c.name} (${c.role}) → voice=${c.voice_id}, seed=${c.seed}`);
      }
    } catch (newSeriesErr) {
      if (newSeriesErr.llmExhausted) {
        state.setStatus(state.STATES.PAUSED,
          '⏸ Paused — LLM keys exhausted before series creation. Refill MISTRAL_KEYS / GROQ_KEYS then click Resume.');
        await telegram.sendTelegram(
          `⏸ <b>Pipeline paused — LLM keys exhausted</b>\n\n` +
          `Could not create a new series because all Mistral and Groq API keys are depleted.\n` +
          `Refill <b>MISTRAL_KEYS</b> / <b>GROQ_KEYS</b> and click <b>Resume</b>.`
        );
        return;
      }
      throw newSeriesErr;
    }

    const storylineId = provisionalStorylineId || await insertStoryline({ ...storyMap, facebook_playlist_id: null });

    // The provisional checkpoint row already exists; upgrade it from the
    // simulation checkpoint into the canonical series record without creating
    // a second storyline.
    await db.execute(
      `UPDATE storylines SET title = ?, genre = ?, character_bible = ?, plot_summary = ?,
       full_story_simulation = ?, central_theme = ?, tone_manifesto = ?, visual_language = ?,
       season_arcs = ?, engagement_hook = ?, premiere_announcement = ?, logline = ?,
       status = 'active', updated_at = NOW() WHERE id = ?`,
      [
        storyMap.title,
        storyMap.genre,
        JSON.stringify(storyMap.character_bible || []),
        storyMap.plot_summary || storyMap.comprehensive_summary || null,
        JSON.stringify(storyMap.full_story_simulation || null),
        storyMap.central_theme || null,
        storyMap.tone_manifesto || null,
        JSON.stringify(storyMap.visual_language || null),
        JSON.stringify(storyMap.season_arcs || []),
        storyMap.engagement_hook || null,
        storyMap.premiere_announcement || null,
        storyMap.logline || null,
        storylineId,
      ]
    );

    // ── Character consistency: anchors + reference portraits ──────────────
    state.setStatus(state.STATES.WRITING, 'Generating character reference portraits...');
    await insertCharactersWithConsistency(storylineId, storyMap.character_bible);

    storyline = await db.queryOne(`SELECT * FROM storylines WHERE id = ?`, [storylineId]);

    // ── Series Premiere announcement → Discord ────────────────────────────
    try {
      const premiereCopy = await scriptWriter.writePremiereAnnouncement(storyMap);
      await discord.postAnnouncement(premiereCopy);
      console.log(`[Pipeline] Series Premiere announcement sent to Discord for "${storyMap.title}"`);
    } catch (e) {
      console.warn('[Pipeline] Premiere announcement failed:', e.message);
    }

    await telegram.sendTelegram(
      `🎬 <b>SERIES PREMIERE</b>\n"${storyMap.title}" (${genre})\n${storyMap.logline || ''}\n\n${storyMap.central_theme || ''}`
    );
  }

  // ── 2b. Master series plan only ─────────────────────────────────────────
  // Detailed episode trajectories are intentionally NOT generated for the
  // whole 80-episode series upfront. The master story plan is durable in DB;
  // each production run creates a rolling 3–5 episode trajectory horizon.
  let storedFullSimulation = storyline?.full_story_simulation
    ? (typeof storyline.full_story_simulation === 'string'
      ? safeJsonParse(storyline.full_story_simulation, {})
      : storyline.full_story_simulation)
    : {};

  const masterPlanReady = !!(
    storedFullSimulation &&
    (storedFullSimulation.opening_state ||
     storedFullSimulation.comprehensive_summary ||
     storyline?.plot_summary) &&
    Array.isArray(storedFullSimulation.season_endpoints || storyline?.season_arcs)
  );

  if (!masterPlanReady) {
    throw new Error('[Pipeline] Master series plan missing or invalid; cannot begin episode production.');
  }

  console.log('[Pipeline] ✓ Authoritative series simulation durable in DB — using stored trajectories when available; rolling window is a production view, not a regeneration requirement');

  // A provisional series row can survive a crash before the cast was locked.
  // Complete the cast foundation before allowing episode generation to start.
  let persistedCharacters = await getCharacters(storyline.id);
  if (!persistedCharacters.length && storyline.character_bible) {
    state.setStatus(state.STATES.WRITING, 'Restoring and locking cast after simulation resume...');
    const rawCast = typeof storyline.character_bible === 'string'
      ? safeJsonParse(storyline.character_bible, [])
      : storyline.character_bible;
    const lockedCast = await scriptWriter.writeCastBible({ ...storyline, character_bible: rawCast });
    await db.execute(`UPDATE storylines SET character_bible = ?, updated_at = NOW() WHERE id = ?`, [JSON.stringify(lockedCast), storyline.id]);
    await insertCharactersWithConsistency(storyline.id, lockedCast);
    storyline = await db.queryOne(`SELECT * FROM storylines WHERE id = ?`, [storyline.id]);
    persistedCharacters = await getCharacters(storyline.id);
  }

  // ── 3. Season / episode counters ──────────────────────────────────────────
  const episodesPerSeason = config.episodesPerSeason;
  const seasonsPerSeries  = config.seasonsPerSeries;

  let currentSeason  = storyline.current_season  || 1;
  let currentEpisode = (storyline.current_episode || 0) + 1;
  if (currentEpisode > episodesPerSeason) { currentSeason++; currentEpisode = 1; }

  const globalEpisodeNumber = (storyline.episode_count || 0) + 1;
  const isSeasonFinale      = currentEpisode === episodesPerSeason;
  const isSeriesMovie       = currentSeason > seasonsPerSeries ||
                              (currentSeason === seasonsPerSeries && currentEpisode === episodesPerSeason);
  const targetMinutes       = isSeriesMovie
    ? Math.round(config.movieMinSeconds / 60)
    : Math.round(config.targetEpisodeMinSeconds / 60);

  console.log(`[Pipeline] S${currentSeason}E${currentEpisode} (global #${globalEpisodeNumber}) finale=${isSeasonFinale} movie=${isSeriesMovie}`);
  state.setCurrentEpisode({ title: storyline.title, seasonNumber: currentSeason, episodeNumber: currentEpisode, globalEpisodeNumber, draftEpisodeId: null });

  // ── 3b. Check for an existing draft episode to resume ────────────────────
  const existingDraft   = await getDraftEpisode(storyline.id);
  let   draftEpisodeId  = existingDraft?.id || null;

  // Push the draft ID into the SSE state immediately if we're resuming,
  // so the dashboard live-counter can target the right card from the start.
  if (draftEpisodeId) {
    state.setCurrentEpisode({ title: storyline.title, seasonNumber: currentSeason, episodeNumber: currentEpisode, globalEpisodeNumber, draftEpisodeId });
  }
  const savedSceneState = {};
  let   isResuming      = false;

  if (existingDraft) {
    isResuming = true;

    // Legacy safety: old final videos are now review-ready, never auto-published.
    if (existingDraft.video_url) {
      await markEpisodeReady(existingDraft.id, { video_url: existingDraft.video_url });
      state.setStatus(state.STATES.IDLE, 'Existing final video marked READY for manual review');
      return;
    }

    // Scene state (fewer rows, still stored as JSON on the episode)
    Object.assign(savedSceneState, safeJsonParse(existingDraft.scene_state, {}));
    // Shot count is loaded from the shots table after upsertShotRows below
    state.setStatus(state.STATES.GENERATING, 'Resuming — loading saved shots...');
  }

  // ── 4. Load characters with consistency guarantee ─────────────────────────
  if (!isResuming) state.setStatus(state.STATES.WRITING, 'Loading character consistency data...');
  const characterList  = await ensureCharacterConsistency(storyline.id);
  const recentEpisodes = await getRecentEpisodes(storyline.id);

  // ── 4b. Rolling episode trajectory horizon ─────────────────────────────
  // Create/restore the next 3–5 episode trajectories immediately before
  // production of the current episode. This is the detailed story plan for the
  // current production horizon; it is persisted in the storyline master JSON
  // so a restart can resume without re-simulating completed trajectory work.
  let rollingTrajectoryWindow = [];
  let currentEpisodeTrajectory = null;

  const currentStoredStory = storyline?.full_story_simulation
    ? (typeof storyline.full_story_simulation === 'string'
      ? safeJsonParse(storyline.full_story_simulation, {})
      : storyline.full_story_simulation)
    : {};

  const currentWindow = Array.isArray(currentStoredStory.episode_trajectory)
    ? currentStoredStory.episode_trajectory.filter(ep =>
        Number(ep?.global_episode) >= globalEpisodeNumber &&
        Number(ep?.global_episode) < globalEpisodeNumber + config.trajectoryWindowEpisodes
      ).sort((a, b) => Number(a.global_episode) - Number(b.global_episode))
    : [];

  if (currentWindow.length >= Math.min(
    config.trajectoryWindowEpisodes,
    (episodesPerSeason * seasonsPerSeries) - globalEpisodeNumber + 1
  )) {
    rollingTrajectoryWindow = currentWindow;
    console.log(`[Pipeline] ↺ Restored rolling trajectory window: E${globalEpisodeNumber}-E${globalEpisodeNumber + rollingTrajectoryWindow.length - 1}`);
  } else {
    state.setStatus(state.STATES.WRITING, `Planning rolling story horizon for E${globalEpisodeNumber}...`);
    const existingCharsForTrajectory = await getCharacters(storyline.id);
    rollingTrajectoryWindow = await scriptWriter.simulateEpisodeTrajectoryWindow({
      storyline: { ...storyline, full_story_simulation: currentStoredStory },
      characters: existingCharsForTrajectory,
      startGlobalEpisode: globalEpisodeNumber,
      windowSize: config.trajectoryWindowEpisodes,
    });

    const updatedFullStorySimulation = {
      ...currentStoredStory,
      episode_trajectory: rollingTrajectoryWindow,
      simulation_status: 'rolling',
      simulation_total_episodes: episodesPerSeason * seasonsPerSeries,
      simulation_completed_episodes: rollingTrajectoryWindow.length,
      simulation_window_start: globalEpisodeNumber,
      simulation_window_end: globalEpisodeNumber + rollingTrajectoryWindow.length - 1,
      simulation_window_size: rollingTrajectoryWindow.length,
    };

    await db.execute(
      `UPDATE storylines SET full_story_simulation = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(updatedFullStorySimulation), storyline.id]
    );
    storyline = { ...storyline, full_story_simulation: updatedFullStorySimulation };
    console.log(`[Pipeline] 💾 Rolling trajectory checkpoint persisted: E${globalEpisodeNumber}-E${globalEpisodeNumber + rollingTrajectoryWindow.length - 1}`);
  }

  currentEpisodeTrajectory = rollingTrajectoryWindow.find(ep =>
    Number(ep.season) === Number(currentSeason) &&
    Number(ep.episode) === Number(currentEpisode)
  ) || null;

  if (!currentEpisodeTrajectory) {
    throw new Error(`[Pipeline] Authoritative story trajectory missing for S${currentSeason}E${currentEpisode}`);
  }
  console.log(`[Pipeline] ✓ Authoritative story trajectory locked for S${currentSeason}E${currentEpisode} (global #${globalEpisodeNumber})`);

  // ── 5. Hard episode simulation gate: authoritative story → persistent scene chain ──
  // Create the durable draft BEFORE the first scene-simulation call. Every scene
  // is checkpointed as it completes, so a provider failure can resume at the first
  // incomplete scene without regenerating earlier causal work.
  let episodeSimulation = null;
  const restoredSimulationForEpisode = isResuming ? safeJsonParse(existingDraft?.script, {}) : {};
  if (!draftEpisodeId) {
    draftEpisodeId = await createDraftEpisode({
      storyline_id:        storyline.id,
      episode_number:      globalEpisodeNumber,
      season_number:       currentSeason,
      script:              { episode_trajectory: currentEpisodeTrajectory },
      scene_count:         0,
      shot_count:          0,
      safety_check_passed: true,
      safety_notes:        null,
    });
    state.setCurrentEpisode({ title: storyline.title, seasonNumber: currentSeason, episodeNumber: currentEpisode, globalEpisodeNumber, draftEpisodeId });
    console.log(`[Pipeline] 💾 Durable draft created before episode simulation: ${draftEpisodeId}`);
  }

  currentEpisodeTrajectory = restoredSimulationForEpisode?.episode_trajectory || currentEpisodeTrajectory;
  episodeSimulation = restoredSimulationForEpisode?.narrative_simulation || null;

  const episodeSceneCheckpoint = async ({ stage, sceneNumber, simulation }) => {
    const persisted = {
      episode_trajectory: currentEpisodeTrajectory,
      narrative_simulation: simulation,
      checkpoint_state: {
        stage,
        last_scene_number: sceneNumber,
        completed_scene_numbers: simulation?.completed_scene_numbers || [],
        updated_at: new Date().toISOString(),
      },
    };
    persisted.global_continuity_state = _continuityStateForScript(persisted);
    await db.execute(
      `UPDATE episodes SET script = ?, scene_count = ?, shot_count = ?, global_continuity_state = ? WHERE id = ?`,
      [
        JSON.stringify(persisted),
        Array.isArray(simulation?.scene_beat_plan) ? simulation.scene_beat_plan.length : 0,
        0,
        JSON.stringify(persisted.global_continuity_state),
        draftEpisodeId,
      ]
    );
    episodeSimulation = simulation;
  };

  const expectedSceneCount = isSeriesMovie ? 20 : (targetMinutes <= 2 ? 8 : targetMinutes <= 5 ? 10 : 12);
  const episodeSimulationComplete = episodeSimulation &&
    episodeSimulation.simulation_status === 'complete' &&
    Array.isArray(episodeSimulation.scene_beat_plan) &&
    episodeSimulation.scene_beat_plan.length >= expectedSceneCount;

  if (!episodeSimulationComplete) {
    state.setStatus(
      state.STATES.WRITING,
      episodeSimulation?.scene_beat_plan?.length
        ? `Resuming episode scene simulation at scene ${(episodeSimulation.scene_beat_plan.length || 0) + 1}...`
        : `Simulating S${currentSeason}E${currentEpisode} scene-by-scene...`
    );
    episodeSimulation = await scriptWriter.simulateEpisodeStory({
      storyline,
      characters: characterList,
      recentEpisodes,
      episodeNumber: currentEpisode,
      seasonNumber: currentSeason,
      isFinale: isSeasonFinale,
      isSeriesMovie,
      targetMinutes,
      episodeTrajectory: currentEpisodeTrajectory,
      existingSimulation: episodeSimulation,
      checkpoint: episodeSceneCheckpoint,
    });
  } else {
    console.log(`[Pipeline] ↺ Restored complete episode scene simulation: S${currentSeason}E${currentEpisode} (${episodeSimulation.scene_beat_plan.length} scenes)`);
  }

  // ── 6. Write or restore episode script with durable stage checkpoints ───────
  let episodeScript;

  const persistScriptCheckpoint = async ({ stage, script, sceneNumber = null }) => {
    if (!draftEpisodeId || !script) return;
    const incoming = script && typeof script === 'object' ? script : {};
    const prior = episodeScript && typeof episodeScript === 'object' ? episodeScript : {};
    const priorStage = prior?.checkpoint_state?.stage || null;
    const incomingRank = _pipelineCheckpointRank(stage);
    const priorRank = _pipelineCheckpointRank(priorStage);
    const safeScript = {
      ...prior, ...incoming,
      episode_trajectory: incoming.episode_trajectory || prior.episode_trajectory,
      narrative_simulation: incoming.narrative_simulation || prior.narrative_simulation,
      scene_simulation: incoming.scene_simulation || prior.scene_simulation,
      shot_simulation: incoming.shot_simulation || prior.shot_simulation,
      scenes: Array.isArray(incoming.scenes) && incoming.scenes.length ? incoming.scenes : (Array.isArray(prior.scenes) ? prior.scenes : incoming.scenes),
      checkpoint_state: {
        ...(prior.checkpoint_state || {}), ...(incoming.checkpoint_state || {}),
        stage: priorRank > incomingRank ? priorStage : stage,
        last_scene_number: sceneNumber != null ? sceneNumber : (incoming.checkpoint_state?.last_scene_number ?? prior.checkpoint_state?.last_scene_number ?? null),
        updated_at: new Date().toISOString(),
      },
    };
    safeScript.global_continuity_state = _continuityStateForScript(safeScript);
    episodeScript = safeScript;
    const sceneCount = Array.isArray(safeScript.scenes) ? safeScript.scenes.length : 0;
    const shotCount = Array.isArray(safeScript.scenes)
      ? safeScript.scenes.reduce((n, s) => n + (Array.isArray(s?.shots) ? s.shots.length : 0), 0)
      : 0;

    await db.execute(
      `UPDATE episodes SET script = ?, scene_count = ?, shot_count = ?, global_continuity_state = ? WHERE id = ?`,
      [
        JSON.stringify(safeScript),
        sceneCount,
        shotCount,
        JSON.stringify(safeScript.global_continuity_state),
        draftEpisodeId,
      ]
    );

    const persistedStage = safeScript.checkpoint_state?.stage || stage;
    console.log(
      `[Pipeline] 💾 Script checkpoint persisted | stage=${persistedStage}` +
      `${sceneNumber != null ? ` scene=${sceneNumber}` : ''}` +
      ` scenes=${sceneCount} shots=${shotCount}`
    );
  };

  const loadedDraftScript = isResuming ? safeJsonParse(existingDraft?.script, {}) : {};
  const loadedScenes = Array.isArray(loadedDraftScript?.scenes) ? loadedDraftScript.scenes : [];
  const loadedCheckpointStage = loadedDraftScript?.checkpoint_state?.stage || null;
  const loadedCheckpointRank = _pipelineCheckpointRank(loadedCheckpointStage);

  // CHECKPOINT IS THE RESUME CURSOR.
  // Never infer the current production stage from the number of scenes currently
  // present in the script. A scene_shot_writing checkpoint can legitimately
  // contain only the scenes written so far; that is exactly what the next resume
  // must continue from.
  const resumeStage = loadedCheckpointStage || null;
  if (isResuming) {
    console.log(
      `[Pipeline] ↺ Resume cursor from persisted checkpoint: stage=${resumeStage || 'none'} ` +
      `lastScene=${loadedDraftScript?.checkpoint_state?.last_scene_number ?? 'n/a'} ` +
      `lastShot=${loadedDraftScript?.checkpoint_state?.last_shot_index ?? 'n/a'}`
    );
  }
  const resumeNeedsScriptWriting = !isResuming
    || !loadedDraftScript
    || !loadedDraftScript.episode_title
    || loadedCheckpointRank <= PIPELINE_CHECKPOINT_STAGE_ORDER.scene_shot_writing;

  // These values remain diagnostic only. They MUST NOT decide resume behavior.
  const hasDurableProductionArtifacts = Boolean(
    loadedDraftScript?.narrative_simulation ||
    loadedDraftScript?.scene_simulation ||
    loadedDraftScript?.shot_simulation ||
    loadedCheckpointRank >= PIPELINE_CHECKPOINT_STAGE_ORDER.blueprint
  );
  const resumedIncompleteScript = Boolean(
    isResuming &&
    resumeStage === 'scene_shot_writing'
  );

  if (resumeNeedsScriptWriting) {
    state.setStatus(
      state.STATES.WRITING,
      resumedIncompleteScript
        ? `Resuming from checkpoint=${resumeStage} for S${currentSeason}E${currentEpisode}...`
        : `Writing episode script for S${currentSeason}E${currentEpisode}...`
    );

    try {
      episodeScript = await scriptWriter.writeEpisodeScript({
        storyline,
        characters: characterList,
        recentEpisodes,
        episodeNumber: currentEpisode,
        seasonNumber: currentSeason,
        isFinale: isSeasonFinale,
        isSeriesMovie,
        targetMinutes,
        narrativeSimulation: episodeSimulation,
        existingScript: isResuming ? loadedDraftScript : null,
        checkpoint: persistScriptCheckpoint,
      });
    } catch (scriptErr) {
      if (scriptErr.llmExhausted) {
        const reason = `LLM keys exhausted during script writing/resume: ${scriptErr.message}`;
        console.error(`[Pipeline] ${reason}`);
        await saveDraftProgress(draftEpisodeId, loadedDraftScript, reason);
        state.setStatus(
          state.STATES.PAUSED,
          '⏸ Paused — LLM keys exhausted. Refill MISTRAL_KEYS / GROQ_KEYS then click Resume.'
        );
        await telegram.sendTelegram(
          `⏸ <b>Episode paused — LLM keys exhausted</b>\n\n` +
          `Refill <b>MISTRAL_KEYS</b> / <b>GROQ_KEYS</b> and click <b>Resume</b>.`
        );
        return;
      }
      throw scriptErr;
    }
  } else {
    episodeScript = loadedDraftScript;
    if (!episodeScript.safety_check_passed) {
      episodeScript.safety_check_passed = !!existingDraft.safety_check_passed;
    }
    console.log(
      `[Pipeline] ↺ Restored complete persisted script: "${episodeScript.episode_title || 'untitled'}" — no script-generation restart required`
    );
  }

  // Always restore authoritative episode metadata onto the script without
  // regenerating any already completed creative work.
  if (!episodeScript.episode_trajectory && currentEpisodeTrajectory) {
    episodeScript.episode_trajectory = currentEpisodeTrajectory;
  }
  if (!episodeScript.narrative_simulation && episodeSimulation) {
    episodeScript.narrative_simulation = episodeSimulation;
  }
  if (!episodeScript.scene_simulation && episodeSimulation) {
    episodeScript.scene_simulation = episodeSimulation;
  }

  // The checkpoint stage is authoritative. Do not advance a scene_shot_writing
  // checkpoint to script_ready_for_processing unless the writer actually returned
  // a complete script checkpoint. This prevents a one-scene partial script from
  // becoming the apparent production universe after a restart.
  let effectiveCheckpointStage = episodeScript?.checkpoint_state?.stage || loadedCheckpointStage || null;
  if (!isResuming || ['script_complete', 'script_ready_for_processing'].includes(String(effectiveCheckpointStage || '').toLowerCase())) {
    await persistScriptCheckpoint({
      stage: 'script_ready_for_processing',
      script: episodeScript,
    });
    effectiveCheckpointStage = episodeScript?.checkpoint_state?.stage || 'script_ready_for_processing';
  } else {
    console.log(
      `[Pipeline] ↺ Checkpoint remains authoritative: stage=${effectiveCheckpointStage || 'unknown'} ` +
      `scene=${episodeScript?.checkpoint_state?.last_scene_number ?? 'n/a'} — downstream media processing not started`
    );
    state.setStatus(
      state.STATES.GENERATING,
      `Checkpoint ${effectiveCheckpointStage || 'unknown'} requires continuation before media generation.`
    );
    return;
  }

  // ── Enforce scene speech coverage before any downstream rendering layers ──
  // Every character-led scene must contain meaningful audible speech: spoken
  // dialogue when the scene naturally supports it, otherwise a contextual
  // internal voice-over. Characterless establishing scenes remain ambient.
  episodeScript = await scriptWriter.ensureSceneSpeechCoverage(episodeScript, {
    storyline,
    characters: characterList,
  });
  if (episodeSimulation && !isResuming) {
    episodeScript.episode_trajectory = currentEpisodeTrajectory;
    episodeScript.narrative_simulation = episodeSimulation;
  } else if (isResuming && !episodeScript.episode_trajectory && currentEpisodeTrajectory) {
    episodeScript.episode_trajectory = currentEpisodeTrajectory;
  }

  // ── Enforce semantic LTX pacing (8–10s temporal canvas) ────────────────
  // On resume, the script was already processed on the first run and the shots
  // table already has rows with the processed shot indices. Re-running these
  // steps would re-split/re-index shots, causing the shotRowMap lookup to fail
  // (indices don't match) and triggering full regeneration of all shots.
  let faceLockRegistry = new Map();
  let sceneGraphs       = new Map();

  const shouldPostProcessScript =
    !isResuming ||
    resumedIncompleteScript ||
    ['script_complete', 'script_ready_for_processing'].includes(
      String(effectiveCheckpointStage || '').toLowerCase()
    );

  if (shouldPostProcessScript) {
    // LLM JSON can drift in scalar-vs-object shape; normalize before any
    // camera/continuity/hard-control engine assumes string methods are safe.
    episodeScript = _normalizeProductionSchemaTypes(episodeScript);
    episodeScript = _enforcePacingRules(episodeScript);
    // ── Normalize multi-speaker shots ────────────────────────────────────────────
    episodeScript = _normalizeMultiSpeakerShots(episodeScript);
    // Speaker splitting can insert reaction shots; recalculate their semantic durations too.
    episodeScript = _enforcePacingRules(episodeScript);
    // ── Apply cinematic shot-reverse-shot grammar ────────────────────────────────
    episodeScript = _applyCinematicShotSelection(episodeScript);
    // ── Scene State Engine: track positions, lighting, camera angle history ──────
    episodeScript = sceneState.applySceneState(episodeScript);
    episodeScript = globalContinuity.applyGlobalContinuity(episodeScript);
    // ── Temporal Consistency Layer: same face, pose progression, no visual resets ─
    episodeScript = temporalConsistency.applyTemporalConsistency(episodeScript);
    // ── Real Camera Simulation: focal length, movement curves, depth layering ─────
    episodeScript = cameraSim.applyCameraSimulation(episodeScript);
    // ── Music direction: one coherent episode-wide score description ─────────────
    episodeScript = _attachMusicDirection(episodeScript);
    // ── Motion System Upgrade: structured motion parameters ──────────────────────
    episodeScript = motionSystem.applyMotionSystem(episodeScript);
    episodeScript = _applyShotFrameHandoffs(episodeScript);
    // ── Hard Control Layers: face-lock, pose tracking, scene graph, multi-pass ──
    const hardControlResult = hardControl.applyHardControlLayers(episodeScript, characterList);
    faceLockRegistry = hardControlResult.faceLockRegistry;
    sceneGraphs       = hardControlResult.sceneGraphs;
    episodeScript = _applyShotFrameHandoffs(episodeScript);
    episodeScript.processing_state = {
      complete: true,
      completed_at: new Date().toISOString(),
    };
    await persistScriptCheckpoint({
      stage: 'media_generation_ready',
      script: episodeScript,
    });
  } else {
    // Rebuild hard control registries from the saved, already-processed script
    // without re-indexing or mutating scene/shot order.
    // Still (re)attach music direction — idempotent, and covers episodes saved
    // before this field existed on the shot objects.
    episodeScript = _attachMusicDirection(episodeScript);
    const hardControlResult = hardControl.applyHardControlLayers(episodeScript, characterList);
    faceLockRegistry = hardControlResult.faceLockRegistry;
    sceneGraphs       = hardControlResult.sceneGraphs;
  }

  // ── Runtime validator: ensure ≥ 120 seconds total clip_duration ──────────────
  // Retry the script call (up to 2 times) before spending Magic Hour credits on
  // a clip that will be too short to publish. Each retry tells the LLM exactly
  // how short the previous attempt was so it knows to write more.
  // SKIPPED on resume — the script was already validated on the first run and
  // re-running it would re-index shots, breaking the shotRowMap lookup.
  if (!isResuming) {
    const _sumRuntime = (script) =>
      (script.scenes || [])
        .flatMap(s => s.shots || [])
        .reduce((sum, sh) => sum + (parseFloat(sh.clip_duration) || 0), 0);

    let _rtAttempt = 0;
    while (_rtAttempt < 2) {
      const totalSecs = _sumRuntime(episodeScript);
      if (totalSecs >= 120) break;

      _rtAttempt++;
      const msg = `Script runtime ${totalSecs.toFixed(1)}s is below the 120s minimum — retry ${_rtAttempt}/2`;
      console.warn(`[Pipeline] ${msg}`);
      await telegram.sendTelegram(
        `⏱ <b>Script too short (${totalSecs.toFixed(1)}s < 120s)</b> for "<b>${storyline.title}</b>" ` +
        `S${currentSeason}E${currentEpisode} — retrying script (attempt ${_rtAttempt}/2)…`
      ).catch(() => {});

      try {
        episodeScript = await scriptWriter.writeEpisodeScript({
          storyline, characters: characterList, recentEpisodes,
          episodeNumber: currentEpisode, seasonNumber: currentSeason,
          isFinale: isSeasonFinale, isSeriesMovie, targetMinutes,
          narrativeSimulation: episodeSimulation,
          existingScript: episodeScript,
          checkpoint: persistScriptCheckpoint,
          runtimeRetryNote:
            `The previous script had only ${totalSecs.toFixed(1)} seconds of total clip_duration. ` +
            `The minimum is 120 seconds. Add more scenes and/or increase individual clip_durations ` +
            `so the sum across ALL shots reaches at least 120 seconds.`,
        });
      } catch (retryScriptErr) {
        if (retryScriptErr.llmExhausted) {
          const reason = `LLM keys exhausted during script runtime-retry: ${retryScriptErr.message}`;
          console.error(`[Pipeline] ${reason}`);
          if (draftEpisodeId) await saveDraftProgress(draftEpisodeId, {}, reason);
          state.setStatus(state.STATES.PAUSED,
            '⏸ Paused — LLM keys exhausted. Refill MISTRAL_KEYS / GROQ_KEYS then click Resume.');
          await telegram.sendTelegram(
            `⏸ <b>Episode paused — LLM keys exhausted during script retry</b>\n\n` +
            `Refill <b>MISTRAL_KEYS</b> / <b>GROQ_KEYS</b> and click <b>Resume</b>.`
          );
          return;
        }
        throw retryScriptErr;
      }
      episodeScript = await scriptWriter.ensureSceneSpeechCoverage(episodeScript, {
        storyline,
        characters: characterList,
      });
      episodeScript = _normalizeProductionSchemaTypes(episodeScript);
      episodeScript = _enforcePacingRules(episodeScript);
      episodeScript = _normalizeMultiSpeakerShots(episodeScript);
      // Re-run semantic pacing after any inserted/split shots.
      episodeScript = _enforcePacingRules(episodeScript);
      episodeScript = _applyCinematicShotSelection(episodeScript);
      episodeScript = sceneState.applySceneState(episodeScript);
    episodeScript = globalContinuity.applyGlobalContinuity(episodeScript);
      episodeScript = temporalConsistency.applyTemporalConsistency(episodeScript);
      episodeScript = cameraSim.applyCameraSimulation(episodeScript);
      episodeScript = _attachMusicDirection(episodeScript);
      episodeScript = motionSystem.applyMotionSystem(episodeScript);
      episodeScript = _applyShotFrameHandoffs(episodeScript);
      // Re-apply hard control layers after script retry
      const _hc = hardControl.applyHardControlLayers(episodeScript, characterList);
      // Update registries in the outer scope
      faceLockRegistry.clear();
      for (const [k, v] of _hc.faceLockRegistry) faceLockRegistry.set(k, v);
      sceneGraphs.clear();
      for (const [k, v] of _hc.sceneGraphs) sceneGraphs.set(k, v);
      episodeScript = _applyShotFrameHandoffs(episodeScript);
    }

    // After retries, warn but don't abort — a short episode is better than none.
    const finalSecs = _sumRuntime(episodeScript);
    if (finalSecs < 120) {
      console.warn(`[Pipeline] Script still short after retries (${finalSecs.toFixed(1)}s) — proceeding anyway`);
      await telegram.sendTelegram(
        `⚠️ <b>Script still short (${finalSecs.toFixed(1)}s)</b> after 2 retries for "<b>${storyline.title}</b>" ` +
        `S${currentSeason}E${currentEpisode} — proceeding with what we have.`
      ).catch(() => {});
    }
  }

  if (!episodeScript.safety_check_passed) {
    await telegram.sendTelegram(`⚠️ Content flag on ep ${globalEpisodeNumber} of "${storyline.title}". Skipping.`);
    state.setError(`Content flag: ${episodeScript.safety_notes}`);
    return;
  }

  const scenes   = episodeScript.scenes || [];

  // ── 5a. Use the simulation checkpoints produced by writeEpisodeScript ────
  // writeEpisodeScript already executes the complete simulation chain:
  // episode narrative → scene blueprint → per-scene shot simulation →
  // per-scene shot writing. Those artifacts are checkpointed as they complete.
  // Never regenerate them here.
  const sceneSimulation = episodeScript.scene_simulation || episodeSimulation || null;
  const shotSimulation = episodeScript.shot_simulation || null;
  const authoritativeEpisodeSimulation =
    episodeScript.narrative_simulation || episodeSimulation || null;

  if (!shotSimulation) {
    throw new Error(
      `[Pipeline] Shot simulation checkpoint missing for S${currentSeason}E${currentEpisode}; ` +
      `the script stage must complete shot simulation before media generation.`
    );
  }

  console.log(
    `[Pipeline] ↺ Using persisted simulation checkpoints | ` +
    `sceneSimulation=${!!sceneSimulation} shotSimulation=${(shotSimulation.shots || []).length} shots`
  );

  await persistScriptCheckpoint({
    stage: 'simulation_chain_locked',
    script: {
      ...episodeScript,
      scene_simulation: sceneSimulation,
      shot_simulation: shotSimulation,
      narrative_simulation: authoritativeEpisodeSimulation,
    },
  });

  const allShots = scenes.flatMap(s =>
    (s.shots || []).map(sh => ({
      ...sh,
      scene_number:        s.scene_number,
      composition:         s.composition,
      characters_in_shot:  sh.characters_in_shot || s.characters_present || [],
      // Scene-level context injected into the image prompt for narrative continuity
      _scene_description:  s.scene_description || '',
      _scene_location:     s.location          || '',
      _scene_emotion:      s.emotional_beat    || '',
      _lighting_design:    s.lighting_design   || '',
      _camera_language:    s.camera_language   || '',
      // Episode-level context — gives the image model the story thread each shot belongs to
      _episode_title:      episodeScript.episode_title   || '',
      _episode_logline:    episodeScript.logline          ||
                           storyline.logline              ||
                           storyline.plot_summary         || '',
    }))
  );

  // ── 5b. Create draft record (first run) or reuse existing (resume) ────────
  if (!draftEpisodeId) {
    draftEpisodeId = await createDraftEpisode({
      storyline_id:        storyline.id,
      episode_number:      globalEpisodeNumber,
      season_number:       currentSeason,
      script:              episodeScript,
      scene_count:         scenes.length,
      shot_count:          allShots.length,
      safety_check_passed: episodeScript.safety_check_passed,
      safety_notes:        episodeScript.safety_notes,
    });
    console.log(`[Pipeline] Draft episode created: ${draftEpisodeId}`);
    // Now that we have the draft ID, push it into the SSE state so the
    // dashboard live-counter targets the right card for new episodes too.
    state.setCurrentEpisode({ title: storyline.title, seasonNumber: currentSeason, episodeNumber: currentEpisode, globalEpisodeNumber, draftEpisodeId });
    state.setStatus(state.STATES.GENERATING, `Generating ${allShots.length} shots...`);
    await telegram.sendTelegram(
      `🎬 Ep ${globalEpisodeNumber} started: <b>${episodeScript.episode_title}</b> | ${allShots.length} shots | ${characterList.length} chars with identity lock`
    );
  }

  // Persist the episode-wide continuity ledger so HIL/restarts retain the same story-world state.
  await db.execute(`UPDATE episodes SET global_continuity_state = ?, script = ? WHERE id = ?`, [
    _continuityJsonForScript(episodeScript),
    JSON.stringify(episodeScript),
    draftEpisodeId,
  ]).catch(err => console.warn('[Continuity] Could not persist global continuity state:', err.message));

  // ── 6. Generate shots — backed by the shots table for reliable persistence ──
  // Each shot gets its own DB row.  State transitions written atomically:
  //   pending → mh_submitted (after MH job is submitted, before polling)
  //   mh_submitted → done    (after clip is uploaded to Cloudinary)
  //   any → failed           (after all retries exhausted)
  //
  // On resume after a Replit restart the loop:
  //   • skips 'done' rows and restores their clip URLs
  //   • resumes 'mh_submitted' rows by polling the saved job ID
  //   • regenerates 'pending'/'failed' rows from scratch
  //
  // Backward compat: old drafts may have shot URLs in the shot_state JSON column
  // and no shots-table rows yet.  upsertShotRows creates any missing rows, then
  // the migration block below promotes old JSON entries to 'done' rows.

  // Ensure every shot has a row (idempotent INSERT IGNORE)
  await upsertShotRows(draftEpisodeId, allShots);

  // Migrate old shot_state JSON → shots table (one-time, for pre-shots-table drafts)
  const legacyShotState = {};
  Object.assign(legacyShotState, safeJsonParse(existingDraft?.shot_state, {}));
  for (const [key, val] of Object.entries(legacyShotState)) {
    if (key.endsWith('_mh')) continue; // skip old in-flight keys
    const parts = key.split('_');
    const sceneNum = parseInt(parts[0], 10);
    const shotIdx  = parseInt(parts[1], 10);
    if (isNaN(sceneNum) || isNaN(shotIdx)) continue;
    const clipData  = typeof val === 'string' ? { url: val, clipDuration: 4 } : val;
    if (!clipData.url) continue;
    // Only overwrite if the row is still pending (don't clobber newer data)
    await db.execute(
      `UPDATE shots SET status = 'done', clip_url = ?, clip_duration = ?
       WHERE episode_id = ? AND scene_number = ? AND shot_index = ? AND status = 'pending'`,
      [clipData.url, clipData.clipDuration || 4, draftEpisodeId, sceneNum, shotIdx]
    );
  }

  // Load current shot state from table
  let shotRowMap = await getShotRowMap(draftEpisodeId);

  const shotClipsByScene  = new Map();
  const tmpImagePublicIds = [];
  let shotSuccesses = [...shotRowMap.values()].filter(r => r.status === 'done').length;
  let shotFailures  = 0;
  const retryLog    = [];
  let   mhWasExhausted  = false;
  let   tooManyFailed   = false; // set when shotFailAbortPct is exceeded — pauses instead of crashing

  // ── Dedicated scene background references ────────────────────────────────
  // Every scene gets one empty-set environment plate BEFORE shot image generation.
  // Characters are never baked into this reference. Every shot then receives
  // [scene background, character refs...] through generateShot.
  const sceneBackgroundStateRow = await db.queryOne(`SELECT scene_background_state FROM episodes WHERE id = ?`, [draftEpisodeId]);
  const sceneBackgroundState = safeJsonParse(sceneBackgroundStateRow?.scene_background_state, {});
  for (const scene of scenes) {
    try {
      await _ensureSceneBackground({ episodeId: draftEpisodeId, storyline, globalEpisodeNumber, scene, savedState: sceneBackgroundState });
    } catch (bgErr) {
      console.warn(`[Pipeline] Scene ${scene.scene_number} background generation failed: ${bgErr.message}`);
      if (!sceneBackgroundState[String(scene.scene_number)]) throw bgErr;
    }
  }
  const sceneFirstImageUrls = new Map(Object.entries(sceneBackgroundState).map(([k,v]) => [Number(k), v]));

  if (isResuming) {
    console.log(`[Pipeline] Resuming draft ${draftEpisodeId}: ${shotSuccesses}/${allShots.length} shots already done`);
    state.setStatus(state.STATES.GENERATING, `Resuming — ${shotSuccesses} shots saved, continuing...`);
    state.setShotProgress(shotSuccesses, allShots.length);
    await telegram.sendTelegram(
      `▶️ <b>Resuming paused episode</b> of "<b>${storyline.title}</b>"\n` +
      `${shotSuccesses}/${allShots.length} shots already saved — picking up where we left off...`
    );
  } else {
    state.setShotProgress(0, allShots.length);
  }

  // ── Early scene compilation setup ──────────────────────────────────────────
  // Compile each scene immediately when all its shots are done, overlapping
  // with generation of later scenes' shots. This avoids a heavy sequential
  // compilation pass at the end — by the time the last shot finishes, most
  // scenes are already compiled and the final merge is lightweight.
  const sceneMeta     = Object.fromEntries(scenes.map(s => [s.scene_number, s.composition || 'cut']));
  const sceneEffectsMap = Object.fromEntries(
    scenes.map(s => [s.scene_number, s.ffmpeg_effects || {}])
  );
  const sceneShotTotalCount = new Map();
  for (const s of allShots) {
    sceneShotTotalCount.set(s.scene_number, (sceneShotTotalCount.get(s.scene_number) || 0) + 1);
  }
  const pendingSceneCompiles = new Map();  // sceneNum → Promise (fire-and-forget)

  async function _persistSceneUrl(ffmpegUrl, sceneNum) {
    const pubId = cloudinary.scenePublicId(globalEpisodeNumber, sceneNum);
    const permanentUrl = await cloudinary.uploadVideoFromUrl(ffmpegUrl, pubId);
    console.log(`[Pipeline] Scene ${sceneNum} persisted to Cloudinary → ${permanentUrl}`);
    return permanentUrl;
  }

  async function _compileSceneEarly(sceneNum) {
    if (savedSceneState[sceneNum]) return;
    const total = sceneShotTotalCount.get(sceneNum) || 0;
    if (total === 0) return;

    console.log(`[Pipeline] Scene ${sceneNum} — starting early compile (${total} shots)`);

    const doneRows = await db.query(
      `SELECT shot_index, clip_url, clip_duration FROM shots
       WHERE episode_id = ? AND scene_number = ? AND status = 'done'
       ORDER BY shot_index ASC`,
      [draftEpisodeId, sceneNum]
    );
    if (doneRows.length < total) {
      console.warn(`[Pipeline] Scene ${sceneNum} early compile: only ${doneRows.length}/${total} shots done — deferring to final pass`);
      return;
    }

    // Plain URL strings only — all visual effects come from Magic Hour's video generation.
    // The FFmpeg service only does basic concatenation ("cut" layout) + simple fade transitions.
    const plainClips = doneRows.map(row => row.clip_url).filter(Boolean);
    const sceneEffects = sceneEffectsMap[sceneNum] || {};
    const layout       = 'cut';

    try {
      const rawUrl    = await compiler.composeSceneSmartAndWait(plainClips, layout, sceneEffects);
      const sceneUrl = await _persistSceneUrl(rawUrl, sceneNum);
      savedSceneState[sceneNum] = sceneUrl;
      await saveDraftProgress(draftEpisodeId, savedSceneState, null);
      console.log(`[Pipeline] Scene ${sceneNum} early-compiled → ${sceneUrl}`);
    } catch (err) {
      console.error(`[Pipeline] Scene ${sceneNum} early compile failed: ${err.message}`);
      // savedSceneState[sceneNum] stays unset — final compilation loop will retry
    }
  }

  function _maybeStartEarlyCompile(sceneNum) {
    if (savedSceneState[sceneNum]) return;
    if (pendingSceneCompiles.has(sceneNum)) return;
    const total = sceneShotTotalCount.get(sceneNum) || 0;
    const clips = shotClipsByScene.get(sceneNum) || [];
    if (total > 0 && clips.length >= total) {
      pendingSceneCompiles.set(sceneNum, _compileSceneEarly(sceneNum));
    }
  }

  // ── Manual pause checkpoint ─────────────────────────────────────────────
  // Called between shots / retry rounds only — never mid-API-call — so the
  // current shot always finishes and is persisted before we stop. Mirrors
  // the exhausted-credits pause path: save progress, flip state to PAUSED,
  // notify Telegram, and let the caller break out of its loop.
  let _manualPauseTriggered = false;
  async function _checkManualPauseRequest(contextLabel) {
    if (!_pauseRequested) return false;
    _manualPauseTriggered = true;
    _pauseRequested = false; // consume the request
    if (pendingSceneCompiles.size > 0) {
      console.log(`[Pipeline] Awaiting ${pendingSceneCompiles.size} early scene compile(s) before manual pause...`);
      await Promise.allSettled([...pendingSceneCompiles.values()]);
      pendingSceneCompiles.clear();
    }
    const reason = `Paused by user (during ${contextLabel}) — ${shotSuccesses}/${allShots.length} shots saved.`;
    await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
    state.setShotProgress(shotSuccesses, allShots.length);
    state.setStatus(state.STATES.PAUSED,
      `⏸ Paused by user — ${shotSuccesses}/${allShots.length} shots saved. Click Resume to continue.`);
    await telegram.sendTelegram(
      `⏸ <b>Pipeline paused by user</b>\n` +
      `✅ ${shotSuccesses}/${allShots.length} shots saved to database.\n` +
      `Click <b>Resume</b> on the dashboard to continue.`
    ).catch(() => {});
    console.log(`[Pipeline] Manual pause honored during ${contextLabel} — ${shotSuccesses}/${allShots.length} shots saved.`);
    return true;
  }

  // Pre-check: scenes already complete on resume — compile immediately so they
  // overlap with generation of any remaining scenes.
  {
    const preDoneCount = new Map();
    for (const row of shotRowMap.values()) {
      if (row.status === 'done') {
        preDoneCount.set(row.scene_number, (preDoneCount.get(row.scene_number) || 0) + 1);
      }
    }
    for (const [sceneNum, doneCount] of preDoneCount) {
      const total = sceneShotTotalCount.get(sceneNum) || 0;
      if (doneCount >= total && total > 0 && !savedSceneState[sceneNum]) {
        pendingSceneCompiles.set(sceneNum, _compileSceneEarly(sceneNum));
      }
    }
  }

  for (let i = 0; i < allShots.length; i++) {
    if (await _checkManualPauseRequest('shot generation')) break;

    const shot     = allShots[i];
    const prevShot = i > 0 ? allShots[i - 1] : null;
    const stateKey = `${shot.scene_number}_${shot.shot_index}`;
    const shotRow  = shotRowMap.get(stateKey);

    if (!shotClipsByScene.has(shot.scene_number)) shotClipsByScene.set(shot.scene_number, []);

    // ── Existing clip: restore it regardless of the transient row status ──
    // A clip URL is the strongest form of persistence. Older runs could leave
    // the row pending/failed after the clip upload succeeded, so status alone
    // must never trigger another CF Worker or video-generation call.
    if (shotRow?.clip_url) {
      // shotSuccesses was pre-seeded above by counting status==='done' rows,
      // so only bump it here for rows that weren't already in that count —
      // otherwise a resumed run double-counts every already-done shot.
      const wasAlreadyCounted = shotRow.status === 'done';
      if (!wasAlreadyCounted) {
        await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
          status: 'done', mh_job_id: null, mh_api_key: null,
        });
      }
      const clipEntry = { url: shotRow.clip_url, clipDuration: parseFloat(shotRow.clip_duration) || shot.clip_duration || 4 };
      shotClipsByScene.get(shot.scene_number).push(clipEntry);
      _maybeStartEarlyCompile(shot.scene_number);
      if (!wasAlreadyCounted) shotSuccesses++;
      state.setShotProgress(shotSuccesses, allShots.length);
      state.setProgress(i + 1, allShots.length, `Shot ${i + 1}/${allShots.length} — reused ✓`);
      continue; // sceneFirstImageUrls already populated from shotRowMap pre-scan above
    }

    // ── Resume an in-flight MH job interrupted mid-poll ──────────────────
    // The row was written to status='mh_submitted' before polling began, so
    // a Replit restart during the poll can continue from the saved job ID.
    if (shotRow?.status === 'mh_submitted' && shotRow.mh_job_id) {
      console.log(`[Pipeline] Shot S${shot.scene_number}/idx${shot.shot_index} — resuming saved MH job ${shotRow.mh_job_id}`);
      state.setProgress(i + 1, allShots.length, `Shot ${i + 1}/${allShots.length} — resuming MH poll`);
      try {
        const videoUrl = await videoGen.pollVideoJob(shotRow.mh_job_id, shotRow.mh_api_key);
        const shotPubId = cloudinary.shotPublicId(storyline.id, globalEpisodeNumber, shot.scene_number, shot.shot_index);
        const clipUrl   = await cloudinary.uploadVideoFromUrl(videoUrl, shotPubId);
        const clipDuration = shot.clip_duration || shot.duration || 4;
        await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
          status: 'done', clip_url: clipUrl, clip_duration: clipDuration,
          mh_job_id: null, mh_api_key: null,
        });
        const clipEntry = { url: clipUrl, clipDuration: clipDuration };
        shotClipsByScene.get(shot.scene_number).push(clipEntry);
        _maybeStartEarlyCompile(shot.scene_number);
        shotSuccesses++;
        state.setShotProgress(shotSuccesses, allShots.length);
        state.setProgress(i + 1, allShots.length, `Shot ${i + 1}/${allShots.length} — resumed MH ✓`);
        console.log(`[Pipeline] Shot S${shot.scene_number}/idx${shot.shot_index} completed via resumed MH poll`);
        continue;
      } catch (pollErr) {
        // Job expired / errored — reset to pending so we regenerate
        console.warn(`[Pipeline] Saved MH job ${shotRow.mh_job_id} failed (${pollErr.message}) — regenerating`);
        await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
          status: 'pending', mh_job_id: null, mh_api_key: null,
          error_count: (shotRow.error_count || 0) + 1, last_error: pollErr.message.slice(0, 500),
        });
        // fall through to normal generation
      }
    }

    state.setProgress(i + 1, allShots.length, `Shot ${i + 1}/${allShots.length} — Scene ${shot.scene_number}`);

    const sceneBgRef = sceneFirstImageUrls.get(shot.scene_number) || null;
    const onImageGenerated = _makeShotImagePersistenceCallback({
      episodeId: draftEpisodeId, shot, storyline, globalEpisodeNumber,
    });
    const storedImageUrl = _storedShotImageUrl(shotRow?.image_url);

    try {
      const { clipUrl, imageTmpPublicId } = await generateShot(
        _attachLtxPromptCapture(shot, { episodeId: draftEpisodeId, sceneNumber: shot.scene_number, shotIndex: shot.shot_index }), storyline, characterList, globalEpisodeNumber,
        // onMhSubmitted: write job ID to DB before polling so a restart can resume the poll
        async (jobId, apiKey, imgTmpPubId) => {
          await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
            status:     'mh_submitted',
            mh_job_id:  jobId,
            mh_api_key: apiKey,
          });
          console.log(`[Pipeline] Shot S${shot.scene_number}/idx${shot.shot_index} MH job ${jobId} written to DB — safe to restart`);
        },
        prevShot,          // scene continuity context for the image prompt
        sceneBgRef,        // scene background reference image (null for first shot in scene)
        onImageGenerated,  // uploads persistent scene BG before MH submission
        storedImageUrl,     // reuseImageUrl — DB-first; avoids another CF Worker call
        faceLockRegistry   // hard-control face-lock registry built earlier in _runPipeline
      );
      if (imageTmpPublicId) tmpImagePublicIds.push(imageTmpPublicId);

      const clipDuration = shot.clip_duration || shot.duration || 4;
      await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
        status: 'done', clip_url: clipUrl, clip_duration: clipDuration,
        mh_job_id: null, mh_api_key: null,
      });
      shotClipsByScene.get(shot.scene_number).push({ url: clipUrl, clipDuration: clipDuration });
      _maybeStartEarlyCompile(shot.scene_number);
      shotSuccesses++;
      state.setShotProgress(shotSuccesses, allShots.length);

    } catch (err) {
      // ── Magic Hour credit exhaustion — pause gracefully ─────────────────
      if (err.mhExhausted) {
        mhWasExhausted = true;
        const reason = `Magic Hour credits exhausted after ${shotSuccesses} of ${allShots.length} shots`;
        await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
        state.setShotProgress(shotSuccesses, allShots.length);
        state.setStatus(state.STATES.PAUSED,
          `⏸ Paused — Magic Hour credits exhausted. ${shotSuccesses}/${allShots.length} shots saved.`);
        await telegram.sendTelegram(
          `⏸ <b>Episode paused — Magic Hour credits exhausted</b>\n` +
          `✅ ${shotSuccesses}/${allShots.length} shots saved to database.\n` +
          `Top up your credits and click <b>Resume</b> on the dashboard to continue from where we stopped.`
        );
        break;
      }

      // ── LTX / ZeroGPU quota exhaustion — all HF tokens cooling down ──────
      if (err.zeroGpuExhausted) {
        const reason = `LTX HF tokens exhausted (ZeroGPU quota) after ${shotSuccesses} of ${allShots.length} shots`;
        await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
        state.setShotProgress(shotSuccesses, allShots.length);
        state.setStatus(state.STATES.PAUSED,
          `⏸ Paused — LTX ZeroGPU quota exhausted. ${shotSuccesses}/${allShots.length} shots saved.`);
        await telegram.sendTelegram(
          `⏸ <b>Episode paused — LTX ZeroGPU quota exhausted</b>\n` +
          `✅ ${shotSuccesses}/${allShots.length} shots saved to database.\n` +
          `All HF_TOKENS are in their 24h cooldown. They'll retry automatically, or add more tokens and click <b>Resume</b>.`
        );
        break;
      }

      // ── CF Worker exhaustion — all URLs and keys depleted ──────────────
      // Pause immediately and notify via Telegram so the operator can upload
      // more CF worker keys/URLs to get the job finished.
      if (err.cfExhausted) {
        const reason = `CF Worker URLs and keys exhausted after ${shotSuccesses} of ${allShots.length} shots`;
        await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
        state.setShotProgress(shotSuccesses, allShots.length);
        state.setStatus(state.STATES.PAUSED,
          `⏸ Paused — CF Worker image generation exhausted. ${shotSuccesses}/${allShots.length} shots saved.`);
        await telegram.sendTelegram(
          `⏸ <b>Episode paused — CF Worker URLs and keys exhausted</b>\n` +
          `✅ ${shotSuccesses}/${allShots.length} shots saved to database.\n` +
          `All Cloudflare Worker URLs have hit their daily quota.\n` +
          `Upload more CF_WORKER_URL entries and click <b>Resume</b> on the dashboard to continue.`
        );
        break;
      }

      // ── Regular shot failure ───────────────────────────────────────────
      shotFailures++;
      const msg = `Shot ${i + 1} (S${shot.scene_number}/idx${shot.shot_index}) failed after ${config.shotMaxRetries} retries: ${err.message}`;
      console.error(`[Pipeline] ${msg}`);
      retryLog.push(msg);
      await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
        status: 'failed',
        error_count: (shotRow?.error_count || 0) + config.shotMaxRetries,
        last_error: err.message.slice(0, 500),
        last_prompt: err.lastPrompt || shot.image_prompt || null,
        failure_reason: err.failureReason || 'unknown',
      }).catch(() => {});
      await telegram.sendTelegram(`⚠️ ${msg}`);

      const totalSoFar = shotSuccesses + shotFailures;
      if (totalSoFar >= Math.ceil(allShots.length / 2)) {
        const failPct = shotFailures / allShots.length;
        if (failPct > config.shotFailAbortPct) {
          // Pause gracefully instead of crashing — preserves all saved shots so Resume can continue
          tooManyFailed = true;
          const reason = `Too many shots failed: ${Math.round(failPct * 100)}% (threshold ${Math.round(config.shotFailAbortPct * 100)}%). Fix API keys and click Resume.`;
          console.error(`[Pipeline] ${reason}`);
          await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
          state.setShotProgress(shotSuccesses, allShots.length);
          state.setStatus(state.STATES.PAUSED, `⏸ Paused — ${reason}`);
          await telegram.sendTelegram(
            `⏸ <b>Episode paused — too many shot failures</b>\n` +
            `✅ ${shotSuccesses}/${allShots.length} shots saved to database.\n` +
            `❌ ${shotFailures} shots failed (${Math.round(failPct * 100)}% failure rate).\n\n` +
            `Fix your API keys (Google, ${config.videoProvider === 'magichour' ? 'Magic Hour' : 'LTX/HF'}) and click <b>Resume</b> on the dashboard to continue.`
          );
          break;
        }
      }
    }
  }

  // Await any in-flight early scene compiles before pausing so compiled
  // scenes are saved to draft progress and available on Resume.
  if (pendingSceneCompiles.size > 0) {
    console.log(`[Pipeline] Awaiting ${pendingSceneCompiles.size} early scene compile(s) before pause...`);
    await Promise.allSettled([...pendingSceneCompiles.values()]);
    pendingSceneCompiles.clear();
  }

  // Episode paused — exit cleanly; all shot rows persisted; state is PAUSED
  // Magic Hour credit exhaustion, high-failure-rate abort, and manual user
  // pause all exit gracefully here.
  if (mhWasExhausted || tooManyFailed || _manualPauseTriggered) return;

  // ── Second-pass: retry any shots that failed in the main pass ───────────────
  // A transient API error mid-run may leave some shots marked 'failed' while
  // others succeeded.  Before proceeding to compilation we make one additional
  // attempt at every failed shot so no clip is silently skipped.
  {
    const failedRows = await db.query(
      `SELECT scene_number, shot_index, clip_url, clip_duration, image_url FROM shots
       WHERE episode_id = ? AND status = 'failed'
       ORDER BY scene_number, shot_index`,
      [draftEpisodeId]
    );
    if (failedRows.length > 0) {
      console.log(`[Pipeline] Second-pass retry: ${failedRows.length} failed shot(s)`);
      state.setStatus(state.STATES.GENERATING, `Retrying ${failedRows.length} failed shot(s)...`);
      await telegram.sendTelegram(
        `🔄 <b>Second-pass retry</b> — ${failedRows.length} shot(s) failed in first pass, retrying now…`
      );

      for (const row of failedRows) {
        if (await _checkManualPauseRequest('second-pass retry')) break;

        const shot    = allShots.find(s => s.scene_number === row.scene_number && s.shot_index === row.shot_index);
        if (!shot) continue;
        const shotIdx = allShots.indexOf(shot);
        const prevShot = shotIdx > 0 ? allShots[shotIdx - 1] : null;

        // A previous attempt may have uploaded the clip successfully before
        // the row was marked failed. Never regenerate such a shot.
        if (row.clip_url) {
          await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
            status: 'done', mh_job_id: null, mh_api_key: null,
          });
          const clipDuration = parseFloat(row.clip_duration) || shot.clip_duration || shot.duration || 4;
          if (!shotClipsByScene.has(shot.scene_number)) shotClipsByScene.set(shot.scene_number, []);
          shotClipsByScene.get(shot.scene_number).push({ url: row.clip_url, clipDuration });
          shotSuccesses++;
          state.setShotProgress(shotSuccesses, allShots.length);
          console.log(`[Pipeline] Second-pass retry reused existing clip: S${shot.scene_number}/idx${shot.shot_index}`);
          continue;
        }

        // Reset to pending so generateShot can overwrite it on success
        await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, { status: 'pending' });

        const retrySceneBgRef = sceneFirstImageUrls.get(shot.scene_number) || null;
        const retryOnImageGenerated = _makeShotImagePersistenceCallback({
          episodeId: draftEpisodeId, shot, storyline, globalEpisodeNumber, logLabel: 'second-pass retry',
        });
        try {
          const { clipUrl, imageTmpPublicId } = await generateShot(
            _attachLtxPromptCapture(shot, { episodeId: draftEpisodeId, sceneNumber: shot.scene_number, shotIndex: shot.shot_index }), storyline, characterList, globalEpisodeNumber,
            async (jobId, apiKey, imgTmpPubId) => {
              await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
                status: 'mh_submitted', mh_job_id: jobId, mh_api_key: apiKey,
              });
            },
            prevShot,
            retrySceneBgRef,
            retryOnImageGenerated,
            _storedShotImageUrl(row.image_url), // reuseImageUrl — DB-first
            faceLockRegistry   // hard-control face-lock registry built earlier in _runPipeline
          );
          if (imageTmpPublicId) tmpImagePublicIds.push(imageTmpPublicId);
          const clipDuration = shot.clip_duration || shot.duration || 4;
          await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
            status: 'done', clip_url: clipUrl, clip_duration: clipDuration, mh_job_id: null, mh_api_key: null,
          });
          if (!shotClipsByScene.has(shot.scene_number)) shotClipsByScene.set(shot.scene_number, []);
          shotClipsByScene.get(shot.scene_number).push({ url: clipUrl, clipDuration: clipDuration });
          _maybeStartEarlyCompile(shot.scene_number);
          shotSuccesses++;
          shotFailures = Math.max(0, shotFailures - 1);
          state.setShotProgress(shotSuccesses, allShots.length);
          console.log(`[Pipeline] Second-pass retry succeeded: S${shot.scene_number}/idx${shot.shot_index}`);
        } catch (retryErr) {
          if (retryErr.mhExhausted) {
            mhWasExhausted = true;
            const reason = `Magic Hour credits exhausted during second-pass retry after ${shotSuccesses} shots`;
            await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
            state.setStatus(state.STATES.PAUSED,
              `⏸ Paused — Magic Hour credits exhausted. ${shotSuccesses}/${allShots.length} shots saved.`);
            await telegram.sendTelegram(
              `⏸ <b>Episode paused — Magic Hour credits exhausted</b>\n` +
              `✅ ${shotSuccesses}/${allShots.length} shots saved. Top up and click <b>Resume</b>.`
            );
            break;
          }
          if (retryErr.zeroGpuExhausted) {
            const reason = `LTX HF tokens exhausted (ZeroGPU quota) during second-pass retry after ${shotSuccesses} shots`;
            await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
            state.setStatus(state.STATES.PAUSED,
              `⏸ Paused — LTX ZeroGPU quota exhausted. ${shotSuccesses}/${allShots.length} shots saved.`);
            await telegram.sendTelegram(
              `⏸ <b>Episode paused — LTX ZeroGPU quota exhausted</b>\n` +
              `✅ ${shotSuccesses}/${allShots.length} shots saved. Tokens retry automatically after 24h, or add more and click <b>Resume</b>.`
            );
            break;
          }
          if (retryErr.cfExhausted) {
            const reason = `CF Worker URLs and keys exhausted during second-pass retry after ${shotSuccesses} shots`;
            await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
            state.setStatus(state.STATES.PAUSED,
              `⏸ Paused — CF Worker image generation exhausted. ${shotSuccesses}/${allShots.length} shots saved.`);
            await telegram.sendTelegram(
              `⏸ <b>Episode paused — CF Worker URLs and keys exhausted</b>\n` +
              `✅ ${shotSuccesses}/${allShots.length} shots saved.\n` +
              `Upload more CF_WORKER_URL entries and click <b>Resume</b> to continue.`
            );
            break;
          }
          await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
            status: 'failed', last_error: retryErr.message.slice(0, 500),
            last_prompt: retryErr.lastPrompt || shot.image_prompt || null,
            failure_reason: retryErr.failureReason || 'unknown',
          }).catch(() => {});
          console.warn(`[Pipeline] Second-pass retry failed: S${shot.scene_number}/idx${shot.shot_index} — ${retryErr.message}`);
        }
      }
    }
  }

  // Await early compiles that were kicked off during the second-pass retry.
  if (pendingSceneCompiles.size > 0) {
    console.log(`[Pipeline] Awaiting ${pendingSceneCompiles.size} early scene compile(s) after second-pass...`);
    await Promise.allSettled([...pendingSceneCompiles.values()]);
    pendingSceneCompiles.clear();
  }

  if (mhWasExhausted || _manualPauseTriggered) return;

  // ── Third-pass: persistent retry loop for any shots still failing ────────────
  // The pipeline MUST NOT drop a shot and move on. If any shots are still marked
  // 'failed' after the second pass, we enter a persistent retry loop with
  // increasing backoff. The only exit conditions are:
  //   1. All shots succeed
  //   2. Magic Hour credits are exhausted (pause for top-up)
  //   3. CF Worker URLs/keys are exhausted (pause for top-up)
  //   4. LLM keys are exhausted (pause for top-up)
  // This ensures no sparse scenes — every shot in the script gets a clip.
  {
    const MAX_PERSISTENT_ROUNDS = 5;
    const BASE_BACKOFF_MS = 10000;

    for (let round = 1; round <= MAX_PERSISTENT_ROUNDS; round++) {
      if (mhWasExhausted || _manualPauseTriggered) break;
      if (await _checkManualPauseRequest('persistent retry')) break;

      const failedRows = await db.query(
        `SELECT scene_number, shot_index, clip_url, clip_duration, image_url
         FROM shots WHERE episode_id = ? AND status = 'failed'
         ORDER BY scene_number, shot_index`,
        [draftEpisodeId]
      );

      if (failedRows.length === 0) {
        console.log(`[Pipeline] Persistent retry: all shots succeeded after round ${round - 1}`);
        break;
      }

      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, round - 1); // 10s, 20s, 40s, 80s, 160s
      console.log(
        `[Pipeline] Persistent retry round ${round}/${MAX_PERSISTENT_ROUNDS}: ` +
        `${failedRows.length} shot(s) still failing — waiting ${Math.round(backoffMs / 1000)}s before retry...`
      );
      state.setStatus(state.STATES.GENERATING,
        `Persistent retry round ${round}/${MAX_PERSISTENT_ROUNDS}: ${failedRows.length} shot(s) still failing...`);
      await telegram.sendTelegram(
        `🔄 <b>Persistent retry round ${round}/${MAX_PERSISTENT_ROUNDS}</b>\n` +
        `${failedRows.length} shot(s) still failing — retrying after ${Math.round(backoffMs / 1000)}s backoff...`
      ).catch(() => {});

      await new Promise(r => setTimeout(r, backoffMs));

      for (const row of failedRows) {
        if (await _checkManualPauseRequest('persistent retry')) break;

        const shot    = allShots.find(s => s.scene_number === row.scene_number && s.shot_index === row.shot_index);
        if (!shot) continue;
        const shotIdx = allShots.indexOf(shot);
        const prevShot = shotIdx > 0 ? allShots[shotIdx - 1] : null;

        if (row.clip_url) {
          await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
            status: 'done', mh_job_id: null, mh_api_key: null,
          });
          const clipDuration = parseFloat(row.clip_duration) || shot.clip_duration || shot.duration || 4;
          if (!shotClipsByScene.has(shot.scene_number)) shotClipsByScene.set(shot.scene_number, []);
          shotClipsByScene.get(shot.scene_number).push({ url: row.clip_url, clipDuration });
          shotSuccesses++;
          state.setShotProgress(shotSuccesses, allShots.length);
          console.log(`[Pipeline] Persistent retry reused existing clip: S${shot.scene_number}/idx${shot.shot_index}`);
          continue;
        }

        await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, { status: 'pending' });

        const retrySceneBgRef = sceneFirstImageUrls.get(shot.scene_number) || null;
        const retryOnImageGenerated = _makeShotImagePersistenceCallback({
          episodeId: draftEpisodeId, shot, storyline, globalEpisodeNumber, logLabel: `persistent retry ${round}`,
        });

        try {
          const { clipUrl, imageTmpPublicId } = await generateShot(
            shot, storyline, characterList, globalEpisodeNumber,
            async (jobId, apiKey, imgTmpPubId) => {
              await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
                status: 'mh_submitted', mh_job_id: jobId, mh_api_key: apiKey,
              });
            },
            prevShot,
            retrySceneBgRef,
            retryOnImageGenerated,
            _storedShotImageUrl(row.image_url), // reuseImageUrl — DB-first
            faceLockRegistry   // hard-control face-lock registry built earlier in _runPipeline
          );
          if (imageTmpPublicId) tmpImagePublicIds.push(imageTmpPublicId);
          const clipDuration = shot.clip_duration || shot.duration || 4;
          await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
            status: 'done', clip_url: clipUrl, clip_duration: clipDuration, mh_job_id: null, mh_api_key: null,
          });
          if (!shotClipsByScene.has(shot.scene_number)) shotClipsByScene.set(shot.scene_number, []);
          shotClipsByScene.get(shot.scene_number).push({ url: clipUrl, clipDuration: clipDuration });
          _maybeStartEarlyCompile(shot.scene_number);
          shotSuccesses++;
          shotFailures = Math.max(0, shotFailures - 1);
          state.setShotProgress(shotSuccesses, allShots.length);
          console.log(`[Pipeline] Persistent retry round ${round} succeeded: S${shot.scene_number}/idx${shot.shot_index}`);
        } catch (retryErr) {
          if (retryErr.mhExhausted) {
            mhWasExhausted = true;
            const reason = `Magic Hour credits exhausted during persistent retry (round ${round}) after ${shotSuccesses} shots`;
            await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
            state.setStatus(state.STATES.PAUSED,
              `⏸ Paused — Magic Hour credits exhausted. ${shotSuccesses}/${allShots.length} shots saved.`);
            await telegram.sendTelegram(
              `⏸ <b>Episode paused — Magic Hour credits exhausted</b>\n` +
              `✅ ${shotSuccesses}/${allShots.length} shots saved. Top up and click <b>Resume</b>.`
            );
            break;
          }
          if (retryErr.zeroGpuExhausted) {
            const reason = `LTX HF tokens exhausted (ZeroGPU quota) during persistent retry (round ${round}) after ${shotSuccesses} shots`;
            await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
            state.setStatus(state.STATES.PAUSED,
              `⏸ Paused — LTX ZeroGPU quota exhausted. ${shotSuccesses}/${allShots.length} shots saved.`);
            await telegram.sendTelegram(
              `⏸ <b>Episode paused — LTX ZeroGPU quota exhausted</b>\n` +
              `✅ ${shotSuccesses}/${allShots.length} shots saved. Tokens retry automatically after 24h, or add more and click <b>Resume</b>.`
            );
            break;
          }
          if (retryErr.cfExhausted) {
            const reason = `CF Worker URLs and keys exhausted during persistent retry (round ${round}) after ${shotSuccesses} shots`;
            await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
            state.setStatus(state.STATES.PAUSED,
              `⏸ Paused — CF Worker image generation exhausted. ${shotSuccesses}/${allShots.length} shots saved.`);
            await telegram.sendTelegram(
              `⏸ <b>Episode paused — CF Worker URLs and keys exhausted</b>\n` +
              `✅ ${shotSuccesses}/${allShots.length} shots saved.\n` +
              `Upload more CF_WORKER_URL entries and click <b>Resume</b> to continue.`
            );
            break;
          }
          if (retryErr.llmExhausted) {
            const reason = `LLM keys exhausted during persistent retry (round ${round}) after ${shotSuccesses} shots`;
            await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
            state.setStatus(state.STATES.PAUSED,
              `⏸ Paused — LLM keys exhausted. ${shotSuccesses}/${allShots.length} shots saved.`);
            await telegram.sendTelegram(
              `⏸ <b>Episode paused — LLM keys exhausted</b>\n` +
              `✅ ${shotSuccesses}/${allShots.length} shots saved.\n` +
              `Add more Mistral/Groq keys and click <b>Resume</b> to continue.`
            );
            break;
          }
          await updateShotRow(draftEpisodeId, shot.scene_number, shot.shot_index, {
            status: 'failed', last_error: retryErr.message.slice(0, 500),
            last_prompt: retryErr.lastPrompt || shot.image_prompt || null,
            failure_reason: retryErr.failureReason || 'unknown',
          }).catch(() => {});
          console.warn(`[Pipeline] Persistent retry round ${round} failed: S${shot.scene_number}/idx${shot.shot_index} — ${retryErr.message}`);
        }
      }
    }

    // Manual pause during the persistent-retry phase already saved progress
    // and set state to PAUSED above — don't let the stillFailed check below
    // overwrite that with a different pause reason.
    if (_manualPauseTriggered) return;

    // After all persistent retry rounds, check if any shots are still failing
    const stillFailed = await db.query(
      `SELECT scene_number, shot_index FROM shots WHERE episode_id = ? AND status = 'failed'
       ORDER BY scene_number, shot_index`,
      [draftEpisodeId]
    );
    if (stillFailed.length > 0) {
      const reason = `${stillFailed.length} shot(s) still failing after ${MAX_PERSISTENT_ROUNDS} persistent retry rounds. ` +
        `Check API keys and click Resume.`;
      console.error(`[Pipeline] ${reason}`);
      await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
      state.setStatus(state.STATES.PAUSED, `⏸ Paused — ${reason}`);
      await telegram.sendTelegram(
        `⏸ <b>Episode paused — ${stillFailed.length} shot(s) still failing</b>\n` +
        `Tried ${MAX_PERSISTENT_ROUNDS} persistent retry rounds.\n` +
        `✅ ${shotSuccesses}/${allShots.length} shots saved.\n` +
        `Check API keys and click <b>Resume</b> to continue.`
      );
      return;
    }
  }

  if (retryLog.length > 0) {
    await telegram.sendTelegram(
      `📊 Shot summary for ep ${globalEpisodeNumber}:\n✅ ${shotSuccesses} succeeded\n❌ ${shotFailures} failed\n\n${retryLog.slice(0, 5).join('\n')}`
    );
  }

  // ── 7. Shot orchestrator: rebuild clip order from DB before compilation ──────
  //
  // Why this matters:
  //   During shot generation, clips are pushed to shotClipsByScene in completion
  //   order — not script order. If shot_01 fails its first pass and is retried
  //   after shot_02 and shot_03 succeed, the in-memory array ends up as
  //   [shot_02, shot_03, shot_01]. The FFmpeg service's filename-sort is a
  //   partial safety net (it extracts the trailing number from each Cloudinary
  //   URL), but that only works if the URL suffix is the only trailing number —
  //   on resume, different URL shapes or version numbers can defeat it.
  //
  // The authoritative source of ordering is ALWAYS the shots table (shot_index
  // column matches the script's scene[].shots[] array position). We unconditionally
  // rebuild shotClipsByScene from DB here so every compilation — first run,
  //   retry, or resume — uses the correct script-defined order.
  //
  // This also handles the resume edge-case where allShots was empty (stored
  // script had malformed scenes) — the DB always has the ground truth.
  if (draftEpisodeId) {
    const doneRows = await db.query(
      `SELECT scene_number, shot_index, clip_url, clip_duration
       FROM shots
       WHERE episode_id = ? AND status = 'done'
       ORDER BY scene_number ASC, shot_index ASC`,
      [draftEpisodeId]
    );

    if (doneRows.length > 0) {
      // Detect ordering drift: compare current in-memory order with DB order
      let orderingDrifted = false;
      const rebuilt = new Map();

      for (const row of doneRows) {
        if (!rebuilt.has(row.scene_number)) rebuilt.set(row.scene_number, []);
        rebuilt.get(row.scene_number).push({
          url:          row.clip_url,
          clipDuration: parseFloat(row.clip_duration) || 4,
          shotIndex:    row.shot_index,
        });
      }

      // Check whether any scene's in-memory URL list differs from DB order
      for (const [sceneNum, dbClips] of rebuilt) {
        const memClips = shotClipsByScene.get(sceneNum) || [];
        if (memClips.length !== dbClips.length) { orderingDrifted = true; break; }
        for (let i = 0; i < dbClips.length; i++) {
          if ((memClips[i]?.url || memClips[i]) !== dbClips[i].url) {
            orderingDrifted = true;
            break;
          }
        }
        if (orderingDrifted) break;
      }

      // Always apply the DB-ordered rebuild regardless — in-memory order is not trusted
      shotClipsByScene.clear();
      for (const [sceneNum, dbClips] of rebuilt) {
        shotClipsByScene.set(sceneNum, dbClips);
      }

      if (orderingDrifted) {
        const msg =
          `🎬 Shot orchestrator corrected clip order for ep ${globalEpisodeNumber} ` +
          `(${doneRows.length} shots across ${rebuilt.size} scenes reordered from DB)`;
        console.log(`[Pipeline] ${msg}`);
        await telegram.sendTelegram(msg).catch(() => {});
      } else {
        console.log(
          `[Pipeline] Shot orchestrator: ${doneRows.length} shots across ` +
          `${rebuilt.size} scenes — order confirmed correct`
        );
      }
    }
  }

  // ── Await any remaining early scene compiles before the final pass ────────
  // Most scenes should already be compiled by now (early compile ran while
  // later shots were generating). Any scenes not yet in savedSceneState will
  // be compiled in the sequential loop below.
  if (pendingSceneCompiles.size > 0) {
    console.log(`[Pipeline] Awaiting ${pendingSceneCompiles.size} remaining early scene compile(s)...`);
    await Promise.allSettled([...pendingSceneCompiles.values()]);
    pendingSceneCompiles.clear();
  }

  // ── 8. Compose scenes (skip already compiled; persist each result) ─────────
  state.setStatus(state.STATES.COMPILING, 'Composing remaining scenes...');
  // Union of scenes that need compilation (in shotClipsByScene) and scenes that
  // were already compiled in a prior run (in savedSceneState). This ensures that
  // scenes compiled before a crash are still included in the final merge even if
  // some scenes have no new clips (all already compiled on a previous run).
  const allSceneNums = new Set([
    ...shotClipsByScene.keys(),
    ...Object.keys(savedSceneState).map(Number),
  ]);
  const sceneNums = [...allSceneNums].sort((a, b) => a - b);
  // ── Narrative context history ─────────────────────────────────────────────
  // After each scene completes, append its configuration to the history array.
  // This is what the scriptWriter reads to maintain contextual progression
  // across consecutive scenes — no overlapping visual concepts, no teleporting
  // characters, no mixed environmental concepts.
  const narrativeContextHistory = [];
  for (const scene of scenes) {
    narrativeContextHistory.push({
      scene_number:       scene.scene_number,
      location:           scene.location || '',
      characters_present: scene.characters_present || [],
      emotional_beat:     scene.emotional_beat || '',
      visual_summary:     (scene.shots || []).map(s => s.image_prompt?.slice(0, 80)).join(' | '),
      shot_count:         (scene.shots || []).length,
      composition:        scene.composition || 'cut',
    });
  }
  console.log(`[Pipeline] Narrative context history: ${narrativeContextHistory.length} scenes tracked for continuity`);

  // sceneMeta and sceneEffectsMap are defined before the shot loop (for early compilation).
  const sceneUrls = [];
  const failedScenes = [];

  for (let si = 0; si < sceneNums.length; si++) {
    const sceneNum = sceneNums[si];
    const clips    = shotClipsByScene.get(sceneNum) || [];
    state.setProgress(si + 1, sceneNums.length, `Composing scene ${si + 1}/${sceneNums.length}`);

    if (!clips.length) { console.warn(`[Pipeline] Scene ${sceneNum} has no clips, skipping`); continue; }

    // Reuse previously compiled URL on resume
    if (savedSceneState[sceneNum]) {
      console.log(`[Pipeline] Scene ${sceneNum} already compiled — reusing`);
      sceneUrls.push(savedSceneState[sceneNum]);
      continue;
    }

    // ── Build per-clip effects payload from shot-level fields ──────────────
    // Plain URL strings only — all visual effects come from Magic Hour's video generation.
    const plainClips = clips.map(clip => typeof clip === 'string' ? clip : clip.url).filter(Boolean);
    const sceneEffects = sceneEffectsMap[sceneNum] || {};
    const layout = 'cut';

    try {
      const rawUrl    = await compiler.composeSceneSmartAndWait(plainClips, layout, sceneEffects);
      const sceneUrl  = await _persistSceneUrl(rawUrl, sceneNum);
      sceneUrls.push(sceneUrl);
      savedSceneState[sceneNum] = sceneUrl;
      await saveDraftProgress(draftEpisodeId, savedSceneState, null);
    } catch (err) {
      console.error(`[Pipeline] Scene ${sceneNum} compose failed:`, err.message);

      // Scene genuinely failed — record it and pause instead of silently dropping
      failedScenes.push(sceneNum);
      await telegram.sendTelegram(`⚠️ Scene ${sceneNum} compose failed: ${err.message}`);
    }
  }

  // ── If any scenes failed, pause the pipeline instead of silently dropping them ──
  // The old code did `continue` on failure, which dropped the scene from sceneUrls
  // without stopping — resulting in episodes with only 3 scenes instead of 6+.
  if (failedScenes.length > 0) {
    const reason = `Scenes ${failedScenes.join(', ')} failed composition. Fix the FFmpeg service and click Resume.`;
    console.error(`[Pipeline] ${reason}`);
    await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
    state.setStatus(state.STATES.PAUSED, `⏸ ${failedScenes.length} scene(s) failed — FFmpeg compose`);
    await telegram.sendTelegram(
      `⏸ <b>Episode paused — ${failedScenes.length} scene(s) failed composition</b>\n\n` +
      `Failed scenes: ${failedScenes.join(', ')}\n` +
      `Successfully compiled: ${sceneUrls.length} scene(s)\n\n` +
      `Check FFmpeg service logs, then click <b>Resume</b> on the dashboard to retry.`
    );
    return;
  }

  if (!sceneUrls.length) {
    // Gracefully pause instead of crashing — preserves all shots so Resume can retry compilation.
    const reason = 'No scenes compiled — all scene composition jobs failed. Fix the FFmpeg service and click Resume.';
    console.error(`[Pipeline] ${reason}`);
    await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
    state.setStatus(state.STATES.PAUSED, `⏸ No scenes compiled — FFmpeg compose failed`);
    await telegram.sendTelegram(
      `⏸ <b>Episode paused — no scenes compiled</b>\n\n` +
      `All scene composition jobs failed.\n` +
      `Check FFmpeg service logs, then click <b>Resume</b> on the dashboard to retry.`
    );
    return;
  }

  // ── 8. Merge the original shot assets → final master ──────────────────────
  state.setStatus(state.STATES.COMPILING, 'Merging final episode...');
  // IMPORTANT: Do NOT feed already-encoded scene files into the master merge.
  // That creates a quality-degrading encode chain:
  //
  //   LTX shot → scene encode → Cloudinary scene asset → episode encode
  //
  // Instead, the episode master is assembled directly from the original
  // Cloudinary shot assets. This keeps the final movie to one master encode:
  //
  //   LTX shot → episode encode
  //
  // Scene files are still compiled and persisted above for fast dashboard
  // previews/review, but they are intentionally NOT used as the source for the
  // final episode master.
  //
  // Rebuild from the authoritative DB order so resume/retry runs cannot
  // accidentally omit or reorder a shot.
  const masterShotRows = await db.query(
    `SELECT scene_number, shot_index, clip_url
       FROM shots
      WHERE episode_id = ?
        AND status = 'done'
        AND clip_url IS NOT NULL
      ORDER BY scene_number ASC, shot_index ASC`,
    [draftEpisodeId]
  );

  const masterShotClips = masterShotRows
    .map(row => row.clip_url)
    .filter(Boolean);

  if (masterShotClips.length === 0) {
    const reason = 'No original shot clips are available for the final master merge.';
    console.error(`[Pipeline] ${reason}`);
    await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
    state.setStatus(state.STATES.PAUSED, `⏸ ${reason}`);
    await telegram.sendTelegram(`⏸ <b>Episode paused — no source shot clips for master merge</b>`).catch(() => {});
    return;
  }

  if (masterShotClips.length !== allShots.length) {
    const reason =
      `Master merge source mismatch: found ${masterShotClips.length}/${allShots.length} original shot clips. ` +
      `Refusing to build a potentially incomplete final episode.`;
    console.error(`[Pipeline] ${reason}`);
    await saveDraftProgress(draftEpisodeId, savedSceneState, reason);
    state.setStatus(state.STATES.PAUSED, `⏸ ${reason}`);
    await telegram.sendTelegram(`⏸ <b>Episode paused — master source mismatch</b>\n${reason}`).catch(() => {});
    return;
  }

  const episodeTransition = episodeScript?.episode_transition || null;

  const mergeJobId    = await compiler.mergeScenes(masterShotClips, {
    introBumperUrl: process.env.INTRO_BUMPER_URL || null,
    outroBumperUrl: process.env.OUTRO_BUMPER_URL || null,
    transition:      episodeTransition,
  });
  const finalVideoUrl = await compiler.pollFFmpegJob(mergeJobId);

  // ── 9. Upload final video to Cloudinary (permanent) ───────────────────────
  const epPubId            = cloudinary.episodePublicId(storyline.id, globalEpisodeNumber);
  const cloudinaryEpUrlRaw = await cloudinary.uploadVideoFromUrl(finalVideoUrl, epPubId);

  const cloudinaryEpUrl = cloudinaryEpUrlRaw;
  console.log(`[Pipeline] Final episode URL: ${cloudinaryEpUrl}`);

  // ── 10. Publishing intentionally removed from compilation ────────────────
  // The operator reviews the final compiled episode before any external post.

  // ── 11. Final compilation → READY FOR HUMAN REVIEW ───────────────────────
  // Publishing and storyline advancement are deliberately separated from
  // compilation. The operator reviews the complete episode in the dashboard
  // and explicitly clicks Publish Episode when satisfied.
  await markEpisodeReady(draftEpisodeId, { video_url: cloudinaryEpUrl });
  state.setStatus(state.STATES.IDLE, 'Episode compiled and READY for manual review');
  await telegram.sendTelegram(
    `🎬 <b>EPISODE READY FOR REVIEW</b>\n` +
    `${storyline.title} S${currentSeason}E${currentEpisode}\n` +
    `Final video compiled successfully. Review it in the dashboard, then click <b>Publish Episode</b>.`
  ).catch(() => {});
  state.setCurrentEpisode(null);
  state.updateDiskUsage(diskUsageMB());

  for (const pubId of tmpImagePublicIds) {
    try { await cloudinary.deleteResource(pubId, 'image'); } catch {}
  }

  console.log(`[Pipeline] Episode ${globalEpisodeNumber} complete.`);

  // ── 13. Series finale → announce + immediately chain next premiere ─────────
  if (isSeriesMovie) {
    console.log(`[Pipeline] "${storyline.title}" series complete after ${globalEpisodeNumber} episodes. Scheduling next premiere...`);

    try {
      const finalePost = await scriptWriter.writeFinaleAnnouncement({
        ...storyline,
        episode_count: globalEpisodeNumber,
      });
      await discord.postAnnouncement(finalePost);
    } catch (e) {
      console.warn('[Pipeline] Finale announcement failed:', e.message);
    }

    await telegram.sendTelegram(
      `🏁 "<b>${storyline.title}</b>" series complete!\n${globalEpisodeNumber} total episodes across 4 seasons.\n\nA new series premiere is starting now...`
    );

    const PREMIERE_DELAY_MS = parseInt(process.env.PREMIERE_DELAY_MS || '300000', 10);
    console.log(`[Pipeline] Next premiere fires in ${PREMIERE_DELAY_MS / 1000}s...`);
    setTimeout(() => {
      runStreamVersePipeline().catch(err =>
        console.error('[Pipeline] Auto-premiere failed:', err.message)
      );
    }, PREMIERE_DELAY_MS);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Reels pipeline — retained as a no-op; Facebook posting has been removed.
// ──────────────────────────────────────────────────────────────────────────────

async function runReelsPipeline() {
  console.log('[Reels] Reels pipeline is disabled — episodes now post to Discord automatically.');
}

// ──────────────────────────────────────────────────────────────────────────────
// Comment reminder
// ──────────────────────────────────────────────────────────────────────────────

async function runCommentReminder() {
  try {
    const eps = await db.query(
      `SELECT episode_number, script, facebook_video_link, posted_at
       FROM episodes WHERE status = 'posted' AND posted_at > DATE_SUB(NOW(), INTERVAL 3 DAY)
       ORDER BY posted_at DESC`
    );
    if (!eps.length) return;
    const lines = eps.map(e => {
      const sc = safeJsonParse(e.script, {});
      return `• Ep ${e.episode_number} "${sc.episode_title || ''}" → ${e.facebook_video_link || 'N/A'}`;
    });
    await telegram.sendTelegram(`💬 Engagement reminder:\n${lines.join('\n')}`);
  } catch (err) { console.error('[CommentReminder] Error:', err.message); }
}

// ──────────────────────────────────────────────────────────────────────────────
// Auto comment reply pipeline — disabled (was Facebook-only).
// ──────────────────────────────────────────────────────────────────────────────

async function runAutoCommentReplies() {
  console.log('[Comments] Auto-reply pipeline is disabled — Facebook has been removed.');
}

// ──────────────────────────────────────────────────────────────────────────────
// Engagement post pipeline
// Posts a standalone conversation-starter between episode drops
// ──────────────────────────────────────────────────────────────────────────────

async function runEngagementPost() {
  if (_pipelineRunning) { console.log('[Engagement] Main pipeline running, skipping.'); return; }
  console.log('[Engagement] Running engagement post pipeline...');

  try {
    const storyline = await getActiveStoryline();
    if (!storyline) { console.log('[Engagement] No active show.'); return; }

    const postText = await scriptWriter.writeEngagementPost({
      storylineTitle: storyline.title,
      genre:          storyline.genre,
      centralTheme:   storyline.central_theme  || storyline.plot_summary || '',
      engagementHook: storyline.engagement_hook || '',
      episodeCount:   storyline.episode_count   || 0,
    });

    if (!postText) { console.log('[Engagement] No post generated.'); return; }

    await discord.postAnnouncement(postText);
    console.log('[Engagement] Engagement post published to Discord');
    await telegram.sendTelegram(`🗣️ Engagement post published to Discord for "<b>${storyline.title}</b>"`);
  } catch (err) {
    console.error('[Engagement] Post error:', err.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt builders
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a portrait prompt for a specific angle.
 * Uses tag-list format to maximise per-trait token weight in diffusion models.
 * Explicit resolution (1080×1920, 9:16) prevents the model from generating horizontal output.
 * @param {object} char
 * @param {string} visualAnchor - comma-separated tag-lock from generateCharacterVisualAnchor
 * @param {'front'|'three_quarter'|'profile'|'full_body'} angle
 */
function _buildCharacterPortraitPrompt(char, visualAnchor, angle = 'front') {
  const angleTag = {
    front:         'front-facing portrait, ONE person centered in frame, looking directly into camera, neutral expression',
    three_quarter: 'three-quarter angle from left, ONE person, 45-degree turn, looking slightly off-camera',
    profile:       'strict side profile from left, ONE person, head and shoulders',
    full_body:     'full body standing shot, ONE person, centered in frame, neutral pose, both hands visible',
  }[angle] || 'front-facing portrait, ONE person centered in frame';

  // Identity tags FIRST — highest token priority in diffusion models
  const anchor = visualAnchor || char.description || char.name;

  return [
    `OUTPUT FORMAT: Single photorealistic image, 768x1365 pixels, 9:16 vertical portrait orientation, no horizontal layout, no landscape, no film strips, no multiple panels`,
    `SUBJECT: ONE PERSON ONLY — ${char.name}. Do NOT add any other person, face, or figure. This is a CHARACTER IDENTITY REFERENCE portrait.`,
    anchor,
    angleTag,
    'plain dark neutral background',
    'mouth closed, natural resting expression',
    'eyes open and clearly visible',
    'hair styled exactly as described in anchor',
    'soft cinematic key light from upper-left, subtle fill from right',
    'sharp focus on eyes and face, crisp detail on hair and skin texture',
    '4K photorealistic, hyper-detailed skin, no filters',
    'no motion blur, no text, no watermarks, no background elements',
    'character identity reference sheet, casting portrait',
  ].join(', ');
}

/**
 * Normalise a character name for fuzzy matching:
 *   "Elena Vasquez"  →  "elena vasquez"
 *   "Dr. Marcus Cole" →  "marcus cole"  (strip honorifics)
 * Also returns the first-name-only variant so "Elena" matches "Elena Vasquez".
 */
function _nameTokens(raw) {
  const cleaned = (raw || '')
    .toLowerCase()
    .replace(/\b(dr|mr|mrs|ms|prof|sir|lady)\b\.?\s*/gi, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  // tokens: full name + each individual word so partial name matches work
  return new Set([cleaned, ...parts]);
}

/**
 * Find character DB rows whose names appear in shot.characters_in_shot.
 *
 * Rules:
 *  - If characters_in_shot is empty/absent → return all characters (shot has no restriction).
 *  - If characters_in_shot is explicitly set but nothing matches → return [] and log a warning.
 *    Never silently apply every character's identity anchor to a shot that named specific people.
 */
function _getCharsInShot(shot, characterList) {
  const scriptNames = (shot.characters_in_shot || []);
  if (!scriptNames.length) return characterList; // unspecified → include all

  const matched = [];
  const unmatched = [];

  for (const scriptName of scriptNames) {
    const scriptTokens = _nameTokens(scriptName);
    const found = characterList.find(c => {
      const dbTokens = _nameTokens(c.name);
      // Match if any token from script appears in db tokens OR vice-versa
      for (const t of scriptTokens) if (dbTokens.has(t)) return true;
      for (const t of dbTokens)    if (scriptTokens.has(t)) return true;
      return false;
    });
    if (found) {
      if (!matched.includes(found)) matched.push(found);
    } else {
      unmatched.push(scriptName);
    }
  }

  if (unmatched.length) {
    const known = characterList.map(c => c.name).join(', ');
    console.warn(
      `[CharMatch] ⚠ Shot "${shot.description?.slice(0, 60) || '?'}" lists characters not found in DB: ` +
      `[${unmatched.join(', ')}]. Known cast: [${known}]. ` +
      `Shot will use only matched characters; check LLM character name spelling.`
    );
  }

  return matched; // may be empty — caller handles gracefully via _buildShotImagePrompt
}

/**
 * Assign explicit spatial positions to characters in a shot.
 * This is CRITICAL for preventing the model from merging two characters into one hybrid person.
 * The position label is embedded directly in the anchor block so the model gets spatial separation.
 */
function _assignCharacterPositions(chars) {
  const count = Array.isArray(chars) ? chars.length : 0;
  const labels = shotStaging.defaultScreenPositions(count);
  return labels.map(label => {
    const pretty = String(label)
      .replace(/-/g, ' ')
      .replace(/\bfar left\b/i, 'on the FAR LEFT of frame')
      .replace(/\bleft of center\b/i, 'LEFT OF CENTER in frame')
      .replace(/\bscreen left\b/i, 'on the LEFT side of frame')
      .replace(/\bcenter\b/i, 'in the CENTER of frame')
      .replace(/\bright of center\b/i, 'RIGHT OF CENTER in frame')
      .replace(/\bscreen right\b/i, 'on the RIGHT side of frame')
      .replace(/\bfar right\b/i, 'on the FAR RIGHT of frame');
    return pretty;
  });
}

/**
 * Strip any embedded identity-lock blocks the LLM may have written into image_prompt.
 * The LLM sometimes embeds "[NAME IDENTITY LOCK: ...]" or similar despite instructions.
 * We inject anchors ourselves — duplicates cause conflicting signals and token dilution.
 */
function _stripEmbeddedAnchors(imagePrompt) {
  if (!imagePrompt) return '';
  return imagePrompt
    // "[Name IDENTITY LOCK: ...]" style blocks
    .replace(/\[[^\]]{0,60}IDENTITY LOCK[^\]]*\]/gi, '')
    // "Character: <long physical description>," patterns
    .replace(/character\s*:\s*[^,\n]{20,}/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Build the full image prompt for a shot.
 *
 * Resolution + orientation directives come first so they receive maximum token weight.
 * Character visual anchors are next, each tagged with an explicit spatial position
 * (left / right / center) to prevent the model from merging two characters into one.
 * Scene-level context (location, lighting, emotional beat) and the previous shot's
 * description are injected so consecutive shots read as part of the same story and
 * environment instead of disconnected abstract images.
 * The LLM-generated image_prompt covers only cinematographic elements.
 *
 * @param {object}      shot            Current shot from the script
 * @param {object}      storyline       Active storyline (genre, visual language, etc.)
 * @param {object[]}    charsInShot     Matched character DB rows
 * @param {object|null} prevShot        Previous shot in allShots (null for first shot)
 * @param {string|null} sceneBgImageUrl Cloudinary URL of the first shot in this scene,
 *                                      used as a visual background reference (non-null for
 *                                      shots 2+ in a scene)
 */

/**
 * Keep legacy/manual image prompts compatible with the STILL-FRAME contract.
 * This is intentionally conservative: remove sentences that address a model,
 * describe speech/audio, or describe motion over time. Static visual sentences
 * (location, lighting, wardrobe, pose, expression, composition) are preserved.
 */
function _sanitizeStillImagePrompt(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return '';

  const blocked = /\b(use this image|animate|animation|video|voiceover|voice-over|narration|audio|dialogue|speaks?|speaking|talking|talks|lips?\s+moving|mouth\s+moving|camera\s+(moves?|push(?:es|ing)?|pull(?:s|ing)?|pans?|tilts?|cranes?|zooms?|tracks?)|push(?:es|ing)?\s+(?:closer|in|forward)|pull(?:s|ing)?\s+(?:back|away)|dolly|tracking shot|pan left|pan right|tilt up|tilt down|walks?|runs?|turns?|reaches?|approaches?|backs?|steps?|gestures?|nods?|shakes?|blinks?)\b/i;

  // Remove labeled control blocks that were previously injected into image_prompt.
  let cleaned = text
    .replace(/(?:^|\n)\s*(?:SPEAKER STATUS|STRICT SPEECH CONTROL|CAMERA SETUP|DIRECTOR'S CAST IDENTIFICATION|REFERENCE IMAGE MAP|NATURALISM|SCENE ACTION|CAMERA LANGUAGE)\s*:[\s\S]*?(?=\n\s*[A-Z][A-Z _'-]+\s*:|\n\n|$)/gi, ' ')
    .replace(/\b(?:SPEAKER STATUS|STRICT SPEECH CONTROL|REFERENCE IMAGE MAP|DIRECTOR'S CAST IDENTIFICATION)\b[^.]*\.?/gi, ' ');

  const sentences = cleaned
    .split(/(?<=[.!?])\s+|\n+/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => !blocked.test(x));

  return sentences.join(' ').replace(/\s{2,}/g, ' ').trim();
}

function _buildShotImagePrompt(shot, storyline, charsInShot, prevShot = null, sceneBgImageUrl = null, focusChar = null, charRefSlots = [], speakerOnlyMode = false) {
  const staging = shotStaging.getShotCharacterStaging(shot, charsInShot);
  const refs = charRefSlots.map(x => `input_image_${x.slotIndex} = ${x.char.name} character reference`).join('; ');
  const bg = sceneBgImageUrl
    ? `input_image_0 is the character-free master background for this scene. Preserve its architecture, spatial geometry, props, lighting and camera geography exactly.`
    : 'No scene background reference was available; preserve the written scene geography exactly.';

  const previousEnd = prevShot
    ? String(prevShot.end_frame_state || prevShot.end_frame_transition || prevShot.next_shot_continuity || '').trim()
    : '';
  const sameScene = !!prevShot && prevShot.scene_number === shot.scene_number;
  const startState = String(shot.start_frame_state || shot._start_frame_handoff || previousEnd || '').trim();

  const speakerName = ttsGen.extractSpeakerName(shot.dialogue_or_action || '') || focusChar?.name || '';
  const visibleDialogue = speakerOnlyMode ? speakerName : '';
  const stagingLines = staging.map(row => {
    const identity = row.visual_identity ? ` Identity cue: ${row.visual_identity}.` : '';
    const speak = _namesMatch(row.name, speakerName) ? ' This character is the visible speaker.' : '';
    return `CHARACTER ${row.name}: ${row.screen_position}, ${row.depth}; facing ${row.facing || 'the stated story focus'}; pose ${row.pose || shot.pose_state || 'natural, readable pose'}; visible action ${row.action || 'holds the established position'}; eyeline ${row.eyeline || row.facing || 'toward the immediate story focus'}; interaction ${row.interaction || 'none beyond the established scene relationship'}.${identity}${speak}`;
  }).join('\n');

  const transition = shot._continuity_transition === 'context_change'
    ? 'This is a deliberate context change. Establish the new geography causally; do not teleport characters.'
    : sameScene && startState
      ? `Open on the exact state inherited from the previous shot: ${startState}. Preserve every character body position, hand or prop contact, gaze, expression, screen position, depth and environment before any new movement.`
      : 'Establish the declared opening visual state with stable screen geography.';

  const focus = shot._multi_speaker
    ? 'Use one shared composition containing every visible speaker and listener. Keep every body and face separately readable; never merge people.'
    : visibleDialogue
      ? `The visual focus is ${visibleDialogue}, while all other visible characters remain silent listeners with natural micro-reactions.`
      : '';

  return [
    'STILL IMAGE — one frozen cinematic opening frame only.',
    `Genre/aesthetic: ${storyline.genre || 'cinematic'}; photorealistic 4K film frame; 9:16 vertical portrait composition.`,
    `Shot framing: ${shot.shot_type || ''}; ${shot.framing || ''}; viewpoint only, no camera movement.`,
    `Scene location: ${shot._scene_location || 'established scene location'}. Scene description: ${_sanitizeStillImagePrompt(shot._scene_description || shot.shot_description || '')}.`,
    `Lighting: ${shot._lighting_design || 'consistent with the established scene lighting'}.`,
    `LOCKED CHARACTER STAGING — this map is authoritative and must be visible exactly as described:\n${stagingLines}`,
    bg,
    refs ? `REFERENCE MAP: ${refs}. Preserve each reference identity in the character staging row with the same screen position.` : '',
    `COMPOSITION SUMMARY: ${shot.character_positions || staging.map(row => `${row.name} at ${row.screen_position}, ${row.depth}`).join('; ')}.`,
    `VISIBLE OPENING STATE: ${shot.pose_state || ''}; expression shown through facial expression and posture; eyelines follow the locked staging map.`,
    transition,
    focus,
    'Do not invent a different room, set, weather, wardrobe, props, time of day, or extra people. No text, logos or watermarks.',
    'The image is silent and static: no dialogue, no speech, no lip-sync, no camera movement, no temporal language.',
  ].filter(Boolean).join('\n');
}
/**
 * Build the dynamic reference-index → character identity map sent to the
 * Cloudflare image Worker's `characters` field (see cfImageGen.js). Purely
 * derived from whichever characters are actually in this shot — no fixed
 * cast, no hardcoded names or count.
 */
/**
 * Build the dynamic reference→character identity map sent to the CF Worker's
 * `characters` field. Each entry gets an explicit position AND a short
 * age/build descriptor pulled from the character's visual anchor, so the
 * Worker's REFERENCE IMAGE N = <name> instructions can distinguish
 * characters even when the scene doesn't otherwise separate them (e.g. two
 * characters of the same gender) — mirrors the same disambiguation strategy
 * used in the LTX video prompt roster.
 */
function _buildCharacterReferenceMap(charRefSlots, positions, shot) {
  const staging = shotStaging.getShotCharacterStaging(shot, charRefSlots.map(x => x.char));
  return charRefSlots.map(({ char, slotIndex }) => {
    const row = shotStaging.findStagingRow(staging, char.name);
    const ageMatch = char.visual_anchor
      ? char.visual_anchor.match(/\b(child|teen(?:ager)?|young(?:er)? (?:adult|man|woman)|middle-aged|elderly|old(?:er)?|in (?:his|her|their) (?:20s|30s|40s|50s|60s|70s))\b/i)
      : null;

    const position = row?.screen_position || positions?.[charRefSlots.findIndex(x => x.char === char)] || undefined;
    const staticParts = [];
    if (position) staticParts.push(`positioned ${position}`);
    if (row?.depth) staticParts.push(row.depth);
    if (row?.pose) staticParts.push(`pose ${row.pose}`);
    if (row?.action) staticParts.push(`visible action ${row.action}`);
    if (row?.eyeline) staticParts.push(`eyeline ${row.eyeline}`);
    if (ageMatch) staticParts.push(ageMatch[0]);

    return {
      name: char.name,
      reference_index: slotIndex,
      position: position || undefined,
      action: staticParts.length ? staticParts.join(', ') : undefined,
    };
  });
}


/**
 * Turn a raw shot description (often written like a script's action line —
 * "Maya stands, arms crossed, staring at John") into an explicit director's
 * instruction ("Direct Maya to stand, arms crossed, staring at John") so it
 * reads unambiguously as staging direction for the performers rather than
 * a line of narration. LTX-2.3 generates its own audio track from whatever
 * text it is given; a bare declarative sentence sitting in the prompt with
 * no other signal has been observed getting voiced verbatim (e.g. a shot
 * with no scripted dialogue coming back with an audio track that literally
 * says "Maya stands..."). Rewriting every sentence as a command, plus the
 * explicit non-narration header this feeds into below, removes that
 * ambiguity instead of relying on the model to infer intent from tone.
 *
 * Sentence-level heuristic, not full NLP: when a sentence opens with a name
 * from this shot's roster followed by a verb, it's rewritten as
 * "Direct <Name> to <verb-base-form>...". Sentences that don't match that
 * shape (scene/setting description, camera-ish phrasing, etc.) are left as
 * physical/visual description but still fall under the same
 * do-not-narrate header, since they're describing the frame, not something
 * to be spoken.
 */
function _toDescriptiveShotDirection(rawText, orderedChars) {
  const text = (rawText || '').trim();
  if (!text) return '';

  const names = orderedChars.map(c => c.name).filter(Boolean);
  // Longest names first so "Maya Chen" matches before "Maya" would.
  const sortedNames = [...names].sort((a, b) => b.length - a.length);

  // Very small set of common 3rd-person-singular → base-form irregulars;
  // everything else is handled by stripping a trailing "s".
  const IRREGULAR = { stands: 'stand', sits: 'sit', turns: 'turn', looks: 'look',
    walks: 'walk', stares: 'stare', watches: 'watch', crosses: 'cross',
    steps: 'step', leans: 'lean', reaches: 'reach', glances: 'glance',
    smiles: 'smile', frowns: 'frown', nods: 'nod', shakes: 'shake',
    grips: 'grip', clenches: 'clench', pauses: 'pause', moves: 'move',
    approaches: 'approach', backs: 'back', pulls: 'pull', pushes: 'push' };

  function toBaseVerb(verb) {
    const lower = verb.toLowerCase();
    if (IRREGULAR[lower]) return IRREGULAR[lower];
    if (/[^aeiou]ies$/i.test(lower)) return lower.replace(/ies$/i, 'y');
    if (/(sh|ch|ss|x|z)es$/i.test(lower)) return lower.replace(/es$/i, '');
    if (/s$/i.test(lower) && !/ss$/i.test(lower)) return lower.replace(/s$/i, '');
    return lower;
  }

  // Split into sentences while keeping simple punctuation intact.
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);

  const rewritten = sentences.map(sentence => {
    const trimmed = sentence.trim();
    const nameMatch = sortedNames.find(name =>
      new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(trimmed)
    );
    if (!nameMatch) return trimmed;

    const rest = trimmed.slice(nameMatch.length).trim();
    const verbMatch = rest.match(/^([A-Za-z]+)(.*)$/s);
    if (!verbMatch) return trimmed;

    const [, verb, remainder] = verbMatch;
    const baseVerb = toBaseVerb(verb);
    return `Direct ${nameMatch} to ${baseVerb}${remainder}`.trim();
  });

  return rewritten.join(' ');
}

/**
 * Build the full LTX-2.3 video-generation prompt for a shot: the composed
 * scene image is the exact starting frame, and this prompt tells LTX how to
 * animate it — preserving every character's identity independently, with
 * explicit per-character action + per-character dialogue instructions so
 * multiple characters can speak/act independently in the same shot instead
 * of collapsing into a generic "people talking" description.
 *
 * Everything here is derived from the actual scene/script data passed in —
 * no hardcoded names, no hardcoded dialogue.
 */
function _buildLtxVideoPrompt(shot, storyline, orderedChars, positions, motionParams) {
  // LTX-2 image-to-video works best with one concise, chronological description
  // of visible/heard change. The source image is already the first frame, so this
  // builder deliberately avoids production-control language, labels, maps and
  // prompt-boundary instructions. See LTX-2's published prompting guidance.
  const clean = value => String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const cleanForLtx = value => clean(value)
    .replace(/\bLTX\s+SHOT\s+CONTRACT\b\s*:?/gi, '')
    .replace(/\bLOCKED\s+SPATIAL\s+MAP\b[^.]*\.?/gi, '')
    .replace(/\bAudio\/text\s+boundary\b[^.]*\.?/gi, '')
    .replace(/\ball character names, staging descriptions, camera directions, scene descriptions and control language are non-audible\.?/gi, '')
    .replace(/\bdo not narrate or speak the prompt\.?/gi, '')
    .replace(/\bpreserve the established set, wardrobe, character identity, screen geography and spatial relationships\.?/gi, '')
    .replace(/\buse this exact map throughout the entire clip[^.]*\.?/gi, '')
    .replace(/\bno random new characters, props, locations, identity swaps, spatial swaps, mirrored placement, or merged faces\.?/gi, '')
    .replace(/\bdo not swap, merge, mirror, or reposition characters\.?/gi, '')
    .replace(/\bdo not (?:write|describe|mention) the prompt itself\.?/gi, '')
    .replace(/\bprompt (?:text|instructions|language)\b[^.]*\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const staging = shotStaging.getShotCharacterStaging(shot, orderedChars);
  const stagingSentence = staging.length
    ? staging.map(row => {
        const subject = row.name || 'The subject';
        const place = [row.screen_position, row.depth].filter(Boolean).join(' ');
        const focus = row.eyeline || row.facing || 'the immediate story focus';
        const action = row.action || 'remains in the established position';
        return `${subject} remains ${place || 'in position'}, facing ${focus}, and ${action}`;
      }).join(' ')
    : '';

  const authored = cleanForLtx(shot.ltx_shot_description);
  const progression = cleanForLtx(shot.temporal_arc);
  const action = cleanForLtx(shot.subject_motion);
  const environment = cleanForLtx(shot.environmental_story_beat || shot.scene_environment);
  const emotion = cleanForLtx(shot.emotional_subtext);
  const camera = cleanForLtx(shot.camera_movement || motionParams?.motionDirection);
  const endState = cleanForLtx(shot.end_frame_state || shot.end_frame_transition || shot.next_shot_continuity);

  const parts = [];
  if (authored) {
    parts.push(authored);
  } else {
    // Backwards-compatible fallback for older checkpoints that predate the
    // dedicated LTX shot description field.
    if (stagingSentence) parts.push(stagingSentence + '.');
    if (progression) parts.push(progression + '.');
    if (action && !/^still$/i.test(action)) parts.push(`The movement remains ${action}.`);
    if (emotion) parts.push(`The emotion is visible through ${emotion}.`);
    if (environment) parts.push(`Around them, ${environment}.`);
    if (camera && !/^none|static$/i.test(camera)) parts.push(`The camera ${camera}.`);
    if (endState) parts.push(`The shot ends with ${endState}.`);
  }

  // Keep spatial continuity as ordinary visual prose when it is not already
  // covered by the authored LTX description.
  if (stagingSentence && (staging.length > 1 || !authored.toLowerCase().includes(String(staging[0]?.name || '').toLowerCase()))) {
    parts.unshift(stagingSentence + '.');
  }

  // Include requested speech naturally, with no speaker labels or meta-instructions.
  const dialogueEntries = typeof ttsGen.extractStrictSpokenDialogue === 'function'
    ? ttsGen.extractStrictSpokenDialogue(shot.dialogue_or_action, { allowUnquotedVO: true })
    : [];
  for (const { speaker, text, mode: entryMode } of dialogueEntries) {
    const spokenText = clean(text);
    if (!spokenText) continue;
    const row = staging.find(r => _namesMatch(r.name, speaker));
    const subject = row?.name || speaker || 'The character';
    if (entryMode === 'internal_monologue') {
      parts.push(`${subject}'s lips remain still as an internal voice is heard: "${spokenText}".`);
    } else if (entryMode === 'phone_vo') {
      parts.push(`A voice is heard through the phone: "${spokenText}".`);
    } else {
      parts.push(`${subject} speaks naturally: "${spokenText}".`);
    }
  }

  let finalPrompt = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!finalPrompt) {
    finalPrompt = 'The subjects make subtle natural movements and the scene remains physically continuous, ending in a steady readable pose.';
  }

  // LTX guidance recommends staying within 200 words; keep a little headroom
  // so the prompt remains information-dense rather than turning into a contract.
  const words = finalPrompt.split(/\s+/).filter(Boolean);
  if (words.length > 190) {
    finalPrompt = words.slice(0, 190).join(' ');
    finalPrompt = finalPrompt.replace(/[,;:]?\s*[^.!?]*$/, '').trim();
  }
  return finalPrompt;
}
// ──────────────────────────────────────────────────────────────────────────────
// Manual recompile / regenerate — called from dashboard API endpoints.
// These operate on the current draft episode and reuse existing shot clips
// (for recompile) or regenerate a single shot from scratch (for regenerate).
// ──────────────────────────────────────────────────────────────────────────────

let _recompileRunning = false;
let _hilRegenerationRunning = new Set();

async function _getDraftContext() {
  const draft = await db.queryOne(
    `SELECT e.*, s.title AS show_title, s.genre
     FROM episodes e JOIN storylines s ON e.storyline_id = s.id
     WHERE e.status IN ('draft','ready') ORDER BY e.created_at DESC LIMIT 1`
  );
  if (!draft) return null;
  const script = safeJsonParse(draft.script, {});
  const storyline = await db.queryOne(`SELECT * FROM storylines WHERE id = ?`, [draft.storyline_id]);
  const characters = await getCharacters(draft.storyline_id);
  return { draft, script, storyline, characters };
}

async function _getEpisodeContext(episodeId) {
  const draft = await db.queryOne(
    `SELECT e.*, s.title AS show_title, s.genre
     FROM episodes e JOIN storylines s ON e.storyline_id = s.id
     WHERE e.id = ?`,
    [episodeId]
  );
  if (!draft) return null;
  const script = safeJsonParse(draft.script, {});
  const storyline = await db.queryOne(`SELECT * FROM storylines WHERE id = ?`, [draft.storyline_id]);
  const characters = await getCharacters(draft.storyline_id);
  return { draft, script, storyline, characters };
}


function _effectiveEditorialClip(row) {
  if (!row) return null;
  if (Number(row.enabled) === 0) return null;
  return row.editorial_url || row.clip_url || null;
}

async function editShotTimeline(sceneNumber, shotIndex, opts = {}) {
  const ctx = opts.episodeId ? await _getEpisodeContext(opts.episodeId) : await _getDraftContext();
  if (!ctx) return { ok: false, error: opts.episodeId ? 'Episode not found' : 'No draft episode found' };

  const row = await db.queryOne(
    `SELECT * FROM shots WHERE episode_id = ? AND scene_number = ? AND shot_index = ?`,
    [ctx.draft.id, sceneNumber, shotIndex]
  );
  if (!row) return { ok: false, error: `Shot ${sceneNumber}/${shotIndex} not found` };
  if (!row.clip_url && !row.editorial_url) return { ok: false, error: 'Shot has no rendered video to edit yet' };

  const currentSource = row.clip_url || row.editorial_url;
  let trimStart = opts.trimStart == null || opts.trimStart === '' ? null : Number(opts.trimStart);
  let trimEnd = opts.trimEnd == null || opts.trimEnd === '' ? null : Number(opts.trimEnd);

  if (trimStart != null && (!Number.isFinite(trimStart) || trimStart < 0)) {
    return { ok: false, error: 'Invalid trim start' };
  }
  if (trimEnd != null && (!Number.isFinite(trimEnd) || trimEnd <= 0)) {
    return { ok: false, error: 'Invalid trim end' };
  }
  const sourceDuration = Number(row.clip_duration || 0);
  if (trimEnd != null && sourceDuration > 0 && trimEnd > sourceDuration + 0.05) {
    trimEnd = sourceDuration;
  }
  if (trimStart != null && trimEnd != null && trimEnd <= trimStart) {
    return { ok: false, error: 'Trim end must be greater than trim start' };
  }
  if (trimStart != null && sourceDuration > 0 && trimStart >= sourceDuration) {
    return { ok: false, error: 'Trim start must be before the end of the shot' };
  }

  const enabled = opts.removed ? 0 : 1;
  let editorialUrl = currentSource;
  if (enabled && (trimStart != null || trimEnd != null)) {
    editorialUrl = cloudinary.trimVideoUrl(currentSource, trimStart ?? 0, trimEnd);
  } else if (enabled) {
    editorialUrl = currentSource;
  }

  const editedDuration = enabled
    ? (trimEnd != null ? (trimEnd - (trimStart || 0)) : sourceDuration)
    : 0;

  await db.execute(
    `UPDATE shots
       SET enabled = ?, trim_start = ?, trim_end = ?, editorial_url = ?,
           clip_duration = ?, edit_revision = COALESCE(edit_revision, 0) + 1
     WHERE episode_id = ? AND scene_number = ? AND shot_index = ?`,
    [enabled, trimStart, trimEnd, editorialUrl, editedDuration || sourceDuration || null,
     ctx.draft.id, sceneNumber, shotIndex]
  );

  // Keep the episode's editorial state coherent immediately.
  const sceneUrl = await _compileOneScene(
    ctx.draft, ctx.script, sceneNumber, ctx.draft.episode_number, ctx.storyline.id
  );
  const sceneState = safeJsonParse(ctx.draft.scene_state, {});
  sceneState[sceneNumber] = sceneUrl;
  await saveDraftProgress(ctx.draft.id, sceneState, null);

  return {
    ok: true,
    sceneNumber, shotIndex,
    enabled: !!enabled,
    trimStart, trimEnd,
    editorialUrl,
    duration: editedDuration || sourceDuration || null,
    sceneUrl,
  };
}

async function _compileOneScene(draft, script, sceneNum, globalEpisodeNumber, storylineId) {
  const doneRows = await db.query(
    `SELECT shot_index, clip_url, clip_duration, enabled, trim_start, trim_end, editorial_url
     FROM shots
     WHERE episode_id = ? AND scene_number = ? AND status = 'done' AND COALESCE(enabled, 1) = 1
     ORDER BY shot_index ASC`,
    [draft.id, sceneNum]
  );
  if (!doneRows.length) throw new Error(`Scene ${sceneNum} has no active done shots to compile`);

  const plainClips = doneRows.map(_effectiveEditorialClip).filter(Boolean);
  if (!plainClips.length) throw new Error(`Scene ${sceneNum} has no active clip URLs to compile`);

  const pubId = cloudinary.scenePublicId(storylineId, globalEpisodeNumber, sceneNum);
  const rawUrl = await compiler.composeSceneSmartAndWait(plainClips, 'cut', {});
  return await cloudinary.uploadVideoFromUrl(rawUrl, pubId);
}

/** Recompile a specific episode after HIL editorial changes. */
async function recompileEpisode(episodeId) {
  if (_recompileRunning) return { ok: false, error: 'Recompile already running' };
  const s = state.getState();
  if (s.status !== state.STATES.IDLE && s.status !== state.STATES.ERROR && s.status !== state.STATES.PAUSED) {
    return { ok: false, error: 'Pipeline is currently running — wait for it to finish first' };
  }
  _recompileRunning = true;
  try {
    const ctx = await _getEpisodeContext(episodeId);
    if (!ctx) return { ok: false, error: 'Episode not found' };
    const { draft, script, storyline } = ctx;
    const sceneNums = (script.scenes || []).map(sc => sc.scene_number).sort((a,b) => a-b);
    if (!sceneNums.length) return { ok: false, error: 'Episode has no scenes' };
    const sceneState = {};
    const sceneUrls = [];
    state.setStatus(state.STATES.COMPILING, `Recompiling episode ${draft.episode_number} from HIL edits...`);
    for (let i = 0; i < sceneNums.length; i++) {
      const sceneNum = sceneNums[i];
      state.setProgress(i + 1, sceneNums.length, `Recompiling scene ${sceneNum} (${i + 1}/${sceneNums.length})`);
      try {
        const url = await _compileOneScene(draft, script, sceneNum, draft.episode_number, storyline.id);
        sceneState[sceneNum] = url;
        sceneUrls.push(url);
      } catch (err) {
        console.error(`[RecompileEpisode] Scene ${sceneNum} failed: ${err.message}`);
      }
    }
    if (!sceneUrls.length) return { ok: false, error: 'No scenes compiled successfully' };
    await saveDraftProgress(draft.id, sceneState, null);
    const mergeJobId = await compiler.mergeScenes(sceneUrls, {
      introBumperUrl: process.env.INTRO_BUMPER_URL || null,
      outroBumperUrl: process.env.OUTRO_BUMPER_URL || null,
      transition: script.episode_transition || null,
    });
    const finalVideoUrl = await compiler.pollFFmpegJob(mergeJobId);
    const epPubId = cloudinary.episodePublicId(storyline.id, draft.episode_number);
    const cloudinaryEpUrl = await cloudinary.uploadVideoFromUrl(finalVideoUrl, epPubId);
    await markEpisodeReady(draft.id, { video_url: cloudinaryEpUrl });
    state.setStatus(state.STATES.IDLE, 'Episode recompiled and READY for manual review');
    return { ok: true, episodeId, videoUrl: cloudinaryEpUrl, scenesCompiled: sceneUrls.length, status: 'ready' };
  } catch (err) {
    console.error('[RecompileEpisode] Error:', err.message);
    state.setStatus(state.STATES.ERROR, `Episode recompile failed — ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    _recompileRunning = false;
  }
}

/**
 * Purge all compiled scene URLs and recompile every scene from existing shots,
 * then merge into a final episode video. Does NOT touch shots.
 */
async function recompileAllScenes() {
  if (_recompileRunning) return { ok: false, error: 'Recompile already running' };
  const s = state.getState();
  if (s.status !== state.STATES.IDLE && s.status !== state.STATES.ERROR && s.status !== state.STATES.PAUSED) {
    return { ok: false, error: 'Pipeline is currently running — wait for it to finish first' };
  }

  _recompileRunning = true;
  try {
    const ctx = await _getDraftContext();
    if (!ctx) return { ok: false, error: 'No draft episode found' };
    const { draft, script, storyline } = ctx;
    const globalEpisodeNumber = draft.episode_number;

    state.setStatus(state.STATES.COMPILING, 'Purging compiled scenes & recompiling...');
    console.log(`[RecompileAll] Starting for episode ${globalEpisodeNumber}`);

    // Purge scene_state (compiled scene URLs only — shots stay untouched)
    const savedSceneState = {};
    await saveDraftProgress(draft.id, savedSceneState, null);

    const scenes = script.scenes || [];
    const sceneNums = scenes.map(s => s.scene_number).sort((a, b) => a - b);
    const sceneUrls = [];

    for (let i = 0; i < sceneNums.length; i++) {
      const sceneNum = sceneNums[i];
      state.setProgress(i + 1, sceneNums.length, `Recompiling scene ${sceneNum} (${i + 1}/${sceneNums.length})`);
      try {
        const sceneUrl = await _compileOneScene(draft, script, sceneNum, globalEpisodeNumber, storyline.id);
        savedSceneState[sceneNum] = sceneUrl;
        sceneUrls.push(sceneUrl);
        await saveDraftProgress(draft.id, savedSceneState, null);
        console.log(`[RecompileAll] Scene ${sceneNum} → ${sceneUrl}`);
      } catch (err) {
        console.error(`[RecompileAll] Scene ${sceneNum} failed: ${err.message}`);
        await telegram.sendTelegram(`⚠️ Recompile: Scene ${sceneNum} failed — ${err.message}`).catch(() => {});
      }
    }

    if (!sceneUrls.length) {
      state.setStatus(state.STATES.ERROR, 'Recompile failed — no scenes compiled');
      return { ok: false, error: 'No scenes compiled successfully' };
    }

    // Merge
    state.setStatus(state.STATES.COMPILING, 'Merging final episode...');
    const episodeTransition = script.episode_transition || null;
    const mergeJobId = await compiler.mergeScenes(sceneUrls, {
      introBumperUrl: process.env.INTRO_BUMPER_URL || null,
      outroBumperUrl: process.env.OUTRO_BUMPER_URL || null,
      transition:      episodeTransition,
    });
    const finalVideoUrl = await compiler.pollFFmpegJob(mergeJobId);
    const epPubId = cloudinary.episodePublicId(storyline.id, globalEpisodeNumber);
    const cloudinaryEpUrl = await cloudinary.uploadVideoFromUrl(finalVideoUrl, epPubId);

    await markEpisodeReady(draft.id, { video_url: cloudinaryEpUrl });
    console.log(`[RecompileAll] Final episode → ${cloudinaryEpUrl} (READY for review)`);
    state.setStatus(state.STATES.IDLE, 'Episode recompiled and READY for manual review');
    return { ok: true, videoUrl: cloudinaryEpUrl, scenesCompiled: sceneUrls.length, status: 'ready' };
  } catch (err) {
    console.error('[RecompileAll] Error:', err.message);
    state.setStatus(state.STATES.ERROR, `Recompile failed — ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    _recompileRunning = false;
  }
}

/**
 * Recompile a single scene from existing shots and update scene_state.
 * Does NOT merge — call recompileAllScenes for that, or the dashboard can
 * trigger a merge separately.
 */
async function recompileScene(sceneNumber) {
  if (_recompileRunning) return { ok: false, error: 'Recompile already running' };

  _recompileRunning = true;
  try {
    const ctx = await _getDraftContext();
    if (!ctx) return { ok: false, error: 'No draft episode found' };
    const { draft, script, storyline } = ctx;
    const globalEpisodeNumber = draft.episode_number;

    state.setStatus(state.STATES.COMPILING, `Recompiling scene ${sceneNumber}...`);
    const sceneUrl = await _compileOneScene(draft, script, sceneNumber, globalEpisodeNumber, storyline.id);

    // Update scene_state in DB
    const sceneState = safeJsonParse(draft.scene_state, {});
    sceneState[sceneNumber] = sceneUrl;
    await saveDraftProgress(draft.id, sceneState, null);

    state.setStatus(state.STATES.IDLE);
    console.log(`[RecompileScene] Scene ${sceneNumber} → ${sceneUrl}`);
    return { ok: true, sceneUrl, sceneNumber };
  } catch (err) {
    console.error('[RecompileScene] Error:', err.message);
    state.setStatus(state.STATES.ERROR, `Scene recompile failed — ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    _recompileRunning = false;
  }
}

/**
 * Regenerate a single shot from scratch (image + video), update the shots
 * table, and recompile the scene it belongs to so the dashboard shows the
 * new result immediately.
 *
 * Returns immediately with { ok: true, queued: true } once validation
 * passes — the actual generation runs in the background so the dashboard
 * (and any other API call) stays responsive instead of the HTTP request
 * hanging for however long generation takes. Progress/result is visible
 * via the shot's `status` row (pending → mh_submitted → done/failed),
 * which /api/drafts/shots already polls.
 *
 * opts.promptOverride, when provided, replaces the shot's image_prompt for
 * this one regeneration attempt — used by the dashboard's "edit & retry"
 * flow for shots that failed on a content-safety flag, so the operator can
 * fix the flagged wording themselves instead of only getting the automatic
 * filmmaker-rewrite retry.
 */
/**
 * HIL (Human-In-the-Loop) shot editor support — fetch everything the
 * dashboard's "edit shot" modal needs: the resolved input image URL, the
 * current image prompt, the current effective LTX video prompt (built the
 * same way generation would build it, so what the operator sees is exactly
 * what would be sent if they hit regenerate without editing anything), and
 * the current duration. Read-only — does not touch the DB.
 */
async function getShotDetail(sceneNumber, shotIndex, episodeId = null) {
  const ctx = episodeId ? await _getEpisodeContext(episodeId) : await _getDraftContext();
  if (!ctx) return { ok: false, error: episodeId ? 'Episode not found' : 'No draft episode found' };
  const { draft, script, storyline, characters } = ctx;
  const scenes = script.scenes || [];
  const sceneObj = scenes.find(s => s.scene_number === sceneNumber) || {};

  const rowMap = await getShotRowMap(draft.id);
  const row = rowMap.get(`${sceneNumber}_${shotIndex}`);
  const imageUrl = _storedShotImageUrl(row?.image_url) || null;
  const shot = (sceneObj.shots || []).find(s => s.shot_index === shotIndex);
  if (!shot) {
    if (row) {
      return {
        ok: true, sceneNumber, shotIndex, status: row.status || null,
        imageUrl, clipUrl: _effectiveEditorialClip(row), originalClipUrl: row.clip_url || null,
        enabled: Number(row.enabled ?? 1) === 1, trimStart: row.trim_start ?? null, trimEnd: row.trim_end ?? null,
        imagePrompt: row.image_prompt_override || '',
        videoPrompt: row.last_prompt || row.video_prompt_override || '',
        promptSource: row.last_prompt ? 'submitted_to_ltx' : (row.video_prompt_override ? 'manual_override' : 'unresolved'),
        duration: row.duration_override || row.clip_duration || config.ltxMinDuration || 4,
        videoProvider: config.videoProvider,
        lastError: row.last_error || null, failureReason: row.failure_reason || null,
      };
    }
    return { ok: false, error: `Shot ${sceneNumber}/${shotIndex} not found in script` };
  }

  let videoPrompt = '';
  try {
    const charsInShot = _getCharsInShot(shot, characters);
    const orderedChars = charsInShot; // best-effort preview — actual generation reorders speaker-first
    const positions = _assignCharacterPositions(orderedChars);
    videoPrompt = shot._ltxPromptOverride
      || _buildLtxVideoPrompt(shot, storyline, orderedChars, positions, shot._motion_params || null);
  } catch (err) {
    console.warn(`[ShotDetail] Could not build video prompt preview for S${sceneNumber}/idx${shotIndex}:`, err.message);
  }

  return {
    ok: true,
    sceneNumber,
    shotIndex,
    status: row?.status || null,
    imageUrl,
    clipUrl: _effectiveEditorialClip(row), originalClipUrl: row?.clip_url || null,
    enabled: Number(row?.enabled ?? 1) === 1, trimStart: row?.trim_start ?? null, trimEnd: row?.trim_end ?? null,
    imagePrompt: row?.image_prompt_override || shot.image_prompt || '',
    videoPrompt: row?.last_prompt || row?.video_prompt_override || shot._ltxPromptOverride || videoPrompt || '',
    promptSource: row?.last_prompt
      ? 'submitted_to_ltx'
      : (row?.video_prompt_override || shot._ltxPromptOverride
        ? 'manual_override'
        : (videoPrompt ? 'reconstructed_preview' : 'unresolved')),
    duration: row?.duration_override || shot.duration || row?.clip_duration || config.ltxMinDuration || 4,
    videoProvider: config.videoProvider,
    lastError: row?.last_error || null,
    failureReason: row?.failure_reason || null,
    lastPrompt: row?.last_prompt || null,
  };
}

async function regenerateShot(sceneNumber, shotIndex, opts = {}) {
  // HIL is intentionally independent from the global production-state mutex.
  // An operator must be able to regenerate any completed/failed shot while the
  // rest of the pipeline continues running. Only the same shot is serialized.
  const hilKey = `${opts.episodeId || 'draft'}:${sceneNumber}:${shotIndex}`;
  if (_hilRegenerationRunning.has(hilKey)) {
    return { ok: false, error: 'This shot is already being regenerated manually' };
  }

  const ctx = opts.episodeId ? await _getEpisodeContext(opts.episodeId) : await _getDraftContext();
  if (!ctx) return { ok: false, error: opts.episodeId ? 'Episode not found' : 'No draft episode found' };
  const { script } = ctx;
  const scenes = script.scenes || [];
  const sceneObj = scenes.find(s => s.scene_number === sceneNumber) || {};
  // Match on the shot's actual shot_index field, NOT its array position.
  // shot_index is re-numbered starting at 1 (and can be renumbered again)
  // whenever shots are split or inserted (see the "Re-index shots sequentially"
  // passes above), so sceneObj.shots[shotIndex] silently grabs a neighbouring
  // shot instead of the one the dashboard actually asked to regenerate.
  const shot = (sceneObj.shots || []).find(s => s.shot_index === shotIndex);
  if (!shot) return { ok: false, error: `Shot ${sceneNumber}/${shotIndex} not found in script` };

  const currentRow = await db.queryOne(
    `SELECT status, mh_job_id FROM shots WHERE episode_id = ? AND scene_number = ? AND shot_index = ?`,
    [ctx.draft.id, sceneNumber, shotIndex]
  );
  if (currentRow && ['pending', 'mh_submitted'].includes(String(currentRow.status || '').toLowerCase())) {
    return { ok: false, error: 'This shot already has an active regeneration in progress' };
  }

  // Persist HIL prompt/duration overrides so episode edits survive reloads.
  const overrideUpdates = {};
  if (typeof opts.promptOverride === 'string' && opts.promptOverride.trim()) overrideUpdates.image_prompt_override = opts.promptOverride.trim();
  if (typeof opts.videoPromptOverride === 'string' && opts.videoPromptOverride.trim()) overrideUpdates.video_prompt_override = opts.videoPromptOverride.trim();
  if (opts.duration != null && Number.isFinite(Number(opts.duration))) overrideUpdates.duration_override = Number(opts.duration);
  if (Object.keys(overrideUpdates).length) await updateShotRow(ctx.draft.id, sceneNumber, shotIndex, overrideUpdates);

  _hilRegenerationRunning.add(hilKey);
  // Mark it 'pending' synchronously (before returning) so an immediate
  // dashboard poll already reflects "regenerating" rather than the stale
  // failed/done row from before this call.
  await updateShotRow(ctx.draft.id, sceneNumber, shotIndex, {
    status: 'pending', clip_url: null, mh_job_id: null, mh_api_key: null,
    last_error: null, failure_reason: null,
  }).catch(() => {});

  _regenerateShotBackground(ctx, sceneNumber, shotIndex, shot, sceneObj, opts)
    .catch(err => console.error(`[RegenShot] Background failure S${sceneNumber}/idx${shotIndex}:`, err.message))
    .finally(() => { _hilRegenerationRunning.delete(hilKey); });

  return { ok: true, queued: true, sceneNumber, shotIndex };
}

async function _regenerateShotBackground(ctx, sceneNumber, shotIndex, shotFromScript, sceneObj, opts) {
  const { draft, storyline, characters } = ctx;
  const globalEpisodeNumber = draft.episode_number;
  const persistedRow = await db.queryOne(
    `SELECT image_prompt_override, video_prompt_override, duration_override FROM shots WHERE episode_id = ? AND scene_number = ? AND shot_index = ?`,
    [draft.id, sceneNumber, shotIndex]
  );
  const shot = {
    ...shotFromScript,
    ...(persistedRow?.image_prompt_override ? { image_prompt: persistedRow.image_prompt_override } : {}),
    ...(opts.promptOverride ? { image_prompt: opts.promptOverride } : {}),
    ...(persistedRow?.duration_override != null ? { duration: Number(persistedRow.duration_override) } : {}),
    ...(opts.duration != null && Number.isFinite(Number(opts.duration)) ? { duration: Number(opts.duration) } : {}),
    ...(persistedRow?.video_prompt_override ? { _ltxPromptOverride: persistedRow.video_prompt_override } : {}),
    // HIL: literal hand-edited LTX video prompt — bypasses _buildLtxVideoPrompt
    // entirely for this one regeneration (see submitMeta in generateShot()).
    ...(opts.videoPromptOverride ? { _ltxPromptOverride: opts.videoPromptOverride } : {}),
  };

  // HIL "regenerate video only, keep this image" — reuse the shot's
  // already-generated still instead of calling the image generator again.
  // Falls back to a full redo (imageReuseUrl = null) if no image was saved.
  let reuseImageUrl = null;
  if (opts.keepImage) {
    const rowMap = await getShotRowMap(draft.id);
    const row = rowMap.get(`${sceneNumber}_${shotIndex}`);
    reuseImageUrl = _storedShotImageUrl(row?.image_url);
    if (!reuseImageUrl) {
      console.warn(`[RegenShot] keepImage requested for S${sceneNumber}/idx${shotIndex} but no saved image found — doing a full image+video redo instead.`);
    }
  }

  try {
    state.setStatus(state.STATES.GENERATING, `Regenerating shot ${sceneNumber}/${shotIndex}...`);
    console.log(`[RegenShot] Regenerating S${sceneNumber}/idx${shotIndex}` +
      `${opts.promptOverride ? ' (manual image-prompt edit)' : ''}` +
      `${opts.videoPromptOverride ? ' (manual video-prompt edit)' : ''}` +
      `${reuseImageUrl ? ' (keeping existing image)' : ''}`);

    // Get the scene background reference (if first shot in scene)
    const sceneBgRef = sceneObj.shots && shotIndex > 0
      ? cloudinary.imageDeliveryUrl(cloudinary.sceneBgPublicId(storyline.id, globalEpisodeNumber, sceneNumber))
      : null;

    // Rebuild the face-lock registry from the saved script so validateFaceLock
    // has reference embeddings to check against during this single-shot regen.
    const { faceLockRegistry } = hardControl.applyHardControlLayers(ctx.script, characters);

    // Regenerate the shot
    const { clipUrl } = await generateShot(
      _attachLtxPromptCapture(shot, { episodeId: draft.id, sceneNumber, shotIndex }), storyline, characters, globalEpisodeNumber,
      async (jobId, apiKey, imgTmpPubId) => {
        await updateShotRow(draft.id, sceneNumber, shotIndex, {
          status: 'mh_submitted', mh_job_id: jobId, mh_api_key: apiKey, image_url: imgTmpPubId || null,
        });
      },
      null,   // prevShot — no continuity context for single regen
      sceneBgRef,
      shotIndex === 0 ? async (imageBuffer) => {
        const bgPubId = cloudinary.sceneBgPublicId(storyline.id, globalEpisodeNumber, sceneNumber);
        const mime = _detectMime(imageBuffer);
        await cloudinary.uploadImageFromUrl(`data:${mime};base64,${imageBuffer.toString('base64')}`, bgPubId);
      } : null,
      reuseImageUrl,     // reuseImageUrl — set when the operator chose "keep this image"
      faceLockRegistry   // hard-control face-lock registry rebuilt for this regen
    );

    const clipDuration = shot.clip_duration || shot.duration || 4;
    await updateShotRow(draft.id, sceneNumber, shotIndex, {
      status: 'done', clip_url: clipUrl, clip_duration: clipDuration,
      mh_job_id: null, mh_api_key: null,
    });
    console.log(`[RegenShot] Shot ${sceneNumber}/${shotIndex} → ${clipUrl}`);

    // Recompile the scene so the dashboard shows the updated video
    state.setStatus(state.STATES.COMPILING, `Recompiling scene ${sceneNumber} after shot regen...`);
    const sceneUrl = await _compileOneScene(draft, ctx.script, sceneNumber, globalEpisodeNumber, storyline.id);
    const sceneState = safeJsonParse(draft.scene_state, {});
    sceneState[sceneNumber] = sceneUrl;
    await saveDraftProgress(draft.id, sceneState, null);

    state.setStatus(state.STATES.IDLE);
    return { ok: true, clipUrl, sceneUrl, sceneNumber, shotIndex };
  } catch (err) {
    console.error(`[RegenShot] Error S${sceneNumber}/idx${shotIndex}:`, err.message);
    await updateShotRow(draft.id, sceneNumber, shotIndex, {
      status: 'failed', last_error: String(err.message || err).slice(0, 500),
      last_prompt: err.lastPrompt || shot.image_prompt || null,
      failure_reason: err.failureReason || 'unknown',
    }).catch(() => {});
    state.setStatus(state.STATES.IDLE, `Shot ${sceneNumber}/${shotIndex} regeneration failed — ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Regenerate every shot in a single scene from scratch (image + video for
 * each shot in script order), then recompile just that scene so the
 * dashboard shows the new result immediately. This is the "whole scene"
 * counterpart to regenerateShot() — use it when several shots in a scene
 * need a redo rather than just one.
 */
async function regenerateScene(sceneNumber) {
  if (_recompileRunning) return { ok: false, error: 'A regenerate/recompile is already running — try again once it finishes' };
  const s = state.getState();
  if (s.status !== state.STATES.IDLE && s.status !== state.STATES.ERROR && s.status !== state.STATES.PAUSED) {
    return { ok: false, error: 'Pipeline is currently running — wait for it to finish first' };
  }

  const ctx = await _getDraftContext();
  if (!ctx) return { ok: false, error: 'No draft episode found' };
  const scenes   = ctx.script.scenes || [];
  const sceneObj = scenes.find(sc => sc.scene_number === sceneNumber);
  if (!sceneObj) return { ok: false, error: `Scene ${sceneNumber} not found in script` };
  const shots = sceneObj.shots || [];
  if (!shots.length) return { ok: false, error: `Scene ${sceneNumber} has no shots` };

  _recompileRunning = true;
  _regenerateSceneBackground(ctx, sceneNumber, sceneObj, shots)
    .catch(err => console.error(`[RegenScene] Background failure scene ${sceneNumber}:`, err.message))
    .finally(() => { _recompileRunning = false; });

  return { ok: true, queued: true, sceneNumber, shotsQueued: shots.length };
}

async function _regenerateSceneBackground(ctx, sceneNumber, sceneObj, shots) {
  const { draft, script, storyline, characters } = ctx;
  const globalEpisodeNumber = draft.episode_number;
  try {
    console.log(`[RegenScene] Regenerating scene ${sceneNumber} (${shots.length} shots)`);
    state.setStatus(state.STATES.GENERATING, `Regenerating scene ${sceneNumber} (${shots.length} shots)...`);
    state.setShotProgress(0, shots.length);

    // NOTE: the DB's shots.shot_index column is `shot.shot_index` — a field
    // already baked onto each shot object by script post-processing — NOT the
    // shot's position in the JS array. The two only coincide by luck, so every
    // DB read/write below keys off shot.shot_index, never the loop counter.

    // Reset every shot in this scene to pending before we start.
    for (const shot of shots) {
      await updateShotRow(draft.id, sceneNumber, shot.shot_index, {
        status: 'pending', clip_url: null, mh_job_id: null, mh_api_key: null,
      });
    }

    const { faceLockRegistry } = hardControl.applyHardControlLayers(script, characters);

    const sceneBackgroundState = safeJsonParse(draft.scene_background_state, {});
    await _ensureSceneBackground({ episodeId: draft.id, storyline, globalEpisodeNumber, scene: sceneObj, savedState: sceneBackgroundState });
    const sceneFirstImageUrls = new Map([[sceneNumber, sceneBackgroundState[String(sceneNumber)]]]);
    let successes = 0;
    const failures = [];

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const dbShotIndex = shot.shot_index;
      const prevShot = i > 0 ? shots[i - 1] : null;
      const sceneBgRef = sceneFirstImageUrls.get(sceneNumber) || null;
      const onImageGenerated = _makeShotImagePersistenceCallback({ episodeId: draft.id, shot, storyline, globalEpisodeNumber, logLabel: 'scene regen' });

      state.setProgress(i + 1, shots.length, `Scene ${sceneNumber} — shot ${i + 1}/${shots.length}`);

      try {
        const { clipUrl } = await generateShot(
          _attachLtxPromptCapture(shot, { episodeId: draft.id, sceneNumber, shotIndex: dbShotIndex }), storyline, characters, globalEpisodeNumber,
          async (jobId, apiKey) => {
            await updateShotRow(draft.id, sceneNumber, dbShotIndex, {
              status: 'mh_submitted', mh_job_id: jobId, mh_api_key: apiKey,
            });
          },
          prevShot,        // scene continuity context between shots within this regen
          sceneBgRef,
          onImageGenerated,
          null,            // reuseImageUrl — full redo, not a reuse
          faceLockRegistry
        );

        const clipDuration = shot.clip_duration || shot.duration || 4;
        await updateShotRow(draft.id, sceneNumber, dbShotIndex, {
          status: 'done', clip_url: clipUrl, clip_duration: clipDuration,
          mh_job_id: null, mh_api_key: null,
        });
        successes++;
        state.setShotProgress(successes, shots.length);
        console.log(`[RegenScene] Shot ${sceneNumber}/${dbShotIndex} → ${clipUrl}`);
      } catch (err) {
        failures.push(dbShotIndex);
        await updateShotRow(draft.id, sceneNumber, dbShotIndex, {
          status: 'failed', last_error: String(err.message || err).slice(0, 500),
          last_prompt: err.lastPrompt || null,
          failure_reason: err.failureReason || 'unknown',
        }).catch(() => {});
        console.warn(`[RegenScene] Shot ${sceneNumber}/${dbShotIndex} failed: ${err.message}`);
      }
    }

    if (failures.length > 0) {
      state.setStatus(state.STATES.IDLE,
        `Scene ${sceneNumber} regen finished with ${failures.length}/${shots.length} shot(s) failed`);
      console.warn(`[RegenScene] Scene ${sceneNumber}: ${failures.length}/${shots.length} shot(s) failed to regenerate`);
      return {
        ok: false,
        error: `${failures.length}/${shots.length} shot(s) failed to regenerate — fix API keys and try again`,
        failedShotIndexes: failures,
      };
    }

    // All shots regenerated — recompile the scene so the dashboard reflects it.
    state.setStatus(state.STATES.COMPILING, `Recompiling scene ${sceneNumber} after full regen...`);
    const sceneUrl = await _compileOneScene(draft, script, sceneNumber, globalEpisodeNumber, storyline.id);
    const sceneState = safeJsonParse(draft.scene_state, {});
    sceneState[sceneNumber] = sceneUrl;
    await saveDraftProgress(draft.id, sceneState, null);

    state.setStatus(state.STATES.IDLE);
    console.log(`[RegenScene] Scene ${sceneNumber} fully regenerated → ${sceneUrl}`);
    return { ok: true, sceneUrl, sceneNumber, shotsRegenerated: successes };
  } catch (err) {
    console.error('[RegenScene] Error:', err.message);
    state.setStatus(state.STATES.IDLE, `Scene regeneration failed — ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Purge every shot's clip_url for an episode (ANY status — draft or already
 * posted) while KEEPING each shot's stored image_url, then regenerate only
 * the videos by reusing those saved stills — no CF Worker calls at all,
 * since every shot has a DB-first image to reuse. Finishes by recompiling
 * every scene and re-merging the final episode video.
 *
 * Shots with no saved image_url are skipped (can't do a video-only
 * regeneration without a still to animate) — use the single-shot
 * regenerateShot() for those instead, which does a full image+video redo.
 */
async function regenerateEpisodeVideos(episodeId) {
  if (_recompileRunning) return { ok: false, error: 'Another recompile/regenerate is already running' };
  const s = state.getState();
  if (s.status !== state.STATES.IDLE && s.status !== state.STATES.ERROR && s.status !== state.STATES.PAUSED) {
    return { ok: false, error: 'Pipeline is currently running — wait for it to finish first' };
  }

  _recompileRunning = true;
  try {
    const episode = await db.queryOne(`SELECT * FROM episodes WHERE id = ?`, [episodeId]);
    if (!episode) return { ok: false, error: 'Episode not found' };

    const script = safeJsonParse(episode.script, {});
    const scenes = script.scenes || [];
    if (!scenes.length) return { ok: false, error: 'Episode has no script/scenes to regenerate from' };

    const storyline = await db.queryOne(`SELECT * FROM storylines WHERE id = ?`, [episode.storyline_id]);
    if (!storyline) return { ok: false, error: 'Storyline for this episode no longer exists' };
    const characterList = await getCharacters(episode.storyline_id);
    const globalEpisodeNumber = episode.episode_number;

    const allShots = scenes.flatMap(sc =>
      (sc.shots || []).map(sh => ({
        ...sh,
        scene_number:        sc.scene_number,
        composition:         sc.composition,
        characters_in_shot:  sh.characters_in_shot || sc.characters_present || [],
        _scene_description:  sc.scene_description || '',
        _scene_location:     sc.location          || '',
        _scene_emotion:      sc.emotional_beat    || '',
        _lighting_design:    sc.lighting_design   || '',
        _camera_language:    sc.camera_language   || '',
        _episode_title:      script.episode_title || '',
        _episode_logline:    script.logline || storyline.logline || storyline.plot_summary || '',
      }))
    );

    console.log(`[RegenEpisodeVideos] Starting for episode ${episodeId} (ep ${globalEpisodeNumber}), ${allShots.length} shots`);
    state.setStatus(state.STATES.GENERATING, `Purging & regenerating videos — episode ${globalEpisodeNumber} (${allShots.length} shots)...`);

    // Purge clip_url only — image_url and the shot row itself are untouched.
    await db.execute(
      `UPDATE shots SET status = 'pending', clip_url = NULL, clip_duration = NULL, mh_job_id = NULL, mh_api_key = NULL
       WHERE episode_id = ?`,
      [episodeId]
    );
    // Compiled scene URLs are now stale too — clear scene_state so recompile rebuilds them.
    await saveDraftProgress(episodeId, {}, null);

    const { faceLockRegistry } = hardControl.applyHardControlLayers(script, characterList);
    const shotRowMap = await getShotRowMap(episodeId);
    const sceneBackgroundState = safeJsonParse(episode.scene_background_state, {});
    for (const scene of scenes) {
      await _ensureSceneBackground({ episodeId, storyline, globalEpisodeNumber, scene, savedState: sceneBackgroundState });
    }
    const sceneFirstImageUrls = new Map(Object.entries(sceneBackgroundState).map(([k,v]) => [Number(k), v]));
    let successes = 0, skipped = 0, failures = 0;

    for (let i = 0; i < allShots.length; i++) {
      const shot = allShots[i];
      const prevShot = i > 0 ? allShots[i - 1] : null;
      const row = shotRowMap.get(`${shot.scene_number}_${shot.shot_index}`);
      const storedImageUrl = _storedShotImageUrl(row?.image_url);

      if (!storedImageUrl) {
        console.warn(`[RegenEpisodeVideos] S${shot.scene_number}/idx${shot.shot_index} has no saved image — skipping (use single-shot regenerate for a full redo)`);
        skipped++;
        continue;
      }

      const sceneBgRef = sceneFirstImageUrls.get(shot.scene_number) || null;

      state.setProgress(i + 1, allShots.length, `Regenerating video ${i + 1}/${allShots.length} — Scene ${shot.scene_number}`);

      try {
        const { clipUrl } = await generateShot(
          _attachLtxPromptCapture(shot, { episodeId, sceneNumber: shot.scene_number, shotIndex: shot.shot_index }), storyline, characterList, globalEpisodeNumber,
          async (jobId, apiKey) => {
            await updateShotRow(episodeId, shot.scene_number, shot.shot_index, {
              status: 'mh_submitted', mh_job_id: jobId, mh_api_key: apiKey,
            });
          },
          prevShot,
          sceneBgRef,
          null,               // onImageGenerated — not needed, image is already persisted
          storedImageUrl,     // reuseImageUrl — forces video-only regen, CF Worker never called
          faceLockRegistry
        );
        const clipDuration = shot.clip_duration || shot.duration || 4;
        await updateShotRow(episodeId, shot.scene_number, shot.shot_index, {
          status: 'done', clip_url: clipUrl, clip_duration: clipDuration, mh_job_id: null, mh_api_key: null,
        });
        successes++;
        state.setShotProgress(successes, allShots.length);
      } catch (err) {
        failures++;
        await updateShotRow(episodeId, shot.scene_number, shot.shot_index, {
          status: 'failed', last_error: String(err.message || err).slice(0, 500),
          last_prompt: err.lastPrompt || null,
          failure_reason: err.failureReason || 'unknown',
        }).catch(() => {});
        console.warn(`[RegenEpisodeVideos] S${shot.scene_number}/idx${shot.shot_index} failed: ${err.message}`);
        if (err.mhExhausted || err.zeroGpuExhausted) {
          state.setStatus(state.STATES.PAUSED,
            `⏸ Paused — provider exhausted during video regen. ${successes}/${allShots.length} done.`);
          return {
            ok: false,
            error: `Provider exhausted after ${successes}/${allShots.length} shots — run regenerate again once quota resets`,
            successes, failures, skipped,
          };
        }
      }
    }

    if (successes === 0) {
      state.setStatus(state.STATES.ERROR, 'Video regeneration failed — no shots succeeded');
      return { ok: false, error: 'No shots regenerated successfully', successes, failures, skipped };
    }

    // Recompile every scene + merge the final episode from the fresh clips.
    state.setStatus(state.STATES.COMPILING, 'Recompiling scenes with regenerated videos...');
    const sceneNums = scenes.map(sc => sc.scene_number).sort((a, b) => a - b);
    const sceneState = {};
    const sceneUrls = [];
    for (const sceneNum of sceneNums) {
      try {
        const sceneUrl = await _compileOneScene({ id: episodeId }, script, sceneNum, globalEpisodeNumber, storyline.id);
        sceneState[sceneNum] = sceneUrl;
        sceneUrls.push(sceneUrl);
        await saveDraftProgress(episodeId, sceneState, null);
      } catch (err) {
        console.error(`[RegenEpisodeVideos] Scene ${sceneNum} compile failed: ${err.message}`);
      }
    }

    if (!sceneUrls.length) {
      state.setStatus(state.STATES.ERROR, 'Recompile failed — no scenes compiled');
      return { ok: false, error: 'Videos regenerated but no scenes compiled', successes, failures, skipped };
    }

    const episodeTransition = script.episode_transition || null;
    const mergeJobId = await compiler.mergeScenes(sceneUrls, {
      introBumperUrl: process.env.INTRO_BUMPER_URL || null,
      outroBumperUrl: process.env.OUTRO_BUMPER_URL || null,
      transition:      episodeTransition,
    });
    const finalVideoUrl = await compiler.pollFFmpegJob(mergeJobId);
    const epPubId = cloudinary.episodePublicId(storyline.id, globalEpisodeNumber);
    const cloudinaryEpUrl = await cloudinary.uploadVideoFromUrl(finalVideoUrl, epPubId);
    await db.execute(`UPDATE episodes SET video_url = ? WHERE id = ?`, [cloudinaryEpUrl, episodeId]);

    state.setStatus(state.STATES.IDLE);
    console.log(`[RegenEpisodeVideos] Done. ${successes}/${allShots.length} shots regenerated (${skipped} skipped, ${failures} failed) → ${cloudinaryEpUrl}`);
    return { ok: true, videoUrl: cloudinaryEpUrl, successes, failures, skipped, totalShots: allShots.length };
  } catch (err) {
    console.error('[RegenEpisodeVideos] Error:', err.message);
    state.setStatus(state.STATES.ERROR, `Video regeneration failed — ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    _recompileRunning = false;
  }
}

module.exports = { runStreamVersePipeline, runReelsPipeline, runCommentReminder, runAutoCommentReplies, runEngagementPost, getDraftEpisodeAny, recompileAllScenes, recompileScene, recompileEpisode, regenerateShot, regenerateScene, regenerateEpisodeVideos, publishEpisode, requestPause, isPauseRequested, getShotDetail, editShotTimeline };
