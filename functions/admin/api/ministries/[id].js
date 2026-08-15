// Routes /admin/api/ministries/:id — update (PUT) or remove (DELETE) one
// ministry row. Listing/creating is functions/admin/api/ministries.js.

import { getFile, putFile, ConflictError } from '../../../_lib/github.js';
import { parseCsv, stringifyCsv } from '../../../_lib/csv.js';
import { ValidationError } from '../../../_lib/text.js';
import { jsonResponse, errorResponse, committerFromRequest, CONFLICT_MESSAGE } from '../../../_lib/http.js';
import { MINISTRIES_PATH, HEADER, rowFromBody } from '../../../_lib/ministries.js';

export async function onRequestPut({ request, env, params }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const file = await getFile(env, MINISTRIES_PATH);
  if (!file) return errorResponse(500, 'data/ministries.csv not found in the repo');
  if (body.sha && body.sha !== file.sha) {
    return errorResponse(409, CONFLICT_MESSAGE, { error: 'conflict' });
  }

  const { rows } = parseCsv(file.content);
  const index = rows.findIndex((r) => r.id === params.id);
  if (index === -1) return errorResponse(404, `No ministry with id ${params.id}`);

  let updatedRow;
  try {
    updatedRow = rowFromBody(params.id, body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return errorResponse(400, err.message, { error: 'validation', field: err.field });
    }
    throw err;
  }
  // Replace in place — preserves row order, keeps the git diff minimal.
  rows[index] = updatedRow;

  const newCsv = stringifyCsv(HEADER, rows);
  let result;
  try {
    result = await putFile(env, MINISTRIES_PATH, newCsv, {
      sha: file.sha,
      message: `Update ministry: ${updatedRow.city}, ${updatedRow.country}`,
      ...committerFromRequest(request),
    });
  } catch (err) {
    if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
    throw err;
  }

  return jsonResponse({ ok: true, id: updatedRow.id, sha: result.sha });
}

export async function onRequestDelete({ request, env, params }) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine for a delete — sha is optional-but-recommended here.
  }

  const file = await getFile(env, MINISTRIES_PATH);
  if (!file) return errorResponse(500, 'data/ministries.csv not found in the repo');
  if (body.sha && body.sha !== file.sha) {
    return errorResponse(409, CONFLICT_MESSAGE, { error: 'conflict' });
  }

  const { rows } = parseCsv(file.content);
  const index = rows.findIndex((r) => r.id === params.id);
  if (index === -1) return errorResponse(404, `No ministry with id ${params.id}`);
  const [removed] = rows.splice(index, 1);

  const newCsv = stringifyCsv(HEADER, rows);
  let result;
  try {
    result = await putFile(env, MINISTRIES_PATH, newCsv, {
      sha: file.sha,
      message: `Remove ministry: ${removed.city}, ${removed.country}`,
      ...committerFromRequest(request),
    });
  } catch (err) {
    if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
    throw err;
  }

  return jsonResponse({ ok: true, sha: result.sha });
}
