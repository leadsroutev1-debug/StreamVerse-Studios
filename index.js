'use strict';
require('dotenv').config();

const express  = require('express');
const cron     = require('node-cron');
const path     = require('path');
const axios    = require('axios');

const config          = require('./src/config');
const db              = require('./src/db');
const state           = require('./src/state');
const pipeline        = require('./src/pipeline');
const agentOrchestrator = require('./src/agentOrchestrator');
const imageGen        = require('./src/imageGen');
const googleImageGen  = require('./src/googleImageGen');
const cloudinaryLib   = require('./src/cloudinary');
const scriptWriter    = require('./src/scriptWriter');
const ltxVideoGen     = require('./src/ltxVideoGen');
const telegramLib     = require('./src/telegram');
const streamGateway   = require('./src/streamGateway');
const auth            = require('./src/auth');
const mailer          = require('./src/mailer');
const { v4: uuidv4 }  = require('uuid');
const videoEngineClient = require('./services/videoEngineClient');
const { safeJsonParse } = require('./src/util');
const analytics = require('./src/analytics');
const agentDashboard = require('./src/agentDashboard');
const { searchCatalog } = require('./src/search');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Global CORS ──────────────────────────────────────────────────────────────
// No cookies/credentials are used by this API (auth is Bearer-token based),
// so a permissive origin does not expose session state. Still, when
// FRONTEND_URL is configured (production), only that origin — plus
// localhost for local development — is allowed, per deployment hardening.
function _resolveApiOrigin(req) {
  const allowed = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  const reqOrigin = req.headers.origin;
  if (!allowed) return '*';
  const devAllowed = reqOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(reqOrigin);
  if (reqOrigin && (reqOrigin === allowed || devAllowed)) return reqOrigin;
  return allowed;
}

app.use('/api/', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  _resolveApiOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Internal-Pipeline, Range');
  res.setHeader('Access-Control-Expose-Headers','Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ──────────────────────────────────────────────────────────────────────────────
// Dashboard
// ──────────────────────────────────────────────────────────────────────────────

app.get('/',          (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));

// ──────────────────────────────────────────────────────────────────────────────
// REST status snapshot
// ──────────────────────────────────────────────────────────────────────────────


// Agent observability — durable event log + live activity. This intentionally
// exposes recorded decisions/action summaries, never hidden chain-of-thought.
app.get('/api/agent/observability', async (req,res)=>{
  try {
    const data=await agentDashboard.getAgentObservability({
      storylineId:req.query.storyline_id||null,
      episodeId:req.query.episode_id||null,
      runId:req.query.run_id||null,
      limit:req.query.limit||200,
    });
    res.json(data);
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

app.post('/api/agent/memory/prune', async (req,res)=>{
  try {
    const data=await agentDashboard.pruneAgentMemory({
      storylineId:req.body?.storyline_id||null,
      episodeId:req.body?.episode_id||null,
      keepPriorityAtLeast:req.body?.keep_priority_at_least,
      olderThanDays:req.body?.older_than_days,
      dryRun:Boolean(req.body?.dry_run),
    });
    res.json(data);
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// AGENT_RESET_ENDPOINT_V1
app.post('/api/agent/memory/reset', async (req,res)=>{
  try {
    const confirmation = String(req.body?.confirmation || '').trim();
    if (confirmation !== 'RESET_AGENT_STATE') {
      return res.status(400).json({ ok:false, error:'Confirmation required: RESET_AGENT_STATE' });
    }
    const data = await agentDashboard.resetAgentState({
      storylineId:req.body?.storyline_id||null,
      episodeId:req.body?.episode_id||null,
      includeEvents:req.body?.include_events !== false,
      includeLlmCalls:req.body?.include_llm_calls !== false,
    });
    res.json(data);
  } catch(err) {
    console.error('[API /api/agent/memory/reset]', err.message);
    res.status(500).json({ok:false,error:err.message});
  }
});

app.get('/api/status', (req, res) => {
  const s = state.getState();
  s.keyHealth = config.keyHealth;
  res.json(s);
});

// ──────────────────────────────────────────────────────────────────────────────
// History — always reads from DB, not memory
// ──────────────────────────────────────────────────────────────────────────────

// Intelligent catalog search — keyword + synonym/intent relevance over the complete published catalog
app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query?.q || '').trim().slice(0, 180);
    if (!q) return res.json({ ok: true, query: '', episodes: [], shows: [] });
    const result = await searchCatalog(db, q, Math.min(50, Math.max(1, Number(req.query?.limit || 30))));
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[API /search]', err.message);
    res.status(500).json({ ok: false, error: 'Search could not be completed', episodes: [], shows: [] });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT e.id, e.storyline_id, e.episode_number, e.season_number, e.script, e.video_url, e.scene_state,
              e.facebook_video_link, e.status, e.posted_at, e.created_at,
              s.title AS show_title, s.genre, s.current_season,
              s.episode_count, s.status AS show_status
       FROM episodes e
       JOIN storylines s ON e.storyline_id = s.id
       WHERE e.video_url IS NOT NULL AND e.status = 'posted'
       ORDER BY COALESCE(e.posted_at, e.created_at) DESC
       LIMIT 1000`
    );
    const history = rows.map(r => {
      const sc = safeJsonParse(r.script, {});
      const sceneState = safeJsonParse(r.scene_state, {});
      const previewEntries = Object.entries(sceneState)
        .filter(([, url]) => typeof url === 'string' && url.trim())
        .sort(([a], [b]) => Number(a) - Number(b));
      const previewUrl = previewEntries[0]?.[1] || '';
      return {
        id:            r.id,
        showId:         r.storyline_id,
        seasonNumber:  r.season_number,
        episodeNumber: r.episode_number,
        title:         `${r.show_title} S${r.season_number}E${r.episode_number}`,
        episodeTitle:  sc.episode_title || '',
        showTitle:     r.show_title     || '',
        // Storage-provider-agnostic thumbnail field — derived server-side.
        // The frontend never receives the permanent Cloudinary video URL;
        // playback goes exclusively through the ad-gated streaming gateway.
        thumbnailUrl:  cloudinaryLib.videoThumbnailUrl(r.video_url) || '',
        previewUrl,
        facebookLink:  r.facebook_video_link || '',
        postedAt:      (r.posted_at || r.created_at) ? ((r.posted_at || r.created_at).toISOString?.() || String(r.posted_at || r.created_at)) : '',
        genre:         r.genre,
        synopsis:      sc.synopsis      || sc.logline || '',
        scenes:        Array.isArray(sc.scenes) ? sc.scenes.length : 0,
      };
    });

    // Active storylines summary
    const activeShows = await db.query(
      `SELECT s.id, s.title, s.genre, s.current_season, s.current_episode,
              s.episode_count, s.status,
              COUNT(CASE WHEN e.status='posted' AND e.video_url IS NOT NULL THEN 1 END) AS posted_episode_count,
              MAX(CASE WHEN e.status='posted' AND e.video_url IS NOT NULL THEN COALESCE(e.posted_at,e.created_at) END) AS last_posted_at
       FROM storylines s
       LEFT JOIN episodes e ON e.storyline_id = s.id
       GROUP BY s.id, s.title, s.genre, s.current_season, s.current_episode, s.episode_count, s.status
       ORDER BY last_posted_at DESC, s.updated_at DESC LIMIT 100`
    );

    res.json({ ok: true, history, activeShows });
  } catch (err) {
    console.error('[API /history]', err.message);
    res.json({ ok: false, error: err.message, history: [], activeShows: [] });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// SSE — real-time push to dashboard
// ──────────────────────────────────────────────────────────────────────────────

const sseClients = new Set();

app.get('/api/sse', (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const snap = state.getState();
  snap.keyHealth = config.keyHealth;
  res.write(`event: state\ndata: ${JSON.stringify(snap)}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

state.emitter.on('update', (s) => {
  s.keyHealth = config.keyHealth;
  const msg = `event: state\ndata: ${JSON.stringify(s)}\n\n`;
  for (const c of sseClients) { try { c.write(msg); } catch {} }
});

setInterval(() => {
  for (const c of sseClients) { try { c.write(': heartbeat\n\n'); } catch {} }
}, 25000);

// ──────────────────────────────────────────────────────────────────────────────
// Trigger endpoints
// ──────────────────────────────────────────────────────────────────────────────

app.post('/api/trigger', (req, res) => {
  const s = state.getState();
  if (s.status !== state.STATES.IDLE && s.status !== state.STATES.ERROR && s.status !== state.STATES.PAUSED) {
    return res.json({ ok: false, error: 'Pipeline already running' });
  }
  agentOrchestrator.runProductionAgent().catch(err =>
    console.error('[API] Autonomous production agent error:', err.message)
  );
  res.json({ ok: true, message: 'Pipeline started' });
});

// ──────────────────────────────────────────────────────────────────────────────
// Resume — explicit alias; trigger already handles PAUSED but this is clearer
// ──────────────────────────────────────────────────────────────────────────────

app.post('/api/resume', (req, res) => {
  const s = state.getState();
  if (s.status !== state.STATES.IDLE && s.status !== state.STATES.ERROR && s.status !== state.STATES.PAUSED) {
    return res.json({ ok: false, error: 'Pipeline already running' });
  }
  agentOrchestrator.runProductionAgent().catch(err =>
    console.error('[API] Autonomous production resume error:', err.message)
  );
  res.json({ ok: true, message: 'Resume triggered' });
});

// ──────────────────────────────────────────────────────────────────────────────
// Pause — request a graceful stop; pipeline honors it after the current shot
// ──────────────────────────────────────────────────────────────────────────────

app.post('/api/pause', (req, res) => {
  const result = pipeline.requestPause();
  res.json(result);
});

// ──────────────────────────────────────────────────────────────────────────────
// Drafts — list paused/partial episodes from DB
// ──────────────────────────────────────────────────────────────────────────────

app.get('/api/drafts', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT e.id, e.episode_number, e.season_number, e.paused_reason, e.created_at,
              e.scene_state, e.scene_count, e.shot_count,
              s.title AS show_title, s.genre
       FROM episodes e
       JOIN storylines s ON e.storyline_id = s.id
       WHERE e.status = 'draft'
       ORDER BY e.created_at DESC`
    );

    // Count done shots per draft from the shots table (the new system)
    // in one query, then join in JS.
    const draftIds = rows.map(r => r.id);
    let shotCountMap = {};
    if (draftIds.length) {
      const placeholders = draftIds.map(() => '?').join(',');
      const shotCounts = await db.query(
        `SELECT episode_id, COUNT(*) AS done_count
         FROM shots WHERE episode_id IN (${placeholders}) AND status = 'done'
         GROUP BY episode_id`,
        draftIds
      );
      for (const sc of shotCounts) shotCountMap[sc.episode_id] = sc.done_count;
    }

    const drafts = rows.map(r => {
      let sceneState = safeJsonParse(r.scene_state, {});
      return {
        id:             r.id,
        title:          `${r.show_title} S${r.season_number}E${r.episode_number}`,
        showTitle:      r.show_title,
        genre:          r.genre,
        pausedReason:   r.paused_reason || null,
        shotsGenerated: shotCountMap[r.id] || 0,
        shotsTotal:     r.shot_count || 0,
        scenesCompiled: Object.keys(sceneState).length,
        scenesTotal:    r.scene_count || 0,
        createdAt:      r.created_at ? (r.created_at.toISOString?.() || String(r.created_at)) : '',
      };
    });
    res.json({ ok: true, drafts });
  } catch (err) {
    console.error('[API /drafts]', err.message);
    res.json({ ok: false, error: err.message, drafts: [] });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Rendered shots — completed shot clips for the current draft, grouped by scene
// ──────────────────────────────────────────────────────────────────────────────

app.get('/api/drafts/shots', async (req, res) => {
  try {
    const draft = await db.queryOne(
      `SELECT e.id, e.episode_number, e.season_number, e.scene_state,
              s.title AS show_title, s.genre
       FROM episodes e
       JOIN storylines s ON e.storyline_id = s.id
       WHERE e.status = 'draft'
       ORDER BY e.created_at DESC LIMIT 1`
    );
    if (!draft) return res.json({ ok: true, scenes: [], episode: null });

    const shots = await db.query(
      `SELECT scene_number, shot_index, status, clip_url, clip_duration, image_url,
              last_error, last_prompt, failure_reason, enabled, trim_start, trim_end, editorial_url, edit_revision
       FROM shots
       WHERE episode_id = ? AND status IN ('done', 'failed', 'pending', 'mh_submitted')
       ORDER BY scene_number, shot_index`,
      [draft.id]
    );

    // Group shots by scene — done shots render as playable clips, everything
    // else (failed / still generating) is surfaced too so the dashboard can
    // highlight failures with a retry action instead of silently omitting
    // them from the grid.
    const sceneMap = new Map();
    for (const shot of shots) {
      if (!sceneMap.has(shot.scene_number)) sceneMap.set(shot.scene_number, []);
      sceneMap.get(shot.scene_number).push({
        shotIndex:      shot.shot_index,
        status:         shot.status,
        clipUrl:        shot.editorial_url || shot.clip_url,
        clipDuration:   shot.clip_duration,
        imageUrl:       shot.image_url || null,
        lastError:      shot.status === 'failed' ? shot.last_error : null,
        lastPrompt:     shot.status === 'failed' ? shot.last_prompt : null,
        failureReason:  shot.status === 'failed' ? shot.failure_reason : null,
        enabled:       Number(shot.enabled ?? 1) === 1,
        trimStart:     shot.trim_start ?? null,
        trimEnd:       shot.trim_end ?? null,
        editRevision:  shot.edit_revision ?? 0,
      });
    }

    // Include compiled scene URLs from scene_state JSON if available
    let compiledScenes = safeJsonParse(draft.scene_state, {});

    const scenes = [...sceneMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sceneNumber, sceneShots]) => ({
        sceneNumber,
        shots:       sceneShots,
        compiledUrl: compiledScenes[sceneNumber] || null,
      }));

    res.json({
      ok: true,
      scenes,
      episode: {
        id:    draft.id,
        title: `${draft.show_title} S${draft.season_number}E${draft.episode_number}`,
        genre: draft.genre,
      },
    });
  } catch (err) {
    console.error('[API /drafts/shots]', err.message);
    res.json({ ok: false, error: err.message, scenes: [] });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Test APIs — run all external service checks; streams results via SSE apiTest
// ──────────────────────────────────────────────────────────────────────────────

app.post('/api/test-apis', (req, res) => {
  const s = state.getState();
  if (s.apiTest?.running) return res.json({ ok: false, error: 'Tests already running' });
  _runApiTests().catch(err => console.error('[TestAPIs]', err.message));
  res.json({ ok: true, message: 'API tests started — watch SSE stream for results' });
});

async function _runApiTests() {
  const startedAt = new Date().toISOString();
  const results   = [];
  state.setApiTest({ running: true, results: [], startedAt });

  function push(name, status, message, latencyMs, extra = {}) {
    results.push({ name, status, message, latencyMs, ...extra });
    state.setApiTest({ running: true, results: [...results], startedAt });
    console.log(`[TestAPIs] ${name}: ${status} — ${message} (${latencyMs}ms)`);
  }

  // ── Helper: timed test wrapper ────────────────────────────────────────────
  async function timed(name, fn) {
    const t = Date.now();
    try {
      const extra = await fn();
      push(name, 'ok', 'OK', Date.now() - t, extra || {});
    } catch (err) {
      push(name, 'fail', err.message.slice(0, 200), Date.now() - t);
    }
  }

  // ── Run parallel tests ────────────────────────────────────────────────────
  let cfImageUrl         = null; // used by LTX Video test if Google upload fails
  let _googleTestImageUrl = null; // 1080×1920 Google image uploaded to Cloudinary for MH test
  let _testImageUrl      = null; // source image shown in dashboard media section

  await Promise.all([

    // Google Image Gen — calls googleImageGen directly (bypasses the router so a CF fallback
    // failure doesn't mask the real Google error).  Generates a cinematic 1080×1920 shot that
    // is then used as the LTX video test source (ensures the test is vertical + high-res).
    timed('Google Image Gen', async () => {
      if (!config.googleKeys.length) throw new Error('No Google keys configured (GOOGLE_KEYS)');
      const buf = await googleImageGen.generateImage(
        'Cinematic aerial shot of a glowing futuristic city skyline at night, neon-lit streets ' +
        'reflecting on rain-soaked roads, dramatic atmospheric lighting, ultra-detailed, ' +
        'photorealistic, sharp focus, 8K quality, 9:16 vertical portrait orientation',
        [],   // no reference images
        null, // no seed
        null  // no negative prompt
      );
      // Upload immediately to Cloudinary so MH video test can use the proper 1080×1920 image
      try {
        const mime = (buf[0] === 0xFF && buf[1] === 0xD8) ? 'image/jpeg' : 'image/png';
        _googleTestImageUrl = await cloudinaryLib.uploadImageFromUrl(
          `data:${mime};base64,${buf.toString('base64')}`,
          `streamverse/shots/tmp/api_test_google_${Date.now()}`
        );
      } catch (e) {
        console.warn('[TestAPIs] Google image Cloudinary upload failed:', e.message);
      }
      const sbCount = config.scrapingBeeKeys.length;
      const sbNote  = sbCount ? ` · ${sbCount} ScrapingBee proxy key${sbCount > 1 ? 's' : ''} available` : ' · no ScrapingBee keys (add SCRAPINGBEE_KEYS for proxy fallback)';
      return { detail: `${buf.length} bytes · direct Google${sbNote}` };
    }),

    // CF Worker — img2img test (send a reference image via multipart FormData)
    timed('CF Worker', async () => {
      const FormData = require('form-data');
      const cfKey    = config.getNextCfKey();
      const cfUrl    = config.cfWorkerUrls[0];
      if (!cfUrl) throw new Error('CF_WORKER_URL not configured');

      // Fetch a reference image to send as input_image_0
      const refResp = await axios.get(
        'https://res.cloudinary.com/fokksydp/image/upload/v1785321577/streamverse/logo/watermark_block.png',
        { responseType: 'arraybuffer', timeout: 20000 }
      );
      const refBuf = Buffer.from(refResp.data);

      const form = new FormData();
      form.append('prompt', 'a glowing test sphere, professional, photorealistic');
      form.append('input_image_0', refBuf, { filename: 'ref.png', contentType: 'image/png' });

      const resp = await axios.post(cfUrl, form, {
        headers: { ...form.getHeaders(), 'Authorization': `Bearer ${cfKey}` },
        responseType: 'arraybuffer',
        timeout: 90000,
      });

      const raw = Buffer.from(resp.data);
      // Detect JSON error response (worker returns { error: "…" } on failure)
      if (raw[0] === 0x7B) {
        let errMsg = raw.toString('utf8').slice(0, 400);
        try { errMsg = JSON.parse(errMsg).error || errMsg; } catch {}
        throw new Error(`❌ Not an image — ${errMsg}`);
      }
      if (raw.length < 100) throw new Error('CF Worker returned empty image');

      // Resize to 1080×1920 (9:16 vertical) before uploading for MH test.
      try {
        const sharp   = require('sharp');
        const resized = await sharp(raw)
          .resize(1080, 1920, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
          .png()
          .toBuffer();
        cfImageUrl = await cloudinaryLib.uploadImageFromUrl(
          `data:image/png;base64,${resized.toString('base64')}`,
          `streamverse/shots/tmp/api_test_${Date.now()}`
        );
      } catch (e) {
        console.warn('[TestAPIs] CF image resize/upload failed:', e.message);
      }
      return { detail: `${raw.length} bytes → resized to 1080×1920` };
    }),

    // Cloudinary — ping Admin API with Basic Auth (api_key:api_secret)
    timed('Cloudinary', async () => {
      const resp = await axios.get(
        `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/resources/image`,
        {
          auth:    { username: config.cloudinaryApiKey, password: config.cloudinaryApiSecret },
          params:  { max_results: 1 },
          timeout: 15000,
        }
      );
      const count = resp.data?.resources?.length ?? 0;
      return { detail: `cloud: ${config.cloudinaryCloudName} (${count} items)` };
    }),

    // Mistral — minimal LLM call
    timed('Mistral', async () => {
      const key = config.getNextMistralKey();
      const resp = await axios.post('https://api.mistral.ai/v1/chat/completions',
        { model: 'mistral-small-latest', messages: [{ role: 'user', content: 'Reply with one word: ready' }], max_tokens: 5 },
        { headers: { Authorization: `Bearer ${key}` }, timeout: 20000 }
      );
      const reply = resp.data?.choices?.[0]?.message?.content || '';
      return { detail: reply.slice(0, 50) };
    }),

    // Groq — minimal LLM call
    timed('Groq', async () => {
      const key = config.getNextGroqKey();
      const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions',
        { model: config.groqModel, messages: [{ role: 'user', content: 'Reply with one word: ready' }], max_tokens: 5 },
        { headers: { Authorization: `Bearer ${key}` }, timeout: 20000 }
      );
      const reply = resp.data?.choices?.[0]?.message?.content || '';
      return { detail: reply.slice(0, 50) };
    }),

    // FFmpeg service — health check
    timed('FFmpeg Service', async () => {
      const resp = await axios.get(`${config.ffmpegServiceUrl}/health`, { timeout: 30000 });
      return { detail: resp.data?.status || 'ok' };
    }),

    // Telegram — send test message
    timed('Telegram', async () => {
      await telegramLib.sendTelegram('🔬 StreamVerse API test — Telegram ✅');
      return {};
    }),

    // Discord Webhook — verify the webhook URL is reachable
    timed('Discord Webhook', async () => {
      const webhookUrl = config.discordWebhookUrl;
      if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL not configured');
      // Send a GET to the webhook URL — Discord returns basic webhook info on GET
      const resp = await axios.get(webhookUrl, { timeout: 10000 });
      return { detail: resp.data?.name || resp.data?.id || 'webhook reachable' };
    }),

    // Hugging Face — validate each token against the HF whoami API. These
    // tokens are what LTX-2.3 generation actually authenticates with, so a
    // failing token here is a failing video generation later.
    timed('Hugging Face Tokens', async () => {
      const keys = config.hfTokens;
      if (!keys.length) throw new Error('No Hugging Face tokens configured (HF_TOKENS)');
      const info = [];
      await Promise.all(keys.map(async (key) => {
        try {
          const resp = await axios.get('https://huggingface.co/api/whoami-v2',
            { headers: { Authorization: `Bearer ${key}` }, timeout: 15000 }
          );
          const data = resp.data || {};
          const name = data.name || data.email || '—';
          const plan = data.isPro ? 'PRO' : (data.type || 'user');
          // Store per-token identity info in keyHealth
          const masked = config.hfTokens.indexOf(key);
          if (config.keyHealth.hf[masked]) {
            config.keyHealth.hf[masked].email = name;
          }
          info.push({ name, plan });
        } catch (e) {
          const status = e.response?.status;
          if (status === 401) config.markKeyStatus('hf', key, 'exhausted');
          info.push({ error: e.message.slice(0, 80) });
        }
      }));
      return { detail: info.map(c => c.name ? `${c.name} (${c.plan})` : c.error).join(' | ') };
    }),

  ]);

  // ── LTX-2.3 video test — exercises the actual live Hugging Face Space ──────
  // Source priority: 1) Google-generated 1080×1920 image (best quality, correct aspect ratio)
  //                  2) CF Worker image  3) static Cloudinary fallback
  // Uses the SAME ltxVideoGen.submitVideoJob/pollVideoJob path as the real
  // pipeline (config.videoProvider === 'ltx'), so a pass here means the live
  // Space integration — upload, param order, duration cap, polling — is
  // genuinely production-ready, not just reachable.
  await timed('LTX Video', async () => {
    const imageUrl = _googleTestImageUrl
      || cfImageUrl
      || 'https://res.cloudinary.com/fokksydp/image/upload/v1785321577/streamverse/logo/watermark_block.png';
    _testImageUrl = imageUrl; // capture for dashboard display

    if (!config.hfTokens.length) throw new Error('No Hugging Face tokens configured (HF_TOKENS)');

    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const imageBuffer = Buffer.from(imgResp.data);

    // Keep the test short — clamp to the live Space's verified minimum so
    // the self-test doesn't burn a full ZeroGPU quota window.
    const testDuration = Math.min(config.ltxMaxDuration, Math.max(config.ltxMinDuration, 3));

    const { jobId, apiKey } = await ltxVideoGen.submitVideoJob(imageBuffer, {
      duration:    testDuration,
      videoPrompt: 'a glowing test sphere slowly rotating, professional, photorealistic, cinematic lighting',
      width:       config.ltxWidth,
      height:      config.ltxHeight,
      seed:        1234567,
    });
    if (!jobId) throw new Error('LTX submission returned no job/event id');

    const rawVideoUrl = await ltxVideoGen.pollVideoJob(jobId, apiKey);
    if (!rawVideoUrl) return { detail: `Job ${jobId} complete (no download URL)`, videoUrl: null };

    // ── Upload to Cloudinary so the dashboard can play it back ─────────────
    let videoUrl = rawVideoUrl;
    try {
      videoUrl = await cloudinaryLib.uploadVideoFromUrl(
        rawVideoUrl,
        `streamverse/shots/tmp/api_test_video_${Date.now()}`
      );
      console.log(`[TestAPIs] LTX test video uploaded: ${videoUrl}`);
    } catch (uploadErr) {
      console.warn('[TestAPIs] LTX video Cloudinary upload failed:', uploadErr.message);
    }

    return { detail: `Job ${jobId} complete (${testDuration}s)`, videoUrl };
  });

  const _ltxResult = results.find(r => r.name === 'LTX Video');
  state.setApiTest({
    running:      false,
    results:      [...results],
    startedAt,
    finishedAt:   new Date().toISOString(),
    testVideoUrl: _ltxResult?.videoUrl || null,
    testImageUrl: _testImageUrl || null,
  });
  console.log('[TestAPIs] All done.');
}

// Detect MIME type from buffer magic bytes (used in test + pipeline)
function _detectMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)                      return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10]=== 0x42 && buf[11]=== 0x50)  return 'image/webp';
  return 'image/png'; // safe fallback
}

// n8n migration webhook compatibility
app.post('/streamverse-run-episode', (req, res) => {
  const s = state.getState();
  if (s.status !== state.STATES.IDLE && s.status !== state.STATES.ERROR) {
    return res.json({ ok: false, error: 'Pipeline already running' });
  }
  agentOrchestrator.runProductionAgent().catch(() => {});
  res.json({ ok: true, message: 'Pipeline triggered via webhook' });
});

app.post('/api/trigger-engagement', async (req, res) => {
  pipeline.runEngagementPost().catch(err => console.error('[API] Engagement post error:', err.message));
  res.json({ ok: true, message: 'Engagement post pipeline started' });
});

// Clear test media (video + source image) from dashboard
app.delete('/api/test-video', (req, res) => {
  const s = state.getState();
  if (s.apiTest) {
    state.setApiTest({ ...s.apiTest, testVideoUrl: null, testImageUrl: null });
  }
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Manual recompile / regenerate — dashboard controls
// ──────────────────────────────────────────────────────────────────────────────

app.post('/api/recompile-all', async (req, res) => {
  try {
    const result = await pipeline.recompileAllScenes();
    res.json(result);
  } catch (err) {
    console.error('[API /recompile-all]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/recompile-scene/:sceneNumber', async (req, res) => {
  try {
    const sceneNumber = parseInt(req.params.sceneNumber, 10);
    if (Number.isNaN(sceneNumber)) return res.status(400).json({ ok: false, error: 'Invalid scene number' });
    const result = await pipeline.recompileScene(sceneNumber);
    res.json(result);
  } catch (err) {
    console.error('[API /recompile-scene]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/regenerate-scene/:sceneNumber', async (req, res) => {
  try {
    const sceneNumber = parseInt(req.params.sceneNumber, 10);
    if (Number.isNaN(sceneNumber)) return res.status(400).json({ ok: false, error: 'Invalid scene number' });
    const result = await pipeline.regenerateScene(sceneNumber);
    res.json(result);
  } catch (err) {
    console.error('[API /regenerate-scene]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/regenerate-shot/:sceneNumber/:shotIndex', async (req, res) => {
  try {
    const sceneNumber = parseInt(req.params.sceneNumber, 10);
    const shotIndex   = parseInt(req.params.shotIndex, 10);
    if (Number.isNaN(sceneNumber) || Number.isNaN(shotIndex)) {
      return res.status(400).json({ ok: false, error: 'Invalid scene/shot number' });
    }
    // Optional manual prompt edit — used by the dashboard's "edit & retry"
    // flow when a shot failed on a content-safety flag and the operator
    // wants to fix the wording themselves before retriggering generation.
    const promptOverride = typeof req.body?.promptOverride === 'string' && req.body.promptOverride.trim()
      ? req.body.promptOverride.trim()
      : undefined;
    // HIL shot editor (see views/dashboard.html "Edit Shot" modal):
    //   videoPromptOverride — literal hand-edited LTX video prompt, sent as-is
    //   duration            — hand-edited clip duration in seconds
    //   keepImage           — true = reuse the existing generated still and
    //                         only regenerate the video (skips the image call)
    const videoPromptOverride = typeof req.body?.videoPromptOverride === 'string' && req.body.videoPromptOverride.trim()
      ? req.body.videoPromptOverride.trim()
      : undefined;
    const duration = req.body?.duration != null && Number.isFinite(Number(req.body.duration))
      ? Number(req.body.duration)
      : undefined;
    const keepImage = req.body?.keepImage === true;
    const episodeId = typeof req.body?.episodeId === 'string' && req.body.episodeId ? req.body.episodeId : undefined;
    // regenerateShot() validates then queues the actual work in the
    // background and returns right away — it does NOT block until the shot
    // finishes generating, so this request (and every other dashboard
    // action) stays responsive while generation runs. Poll /api/drafts/shots
    // to see the shot's status move pending → mh_submitted → done/failed.
    const result = await pipeline.regenerateShot(sceneNumber, shotIndex, { promptOverride, videoPromptOverride, duration, keepImage, episodeId });
    res.json(result);
  } catch (err) {
    console.error('[API /regenerate-shot]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// HIL shot editor — fetch the current image/prompt/duration for one shot so
// the dashboard's "Edit Shot" modal can show/edit them before regenerating.
app.get('/api/shot-detail/:sceneNumber/:shotIndex', async (req, res) => {
  try {
    const sceneNumber = parseInt(req.params.sceneNumber, 10);
    const shotIndex   = parseInt(req.params.shotIndex, 10);
    if (Number.isNaN(sceneNumber) || Number.isNaN(shotIndex)) {
      return res.status(400).json({ ok: false, error: 'Invalid scene/shot number' });
    }
    const episodeId = typeof req.query?.episodeId === 'string' && req.query.episodeId ? req.query.episodeId : null;
    const result = await pipeline.getShotDetail(sceneNumber, shotIndex, episodeId);
    res.json(result);
  } catch (err) {
    console.error('[API /shot-detail]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// HIL editorial timeline — non-destructive Cloudinary trim/remove for a shot.
// The original generated clip remains intact; the episode timeline references
// the Cloudinary-derived editorial URL.
app.post('/api/shot-editor/:sceneNumber/:shotIndex', async (req, res) => {
  try {
    const sceneNumber = parseInt(req.params.sceneNumber, 10);
    const shotIndex = parseInt(req.params.shotIndex, 10);
    if (Number.isNaN(sceneNumber) || Number.isNaN(shotIndex)) {
      return res.status(400).json({ ok: false, error: 'Invalid scene/shot number' });
    }
    const result = await pipeline.editShotTimeline(sceneNumber, shotIndex, {
      episodeId: typeof req.body?.episodeId === 'string' ? req.body.episodeId : undefined,
      trimStart: req.body?.trimStart,
      trimEnd: req.body?.trimEnd,
      removed: req.body?.removed === true,
    });
    res.json(result);
  } catch (err) {
    console.error('[API /shot-editor]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Hugging Face token pool status — sticky/linear rotation state for the
// dashboard's token panel. Read-only; masks the actual token values.
// ──────────────────────────────────────────────────────────────────────────────

app.get('/api/hf-tokens', async (req, res) => {
  try {
    const tokens = await videoEngineClient.getTokenStatus();
    res.json({ ok: true, tokens });
  } catch (err) {
    console.error('[API /hf-tokens]', err.message);
    res.json({ ok: false, error: err.message, tokens: [] });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Episodes tab — list all episodes + purge-and-regenerate-videos-only action
// ──────────────────────────────────────────────────────────────────────────────

app.get('/api/episodes', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT e.id, e.storyline_id, e.episode_number, e.season_number, e.status, e.video_url, e.posted_at, e.created_at,
              s.title AS show_title, s.genre
       FROM episodes e
       JOIN storylines s ON e.storyline_id = s.id
       ORDER BY e.created_at DESC
       LIMIT 100`
    );
    const episodeIds = rows.map(r => r.id);
    let shotCounts = {};
    if (episodeIds.length) {
      const placeholders = episodeIds.map(() => '?').join(',');
      const shotRows = await db.query(
        `SELECT episode_id,
                COUNT(*) AS total,
                SUM(status = 'done') AS done,
                SUM(image_url IS NOT NULL AND image_url != '') AS with_image
         FROM shots WHERE episode_id IN (${placeholders}) GROUP BY episode_id`,
        episodeIds
      );
      shotCounts = Object.fromEntries(shotRows.map(r => [r.episode_id, r]));
    }
    const episodes = rows.map(r => {
      const counts = shotCounts[r.id] || { total: 0, done: 0, with_image: 0 };
      return {
        id:            r.id,
        showId:        r.storyline_id,
        showTitle:     r.show_title,
        seasonNumber:  r.season_number,
        episodeNumber: r.episode_number,
        title:         `${r.show_title} S${r.season_number}E${r.episode_number}`,
        genre:         r.genre,
        status:        r.status,
        videoUrl:      r.video_url || '',
        postedAt:      r.posted_at ? (r.posted_at.toISOString?.() || String(r.posted_at)) : '',
        createdAt:     r.created_at ? (r.created_at.toISOString?.() || String(r.created_at)) : '',
        shotsTotal:    Number(counts.total) || 0,
        shotsDone:     Number(counts.done) || 0,
        shotsWithImage: Number(counts.with_image) || 0,
      };
    });
    res.json({ ok: true, episodes });
  } catch (err) {
    console.error('[API /episodes]', err.message);
    res.status(500).json({ ok: false, error: err.message, episodes: [] });
  }
});

app.post('/api/episodes/:id/regenerate-videos', async (req, res) => {
  try {
    const result = await pipeline.regenerateEpisodeVideos(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('[API /episodes/:id/regenerate-videos]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/episodes/:id/publish', async (req, res) => {
  try {
    const result = await pipeline.publishEpisode(req.params.id);
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    console.error('[API /episodes/:id/publish]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/episodes/:id/editor', async (req, res) => {
  try {
    const episode = await db.queryOne(
      `SELECT e.id, e.episode_number, e.season_number, e.status, e.video_url, e.script, e.scene_state,
              s.title AS show_title, s.genre
       FROM episodes e JOIN storylines s ON e.storyline_id = s.id WHERE e.id = ?`,
      [req.params.id]
    );
    if (!episode) return res.status(404).json({ ok: false, error: 'Episode not found' });
    const shots = await db.query(
      `SELECT scene_number, shot_index, status, clip_url, clip_duration, image_url, last_error, last_prompt,
              failure_reason, enabled, trim_start, trim_end, editorial_url, edit_revision,
              image_prompt_override, video_prompt_override, duration_override
       FROM shots WHERE episode_id = ? ORDER BY scene_number, shot_index`,
      [episode.id]
    );
    const script = safeJsonParse(episode.script, {});
    const sceneState = safeJsonParse(episode.scene_state, {});
    const sceneMap = new Map();
    for (const row of shots) {
      if (!sceneMap.has(row.scene_number)) sceneMap.set(row.scene_number, []);
      sceneMap.get(row.scene_number).push({
        shotIndex: row.shot_index, status: row.status, imageUrl: row.image_url || null,
        clipUrl: row.editorial_url || row.clip_url || null, originalClipUrl: row.clip_url || null,
        clipDuration: row.clip_duration, lastError: row.last_error || null,
        failureReason: row.failure_reason || null, enabled: Number(row.enabled ?? 1) === 1,
        trimStart: row.trim_start ?? null, trimEnd: row.trim_end ?? null, editRevision: row.edit_revision ?? 0,
      });
    }
    const scenes = (script.scenes || []).slice().sort((a,b) => a.scene_number - b.scene_number).map(sc => ({
      sceneNumber: sc.scene_number, title: sc.title || sc.scene_title || `Scene ${sc.scene_number}`,
      description: sc.scene_description || '', shots: sceneMap.get(sc.scene_number) || [],
      compiledUrl: sceneState[sc.scene_number] || null,
    }));
    res.json({ ok: true, episode: { id: episode.id, title: `${episode.show_title} S${episode.season_number}E${episode.episode_number}`,
      showTitle: episode.show_title, genre: episode.genre, status: episode.status, videoUrl: episode.video_url || '',
      scenes } });
  } catch (err) {
    console.error('[API /episodes/:id/editor]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/episodes/:id/recompile', async (req, res) => {
  try {
    const result = await pipeline.recompileEpisode(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('[API /episodes/:id/recompile]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, status: state.getState().status, ts: new Date().toISOString() });
});

// ──────────────────────────────────────────────────────────────────────────────
// Ad-as-Auth Streaming Gateway
// External traffic → HilltopAds VAST ad → token → backend-proxied video stream
// Internal pipeline → bypass header → direct video URL
// ──────────────────────────────────────────────────────────────────────────────

app.options('/api/episodes/:id/stream',    streamGateway.handleOptions);
app.get('/api/episodes/:id/stream',        auth.requireAuth, streamGateway.handleStream);
app.options('/api/episodes/:id/vast',      streamGateway.handleOptions);
app.get('/api/episodes/:id/vast',          streamGateway.handleVastProxy);
app.options('/api/episodes/:id/ad-complete', streamGateway.handleOptions);
app.post('/api/episodes/:id/ad-complete',  auth.requireAuth, streamGateway.handleAdComplete);
app.options('/api/episodes/:id/video',     streamGateway.handleOptions);
app.get(
  '/api/episodes/:id/video',
  async (req, res, next) => {
    try {
      return await streamGateway.handleVideoStream(req, res, next);
    } catch (err) {
      console.error(
        '[StreamGateway] /video route adapter error:',
        err?.message || err
      );
      return next(err);
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// Auth — email/password registration with email verification (Brevo/SMTP)
// ──────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function _publicUser(u) {
  return { id: u.id, email: u.email, displayName: u.display_name || null, emailVerified: !!u.email_verified };
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const email    = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const displayName = req.body?.displayName ? String(req.body.displayName).trim().slice(0, 120) : null;

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid email address' });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
    }

    const existing = await db.queryOne(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'An account with that email already exists' });
    }

    const { hash, salt } = auth.hashPassword(password);
    const userId       = uuidv4();
    const verifyToken   = auth.randomToken();
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.execute(
      `INSERT INTO users (id, email, password_hash, password_salt, display_name, email_verified, verify_token, verify_token_expires)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [userId, email, hash, salt, displayName, verifyToken, verifyExpires]
    );

    const frontendUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '';
    const verifyUrl   = `${frontendUrl.replace(/\/$/, '')}/verify?token=${verifyToken}`;

    try {
      const { subject, html, text } = mailer.verificationEmail({ verifyUrl });
      await mailer.sendMail({ to: email, subject, html, text });
    } catch (mailErr) {
      console.error('[Auth] Verification email failed to send:', mailErr.message);
      // Account is still created — user can request the link again later.
      return res.json({
        ok: true,
        warning: 'Account created, but the verification email could not be sent. Contact support or try resending it.',
      });
    }

    res.json({ ok: true, message: 'Account created. Check your email to verify your address.' });
  } catch (err) {
    console.error('[API /auth/register]', err.message);
    res.status(500).json({ ok: false, error: 'Registration failed' });
  }
});

app.get('/api/auth/verify', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).json({ ok: false, error: 'Missing verification token' });

    const user = await db.queryOne(
      `SELECT * FROM users WHERE verify_token = ? LIMIT 1`,
      [token]
    );
    if (!user) return res.status(400).json({ ok: false, error: 'Invalid or already-used verification link' });
    if (user.verify_token_expires && new Date(user.verify_token_expires) < new Date()) {
      return res.status(400).json({ ok: false, error: 'Verification link expired — please register again or request a new link' });
    }

    await db.execute(
      `UPDATE users SET email_verified = 1, verify_token = NULL, verify_token_expires = NULL WHERE id = ?`,
      [user.id]
    );

    const frontendUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '';
    try {
      const { subject, html, text } = mailer.welcomeEmail({ appUrl: frontendUrl || '/' });
      await mailer.sendMail({ to: user.email, subject, html, text });
    } catch (e) {
      console.warn('[Auth] Welcome email failed (non-fatal):', e.message);
    }

    res.json({ ok: true, message: 'Email verified — you can now sign in.' });
  } catch (err) {
    console.error('[API /auth/verify]', err.message);
    res.status(500).json({ ok: false, error: 'Verification failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email    = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    const user = await db.queryOne(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user || !auth.verifyPassword(password, user.password_hash, user.password_salt)) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password' });
    }
    if (!user.is_active) {
      return res.status(403).json({ ok: false, error: 'This account is currently disabled' });
    }
    if (!user.email_verified) {
      return res.status(403).json({ ok: false, error: 'Please verify your email before signing in', unverified: true });
    }

    await db.execute(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [user.id]);

    const token = auth.createSessionToken(user);
    res.json({ ok: true, token, user: _publicUser(user) });
  } catch (err) {
    console.error('[API /auth/login]', err.message);
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

app.get('/api/auth/me', auth.requireAuth, async (req, res) => {
  try {
    const user = await db.queryOne(`SELECT * FROM users WHERE id = ?`, [req.user.sub]);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, user: _publicUser(user) });
  } catch (err) {
    console.error('[API /auth/me]', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load account' });
  }
});

// Session tokens are stateless (signed, expiring) — "logout" is a client-side
// action (discard the token). This endpoint exists for a consistent API and
// as a hook if server-side token revocation is added later.
app.post('/api/auth/logout', (req, res) => res.json({ ok: true }));


// ──────────────────────────────────────────────────────────────────────────────
// User account library — profile, watch progress, favourites and announcements
// ──────────────────────────────────────────────────────────────────────────────

function _accountEpisodeRow(r) {
  const script = safeJsonParse(r.script, {});
  return {
    id: r.id,
    title: r.show_title || '',
    episodeTitle: script.episode_title || `Season ${r.season_number} · Episode ${r.episode_number}`,
    synopsis: script.synopsis || script.logline || '',
    thumbnailUrl: cloudinaryLib.videoThumbnailUrl(r.video_url) || '',
    seasonNumber: r.season_number,
    episodeNumber: r.episode_number,
    progressSeconds: Number(r.position_sec || 0),
    durationSeconds: Number(r.duration_sec || 0),
    completed: !!r.completed,
    updatedAt: r.updated_at,
    addedAt: r.added_at,
  };
}

app.get('/api/account/dashboard', auth.requireAuth, async (req, res) => {
  try {
    const [announcements, favorites, progress, history] = await Promise.all([
      db.query(`
        SELECT a.id, a.title, a.body, a.published_at, ar.read_at
        FROM announcements a
        LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = ?
        WHERE a.published_at IS NOT NULL AND (a.audience = 'all')
        ORDER BY a.published_at DESC LIMIT 8`, [req.user.sub]),
      db.query(`
        SELECT e.id, e.season_number, e.episode_number, e.script, e.video_url, s.title AS show_title, f.created_at AS added_at
        FROM user_favorites f JOIN episodes e ON e.id = f.episode_id JOIN storylines s ON s.id = e.storyline_id
        WHERE f.user_id = ? AND e.status = 'posted' AND e.video_url IS NOT NULL
        ORDER BY f.created_at DESC LIMIT 30`, [req.user.sub]),
      db.query(`
        SELECT p.episode_id AS id, p.position_sec, p.duration_sec, p.completed, p.updated_at,
               e.season_number, e.episode_number, e.script, e.video_url, s.title AS show_title
        FROM user_watch_progress p JOIN episodes e ON e.id = p.episode_id JOIN storylines s ON s.id = e.storyline_id
        WHERE p.user_id = ? AND e.status = 'posted' AND e.video_url IS NOT NULL
        ORDER BY p.updated_at DESC LIMIT 20`, [req.user.sub]),
      db.query(`
        SELECT p.episode_id AS id, p.position_sec, p.duration_sec, p.completed, p.updated_at AS created_at,
               e.season_number, e.episode_number, e.script, e.video_url, s.title AS show_title
        FROM user_watch_progress p JOIN episodes e ON e.id=p.episode_id JOIN storylines s ON s.id=e.storyline_id
        WHERE p.user_id=? AND e.status='posted' AND e.video_url IS NOT NULL
        ORDER BY p.updated_at DESC LIMIT 30`, [req.user.sub]),
    ]);

    const stats = await db.queryOne(`
      SELECT COUNT(DISTINCT episode_id) AS unique_episodes,
             COALESCE(SUM(CASE WHEN event_type = 'video_progress' THEN duration_seconds ELSE 0 END),0) AS watch_seconds,
             COUNT(DISTINCT CASE WHEN event_type = 'video_complete' THEN episode_id END) AS completed_episodes
      FROM analytics_events WHERE user_id = ?`, [req.user.sub]);

    res.json({
      ok: true,
      announcements,
      favorites: favorites.map(_accountEpisodeRow),
      continueWatching: progress.filter(p => !p.completed).map(_accountEpisodeRow),
      progress: progress.map(_accountEpisodeRow),
      history: history.map(_accountEpisodeRow),
      stats: {
        uniqueEpisodes: Number(stats?.unique_episodes || 0),
        watchSeconds: Number(stats?.watch_seconds || 0),
        completedEpisodes: Number(stats?.completed_episodes || 0),
      },
    });
  } catch (err) {
    console.error('[API /account/dashboard]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load account dashboard' });
  }
});

app.put('/api/account/profile', auth.requireAuth, async (req, res) => {
  try {
    const displayName = req.body?.displayName == null ? null : String(req.body.displayName).trim().slice(0, 120);
    if (displayName && displayName.length < 2) return res.status(400).json({ ok: false, error: 'Display name is too short' });
    await db.execute(`UPDATE users SET display_name = ? WHERE id = ?`, [displayName || null, req.user.sub]);
    const user = await db.queryOne(`SELECT id, email, display_name, email_verified FROM users WHERE id = ?`, [req.user.sub]);
    res.json({ ok: true, user: _publicUser(user) });
  } catch (err) {
    console.error('[API /account/profile]', err.message);
    res.status(500).json({ ok: false, error: 'Could not update profile' });
  }
});

app.put('/api/account/password', auth.requireAuth, async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 8) return res.status(400).json({ ok: false, error: 'New password must be at least 8 characters' });
    const user = await db.queryOne(`SELECT password_hash, password_salt FROM users WHERE id = ?`, [req.user.sub]);
    if (!user || !auth.verifyPassword(currentPassword, user.password_hash, user.password_salt)) {
      return res.status(401).json({ ok: false, error: 'Current password is incorrect' });
    }
    const { hash, salt } = auth.hashPassword(newPassword);
    await db.execute(`UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?`, [hash, salt, req.user.sub]);
    res.json({ ok: true, message: 'Password updated' });
  } catch (err) {
    console.error('[API /account/password]', err.message);
    res.status(500).json({ ok: false, error: 'Could not update password' });
  }
});


app.put('/api/account/progress', auth.requireAuth, async (req, res) => {
  try {
    const episodeId = String(req.body?.episodeId || '').trim();
    const positionSec = Math.max(0, Math.min(86400, Number(req.body?.positionSeconds || 0)));
    const durationSec = Math.max(0, Math.min(86400, Number(req.body?.durationSeconds || 0)));
    const completed = !!req.body?.completed;
    if (!episodeId) return res.status(400).json({ ok:false, error:'Episode ID is required' });
    const episode = await db.queryOne(`SELECT id FROM episodes WHERE id=? AND status='posted' AND video_url IS NOT NULL`, [episodeId]);
    if (!episode) return res.status(404).json({ ok:false, error:'Episode not found' });
    await db.execute(`
      INSERT INTO user_watch_progress (user_id,episode_id,position_sec,duration_sec,completed)
      VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE position_sec=VALUES(position_sec), duration_sec=GREATEST(duration_sec,VALUES(duration_sec)), completed=GREATEST(completed,VALUES(completed)), updated_at=NOW()
    `, [req.user.sub,episodeId,positionSec,durationSec,completed ? 1 : 0]);
    res.json({ok:true});
  } catch(err) {
    console.error('[API /account/progress]',err.message);
    res.status(500).json({ok:false,error:'Could not save watch progress'});
  }
});

app.get('/api/account/favorites', auth.requireAuth, async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT f.episode_id AS episodeId, f.created_at AS addedAt
      FROM user_favorites f
      JOIN episodes e ON e.id = f.episode_id
      WHERE f.user_id = ? AND e.status='posted' AND e.video_url IS NOT NULL
      ORDER BY f.created_at DESC
    `, [req.user.sub]);
    res.json({ ok: true, favorites: rows });
  } catch (err) {
    console.error('[API /account/favorites GET]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load saved episodes', favorites: [] });
  }
});

app.post('/api/account/favorites/:episodeId', auth.requireAuth, async (req, res) => {
  try {
    const episodeId = String(req.params.episodeId || '').trim();
    if (!episodeId) return res.status(400).json({ ok: false, error: 'Episode ID is required' });
    const episode = await db.queryOne(`SELECT id FROM episodes WHERE id = ? AND status = 'posted' AND video_url IS NOT NULL`, [episodeId]);
    if (!episode) return res.status(404).json({ ok: false, error: 'Episode not found' });
    await db.execute(`INSERT IGNORE INTO user_favorites (user_id, episode_id) VALUES (?, ?)`, [req.user.sub, episodeId]);
    res.json({ ok: true, favorite: true });
  } catch (err) {
    console.error('[API /account/favorites POST]', err.message);
    res.status(500).json({ ok: false, error: 'Could not save favourite' });
  }
});

app.delete('/api/account/favorites/:episodeId', auth.requireAuth, async (req, res) => {
  try {
    await db.execute(`DELETE FROM user_favorites WHERE user_id = ? AND episode_id = ?`, [req.user.sub, req.params.episodeId]);
    res.json({ ok: true, favorite: false });
  } catch (err) {
    console.error('[API /account/favorites DELETE]', err.message);
    res.status(500).json({ ok: false, error: 'Could not remove favourite' });
  }
});

app.post('/api/account/announcements/:id/read', auth.requireAuth, async (req, res) => {
  try {
    await db.execute(`INSERT INTO announcement_reads (announcement_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE read_at = NOW()`, [req.params.id, req.user.sub]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[API /account/announcements/read]', err.message);
    res.status(500).json({ ok: false, error: 'Could not mark announcement as read' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Anonymous analytics ingestion — only active after visitor consent in browser
// ──────────────────────────────────────────────────────────────────────────────

app.post('/api/analytics/track', async (req, res) => {
  try {
    const event = analytics.normalizeEvent(req.body || {});
    const browser = analytics.normalizeBrowser(req.body?.browser || {});
    const ua = analytics.parseUserAgent(req.headers['user-agent'] || '');
    const geo = analytics.geoFromRequest(req, browser);
    const userId = analytics.optionalUserId(auth, req);
    const ipHash = analytics.hashIp(analytics.getClientIp(req));

    await db.execute(`
      INSERT INTO analytics_visitors
        (visitor_id,user_id,first_seen_at,last_seen_at,country_code,country_name,region_name,city_name,continent,geo_source,timezone,language,browser,operating_system,device_type,user_agent,platform,screen_width,screen_height,viewport_width,viewport_height,device_memory,hardware_cores,ip_hash,referrer)
      VALUES (?,?,NOW(),NOW(),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        user_id=COALESCE(VALUES(user_id),user_id), last_seen_at=NOW(),
        country_code=COALESCE(VALUES(country_code),country_code), country_name=COALESCE(VALUES(country_name),country_name),
        region_name=COALESCE(VALUES(region_name),region_name), city_name=COALESCE(VALUES(city_name),city_name), continent=COALESCE(VALUES(continent),continent),
        geo_source=COALESCE(VALUES(geo_source),geo_source), timezone=COALESCE(VALUES(timezone),timezone), language=COALESCE(VALUES(language),language),
        browser=COALESCE(VALUES(browser),browser), operating_system=COALESCE(VALUES(operating_system),operating_system), device_type=COALESCE(VALUES(device_type),device_type),
        user_agent=COALESCE(VALUES(user_agent),user_agent), platform=COALESCE(VALUES(platform),platform), screen_width=COALESCE(VALUES(screen_width),screen_width),
        screen_height=COALESCE(VALUES(screen_height),screen_height), viewport_width=COALESCE(VALUES(viewport_width),viewport_width), viewport_height=COALESCE(VALUES(viewport_height),viewport_height),
        device_memory=COALESCE(VALUES(device_memory),device_memory), hardware_cores=COALESCE(VALUES(hardware_cores),hardware_cores), ip_hash=COALESCE(VALUES(ip_hash),ip_hash),
        referrer=COALESCE(VALUES(referrer),referrer)
    `, [event.visitorId,userId,geo.countryCode,geo.countryName,geo.region,geo.city,geo.continent,geo.geoSource,browser.timezone,browser.language,ua.browser,ua.os,ua.deviceType,ua.userAgent,browser.platform,browser.screenWidth,browser.screenHeight,browser.viewportWidth,browser.viewportHeight,browser.deviceMemory,browser.hardwareConcurrency,ipHash,event.referrer]);

    await db.execute(`
      INSERT INTO analytics_sessions (session_id,visitor_id,user_id,started_at,last_seen_at,country_code)
      VALUES (?, ?, ?, NOW(), NOW(), ?)
      ON DUPLICATE KEY UPDATE user_id=COALESCE(VALUES(user_id),user_id), last_seen_at=NOW(), country_code=COALESCE(VALUES(country_code),country_code)
    `, [event.sessionId,event.visitorId,userId,geo.countryCode]);

    await db.execute(`
      INSERT INTO analytics_events
        (visitor_id,session_id,user_id,event_type,path,referrer,episode_id,video_seconds,duration_seconds,country_code,device_type,browser,operating_system,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [event.visitorId,event.sessionId,userId,event.eventType,event.path,event.referrer,event.episodeId,event.videoSeconds,event.durationSeconds,geo.countryCode,ua.deviceType,ua.browser,ua.os,event.metadata]);

    if (event.eventType === 'page_view') {
      await db.execute(`UPDATE analytics_sessions SET page_count = page_count + 1, last_seen_at = NOW() WHERE session_id = ?`, [event.sessionId]);
    } else if (event.eventType === 'video_start') {
      await db.execute(`UPDATE analytics_sessions SET video_count = video_count + 1, last_seen_at = NOW() WHERE session_id = ?`, [event.sessionId]);
    } else if (event.eventType === 'video_progress' || event.eventType === 'heartbeat') {
      await db.execute(`UPDATE analytics_sessions SET watch_seconds = watch_seconds + ?, last_seen_at = NOW() WHERE session_id = ?`, [event.eventType === 'video_progress' ? event.durationSeconds : 0, event.sessionId]);
      if (userId && event.eventType === 'video_progress' && event.episodeId) {
        await db.execute(`
          INSERT INTO user_watch_progress (user_id,episode_id,position_sec,duration_sec,completed)
          VALUES (?,?,?,?,0)
          ON DUPLICATE KEY UPDATE position_sec=VALUES(position_sec), duration_sec=GREATEST(duration_sec, VALUES(duration_sec))
        `, [userId,event.episodeId,event.videoSeconds || 0,event.videoDuration || 0]);
      }
    } else if (event.eventType === 'video_complete' && userId && event.episodeId) {
      await db.execute(`UPDATE user_watch_progress SET completed=1, position_sec=GREATEST(position_sec, duration_sec), updated_at=NOW() WHERE user_id=? AND episode_id=?`, [userId,event.episodeId]);
    } else if (event.eventType === 'session_end') {
      await db.execute(`UPDATE analytics_sessions SET ended_at=NOW(), last_seen_at=NOW() WHERE session_id = ?`, [event.sessionId]);
    }

    res.json({ ok: true });
  } catch (err) {
    if (/Unsupported analytics|identifiers are required/.test(err.message)) return res.status(400).json({ ok: false, error: err.message });
    console.error('[API /analytics/track]', err.message);
    res.status(500).json({ ok: false, error: 'Analytics event could not be recorded' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Admin dashboard authentication and management APIs
// ──────────────────────────────────────────────────────────────────────────────

function _adminPasswordConfigured() {
  return process.env.DASHBOARD_ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD_HASH || '';
}

function _checkAdminPassword(password) {
  const configured = _adminPasswordConfigured();
  if (!configured || !password) return false;
  const candidate = crypto.createHash('sha256').update(String(password)).digest('hex');
  try {
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(configured, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

app.post('/api/admin/login', (req, res) => {
  if (!_adminPasswordConfigured()) return res.status(503).json({ ok: false, error: 'Dashboard admin password hash is not configured' });
  if (!_checkAdminPassword(req.body?.password)) return res.status(401).json({ ok: false, error: 'Incorrect admin password' });
  res.json({ ok: true, token: auth.createAdminSessionToken() });
});

app.get('/api/admin/session', auth.requireAdmin, (req, res) => res.json({ ok: true, role: 'admin' }));

app.get('/api/admin/analytics', auth.requireAdmin, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const requestedPageSize = Number(req.query.pageSize);
    const pageSize = Number.isFinite(requestedPageSize)
      ? Math.min(20, Math.max(1, Math.floor(requestedPageSize)))
      : 20;
    const requestedPage = Number(req.query.page);
    const page = Number.isFinite(requestedPage)
      ? Math.max(1, Math.floor(requestedPage))
      : 1;
    const offset = (page - 1) * pageSize;
    const since = new Date(Date.now() - days * 86400000);

    const [summary, countries, videos, paths, devices, requests] = await Promise.all([
      db.queryOne(`
        SELECT COUNT(DISTINCT ae.visitor_id) visitors, COUNT(DISTINCT ae.session_id) sessions,
               COUNT(*) requests,
               COUNT(DISTINCT CASE WHEN ae.event_type='video_start' THEN CONCAT(ae.visitor_id,':',ae.episode_id) END) video_views,
               COALESCE(SUM(CASE WHEN ae.event_type='video_progress' THEN ae.duration_seconds ELSE 0 END),0) watch_seconds,
               COALESCE(AVG(CASE WHEN ae.event_type='video_progress' THEN ae.video_seconds END),0) avg_video_position,
               (SELECT COALESCE(AVG(TIMESTAMPDIFF(SECOND, started_at, COALESCE(ended_at,last_seen_at))),0) FROM analytics_sessions WHERE started_at >= ? AND last_seen_at >= ?) avg_session_seconds
        FROM analytics_events ae WHERE ae.created_at >= ?`, [since, since, since]),
      db.query(`
        SELECT COALESCE(country_code,'ZZ') country_code, COALESCE(MAX(country_code),'ZZ') code,
               COUNT(DISTINCT visitor_id) visitors, COUNT(DISTINCT session_id) sessions, COUNT(*) requests,
               COALESCE(SUM(CASE WHEN event_type='video_progress' THEN duration_seconds ELSE 0 END),0) watch_seconds,
               MAX(created_at) last_seen
        FROM analytics_events WHERE created_at >= ? GROUP BY COALESCE(country_code,'ZZ')
        ORDER BY visitors DESC, requests DESC LIMIT 100`, [since]),
      db.query(`
        SELECT ae.episode_id, s.title AS show_title, e.season_number, e.episode_number,
               COUNT(DISTINCT CASE WHEN ae.event_type='video_start' THEN ae.visitor_id END) unique_viewers,
               COUNT(CASE WHEN ae.event_type='video_start' THEN 1 END) starts,
               COUNT(CASE WHEN ae.event_type='video_complete' THEN 1 END) completions,
               COALESCE(SUM(CASE WHEN ae.event_type='video_progress' THEN ae.duration_seconds ELSE 0 END),0) watch_seconds,
               MAX(ae.created_at) last_watched
        FROM analytics_events ae LEFT JOIN episodes e ON e.id = ae.episode_id LEFT JOIN storylines s ON s.id = e.storyline_id
        WHERE ae.created_at >= ? AND ae.episode_id IS NOT NULL
        GROUP BY ae.episode_id, s.title, e.season_number, e.episode_number
        ORDER BY watch_seconds DESC, starts DESC LIMIT 100`, [since]),
      db.query(`
        SELECT path, COUNT(*) requests, COUNT(DISTINCT visitor_id) visitors
        FROM analytics_events WHERE created_at >= ? GROUP BY path ORDER BY requests DESC LIMIT 50`, [since]),
      db.query(`
        SELECT COALESCE(device_type,'unknown') device_type, COALESCE(browser,'unknown') browser,
               COALESCE(operating_system,'unknown') operating_system, COUNT(DISTINCT visitor_id) visitors, COUNT(*) requests
        FROM analytics_events WHERE created_at >= ? GROUP BY device_type,browser,operating_system ORDER BY visitors DESC LIMIT 50`, [since]),
      db.query(`
        SELECT id, created_at, event_type, path, episode_id, visitor_id, session_id, user_id,
               COALESCE(country_code,'ZZ') country_code, device_type, browser, operating_system, video_seconds, duration_seconds, metadata
         FROM analytics_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, [since]),
    ]);

    const shows = await db.query(`
      SELECT COALESCE(s.id,'unknown') AS show_id, COALESCE(s.title,'Unknown Show') AS show_title,
             COUNT(DISTINCT CASE WHEN ae.event_type='video_start' THEN ae.visitor_id END) unique_viewers,
             COUNT(CASE WHEN ae.event_type='video_start' THEN 1 END) starts,
             COUNT(CASE WHEN ae.event_type='video_complete' THEN 1 END) completions,
             COALESCE(SUM(CASE WHEN ae.event_type='video_progress' THEN ae.duration_seconds ELSE 0 END),0) watch_seconds,
             COUNT(DISTINCT ae.episode_id) episodes_watched, MAX(ae.created_at) last_watched
      FROM analytics_events ae
      LEFT JOIN episodes e ON e.id = ae.episode_id
      LEFT JOIN storylines s ON s.id = e.storyline_id
      WHERE ae.created_at >= ? AND ae.episode_id IS NOT NULL
      GROUP BY s.id, s.title
      ORDER BY watch_seconds DESC, starts DESC LIMIT 100`, [since]);

    const repeat = await db.query(`
      SELECT country_code, COUNT(*) AS visitors, SUM(CASE WHEN visits > 1 THEN 1 ELSE 0 END) repeat_visitors
      FROM (SELECT country_code, visitor_id, COUNT(DISTINCT DATE(created_at)) visits FROM analytics_events WHERE created_at >= ? GROUP BY country_code, visitor_id) x
      GROUP BY country_code ORDER BY visitors DESC`, [since]);

    const totalRequests = Number(summary?.requests || 0);
    res.json({
      ok: true,
      days,
      summary: summary || {},
      countries,
      repeat,
      videos,
      shows,
      paths,
      devices,
      requests,
      requestPagination: {
        page,
        pageSize,
        total: totalRequests,
        totalPages: Math.max(1, Math.ceil(totalRequests / pageSize)),
      },
    });
  } catch (err) {
    console.error('[API /admin/analytics]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load analytics' });
  }
});

app.get('/api/admin/users', auth.requireAdmin, async (req, res) => {
  try {
    const users = await db.query(`
      SELECT u.id,u.email,u.display_name,u.email_verified,u.is_active,u.last_login_at,u.created_at,
             (SELECT COUNT(*) FROM user_favorites f WHERE f.user_id=u.id) favorite_count,
             (SELECT COUNT(*) FROM analytics_events ae WHERE ae.user_id=u.id AND ae.event_type='video_start') video_starts
      FROM users u ORDER BY u.created_at DESC LIMIT 500`);
    res.json({ ok: true, users });
  } catch (err) {
    console.error('[API /admin/users GET]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load users' });
  }
});

app.post('/api/admin/users', auth.requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const displayName = req.body?.displayName ? String(req.body.displayName).trim().slice(0,120) : null;
    const password = String(req.body?.password || '');
    const verified = req.body?.emailVerified !== false;
    if (!EMAIL_RE.test(email)) return res.status(400).json({ ok:false, error:'Enter a valid email address' });
    if (password.length < 8) return res.status(400).json({ ok:false, error:'Password must be at least 8 characters' });
    if (await db.queryOne(`SELECT id FROM users WHERE email=?`, [email])) return res.status(409).json({ ok:false, error:'A user with that email already exists' });
    const { hash, salt } = auth.hashPassword(password);
    const userId = uuidv4();
    await db.execute(`INSERT INTO users (id,email,password_hash,password_salt,display_name,email_verified,is_active) VALUES (?,?,?,?,?,?,1)`, [userId,email,hash,salt,displayName,verified ? 1 : 0]);
    res.json({ ok:true, user:{ id:userId,email,displayName,emailVerified:verified,isActive:true } });
  } catch (err) {
    console.error('[API /admin/users POST]', err.message);
    res.status(500).json({ ok:false, error:'Could not create user' });
  }
});

app.put('/api/admin/users/:id', auth.requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const existing = await db.queryOne(`SELECT id,email FROM users WHERE id=?`, [id]);
    if (!existing) return res.status(404).json({ ok:false, error:'User not found' });
    const fields=[]; const values=[];
    if (req.body?.displayName !== undefined) { fields.push('display_name=?'); values.push(String(req.body.displayName || '').trim().slice(0,120) || null); }
    if (req.body?.emailVerified !== undefined) { fields.push('email_verified=?'); values.push(req.body.emailVerified ? 1 : 0); }
    if (req.body?.isActive !== undefined) { fields.push('is_active=?'); values.push(req.body.isActive ? 1 : 0); }
    if (req.body?.password) {
      const password=String(req.body.password); if(password.length<8)return res.status(400).json({ok:false,error:'Password must be at least 8 characters'});
      const {hash,salt}=auth.hashPassword(password); fields.push('password_hash=?','password_salt=?'); values.push(hash,salt);
    }
    if (!fields.length) return res.json({ok:true});
    values.push(id); await db.execute(`UPDATE users SET ${fields.join(', ')} WHERE id=?`, values);
    res.json({ok:true});
  } catch (err) {
    console.error('[API /admin/users PUT]', err.message); res.status(500).json({ok:false,error:'Could not update user'});
  }
});

app.get('/api/admin/announcements', auth.requireAdmin, async (req, res) => {
  try { res.json({ ok:true, announcements: await db.query(`SELECT id,title,body,audience,published_at,created_at FROM announcements ORDER BY created_at DESC LIMIT 100`) }); }
  catch (err) { console.error('[API /admin/announcements GET]',err.message); res.status(500).json({ok:false,error:'Could not load announcements'}); }
});

app.post('/api/admin/announcements', auth.requireAdmin, async (req, res) => {
  try {
    const title=String(req.body?.title||'').trim().slice(0,180); const body=String(req.body?.body||'').trim();
    if(title.length<2 || !body) return res.status(400).json({ok:false,error:'Title and announcement body are required'});
    const id=uuidv4(); const publish=req.body?.publish !== false;
    await db.execute(`INSERT INTO announcements (id,title,body,audience,published_at) VALUES (?,?,?,?,?)`, [id,title,body,'all',publish ? new Date() : null]);
    res.json({ok:true,id,published:publish});
  } catch (err) { console.error('[API /admin/announcements POST]',err.message); res.status(500).json({ok:false,error:'Could not create announcement'}); }
});

app.delete('/api/admin/announcements/:id', auth.requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok:false, error:'Announcement id is required' });
    const existing = await db.queryOne(`SELECT id FROM announcements WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ ok:false, error:'Announcement not found' });
    await db.execute('DELETE FROM announcement_reads WHERE announcement_id = ?', [id]);
    const result = await db.execute('DELETE FROM announcements WHERE id = ?', [id]);
    const affected = Number(result?.affectedRows ?? result?.[0]?.affectedRows ?? 0);
    res.json({ ok:true, deleted: affected > 0 });
  } catch (err) {
    console.error('[API /admin/announcements DELETE]', err.message);
    res.status(500).json({ ok:false, error:'Could not delete announcement' });
  }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user  = await db.queryOne(`SELECT * FROM users WHERE email = ?`, [email]);
    // Always return ok — don't leak whether an email is registered.
    if (!user || user.email_verified) {
      return res.json({ ok: true, message: 'If that account needs verification, a new link has been sent.' });
    }

    const verifyToken   = auth.randomToken();
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.execute(
      `UPDATE users SET verify_token = ?, verify_token_expires = ? WHERE id = ?`,
      [verifyToken, verifyExpires, user.id]
    );

    const frontendUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '';
    const verifyUrl   = `${frontendUrl.replace(/\/$/, '')}/verify?token=${verifyToken}`;
    const { subject, html, text } = mailer.verificationEmail({ verifyUrl });
    await mailer.sendMail({ to: user.email, subject, html, text });

    res.json({ ok: true, message: 'If that account needs verification, a new link has been sent.' });
  } catch (err) {
    console.error('[API /auth/resend-verification]', err.message);
    res.status(500).json({ ok: false, error: 'Could not resend verification email' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Prune DB — wipe all content tables
//
// Authorization: the caller must supply the server's SESSION_SECRET (or a
// dedicated PRUNE_SECRET if set) in the request body.  The server validates it
// with crypto.timingSafeEqual so the secret never leaks via timing side-channels.
//
// The secret is never embedded in the dashboard JS — the user types it into
// a password field in the confirmation dialog.  Anyone who can reach the endpoint
// still needs to know the secret, which only the operator has.
// ──────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// Admin password hash — read from environment (ADMIN_PASSWORD_HASH).
// Accepts either the plaintext password OR the session secret for DB pruning.
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

app.delete('/api/prune-db', async (req, res) => {
  const provided = req.body?.secret;
  if (!provided || typeof provided !== 'string') {
    return res.status(401).json({ ok: false, error: 'Unauthorized — admin secret required' });
  }

  // Two authorization paths:
  //   1. Admin password (works without Replit — SHA-256 hash compared timing-safe)
  //   2. Session secret / PRUNE_SECRET (Replit-style, plain string compared timing-safe)
  let authorized = false;

  // ── Path 1: admin password hash ──────────────────────────────────────────────
  try {
    const providedHash = crypto.createHash('sha256').update(provided).digest('hex');
    const a = Buffer.from(providedHash,        'utf8');
    const b = Buffer.from(ADMIN_PASSWORD_HASH, 'utf8');
    authorized = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { authorized = false; }

  // ── Path 2: session / prune secret ───────────────────────────────────────────
  if (!authorized) {
    const adminSecret = process.env.PRUNE_SECRET || process.env.SESSION_SECRET || '';
    if (adminSecret && adminSecret !== 'change-me-to-a-random-string') {
      try {
        const a = Buffer.from(provided,    'utf8');
        const b = Buffer.from(adminSecret, 'utf8');
        authorized = a.length === b.length && crypto.timingSafeEqual(a, b);
      } catch { authorized = false; }
    }
  }

  if (!authorized) {
    console.warn('[PruneDB] Unauthorized prune attempt — wrong secret');
    return res.status(403).json({ ok: false, error: 'Forbidden — incorrect admin secret or password' });
  }

  try {
    // Delete in FK dependency order (shots → episodes → characters → storylines)
    const shotsDel      = await db.execute('DELETE FROM shots');
    const episodesDel   = await db.execute('DELETE FROM episodes');
    const charactersDel = await db.execute('DELETE FROM characters');
    const storylinesDel = await db.execute('DELETE FROM storylines');
    console.log(
      `[PruneDB] Wiped: ${shotsDel.affectedRows} shots, ` +
      `${episodesDel.affectedRows} episodes, ` +
      `${charactersDel.affectedRows} characters, ` +
      `${storylinesDel.affectedRows} storylines`
    );

    // ── Reset the entire engine state so the dashboard reflects the wipe ──────────
    state.resetForRun();
    state.setStatus(state.STATES.IDLE);
    state.setCurrentEpisode(null);
    state.setShotProgress(0, 0);
    state.setApiTest(null);
    // Clear in-memory history
    for (let i = 0; i < 10; i++) state.addHistory({ title: '', episodeTitle: '', cloudinaryUrl: '', videoLink: '', postedAt: '' });
    // Re-emit a clean state to all SSE clients
    state.emitter.emit('update', state.getState());

    res.json({
      ok: true,
      message: 'Database wiped and engine state reset',
      deleted: {
        shots:      shotsDel.affectedRows,
        episodes:   episodesDel.affectedRows,
        characters: charactersDel.affectedRows,
        storylines: storylinesDel.affectedRows,
      },
    });
  } catch (err) {
    console.error('[PruneDB] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Cron schedules (UTC)
// ──────────────────────────────────────────────────────────────────────────────

cron.schedule('0 5 * * *', () => {
  console.log('[Cron] 05:00 UTC — episode pipeline');
  agentOrchestrator.runProductionAgent().catch(err => console.error('[Cron 05:00 agent]', err.message));
}, { timezone: 'UTC' });

cron.schedule('0 17 * * *', () => {
  console.log('[Cron] 17:00 UTC — episode pipeline');
  agentOrchestrator.runProductionAgent().catch(err => console.error('[Cron 17:00 agent]', err.message));
}, { timezone: 'UTC' });

cron.schedule('0 9,14,19 * * *', () => {
  console.log('[Cron] Comment reminder');
  pipeline.runCommentReminder().catch(err => console.error('[Cron reminders]', err.message));
}, { timezone: 'UTC' });

cron.schedule('0 10,15 * * *', () => {
  console.log('[Cron] Engagement post → Discord');
  pipeline.runEngagementPost().catch(err => console.error('[Cron engagement]', err.message));
}, { timezone: 'UTC' });

// ──────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// Magic Hour credit refresh — runs on boot and every 30 minutes.
// Magic Hour does not currently expose a public credits endpoint; this function
// probes the known candidates once, logs the outcome once, then stops retrying
// on 404 so the log stays clean.
// ──────────────────────────────────────────────────────────────────────────────

const MH_CREDIT_ENDPOINTS = [
  'https://api.magichour.ai/v1/me',
  'https://api.magichour.ai/v1/account',
  'https://api.magichour.ai/v1/user',
];
let _mhCreditEndpoint      = null;   // discovered working URL, null = unknown, false = none exist
let _mhCreditEndpointLogged = false; // only log "unavailable" once

async function _probeMhCreditEndpoint(key) {
  for (const url of MH_CREDIT_ENDPOINTS) {
    try {
      const resp = await axios.get(url, { headers: { Authorization: `Bearer ${key}` }, timeout: 10000 });
      if (resp.data && typeof resp.data === 'object') {
        _mhCreditEndpoint = url;
        console.log(`[MH Credits] Discovered credit endpoint: ${url}`);
        return { url, data: resp.data };
      }
    } catch (err) {
      if (err.response?.status !== 404) throw err; // unexpected error — propagate
      // 404 → try next candidate
    }
  }
  _mhCreditEndpoint = false; // definitively unavailable
  if (!_mhCreditEndpointLogged) {
    console.log('[MH Credits] No credit balance endpoint found on Magic Hour API — balance display unavailable.');
    _mhCreditEndpointLogged = true;
  }
  return null;
}

async function refreshMhCredits() {
  const keys = config.magicHourKeys;
  if (!keys.length) return;

  // If we already know the endpoint doesn't exist, skip silently
  if (_mhCreditEndpoint === false) return;

  await Promise.all(keys.map(async (key, i) => {
    try {
      let result = null;
      if (_mhCreditEndpoint) {
        const resp = await axios.get(_mhCreditEndpoint,
          { headers: { Authorization: `Bearer ${key}` }, timeout: 10000 });
        result = { url: _mhCreditEndpoint, data: resp.data };
      } else {
        result = await _probeMhCreditEndpoint(key);
      }
      if (!result) return; // endpoint unavailable

      const data    = result.data || {};
      const email   = data.email || data.user?.email || null;
      const credits = data.credits?.remaining ?? data.frame_credits ?? data.credits ?? null;
      if (config.keyHealth.magicHour[i]) {
        if (credits !== null) config.keyHealth.magicHour[i].credits = credits;
        if (email)            config.keyHealth.magicHour[i].email   = email;
        config.keyHealth.magicHour[i].creditsRefreshedAt = new Date().toISOString();
      }
      console.log(`[MH Credits] Key ${i + 1}: ${credits !== null ? credits + ' credits' : '?'} (${email || 'no email'})`);
    } catch (err) {
      if (!_mhCreditEndpointLogged) {
        console.warn(`[MH Credits] Key ${i + 1}: ${err.message}`);
      }
    }
  }));

  // Push updated keyHealth to all SSE clients so the dashboard refreshes live
  state.emitter.emit('update', state.getState());
}

// ──────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────────────────────────────────────

async function bootstrap() {
  try {
    await db.initSchema();
    const agentMemory = require('./src/agentMemory');
    await agentMemory.initAgentMemorySchema();
    console.log('[Bootstrap] Agent memory schema ready.');
  } catch (err) {
    console.error('[Bootstrap] DB schema init failed:', err.message);
    console.error('[Bootstrap] App will start but DB features will fail until DB is reachable.');
  }



  // Fetch Magic Hour credit balances on startup (non-blocking) then every 30 min
  refreshMhCredits().catch(err => console.warn('[MH Credits] Startup fetch failed:', err.message));
  setInterval(() => {
    refreshMhCredits().catch(err => console.warn('[MH Credits] Refresh failed:', err.message));
  }, 30 * 60 * 1000);

  // ── Auto-resume any in-progress draft episode on startup ─────────────────
  // Episode generation takes 30-60 min. Replit can restart at any time.
  // Without this, a paused draft would wait until the next scheduled cron window
  // (up to 12 hours away) before resuming. We check immediately after boot.
  setTimeout(async () => {
    try {
      const draftInfo = await pipeline.getDraftEpisodeAny();
      if (draftInfo) {
        const { storyline } = draftInfo;
        console.log(`[Bootstrap] Found in-progress draft for "${storyline.title}" — auto-resuming`);
        await telegramLib.sendTelegram(
          `🔄 <b>StreamVerse restarted</b> — found paused episode of "<b>${storyline.title}</b>". Auto-resuming now...`
        ).catch(() => {});
        agentOrchestrator.runProductionAgent().catch(err =>
          console.error('[Bootstrap] Auto-resume production agent failed:', err.message)
        );
      }
    } catch (err) {
      console.warn('[Bootstrap] Draft check failed (non-fatal):', err.message);
    }
  }, 8000); // 8s delay — let DB connections and Cloudinary init settle first
}

// Export for Vite middleware usage — when required by vite.config.ts,
// the app is mounted as middleware and bootstrap runs there.
module.exports = { app, bootstrap };

// Only listen + bootstrap when run directly (node index.js / npm start)
if (require.main === module) {
  bootstrap();
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[StreamVerse] Server running on port ${config.port}`);
    console.log(`[StreamVerse] Dashboard: http://0.0.0.0:${config.port}/dashboard`);
    console.log('[StreamVerse] Cron: 05:00, 12:00, 17:00 UTC episodes/reels + 09/14/19 reminders');
  });
}
