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
// there was nothing to delete anywhere (no R2 file AND no dangling
// ministry reference).
//
// Scrubs ministry `photos` references by slug PREFIX, not just the exact
// R2-matched filenames — confirmed live as a real gap: a ministry photo
// whose R2 file was already gone (never uploaded successfully, or
// removed some other way) had no matches here, so this returned []
// early without ever touching the ministry's own `photos` column,
// leaving a permanently-broken reference the admin's Remove button could
// never actually clear (worker/routes/photo.js 404s when this returns
// empty). Matching by slug prefix instead covers that case the same way
// as a real deletion, since it doesn't require an R2 object to exist
// first.
export async function deletePhotosBySlug(env, slug) {
  const matches = await listObjects(env, `${IMAGES_DIR}/${slug}.`);
  const r2Filenames = matches.map((f) => f.key.slice(`${IMAGES_DIR}/`.length));
  if (r2Filenames.length) {
    await Promise.all(matches.map((f) => deleteObject(env, f.key)));
  }
  const scrubbedFilenames = await scrubMinistryPhotoReferencesBySlug(env, slug);
  return [...new Set([...r2Filenames, ...scrubbedFilenames])];
}

// Deletes one already-known exact filename — a ministry's own `photos`
// column lists these explicitly (unlike a staff photo's slug-derived
// name), so no prefix search is needed to find it.
export async function deletePhotoFile(env, filename) {
  await deleteObject(env, `${IMAGES_DIR}/${filename}`);
}

// Removes any ministry `photos` entry starting with `${slug}.` (whatever
// its extension) from every ministry row that has one — used by
// deletePhotosBySlug so a dangling reference with no backing R2 file is
// just as cleanable as a real one — see that function's own comment.
// -> the filenames actually removed, [] if nothing matched.
async function scrubMinistryPhotoReferencesBySlug(env, slug) {
  const prefix = `${slug}.`;
  const { results } = await env.DB.prepare('SELECT id, photos FROM ministries').all();
  const removed = [];
  for (const row of results) {
    const photos = JSON.parse(row.photos);
    const kept = photos.filter((p) => !p.startsWith(prefix));
    if (kept.length !== photos.length) {
      removed.push(...photos.filter((p) => p.startsWith(prefix)));
      await env.DB.prepare('UPDATE ministries SET photos = ? WHERE id = ?').bind(JSON.stringify(kept), row.id).run();
    }
  }
  return removed;
}
