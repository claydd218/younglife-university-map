// Routes /bigtime/api/site-access — admin-only management of the
// temporary whole-site password gate's password (see
// worker/routes/site-login.js and scripts/schema-site-access.sql). Same
// is_admin gate as worker/routes/users.js.

import { jsonResponse, errorResponse } from '../lib/http.js';
import { getSitePassword, setSitePassword } from '../lib/db/siteAccess.js';

function requireAdmin(user) {
  if (!user || !user.is_admin) return errorResponse(403, 'Admin access required');
  return null;
}

export async function onRequestGet({ env, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  return jsonResponse({ password: await getSitePassword(env) });
}

export async function onRequestPut({ request, env, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const password = typeof body.password === 'string' ? body.password.trim() : '';
  if (!password) return errorResponse(400, 'Password is required');

  await setSitePassword(env, password);
  return jsonResponse({ ok: true, password });
}
