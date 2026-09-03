// Best-effort mutex over Cloudflare Browser Rendering (env.BROWSER)
// sessions — shared by every Puppeteer caller: report generation
// (reportArchive.js, report-pdf.js) and map capture, both the automatic
// per-edit kind (mapArchive.js) and the manual "Regenerate" button
// (routes/map-screenshot.js). Confirmed live: two Puppeteer sessions
// running at once can crash both ("Protocol error ... Target closed"),
// almost certainly Browser Rendering's own concurrent-session limit for
// this account — and a crashed map capture fails silently (it just never
// commits new maps/*.png), so a report generation racing a map capture
// doesn't just error once, it leaves the maps stuck stale until the next
// edit triggers another attempt.
//
// Lives in the LOGIN_ATTEMPTS KV binding (name is historical; it's just a
// generic key-value store) rather than provisioning a whole new
// namespace just for this. Not a strict mutex — KV is eventually
// consistent, so this can't fully rule out two acquisitions racing, only
// make it very unlikely — but that's a real improvement over no
// coordination at all.

const GENERATING_KEY = 'browser:generating';
// Comfortably longer than any single caller's own generation timeout (the
// report is the slowest at up to 360s), so the lock self-expires even if
// something crashes before ever releasing it, but not so long that a
// genuinely stuck generation blocks new ones for longer than it has to.
const LOCK_TTL_SECONDS = 420;

// -> true if the lock was free and this call just claimed it (caller must
// releaseGenerationLock when done, even on error), false if someone else
// already holds it. Fails open (returns true, i.e. "go ahead") if the KV
// binding itself is missing — no coordination is safer than silently
// never generating at all.
export async function tryAcquireGenerationLock(env) {
  if (!env.LOGIN_ATTEMPTS) return true;
  const existing = await env.LOGIN_ATTEMPTS.get(GENERATING_KEY);
  if (existing) return false;
  await env.LOGIN_ATTEMPTS.put(GENERATING_KEY, String(Date.now()), { expirationTtl: LOCK_TTL_SECONDS });
  return true;
}

export async function releaseGenerationLock(env) {
  if (!env.LOGIN_ATTEMPTS) return;
  await env.LOGIN_ATTEMPTS.delete(GENERATING_KEY).catch(() => {});
}

const POLL_INTERVAL_MS = 5000;

// Polls until the lock frees up and this call claims it, or gives up
// after timeoutMs (returns false). What "couldn't get a turn" means is
// left to the caller: report-pdf.js treats it as a real error to surface
// to the admin; mapArchive.js just skips this capture and logs, since the
// next ministry edit will trigger another attempt anyway.
export async function waitForGenerationLock(env, timeoutMs) {
  if (await tryAcquireGenerationLock(env)) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (await tryAcquireGenerationLock(env)) return true;
  }
  return false;
}
