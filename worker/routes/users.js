// Routes /bigtime/api/users — list/create (GET/POST) and update/delete a
// specific user (PUT/DELETE .../:id). The in-app replacement for
// superbigtime: any /bigtime/ session already proves who's asking
// (`context.user`, threaded in by worker/index.js), so this only needs an
// is_admin check rather than a whole separate password gate.

import { errorResponse, jsonResponse } from '../lib/http.js';
import { listUsers, createUser, updateUser, deleteUser, LastAdminError } from '../lib/db/users.js';

function requireAdmin(user) {
  if (!user || !user.is_admin) return errorResponse(403, 'Admin access required');
  return null;
}

function validateFields(body, { requirePassword }) {
  if (!body.name || !String(body.name).trim()) return 'Name is required';
  if (!body.login || !String(body.login).trim()) return 'Login is required';
  if (requirePassword && !body.password) return 'Password is required';
  return null;
}

export async function onRequestGet({ env, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;
  return jsonResponse({ rows: await listUsers(env) });
}

export async function onRequestPost({ request, env, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const error = validateFields(body, { requirePassword: true });
  if (error) return errorResponse(400, error, { error: 'validation' });

  try {
    const created = await createUser(env, { name: body.name.trim(), login: body.login.trim(), password: body.password, isAdmin: !!body.is_admin });
    return jsonResponse({ ok: true, row: created });
  } catch (err) {
    // D1's UNIQUE constraint on admin_users.login — the only realistic way
    // this insert fails given the validation above already passed.
    if (String(err.message || '').includes('UNIQUE')) {
      return errorResponse(409, 'That login is already in use', { error: 'conflict' });
    }
    throw err;
  }
}

export async function onRequestPut({ request, env, params, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const error = validateFields(body, { requirePassword: false });
  if (error) return errorResponse(400, error, { error: 'validation' });

  try {
    const updated = await updateUser(env, Number(params.id), {
      name: body.name.trim(),
      login: body.login.trim(),
      password: body.password || null,
      isAdmin: !!body.is_admin,
    });
    if (!updated) return errorResponse(404, 'No user with that id');
    return jsonResponse({ ok: true, row: updated });
  } catch (err) {
    if (err instanceof LastAdminError) return errorResponse(409, err.message, { error: 'last-admin' });
    if (String(err.message || '').includes('UNIQUE')) {
      return errorResponse(409, 'That login is already in use', { error: 'conflict' });
    }
    throw err;
  }
}

export async function onRequestDelete({ env, params, user }) {
  const denied = requireAdmin(user);
  if (denied) return denied;

  try {
    await deleteUser(env, Number(params.id));
    return jsonResponse({ ok: true });
  } catch (err) {
    if (err instanceof LastAdminError) return errorResponse(409, err.message, { error: 'last-admin' });
    throw err;
  }
}
