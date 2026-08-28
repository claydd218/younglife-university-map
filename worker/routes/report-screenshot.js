// Routes GET /bigtime/api/report-screenshot — captures the live public map
// as a PNG for the /bigtime/reports PDF's first page. Uses Cloudflare's
// Browser Rendering (a real headless Chrome instance, via env.BROWSER —
// see wrangler.toml) rather than a client-side DOM-to-canvas library, since
// this map is SVG + custom-font/CSS heavy in ways those tend to render
// imperfectly.

import puppeteer from '@cloudflare/puppeteer';
import { errorResponse } from '../lib/http.js';

// Taller than the public site's own aspect ratio — the extra height is
// what keeps Patagonia in frame at REPORT_ZOOM below (verified against
// map.getBounds(): south -57.8° at this exact width/height/zoom/center
// combination, well past Tierra del Fuego's -55.9°). The displayed <img>
// is capped back down via CSS (see index.html's .report-map-shot) so this
// resolution doesn't dictate how large the map looks on the page.
const VIEWPORT = { width: 1600, height: 1040 };
// Tighter than the public map's own initial zoom (CONFIG.MAP_ZOOM, 2.5) —
// at 2.5 the world is narrower than VIEWPORT.width, so Leaflet's
// worldCopyJump repeats a second copy of the map and Russia shows up on
// both edges at once. 2.75 is the smallest step on the map's zoomSnap:0.25
// grid (js/app.js) that's wide enough to show just one world copy — at
// this width/zoom the visible longitude span is ~334° of 360°, verified
// via map.getBounds().
const REPORT_ZOOM = 2.75;
const REPORT_CENTER = [35, 0];
// The map fetches its own CSV/GeoJSON data and builds ~250 country shapes
// plus every ministry marker after the page loads — waitForFunction below
// is the real gate, this is just a hard backstop against hanging forever
// if that signal never fires for some reason.
const READY_TIMEOUT_MS = 20000;

export async function onRequestGet({ request, env }) {
  if (!env.BROWSER) {
    return errorResponse(500, 'Browser Rendering isn\'t configured for this Worker (env.BROWSER missing) — check wrangler.toml\'s [browser] binding and that it\'s enabled on the Cloudflare dashboard for this account.');
  }

  const mapUrl = new URL('/', request.url);

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(mapUrl.toString(), { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__mapReady === true', { timeout: READY_TIMEOUT_MS });
    // Report-only framing — window.__reportMap is exposed by js/app.js
    // specifically for this. animate:false makes it instant instead of
    // waiting out Leaflet's pan/zoom transition; the two rAFs afterward
    // give the vector country layer and marker clusters a moment to
    // actually redraw at the new zoom before the screenshot is taken.
    await page.evaluate(
      `window.__reportMap.setView([${REPORT_CENTER[0]}, ${REPORT_CENTER[1]}], ${REPORT_ZOOM}, { animate: false })`
    );
    await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    // Report-only cleanup — hides the decorative title bar and every map
    // control (zoom, the directory/search magnifying-glass icon, Leaflet's
    // attribution text) so the screenshot is just the map itself. Injected
    // here rather than in the public site's own CSS/JS so regular visitors
    // are never affected by report-specific chrome changes.
    await page.addStyleTag({
      content: '#site-title, .leaflet-control-container, #legend { display: none !important; }',
    });
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
