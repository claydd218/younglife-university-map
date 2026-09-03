// Generates the merged multi-page report PDF via Puppeteer's native
// page.pdf() — called once per section (the overview page, then once per
// division) instead of once for the whole document, each with its own
// static headerTemplate/footerTemplate baked in for that section. Chrome
// repeats whatever header/footer a single page.pdf() call is given on
// every physical page THAT call produces, so a division whose content
// spans 3 pages gets the same (correct, division-specific) footer on all
// 3, without ever needing to know "which page is this". The per-section
// PDFs are merged into one file with pdf-lib.
//
// Extracted from worker/routes/report-pdf.js so it can be shared between
// that route's own live-generation fallback and worker/lib/reportArchive.js's
// background regeneration — mirrors mapCapture.js's relationship to
// mapArchive.js for the exact same reason.

import puppeteer from '@cloudflare/puppeteer';
import { PDFDocument } from 'pdf-lib';

const VIEWPORT = { width: 1600, height: 1200 };
// Ministry data + every ministry/staff photo has to load before the
// report is ready to be sectioned off — see bigtime/report/report.js's
// window.__reportReady. Generous: this waits on real network round trips
// (GitHub-backed API, dozens of images), not just rendering.
const REPORT_READY_TIMEOUT_MS = 60000;
// Six-ish page.pdf() calls (overview + one per division) plus a pdf-lib
// merge — same reasoning as mapCapture.js's CAPTURE_TIMEOUT_MS for why
// this needs real headroom, not just what "should" be fast.
const GENERATE_TIMEOUT_MS = 280000;
const CLOSE_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// No footer at all — used for every map page (the world map / a
// division's title+map+metrics page), since that page already shows the
// report or division title on-page; repeating it in a footer is
// redundant. A literal empty string still leaves Chrome to fall back to
// its own default footer, so this has to be explicitly empty markup, the
// same way headerTemplate below always is.
const NO_FOOTER = '<span></span>';

function footerTemplateFor(text, color) {
  // Chrome renders header/footer templates in their own isolated document
  // (no access to the report's own stylesheet), so this is a fully
  // self-contained inline-styled snippet rather than a class name.
  return `<div style="width:100%; font-size:9px; text-align:center; color:${color}; font-family: Georgia, 'EB Garamond', serif;">${text}</div>`;
}

async function generateWithPage(env, request) {
  const reportUrl = new URL('/bigtime/report', request.url);
  const cookie = request.headers.get('Cookie') || '';

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    // Whoever's calling this already proved they're logged in (the
    // Worker's own session check ran before either the route or the
    // background regeneration that leads here) — forwarding that same
    // cookie is what lets this internal Puppeteer navigation into the
    // auth-gated /bigtime/report without a second login step.
    if (cookie) await page.setExtraHTTPHeaders({ Cookie: cookie });
    await page.goto(reportUrl.toString(), { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__reportReady === true', { timeout: REPORT_READY_TIMEOUT_MS });

    // Print media first — report.js's __shrinkImagesForPdf reads each
    // image's *rendered* box (clientWidth/Height) to decide how much to
    // downscale it by, and that box is smaller under print CSS (e.g.
    // .report-map-shot's max-height:460px) than it is on screen.
    await page.emulateMediaType('print');

    const generatedLabel = await page.evaluate('window.__reportGeneratedLabel');
    const divisionInfo = await page.evaluate('Object.fromEntries(Object.entries(DIVISIONS).map(([k, d]) => [k, { label: d.label, pin: d.pin }]))');
    const sectionParts = await page.evaluate('window.__allSectionParts()');

    const pdfBuffers = [];
    for (const { key, part } of sectionParts) {
      await page.evaluate(`window.__showOnlySectionPart(${JSON.stringify(key)}, ${JSON.stringify(part)})`);
      // Shrunk per section/part (only what's visible right now), not once
      // for the whole report — decoding a division's dozen-ish photos at a
      // time instead of every photo across all 5 divisions at once is what
      // keeps this from spiking the renderer's own memory and crashing the
      // session outright.
      await page.evaluate('window.__shrinkImagesForPdf()');
      // Every map page (the overview's world map, and a division's own
      // title+map+metrics page) already shows the report/division title
      // on-page, so a repeated footer there is redundant — only the
      // ministry-listing pages get one, in that division's own color
      // (matching the title's own color on the page before it). A single
      // page.pdf() call can't vary its footer from page to page, which is
      // exactly why the header/areas split (report.js's
      // __allSectionParts) exists.
      const footerTemplate = part === 'areas'
        ? footerTemplateFor(`Young Life University International Ministries — ${divisionInfo[key].label} — ${generatedLabel}`, divisionInfo[key].pin)
        : NO_FOOTER;
      // Explicit format/landscape/margin, not preferCSSPageSize — the
      // page's own @page rule sets `size: landscape` (a bare keyword, no
      // explicit dimensions), and letting Chrome's PDF engine resolve
      // that itself produced a nonsense page size. Format+margin here
      // reproduce the same geometry explicitly instead.
      const pdfBytes = await page.pdf({
        format: 'Letter',
        landscape: true,
        margin: { top: '14mm', right: '16mm', bottom: '14mm', left: '16mm' },
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate,
      });
      pdfBuffers.push(pdfBytes);
    }

    const merged = await PDFDocument.create();
    for (const bytes of pdfBuffers) {
      const src = await PDFDocument.load(bytes);
      const copiedPages = await merged.copyPages(src, src.getPageIndices());
      for (const copiedPage of copiedPages) merged.addPage(copiedPage);
    }
    return await merged.save();
  } finally {
    if (browser) {
      await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, 'browser.close() timed out').catch((err) => {
        console.error('Failed to close the report-PDF browser session cleanly:', err);
      });
    }
  }
}

// -> Uint8Array of the merged PDF. Throws if env.BROWSER isn't configured.
// Deliberately NOT timeout-wrapped in here — the two callers need this raw,
// un-raced promise for different reasons:
//
// - worker/routes/report-pdf.js's own live-generation fallback returns an
//   HTTP response early if this hangs, and Cloudflare can tear down the
//   whole execution context once a response goes out unless something
//   (ctx.waitUntil) is explicitly keeping it alive — so that route passes
//   THIS raw promise to ctx.waitUntil itself, separately from whatever
//   timeout race decides what the response waits for. Wrapping the timeout
//   in here would hide that raw promise from it entirely.
// - worker/lib/reportArchive.js's background regeneration never returns an
//   early response at all (the entire call is already inside its own
//   caller's ctx.waitUntil from the start), so it can just await this
//   directly with its own timeout race — same as mapCapture.js's
//   captureAllMaps/mapArchive.js's regenerateMapArchive.
//
// Either way, generateWithPage's own try/finally always closes the browser
// once IT actually settles, regardless of whether a caller's race against
// GENERATE_TIMEOUT_MS gave up on waiting for it first.
export async function generateReportPdf(env, request) {
  if (!env.BROWSER) {
    throw new Error('Browser Rendering isn\'t configured for this Worker (env.BROWSER missing) — check wrangler.toml\'s [browser] binding and that it\'s enabled on the Cloudflare dashboard for this account.');
  }
  return generateWithPage(env, request);
}

export { withTimeout, GENERATE_TIMEOUT_MS };
