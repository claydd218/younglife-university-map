// Handles /bigtime/api/login (POST) and /bigtime/api/logout (POST). Plain
// functions, not the onRequestX Pages-Functions-shaped convention the other
// routes use, since these are dispatched directly by worker/index.js's auth
// gate rather than through the normal route table.

import { createSessionCookie, clearSessionCookie, checkPassword } from '../lib/session.js';
import { isLoginLockedOut, recordLoginFailure, resetLoginFailures } from '../lib/loginRateLimit.js';
import { MAINTENANCE_MODE } from '../lib/maintenance.js';

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
  if (MAINTENANCE_MODE) {
    return Response.redirect(new URL('/bigtime/login?error=maintenance', request.url), 302);
  }

  // Checked before doing any other work — including reading the form body
  // — so a tripped lockout costs a tripped attacker nothing but a redirect,
  // not a Turnstile siteverify round trip. See loginRateLimit.js for why
  // this is a global counter, not per-IP.
  //
  // error=locked (not the generic error=1 below) so bigtime/login.js can
  // show a distinct message — otherwise the legitimate admin, having
  // tripped this themselves with a few genuine mistypes, sees "check your
  // password", retypes the *correct* one, gets rejected again, and has no
  // way to know they're waiting out a timer rather than still getting the
  // password wrong.
  if (await isLoginLockedOut(env)) {
    return Response.redirect(new URL('/bigtime/login?error=locked', request.url), 302);
  }

  const form = await request.formData();
  const password = form.get('password');
  const turnstileToken = form.get('cf-turnstile-response');

  // Checked first (and reported with the same generic error as a wrong
  // password) so a failed captcha never reveals whether it was the human
  // check or the password that actually failed.
  if (!(await verifyTurnstile(turnstileToken, env, request))) {
    await recordLoginFailure(env);
    return Response.redirect(new URL('/bigtime/login?error=1', request.url), 302);
  }

  if (!checkPassword(password, env.ADMIN_SHARED_PASSWORD)) {
    await recordLoginFailure(env);
    return Response.redirect(new URL('/bigtime/login?error=1', request.url), 302);
  }

  try {
    const cookie = await createSessionCookie(env);
    await resetLoginFailures(env);
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
