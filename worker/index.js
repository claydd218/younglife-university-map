// Single Worker entry point. This project is a Cloudflare Worker with
// static assets (see wrangler.toml), not classic Cloudflare Pages — so
// unlike Pages Functions there's no `functions/` directory auto-routing
// convention here. The Worker runs for every request; anything that isn't
// an /admin/api/* route falls through to env.ASSETS.fetch() below, so the
// public map/admin HTML/JS are served exactly as they were before this
// admin tool existed.
//
// Route handlers themselves (worker/routes/*.js) still take the same
// {request, env, params} shape Pages Functions would have provided
// automatically, so building that shape here — rather than changing the
// handlers — kept all of that already-tested logic untouched when this
// turned out to be a Worker, not Pages.

import { onRequestGet as ministriesGet, onRequestPost as ministriesPost } from './routes/ministries.js';
import { onRequestPut as ministryPut, onRequestDelete as ministryDelete } from './routes/ministry-detail.js';
import { onRequestPost as uploadPost } from './routes/upload.js';
import { onRequestDelete as photoDelete } from './routes/photo.js';

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: 'error', message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    try {
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

      // Everything else — the public map, admin/index.html, admin/admin.js,
      // css/js/images/data — is a plain static file, unrelated to the admin
      // API this Worker adds.
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Unhandled error in admin API:', err);
      return jsonError(500, err.message || 'Internal error');
    }
  },
};
