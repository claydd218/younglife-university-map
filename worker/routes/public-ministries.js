// Routes GET /api/ministries — the public map's own data source, now that
// ministry data lives in D1 instead of a static data/ministries.csv file.
// Deliberately returns the *legacy* packed-string row shape that CSV file
// always had (staff: "Name (Role); ...", is_developing: "true"/"false" as
// a string, etc.) rather than the admin API's structured shape — js/app.js
// already parses exactly this shape (parseParenList, .split(';'), etc.)
// in code touched heavily this session, so keeping it identical means
// only the fetch call in js/app.js needed to change, not any of that
// already-working rendering/metrics logic. See
// worker/lib/db/ministries.js's listMinistriesPublic for where the
// re-packing actually happens.
//
// Site-gated the same way the static CSV file always was (this route is
// NOT in worker/index.js's PUBLIC_SITE_PATHS) — not a new public surface,
// just the same data reachable the same way it always was.

import { jsonResponse } from '../lib/http.js';
import { listMinistriesPublic } from '../lib/db/ministries.js';

export async function onRequestGet({ env }) {
  const rows = await listMinistriesPublic(env);
  return jsonResponse({ rows }, { headers: { 'Cache-Control': 'public, max-age=30' } });
}
