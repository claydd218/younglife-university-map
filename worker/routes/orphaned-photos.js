// Routes GET /bigtime/api/orphaned-photos — compares every file actually
// in R2's images/ against what D1 says should be there (every staff
// member's slug, under any extension CONFIG.IMAGE_EXTENSIONS on the
// client would try; every filename explicitly listed in a ministry's own
// `photos` column) and reports whichever files match nothing. These
// accumulate from gaps worker/lib/photoCleanup.js's callers now close
// going forward (a removed staffer, a deleted ministry) plus anything
// left over from the pre-D1 CSV era, which never tracked staff identity
// at all. Read-only — actually removing one reuses the existing
// DELETE /bigtime/api/photos/:slug route the Images tab already has.

import { listObjects } from '../lib/r2.js';
import { jsonResponse, errorResponse } from '../lib/http.js';

const IMAGES_DIR = 'images';
// Mirrors js/config.js's CONFIG.IMAGE_EXTENSIONS — a staff photo has no
// explicit stored filename, only a slug, so any of these extensions
// counts as "this slug has a photo" the same way the public site
// resolves one.
const STAFF_EXTENSIONS = ['jpg', 'png', 'jpeg', 'webp'];

export async function onRequestGet({ env, user }) {
  if (!user || !user.is_admin) return errorResponse(403, 'Admin access required');

  const [files, staffRows, ministryRows] = await Promise.all([
    listObjects(env, `${IMAGES_DIR}/`),
    env.DB.prepare('SELECT slug FROM staff').all().then((r) => r.results),
    env.DB.prepare('SELECT photos FROM ministries').all().then((r) => r.results),
  ]);

  const expected = new Set();
  for (const { slug } of staffRows) {
    for (const ext of STAFF_EXTENSIONS) expected.add(`${slug}.${ext}`);
  }
  for (const { photos } of ministryRows) {
    for (const filename of JSON.parse(photos)) expected.add(filename);
  }

  const orphans = files
    .filter((f) => !expected.has(f.name))
    .map((f) => f.name)
    .sort();

  return jsonResponse({ orphans, totalFiles: files.length });
}
