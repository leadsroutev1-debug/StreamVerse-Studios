'use strict';
const mysql = require('mysql2/promise');
const config = require('./config');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(config.db);
    pool.on('connection', () => console.log('[DB] New MySQL connection established'));
  }
  return pool;
}

/**
 * mysql2 prepared statements throw "Incorrect arguments to mysqld_stmt_execute"
 * when any parameter value is `undefined`. Coerce every undefined to null so
 * the driver always receives a serialisable value.
 */
function sanitizeParams(params) {
  return params.map(p => (p === undefined ? null : p));
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, sanitizeParams(params));
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, sanitizeParams(params));
  return result;
}

async function transaction(fn) {
  const conn = await getPool().getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function initSchema() {
  console.log('[DB] Initialising schema...');

  await execute(`
    CREATE TABLE IF NOT EXISTS storylines (
      id                    VARCHAR(36)  NOT NULL PRIMARY KEY,
      title                 VARCHAR(255) NOT NULL,
      genre                 VARCHAR(100) NOT NULL,
      character_bible       JSON         NULL,
      plot_summary          TEXT         NULL,
      full_story_simulation  JSON         NULL,
      central_theme         TEXT         NULL,
      tone_manifesto        TEXT         NULL,
      visual_language       JSON         NULL,
      season_arcs           JSON         NULL,
      engagement_hook       TEXT         NULL,
      premiere_announcement TEXT         NULL,
      logline               TEXT         NULL,
      status                ENUM('active','completed') NOT NULL DEFAULT 'active',
      episode_count         INT          NOT NULL DEFAULT 0,
      current_season        INT          NOT NULL DEFAULT 1,
      current_episode       INT          NOT NULL DEFAULT 0,
      facebook_playlist_id  VARCHAR(100) NULL,
      next_episode_due_date DATETIME     NULL,
      created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS episodes (
      id                  VARCHAR(36)   NOT NULL PRIMARY KEY,
      storyline_id        VARCHAR(36)   NOT NULL,
      episode_number      INT           NOT NULL,
      season_number       INT           NOT NULL DEFAULT 1,
      script              LONGTEXT      NULL,
      scene_count         INT           NOT NULL DEFAULT 0,
      shot_count          INT           NOT NULL DEFAULT 0,
      video_url           VARCHAR(1024) NULL,
      facebook_video_id   VARCHAR(100)  NULL,
      facebook_video_link VARCHAR(1024) NULL,
      status              VARCHAR(50)   NOT NULL DEFAULT 'pending',
      safety_check_passed TINYINT(1)    NOT NULL DEFAULT 1,
      safety_notes        TEXT          NULL,
      shot_state          JSON          NULL COMMENT 'scene_shot → Cloudinary clip URL; saved after every successful shot for resume support',
      scene_state         JSON          NULL COMMENT 'scene number → compiled scene URL; saved after each scene compile',
      global_continuity_state JSON       NULL COMMENT 'Episode-wide continuity ledger: environment, character states, unresolved threads, last end state',
      scene_background_state JSON        NULL COMMENT 'scene number → dedicated empty-set background reference URL',
      paused_reason       VARCHAR(512)  NULL COMMENT 'Why this draft episode is paused (e.g. MH credits exhausted)',
      ready_at            DATETIME      NULL COMMENT 'When final compilation finished and the episode became ready for manual review/publish',
      posted_at           DATETIME      NULL,
      created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_storyline (storyline_id),
      INDEX idx_status    (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS shots (
      id             VARCHAR(36)    NOT NULL PRIMARY KEY,
      episode_id     VARCHAR(36)    NOT NULL,
      scene_number   INT            NOT NULL,
      shot_index     INT            NOT NULL,
      status         VARCHAR(30)    NOT NULL DEFAULT 'pending'
                                    COMMENT 'pending|mh_submitted|done|failed',
      image_url      VARCHAR(1024)  NULL     COMMENT 'Temp Cloudinary public ID of generated still',
      mh_job_id      VARCHAR(100)   NULL     COMMENT 'Video-gen job/event ID — Magic Hour job ID or LTX event_id depending on VIDEO_PROVIDER; set before polling begins',
      mh_api_key     VARCHAR(256)   NULL     COMMENT 'Auth credential used for this job — Magic Hour API key or HF token depending on VIDEO_PROVIDER',
      clip_url       VARCHAR(1024)  NULL     COMMENT 'Final Cloudinary clip URL',
      clip_duration  FLOAT          NULL     COMMENT 'Effective clip duration in seconds for FFmpeg',
      error_count    INT            NOT NULL DEFAULT 0,
      last_error     TEXT           NULL,
      created_at     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_episode_shot (episode_id, scene_number, shot_index),
      INDEX idx_episode_status (episode_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS characters (
      id                   VARCHAR(36)   NOT NULL PRIMARY KEY,
      storyline_id         VARCHAR(36)   NOT NULL,
      name                 VARCHAR(255)  NOT NULL,
      description          TEXT          NULL,
      visual_profile       JSON          NULL,
      visual_anchor        TEXT          NULL COMMENT 'Comma-separated tag-lock injected into every shot prompt',
      reference_image_url  VARCHAR(1024) NULL COMMENT 'Cloudinary URL of primary (front) portrait',
      reference_image_urls JSON          NULL COMMENT 'JSON array of all portrait angle URLs for reference conditioning',
      created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_storyline (storyline_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Safe column additions for existing installs
  const alterColumns = [
    // episodes table
    [`episodes`,    `season_number`,       `ALTER TABLE episodes ADD COLUMN season_number INT NOT NULL DEFAULT 1 AFTER episode_number`],
    [`episodes`,    `safety_check_passed`, `ALTER TABLE episodes ADD COLUMN safety_check_passed TINYINT(1) NOT NULL DEFAULT 1 AFTER status`],
    [`episodes`,    `safety_notes`,        `ALTER TABLE episodes ADD COLUMN safety_notes TEXT NULL AFTER safety_check_passed`],
    [`episodes`,    `shot_state`,          `ALTER TABLE episodes ADD COLUMN shot_state JSON NULL COMMENT 'scene_shot → clip URL; persisted after each successful shot'`],
    [`episodes`,    `global_continuity_state`,       `ALTER TABLE episodes ADD COLUMN global_continuity_state JSON NULL COMMENT 'Episode-wide continuity ledger'`],
    [`episodes`,    `scene_state`,         `ALTER TABLE episodes ADD COLUMN scene_state JSON NULL COMMENT 'scene number → compiled URL; persisted after each compose'`],
    [`episodes`,    `scene_background_state`, `ALTER TABLE episodes ADD COLUMN scene_background_state JSON NULL COMMENT 'scene number → dedicated empty-set background reference URL'`],
    [`episodes`,    `paused_reason`,       `ALTER TABLE episodes ADD COLUMN paused_reason VARCHAR(512) NULL COMMENT 'Why this draft is paused'`],
    [`episodes`,    `ready_at`,            `ALTER TABLE episodes ADD COLUMN ready_at DATETIME NULL COMMENT 'Final compilation completed; waiting for manual review/publish'`],
    // shots table — structured motion parameters from the Motion System Upgrade
    [`shots`,       `motion_params`,        `ALTER TABLE shots ADD COLUMN motion_params JSON NULL COMMENT 'Structured motion control params from Motion System Upgrade'`],
    // shots table — constraint enforcement results
    [`shots`,       `constraint_check`,     `ALTER TABLE shots ADD COLUMN constraint_check JSON NULL COMMENT 'Constraint enforcement validation results'`],
    // shots table — hard control layer data (face-lock, pose, spatial, render pass)
    [`shots`,       `hard_control_data`,    `ALTER TABLE shots ADD COLUMN hard_control_data JSON NULL COMMENT 'Hard control layer results: face-lock, pose trajectory, scene graph, render pass'`],
    [`shots`,       `render_pass`,          `ALTER TABLE shots ADD COLUMN render_pass VARCHAR(20) NULL DEFAULT 'draft' COMMENT 'Current multi-pass render stage: draft, refine, final'`],
    // characters table — add visual_profile first so subsequent AFTER clauses work
    [`characters`,  `visual_profile`,       `ALTER TABLE characters ADD COLUMN visual_profile JSON NULL`],
    [`characters`,  `visual_anchor`,        `ALTER TABLE characters ADD COLUMN visual_anchor TEXT NULL COMMENT 'Immutable prompt anchor'`],
    [`characters`,  `reference_image_url`,  `ALTER TABLE characters ADD COLUMN reference_image_url VARCHAR(1024) NULL COMMENT 'Cloudinary canonical portrait URL (primary / front angle)'`],
    [`characters`,  `reference_image_urls`, `ALTER TABLE characters ADD COLUMN reference_image_urls JSON NULL COMMENT 'JSON array of all portrait angle URLs for multi-angle reference conditioning'`],
    [`characters`,  `voice_id`,             `ALTER TABLE characters ADD COLUMN voice_id VARCHAR(100) NULL COMMENT 'Locked Deepgram Aura voice ID for TTS'`],
    [`characters`,  `seed`,                `ALTER TABLE characters ADD COLUMN seed INT NULL COMMENT 'Deterministic image generation seed for character identity lock'`],
    // characters table — LTX native-audio voice profile (age/gender/style),
    // derived once at cast-lock time and reused in every LTX video prompt so
    // a character's spoken delivery stays consistent across episodes without
    // depending on an external TTS provider.
    [`characters`,  `voice_profile`,       `ALTER TABLE characters ADD COLUMN voice_profile JSON NULL COMMENT 'Deterministic {gender, ageRange, style} used in LTX native-audio prompts'`],
    // shots table — LTX-specific status detail, finer-grained than the
    // shared status column (which stays pending|mh_submitted|done|failed for
    // compatibility with both video providers). Distinguishes a transient
    // poll hiccup from an actual generation failure or ZeroGPU exhaustion.
    [`shots`,       `ltx_status`,          `ALTER TABLE shots ADD COLUMN ltx_status VARCHAR(30) NULL COMMENT 'LTX-specific detail: submitted|generating|zero_gpu_exhausted|failed|complete'`],
    // shots table — exact prompt last sent to the image/video generator when
    // this shot failed, so a content-flagged shot can be shown on the
    // dashboard with the offending prompt pre-filled in an editable field
    // for manual fix + retry, instead of the operator having to guess it.
    [`shots`,       `last_prompt`,         `ALTER TABLE shots ADD COLUMN last_prompt TEXT NULL COMMENT 'Exact image/video prompt last attempted for this shot (populated on failure for manual edit+retry)'`],
    [`shots`,       `enabled`,             `ALTER TABLE shots ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Editorial timeline inclusion flag; 0 means removed from the episode timeline'`],
    [`shots`,       `trim_start`,          `ALTER TABLE shots ADD COLUMN trim_start FLOAT NULL COMMENT 'Cloudinary temporal trim start in seconds'`],
    [`shots`,       `trim_end`,            `ALTER TABLE shots ADD COLUMN trim_end FLOAT NULL COMMENT 'Cloudinary temporal trim end in seconds'`],
    [`shots`,       `editorial_url`,       `ALTER TABLE shots ADD COLUMN editorial_url VARCHAR(1024) NULL COMMENT 'Cloudinary-derived editorial delivery URL after trim'`],
    [`shots`,       `edit_revision`,       `ALTER TABLE shots ADD COLUMN edit_revision INT NOT NULL DEFAULT 0 COMMENT 'Human editorial revision counter'`],
    // shots table — cheap machine-readable failure category derived from
    // last_error at write time, so the dashboard can distinguish "content
    // flagged by CF Worker / Gemini — needs a prompt edit" failures from
    // ordinary transient/API failures without re-parsing free text.
    [`shots`,       `failure_reason`,      `ALTER TABLE shots ADD COLUMN failure_reason VARCHAR(30) NULL COMMENT 'content_flag|quota|transient|unknown — set when status=failed'`],
    [`shots`,       `image_prompt_override`, `ALTER TABLE shots ADD COLUMN image_prompt_override TEXT NULL COMMENT 'Human-edited still-image prompt override for HIL episode editing'`],
    [`shots`,       `video_prompt_override`, `ALTER TABLE shots ADD COLUMN video_prompt_override TEXT NULL COMMENT 'Human-edited LTX video prompt override for HIL episode editing'`],
    [`shots`,       `duration_override`,     `ALTER TABLE shots ADD COLUMN duration_override FLOAT NULL COMMENT 'Human-edited duration override for HIL episode editing'`],
    // storylines table
    [`storylines`,  `current_season`,      `ALTER TABLE storylines ADD COLUMN current_season INT NOT NULL DEFAULT 1`],
    [`storylines`,  `current_episode`,     `ALTER TABLE storylines ADD COLUMN current_episode INT NOT NULL DEFAULT 0`],
    [`storylines`,  `full_story_simulation`, `ALTER TABLE storylines ADD COLUMN full_story_simulation JSON NULL AFTER plot_summary`],
    [`storylines`,  `central_theme`,       `ALTER TABLE storylines ADD COLUMN central_theme TEXT NULL AFTER plot_summary`],
    [`storylines`,  `tone_manifesto`,      `ALTER TABLE storylines ADD COLUMN tone_manifesto TEXT NULL AFTER central_theme`],
    [`storylines`,  `visual_language`,     `ALTER TABLE storylines ADD COLUMN visual_language JSON NULL AFTER tone_manifesto`],
    [`storylines`,  `season_arcs`,         `ALTER TABLE storylines ADD COLUMN season_arcs JSON NULL AFTER visual_language`],
    [`storylines`,  `engagement_hook`,     `ALTER TABLE storylines ADD COLUMN engagement_hook TEXT NULL AFTER season_arcs`],
    [`storylines`,  `premiere_announcement`, `ALTER TABLE storylines ADD COLUMN premiere_announcement TEXT NULL AFTER engagement_hook`],
    [`storylines`,  `logline`,             `ALTER TABLE storylines ADD COLUMN logline TEXT NULL AFTER premiere_announcement`],
    [`storylines`,  `facebook_playlist_id`, `ALTER TABLE storylines ADD COLUMN facebook_playlist_id VARCHAR(100) NULL AFTER logline`],
  ];
  for (const [table, col, ddl] of alterColumns) {
    const exists = await queryOne(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, col]
    );
    if (!exists) {
      try { await execute(ddl); console.log(`[DB] Added column ${table}.${col}`); }
      catch (e) { console.warn(`[DB] Could not add ${table}.${col}:`, e.message); }
    }
  }

  // Recover continuity state for older episodes from the canonical saved script.
  // This is intentionally idempotent and only fills empty columns.
  const continuityBackfill = await execute(`
    UPDATE episodes
    SET global_continuity_state = JSON_EXTRACT(script, '$.global_continuity_state')
    WHERE (global_continuity_state IS NULL OR JSON_LENGTH(global_continuity_state) = 0)
      AND script IS NOT NULL
      AND JSON_VALID(script)
      AND JSON_CONTAINS_PATH(script, 'one', '$.global_continuity_state')
  `);
  if (continuityBackfill.affectedRows) {
    console.log(`[DB] Restored global continuity state for ${continuityBackfill.affectedRows} episode(s).`);
  }

  await execute(`
    CREATE TABLE IF NOT EXISTS users (
      id                    VARCHAR(36)   NOT NULL PRIMARY KEY,
      email                 VARCHAR(255)  NOT NULL UNIQUE,
      password_hash         VARCHAR(255)  NOT NULL,
      password_salt         VARCHAR(64)   NOT NULL,
      display_name          VARCHAR(120)  NULL,
      email_verified         TINYINT(1)    NOT NULL DEFAULT 0,
      is_active             TINYINT(1)    NOT NULL DEFAULT 1,
      verify_token          VARCHAR(128)  NULL,
      verify_token_expires  DATETIME      NULL,
      reset_token           VARCHAR(128)  NULL,
      reset_token_expires   DATETIME      NULL,
      last_login_at         DATETIME      NULL,
      created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_verify_token (verify_token),
      INDEX idx_reset_token   (reset_token),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const userActiveCol = await queryOne(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_active'`
  );
  if (!userActiveCol) {
    try { await execute(`ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER email_verified`); }
    catch (e) { console.warn('[DB] Could not add users.is_active:', e.message); }
  }

  await execute(`
    CREATE TABLE IF NOT EXISTS analytics_visitors (
      visitor_id       VARCHAR(128) NOT NULL PRIMARY KEY,
      user_id          VARCHAR(36) NULL,
      first_seen_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      country_code     CHAR(2) NULL,
      country_name     VARCHAR(120) NULL,
      region_name      VARCHAR(120) NULL,
      city_name        VARCHAR(120) NULL,
      continent        VARCHAR(32) NULL,
      geo_source       VARCHAR(40) NULL,
      timezone         VARCHAR(120) NULL,
      language         VARCHAR(35) NULL,
      browser          VARCHAR(40) NULL,
      operating_system VARCHAR(40) NULL,
      device_type      VARCHAR(20) NULL,
      user_agent       TEXT NULL,
      platform         VARCHAR(120) NULL,
      screen_width     SMALLINT NULL,
      screen_height    SMALLINT NULL,
      viewport_width   SMALLINT NULL,
      viewport_height  SMALLINT NULL,
      device_memory    DECIMAL(6,2) NULL,
      hardware_cores   SMALLINT NULL,
      ip_hash          CHAR(64) NULL,
      referrer         VARCHAR(1024) NULL,
      INDEX idx_visitor_user (user_id),
      INDEX idx_visitor_country (country_code),
      INDEX idx_visitor_last_seen (last_seen_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS analytics_sessions (
      session_id          VARCHAR(128) NOT NULL PRIMARY KEY,
      visitor_id          VARCHAR(128) NOT NULL,
      user_id             VARCHAR(36) NULL,
      started_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at            DATETIME NULL,
      page_count          INT NOT NULL DEFAULT 0,
      video_count         INT NOT NULL DEFAULT 0,
      watch_seconds       DECIMAL(12,2) NOT NULL DEFAULT 0,
      country_code        CHAR(2) NULL,
      INDEX idx_session_visitor (visitor_id),
      INDEX idx_session_user (user_id),
      INDEX idx_session_started (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      visitor_id       VARCHAR(128) NOT NULL,
      session_id       VARCHAR(128) NOT NULL,
      user_id          VARCHAR(36) NULL,
      event_type       VARCHAR(40) NOT NULL,
      path             VARCHAR(1024) NOT NULL,
      referrer         VARCHAR(1024) NULL,
      episode_id       VARCHAR(36) NULL,
      video_seconds    DECIMAL(12,3) NULL,
      duration_seconds DECIMAL(12,3) NOT NULL DEFAULT 0,
      country_code     CHAR(2) NULL,
      device_type      VARCHAR(20) NULL,
      browser          VARCHAR(40) NULL,
      operating_system VARCHAR(40) NULL,
      metadata         JSON NULL,
      created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_event_created (created_at),
      INDEX idx_event_visitor (visitor_id, created_at),
      INDEX idx_event_session (session_id, created_at),
      INDEX idx_event_type (event_type, created_at),
      INDEX idx_event_episode (episode_id, event_type, created_at),
      INDEX idx_event_country (country_code, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS announcements (
      id            VARCHAR(36) NOT NULL PRIMARY KEY,
      title         VARCHAR(180) NOT NULL,
      body          TEXT NOT NULL,
      audience      VARCHAR(20) NOT NULL DEFAULT 'all',
      published_at  DATETIME NULL,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_announcement_published (published_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS announcement_reads (
      announcement_id VARCHAR(36) NOT NULL,
      user_id         VARCHAR(36) NOT NULL,
      read_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (announcement_id, user_id),
      INDEX idx_reads_user (user_id, read_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id     VARCHAR(36) NOT NULL,
      episode_id  VARCHAR(36) NOT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, episode_id),
      INDEX idx_favorites_episode (episode_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS user_watch_progress (
      user_id        VARCHAR(36) NOT NULL,
      episode_id     VARCHAR(36) NOT NULL,
      position_sec   DECIMAL(12,3) NOT NULL DEFAULT 0,
      duration_sec   DECIMAL(12,3) NOT NULL DEFAULT 0,
      completed      TINYINT(1) NOT NULL DEFAULT 0,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, episode_id),
      INDEX idx_progress_updated (user_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('[DB] Schema ready.');
}

module.exports = { query, queryOne, execute, transaction, initSchema, getPool };
