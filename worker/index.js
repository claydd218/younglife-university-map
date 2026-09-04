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
import { onRequestGet as mapScreenshotGet } from './routes/map-screenshot.js';
import { onRequestGet as reportPdfGet } from './routes/report-pdf.js';
import { onRequestGet as imagesManifestGet } from './routes/images-manifest.js';
import { onRequestGet as publicMinistriesGet } from './routes/public-ministries.js';
import { serveMedia } from './routes/media.js';
import { login, logout } from './routes/login.js';
import { hasValidSession, createSessionCookie } from './lib/session.js';
import { siteLogin, siteLogout } from './routes/site-login.js';
import { hasValidSiteSession, createSiteSessionCookie } from './lib/siteSession.js';
import { MAINTENANCE_MODE } from './lib/maintenance.js';

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: 'error', message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Every third-party host anything on the site actually talks to, named
// explicitly rather than left open — Leaflet/Leaflet.markercluster/
// Papaparse are vendored (vendor/) precisely so script-src doesn't need
// to trust unpkg.com at all. What's left: Cloudflare Turnstile (the
// login page's CAPTCHA widget — script, its iframe, and its own API
// calls), Google Fonts (stylesheet + the font files it references), the
// two free geocoders bigtime/admin.js's ministry-location lookup calls
// directly from the browser (Nominatim for "look up this city", Photon
// for live city-name suggestions while typing — see admin.js's comments
// on lookupLatLng/fetchCitySuggestions for why two different services),
// and Cloudflare's own Web Analytics (RUM) beacon — enabled at the zone
// level (Cloudflare Dashboard's Recommendations flagged it on; no
// in-dashboard toggle was findable to turn it back off), which
// auto-injects its own loader snippet into every response and can't be
// stripped from here. static.cloudflareinsights.com serves beacon.min.js
// itself; cloudflareinsights.com is where it reports collected metrics.
//
// script-src has no blanket 'unsafe-inline': the one inline <script> that
// used to exist (bigtime/login.html) is now an external file so it needs
// no allowance at all, the two inline onerror="" attributes in
// js/app.js's image-fallback chain (photoTag/ministry photo <img> tags)
// are allowed by exact SHA-256 hash via 'unsafe-hashes' instead (an
// injected onerror with any other content still gets blocked), and the
// Cloudflare beacon's own auto-injected loader snippet is allowed the
// same way — a plain hash entry, no 'unsafe-hashes' needed since that
// keyword only applies to hashing inline event-handler attributes, not
// whole <script> blocks.
//
// style-src does need 'unsafe-inline': dozens of inline style="..."
// attributes are generated at runtime (per-division pin colors, mostly)
// across admin.js/app.js/reports*.js, and CSP has no hash/nonce mechanism
// for style *attributes* (only for <style> blocks) — there's no
// equivalent of 'unsafe-hashes' to narrow this one the way script-src's
// gap was narrowed above.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com 'unsafe-hashes' 'sha256-l+nb61U7KKpl4Wcot60MfghvQrADUbeax5hOQehBiVI=' 'sha256-AcfKIR6miDewAaBxREOcW4R7Mgq+qUNQqh/TiZ62OU4=' 'sha256-XwaJgjnLD5K8JyD3xdR8SEhEtsdmSSLuqZrtJjqdWZQ='",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // tile.openstreetmap.org serves the pin-placement map's base tiles
  // (bigtime/admin.js's openPinPlacementMap) — the only place this admin
  // tool loads a live map-tile image from, everything else (the public
  // map, /bigtime/maps) draws its own vector country shapes instead.
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
  "connect-src 'self' https://nominatim.openstreetmap.org https://photon.komoot.io https://challenges.cloudflare.com https://cloudflareinsights.com",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Applied to every response the Worker returns, admin and public alike —
// there's nothing path-specific here that would justify two different
// policies, and CSP only restricts what's *allowed* to load, so the
// (unused, on public pages) admin-only allowances above cost nothing.
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CSP);
  // Belt-and-suspenders with frame-ancestors above — X-Frame-Options is
  // the older header, kept for browsers that predate frame-ancestors.
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Paths reachable without a session — everything else under /bigtime/ is
// gated below. Cloudflare's asset serving 307-redirects requests for a
// literal *.html file to the extensionless path (found in production:
// /bigtime/login.html -> /bigtime/login), so both forms need to be public or
// the canonical redirect target gets treated as protected and bounces
// straight back to the .html form — an infinite redirect loop, which is
// exactly what happened before this was two entries instead of one.
// login.js has to be public too — it's the login page's own script (moved
// out of an inline <script> block so the CSP's script-src can stay
// 'self'-only with no inline allowance), and the one audience that
// actually needs it is exactly the audience that isn't logged in yet.
const PUBLIC_ADMIN_PATHS = new Set(['/bigtime/login.html', '/bigtime/login', '/bigtime/login.js', '/bigtime/api/login', '/bigtime/api/logout']);

// TEMPORARY public-site password gate — requested to keep the site private
// for a while before the real public launch, removed by hand once that
// happens (delete this block, PUBLIC_SITE_PATHS, the siteLogin/siteLogout
// import above, worker/lib/siteSession.js, worker/routes/site-login.js,
// site-login.html, and site-login.js — nothing else depends on any of
// it). Entirely independent of the admin login above: /bigtime/* keeps
// using its own gate untouched, and a valid admin session does NOT also
// satisfy this one (or vice versa) — simplest to reason about, and to
// remove cleanly later, as two gates that never interact. Same *.html/
// extensionless double-entry reasoning as PUBLIC_ADMIN_PATHS above.
// GET /api/ministries, /images/*, /maps/*, /reports/* are deliberately
// NOT listed here — they're the same gated public surface
// data/ministries.csv, images/*, maps/*, and reports/* always were
// (see worker/routes/public-ministries.js and worker/routes/media.js),
// just backed by D1/R2 now instead of static files.
const PUBLIC_SITE_PATHS = new Set(['/site-login.html', '/site-login', '/site-login.js', '/api/site-login', '/api/site-logout']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    try {
      const isAdminPath = pathname === '/bigtime' || pathname.startsWith('/bigtime/');
      const needsSession = isAdminPath && !PUBLIC_ADMIN_PATHS.has(pathname);
      // TEMPORARY: admin closed for maintenance (worker/lib/maintenance.js)
      // — treated as "no session is ever valid" so this blocks even an
      // already-logged-in admin, not just new logins from
      // routes/login.js's own check. Both flip together (same import).
      const sessionValid = needsSession && !MAINTENANCE_MODE && (await hasValidSession(request, env));
      if (needsSession && !sessionValid) {
        if (pathname.startsWith('/bigtime/api/')) {
          return withSecurityHeaders(jsonError(401, MAINTENANCE_MODE ? 'Admin temporarily closed for maintenance' : 'Not logged in'));
        }
        // The extensionless path, not /bigtime/login.html directly — skips
        // the extra 307 hop from Cloudflare's own *.html canonicalization.
        return withSecurityHeaders(Response.redirect(new URL('/bigtime/login', request.url), 302));
      }

      // See PUBLIC_SITE_PATHS above — TEMPORARY, remove alongside it. An
      // already-authenticated admin is exempt on every path, not just
      // /bigtime/* (checked here regardless of path, unlike sessionValid
      // above which only ever gets computed for isAdminPath) — needed so
      // worker/lib/reportCapture.js's internal Puppeteer navigation, which
      // forwards the admin's own session cookie into the page it opens,
      // can also reach the plain static assets that page loads (data/*.csv,
      // maps/*.png, images/*, js/*.js) — all outside /bigtime/, so without
      // this they'd get redirected to /site-login instead of their real
      // content, which is what was actually causing report generation to
      // hang and eventually crash the browser session rather than a
      // simple, clean failure. Confirmed live.
      const hasAdminSession = isAdminPath ? sessionValid : await hasValidSession(request, env);
      const needsSiteSession = !isAdminPath && !PUBLIC_SITE_PATHS.has(pathname) && !hasAdminSession;
      const siteSessionValid = needsSiteSession && (await hasValidSiteSession(request, env));
      if (needsSiteSession && !siteSessionValid) {
        return withSecurityHeaders(Response.redirect(new URL('/site-login', request.url), 302));
      }

      const routeRequest = async () => {
        if (pathname === '/bigtime/api/login' && method === 'POST') return await login(request, env);
        if (pathname === '/bigtime/api/logout' && method === 'POST') return await logout(request);
        if (pathname === '/api/site-login' && method === 'POST') return await siteLogin(request, env);
        if (pathname === '/api/site-logout' && method === 'POST') return await siteLogout(request);

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

        if (pathname === '/bigtime/api/map-screenshot' && method === 'GET') {
          return await mapScreenshotGet({ request, env, ctx });
        }

        if (pathname === '/bigtime/api/report-pdf' && method === 'GET') {
          return await reportPdfGet({ request, env, ctx });
        }

        if (pathname === '/bigtime/api/images-manifest' && method === 'GET') {
          return await imagesManifestGet({ request, env, ctx });
        }

        const photoMatch = pathname.match(/^\/bigtime\/api\/photos\/([^/]+)$/);
        if (photoMatch && method === 'DELETE') {
          const params = { slug: decodeURIComponent(photoMatch[1]) };
          return await photoDelete({ request, env, ctx, params });
        }

        if (pathname.startsWith('/bigtime/api/')) {
          return jsonError(404, `No admin API route for ${method} ${pathname}`);
        }

        if (pathname === '/api/ministries' && method === 'GET') {
          return await publicMinistriesGet({ env });
        }

        // images/, maps/, and reports/ used to be plain static files
        // (git-committed) — now they're R2 objects, streamed back out by
        // worker/routes/media.js. Checked before the ASSETS fallthrough
        // below so these paths never fall through to it (there's nothing
        // there to fall through to anymore; the files themselves aren't
        // deployed as static assets going forward).
        if ((pathname.startsWith('/images/') || pathname.startsWith('/maps/') || pathname.startsWith('/reports/')) && method === 'GET') {
          return await serveMedia(env, request, pathname.slice(1));
        }

        // Everything else — the public map, bigtime/index.html (once past
        // the session check above), bigtime/admin.js, bigtime/login.html,
        // css/js — is a plain static file.
        return await env.ASSETS.fetch(request);
      };

      const response = await routeRequest();

      // Sliding-window session: every authenticated request re-issues the
      // cookie with a fresh SESSION_DAYS expiry (see session.js) from
      // *now*, rather than a fixed expiry set once at login — so staying
      // active keeps you logged in indefinitely, and only that many days
      // of real inactivity signs you out. login()/siteLogin() already set
      // their own first cookie on the response they return (those paths
      // never reach here — they're in PUBLIC_ADMIN_PATHS/PUBLIC_SITE_PATHS,
      // so sessionValid/siteSessionValid are always false for them), so
      // this only needs to cover requests made with an existing session.
      if (sessionValid || siteSessionValid) {
        const renewed = new Response(response.body, response);
        if (sessionValid) renewed.headers.append('Set-Cookie', await createSessionCookie(env));
        if (siteSessionValid) renewed.headers.append('Set-Cookie', await createSiteSessionCookie(env));
        return withSecurityHeaders(renewed);
      }
      return withSecurityHeaders(response);
    } catch (err) {
      console.error('Unhandled error in admin API:', err);
      return withSecurityHeaders(jsonError(500, err.message || 'Internal error'));
    }
  },
};
