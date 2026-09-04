// Routes /bigtime/api/ministries — list all ministries (GET) and create a
// new one (POST). Editing/deleting a specific row is
// worker/routes/ministry-detail.js. Dispatched by worker/index.js's
// router with the same {request, env, ctx, params} shape as every other
// route handler here.

import { ValidationError } from '../lib/text.js';
import { jsonResponse, errorResponse } from '../lib/http.js';
import { loadDivisions } from '../lib/ministries.js';
import { listMinistries, insertMinistry } from '../lib/db/ministries.js';
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

export async function onRequestGet({ env, request }) {
  const rows = await listMinistries(env);
  const divisions = await loadDivisions(env, request);

  const unmatchedCountries = new Set();
  for (const r of rows) {
    if (r.country && !divisions.has(r.country)) unmatchedCountries.add(r.country);
  }

  return jsonResponse({ rows, unmatchedCountries: Array.from(unmatchedCountries) });
}

export async function onRequestPost({ request, env, ctx, user }) {
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

  const result = await insertMinistry(env, {
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
  }, user ? user.name : null);

  const deployVersion = await bumpDataVersion(env);
  // Adding a ministry area can introduce a new pin/country — regenerate
  // the cached maps/*.png files so /bigtime/report and /bigtime/maps stay
  // current. Detached (never awaited by this response) — D1/R2's own
  // read-after-write consistency means this can run right away, no more
  // waiting for a deploy to catch up first.
  if (ctx) {
    ctx.waitUntil(
      regenerateMapArchive(env, request, deployVersion).catch((err) => {
        console.error('Map archive regeneration failed:', err);
      })
    );
    // A new ministry area's blurb/staff/universities/photos all show up
    // in the report too, not just on the map — see reportArchive.js.
    ctx.waitUntil(
      regenerateReportArchive(env, request, deployVersion).catch((err) => {
        console.error('Report archive regeneration failed:', err);
      })
    );
  }
  return jsonResponse({ ok: true, id: result.id, sha: result.updated_at, updated_at: result.updated_at, deployVersion, row: result });
}
