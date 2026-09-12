-- Adds the "restricted countries" gate: a country in restricted_countries
-- is entirely omitted from the public GET /api/ministries response (no
-- pins, no country coloring, no metrics contribution — all three fall out
-- for free once the ministry rows themselves are never sent) unless the
-- request carries a valid restricted-unlock cookie. See
-- worker/lib/db/restrictedAccess.js and worker/lib/restrictedSession.js.
--
--   wrangler d1 execute younglife-map-db --local --file=scripts/schema-restricted-countries.sql
--   wrangler d1 execute younglife-map-db --remote --file=scripts/schema-restricted-countries.sql
--
-- Also requires a new Worker secret before the unlock cookie can be
-- signed/verified (see worker/lib/restrictedSession.js's own comment):
--
--   wrangler secret put RESTRICTED_SESSION_SECRET

CREATE TABLE restricted_countries (
  -- Exact string match against ministries.country — populated in the
  -- admin UI from that same table's own distinct values (a picklist, not
  -- free text), so there's no normalization mismatch to worry about here.
  country TEXT PRIMARY KEY
);

-- Single-row table, same convention as data_version in scripts/schema.sql
-- — one shared password gates every restricted country at once, not a
-- password per country.
CREATE TABLE restricted_access (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL
);
