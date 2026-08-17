// ---------------------------------------------------------------------------
// Admin CMS — Ministries CRUD + Images (photo health/upload/remove) tabs.
// Talks only to /admin/api/* (JSON in/out) — never reads/writes CSV itself.
// Every write there is a real GitHub commit; this page just calls the API.
// Uses slugify/parseParenList/lastNameOf/flagEmoji from ../js/utils.js and
// DIVISIONS from ../js/config.js, loaded as plain <script> tags before this
// file (see admin/index.html) — same convention as admin/imagecheck.html.
// ---------------------------------------------------------------------------

const API_BASE = '/admin/api';

// Recommended minimum photo dimensions, used by both the Images tab's
// classification and its guidance banner text — one source of truth so
// they can't drift apart. See admin/index.html's .guidance block for where
// this is rendered.
const PHOTO_MINIMUMS = {
  staff: { width: 400, height: 400, label: 'Profile photos', detail: 'at least 400×400px, square' },
  city: { width: 1200, height: 630, label: 'Banner (city) photos', detail: 'at least 1200×630px' },
};

const state = {
  rows: [],
  sha: null,
  divisionByCountry: new Map(),
  editingId: null, // null while adding, otherwise the id being edited
};

// --- small DOM/text helpers -------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- banner ------------------------------------------------------------------

function showBanner(kind, message, actions = []) {
  const el = $('banner');
  el.className = `banner ${kind}`;
  el.innerHTML = escapeHtml(message);
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    el.appendChild(btn);
  }
  el.hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

// --- API helpers ---------------------------------------------------------

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body — fine for some responses
  }
  if (!res.ok) {
    throw new ApiError((body && body.message) || `Request failed (${res.status})`, res.status, body);
  }
  return body;
}

// Central 409 handler for every write action in both tabs: discard
// in-progress state and reload fresh data rather than trying to preserve
// the draft (see the plan's "draft-preservation" decision — simple/safe
// over clever for v1).
function handleWriteError(err, retryReload) {
  if (err instanceof ApiError && err.status === 409) {
    showBanner('conflict', err.message, [
      { label: 'Reload latest data', onClick: () => { hideBanner(); retryReload(); } },
    ]);
    return true;
  }
  showBanner('error', err.message || String(err));
  return false;
}

// --- tabs ------------------------------------------------------------------

function wireTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.tab;
      $('tab-ministries').hidden = tab !== 'ministries';
      $('tab-images').hidden = tab !== 'images';
      if (tab === 'images') renderImagesTab();
    });
  });
}

// --- photo widget (shared: Ministries form + Images tab replace) -----------

// Re-encodes any image (including iPhone HEIC — see createImageBitmap's
// WebKit HEIC decode, which every iOS browser uses regardless of vendor)
// to a size/quality-capped JPEG before it's ever base64'd and sent.
async function reencodeToJpeg(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Fallback path for engines without createImageBitmap support.
    const url = URL.createObjectURL(file);
    try {
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
    } catch {
      throw new Error("This photo format isn't supported by your browser — try a JPEG/PNG, or use an iPhone/Safari.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const MAX_DIM = 1600;
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);

  const TARGET_BYTES = 800 * 1024;
  let quality = 0.82;
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  for (let i = 0; i < 3 && blob.size > TARGET_BYTES; i++) {
    quality -= 0.15;
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  return blob;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function findExistingImageUrl(slug) {
  for (const ext of CONFIG.IMAGE_EXTENSIONS) {
    const url = `../${CONFIG.IMAGES_DIR}${slug}.${ext}`;
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (res.ok) return url;
    } catch {
      // try the next extension
    }
  }
  return null;
}

// Builds a drag-drop/file-picker widget. `getSlugParts()` is called at
// upload time (not widget-creation time) so it reflects whatever the
// associated name/city/country fields currently say — e.g. typing a staff
// member's name before dropping their photo works naturally.
// `onUploaded(path)` fires after a successful upload (used by the Images
// tab to flip a row from Missing back to Good/Low in place).
function createPhotoWidget(container, { getSlugParts, initialUrl, onUploaded }) {
  container.innerHTML = '';
  const thumb = initialUrl
    ? Object.assign(document.createElement('img'), { className: 'photo-thumb', src: initialUrl })
    : Object.assign(document.createElement('div'), { className: 'photo-placeholder' });
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  const status = document.createElement('span');
  status.textContent = initialUrl ? 'Drop a new photo to replace it' : 'Drop a photo or choose a file';

  container.appendChild(thumb);
  container.appendChild(input);
  container.appendChild(status);

  async function handleFile(file) {
    if (!file) return;
    const parts = getSlugParts();
    if (!parts) {
      status.textContent = 'Fill in the name/city first, then add a photo.';
      return;
    }
    status.textContent = 'Uploading…';
    try {
      const jpeg = await reencodeToJpeg(file);
      const imageBase64 = await blobToBase64(jpeg);
      const result = await apiFetch('/upload', {
        method: 'POST',
        body: JSON.stringify({ ...parts, imageBase64 }),
      });
      thumb.src = URL.createObjectURL(jpeg);
      if (thumb.tagName !== 'IMG') {
        const img = Object.assign(document.createElement('img'), { className: 'photo-thumb', src: thumb.src });
        thumb.replaceWith(img);
      }
      status.textContent = 'Uploaded';
      if (onUploaded) onUploaded(result.path);
    } catch (err) {
      status.textContent = `Upload failed: ${err.message || err}`;
    }
  }

  input.addEventListener('change', () => handleFile(input.files[0]));
  container.addEventListener('dragover', (e) => { e.preventDefault(); container.classList.add('dragover'); });
  container.addEventListener('dragleave', () => container.classList.remove('dragover'));
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.classList.remove('dragover');
    handleFile(e.dataTransfer.files[0]);
  });
}

// --- Ministries tab: table -------------------------------------------------

function renderMinistriesTable() {
  const tbody = $('ministries-tbody');
  tbody.innerHTML = '';
  const sorted = state.rows.slice().sort((a, b) => a.city.localeCompare(b.city));
  for (const row of sorted) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.city)}</td>
      <td>${escapeHtml(row.country)}</td>
      <td>${row.staff.map((s) => escapeHtml(s.name)).join(', ') || '—'}</td>
      <td>${escapeHtml(row.date_opened) || '—'}</td>
      <td class="actions">
        <button type="button" class="btn secondary btn-small" data-edit="${escapeHtml(row.id)}">Edit</button>
        <button type="button" class="btn danger btn-small" data-delete="${escapeHtml(row.id)}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  $('ministries-count').textContent = `${state.rows.length} ministr${state.rows.length === 1 ? 'y' : 'ies'}`;

  tbody.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openDialog(state.rows.find((r) => r.id === btn.dataset.edit)));
  });
  tbody.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteMinistry(btn.dataset.delete));
  });
}

async function deleteMinistry(id) {
  const row = state.rows.find((r) => r.id === id);
  if (!row) return;
  if (!window.confirm(`Delete the ${row.city}, ${row.country} ministry? This removes it from the live site.`)) return;
  try {
    const result = await apiFetch(`/ministries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ sha: state.sha }),
    });
    // Update state from what we already know rather than re-fetching —
    // GitHub's Contents API has a brief read-after-write lag immediately
    // after a commit, so an instant re-GET can occasionally still show the
    // pre-write data. The write response already has everything needed.
    state.rows = state.rows.filter((r) => r.id !== id);
    state.sha = result.sha;
    renderMinistriesTable();
  } catch (err) {
    handleWriteError(err, loadMinistries);
  }
}

// --- Ministries tab: dialog/form -------------------------------------------

function repeatableRow(group, { nameLabel, metaLabel, metaPlaceholder, name = '', meta = '' }) {
  const item = document.createElement('div');
  item.className = 'repeatable-item';
  item.innerHTML = `
    <div class="field">
      <label>${escapeHtml(nameLabel)}</label>
      <input type="text" class="row-name" value="${escapeHtml(name)}">
      <div class="field-error" hidden></div>
    </div>
    <div class="field">
      <label>${escapeHtml(metaLabel)}</label>
      <input type="text" class="row-meta" value="${escapeHtml(meta)}" placeholder="${escapeHtml(metaPlaceholder || '')}">
      <div class="field-error" hidden></div>
    </div>
    <button type="button" class="btn secondary btn-small remove-row">Remove</button>
  `;
  item.querySelector('.remove-row').addEventListener('click', () => item.remove());
  group.appendChild(item);
  return item;
}

function addStaffRow(prefill = {}) {
  const item = repeatableRow($('staff-group'), {
    nameLabel: 'Name', metaLabel: 'Role', metaPlaceholder: 'e.g. Staff Associate',
    name: prefill.name, meta: prefill.role,
  });
  const nameInput = item.querySelector('.row-name');
  const photoWidget = document.createElement('div');
  photoWidget.className = 'photo-widget';
  item.appendChild(photoWidget);

  const slug = prefill.name ? slugify(prefill.name) : null;
  const wireWidget = (initialUrl) => createPhotoWidget(photoWidget, {
    getSlugParts: () => (nameInput.value.trim() ? { kind: 'staff', name: nameInput.value.trim() } : null),
    initialUrl,
  });
  if (slug) {
    findExistingImageUrl(slug).then(wireWidget);
  } else {
    wireWidget(null);
  }
}

function addUniversityRow(prefill = {}) {
  repeatableRow($('universities-group'), {
    nameLabel: 'University', metaLabel: 'Year', metaPlaceholder: 'e.g. 2025',
    name: prefill.name, meta: prefill.year,
  });
}

function clearFieldErrors() {
  document.querySelectorAll('#ministry-dialog .field-error').forEach((el) => { el.hidden = true; el.textContent = ''; });
  $('country-error').hidden = true;
}

function openDialog(row) {
  clearFieldErrors();
  state.editingId = row ? row.id : null;
  $('dialog-title').textContent = row ? `Edit ${row.city}, ${row.country}` : 'Add ministry';

  $('field-city').value = row ? row.city : '';
  $('field-country').value = row ? row.country : '';
  $('field-lat').value = row ? row.lat : '';
  $('field-lng').value = row ? row.lng : '';
  $('field-date-opened').value = row ? row.date_opened : '';
  $('field-blurb').value = row ? row.blurb : '';

  $('staff-group').innerHTML = '';
  $('universities-group').innerHTML = '';
  if (row) {
    row.staff.forEach((s) => addStaffRow(s));
    row.universities.forEach((u) => addUniversityRow(u));
  }

  const cityWidget = $('city-photo-widget');
  const citySlug = row ? `${slugify(row.city)}-${slugify(row.country)}` : null;
  const wireCityWidget = (initialUrl) => createPhotoWidget(cityWidget, {
    getSlugParts: () => {
      const city = $('field-city').value.trim();
      const country = $('field-country').value.trim();
      return city && country ? { kind: 'city', city, country } : null;
    },
    initialUrl,
  });
  if (citySlug) findExistingImageUrl(citySlug).then(wireCityWidget);
  else wireCityWidget(null);

  $('ministry-dialog').showModal();
}

function collectRepeatable(group, nameField, metaField) {
  return Array.from(group.querySelectorAll('.repeatable-item')).map((item) => ({
    [nameField]: item.querySelector('.row-name').value.trim(),
    [metaField]: item.querySelector('.row-meta').value.trim(),
  })).filter((entry) => entry[nameField]);
}

// Mirrors the server's assertNoParens rule for instant feedback — the
// Function re-validates regardless, this is just so a mistake shows up
// immediately instead of after a round-trip.
function validateNoParensInForm() {
  let ok = true;
  document.querySelectorAll('#staff-group .repeatable-item, #universities-group .repeatable-item').forEach((item) => {
    const nameInput = item.querySelector('.row-name');
    const metaInput = item.querySelector('.row-meta');
    const nameErr = item.querySelectorAll('.field-error')[0];
    const metaErr = item.querySelectorAll('.field-error')[1];
    const nameBad = /[()]/.test(nameInput.value);
    const metaBad = /[()]/.test(metaInput.value);
    nameErr.hidden = !nameBad;
    nameErr.textContent = nameBad ? "Can't contain parentheses" : '';
    metaErr.hidden = !metaBad;
    metaErr.textContent = metaBad ? "Can't contain parentheses" : '';
    if (nameBad || metaBad) ok = false;
  });
  return ok;
}

async function saveMinistry() {
  if (!validateNoParensInForm()) return;

  const body = {
    sha: state.sha,
    city: $('field-city').value.trim(),
    country: $('field-country').value.trim(),
    lat: $('field-lat').value.trim(),
    lng: $('field-lng').value.trim(),
    date_opened: $('field-date-opened').value.trim(),
    blurb: $('field-blurb').value.trim(),
    staff: collectRepeatable($('staff-group'), 'name', 'role'),
    universities: collectRepeatable($('universities-group'), 'name', 'year'),
  };

  if (body.country && !state.divisionByCountry.has(body.country)) {
    $('country-error').hidden = false;
    $('country-error').textContent = `"${body.country}" isn't in country-divisions.csv — it won't be colored on the map. Check the spelling, or ask for it to be added.`;
    return;
  }

  const { sha: _staleSha, ...rowFields } = body;

  try {
    if (state.editingId) {
      const result = await apiFetch(`/ministries/${encodeURIComponent(state.editingId)}`, { method: 'PUT', body: JSON.stringify(body) });
      // Same read-after-write reasoning as deleteMinistry — update from the
      // write response instead of re-fetching.
      const index = state.rows.findIndex((r) => r.id === state.editingId);
      state.rows[index] = { id: state.editingId, ...rowFields };
      state.sha = result.sha;
    } else {
      const result = await apiFetch('/ministries', { method: 'POST', body: JSON.stringify(body) });
      state.rows.push({ id: result.id, ...rowFields });
      state.sha = result.sha;
    }
    renderMinistriesTable();
    $('ministry-dialog').close();
  } catch (err) {
    if (err instanceof ApiError && err.status === 400 && err.body && err.body.error === 'validation') {
      showBanner('error', err.body.message);
      return;
    }
    handleWriteError(err, loadMinistries);
  }
}

function wireDialog() {
  $('add-ministry-btn').addEventListener('click', () => openDialog(null));
  $('add-staff-btn').addEventListener('click', () => addStaffRow());
  $('add-university-btn').addEventListener('click', () => addUniversityRow());
  $('dialog-save-btn').addEventListener('click', saveMinistry);
  $('dialog-cancel-btn').addEventListener('click', () => $('ministry-dialog').close());
  $('dialog-close-btn').addEventListener('click', () => $('ministry-dialog').close());
}

// --- Ministries tab: load ---------------------------------------------------

function fetchCsvDirect(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true, header: true, skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: reject,
    });
  });
}

async function loadDivisionsDirect() {
  // country-divisions.csv is a public static file — fetched directly by the
  // browser, same as the public map does, no Function needed for this.
  const rows = await fetchCsvDirect('../data/country-divisions.csv');
  const map = new Map();
  for (const row of rows) {
    const country = (row.country || '').trim();
    const division = (row.division || '').trim();
    if (country && division) map.set(country, division);
  }
  return map;
}

async function loadMinistries() {
  hideBanner();
  try {
    const [data, divisions] = await Promise.all([
      apiFetch('/ministries'),
      state.divisionByCountry.size ? Promise.resolve(state.divisionByCountry) : loadDivisionsDirect(),
    ]);
    state.rows = data.rows;
    state.sha = data.sha;
    state.divisionByCountry = divisions;

    const datalist = $('country-list');
    datalist.innerHTML = Array.from(divisions.keys()).sort().map((c) => `<option value="${escapeHtml(c)}">`).join('');

    renderMinistriesTable();

    if (data.unmatchedCountries && data.unmatchedCountries.length) {
      showBanner('error', `${data.unmatchedCountries.length} row(s) have a country not in country-divisions.csv, so they won't be colored on the public map: ${data.unmatchedCountries.join(', ')}`);
    }
  } catch (err) {
    showBanner('error', `Failed to load ministries: ${err.message || err}`);
  }
}

// --- Images tab --------------------------------------------------------

let imagesData = null; // cached derived structure, rebuilt when state.rows changes
let imagesFilter = { missing: true, low: true, good: true };

function classify(kind, dims) {
  if (!dims) return 'missing';
  const min = PHOTO_MINIMUMS[kind];
  return (dims.width >= min.width && dims.height >= min.height) ? 'good' : 'low';
}

function measureImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ url, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function buildImagesData() {
  // division -> country -> { cities: [...], staff: [...] } — same shape
  // admin/imagecheck.html used to build from the ministries rows.
  const structure = new Map();
  for (const row of state.rows) {
    const divisionKey = state.divisionByCountry.get(row.country);
    if (!divisionKey) continue;
    if (!structure.has(divisionKey)) structure.set(divisionKey, new Map());
    const countryMap = structure.get(divisionKey);
    if (!countryMap.has(row.country)) countryMap.set(row.country, { cities: [], staff: [] });
    const bucket = countryMap.get(row.country);

    bucket.cities.push({ kind: 'city', label: row.city, city: row.city, country: row.country, slug: `${slugify(row.city)}-${slugify(row.country)}` });
    for (const s of row.staff) {
      bucket.staff.push({ kind: 'staff', label: s.name, role: s.role, city: row.city, name: s.name, slug: slugify(s.name) });
    }
  }

  const checks = [];
  for (const [, countryMap] of structure) {
    for (const [, bucket] of countryMap) {
      for (const entry of [...bucket.cities, ...bucket.staff]) {
        checks.push((async () => {
          entry.dims = null;
          for (const ext of CONFIG.IMAGE_EXTENSIONS) {
            const url = `../${CONFIG.IMAGES_DIR}${entry.slug}.${ext}`;
            const measured = await measureImage(url);
            if (measured) { entry.dims = measured; break; }
          }
          entry.status = classify(entry.kind, entry.dims);
        })());
      }
    }
  }
  await Promise.all(checks);
  return structure;
}

function renderGuidance() {
  $('images-guidance').innerHTML = Object.values(PHOTO_MINIMUMS)
    .map((m) => `<strong>${escapeHtml(m.label)}:</strong> ${escapeHtml(m.detail)}`)
    .join(' &nbsp;·&nbsp; ');
}

function renderFilterBar() {
  const bar = $('images-filter-bar');
  const defs = [
    { key: 'good', label: 'Good' },
    { key: 'low', label: 'Low resolution' },
    { key: 'missing', label: 'Missing' },
  ];
  bar.innerHTML = defs.map((d) => `<button type="button" class="filter-toggle status-${d.key} ${imagesFilter[d.key] ? 'on' : ''}" data-status="${d.key}">${d.label}</button>`).join('');
  bar.querySelectorAll('.filter-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const status = btn.dataset.status;
      imagesFilter[status] = !imagesFilter[status];
      btn.classList.toggle('on', imagesFilter[status]);
      applyImagesFilter();
    });
  });
}

function applyImagesFilter() {
  document.querySelectorAll('#images-report .entry').forEach((li) => {
    const status = li.dataset.status;
    li.classList.toggle('hide-status', !imagesFilter[status]);
  });
}

function imageEntryRow(entry) {
  const roleText = entry.kind === 'staff' ? (entry.role ? `${entry.role}, ${entry.city}` : entry.city) : '';
  const dimsText = entry.dims ? `${entry.dims.width}×${entry.dims.height}` : '';
  const li = document.createElement('li');
  li.className = 'entry';
  li.dataset.status = entry.status;
  li.dataset.slug = entry.slug;
  const removeBtn = entry.status !== 'missing' ? `<button type="button" class="btn secondary btn-small" data-remove="${escapeHtml(entry.slug)}">Remove</button>` : '';
  li.innerHTML = `
    <div class="entry-row">
      <div class="entry-left">
        <span class="status-dot status-${entry.status}"></span>
        <button type="button" class="who-btn" ${entry.status === 'missing' ? 'disabled' : ''}>
          <span class="kind-tag">${entry.kind === 'city' ? 'City' : 'Staff'}</span>
          <span class="who">${escapeHtml(entry.label)}${roleText ? `<span class="role">${escapeHtml(roleText)}</span>` : ''}</span>
        </button>
        ${dimsText ? `<span class="dims">${dimsText}</span>` : ''}
      </div>
      <div class="entry-actions">${removeBtn}</div>
    </div>
    <div class="preview" hidden></div>
    <div class="replace-widget" hidden></div>
  `;

  if (entry.status !== 'missing') {
    li.querySelector('.who-btn').addEventListener('click', () => {
      const preview = li.querySelector('.preview');
      if (!preview.hidden) { preview.hidden = true; return; }
      if (!preview.dataset.loaded) {
        preview.innerHTML = `<img src="${escapeHtml(entry.dims.url)}" alt="">`;
        preview.dataset.loaded = '1';
      }
      preview.hidden = false;
    });
    li.querySelector('[data-remove]').addEventListener('click', () => removePhoto(entry, li));
  }

  return li;
}

async function removePhoto(entry, li) {
  if (!window.confirm(`Remove this photo? This deletes it from the live site.`)) return;
  try {
    await apiFetch(`/photos/${encodeURIComponent(entry.slug)}`, { method: 'DELETE' });
    entry.dims = null;
    entry.status = 'missing';
    li.dataset.status = 'missing';
    li.querySelector('.status-dot').className = 'status-dot status-missing';
    li.querySelector('.dims')?.remove();
    li.querySelector('.entry-actions').innerHTML = '';
    li.querySelector('.who-btn').disabled = true;
    li.querySelector('.preview').hidden = true;
    const replaceWidget = li.querySelector('.replace-widget');
    replaceWidget.hidden = false;
    createPhotoWidget(replaceWidget, {
      getSlugParts: () => (entry.kind === 'staff' ? { kind: 'staff', name: entry.name } : { kind: 'city', city: entry.city, country: entry.country }),
      initialUrl: null,
      onUploaded: () => loadMinistries().then(renderImagesTab),
    });
  } catch (err) {
    handleWriteError(err, () => loadMinistries().then(renderImagesTab));
  }
}

async function renderImagesTab() {
  renderGuidance();
  renderFilterBar();
  $('images-summary').innerHTML = '<span class="status-text">Checking images…</span>';
  const reportContainer = $('images-report');
  reportContainer.innerHTML = '';

  const structure = await buildImagesData();
  imagesData = structure;

  let total = 0, missing = 0, low = 0;
  const divisionOrder = Object.keys(DIVISIONS);

  for (const divisionKey of divisionOrder) {
    const countryMap = structure.get(divisionKey);
    if (!countryMap) continue;
    const countryNames = Array.from(countryMap.keys()).sort((a, b) => a.localeCompare(b));
    const divisionEl = document.createElement('div');
    divisionEl.innerHTML = `<h2 class="division">${escapeHtml(DIVISIONS[divisionKey].label)}</h2>`;

    for (const country of countryNames) {
      const bucket = countryMap.get(country);
      const staffSorted = bucket.staff.slice().sort((a, b) => lastNameOf(a.name).localeCompare(lastNameOf(b.name)));
      const countryEl = document.createElement('div');
      countryEl.innerHTML = `<h3 class="country">${escapeHtml(country)}</h3>`;
      const ul = document.createElement('ul');
      ul.className = 'entry-list';
      for (const entry of [...bucket.cities, ...staffSorted]) {
        total++;
        if (entry.status === 'missing') missing++;
        if (entry.status === 'low') low++;
        ul.appendChild(imageEntryRow(entry));
      }
      countryEl.appendChild(ul);
      divisionEl.appendChild(countryEl);
    }
    reportContainer.appendChild(divisionEl);
  }

  const good = total - missing - low;
  $('images-summary').innerHTML = missing === 0 && low === 0
    ? `All ${total} photos present and at least the recommended size.`
    : `<strong>${good}</strong> good &middot; <strong>${low}</strong> low resolution &middot; <strong>${missing}</strong> missing (of ${total} total)`;

  applyImagesFilter();
}

// --- init --------------------------------------------------------------

wireTabs();
wireDialog();
loadMinistries();
