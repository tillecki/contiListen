-- ContiListen storage.
-- Row-level, so two devices touching different series can never collide.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,        -- Spotify user id
  display_name    TEXT,
  refresh_token   TEXT NOT NULL,           -- never leaves the Worker
  access_token    TEXT,
  token_expires   INTEGER DEFAULT 0,
  market          TEXT,                    -- country, for shows and audiobooks
  shortcut_key    TEXT UNIQUE NOT NULL,    -- what the Siri Shortcut carries
  default_profile TEXT DEFAULT 'Me',       -- whose bookmarks the cron records
  mode            TEXT DEFAULT 'everything',
  rewind_sec      INTEGER DEFAULT 15,
  pinned_device   TEXT,
  created_at      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Short-lived CSRF guard for the OAuth round trip.
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile      TEXT NOT NULL,
  key          TEXT NOT NULL,             -- album / audiobook / episode URI
  album_name   TEXT,
  artist_name  TEXT,
  art          TEXT,
  album_uri    TEXT,
  context_uri  TEXT,
  track_uri    TEXT,
  track_name   TEXT,
  track_number INTEGER,
  position_ms  INTEGER DEFAULT 0,
  duration_ms  INTEGER DEFAULT 0,
  kind         TEXT DEFAULT 'track',
  whole_series INTEGER,                   -- NULL = derive from kind
  archived     INTEGER DEFAULT 0,
  history      TEXT DEFAULT '[]',         -- JSON breadcrumb trail
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile, key)
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_recent ON bookmarks(user_id, profile, updated_at DESC);

-- Deletions have to travel, or another device just puts the row back.
CREATE TABLE IF NOT EXISTS tombstones (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile    TEXT NOT NULL,
  key        TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile, key)
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uri        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  name       TEXT,
  art        TEXT,
  spotify_id TEXT,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, uri)
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
);

-- Album and audiobook chapter maps, shared by every device of every user.
-- Static data, so one fetch serves everyone forever.
CREATE TABLE IF NOT EXISTS containers (
  uri        TEXT PRIMARY KEY,
  total_ms   INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  parts      TEXT NOT NULL,               -- JSON { trackUri: {o, i} }
  fetched_at INTEGER NOT NULL
);
