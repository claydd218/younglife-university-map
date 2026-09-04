// Stateless signed-cookie session for the superbigtime area (admin-user
// management) — a separate, permanent, single-shared-password gate,
// independent of both the per-user /bigtime/ admin login (session.js) and
// the temporary public-site gate (siteSession.js). Deliberately its own
// self-contained copy of the same HMAC-cookie scheme rather than a shared
// refactor, for the same reason siteSession.js stayed separate: this gate
// should be freely removable/rewritable without ever touching the other
// two login flows.

const COOKIE_NAME = 'superadmin_session';
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

export async function createSuperSessionCookie(env) {
  if (!env.SUPERADMIN_SESSION_SECRET) {
    throw new Error('SUPERADMIN_SESSION_SECRET unavailable (mid-deploy?) — try again shortly');
  }
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const sig = await hmacHex(env.SUPERADMIN_SESSION_SECRET, String(expiresAt));
  const value = `${expiresAt}.${sig}`;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}

export function clearSuperSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function hasValidSuperSession(request, env) {
  if (!env.SUPERADMIN_SESSION_SECRET) return false;
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const [expiresAtStr, sig] = decodeURIComponent(match[1]).split('.');
  const expiresAt = parseInt(expiresAtStr, 10);
  if (!expiresAt || Date.now() > expiresAt) return false;
  const expectedSig = await hmacHex(env.SUPERADMIN_SESSION_SECRET, expiresAtStr);
  return timingSafeEqual(sig || '', expectedSig);
}
