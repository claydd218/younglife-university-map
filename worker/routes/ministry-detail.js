// Routes /bigtime/api/ministries/:id — update (PUT) or remove (DELETE) one
// ministry row. Listing/creating is worker/routes/ministries.js.

import { ValidationError } from '../lib/text.js';
import { jsonResponse, errorResponse } from '../lib/http.js';
import { updateMinistry, deleteMinistry, ConflictError, NotFoundError } from '../lib/db/ministries.js';
import { bumpDataVersion } from '../lib/dataVersion.js';
import { regenerateMapArchive } from '../lib/mapArchive.js';
import { regenerateReportArchive } from '../lib/reportArchive.js';

function validateFields(body) {
  const required = ['city', 'country', 'lat', 'lng'];
  for (const field of required) {
    if (!body[field] || !String(body[field]).trim()) {
      throw new ValidationError(`${field} is required`, field);
    }
  }
  if (Number.isNaN(Number(body.lat)) || Number.isNaN(Number(body.lng))) {
    throw new ValidationError('Lat/Lng must be numbers', 'lat');
  }
}

export async function onRequestPut({ request, env, ctx, params }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  try {
    validateFields(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return errorResponse(400, err.message, { error: 'validation', field: err.field });
    }
    throw err;
  }

  const id = Number(params.id);
  let result;
  try {
    result = await updateMinistry(env, id, body.sha, {
      city: body.city.trim(),
      country: body.country.trim(),
      lat: body.lat,
      lng: body.lng,
      date_opened: body.date_opened,
      is_developing: !!body.is_developing,
      universities: body.universities,
      staff: body.staff,
      blurb: body.blurb,
      photos: body.photos,
      video_url: body.video_url,
      video_label: body.video_label,
      assigned_staff: body.assigned_staff,
    });
  } catch (err) {
    if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
    if (err instanceof NotFoundError) return errorResponse(404, err.message);
    throw err;
  }

  // Unlike the old CSV system, a renamed/removed home staffer's
  // assignments elsewhere don't need a separate sweep here — D1's
  // ON DELETE CASCADE (staff -> staff_assignments) already keeps that
  // table consistent the instant upsertHomeStaff() deletes their old
  // staff row (a rename is a delete+insert). bigtime/admin.js's own
  // sweepAssignments() still runs client-side, but only to refresh the
  // *admin's own in-memory* state.rows cache for ministries it hasn't
  // reloaded this session — the underlying data is already correct.
  const deployVersion = await bumpDataVersion(env);
  if (ctx) {
    // Editing a ministry area can move a pin/change its country.
    ctx.waitUntil(
      regenerateMapArchive(env, request, deployVersion).catch((err) => {
        console.error('Map archive regeneration failed:', err);
      })
    );
    // Any field edit here (blurb, staff, universities, photos, not just
    // ones that would move a map pin) shows up in the report too.
    ctx.waitUntil(
      regenerateReportArchive(env, request, deployVersion).catch((err) => {
        console.error('Report archive regeneration failed:', err);
      })
    );
  }
  return jsonResponse({ ok: true, id: result.id, sha: result.updated_at, updated_at: result.updated_at, deployVersion });
}

export async function onRequestDelete({ request, env, ctx, params }) {
  const id = Number(params.id);
  let result;
  try {
    result = await deleteMinistry(env, id);
  } catch (err) {
    if (err instanceof NotFoundError) return errorResponse(404, err.message);
    throw err;
  }

  const deployVersion = await bumpDataVersion(env);
  if (ctx) {
    ctx.waitUntil(
      regenerateMapArchive(env, request, deployVersion).catch((err) => {
        console.error('Map archive regeneration failed:', err);
      })
    );
    ctx.waitUntil(
      regenerateReportArchive(env, request, deployVersion).catch((err) => {
        console.error('Report archive regeneration failed:', err);
      })
    );
  }
  return jsonResponse({ ok: true, deployVersion });
}
