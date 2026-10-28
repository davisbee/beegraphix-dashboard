-- "Forgot your password?" by email: one row per reset link sent. Only a SHA-256 of the link's token is stored.
-- A link works once, for an hour.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX password_resets_user ON password_resets (user_id, created_at);
