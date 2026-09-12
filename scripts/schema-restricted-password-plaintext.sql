-- Switches restricted_access.password_hash (PBKDF2 hash) to a plain
-- password column — the admin UI now shows the current restricted-access
-- password back (no more "leave blank to keep the current one"), which
-- only works if it's stored in a readable form. Same tradeoff
-- SITE_SHARED_PASSWORD (a Worker secret, also plain) already makes: this
-- is one shared, low-stakes password gating a subset of otherwise-public
-- map data, not a real per-user login credential — see
-- worker/lib/db/restrictedAccess.js's own comment.
--
-- The existing password_hash value (if any) is NOT migrated — a PBKDF2
-- hash can't be reversed back into the real password, so whatever was
-- previously set just needs to be re-entered once via the admin UI after
-- this runs.
--
--   wrangler d1 execute younglife-map-db --local --file=scripts/schema-restricted-password-plaintext.sql
--   wrangler d1 execute younglife-map-db --remote --file=scripts/schema-restricted-password-plaintext.sql

ALTER TABLE restricted_access RENAME COLUMN password_hash TO password;
