// Routes /bigtime/api/photos/:slug — remove a staff/city photo. Powers the
// Images tab's "Remove" action, and the Ministries tab's own per-photo
// Remove button (see admin.js's shared photo widget) — both delete
// immediately, with no separate confirm/save step. Add/replace is
// worker/routes/upload.js.
//
// Also scrubs any ministry row's own `photos` column. A ministry/city
// photo (unlike a staff photo, which is never stored as an explicit
// filename — it's resolved on the fly from a slugified name, see
// bigtime/report/report.js's findStaffPhotoUrl) is referenced by exact
// filename in a ministry row's photos list. Deleting the file without
// also touching that reference used to leave it dangling — see the git
// history around the Kathmandu, Nepal incident this scrubbing exists to
// prevent. Scrubbing here, inside the same delete that removes the file,
// keeps the two always consistent regardless of which UI path triggered
// the deletion or whether the ministry form's own Save was ever reached.

import { listObjects, deleteObject } from '../lib/r2.js';
import { jsonResponse, errorResponse } from '../lib/http.js';
import { bumpDataVersion } from '../lib/dataVersion.js';
import { regenerateReportArchive } from '../lib/reportArchive.js';

const IMAGES_DIR = 'images';

// Removes any of `deletedFilenames` from every ministry row's `photos`
// column that references one — a no-op (no writes at all) if nothing
// did, which is the common case: most deletions are staff photos, never
// stored as an explicit filename here to begin with. Unlike the old CSV
// version, this touches only the specific rows that actually reference a
// deleted filename (a per-row UPDATE, not a whole-file rewrite), so
// there's no whole-dataset conflict to race against — just plain, safe
// per-row writes.
async function scrubMinistryPhotoReferences(env, deletedFilenames) {
  const deleted = new Set(deletedFilenames);
  const { results } = await env.DB.prepare('SELECT id, photos FROM ministries').all();
  for (const row of results) {
    const photos = JSON.parse(row.photos);
    const kept = photos.filter((p) => !deleted.has(p));
    if (kept.length !== photos.length) {
      await env.DB.prepare('UPDATE ministries SET photos = ? WHERE id = ?').bind(JSON.stringify(kept), row.id).run();
    }
  }
}

export async function onRequestDelete({ request, env, ctx, params }) {
  const slug = params.slug;
  // There should be at most one file per slug (upload.js's stale-extension
  // cleanup keeps it that way), but remove all matches just in case.
  const matches = await listObjects(env, `${IMAGES_DIR}/${slug}.`);
  if (matches.length === 0) {
    return errorResponse(404, `No photo found for ${slug}`);
  }

  await Promise.all(matches.map((f) => deleteObject(env, f.key)));

  await scrubMinistryPhotoReferences(env, matches.map((f) => f.key.slice(`${IMAGES_DIR}/`.length)));

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
