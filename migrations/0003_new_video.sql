-- Stage 3, part 2: the New video screen.

-- Footage and product photos staff upload from the browser. The file itself is in R2 at r2_key;
-- the desktop downloads it when it builds the campaign.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- footage | photo
  name TEXT NOT NULL,                       -- the file's name on the person's computer
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  upload_id TEXT,                           -- R2 multipart upload while it's still coming in
  status TEXT NOT NULL,                     -- uploading | ready
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- One row per "Draft it for me", so one person can't run up the Claude bill.
CREATE TABLE ai_calls (
  who TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX ai_calls_who_at ON ai_calls (who, at);
