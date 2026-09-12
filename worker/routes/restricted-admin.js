// Routes /bigtime/api/restricted-access — admin-only management of the
// restricted-countries list and the shared unlock password. Same
// is_admin gate as worker/routes/users.js.

import { jsonResponse, errorResponse } from '../lib/http.js';
import {
  getRestrictedCountries, setRestrictedCountries,
  getRestrictedPassword, setRestrictedPassword,
  getRestrictedMode, setRestrictedMode, RESTRICTED_MODES,
} from '../lib/db/restrictedAccess.js';

function requireAdmin(user) {
  if (!user || !user.is_admin) return errorResponse(403, 'Admin access required');
  return null;
}

export async function onRequestGet({ env, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  return jsonResponse({
    countries: await getRestrictedCountries(env),
    password: await getRestrictedPassword(env),
    mode: await getRestrictedMode(env),
  });
}

// Accepts any of {countries: [...]}, {password: "..."}, {mode: "..."} — the
// admin UI always shows the current password/mode back (see
// restrictedAccess.js's own comment on why the password is plain text, not
// hashed), so there's no "blank means leave it alone" special case here:
// whatever value comes through is saved as-is.
export async function onRequestPut({ request, env, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  if (Array.isArray(body.countries)) {
    await setRestrictedCountries(env, body.countries);
  }
  if (typeof body.password === 'string') {
    await setRestrictedPassword(env, body.password);
  }
  if (typeof body.mode === 'string') {
    if (!RESTRICTED_MODES.includes(body.mode)) return errorResponse(400, `Invalid mode: ${body.mode}`);
    await setRestrictedMode(env, body.mode);
  }

  return jsonResponse({
    ok: true,
    countries: await getRestrictedCountries(env),
    password: await getRestrictedPassword(env),
    mode: await getRestrictedMode(env),
  });
}
