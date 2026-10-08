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
