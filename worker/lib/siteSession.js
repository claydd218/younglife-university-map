// Stateless signed-cookie session for the TEMPORARY public-site password
// gate — see worker/index.js's "Temporary public-site password gate"
// block and bigtime/SETUP.md. Deliberately a separate, self-contained
// copy of worker/lib/session.js's scheme rather than a shared refactor:
// this whole feature is meant to be ripped out with a handful of file
// deletions once the real public launch happens, and that's only true if
// it never touches the admin login's own code path.

const COOKIE_NAME = 'site_session';
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

export async function createSiteSessionCookie(env) {
  if (!env.SITE_SESSION_SECRET) {
    throw new Error('SITE_SESSION_SECRET unavailable (mid-deploy?) — try again shortly');
  }
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const sig = await hmacHex(env.SITE_SESSION_SECRET, String(expiresAt));
  const value = `${expiresAt}.${sig}`;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}

export function clearSiteSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function hasValidSiteSession(request, env) {
  if (!env.SITE_SESSION_SECRET) return false;
  const cookieHeader = request.headers.get('Cookie') || '';
  // Anchored to a cookie boundary — see worker/lib/session.js's identical
  // fix for why an unanchored match here is a real bug, not just theory.
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const [expiresAtStr, sig] = decodeURIComponent(match[1]).split('.');
  const expiresAt = parseInt(expiresAtStr, 10);
  if (!expiresAt || Date.now() > expiresAt) return false;
  const expectedSig = await hmacHex(env.SITE_SESSION_SECRET, expiresAtStr);
  return timingSafeEqual(sig || '', expectedSig);
}
