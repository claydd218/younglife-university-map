// Routes /bigtime/api/ministries — list all ministries (GET) and create a new
// one (POST). Editing/deleting a specific row is worker/routes/ministry-detail.js.
// Dispatched by worker/index.js's router, which builds the same
// {request, env, params} shape Cloudflare Pages Functions used to provide
// automatically — kept so this handler code didn't need to change when the
// project turned out to be a Worker-with-assets deployment, not Pages.

import { getFile, putFile, ConflictError } from '../lib/github.js';
import { parseCsv, stringifyCsv } from '../lib/csv.js';
import { ValidationError } from '../lib/text.js';
import { jsonResponse, errorResponse, committerFromRequest } from '../lib/http.js';
import { MINISTRIES_PATH, HEADER, loadDivisions, rowToApi, rowFromBody, maxId } from '../lib/ministries.js';

export async function onRequestGet({ env }) {
  const file = await getFile(env, MINISTRIES_PATH);
  if (!file) return errorResponse(500, 'data/ministries.csv not found in the repo');

  const { rows: rawRows } = parseCsv(file.content);
  const divisions = await loadDivisions(env);

  const unmatchedCountries = new Set();
  const rows = rawRows.map((r) => {
    const country = (r.country || '').trim();
    if (country && !divisions.has(country)) unmatchedCountries.add(country);
    return rowToApi(r);
  });

  return jsonResponse({
    sha: file.sha,
    rows,
    unmatchedCountries: Array.from(unmatchedCountries),
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  // Fetched for content (need every existing row to compute the new id and
  // append to it), not to pre-check sha — see the longer note in
  // ministry-detail.js's onRequestPut for why that pre-check was removed
  // (GitHub read-after-write lag caused real false-positive 409s). GitHub's
  // own write-time sha check on the putFile call below is authoritative.
  const file = await getFile(env, MINISTRIES_PATH);
  if (!file) return errorResponse(500, 'data/ministries.csv not found in the repo');

  const { rows } = parseCsv(file.content);

  let newRow;
  try {
    newRow = rowFromBody(maxId(rows) + 1, body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return errorResponse(400, err.message, { error: 'validation', field: err.field });
    }
    throw err;
  }
  rows.push(newRow);

  const newCsv = stringifyCsv(HEADER, rows);
  let result;
  try {
    result = await putFile(env, MINISTRIES_PATH, newCsv, {
      sha: body.sha || file.sha,
      message: `Add ministry: ${newRow.city}, ${newRow.country}`,
      ...committerFromRequest(request),
    });
  } catch (err) {
    if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
    throw err;
  }

  return jsonResponse({ ok: true, id: newRow.id, sha: result.sha });
}
