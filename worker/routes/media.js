// Routes GET /images/*, /maps/*, /reports/* — streams the matching R2
// object (worker/lib/r2.js) straight back out as the response body.
//
// Deliberately Worker-mediated rather than public R2 bucket access (e.g.
// an r2.dev subdomain bound directly to the bucket): these paths were
// plain static files under git, subject to worker/index.js's
// needsSiteSession check (the temporary site-wide password gate) like
// every other public path — direct R2 access would bypass that gate
// entirely, and would also break worker/lib/reportCapture.js's Puppeteer
// navigation, which forwards the admin's own session cookie specifically
// to reach these paths under it. Routing through this same Worker
// fetch() handler means these inherit that gate for free, with zero
// duplicated auth code — worker/index.js's own gate logic runs before
// this route is ever dispatched.

import { getObject } from '../lib/r2.js';

const CONTENT_TYPE_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
  json: 'application/json',
};

// Not the onRequestGet(context) shape every other route here uses —
// worker/index.js calls this directly with (env, request, key) since the
// key is just the pathname with its leading slash stripped (see its own
// routing), not something that needs Pages-Functions-style :param parsing.
export async function serveMedia(env, request, key) {
  const object = await getObject(env, key);
  if (!object) return new Response('Not found', { status: 404 });

  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && object.httpEtag && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers: { ETag: object.httpEtag } });
  }

  const ext = key.split('.').pop().toLowerCase();
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=300');
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (object.size != null) headers.set('Content-Length', String(object.size));

  return new Response(object.body, { headers });
}
