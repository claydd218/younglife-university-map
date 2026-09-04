// Thin wrapper around the R2 bucket binding (env.MEDIA) — replaces
// worker/lib/github.js as the storage layer for images/, maps/, and
// reports/. Mirrors github.js's function shapes (getFile/putFile/
// putFileBase64/deleteFile/listDir) closely enough that the route files
// that used to call those could be swapped over mechanically.
//
// No SHA/ConflictError concept here — R2 puts are unconditional
// overwrites-by-key, matching the actual (never enforced) risk profile
// image writes already had under git: two admins uploading the same
// staff photo at once already just last-write-wins in practice.

// path -> R2ObjectBody | null (404 = doesn't exist). Callers that need the
// raw bytes should call .arrayBuffer()/.bytes() on the result; callers
// that just want to stream it back out (worker/routes/media.js) can pass
// the ObjectBody straight through as a Response body.
export async function getObject(env, key) {
  const object = await env.MEDIA.get(key);
  return object || null;
}

// bytes: Uint8Array | ArrayBuffer. No base64 round-trip needed — R2 takes
// raw bytes directly, unlike GitHub's Contents API.
export async function putObject(env, key, bytes, { contentType } = {}) {
  const result = await env.MEDIA.put(key, bytes, {
    httpMetadata: contentType ? { contentType } : undefined,
  });
  return { etag: result.etag };
}

export async function deleteObject(env, key) {
  await env.MEDIA.delete(key);
}

// Deletes every object under `prefix` (e.g. all of a ministry's photos in
// one call) — R2 has no "delete a folder" primitive, so this lists then
// deletes each key.
export async function deleteObjectsWithPrefix(env, prefix) {
  const objects = await listObjects(env, prefix);
  await Promise.all(objects.map((o) => deleteObject(env, o.key)));
}

// prefix -> [{ name, key }] — `name` is the key with the prefix stripped
// (matching github.js's listDir({name, sha, path}) shape closely enough
// that existing `.filter(f => f.name.startsWith(...))`-style logic in
// upload.js/photo.js/images-manifest.js needs no changes beyond the
// import swap). [] if nothing matches (never throws for "no results").
export async function listObjects(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.MEDIA.list({ prefix, cursor });
    for (const obj of page.objects) {
      out.push({ name: obj.key.slice(prefix.length), key: obj.key });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}
