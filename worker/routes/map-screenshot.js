// Routes GET /bigtime/api/map-screenshot — captures the live public map as
// a bundle of PNGs: the whole world plus one zoomed-in map per division
// (js/config.js's DIVISIONS), each cropped to fully show that division's
// countries. Used by both /bigtime/maps and /bigtime/reports (the world
// shot is the overview page's map; each division shot sits between that
// division's title and metrics).
//
// Everything is captured from a single browser/page session — Cloudflare
// Browser Rendering rate-limits new-browser creation, and the previous
// version (one browser launch per division, six total per page load) hit
// that limit ("Unable to create new browser: 429"). One navigation/wait,
// then reframe-and-reshoot per view, avoids six repeats of the page load
// and stays well under that limit regardless of how many divisions exist.
//
// Response is JSON: { world: "data:image/png;base64,...", divisions: {
// <key>: "data:image/png;base64,...", ... } } — base64 data URLs rather
// than a raw multi-image response so the client can just set them as
// <img src> directly.

import { errorResponse } from '../lib/http.js';
import { openMapPage, settleAfterReframe } from '../lib/mapScreenshot.js';

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
function toBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function toDataUrl(page) {
  const png = await page.screenshot({ type: 'png' });
  return `data:image/png;base64,${toBase64(png)}`;
}

export async function onRequestGet({ request, env }) {
  if (!env.BROWSER) {
    return errorResponse(500, 'Browser Rendering isn\'t configured for this Worker (env.BROWSER missing) — check wrangler.toml\'s [browser] binding and that it\'s enabled on the Cloudflare dashboard for this account.');
  }

  let browser;
  try {
    const opened = await openMapPage(env, request, WORLD_VIEWPORT);
    browser = opened.browser;
    const { page } = opened;

    await page.evaluate(
      `window.__reportMap.setView([${WORLD_CENTER[0]}, ${WORLD_CENTER[1]}], ${WORLD_ZOOM}, { animate: false })`
    );
    await settleAfterReframe(page);
    const world = await toDataUrl(page);

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
      divisions[key] = await toDataUrl(page);
    }

    return new Response(JSON.stringify({ world, divisions }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return errorResponse(500, `Map screenshot failed: ${err.message || err}`);
  } finally {
    if (browser) await browser.close();
  }
}
