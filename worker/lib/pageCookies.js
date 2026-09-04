// Forwards the incoming request's Cookie header into a Puppeteer page's
// actual cookie jar (page.setCookie), for the internal navigations in
// mapScreenshot.js/reportCapture.js that need to carry the caller's own
// session into an auth-gated page (the site-wide gate, or /bigtime/report)
// without a second login step.
//
// Deliberately NOT page.setExtraHTTPHeaders({ Cookie: ... }) — that
// attaches the raw header to EVERY request the page makes, regardless of
// origin, unlike a real browser's cookie jar (which only ever sends a
// cookie to requests matching its own domain). Both the public map and
// the admin report page load Google Fonts (fonts.googleapis.com,
// fonts.gstatic.com) — confirmed live that setExtraHTTPHeaders was
// sending the caller's session cookie value to Google on every single
// report/screenshot generation, an unnecessary third-party exposure of a
// live auth token. setCookie is properly domain-scoped instead, so it's
// only ever sent to requests matching the cookie's own domain.
export async function forwardCookiesToPage(page, request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  if (!cookieHeader) return;
  const domain = new URL(request.url).hostname;
  const cookies = cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return null;
      return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain, path: '/' };
    })
    .filter(Boolean);
  if (cookies.length) await page.setCookie(...cookies);
}
