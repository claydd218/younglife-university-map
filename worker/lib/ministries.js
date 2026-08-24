// Shared CSV<->API conversion and validation for the ministries endpoints
// (functions/admin/api/ministries.js and functions/admin/api/ministries/[id].js),
// so both files build/validate rows the exact same way.

import { getFile } from './github.js';
import { parseCsv } from './csv.js';
import { parseParenList, joinParenList, assertNoParens, stripParens, parseVideoEmbedUrl, ValidationError } from './text.js';

export const MINISTRIES_PATH = 'data/ministries.csv';
export const DIVISIONS_PATH = 'data/country-divisions.csv';
export const HEADER = ['id', 'city', 'country', 'lat', 'lng', 'date_opened', 'is_developing', 'universities', 'staff', 'blurb', 'photos', 'video_url', 'video_label', 'updated_at'];

// country -> division, per data/country-divisions.csv.
export async function loadDivisions(env) {
  const file = await getFile(env, DIVISIONS_PATH);
  const map = new Map();
  if (!file) return map;
  const { rows } = parseCsv(file.content);
  for (const row of rows) {
    const country = (row.country || '').trim();
    const division = (row.division || '').trim();
    if (country && division) map.set(country, division);
  }
  return map;
}

// A raw ministries.csv row -> the JSON shape the admin form edits.
// staff/universities are parsed with the same (unchanged) regex the public
// site uses, purely to pre-fill the form — read-only/best-effort, matching
// its existing fallback (no-match -> whole string as name, empty meta).
// parseParenList returns generic {name, meta} pairs; the API/form uses the
// more legible {name, role} and {name, year} — rename here, not in
// text.js, since text.js is also duplicated verbatim from js/utils.js and
// shouldn't drift from it.
export function rowToApi(row) {
  return {
    id: row.id,
    city: row.city,
    country: row.country,
    lat: row.lat,
    lng: row.lng,
    date_opened: row.date_opened,
    is_developing: String(row.is_developing).trim().toLowerCase() === 'true',
    staff: parseParenList(row.staff).map(({ name, meta }) => ({ name, role: meta })),
    universities: parseParenList(row.universities).map(({ name, meta }) => ({ name, year: meta })),
    blurb: row.blurb,
    photos: (row.photos || '').split(';').map((s) => s.trim()).filter(Boolean),
    video_url: row.video_url || '',
    video_label: row.video_label || '',
    updated_at: row.updated_at || '',
  };
}

// The admin form's JSON body -> a raw ministries.csv row. Throws
// ValidationError on any problem — the caller maps that to a 400.
export function rowFromBody(id, body) {
  const required = ['city', 'country', 'lat', 'lng'];
  for (const field of required) {
    if (!body[field] || !String(body[field]).trim()) {
      throw new ValidationError(`${field} is required`, field);
    }
  }
  if (Number.isNaN(Number(body.lat)) || Number.isNaN(Number(body.lng))) {
    throw new ValidationError('Lat/Lng must be numbers', 'lat');
  }
  for (const s of body.staff || []) {
    assertNoParens(s.name, 'Staff name');
    assertNoParens(s.role, 'Staff role');
  }

  // Rejected outright rather than sanitized (unlike university names) —
  // there's no reasonable way to "clean up" a link that doesn't point at a
  // playable video, unlike stripping a stray paren out of a name.
  const videoUrl = (body.video_url || '').trim();
  if (videoUrl && !parseVideoEmbedUrl(videoUrl)) {
    throw new ValidationError('Video link must be a YouTube or Vimeo URL', 'video_url');
  }
  // Only meaningful (and only defaulted) alongside an actual video — an
  // empty video_url means no video at all, so any label is discarded too
  // rather than left dangling with nothing to attach to.
  const videoLabel = videoUrl ? ((body.video_label || '').trim() || `Watch a ${body.city.trim()} Story`) : '';

  const staffMeta = (body.staff || []).map(({ name, role }) => ({ name, meta: role }));
  // Universities get sanitized rather than rejected — see stripParens.
  const universitiesMeta = (body.universities || []).map(({ name, year }) => ({
    name: stripParens(name),
    meta: stripParens(year),
  }));

  return {
    id: String(id),
    city: body.city.trim(),
    country: body.country.trim(),
    lat: String(body.lat).trim(),
    lng: String(body.lng).trim(),
    date_opened: (body.date_opened || '').trim(),
    is_developing: body.is_developing ? 'true' : 'false',
    universities: joinParenList(universitiesMeta),
    staff: joinParenList(staffMeta),
    blurb: (body.blurb || '').trim(),
    photos: (body.photos || []).join('; '),
    video_url: videoUrl,
    video_label: videoLabel,
    // Server-stamped, never taken from the client — every call through
    // here is a real write to this row (a plain save, or the target side
    // of a staff Move), so "now" is always correct and can't be spoofed.
    updated_at: new Date().toISOString(),
  };
}

export function maxId(rows) {
  return rows.reduce((max, r) => Math.max(max, parseInt(r.id, 10) || 0), 0);
}
