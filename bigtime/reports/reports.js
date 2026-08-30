// Builds the /bigtime/reports PDF. Not linked from the admin nav yet —
// reachable at /bigtime/reports, behind the same session auth as
// everything else under /bigtime/ (see worker/index.js). Uses js/utils.js
// and js/config.js's globals (slugify, flagEmoji, initialsFor, CONFIG,
// DIVISIONS) the same way bigtime/admin.js does, loaded via plain <script>
// tags in index.html before this module runs.
//
// Generation starts automatically on load (no button to click first) —
// a loading overlay covers the page until it's done, then dismisses to
// reveal the report plus Regenerate/Print buttons. Printing is a
// separate, deliberate action (never automatic): the user reviews the
// on-screen report first, which doubles as a visual check that
// everything (especially images — see the load-wait below) actually
// came through before they commit to printing/saving a PDF.
//
// Pagination is plain CSS (break-before/break-inside in index.html's print
// styles) plus the browser's own native print-to-PDF, not a library —
// Paged.js was tried first for real page-by-page control (specifically to
// repeat a modified "Division (Continued)" header on a division's
// overflow pages, which plain CSS genuinely can't do), but its @page/
// string-set/@top-center handling proved unreliable in extensive testing
// (hangs and silently-empty output, not consistently reproducible by any
// single cause isolated). Dropped for a v1 that works reliably today;
// "Division (Continued)" isn't implemented as a result — the division
// name itself is still the section heading, it just won't repeat on
// pages the browser's own pagination wraps a division onto.

// Matches the public map's own <h1> text exactly (index.html's
// #site-title) — repeated here as the map's caption and again before
// each division name, per request.
const REPORT_TITLE = 'Young Life University International Ministries';

const regenerateBtn = document.getElementById('regenerate-btn');
const printBtn = document.getElementById('print-btn');
const output = document.getElementById('report-output');
const overlay = document.getElementById('loading-overlay');
const loadingSpinner = document.getElementById('loading-spinner');
const loadingText = document.getElementById('loading-text');
const retryBtn = document.getElementById('retry-btn');

function setStatus(text, isError = false) {
  loadingText.textContent = text;
  loadingText.classList.toggle('error', isError);
  loadingSpinner.hidden = isError;
  retryBtn.hidden = !isError;
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchCsvDirect(url) {
  const res = await fetch(url);
  const text = await res.text();
  return Papa.parse(text, { header: true, skipEmptyLines: true }).data;
}

// Same shape as bigtime/admin.js's loadDivisionsDirect.
async function loadDivisionByCountry() {
  const rows = await fetchCsvDirect('../../data/country-divisions.csv');
  const map = new Map();
  for (const row of rows) {
    const country = (row.country || '').trim();
    const division = (row.division || '').trim();
    if (country && division) map.set(country, division);
  }
  return map;
}

// Same shape as js/app.js's countryIsoByName, built the same way (from the
// public map's own country boundary file) since that's the only place
// ISO codes exist in this project.
async function loadCountryIsoByName() {
  const res = await fetch('../../data/world-countries.geojson');
  const geo = await res.json();
  const map = new Map();
  for (const feature of geo.features) {
    const name = (feature.properties.name || '').trim();
    const iso2 = feature.properties['ISO3166-1-Alpha-2'];
    if (name && iso2) map.set(name, iso2);
  }
  return map;
}

async function loadMinistryRows() {
  const res = await fetch('/bigtime/api/ministries');
  if (!res.ok) throw new Error(`Could not load ministries (${res.status})`);
  const data = await res.json();
  return data.rows;
}

// Staff photos aren't referenced by filename in the CSV (unlike ministry
// photos, which store their exact filename) — same extension-guessing
// HEAD-request pattern as bigtime/admin.js's findExistingImageUrl.
async function findStaffPhotoUrl(name) {
  const slug = slugify(name);
  for (const ext of CONFIG.IMAGE_EXTENSIONS) {
    const url = `../../${CONFIG.IMAGES_DIR}${slug}.${ext}`;
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (res.ok) return url;
    } catch {
      // try the next extension
    }
  }
  return null;
}

async function buildMinistryAreaHtml(row, countryIsoByName, def) {
  const iso2 = countryIsoByName.get(row.country.trim());
  const flag = flagEmoji(iso2);
  const name = row.city === row.country ? row.city : `${row.city}, ${row.country}`;

  // No placeholder box when a ministry area has no photo — the blurb/staff/
  // universities column just takes the full width instead (see the
  // .ministry-area.no-photo grid override in index.html).
  const mainPhoto = row.photos[0]
    ? `<img class="ministry-area-photo" src="../../${CONFIG.IMAGES_DIR}${encodeURIComponent(row.photos[0])}" alt="">`
    : '';

  const staffUrls = await Promise.all(row.staff.map((s) => findStaffPhotoUrl(s.name)));
  const staffHtml = row.staff.map((s, i) => {
    const photo = staffUrls[i]
      ? `<img class="ministry-staff-photo" src="${staffUrls[i]}" alt="">`
      : `<div class="ministry-staff-photo-fallback" style="background:${def.country};">${escapeHtml(initialsFor(s.name))}</div>`;
    return `
      <div class="ministry-staff-item">
        ${photo}
        <div class="ministry-staff-name">${escapeHtml(s.name)}</div>
        <div class="ministry-staff-role">${escapeHtml(s.role || '')}</div>
      </div>`;
  }).join('');

  const universitiesText = row.universities
    .map((u) => (u.year ? `${u.name} (${u.year})` : u.name))
    .join(', ');
  const universitiesHtml = universitiesText
    ? `<div class="ministry-universities"><span class="ministry-universities-label">Universities: </span>${escapeHtml(universitiesText)}</div>`
    : '';

  return `
    <div class="ministry-area${row.photos[0] ? '' : ' no-photo'}">
      <h3 class="ministry-area-title">${flag ? `${flag} ` : ''}${escapeHtml(name)}</h3>
      ${mainPhoto}
      <div>
        ${row.blurb ? `<p class="ministry-area-blurb">${escapeHtml(row.blurb)}</p>` : ''}
        ${row.staff.length ? `<div class="ministry-staff">${staffHtml}</div>` : ''}
        ${universitiesHtml}
      </div>
    </div>`;
}

function computeMetrics(rowsSubset) {
  const countries = new Set(rowsSubset.map((r) => r.country.trim()).filter(Boolean));
  return [
    { label: 'Countries', num: countries.size },
    { label: 'Ministry Areas', num: rowsSubset.length },
    { label: 'Staff', num: rowsSubset.reduce((sum, r) => sum + r.staff.length, 0) },
    { label: 'Universities', num: rowsSubset.reduce((sum, r) => sum + r.universities.length, 0) },
  ];
}

// Boxed, Google-Analytics-style metric cards — label on top, the number
// large underneath. `accent` (a division's pin/country colors) is only
// passed for the per-division repeats; the page-1 totals stay neutral
// since they aren't tied to any one division.
function metricBoxesHtml(metrics, accent) {
  const boxStyle = accent ? ` style="border-color:${accent.pin};"` : '';
  const textStyle = accent ? ` style="color:${accent.pin};"` : '';
  return `<div class="report-metrics">${metrics.map(({ label, num }) => `
    <div class="report-metric"${boxStyle}>
      <div class="report-metric-label"${textStyle}>${escapeHtml(label)}</div>
      <div class="report-metric-num"${textStyle}>${num}</div>
    </div>`).join('')}</div>`;
}

async function buildReportHtml(rows, divisionByCountry, countryIsoByName, mapShots) {
  const generatedLabel = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const metricsPage = `
    <section class="report-page-one">
      <h2 class="report-map-title">${escapeHtml(REPORT_TITLE)}</h2>
      <div class="report-generated-date">${escapeHtml(generatedLabel)}</div>
      <img class="report-map-shot" src="${mapShots.world}" alt="Map of ministry locations">
      ${metricBoxesHtml(computeMetrics(rows))}
    </section>`;

  // division key -> [rows]. Divisions render in js/config.js's DIVISIONS
  // insertion order (also the public map's legend order) rather than
  // being re-sorted themselves — only countries and ministry areas within
  // a division are alphabetized.
  const byDivision = new Map();
  for (const row of rows) {
    const divisionKey = divisionByCountry.get(row.country.trim());
    // Same "country not in country-divisions.csv" case bigtime/admin.js
    // already surfaces elsewhere — silently excluded here rather than a
    // second warning system for a report that already isn't the source of
    // truth for that problem.
    if (!divisionKey) continue;
    if (!byDivision.has(divisionKey)) byDivision.set(divisionKey, []);
    byDivision.get(divisionKey).push(row);
  }

  const divisionSectionsHtml = [];
  for (const [key, def] of Object.entries(DIVISIONS)) {
    const divisionRows = byDivision.get(key);
    if (!divisionRows || !divisionRows.length) continue;
    divisionRows.sort((a, b) => a.country.localeCompare(b.country) || a.city.localeCompare(b.city));
    const areasHtml = (await Promise.all(divisionRows.map((row) => buildMinistryAreaHtml(row, countryIsoByName, def)))).join('');
    const divisionMapShot = mapShots.divisions[key];
    const divisionMapHtml = divisionMapShot
      ? `<img class="division-map-shot" src="${divisionMapShot}" alt="${escapeHtml(def.label)} map">`
      : '';
    divisionSectionsHtml.push(`
      <section class="division-section">
        <h2 class="division-title" style="color:${def.pin};border-bottom-color:${def.pin};"><span class="division-title-report-name">${escapeHtml(REPORT_TITLE)} — ${escapeHtml(generatedLabel)}</span><span class="division-title-division-name">${escapeHtml(def.label)}</span></h2>
        ${divisionMapHtml}
        ${metricBoxesHtml(computeMetrics(divisionRows), def)}
        <div class="division-areas">${areasHtml}</div>
      </section>`);
  }

  return metricsPage + divisionSectionsHtml.join('');
}

async function generateReport() {
  overlay.hidden = false;
  regenerateBtn.hidden = true;
  printBtn.hidden = true;
  output.classList.remove('ready');
  output.innerHTML = '';
  setStatus('Loading ministry data…');
  try {
    const [rows, divisionByCountry, countryIsoByName] = await Promise.all([
      loadMinistryRows(),
      loadDivisionByCountry(),
      loadCountryIsoByName(),
    ]);

    // Cached PNGs, not a live capture — worker/lib/mapArchive.js keeps
    // maps/*.png current automatically whenever a ministry area is added,
    // edited, or removed, so the report never has to wait on a fresh
    // Puppeteer capture just to load. The filename never changes even when
    // the file's content does, so a cache-busting query param is the only
    // way to avoid the browser serving a stale copy across page loads.
    const cacheBust = Date.now();
    const mapShots = {
      world: `../../maps/world.png?v=${cacheBust}`,
      divisions: Object.fromEntries(Object.keys(DIVISIONS).map((key) => [key, `../../maps/${key}.png?v=${cacheBust}`])),
    };

    setStatus('Building report…');
    output.innerHTML = await buildReportHtml(rows, divisionByCountry, countryIsoByName, mapShots);
    output.classList.add('ready');

    // Chrome/Safari's print-to-PDF dialog suggests document.title as the
    // save filename — appending today's date here means "Save as PDF"
    // defaults to a dated filename without the user having to rename it.
    const fileDateStr = new Date().toISOString().slice(0, 10);
    document.title = `Ministry Report ${fileDateStr}`;

    // Waiting for the overlay to dismiss is also a real visual check, not
    // just a delay — see the buildReportHtml photos: dynamically-inserted
    // <img>s that haven't finished loading yet render as nothing at all
    // (alt="" suppresses even the broken-image icon), so without this the
    // report would visibly *look* done (overlay gone) while still missing
    // most of its images, the same way it silently did in the printed PDF
    // before this wait existed.
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
    printBtn.hidden = false;
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  }
}

regenerateBtn.addEventListener('click', generateReport);
retryBtn.addEventListener('click', generateReport);
printBtn.addEventListener('click', () => window.print());

generateReport();
