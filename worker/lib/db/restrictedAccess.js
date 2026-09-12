// Restricted-countries gate — see scripts/schema-restricted-countries.sql
// for the two tables this reads/writes. Every read here is wrapped
// against a missing-table error and falls back to "nothing configured
// yet" rather than throwing: this code deploys the instant it's pushed
// (Cloudflare Workers Builds), but the migration is a separate manual
// step (see that file's own wrangler commands) — without this fallback,
// GET /api/ministries (which calls getRestrictedCountries on every
// request) would 500 the entire public map for however long the
// migration lags behind the code that expects it.

import { hashPassword, verifyPassword } from '../password.js';

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

export async function hasRestrictedPassword(env) {
  try {
    const row = await env.DB.prepare('SELECT id FROM restricted_access WHERE id = 1').first();
    return !!row;
  } catch (err) {
    console.error('hasRestrictedPassword (treating as unset):', err);
    return false;
  }
}

export async function setRestrictedPassword(env, password) {
  const hash = await hashPassword(password);
  await env.DB.prepare(
    'INSERT INTO restricted_access (id, password_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash'
  ).bind(hash).run();
}

// No password configured yet -> nothing can ever unlock (fails closed,
// not open) — a country marked restricted with no password set stays
// restricted rather than becoming accidentally unlockable by anyone.
export async function checkRestrictedPassword(env, password) {
  try {
    const row = await env.DB.prepare('SELECT password_hash FROM restricted_access WHERE id = 1').first();
    if (!row) return false;
    return verifyPassword(password, row.password_hash);
  } catch (err) {
    console.error('checkRestrictedPassword (treating as no match):', err);
    return false;
  }
}
