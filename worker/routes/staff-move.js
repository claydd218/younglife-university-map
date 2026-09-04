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

export async function onRequestPost({ request, env, ctx, params, user }) {
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

  // Captured before the move so the log can name the staffer and where
  // they came from — worker/routes/logs.js reads this to build a summary
  // like "Moved Anna Turchynska here from Zhytomyr, Ukraine" instead of
  // just a bare staff id.
  const staffRow = await env.DB.prepare('SELECT name, home_ministry_id FROM staff WHERE id = ?').bind(staffId).first();
  const sourceMinistry = staffRow ? await getMinistry(env, staffRow.home_ministry_id) : null;

  await moveStaffHome(env, staffId, targetMinistryId);

  // Same ministry_edits audit trail every other mutation in this module
  // writes to — a move is a real change to the target ministry's roster,
  // so it should show up in the Log tab same as any other edit.
  await env.DB.prepare(
    'INSERT INTO ministry_edits (ministry_id, changed_at, action, old_json, new_json, user_name) VALUES (?, ?, ?, NULL, ?, ?)'
  ).bind(
    targetMinistryId,
    new Date().toISOString(),
    'staff-move',
    JSON.stringify({
      staffId,
      staffName: staffRow ? staffRow.name : null,
      fromCity: sourceMinistry ? sourceMinistry.city : null,
      fromCountry: sourceMinistry ? sourceMinistry.country : null,
    }),
    user ? user.name : null
  ).run();

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
