// Daily backup of uploaded staff/ministry photos (worker/index.js's
// scheduled() handler, driven by wrangler.toml's cron trigger) into a
// second R2 bucket (env.MEDIA_BACKUP). Deliberately scoped to images/
// only — maps/*.png and reports/*.pdf both regenerate automatically from
// D1 data on demand (see mapArchive.js/reportArchive.js), so backing
// those up would just be protecting something that costs nothing to
// recreate.
//
// A plain mirror (copy if the key doesn't exist in the backup yet) would
// protect against an outright deletion, but not against a bad
// crop/re-upload — the next backup run would just overwrite the backup's
// copy with the same bad content, since it's still "the current version
// of that key." So instead: every *distinct version* of a photo that's
// ever existed (keyed by its own R2 etag, effectively a content hash)
// gets its own permanent backup entry, and nothing already backed up is
// ever touched or deleted by this job — recovering from either a
// deletion or a bad overwrite means finding the right version under
// `<original key>/<etag>` and copying it back.

const IMAGES_PREFIX = 'images/';

export async function backupImages(env) {
  let cursor;
  let checked = 0;
  let copied = 0;
  let skipped = 0;
  let failed = 0;

  do {
    const page = await env.MEDIA.list({ prefix: IMAGES_PREFIX, cursor });
    for (const obj of page.objects) {
      checked++;
      const backupKey = `${obj.key}/${obj.etag}`;
      try {
        // head(), not a full get() — this exact version's already backed
        // up if it's here, so there's nothing to transfer.
        const already = await env.MEDIA_BACKUP.head(backupKey);
        if (already) {
          skipped++;
          continue;
        }
        const full = await env.MEDIA.get(obj.key);
        if (!full) continue; // deleted between list() and get() — next run picks up whatever replaced it, if anything
        await env.MEDIA_BACKUP.put(backupKey, full.body, {
          httpMetadata: full.httpMetadata,
        });
        copied++;
      } catch (err) {
        failed++;
        console.error(`Image backup failed for ${obj.key}:`, err);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { checked, copied, skipped, failed };
}
