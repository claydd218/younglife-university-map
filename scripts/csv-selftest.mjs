// Manual self-check for functions/_lib/csv.js and functions/_lib/text.js.
// Run with: node scripts/csv-selftest.mjs
// No test framework in this repo; this is a small dependency-free assert
// script for the one genuinely tricky piece of logic in the admin tool.

import assert from 'node:assert/strict';
import { parseCsv, stringifyCsv } from '../functions/_lib/csv.js';
import { parseParenList, joinParenList, assertNoParens, slugify } from '../functions/_lib/text.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

check('parses a simple row', () => {
  const { header, rows } = parseCsv('a,b,c\n1,2,3\n');
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.deepEqual(rows, [{ a: '1', b: '2', c: '3' }]);
});

check('comma inside a quoted field', () => {
  const { rows } = parseCsv('id,blurb\n1,"Reaches students in Districts 7, 8, and Nha Be"\n');
  assert.equal(rows[0].blurb, 'Reaches students in Districts 7, 8, and Nha Be');
});

check('doubled quote inside a quoted field', () => {
  const { rows } = parseCsv('id,blurb\n1,"She said ""hello"" to everyone"\n');
  assert.equal(rows[0].blurb, 'She said "hello" to everyone');
});

check('embedded newline inside a quoted field', () => {
  const { rows } = parseCsv('id,blurb\n1,"Line one\nLine two"\n');
  assert.equal(rows[0].blurb, 'Line one\nLine two');
});

check('mixed CRLF/LF line endings', () => {
  const { rows } = parseCsv('id,city\r\n1,Dhaka\n2,Khulna\r\n');
  assert.deepEqual(rows, [
    { id: '1', city: 'Dhaka' },
    { id: '2', city: 'Khulna' },
  ]);
});

check('stringifyCsv quotes only fields that need it', () => {
  const out = stringifyCsv(['id', 'city', 'blurb'], [
    { id: '1', city: 'Dhaka', blurb: 'No special characters here' },
  ]);
  assert.equal(out, 'id,city,blurb\n1,Dhaka,No special characters here\n');
});

check('stringifyCsv quotes a field containing a comma and doubles internal quotes', () => {
  const out = stringifyCsv(['id', 'blurb'], [
    { id: '1', blurb: 'Districts 7, 8, and "Nha Be"' },
  ]);
  assert.equal(out, 'id,blurb\n1,"Districts 7, 8, and ""Nha Be"""\n');
});

check('round-trips real ministries.csv-shaped data through parse -> stringify -> parse', () => {
  const original = [
    { id: '1', city: 'Ho Chi Minh City', blurb: 'Two hubs, Districts 7, 8, and Nha Be.' },
    { id: '2', city: 'Dhaka', blurb: 'Bangladesh\'s first YLU ministry, "launched" in 2025.' },
  ];
  const header = ['id', 'city', 'blurb'];
  const csvText = stringifyCsv(header, original);
  const { rows: reparsed } = parseCsv(csvText);
  assert.deepEqual(reparsed, original);
});

check('joinParenList preserves the no-meta case (e.g. "Jaffray School of Theology")', () => {
  const out = joinParenList([
    { name: 'Hasanuddin University (UNHAS)', meta: '' },
    { name: 'Jaffray School of Theology', meta: '' },
    { name: 'University of Negri Makassar (UNEM)', meta: '' },
  ]);
  assert.equal(out, 'Hasanuddin University (UNHAS); Jaffray School of Theology; University of Negri Makassar (UNEM)');
});

check('parseParenList -> joinParenList round-trips a mixed meta/no-meta list', () => {
  const raw = 'JP Teves (Staff Associate); Some Volunteer';
  const parsed = parseParenList(raw);
  assert.deepEqual(parsed, [
    { name: 'JP Teves', meta: 'Staff Associate' },
    { name: 'Some Volunteer', meta: '' },
  ]);
  assert.equal(joinParenList(parsed), raw);
});

check('assertNoParens rejects a literal paren, accepts clean text', () => {
  assert.throws(() => assertNoParens('Cadette (College Coordinator)', 'Role'), /parentheses/);
  assert.doesNotThrow(() => assertNoParens('Cadette College Coordinator', 'Role'));
});

check('slugify matches the known real-data cases', () => {
  assert.equal(slugify('Jeannette Dembélé'), 'jeannette-dembele');
  assert.equal(slugify("N'gouan Ebu Noel"), 'n-gouan-ebu-noel');
  assert.equal(slugify('Daniel-Njoku'), 'daniel-njoku');
});

console.log(`\n${passed} passed`);
