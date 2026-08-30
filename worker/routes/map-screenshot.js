// Routes GET /bigtime/api/map-screenshot[?division=<key>] — captures the
// live public map as a PNG, either the whole world (no division param, same
// framing as report-screenshot.js's page one) or zoomed to fully show one
// division's countries (division param, one of js/config.js's DIVISIONS
// keys). Built for /bigtime/maps. Shares its browser-launch/wait/
// chrome-hiding boilerplate with report-screenshot.js via lib/mapScreenshot.js.

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

export async function onRequestGet({ request, env }) {
  if (!env.BROWSER) {
    return errorResponse(500, 'Browser Rendering isn\'t configured for this Worker (env.BROWSER missing) — check wrangler.toml\'s [browser] binding and that it\'s enabled on the Cloudflare dashboard for this account.');
  }

  const division = new URL(request.url).searchParams.get('division');

  let browser;
  try {
    if (division) {
      // A throwaway small viewport just to get the page loaded — resized
      // below once the division's actual bounds/aspect ratio are known.
      const opened = await openMapPage(env, request, { width: 1024, height: 768 });
      browser = opened.browser;
      const { page } = opened;

      const bounds = await page.evaluate(`window.__divisionBounds(${JSON.stringify(division)})`);
      if (!bounds) return errorResponse(400, `Unknown or empty division: ${division}`);

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

      const png = await page.screenshot({ type: 'png' });
      return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
    }

    const opened = await openMapPage(env, request, WORLD_VIEWPORT);
    browser = opened.browser;
    const { page } = opened;
    await page.evaluate(
      `window.__reportMap.setView([${WORLD_CENTER[0]}, ${WORLD_CENTER[1]}], ${WORLD_ZOOM}, { animate: false })`
    );
    await settleAfterReframe(page);

    const png = await page.screenshot({ type: 'png' });
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
  } catch (err) {
    return errorResponse(500, `Map screenshot failed: ${err.message || err}`);
  } finally {
    if (browser) await browser.close();
  }
}
