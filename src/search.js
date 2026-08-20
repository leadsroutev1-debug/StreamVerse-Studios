'use strict';

// Lightweight, dependency-free semantic-style catalog search.
// It combines normalized token matching, synonym expansion, field weighting,
// exact phrase boosts, and intent terms so natural queries remain useful
// without requiring an external embedding service.

const STOP = new Set([
  'a','an','and','are','as','at','be','by','for','from','in','is','it','of','on','or','the','to','with','this','that','me','my','show','shows','series','episode','episodes','watch','watching'
]);

const SYNONYMS = {
  love: ['romance','romantic','relationship','heart'],
  romance: ['love','romantic','relationship','heart'],
  romantic: ['love','romance','relationship','heart'],
  funny: ['comedy','humour','humor','comedic'],
  comedy: ['funny','humour','humor','comedic'],
  scary: ['horror','thriller','fear'],
  horror: ['scary','thriller','fear'],
  suspense: ['thriller','mystery','tension'],
  thriller: ['suspense','mystery','tension'],
  mystery: ['thriller','suspense','detective'],
  futuristic: ['sci-fi','science','technology','future'],
  scifi: ['sci-fi','science','technology','future'],
  'sci-fi': ['scifi','science','technology','future'],
  action: ['fight','adventure','chase','combat'],
  drama: ['emotional','family','relationship','serious'],
  emotional: ['drama','heart','relationship'],
  family: ['home','parents','children','relationship'],
  revenge: ['betrayal','payback','vengeance'],
  betrayal: ['revenge','deception','trust'],
  detective: ['mystery','crime','investigation'],
  crime: ['criminal','detective','mystery'],
  school: ['student','classroom','college','campus'],
  student: ['school','college','campus'],
  friendship: ['friends','friend','bond'],
  friends: ['friendship','friend','bond'],
  college: ['student','school','campus','university'],
  university: ['student','college','campus','school'],
  story: ['plot','narrative','tale','drama'],
  stories: ['story','plot','narrative','tale'],
  supernatural: ['horror','paranormal','ghost'],
  ghost: ['supernatural','paranormal','horror']
};

function thumbnailFromVideo(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (!raw.includes('/video/upload/')) return '';
  return raw.replace('/video/upload/', '/video/upload/so_0,w_720,q_auto,f_jpg/').replace(/\.(mp4|mov|webm)(?:\?.*)?$/i, '.jpg');
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normalize(text)
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1 && !STOP.has(t));
}

function expand(queryTokens) {
  const out = new Set(queryTokens);
  for (const token of queryTokens) {
    for (const synonym of SYNONYMS[token] || []) out.add(synonym);
  }
  return [...out];
}

function wordBoundaryScore(text, term) {
  const n = normalize(text);
  if (!n || !term) return 0;
  if (n === term) return 10;
  if (n.includes(` ${term} `) || n.startsWith(`${term} `) || n.endsWith(` ${term}`)) return 5;
  if (n.includes(term)) return 2;
  return 0;
}

function scoreRow(row, query, queryTokens, expandedTokens) {
  const showTitle = row.show_title || '';
  const episodeTitle = row.episode_title || '';
  const synopsis = row.synopsis || '';
  const genre = row.genre || '';
  const logline = row.logline || '';
  const plot = row.plot_summary || '';
  const blob = `${showTitle} ${episodeTitle} ${synopsis} ${genre} ${logline} ${plot}`;

  let score = 0;
  const nq = normalize(query);
  const fields = [
    [showTitle, 12],
    [episodeTitle, 11],
    [genre, 8],
    [synopsis, 6],
    [logline, 5],
    [plot, 4],
  ];

  for (const [field, weight] of fields) {
    const nf = normalize(field);
    if (!nf) continue;
    if (nf === nq) score += weight * 4;
    else if (nf.includes(nq)) score += weight * 2;
    for (const token of queryTokens) score += wordBoundaryScore(field, token) * weight;
  }

  const normalizedBlob = normalize(blob);
  for (const token of expandedTokens) {
    if (normalizedBlob.includes(token)) score += token.length > 4 ? 1.5 : 0.75;
  }

  const phraseTokens = queryTokens.filter(Boolean);
  if (phraseTokens.length > 1 && phraseTokens.every(t => normalizedBlob.includes(t))) score += 8;

  // Small freshness tie-breaker without overwhelming relevance.
  const date = row.posted_at ? new Date(row.posted_at).getTime() : 0;
  score += Number.isFinite(date) ? Math.max(0, date / 8.64e10) * 0.00001 : 0;
  return score;
}

function mapEpisode(row) {
  let script = {};
  try { script = typeof row.script === 'string' ? JSON.parse(row.script || '{}') : (row.script || {}); } catch {}
  let sceneState = {};
  try { sceneState = typeof row.scene_state === 'string' ? JSON.parse(row.scene_state || '{}') : (row.scene_state || {}); } catch {}
  const previewEntries = Object.entries(sceneState || {})
    .filter(([, url]) => typeof url === 'string' && url.trim())
    .sort(([a], [b]) => Number(a) - Number(b));

  return {
    id: row.id,
    showId: row.storyline_id,
    showTitle: row.show_title || '',
    title: `${row.show_title || 'Show'} S${row.season_number}E${row.episode_number}`,
    episodeTitle: row.episode_title || script.episode_title || '',
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    genre: row.genre || '',
    synopsis: row.synopsis || script.synopsis || script.logline || '',
    thumbnailUrl: row.thumbnail_url || '',
    previewUrl: previewEntries[0]?.[1] || '',
    postedAt: row.posted_at || row.created_at || null,
    relevance: row._score,
  };
}

async function searchCatalog(db, query, limit = 30) {
  const q = String(query || '').trim();
  if (!q) return { query: '', episodes: [], shows: [] };
  const queryTokens = tokens(q);
  const expandedTokens = expand(queryTokens);
  if (!queryTokens.length) return { query: q, episodes: [], shows: [] };

  const rows = await db.query(`
    SELECT e.id, e.storyline_id, e.episode_number, e.season_number, e.script, e.scene_state, e.video_url,
           e.posted_at, e.created_at,
           s.title AS show_title, s.genre, s.logline, s.plot_summary
    FROM episodes e
    JOIN storylines s ON s.id = e.storyline_id
    WHERE e.status='posted' AND e.video_url IS NOT NULL
    ORDER BY COALESCE(e.posted_at,e.created_at) DESC
    LIMIT 2000
  `);

  const scored = rows.map(row => {
    let script = {};
    try { script = typeof row.script === 'string' ? JSON.parse(row.script || '{}') : (row.script || {}); } catch {}
    const candidate = {
      ...row,
      episode_title: script.episode_title || '',
      synopsis: script.synopsis || script.logline || '',
      thumbnail_url: thumbnailFromVideo(row.video_url),
    };
    return { row: candidate, score: scoreRow(candidate, q, queryTokens, expandedTokens) };
  }).filter(x => x.score > 0.5).sort((a, b) => b.score - a.score);

  const episodes = scored.slice(0, Math.max(limit, 1)).map(x => {
    x.row._score = x.score;
    return mapEpisode(x.row);
  });

  const showMap = new Map();
  for (const item of scored) {
    const r = item.row;
    const key = String(r.storyline_id);
    const existing = showMap.get(key);
    if (!existing) {
      showMap.set(key, {
        id: r.storyline_id,
        title: r.show_title || '',
        genre: r.genre || '',
        score: item.score,
        latestAt: r.posted_at || r.created_at,
      });
    } else {
      existing.score = Math.max(existing.score, item.score);
    }
  }
  const shows = [...showMap.values()].sort((a, b) => b.score - a.score).slice(0, 12);
  return { query: q, episodes, shows };
}

module.exports = { searchCatalog };
