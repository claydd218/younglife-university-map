// Stateless signed-cookie session for the restricted-countries unlock —
// same scheme as worker/lib/siteSession.js (a separate, self-contained
// copy rather than a shared refactor, for the same reason that file gives:
// each of these gates is meant to be independently removable). Requires
// its own RESTRICTED_SESSION_SECRET Worker secret:
//
//   wrangler secret put RESTRICTED_SESSION_SECRET
//
// Deliberately NOT the same secret as SITE_SESSION_SECRET/
// ADMIN_SESSION_SECRET — those gates are unrelated concepts (the whole
// site's temporary password, and per-user admin logins); reusing either
// one here would tie this feature's lifetime to theirs.
//
// Once unlocked, the cookie stays valid for its own SESSION_DAYS
// regardless of the admin later changing the restricted-access password —
// same "sliding trust, not re-checked against the current password every
// request" tradeoff siteSession.js already makes, kept for the same
// reason: simplicity, and the password is checked again at whatever the
// next relock+unlock cycle is anyway.

const COOKIE_NAME = 'restricted_unlock';
const SESSION_DAYS = 30;

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export async function createRestrictedUnlockCookie(env) {
  if (!env.RESTRICTED_SESSION_SECRET) {
    throw new Error('RESTRICTED_SESSION_SECRET unavailable (mid-deploy, or not yet set — see this file\'s own comment)');
  }
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const sig = await hmacHex(env.RESTRICTED_SESSION_SECRET, String(expiresAt));
  const value = `${expiresAt}.${sig}`;
  // HttpOnly: the client-side lock icon widget never reads this cookie's
  // value directly — it asks GET /api/restricted-status instead — so
  // there's no reason to expose it to page JS at all.
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}

export function clearRestrictedUnlockCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function hasValidRestrictedUnlock(request, env) {
  if (!env.RESTRICTED_SESSION_SECRET) return false;
  const cookieHeader = request.headers.get('Cookie') || '';
  // Anchored to a cookie boundary — see worker/lib/session.js's identical
  // fix for why an unanchored match here is a real bug, not just theory.
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const [expiresAtStr, sig] = decodeURIComponent(match[1]).split('.');
  const expiresAt = parseInt(expiresAtStr, 10);
  if (!expiresAt || Date.now() > expiresAt) return false;
  const expectedSig = await hmacHex(env.RESTRICTED_SESSION_SECRET, expiresAtStr);
  return timingSafeEqual(sig || '', expectedSig);
}
