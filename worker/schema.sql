-- Resonance: D1 schema for music-discovery-db
-- Apply once. Safe to re-run: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_name   TEXT    NOT NULL,
  spotify_id    TEXT,
  verdict       TEXT    NOT NULL CHECK (verdict IN ('up', 'down')),
  mood          TEXT,
  genres        TEXT,                       -- JSON array of strings
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS feedback_tags (
  feedback_id   INTEGER NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  tag           TEXT    NOT NULL,
  PRIMARY KEY (feedback_id, tag)
);

CREATE TABLE IF NOT EXISTS recommendation_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_name   TEXT    NOT NULL,
  spotify_id    TEXT,
  reason        TEXT,
  mood          TEXT,
  shown_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_verdict     ON feedback(verdict);
CREATE INDEX IF NOT EXISTS idx_feedback_artist      ON feedback(artist_name);
CREATE INDEX IF NOT EXISTS idx_tags_tag             ON feedback_tags(tag);
CREATE INDEX IF NOT EXISTS idx_log_artist           ON recommendation_log(artist_name);
CREATE INDEX IF NOT EXISTS idx_log_shown            ON recommendation_log(shown_at);

-- Shelf support (added after initial deploy; already applied to the live database)
-- ALTER TABLE recommendation_log ADD COLUMN status TEXT NOT NULL DEFAULT 'active';   -- active | rated | dismissed
-- ALTER TABLE recommendation_log ADD COLUMN image_url TEXT;
-- ALTER TABLE recommendation_log ADD COLUMN spotify_url TEXT;
-- ALTER TABLE recommendation_log ADD COLUMN genres TEXT;
CREATE INDEX IF NOT EXISTS idx_log_status ON recommendation_log(status);

-- Listening diary: one row per play, copied from recently-played on every open
CREATE TABLE IF NOT EXISTS plays (
  played_at     TEXT PRIMARY KEY,
  track_id      TEXT,
  track_name    TEXT NOT NULL,
  artist_id     TEXT,
  artist_name   TEXT NOT NULL,
  album_name    TEXT,
  release_date  TEXT,
  duration_ms   INTEGER,
  image_url     TEXT
);
CREATE INDEX IF NOT EXISTS idx_plays_artist ON plays(artist_id);

-- Genre labels per artist, written once by Claude (Spotify's genres field is being emptied)
CREATE TABLE IF NOT EXISTS artist_genres (
  artist_id     TEXT PRIMARY KEY,
  artist_name   TEXT NOT NULL,
  genres        TEXT NOT NULL,              -- JSON array, most defining first
  source        TEXT NOT NULL DEFAULT 'claude',
  labeled_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Device keys (hashed), the encrypted Spotify token, and the Claude call ledger
CREATE TABLE IF NOT EXISTS settings  (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS devices   (key_hash TEXT PRIMARY KEY, label TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_seen TEXT);
CREATE TABLE IF NOT EXISTS api_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX IF NOT EXISTS idx_api_calls_at ON api_calls(at);
