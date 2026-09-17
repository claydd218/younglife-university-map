// Same global-counter backstop as worker/lib/loginRateLimit.js (see that
// file's own comment for the full reasoning — keyed globally rather than
// per-IP on purpose, since the attack this defends against is a
// distributed one), applied to the restricted-countries unlock password
// instead of the admin login. A separate key in the same LOGIN_ATTEMPTS
// KV namespace rather than a second namespace — this is just a generic
// failure counter, and provisioning a whole new KV namespace for one more
// counter isn't worth the deploy friction. Kept as its own module (not a
// parameterized version of loginRateLimit.js) so the two gates' lockouts
// stay fully independent — a flood of restricted-password guesses can't
// also lock the admin out of /bigtime, or vice versa.

const FAILURE_KEY = 'restricted:failures';
const MAX_FAILURES = 10;
const WINDOW_SECONDS = 15 * 60;

// True if the restricted-unlock endpoint should reject outright, before
// even checking the password. env.LOGIN_ATTEMPTS missing fails OPEN, same
// as loginRateLimit.js — defense-in-depth on top of the real password
// check, not a replacement for it.
export async function isRestrictedLockedOut(env) {
  if (!env.LOGIN_ATTEMPTS) return false;
  const raw = await env.LOGIN_ATTEMPTS.get(FAILURE_KEY);
  return raw !== null && parseInt(raw, 10) >= MAX_FAILURES;
}

export async function recordRestrictedFailure(env) {
  if (!env.LOGIN_ATTEMPTS) return;
  const raw = await env.LOGIN_ATTEMPTS.get(FAILURE_KEY);
  const count = (raw !== null ? parseInt(raw, 10) : 0) + 1;
  await env.LOGIN_ATTEMPTS.put(FAILURE_KEY, String(count), { expirationTtl: WINDOW_SECONDS });
}

export async function resetRestrictedFailures(env) {
  if (!env.LOGIN_ATTEMPTS) return;
  await env.LOGIN_ATTEMPTS.delete(FAILURE_KEY);
}
