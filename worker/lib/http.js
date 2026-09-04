// Small response helpers shared by every worker/routes/*.js route.

export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

export function errorResponse(status, message, extra = {}) {
  return jsonResponse({ error: extra.error || 'error', message, ...extra }, { status });
}
