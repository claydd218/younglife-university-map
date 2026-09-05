// Staff/staff_assignments queries — the D1-backed replacement for the
// name-matching-across-CSV-columns scheme bigtime/admin.js's
// findStaffHome()/confirmMoveStaff()/sweepAssignments() used to implement
// by hand. Those client-side functions are unchanged (see
// worker/lib/db/ministries.js's own comment on why the JSON contract is
// preserved) — this module is what the *server* now does instead of a
// client-side scan across every ministry row.

import { slugify } from '../text.js';
import { deletePhotosBySlug } from '../photoCleanup.js';

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

// Diffs `staffEntries` ([{id?, name, role}], the ministry form's current
// Staff section) against this ministry's existing home staff rows, by
// `id` when the entry has one (an existing row the form loaded, possibly
// renamed) — matching by name instead would treat every rename as
// "the old person was deleted, a brand-new person was added", which
// silently loses their stable id *and* cascade-deletes their
// staff_assignments elsewhere (confirmed live: renaming someone with an
// active assignment made it vanish). A entry with no `id` is a genuinely
// new row added in this same edit, always inserted.
export async function upsertHomeStaff(env, ministryId, staffEntries) {
  const existing = await staffRowsForMinistry(env, ministryId);
  const existingById = new Map(existing.map((s) => [s.id, s]));
  const wantedIds = new Set(staffEntries.filter((s) => s.id != null).map((s) => Number(s.id)));
  const now = new Date().toISOString();

  for (const { id, name, role } of staffEntries) {
    const current = id != null ? existingById.get(Number(id)) : null;
    if (current) {
      if (current.name !== name || current.role !== role) {
        // Re-slugified on every save, not just when the name changes —
        // cheap, and guarantees it can never drift from the name even if
        // some future path updates one without the other.
        await env.DB.prepare('UPDATE staff SET name = ?, slug = ?, role = ?, updated_at = ? WHERE id = ?')
          .bind(name, slugify(name), role, now, current.id).run();
      }
    } else {
      await env.DB.prepare(
        'INSERT INTO staff (name, slug, role, home_ministry_id, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(name, slugify(name), role, ministryId, now).run();
    }
  }

  // ON DELETE CASCADE removes their assignments elsewhere too — the real
  // bug fix over the old sweepAssignments() workaround, see schema.sql.
  // Their photo is a separate cleanup, since R2 has no equivalent of a
  // foreign-key cascade — confirmed live as a real gap: a removed
  // staffer's photo used to just sit there in R2 forever.
  for (const row of existing) {
    if (!wantedIds.has(row.id)) {
      await env.DB.prepare('DELETE FROM staff WHERE id = ?').bind(row.id).run();
      await deletePhotosBySlug(env, row.slug);
    }
  }
}

// Atomically re-homes a staffer to a different ministry, preserving their
// id (and thus their staff_assignments) — the fix for "Move to Ministry"
// used to PUT the whole target ministry with a brand-new {name, role}
// entry (no id), which upsertHomeStaff always treats as an insert. That
// left a duplicate row at the target and a dangling orphaned row (and its
// assignments) at the source, cleaned up only if/when the source ministry
// happened to be saved again — same bug class as the rename corruption
// upsertHomeStaff's own comment describes.
export async function moveStaffHome(env, staffId, newMinistryId) {
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE staff SET home_ministry_id = ?, updated_at = ? WHERE id = ?')
    .bind(newMinistryId, now, staffId).run();
}

export async function setAssignment(env, staffId, ministryId) {
  await env.DB.prepare('INSERT OR IGNORE INTO staff_assignments (staff_id, ministry_id) VALUES (?, ?)').bind(staffId, ministryId).run();
}

export async function removeAssignment(env, staffId, ministryId) {
  await env.DB.prepare('DELETE FROM staff_assignments WHERE staff_id = ? AND ministry_id = ?').bind(staffId, ministryId).run();
}
