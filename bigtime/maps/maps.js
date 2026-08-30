// Builds /bigtime/maps — a hidden page (reachable at /bigtime/maps, same
// session auth as everything else under /bigtime/, not linked from the
// admin nav) showing the whole-world map followed by one zoomed-in map per
// division, each cropped to fully show that division's colored countries.
// The actual framing/cropping happens server-side in
// worker/routes/map-screenshot.js (via js/app.js's window.__divisionBounds
// helper); this file just fetches the resulting bundle and lays it out.
//
// One fetch, not one per view — map-screenshot.js captures everything from
// a single browser/page session. An earlier version fetched each view
// separately (one browser launch per division, six total), which hit
// Cloudflare Browser Rendering's new-browser-creation rate limit
// ("Unable to create new browser: 429").
//
// Generation starts automatically on load, same pattern as
// bigtime/reports — a loading overlay covers the page until every image
// has loaded, then dismisses.

const output = document.getElementById('maps-output');
const overlay = document.getElementById('loading-overlay');
const loadingSpinner = document.getElementById('loading-spinner');
const loadingText = document.getElementById('loading-text');
const retryBtn = document.getElementById('retry-btn');
const regenerateBtn = document.getElementById('regenerate-btn');

function setStatus(text, isError = false) {
  loadingText.textContent = text;
  loadingText.classList.toggle('error', isError);
  loadingSpinner.hidden = isError;
  retryBtn.hidden = !isError;
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchMapShots() {
  const res = await fetch('/bigtime/api/map-screenshot');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Map screenshot failed (${res.status})`);
  }
  return res.json();
}

async function generateMaps() {
  overlay.hidden = false;
  regenerateBtn.hidden = true;
  output.classList.remove('ready');
  output.innerHTML = '';
  try {
    setStatus('Capturing maps (this can take a little while)…');
    const { world, divisions } = await fetchMapShots();

    setStatus('Building page…');
    const blocksHtml = [
      `<section class="map-block">
        <h2 class="map-title">World</h2>
        <img class="map-shot" src="${world}" alt="World map">
      </section>`,
      ...Object.entries(DIVISIONS)
        .filter(([key]) => divisions[key])
        .map(([key, def]) => `
      <section class="map-block">
        <h2 class="map-title" style="color:${def.pin};">${escapeHtml(def.label)}</h2>
        <img class="map-shot" src="${divisions[key]}" alt="${escapeHtml(def.label)} map">
      </section>`),
    ];
    output.innerHTML = blocksHtml.join('');
    output.classList.add('ready');

    setStatus('Waiting for images to load…');
    const images = output.querySelectorAll('img');
    await Promise.all(Array.from(images).map((img) => (
      img.complete ? Promise.resolve() : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })
    )));

    overlay.hidden = true;
    regenerateBtn.hidden = false;
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  }
}

regenerateBtn.addEventListener('click', generateMaps);
retryBtn.addEventListener('click', generateMaps);

generateMaps();
