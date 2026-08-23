// A tiny public marker file the admin polls after a save to know when its
// own change has actually gone live — not just landed in git. Every
// mutating route calls bumpDeployVersion() after its real write succeeds,
// gets back a fresh token, and returns it to the client as `deployVersion`.
// The client polls this same file on the deployed site until it sees that
// token (or a later one), which only happens once Cloudflare has actually
// rebuilt and redeployed the commit that wrote it.
//
// The token is a random UUID, not the write's own commit SHA — a commit
// can't contain its own hash (the hash is computed from the tree, which
// would include this file's content), so there's no way for the marker
// file to self-report the commit it's part of.

import { getFile, putFile } from './github.js';

export const DEPLOY_VERSION_PATH = 'data/deploy-version.txt';

// Best-effort: called after the real change already committed
// successfully, so a failure here shouldn't fail the whole request — the
// save itself still worked, the caller just won't get a token to poll for
// (and the client skips the "publishing" indicator in that case).
export async function bumpDeployVersion(env, commit) {
  const token = crypto.randomUUID();
  try {
    const existing = await getFile(env, DEPLOY_VERSION_PATH);
    await putFile(env, DEPLOY_VERSION_PATH, token, {
      sha: existing ? existing.sha : undefined,
      message: `Bump deploy version: ${token}`,
      ...commit,
    });
    return token;
  } catch (err) {
    console.error('bumpDeployVersion failed (save itself still succeeded):', err);
    return null;
  }
}
