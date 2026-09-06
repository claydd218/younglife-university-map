// Routes GET /bigtime/api/duplicate-photos — groups every file in R2's
// images/ by content (R2's own etag, which for a plain put is a hash of
// the bytes), surfacing any group with more than one filename: the same
// photo saved under two or more different names, whether that's a staff
// photo and a city photo that happen to be the same image, or the same
// city photo re-uploaded (and re-cropped/re-encoded, or not) more than
// once for one ministry. Read-only — removing one reuses the existing
// DELETE /bigtime/api/photos/:slug route the Images tab already has, same
// as worker/routes/orphaned-photos.js.

import { listObjects } from '../lib/r2.js';
import { jsonResponse, errorResponse } from '../lib/http.js';

const IMAGES_DIR = 'images';
const STAFF_EXTENSIONS = ['jpg', 'png', 'jpeg', 'webp'];

export async function onRequestGet({ env, user }) {
  if (!user || !user.is_admin) return errorResponse(403, 'Admin access required');

  const [files, staffRows, ministryRows] = await Promise.all([
    listObjects(env, `${IMAGES_DIR}/`),
    env.DB.prepare('SELECT slug, name, home_ministry_id FROM staff').all().then((r) => r.results),
    env.DB.prepare('SELECT id, city, country, photos FROM ministries').all().then((r) => r.results),
  ]);

  const ministryById = new Map(ministryRows.map((m) => [m.id, m]));
  const owner = new Map();
  for (const staff of staffRows) {
    const home = ministryById.get(staff.home_ministry_id);
    const label = home ? `${staff.name} — ${home.city}, ${home.country} (staff photo)` : staff.name;
    for (const ext of STAFF_EXTENSIONS) owner.set(`${staff.slug}.${ext}`, label);
  }
  for (const m of ministryRows) {
    for (const filename of JSON.parse(m.photos)) owner.set(filename, `${m.city}, ${m.country} (city photo)`);
  }

  const byEtag = new Map();
  for (const f of files) {
    if (!f.etag) continue;
    if (!byEtag.has(f.etag)) byEtag.set(f.etag, []);
    byEtag.get(f.etag).push(f.name);
  }

  const groups = [...byEtag.values()]
    .filter((names) => names.length > 1)
    .map((names) => names.map((name) => ({ name, owner: owner.get(name) || '(unreferenced)' })));

  return jsonResponse({ groups, totalFiles: files.length });
}
