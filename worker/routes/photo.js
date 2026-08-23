// Routes /bigtime/api/photos/:slug — remove a staff/city photo. Powers the
// Images tab's "Remove" action. Add/replace is worker/routes/upload.js.

import { listDir, deleteFile, ConflictError } from '../lib/github.js';
import { jsonResponse, errorResponse, committerFromRequest } from '../lib/http.js';
import { bumpDeployVersion } from '../lib/deployVersion.js';

const IMAGES_DIR = 'images';

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

  const deployVersion = await bumpDeployVersion(env, commit);
  return jsonResponse({ ok: true, deployVersion });
}
