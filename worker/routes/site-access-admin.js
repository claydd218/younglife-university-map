// Routes /bigtime/api/site-access — admin-only management of the
// temporary whole-site password gate's password (see
// worker/routes/site-login.js and scripts/schema-site-access.sql). Same
// is_admin gate as worker/routes/users.js.

import { jsonResponse, errorResponse } from '../lib/http.js';
import { getSitePassword, setSitePassword, isSiteGateDisabled, setSiteGateDisabled } from '../lib/db/siteAccess.js';

function requireAdmin(user) {
  if (!user || !user.is_admin) return errorResponse(403, 'Admin access required');
  return null;
}

export async function onRequestGet({ env, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  return jsonResponse({ password: await getSitePassword(env), disabled: await isSiteGateDisabled(env) });
}

// Accepts either or both of {password: "..."} and {disabled: true/false} —
// password is only required/validated when it's actually present in the
// body, so toggling the gate on/off doesn't force re-submitting a password
// that isn't changing.
export async function onRequestPut({ request, env, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  if (typeof body.password === 'string') {
    const password = body.password.trim();
    if (!password) return errorResponse(400, 'Password is required');
    await setSitePassword(env, password);
  }
  if (typeof body.disabled === 'boolean') {
    await setSiteGateDisabled(env, body.disabled);
  }

  return jsonResponse({ ok: true, password: await getSitePassword(env), disabled: await isSiteGateDisabled(env) });
}
