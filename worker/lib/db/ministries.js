// D1-backed replacement for the CSV-reading half of worker/lib/ministries.js.
// Deliberately preserves the *exact* JSON shapes worker/lib/ministries.js's
// old rowToApi()/rowFromBody() produced/consumed — bigtime/admin.js,
// js/app.js, and bigtime/report/report.js all already work against those
// shapes, and none of that (recently-built, already-working) code needs to
// change just because the storage underneath did. The one unavoidable
// exception: `sha` is repurposed to carry the row's own `updated_at`
// value instead of a GitHub blob SHA — see updateMinistry()'s own comment.

import { setAssignment, removeAssignment, upsertHomeStaff, staffRowsForMinistry, assignedStaffNamesForMinistry, getStaffIdByName } from './staff.js';
import { joinParenList } from '../text.js';

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

function toAdminShape(row, staffRows, assignedNames) {
  return {
    id: String(row.id),
    city: row.city,
    country: row.country,
    lat: row.lat,
    lng: row.lng,
    date_opened: row.date_opened,
    is_developing: !!row.is_developing,
    // `id` lets upsertHomeStaff match an edited row back to its real
    // staff record even when the name itself changed — see that
    // function's own comment for why matching by name alone silently
    // corrupted a rename into a delete-and-recreate.
    staff: staffRows.map((s) => ({ id: s.id, name: s.name, role: s.role })),
    assigned_staff: assignedNames,
    universities: JSON.parse(row.universities),
    blurb: row.blurb,
    photos: JSON.parse(row.photos),
    video_url: row.video_url,
    video_label: row.video_label,
    updated_at: row.updated_at,
    sha: row.updated_at, // see module comment — the per-row concurrency token
  };
}

// -> [] of every ministry in the admin's structured JSON shape (same as
// today's rowToApi output). Used only by worker/routes/ministries.js's
// GET (admin) — the public map's own listing goes through
// listMinistriesPublic below instead.
export async function listMinistries(env) {
  const { results: ministryRows } = await env.DB.prepare('SELECT * FROM ministries ORDER BY id').all();
  const { results: allStaff } = await env.DB.prepare('SELECT * FROM staff ORDER BY id').all();
  const { results: allAssignments } = await env.DB.prepare(
    'SELECT sa.ministry_id, s.name FROM staff_assignments sa JOIN staff s ON s.id = sa.staff_id'
  ).all();

  const staffByMinistry = new Map();
  for (const s of allStaff) {
    if (!staffByMinistry.has(s.home_ministry_id)) staffByMinistry.set(s.home_ministry_id, []);
    staffByMinistry.get(s.home_ministry_id).push(s);
  }
  const assignedByMinistry = new Map();
  for (const a of allAssignments) {
    if (!assignedByMinistry.has(a.ministry_id)) assignedByMinistry.set(a.ministry_id, []);
    assignedByMinistry.get(a.ministry_id).push(a.name);
  }

  return ministryRows.map((row) =>
    toAdminShape(row, staffByMinistry.get(row.id) || [], assignedByMinistry.get(row.id) || [])
  );
}

// -> [] in the legacy packed-string shape data/ministries.csv always had
// (staff: "Name (Role); ..."), for the new public GET /api/ministries —
// js/app.js already parses exactly this shape (parseParenList, .split(';'),
// String(is_developing) === 'true'), so this is the one place that still
// needs the paren-list join, purely to keep that client code unchanged.
export async function listMinistriesPublic(env) {
  const admin = await listMinistries(env);
  return admin.map((r) => ({
    id: r.id,
    city: r.city,
    country: r.country,
    lat: String(r.lat),
    lng: String(r.lng),
    date_opened: r.date_opened,
    is_developing: String(r.is_developing),
    universities: joinParenList(r.universities.map((u) => ({ name: u.name, meta: u.year }))),
    staff: joinParenList(r.staff.map((s) => ({ name: s.name, meta: s.role }))),
    assigned_staff: r.assigned_staff.join('; '),
    blurb: r.blurb,
    photos: r.photos.join('; '),
    video_url: r.video_url,
    video_label: r.video_label,
    updated_at: r.updated_at,
  }));
}

export async function getMinistry(env, id) {
  const row = await env.DB.prepare('SELECT * FROM ministries WHERE id = ?').bind(id).first();
  if (!row) return null;
  const [staffRows, assignedNames] = await Promise.all([
    staffRowsForMinistry(env, id),
    assignedStaffNamesForMinistry(env, id),
  ]);
  return toAdminShape(row, staffRows, assignedNames);
}

function ministryColumns(fields) {
  return {
    city: fields.city,
    country: fields.country,
    lat: Number(fields.lat),
    lng: Number(fields.lng),
    date_opened: fields.date_opened || '',
    is_developing: fields.is_developing ? 1 : 0,
    universities: JSON.stringify(fields.universities || []),
    blurb: fields.blurb || '',
    photos: JSON.stringify(fields.photos || []),
    video_url: fields.video_url || '',
    video_label: fields.video_label || '',
  };
}

// `fields`: the same shape rowFromBody used to accept — {city, country,
// lat, lng, date_opened, is_developing, universities:[{name,year}],
// staff:[{name,role}], blurb, photos:[...], video_url, video_label}.
// assigned_staff is deliberately NOT accepted here — a brand-new ministry
// can't have anyone assigned to it yet (nothing else references its id).
export async function insertMinistry(env, fields) {
  const cols = ministryColumns(fields);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO ministries (city, country, lat, lng, date_opened, is_developing, universities, blurb, photos, video_url, video_label, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(cols.city, cols.country, cols.lat, cols.lng, cols.date_opened, cols.is_developing, cols.universities, cols.blurb, cols.photos, cols.video_url, cols.video_label, now).run();
  const id = result.meta.last_row_id;

  await upsertHomeStaff(env, id, fields.staff || []);
  await env.DB.prepare(
    'INSERT INTO ministry_edits (ministry_id, changed_at, action, old_json, new_json) VALUES (?, ?, ?, NULL, ?)'
  ).bind(id, now, 'create', JSON.stringify({ ...cols, staff: fields.staff || [] })).run();

  // The full fresh row, not just {id, updated_at} — critically including
  // the real database id upsertHomeStaff just assigned each new staff
  // member, which bigtime/admin.js needs in its own local state so a
  // second save (of a just-created staffer, no reload in between) is
  // recognized as an update, not another insert of the same person.
  return getMinistry(env, id);
}

// expectedUpdatedAt: the row's own `updated_at`/`sha` value the client
// last saw — the per-row equivalent of GitHub's SHA check. 0 rows
// affected by the conditional UPDATE means either the id doesn't exist
// (NotFoundError) or someone else's write already changed updated_at
// (ConflictError) — a follow-up SELECT tells them apart, same "someone
// else's edit landed first, reload" UX the admin already shows today.
export async function updateMinistry(env, id, expectedUpdatedAt, fields) {
  const existing = await env.DB.prepare('SELECT updated_at FROM ministries WHERE id = ?').bind(id).first();
  if (!existing) throw new NotFoundError(`No ministry with id ${id}`);

  const cols = ministryColumns(fields);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE ministries SET city=?, country=?, lat=?, lng=?, date_opened=?, is_developing=?, universities=?, blurb=?, photos=?, video_url=?, video_label=?, updated_at=?
     WHERE id = ? AND updated_at = ?`
  ).bind(cols.city, cols.country, cols.lat, cols.lng, cols.date_opened, cols.is_developing, cols.universities, cols.blurb, cols.photos, cols.video_url, cols.video_label, now, id, expectedUpdatedAt).run();

  if (result.meta.changes === 0) {
    throw new ConflictError('Someone else saved a change to this ministry. Reload and try again.');
  }

  const oldStaff = await staffRowsForMinistry(env, id);
  await upsertHomeStaff(env, id, fields.staff || []);

  // Reconciles who's assigned TO this ministry (fields.assigned_staff —
  // the read-only "Assigned Here" section on this same form, edited via
  // its own Remove Assignment buttons) against what's actually in
  // staff_assignments. The picker dialog (bigtime/admin.js's
  // openAssignStaffDialog) calls setAssignment/removeAssignment directly
  // against the *target* ministry it's checking boxes for — a separate
  // path from this one, which only ever reconciles the currently-open
  // ministry's own incoming list.
  if (fields.assigned_staff) {
    const current = new Set(await assignedStaffNamesForMinistry(env, id));
    const wanted = new Set(fields.assigned_staff);
    for (const name of wanted) {
      if (!current.has(name)) {
        const staffId = await getStaffIdByName(env, name);
        if (staffId) await setAssignment(env, staffId, id);
      }
    }
    for (const name of current) {
      if (!wanted.has(name)) {
        const staffId = await getStaffIdByName(env, name);
        if (staffId) await removeAssignment(env, staffId, id);
      }
    }
  }

  await env.DB.prepare(
    'INSERT INTO ministry_edits (ministry_id, changed_at, action, old_json, new_json) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, now, 'update', JSON.stringify({ staff: oldStaff }), JSON.stringify({ ...cols, staff: fields.staff || [] })).run();

  // See insertMinistry's own comment — same reason: a just-added staff
  // member's real id has to make it back to the client.
  return getMinistry(env, id);
}

export async function deleteMinistry(env, id) {
  const row = await env.DB.prepare('SELECT * FROM ministries WHERE id = ?').bind(id).first();
  if (!row) throw new NotFoundError(`No ministry with id ${id}`);
  const staffRows = await staffRowsForMinistry(env, id);

  // ON DELETE CASCADE (staff, then staff_assignments transitively) handles
  // cleanup of this ministry's own home staff and every assignment
  // pointing at them — see scripts/schema.sql's own comment on why this
  // is a real bug fix versus the old CSV system, not just a port.
  await env.DB.prepare('DELETE FROM ministries WHERE id = ?').bind(id).run();

  await env.DB.prepare(
    'INSERT INTO ministry_edits (ministry_id, changed_at, action, old_json, new_json) VALUES (?, ?, ?, ?, NULL)'
  ).bind(id, new Date().toISOString(), 'delete', JSON.stringify({ ...row, staff: staffRows })).run();

  return { city: row.city, country: row.country, removedStaffNames: staffRows.map((s) => s.name) };
}
