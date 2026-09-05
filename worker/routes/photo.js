// Routes /bigtime/api/photos/:slug — remove a staff/city photo. Powers the
// Images tab's "Remove" action, and the Ministries tab's own per-photo
// Remove button (see admin.js's shared photo widget) — both delete
// immediately, with no separate confirm/save step. Add/replace is
// worker/routes/upload.js. The actual delete-and-scrub logic
// (worker/lib/photoCleanup.js's deletePhotosBySlug) is shared with
// db/staff.js and db/ministries.js, which need the same cleanup when a
// staffer is removed or a whole ministry is deleted, not just when this
// route is hit directly.

import { deletePhotosBySlug } from '../lib/photoCleanup.js';
import { jsonResponse, errorResponse } from '../lib/http.js';
import { bumpDataVersion } from '../lib/dataVersion.js';
import { regenerateReportArchive } from '../lib/reportArchive.js';

export async function onRequestDelete({ request, env, ctx, params }) {
  const deleted = await deletePhotosBySlug(env, params.slug);
  if (!deleted.length) {
    return errorResponse(404, `No photo found for ${params.slug}`);
  }

  const deployVersion = await bumpDataVersion(env);
  // A deleted staff/ministry photo shows up (or stops showing up) in the
  // report too — see reportArchive.js.
  if (ctx) {
    ctx.waitUntil(
      regenerateReportArchive(env, request, deployVersion).catch((err) => {
        console.error('Report archive regeneration failed:', err);
      })
    );
  }
  return jsonResponse({ ok: true, deployVersion });
}
