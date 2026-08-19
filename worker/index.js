// Single Worker entry point. This project is a Cloudflare Worker with
// static assets (see wrangler.toml), not classic Cloudflare Pages — so
// unlike Pages Functions there's no `functions/` directory auto-routing
// convention here. The Worker runs for every request; anything that isn't
// an /bigtime/* route falls through to env.ASSETS.fetch() below, so the
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

// Paths reachable without a session — everything else under /bigtime/ is
// gated below. Cloudflare's asset serving 307-redirects requests for a
// literal *.html file to the extensionless path (found in production:
// /bigtime/login.html -> /bigtime/login), so both forms need to be public or
// the canonical redirect target gets treated as protected and bounces
// straight back to the .html form — an infinite redirect loop, which is
// exactly what happened before this was two entries instead of one.
const PUBLIC_ADMIN_PATHS = new Set(['/bigtime/login.html', '/bigtime/login', '/bigtime/api/login', '/bigtime/api/logout']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    try {
      const isAdminPath = pathname === '/bigtime' || pathname.startsWith('/bigtime/');
      if (isAdminPath && !PUBLIC_ADMIN_PATHS.has(pathname) && !(await hasValidSession(request, env))) {
        if (pathname.startsWith('/bigtime/api/')) return jsonError(401, 'Not logged in');
        // The extensionless path, not /bigtime/login.html directly — skips
        // the extra 307 hop from Cloudflare's own *.html canonicalization.
        return Response.redirect(new URL('/bigtime/login', request.url), 302);
      }

      if (pathname === '/bigtime/api/login' && method === 'POST') return await login(request, env);
      if (pathname === '/bigtime/api/logout' && method === 'POST') return await logout(request);

      if (pathname === '/bigtime/api/ministries') {
        if (method === 'GET') return await ministriesGet({ request, env, ctx });
        if (method === 'POST') return await ministriesPost({ request, env, ctx });
      }

      const ministryMatch = pathname.match(/^\/bigtime\/api\/ministries\/([^/]+)$/);
      if (ministryMatch) {
        const params = { id: decodeURIComponent(ministryMatch[1]) };
        if (method === 'PUT') return await ministryPut({ request, env, ctx, params });
        if (method === 'DELETE') return await ministryDelete({ request, env, ctx, params });
      }

      if (pathname === '/bigtime/api/upload' && method === 'POST') {
        return await uploadPost({ request, env, ctx });
      }

      const photoMatch = pathname.match(/^\/bigtime\/api\/photos\/([^/]+)$/);
      if (photoMatch && method === 'DELETE') {
        const params = { slug: decodeURIComponent(photoMatch[1]) };
        return await photoDelete({ request, env, ctx, params });
      }

      if (pathname.startsWith('/bigtime/api/')) {
        return jsonError(404, `No admin API route for ${method} ${pathname}`);
      }

      // Everything else — the public map, bigtime/index.html (once past the
      // session check above), bigtime/admin.js, bigtime/login.html,
      // css/js/images/data — is a plain static file.
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Unhandled error in admin API:', err);
      return jsonError(500, err.message || 'Internal error');
    }
  },
};
