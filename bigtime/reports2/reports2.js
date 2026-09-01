// Builds /bigtime/reports2 — an experimental parallel to /bigtime/reports
// trying a different PDF strategy: real, page-aware headers/footers via
// Chrome's own page.pdf() API instead of browser print-to-PDF.
//
// bigtime/reports/ pages this exact same content with plain CSS
// (break-before/break-inside) plus the browser's native print-to-PDF.
// That's reliable but fundamentally can't do a footer whose text varies
// by page/division, or a repeated "Division (Continued)" header — plain
// CSS has no way to know where page breaks land, and Paged.js (the only
// library that tries to give HTML/CSS that page-awareness) proved
// unreliable in this environment (hangs, silently-empty output) when
// tried earlier for the exact same thing.
//
// This page still builds the same on-screen HTML preview the same way
// (buildReportHtml below is copied from reports.js essentially unchanged)
// — the difference is entirely server-side. Each top-level section here
// carries a data-section attribute; worker/routes/report-pdf.js drives a
// headless Chrome session that shows one section at a time and calls
// page.pdf() separately for each, with a static headerTemplate/
// footerTemplate baked in for THAT section. Chrome repeats that
// header/footer on every physical page a single page.pdf() call
// produces, so a division whose content spans 3 pages gets the same
// (correct, division-specific) footer on all 3 — genuinely page-aware,
// because the "which page is this" question never has to be answered by
// the HTML/CSS at all. The per-section PDFs are merged into one file with
// pdf-lib (worker/routes/report-pdf.js).
//
// "Download PDF" hits that server route directly; there's no
// window.print() path on this page at all.

const REPORT_TITLE = 'Young Life University International Ministries';

const regenerateBtn = document.getElementById('regenerate-btn');
const downloadBtn = document.getElementById('download-btn');
const downloadStatus = document.getElementById('download-status');
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

async function loadImageManifest() {
  const res = await fetch('/bigtime/api/images-manifest');
  if (!res.ok) throw new Error(`Could not load image manifest (${res.status})`);
  const data = await res.json();
  return new Set(data.files);
}

// Staff photos aren't stored with a known filename the way a ministry's own
// `photos` column is, only a slugified name — so the actual extension has
// to be checked against what's actually in images/ (imageFiles, loaded
// once per report by loadImageManifest). This used to be a HEAD request
// per candidate extension per staff member, fired via Promise.all across
// every staff member in the report — with 100+ staff that was hundreds of
// requests in one burst, which is what was behind the multi-thousand-
// request spikes seen in Workers analytics every time a report generated.
function findStaffPhotoUrl(name, imageFiles) {
  const slug = slugify(name);
  for (const ext of CONFIG.IMAGE_EXTENSIONS) {
    const filename = `${slug}.${ext}`;
    if (imageFiles.has(filename)) return `../../${CONFIG.IMAGES_DIR}${filename}`;
  }
  return null;
}

function buildMinistryAreaHtml(row, countryIsoByName, def, imageFiles) {
  const iso2 = countryIsoByName.get(row.country.trim());
  const flag = flagEmoji(iso2);
  const name = row.city === row.country ? row.city : `${row.city}, ${row.country}`;

  const mainPhoto = row.photos[0]
    ? `<img class="ministry-area-photo" src="../../${CONFIG.IMAGES_DIR}${encodeURIComponent(row.photos[0])}" alt="">`
    : '';

  const staffUrls = row.staff.map((s) => findStaffPhotoUrl(s.name, imageFiles));
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

function metricBoxesHtml(metrics, accent) {
  const boxStyle = accent ? ` style="border-color:${accent.pin};"` : '';
  const textStyle = accent ? ` style="color:${accent.pin};"` : '';
  return `<div class="report-metrics">${metrics.map(({ label, num }) => `
    <div class="report-metric"${boxStyle}>
      <div class="report-metric-label"${textStyle}>${escapeHtml(label)}</div>
      <div class="report-metric-num"${textStyle}>${num}</div>
    </div>`).join('')}</div>`;
}

async function buildReportHtml(rows, divisionByCountry, countryIsoByName, mapShots, imageFiles) {
  const generatedLabel = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  // worker/routes/report-pdf.js reads this back off the page (not
  // recomputed server-side) so the PDF's footer text always matches
  // exactly what's on screen, even right around a month/year boundary.
  window.__reportGeneratedLabel = generatedLabel;

  const metricsPage = `
    <section class="report-page-one" data-section="overview">
      <h2 class="report-map-title">${escapeHtml(REPORT_TITLE)}</h2>
      <div class="report-generated-date">${escapeHtml(generatedLabel)}</div>
      <img class="report-map-shot" src="${mapShots.world}" alt="Map of ministry locations">
      ${metricBoxesHtml(computeMetrics(rows))}
    </section>`;

  const byDivision = new Map();
  for (const row of rows) {
    const divisionKey = divisionByCountry.get(row.country.trim());
    if (!divisionKey) continue;
    if (!byDivision.has(divisionKey)) byDivision.set(divisionKey, []);
    byDivision.get(divisionKey).push(row);
  }

  const divisionSectionsHtml = [];
  for (const [key, def] of Object.entries(DIVISIONS)) {
    const divisionRows = byDivision.get(key);
    if (!divisionRows || !divisionRows.length) continue;
    divisionRows.sort((a, b) => a.country.localeCompare(b.country) || a.city.localeCompare(b.city));
    const areasHtml = divisionRows.map((row) => buildMinistryAreaHtml(row, countryIsoByName, def, imageFiles)).join('');
    const divisionMapShot = mapShots.divisions[key];
    const divisionMapHtml = divisionMapShot
      ? `<img class="division-map-shot" src="${divisionMapShot}" alt="${escapeHtml(def.label)} map">`
      : '';
    divisionSectionsHtml.push(`
      <section class="division-section" data-section="${key}">
        <h2 class="division-title" style="color:${def.pin};"><span class="division-title-report-name">${escapeHtml(REPORT_TITLE)} — ${escapeHtml(generatedLabel)}</span><span class="division-title-division-name">${escapeHtml(def.label)}</span></h2>
        ${divisionMapHtml}
        ${metricBoxesHtml(computeMetrics(divisionRows), def)}
        <div class="division-areas">${areasHtml}</div>
      </section>`);
  }

  return metricsPage + divisionSectionsHtml.join('');
}

// worker/routes/report-pdf.js's Puppeteer session calls this once per
// data-section before each page.pdf() call — hides every other section so
// that call captures only this one. Idempotent/order-independent, same
// pattern as bigtime/maps' window.__isolateDivision.
window.__showOnlySection = function (sectionKey) {
  document.querySelectorAll('[data-section]').forEach((el) => {
    el.style.display = el.dataset.section === sectionKey ? '' : 'none';
  });
};

// -> ["overview", "europe", "asia", ...] in document order (report-pdf.js
// generates the merged PDF in this same order).
window.__allSectionKeys = function () {
  return Array.from(document.querySelectorAll('[data-section]')).map((el) => el.dataset.section);
};

// Chrome's page.pdf() embeds each <img> at roughly its source file's
// resolution, not its small on-page CSS size — a single ~1MB ministry
// photo shown as a 220px-wide thumbnail (or a 52px staff circle) still
// gets embedded near-full-size. Across dozens of ministry areas across 5
// divisions that's enough to blow well past what a Cloudflare Worker can
// hold in memory ("Invalid typed array length" while pdf-lib assembles
// the final file — the number was the real attempted allocation size,
// not a bug: a synthetic 9-photo test already produced a ~40MB PDF
// locally). This redraws every image onto a canvas sized to
// PIXEL_DENSITY× its actual rendered box and swaps img.src for that
// downscaled JPEG data URL.
//
// Only ever runs inside worker/routes/report-pdf.js's Puppeteer session —
// the live interactive site and the on-screen report preview both keep
// full-resolution images. Two things keep this from spiking the
// renderer's own memory instead of pdf-lib's: report-pdf.js calls this
// once per section (right after window.__showOnlySection, not once
// upfront with the whole report visible) — decoding one division's dozen
// photos at a time instead of every photo across all 5 divisions at
// once — and this itself processes sequentially (one full decode+redraw
// fully finished before the next starts), not in parallel. The first
// version of this fix did both wrong: it ran once for the whole report,
// and used Promise.all to decode every image concurrently, which crashed
// the Chrome session outright ("Protocol error: Target closed") instead
// of hitting pdf-lib's allocation limit — worse, not better.
window.__shrinkImagesForPdf = async function () {
  const PIXEL_DENSITY = 2; // crisp at print size without embedding the full original
  // querySelectorAll (not filtering by visibility) is fine here — a
  // hidden ancestor means clientWidth/Height are 0 below, so a
  // currently-invisible image is skipped without needing a separate
  // check for it.
  const images = Array.from(document.querySelectorAll('img'));
  for (const img of images) {
    await new Promise((resolve) => {
      const shrink = () => {
        const cssWidth = img.clientWidth;
        const cssHeight = img.clientHeight;
        if (!cssWidth || !cssHeight || !img.naturalWidth || !img.naturalHeight) { resolve(); return; }
        const targetW = Math.max(1, Math.round(cssWidth * PIXEL_DENSITY));
        const targetH = Math.max(1, Math.round(cssHeight * PIXEL_DENSITY));
        // Never upscale — only worth redrawing if the source is actually
        // bigger than what print needs.
        if (img.naturalWidth <= targetW && img.naturalHeight <= targetH) { resolve(); return; }
        try {
          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          canvas.getContext('2d').drawImage(img, 0, 0, targetW, targetH);
          img.src = canvas.toDataURL('image/jpeg', 0.82);
        } catch (err) {
          console.error('Could not shrink image for PDF, leaving it full-size:', img.src, err);
        }
        resolve();
      };
      if (img.complete && img.naturalWidth) shrink();
      else {
        img.addEventListener('load', shrink, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }
    });
  }
};

async function generateReport() {
  overlay.hidden = false;
  regenerateBtn.hidden = true;
  downloadBtn.hidden = true;
  output.classList.remove('ready');
  output.innerHTML = '';
  window.__reportReady = false;
  setStatus('Loading ministry data…');
  try {
    const [rows, divisionByCountry, countryIsoByName, imageFiles] = await Promise.all([
      loadMinistryRows(),
      loadDivisionByCountry(),
      loadCountryIsoByName(),
      loadImageManifest(),
    ]);

    // Cached PNGs, not a live capture — same as bigtime/reports/reports.js.
    const cacheBust = Date.now();
    const mapShots = {
      world: `../../maps/world.png?v=${cacheBust}`,
      divisions: Object.fromEntries(Object.keys(DIVISIONS).map((key) => [key, `../../maps/${key}.png?v=${cacheBust}`])),
    };

    setStatus('Building report…');
    output.innerHTML = await buildReportHtml(rows, divisionByCountry, countryIsoByName, mapShots, imageFiles);
    output.classList.add('ready');

    const fileDateStr = new Date().toISOString().slice(0, 10);
    document.title = `Ministry Report ${fileDateStr}`;

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
    downloadBtn.hidden = false;
    // Signal for worker/routes/report-pdf.js's Puppeteer capture to wait
    // on — everything above this point is synchronous DOM work, so once
    // it's run the report is visually complete and ready to be sectioned
    // off for page.pdf().
    window.__reportReady = true;
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  }
}

// Generating the real PDF can take a while (a separate page.pdf() call
// per division, then a merge) — this button's own loading state is
// separate from the on-screen preview's overlay above, since the preview
// is already done and visible by the time this is ever clickable.
async function downloadPdf() {
  const originalLabel = downloadBtn.textContent;
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Generating PDF…';
  downloadStatus.hidden = true;
  try {
    const res = await fetch('/bigtime/api/report-pdf');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `PDF generation failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ministry-report-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    downloadStatus.textContent = err.message || String(err);
    downloadStatus.classList.add('error');
    downloadStatus.hidden = false;
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = originalLabel;
  }
}

regenerateBtn.addEventListener('click', generateReport);
retryBtn.addEventListener('click', generateReport);
downloadBtn.addEventListener('click', downloadPdf);

generateReport();
