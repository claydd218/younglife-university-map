// Routes GET /bigtime/api/photos-export — streams every uploaded staff/
// ministry photo (everything under images/ in R2) as a single downloadable
// ZIP, for an admin who wants an offsite copy beyond the automatic daily
// backup (worker/lib/imageBackup.js). Lives in (and is gated the same as)
// the Admin tab's own user-management area, so this checks is_admin too.

import { errorResponse } from '../lib/http.js';
import { createZipStream } from '../lib/zip.js';

const IMAGES_PREFIX = 'images/';

async function* photoEntries(env) {
  let cursor;
  do {
    const page = await env.MEDIA.list({ prefix: IMAGES_PREFIX, cursor });
    for (const obj of page.objects) {
      const object = await env.MEDIA.get(obj.key);
      if (!object) continue; // deleted between list() and get() — just skip it
      const bytes = new Uint8Array(await object.arrayBuffer());
      // Flatten "images/foo.jpg" -> "foo.jpg" in the zip — the images/
      // prefix is an R2 storage-layout detail, not worth reproducing as a
      // subfolder in the download.
      yield { name: obj.key.slice(IMAGES_PREFIX.length), bytes };
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
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
