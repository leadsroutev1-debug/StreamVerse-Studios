'use strict';

/**
 * ============================================================================
 * StreamVerse Studios — Decoupled Ad-as-Auth Streaming Gateway
 * ============================================================================
 *
 * Serves video content THROUGH this backend so an external frontend only
 * needs to know the backend URL. Direct Cloudinary URLs are not exposed to
 * normal viewers.
 *
 * External viewer flow:
 *
 *   1. GET /api/episodes/:id/stream
 *      -> Creates a short-lived ad-session token only.
 *      -> The Render/Next.js frontend owns Hilltop VAST retrieval, playback,
 *         and client-side VAST tracking.
 *      -> No episode video URL is issued at this stage.
 *
 *   2. Frontend plays the Hilltop VAST ad and completes the ad gate.
 *
 *   3. POST /api/episodes/:id/ad-complete { token }
 *      -> Consumes the one-time ad-session token.
 *      -> Mints a short-lived episode-scoped video-access token.
 *
 *   4. GET /api/episodes/:id/video?t=<token>
 *      -> Validates the video-access token.
 *      -> Proxies the Cloudinary video through this backend.
 *      -> Supports HTTP Range requests for seeking/buffering.
 *
 * Internal pipeline flow:
 *
 *   Requests carrying:
 *      X-Internal-Pipeline: <HMAC>
 *
 *   bypass the ad wall and receive the raw Cloudinary video URL.
 *
 * HMAC:
 *   SHA-256 HMAC over:
 *      "internal:streamverse-pipeline"
 *
 *   using SESSION_SECRET as the key.
 *
 * Important terminology:
 *
 *   "Ad session completion" means the client reported that the ad break
 *   completed/skipped/failed through the client-side player.
 *
 *   It is NOT a cryptographically server-verified human ad view.
 *
 * VAST behavior:
 *
 *   HTTP 2xx + valid VAST with MediaFile
 *       -> playable ad
 *
 *   HTTP 2xx + valid empty VAST:
 *       <VAST version="3.0"/>
 *       -> valid no-fill; frontend should skip the ad and play the episode
 *
 *   HTTP 4xx/5xx
 *       -> upstream ad-network problem; route returns 502
 *
 * Important:
 *
 *   This gateway does NOT cache complete VAST responses across viewers.
 *   Ad-network requests can contain per-request targeting/tracking context.
 *
 *   It DOES deduplicate concurrent identical /vast requests so a burst of
 *   simultaneous player initialization calls does not hammer Hilltop with
 *   the same request multiple times.
 *
 * The frontend should fail open on any ad failure so ad availability can
 * never make the actual episode unplayable.
 * ============================================================================
 */

const crypto = require('crypto');
const axios = require('axios');
const db = require('./db');
const { TokenStore } = require('./tokenStore');

// ============================================================================
// Configuration
// ============================================================================

const AD_TOKEN_TTL_MS =
  Number(process.env.AD_TOKEN_TTL_MS) || 15 * 60 * 1000;

const VIDEO_TOKEN_TTL_MS =
  Number(process.env.VIDEO_TOKEN_TTL_MS) || 15 * 60 * 1000;

const VAST_FETCH_TIMEOUT_MS =
  Number(process.env.VAST_FETCH_TIMEOUT_MS) || 12 * 1000;

const MAX_VAST_WRAPPER_DEPTH =
  Number(process.env.MAX_VAST_WRAPPER_DEPTH) || 3;

const VAST_LOG_PREVIEW_CHARS =
  Number(process.env.VAST_LOG_PREVIEW_CHARS) || 1200;

/**
 * Concurrent-request dedupe only.
 *
 * This is NOT a persistent VAST cache.
 *
 * If 8 frontend requests hit the same VAST route at the same time, only one
 * upstream request is made and the other 7 callers await the same promise.
 *
 * Once that request settles, it is removed immediately.
 */
const _vastInFlight = new Map();

const _adTokens = new TokenStore('ad-session');
const _videoTokens = new TokenStore('video-access');

// ============================================================================
// Token helpers
// ============================================================================

function _mintAdToken(episodeId, sessionId) {
  return _adTokens.createToken(
    { episodeId, sessionId },
    AD_TOKEN_TTL_MS
  );
}

function _mintVideoToken(episodeId, videoUrl, sessionId) {
  return _videoTokens.createToken(
    { episodeId, videoUrl, sessionId },
    VIDEO_TOKEN_TTL_MS
  );
}

// ============================================================================
// Internal pipeline authentication
// ============================================================================

function _internalPipelineHmac() {
  const secret = process.env.SESSION_SECRET || '';

  return crypto
    .createHmac('sha256', secret)
    .update('internal:streamverse-pipeline')
    .digest('hex');
}

function _isInternalRequest(req) {
  const provided = req.headers['x-internal-pipeline'];

  if (!provided) {
    return false;
  }

  try {
    const expected = _internalPipelineHmac();

    const a = Buffer.from(String(provided), 'utf8');
    const b = Buffer.from(String(expected), 'utf8');

    return (
      a.length === b.length &&
      crypto.timingSafeEqual(a, b)
    );
  } catch {
    return false;
  }
}

// ============================================================================
// CORS
// ============================================================================

function _resolveOrigin(req) {
  const allowed = String(process.env.FRONTEND_URL || '')
    .replace(/\/+$/, '');

  const reqOrigin = req.headers.origin;

  if (!allowed) {
    return '*';
  }

  const devAllowed =
    reqOrigin &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(reqOrigin);

  if (
    reqOrigin &&
    (
      reqOrigin === allowed ||
      devAllowed
    )
  ) {
    return reqOrigin;
  }

  return allowed;
}

function _apiHeaders(req, res) {
  res.setHeader(
    'Access-Control-Allow-Origin',
    _resolveOrigin(req)
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Internal-Pipeline'
  );

  res.setHeader(
    'Access-Control-Max-Age',
    '86400'
  );

  res.setHeader(
    'Vary',
    'Origin'
  );
}

function _videoHeaders(req, res) {
  if (!res || typeof res.setHeader !== 'function') {
    throw new TypeError(
      'StreamGateway /video route received an invalid Express response object'
    );
  }

  res.setHeader(
    'Access-Control-Allow-Origin',
    _resolveOrigin(req)
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Range'
  );

  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Range, Content-Length, Accept-Ranges, ETag'
  );

  res.setHeader(
    'Vary',
    'Origin'
  );
}

function _unauthorized(res, status, message) {
  return res.status(status).json({
    ok: false,
    error: message,
  });
}

// ============================================================================
// VAST parsing helpers
// ============================================================================

function _decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/');
}

function _xmlTagText(xml, tagName) {
  const safeTag = String(tagName).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );

  const re = new RegExp(
    `<${safeTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeTag}>`,
    'i'
  );

  const m = String(xml || '').match(re);

  if (!m) {
    return null;
  }

  let value = String(m[1] || '').trim();

  if (
    value.startsWith('<![CDATA[') &&
    value.endsWith(']]>')
  ) {
    value = value.slice(9, -3).trim();
  }

  return _decodeXmlEntities(value);
}

function _xmlAllTagText(xml, tagName) {
  const out = [];

  const safeTag = String(tagName).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );

  const re = new RegExp(
    `<${safeTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeTag}>`,
    'gi'
  );

  let m;

  while ((m = re.exec(String(xml || '')))) {
    let value = String(m[1] || '').trim();

    if (
      value.startsWith('<![CDATA[') &&
      value.endsWith(']]>')
    ) {
      value = value.slice(9, -3).trim();
    }

    value = _decodeXmlEntities(value);

    if (value) {
      out.push(value);
    }
  }

  return out;
}

function _vastTracking(xml) {
  const trackingEvents = {};

  const re =
    /<Tracking\b([^>]*)>([\s\S]*?)<\/Tracking>/gi;

  let m;

  while ((m = re.exec(String(xml || '')))) {
    const attrs = m[1] || '';

    const eventMatch =
      attrs.match(
        /event\s*=\s*["']([^"']+)["']/i
      );

    const event = eventMatch?.[1] || null;

    let url = String(m[2] || '').trim();

    if (
      url.startsWith('<![CDATA[') &&
      url.endsWith(']]>')
    ) {
      url = url.slice(9, -3).trim();
    }

    url = _decodeXmlEntities(url);

    if (!event || !url) {
      continue;
    }

    (trackingEvents[event] ||= []).push(url);
  }

  return trackingEvents;
}

function _vastSkipOffset(xml) {
  const m = String(xml || '').match(
    /<Linear\b[^>]*skipoffset\s*=\s*["']([^"']+)["']/i
  );

  if (!m) {
    return null;
  }

  const raw = String(m[1] || '').trim();

  if (raw.endsWith('%')) {
    const pct = Number.parseFloat(raw);

    if (Number.isFinite(pct)) {
      return { pct };
    }

    return null;
  }

  const parts = raw.split(':').map(Number);

  if (
    parts.length === 3 &&
    parts.every(Number.isFinite)
  ) {
    return {
      seconds:
        parts[0] * 3600 +
        parts[1] * 60 +
        parts[2],
    };
  }

  return null;
}

function _resolveAbsoluteUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function _isVastXml(xml) {
  return /<VAST\b/i.test(String(xml || ''));
}

function _hasVastAd(xml) {
  return /<Ad\b/i.test(String(xml || ''));
}

function _hasVastMediaFile(xml) {
  return /<MediaFile\b/i.test(String(xml || ''));
}

// ============================================================================
// VAST request headers
// ============================================================================

function _vastRequestHeaders(req) {
  const frontendUrl =
    String(process.env.FRONTEND_URL || '').trim();

  const configuredReferer =
    String(
      process.env.VAST_REQUEST_REFERER ||
      frontendUrl ||
      ''
    ).trim();

  const headers = {
    Accept:
      'application/xml, text/xml;q=0.9, */*;q=0.8',

    'User-Agent':
      process.env.VAST_USER_AGENT ||
      'StreamVerseStudio/1.0',
  };

  if (configuredReferer) {
    headers.Referer = configuredReferer;
  }

  if (frontendUrl) {
    try {
      headers.Origin =
        new URL(frontendUrl).origin;
    } catch {
      // Ignore malformed optional frontend URL.
    }
  }

  return headers;
}

// ============================================================================
// VAST upstream resolver
// ============================================================================

async function _fetchVastUpstream(url, req) {
  let response;

  try {
    response = await axios.get(url, {
      timeout: VAST_FETCH_TIMEOUT_MS,
      responseType: 'text',
      maxRedirects: 5,

      /**
       * Important:
       * Don't let Axios throw on 4xx/5xx.
       * We need to inspect the actual upstream response and status.
       */
      validateStatus: () => true,

      headers: _vastRequestHeaders(req),
    });
  } catch (err) {
    const error = new Error(
      err?.code === 'ECONNABORTED'
        ? `VAST upstream timeout after ${VAST_FETCH_TIMEOUT_MS}ms`
        : `VAST upstream request failed: ${err?.message || err}`
    );

    error.code =
      err?.code === 'ECONNABORTED'
        ? 'VAST_TIMEOUT'
        : 'VAST_REQUEST_FAILED';

    error.cause = err;

    throw error;
  }

  const status =
    Number(response.status || 0);

  const contentType =
    String(
      response.headers?.['content-type'] || ''
    );

  const xml =
    String(response.data || '');

  const bytes =
    Buffer.byteLength(xml, 'utf8');

  const hasAd =
    _hasVastAd(xml);

  const hasMediaFile =
    _hasVastMediaFile(xml);

  console.log(
    `[StreamGateway] Hilltop VAST upstream: ${status} ${contentType || '(no content-type)'} ` +
    `bytes=${bytes} hasAd=${hasAd} hasMediaFile=${hasMediaFile}`
  );

  if (status < 200 || status >= 300) {
    const preview =
      xml
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, VAST_LOG_PREVIEW_CHARS);

    console.error(
      `[StreamGateway] Hilltop VAST HTTP ${status} from upstream`
    );

    if (preview) {
      console.error(
        `[StreamGateway] Hilltop VAST response preview: ${preview}`
      );
    }

    const error = new Error(
      `Hilltop VAST upstream returned HTTP ${status}`
    );

    error.code = 'VAST_UPSTREAM_HTTP';
    error.status = status;
    error.url = url;
    error.bodyPreview = preview;

    throw error;
  }

  if (!_isVastXml(xml)) {
    const preview =
      xml
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, VAST_LOG_PREVIEW_CHARS);

    const error = new Error(
      'Invalid VAST response'
    );

    error.code = 'VAST_INVALID_XML';
    error.status = status;
    error.bodyPreview = preview;

    throw error;
  }

  return {
    xml,
    status,
    contentType,
    bytes,
    hasAd,
    hasMediaFile,
  };
}

// ============================================================================
// VAST resolver
// ============================================================================

async function _resolveVast(
  url,
  req,
  depth = 0,
  acc = null
) {
  const state =
    acc || {
      impressions: [],
      trackingEvents: {},
      clickThrough: null,
    };

  if (
    depth >
    MAX_VAST_WRAPPER_DEPTH
  ) {
    throw new Error(
      'VAST wrapper redirect depth exceeded'
    );
  }

  const upstream =
    await _fetchVastUpstream(
      url,
      req
    );

  const {
    xml,
    hasAd,
  } = upstream;

  // --------------------------------------------------------------------------
  // Valid empty VAST / no-fill
  // --------------------------------------------------------------------------

  if (!hasAd) {
    console.log(
      `[StreamGateway] Hilltop VAST valid no-fill at depth ${depth}`
    );

    return {
      hasAd: false,
      noFill: true,
      mediaFileUrl: null,
      mediaType: null,
      skipOffset: null,
      trackingEvents:
        state.trackingEvents,
      impressions:
        state.impressions,
      clickThrough:
        state.clickThrough,
    };
  }

  // --------------------------------------------------------------------------
  // Collect tracking
  // --------------------------------------------------------------------------

  state.impressions.push(
    ..._xmlAllTagText(
      xml,
      'Impression'
    )
  );

  const tracking =
    _vastTracking(xml);

  for (
    const [event, urls]
    of Object.entries(tracking)
  ) {
    (
      state.trackingEvents[event] ||= []
    ).push(...urls);
  }

  const clickThrough =
    _xmlTagText(
      xml,
      'ClickThrough'
    );

  if (clickThrough) {
    state.clickThrough =
      clickThrough;
  }

  // --------------------------------------------------------------------------
  // Wrapper
  // --------------------------------------------------------------------------

  const wrapper =
    _xmlTagText(
      xml,
      'VASTAdTagURI'
    );

  // --------------------------------------------------------------------------
  // Media files
  // --------------------------------------------------------------------------

  const mediaRe =
    /<MediaFile\b([^>]*)>([\s\S]*?)<\/MediaFile>/gi;

  const mediaFiles = [];

  let mm;

  while ((mm = mediaRe.exec(xml))) {
    const attrs =
      mm[1] || '';

    const typeMatch =
      attrs.match(
        /type\s*=\s*["']([^"']+)["']/i
      );

    const type =
      typeMatch?.[1] ||
      'video/mp4';

    let rawUrl =
      String(mm[2] || '').trim();

    if (
      rawUrl.startsWith('<![CDATA[') &&
      rawUrl.endsWith(']]>')
    ) {
      rawUrl =
        rawUrl.slice(9, -3).trim();
    }

    rawUrl =
      _decodeXmlEntities(
        rawUrl
      );

    if (!rawUrl) {
      continue;
    }

    mediaFiles.push({
      url:
        _resolveAbsoluteUrl(
          rawUrl,
          url
        ),
      type,
    });
  }

  // --------------------------------------------------------------------------
  // Follow wrapper
  // --------------------------------------------------------------------------

  if (
    wrapper &&
    mediaFiles.length === 0
  ) {
    const wrapperUrl =
      _resolveAbsoluteUrl(
        wrapper,
        url
      );

    console.log(
      `[StreamGateway] Following VAST wrapper ` +
      `${depth + 1}/${MAX_VAST_WRAPPER_DEPTH}`
    );

    return _resolveVast(
      wrapperUrl,
      req,
      depth + 1,
      state
    );
  }

  // --------------------------------------------------------------------------
  // Ad without playable creative
  // --------------------------------------------------------------------------

  if (!mediaFiles.length) {
    console.warn(
      '[StreamGateway] VAST contains <Ad> but no playable <MediaFile>'
    );

    return {
      hasAd: false,
      noFill: true,
      creativeUnavailable: true,
      mediaFileUrl: null,
      mediaType: null,
      skipOffset:
        _vastSkipOffset(xml),
      trackingEvents:
        state.trackingEvents,
      impressions:
        state.impressions,
      clickThrough:
        state.clickThrough,
    };
  }

  // Prefer MP4.
  const mediaFile =
    mediaFiles.find(
      m =>
        String(m.type || '')
          .toLowerCase() ===
        'video/mp4'
    ) ||
    mediaFiles.find(
      m =>
        String(m.type || '')
          .toLowerCase()
          .startsWith('video/')
    ) ||
    mediaFiles[0];

  console.log(
    `[StreamGateway] Hilltop VAST playable ad found: ` +
    `${mediaFile.type}`
  );

  return {
    hasAd: true,
    noFill: false,

    mediaFileUrl:
      mediaFile.url,

    mediaType:
      mediaFile.type,

    skipOffset:
      _vastSkipOffset(xml),

    trackingEvents:
      state.trackingEvents,

    impressions:
      state.impressions,

    clickThrough:
      state.clickThrough,
  };
}

// ============================================================================
// Single-flight VAST deduplication
// ============================================================================

/**
 * Run one VAST resolution for a key at a time.
 *
 * This prevents repeated simultaneous player initialization calls from
 * generating identical upstream Hilltop requests.
 *
 * Important:
 * The promise is removed from the map immediately after settlement.
 * We do not cache the resulting ad across viewers.
 */
function _resolveVastSingleFlight(
  key,
  url,
  req
) {
  const existing =
    _vastInFlight.get(key);

  if (existing) {
    console.log(
      `[StreamGateway] Joining existing VAST request for ${key}`
    );

    return existing;
  }

  const promise =
    _resolveVast(
      url,
      req
    );

  _vastInFlight.set(
    key,
    promise
  );

  promise.finally(() => {
    if (
      _vastInFlight.get(key) ===
      promise
    ) {
      _vastInFlight.delete(key);
    }
  }).catch(() => {
    // The caller receives the original rejection.
    // This catch prevents an unhandled rejection from the .finally chain.
  });

  return promise;
}

// ============================================================================
// OPTIONS / CORS
// ============================================================================

function handleOptions(req, res) {
  _apiHeaders(req, res);
  return res.sendStatus(204);
}

// ============================================================================
// GET /api/episodes/:id/stream
// ============================================================================

async function handleStream(req, res) {
  _apiHeaders(req, res);

  try {
    const episodeId =
      String(req.params.id || '').trim();

    if (!episodeId) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid episode ID',
      });
    }

    const episode =
      await db.queryOne(
        `
          SELECT id, video_url, status
          FROM episodes
          WHERE id = ?
        `,
        [episodeId]
      );

    if (!episode) {
      return res.status(404).json({
        ok: false,
        error: 'Episode not found',
      });
    }

    if (episode.status !== 'posted') {
      return res.status(403).json({
        ok: false,
        error: 'Episode is not published yet',
      });
    }

    if (!episode.video_url) {
      return res.status(409).json({
        ok: false,
        error:
          'Episode video not yet available',
      });
    }

    // Internal pipeline bypass.
    if (
      _isInternalRequest(req)
    ) {
      return res.json({
        ok: true,
        adRequired: false,
        videoUrl:
          episode.video_url,
        bypass: true,
      });
    }

    // Hilltop VAST is now owned by the verified Render/frontend deployment.
    // The Replit backend only creates the one-time ad-session token that must
    // be consumed after the browser reports the ad gate as completed.
    const sessionId =
      crypto.randomBytes(16)
        .toString('hex');

    const adToken =
      _mintAdToken(
        episodeId,
        sessionId
      );

    return res.json({
      ok: true,
      adRequired: true,
      adProvider: 'hilltopads',
      adGate: 'frontend',
      token: adToken,
      tokenExpiresInMs: AD_TOKEN_TTL_MS,
      completeUrl:
        `/api/episodes/${encodeURIComponent(episodeId)}/ad-complete`,
    });

  } catch (err) {
    console.error(
      '[StreamGateway] /stream error:',
      err?.message || err
    );

    return res.status(500).json({
      ok: false,
      error:
        'Internal server error',
    });
  }
}

// ============================================================================
// GET /api/episodes/:id/vast
// ============================================================================

async function handleVastProxy(
  req,
  res
) {
  _apiHeaders(req, res);

  try {
    const episodeId =
      String(req.params.id || '').trim();

    if (!episodeId) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid episode ID',
      });
    }

    const episode =
      await db.queryOne(
        `
          SELECT id, video_url, status
          FROM episodes
          WHERE id = ?
        `,
        [episodeId]
      );

    if (!episode) {
      return res.status(404).json({
        ok: false,
        error:
          'Episode not found',
      });
    }

    const vastUrl =
      String(
        process.env.HILLTOPADS_VAST_URL || ''
      ).trim();

    if (!vastUrl) {
      return res.status(503).json({
        ok: false,
        error:
          'VAST advertising is not configured',
      });
    }

    /**
     * Do not include viewer-specific ad tokens in the dedupe key.
     *
     * The dedupe is only for concurrent requests to the same episode
     * and same configured VAST URL.
     */
    const dedupeKey =
      `${episodeId}|${vastUrl}`;

    const ad =
      await _resolveVastSingleFlight(
        dedupeKey,
        vastUrl,
        req
      );

    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate'
    );

    return res.status(200).json({
      ok: true,
      ...ad,
    });

  } catch (err) {
    console.error(
      '[StreamGateway] /vast proxy error:',
      err?.message || err
    );

    if (err?.status) {
      console.error(
        `[StreamGateway] /vast upstream status: ${err.status}`
      );
    }

    if (err?.bodyPreview) {
      console.error(
        `[StreamGateway] /vast upstream preview: ${err.bodyPreview}`
      );
    }

    return res.status(502).json({
      ok: false,
      error:
        'VAST ad could not be loaded',

      code:
        err?.code ||
        'VAST_PROXY_ERROR',

      upstreamStatus:
        Number.isFinite(
          Number(err?.status)
        )
          ? Number(err.status)
          : null,
    });
  }
}

// ============================================================================
// POST /api/episodes/:id/ad-complete
// ============================================================================

async function handleAdComplete(
  req,
  res
) {
  _apiHeaders(req, res);

  try {
    const episodeId =
      String(req.params.id || '').trim();

    if (!episodeId) {
      return res.status(400).json({
        ok: false,
        error:
          'Invalid episode ID',
      });
    }

    const episode =
      await db.queryOne(
        `
          SELECT id, video_url, status
          FROM episodes
          WHERE id = ?
        `,
        [episodeId]
      );

    if (!episode || episode.status !== 'posted' || !episode.video_url) {
      return res.status(404).json({
        ok: false,
        error:
          'Episode not found, not published, or no video',
      });
    }

    // Internal pipeline bypass.
    if (
      _isInternalRequest(req)
    ) {
      return res.json({
        ok: true,
        videoUrl:
          episode.video_url,
        bypass: true,
      });
    }

    const adToken =
      req.body?.token;

    if (
      !adToken ||
      typeof adToken !== 'string'
    ) {
      return _unauthorized(
        res,
        401,
        'Ad-session token required'
      );
    }

    const session =
      _adTokens.getToken(
        adToken
      );

    if (!session) {
      return _unauthorized(
        res,
        401,
        'Invalid or expired ad-session token'
      );
    }

    if (
      session.episodeId !==
      episodeId
    ) {
      return _unauthorized(
        res,
        403,
        'Token does not match episode'
      );
    }

    _adTokens.deleteToken(
      adToken
    );

    const videoToken =
      _mintVideoToken(
        episodeId,
        episode.video_url,
        session.sessionId
      );

    const proto =
      req.headers['x-forwarded-proto'] ||
      req.protocol ||
      'https';

    const host =
      req.headers['x-forwarded-host'] ||
      req.get('host') ||
      '';

    const streamUrl =
      `${proto}://${host}/api/episodes/${encodeURIComponent(episodeId)}/video?t=${encodeURIComponent(videoToken)}`;

    return res.json({
      ok: true,

      videoUrl:
        streamUrl,

      expiresIn:
        VIDEO_TOKEN_TTL_MS / 1000,

      supportsRange:
        true,
    });

  } catch (err) {
    console.error(
      '[StreamGateway] /ad-complete error:',
      err?.message || err
    );

    return res.status(500).json({
      ok: false,
      error:
        'Internal server error',
    });
  }
}

// ============================================================================
// GET /api/episodes/:id/video?t=<videoToken>
// ============================================================================

async function handleVideoStream(
  req,
  res,
  next
) {
  try {
    _videoHeaders(req, res);
  } catch (err) {
    console.error(
      '[StreamGateway] /video route contract error:',
      err?.message || err
    );

    if (typeof next === 'function') {
      return next(err);
    }

    if (res && typeof res.status === 'function' && !res.headersSent) {
      return res.status(500).json({
        ok: false,
        error: 'Video streaming route initialization failed',
      });
    }

    return;
  }

  if (
    req.method ===
    'OPTIONS'
  ) {
    return res.sendStatus(204);
  }

  try {
    const episodeId =
      String(req.params.id || '').trim();

    const videoToken =
      req.query.t;

    if (!episodeId) {
      return res.status(400).json({
        ok: false,
        error:
          'Invalid episode ID',
      });
    }

    if (
      !videoToken ||
      typeof videoToken !== 'string'
    ) {
      return _unauthorized(
        res,
        401,
        'Video access token required (?t=...)'
      );
    }

    const session =
      _videoTokens.getToken(
        videoToken
      );

    if (!session) {
      return _unauthorized(
        res,
        401,
        'Invalid or expired video token'
      );
    }

    if (
      session.episodeId !==
      episodeId
    ) {
      return _unauthorized(
        res,
        403,
        'Token does not match episode'
      );
    }

    const cloudinaryVideoUrl =
      session.videoUrl;

    if (
      !cloudinaryVideoUrl ||
      typeof cloudinaryVideoUrl !== 'string'
    ) {
      return res.status(502).json({
        ok: false,
        error:
          'Video source unavailable',
      });
    }

    const upstreamHeaders = {};

    if (req.headers.range) {
      upstreamHeaders.Range =
        req.headers.range;
    }

    const upstream =
      await axios.get(
        cloudinaryVideoUrl,
        {
          headers:
            upstreamHeaders,

          responseType:
            'stream',

          timeout:
            60 * 1000,

          validateStatus:
            status => status < 400,
        }
      );

    res.status(
      upstream.status
    );

    const passthroughHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'last-modified',
      'etag',
    ];

    for (
      const header
      of passthroughHeaders
    ) {
      const value =
        upstream.headers[
          header
        ];

      if (value) {
        res.setHeader(
          header,
          value
        );
      }
    }

    res.setHeader(
      'Accept-Ranges',
      'bytes'
    );

    upstream.data.pipe(res);

    upstream.data.on(
      'error',
      err => {
        console.error(
          '[StreamGateway] Proxy stream error:',
          err?.message || err
        );

        if (
          !res.headersSent
        ) {
          res.status(502).json({
            ok: false,
            error:
              'Upstream stream error',
          });
        }
      }
    );

    req.on(
      'close',
      () => {
        if (
          upstream.data &&
          typeof upstream.data.destroy ===
            'function'
        ) {
          upstream.data.destroy();
        }
      }
    );

  } catch (err) {
    console.error(
      '[StreamGateway] /video error:',
      err?.message || err
    );

    if (
      !res.headersSent
    ) {
      return res.status(502).json({
        ok: false,
        error:
          'Unable to stream episode video',
      });
    }
  }
}

// ============================================================================
// Internal pipeline helper
// ============================================================================

function internalHeader() {
  return _internalPipelineHmac();
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  handleOptions,
  handleStream,
  handleVastProxy,
  handleAdComplete,
  handleVideoStream,
  internalHeader,

  _config: {
    AD_TOKEN_TTL_MS,
    VIDEO_TOKEN_TTL_MS,
    VAST_FETCH_TIMEOUT_MS,
    MAX_VAST_WRAPPER_DEPTH,
  },
};