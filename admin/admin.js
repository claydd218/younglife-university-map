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
// `onUploaded(path, measured)` fires after a successful upload — `measured`
// is `{url, width, height}` (url is a local blob, not a repo URL) or null
// if it couldn't be read, used by the Images tab to flip a row from Missing
// back to Good/Low in place without re-fetching the just-uploaded file.
// `kind` ('staff' or 'city') drives the same good/low classification used
// by the Images tab, so the dimensions shown here get the same color and
// the same recommended-size hint when a photo comes in under the minimum.
function basenameOf(url) {
  try {
    return decodeURIComponent(url.split('/').pop().split('?')[0]);
  } catch {
    return url;
  }
}

// Mirrors the server's own slug computation (worker/routes/upload.js) so
// the client can tell, without asking the server, whether a photo that's
// already on screen still matches the current field values.
function slugFromParts(parts) {
  if (!parts) return null;
  return parts.kind === 'staff' ? slugify(parts.name) : `${slugify(parts.city)}-${slugify(parts.country)}`;
}

function missingFieldsMessage(kind) {
  return kind === 'city'
    ? 'Fill in the City and Country first, then add a photo.'
    : 'Fill in the Name first, then add a photo.';
}

function createPhotoWidget(container, { kind, getSlugParts, initialUrl, initialSlug, onUploaded }) {
  container.innerHTML = '';
  let photoSlug = initialUrl ? (initialSlug || null) : null;

  // Column 1: the photo itself, unchanged.
  const thumb = initialUrl
    ? Object.assign(document.createElement('img'), { className: 'photo-thumb', src: initialUrl })
    : Object.assign(document.createElement('div'), { className: 'photo-placeholder' });
  const thumbCol = document.createElement('div');
  thumbCol.className = 'photo-col-thumb';
  thumbCol.appendChild(thumb);

  // Column 2: file name / resolution / recommendation, one per row.
  const fileNameEl = document.createElement('div');
  fileNameEl.className = 'photo-filename';
  const dims = document.createElement('div');
  dims.className = 'dims';
  const hint = document.createElement('div');
  hint.className = 'photo-hint';
  hint.hidden = true;
  const infoCol = document.createElement('div');
  infoCol.className = 'photo-col-info';
  infoCol.append(fileNameEl, dims, hint);

  // Column 3: replace action. The real file input is visually hidden — a
  // styled button drives it via .click(), so the browser's own "No file
  // chosen" text next to a native input never appears; the file name is
  // already shown in column 2 instead.
  const replaceLabel = document.createElement('div');
  replaceLabel.className = 'replace-label';
  replaceLabel.textContent = 'To replace, drop a new photo';
  const chooseBtn = document.createElement('button');
  chooseBtn.type = 'button';
  chooseBtn.className = 'btn secondary btn-small';
  chooseBtn.textContent = 'Choose File';
  const replaceRow = document.createElement('div');
  replaceRow.className = 'replace-row';
  replaceRow.append('or ', chooseBtn);
  const replaceStatus = document.createElement('div');
  replaceStatus.className = 'replace-status';
  replaceStatus.hidden = true;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.className = 'hidden-file-input';
  const replaceCol = document.createElement('div');
  replaceCol.className = 'photo-col-replace';
  replaceCol.append(replaceLabel, replaceRow, replaceStatus, input);

  // Click a loaded photo to toggle a larger preview below the widget.
  const zoomRow = document.createElement('div');
  zoomRow.className = 'photo-zoom-row';
  zoomRow.hidden = true;
  const zoomImg = document.createElement('img');
  zoomRow.appendChild(zoomImg);

  container.append(thumbCol, infoCol, replaceCol, zoomRow);

  thumbCol.addEventListener('click', (e) => {
    const img = e.target.closest('img.photo-thumb');
    if (!img) return;
    if (zoomRow.hidden) {
      zoomImg.src = img.src;
      zoomRow.hidden = false;
    } else {
      zoomRow.hidden = true;
    }
  });
  zoomImg.addEventListener('click', () => { zoomRow.hidden = true; });

  // Exposed on the DOM node (rather than returned) so code outside the
  // async findExistingImageUrl().then(wireWidget) chain — e.g. the Close
  // handler's slug-reconciliation pass — can still reach this widget.
  container.photoHandle = {
    getPhotoSlug: () => photoSlug,
    setPhotoSlug: (s) => { photoSlug = s; },
    hasPhoto: () => thumb.tagName === 'IMG',
  };

  chooseBtn.addEventListener('click', () => input.click());

  // kind: 'error' | 'uploading' | '' (cleared)
  function setReplaceStatus(message, kind = '') {
    replaceStatus.textContent = message;
    replaceStatus.className = `replace-status ${kind}`.trim();
    replaceStatus.hidden = !message;
  }

  async function refreshInfo(url, displayName) {
    fileNameEl.textContent = displayName || (url ? basenameOf(url) : 'No photo yet');
    const measured = (kind && url) ? await measureImage(url) : null;
    const min = PHOTO_MINIMUMS[kind];
    if (!measured) {
      dims.textContent = '';
      dims.className = 'dims';
      if (min) {
        hint.textContent = `Recommended: at least ${min.width}×${min.height}px${kind === 'staff' ? ', square' : ''}.`;
        hint.className = 'photo-hint neutral';
        hint.hidden = false;
      } else {
        hint.hidden = true;
      }
      return null;
    }
    const cls = classify(kind, measured);
    dims.textContent = `${measured.width}×${measured.height}`;
    dims.className = `dims status-${cls}`;
    if (cls === 'low' && min) {
      hint.textContent = `Recommended: at least ${min.width}×${min.height}px${kind === 'staff' ? ', square' : ''}.`;
      hint.className = 'photo-hint warning';
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
    return measured;
  }

  refreshInfo(initialUrl, null);

  async function handleFile(file) {
    if (!file) return;
    const parts = getSlugParts();
    if (!parts) {
      setReplaceStatus(missingFieldsMessage(kind), 'error');
      return;
    }
    setReplaceStatus('Uploading…', 'uploading');
    try {
      const jpeg = await reencodeToJpeg(file);
      const imageBase64 = await blobToBase64(jpeg);
      const result = await apiFetch('/upload', {
        method: 'POST',
        body: JSON.stringify({ ...parts, imageBase64 }),
      });
      const objectUrl = URL.createObjectURL(jpeg);
      thumb.src = objectUrl;
      if (thumb.tagName !== 'IMG') {
        const img = Object.assign(document.createElement('img'), { className: 'photo-thumb', src: thumb.src });
        thumb.replaceWith(img);
      }
      setReplaceStatus('');
      zoomRow.hidden = true;
      photoSlug = slugFromParts(parts);
      // The stored name (from the server's slug-based naming convention,
      // e.g. daniel-njoku.jpg) — not the original filename from the
      // uploader's computer — so this matches what's actually in the repo.
      const measured = await refreshInfo(objectUrl, basenameOf(result.path));
      // Pass the just-measured local blob, not a URL the caller would have
      // to re-fetch from the repo — GitHub's Contents API has a brief
      // read-after-write lag, so an immediate re-fetch can still 404.
      if (onUploaded) onUploaded(result.path, measured);
    } catch (err) {
      setReplaceStatus(`Upload failed: ${err.message || err}`, 'error');
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
  const container = $('ministries-report');
  container.innerHTML = '';

  // Group by division (same key used to color the public map) so ministries
  // read the same way the Images tab already does. Rows whose country isn't
  // in country-divisions.csv still need to be reachable to fix, so they get
  // their own uncolored group rather than being silently dropped.
  const byDivision = new Map();
  const other = [];
  for (const row of state.rows) {
    const divisionKey = state.divisionByCountry.get(row.country);
    if (!divisionKey) { other.push(row); continue; }
    if (!byDivision.has(divisionKey)) byDivision.set(divisionKey, []);
    byDivision.get(divisionKey).push(row);
  }

  const groups = Object.keys(DIVISIONS)
    .filter((key) => byDivision.has(key))
    .map((key) => ({ label: DIVISIONS[key].label, color: DIVISIONS[key].pin, rows: byDivision.get(key) }));
  if (other.length) groups.push({ label: 'Other (country not in country-divisions.csv)', color: '#888', rows: other });

  for (const group of groups) {
    const sorted = group.rows.slice().sort((a, b) => a.city.localeCompare(b.city));
    const rowsHtml = sorted.map((row) => `
      <tr>
        <td>${escapeHtml(row.city)}</td>
        <td>${escapeHtml(row.country)}</td>
        <td>${row.staff.map((s) => escapeHtml(s.name)).join(', ') || '—'}</td>
        <td>${escapeHtml(row.date_opened) || '—'}</td>
        <td class="actions">
          <button type="button" class="btn secondary btn-small" data-edit="${escapeHtml(row.id)}">Edit</button>
          <button type="button" class="btn danger btn-small" data-delete="${escapeHtml(row.id)}">Delete</button>
        </td>
      </tr>
    `).join('');
    const section = document.createElement('div');
    section.innerHTML = `
      <h2 class="division" style="color: ${group.color}; border-bottom-color: ${group.color};">${escapeHtml(group.label)}</h2>
      <table>
        <thead>
          <tr><th>City</th><th>Country</th><th>Staff</th><th>Opened</th><th></th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
    container.appendChild(section);
  }

  $('ministries-count').textContent = `${state.rows.length} ministr${state.rows.length === 1 ? 'y' : 'ies'}`;

  container.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openDialog(state.rows.find((r) => r.id === btn.dataset.edit)));
  });
  container.querySelectorAll('[data-delete]').forEach((btn) => {
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
  `;
  group.appendChild(item);
  return item;
}

// `confirmMessage`, when set, guards the click with window.confirm — used
// for staff rows since removing one (unlike a university) also abandons an
// attached photo upload.
function makeRemoveButton({ danger = false, confirmMessage = null, onRemove }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn btn-small remove-row ${danger ? 'danger' : 'secondary'}`;
  btn.textContent = 'Remove';
  btn.addEventListener('click', () => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    onRemove();
  });
  return btn;
}

function addStaffRow(prefill = {}) {
  const item = repeatableRow($('staff-group'), {
    nameLabel: 'Name', metaLabel: 'Role', metaPlaceholder: 'e.g. College Coordinator',
    name: prefill.name, meta: prefill.role,
  });
  const nameInput = item.querySelector('.row-name');
  const photoWidget = document.createElement('div');
  photoWidget.className = 'photo-widget';
  item.appendChild(photoWidget);

  item.appendChild(makeRemoveButton({
    danger: true,
    confirmMessage: 'Remove this staff member? This can’t be undone after you save the ministry.',
    onRemove: () => item.remove(),
  }));

  const slug = prefill.name ? slugify(prefill.name) : null;
  const wireWidget = (initialUrl) => createPhotoWidget(photoWidget, {
    kind: 'staff',
    getSlugParts: () => (nameInput.value.trim() ? { kind: 'staff', name: nameInput.value.trim() } : null),
    initialUrl,
    initialSlug: slug,
  });
  if (slug) {
    findExistingImageUrl(slug).then(wireWidget);
  } else {
    wireWidget(null);
  }
}

function addUniversityRow(prefill = {}) {
  const item = repeatableRow($('universities-group'), {
    nameLabel: 'University', metaLabel: 'Year', metaPlaceholder: 'e.g. 2025',
    name: prefill.name, meta: prefill.year,
  });
  item.appendChild(makeRemoveButton({
    danger: true,
    confirmMessage: 'Remove this university? This can’t be undone after you save the ministry.',
    onRemove: () => item.remove(),
  }));
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
  $('field-blurb').value = row ? row.blurb : '';
  setLatLngLookupStatus('');
  closePinPlacementMap();
  updatePinPlacementVisibility();

  // Editing saves in place on Update (existing data, nothing to discard).
  // Adding gets a real Save/Cancel choice — there's no prior state to fall
  // back to, so a single always-saving button would be ambiguous.
  $('dialog-close-btn').textContent = row ? 'Update' : 'Save';
  $('dialog-cancel-btn').hidden = !!row;
  updateSaveButtonState();

  $('staff-group').innerHTML = '';
  $('universities-group').innerHTML = '';
  if (row) {
    row.staff.forEach((s) => addStaffRow(s));
    row.universities.forEach((u) => addUniversityRow(u));
  }

  const cityWidget = $('city-photo-widget');
  const citySlug = row ? `${slugify(row.city)}-${slugify(row.country)}` : null;
  const wireCityWidget = (initialUrl) => createPhotoWidget(cityWidget, {
    kind: 'city',
    getSlugParts: () => {
      const city = $('field-city').value.trim();
      const country = $('field-country').value.trim();
      return city && country ? { kind: 'city', city, country } : null;
    },
    initialUrl,
    initialSlug: citySlug,
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

// There's no standalone "date opened" field anymore — it's derived from
// the ministry's own data instead of asking for it twice. A university's
// Year field isn't always a year (it's whatever's in that entry's last
// parens, e.g. "UNHAS" is an abbreviation, not a year — see rowToApi/
// rowFromBody in worker/lib/ministries.js), so this only counts entries
// that actually parse as a plausible year and takes the earliest one.
// computeStage() in js/app.js already treats a blank value as
// "established", same as it always has for ministries with no date.
function deriveDateOpened(universities) {
  const years = universities
    .map((u) => parseInt(u.year, 10))
    .filter((y) => Number.isInteger(y) && y > 1900 && y < 2200);
  return years.length ? String(Math.min(...years)) : '';
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

// If a photo was uploaded under a name that's since been edited — or the
// dialog was opened on an existing photo and the row got renamed — the
// file on disk drifts from what the fields now say. Editing has no Cancel
// to escape that mismatch through, so Update reconciles each photo to the
// current fields as part of saving: read the old file's bytes,
// re-upload them under the new slug, then remove the old one. Instant
// no-op (no network calls) when nothing's changed, which is the common case.
async function reconcilePhotoWidget(widget, parts) {
  if (!widget || !widget.hasPhoto()) return;
  const oldSlug = widget.getPhotoSlug();
  const newSlug = slugFromParts(parts);
  if (!oldSlug || !newSlug || oldSlug === newSlug) return;
  const oldUrl = await findExistingImageUrl(oldSlug);
  if (!oldUrl) return; // nothing on disk to move
  const sourceBlob = await (await fetch(oldUrl, { cache: 'no-store' })).blob();
  const jpeg = await reencodeToJpeg(sourceBlob);
  const imageBase64 = await blobToBase64(jpeg);
  await apiFetch('/upload', { method: 'POST', body: JSON.stringify({ ...parts, imageBase64 }) });
  await apiFetch(`/photos/${encodeURIComponent(oldSlug)}`, { method: 'DELETE' });
  widget.setPhotoSlug(newSlug);
}

async function reconcileAllPhotos() {
  for (const item of document.querySelectorAll('#staff-group .repeatable-item')) {
    const name = item.querySelector('.row-name').value.trim();
    if (!name) continue;
    await reconcilePhotoWidget(item.querySelector('.photo-widget')?.photoHandle, { kind: 'staff', name });
  }
  const city = $('field-city').value.trim();
  const country = $('field-country').value.trim();
  if (city && country) {
    await reconcilePhotoWidget($('city-photo-widget').photoHandle, { kind: 'city', city, country });
  }
}

async function saveMinistry() {
  if (!validateNoParensInForm()) return;

  const universities = collectRepeatable($('universities-group'), 'name', 'year');
  const body = {
    sha: state.sha,
    city: $('field-city').value.trim(),
    country: $('field-country').value.trim(),
    lat: $('field-lat').value.trim(),
    lng: $('field-lng').value.trim(),
    date_opened: deriveDateOpened(universities),
    blurb: $('field-blurb').value.trim(),
    staff: collectRepeatable($('staff-group'), 'name', 'role'),
    universities,
  };

  if (body.country && !state.divisionByCountry.has(body.country)) {
    $('country-error').hidden = false;
    $('country-error').textContent = `"${body.country}" isn't in country-divisions.csv — it won't be colored on the map. Check the spelling, or ask for it to be added.`;
    return;
  }

  const { sha: _staleSha, ...rowFields } = body;

  const closeBtn = $('dialog-close-btn');
  closeBtn.disabled = true;
  closeBtn.textContent = 'Saving…';
  $('dialog-cancel-btn').disabled = true;
  try {
    await reconcileAllPhotos();
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
  } finally {
    closeBtn.textContent = state.editingId ? 'Update' : 'Save';
    updateSaveButtonState();
    $('dialog-cancel-btn').disabled = false;
  }
}

// City, Country, Latitude, and Longitude are the only fields the site's map
// pin actually needs to place a ministry — gate Save/Close on those instead
// of relying solely on the server's validation error after a round trip.
function updateSaveButtonState() {
  const ready = ['field-city', 'field-country', 'field-lat', 'field-lng']
    .every((id) => $(id).value.trim());
  $('dialog-close-btn').disabled = !ready;
}

function setLatLngLookupStatus(message, kind = '') {
  const status = $('latlng-lookup-status');
  status.textContent = message;
  status.className = `latlng-lookup-status ${kind}`.trim();
}

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const results = await res.json();
  return results[0] || null;
}

// Nominatim (OpenStreetMap's free geocoder) — no API key, but rate-limited
// and occasionally imprecise for small towns, so this only ever fills the
// lat/lng fields; it never blocks manual entry/override. If the exact city
// can't be found, falls back to a country-only query so the fields always
// end up with *something* plausible to fine-tune with pin placement, rather
// than staying blank.
async function lookupLatLng() {
  const city = $('field-city').value.trim();
  const country = $('field-country').value.trim();
  if (!city || !country) {
    setLatLngLookupStatus('Fill in City and Country first.', 'error');
    return;
  }
  const btn = $('latlng-lookup-btn');
  btn.disabled = true;
  setLatLngLookupStatus('Looking up…');
  try {
    let result = await geocode(`${city}, ${country}`);
    let approximate = false;
    if (!result) {
      result = await geocode(country);
      approximate = true;
    }
    if (!result) {
      setLatLngLookupStatus('No match found — enter lat/long manually.', 'error');
      return;
    }
    $('field-lat').value = Number(result.lat).toFixed(4);
    $('field-lng').value = Number(result.lon).toFixed(4);
    setLatLngLookupStatus(approximate
      ? `No exact match for "${city}" — placed at the approximate center of ${country}. Use Update pin placement to adjust.`
      : `Found: ${result.display_name}`);
    updateSaveButtonState();
    updatePinPlacementVisibility();
  } catch (err) {
    setLatLngLookupStatus(`Lookup failed: ${err.message || err}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Ministries tab: pin placement map --------------------------------------

let pinPlacementMap = null; // Leaflet instances, only exist while the panel is open
let pinPlacementMarker = null;

function updatePinPlacementVisibility() {
  const hasLatLng = $('field-lat').value.trim() && $('field-lng').value.trim();
  $('pin-placement-btn').hidden = !hasLatLng;
  if (!hasLatLng) closePinPlacementMap();
}

function closePinPlacementMap() {
  if (pinPlacementMap) {
    pinPlacementMap.remove();
    pinPlacementMap = null;
    pinPlacementMarker = null;
  }
  $('pin-placement-map').hidden = true;
  $('pin-placement-btn').textContent = 'Update Pin Placement';
  $('pin-placement-btn').classList.add('secondary');
}

// A single draggable marker, click-anywhere-to-place — dragging or clicking
// writes straight back into the lat/lng fields so the map and the fields
// never disagree about where the pin actually is.
function openPinPlacementMap() {
  const lat = Number($('field-lat').value);
  const lng = Number($('field-lng').value);
  $('pin-placement-map').hidden = false;
  $('pin-placement-btn').textContent = 'Close Map';
  $('pin-placement-btn').classList.remove('secondary');

  pinPlacementMap = L.map('pin-placement-map').setView([lat, lng], 10);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(pinPlacementMap);

  pinPlacementMarker = L.marker([lat, lng], { draggable: true }).addTo(pinPlacementMap);
  const applyPosition = (latlng) => {
    $('field-lat').value = latlng.lat.toFixed(4);
    $('field-lng').value = latlng.lng.toFixed(4);
    updateSaveButtonState();
  };
  pinPlacementMarker.on('dragend', () => applyPosition(pinPlacementMarker.getLatLng()));
  pinPlacementMap.on('click', (e) => {
    pinPlacementMarker.setLatLng(e.latlng);
    applyPosition(e.latlng);
  });
}

function togglePinPlacementMap() {
  if (pinPlacementMap) closePinPlacementMap();
  else openPinPlacementMap();
}

function wireDialog() {
  $('add-ministry-btn').addEventListener('click', () => openDialog(null));
  $('add-staff-btn').addEventListener('click', () => addStaffRow());
  $('add-university-btn').addEventListener('click', () => addUniversityRow());
  $('latlng-lookup-btn').addEventListener('click', lookupLatLng);
  $('pin-placement-btn').addEventListener('click', togglePinPlacementMap);
  $('dialog-close-btn').addEventListener('click', saveMinistry);
  $('dialog-cancel-btn').addEventListener('click', () => $('ministry-dialog').close());
  ['field-city', 'field-country', 'field-lat', 'field-lng'].forEach((id) => {
    $(id).addEventListener('input', updateSaveButtonState);
  });
  ['field-lat', 'field-lng'].forEach((id) => {
    $(id).addEventListener('input', () => {
      updatePinPlacementVisibility();
      // Keep the map in sync if it's open and the fields were hand-edited
      // instead of dragged/clicked.
      if (pinPlacementMarker) {
        const lat = Number($('field-lat').value);
        const lng = Number($('field-lng').value);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          pinPlacementMarker.setLatLng([lat, lng]);
          pinPlacementMap.panTo([lat, lng]);
        }
      }
    });
  });
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
  const actionsHtml = entry.status === 'missing'
    ? `<button type="button" class="btn secondary btn-small" data-add>Add photo</button>`
    : `<button type="button" class="btn danger btn-small" data-remove="${escapeHtml(entry.slug)}">Remove</button>`;
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
      <div class="entry-actions">${actionsHtml}</div>
    </div>
    <div class="preview" hidden></div>
    <div class="replace-widget" hidden></div>
  `;

  // The name/city only reads as a link — and only opens a preview — when
  // there's actually a photo behind it; `disabled` above already keeps it
  // inert for a missing entry.
  if (entry.status !== 'missing') {
    li.querySelector('.who-btn').addEventListener('click', () => {
      const preview = li.querySelector('.preview');
      if (!preview.hidden) { preview.hidden = true; return; }
      if (!preview.dataset.loaded) {
        preview.innerHTML = `<img src="${escapeHtml(entry.dims.url)}" alt="">`;
        preview.dataset.loaded = '1';
        preview.querySelector('img').addEventListener('click', () => { preview.hidden = true; });
      }
      preview.hidden = false;
    });
    li.querySelector('[data-remove]').addEventListener('click', () => removePhoto(entry, li));
  } else {
    li.querySelector('[data-add]').addEventListener('click', () => openAddPhotoWidget(entry, li));
  }

  return li;
}

// Only reachable for a missing entry — to change an existing photo,
// Remove it first and a fresh Add photo button takes its place.
function openAddPhotoWidget(entry, li) {
  const replaceWidget = li.querySelector('.replace-widget');
  replaceWidget.hidden = false;
  createPhotoWidget(replaceWidget, {
    kind: entry.kind,
    getSlugParts: () => (entry.kind === 'staff' ? { kind: 'staff', name: entry.name } : { kind: 'city', city: entry.city, country: entry.country }),
    initialUrl: null,
    initialSlug: entry.slug,
    // Swap straight from the just-uploaded blob rather than reloading —
    // reloading re-measures every image over the network, including this
    // one from the repo it was just written to, which can still 404 during
    // GitHub's brief read-after-write lag and flip the row back to Missing.
    onUploaded: (path, measured) => {
      entry.dims = measured;
      entry.status = classify(entry.kind, measured);
      const newLi = imageEntryRow(entry);
      li.replaceWith(newLi);
      // Land straight on the preview instead of making them click the name
      // again to confirm the photo they just watched upload actually took.
      if (entry.status !== 'missing') newLi.querySelector('.who-btn').click();
    },
  });
}

async function removePhoto(entry, li) {
  if (!window.confirm(`Remove this photo? This deletes it from the live site.`)) return;
  try {
    await apiFetch(`/photos/${encodeURIComponent(entry.slug)}`, { method: 'DELETE' });
    entry.dims = null;
    entry.status = 'missing';
    li.replaceWith(imageEntryRow(entry));
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
    const divisionColor = DIVISIONS[divisionKey].pin;
    divisionEl.innerHTML = `<h2 class="division" style="color: ${divisionColor}; border-bottom-color: ${divisionColor};">${escapeHtml(DIVISIONS[divisionKey].label)}</h2>`;

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
