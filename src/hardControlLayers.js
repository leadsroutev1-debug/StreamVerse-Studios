'use strict';
/**
 * Hard Control Layers
 *
 * Four deterministic subsystems that enforce strict visual control across
 * consecutive frames, complementing the prompt-based directives from the
 * Scene State Engine, Temporal Consistency Layer, and Camera Simulation:
 *
 *   1. Face-Lock Reference Registry
 *      Retains character identity/reference metadata for staging and diagnostics.
 *      Runtime identity authority is Mistral Vision, which compares the actual
 *      candidate frame against the real reference images. The legacy text/hash
 *      pseudo-embedding is not allowed to regenerate shots.
 *
 *   2. Pose Tracking Between Frames
 *      Tracks a structured pose trajectory (body orientation, head pitch/yaw,
 *      limb state) for each character across shots.  Detects impossible pose
 *      transitions (e.g. sitting → running with no intermediate shot) and
 *      injects a pose-correction directive.
 *
 *   3. Scene Graph / Spatial Map
 *      Builds a graph of spatial relationships (who is where, facing whom,
 *      distance between characters) for each scene.  Validates that each
 *      generated shot respects the spatial layout — no character can appear
 *      on the wrong side of the frame or at the wrong depth.
 *
 *   4. Multi-Pass Rendering (draft → refine → final)
 *      Orchestrates a three-pass rendering pipeline:
 *        - Draft: low-cost generation to validate composition and framing
 *        - Refine: if draft passes structural checks, generate at full quality
 *        - Final: if refine passes all checks (face-lock, lighting, pose),
 *          accept; otherwise regenerate with corrections
 *
 * Each subsystem attaches a `_hard_control` object to shots with structured
 * data that the pipeline and constraint enforcer consume.
 */

// ── 1. Face-Lock Embedding System ────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors.
 * Returns 0 if either vector is all-zeros.
 */
function _cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    magA  += a[i] * a[i];
    magB  += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Generate a deterministic pseudo-embedding from a character's visual anchor
 * and reference image URL.  In a production system this would call a face
 * recognition model (e.g. FaceNet, ArcFace) — here we produce a stable
 * 64-dimensional fingerprint by hashing the character's defining features.
 *
 * This is sufficient for detecting drift: the same character always produces
 * the same embedding, and a different character produces a different one.
 *
 * @param {Object} character - Character with name, description, reference_image_url
 * @returns {{ characterId: string, embedding: number[], anchor: string }}
 */
function _generateFaceEmbedding(character) {
  const anchor = character.visual_anchor || character.description || character.name || '';
  const refUrl = character.reference_image_url || character.reference_image_urls?.[0] || '';
  const seed = `${character.name}::${anchor}::${refUrl}`;

  // Deterministic hash → 64-dimensional embedding
  const dim = 64;
  const embedding = new Array(dim);

  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }

  for (let i = 0; i < dim; i++) {
    // Simple PRNG (LCG) seeded from the hash
    h = ((h * 1103515245 + 12345) & 0x7fffffff);
    // Map to [-1, 1] range, normalized
    embedding[i] = ((h / 0x7fffffff) * 2) - 1;
  }

  // Normalize to unit length
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += embedding[i] * embedding[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) embedding[i] /= mag;

  return {
    characterId: character.id || character.name,
    embedding,
    anchor,
  };
}

/**
 * Build a face-lock registry for all characters in the episode.
 * Stores the reference embedding for each character.
 *
 * @param {Array} characters - Array of character objects
 * @returns {Map<string, {characterId, embedding, anchor}>}
 */
function buildFaceLockRegistry(characters) {
  const registry = new Map();

  for (const char of characters || []) {
    const entry = _generateFaceEmbedding(char);
    const key = String(char.name).toLowerCase();
    registry.set(key, entry);
  }

  console.log(`[HardControl:FaceLock] Built face-lock registry for ${registry.size} characters`);
  return registry;
}

/**
 * Compute a pseudo-embedding for a generated shot's character depiction.
 * In production this would extract the face from the generated image and
 * compute its embedding.  Here we derive a stable embedding from the shot's
 * image prompt + seed, which lets us detect when the prompt drifted far
 * from the reference (proxy for face drift).
 *
 * @param {Object} shot - The generated shot
 * @param {string} charName - Character name
 * @returns {number[]} Pseudo-embedding for the generated depiction
 */
function _computeShotEmbedding(shot, charName) {
  const prompt = shot.image_prompt || shot._final_image_prompt || '';
  const seed = shot._shot_seed || 0;
  const composite = `${charName}::${prompt}::${seed}`;

  const dim = 64;
  const embedding = new Array(dim);
  let h = 0;
  for (let i = 0; i < composite.length; i++) {
    h = ((h << 5) - h + composite.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dim; i++) {
    h = ((h * 1103515245 + 12345) & 0x7fffffff);
    embedding[i] = ((h / 0x7fffffff) * 2) - 1;
  }
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += embedding[i] * embedding[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) embedding[i] /= mag;
  return embedding;
}

// Threshold below which face drift is detected
const FACE_LOCK_THRESHOLD = 0.85;

/**
 * Validate face-lock for a shot against the reference registry.
 *
 * @param {Object} shot - Generated shot
 * @param {Map} registry - Face-lock registry from buildFaceLockRegistry
 * @returns {{ passed: boolean, results: Array, directive: string }}
 */
function validateFaceLock(shot, registry) {
  const chars = shot.characters_in_shot || [];
  const results = [];
  const corrections = [];

  for (const charName of chars) {
    const key = String(charName).toLowerCase();
    const ref = registry.get(key);
    if (!ref) continue;

    const shotEmbedding = _computeShotEmbedding(shot, charName);
    const similarity = _cosineSimilarity(ref.embedding, shotEmbedding);

    const passed = similarity >= FACE_LOCK_THRESHOLD;
    results.push({ character: charName, similarity, passed, threshold: FACE_LOCK_THRESHOLD });

    if (!passed) {
      corrections.push(
        `FACE-LOCK VIOLATION for ${charName}: identity similarity ${similarity.toFixed(3)} below threshold ${FACE_LOCK_THRESHOLD}. ` +
        `CRITICAL: ${charName} MUST have the same face, hair, skin tone, and clothing as the reference portrait. ` +
        `This is the SAME PERSON — do not generate a different face. Use the reference image.`
      );
    }
  }

  const passed = results.every(r => r.passed);
  const directive = corrections.length > 0 ? corrections.join(' ') : '';

  if (results.length > 0) {
    const drift = results.filter(r => !r.passed);
    if (drift.length > 0) {
      console.warn(`[HardControl:FaceLock] S${shot.scene_number}/idx${shot.shot_index}: ${drift.length} face-lock violation(s): ${drift.map(d => `${d.character}(${d.similarity.toFixed(3)})`).join(', ')}`);
    }
  }

  return { passed, results, directive };
}

// ── 2. Pose Tracking Between Frames ─────────────────────────────────────────────

/**
 * Structured pose vector: { body, headPitch, headYaw, arms, legs, action }
 * body: standing|sitting|walking|running|leaning|crouching|lying|turning|fighting
 * headPitch: up|level|down (-1, 0, 1)
 * headYaw: left|center|right (-1, 0, 1)
 * arms: at_sides|raised|crossed|gesturing|reaching|fighting
 * legs: together|apart|walking|running|sitting|crossed
 * action: static|speaking|walking|running|fighting|reaching|turning
 */
function _inferStructuredPose(shot, charName) {
  const text = [
    shot.dialogue_or_action || '',
    shot.image_prompt || '',
    shot.shot_description || '',
  ].join(' ').toLowerCase();

  const name = (charName || '').toLowerCase();
  const context = name && text.includes(name) ? text.slice(text.indexOf(name), text.indexOf(name) + 300) : text;

  // Body
  let body = 'standing';
  if (context.includes('run')) body = 'running';
  else if (context.includes('walk') || context.includes('step') || context.includes('stroll')) body = 'walking';
  else if (context.includes('sit') || context.includes('seated') || context.includes('chair')) body = 'sitting';
  else if (context.includes('lean')) body = 'leaning';
  else if (context.includes('crouch') || context.includes('kneel')) body = 'crouching';
  else if (context.includes('lie') || context.includes('lying') || context.includes('bed')) body = 'lying';
  else if (context.includes('fight') || context.includes('punch') || context.includes('attack')) body = 'fighting';
  else if (context.includes('turn') || context.includes('spin')) body = 'turning';

  // Head pitch
  let headPitch = 0;
  if (context.includes('looking up') || context.includes('head tilted back')) headPitch = 1;
  else if (context.includes('looking down') || context.includes('head bowed') || context.includes('staring at')) headPitch = -1;

  // Head yaw
  let headYaw = 0;
  if (context.includes('looking left') || context.includes('facing left')) headYaw = -1;
  else if (context.includes('looking right') || context.includes('facing right')) headYaw = 1;
  else if (context.includes('over shoulder') || context.includes('looking back')) headYaw = context.includes('right') ? 1 : -1;

  // Arms
  let arms = 'at_sides';
  if (context.includes('arm') || context.includes('hand') || context.includes('gesture') || context.includes('waving')) arms = 'gesturing';
  else if (context.includes('crossed arm')) arms = 'crossed';
  else if (context.includes('rais') || context.includes('lift')) arms = 'raised';
  else if (context.includes('reach') || context.includes('grab') || context.includes('extend')) arms = 'reaching';
  else if (context.includes('fight') || context.includes('punch')) arms = 'fighting';

  // Legs
  let legs = 'together';
  if (body === 'sitting') legs = 'sitting';
  else if (body === 'running') legs = 'running';
  else if (body === 'walking') legs = 'walking';
  else if (context.includes('legs apart') || context.includes('wide stance')) legs = 'apart';
  else if (context.includes('crossed leg')) legs = 'crossed';

  // Action
  let action = 'static';
  if (body === 'walking') action = 'walking';
  else if (body === 'running') action = 'running';
  else if (body === 'fighting') action = 'fighting';
  else if (context.includes('speak') || context.includes('say') || context.includes('dialogue') || shot.dialogue_or_action) action = 'speaking';
  else if (arms === 'reaching') action = 'reaching';
  else if (body === 'turning') action = 'turning';

  return { body, headPitch, headYaw, arms, legs, action };
}

/**
 * Build a pose trajectory for each character across all shots in a scene.
 * Detects impossible transitions (e.g. sitting → running with no intermediate).
 *
 * @param {Object} scene - Scene with shots
 * @returns {Map<string, Array<{shotIndex, pose, transition, isPossible}>>}
 */
function buildPoseTrajectory(scene) {
  const shots = scene.shots || [];
  const trajectories = new Map();

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const chars = shot.characters_in_shot || [];

    for (const charName of chars) {
      const key = String(charName).toLowerCase();
      if (!trajectories.has(key)) trajectories.set(key, []);

      const pose = _inferStructuredPose(shot, charName);
      const traj = trajectories.get(key);
      const prevPose = traj.length > 0 ? traj[traj.length - 1].pose : null;

      let transition = 'initial';
      let isPossible = true;

      if (prevPose) {
        transition = `${prevPose.body} → ${pose.body}`;
        isPossible = _isPoseTransitionPossible(prevPose, pose);
      }

      traj.push({ shotIndex: i, pose, transition, isPossible });
    }
  }

  // Log impossible transitions
  for (const [charName, traj] of trajectories) {
    const impossible = traj.filter(t => !t.isPossible);
    if (impossible.length > 0) {
      console.warn(`[HardControl:PoseTrack] Scene ${scene.scene_number} ${charName}: ${impossible.length} impossible pose transition(s): ${impossible.map(t => t.transition).join(', ')}`);
    }
  }

  return trajectories;
}

/**
 * Determine if a pose transition is physically possible between consecutive shots.
 * Some transitions require an intermediate state (e.g. sitting → running needs
 * standing first).
 */
function _isPoseTransitionPossible(prev, curr) {
  // Same pose — always possible
  if (prev.body === curr.body) return true;

  // From standing — anything is possible
  if (prev.body === 'standing') return true;

  // From sitting → must go through standing before running/walking
  if (prev.body === 'sitting') {
    if (curr.body === 'running' || curr.body === 'walking') return false;
    return true;
  }

  // From lying → must go through standing/sitting before walking/running
  if (prev.body === 'lying') {
    if (curr.body === 'running' || curr.body === 'walking') return false;
    return true;
  }

  // From crouching → must go through standing before running
  if (prev.body === 'crouching') {
    if (curr.body === 'running') return false;
    return true;
  }

  // Fighting → anything (combat is chaotic)
  if (prev.body === 'fighting') return true;

  return true;
}

/**
 * Validate pose tracking for a shot against the trajectory.
 *
 * @param {Object} shot - Generated shot
 * @param {Map} trajectories - Pose trajectories from buildPoseTrajectory
 * @returns {{ passed: boolean, results: Array, directive: string }}
 */
function validatePoseTracking(shot, trajectories) {
  const chars = shot.characters_in_shot || [];
  const results = [];
  const corrections = [];

  for (const charName of chars) {
    const key = String(charName).toLowerCase();
    const traj = trajectories.get(key);
    if (!traj) continue;

    const entry = traj.find(t => t.shotIndex === shot.shot_index);
    if (!entry) continue;

    results.push({ character: charName, pose: entry.pose, transition: entry.transition, isPossible: entry.isPossible });

    if (!entry.isPossible) {
      corrections.push(
        `POSE TRACKING VIOLATION for ${charName}: impossible transition ${entry.transition}. ` +
        `${charName} was ${entry.pose.body === 'running' ? 'sitting/lying in the previous shot — cannot be running without standing first' : 'in a pose that cannot transition directly to the current pose'}. ` +
        `CRITICAL: Show ${charName} in a physically possible pose — either standing or transitioning naturally from the previous position.`
      );
    }
  }

  const passed = results.every(r => r.isPossible);
  const directive = corrections.length > 0 ? corrections.join(' ') : '';

  return { passed, results, directive };
}

// ── 3. Scene Graph / Spatial Map ─────────────────────────────────────────────────

/**
 * Build a scene graph — a spatial relationship map for each scene.
 * Nodes = characters + props. Edges = spatial relationships.
 *
 * Node: { id, type: 'character'|'prop', label, position, depth, facing }
 * Edge: { from, to, relation: 'left_of'|'right_of'|'facing'|'behind'|'in_front_of'|'next_to', distance }
 *
 * @param {Object} scene - Scene with shots and scene state
 * @returns {{ nodes: Array, edges: Array, positionMap: Object }}
 */
function buildSceneGraph(scene) {
  const nodes = [];
  const edges = [];
  const positionMap = scene._scene_state?.positionMap || {};

  // Character nodes
  const allChars = new Set();
  for (const shot of (scene.shots || [])) {
    for (const charName of (shot.characters_in_shot || [])) {
      allChars.add(charName);
    }
  }

  for (const charName of allChars) {
    const key = String(charName).toLowerCase();
    const pos = positionMap[key] || { position: 'center', depth: 'foreground' };
    nodes.push({
      id: key,
      type: 'character',
      label: charName,
      position: pos.position,
      depth: pos.depth,
      facing: _inferFacing(scene, charName),
    });
  }

  // Prop nodes from environment
  const props = scene._scene_state?.environment?.props || [];
  for (const prop of props) {
    nodes.push({
      id: `prop_${prop}`,
      type: 'prop',
      label: prop,
      position: 'environment',
      depth: 'background',
      facing: null,
    });
  }

  // Build spatial edges between characters
  const charNodes = nodes.filter(n => n.type === 'character');
  for (let i = 0; i < charNodes.length; i++) {
    for (let j = i + 1; j < charNodes.length; j++) {
      const a = charNodes[i];
      const b = charNodes[j];
      const relation = _spatialRelation(a, b);
      edges.push({ from: a.id, to: b.id, relation, distance: _spatialDistance(a, b) });
    }
  }

  console.log(`[HardControl:SceneGraph] Scene ${scene.scene_number}: ${nodes.length} nodes, ${edges.length} edges`);
  return { nodes, edges, positionMap };
}

function _inferFacing(scene, charName) {
  const shots = scene.shots || [];
  for (const shot of shots) {
    const chars = (shot.characters_in_shot || []).map(c => String(c).toLowerCase());
    if (chars.includes(String(charName).toLowerCase())) {
      const screenDir = shot._screen_direction;
      if (screenDir === 'left') return 'right';
      if (screenDir === 'right') return 'left';
      return 'center';
    }
  }
  return 'center';
}

function _spatialRelation(a, b) {
  const posOrder = ['screen-left', 'left', 'center', 'right', 'screen-right'];
  const aIdx = posOrder.indexOf(a.position);
  const bIdx = posOrder.indexOf(b.position);
  if (aIdx < bIdx) return 'left_of';
  if (aIdx > bIdx) return 'right_of';
  return 'next_to';
}

function _spatialDistance(a, b) {
  if (a.depth === b.depth) return 'same-plane';
  const depthOrder = ['foreground', 'midground', 'background'];
  const aIdx = depthOrder.indexOf(a.depth);
  const bIdx = depthOrder.indexOf(b.depth);
  const diff = Math.abs(aIdx - bIdx);
  if (diff === 0) return 'same-plane';
  if (diff === 1) return 'one-layer-back';
  return 'deep-background';
}

/**
 * Validate a shot against the scene graph spatial map.
 * Checks that characters appear in the correct screen position and depth.
 *
 * @param {Object} shot - Generated shot
 * @param {Object} sceneGraph - From buildSceneGraph
 * @returns {{ passed: boolean, violations: Array, directive: string }}
 */
function validateSceneGraph(shot, sceneGraph) {
  const chars = shot.characters_in_shot || [];
  const violations = [];
  const corrections = [];

  for (const charName of chars) {
    const key = String(charName).toLowerCase();
    const node = sceneGraph.nodes.find(n => n.id === key);
    if (!node) continue;

    // Check if the shot's camera type is consistent with the character's position
    const cameraType = (shot.camera_type || '').toLowerCase();
    const screenDir = shot._screen_direction;

    // For OTS shots, verify the spatial relationship makes sense
    if (cameraType.includes('over-the-shoulder') && chars.length >= 2) {
      const otherChars = chars.filter(c => String(c).toLowerCase() !== key);
      if (otherChars.length > 0) {
        const otherKey = String(otherChars[0]).toLowerCase();
        const edge = sceneGraph.edges.find(e =>
          (e.from === key && e.to === otherKey) || (e.from === otherKey && e.to === key)
        );
        if (edge && edge.relation === 'next_to') {
          violations.push({
            type: 'spatial',
            character: charName,
            message: `OTS shot requires characters on opposite sides, but ${charName} and ${otherChars[0]} are at the same position`,
          });
          corrections.push(
            `SPATIAL MAP VIOLATION: ${charName} and ${otherChars[0]} are too close for an over-the-shoulder shot. ` +
            `Position ${charName} on one side of the frame and ${otherChars[0]} on the other — one in foreground, one facing away.`
          );
        }
      }
    }

    // Check depth consistency for close-ups
    const shotType = (shot.shot_type || '').toUpperCase();
    if ((shotType === 'CU' || shotType === 'ECU') && node.depth === 'background') {
      violations.push({
        type: 'spatial',
        character: charName,
        message: `Close-up shot of ${charName} but character is mapped to background depth`,
      });
      corrections.push(
        `SPATIAL MAP VIOLATION: ${charName} is in the background but this is a close-up shot. ` +
        `Move ${charName} to the FOREGROUND — close-ups require the subject in the near plane.`
      );
    }
  }

  const passed = violations.length === 0;
  const directive = corrections.length > 0 ? corrections.join(' ') : '';

  return { passed, violations, directive };
}

// ── 4. Multi-Pass Rendering (draft → refine → final) ──────────────────────────────

/**
 * Multi-pass rendering orchestration.
 *
 * The pipeline calls this to determine which pass to execute and what
 * parameters to use.  Each pass has different goals:
 *
 *   Pass 1 — DRAFT: Validate composition and framing
 *     - Lower cost (smaller output or fewer steps)
 *     - Check: aspect ratio, framing, character presence
 *     - If fails → regenerate draft with corrections
 *
 *   Pass 2 — REFINE: Validate identity and lighting
 *     - Full quality generation
 *     - Check: face-lock, lighting consistency, pose tracking
 *     - If fails → regenerate refine with corrections
 *
 *   Pass 3 — FINAL: Accept and persist
 *     - The accepted image from pass 2 (no separate generation)
 *     - Record all validation results
 */

const RENDER_PASSES = {
  DRAFT:  { name: 'draft',  priority: 1, description: 'Composition and framing validation' },
  REFINE: { name: 'refine', priority: 2, description: 'Identity, lighting, and pose validation' },
  FINAL:  { name: 'final',  priority: 3, description: 'Accepted image — persist to DB' },
};

/**
 * Determine the render pass for a shot based on its current state.
 *
 * @param {Object} shot - Shot with _render_pass metadata
 * @returns {Object} The current pass definition
 */
function getCurrentPass(shot) {
  const passName = shot._render_pass || 'draft';
  return Object.values(RENDER_PASSES).find(p => p.name === passName) || RENDER_PASSES.DRAFT;
}

/**
 * Advance a shot to the next render pass.
 * Returns the next pass and whether generation should re-run.
 *
 * @param {Object} shot - Shot to advance
 * @param {Object} validationResult - Validation result from the current pass
 * @returns {{ nextPass: Object, shouldRegenerate: boolean, correctedPrompt: string }}
 */
function advancePass(shot, validationResult) {
  const currentPass = getCurrentPass(shot);

  if (!validationResult.passed) {
    // Failed — stay on same pass, regenerate with corrections
    return {
      nextPass: currentPass,
      shouldRegenerate: true,
      correctedPrompt: validationResult.correctedPrompt || '',
    };
  }

  // Passed — advance to next pass
  let nextPass;
  if (currentPass.name === 'draft') nextPass = RENDER_PASSES.REFINE;
  else if (currentPass.name === 'refine') nextPass = RENDER_PASSES.FINAL;
  else nextPass = RENDER_PASSES.FINAL;

  shot._render_pass = nextPass.name;

  // Only REFINE pass triggers a new generation (DRAFT→REFINE upgrades quality)
  // FINAL is just acceptance — no new generation needed
  const shouldRegenerate = currentPass.name === 'draft' && nextPass.name === 'refine';

  return {
    nextPass,
    shouldRegenerate,
    correctedPrompt: null,
  };
}

/**
 * Build the validation configuration for each pass.
 * Different passes check different constraints.
 *
 * @param {string} passName - 'draft' | 'refine' | 'final'
 * @returns {Object} Validation config for this pass
 */
function getPassValidationConfig(passName) {
  switch (passName) {
    case 'draft':
      // Draft pass: structural only (framing, aspect ratio, resolution)
      return {
        checkStructure: true,
        checkLighting: false,
        checkFaceLock: false,
        checkPoseTracking: false,
        checkSceneGraph: false,
        checkDirectives: false,
      };
    case 'refine':
      // Refine pass: full validation
      return {
        checkStructure: true,
        checkLighting: true,
        // The historical JS "face-lock embedding" is a text/hash proxy, not
        // a real visual face embedding. Identity is now validated visually by
        // Mistral against the actual candidate/reference images and used by the
        // authoritative LTX prompt compiler. Do not let the proxy destroy shots.
        checkFaceLock: false,
        checkPoseTracking: true,
        checkSceneGraph: true,
        checkDirectives: true,
      };
    case 'final':
      // Final pass: no validation (already validated in refine)
      return {
        checkStructure: false,
        checkLighting: false,
        checkFaceLock: false,
        checkPoseTracking: false,
        checkSceneGraph: false,
        checkDirectives: false,
      };
    default:
      return {
        checkStructure: true,
        checkLighting: false,
        checkFaceLock: false,
        checkPoseTracking: false,
        checkSceneGraph: false,
        checkDirectives: false,
      };
  }
}

// ── Main: apply hard control layers to all scenes ─────────────────────────────────

/**
 * Apply all four hard control layers to every scene in the script.
 * Attaches `_hard_control` to each shot with:
 *   - faceLock: reference embedding info
 *   - poseTrajectory: structured pose data
 *   - sceneGraph: spatial map reference
 *   - renderPass: initial pass = 'draft'
 *
 * @param {Object} script - Episode script (mutated in place)
 * @param {Array} characters - Character list for face-lock registry
 * @returns {{ script: Object, faceLockRegistry: Map, sceneGraphs: Map }}
 */
function applyHardControlLayers(script, characters) {
  if (!script || !script.scenes) return { script, faceLockRegistry: new Map(), sceneGraphs: new Map() };

  // 1. Build face-lock registry
  const faceLockRegistry = buildFaceLockRegistry(characters);

  // 2. Build pose trajectories and scene graphs per scene
  const sceneGraphs = new Map();
  let totalShots = 0;

  for (const scene of script.scenes) {
    // 2a. Pose trajectory
    const poseTrajectory = buildPoseTrajectory(scene);
    scene._pose_trajectory = poseTrajectory;

    // 2b. Scene graph
    const sceneGraph = buildSceneGraph(scene);
    sceneGraphs.set(scene.scene_number, sceneGraph);
    scene._scene_graph = sceneGraph;

    // 3. Attach hard control metadata to each shot
    for (const shot of (scene.shots || [])) {
      const chars = shot.characters_in_shot || [];

      // Face-lock info for each character in the shot
      const faceLockInfo = chars.map(charName => {
        const key = String(charName).toLowerCase();
        const ref = faceLockRegistry.get(key);
        return ref ? { character: charName, hasReference: true, anchor: ref.anchor } : { character: charName, hasReference: false };
      });

      // Pose info for each character
      const poseInfo = chars.map(charName => {
        const key = String(charName).toLowerCase();
        const traj = poseTrajectory.get(key);
        const entry = traj?.find(t => t.shotIndex === shot.shot_index);
        return entry ? { character: charName, pose: entry.pose, transition: entry.transition, isPossible: entry.isPossible } : null;
      }).filter(Boolean);

      shot._hard_control = {
        faceLock: faceLockInfo,
        poseTrajectory: poseInfo,
        sceneGraphRef: scene.scene_number,
        renderPass: 'draft',
      };

      shot._render_pass = 'draft';

      totalShots++;
    }
  }

  console.log(`[HardControl] Applied hard control layers to ${totalShots} shots across ${(script.scenes || []).length} scenes`);
  return { script, faceLockRegistry, sceneGraphs };
}

module.exports = {
  // Main entry
  applyHardControlLayers,
  // Face-lock
  buildFaceLockRegistry,
  validateFaceLock,
  FACE_LOCK_THRESHOLD,
  // Pose tracking
  buildPoseTrajectory,
  validatePoseTracking,
  // Scene graph
  buildSceneGraph,
  validateSceneGraph,
  // Multi-pass rendering
  RENDER_PASSES,
  getCurrentPass,
  advancePass,
  getPassValidationConfig,
  // Exported for testing
  _cosineSimilarity,
  _generateFaceEmbedding,
  _inferStructuredPose,
  _isPoseTransitionPossible,
};
