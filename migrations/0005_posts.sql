-- Approve and post: one row per campaign built on the New video screen. Holds the landing page copy and
-- the social captions people edit, and what the desktop reported back (preview link, live page, posts).
CREATE TABLE posts (
  campaign TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  source_job TEXT NOT NULL,                 -- the video whose render gets posted
  variant TEXT NOT NULL,
  slug TEXT,                                -- blog.beegraphix.com/<slug>; programs link to their own page instead
  copy TEXT NOT NULL,                       -- JSON {page: {...}, captions: {...}}
  start_date TEXT,                          -- YYYY-MM-DD the posts go out
  task_job TEXT,                            -- the desktop job building the preview or publishing
  task_kind TEXT,                           -- page | publish
  preview_url TEXT,
  live_url TEXT,
  posted TEXT,                              -- JSON from the desktop: which posts were scheduled
  approved_by TEXT,
  approved_at TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX posts_slug ON posts (slug) WHERE slug IS NOT NULL;
