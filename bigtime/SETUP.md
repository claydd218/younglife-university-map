# Admin CMS — one-time setup

This is dashboard/account configuration, not stored in the repo. Do this once before real editors use `/bigtime/`.

## 1. Environment variables (this is a Worker, not classic Pages)

This site turned out to be deployed as a **Cloudflare Worker with static assets** (confirmed via the dashboard — the project lives under Workers & Pages, URL path `.../workers/services/view/younglife-university-map/...`), not a classic Pages project. That means env vars/secrets are set on the **Worker**, not on a "Pages project" screen:

Cloudflare dashboard → **Workers & Pages** → **younglife-university-map** → **Settings** → **Variables and Secrets**.

| Name | Value | Type |
|---|---|---|
| `GITHUB_TOKEN` | A fine-grained GitHub PAT scoped to **only** `claydd218/younglife-university-map`, permission **Contents: Read and write** | Secret (encrypted) |
| `GITHUB_OWNER` | `claydd218` | Plain text |
| `GITHUB_REPO` | `younglife-university-map` | Plain text |
| `GITHUB_BRANCH` | `main` | Plain text |
| `ADMIN_SHARED_PASSWORD` | Whatever password you're sharing with editors | Secret (encrypted) |
| `ADMIN_SESSION_SECRET` | A long random string (e.g. `openssl rand -hex 32`) — never shared with anyone, just used to sign login sessions | Secret (encrypted) |

**Worth double-checking when you set this up:** confirm whether this dashboard's variables apply only to the production deployment or also to preview/branch builds (Workers' preview-environment model isn't identical to classic Pages, and this repo doesn't define named `[env.*]` sections in `wrangler.toml` to separate them explicitly). If preview builds get the same `GITHUB_TOKEN`, a pushed-but-unmerged branch could write real commits to `main` — if that's the case, avoid pushing admin-tool changes to branches other than `main` until that's resolved, rather than relying on the token being scoped away.

## 2. Login

No Cloudflare Access, no per-user accounts — just a single shared password, checked against `ADMIN_SHARED_PASSWORD` above. Visiting `/bigtime/` while logged out redirects to `/bigtime/login.html`; a correct password sets a signed, HttpOnly session cookie (30 days) and there's nothing else to configure. Share the password with whoever needs to edit; change it any time by updating `ADMIN_SHARED_PASSWORD` (existing logged-in sessions stay valid until they expire, since the cookie's signature only depends on `ADMIN_SESSION_SECRET` — rotate that too if you need to force everyone out immediately).

One tradeoff worth knowing: since everyone shares one password, git commit history (`git log` on `data/ministries.csv`/`images/`) will show every admin edit as coming from the same generic committer identity — there's no per-editor attribution the way Cloudflare Access's per-email login would have given.

## 3. Build settings (only matters because this branch adds `package.json`)

Verify in **Settings** → **Build**: since this repo now has a `wrangler.toml`, Cloudflare's git integration should deploy via `wrangler deploy` automatically — no `npm run build` step should be needed or triggered. `package.json` here is dev tooling only (`wrangler`, for running the admin Worker locally via `npm run dev`); the site itself still has no build step beyond what `wrangler deploy` does on its own.
