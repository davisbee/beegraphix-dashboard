-- Performance tracking, step 2 (YouTube): the dashboard reads a platform itself, with a login an admin connects once.
-- Shaped for every platform, so Facebook, Instagram and TikTok can move here later the same way.

-- One connected account per brand and platform. The refresh token is encrypted with the CONNECTIONS_KEY secret.
CREATE TABLE platform_connections (
  brand TEXT NOT NULL,
  platform TEXT NOT NULL,                   -- youtube | facebook | instagram | tiktok | linkedin
  account_id TEXT NOT NULL,                 -- the platform's id for it (YouTube: the channel id)
  account_name TEXT,
  token TEXT NOT NULL,                      -- AES-GCM, base64 "iv.ciphertext"
  scopes TEXT,
  connected_by TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  last_pull_at TEXT,
  last_error TEXT,                          -- set when a pull fails, e.g. the login was taken back; cleared on success
  PRIMARY KEY (brand, platform)
);

-- A sign-in that's under way: the random state Google sends back, good for 10 minutes.
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The platform's own id and link for a post once it's out (YouTube: the video id), so its numbers can be read.
ALTER TABLE post_features ADD COLUMN platform_post_id TEXT;
ALTER TABLE post_features ADD COLUMN platform_url TEXT;
ALTER TABLE post_features ADD COLUMN matched_by TEXT;  -- highlevel | title_time

-- Numbers every platform can fill. reading also takes "latest": refreshed each day for 30 days, replaced each time.
ALTER TABLE post_stats ADD COLUMN likes INTEGER;
ALTER TABLE post_stats ADD COLUMN avg_view_seconds REAL;
