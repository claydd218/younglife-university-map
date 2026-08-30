// Shared setup for every /bigtime/api/*-screenshot route — launches a
// headless-Chrome page (Cloudflare Browser Rendering, via env.BROWSER) on
// the live public map, waits for it to finish rendering, and hides the
// report-only chrome (title, controls, legend) so the screenshot is just
// the map itself. Callers do their own framing (setView/fitBounds) before
// calling page.screenshot().

import puppeteer from '@cloudflare/puppeteer';

// The map fetches its own CSV/GeoJSON data and builds ~250 country shapes
// plus every ministry marker after the page loads — waitForFunction below
// is the real gate, this is just a hard backstop against hanging forever
// if that signal never fires for some reason.
const READY_TIMEOUT_MS = 20000;

export async function openMapPage(env, request, viewport) {
  const browser = await puppeteer.launch(env.BROWSER);
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const mapUrl = new URL('/', request.url);
  await page.goto(mapUrl.toString(), { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__mapReady === true', { timeout: READY_TIMEOUT_MS });
  // Injected here rather than in the public site's own CSS/JS so regular
  // visitors are never affected by report/map-only chrome changes.
  await page.addStyleTag({
    content: '#site-title, .leaflet-control-container, #legend { display: none !important; }',
  });
  return { browser, page };
}

// A couple of animation frames' worth of settling time after reframing
// the view (setView/fitBounds) — gives the vector country layer and
// marker clusters a moment to actually redraw before the screenshot is
// taken.
export async function settleAfterReframe(page) {
  await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
