// Handles /bigtime/api/login (POST) and /bigtime/api/logout (POST). Plain
// functions, not the onRequestX Pages-Functions-shaped convention the other
// routes use, since these are dispatched directly by worker/index.js's auth
// gate rather than through the normal route table.

import { createSessionCookie, clearSessionCookie, checkPassword } from '../lib/session.js';

// Verifies the Turnstile widget's token server-side against Cloudflare's
// siteverify endpoint. Fails closed like the rest of this file's secret
// handling (see hasValidSession in session.js) — a missing/misconfigured
// TURNSTILE_SECRET_KEY rejects the login rather than silently skipping the
// bot check, so a botched deploy can't quietly turn Turnstile off.
async function verifyTurnstile(token, env, request) {
  if (!env.ADMIN_TURNSTILE_SECRET_KEY || !token) return false;
  const body = new URLSearchParams({
    secret: env.ADMIN_TURNSTILE_SECRET_KEY,
    response: token,
    remoteip: request.headers.get('CF-Connecting-IP') || '',
  });
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await res.json();
    if (data.success !== true) console.error('Turnstile verification did not pass:', JSON.stringify(data));
    return data.success === true;
  } catch (err) {
    console.error('Turnstile verification request failed:', err);
    return false;
  }
}

export async function login(request, env) {
  const form = await request.formData();
  const password = form.get('password');
  const turnstileToken = form.get('cf-turnstile-response');

  // Checked first (and reported with the same generic error text as a
  // wrong password) so a failed captcha never reveals whether it was the
  // human check or the password that actually failed. The distinct query
  // param (same displayed message either way) is a temporary debugging aid
  // — remove once the current login-failure report is root-caused.
  if (!(await verifyTurnstile(turnstileToken, env, request))) {
    return Response.redirect(new URL('/bigtime/login?error=captcha', request.url), 302);
  }

  if (!checkPassword(password, env.ADMIN_SHARED_PASSWORD)) {
    return Response.redirect(new URL('/bigtime/login?error=password', request.url), 302);
  }

  try {
    const cookie = await createSessionCookie(env);
    return new Response(null, {
      status: 302,
      headers: { Location: '/bigtime/', 'Set-Cookie': cookie },
    });
  } catch (err) {
    // Same user-facing outcome as a wrong password (a clean redirect back
    // to the login page) rather than a raw crypto/config error reaching the
    // browser — covers the mid-deploy secrets-not-attached-yet case a
    // retry a few seconds later resolves on its own.
    console.error('Login failed after password check passed:', err);
    return Response.redirect(new URL('/bigtime/login?error=1', request.url), 302);
  }
}

export async function logout(request) {
  return new Response(null, {
    status: 302,
    headers: { Location: '/bigtime/login', 'Set-Cookie': clearSessionCookie() },
  });
}
