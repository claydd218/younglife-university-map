// Persists captureAllMaps()'s output (worker/lib/mapCapture.js) to
// maps/*.png in the repo, so /bigtime/reports and /bigtime/maps can read
// them as plain static files instead of running a live Puppeteer capture
// on every page load. Called from two places, both via ctx.waitUntil so
// the triggering request is never held up by however long this takes:
//
// - worker/routes/map-screenshot.js, after a manual "Regenerate" — the
//   page being screenshotted is already live, so saveMapsNow() just
//   commits what was already captured for the response.
// - worker/routes/ministries.js and ministry-detail.js, automatically on
//   every ministry add/edit/delete — regenerateMapArchive() has to wait
//   for the triggering commit to actually go live first (Cloudflare's
//   build+deploy takes real time), otherwise it would screenshot the
//   public map before it reflects the change that triggered this, and
//   silently archive a stale image.

import { listDir, putFileBase64 } from './github.js';
import { captureAllMaps, toBase64 } from './mapCapture.js';

const MAPS_DIR = 'maps';
// Deploys in this project have taken up to ~80s in past observation;
// this leaves real headroom without letting one hung build block the
// background task indefinitely.
const DEPLOY_WAIT_TIMEOUT_MS = 150000;
const DEPLOY_WAIT_INTERVAL_MS = 5000;

async function waitForDeploy(request, expectedVersion) {
  if (!expectedVersion) return false;
  const url = new URL('/data/deploy-version.txt', request.url).toString();
  const deadline = Date.now() + DEPLOY_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok && (await res.text()).trim() === expectedVersion) return true;
    } catch {
      // transient network hiccup — just retry until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, DEPLOY_WAIT_INTERVAL_MS));
  }
  return false;
}

// `captured` is captureAllMaps()'s return shape: { world, divisions }.
export async function saveMapsNow(env, captured, commit) {
  const existing = await listDir(env, MAPS_DIR);
  const shaByName = new Map(existing.map((f) => [f.name, f.sha]));

  const entries = [['world', captured.world], ...Object.entries(captured.divisions)];
  for (const [key, bytes] of entries) {
    const filename = `${key}.png`;
    await putFileBase64(env, `${MAPS_DIR}/${filename}`, toBase64(bytes), {
      sha: shaByName.get(filename),
      message: `Update map: ${filename}`,
      ...commit,
    });
  }
}

// Waits for deployVersion (from lib/deployVersion.js's bumpDeployVersion,
// called right after the ministry change that should trigger this) to
// actually go live, then captures and saves every map. Skips the capture
// entirely — logging instead of throwing, since this always runs detached
// inside ctx.waitUntil — if the deploy doesn't land within the timeout.
export async function regenerateMapArchive(env, request, deployVersion, commit) {
  if (!env.BROWSER) return;
  const deployed = await waitForDeploy(request, deployVersion);
  if (!deployed) {
    console.error(`Map archive: deploy version ${deployVersion} did not go live within ${DEPLOY_WAIT_TIMEOUT_MS}ms — skipping capture to avoid saving a stale map.`);
    return;
  }
  const captured = await captureAllMaps(env, request);
  await saveMapsNow(env, captured, commit);
}
