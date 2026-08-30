// Routes /bigtime/api/ministries/:id — update (PUT) or remove (DELETE) one
// ministry row. Listing/creating is worker/routes/ministries.js.

import { getFile, putFile, ConflictError } from '../lib/github.js';
import { parseCsv, stringifyCsv } from '../lib/csv.js';
import { ValidationError } from '../lib/text.js';
import { jsonResponse, errorResponse, committerFromRequest } from '../lib/http.js';
import { MINISTRIES_PATH, HEADER, rowFromBody } from '../lib/ministries.js';
import { bumpDeployVersion } from '../lib/deployVersion.js';
import { regenerateMapArchive } from '../lib/mapArchive.js';

export async function onRequestPut({ request, env, ctx, params }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  // Fetched for its *content* (to edit the right row in the full CSV), not
  // to pre-check its sha against body.sha — GitHub's Contents API listing
  // endpoint has a brief read-after-write lag right after a commit, so an
  // immediate GET here can occasionally still return the pre-write sha even
  // though body.sha (from the client's last successful write) is actually
  // current. That produced real false-positive 409s in testing. Passing
  // body.sha straight through to putFile below and letting GitHub's own
  // write-time check (proven atomic/reliable in testing) be the sole
  // arbiter avoids that; see conflict handling on the putFile call.
  const file = await getFile(env, MINISTRIES_PATH);
  if (!file) return errorResponse(500, 'data/ministries.csv not found in the repo');

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
      sha: body.sha || file.sha,
      message: `Update ministry: ${updatedRow.city}, ${updatedRow.country}`,
      ...committerFromRequest(request),
    });
  } catch (err) {
    if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
    throw err;
  }

  const deployVersion = await bumpDeployVersion(env, committerFromRequest(request));
  // Editing a ministry area can move a pin/change its country — see
  // onRequestPost in ministries.js for why this is detached and waits for
  // the deploy first.
  if (ctx) {
    ctx.waitUntil(
      regenerateMapArchive(env, request, deployVersion, committerFromRequest(request)).catch((err) => {
        console.error('Map archive regeneration failed:', err);
      })
    );
  }
  return jsonResponse({ ok: true, id: updatedRow.id, sha: result.sha, deployVersion });
}

export async function onRequestDelete({ request, env, ctx, params }) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine for a delete — sha is optional-but-recommended here.
  }

  // See onRequestPut above — fetched for content, not for a pre-check
  // against body.sha.
  const file = await getFile(env, MINISTRIES_PATH);
  if (!file) return errorResponse(500, 'data/ministries.csv not found in the repo');

  const { rows } = parseCsv(file.content);
  const index = rows.findIndex((r) => r.id === params.id);
  if (index === -1) return errorResponse(404, `No ministry with id ${params.id}`);
  const [removed] = rows.splice(index, 1);

  const newCsv = stringifyCsv(HEADER, rows);
  let result;
  try {
    result = await putFile(env, MINISTRIES_PATH, newCsv, {
      sha: body.sha || file.sha,
      message: `Remove ministry: ${removed.city}, ${removed.country}`,
      ...committerFromRequest(request),
    });
  } catch (err) {
    if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
    throw err;
  }

  const deployVersion = await bumpDeployVersion(env, committerFromRequest(request));
  // Removing a ministry area can remove a pin/country's only marker — see
  // onRequestPost in ministries.js for why this is detached and waits for
  // the deploy first.
  if (ctx) {
    ctx.waitUntil(
      regenerateMapArchive(env, request, deployVersion, committerFromRequest(request)).catch((err) => {
        console.error('Map archive regeneration failed:', err);
      })
    );
  }
  return jsonResponse({ ok: true, sha: result.sha, deployVersion });
}
