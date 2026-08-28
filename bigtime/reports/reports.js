// Builds the /bigtime/reports PDF. Not linked from the admin nav yet —
// reachable at /bigtime/reports, behind the same session auth as
// everything else under /bigtime/ (see worker/index.js). Uses js/utils.js
// and js/config.js's globals (slugify, flagEmoji, initialsFor, CONFIG,
// DIVISIONS) the same way bigtime/admin.js does, loaded via plain <script>
// tags in index.html before this module runs.
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

const statusEl = document.getElementById('status');
const btn = document.getElementById('generate-btn');
const output = document.getElementById('report-output');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
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

async function buildMinistryAreaHtml(row, countryIsoByName) {
  const iso2 = countryIsoByName.get(row.country.trim());
  const flag = flagEmoji(iso2);
  const name = row.city === row.country ? row.city : `${row.city}, ${row.country}`;

  const mainPhoto = row.photos[0]
    ? `<img class="ministry-area-photo" src="../../${CONFIG.IMAGES_DIR}${encodeURIComponent(row.photos[0])}" alt="">`
    : '<div class="ministry-area-photo-empty">No photo</div>';

  const staffUrls = await Promise.all(row.staff.map((s) => findStaffPhotoUrl(s.name)));
  const staffHtml = row.staff.map((s, i) => {
    const photo = staffUrls[i]
      ? `<img class="ministry-staff-photo" src="${staffUrls[i]}" alt="">`
      : `<div class="ministry-staff-photo-fallback">${escapeHtml(initialsFor(s.name))}</div>`;
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
    <div class="ministry-area">
      <h3 class="ministry-area-title">${flag ? `${flag} ` : ''}${escapeHtml(name)}</h3>
      ${mainPhoto}
      <div>
        ${row.blurb ? `<p class="ministry-area-blurb">${escapeHtml(row.blurb)}</p>` : ''}
        ${row.staff.length ? `<div class="ministry-staff">${staffHtml}</div>` : ''}
        ${universitiesHtml}
      </div>
    </div>`;
}

async function buildReportHtml(rows, divisionByCountry, countryIsoByName, mapShotUrl) {
  const countries = new Set(rows.map((r) => r.country.trim()).filter(Boolean));
  const staffCount = rows.reduce((sum, r) => sum + r.staff.length, 0);
  const universityCount = rows.reduce((sum, r) => sum + r.universities.length, 0);

  const metricsPage = `
    <section class="report-page-one">
      <img class="report-map-shot" src="${mapShotUrl}" alt="Map of ministry locations">
      <div class="report-metrics">
        <div class="report-metric"><div class="report-metric-num">${countries.size}</div><div class="report-metric-label">Countries</div></div>
        <div class="report-metric"><div class="report-metric-num">${rows.length}</div><div class="report-metric-label">Ministry Areas</div></div>
        <div class="report-metric"><div class="report-metric-num">${staffCount}</div><div class="report-metric-label">Staff</div></div>
        <div class="report-metric"><div class="report-metric-num">${universityCount}</div><div class="report-metric-label">Universities</div></div>
      </div>
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
    const areasHtml = (await Promise.all(divisionRows.map((row) => buildMinistryAreaHtml(row, countryIsoByName)))).join('');
    divisionSectionsHtml.push(`
      <section class="division-section">
        <h2 class="division-title">${escapeHtml(def.label)}</h2>
        ${areasHtml}
      </section>`);
  }

  return metricsPage + divisionSectionsHtml.join('');
}

async function generateReport() {
  btn.disabled = true;
  output.classList.remove('ready');
  output.innerHTML = '';
  try {
    setStatus('Loading ministry data…');
    const [rows, divisionByCountry, countryIsoByName] = await Promise.all([
      loadMinistryRows(),
      loadDivisionByCountry(),
      loadCountryIsoByName(),
    ]);

    setStatus('Capturing map (this can take a few seconds)…');
    const shotRes = await fetch('/bigtime/api/report-screenshot');
    if (!shotRes.ok) {
      const body = await shotRes.json().catch(() => ({}));
      throw new Error(body.message || `Map screenshot failed (${shotRes.status})`);
    }
    const mapShotUrl = URL.createObjectURL(await shotRes.blob());

    setStatus('Building report…');
    output.innerHTML = await buildReportHtml(rows, divisionByCountry, countryIsoByName, mapShotUrl);
    output.classList.add('ready');

    setStatus('Ready — opening print dialog. Choose "Save as PDF" as the destination.');
    window.print();
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  } finally {
    btn.disabled = false;
  }
}

btn.addEventListener('click', generateReport);
