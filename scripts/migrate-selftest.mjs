#!/usr/bin/env node
// Post-migration sanity check — run after both migrate-data.mjs's SQL and
// migrate-media.mjs have been applied to remote D1/R2. Compares against
// the still-untouched local data/ files (kept as the source of truth
// until the rollout's retention window ends), not against D1/R2 directly
// (no Node-side D1/R2 client is wired up here — this asserts counts via
// `wrangler` subprocess calls instead, same tool the migrations themselves
// used).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { parseCsv } from '../worker/lib/csv.js';
import { parseParenList } from '../worker/lib/text.js';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    out.push(...(statSync(full).isDirectory() ? walk(full) : [full]));
  }
  return out;
}

function d1Query(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'younglife-map-db', '--remote', '--json', '--command', sql], { encoding: 'utf-8' });
  return JSON.parse(out)[0].results;
}

const csvText = readFileSync(new URL('../data/ministries.csv', import.meta.url), 'utf-8');
const { rows } = parseCsv(csvText);
const expectedStaff = rows.reduce((sum, r) => sum + parseParenList(r.staff).length, 0);
const expectedAssignments = rows.reduce((sum, r) => sum + (r.assigned_staff || '').split(';').map((s) => s.trim()).filter(Boolean).length, 0);

console.log('Checking D1 row counts against data/ministries.csv...');
const [{ ministries, staff, assignments }] = d1Query(
  'SELECT (SELECT COUNT(*) FROM ministries) AS ministries, (SELECT COUNT(*) FROM staff) AS staff, (SELECT COUNT(*) FROM staff_assignments) AS assignments;'
);
assert.equal(ministries, rows.length, `ministries: expected ${rows.length}, got ${ministries}`);
assert.equal(staff, expectedStaff, `staff: expected ${expectedStaff}, got ${staff}`);
// Assignment count in D1 can be <= the CSV's raw count if any were
// dangling references (logged by migrate-data.mjs, not an error here).
assert.ok(assignments <= expectedAssignments, `assignments: got ${assignments}, more than the CSV's own ${expectedAssignments}`);
console.log(`  OK — ${ministries} ministries, ${staff} staff, ${assignments} assignments.`);

console.log('Checking a paren-edge-case round-trips through JSON...');
const [{ universities }] = d1Query(
  `SELECT universities FROM ministries WHERE universities LIKE '%(ITE)%' OR universities LIKE '%ITE%' LIMIT 1;`
);
if (universities) {
  const parsed = JSON.parse(universities);
  assert.ok(Array.isArray(parsed), 'universities column should be a JSON array');
  console.log(`  OK — ${JSON.stringify(parsed)}`);
} else {
  console.log('  (no ITE-style row found in this dataset — skipping, not a failure)');
}

console.log('Spot-checking a few R2 objects against their local source files...');
const localFiles = ['images', 'maps', 'reports'].flatMap((d) => walk(d));
const sample = [localFiles[0], localFiles[Math.floor(localFiles.length / 2)], localFiles[localFiles.length - 1]];
for (const localPath of sample) {
  const tmpOut = `/tmp/r2-selftest-${Date.now()}-${localPath.replace(/[/\\]/g, '_')}`;
  execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `younglife-map-media/${localPath}`, '--remote', '--file', tmpOut], { stdio: 'ignore' });
  const expected = readFileSync(localPath);
  const actual = readFileSync(tmpOut);
  assert.ok(expected.equals(actual), `${localPath}: R2 object doesn't match local file byte-for-byte`);
  console.log(`  OK — ${localPath} (${actual.length} bytes)`);
}
// wrangler r2 has no bucket-listing subcommand in this version to
// cross-check total counts against, so the migration script's own
// per-file upload confirmation (migrate-media.mjs's "N/N uploaded
// successfully") is the count-level signal — this spot-checks content.

console.log('\nAll checks passed.');
