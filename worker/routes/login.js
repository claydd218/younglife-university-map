// Handles /admin/api/login (POST) and /admin/api/logout (POST). Plain
// functions, not the onRequestX Pages-Functions-shaped convention the other
// routes use, since these are dispatched directly by worker/index.js's auth
// gate rather than through the normal route table.

import { createSessionCookie, clearSessionCookie, checkPassword } from '../lib/session.js';

export async function login(request, env) {
  const form = await request.formData();
  const password = form.get('password');

  if (!checkPassword(password, env.ADMIN_SHARED_PASSWORD)) {
    return Response.redirect(new URL('/admin/login?error=1', request.url), 302);
  }

  try {
    const cookie = await createSessionCookie(env);
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/', 'Set-Cookie': cookie },
    });
  } catch (err) {
    // Same user-facing outcome as a wrong password (a clean redirect back
    // to the login page) rather than a raw crypto/config error reaching the
    // browser — covers the mid-deploy secrets-not-attached-yet case a
    // retry a few seconds later resolves on its own.
    console.error('Login failed after password check passed:', err);
    return Response.redirect(new URL('/admin/login?error=1', request.url), 302);
  }
}

export async function logout(request) {
  return new Response(null, {
    status: 302,
    headers: { Location: '/admin/login', 'Set-Cookie': clearSessionCookie() },
  });
}
