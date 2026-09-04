// Routes POST /bigtime/api/staff/:id/move — atomically re-home a staffer to
// a different ministry (the fix for the "Move to Ministry" atomicity bug:
// this used to be done by PUTting the whole target ministry with a
// no-id staff entry, which always inserted a new row instead of moving the
// existing one — see worker/lib/db/staff.js's moveStaffHome for the detail).

import { errorResponse, jsonResponse } from '../lib/http.js';
import { moveStaffHome } from '../lib/db/staff.js';
import { getMinistry } from '../lib/db/ministries.js';
import { bumpDataVersion } from '../lib/dataVersion.js';
import { regenerateReportArchive } from '../lib/reportArchive.js';

export async function onRequestPost({ request, env, ctx, params }) {
  const staffId = Number(params.id);
  if (!Number.isFinite(staffId)) return errorResponse(400, 'Invalid staff id');

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const targetMinistryId = Number(body.targetMinistryId);
  if (!Number.isFinite(targetMinistryId)) {
    return errorResponse(400, 'targetMinistryId is required');
  }

  const target = await getMinistry(env, targetMinistryId);
  if (!target) return errorResponse(404, `No ministry with id ${targetMinistryId}`);

  await moveStaffHome(env, staffId, targetMinistryId);

  // Same ministry_edits audit trail every other mutation in this module
  // writes to — a move is a real change to the target ministry's roster,
  // so it should show up in the (planned) Log tab same as any other edit.
  await env.DB.prepare(
    'INSERT INTO ministry_edits (ministry_id, changed_at, action, old_json, new_json) VALUES (?, ?, ?, NULL, ?)'
  ).bind(targetMinistryId, new Date().toISOString(), 'staff-move', JSON.stringify({ staffId })).run();

  const deployVersion = await bumpDataVersion(env);
  if (ctx) {
    // A staffer's own pin doesn't move, and neither ministry's map area
    // changes — only the two ministries' staff listings do, so only the
    // report (not the map archive) needs regenerating here.
    ctx.waitUntil(
      regenerateReportArchive(env, request, deployVersion).catch((err) => {
        console.error('Report archive regeneration failed:', err);
      })
    );
  }

  const row = await getMinistry(env, targetMinistryId);
  return jsonResponse({ ok: true, deployVersion, row });
}
