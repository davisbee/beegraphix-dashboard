-- Remove a video: an admin takes a finished video (and its unapproved page and posts) off the Videos list.
-- Nothing is erased, so Restore puts it back. A video whose posts went out can't be removed (src/index.ts).

ALTER TABLE jobs ADD COLUMN removed_at TEXT;
ALTER TABLE jobs ADD COLUMN removed_by TEXT;
