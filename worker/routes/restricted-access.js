// Routes the public-facing half of the restricted-countries gate:
// GET /api/restricted-status, POST /api/restricted-unlock, POST
// /api/restricted-lock. Same site-gating as GET /api/ministries — these
// three are NOT in worker/index.js's PUBLIC_SITE_PATHS, so they inherit
// the existing temporary site-wide password check first, same as
// everything else under the public map.

import { jsonResponse, errorResponse } from '../lib/http.js';
import { checkRestrictedPassword } from '../lib/db/restrictedAccess.js';
import { createRestrictedUnlockCookie, clearRestrictedUnlockCookie, hasValidRestrictedUnlock } from '../lib/restrictedSession.js';
import { isRestrictedLockedOut, recordRestrictedFailure, resetRestrictedFailures } from '../lib/restrictedRateLimit.js';

export async function restrictedStatus({ request, env }) {
  return jsonResponse({ unlocked: await hasValidRestrictedUnlock(request, env) });
}

export async function restrictedUnlock({ request, env }) {
  // Checked before reading the body at all — same reasoning as
  // worker/routes/login.js's own isLoginLockedOut check — so a tripped
  // lockout costs an attacker nothing extra, and a legitimate visitor who
  // trips it themselves gets a distinct "too many attempts" message
  // instead of a misleading "incorrect password" on their next (possibly
  // correct) try.
  if (await isRestrictedLockedOut(env)) {
    return errorResponse(429, 'Too many attempts — try again in a few minutes.');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }
  const password = String(body.password || '');
  if (!password) return errorResponse(400, 'Password is required');

  const ok = await checkRestrictedPassword(env, password);
  if (!ok) {
    await recordRestrictedFailure(env);
    return errorResponse(401, 'Incorrect password');
  }

  try {
    const cookie = await createRestrictedUnlockCookie(env);
    await resetRestrictedFailures(env);
    return jsonResponse({ ok: true }, { headers: { 'Set-Cookie': cookie } });
  } catch (err) {
    console.error('Restricted unlock failed after password check passed:', err);
    return errorResponse(500, 'Unlock is temporarily unavailable — try again shortly');
  }
}

export async function restrictedLock() {
  return jsonResponse({ ok: true }, { headers: { 'Set-Cookie': clearRestrictedUnlockCookie() } });
}
