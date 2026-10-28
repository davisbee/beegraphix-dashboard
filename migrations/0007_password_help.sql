-- "Forgot your password?" on the sign-in page: when someone asks, their row is marked so admins see it on the Team
-- page and can give them a new temporary password with one click. Cleared once they have a working password again.
ALTER TABLE users ADD COLUMN reset_requested_at TEXT;
