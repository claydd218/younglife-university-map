// Restricted-countries gate — see scripts/schema-restricted-countries.sql
// for the two tables this reads/writes. Every read here is wrapped
// against a missing-table error and falls back to "nothing configured
// yet" rather than throwing: this code deploys the instant it's pushed
// (Cloudflare Workers Builds), but the migration is a separate manual
// step (see that file's own wrangler commands) — without this fallback,
// GET /api/ministries (which calls getRestrictedCountries on every
// request) would 500 the entire public map for however long the
// migration lags behind the code that expects it.

import { checkPassword } from '../session.js';

export async function getRestrictedCountries(env) {
  try {
    const { results } = await env.DB.prepare('SELECT country FROM restricted_countries ORDER BY country').all();
    return results.map((r) => r.country);
  } catch (err) {
    console.error('getRestrictedCountries (treating as none configured):', err);
    return [];
  }
}

export async function setRestrictedCountries(env, countries) {
  const clean = [...new Set((countries || []).map((c) => String(c).trim()).filter(Boolean))];
  await env.DB.prepare('DELETE FROM restricted_countries').run();
  for (const country of clean) {
    await env.DB.prepare('INSERT INTO restricted_countries (country) VALUES (?)').bind(country).run();
  }
  return clean;
}

// Stored (and returned to the admin UI) as plain text, not hashed —
// deliberate, same tradeoff worker/lib/session.js's own SITE_SHARED_PASSWORD
// already makes: this is one shared, low-stakes password gating a subset of
// otherwise-public map data, not a real per-user login credential, and the
// admin UI shows it back so there's no "leave blank to keep the current
// one" guessing game.
export async function getRestrictedPassword(env) {
  try {
    const row = await env.DB.prepare('SELECT password FROM restricted_access WHERE id = 1').first();
    return row ? row.password : '';
  } catch (err) {
    console.error('getRestrictedPassword (treating as unset):', err);
    return '';
  }
}

export async function setRestrictedPassword(env, password) {
  await env.DB.prepare(
    'INSERT INTO restricted_access (id, password) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET password = excluded.password'
  ).bind(password).run();
}

// No password configured yet -> nothing can ever unlock (fails closed,
// not open) — a country marked restricted with no password set stays
// restricted rather than becoming accidentally unlockable by anyone.
export async function checkRestrictedPassword(env, password) {
  try {
    const row = await env.DB.prepare('SELECT password FROM restricted_access WHERE id = 1').first();
    if (!row || !row.password) return false;
    return checkPassword(password, row.password);
  } catch (err) {
    console.error('checkRestrictedPassword (treating as no match):', err);
    return false;
  }
}
