// Builds bigtime/report/index.html's content — a pure Puppeteer rendering
// target for worker/routes/report-pdf.js. Real, page-aware headers/footers
// via Chrome's own page.pdf() API: each top-level section here carries a
// data-section attribute; report-pdf.js drives a headless Chrome session
// that shows one section at a time and calls page.pdf() separately for
// each, with a static headerTemplate/footerTemplate baked in for THAT
// section. Chrome repeats that header/footer on every physical page a
// single page.pdf() call produces, so a division whose content spans 3
// pages gets the same (correct, division-specific) footer on all 3 —
// genuinely page-aware, because the "which page is this" question never
// has to be answered by the HTML/CSS at all. The per-section PDFs are
// merged into one file with pdf-lib (worker/routes/report-pdf.js).
//
// Replaces bigtime/reports2/ (and the older bigtime/reports/) — this page
// is never browsed directly by a person anymore (the "Download Report
// PDF" button lives on bigtime/index.html and hits the PDF route
// straight), so unlike those, there's no on-screen chrome, loading
// overlay, or retry/regenerate UI here at all.

const REPORT_TITLE = 'Young Life University International Ministries';

const output = document.getElementById('report-output');

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
// once per report by loadImageManifest) rather than guessed via a burst of
// HEAD requests per candidate extension per staff member (the old
// approach — with 100+ staff that was hundreds of requests in one burst,
// behind the multi-thousand-request spikes seen in Workers analytics
// every time a report generated).
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
        <div class="division-header">
          <h2 class="division-title" style="color:${def.pin};"><span class="division-title-report-name">${escapeHtml(REPORT_TITLE)} — ${escapeHtml(generatedLabel)}</span><span class="division-title-division-name">${escapeHtml(def.label)}</span></h2>
          ${divisionMapHtml}
          ${metricBoxesHtml(computeMetrics(divisionRows), def)}
        </div>
        <div class="division-areas">${areasHtml}</div>
      </section>`);
  }

  return metricsPage + divisionSectionsHtml.join('');
}

// report-pdf.js's Puppeteer session calls this once per (section, part)
// pair before each page.pdf() call — hides every other section so that
// call captures only this one. A division section has two parts, each
// becoming its own page.pdf() call so each can get its own footer:
// 'header' (title + map + metrics — always exactly one page) and 'areas'
// (the ministry listing, which can span several). That split is what lets
// the map page go out with no footer at all (see __allSectionParts below)
// while the listing pages keep one — a single page.pdf() call can't vary
// its footer page-to-page, so this is the only way to make one page in a
// section look different from another. 'overview' has no header/areas
// split (part is ignored for it — the whole section is just the world map
// + metrics, shown as a whole).
window.__showOnlySectionPart = function (sectionKey, part) {
  document.querySelectorAll('[data-section]').forEach((el) => {
    el.style.display = el.dataset.section === sectionKey ? '' : 'none';
  });
  if (sectionKey === 'overview') return;
  const section = document.querySelector(`[data-section="${sectionKey}"]`);
  section.querySelector('.division-header').style.display = part === 'header' ? '' : 'none';
  section.querySelector('.division-areas').style.display = part === 'areas' ? '' : 'none';
};

// -> [{key:'overview', part:null}, {key:'europe', part:'header'},
//     {key:'europe', part:'areas'}, ...] in document order (report-pdf.js
// generates the merged PDF in this same order).
window.__allSectionParts = function () {
  const keys = Array.from(document.querySelectorAll('[data-section]')).map((el) => el.dataset.section);
  const result = [];
  for (const key of keys) {
    if (key === 'overview') { result.push({ key, part: null }); continue; }
    result.push({ key, part: 'header' });
    result.push({ key, part: 'areas' });
  }
  return result;
};

// Chrome's page.pdf() embeds each <img> at roughly its source file's
// resolution, not its small on-page CSS size — a single ~1MB ministry
// photo shown as a 220px-wide thumbnail (or a 52px staff circle) still
// gets embedded near-full-size. Across dozens of ministry areas across 5
// divisions that's enough to blow well past what a Cloudflare Worker can
// hold in memory ("Invalid typed array length" while pdf-lib assembles
// the final file — the number was the real attempted allocation size, not
// a bug: a synthetic 9-photo test already produced a ~40MB PDF locally).
// This redraws every image onto a canvas sized to PIXEL_DENSITY× its
// actual rendered box and swaps img.src for that downscaled JPEG data URL.
//
// Only ever runs inside report-pdf.js's Puppeteer session. Two things
// keep this from spiking the renderer's own memory instead of pdf-lib's:
// report-pdf.js calls this once per section (right after
// window.__showOnlySectionPart, not once upfront with the whole report
// visible) — decoding one division's dozen photos at a time instead of
// every photo across all 5 divisions at once — and this itself processes
// sequentially (one full decode+redraw fully finished before the next
// starts), not in parallel.
window.__shrinkImagesForPdf = async function () {
  const PIXEL_DENSITY = 2; // crisp at print size without embedding the full original
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
          // Replicates object-fit:cover (crop to fill, centered) instead
          // of stretching the whole source into the target box.
          const srcAspect = img.naturalWidth / img.naturalHeight;
          const dstAspect = targetW / targetH;
          let sx = 0;
          let sy = 0;
          let sw = img.naturalWidth;
          let sh = img.naturalHeight;
          if (srcAspect > dstAspect) {
            sw = img.naturalHeight * dstAspect;
            sx = (img.naturalWidth - sw) / 2;
          } else {
            sh = img.naturalWidth / dstAspect;
            sy = (img.naturalHeight - sh) / 2;
          }
          canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
          img.src = canvas.toDataURL('image/jpeg', 0.82);
        } catch (err) {
          console.error('Could not shrink image for PDF, leaving it full-size:', img.src, err);
        }
        resolve();
      };
      if (img.complete) {
        // A broken image (e.g. a stale/missing filename) is also
        // "complete" — with naturalWidth 0 — and will never fire another
        // load/error event, since nothing is retrying its src. Treating
        // that the same as "still loading" hangs this function forever on
        // the very first broken photo it hits — resolve immediately
        // instead so a bad photo just gets skipped, not a hung report.
        if (img.naturalWidth) shrink(); else resolve();
      } else {
        img.addEventListener('load', shrink, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }
    });
  }
};

async function generateReport() {
  window.__reportReady = false;
  try {
    const [rows, divisionByCountry, countryIsoByName, imageFiles] = await Promise.all([
      loadMinistryRows(),
      loadDivisionByCountry(),
      loadCountryIsoByName(),
      loadImageManifest(),
    ]);

    // Cached PNGs, not a live capture — see worker/lib/mapArchive.js.
    const cacheBust = Date.now();
    const mapShots = {
      world: `../../maps/world.png?v=${cacheBust}`,
      divisions: Object.fromEntries(Object.keys(DIVISIONS).map((key) => [key, `../../maps/${key}.png?v=${cacheBust}`])),
    };

    output.innerHTML = await buildReportHtml(rows, divisionByCountry, countryIsoByName, mapShots, imageFiles);

    const images = output.querySelectorAll('img');
    await Promise.all(Array.from(images).map((img) => (
      img.complete ? Promise.resolve() : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })
    )));

    // Signal for reportCapture.js's Puppeteer capture to wait on —
    // everything above this point is synchronous DOM work, so once it's
    // run the report is visually complete and ready to be sectioned off
    // for page.pdf(). Left false (and this page.waitForFunction()'d out
    // by reportCapture.js's own timeout) on any error below — nobody's
    // watching this page for a retry UI anymore, so a failure here is
    // just a failed generation request, same as any other.
    window.__reportReady = true;
  } catch (err) {
    console.error('Report generation failed:', err);
    // reportCapture.js reads this back after its wait times out, so a
    // failure here surfaces as an actual reason (e.g. "Could not load
    // ministries (401)") instead of just Puppeteer's generic "Waiting
    // failed: 60000ms exceeded" — that message alone gives no way to
    // tell a real bug apart from data loading just legitimately being
    // slow.
    window.__reportError = String((err && err.message) || err);
  }
}

generateReport();
