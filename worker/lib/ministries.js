// country -> division lookup. data/country-divisions.csv stays a plain
// static file (read-only reference data, no write path, not worth moving
// off git) — everything else that used to live here (HEADER, rowToApi,
// rowFromBody, maxId) moved to worker/lib/db/ministries.js now that
// ministry/staff data itself lives in D1, not a CSV file.

import { parseCsv } from './csv.js';

export const DIVISIONS_PATH = 'data/country-divisions.csv';

// `request` supplies the origin for env.ASSETS.fetch() — this used to be
// a plain getFile(env, DIVISIONS_PATH) call against GitHub; the static
// file itself hasn't moved, just what serves it.
export async function loadDivisions(env, request) {
  const url = new URL(`/${DIVISIONS_PATH}`, request.url);
  const res = await env.ASSETS.fetch(url);
  const map = new Map();
  if (!res.ok) return map;
  const { rows } = parseCsv(await res.text());
  for (const row of rows) {
    const country = (row.country || '').trim();
    const division = (row.division || '').trim();
    if (country && division) map.set(country, division);
  }
  return map;
}
