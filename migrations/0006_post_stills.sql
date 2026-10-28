-- The social images the desktop made with a post's last preview (names like carousel-1, teaser-1-feed),
-- stored in R2 at stills/<campaign>/<name>.png, so the dashboard can show every post before approval.
ALTER TABLE posts ADD COLUMN stills TEXT;
ALTER TABLE posts ADD COLUMN stills_at TEXT;
