// Handles /superbigtime/api/login and /superbigtime/api/logout — the
// single-shared-password gate for the superbigtime admin-user management
// area. Mirrors worker/routes/site-login.js almost exactly (no Turnstile,
// no rate-limit lockout — a low-traffic internal management page, not the
// public site or the per-user admin login).

import { checkPassword } from '../lib/session.js';
import { createSuperSessionCookie, clearSuperSessionCookie } from '../lib/superSession.js';

export async function superLogin(request, env) {
  const form = await request.formData();
  const password = (form.get('password') || '').trim();
  const expected = (env.SUPERADMIN_SHARED_PASSWORD || '').trim();

  // TEMP diagnostic — logs only string lengths and whether the secret is
  // bound at all, never either value, to debug a reported "wrong password"
  // that the account owner is confident is correct. Remove once resolved.
  console.log(`[superbigtime login diag] secret bound=${env.SUPERADMIN_SHARED_PASSWORD != null} submitted length=${password.length} expected length=${expected.length}`);

  if (!checkPassword(password, expected)) {
    return Response.redirect(new URL('/superbigtime/login?error=1', request.url), 302);
  }

  try {
    const cookie = await createSuperSessionCookie(env);
    return new Response(null, {
      status: 302,
      headers: { Location: '/superbigtime/', 'Set-Cookie': cookie },
    });
  } catch (err) {
    console.error('Superbigtime login failed after password check passed:', err);
    return Response.redirect(new URL('/superbigtime/login?error=1', request.url), 302);
  }
}

export async function superLogout(request) {
  return new Response(null, {
    status: 302,
    headers: { Location: '/superbigtime/login', 'Set-Cookie': clearSuperSessionCookie() },
  });
}
