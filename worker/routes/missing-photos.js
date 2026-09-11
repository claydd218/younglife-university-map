// Routes GET /bigtime/api/missing-photos — the inverse of
// orphaned-photos.js: checks every filename explicitly listed in a
// ministry's own `photos` column against what's actually sitting in R2,
// and reports whichever ones don't exist there. Unlike an orphan (a file
// nothing points to), one of these is a ministry actively trying to show
// a photo that isn't there — the public map's own onerror fallback
// (window.__ministryPhotoFallback) already swaps in an initials
// placeholder for a real visitor rather than a broken-image icon, so
// this doesn't look like anything's wrong there. It surfaced a different
// way instead: the ?tour=NAME tour's own photo carousel held a dwell's
// worth of an empty bordered frame on the pin before this was caught and
// fixed client-side (js/app.js's whenLoaded) — this route exists to find
// and let an admin actually fix the underlying bad reference, not just
// paper over it. Read-only — no delete action here, since there's
// nothing in R2 to delete; fixing one means re-uploading the real photo
// or removing the stale filename from that ministry's own photo list.
// Staff photos aren't checked here — a staff member's photo is only ever
// a slug + guessed extension (any of CONFIG.IMAGE_EXTENSIONS counts),
// not an explicit stored filename, so "no photo exists for this staffer"
// is an entirely normal, expected state, not a broken reference.

import { listObjects } from '../lib/r2.js';
import { jsonResponse, errorResponse } from '../lib/http.js';

const IMAGES_DIR = 'images';

export async function onRequestGet({ env, user }) {
  if (!user || !user.is_admin) return errorResponse(403, 'Admin access required');

  const [files, ministryRows] = await Promise.all([
    listObjects(env, `${IMAGES_DIR}/`),
    env.DB.prepare('SELECT id, city, country, photos FROM ministries').all().then((r) => r.results),
  ]);

  const actual = new Set(files.map((f) => f.name));
  const missing = [];
  for (const row of ministryRows) {
    for (const filename of JSON.parse(row.photos || '[]')) {
      if (!actual.has(filename)) {
        missing.push({ ministryId: row.id, city: row.city, country: row.country, filename });
      }
    }
  }

  return jsonResponse({ missing, totalFiles: files.length });
}
