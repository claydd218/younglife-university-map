// Replaces worker/lib/deployVersion.js's role now that ministry data lives
// in D1 instead of a file in the deployed static bundle: a single token
// the report/map cache-freshness checks (worker/lib/reportArchive.js,
// worker/lib/mapArchive.js) compare against after a write, to know their
// cached artifact still matches the current data.
//
// Unlike deployVersion.js, this is NOT a public marker file polled over
// HTTP to detect when a change has "gone live" — D1 (no read replication)
// gives read-your-writes consistency for free, so the moment a write
// commits, every subsequent read (including a live Puppeteer navigation)
// already sees it. That's what let worker/lib/deployVersion.js's whole
// waitForDeploy() polling dance be deleted outright, not just ported.

export async function bumpDataVersion(env) {
  const token = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO data_version (id, token, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at'
  ).bind(token, new Date().toISOString()).run();
  return token;
}

export async function getDataVersion(env) {
  const row = await env.DB.prepare('SELECT token FROM data_version WHERE id = 1').first();
  return row ? row.token : null;
}
