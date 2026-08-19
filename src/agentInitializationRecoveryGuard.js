'use strict';

/**
 * StreamVerse production guard: series initialization must be resumable.
 *
 * The series row is durable before character-reference generation starts, so a
 * transient CF/LTX/Mistral failure must never make the whole series disappear
 * or leave the agent with no actionable state. This guard wraps the already
 * loaded production-readiness wrapper and turns character-reference failures
 * into a durable, retryable readiness result.
 *
 * It also makes canonical character references a hard prerequisite for season
 * simulation. The repair is deterministic and calls the existing pipeline
 * character-consistency engine; it does not ask the LLM to invent a new cast.
 */
const Module = require('module');
const path = require('path');

const originalLoad = Module._load;
let wrapped = null;

function json(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function isPlaceholder(row) {
  if (!row) return true;
  const title = String(row.title || '').trim();
  const id = String(row.id || '').trim();
  return /^(placeholder(?:[-_ ]storyline)?|untitled|test)$/i.test(title) || /^placeholder[-_]/i.test(id);
}

function isCharacterReferenceError(err) {
  const text = String(err?.message || err || '');
  return /CFOutputValidationError|Cloudflare returned .*expected 1024x1536|CHARACTER_REFERENCE_INCOMPLETE|reference.*(incomplete|missing|failed)|portrait/i.test(text);
}

async function referenceStatus(db, storylineId) {
  const rows = await db.query(`SELECT id,name,reference_status,reference_image_url,reference_image_urls,reference_image_meta FROM characters WHERE storyline_id=? ORDER BY created_at`, [storylineId]);
  const required = ['front','three_quarter','profile','full_body'];
  const missing = [];
  for (const row of rows) {
    const meta = json(row.reference_image_meta, {});
    const angles = meta.angles && typeof meta.angles === 'object' ? meta.angles : {};
    const urls = Array.isArray(row.reference_image_urls) ? row.reference_image_urls : json(row.reference_image_urls, []);
    if (row.reference_image_url && !angles.front) angles.front = row.reference_image_url;
    if (Array.isArray(urls)) required.forEach((a, i) => { if (urls[i] && !angles[a]) angles[a] = urls[i]; });
    for (const angle of required) {
      if (!angles[angle]) missing.push({ character_id: row.id, character: row.name, angle });
    }
  }
  return { ok: rows.length > 0 && missing.length === 0, character_count: rows.length, missing };
}

async function getRecoverableStoryline(db, genre) {
  const params = genre ? [genre] : [];
  const where = genre ? `AND genre=?` : '';
  const rows = await db.query(
    `SELECT * FROM storylines WHERE status='active' ${where} ORDER BY updated_at DESC LIMIT 10`,
    params,
  );
  return rows.find(row => !isPlaceholder(row)) || null;
}

function wrapProductionTools(original) {
  if (wrapped) return wrapped;
  const out = { ...original };
  const db = originalLoad(path.join(__dirname, 'db.js'), module, false);
  const pipeline = originalLoad(path.join(__dirname, 'pipeline.js'), module, false);

  const originalInitialize = original.initializeSeries;
  out.initializeSeries = async (args = {}) => {
    try {
      const result = await originalInitialize(args);
      if (result?.storyline?.id) {
        const refs = await referenceStatus(db, result.storyline.id);
        if (!refs.ok) {
          return {
            ...result,
            ok: true,
            pending: true,
            phase: 'character_references',
            code: 'CHARACTER_REFERENCE_INCOMPLETE',
            character_references: refs,
            reason: 'Series is durably initialized, but canonical character references are incomplete. Retry the character-reference stage before season simulation.',
          };
        }
      }
      return result;
    } catch (err) {
      // initializeSeries persists the storyline before insertCharactersWithConsistency.
      // Recover that durable series instead of converting a character-image failure
      // into a fatal series initialization failure.
      if (!isCharacterReferenceError(err)) throw err;
      const storyline = await getRecoverableStoryline(db, args.genre || null);
      if (!storyline) throw err;
      const refs = await referenceStatus(db, storyline.id);
      console.warn(`[ProductionGuard] Series row survived character-reference failure; returning resumable state for ${storyline.title}. Missing=${refs.missing.length}`);
      return {
        ok: true,
        created: true,
        pending: true,
        phase: 'character_references',
        code: 'CHARACTER_REFERENCE_INCOMPLETE',
        storyline,
        character_references: refs,
        reason: `Character reference generation is incomplete: ${refs.missing.length} canonical angle(s) still missing.`,
        error: String(err.message || err),
      };
    }
  };

  const originalSimulateSeason = original.simulateSeason;
  out.simulateSeason = async (args = {}) => {
    const storylineId = args.storyline_id;
    const row = storylineId ? await db.queryOne(`SELECT * FROM storylines WHERE id=?`, [storylineId]) : null;
    if (!row || isPlaceholder(row)) throw new Error(`Production invariant failed: real storyline required before season simulation`);

    let refs = await referenceStatus(db, storylineId);
    if (!refs.ok) {
      console.log(`[ProductionGuard] CHARACTER_REFERENCE_INCOMPLETE — repairing missing canonical angles before season simulation (${refs.missing.length} missing).`);
      try {
        if (typeof pipeline.ensureCharacterConsistency !== 'function') {
          throw new Error('Character consistency engine is not available');
        }
        await pipeline.ensureCharacterConsistency(storylineId);
      } catch (err) {
        refs = await referenceStatus(db, storylineId);
        const e = new Error(`CHARACTER_REFERENCE_INCOMPLETE: ${refs.missing.length} canonical character angle(s) remain missing after targeted regeneration. ${err.message}`);
        e.code = 'CHARACTER_REFERENCE_INCOMPLETE';
        e.retryable = true;
        throw e;
      }
      refs = await referenceStatus(db, storylineId);
      if (!refs.ok) {
        const e = new Error(`CHARACTER_REFERENCE_INCOMPLETE: ${refs.missing.length} canonical character angle(s) remain missing after targeted regeneration.`);
        e.code = 'CHARACTER_REFERENCE_INCOMPLETE';
        e.retryable = true;
        throw e;
      }
    }

    return originalSimulateSeason(args);
  };

  out.__characterReferenceRecoveryGuard = true;
  wrapped = out;
  return out;
}

Module._load = function(request, parent, isMain) {
  if (request === './agentProductionTools' && parent && parent.filename && path.basename(parent.filename) === 'agentOrchestrator.js') {
    const original = originalLoad(path.join(__dirname, 'agentProductionTools.js'), parent, isMain);
    return wrapProductionTools(original);
  }
  return originalLoad(request, parent, isMain);
};

console.log('[ProductionGuard] Resumable series initialization + canonical character-reference gate loaded.');
