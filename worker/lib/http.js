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

// Login is a single shared password (see worker/lib/session.js), not
// per-user accounts, so there's no per-editor identity to attribute commits
// to — everything just commits as this generic identity. (An earlier
// version of this used Cloudflare Access's per-email login for a free
// per-editor git log, but that needed an Identity Provider added at the
// Zero Trust org level first, which was more setup friction than this
// tool's scale warranted.)
export function committerFromRequest() {
  return { authorName: 'Admin CMS', authorEmail: 'admin-cms@yl-uni-intl.com' };
}
