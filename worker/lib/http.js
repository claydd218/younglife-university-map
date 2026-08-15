// Small response helpers shared by every worker/routes/*.js route.

export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

export function errorResponse(status, message, extra = {}) {
  return jsonResponse({ error: extra.error || 'error', message, ...extra }, { status });
}

// Cloudflare Access injects this header on requests that pass its login
// gate — using it as the GitHub commit author/committer gives a free
// per-editor audit trail in `git log` without building any user system of
// our own. Falls back to a generic identity when Access isn't configured
// (e.g. local dev via `wrangler dev`, which has no Access in front of it)
// so commits still succeed.
export function committerFromRequest(request) {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (!email) {
    return { authorName: 'Admin CMS', authorEmail: 'admin-cms@yl-uni-intl.com' };
  }
  const name = email.split('@')[0];
  return { authorName: name, authorEmail: email };
}
