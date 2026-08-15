# Admin CMS — one-time setup

This is dashboard/account configuration, not stored in the repo. Do this once before real editors use `/admin/`.

## 1. Cloudflare Access (gates who can log in)

Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**.

- **Domain:** `yl-uni-intl.com`
- **Path:** `/admin*` (covers `/admin/`, and `/admin/api/*` under the same policy)
- **Policy:** an "Emails" rule listing the exact addresses allowed to edit (start with `claydd@gmail.com`; add others as needed later — no code change required, just edit the policy)
- **Identity provider:** "One-time PIN" (email OTP) — Zero Trust's default, needs no separate SSO setup, good fit for a small group

Once saved, Cloudflare's own login page fronts every request under `/admin*` — there's no way to reach the admin tool or its API without passing that gate first. It also passes through a `Cf-Access-Authenticated-User-Email` header, which the Functions use as the GitHub commit author, so `git log` shows who made each change without any user-accounts code of our own.

## 2. Environment variables (Cloudflare Pages project → Settings → Environment variables)

| Name | Value | Scope |
|---|---|---|
| `GITHUB_TOKEN` | A fine-grained GitHub PAT scoped to **only** `claydd218/younglife-university-map`, permission **Contents: Read and write** | **Production only** — leave unset for Preview, see below |
| `GITHUB_OWNER` | `claydd218` | Production + Preview |
| `GITHUB_REPO` | `younglife-university-map` | Production + Preview |
| `GITHUB_BRANCH` | `main` | Production + Preview |

**Why `GITHUB_TOKEN` is Production-only:** Cloudflare Pages spins up a preview deployment for every branch automatically. If a write-capable token were available there too, any preview URL (including from an unmerged/unreviewed branch) could commit real changes to `main`. Leaving it unset means the admin tool simply can't write from a preview URL — which is fine, previews aren't where it's meant to be used.

## 3. Build settings (only matters because this branch adds `package.json`)

Pages project → **Settings** → **Builds & deployments**. Confirm:
- **Build command:** *(none)*
- **Build output directory:** `/`

`package.json` here is dev tooling only (`wrangler`, for running the admin Functions locally) — the site itself still has no build step. If Cloudflare's framework auto-detection tries to run `npm install && npm run build` because a `package.json` now exists, it'll fail (no `build` script) and the deploy will show as failed. If that happens, just set Build command to empty explicitly in this screen and redeploy.
