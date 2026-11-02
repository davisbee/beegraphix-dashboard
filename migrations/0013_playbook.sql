-- Performance tracking, the playbook: findings from the weekly report that an admin approved or rejected.
-- Approved hook and template rules go into "Draft it for me" for that brand and goal (src/playbook.ts).

CREATE TABLE playbook (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  goal TEXT NOT NULL,                       -- reach | target | sell
  dimension TEXT NOT NULL,                  -- template | hook | slot | weekday | platform
  key TEXT NOT NULL,                        -- what it's about: the template's name, the hook, the time of day, ...
  status TEXT NOT NULL,                     -- approved | rejected | retired
  rule TEXT,                                -- the line Draft it for me gets, as the admin approved it
  note TEXT,
  score_at INTEGER,                         -- the finding's score and post count when it was decided
  posts_at INTEGER,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  retired_by TEXT,
  retired_at TEXT
);
-- One decision per finding. Deciding again (say, after it was retired) replaces it.
CREATE UNIQUE INDEX playbook_finding ON playbook (brand, goal, dimension, key);
