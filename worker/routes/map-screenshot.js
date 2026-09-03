// Routes GET /bigtime/api/map-screenshot — captures the live public map as
// a bundle of PNGs: the whole world plus one zoomed-in map per division
// (js/config.js's DIVISIONS), each cropped to fully show that division's
// countries. Manual "Regenerate" trigger for /bigtime/maps — the normal,
// fast path for both /bigtime/maps and /bigtime/report is now reading the
// cached maps/*.png files worker/lib/mapArchive.js keeps up to date
// automatically on every ministry add/edit/delete (see
// worker/routes/ministries.js and ministry-detail.js), not a live capture
// on every page load.
//
// Response is JSON: { world: "data:image/png;base64,...", divisions: {
// <key>: "data:image/png;base64,...", ... } } — base64 data URLs rather
// than a raw multi-image response so the client can just set them as
// <img src> directly.

import { errorResponse, committerFromRequest } from '../lib/http.js';
import { captureAllMaps, toBase64 } from '../lib/mapCapture.js';
import { saveMapsNow } from '../lib/mapArchive.js';
import { waitForGenerationLock, releaseGenerationLock } from '../lib/browserLock.js';
import { getFile } from '../lib/github.js';
import { DEPLOY_VERSION_PATH } from '../lib/deployVersion.js';

// Same rationale as mapArchive.js's own wait budget — this is a manual,
// live admin request, but it shares the same Browser Rendering
// concurrency limit as an automatic map capture or report generation, so
// it needs the same coordination rather than risking the same
// "Target closed" crash if one of those happens to be running too.
const LOCK_WAIT_TIMEOUT_MS = 420000;

export async function onRequestGet({ request, env, ctx }) {
  if (!env.BROWSER) {
    return errorResponse(500, 'Browser Rendering isn\'t configured for this Worker (env.BROWSER missing) — check wrangler.toml\'s [browser] binding and that it\'s enabled on the Cloudflare dashboard for this account.');
  }

  const locked = await waitForGenerationLock(env, LOCK_WAIT_TIMEOUT_MS);
  if (!locked) {
    return errorResponse(503, 'Browser Rendering is busy with another report/map generation — please try again in a few minutes.');
  }

  let captured;
  try {
    captured = await captureAllMaps(env, request);
  } catch (err) {
    return errorResponse(500, `Map screenshot failed: ${err.message || err}`);
  } finally {
    await releaseGenerationLock(env);
  }

  // Keeps the cached maps/*.png files in sync with a manual regenerate
  // too, reusing the bytes just captured (no second browser launch).
  // Doesn't block the response — a slow GitHub write shouldn't make
  // "Regenerate" feel slower than it has to. Also records the deploy
  // version live right now as what this capture reflects (captureAllMaps
  // screenshots the live deployed site, so that's an accurate stamp) —
  // without this, a manual regenerate left maps-meta.json's freshness
  // marker untouched even though the images themselves were current,
  // which would make report-pdf.js's waitForFreshMaps poll and time out
  // needlessly on the next download.
  if (ctx) {
    ctx.waitUntil(
      getFile(env, DEPLOY_VERSION_PATH)
        .then((f) => saveMapsNow(env, captured, committerFromRequest(request), f ? f.content.trim() : undefined))
        .catch((err) => {
          console.error('Failed to save maps to the repo archive:', err);
        })
    );
  }

  const world = `data:image/png;base64,${toBase64(captured.world)}`;
  const divisions = {};
  for (const [key, bytes] of Object.entries(captured.divisions)) {
    divisions[key] = `data:image/png;base64,${toBase64(bytes)}`;
  }
  return new Response(JSON.stringify({ world, divisions }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
