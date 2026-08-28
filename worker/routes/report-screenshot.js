// Routes GET /bigtime/api/report-screenshot — captures the live public map
// as a PNG for the /bigtime/reports PDF's first page. Uses Cloudflare's
// Browser Rendering (a real headless Chrome instance, via env.BROWSER —
// see wrangler.toml) rather than a client-side DOM-to-canvas library, since
// this map is SVG + custom-font/CSS heavy in ways those tend to render
// imperfectly.

import puppeteer from '@cloudflare/puppeteer';
import { errorResponse } from '../lib/http.js';

// Landscape-friendly proportions, large enough to look sharp in a printed
// report without an excessive capture/encode cost.
const VIEWPORT = { width: 1600, height: 900 };
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
