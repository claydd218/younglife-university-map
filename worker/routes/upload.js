// Routes /bigtime/api/upload — add or replace a staff/city photo.
// Deletion is worker/routes/photo.js.

import { listDir, deleteFile, putFileBase64, ConflictError } from '../lib/github.js';
import { slugify } from '../lib/text.js';
import { jsonResponse, errorResponse, committerFromRequest } from '../lib/http.js';

const IMAGES_DIR = 'images';
const MAX_BYTES = 2 * 1024 * 1024; // 2MB — defense in depth; the client is
// expected to have already compressed the image (canvas re-encode pipeline).
const OUTPUT_EXT = 'jpg'; // Always written as .jpg — see the stale-extension
// note below for why an existing file of a different extension must be
// removed, not just left alongside the new one.

function decodedByteLength(base64) {
  const cleaned = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const padding = (cleaned.match(/=+$/) || [''])[0].length;
  return Math.floor((cleaned.length * 3) / 4) - padding;
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const { kind, name, city, country, imageBase64 } = body;

  // The slug is computed here from semantic fields, not trusted from a
  // client-sent path — defense in depth against writing to an arbitrary
  // images/ path.
  let slug;
  if (kind === 'staff') {
    if (!name || !name.trim()) return errorResponse(400, 'name is required for a staff photo');
    slug = slugify(name);
  } else if (kind === 'city') {
    if (!city || !city.trim() || !country || !country.trim()) {
      return errorResponse(400, 'city and country are required for a city photo');
    }
    slug = `${slugify(city)}-${slugify(country)}`;
  } else {
    return errorResponse(400, 'kind must be "staff" or "city"');
  }

  if (!imageBase64) return errorResponse(400, 'imageBase64 is required');
  const byteLength = decodedByteLength(imageBase64);
  if (byteLength > MAX_BYTES) {
    return errorResponse(400, `Image is ${(byteLength / 1024 / 1024).toFixed(1)}MB, over the ${MAX_BYTES / 1024 / 1024}MB limit`);
  }

  const targetPath = `${IMAGES_DIR}/${slug}.${OUTPUT_EXT}`;
  const existing = await listDir(env, IMAGES_DIR);
  const existingForSlug = existing.filter((f) => f.name.startsWith(`${slug}.`));
  const sameExt = existingForSlug.find((f) => f.name === `${slug}.${OUTPUT_EXT}`);

  // CONFIG.IMAGE_EXTENSIONS on the public site tries .png before .jpg — if
  // an existing photo is slug.png and this endpoint always writes slug.jpg
  // without removing the old file, the new upload would silently never win
  // that extension race and the old photo would keep showing. Clear out any
  // other-extension file for this slug first (its own commit) before
  // writing the new one.
  const commit = committerFromRequest(request);
  for (const stale of existingForSlug) {
    if (stale.name === `${slug}.${OUTPUT_EXT}`) continue;
    try {
      await deleteFile(env, stale.path, stale.sha, `Remove stale photo: ${stale.name}`, commit);
    } catch (err) {
      if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
      throw err;
    }
  }

  let result;
  try {
    result = await putFileBase64(env, targetPath, imageBase64, {
      sha: sameExt ? sameExt.sha : undefined,
      message: `${sameExt ? 'Update' : 'Add'} photo: ${slug}`,
      ...commit,
    });
  } catch (err) {
    if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
    throw err;
  }

  return jsonResponse({ ok: true, path: targetPath, sha: result.sha });
}
