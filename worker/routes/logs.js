// Routes GET /bigtime/api/logs?before=<id>&limit=50 — reads ministry_edits
// (the lightweight audit table added with the original D1 migration)
// newest-first, paginated, and builds a human-readable summary of what
// actually changed on each row instead of a bare action label. City/
// country primarily come from old_json/new_json (so a deleted ministry's
// own row being gone by the time its log entry is read doesn't lose the
// label), falling back to a live join against ministries for rows whose
// JSON snapshot doesn't carry it (staff-move only logs the target
// ministry's id, not its city/country).

import { jsonResponse } from '../lib/http.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cityCountry(newData, oldData) {
  const source = newData || oldData;
  return { city: (source && source.city) || null, country: (source && source.country) || null };
}

// [{id, name}] from either shape staff has appeared in: DB rows
// (staffRowsForMinistry, id always present) or the client's submitted
// shape ({id?, name, role}, id absent for a brand-new row).
function staffDiff(oldStaff, newStaff) {
  const oldById = new Map((oldStaff || []).filter((s) => s.id != null).map((s) => [s.id, s.name]));
  const newById = new Map((newStaff || []).filter((s) => s.id != null).map((s) => [s.id, s.name]));
  const added = [];
  const renamed = [];
  for (const [id, name] of newById) {
    if (!oldById.has(id)) added.push(name);
    else if (oldById.get(id) !== name) renamed.push(`${oldById.get(id)} → ${name}`);
  }
  const removed = [];
  for (const [id, name] of oldById) {
    if (!newById.has(id)) removed.push(name);
  }
  return { added, removed, renamed };
}

function listDiff(oldList, newList) {
  const oldSet = new Set(oldList || []);
  const newSet = new Set(newList || []);
  return {
    added: [...newSet].filter((n) => !oldSet.has(n)),
    removed: [...oldSet].filter((n) => !newSet.has(n)),
  };
}

function buildUpdateSummary(oldData, newData) {
  if (!oldData || !newData) return 'Updated';
  const parts = [];
  if (oldData.city !== newData.city || oldData.country !== newData.country) {
    parts.push(`moved to ${newData.city}, ${newData.country}`);
  }
  if (oldData.lat !== newData.lat || oldData.lng !== newData.lng) parts.push('pin location changed');
  if (oldData.date_opened !== newData.date_opened) parts.push('opening date changed');
  if (!!oldData.is_developing !== !!newData.is_developing) {
    parts.push(newData.is_developing ? 'marked as developing' : 'no longer marked as developing');
  }
  if (oldData.blurb !== newData.blurb) parts.push('description changed');
  if (oldData.universities !== newData.universities) parts.push('universities changed');
  if (oldData.photos !== newData.photos) parts.push('photos changed');
  if (oldData.video_url !== newData.video_url || oldData.video_label !== newData.video_label) parts.push('video changed');

  const sd = staffDiff(oldData.staff, newData.staff);
  if (sd.added.length) parts.push(`staff added: ${sd.added.join(', ')}`);
  if (sd.removed.length) parts.push(`staff removed: ${sd.removed.join(', ')}`);
  if (sd.renamed.length) parts.push(`staff renamed: ${sd.renamed.join(', ')}`);

  const ad = listDiff(oldData.assigned_staff, newData.assigned_staff);
  if (ad.added.length) parts.push(`assigned here: +${ad.added.join(', ')}`);
  if (ad.removed.length) parts.push(`assigned here: -${ad.removed.join(', ')}`);

  return parts.length ? parts.join('; ') : 'Saved with no visible changes';
}

function buildSummary(action, oldData, newData) {
  if (action === 'create') {
    const staffNames = (newData && newData.staff ? newData.staff : []).map((s) => s.name);
    return staffNames.length ? `Added, with staff: ${staffNames.join(', ')}` : 'Added';
  }
  if (action === 'delete') {
    const staffNames = (oldData && oldData.staff ? oldData.staff : []).map((s) => s.name);
    return staffNames.length ? `Removed (was staffed by: ${staffNames.join(', ')})` : 'Removed';
  }
  if (action === 'staff-move') {
    const name = newData && newData.staffName;
    const fromCity = newData && newData.fromCity;
    if (name && fromCity) return `Moved ${name} here from ${fromCity}, ${newData.fromCountry}`;
    if (name) return `Moved ${name} here`;
    return 'Moved a staff member here';
  }
  if (action === 'update') return buildUpdateSummary(oldData, newData);
  return action;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const before = url.searchParams.get('before');
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || DEFAULT_LIMIT));

  const query = before
    ? env.DB.prepare(
        `SELECT me.*, m.city AS live_city, m.country AS live_country
         FROM ministry_edits me LEFT JOIN ministries m ON m.id = me.ministry_id
         WHERE me.id < ? ORDER BY me.id DESC LIMIT ?`
      ).bind(Number(before), limit)
    : env.DB.prepare(
        `SELECT me.*, m.city AS live_city, m.country AS live_country
         FROM ministry_edits me LEFT JOIN ministries m ON m.id = me.ministry_id
         ORDER BY me.id DESC LIMIT ?`
      ).bind(limit);
  const { results } = await query.all();

  const rows = results.map((row) => {
    const oldData = parseJson(row.old_json);
    const newData = parseJson(row.new_json);
    const { city, country } = cityCountry(newData, oldData);
    return {
      id: row.id,
      ministry_id: row.ministry_id,
      changed_at: row.changed_at,
      action: row.action,
      user_name: row.user_name,
      city: city || row.live_city || null,
      country: country || row.live_country || null,
      summary: buildSummary(row.action, oldData, newData),
    };
  });

  return jsonResponse({ rows, nextBefore: rows.length === limit ? rows[rows.length - 1].id : null });
}
