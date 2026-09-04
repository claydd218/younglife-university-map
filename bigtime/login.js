const params = new URLSearchParams(location.search);
if (params.has('error')) {
  const errorEl = document.getElementById('error');
  // worker/routes/login.js sends error=locked specifically (not the
  // generic error=1 a wrong password/captcha gets) so this can tell the
  // legitimate admin they're waiting out the rate-limit timer, not still
  // getting the password wrong — the HTML's own default text covers
  // every other case.
  if (params.get('error') === 'locked') {
    errorEl.textContent = 'Too many failed attempts — try again in a few minutes.';
  }
  // Reachable if a POST hit the login API directly (bookmarked/cached
  // form) while the maintenance notice above has the form hidden — same
  // message either way, not a real error worth alarming over.
  if (params.get('error') === 'maintenance') {
    errorEl.textContent = 'The admin tool is temporarily closed for maintenance.';
  }
  errorEl.hidden = false;
}
