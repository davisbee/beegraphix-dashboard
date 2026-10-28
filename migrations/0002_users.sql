-- Stage 3: staff logins and the list of campaigns the desktop can render.

-- One row per person. brand "*" sees every brand (Davis); role admin may add and manage people.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,                      -- beegraphix | rugbee | *
  role TEXT NOT NULL DEFAULT 'staff',       -- staff | admin
  pw_hash TEXT NOT NULL,                    -- PBKDF2-SHA256, hex
  pw_salt TEXT NOT NULL,                    -- hex
  pw_iters INTEGER NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1,   -- 1 until they replace the temporary password
  disabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

-- Signed-in browsers. Only a SHA-256 of the cookie value is stored.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Campaigns on AI-DESKTOP and their variants, as the desktop last reported them.
CREATE TABLE catalog (
  brand TEXT NOT NULL,
  campaign TEXT NOT NULL,
  title TEXT NOT NULL,
  variants TEXT NOT NULL,                   -- JSON [{"id","label"}]
  updated_at TEXT NOT NULL,
  PRIMARY KEY (brand, campaign)
);
