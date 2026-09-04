// Routes GET /bigtime/api/report-pdf — serves the cached report PDF
// (reports/ministry-report.pdf, kept fresh automatically by
// worker/lib/reportArchive.js after admin edits) when it's still current,
// and falls back to a live Puppeteer generation
// (worker/lib/reportCapture.js) — committing the result as the new cache
// before returning it — when it isn't. The live path is the only slow
// one; bigtime/admin.js's button shows a "generating" state for the
// duration of its one fetch either way, since the client can't know in
// advance which path a given click will take.

import { errorResponse } from '../lib/http.js';
import { getObject } from '../lib/r2.js';
import { getDataVersion } from '../lib/dataVersion.js';
import { generateReportPdf, withTimeout, GENERATE_TIMEOUT_MS } from '../lib/reportCapture.js';
import { captureAllMaps } from '../lib/mapCapture.js';
import { isMapsCacheFreshFor, saveMapsNow } from '../lib/mapArchive.js';
import { tryAcquireGenerationLock, releaseGenerationLock } from '../lib/browserLock.js';
import {
  getReportCacheStatus,
  saveReportNow,
  PDF_PATH,
} from '../lib/reportArchive.js';

async function servableFromCache(env) {
  const { fresh, meta } = await getReportCacheStatus(env);
  if (!fresh) return null;
  const object = await getObject(env, PDF_PATH);
  if (!object) return null;
  return { bytes: await object.arrayBuffer(), generatedAt: meta.generatedAt };
}

// Polls the cache (not the lock directly — the lock only says *someone*
// is generating, this is what tells us they actually finished) while a
// regeneration this request didn't start — almost always the background
// job worker/lib/reportArchive.js's regenerateReportArchive kicked off
// from the admin edit that just invalidated the cache — is presumably
// still running. Same rough budget as GENERATE_TIMEOUT_MS, since that's
// genuinely how long the other generation could still legitimately take.
const POLL_INTERVAL_MS = 5000;
async function pollForFreshCache(env, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const result = await servableFromCache(env);
    if (result) return result;
  }
  return null;
}

// maps/*.png are kept fresh by a completely separate background job
// (worker/lib/mapArchive.js's regenerateMapArchive, triggered by the same
// ministry edit as this report's own invalidation), which can still be
// running (or have lost the shared Browser Rendering lock and skipped
// itself) by the time this request needs them. Since this request
// already holds that lock for its own report generation, it's simpler
// and more reliable to just capture fresh maps itself right here when
// they're stale, rather than wait on a separate job that may not finish
// in time — no deploy-wait step needed either way: R2 has no read
// replication, so the moment saveMapsNow() returns, the bytes it just
// wrote are already what any subsequent fetch (including this report's
// own Puppeteer page load) will see.
async function ensureFreshMaps(env, request, deployVersion) {
  if (await isMapsCacheFreshFor(env, deployVersion)) return;
  try {
    const captured = await captureAllMaps(env, request);
    await saveMapsNow(env, captured, deployVersion);
  } catch (err) {
    console.error('Report generation: failed to refresh stale maps before embedding — using whatever is currently cached.', err);
  }
}

// Reflects when the PDF was actually generated, not "today" — a re-served
// cached copy wasn't made today, and claiming otherwise isn't accurate.
function reportFilename(generatedAt) {
  const d = generatedAt ? new Date(generatedAt) : new Date();
  const month = d.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
  return `yl-uni-intl-ministry-report-${month}-${d.getFullYear()}.pdf`;
}

function pdfResponse(pdfBytes, generatedAt) {
  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${reportFilename(generatedAt)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestGet({ request, env, ctx }) {
  if (!env.BROWSER) {
    return errorResponse(500, 'Browser Rendering isn\'t configured for this Worker (env.BROWSER missing) — check wrangler.toml\'s [browser] binding and that it\'s enabled on the Cloudflare dashboard for this account.');
  }

  const cached = await servableFromCache(env);
  if (cached) return pdfResponse(cached.bytes, cached.generatedAt);

  // Cache is stale/missing. If a regeneration is already running —
  // almost always the background job an admin edit just triggered (see
  // reportArchive.js) — wait for it and serve what it produces instead of
  // racing a second, competing Puppeteer session: confirmed live, two at
  // once can crash both ("Protocol error ... Target closed"), almost
  // certainly Browser Rendering's own concurrent-session limit for this
  // account.
  let acquired = await tryAcquireGenerationLock(env);
  if (!acquired) {
    const polled = await pollForFreshCache(env, GENERATE_TIMEOUT_MS);
    if (polled) return pdfResponse(polled.bytes, polled.generatedAt);
    // The other generation didn't finish (or never released its lock —
    // it self-expires, but not necessarily within our own poll window)
    // — try once more to claim it ourselves rather than leaving the
    // admin with nothing after all that waiting.
    acquired = await tryAcquireGenerationLock(env);
    if (!acquired) {
      return errorResponse(503, 'A report is already being generated — please try again in a few minutes.');
    }
  }

  try {
    // Read once, up front, and reused below for both the maps-freshness
    // check and (after generation) what gets recorded to report-meta.json
    // — deliberately the version from *before* generation started, not
    // after. If another edit lands during the several minutes this takes,
    // recording the later value would mark this result "fresh" for data
    // it was never actually generated against; recording this earlier one
    // means the next request correctly sees it as stale again instead.
    const currentDeployVersion = await getDataVersion(env);

    // See ensureFreshMaps's own comment above — captures fresh maps itself
    // (best-effort) when they're stale, rather than hoping a separate job
    // already has or eventually will.
    await ensureFreshMaps(env, request, currentDeployVersion);

    // Raced against the timeout below, not awaited directly — if the
    // timeout wins, generateReportPdf() (and its own finally-block
    // browser.close()) is still running. ctx.waitUntil keeps that alive
    // after this request has already returned an error response, so a
    // timed-out generation still gets its browser session torn down
    // instead of leaking one that would count against Browser Rendering's
    // concurrency limit for the next call.
    const workPromise = generateReportPdf(env, request);
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

    const generatedAt = new Date().toISOString();
    // Saved before responding — unlike the background regeneration path
    // (reportArchive.js's regenerateReportArchive, triggered by an
    // unrelated admin write that shouldn't be held up by this), there's
    // no other request here to avoid blocking: the admin is already
    // waiting through the generation itself, so a moment more to commit
    // the cache is negligible, and it guarantees the very next click hits
    // the fast cached path instead of regenerating all over again.
    try {
      await saveReportNow(env, pdfBytes, currentDeployVersion);
    } catch (err) {
      console.error('Failed to save the freshly-generated report to the cache (still returning it to this request):', err);
    }

    return pdfResponse(pdfBytes, generatedAt);
  } finally {
    await releaseGenerationLock(env);
  }
}
