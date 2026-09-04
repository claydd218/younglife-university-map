// Per-user password hashing (worker/lib/db/users.js). PBKDF2-SHA256 via
// crypto.subtle — native to the Workers runtime, same reasoning as
// session.js's own use of it for HMAC: no dependency to vendor/audit.
// Stored format: "{iterations}.{saltHex}.{hashHex}" — the iteration count
// travels with the hash so it can be raised later without invalidating
// passwords hashed under a lower count.

// OWASP's 2023 minimum recommendation for PBKDF2-SHA256 is 210000, but the
// Workers runtime's crypto.subtle caps PBKDF2 at 100000 iterations —
// confirmed live ("Pbkdf2 failed: iteration counts above 100000 are not
// supported (requested 210000)"). 100000 is the platform ceiling, so it's
// what's used here.
const ITERATIONS = 100000;
const KEY_LENGTH_BITS = 256;

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function derive(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key,
    KEY_LENGTH_BITS
  );
  return toHex(bits);
}

export async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const hashHex = await derive(password, saltBytes, ITERATIONS);
  return `${ITERATIONS}.${toHex(saltBytes)}.${hashHex}`;
}

// Timing-safe compare on the derived bits, not the stored string —
// derive() always runs (even on a malformed `stored`, falling back to a
// dummy salt/iteration count) so this takes the same time whether the
// login exists or not.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('.');
  const iterations = parts.length === 3 ? parseInt(parts[0], 10) : ITERATIONS;
  const saltHex = parts.length === 3 ? parts[1] : '00'.repeat(16);
  const expectedHex = parts.length === 3 ? parts[2] : '';
  const actualHex = await derive(password, fromHex(saltHex), iterations);
  return timingSafeEqual(actualHex, expectedHex);
}
