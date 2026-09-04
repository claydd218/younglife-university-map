// TEMPORARY: admin closed for maintenance, per explicit request — blocks
// every /bigtime/* admin path (worker/index.js) and the login API
// (worker/routes/login.js) alike, including anyone with an already-valid
// session cookie, not just new logins. Flip to false (or delete this file
// and its two import sites) to reopen.
export const MAINTENANCE_MODE = true;
