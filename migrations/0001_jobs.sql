-- One row per video job. AI-DESKTOP claims queued jobs, renders them and uploads the MP4 to R2.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,                      -- brand kit id in the Content Factory (beegraphix, rugbee)
  kind TEXT NOT NULL DEFAULT 'render',
  payload TEXT NOT NULL,                    -- JSON, for kind=render: {"campaign","variant","draft"}
  status TEXT NOT NULL,                     -- queued | claimed | rendering | uploading | done | failed | cancelled
  message TEXT,                             -- last status line or error from the desktop
  progress REAL,                            -- 0..1 while rendering
  attempts INTEGER NOT NULL DEFAULT 0,
  output_key TEXT,                          -- R2 key of the finished video
  output_bytes INTEGER,
  upload_id TEXT,                           -- R2 multipart upload in progress
  created_by TEXT,                          -- which submit token (brand label) created it
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_at TEXT,
  heartbeat_at TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_status_created ON jobs (status, created_at);
CREATE INDEX jobs_brand_created ON jobs (brand, created_at);
