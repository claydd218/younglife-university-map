// A stateless, single-shared-password login has no per-account lockout to
// fall back on, and Turnstile alone only raises the cost of a *fast*,
// naive brute force — it does nothing against a slow attacker paired
// with a CAPTCHA-solving service, which can clear a fresh challenge on
// every single attempt. This is the missing backstop: a global failure
// counter in Workers KV that locks out ALL login attempts (even ones
// with a correct password) once too many failures land within a rolling
// window.
//
// Keyed globally, not per-IP, on purpose — the exact attack this exists
// to stop is a *distributed* one (many source IPs, few attempts each),
// which a per-IP counter would never accumulate enough to trip. The
// trade-off: if this site ever saw meaningful unrelated background noise
// hitting /bigtime/api/login at the same time as the real admin fumbling
// their own password, the admin could end up waiting out someone else's
// lockout. For a single-admin internal tool, that's an acceptable cost
// for meaningfully raising an attacker's cost of guessing the one shared
// password.
//
// KV has no atomic increment — concurrent failures can race and
// undercount by one or two. Not worth a Durable Object to close that gap
// for this threat model; even an occasional undercount still means real
// friction for an attacker, which is the actual goal here.

const FAILURE_KEY = 'login:failures';
const MAX_FAILURES = 10;
// Sliding window: every write refreshes this TTL, so a slow, steady
// trickle of attempts still accumulates (and locks out) instead of
// quietly resetting to zero on a fixed clock an attacker could plan
// around. KV requires at least 60s; 15 minutes leaves real headroom
// above that floor.
const WINDOW_SECONDS = 15 * 60;

// True if login should be rejected outright, before even checking
// Turnstile/password. env.LOGIN_ATTEMPTS missing (not yet provisioned,
// or removed later) fails OPEN rather than breaking login entirely —
// this is defense-in-depth on top of the real auth check, not a
// replacement for it.
export async function isLoginLockedOut(env) {
  if (!env.LOGIN_ATTEMPTS) return false;
  const raw = await env.LOGIN_ATTEMPTS.get(FAILURE_KEY);
  return raw !== null && parseInt(raw, 10) >= MAX_FAILURES;
}

export async function recordLoginFailure(env) {
  if (!env.LOGIN_ATTEMPTS) return;
  const raw = await env.LOGIN_ATTEMPTS.get(FAILURE_KEY);
  const count = (raw !== null ? parseInt(raw, 10) : 0) + 1;
  await env.LOGIN_ATTEMPTS.put(FAILURE_KEY, String(count), { expirationTtl: WINDOW_SECONDS });
}

export async function resetLoginFailures(env) {
  if (!env.LOGIN_ATTEMPTS) return;
  await env.LOGIN_ATTEMPTS.delete(FAILURE_KEY);
}
