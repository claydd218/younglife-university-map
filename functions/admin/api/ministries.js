// Routes /admin/api/ministries — list all ministries (GET) and create a new
// one (POST). Editing/deleting a specific row is
// functions/admin/api/ministries/[id].js.

import { getFile, putFile, ConflictError } from '../../_lib/github.js';
import { parseCsv, stringifyCsv } from '../../_lib/csv.js';
import { ValidationError } from '../../_lib/text.js';
import { jsonResponse, errorResponse, committerFromRequest, CONFLICT_MESSAGE } from '../../_lib/http.js';
import { MINISTRIES_PATH, HEADER, loadDivisions, rowToApi, rowFromBody, maxId } from '../../_lib/ministries.js';

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

  // Re-fetch fresh right before writing — the concurrency contract every
  // write endpoint shares. If the caller's last-seen sha doesn't match,
  // reject before ever attempting the GitHub write.
  const file = await getFile(env, MINISTRIES_PATH);
  if (!file) return errorResponse(500, 'data/ministries.csv not found in the repo');
  if (body.sha && body.sha !== file.sha) {
    return errorResponse(409, CONFLICT_MESSAGE, { error: 'conflict' });
  }

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
      sha: file.sha,
      message: `Add ministry: ${newRow.city}, ${newRow.country}`,
      ...committerFromRequest(request),
    });
  } catch (err) {
    if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
    throw err;
  }

  return jsonResponse({ ok: true, id: newRow.id, sha: result.sha });
}
