'use strict';
/**
 * Constraint Enforcement Layer
 *
 * Validates generated images against the structured directives produced by
 * the Scene State Engine, Temporal Consistency Layer, and Camera Simulation
 * module.  When a violation is detected the enforcer does NOT silently accept
 * the image — it builds a corrected prompt that strengthens the violated
 * constraint and signals the pipeline to regenerate.
 *
 * Three validation passes:
 *
 *   1. Structural validation
 *      - Aspect ratio must match the production 2:3 portrait frame (1024×1536 or proportional)
 *      - Minimum resolution / file-size thresholds
 *      - Detect wrong camera framing (landscape, square, film-strip)
 *
 *   2. Lighting / colour validation
 *      - Analyse dominant colour temperature with sharp's histogram
 *      - Compare against the scene's lighting directive (warm / cool / neutral)
 *      - Detect lighting mismatch between consecutive shots in the same scene
 *
 *   3. Directive compliance validation
 *      - Verify the prompt that was sent actually contained every required
 *        directive (continuity, temporal, camera sim)
 *      - If a directive was missing the enforcer adds it back with stronger
 *        language so the next generation attempt receives it
 *
 * Returns a ValidationResult:
 *   { passed: boolean, violations: [{type, severity, message, correction}], correctedPrompt: string }
 *
 * The pipeline uses `passed` to decide whether to regenerate, and
 * `correctedPrompt` to replace the image prompt for the next attempt.
 */

const sharp = require('sharp');

// ── Constants ──────────────────────────────────────────────────────────────────

const TARGET_ASPECT_RATIO = 2 / 3;   // 0.666666... for 1024×1536 production frame
const ASPECT_TOLERANCE    = 0.06;      // allow ±6% deviation
const MIN_WIDTH           = 720;
const MIN_HEIGHT          = 1080;
const MIN_FILE_BYTES      = 5000;
const DRAFT_ACCEPT_SCORE  = 72;   // Good images advance; do not waste CF calls on cosmetic misses.
const DRAFT_RETRY_SCORE   = 55;   // Only clearly weak images are regenerated in draft.

const SEVERITY = {
  LOW:      'low',     // cosmetic — accept but log
  MEDIUM:   'medium',  // regenerate if retries remain
  HIGH:     'high',    // always regenerate
};

// ── 1. Structural validation ───────────────────────────────────────────────────

/**
 * Validate image dimensions, aspect ratio, and file size.
 * Detects wrong camera framing (landscape, square, film-strip layouts).
 */
async function _validateStructure(imageBuffer) {
  const violations = [];

  if (!imageBuffer || imageBuffer.length < MIN_FILE_BYTES) {
    violations.push({
      type: 'structure',
      severity: SEVERITY.HIGH,
      message: `Image too small (${imageBuffer?.length ?? 0} bytes) — likely corrupt or blank`,
      correction: 'Regenerate — image data is corrupt or incomplete.',
    });
    return violations;
  }

  let meta;
  try {
    meta = await sharp(imageBuffer).metadata();
  } catch (err) {
    violations.push({
      type: 'structure',
      severity: SEVERITY.HIGH,
      message: `Cannot read image metadata: ${err.message}`,
      correction: 'Regenerate — image format is unreadable.',
    });
    return violations;
  }

  const w = meta.width  || 0;
  const h = meta.height || 0;

  // Resolution check
  if (w < MIN_WIDTH || h < MIN_HEIGHT) {
    violations.push({
      type: 'structure',
      severity: SEVERITY.MEDIUM,
      message: `Resolution too low: ${w}×${h} (minimum ${MIN_WIDTH}×${MIN_HEIGHT})`,
      correction: `CRITICAL: Generate at the production portrait resolution, preferably 1024×1536 pixels. Do not produce a low-resolution thumbnail.`,
    });
  }

  // Aspect ratio check — must match the canonical 2:3 portrait production frame
  if (w > 0 && h > 0) {
    const aspect = w / h;
    const deviation = Math.abs(aspect - TARGET_ASPECT_RATIO) / TARGET_ASPECT_RATIO;

    if (deviation > ASPECT_TOLERANCE) {
      const isLandscape = aspect > 1.0;
      const isSquare   = Math.abs(aspect - 1.0) < 0.1;
      const isWidePortrait = aspect > TARGET_ASPECT_RATIO && aspect < 1.0;

      let framingIssue = 'wrong aspect ratio';
      if (isLandscape) framingIssue = 'landscape orientation instead of vertical portrait';
      else if (isSquare) framingIssue = 'square orientation instead of vertical portrait';
      else if (isWidePortrait) framingIssue = 'portrait frame wider than the canonical 2:3 target';

      violations.push({
        type: 'framing',
        severity: SEVERITY.HIGH,
        message: `Wrong camera framing: ${framingIssue} (${w}×${h}, aspect ${aspect.toFixed(3)}; expected 2:3 ≈ 0.667)`,
        correction: `CRITICAL: Produce ONE single image in the canonical 2:3 PORTRAIT frame, preferably exactly 1024×1536 pixels. NO landscape layout. NO film strips. NO multiple panels. NO square. Keep one continuous tall portrait frame.`,
      });
    }
  }

  return violations;
}

// ── 2. Lighting / colour validation ────────────────────────────────────────────

/**
 * Analyse the image's dominant colour temperature and compare it against
 * the scene's lighting directive.  Uses sharp's stats to get RGB channel
 * averages, then classifies as warm / cool / neutral.
 */
async function _validateLighting(imageBuffer, shot, prevShot) {
  const violations = [];

  let stats;
  try {
    stats = await sharp(imageBuffer).stats();
  } catch {
    // Can't analyse — skip lighting validation
    return violations;
  }

  // sharp stats returns channels: [{min, max, sum, squaresSum, mean, stdev, ...}, ...]
  // channels[0] = red, channels[1] = green, channels[2] = blue
  const channels = stats.channels || [];
  if (channels.length < 3) return violations;

  const rMean = channels[0].mean || 0;
  const gMean = channels[1].mean || 0;
  const bMean = channels[2].mean || 0;

  // Classify colour temperature
  const warmBias  = rMean - bMean;  // positive = warm, negative = cool
  const brightness = (rMean + gMean + bMean) / 3;

  let imageTemp;
  if (warmBias > 25) imageTemp = 'warm';
  else if (warmBias < -25) imageTemp = 'cool';
  else imageTemp = 'neutral';

  // Compare against scene lighting directive
  const sceneLighting = shot._scene_state?.lighting || shot._continuity_directive;
  const expectedTemp = _extractExpectedTemp(sceneLighting);

  if (expectedTemp && imageTemp !== expectedTemp && expectedTemp !== 'unknown') {
    violations.push({
      type: 'lighting',
      severity: SEVERITY.MEDIUM,
      message: `Lighting mismatch: image is ${imageTemp} (R=${rMean.toFixed(0)} B=${bMean.toFixed(0)}) but scene expects ${expectedTemp}`,
      correction: `CRITICAL LIGHTING CORRECTION: The lighting MUST be ${expectedTemp} temperature. ${expectedTemp === 'warm' ? 'Use golden, amber, orange tones. Add warm key light.' : expectedTemp === 'cool' ? 'Use blue, cold, icy tones. Add cool key light.' : 'Use neutral, balanced lighting.'} The current image has wrong colour temperature — fix it.`,
    });
  }

  // Cross-shot lighting consistency: compare brightness + temp with previous shot
  if (prevShot?._constraint_profile) {
    const prevProfile = prevShot._constraint_profile;
    const brightnessDiff = Math.abs(brightness - prevProfile.brightness);
    const tempShift = Math.abs(warmBias - prevProfile.warmBias);

    // Large brightness shift within the same scene = potential lighting reset
    if (brightnessDiff > 40 && _sameScene(shot, prevShot)) {
      violations.push({
        type: 'lighting',
        severity: SEVERITY.MEDIUM,
        message: `Brightness discontinuity: ${brightnessDiff.toFixed(0)} difference from previous shot in same scene`,
        correction: `LIGHTING CONTINUITY: Match the brightness level of the previous shot. Do not drastically change exposure between shots in the same scene.`,
      });
    }

    // Large temperature shift within the same scene
    if (tempShift > 35 && _sameScene(shot, prevShot)) {
      violations.push({
        type: 'lighting',
        severity: SEVERITY.MEDIUM,
        message: `Colour temperature discontinuity: ${tempShift.toFixed(0)} shift from previous shot in same scene`,
        correction: `COLOUR CONTINUITY: Maintain the same colour temperature as the previous shot. Do not shift from ${prevProfile.temp} to ${imageTemp} within the same scene.`,
      });
    }
  }

  // Store the profile on the shot for cross-shot comparison by the next shot
  shot._constraint_profile = { brightness, warmBias, temp: imageTemp, rMean, gMean, bMean };

  return violations;
}

function _extractExpectedTemp(directive) {
  if (!directive) return 'unknown';
  const text = String(directive).toLowerCase();
  if (text.includes('warm') || text.includes('golden') || text.includes('amber')) return 'warm';
  if (text.includes('cool') || text.includes('blue') || text.includes('cold')) return 'cool';
  if (text.includes('neutral')) return 'neutral';
  return 'unknown';
}

function _sameScene(shot, prevShot) {
  return shot.scene_number === prevShot.scene_number;
}

// ── 3. Directive compliance validation ─────────────────────────────────────────

/**
 * Verify that the prompt sent to the image generator actually contained
 * all required directives.  If a directive was missing (e.g. due to prompt
 * truncation or a bug), add it back with stronger language.
 */
function _validateDirectiveCompliance(shot, imagePrompt) {
  const violations = [];
  const promptText = (imagePrompt || '').toLowerCase();

  // Check for continuity directive
  if (shot._continuity_directive && !promptText.includes('scene state continuity')) {
    violations.push({
      type: 'directive_missing',
      severity: SEVERITY.LOW,
      message: 'Scene State continuity directive was missing from the prompt',
      correction: shot._continuity_directive,
    });
  }

  // Check for temporal directive
  if (shot._temporal_directive && !promptText.includes('temporal consistency')) {
    violations.push({
      type: 'directive_missing',
      severity: SEVERITY.LOW,
      message: 'Temporal consistency directive was missing from the prompt',
      correction: shot._temporal_directive,
    });
  }

  // Check for camera simulation directive
  if (shot._camera_sim?.promptFragment && !promptText.includes('camera simulation')) {
    violations.push({
      type: 'directive_missing',
      severity: SEVERITY.LOW,
      message: 'Camera simulation directive was missing from the prompt',
      correction: shot._camera_sim.promptFragment,
    });
  }

  return violations;
}

// ── Prompt correction assembly ──────────────────────────────────────────────────

/**
 * Build a corrected prompt by appending violation corrections to the
 * original prompt.  Each correction is prefixed with a severity marker so
 * the image generator knows which constraints are non-negotiable.
 *
 * @param {string} originalPrompt  - The prompt that was sent for this attempt
 * @param {Array}  violations      - Violations from all validation passes
 * @returns {string} The corrected prompt for the next generation attempt
 */
function _buildCorrectedPrompt(originalPrompt, violations) {
  const parts = [originalPrompt || ''];

  // Group corrections by severity — HIGH first, then MEDIUM, then LOW
  const sorted = [...violations].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.severity] || 3) - (order[b.severity] || 3);
  });

  for (const v of sorted) {
    if (v.correction) {
      const prefix = v.severity === SEVERITY.HIGH
        ? `⚠️ MANDATORY CORRECTION (${v.type}):`
        : v.severity === SEVERITY.MEDIUM
          ? `CORRECTION (${v.type}):`
          : `Note (${v.type}):`;
      parts.push(`${prefix} ${v.correction}`);
    }
  }

  return parts.join('\n\n');
}


/**
 * Quality scoring: draft is now a score gate, not a brittle all-or-nothing
 * constraint gate. The score rewards structural validity and scene fidelity,
 * while lighting/directive mismatches are soft penalties unless severe.
 *
 * 100 = strong candidate to advance.
 * 72+ = accept draft and advance without burning another CF generation.
 * 55-71 = one corrected retry may be worthwhile.
 * <55 = clearly weak; regenerate when retries remain.
 */

// ── 4. Canonical directorial-state validation -------------------------------

function _validateDirectorialState(shot, prevShot = null) {
  const violations = [];
  const ds = shot?._director_state;

  if (!ds) {
    violations.push({
      type: 'directorial_state',
      severity: SEVERITY.HIGH,
      message: 'Shot has no canonical _director_state.',
      correction: 'Rebuild the shot through the Directorial Orchestrator before image generation.',
    });
    return violations;
  }

  const travel = ds.travel || {};
  const stage = String(shot.travel_stage || travel.stage || 'none').toLowerCase();
  if (shot.travel_stage && travel.stage && String(shot.travel_stage).toLowerCase() !== String(travel.stage).toLowerCase()) {
    violations.push({
      type: 'directorial_state',
      severity: SEVERITY.HIGH,
      message: `Shot travel_stage "${shot.travel_stage}" disagrees with canonical state "${travel.stage}".`,
      correction: 'Regenerate the directorial state from the authoritative travel choreography.',
    });
  }
  if (stage !== 'none') {
    const origin = String(travel.origin || '').trim();
    const destination = String(travel.destination || '').trim();
    const mode = String(travel.mode || 'none').trim();

    if (!origin || !destination) {
      violations.push({
        type: 'travel',
        severity: SEVERITY.HIGH,
        message: `Travel stage "${stage}" is missing origin or destination.`,
        correction: 'Every physical location transition must identify origin, destination and travel mode.',
      });
    }

    if (['depart', 'in_transit', 'approach'].includes(stage) &&
        /\b(arrived|arrives|already at|inside the destination)\b/i.test(String(shot.start_state || shot.image_prompt || ''))) {
      violations.push({
        type: 'teleport',
        severity: SEVERITY.HIGH,
        message: `Shot is ${stage} but its opening state appears to place the character at the destination.`,
        correction: `Show the true ${stage} state from ${origin || 'the origin'} before the destination is reached.`,
      });
    }

    if (stage === 'in_transit' && !String(travel.route_beat || '').trim()) {
      violations.push({
        type: 'travel',
        severity: SEVERITY.MEDIUM,
        message: 'Transit shot has no route beat.',
        correction: `Describe a concrete physical movement between ${origin} and ${destination}.`,
      });
    }

    if (mode === 'none') {
      violations.push({
        type: 'travel',
        severity: SEVERITY.MEDIUM,
        message: 'Travel stage exists but travel mode is none.',
        correction: 'Specify the physical travel mode.',
      });
    }
  }

  if (prevShot?._director_state?.world?.location && ds.world?.location) {
    const prevLoc = String(prevShot._director_state.world.location).toLowerCase();
    const nextLoc = String(ds.world.location).toLowerCase();
    if (prevLoc !== nextLoc && stage === 'none') {
      violations.push({
        type: 'teleport',
        severity: SEVERITY.HIGH,
        message: `Location jumps from "${prevLoc}" to "${nextLoc}" without a transition stage.`,
        correction: `Use departure/transit/approach/arrival choreography from ${prevLoc} to ${nextLoc}.`,
      });
    }
  }

  const blocking = ds.spatial?.blocking || [];
  const positions = new Set();
  for (const row of blocking) {
    const key = `${String(row.screen_position || '').toLowerCase()}|${String(row.depth || '').toLowerCase()}`;
    if (positions.has(key)) {
      violations.push({
        type: 'blocking',
        severity: SEVERITY.MEDIUM,
        message: `Multiple characters occupy the same blocking slot "${key}".`,
        correction: 'Resolve screen geography before rendering the frame.',
      });
    }
    positions.add(key);
  }

  return violations;
}

function _scoreImage({ structureViolations = [], lightingViolations = [], directiveViolations = [], imageBuffer }) {
  let score = 100;
  const penalties = { high: 35, medium: 12, low: 3 };
  for (const v of structureViolations) score -= penalties[v.severity] || 0;
  for (const v of lightingViolations) score -= v.type === 'lighting' ? 8 : (penalties[v.severity] || 0);
  for (const v of directiveViolations) score -= 2;

  // Mild bonus for a healthy image payload; never exceed 100.
  if (imageBuffer?.length >= 300_000) score += 2;
  else if (imageBuffer?.length < 50_000) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreImageQuality({ structureViolations = [], lightingViolations = [], directiveViolations = [], imageBuffer }) {
  return _scoreImage({ structureViolations, lightingViolations, directiveViolations, imageBuffer });
}

function getDraftDecision(score, violations = []) {
  const hard = violations.some(v => v.severity === SEVERITY.HIGH);
  if (hard) return { action: 'regenerate', reason: 'hard_failure' };
  if (score >= DRAFT_ACCEPT_SCORE) return { action: 'accept', reason: 'good_enough' };
  if (score >= DRAFT_RETRY_SCORE) return { action: 'retry_once', reason: 'borderline' };
  return { action: 'regenerate', reason: 'weak_image' };
}

// ── Main: validate a generated image ────────────────────────────────────────────

/**
 * Validate a generated image against all constraint layers.
 *
 * @param {Buffer}  imageBuffer   - The generated image bytes
 * @param {Object} shot          - The shot object with directives attached
 * @param {string} imagePrompt   - The prompt that was sent to the generator
 * @param {Object} prevShot       - The previous shot (for cross-shot comparison)
 * @returns {Promise<{passed: boolean, violations: Array, correctedPrompt: string, profile: Object}>}
 */
async function validateImage(imageBuffer, shot, imagePrompt, prevShot = null, options = {}) {
  const checkLighting = options.checkLighting !== false;
  const checkDirectives = options.checkDirectives !== false;
  const allViolations = [];
  const structureViolations = await _validateStructure(imageBuffer);
  allViolations.push(...structureViolations);

  const directorialViolations = _validateDirectorialState(shot, prevShot);
  allViolations.push(...directorialViolations);

  const hasHighStructural = structureViolations.some(v => v.severity === SEVERITY.HIGH);
  const lightingViolations = (hasHighStructural || !checkLighting) ? [] : await _validateLighting(imageBuffer, shot, prevShot);
  allViolations.push(...lightingViolations);

  const directiveViolations = checkDirectives ? _validateDirectiveCompliance(shot, imagePrompt) : [];
  allViolations.push(...directiveViolations);

  const score = _scoreImage({ structureViolations, lightingViolations, directiveViolations, imageBuffer });
  const decision = getDraftDecision(score, allViolations);
  const retryable = allViolations.filter(v => v.severity === SEVERITY.HIGH || v.severity === SEVERITY.MEDIUM);
  const correctedPrompt = retryable.length ? _buildCorrectedPrompt(imagePrompt, retryable) : imagePrompt;
  const passed = decision.action === 'accept';

  if (allViolations.length > 0 || score < 90) {
    const summary = allViolations.length ? allViolations.map(v => `[${v.severity}] ${v.type}: ${v.message}`).join('; ') : 'no hard violations';
    console.log(`[ConstraintEnforcer] S${shot.scene_number}/idx${shot.shot_index}: score=${score}/100 decision=${decision.action} — ${summary}`);
  }

  return {
    passed,
    score,
    decision: decision.action,
    violations: allViolations,
    regenerate: decision.action !== 'accept',
    correctedPrompt,
    profile: shot._constraint_profile || null,
  };
}

/**
 * Determine whether a violation warrants consuming a retry attempt.
 * LOW severity violations are logged but don't trigger regeneration.
 */
function shouldRegenerate(result) {
  return result.regenerate === true;
}

module.exports = {
  validateImage,
  shouldRegenerate,
  SEVERITY,
  // Exported for testing
  _validateStructure,
  _validateLighting,
  _validateDirectiveCompliance,
  _validateDirectorialState,
  _buildCorrectedPrompt,
  scoreImageQuality,
  getDraftDecision,
  DRAFT_ACCEPT_SCORE,
  DRAFT_RETRY_SCORE,
};
