// Builds /bigtime/maps — a hidden page (reachable at /bigtime/maps, same
// session auth as everything else under /bigtime/, not linked from the
// admin nav) showing the whole-world map followed by one zoomed-in map per
// division, each cropped to fully show that division's colored countries.
//
// On load this just displays the cached maps/*.png files — worker/lib/
// mapArchive.js keeps those current automatically on every ministry add/
// edit/delete (see worker/routes/ministries.js and ministry-detail.js), so
// there's normally no need to wait on a live capture at all. "Regenerate"
// still triggers a live Puppeteer capture via /bigtime/api/map-screenshot
// (worker/routes/map-screenshot.js), for a manual on-demand refresh; that
// route also re-saves its result to the same cache, so a manual regenerate
// keeps future page loads (and /bigtime/reports) up to date too.

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

// urlByKey: { world: "...", <divisionKey>: "...", ... } — a division
// missing from it (no countries currently mapped there) is just skipped.
async function renderAndWait(urlByKey) {
  const blocksHtml = [
    `<section class="map-block">
      <h2 class="map-title">World</h2>
      <img class="map-shot" src="${urlByKey.world}" alt="World map">
    </section>`,
    ...Object.entries(DIVISIONS)
      .filter(([key]) => urlByKey[key])
      .map(([key, def]) => `
    <section class="map-block">
      <h2 class="map-title" style="color:${def.pin};">${escapeHtml(def.label)}</h2>
      <img class="map-shot" src="${urlByKey[key]}" alt="${escapeHtml(def.label)} map">
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
}

// The filenames never change even when their content does, so a
// cache-busting query param is the only way to avoid the browser serving
// a stale copy across page loads.
function cachedMapUrls() {
  const cacheBust = Date.now();
  const urlByKey = { world: `../../maps/world.png?v=${cacheBust}` };
  for (const key of Object.keys(DIVISIONS)) urlByKey[key] = `../../maps/${key}.png?v=${cacheBust}`;
  return urlByKey;
}

async function loadCachedMaps() {
  overlay.hidden = false;
  regenerateBtn.hidden = true;
  output.classList.remove('ready');
  output.innerHTML = '';
  try {
    setStatus('Loading maps…');
    await renderAndWait(cachedMapUrls());
    overlay.hidden = true;
    regenerateBtn.hidden = false;
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  }
}

async function regenerateLive() {
  overlay.hidden = false;
  regenerateBtn.hidden = true;
  output.classList.remove('ready');
  output.innerHTML = '';
  try {
    setStatus('Capturing maps (this can take a little while)…');
    const res = await fetch('/bigtime/api/map-screenshot');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `Map screenshot failed (${res.status})`);
    }
    const { world, divisions } = await res.json();
    setStatus('Building page…');
    await renderAndWait({ world, ...divisions });
    overlay.hidden = true;
    regenerateBtn.hidden = false;
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  }
}

regenerateBtn.addEventListener('click', regenerateLive);
retryBtn.addEventListener('click', loadCachedMaps);

loadCachedMaps();
