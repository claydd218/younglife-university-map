#!/usr/bin/env node
// One-time migration: images/, maps/, reports/ -> R2 (bucket
// younglife-map-media), at the identical relative key each file has
// today (images/foo.jpg -> key "images/foo.jpg") — see the migration
// plan for why the key scheme deliberately mirrors today's paths.
// Idempotent (R2 puts are overwrite-by-key) — safe to re-run.
//
// Shells out to `wrangler r2 object put` per file rather than using the
// S3-compatible API directly, so it can reuse the same `wrangler login`
// OAuth session already in place for the D1 migration, with no separate
// R2 API token to provision. Runs with limited concurrency since ~380
// individual CLI invocations serially would be slow.
//
// Usage: node scripts/migrate-media.mjs

import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';

const BUCKET = 'younglife-map-media';
const DIRS = ['images', 'maps', 'reports'];
const CONCURRENCY = 6;

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function uploadOne(localPath) {
  return new Promise((resolve, reject) => {
    const key = localPath.split('/').join('/'); // already repo-relative, e.g. "images/foo.jpg"
    const contentType = CONTENT_TYPES[extname(localPath).toLowerCase()] || 'application/octet-stream';
    const args = [
      'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`,
      '--file', localPath,
      '--content-type', contentType,
      '--remote',
    ];
    const child = spawn('npx', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (code === 0) resolve(key);
      else reject(new Error(`${key}: exit ${code}\n${stderr}`));
    });
  });
}

async function runPool(items, worker, concurrency) {
  let index = 0;
  let done = 0;
  const failures = [];
  async function next() {
    while (index < items.length) {
      const i = index++;
      try {
        await worker(items[i]);
      } catch (err) {
        failures.push(err.message);
      }
      done++;
      if (done % 25 === 0 || done === items.length) {
        console.error(`  ${done}/${items.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return failures;
}

const files = DIRS.flatMap((d) => walk(d));
console.error(`Uploading ${files.length} files to r2://${BUCKET} (concurrency ${CONCURRENCY})...`);

const failures = await runPool(files, uploadOne, CONCURRENCY);

console.error('');
if (failures.length) {
  console.error(`${failures.length} FAILED:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exitCode = 1;
} else {
  console.error(`All ${files.length} files uploaded successfully.`);
}
