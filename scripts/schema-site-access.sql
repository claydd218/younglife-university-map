-- Moves the temporary whole-site password gate's password from a Worker
-- secret (SITE_SHARED_PASSWORD, editable only via `wrangler secret put` or
-- the Cloudflare dashboard) into D1, so it's admin-settable from the CMS
-- like the restricted-countries password already is. Plain text, same
-- reasoning as restricted_access.password (worker/lib/db/restrictedAccess.js) —
-- one shared, low-stakes password, not a per-user login credential, and
-- the admin UI shows the current value back rather than a "leave blank to
-- keep it" guessing game.
--
-- worker/routes/site-login.js falls back to the SITE_SHARED_PASSWORD
-- secret when this table has no row yet, so existing deploys keep working
-- until an admin sets a new value here — once set, this table wins.
--
--   wrangler d1 execute younglife-map-db --local --file=scripts/schema-site-access.sql
--   wrangler d1 execute younglife-map-db --remote --file=scripts/schema-site-access.sql

CREATE TABLE site_access (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  password TEXT NOT NULL
);
