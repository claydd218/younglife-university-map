// Persists generateReportPdf()'s output (worker/lib/reportCapture.js) to
// reports/ministry-report.pdf in R2, so the "Download Report PDF" button
// (bigtime/admin.js) can just re-serve that file instead of running a
// fresh 3+ minute Puppeteer generation on every click —
// worker/routes/report-pdf.js checks getReportCacheStatus() first and
// only falls back to a live generation when it isn't fresh. Same pattern
// as worker/lib/mapArchive.js for the exact same underlying problem.
//
// Called from six places, all via ctx.waitUntil so the triggering
// request is never held up by however long generation takes:
// worker/routes/ministries.js (create), ministry-detail.js (update,
// delete), upload.js and photo.js (photo changes show up in the report
// too, even though they don't move a map pin).

import { putObject, getObject } from './r2.js';
import { getDataVersion } from './dataVersion.js';
import { generateReportPdf, withTimeout, GENERATE_TIMEOUT_MS } from './reportCapture.js';
import { tryAcquireGenerationLock, releaseGenerationLock } from './browserLock.js';

const REPORTS_DIR = 'reports';
export const PDF_PATH = `${REPORTS_DIR}/ministry-report.pdf`;
export const META_PATH = `${REPORTS_DIR}/report-meta.json`;

// `deployVersion` is the data_version token that was live when `pdfBytes`
// was generated against it — recorded so a later request can tell
// whether anything's changed since (see getReportCacheStatus).
export async function saveReportNow(env, pdfBytes, deployVersion) {
  await putObject(env, PDF_PATH, pdfBytes, { contentType: 'application/pdf' });
  const meta = { generatedAt: new Date().toISOString(), deployVersion };
  await putObject(env, META_PATH, new TextEncoder().encode(JSON.stringify(meta, null, 2)), { contentType: 'application/json' });
}

// -> { fresh: boolean, meta: {generatedAt, deployVersion} | null }. Fresh
// iff a cached PDF+meta both exist, no admin write has happened since it
// was generated (deployVersion still matches the current data_version
// token — every ministry/photo write bumps that), and it's still the
// same calendar month (the report's own "Generated: <Month Year>" label
// would otherwise go stale with no admin activity at all to trigger a
// regeneration). Meta is still returned even when stale/missing, so a
// caller building a download filename after a fresh live-generation
// doesn't need a second read.
export async function getReportCacheStatus(env) {
  const [metaObject, currentDeployVersion] = await Promise.all([
    getObject(env, META_PATH),
    getDataVersion(env),
  ]);
  if (!metaObject) return { fresh: false, meta: null };
  let meta;
  try {
    meta = JSON.parse(await metaObject.text());
  } catch {
    return { fresh: false, meta: null };
  }

  if (!currentDeployVersion || currentDeployVersion !== meta.deployVersion) {
    return { fresh: false, meta };
  }
  const generated = new Date(meta.generatedAt);
  if (Number.isNaN(generated.getTime())) return { fresh: false, meta };
  const now = new Date();
  const fresh = generated.getUTCFullYear() === now.getUTCFullYear() && generated.getUTCMonth() === now.getUTCMonth();
  return { fresh, meta };
}

// Paused for a few weeks of heavy, concurrent editing from multiple
// people — a background regeneration on every single edit isn't worth it
// right now. This only controls whether an edit's invalidation gets acted
// on immediately; the invalidation itself doesn't live here at all (see
// getReportCacheStatus's deployVersion comparison above, which reads
// state bumpDataVersion already updates on every admin write regardless
// of this flag) — so a paused edit still correctly invalidates the cache,
// it just waits for the next Download click to notice and regenerate live
// instead of an automatic background one. Flip back to true to resume.
const BACKGROUND_REGEN_ENABLED = false;

// Generates and saves a fresh report, behind the shared Browser Rendering
// lock. No more waiting for a deploy first (see mapArchive.js's own
// comment on why) — D1/R2's read-after-write consistency means the data
// this generates against is already current the moment this runs.
export async function regenerateReportArchive(env, request, deployVersion) {
  if (!BACKGROUND_REGEN_ENABLED) return;
  if (!env.BROWSER) return;

  // If a live download request got here first (see report-pdf.js), let
  // that one own this generation — it'll save the result itself, which
  // is exactly what this background job exists to keep the next request
  // from having to do anyway.
  const acquired = await tryAcquireGenerationLock(env);
  if (!acquired) {
    console.error('Report archive: another generation is already in progress — skipping this regeneration.');
    return;
  }
  try {
    const pdfBytes = await withTimeout(
      generateReportPdf(env, request),
      GENERATE_TIMEOUT_MS,
      `Report regeneration timed out after ${GENERATE_TIMEOUT_MS}ms — likely a stuck Browser Rendering session, not a code loop`
    );
    await saveReportNow(env, pdfBytes, deployVersion);
  } finally {
    await releaseGenerationLock(env);
  }
}
