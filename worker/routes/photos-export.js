// Routes GET /bigtime/api/photos-export — streams every uploaded staff/
// ministry photo (everything under images/ in R2) as a single downloadable
// ZIP, for an admin who wants an offsite copy beyond the automatic daily
// backup (worker/lib/imageBackup.js). Lives in (and is gated the same as)
// the Admin tab's own user-management area, so this checks is_admin too.

import { errorResponse } from '../lib/http.js';
import { createZipStream } from '../lib/zip.js';

const IMAGES_PREFIX = 'images/';
// Fetching ~377 photos one at a time (a full R2 round trip each) was slow
// enough that a real export ran long enough to get cut off mid-stream —
// confirmed live: macOS Archive Utility failed to open the result with a
// generic "Error 0", exactly what a truncated (missing its end-of-
// central-directory record) zip looks like. Fetching several at once
// cuts the wall-clock time roughly by this factor; entries are yielded
// in whatever order they finish in, not list order, which is fine — ZIP
// doesn't require any particular entry order.
const FETCH_CONCURRENCY = 12;

async function fetchEntry(env, key) {
  const object = await env.MEDIA.get(key);
  if (!object) return null; // deleted between list() and get() — just skip it
  const bytes = new Uint8Array(await object.arrayBuffer());
  // Flatten "images/foo.jpg" -> "foo.jpg" in the zip — the images/ prefix
  // is an R2 storage-layout detail, not worth reproducing as a subfolder
  // in the download.
  return { name: key.slice(IMAGES_PREFIX.length), bytes };
}

async function* photoEntries(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.MEDIA.list({ prefix: IMAGES_PREFIX, cursor });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  let nextIndex = 0;
  const inFlight = new Set();

  function launch() {
    if (nextIndex >= keys.length) return;
    const key = keys[nextIndex++];
    const wrapped = fetchEntry(env, key).then((result) => ({ wrapped, result }));
    inFlight.add(wrapped);
  }

  for (let i = 0; i < FETCH_CONCURRENCY; i++) launch();

  while (inFlight.size > 0) {
    const { wrapped, result } = await Promise.race(inFlight);
    inFlight.delete(wrapped);
    launch();
    if (result) yield result;
  }
}

export async function onRequestGet({ env, user }) {
  if (!user || !user.is_admin) return errorResponse(403, 'Admin access required');
  const stream = createZipStream(photoEntries(env));
  const filename = `yl-uni-intl-photos-${new Date().toISOString().slice(0, 10)}.zip`;
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
