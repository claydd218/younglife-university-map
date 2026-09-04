// Stateless signed-cookie sessions for per-user admin logins. No
// server-side session storage: the cookie carries the logged-in user's id
// plus an expiry timestamp and an HMAC over both (keyed by
// ADMIN_SESSION_SECRET) — a session is structurally valid iff the
// signature checks out and it hasn't expired, same scheme as the old
// shared-password cookie, just with `userId` added to the signed payload.
// That's a real format change, not additive: a cookie minted under the old
// `expiresAt.sig` scheme won't parse under `userId.expiresAt.sig`, so
// everyone with an existing session is signed out the moment this ships —
// expected and fine for this rollout (see the admin-users plan).
//
// Unlike the old scheme, a structurally-valid signature isn't enough on
// its own: getSessionUser also looks the user up in admin_users, so a
// removed user's session stops working on their very next request rather
// than lingering until the cookie's own expiry, and the name it returns
// always reflects whatever that user is named *now*, not whatever they
// were named at login time. SESSION_DAYS is still a sliding window —
// worker/index.js re-issues the cookie via createSessionCookie on every
// authenticated request, so staying active keeps a session alive
// indefinitely; only SESSION_DAYS of real inactivity signs someone out.

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

// -> a `Set-Cookie` header value that logs `userId` in.
export async function createSessionCookie(env, userId) {
  if (!env.ADMIN_SESSION_SECRET) {
    throw new Error('ADMIN_SESSION_SECRET unavailable (mid-deploy?) — try again shortly');
  }
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${userId}.${expiresAt}`;
  const sig = await hmacHex(env.ADMIN_SESSION_SECRET, payload);
  const value = `${payload}.${sig}`;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// Verifies the cookie's signature/expiry only — no D1 read. Used to decide
// whether re-issuing the cookie (worker/index.js's sliding-window renewal)
// is worthwhile without paying for a second admin_users lookup on top of
// getSessionUser's own.
async function readSessionCookie(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return null;
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const parts = decodeURIComponent(match[1]).split('.');
  if (parts.length !== 3) return null;
  const [userIdStr, expiresAtStr, sig] = parts;
  const expiresAt = parseInt(expiresAtStr, 10);
  if (!expiresAt || Date.now() > expiresAt) return null;
  const expectedSig = await hmacHex(env.ADMIN_SESSION_SECRET, `${userIdStr}.${expiresAtStr}`);
  if (!timingSafeEqual(sig || '', expectedSig)) return null;
  const userId = parseInt(userIdStr, 10);
  return Number.isFinite(userId) ? userId : null;
}

// Request -> {id, name} | null. Verifies the cookie, then confirms the
// user it names still exists — see this module's own header comment for
// why that second check matters (instant revocation, always-current name).
export async function getSessionUser(request, env) {
  const userId = await readSessionCookie(request, env);
  if (userId == null) return null;
  const row = await env.DB.prepare('SELECT id, name FROM admin_users WHERE id = ?').bind(userId).first();
  return row ? { id: row.id, name: row.name } : null;
}

// Timing-safe password check — exported so route handlers (e.g. the
// superbigtime shared-password gate) don't need their own copy of
// timingSafeEqual.
export function checkPassword(submitted, expected) {
  return timingSafeEqual(String(submitted || ''), String(expected || ''));
}
