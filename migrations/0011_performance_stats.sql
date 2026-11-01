-- Performance tracking, step 2: pull the numbers in and score them.

-- Ties a reading to the post it belongs to (old posts have none).
ALTER TABLE post_stats ADD COLUMN item_key TEXT;
CREATE INDEX post_stats_post ON post_stats (job_id, platform, item_key, reading);

-- Paid posts, marked by a person on the Performance tab. They stay out of the organic scores.
ALTER TABLE post_features ADD COLUMN boosted INTEGER NOT NULL DEFAULT 0;

-- Visits and quote requests the landing pages report for a tracking link. Counts only, nothing about the person.
CREATE TABLE link_events (
  job_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  item_key TEXT NOT NULL,
  event TEXT NOT NULL,                      -- click | lead
  count INTEGER NOT NULL DEFAULT 0,
  last_at TEXT NOT NULL,
  PRIMARY KEY (job_id, platform, item_key, event)
);

-- HighLevel's Social Planner stats: per account for the last 7 days, not per post. Kept as HighLevel sends them.
CREATE TABLE account_stats (
  brand TEXT NOT NULL,
  as_of TEXT NOT NULL,                      -- YYYY-MM-DD
  source TEXT NOT NULL,
  raw TEXT NOT NULL,                        -- JSON
  taken_at TEXT NOT NULL,
  PRIMARY KEY (brand, as_of, source)
);
