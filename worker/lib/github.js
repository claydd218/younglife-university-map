// Thin wrapper around the GitHub REST Contents API. Every write the admin
// tool makes goes through here — there is no local filesystem, no database,
// no live state anywhere: `git log` on the target repo is the only record
// of what changed, same as every other change made to this site.
//
// Runs in the Workers runtime (Pages Functions), which has native fetch,
// atob/btoa, and TextEncoder/TextDecoder — no npm dependency needed for any
// of this.

const DEFAULT_OWNER = 'claydd218';
const DEFAULT_REPO = 'younglife-university-map';
const DEFAULT_BRANCH = 'main';

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class GitHubApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.body = body;
  }
}

function apiBase(env) {
  const owner = env.GITHUB_OWNER || DEFAULT_OWNER;
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  return `https://api.github.com/repos/${owner}/${repo}`;
}

function branchName(env) {
  return env.GITHUB_BRANCH || DEFAULT_BRANCH;
}

function headers(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // GitHub rejects requests with no User-Agent.
    'User-Agent': 'yl-uni-intl-admin',
  };
}

function committerFields({ authorName, authorEmail } = {}) {
  if (!authorName || !authorEmail) return {};
  const identity = { name: authorName, email: authorEmail };
  return { author: identity, committer: identity };
}

// GitHub returns base64 with embedded newlines every 60 chars — strip those
// before decoding, then decode as UTF-8 text (only correct for text files;
// see putFileBase64 for binary content).
function decodeBase64Utf8(b64) {
  const cleaned = b64.replace(/\n/g, '');
  const binary = atob(cleaned);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function throwIfConflict(res) {
  if (res.status === 409) {
    throw new ConflictError('Someone else saved a change to this file. Reload and try again.');
  }
  // The Contents API also uses 422 for a stale/missing sha on update, not
  // just structural validation errors — treat a 422 that mentions "sha" as
  // the same conflict case so the client only has to handle one shape.
  if (res.status === 422) {
    const text = await res.text();
    if (/sha/i.test(text)) {
      throw new ConflictError('Someone else saved a change to this file. Reload and try again.');
    }
    throw new GitHubApiError('GitHub rejected the request', res.status, text);
  }
}

// path -> { content: string, sha: string } | null (404 = file doesn't exist)
// `content` is UTF-8 decoded text — only for text files (CSV). For images,
// use listDir + the raw sha, not this.
export async function getFile(env, path) {
  const res = await fetch(`${apiBase(env)}/contents/${path}?ref=${branchName(env)}`, {
    headers: headers(env),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GitHubApiError(`GitHub GET ${path} failed`, res.status, await res.text());
  }
  const data = await res.json();
  return { content: decodeBase64Utf8(data.content), sha: data.sha };
}

// path -> { contentBase64: string, sha: string } | null (404 = doesn't
// exist). Unlike getFile, does NOT decode as UTF-8 text — for binary files
// (the cached report PDF), same reasoning as putFileBase64 vs putFile.
export async function getFileBase64(env, path) {
  const res = await fetch(`${apiBase(env)}/contents/${path}?ref=${branchName(env)}`, {
    headers: headers(env),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GitHubApiError(`GitHub GET ${path} failed`, res.status, await res.text());
  }
  const data = await res.json();
  return { contentBase64: data.content.replace(/\n/g, ''), sha: data.sha };
}

// Writes UTF-8 text content (CSV files). `sha` is required to update an
// existing file, omit to create a new one.
export async function putFile(env, path, contentString, { sha, message, authorName, authorEmail } = {}) {
  const body = {
    message,
    content: encodeBase64Utf8(contentString),
    branch: branchName(env),
    ...committerFields({ authorName, authorEmail }),
  };
  if (sha) body.sha = sha;

  const res = await fetch(`${apiBase(env)}/contents/${path}`, {
    method: 'PUT',
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await throwIfConflict(res);
  if (!res.ok) {
    throw new GitHubApiError(`GitHub PUT ${path} failed`, res.status, await res.text());
  }
  const data = await res.json();
  return { sha: data.content.sha };
}

// Writes an already-base64-encoded blob as-is (images). Deliberately
// separate from putFile: re-decoding/re-encoding binary bytes as if they
// were UTF-8 text (putFile's path) corrupts them — this skips that step.
export async function putFileBase64(env, path, base64Content, { sha, message, authorName, authorEmail } = {}) {
  const body = {
    message,
    content: base64Content,
    branch: branchName(env),
    ...committerFields({ authorName, authorEmail }),
  };
  if (sha) body.sha = sha;

  const res = await fetch(`${apiBase(env)}/contents/${path}`, {
    method: 'PUT',
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await throwIfConflict(res);
  if (!res.ok) {
    throw new GitHubApiError(`GitHub PUT ${path} failed`, res.status, await res.text());
  }
  const data = await res.json();
  return { sha: data.content.sha };
}

export async function deleteFile(env, path, sha, message, { authorName, authorEmail } = {}) {
  const body = {
    message,
    sha,
    branch: branchName(env),
    ...committerFields({ authorName, authorEmail }),
  };
  const res = await fetch(`${apiBase(env)}/contents/${path}`, {
    method: 'DELETE',
    headers: { ...headers(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await throwIfConflict(res);
  if (!res.ok) {
    throw new GitHubApiError(`GitHub DELETE ${path} failed`, res.status, await res.text());
  }
}

// path -> [{ name, sha, path }] — [] if the directory doesn't exist.
export async function listDir(env, path) {
  const res = await fetch(`${apiBase(env)}/contents/${path}?ref=${branchName(env)}`, {
    headers: headers(env),
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new GitHubApiError(`GitHub GET (list) ${path} failed`, res.status, await res.text());
  }
  const data = await res.json();
  return data.map((entry) => ({ name: entry.name, sha: entry.sha, path: entry.path }));
}
