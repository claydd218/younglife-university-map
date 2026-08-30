// Routes GET /bigtime/api/report-screenshot — captures the live public map
// as a PNG for the /bigtime/reports PDF's first page. Uses Cloudflare's
// Browser Rendering (a real headless Chrome instance, via env.BROWSER —
// see wrangler.toml) rather than a client-side DOM-to-canvas library, since
// this map is SVG + custom-font/CSS heavy in ways those tend to render
// imperfectly. Shares its browser-launch/wait/chrome-hiding boilerplate
// with map-screenshot.js via lib/mapScreenshot.js.

import { errorResponse } from '../lib/http.js';
import { openMapPage, settleAfterReframe } from '../lib/mapScreenshot.js';

// Taller than the public site's own aspect ratio — the extra height is
// what keeps Patagonia comfortably in frame (with room to spare below it)
// at REPORT_ZOOM below (verified against map.getBounds(): south -62.0° at
// this exact width/height/zoom/center combination, well past Tierra del
// Fuego's -55.9°). The displayed <img> is capped back down via CSS (see
// index.html's .report-map-shot) so this resolution doesn't dictate how
// large the map looks on the page.
const VIEWPORT = { width: 1600, height: 1120 };
// Tighter than the public map's own initial zoom (CONFIG.MAP_ZOOM, 2.5) —
// at 2.5 the world is narrower than VIEWPORT.width, so Leaflet's
// worldCopyJump repeats a second copy of the map and Russia shows up on
// both edges at once. 2.75 is the smallest step on the map's zoomSnap:0.25
// grid (js/app.js) that's wide enough to show just one world copy — at
// this width/zoom the visible longitude span is ~334° of 360°, verified
// via map.getBounds().
const REPORT_ZOOM = 2.75;
const REPORT_CENTER = [35, 0];

export async function onRequestGet({ request, env }) {
  if (!env.BROWSER) {
    return errorResponse(500, 'Browser Rendering isn\'t configured for this Worker (env.BROWSER missing) — check wrangler.toml\'s [browser] binding and that it\'s enabled on the Cloudflare dashboard for this account.');
  }

  let browser;
  try {
    const opened = await openMapPage(env, request, VIEWPORT);
    browser = opened.browser;
    const { page } = opened;
    // Report-only framing — window.__reportMap is exposed by js/app.js
    // specifically for this. animate:false makes it instant instead of
    // waiting out Leaflet's pan/zoom transition.
    await page.evaluate(
      `window.__reportMap.setView([${REPORT_CENTER[0]}, ${REPORT_CENTER[1]}], ${REPORT_ZOOM}, { animate: false })`
    );
    await settleAfterReframe(page);
    const png = await page.screenshot({ type: 'png' });
    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        // The report always wants a fresh capture, not a stale cached one
        // from an earlier data state.
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(500, `Map screenshot failed: ${err.message || err}`);
  } finally {
    if (browser) await browser.close();
  }
}
