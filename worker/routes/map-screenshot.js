// Routes GET /bigtime/api/map-screenshot — captures the live public map as
// a bundle of PNGs: the whole world plus one zoomed-in map per division
// (js/config.js's DIVISIONS), each cropped to fully show that division's
// countries. Manual "Regenerate" trigger for /bigtime/maps — the normal,
// fast path for both /bigtime/maps and /bigtime/reports is now reading the
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

export async function onRequestGet({ request, env, ctx }) {
  if (!env.BROWSER) {
    return errorResponse(500, 'Browser Rendering isn\'t configured for this Worker (env.BROWSER missing) — check wrangler.toml\'s [browser] binding and that it\'s enabled on the Cloudflare dashboard for this account.');
  }

  let captured;
  try {
    captured = await captureAllMaps(env, request);
  } catch (err) {
    return errorResponse(500, `Map screenshot failed: ${err.message || err}`);
  }

  // Keeps the cached maps/*.png files in sync with a manual regenerate
  // too, reusing the bytes just captured (no second browser launch).
  // Doesn't block the response — a slow GitHub write shouldn't make
  // "Regenerate" feel slower than it has to.
  if (ctx) {
    ctx.waitUntil(
      saveMapsNow(env, captured, committerFromRequest(request)).catch((err) => {
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
