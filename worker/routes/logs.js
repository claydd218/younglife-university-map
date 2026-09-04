// Routes GET /bigtime/api/logs?before=<id>&limit=50 — reads ministry_edits
// (the lightweight audit table added with the original D1 migration)
// newest-first, paginated. City/country for each row's label come out of
// old_json/new_json directly rather than a join against ministries, since
// a deleted ministry's own row is gone by the time its log entry is read.

import { jsonResponse } from '../lib/http.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function cityCountry(row) {
  const source = row.new_json || row.old_json;
  if (!source) return { city: null, country: null };
  try {
    const parsed = JSON.parse(source);
    return { city: parsed.city || null, country: parsed.country || null };
  } catch {
    return { city: null, country: null };
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const before = url.searchParams.get('before');
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || DEFAULT_LIMIT));

  const query = before
    ? env.DB.prepare('SELECT * FROM ministry_edits WHERE id < ? ORDER BY id DESC LIMIT ?').bind(Number(before), limit)
    : env.DB.prepare('SELECT * FROM ministry_edits ORDER BY id DESC LIMIT ?').bind(limit);
  const { results } = await query.all();

  const rows = results.map((row) => ({
    id: row.id,
    ministry_id: row.ministry_id,
    changed_at: row.changed_at,
    action: row.action,
    user_name: row.user_name,
    ...cityCountry(row),
  }));

  return jsonResponse({ rows, nextBefore: rows.length === limit ? rows[rows.length - 1].id : null });
}
