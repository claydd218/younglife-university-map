// Persists generateReportPdf()'s output (worker/lib/reportCapture.js) to
// reports/ministry-report.pdf in the repo, so the "Download Report PDF"
// button (bigtime/admin.js) can just re-serve that file instead of running
// a fresh 3+ minute Puppeteer generation on every click —
// worker/routes/report-pdf.js checks isReportCacheFresh() first and only
// falls back to a live generation when it isn't. Same pattern as
// worker/lib/mapArchive.js for the exact same underlying problem (an
// expensive Puppeteer artifact, kept fresh automatically after admin
// edits) — this is its own copy of the small waitForDeploy helper rather
// than importing mapArchive.js's, so the two stay independently
// understandable/removable.
//
// Called from four places, all via ctx.waitUntil so the triggering
// request is never held up by however long generation takes:
// - worker/routes/ministries.js (create) and ministry-detail.js (update,
//   delete) — mirrors regenerateMapArchive's own call sites; this route
//   already handles blurb/staff/university edits unconditionally, so
//   those are covered automatically just by hooking in here.
// - worker/routes/upload.js and photo.js (delete) — maps don't hook these
//   (a photo change doesn't move a pin), but the report shows staff and
//   ministry photos directly, so it needs to.

import { listDir, putFileBase64, putFile, getFile } from './github.js';
import { DEPLOY_VERSION_PATH } from './deployVersion.js';
import { generateReportPdf, withTimeout, GENERATE_TIMEOUT_MS } from './reportCapture.js';

const REPORTS_DIR = 'reports';
export const PDF_PATH = `${REPORTS_DIR}/ministry-report.pdf`;
export const META_PATH = `${REPORTS_DIR}/report-meta.json`;

// Best-effort lock so a background regeneration (triggered by an admin
// edit) and a live-generation fallback (worker/routes/report-pdf.js,
// triggered by clicking Download before that background job finishes)
// can't both spin up a Puppeteer session at the same time — confirmed
// live: two at once can crash both ("Protocol error ... Target closed"),
// almost certainly Browser Rendering's own concurrent-session limit for
// this account. Not a strict mutex — Cloudflare KV is eventually
// consistent, so this can't fully rule out two acquisitions racing, only
// make it very unlikely — but that's a real improvement over no
// coordination at all. Lives in the LOGIN_ATTEMPTS KV binding (name is
// historical; it's just a generic key-value store, and this key is
// clearly namespaced apart from loginRateLimit.js's own 'login:failures'
// key) rather than provisioning a whole new namespace just for this.
const GENERATING_KEY = 'report:generating';
// Comfortably longer than GENERATE_TIMEOUT_MS so the lock self-expires
// even if something crashes before ever releasing it, but not so long
// that a genuinely stuck generation blocks new ones for longer than it
// has to.
const GENERATING_LOCK_TTL_SECONDS = Math.ceil(GENERATE_TIMEOUT_MS / 1000) + 60;

// -> true if the lock was free and this call just claimed it (caller must
// releaseGenerationLock when done, even on error), false if someone else
// already holds it. Fails open (returns true, i.e. "go ahead") if the KV
// binding itself is missing — no coordination is safer than silently
// never generating at all.
export async function tryAcquireGenerationLock(env) {
  if (!env.LOGIN_ATTEMPTS) return true;
  const existing = await env.LOGIN_ATTEMPTS.get(GENERATING_KEY);
  if (existing) return false;
  await env.LOGIN_ATTEMPTS.put(GENERATING_KEY, String(Date.now()), { expirationTtl: GENERATING_LOCK_TTL_SECONDS });
  return true;
}

export async function releaseGenerationLock(env) {
  if (!env.LOGIN_ATTEMPTS) return;
  await env.LOGIN_ATTEMPTS.delete(GENERATING_KEY).catch(() => {});
}

// Same reasoning/value as mapArchive.js's DEPLOY_WAIT_TIMEOUT_MS: deploys
// in this project have taken up to ~80s in past observation.
const DEPLOY_WAIT_TIMEOUT_MS = 150000;
const DEPLOY_WAIT_INTERVAL_MS = 5000;

async function waitForDeploy(request, expectedVersion) {
  if (!expectedVersion) return false;
  const url = new URL('/data/deploy-version.txt', request.url).toString();
  const deadline = Date.now() + DEPLOY_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok && (await res.text()).trim() === expectedVersion) return true;
    } catch {
      // transient network hiccup — just retry until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, DEPLOY_WAIT_INTERVAL_MS));
  }
  return false;
}

// The Workers runtime has no Buffer.toString('base64') without leaning on
// nodejs_compat internals — btoa() is the portable primitive, but it only
// accepts a binary string, so this builds that string in chunks (a single
// String.fromCharCode(...bytes) call on a multi-hundred-KB PDF risks
// blowing the call stack). Same approach as mapCapture.js's toBase64.
function toBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// `deployVersion` is the data/deploy-version.txt token that was live when
// `pdfBytes` was generated against it — recorded so a later request can
// tell whether anything has changed since (see isReportCacheFresh).
export async function saveReportNow(env, pdfBytes, deployVersion, commit) {
  const existing = await listDir(env, REPORTS_DIR);
  const shaByName = new Map(existing.map((f) => [f.name, f.sha]));

  await putFileBase64(env, PDF_PATH, toBase64(pdfBytes), {
    sha: shaByName.get('ministry-report.pdf'),
    message: 'Update report: ministry-report.pdf',
    ...commit,
  });
  const meta = { generatedAt: new Date().toISOString(), deployVersion };
  await putFile(env, META_PATH, JSON.stringify(meta, null, 2), {
    sha: shaByName.get('report-meta.json'),
    message: 'Update report metadata',
    ...commit,
  });
}

// -> { fresh: boolean, meta: {generatedAt, deployVersion} | null }. Fresh
// iff a cached PDF+meta both exist, no admin write has happened since it
// was generated (deployVersion still matches data/deploy-version.txt's
// current value — every ministry/photo write bumps that to a fresh
// token, see deployVersion.js), and it's still the same calendar month
// (the report's own "Generated: <Month Year>" label would otherwise go
// stale with no admin activity at all to trigger a regeneration). Meta is
// still returned even when stale/missing, so a caller building a download
// filename after a fresh live-generation doesn't need a second read.
export async function getReportCacheStatus(env) {
  const metaFile = await getFile(env, META_PATH);
  if (!metaFile) return { fresh: false, meta: null };
  let meta;
  try {
    meta = JSON.parse(metaFile.content);
  } catch {
    return { fresh: false, meta: null };
  }

  const currentDeployVersion = await getFile(env, DEPLOY_VERSION_PATH);
  if (!currentDeployVersion || currentDeployVersion.content.trim() !== meta.deployVersion) {
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
// state bumpDeployVersion already updates on every admin write regardless
// of this flag) — so a paused edit still correctly invalidates the cache,
// it just waits for the next Download click to notice and regenerate live
// instead of an automatic background one. Flip back to true to resume.
const BACKGROUND_REGEN_ENABLED = false;

// Waits for deployVersion (from lib/deployVersion.js's bumpDeployVersion,
// called right after the ministry/photo change that should trigger this)
// to actually go live, then generates and saves a fresh report. Skips
// entirely — logging instead of throwing, since this always runs detached
// inside ctx.waitUntil — if the deploy doesn't land within the timeout,
// same reasoning as mapArchive.js's regenerateMapArchive. No extra
// ctx.waitUntil dance around generateReportPdf itself needed here (unlike
// worker/routes/report-pdf.js's own live-generation path) — this whole
// call is already running inside its caller's ctx.waitUntil from the
// start, so there's no early HTTP response that could tear the execution
// context down mid-generation the way there is for that route.
export async function regenerateReportArchive(env, request, deployVersion, commit) {
  if (!BACKGROUND_REGEN_ENABLED) return;
  if (!env.BROWSER) return;
  const deployed = await waitForDeploy(request, deployVersion);
  if (!deployed) {
    console.error(`Report archive: deploy version ${deployVersion} did not go live within ${DEPLOY_WAIT_TIMEOUT_MS}ms — skipping regeneration to avoid saving a stale report.`);
    return;
  }

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
    await saveReportNow(env, pdfBytes, deployVersion, commit);
  } finally {
    await releaseGenerationLock(env);
  }
}
