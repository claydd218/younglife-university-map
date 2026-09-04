-- Adds per-user admin accounts on top of the original D1 migration
-- (scripts/schema.sql). Run the same way that one was: validate locally
-- first, then apply to the remote database.
--
--   wrangler d1 execute younglife-map-db --local --file=scripts/schema-users.sql
--   wrangler d1 execute younglife-map-db --remote --file=scripts/schema-users.sql

CREATE TABLE admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  login         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- Nullable: existing ministry_edits rows predate per-user accounts and
-- have no author to attribute; the Log tab shows those as "—".
ALTER TABLE ministry_edits ADD COLUMN user_name TEXT;
