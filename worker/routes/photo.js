// Routes /bigtime/api/photos/:slug — remove a staff/city photo. Powers the
// Images tab's "Remove" action, and the Ministries tab's own per-photo
// Remove button (see admin.js's shared photo widget) — both delete
// immediately, with no separate confirm/save step. Add/replace is
// worker/routes/upload.js.
//
// Also scrubs data/ministries.csv itself. A ministry/city photo (unlike a
// staff photo, which is never stored as an explicit filename — it's
// resolved on the fly from a slugified name, see bigtime/reports/
// reports.js's findStaffPhotoUrl) is referenced by exact filename in a
// ministry row's `photos` column. Deleting the file without also touching
// that reference used to leave it dangling — the Ministries tab only wrote
// an updated `photos` list back on the form's own Save, and the Images tab
// never knew which ministry (if any) referenced a given filename at all —
// so the file could be gone while the CSV still pointed at it, with
// nothing to catch it. That's exactly what happened to Kathmandu, Nepal's
// row, and it hung worker/routes/report-pdf.js's image-shrinking step
// indefinitely on every PDF generation (a broken <img> never fires another
// load/error event once it's already failed once). Scrubbing the
// reference here, inside the same delete that removes the file, keeps the
// two always consistent regardless of which UI path triggered the
// deletion or whether the ministry form's own Save was ever reached.

import { listDir, deleteFile, getFile, putFile, ConflictError } from '../lib/github.js';
import { parseCsv, stringifyCsv } from '../lib/csv.js';
import { jsonResponse, errorResponse, committerFromRequest } from '../lib/http.js';
import { MINISTRIES_PATH, HEADER } from '../lib/ministries.js';
import { bumpDeployVersion } from '../lib/deployVersion.js';

const IMAGES_DIR = 'images';

// Removes any of `deletedFilenames` from every ministry row's `photos`
// column, in a single commit — a no-op (no write at all) if nothing
// referenced them, which is the common case: most deletions are staff
// photos, never stored as an explicit filename here to begin with.
async function scrubMinistryPhotoReferences(env, deletedFilenames, commit) {
  const deleted = new Set(deletedFilenames);
  const file = await getFile(env, MINISTRIES_PATH);
  if (!file) return;

  const { rows } = parseCsv(file.content);
  let changed = false;
  for (const row of rows) {
    const photos = (row.photos || '').split(';').map((s) => s.trim()).filter(Boolean);
    const kept = photos.filter((p) => !deleted.has(p));
    if (kept.length !== photos.length) {
      row.photos = kept.join('; ');
      changed = true;
    }
  }
  if (!changed) return;

  const newCsv = stringifyCsv(HEADER, rows);
  try {
    await putFile(env, MINISTRIES_PATH, newCsv, {
      sha: file.sha,
      message: `Clean up stale photo reference${deletedFilenames.length > 1 ? 's' : ''}: ${deletedFilenames.join(', ')}`,
      ...commit,
    });
  } catch (err) {
    // The photo file is already gone either way (deleteFile above already
    // succeeded, and can't be undone) — a losing race against some other
    // concurrent CSV write shouldn't turn into a failed delete response.
    // Worst case a reference is left stale here; report-pdf.js's own fix
    // (see reports2.js's __shrinkImagesForPdf) means that's a skipped
    // photo, not a hang, so this is safe to just log and move on from.
    if (err instanceof ConflictError) {
      console.error('Could not clean up ministries.csv photo reference (conflict) — left stale:', err.message);
      return;
    }
    throw err;
  }
}

export async function onRequestDelete({ request, env, params }) {
  const slug = params.slug;
  const existing = await listDir(env, IMAGES_DIR);
  // There should be at most one file per slug (upload.js's stale-extension
  // cleanup keeps it that way), but remove all matches just in case.
  const matches = existing.filter((f) => f.name.startsWith(`${slug}.`));
  if (matches.length === 0) {
    return errorResponse(404, `No photo found for ${slug}`);
  }

  const commit = committerFromRequest(request);
  try {
    for (const file of matches) {
      await deleteFile(env, file.path, file.sha, `Remove photo: ${slug}`, commit);
    }
  } catch (err) {
    if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
    throw err;
  }

  await scrubMinistryPhotoReferences(env, matches.map((f) => f.name), commit);

  const deployVersion = await bumpDeployVersion(env, commit);
  return jsonResponse({ ok: true, deployVersion });
}
