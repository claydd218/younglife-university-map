// admin_users queries — per-user admin accounts (scripts/schema-users.sql),
// created/managed only through superbigtime (worker/routes/super-users.js).
// Login itself (worker/routes/login.js) uses only verifyLogin below.

import { hashPassword, verifyPassword } from '../password.js';

function toShape(row) {
  return { id: row.id, name: row.name, login: row.login, created_at: row.created_at, last_login_at: row.last_login_at };
}

// Never includes password_hash — superbigtime's user list has no reason to
// see it, even hashed.
export async function listUsers(env) {
  const { results } = await env.DB.prepare('SELECT * FROM admin_users ORDER BY name').all();
  return results.map(toShape);
}

export async function createUser(env, { name, login, password }) {
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    'INSERT INTO admin_users (name, login, password_hash, created_at) VALUES (?, ?, ?, ?)'
  ).bind(name, login, passwordHash, now).run();
  return toShape({ id: result.meta.last_row_id, name, login, created_at: now, last_login_at: null });
}

// `password` optional — omitted (or empty) leaves the existing hash alone,
// so an edit that only changes the display name doesn't force a reset.
export async function updateUser(env, id, { name, login, password }) {
  if (password) {
    const passwordHash = await hashPassword(password);
    await env.DB.prepare('UPDATE admin_users SET name = ?, login = ?, password_hash = ? WHERE id = ?')
      .bind(name, login, passwordHash, id).run();
  } else {
    await env.DB.prepare('UPDATE admin_users SET name = ?, login = ? WHERE id = ?')
      .bind(name, login, id).run();
  }
  const row = await env.DB.prepare('SELECT * FROM admin_users WHERE id = ?').bind(id).first();
  return row ? toShape(row) : null;
}

export async function deleteUser(env, id) {
  await env.DB.prepare('DELETE FROM admin_users WHERE id = ?').bind(id).run();
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
