// Handles /api/site-login and /api/site-logout for the TEMPORARY public-
// site password gate — see worker/index.js and bigtime/SETUP.md. No
// Turnstile, no rate-limit lockout: this is a low-stakes, short-lived
// soft-launch gate on an otherwise-public informational site, not the
// admin tool's write access, so that extra machinery isn't warranted here.
// Deliberately kept separate from worker/routes/login.js for the same
// reason siteSession.js is separate from session.js — easy to delete
// wholesale later without touching admin login at all.

import { checkPassword } from '../lib/session.js';
import { createSiteSessionCookie, clearSiteSessionCookie } from '../lib/siteSession.js';

export async function siteLogin(request, env) {
  const form = await request.formData();
  // Trimmed on both sides — a stray leading/trailing space or newline is
  // an easy copy-paste mistake into the dashboard's secret field (or a
  // mobile keyboard's autocomplete), and there's no legitimate reason a
  // real password here would need to start or end with whitespace.
  const password = (form.get('password') || '').trim();
  const expected = (env.SITE_SHARED_PASSWORD || '').trim();

  if (!checkPassword(password, expected)) {
    return Response.redirect(new URL('/site-login?error=1', request.url), 302);
  }

  try {
    const cookie = await createSiteSessionCookie(env);
    return new Response(null, {
      status: 302,
      headers: { Location: '/', 'Set-Cookie': cookie },
    });
  } catch (err) {
    console.error('Site login failed after password check passed:', err);
    return Response.redirect(new URL('/site-login?error=1', request.url), 302);
  }
}

export async function siteLogout(request) {
  return new Response(null, {
    status: 302,
    headers: { Location: '/site-login', 'Set-Cookie': clearSiteSessionCookie() },
  });
}
