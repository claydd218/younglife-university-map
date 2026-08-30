// Core logic for capturing the whole-world map plus one zoomed-in map per
// division (js/config.js's DIVISIONS), from a single browser/page session
// — Cloudflare Browser Rendering rate-limits new-browser creation, and an
// earlier version (one browser launch per division) hit that limit
// ("Unable to create new browser: 429"). Returns raw PNG bytes
// (Uint8Array); callers decide how to encode them — base64 data URLs for
// worker/routes/map-screenshot.js's JSON response, or a plain base64
// string for worker/lib/mapArchive.js to commit straight to the repo.

import { openMapPage, settleAfterReframe } from './mapScreenshot.js';

const WORLD_VIEWPORT = { width: 1600, height: 1120 };
const WORLD_ZOOM = 2.75;
const WORLD_CENTER = [35, 0];

// Divisions vary hugely in shape, not just size — Europe is tall and
// narrow (Iceland to Turkey), Middle East & Central Asia is wide and flat
// (Turkey to Russia's Pacific coast). Rather than force every division
// into the same fixed rectangle (leaving empty ocean padded onto whichever
// axis doesn't need it), the longer axis is capped at DIVISION_MAX_DIM and
// the other axis is sized to whatever the division's own bounds need —
// see the aspect-ratio calculation below.
const DIVISION_MAX_DIM = 1400;
const DIVISION_MIN_DIM = 500;
const DIVISION_PADDING = [40, 40];
// Any zoom works here — map.project() at a fixed zoom is only used to
// measure the *ratio* between the bounds' projected width and height, and
// that ratio (unlike literal pixel counts) doesn't depend on which zoom
// was used to measure it.
const ASPECT_REFERENCE_ZOOM = 10;

// The Workers runtime has no Buffer.toString('base64') without leaning on
// nodejs_compat internals — btoa() is the portable primitive, but it only
// accepts a binary string, so this builds that string in chunks (a single
// String.fromCharCode(...bytes) call on a multi-hundred-KB PNG risks
// blowing the call stack).
export function toBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Returns { world: Uint8Array, divisions: { <key>: Uint8Array, ... } }.
export async function captureAllMaps(env, request) {
  let browser;
  try {
    const opened = await openMapPage(env, request, WORLD_VIEWPORT);
    browser = opened.browser;
    const { page } = opened;

    await page.evaluate(
      `window.__reportMap.setView([${WORLD_CENTER[0]}, ${WORLD_CENTER[1]}], ${WORLD_ZOOM}, { animate: false })`
    );
    await settleAfterReframe(page);
    const world = await page.screenshot({ type: 'png' });

    const divisionKeys = await page.evaluate('Object.keys(DIVISIONS)');
    const divisions = {};
    for (const key of divisionKeys) {
      const bounds = await page.evaluate(`window.__divisionBounds(${JSON.stringify(key)})`);
      if (!bounds) continue; // no countries currently mapped to this division

      // Only this division's own countries/pins should be colored —
      // otherwise whatever else happened to be un-clustered/visible in
      // this crop (a neighboring division's countries) lit up too.
      await page.evaluate(`window.__isolateDivision(${JSON.stringify(key)})`);

      const aspect = await page.evaluate(`(() => {
        const map = window.__reportMap;
        const b = ${JSON.stringify(bounds)};
        const p1 = map.project(L.latLng(b[0][0], b[0][1]), ${ASPECT_REFERENCE_ZOOM});
        const p2 = map.project(L.latLng(b[1][0], b[1][1]), ${ASPECT_REFERENCE_ZOOM});
        return Math.abs(p2.x - p1.x) / Math.abs(p2.y - p1.y);
      })()`);

      const viewport = aspect >= 1
        ? { width: DIVISION_MAX_DIM, height: Math.max(DIVISION_MIN_DIM, Math.round(DIVISION_MAX_DIM / aspect)) }
        : { width: Math.max(DIVISION_MIN_DIM, Math.round(DIVISION_MAX_DIM * aspect)), height: DIVISION_MAX_DIM };
      await page.setViewport(viewport);
      // Leaflet auto-invalidates on the window resize Puppeteer's
      // setViewport triggers (trackResize is on by default), but an
      // explicit call removes any doubt about ordering before fitBounds.
      await page.evaluate('window.__reportMap.invalidateSize(false)');
      await page.evaluate(
        `window.__reportMap.fitBounds(${JSON.stringify(bounds)}, { padding: ${JSON.stringify(DIVISION_PADDING)}, animate: false })`
      );
      await settleAfterReframe(page);
      divisions[key] = await page.screenshot({ type: 'png' });
    }

    return { world, divisions };
  } finally {
    if (browser) await browser.close();
  }
}
