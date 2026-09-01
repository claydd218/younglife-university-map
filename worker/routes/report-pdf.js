// Routes GET /bigtime/api/report-pdf — generates a real multi-page PDF of
// /bigtime/reports2's content using Puppeteer's native page.pdf(), called
// once per section (the overview page, then once per division) instead of
// once for the whole document. Each call gets its own static
// headerTemplate/footerTemplate baked in for that section — genuinely
// page-aware, unlike bigtime/reports/'s plain-CSS-pagination approach:
// Chrome repeats whatever header/footer a single page.pdf() call is given
// on every physical page THAT call produces, so a division whose content
// spans 3 pages gets the same (correct, division-specific) footer on all
// 3, without ever needing to know "which page is this" — the question
// that sank the Paged.js attempt (see bigtime/reports2/reports2.js's
// header comment) and that plain CSS can't answer at all.
//
// The per-section PDFs are merged into one file with pdf-lib and returned
// as a download.

import puppeteer from '@cloudflare/puppeteer';
import { errorResponse } from '../lib/http.js';
import { PDFDocument } from 'pdf-lib';

const VIEWPORT = { width: 1600, height: 1200 };
// Ministry data + every ministry/staff photo has to load (same as the
// on-screen preview) before the report is ready to be sectioned off —
// see reports2.js's window.__reportReady. Generous: this waits on real
// network round trips (GitHub-backed API, dozens of images), not just
// rendering.
const REPORT_READY_TIMEOUT_MS = 60000;
// Six-ish page.pdf() calls (overview + one per division) plus a pdf-lib
// merge — same reasoning as worker/lib/mapCapture.js's CAPTURE_TIMEOUT_MS
// for why this needs real headroom, not just what "should" be fast.
const GENERATE_TIMEOUT_MS = 280000;
const CLOSE_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function footerTemplateFor(text) {
  // Chrome renders header/footer templates in their own isolated document
  // (no access to the report's own stylesheet), so this is a fully
  // self-contained inline-styled snippet rather than a class name.
  return `<div style="width:100%; font-size:9px; text-align:center; color:#888; font-family: Georgia, 'EB Garamond', serif;">${text}</div>`;
}

async function generatePdf(env, request) {
  const reportUrl = new URL('/bigtime/reports2', request.url);
  const cookie = request.headers.get('Cookie') || '';

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    // report-pdf.js's own request already proved the caller is logged in
    // (worker/index.js's session check ran before this route did) —
    // forwarding that same cookie is what lets this internal Puppeteer
    // navigation into the auth-gated /bigtime/reports2 without a second
    // login step.
    if (cookie) await page.setExtraHTTPHeaders({ Cookie: cookie });
    await page.goto(reportUrl.toString(), { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__reportReady === true', { timeout: REPORT_READY_TIMEOUT_MS });

    // Print media first — reports2.js's __shrinkImagesForPdf reads each
    // image's *rendered* box (clientWidth/Height) to decide how much to
    // downscale it by, and that box is smaller under print CSS (e.g.
    // .report-map-shot's max-height:460px) than it is on screen.
    await page.emulateMediaType('print');

    const generatedLabel = await page.evaluate('window.__reportGeneratedLabel');
    const divisionLabels = await page.evaluate('Object.fromEntries(Object.entries(DIVISIONS).map(([k, d]) => [k, d.label]))');
    const sectionKeys = await page.evaluate('window.__allSectionKeys()');

    const pdfBuffers = [];
    for (const key of sectionKeys) {
      await page.evaluate(`window.__showOnlySection(${JSON.stringify(key)})`);
      // Shrunk per-section (only this section's images are visible right
      // now), not once for the whole report — decoding a division's
      // dozen-ish photos at a time instead of every photo across all 5
      // divisions at once is what keeps this from spiking the renderer's
      // own memory and crashing the session outright. See reports2.js's
      // comment on this function for the full story (an earlier version
      // of this fix got this backwards).
      await page.evaluate('window.__shrinkImagesForPdf()');
      const footerText = key === 'overview'
        ? `Young Life University International Ministries — ${generatedLabel}`
        : `Young Life University International Ministries — ${divisionLabels[key]} — ${generatedLabel}`;
      // Explicit format/landscape/margin, not preferCSSPageSize — the
      // page's own @page rule sets `size: landscape` (a bare keyword, no
      // explicit dimensions), and letting Chrome's PDF engine resolve
      // that itself produced a nonsense page size ("Invalid typed array
      // length: 165408426" — ~158MB for a few PNG-embedded pages is not
      // real content, it's a degenerate size calculation). Format+margin
      // here reproduce the same geometry explicitly instead.
      const pdfBytes = await page.pdf({
        format: 'Letter',
        landscape: true,
        margin: { top: '14mm', right: '16mm', bottom: '14mm', left: '16mm' },
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: footerTemplateFor(footerText),
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

export async function onRequestGet({ request, env, ctx }) {
  if (!env.BROWSER) {
    return errorResponse(500, 'Browser Rendering isn\'t configured for this Worker (env.BROWSER missing) — check wrangler.toml\'s [browser] binding and that it\'s enabled on the Cloudflare dashboard for this account.');
  }

  // Raced against the timeout below, not awaited directly — if the
  // timeout wins, generatePdf() (and its own finally-block browser.close())
  // is still running. ctx.waitUntil keeps that alive after this request
  // has already returned an error response, so a timed-out capture still
  // gets its browser session torn down instead of leaking one that would
  // count against Browser Rendering's concurrency limit for the next call.
  const workPromise = generatePdf(env, request);
  if (ctx) ctx.waitUntil(workPromise.catch(() => {}));

  let pdfBytes;
  try {
    pdfBytes = await withTimeout(
      workPromise,
      GENERATE_TIMEOUT_MS,
      `PDF generation timed out after ${GENERATE_TIMEOUT_MS}ms — likely a stuck Browser Rendering session, not a code loop`
    );
  } catch (err) {
    return errorResponse(500, `PDF generation failed: ${err.message || err}`);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="ministry-report-${dateStr}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
