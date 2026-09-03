// Routes /bigtime/api/upload — add or replace a staff/city photo.
// Deletion is worker/routes/photo.js.

import { listDir, deleteFile, putFileBase64, ConflictError } from '../lib/github.js';
import { slugify } from '../lib/text.js';
import { jsonResponse, errorResponse, committerFromRequest } from '../lib/http.js';
import { bumpDeployVersion } from '../lib/deployVersion.js';
import { regenerateReportArchive } from '../lib/reportArchive.js';

const IMAGES_DIR = 'images';
const MAX_BYTES = 6 * 1024 * 1024; // 6MB — defense in depth; the client is
// expected to have already compressed the image (canvas re-encode pipeline)
// down to well under this, so this is really a backstop for when that
// compression is bypassed or fails, not a ceiling normal uploads approach.
// Staff photos stay .jpg — CONFIG.IMAGE_EXTENSIONS on the public site
// guesses staff photo extensions by trying each in turn, so an existing
// staff photo's extension has to keep matching what this always writes (see
// the stale-extension note below). City/ministry photos have no such
// guessing (the exact filename is stored in ministries.csv), so they're
// free to use .webp for the real size win — see bigtime/admin.js's
// reencodeImage for why staff photos aren't switched too.
const STAFF_OUTPUT_EXT = 'jpg';

function decodedByteLength(base64) {
  const cleaned = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const padding = (cleaned.match(/=+$/) || [''])[0].length;
  return Math.floor((cleaned.length * 3) / 4) - padding;
}

// City/ministry photos take their extension from the image's own actual
// bytes rather than a fixed '.webp' constant. Safari's canvas.toBlob
// silently substitutes PNG when asked to encode WebP (which it can't
// encode at all) instead of erroring — bigtime/admin.js's reencodeImage
// now catches that client-side and falls back to JPEG, but trusting a
// fixed extension here would still mislabel anything that slips through
// (an older cached admin.js, a future encoder change, direct API use).
// Reading the real magic bytes keeps the stored filename honest no matter
// what produced them.
function detectImageExt(base64) {
  const cleaned = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  // 24 base64 chars (a multiple of 4, so it decodes cleanly on its own)
  // is 18 bytes — enough for every signature checked below.
  const bytes = Uint8Array.from(atob(cleaned.slice(0, 24)), (c) => c.charCodeAt(0));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return null;
}

export async function onRequestPost({ request, env, ctx }) {
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

  const commit = committerFromRequest(request);
  // A staff or ministry photo shows up directly in the report — see
  // reportArchive.js. Unlike ministries.js/ministry-detail.js's map
  // regeneration, this doesn't touch maps/*.png at all (a photo change
  // never moves a pin), which is why only the report archive is hooked
  // here.
  function triggerReportRegen(deployVersion) {
    if (!ctx) return;
    ctx.waitUntil(
      regenerateReportArchive(env, request, deployVersion, commit).catch((err) => {
        console.error('Report archive regeneration failed:', err);
      })
    );
  }
  const existing = await listDir(env, IMAGES_DIR);

  if (kind === 'staff') {
    const targetPath = `${IMAGES_DIR}/${slug}.${STAFF_OUTPUT_EXT}`;
    const existingForSlug = existing.filter((f) => f.name.startsWith(`${slug}.`));
    const sameExt = existingForSlug.find((f) => f.name === `${slug}.${STAFF_OUTPUT_EXT}`);

    // CONFIG.IMAGE_EXTENSIONS on the public site tries .png before .jpg —
    // if an existing photo is slug.png and this endpoint always writes
    // slug.jpg without removing the old file, the new upload would
    // silently never win that extension race and the old photo would
    // keep showing. Clear out any other-extension file for this slug
    // first (its own commit) before writing the new one.
    for (const stale of existingForSlug) {
      if (stale.name === `${slug}.${STAFF_OUTPUT_EXT}`) continue;
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

    const deployVersion = await bumpDeployVersion(env, commit);
    triggerReportRegen(deployVersion);
    return jsonResponse({ ok: true, path: targetPath, filename: `${slug}.${STAFF_OUTPUT_EXT}`, sha: result.sha, deployVersion });
  }

  // kind === 'city': a ministry can have multiple photos, so each upload
  // adds a new numbered file (slug-1.ext, slug-2.ext, ...) rather than
  // overwriting — the admin's photo manager owns ordering/deletion.
  const cityExt = detectImageExt(imageBase64);
  if (!cityExt) return errorResponse(400, "Couldn't recognize the image format (expected JPEG, PNG, or WebP)");

  const numberedPattern = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.`);
  let nextIndex = 1;
  for (const f of existing) {
    const match = f.name.match(numberedPattern);
    if (match) nextIndex = Math.max(nextIndex, parseInt(match[1], 10) + 1);
  }
  const filename = `${slug}-${nextIndex}.${cityExt}`;
  const targetPath = `${IMAGES_DIR}/${filename}`;

  let result;
  try {
    result = await putFileBase64(env, targetPath, imageBase64, {
      message: `Add photo: ${filename}`,
      ...commit,
    });
  } catch (err) {
    if (err instanceof ConflictError) return errorResponse(409, err.message, { error: 'conflict' });
    throw err;
  }

  const deployVersion = await bumpDeployVersion(env, commit);
  triggerReportRegen(deployVersion);
  return jsonResponse({ ok: true, path: targetPath, filename, sha: result.sha, deployVersion });
}
