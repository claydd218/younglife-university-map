// Stateless signed-cookie sessions for the shared-password login. No
// server-side session storage: the cookie itself carries an expiry
// timestamp plus an HMAC over that timestamp (keyed by ADMIN_SESSION_SECRET),
// so a session is valid iff the signature checks out and it hasn't expired —
// nothing to look up, nothing to invalidate server-side on logout beyond
// clearing the cookie. SESSION_DAYS is a sliding window, not a fixed
// expiry from login — worker/index.js re-issues the cookie via
// createSessionCookie on every authenticated request, so staying active
// keeps a session alive indefinitely; only SESSION_DAYS of real
// inactivity actually signs someone out.

const COOKIE_NAME = 'admin_session';
const SESSION_DAYS = 90;

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

// -> a `Set-Cookie` header value that logs the session in.
export async function createSessionCookie(env) {
  if (!env.ADMIN_SESSION_SECRET) {
    throw new Error('ADMIN_SESSION_SECRET unavailable (mid-deploy?) — try again shortly');
  }
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const sig = await hmacHex(env.ADMIN_SESSION_SECRET, String(expiresAt));
  const value = `${expiresAt}.${sig}`;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// Request -> boolean. Checks the cookie against ADMIN_SESSION_SECRET.
export async function hasValidSession(request, env) {
  // Seen in practice: a request landing on a freshly-deployed Worker
  // version in the brief window before its secrets are fully attached,
  // which otherwise reached crypto.subtle.importKey with an empty key and
  // threw a low-level "raw key data (0)" error instead of a clean
  // not-logged-in result. Fails safe here — no valid secret means no
  // session can be valid, so this is behaviorally a no-op change, just
  // without the crash.
  if (!env.ADMIN_SESSION_SECRET) return false;
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const [expiresAtStr, sig] = decodeURIComponent(match[1]).split('.');
  const expiresAt = parseInt(expiresAtStr, 10);
  if (!expiresAt || Date.now() > expiresAt) return false;
  const expectedSig = await hmacHex(env.ADMIN_SESSION_SECRET, expiresAtStr);
  return timingSafeEqual(sig || '', expectedSig);
}

// Timing-safe password check — exported so the login route doesn't need its
// own copy of timingSafeEqual.
export function checkPassword(submitted, expected) {
  return timingSafeEqual(String(submitted || ''), String(expected || ''));
}
