// superbigtime — manage the per-user admin_users accounts that log into
// /bigtime/. Talks only to /superbigtime/api/users (JSON in/out).

const API_BASE = '/superbigtime/api';

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body — fine for some responses
  }
  if (!res.ok) {
    throw new ApiError((body && body.message) || `Request failed (${res.status})`, res.status, body);
  }
  return body;
}

function showBanner(kind, message) {
  const el = $('banner');
  el.className = `banner ${kind}`;
  el.textContent = message;
  el.hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

function showDialogBanner(message) {
  const el = $('dialog-banner');
  el.textContent = message;
  el.hidden = false;
}

function hideDialogBanner() {
  $('dialog-banner').hidden = true;
}

const state = { rows: [] };

function formatDate(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function renderUsers() {
  $('users-count').textContent = `${state.rows.length} user${state.rows.length === 1 ? '' : 's'}`;
  const tbody = $('users-tbody');
  if (!state.rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="status-text">No users yet — add the first one.</td></tr>';
    return;
  }
  tbody.innerHTML = state.rows.map((u) => `
    <tr data-id="${escapeHtml(u.id)}">
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.login)}</td>
      <td>${escapeHtml(formatDate(u.last_login_at))}</td>
      <td class="actions">
        <button type="button" class="btn secondary btn-small" data-action="edit">Edit</button>
        <button type="button" class="btn danger btn-small" data-action="delete">Delete</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = Number(tr.dataset.id);
    const user = state.rows.find((u) => u.id === id);
    tr.querySelector('[data-action="edit"]').addEventListener('click', () => openUserDialog(user));
    tr.querySelector('[data-action="delete"]').addEventListener('click', () => deleteUser(user));
  });
}

async function loadUsers() {
  try {
    const result = await apiFetch('/users');
    state.rows = result.rows;
    renderUsers();
  } catch (err) {
    showBanner('error', err.message || String(err));
  }
}

let editingId = null;

function openUserDialog(user) {
  hideDialogBanner();
  editingId = user ? user.id : null;
  $('dialog-title').textContent = user ? 'Edit User' : 'Add User';
  $('field-name').value = user ? user.name : '';
  $('field-login').value = user ? user.login : '';
  $('field-password').value = '';
  $('password-hint').textContent = user ? 'Leave blank to keep the current password.' : '';
  $('user-dialog').showModal();
  $('field-name').focus();
}

function closeUserDialog() {
  $('user-dialog').close();
  editingId = null;
}

async function saveUser(e) {
  e.preventDefault();
  hideDialogBanner();
  const name = $('field-name').value.trim();
  const login = $('field-login').value.trim();
  const password = $('field-password').value;

  if (!name || !login) {
    showDialogBanner('Name and login are required.');
    return;
  }
  if (!editingId && !password) {
    showDialogBanner('Password is required for a new user.');
    return;
  }

  const body = { name, login };
  if (password) body.password = password;

  try {
    if (editingId) {
      await apiFetch(`/users/${encodeURIComponent(editingId)}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await apiFetch('/users', { method: 'POST', body: JSON.stringify(body) });
    }
    closeUserDialog();
    hideBanner();
    await loadUsers();
  } catch (err) {
    showDialogBanner(err.message || String(err));
  }
}

async function deleteUser(user) {
  if (!window.confirm(`Delete ${user.name} (${user.login})? They'll be signed out immediately and can no longer log into /bigtime/.`)) return;
  try {
    await apiFetch(`/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    await loadUsers();
  } catch (err) {
    showBanner('error', err.message || String(err));
  }
}

function wireDialog() {
  $('add-user-btn').addEventListener('click', () => openUserDialog(null));
  $('dialog-cancel-btn').addEventListener('click', closeUserDialog);
  $('user-form').addEventListener('submit', saveUser);
}

function wireSignOut() {
  $('sign-out-btn').addEventListener('click', async () => {
    if (!window.confirm('Sign out?')) return;
    try {
      await fetch(`${API_BASE}/logout`, { method: 'POST' });
    } catch {
      // Nothing more useful to do client-side with a failed request here.
    }
    window.location.href = 'login.html';
  });
}

wireDialog();
wireSignOut();
loadUsers();
