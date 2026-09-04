// Persists captureAllMaps()'s output (worker/lib/mapCapture.js) to
// maps/*.png in R2, so /bigtime/report and /bigtime/maps can read them
// back instead of running a live Puppeteer capture on every page load.
// Called from two places, both via ctx.waitUntil so the triggering
// request is never held up by however long this takes:
//
// - worker/routes/map-screenshot.js, after a manual "Regenerate" — the
//   page being screenshotted is already live, so saveMapsNow() just
//   commits what was already captured for the response.
// - worker/routes/ministries.js and ministry-detail.js, automatically on
//   every ministry add/edit/delete.
//
// No more waiting for a deploy to catch up first (the old
// waitForDeploy() this file used to have): the public map now reads
// ministry data from D1 via GET /api/ministries (worker/routes/
// public-ministries.js), not a file in the deployed static bundle, so a
// Puppeteer navigation to "/" right after a write already sees it — D1's
// (no read replication) read-your-writes consistency, same reasoning
// worker/lib/dataVersion.js's own header comment gives.

import { putObject, getObject } from './r2.js';
import { captureAllMaps, toBase64 } from './mapCapture.js';
import { waitForGenerationLock, releaseGenerationLock } from './browserLock.js';

const MAPS_DIR = 'maps';
// Written alongside the PNGs whenever a deployVersion is known (the
// automatic ministry-edit trigger below, not the manual "Regenerate"
// button — that one isn't tied to any specific edit) — lets a caller
// elsewhere (worker/lib/reportArchive.js) check whether the *maps*
// specifically are caught up with the current data, not just whether the
// report's own cache is.
export const MAPS_META_PATH = `${MAPS_DIR}/maps-meta.json`;

// `captured` is captureAllMaps()'s return shape: { world, divisions }.
// `deployVersion`, when known, is recorded to MAPS_META_PATH — omitted
// (as the manual "Regenerate" button's own call here does) when this
// capture isn't tied to any specific edit.
export async function saveMapsNow(env, captured, deployVersion) {
  const entries = [['world', captured.world], ...Object.entries(captured.divisions)];
  for (const [key, bytes] of entries) {
    await putObject(env, `${MAPS_DIR}/${key}.png`, bytes, { contentType: 'image/png' });
  }

  if (deployVersion) {
    const meta = { generatedAt: new Date().toISOString(), deployVersion };
    await putObject(env, MAPS_META_PATH, new TextEncoder().encode(JSON.stringify(meta, null, 2)), { contentType: 'application/json' });
  }
}

// -> true if the maps currently in maps/*.png were captured against the
// same deployVersion as `expectedVersion` — false if stale or unknowable
// (no meta yet). A caller with nothing better to go on should treat
// "unknowable" the same as "stale".
export async function isMapsCacheFreshFor(env, expectedVersion) {
  if (!expectedVersion) return true;
  const object = await getObject(env, MAPS_META_PATH);
  if (!object) return false;
  try {
    return JSON.parse(await object.text()).deployVersion === expectedVersion;
  } catch {
    return false;
  }
}

// Same rationale as report-pdf.js's own wait budget: genuinely how long a
// concurrent report generation (the slowest thing that can hold this
// lock) could still legitimately be running.
const LOCK_WAIT_TIMEOUT_MS = 420000;

// Captures and saves every map, behind the shared Browser Rendering lock
// (see browserLock.js) so it can't collide with a concurrent report
// generation. Skips entirely — logging instead of throwing, since this
// always runs detached inside ctx.waitUntil — if that lock doesn't free
// up in time; the maps are simply left stale until the next ministry
// edit triggers another attempt.
export async function regenerateMapArchive(env, request, deployVersion) {
  if (!env.BROWSER) return;
  const locked = await waitForGenerationLock(env, LOCK_WAIT_TIMEOUT_MS);
  if (!locked) {
    console.error('Map archive: Browser Rendering stayed busy with another generation — skipping this capture; the next ministry edit will trigger another attempt.');
    return;
  }
  try {
    const captured = await captureAllMaps(env, request);
    await saveMapsNow(env, captured, deployVersion);
  } finally {
    await releaseGenerationLock(env);
  }
}
