# Admin CMS — one-time setup

This is dashboard/account configuration, not stored in the repo. Do this once before real editors use `/admin/`.

## 1. Cloudflare Access (gates who can log in)

Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**.

- **Domain:** `yl-uni-intl.com`
- **Path:** `/admin*` (covers `/admin/`, and `/admin/api/*` under the same policy)
- **Policy:** an "Emails" rule listing the exact addresses allowed to edit (start with `claydd@gmail.com`; add others as needed later — no code change required, just edit the policy)
- **Identity provider:** "One-time PIN" (email OTP) — Zero Trust's default, needs no separate SSO setup, good fit for a small group

Once saved, Cloudflare's own login page fronts every request under `/admin*` — there's no way to reach the admin tool or its API without passing that gate first. It also passes through a `Cf-Access-Authenticated-User-Email` header, which the Worker uses as the GitHub commit author, so `git log` shows who made each change without any user-accounts code of our own.

## 2. Environment variables (this is a Worker, not classic Pages)

This site turned out to be deployed as a **Cloudflare Worker with static assets** (confirmed via the dashboard — the project lives under Workers & Pages, URL path `.../workers/services/view/younglife-university-map/...`), not a classic Pages project. That means env vars/secrets are set on the **Worker**, not on a "Pages project" screen:

Cloudflare dashboard → **Workers & Pages** → **younglife-university-map** → **Settings** → **Variables and Secrets**.

| Name | Value | Type |
|---|---|---|
| `GITHUB_TOKEN` | A fine-grained GitHub PAT scoped to **only** `claydd218/younglife-university-map`, permission **Contents: Read and write** | Secret (encrypted) |
| `GITHUB_OWNER` | `claydd218` | Plain text |
| `GITHUB_REPO` | `younglife-university-map` | Plain text |
| `GITHUB_BRANCH` | `main` | Plain text |

**Worth double-checking when you set this up:** confirm whether this dashboard's variables apply only to the production deployment or also to preview/branch builds (Workers' preview-environment model isn't identical to classic Pages, and this repo doesn't define named `[env.*]` sections in `wrangler.toml` to separate them explicitly). If preview builds get the same `GITHUB_TOKEN`, a pushed-but-unmerged branch could write real commits to `main` — if that's the case, avoid pushing admin-tool changes to branches other than `main` until that's resolved, rather than relying on the token being scoped away.

## 3. Build settings (only matters because this branch adds `package.json`)

Verify in **Settings** → **Build**: since this repo now has a `wrangler.toml`, Cloudflare's git integration should deploy via `wrangler deploy` automatically — no `npm run build` step should be needed or triggered. `package.json` here is dev tooling only (`wrangler`, for running the admin Worker locally via `npm run dev`); the site itself still has no build step beyond what `wrangler deploy` does on its own.
