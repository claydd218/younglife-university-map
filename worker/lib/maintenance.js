// Admin-wide kill switch, kept around for any future maintenance window —
// blocks every /bigtime/* admin path (worker/index.js) and the login API
// (worker/routes/login.js) alike, including anyone with an already-valid
// session cookie, not just new logins. Was `true` during the D1/R2 and
// per-user-accounts migration to keep the half-built system closed to
// real editors; now `false` — the launched, intended state.
export const MAINTENANCE_MODE = false;
