-- Adds a global restriction-strength setting alongside restricted_access's
-- existing password. Applies to every restricted country at once (not
-- per-country) — see worker/lib/db/restrictedAccess.js and
-- worker/lib/db/ministries.js's listMinistriesPublic for how each mode
-- reshapes a restricted country's ministry rows before they're sent to a
-- locked-out visitor. One shared value, same single-row convention as the
-- password column.
--
--   wrangler d1 execute younglife-map-db --local --file=scripts/schema-restricted-mode.sql
--   wrangler d1 execute younglife-map-db --remote --file=scripts/schema-restricted-mode.sql

ALTER TABLE restricted_access ADD COLUMN mode TEXT NOT NULL DEFAULT 'full_country';
