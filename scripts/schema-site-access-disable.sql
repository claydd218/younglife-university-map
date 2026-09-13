-- Adds an admin-settable on/off switch for the temporary whole-site
-- password gate itself — see worker/index.js and worker/lib/db/siteAccess.js.
-- 0 (default) keeps the gate active, matching current behavior exactly;
-- 1 makes the site fully public, skipping /site-login entirely regardless
-- of the password.
--
--   wrangler d1 execute younglife-map-db --local --file=scripts/schema-site-access-disable.sql
--   wrangler d1 execute younglife-map-db --remote --file=scripts/schema-site-access-disable.sql

ALTER TABLE site_access ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
