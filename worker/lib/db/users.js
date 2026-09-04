// admin_users queries — per-user admin accounts (scripts/schema-users.sql,
// scripts/schema-admin-flag.sql), managed through /bigtime/'s own Admin
// tab (worker/routes/users.js) by anyone with is_admin — replaces the
// separate superbigtime shared-password area. Login itself
// (worker/routes/login.js) uses only verifyLogin below.

import { hashPassword, verifyPassword } from '../password.js';

// Thrown by updateUser/deleteUser when the change would leave zero
// admins — with superbigtime gone, there's no password-based fallback
// left to recover user management if that ever happened, so it's
// refused outright rather than left as a footgun.
export class LastAdminError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LastAdminError';
  }
}

function toShape(row) {
  return { id: row.id, name: row.name, login: row.login, is_admin: !!row.is_admin, created_at: row.created_at, last_login_at: row.last_login_at };
}

// Never includes password_hash — the Admin tab's user list has no reason
// to see it, even hashed.
export async function listUsers(env) {
  const { results } = await env.DB.prepare('SELECT * FROM admin_users ORDER BY name').all();
  return results.map(toShape);
}

export async function createUser(env, { name, login, password, isAdmin }) {
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    'INSERT INTO admin_users (name, login, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(name, login, passwordHash, isAdmin ? 1 : 0, now).run();
  return toShape({ id: result.meta.last_row_id, name, login, is_admin: isAdmin ? 1 : 0, created_at: now, last_login_at: null });
}

// `password` optional — omitted (or empty) leaves the existing hash alone,
// so an edit that only changes the display name doesn't force a reset.
//
// The last-admin guard is baked into the UPDATE's own WHERE clause (a
// correlated COUNT subquery), not a separate SELECT-then-write — D1 runs
// a single prepared statement as one atomic step, so this closes a real
// race a "check count, then write" pair left open: two concurrent
// demotions of the last two admins could each see count=2 in their own
// check and both proceed, leaving zero. A single conditional statement
// can't be interleaved like that.
export async function updateUser(env, id, { name, login, password, isAdmin }) {
  const isAdminInt = isAdmin ? 1 : 0;
  const guard = '(? = 1 OR is_admin = 0 OR (SELECT COUNT(*) FROM admin_users WHERE is_admin = 1) > 1)';
  const passwordHash = password ? await hashPassword(password) : null;
  const result = passwordHash
    ? await env.DB.prepare(`UPDATE admin_users SET name = ?, login = ?, password_hash = ?, is_admin = ? WHERE id = ? AND ${guard}`)
        .bind(name, login, passwordHash, isAdminInt, id, isAdminInt).run()
    : await env.DB.prepare(`UPDATE admin_users SET name = ?, login = ?, is_admin = ? WHERE id = ? AND ${guard}`)
        .bind(name, login, isAdminInt, id, isAdminInt).run();

  if (result.meta.changes === 0) {
    // Ambiguous on its own (blocked by the guard, or id doesn't exist) —
    // a cheap follow-up read tells them apart for the right error.
    const stillExists = await env.DB.prepare('SELECT 1 FROM admin_users WHERE id = ?').bind(id).first();
    if (stillExists) throw new LastAdminError('This is the last remaining admin — promote someone else first.');
    return null;
  }
  const row = await env.DB.prepare('SELECT * FROM admin_users WHERE id = ?').bind(id).first();
  return row ? toShape(row) : null;
}

export async function deleteUser(env, id) {
  const result = await env.DB.prepare(
    'DELETE FROM admin_users WHERE id = ? AND (is_admin = 0 OR (SELECT COUNT(*) FROM admin_users WHERE is_admin = 1) > 1)'
  ).bind(id).run();

  if (result.meta.changes === 0) {
    const stillExists = await env.DB.prepare('SELECT 1 FROM admin_users WHERE id = ?').bind(id).first();
    if (stillExists) throw new LastAdminError('This is the last remaining admin — promote someone else before removing this account.');
  }
}

// -> {id, name} on success, null on any failure (unknown login OR wrong
// password) — deliberately the same outcome for both, same reasoning as
// the old shared-password checkPassword: never reveal which one was wrong.
export async function verifyLogin(env, login, password) {
  const row = await env.DB.prepare('SELECT * FROM admin_users WHERE login = ?').bind(login).first();
  if (!row) {
    // Still runs a full PBKDF2 derivation against a dummy stored value so
    // a nonexistent login doesn't respond measurably faster than a wrong
    // password for a real one.
    await verifyPassword(password, null);
    return null;
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;
  await env.DB.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').bind(new Date().toISOString(), row.id).run();
  return { id: row.id, name: row.name };
}
