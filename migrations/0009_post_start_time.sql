-- Approve and post: the time the day 0 posts (the video) go out, HH:MM Eastern. The rest of the week stays at 11:30.
ALTER TABLE posts ADD COLUMN start_time TEXT;
