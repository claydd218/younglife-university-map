// Shared photo-cleanup helpers — used by the explicit Remove-photo route
// (worker/routes/photo.js) and by anything that removes the underlying
// staff/ministry record itself (db/staff.js's upsertHomeStaff, db/
// ministries.js's deleteMinistry). Confirmed live as a real, ongoing gap:
// removing a staff member from their home ministry's Staff list, or
// deleting a whole ministry outright, only ever touched D1 — neither path
// ever deleted the corresponding R2 file(s), leaving them orphaned
// forever. ON DELETE CASCADE only reaches other D1 tables, never R2.

import { listObjects, deleteObject } from './r2.js';

const IMAGES_DIR = 'images';

// Deletes every R2 file matching images/<slug>.* — there should only
// ever be one (upload.js's own stale-extension cleanup keeps it that
// way for anything uploaded through the current code), but historical/
// pre-migration data occasionally left more than one extension behind
// for the same slug, so this removes all matches rather than assuming
// exactly one. -> the deleted filenames (relative to images/), [] if
// there was nothing to delete.
export async function deletePhotosBySlug(env, slug) {
  const matches = await listObjects(env, `${IMAGES_DIR}/${slug}.`);
  if (!matches.length) return [];
  await Promise.all(matches.map((f) => deleteObject(env, f.key)));
  const filenames = matches.map((f) => f.key.slice(`${IMAGES_DIR}/`.length));
  await scrubMinistryPhotoReferences(env, filenames);
  return filenames;
}

// Deletes one already-known exact filename — a ministry's own `photos`
// column lists these explicitly (unlike a staff photo's slug-derived
// name), so no prefix search is needed to find it.
export async function deletePhotoFile(env, filename) {
  await deleteObject(env, `${IMAGES_DIR}/${filename}`);
}

// Removes any of `deletedFilenames` from every ministry row's `photos`
// column that references one — a no-op (no writes at all) if nothing
// did, which is the common case: most deletions are staff photos, never
// stored as an explicit filename here to begin with.
export async function scrubMinistryPhotoReferences(env, deletedFilenames) {
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
