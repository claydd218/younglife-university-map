// Single Worker entry point. This project is a Cloudflare Worker with
// static assets (see wrangler.toml), not classic Cloudflare Pages — so
// unlike Pages Functions there's no `functions/` directory auto-routing
// convention here. The Worker runs for every request; anything that isn't
// an /admin/* route falls through to env.ASSETS.fetch() below, so the
// public map is served exactly as it was before this admin tool existed.
//
// Route handlers themselves (worker/routes/*.js) still take the same
// {request, env, params} shape Pages Functions would have provided
// automatically, so building that shape here — rather than changing the
// handlers — kept all of that already-tested logic untouched when this
// turned out to be a Worker, not Pages.
//
// Auth: a shared password (not Cloudflare Access — that needed an
// Identity Provider added at the Zero Trust org level first, which turned
// into more setup friction than this small a tool warranted). See
// worker/lib/session.js for the stateless signed-cookie scheme.

import { onRequestGet as ministriesGet, onRequestPost as ministriesPost } from './routes/ministries.js';
import { onRequestPut as ministryPut, onRequestDelete as ministryDelete } from './routes/ministry-detail.js';
import { onRequestPost as uploadPost } from './routes/upload.js';
import { onRequestDelete as photoDelete } from './routes/photo.js';
import { login, logout } from './routes/login.js';
import { hasValidSession } from './lib/session.js';

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: 'error', message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Paths reachable without a session — everything else under /admin/ is
// gated below. Cloudflare's asset serving 307-redirects requests for a
// literal *.html file to the extensionless path (found in production:
// /admin/login.html -> /admin/login), so both forms need to be public or
// the canonical redirect target gets treated as protected and bounces
// straight back to the .html form — an infinite redirect loop, which is
// exactly what happened before this was two entries instead of one.
const PUBLIC_ADMIN_PATHS = new Set(['/admin/login.html', '/admin/login', '/admin/api/login', '/admin/api/logout']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    try {
      // TEMPORARY — diagnosing why ADMIN_SHARED_PASSWORD isn't matching on
      // the deployed preview. Reports presence/length only, never actual
      // secret values. Remove once resolved.
      if (pathname === '/admin/api/debug-env') {
        return new Response(JSON.stringify({
          GITHUB_TOKEN: typeof env.GITHUB_TOKEN === 'string' ? `present, ${env.GITHUB_TOKEN.length} chars` : 'MISSING',
          GITHUB_OWNER: env.GITHUB_OWNER || 'MISSING',
          GITHUB_REPO: env.GITHUB_REPO || 'MISSING',
          GITHUB_BRANCH: env.GITHUB_BRANCH || 'MISSING',
          ADMIN_SHARED_PASSWORD: typeof env.ADMIN_SHARED_PASSWORD === 'string' ? `present, ${env.ADMIN_SHARED_PASSWORD.length} chars` : 'MISSING',
          ADMIN_SESSION_SECRET: typeof env.ADMIN_SESSION_SECRET === 'string' ? `present, ${env.ADMIN_SESSION_SECRET.length} chars` : 'MISSING',
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/');
      if (isAdminPath && !PUBLIC_ADMIN_PATHS.has(pathname) && !(await hasValidSession(request, env))) {
        if (pathname.startsWith('/admin/api/')) return jsonError(401, 'Not logged in');
        // The extensionless path, not /admin/login.html directly — skips
        // the extra 307 hop from Cloudflare's own *.html canonicalization.
        return Response.redirect(new URL('/admin/login', request.url), 302);
      }

      if (pathname === '/admin/api/login' && method === 'POST') return await login(request, env);
      if (pathname === '/admin/api/logout' && method === 'POST') return await logout(request);

      if (pathname === '/admin/api/ministries') {
        if (method === 'GET') return await ministriesGet({ request, env, ctx });
        if (method === 'POST') return await ministriesPost({ request, env, ctx });
      }

      const ministryMatch = pathname.match(/^\/admin\/api\/ministries\/([^/]+)$/);
      if (ministryMatch) {
        const params = { id: decodeURIComponent(ministryMatch[1]) };
        if (method === 'PUT') return await ministryPut({ request, env, ctx, params });
        if (method === 'DELETE') return await ministryDelete({ request, env, ctx, params });
      }

      if (pathname === '/admin/api/upload' && method === 'POST') {
        return await uploadPost({ request, env, ctx });
      }

      const photoMatch = pathname.match(/^\/admin\/api\/photos\/([^/]+)$/);
      if (photoMatch && method === 'DELETE') {
        const params = { slug: decodeURIComponent(photoMatch[1]) };
        return await photoDelete({ request, env, ctx, params });
      }

      if (pathname.startsWith('/admin/api/')) {
        return jsonError(404, `No admin API route for ${method} ${pathname}`);
      }

      // Everything else — the public map, admin/index.html (once past the
      // session check above), admin/admin.js, admin/login.html,
      // css/js/images/data — is a plain static file.
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Unhandled error in admin API:', err);
      return jsonError(500, err.message || 'Internal error');
    }
  },
};
