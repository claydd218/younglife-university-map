// Staff/staff_assignments queries — the D1-backed replacement for the
// name-matching-across-CSV-columns scheme bigtime/admin.js's
// findStaffHome()/confirmMoveStaff()/sweepAssignments() used to implement
// by hand. Those client-side functions are unchanged (see
// worker/lib/db/ministries.js's own comment on why the JSON contract is
// preserved) — this module is what the *server* now does instead of a
// client-side scan across every ministry row.

import { slugify } from '../text.js';

export async function staffRowsForMinistry(env, ministryId) {
  const { results } = await env.DB.prepare('SELECT * FROM staff WHERE home_ministry_id = ? ORDER BY id').bind(ministryId).all();
  return results;
}

export async function assignedStaffNamesForMinistry(env, ministryId) {
  const { results } = await env.DB.prepare(
    'SELECT s.name FROM staff_assignments sa JOIN staff s ON s.id = sa.staff_id WHERE sa.ministry_id = ?'
  ).bind(ministryId).all();
  return results.map((r) => r.name);
}

// First staff row matching this exact name, anywhere — mirrors the old
// client-side findStaffHome()'s "scan every row's staff list" semantics
// (first match wins if a name is somehow duplicated, same as before).
export async function getStaffIdByName(env, name) {
  const row = await env.DB.prepare('SELECT id FROM staff WHERE name = ? LIMIT 1').bind(name).first();
  return row ? row.id : null;
}

// Diffs `staffEntries` ([{name, role}], the ministry form's current Staff
// section) against this ministry's existing home staff rows, by name —
// same matching heuristic bigtime/admin.js already used, just scoped to
// one ministry's own rows instead of a global scan (strictly narrower and
// safer: a same-named person elsewhere is never touched by this).
export async function upsertHomeStaff(env, ministryId, staffEntries) {
  const existing = await staffRowsForMinistry(env, ministryId);
  const existingByName = new Map(existing.map((s) => [s.name, s]));
  const wantedNames = new Set(staffEntries.map((s) => s.name));
  const now = new Date().toISOString();

  for (const { name, role } of staffEntries) {
    const current = existingByName.get(name);
    if (current) {
      if (current.role !== role) {
        await env.DB.prepare('UPDATE staff SET role = ?, updated_at = ? WHERE id = ?').bind(role, now, current.id).run();
      }
    } else {
      await env.DB.prepare(
        'INSERT INTO staff (name, slug, role, home_ministry_id, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(name, slugify(name), role, ministryId, now).run();
    }
  }

  // ON DELETE CASCADE removes their assignments elsewhere too — the real
  // bug fix over the old sweepAssignments() workaround, see schema.sql.
  for (const row of existing) {
    if (!wantedNames.has(row.name)) {
      await env.DB.prepare('DELETE FROM staff WHERE id = ?').bind(row.id).run();
    }
  }
}

export async function setAssignment(env, staffId, ministryId) {
  await env.DB.prepare('INSERT OR IGNORE INTO staff_assignments (staff_id, ministry_id) VALUES (?, ?)').bind(staffId, ministryId).run();
}

export async function removeAssignment(env, staffId, ministryId) {
  await env.DB.prepare('DELETE FROM staff_assignments WHERE staff_id = ? AND ministry_id = ?').bind(staffId, ministryId).run();
}
