// Routes /bigtime/api/restricted-access — admin-only management of the
// restricted-countries list and the shared unlock password. Same
// is_admin gate as worker/routes/users.js.

import { jsonResponse, errorResponse } from '../lib/http.js';
import { getRestrictedCountries, setRestrictedCountries, hasRestrictedPassword, setRestrictedPassword } from '../lib/db/restrictedAccess.js';

function requireAdmin(user) {
  if (!user || !user.is_admin) return errorResponse(403, 'Admin access required');
  return null;
}

export async function onRequestGet({ env, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  return jsonResponse({
    countries: await getRestrictedCountries(env),
    passwordSet: await hasRestrictedPassword(env),
  });
}

// Accepts either or both of {countries: [...]} and {password: "..."} —
// a blank/omitted password leaves whatever's already set untouched
// (this endpoint never echoes the current password back, so there's
// nothing for the form to round-trip if the admin only meant to change
// the country list).
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
  if (typeof body.password === 'string' && body.password.trim()) {
    await setRestrictedPassword(env, body.password.trim());
  }

  return jsonResponse({
    ok: true,
    countries: await getRestrictedCountries(env),
    passwordSet: await hasRestrictedPassword(env),
  });
}
