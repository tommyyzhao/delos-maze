CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  ticks INTEGER NOT NULL,
  physics TEXT NOT NULL,
  replay BLOB NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_rank ON runs (physics, ticks, id);
-- Rate limit: last attempt per salted IP hash (no raw IPs stored).
CREATE TABLE IF NOT EXISTS attempts (ip_hash TEXT PRIMARY KEY, at INTEGER NOT NULL);
