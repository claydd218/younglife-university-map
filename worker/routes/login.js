// Handles /admin/api/login (POST) and /admin/api/logout (POST). Plain
// functions, not the onRequestX Pages-Functions-shaped convention the other
// routes use, since these are dispatched directly by worker/index.js's auth
// gate rather than through the normal route table.

import { createSessionCookie, clearSessionCookie, checkPassword } from '../lib/session.js';

export async function login(request, env) {
  const form = await request.formData();
  const password = form.get('password');

  if (!checkPassword(password, env.ADMIN_SHARED_PASSWORD)) {
    return Response.redirect(new URL('/admin/login.html?error=1', request.url), 302);
  }

  const cookie = await createSessionCookie(env);
  return new Response(null, {
    status: 302,
    headers: { Location: '/admin/', 'Set-Cookie': cookie },
  });
}

export async function logout(request) {
  return new Response(null, {
    status: 302,
    headers: { Location: '/admin/login.html', 'Set-Cookie': clearSessionCookie() },
  });
}
