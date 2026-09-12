// The temporary whole-site password gate's password — see
// scripts/schema-site-access.sql. Every read is wrapped against a
// missing-table error, same reasoning as restrictedAccess.js: this code
// deploys the instant it's pushed, but the migration is a separate manual
// step, and worker/index.js's site gate runs on every single request —
// without a fallback here, a lagging migration would 500 the entire site,
// not just fail to find a password.

export async function getSitePassword(env) {
  try {
    const row = await env.DB.prepare('SELECT password FROM site_access WHERE id = 1').first();
    return row ? row.password : '';
  } catch (err) {
    console.error('getSitePassword (treating as unset):', err);
    return '';
  }
}

export async function setSitePassword(env, password) {
  await env.DB.prepare(
    'INSERT INTO site_access (id, password) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET password = excluded.password'
  ).bind(password).run();
}
