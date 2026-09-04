# Admin CMS — one-time setup

This is dashboard/account configuration, not stored in the repo. Do this once before real editors use `/bigtime/`.

## 1. Environment variables (this is a Worker, not classic Pages)

This site turned out to be deployed as a **Cloudflare Worker with static assets** (confirmed via the dashboard — the project lives under Workers & Pages, URL path `.../workers/services/view/younglife-university-map/...`), not a classic Pages project. That means env vars/secrets are set on the **Worker**, not on a "Pages project" screen:

Cloudflare dashboard → **Workers & Pages** → **younglife-university-map** → **Settings** → **Variables and Secrets**.

| Name | Value | Type |
|---|---|---|
| `ADMIN_SESSION_SECRET` | A long random string (e.g. `openssl rand -hex 32`) — never shared with anyone, just used to sign login sessions | Secret (encrypted) |
| `ADMIN_TURNSTILE_SECRET_KEY` | The **Secret Key** from the Cloudflare Turnstile widget (Turnstile → your site → Settings) | Secret (encrypted) |

Login fails closed if `ADMIN_TURNSTILE_SECRET_KEY` isn't set — same fail-safe pattern as the other secrets here — so this one isn't optional once the login page's Turnstile widget is live; without it, nobody (including a correct password) can log in.

## 2. Login

No Cloudflare Access — per-user accounts instead, stored in D1's `admin_users` table (name, login, password hash, is_admin) and managed by any admin at `/bigtime/`'s own Admin tab (see `worker/routes/users.js`). A Cloudflare Turnstile widget on the login form keeps bots/scanners out. Visiting `/bigtime/` while logged out redirects to `/bigtime/login.html`; a passed Turnstile check and correct login+password together set a signed, HttpOnly session cookie (90 days, sliding) naming that user, and every ministry edit records their current name in the Log tab. Removing a user (or someone's own admin status) takes effect immediately, not just at cookie expiry — `worker/lib/session.js`'s `getSessionUser` re-checks `admin_users` on every request, not just the cookie's signature.

**Bootstrapping the very first account** (a fresh deployment with an empty `admin_users` table — there's no signup flow, and the Admin tab needs an existing admin to create anyone): insert one directly via `wrangler d1 execute`, hashing a password the same way `worker/lib/password.js`'s `hashPassword` does (PBKDF2-SHA256, 100000 iterations — the Workers runtime's own cap — 16-byte salt, stored as `{iterations}.{saltHex}.{hashHex}`), then set `is_admin = 1` on that row so they can create everyone else through the UI from there.

Before this existed, admin login was a single password shared by every editor — every edit was attributed to a generic identity, with no way to know who actually made a given change. Per-user accounts (and the Log tab reading `ministry_edits.user_name`) are what replaced that.

## 3. Build settings (only matters because this branch adds `package.json`)

Verify in **Settings** → **Build**: since this repo now has a `wrangler.toml`, Cloudflare's git integration should deploy via `wrangler deploy` automatically — no `npm run build` step should be needed or triggered. `package.json` here is dev tooling only (`wrangler`, for running the admin Worker locally via `npm run dev`); the site itself still has no build step beyond what `wrangler deploy` does on its own.

## 4. Temporary public-site password gate

Requested to keep the whole public site private for a while before the real launch — separate from, and independent of, the admin login above. Same **Variables and Secrets** screen as section 1, two more secrets:

| Name | Value | Type |
|---|---|---|
| `SITE_SHARED_PASSWORD` | The password visitors enter | Secret (encrypted) |
| `SITE_SESSION_SECRET` | A long random string (e.g. `openssl rand -hex 32`) — never shared with anyone, just used to sign the site's session cookie | Secret (encrypted) |

Until both are set, `hasValidSiteSession` fails closed (same fail-safe pattern as the admin secrets), so every visitor gets bounced to `/site-login` with no way to pass it — set both before this deploys, not after.

**To remove it later** (real launch day): delete `worker/lib/siteSession.js`, `worker/routes/site-login.js`, `site-login.html`, and `site-login.js`; in `worker/index.js`, remove the `siteLogin`/`siteLogout`/`hasValidSiteSession`/`createSiteSessionCookie` imports, the `PUBLIC_SITE_PATHS` constant, the `hasAdminSession`/`needsSiteSession`/`siteSessionValid` block right after the admin session check, the two `/api/site-login`/`/api/site-logout` lines in `routeRequest`, and fold the cookie-renewal `if` back down to just `sessionValid`. Nothing else in the repo references any of it — including `worker/lib/reportCapture.js`'s Puppeteer navigation, which relies only on `hasAdminSession` exempting an already-logged-in admin from the site gate on every path, not on anything specific to the site gate's own implementation, so removing the gate entirely leaves report generation unaffected. The two secrets above can be left in the dashboard afterward (unused) or removed — either is safe.
