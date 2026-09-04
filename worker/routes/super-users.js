// Routes /superbigtime/api/users — list/create (GET/POST) and
// update/delete a specific user (PUT/DELETE .../:id). Thin wrappers over
// worker/lib/db/users.js; gated by the superbigtime session, checked in
// worker/index.js before these are ever dispatched (same pattern as
// /bigtime/* and the site gate).

import { errorResponse, jsonResponse } from '../lib/http.js';
import { listUsers, createUser, updateUser, deleteUser } from '../lib/db/users.js';

function validateFields(body, { requirePassword }) {
  if (!body.name || !String(body.name).trim()) return 'Name is required';
  if (!body.login || !String(body.login).trim()) return 'Login is required';
  if (requirePassword && !body.password) return 'Password is required';
  return null;
}

export async function onRequestGet({ env }) {
  return jsonResponse({ rows: await listUsers(env) });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const error = validateFields(body, { requirePassword: true });
  if (error) return errorResponse(400, error, { error: 'validation' });

  try {
    const user = await createUser(env, { name: body.name.trim(), login: body.login.trim(), password: body.password });
    return jsonResponse({ ok: true, row: user });
  } catch (err) {
    // D1's UNIQUE constraint on admin_users.login — the only realistic way
    // this insert fails given the validation above already passed.
    if (String(err.message || '').includes('UNIQUE')) {
      return errorResponse(409, 'That login is already in use', { error: 'conflict' });
    }
    throw err;
  }
}

export async function onRequestPut({ request, env, params }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const error = validateFields(body, { requirePassword: false });
  if (error) return errorResponse(400, error, { error: 'validation' });

  try {
    const user = await updateUser(env, Number(params.id), { name: body.name.trim(), login: body.login.trim(), password: body.password || null });
    if (!user) return errorResponse(404, 'No user with that id');
    return jsonResponse({ ok: true, row: user });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return errorResponse(409, 'That login is already in use', { error: 'conflict' });
    }
    throw err;
  }
}

export async function onRequestDelete({ env, params }) {
  await deleteUser(env, Number(params.id));
  return jsonResponse({ ok: true });
}
