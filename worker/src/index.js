/**
 * ContiListen backend.
 *
 * Does four jobs the browser can't:
 *   1. Holds Spotify credentials server-side, so a managed phone stores nothing
 *      but a session token.
 *   2. Merges bookmarks row by row, so two devices never clobber each other.
 *   3. Polls playback every minute, whether or not anything is open.
 *   4. Waits for Spotify to finish launching before resuming — the thing a
 *      suspended web page fundamentally cannot do.
 */

const ACCOUNTS = 'https://accounts.spotify.com';
const SPOTIFY = 'https://api.spotify.com';

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-read-private'
].join(' ');

// Bumped on every deploy, so /health proves which build is actually live.
const BUILD = 'worker-2026-10-25.1';

const SESSION_DAYS = 180;
const RESUME_TRIES = 18;        // ~18s of waiting for Spotify to register
const RESUME_GAP_MS = 1000;

/* ── Small helpers ─────────────────────────────────────────── */

const now = () => Date.now();

function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A CORS origin is scheme + host only. APP_ORIGIN is the full page URL because
    the login redirect needs the path, so strip it down here rather than making
    the two settings disagree. */
function allowedOrigin(env) {
  try { return new URL(env.APP_ORIGIN).origin; }
  catch (e) { return env.APP_ORIGIN || '*'; }
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(env),
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}

const fail = (env, status, message) => json({ error: message }, env, status);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Spotify tokens ────────────────────────────────────────── */

/** A live access token for this user, refreshing and persisting when stale. */
async function accessToken(env, user) {
  if (user.access_token && now() < (user.token_expires || 0) - 30000) {
    return user.access_token;
  }

  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user.refresh_token
    })
  });

  if (!res.ok) throw new Error('refresh failed: ' + res.status);
  const t = await res.json();

  const expires = now() + (t.expires_in || 3600) * 1000;
  // Spotify only returns a new refresh token occasionally; keep the old one otherwise.
  await env.DB.prepare(
    'UPDATE users SET access_token = ?, token_expires = ?, refresh_token = ? WHERE id = ?'
  ).bind(t.access_token, expires, t.refresh_token || user.refresh_token, user.id).run();

  user.access_token = t.access_token;
  user.token_expires = expires;
  return t.access_token;
}

async function spotify(env, user, path, init = {}) {
  const token = await accessToken(env, user);
  const res = await fetch(SPOTIFY + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  return res;
}

async function spotifyJSON(env, user, path, init) {
  const res = await spotify(env, user, path, init);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(text.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/* ── Sessions ──────────────────────────────────────────────── */

async function userFromSession(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  ).bind(token, now()).first();

  if (row) {
    // Cheap liveness marker; also lets us prune abandoned accounts later.
    await env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?')
      .bind(now(), row.id).run();
  }
  return row || null;
}

async function userFromShortcutKey(env, key) {
  if (!key) return null;
  return await env.DB.prepare('SELECT * FROM users WHERE shortcut_key = ?')
    .bind(key).first();
}

/* ── OAuth ─────────────────────────────────────────────────── */

async function handleLogin(env, url) {
  const state = randomHex(16);
  await env.DB.prepare('INSERT INTO oauth_states (state, created_at) VALUES (?, ?)')
    .bind(state, now()).run();

  const q = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${url.origin}/auth/callback`,
    scope: SCOPES,
    state
  });
  return Response.redirect(`${ACCOUNTS}/authorize?${q}`, 302);
}

async function handleCallback(env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const appOrigin = env.APP_ORIGIN || url.origin;

  // Spotify explains itself in ?error — pass it through instead of swallowing it.
  const denied = url.searchParams.get('error');
  if (denied) {
    console.log('spotify denied authorisation:', denied);
    return Response.redirect(appOrigin + '#error=' + encodeURIComponent(denied), 302);
  }
  if (!code || !state) {
    console.log('callback without code. query:', url.search);
    return Response.redirect(appOrigin + '#error=missing_code', 302);
  }

  const known = await env.DB.prepare('SELECT state FROM oauth_states WHERE state = ?')
    .bind(state).first();
  if (!known) return Response.redirect(appOrigin + '#error=bad_state', 302);
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ? OR created_at < ?')
    .bind(state, now() - 3600000).run();

  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${url.origin}/auth/callback`
    })
  });
  if (!res.ok) return Response.redirect(appOrigin + '#error=token_exchange', 302);
  const t = await res.json();

  const me = await (await fetch(SPOTIFY + '/v1/me', {
    headers: { Authorization: 'Bearer ' + t.access_token }
  })).json();

  if (!me?.id) return Response.redirect(appOrigin + '#error=no_profile', 302);

  const existing = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
  const expires = now() + (t.expires_in || 3600) * 1000;

  if (existing) {
    await env.DB.prepare(
      `UPDATE users SET display_name = ?, refresh_token = ?, access_token = ?,
       token_expires = ?, market = ?, last_seen = ? WHERE id = ?`
    ).bind(me.display_name || me.id, t.refresh_token || existing.refresh_token,
           t.access_token, expires, me.country || existing.market, now(), me.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO users (id, display_name, refresh_token, access_token, token_expires,
       market, shortcut_key, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(me.id, me.display_name || me.id, t.refresh_token, t.access_token, expires,
           me.country || null, randomHex(20), now(), now()).run();

    // Naming the first profile "Me" next to an account called Max reads as two
    // different people. Use the Spotify name for both.
    const firstProfile = (me.display_name || '').trim() || 'Me';
    await env.DB.prepare(
      'INSERT OR IGNORE INTO profiles (user_id, name, added_at) VALUES (?, ?, ?)'
    ).bind(me.id, firstProfile, now()).run();
    await env.DB.prepare('UPDATE users SET default_profile = ? WHERE id = ?')
      .bind(firstProfile, me.id).run();
  }

  const session = randomHex(32);
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(session, me.id, now(), now() + SESSION_DAYS * 864e5).run();

  // Fragment, not query: never lands in a server log or the Referer header.
  return Response.redirect(`${appOrigin}#session=${session}`, 302);
}

/* ── Spotify proxy ─────────────────────────────────────────────
   The app makes the same calls it always did, but through here, so no
   Spotify token ever reaches the browser. Whitelisted so a leaked session
   can't be used as a general-purpose Spotify proxy.
   ──────────────────────────────────────────────────────────── */

const READ_PREFIXES = [
  '/v1/me/player', '/v1/me/player/devices', '/v1/me/player/recently-played',
  '/v1/search', '/v1/albums/', '/v1/artists/', '/v1/shows/', '/v1/audiobooks/',
  '/v1/playlists/', '/v1/episodes/', '/v1/chapters/', '/v1/me'
];
const WRITE_PATHS = [
  '/v1/me/player', '/v1/me/player/play', '/v1/me/player/pause', '/v1/me/player/seek'
];

async function handleProxy(env, user, request, path) {
  const bare = path.split('?')[0];
  const allowed = request.method === 'GET'
    ? READ_PREFIXES.some(p => bare === p || bare.startsWith(p))
    : WRITE_PATHS.includes(bare);

  if (!allowed) return fail(env, 403, 'path not allowed');

  const body = request.method === 'GET' ? undefined : await request.text();
  const res = await spotify(env, user, path, {
    method: request.method,
    body: body && body.length ? body : (request.method === 'GET' ? undefined : '{}')
  });

  const text = await res.text();
  return new Response(text || null, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}

/* ── State ─────────────────────────────────────────────────── */

const rowToBookmark = r => ({
  id: r.profile + '::' + r.key,
  profile: r.profile,
  key: r.key,
  albumName: r.album_name,
  artistName: r.artist_name,
  art: r.art,
  albumURI: r.album_uri,
  contextURI: r.context_uri,
  trackURI: r.track_uri,
  trackName: r.track_name,
  trackNumber: r.track_number,
  positionMs: r.position_ms,
  durationMs: r.duration_ms,
  kind: r.kind,
  wholeSeries: r.whole_series === null ? undefined : !!r.whole_series,
  archived: !!r.archived,
  history: JSON.parse(r.history || '[]'),
  updatedAt: new Date(r.updated_at).toISOString()
});

async function loadState(env, user) {
  const [bookmarks, watch, profiles, tombs] = await Promise.all([
    env.DB.prepare('SELECT * FROM bookmarks WHERE user_id = ? ORDER BY updated_at DESC')
      .bind(user.id).all(),
    env.DB.prepare('SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC')
      .bind(user.id).all(),
    env.DB.prepare('SELECT name FROM profiles WHERE user_id = ?').bind(user.id).all(),
    env.DB.prepare('SELECT * FROM tombstones WHERE user_id = ?').bind(user.id).all()
  ]);

  const series = await env.DB.prepare('SELECT uri, mode FROM series_mode WHERE user_id = ?')
    .bind(user.id).all();
  const seriesMode = {};
  for (const r of series.results || []) seriesMode[r.uri] = r.mode;

  const tombstones = {};
  for (const t of tombs.results || []) {
    tombstones[t.profile + '::' + t.key] = new Date(t.deleted_at).toISOString();
  }

  return {
    user: {
      id: user.id,
      name: user.display_name,
      market: user.market,
      shortcutKey: user.shortcut_key,
      defaultProfile: user.default_profile || 'Me'
    },
    settings: {
      mode: user.mode || 'everything',
      rewindSec: user.rewind_sec ?? 15,
      pinnedDevice: user.pinned_device ? JSON.parse(user.pinned_device) : null,
      sleepUntil: user.sleep_until || null
    },
    seriesMode,
    profiles: (profiles.results || []).map(p => p.name),
    bookmarks: (bookmarks.results || []).map(rowToBookmark),
    watchlist: (watch.results || []).map(w => ({
      kind: w.kind, id: w.uri, uri: w.uri, name: w.name, art: w.art,
      spotifyId: w.spotify_id, addedAt: new Date(w.added_at).toISOString()
    })),
    tombstones
  };
}

const ts = v => {
  const n = typeof v === 'number' ? v : Date.parse(v || 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Which bookmark a now-playing item belongs to.
 *
 * Two traps here, both found in real data:
 *   - A playlist or Liked-Songs context is NOT the work. Keying on it made every
 *     Hörspiel played from one playlist collapse into a single row that each
 *     overwrote in turn, so albumURI is preferred over contextURI.
 *   - Spotify serves some audiobooks as shows, indistinguishable from podcasts.
 *     `bookSeries` carries the listener's decision for that show.
 */
function bookmarkKey(np, bookSeries) {
  const parent = np.albumURI || null;
  if (np.kind === 'episode') {
    return (parent && bookSeries) ? parent : np.trackURI;
  }
  // A context that isn't the work itself (playlist, collection) is useless as an
  // identity, so only fall back to it when there is no parent at all.
  const usableContext = /^spotify:(album|audiobook|show):/.test(np.contextURI || '')
    ? np.contextURI : null;
  return parent || usableContext || np.trackURI;
}

/**
 * Which show or book an episode belongs to, when Spotify didn't say.
 *
 * Skipping backwards makes /v1/me/player briefly return an episode with no
 * `show` object and sometimes no context. A single poll in that window used to
 * mint a fresh bookmark keyed on the episode, fragmenting a book that was
 * already merged. Two cheap sources recover it:
 *   1. the chapter list we already cached for this show
 *   2. Spotify itself, asked once and remembered
 */
async function resolveParent(env, user, np) {
  if (np.albumURI) return np.albumURI;
  if (np.kind !== 'episode' && np.kind !== 'chapter') return null;

  const known = await env.DB.prepare(
    'SELECT uri FROM containers WHERE parts LIKE ? LIMIT 1'
  ).bind('%"' + np.trackURI + '"%').first();
  if (known?.uri) return known.uri;

  // Ask Spotify, then cache the answer in containers' stead via titles so the
  // next orphaned poll is free.
  const id = (np.trackURI || '').split(':').pop();
  if (!id) return null;
  const cachedName = await env.DB.prepare(
    'SELECT name FROM titles WHERE uri = ?'
  ).bind('parent:' + np.trackURI).first();
  if (cachedName?.name) return cachedName.name;

  try {
    const mk = user.market ? '?market=' + user.market : '';
    const ep = await spotifyJSON(env, user, `/v1/episodes/${id}${mk}`);
    const parent = ep?.show?.uri || ep?.audiobook?.uri || null;
    if (parent) {
      await env.DB.prepare(
        `INSERT INTO titles (uri, name, fetched_at) VALUES (?,?,?)
         ON CONFLICT(uri) DO UPDATE SET name = excluded.name`
      ).bind('parent:' + np.trackURI, parent, now()).run();
      return parent;
    }
  } catch (e) { /* offline or unavailable; fall through */ }
  return null;
}

/** Has the listener marked this show as a single book? */
async function isBookSeries(env, userId, uri) {
  if (!uri) return false;
  if (uri.startsWith('spotify:audiobook:')) return true;      // unambiguous
  const row = await env.DB.prepare(
    'SELECT mode FROM series_mode WHERE user_id = ? AND uri = ?'
  ).bind(userId, uri).first();
  return row?.mode === 'book';
}

/**
 * Forces an incoming bookmark onto the right key before it is stored.
 *
 * The server used to trust whatever key a device sent, so a phone running a
 * stale build — or one that had not yet pulled `series_mode` — could re-split a
 * book into one row per chapter however many times you merged it. The series
 * marking lives here, so the decision belongs here too.
 */
async function normaliseBookmark(env, userId, b) {
  const parent = b.albumURI || null;
  const strayKey = b.key || b.id;

  // Logged for every episode-shaped row, so `wrangler tail` shows exactly what a
  // device sent and why it was or wasn't re-keyed.
  const trace = (verdict) => {
    if (b.kind === 'track') return;
    console.log(`sync in: key=${strayKey} album=${parent} kind=${b.kind} -> ${verdict}`);
  };

  if (!parent || b.kind === 'track') { trace('left alone (no parent)'); return b; }
  if (!(await isBookSeries(env, userId, parent))) {
    trace('left alone (series not marked as book)');
    return b;
  }
  if (strayKey === parent) { trace('already correct'); return b; }
  trace('RE-KEYED onto ' + parent);

  // Retire the per-chapter row this device believed in.
  if (strayKey) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ? AND profile = ? AND "key" = ?')
        .bind(userId, b.profile || 'Me', strayKey),
      env.DB.prepare(
        `INSERT INTO tombstones (user_id, profile, "key", deleted_at) VALUES (?,?,?,?)
         ON CONFLICT(user_id, profile, "key") DO UPDATE SET deleted_at = excluded.deleted_at`
      ).bind(userId, b.profile || 'Me', strayKey, now())
    ]);
  }

  return { ...b, key: parent, id: undefined, kind: 'chapter', wholeSeries: true };
}

/** Newest-wins per row, so concurrent devices merge instead of overwrite. */
async function upsertBookmark(env, userId, b) {
  const profile = b.profile || 'Me';
  const key = b.key || b.id;
  const updated = ts(b.updatedAt) || now();

  const tomb = await env.DB.prepare(
    'SELECT deleted_at FROM tombstones WHERE user_id = ? AND profile = ? AND key = ?'
  ).bind(userId, profile, key).first();
  if (tomb && tomb.deleted_at >= updated) return;   // deleted elsewhere, more recently

  const existing = await env.DB.prepare(
    'SELECT updated_at, history FROM bookmarks WHERE user_id = ? AND profile = ? AND key = ?'
  ).bind(userId, profile, key).first();

  if (existing && existing.updated_at >= updated) {
    // Their position is older, but their breadcrumb trail may be longer.
    const incoming = Array.isArray(b.history) ? b.history : [];
    const held = JSON.parse(existing.history || '[]');
    if (incoming.length > held.length) {
      await env.DB.prepare(
        'UPDATE bookmarks SET history = ? WHERE user_id = ? AND profile = ? AND key = ?'
      ).bind(JSON.stringify(incoming.slice(-24)), userId, profile, key).run();
    }
    return;
  }

  const history = JSON.stringify((Array.isArray(b.history) ? b.history : []).slice(-24));

  await env.DB.prepare(
    `INSERT INTO bookmarks (user_id, profile, key, album_name, artist_name, art, album_uri,
      context_uri, track_uri, track_name, track_number, position_ms, duration_ms, kind,
      whole_series, archived, history, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, profile, key) DO UPDATE SET
       album_name=excluded.album_name, artist_name=excluded.artist_name, art=excluded.art,
       album_uri=excluded.album_uri, context_uri=excluded.context_uri,
       track_uri=excluded.track_uri, track_name=excluded.track_name,
       track_number=excluded.track_number, position_ms=excluded.position_ms,
       duration_ms=excluded.duration_ms, kind=excluded.kind,
       whole_series=excluded.whole_series, archived=excluded.archived,
       history=excluded.history, updated_at=excluded.updated_at`
  ).bind(
    userId, profile, key, b.albumName || '', b.artistName || '', b.art || null,
    b.albumURI || null, b.contextURI || null, b.trackURI || '', b.trackName || '',
    b.trackNumber ?? null, b.positionMs || 0, b.durationMs || 0, b.kind || 'track',
    b.wholeSeries === undefined ? null : (b.wholeSeries ? 1 : 0),
    b.archived ? 1 : 0, history, updated
  ).run();
}

async function applySync(env, user, payload) {
  const stmts = [];

  for (const [id, when] of Object.entries(payload.tombstones || {})) {
    const idx = id.indexOf('::');
    if (idx < 0) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO tombstones (user_id, profile, key, deleted_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id, profile, key) DO UPDATE SET
         deleted_at = MAX(deleted_at, excluded.deleted_at)`
    ).bind(user.id, id.slice(0, idx), id.slice(idx + 2), ts(when)));
  }
  for (const name of payload.profiles || []) {
    stmts.push(env.DB.prepare(
      'INSERT OR IGNORE INTO profiles (user_id, name, added_at) VALUES (?,?,?)'
    ).bind(user.id, name, now()));
  }
  for (const w of payload.watchlist || []) {
    if (!w?.uri) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO watchlist (user_id, uri, kind, name, art, spotify_id, added_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(user_id, uri) DO UPDATE SET
         kind=excluded.kind, name=excluded.name, art=excluded.art`
    ).bind(user.id, w.uri, w.kind || 'album', w.name || '', w.art || null,
           w.spotifyId || null, ts(w.addedAt) || now()));
  }
  if (stmts.length) await env.DB.batch(stmts);

  for (const raw of payload.bookmarks || []) {
    if (!raw || !(raw.key || raw.id)) continue;
    await upsertBookmark(env, user.id, await normaliseBookmark(env, user.id, raw));
  }

  // A tombstone always outranks a row that is no newer than it.
  await env.DB.prepare(
    `DELETE FROM bookmarks WHERE user_id = ? AND EXISTS (
       SELECT 1 FROM tombstones t WHERE t.user_id = bookmarks.user_id
         AND t.profile = bookmarks.profile AND t.key = bookmarks.key
         AND t.deleted_at >= bookmarks.updated_at)`
  ).bind(user.id).run();

  if (payload.settings) {
    const s = payload.settings;
    await env.DB.prepare(
      `UPDATE users SET mode = COALESCE(?, mode), rewind_sec = COALESCE(?, rewind_sec),
       pinned_device = ?, default_profile = COALESCE(?, default_profile) WHERE id = ?`
    ).bind(s.mode ?? null, s.rewindSec ?? null,
           s.pinnedDevice ? JSON.stringify(s.pinnedDevice) : null,
           s.defaultProfile ?? null, user.id).run();
    Object.assign(user, {
      mode: s.mode ?? user.mode,
      rewind_sec: s.rewindSec ?? user.rewind_sec,
      pinned_device: s.pinnedDevice ? JSON.stringify(s.pinnedDevice) : null,
      default_profile: s.defaultProfile ?? user.default_profile
    });
  }
}

/* ── Chapter maps ──────────────────────────────────────────────
   Fetched once, then served to every device of every user. Static data,
   so one user opening a Hörspiel warms it for everyone.
   ──────────────────────────────────────────────────────────── */

function partsEndpoint(uri) {
  const [, kind, id] = (uri || '').split(':');
  if (kind === 'album') return `/v1/albums/${id}/tracks`;
  if (kind === 'audiobook') return `/v1/audiobooks/${id}/chapters`;
  if (kind === 'show') return `/v1/shows/${id}/episodes`;
  return null;
}

async function containerMap(env, user, uri) {
  const cached = await env.DB.prepare('SELECT * FROM containers WHERE uri = ?')
    .bind(uri).first();
  if (cached) {
    return { totalMs: cached.total_ms, count: cached.part_count,
             tracks: JSON.parse(cached.parts) };
  }

  const endpoint = partsEndpoint(uri);
  if (!endpoint) return null;

  const mk = user.market ? '&market=' + user.market : '';
  const tracks = {};
  let total = 0, offset = 0, count = 0;

  try {
    while (offset < 400) {
      const page = await spotifyJSON(env, user, `${endpoint}?limit=50&offset=${offset}${mk}`);
      const items = (page?.items || []).filter(Boolean);
      for (const t of items) {
        tracks[t.uri] = { o: total, i: t.track_number ?? t.chapter_number ?? (count + 1) };
        total += t.duration_ms || 0;
        count++;
      }
      if (items.length < 50) break;
      offset += 50;
    }
  } catch (e) {
    return null;
  }
  if (!count) return null;

  await env.DB.prepare(
    `INSERT INTO containers (uri, total_ms, part_count, parts, fetched_at)
     VALUES (?,?,?,?,?) ON CONFLICT(uri) DO UPDATE SET
       total_ms=excluded.total_ms, part_count=excluded.part_count,
       parts=excluded.parts, fetched_at=excluded.fetched_at`
  ).bind(uri, total, count, JSON.stringify(tracks), now()).run();

  return { totalMs: total, count, tracks };
}

/** The display name of an audiobook, show or album. Spotify sometimes hands back
    a chapter with no parent object, leaving the chapter title where the book title
    belongs — so resolve it once and remember it. */
async function parentTitle(env, user, uri) {
  if (!uri) return null;
  const [, kind, id] = uri.split(':');
  if (!['audiobook', 'show', 'album'].includes(kind)) return null;

  const cached = await env.DB.prepare('SELECT * FROM titles WHERE uri = ?').bind(uri).first();
  if (cached) return { name: cached.name, art: cached.art, author: cached.author };

  const mk = user.market ? '?market=' + user.market : '';
  let obj = null;
  try { obj = await spotifyJSON(env, user, `/v1/${kind}s/${id}${mk}`); }
  catch (e) { return null; }
  if (!obj?.name) return null;

  const imgs = obj.images || [];
  const found = {
    name: obj.name,
    art: (imgs.length > 1 ? imgs[1] : imgs[0])?.url || null,
    author: obj.authors?.[0]?.name || obj.publisher || obj.artists?.[0]?.name || null
  };

  await env.DB.prepare(
    `INSERT INTO titles (uri, name, art, author, fetched_at) VALUES (?,?,?,?,?)
     ON CONFLICT(uri) DO UPDATE SET name=excluded.name, art=excluded.art,
       author=excluded.author, fetched_at=excluded.fetched_at`
  ).bind(uri, found.name, found.art, found.author, now()).run();

  return found;
}

/* ── Resume ────────────────────────────────────────────────────
   The whole point of having a server. A web page gets suspended the instant
   you switch to Spotify, so it can never see the device appear. This can.
   ──────────────────────────────────────────────────────────── */

/* An allowlist, not a blocklist: Spotify reports Echos variously as Speaker,
   CastAudio or Unknown, so anything not recognisably in your hand is treated as
   "somewhere else in the house". */
const NEAR = new Set(['Smartphone', 'Tablet', 'Computer', 'Automobile']);

/**
 * A speaker is always online, so it would otherwise win every race against a
 * phone that is still launching. While `eager` is set we refuse anything that
 * isn't handheld and keep waiting; only near the end of the window do we accept
 * whatever is left.
 */
function chooseDevice(devices, pinnedId, eager, hint) {
  const byActive = (a, b) => (b.is_active ? 1 : 0) - (a.is_active ? 1 : 0);

  if (pinnedId) {
    const exact = devices.find(d => d.id === pinnedId);
    if (exact) return exact;
    // Spotify mints a new device id on reinstall, so a remembered one can go
    // stale. Once the eager window closes, recover by device type instead of
    // failing outright.
    if (!eager && hint) {
      const sameKind = devices.filter(d => d.type === hint);
      if (sameKind.length) return [...sameKind].sort(byActive)[0];
    }
    return null;
  }

  // The caller tells us what it's running on, so a request from the phone goes
  // to the phone even when a laptop is also awake.
  if (hint) {
    const sameKind = devices.filter(d => d.type === hint);
    if (sameKind.length) return [...sameKind].sort(byActive)[0];
  }

  const near = devices.filter(d => NEAR.has(d.type));
  if (near.length) return [...near].sort(byActive)[0];

  return eager ? null : [...devices].sort(byActive)[0] || null;
}

async function doResume(env, user, { profile, key, device, hint }) {
  const wanted = profile || user.default_profile || 'Me';

  const row = key
    ? await env.DB.prepare(
        'SELECT * FROM bookmarks WHERE user_id = ? AND profile = ? AND key = ?'
      ).bind(user.id, wanted, key).first()
    : await env.DB.prepare(
        `SELECT * FROM bookmarks WHERE user_id = ? AND profile = ? AND archived = 0
         ORDER BY updated_at DESC LIMIT 1`
      ).bind(user.id, wanted).first();

  if (!row) return { ok: false, reason: 'nothing_saved' };

  const b = rowToBookmark(row);
  const rewind = (user.rewind_sec ?? 15) * 1000;
  const position = Math.max(0, b.positionMs - rewind);
  // An explicit device beats the pin, so one Shortcut can target the kitchen
  // speaker while the app still defaults to your phone.
  const pinned = device || (user.pinned_device ? JSON.parse(user.pinned_device)?.id : null);

  // Spotify takes a few seconds to register after launching. Wait it out.
  const GRACE = RESUME_TRIES - 5;      // after this, settle for anything

  for (let attempt = 0; attempt < RESUME_TRIES; attempt++) {
    let devices = [];
    try {
      const d = await spotifyJSON(env, user, '/v1/me/player/devices');
      devices = (d?.devices || []).filter(x => x.id);
    } catch (e) { /* transient; try again */ }

    const target = chooseDevice(devices, pinned, attempt < GRACE, hint);

    if (target) {

      if (!target.is_active) {
        try {
          await spotify(env, user, '/v1/me/player', {
            method: 'PUT',
            body: JSON.stringify({ device_ids: [target.id], play: false })
          });
          await sleep(500);
        } catch (e) {}
      }

      const payload = b.contextURI
        ? { context_uri: b.contextURI, offset: { uri: b.trackURI }, position_ms: position }
        : { uris: [b.trackURI], position_ms: position };

      let res = await spotify(env, user, `/v1/me/player/play?device_id=${target.id}`,
        { method: 'PUT', body: JSON.stringify(payload) });

      // Shows and audiobooks don't always accept a context.
      if (!res.ok && (res.status === 400 || res.status === 404) && b.contextURI) {
        res = await spotify(env, user, `/v1/me/player/play?device_id=${target.id}`, {
          method: 'PUT',
          body: JSON.stringify({ uris: [b.trackURI], position_ms: position })
        });
      }

      if (res.ok || res.status === 204) {
        // Playing on one device doesn't always wrest control from another that was
        // already going. Verify, and take over properly if it didn't land.
        await sleep(700);
        try {
          const nowOn = await spotifyJSON(env, user, '/v1/me/player');
          if (nowOn?.device?.id && nowOn.device.id !== target.id) {
            await spotify(env, user, '/v1/me/player', {
              method: 'PUT',
              body: JSON.stringify({ device_ids: [target.id], play: true })
            });
            await sleep(400);
            await spotify(env, user, `/v1/me/player/play?device_id=${target.id}`,
              { method: 'PUT', body: JSON.stringify(payload) });
          }
        } catch (e) { /* best effort; playback already started somewhere */ }

        // Hand the resolved id back so the caller can remember it, and refresh
        // its copy when the id has changed underneath us.
        return { ok: true, device: target.name, deviceId: target.id,
                 album: b.albumName, positionMs: position,
                 waitedMs: attempt * RESUME_GAP_MS };
      }
      if (res.status === 403) return { ok: false, reason: 'premium_required' };
    }
    await sleep(RESUME_GAP_MS);
  }

  return { ok: false, reason: pinned ? 'pinned_offline' : 'no_device' };
}

/* ── Recording playback ────────────────────────────────────── */

/**
 * Normalises a track, a podcast episode or an audiobook chapter into one shape.
 *
 * Audiobook chapters are the awkward case: they carry `spotify:episode:` URIs and
 * `"type": "episode"`, so they are indistinguishable from podcast episodes unless
 * either the item has an `audiobook` field or the playback context says
 * `spotify:audiobook:`. Missing that made every chapter its own bookmark instead
 * of one bookmark for the book.
 */
function describeItem(d) {
  const it = d.item;
  if (!it) return null;

  const contextURI = d.context?.uri || null;
  const contextKind = (contextURI || '').split(':')[1] || null;
  const isAudiobook = !!it.audiobook || contextKind === 'audiobook';

  const parent = it.album || it.audiobook || it.show || null;
  const imgs = it.images || parent?.images || [];
  const people = it.artists || it.authors || parent?.authors || [];

  const kind = it.type === 'chapter' || isAudiobook ? 'chapter'
             : it.type === 'episode' ? 'episode'
             : 'track';

  // Without a parent object, the context is the only handle on the whole work.
  const groupURI = parent?.uri
    || (contextKind === 'audiobook' || contextKind === 'show' || contextKind === 'album'
        ? contextURI : null);

  return {
    trackURI: it.uri,
    trackName: it.name,
    trackNumber: it.track_number ?? it.chapter_number ?? null,
    durationMs: it.duration_ms || 0,
    positionMs: d.progress_ms || 0,
    isPlaying: !!d.is_playing,
    contextURI,
    albumURI: groupURI,
    albumName: parent?.name || it.name,
    artistName: people[0]?.name || parent?.publisher || '',
    artistURI: people[0]?.uri || null,
    art: (imgs.length > 1 ? imgs[1] : imgs[0])?.url || null,
    kind
  };
}

function watchMatches(np, watchlist) {
  const has = (s, n) => (s || '').toLowerCase().includes((n || '').toLowerCase());
  return watchlist.some(w => {
    if (w.kind === 'artist') return w.uri === np.artistURI || has(np.artistName, w.name);
    if (w.kind === 'playlist') return w.uri === np.contextURI;
    if (w.kind === 'keyword') {
      return has(np.albumName, w.name) || has(np.artistName, w.name) || has(np.trackName, w.name);
    }
    return w.uri === np.albumURI || w.uri === np.contextURI;
  });
}

const HISTORY_GAP_MS = 4 * 60 * 1000;

function pushHistory(history, entry) {
  const list = [...(history || [])];
  const sample = { t: entry.updatedAt, p: entry.positionMs, u: entry.trackURI, n: entry.trackNumber };
  const last = list[list.length - 1];
  if (last && last.u === sample.u && ts(sample.t) - ts(last.t) < HISTORY_GAP_MS) {
    list[list.length - 1] = sample;
  } else {
    list.push(sample);
  }
  return list.slice(-24);
}

/** One poll for one user. Shared by the cron and the app's own refresh. */
async function recordNowPlaying(env, user) {
  let data;
  try {
    data = await spotifyJSON(env, user, '/v1/me/player?additional_types=track,episode');
  } catch (e) {
    return { recorded: false, reason: 'spotify_error' };
  }
  if (!data) return { recorded: false, reason: 'idle' };

  const np = describeItem(data);
  if (!np) {
    // Spotify withholds `item` for some content. Say which kind, so this is
    // diagnosable from the logs instead of looking like silence.
    return { recorded: false,
             reason: `no_item (playing type: ${data.currently_playing_type || 'unknown'})` };
  }

  if ((user.mode || 'everything') === 'watchlist') {
    const wl = await env.DB.prepare('SELECT * FROM watchlist WHERE user_id = ?')
      .bind(user.id).all();
    const list = (wl.results || []).map(w => ({ kind: w.kind, uri: w.uri, name: w.name }));
    if (!watchMatches(np, list)) return { recorded: false, reason: 'not_watched' };
  }

  // No parent object means albumName fell back to the chapter title. Fix it up.
  if (np.albumURI && np.albumName === np.trackName) {
    const parent = await parentTitle(env, user, np.albumURI);
    if (parent) {
      np.albumName = parent.name;
      np.art = np.art || parent.art;
      np.artistName = np.artistName || parent.author || '';
    }
  }

  const profile = user.default_profile || 'Me';
  // Recover the parent before keying, or a transient gap starts a new bookmark.
  np.albumURI = await resolveParent(env, user, np) || np.albumURI;
  const bookSeries = await isBookSeries(env, user.id, np.albumURI);
  const key = bookmarkKey(np, bookSeries);

  const existing = await env.DB.prepare(
    'SELECT * FROM bookmarks WHERE user_id = ? AND profile = ? AND key = ?'
  ).bind(user.id, profile, key).first();

  // Don't let a restart at 0:01 clobber a good position.
  if (existing && existing.track_uri === np.trackURI
      && np.positionMs < 3000 && existing.position_ms > 10000) {
    return { recorded: false, reason: 'restart_guard' };
  }
  if (!existing && np.positionMs < 3000 && !np.isPlaying) {
    return { recorded: false, reason: 'too_early' };
  }

  const entry = {
    profile, key,
    albumName: np.albumName, artistName: np.artistName, art: np.art,
    albumURI: np.albumURI, contextURI: np.contextURI, trackURI: np.trackURI,
    trackName: np.trackName, trackNumber: np.trackNumber,
    positionMs: np.positionMs, durationMs: np.durationMs, kind: np.kind,
    wholeSeries: existing?.whole_series === null || existing?.whole_series === undefined
      ? undefined : !!existing.whole_series,
    archived: false,
    updatedAt: new Date().toISOString()
  };
  entry.history = pushHistory(JSON.parse(existing?.history || '[]'), entry);

  await upsertBookmark(env, user.id, entry);
  return { recorded: true, album: np.albumName, track: np.trackName, positionMs: np.positionMs };
}

async function pollAll(env) {
  const users = await env.DB.prepare(
    // Skip accounts nobody has opened in three months.
    'SELECT * FROM users WHERE last_seen > ?'
  ).bind(now() - 90 * 864e5).all();

  const list = users.results || [];
  if (!list.length) { console.log('cron: no active users'); return; }

  for (const user of list) {
    try {
      // Record first, then pause — so the bookmark lands before playback stops.
      const r = await recordNowPlaying(env, user);
      console.log(`cron ${user.id}:`, r.recorded
        ? `saved "${r.album}" at ${Math.round(r.positionMs / 1000)}s`
        : r.reason);

      if (user.sleep_until && now() >= user.sleep_until) {
        await spotify(env, user, '/v1/me/player/pause', { method: 'PUT' });
        await env.DB.prepare('UPDATE users SET sleep_until = NULL WHERE id = ?')
          .bind(user.id).run();
        console.log(`cron ${user.id}: sleep timer paused playback`);
      }
    } catch (e) {
      console.log('cron failed for', user.id, e.message);
    }
  }
}

/* ── Router ────────────────────────────────────────────────── */

async function router(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  if (path === '/auth/login') return handleLogin(env, url);
  if (path === '/auth/callback') return handleCallback(env, url);

  if (path === '/health') {
    return json({ ok: true, build: BUILD, time: new Date().toISOString() }, env);
  }

  /* Shortcut / Siri entry point. A bare GET so Shortcuts can just fetch a URL,
     authenticated by a long random key rather than a session. */
  if (path === '/resume') {
    const user = await userFromShortcutKey(env, url.searchParams.get('key'));
    if (!user) return fail(env, 401, 'bad key');

    const profile = url.searchParams.get('profile') || undefined;
    const key = url.searchParams.get('id') || undefined;
    // Lets a lock-screen Shortcut target an always-on speaker, which needs no
    // unlocking because nothing has to be launched.
    const device = url.searchParams.get('device') || undefined;
    const hint = url.searchParams.get('hint') || undefined;

    // Answer instantly so Siri isn't left hanging; keep working in the background.
    ctx.waitUntil(doResume(env, user, { profile, key, device, hint }));
    return json({ ok: true, queued: true, message: 'Resuming…' }, env);
  }

  if (!path.startsWith('/api/')) return fail(env, 404, 'not found');

  const user = await userFromSession(env, request);
  if (!user) return fail(env, 401, 'not signed in');

  /* Spotify passthrough: /api/spotify/v1/... */
  if (path.startsWith('/api/spotify/')) {
    const target = path.slice('/api/spotify'.length) + (url.search || '');
    return handleProxy(env, user, request, target);
  }

  if (path === '/api/state' && request.method === 'GET') {
    return json(await loadState(env, user), env);
  }

  if (path === '/api/sync' && request.method === 'POST') {
    const payload = await request.json().catch(() => ({}));
    console.log(`/api/sync from ${user.id} [${request.headers.get('X-App-Build') || 'build unknown'}]`
      + `: ${(payload.bookmarks || []).length} bookmarks`);
    await applySync(env, user, payload);
    return json(await loadState(env, user), env);
  }

  if (path === '/api/bookmark' && request.method === 'POST') {
    const b = await request.json().catch(() => null);
    if (!b) return fail(env, 400, 'bad body');
    console.log(`/api/bookmark from ${user.id}: key=${b.key || b.id}`);
    await upsertBookmark(env, user.id, await normaliseBookmark(env, user.id, b));
    return json({ ok: true }, env);
  }

  if (path === '/api/parent' && request.method === 'GET') {
    const track = url.searchParams.get('track');
    if (!track) return fail(env, 400, 'track required');
    const uri = await resolveParent(env, user, { trackURI: track, kind: 'episode' });
    return json({ uri: uri || null }, env);
  }

  if (path === '/api/title' && request.method === 'GET') {
    const uri = url.searchParams.get('uri');
    if (!uri) return fail(env, 400, 'uri required');
    return json(await parentTitle(env, user, uri) || { failed: true }, env);
  }

  if (path === '/api/container' && request.method === 'GET') {
    const uri = url.searchParams.get('uri');
    if (!uri) return fail(env, 400, 'uri required');
    const map = await containerMap(env, user, uri);
    return json(map || { failed: true }, env);
  }

  if (path === '/api/poll' && request.method === 'POST') {
    return json(await recordNowPlaying(env, user), env);
  }

  if (path === '/api/resume' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    ctx.waitUntil(doResume(env, user, body));
    return json({ ok: true, queued: true }, env);
  }

  /* Blocking variant, for the app's own button — it wants the outcome. */
  if (path === '/api/resume-sync' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return json(await doResume(env, user, body), env);
  }

  if (path === '/api/transfer' && request.method === 'POST') {
    const { deviceId } = await request.json().catch(() => ({}));
    if (!deviceId) return fail(env, 400, 'deviceId required');

    const res = await spotify(env, user, '/v1/me/player', {
      method: 'PUT',
      body: JSON.stringify({ device_ids: [deviceId], play: true })
    });
    if (!res.ok && res.status !== 204) {
      return json({ ok: false, status: res.status }, env);
    }
    return json({ ok: true }, env);
  }

  if (path === '/api/debug/player' && request.method === 'GET') {
    let raw = null, error = null;
    try { raw = await spotifyJSON(env, user, '/v1/me/player?additional_types=track,episode'); }
    catch (e) { error = e.message; }

    const it = raw?.item;
    return json({
      error,
      empty: !raw,
      currentlyPlayingType: raw?.currently_playing_type || null,
      hasItem: !!it,
      itemType: it?.type || null,
      itemUri: it?.uri || null,
      itemName: it?.name || null,
      contextUri: raw?.context?.uri || null,
      contextType: raw?.context?.type || null,
      parentFields: it ? {
        album: it.album?.uri || null,
        show: it.show?.uri || null,
        audiobook: it.audiobook?.uri || null
      } : null,
      chapterNumber: it?.chapter_number ?? null,
      trackNumber: it?.track_number ?? null,
      durationMs: it?.duration_ms ?? null,
      progressMs: raw?.progress_ms ?? null,
      interpreted: it ? describeItem(raw) : null
    }, env);
  }

  /* Marking a show as a book also merges the per-episode rows it already made:
     the furthest-along one becomes the book's bookmark, the rest are tombstoned
     so other devices don't push them back. */
  if (path === '/api/series-mode' && request.method === 'POST') {
    const { uri, mode } = await request.json().catch(() => ({}));
    if (!uri || !['book', 'episodes'].includes(mode)) {
      return fail(env, 400, 'uri and mode (book|episodes) required');
    }

    await env.DB.prepare(
      `INSERT INTO series_mode (user_id, uri, mode, set_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id, uri) DO UPDATE SET mode=excluded.mode, set_at=excluded.set_at`
    ).bind(user.id, uri, mode, now()).run();

    let merged = 0;
    if (mode === 'book') {
      const strays = await env.DB.prepare(
        `SELECT * FROM bookmarks
         WHERE user_id = ? AND album_uri = ? AND "key" <> ?
         ORDER BY updated_at DESC`
      ).bind(user.id, uri, uri).all();

      const rows = strays.results || [];
      if (rows.length) {
        // Most recently touched wins; it is the furthest you actually got.
        const keep = rows[0];
        await upsertBookmark(env, user.id, {
          ...rowToBookmark(keep),
          key: uri,
          kind: 'chapter',
          wholeSeries: true,
          updatedAt: new Date(keep.updated_at).toISOString()
        });

        const stmts = [];
        for (const r of rows) {
          stmts.push(env.DB.prepare(
            'DELETE FROM bookmarks WHERE user_id = ? AND profile = ? AND "key" = ?'
          ).bind(user.id, r.profile, r.key));
          stmts.push(env.DB.prepare(
            `INSERT INTO tombstones (user_id, profile, "key", deleted_at) VALUES (?,?,?,?)
             ON CONFLICT(user_id, profile, "key") DO UPDATE SET deleted_at=excluded.deleted_at`
          ).bind(user.id, r.profile, r.key, now()));
        }
        await env.DB.batch(stmts);
        merged = rows.length;
      }
    }

    const state = await loadState(env, user);
    return json({ ...state, merged }, env);
  }

  if (path === '/api/sleep' && request.method === 'POST') {
    const { minutes } = await request.json().catch(() => ({}));
    const until = minutes > 0 ? now() + minutes * 60000 : null;
    await env.DB.prepare('UPDATE users SET sleep_until = ? WHERE id = ?')
      .bind(until, user.id).run();
    return json({ sleepUntil: until }, env);
  }

  /* Renaming moves every row, because a bookmark's identity includes its owner. */
  if (path === '/api/profile/rename' && request.method === 'POST') {
    const { from, to } = await request.json().catch(() => ({}));
    const target = (to || '').trim();
    if (!from || !target) return fail(env, 400, 'from and to required');
    if (from === target) return json({ ok: true }, env);

    const clash = await env.DB.prepare(
      'SELECT 1 FROM profiles WHERE user_id = ? AND name = ?'
    ).bind(user.id, target).first();
    if (clash) return fail(env, 409, 'a profile with that name already exists');

    await env.DB.batch([
      env.DB.prepare('UPDATE bookmarks SET profile = ? WHERE user_id = ? AND profile = ?')
        .bind(target, user.id, from),
      env.DB.prepare('UPDATE tombstones SET profile = ? WHERE user_id = ? AND profile = ?')
        .bind(target, user.id, from),
      env.DB.prepare('INSERT OR IGNORE INTO profiles (user_id, name, added_at) VALUES (?,?,?)')
        .bind(user.id, target, now()),
      env.DB.prepare('DELETE FROM profiles WHERE user_id = ? AND name = ?')
        .bind(user.id, from),
      env.DB.prepare(
        'UPDATE users SET default_profile = ? WHERE id = ? AND default_profile = ?'
      ).bind(target, user.id, from)
    ]);

    return json(await loadState(env, user), env);
  }

  if (path === '/api/logout' && request.method === 'POST') {
    const auth = request.headers.get('Authorization') || '';
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?')
      .bind(auth.slice(7)).run();
    return json({ ok: true }, env);
  }

  if (path === '/api/shortcut-key' && request.method === 'POST') {
    const key = randomHex(20);
    await env.DB.prepare('UPDATE users SET shortcut_key = ? WHERE id = ?')
      .bind(key, user.id).run();
    return json({ shortcutKey: key }, env);
  }

  return fail(env, 404, 'not found');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await router(request, env, ctx);
    } catch (e) {
      return json({ error: e.message || 'worker error' }, env, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAll(env));
  }
};
