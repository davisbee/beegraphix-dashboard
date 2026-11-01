-- Performance tracking, step 1: get the data in. Nothing reads these to make decisions yet.

-- The day and time the rotation offered, so a person's override can be told apart from the rotation later.
ALTER TABLE posts ADD COLUMN suggested_start TEXT;
ALTER TABLE posts ADD COLUMN suggested_time TEXT;

-- One row per post sent to HighLevel: what made the video and the post different. Saved when the post is scheduled.
CREATE TABLE post_features (
  campaign TEXT NOT NULL,
  item_key TEXT NOT NULL,                   -- the plan step: d0-reel, d1-teaser-1, ...
  platform TEXT NOT NULL,
  job_id TEXT NOT NULL,                     -- the video job; also utm_id on the tracking link
  brand TEXT NOT NULL,
  post_type TEXT,                           -- reel | post | story
  day_offset INTEGER,
  template TEXT,
  goal TEXT NOT NULL,                       -- reach | target | sell
  audience TEXT,
  hook_text TEXT,
  length_seconds REAL,
  presenter TEXT,
  presenter_mode TEXT,                      -- self | heygen | none
  look TEXT,
  caption_style TEXT,
  scheduled_at TEXT,                        -- UTC
  slot TEXT,                                -- morning | lunch | after_school | evening (Eastern)
  weekday INTEGER,                          -- 0 = Sunday (Eastern)
  time_source TEXT NOT NULL,                -- rotation | picked
  tracking_url TEXT,
  ghl_post_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (campaign, item_key, platform)
);
CREATE INDEX post_features_job ON post_features (job_id);
CREATE INDEX post_features_ghl ON post_features (ghl_post_id);

-- Where each platform stood before anything changed. Filled once the platform connections exist.
CREATE TABLE platform_baseline (
  brand TEXT NOT NULL,
  platform TEXT NOT NULL,
  as_of TEXT NOT NULL,                      -- YYYY-MM-DD the numbers describe
  followers INTEGER,
  avg_views REAL,
  posts_counted INTEGER,
  source TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  PRIMARY KEY (brand, platform, as_of)
);

-- A post's numbers at each reading. Old posts come in as "backfill" with no job_id. Filled once the connections exist.
CREATE TABLE post_stats (
  source TEXT NOT NULL,                     -- which connection reported it (meta, highlevel, ...)
  post_id TEXT NOT NULL,                    -- that connection's id for the post
  reading TEXT NOT NULL,                    -- 48h | 7d | backfill
  brand TEXT NOT NULL,
  platform TEXT NOT NULL,
  job_id TEXT,
  posted_at TEXT,
  read_at TEXT NOT NULL,
  views INTEGER,
  watch_seconds REAL,
  shares INTEGER,
  comments INTEGER,
  saves INTEGER,
  link_clicks INTEGER,
  new_followers INTEGER,
  leads INTEGER,
  orders INTEGER,
  boosted INTEGER NOT NULL DEFAULT 0,       -- 1 = paid, so it doesn't count as organic
  PRIMARY KEY (source, post_id, reading)
);
CREATE INDEX post_stats_job ON post_stats (job_id);
