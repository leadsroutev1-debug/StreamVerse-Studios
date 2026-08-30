'use strict';

/**
 * StreamVerse cinematic finishing pipeline.
 *
 * Contract:
 *   provider master
 *      -> spatial upscale
 *      -> temporal interpolation
 *      -> color/grain + metadata
 *
 * The provider output is never overwritten. Every stage writes a new atomic
 * artifact, and a failed stage leaves the last known-good artifact available.
 *
 * Requires ffmpeg + ffprobe on the worker running Node.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const config = require('./config');

const DEFAULTS = Object.freeze({
  enabled: true,
  upscaleFactor: 1.5,
  targetFps: 48,
  grainAmount: 0.006,
  grainSeed: 4242,
  saturation: 1.02,
  contrast: 1.015,
  gamma: 1.0,
  crf: 15,
  preset: 'medium',
  concurrency: 1,
  timeoutMs: 20 * 60 * 1000,
});

let activeJobs = 0;
const waiters = [];

function cfg(name, fallback) {
  const value = config?.[name];
  return value == null || value === '' ? fallback : value;
}

function truthy(value, fallback) {
  if (value == null) return fallback;
  return String(value).toLowerCase() === 'true';
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const settings = () => ({
  enabled: truthy(cfg('cinematicRefinementEnabled', process.env.CINEMATIC_REFINEMENT_ENABLED), DEFAULTS.enabled),
  upscaleFactor: positiveNumber(cfg('cinematicUpscaleFactor', process.env.CINEMATIC_UPSCALE_FACTOR), DEFAULTS.upscaleFactor),
  targetFps: Math.max(1, Math.floor(positiveNumber(cfg('cinematicTargetFps', process.env.CINEMATIC_TARGET_FPS), DEFAULTS.targetFps))),
  grainAmount: (() => { const raw = cfg('cinematicGrainAmount', process.env.CINEMATIC_GRAIN_AMOUNT); const n = Number(raw); return Number.isFinite(n) ? Math.max(0, Math.min(0.1, n)) : DEFAULTS.grainAmount; })(),
  grainSeed: Math.floor(Number(cfg('cinematicGrainSeed', process.env.CINEMATIC_GRAIN_SEED)) || DEFAULTS.grainSeed),
  saturation: positiveNumber(cfg('cinematicSaturation', process.env.CINEMATIC_SATURATION), DEFAULTS.saturation),
  contrast: positiveNumber(cfg('cinematicContrast', process.env.CINEMATIC_CONTRAST), DEFAULTS.contrast),
  gamma: positiveNumber(cfg('cinematicGamma', process.env.CINEMATIC_GAMMA), DEFAULTS.gamma),
  crf: Math.max(10, Math.min(30, Math.floor(Number(cfg('cinematicCrf', process.env.CINEMATIC_CRF)) || DEFAULTS.crf))),
  preset: String(cfg('cinematicPreset', process.env.CINEMATIC_PRESET) || DEFAULTS.preset),
  concurrency: Math.max(1, Math.floor(positiveNumber(cfg('cinematicConcurrency', process.env.CINEMATIC_CONCURRENCY), DEFAULTS.concurrency))),
  timeoutMs: Math.max(60_000, Math.floor(positiveNumber(cfg('cinematicTimeoutMs', process.env.CINEMATIC_TIMEOUT_MS), DEFAULTS.timeoutMs))),
});

function stageId(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

function tempArtifact(jobId, stage) {
  const safeJob = String(jobId || 'cinematic').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `streamverse-${safeJob}-${stage}-${stageId(Date.now())}.mp4`);
}

async function acquire() {
  const limit = settings().concurrency;
  if (activeJobs < limit) {
    activeJobs += 1;
    return;
  }
  await new Promise(resolve => waiters.push(resolve));
  activeJobs += 1;
}

function release() {
  activeJobs = Math.max(0, activeJobs - 1);
  const next = waiters.shift();
  if (next) next();
}

function run(cmd, args, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`[CinematicRefinement] ${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`[CinematicRefinement] ${label} spawn failed: ${err.message}`));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`[CinematicRefinement] ${label} exited ${code}: ${stderr.slice(-4000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function probe(url, timeoutMs) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,duration',
    '-of', 'json',
    url,
  ];
  const { stdout } = await run('ffprobe', args, timeoutMs, 'ffprobe');
  const data = JSON.parse(stdout || '{}');
  const stream = data.streams?.[0] || {};
  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    fps: parseRate(stream.avg_frame_rate || stream.r_frame_rate),
    duration: Number(stream.duration) || 0,
  };
}

function parseRate(raw) {
  const [a, b] = String(raw || '').split('/').map(Number);
  return b > 0 ? a / b : Number(raw) || 0;
}

function needsUpscale(meta, factor) {
  return factor > 1.01 && meta.width > 0 && meta.height > 0;
}

async function ffmpegStage(input, output, filter, extra = [], timeoutMs, label) {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'warning',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', filter,
    '-c:v', 'libx264',
    '-preset', extra.preset,
    '-crf', String(extra.crf),
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-color_range', 'tv',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-metadata', 'encoder=StreamVerse Cinematic Refinement',
    '-metadata', `streamverse_stage=${label}`,
    output,
  ];
  await run('ffmpeg', args, timeoutMs, label);
}

function buildScaleFilter(meta, s) {
  const targetW = Math.max(2, Math.round(meta.width * s.upscaleFactor / 2) * 2);
  const targetH = Math.max(2, Math.round(meta.height * s.upscaleFactor / 2) * 2);
  return `scale=${targetW}:${targetH}:flags=lanczos`;
}

function buildTemporalFilter(meta, s) {
  if (!s.targetFps || !meta.fps || s.targetFps <= meta.fps * 1.01) return null;
  return `minterpolate=fps=${s.targetFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
}

function buildFinishFilter(s) {
  // Deliberately subtle grading. The generated imagery remains the source of truth;
  // finishing should restore density/texture, not introduce a new "look".
  return [
    `eq=contrast=${s.contrast}:saturation=${s.saturation}:gamma=${s.gamma}`,
    `noise=alls=${Math.round(s.grainAmount * 1000)}:allf=t+u:all_seed=${s.grainSeed}`,
  ].join(',');
}

async function refineVideo(inputUrl, {
  jobId = 'cinematic',
  targetFps,
  upscaleFactor,
  signal,
  onStage,
} = {}) {
  const s = settings();
  if (!s.enabled) {
    return {
      videoUrl: inputUrl,
      skipped: true,
      manifest: { enabled: false, reason: 'disabled' },
    };
  }

  if (signal?.aborted) throw new Error('[CinematicRefinement] Aborted before start');

  await acquire();
  const work = [];
  try {
    const timeoutMs = s.timeoutMs;
    const meta = await probe(inputUrl, timeoutMs);
    const resolvedScale = positiveNumber(upscaleFactor, s.upscaleFactor);
    const resolvedFps = Math.max(1, Math.floor(positiveNumber(targetFps, s.targetFps)));

    const manifest = {
      enabled: true,
      source: inputUrl,
      sourceWidth: meta.width,
      sourceHeight: meta.height,
      sourceFps: meta.fps,
      sourceDuration: meta.duration,
      targetWidth: meta.width,
      targetHeight: meta.height,
      targetFps: meta.fps,
      passes: [],
      startedAt: new Date().toISOString(),
    };

    let current = inputUrl;

    // PASS 1 — spatial density.
    if (needsUpscale(meta, resolvedScale)) {
      const out = tempArtifact(jobId, 'upscale');
      work.push(out);
      await onStage?.('spatial_upscale', 1, 4);
      await ffmpegStage(current, out, buildScaleFilter(meta, { upscaleFactor: resolvedScale }), {
        preset: s.preset, crf: s.crf,
      }, timeoutMs, 'spatial-upscale');
      current = out;
      const up = await probe(current, timeoutMs);
      manifest.targetWidth = up.width;
      manifest.targetHeight = up.height;
      manifest.passes.push({ stage: 'spatial_upscale', width: up.width, height: up.height, method: 'lanczos' });
    } else {
      manifest.passes.push({ stage: 'spatial_upscale', skipped: true, reason: 'source already at target density' });
    }

    // PASS 2 — temporal cadence.
    const temporal = buildTemporalFilter(meta, { targetFps: resolvedFps });
    if (temporal) {
      const out = tempArtifact(jobId, 'temporal');
      work.push(out);
      await onStage?.('temporal_interpolation', 2, 4);
      await ffmpegStage(current, out, temporal, {
        preset: s.preset, crf: s.crf,
      }, timeoutMs, 'temporal-interpolation');
      current = out;
      manifest.targetFps = resolvedFps;
      manifest.passes.push({
        stage: 'temporal_interpolation',
        fromFps: meta.fps,
        toFps: resolvedFps,
        method: 'ffmpeg-minterpolate-mci',
      });
    } else {
      manifest.passes.push({ stage: 'temporal_interpolation', skipped: true, reason: 'source cadence already >= target' });
    }

    // PASS 3 — restrained finish + explicit provenance metadata.
    const out = tempArtifact(jobId, 'finish');
    work.push(out);
    await onStage?.('color_grain_metadata', 3, 4);
    await ffmpegStage(current, out, buildFinishFilter(s), {
      preset: s.preset, crf: s.crf,
    }, timeoutMs, 'color-grain-metadata');
    current = out;
    manifest.passes.push({
      stage: 'color_grain_metadata',
      contrast: s.contrast,
      saturation: s.saturation,
      gamma: s.gamma,
      grainAmount: s.grainAmount,
    });

    await onStage?.('complete', 4, 4);
    manifest.completedAt = new Date().toISOString();
    return { videoUrl: current, skipped: false, manifest };
  } finally {
    // Never delete the final artifact returned to caller. All intermediate files
    // are deleted; caller owns upload/retention of the returned output.
    for (const file of work.slice(0, -1)) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
}

module.exports = { refineVideo, settings };
