// Routes GET /bigtime/api/me — tells the client who's logged in and
// whether they're an admin, so bigtime/admin.js knows whether to show the
// Admin tab. worker/index.js's own gate already guarantees `user` is set
// by the time this runs (this path isn't in PUBLIC_ADMIN_PATHS).

import { jsonResponse } from '../lib/http.js';

export async function onRequestGet({ user }) {
  return jsonResponse({ id: user.id, name: user.name, is_admin: user.is_admin });
}
