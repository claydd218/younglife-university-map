// ---------------------------------------------------------------------------
// Admin CMS — Ministries CRUD + Images (photo health/upload/remove) tabs.
// Talks only to /bigtime/api/* (JSON in/out) — never reads/writes CSV itself.
// Every write there is a real GitHub commit; this page just calls the API.
// Uses slugify/parseParenList/lastNameOf/flagEmoji from ../js/utils.js and
// DIVISIONS from ../js/config.js, loaded as plain <script> tags before this
// file (see index.html) — same convention as admin/imagecheck.html used to.
// ---------------------------------------------------------------------------

const API_BASE = '/bigtime/api';

// Recommended minimum photo dimensions, used by both the Images tab's
// classification and its guidance banner text — one source of truth so
// they can't drift apart. See index.html's .guidance block for where
// this is rendered.
const PHOTO_MINIMUMS = {
  staff: { width: 400, height: 400, label: 'Profile photos', detail: 'at least 400×400px, square' },
  city: { width: 1200, height: 900, label: 'Banner (city) photos', detail: 'at least 1200×900px (4:3)' },
};

const state = {
  rows: [],
  sha: null,
  divisionByCountry: new Map(),
  editingId: null, // null while adding, otherwise the id being edited
  dialogDirty: false, // edit mode only — see markDialogDirty/updateDialogButtons
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

// --- Deploy status toast -----------------------------------------------

// Confirms a save isn't just committed to git but actually live — polls a
// small public marker file (worker/lib/deployVersion.js) on the deployed
// site until it reflects the token the just-completed write's response
// came back with. Only the *latest* token is ever tracked: a newer save
// made while an older one is still publishing simply replaces the target,
// since once the live site catches up to the newer token the earlier
// change (committed first) is necessarily live too — no need to track
// multiple in-flight saves separately.
const DEPLOY_VERSION_URL = '../data/deploy-version.txt';
const DEPLOY_POLL_MS = 3000;
const DEPLOY_POLL_MAX_ATTEMPTS = 40; // ~2 minutes, then give up quietly

let deployTarget = null;
let deployPollTimer = null;
let deployPollAttempts = 0;

// token is null when the server-side bump itself failed (see
// bumpDeployVersion's own comment) — the save still succeeded, there's
// just nothing to poll for, so this is a no-op rather than showing a
// toast that would never resolve.
function trackDeployVersion(token) {
  if (!token) return;
  deployTarget = token;
  deployPollAttempts = 0;
  showDeployToast('Publishing changes…', false);
  if (!deployPollTimer) pollDeployVersion();
}

async function pollDeployVersion() {
  deployPollTimer = null;
  if (!deployTarget) return; // dismissed since this was scheduled
  deployPollAttempts++;
  try {
    const res = await fetch(DEPLOY_VERSION_URL, { cache: 'no-store' });
    if (res.ok) {
      const live = (await res.text()).trim();
      if (live === deployTarget) {
        showDeployToast('Changes are live', true);
        deployTarget = null;
        setTimeout(hideDeployToast, 3000);
        return;
      }
    }
  } catch {
    // Network hiccup — just retry on the next tick rather than surfacing
    // it; this status check is a nicety, not something worth alarming
    // over when the actual save already succeeded.
  }
  if (deployPollAttempts >= DEPLOY_POLL_MAX_ATTEMPTS) {
    hideDeployToast();
    deployTarget = null;
    return;
  }
  deployPollTimer = setTimeout(pollDeployVersion, DEPLOY_POLL_MS);
}

function showDeployToast(text, done) {
  const toast = $('deploy-toast');
  toast.classList.toggle('done', done);
  $('deploy-toast-text').textContent = text;
  toast.hidden = false;
}

function hideDeployToast() {
  $('deploy-toast').hidden = true;
}

// Dismissing stops polling outright rather than just hiding the toast —
// once the user's stopped watching for it, there's no value in silently
// confirming a fact nobody's waiting on anymore.
function wireDeployToast() {
  $('deploy-toast-dismiss').addEventListener('click', () => {
    deployTarget = null;
    if (deployPollTimer) { clearTimeout(deployPollTimer); deployPollTimer = null; }
    hideDeployToast();
  });
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
      { label: 'Reload Latest Data', onClick: () => { hideBanner(); retryReload(); } },
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
// to a size/quality-capped JPEG or WebP before it's ever base64'd and sent.
// City (ministry) photos go to WebP for the real size win — they have no
// extension-guessing to stay compatible with (the exact filename is stored
// in ministries.csv), unlike staff photos, which CONFIG.IMAGE_EXTENSIONS on
// the public site finds by trying each extension in turn against the slug;
// switching staff output would just add a failed guess in that chain for no
// benefit until/unless that guessing logic changes too. Mirrors the
// server's own STAFF_OUTPUT_EXT/CITY_OUTPUT_EXT split (worker/routes/upload.js).
// Shared by reencodeImage and the staff-photo crop dialog — loads any
// image (including iPhone HEIC — see createImageBitmap's WebKit HEIC
// decode, which every iOS browser uses regardless of vendor) into
// something both a canvas and the crop dialog can draw from directly.
async function loadImageBitmap(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    // Fallback path for engines without createImageBitmap support.
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
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
}

async function reencodeImage(file, kind) {
  const mime = kind === 'city' ? 'image/webp' : 'image/jpeg';
  const bitmap = await loadImageBitmap(file);

  // The public lightbox (css/style.css's .lightbox-viewport) caps photos
  // at 900px CSS height — on a 2x/retina display that's ~1800px of real
  // detail wanted on the short edge. 2400 on the long edge covers that
  // for most aspect ratios without going much past what's actually used.
  const MAX_DIM = 2400;
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);

  // Scaled up roughly with MAX_DIM's ~2.25x more pixels (1600 -> 2400),
  // so the extra resolution isn't immediately squeezed back out by the
  // same compression budget it had before.
  const TARGET_BYTES = 1.5 * 1024 * 1024;
  let encodeMime = mime;
  let quality = 0.82;
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, encodeMime, quality));
  // Safari doesn't support WebP encoding via canvas.toBlob and silently
  // substitutes PNG instead of erroring or honoring the requested type —
  // canvas.toBlob's spec-defined behavior for an unsupported type is to
  // fall back to PNG with no signal that anything was substituted. PNG is
  // also lossless, so the quality-based shrink loop below would do
  // nothing and leave a multi-MB file mislabeled with a .webp extension
  // once uploaded. Falling back to JPEG here — universally supported, and
  // it actually responds to the quality parameter — catches that instead.
  if (blob.type !== encodeMime && encodeMime === 'image/webp') {
    encodeMime = 'image/jpeg';
    blob = await new Promise((resolve) => canvas.toBlob(resolve, encodeMime, quality));
  }
  for (let i = 0; i < 3 && blob.size > TARGET_BYTES; i++) {
    quality -= 0.15;
    blob = await new Promise((resolve) => canvas.toBlob(resolve, encodeMime, quality));
  }
  return blob;
}

// Staff photos render everywhere as a fixed circular avatar (public site,
// reports, this tool's own thumbnails) — object-fit:cover picks whatever
// the browser happens to center on, which for a non-square source (most
// real photos) often isn't the person's face. This lets the admin choose
// that framing themselves before it's ever uploaded, instead of after the
// fact by re-cropping and re-uploading a file externally.
//
// Resolves to a cropped, square JPEG Blob, or null if the admin cancelled
// (the caller should leave the existing photo/upload untouched in that
// case). Only wired into the staff-photo path (createPhotoWidget's
// handleFile) — ministry/city photos keep their existing object-fit:cover
// framing in a 220x165 box, a different problem (multiple photos, 4:3-ish
// aspect) this dialog wasn't built for.
//
// Pan is drag (mouse or single-finger touch, via Pointer Events — one
// handler for both). Zoom is the slider only, not pinch-gesture or scroll
// — a second input method would duplicate what the slider already covers
// for a single-image crop, not add real capability.
function openCropDialog(file) {
  return new Promise((resolve, reject) => {
    const dialog = $('crop-photo-dialog');
    const viewport = $('crop-viewport');
    const canvas = $('crop-canvas');
    const slider = $('crop-zoom-slider');
    const ctx = canvas.getContext('2d');
    const VIEW_SIZE = 320; // matches .crop-viewport's CSS width/height
    const OUTPUT_SIZE = 800; // 2x PHOTO_MINIMUMS.staff, comfortable headroom

    canvas.width = VIEW_SIZE;
    canvas.height = VIEW_SIZE;

    let bitmap;
    let scale = 1;
    let minScale = 1;
    let offsetX = 0;
    let offsetY = 0;

    function draw() {
      ctx.clearRect(0, 0, VIEW_SIZE, VIEW_SIZE);
      ctx.drawImage(bitmap, offsetX, offsetY, bitmap.width * scale, bitmap.height * scale);
    }

    // Keeps the image covering the whole viewport at every pan position —
    // offset can range from (viewport - scaledImageSize) up to 0, in each
    // axis, so a drag can never pull a gap in past the image's own edge.
    function clampOffsets() {
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      offsetX = Math.min(0, Math.max(VIEW_SIZE - w, offsetX));
      offsetY = Math.min(0, Math.max(VIEW_SIZE - h, offsetY));
    }

    function onZoomInput() {
      const zoomFactor = parseFloat(slider.value);
      const newScale = minScale * zoomFactor;
      // Zoom toward the viewport's own center rather than the image's
      // top-left corner, so moving the slider doesn't also yank whatever
      // was centered out of frame.
      const cx = VIEW_SIZE / 2;
      const cy = VIEW_SIZE / 2;
      const imgX = (cx - offsetX) / scale;
      const imgY = (cy - offsetY) / scale;
      scale = newScale;
      offsetX = cx - imgX * scale;
      offsetY = cy - imgY * scale;
      clampOffsets();
      draw();
    }

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    function onPointerDown(e) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      viewport.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e) {
      if (!dragging) return;
      offsetX += e.clientX - lastX;
      offsetY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      clampOffsets();
      draw();
    }
    function onPointerUp(e) {
      dragging = false;
      viewport.releasePointerCapture(e.pointerId);
    }

    function cleanup() {
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', onPointerUp);
      slider.removeEventListener('input', onZoomInput);
      cancelBtn.removeEventListener('click', onCancel);
      saveBtn.removeEventListener('click', onSave);
    }
    function onCancel() {
      cleanup();
      dialog.close();
      resolve(null);
    }
    function onSave() {
      // Never claim more detail than the current crop actually has —
      // capping at a flat OUTPUT_SIZE regardless of zoom meant a heavily
      // zoomed-in (or just low-res to start with) crop got upscaled to
      // fill 800x800 anyway, so the saved file's own dimensions always
      // read as "good" even though the visible content was still blurry.
      // VIEW_SIZE / scale is how many real source pixels the viewport's
      // current crop/zoom actually covers per axis — output at that,
      // capped at OUTPUT_SIZE, so a genuinely low-detail crop saves (and
      // is measured, and flagged Low by the existing classify() below) at
      // its real resolution instead of a dishonestly upscaled one.
      const capturedSourcePixels = VIEW_SIZE / scale;
      const outputSize = Math.max(1, Math.min(OUTPUT_SIZE, Math.round(capturedSourcePixels)));
      const outCanvas = document.createElement('canvas');
      outCanvas.width = outputSize;
      outCanvas.height = outputSize;
      const outScale = outputSize / VIEW_SIZE;
      outCanvas.getContext('2d').drawImage(
        bitmap,
        offsetX * outScale, offsetY * outScale,
        bitmap.width * scale * outScale, bitmap.height * scale * outScale,
      );
      outCanvas.toBlob((blob) => {
        cleanup();
        dialog.close();
        resolve(blob);
      }, 'image/jpeg', 0.9);
    }

    const cancelBtn = $('crop-photo-cancel-btn');
    const saveBtn = $('crop-photo-save-btn');

    loadImageBitmap(file).then((loaded) => {
      bitmap = loaded;
      // Covers the full square viewport with no letterboxing at the
      // smallest allowed zoom — anything less would show background
      // through a gap on one axis.
      minScale = Math.max(VIEW_SIZE / bitmap.width, VIEW_SIZE / bitmap.height);
      scale = minScale;
      offsetX = (VIEW_SIZE - bitmap.width * scale) / 2;
      offsetY = (VIEW_SIZE - bitmap.height * scale) / 2;
      slider.value = '1';
      draw();

      viewport.addEventListener('pointerdown', onPointerDown);
      viewport.addEventListener('pointermove', onPointerMove);
      viewport.addEventListener('pointerup', onPointerUp);
      slider.addEventListener('input', onZoomInput);
      cancelBtn.addEventListener('click', onCancel);
      saveBtn.addEventListener('click', onSave);

      dialog.showModal();
    }).catch(reject);
  });
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

  // Column 1: the photo itself. Reassigned (not const) the first time a
  // placeholder becomes a real photo — see uploadSourceFile below, which
  // swaps the DOM node via replaceWith() and has to repoint this at the
  // new element too, or every later reference here (including a second
  // upload's own replaceWith call) would still target the first swap's
  // now-parentless, detached placeholder — a real bug found while adding
  // the click-to-recrop handler below, which specifically invites more
  // than one upload in a single widget session.
  let thumb = initialUrl
    ? Object.assign(document.createElement('img'), { className: kind === 'staff' ? 'photo-thumb photo-thumb-editable' : 'photo-thumb', src: initialUrl })
    : Object.assign(document.createElement('div'), { className: 'photo-placeholder' });
  const thumbCol = document.createElement('div');
  thumbCol.className = 'photo-col-thumb';
  thumbCol.appendChild(thumb);

  // Column 2: resolution / recommendation, one per row.
  const dims = document.createElement('div');
  dims.className = 'dims';
  const hint = document.createElement('div');
  hint.className = 'photo-hint';
  hint.hidden = true;
  const infoCol = document.createElement('div');
  infoCol.className = 'photo-col-info';
  infoCol.append(dims, hint);

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

  // Staff photos: clicking an existing one re-opens the same crop dialog
  // an upload goes through, instead of just showing a bigger version — the
  // framing choice they made at upload time (or the browser's own
  // uncontrollable object-fit:cover guess, for anything uploaded before
  // this dialog existed) isn't a one-time, unrevisitable decision. Every
  // other kind (a ministry/city photo, or a placeholder with no photo
  // yet) keeps the plain toggle-a-larger-preview behavior below.
  thumbCol.addEventListener('click', async (e) => {
    const img = e.target.closest('img.photo-thumb');
    if (!img) return;
    if (kind === 'staff') {
      const parts = getSlugParts();
      if (!parts) {
        setReplaceStatus(missingFieldsMessage(kind), 'error');
        return;
      }
      const existingBlob = await (await fetch(img.src)).blob();
      const cropped = await openCropDialog(existingBlob);
      if (!cropped) return; // cancelled — leave the existing photo alone
      await uploadSourceFile(cropped, parts);
      return;
    }
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

  async function refreshInfo(url) {
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

  refreshInfo(initialUrl);

  // Shared by handleFile (a newly picked/dropped file) and the
  // click-to-recrop handler above (re-cropping whatever's already
  // uploaded) — everything past "we have a source image and know where
  // it goes" is identical either way.
  async function uploadSourceFile(sourceFile, parts) {
    setReplaceStatus('Uploading…', 'uploading');
    try {
      const jpeg = await reencodeImage(sourceFile, kind);
      const imageBase64 = await blobToBase64(jpeg);
      const result = await apiFetch('/upload', {
        method: 'POST',
        body: JSON.stringify({ ...parts, imageBase64 }),
      });
      trackDeployVersion(result.deployVersion);
      const objectUrl = URL.createObjectURL(jpeg);
      thumb.src = objectUrl;
      if (thumb.tagName !== 'IMG') {
        const img = Object.assign(document.createElement('img'), {
          className: kind === 'staff' ? 'photo-thumb photo-thumb-editable' : 'photo-thumb',
          src: thumb.src,
        });
        thumb.replaceWith(img);
        thumb = img;
      }
      setReplaceStatus('');
      zoomRow.hidden = true;
      photoSlug = slugFromParts(parts);
      const measured = await refreshInfo(objectUrl);
      // Pass the just-measured local blob, not a URL the caller would have
      // to re-fetch from the repo — GitHub's Contents API has a brief
      // read-after-write lag, so an immediate re-fetch can still 404.
      if (onUploaded) onUploaded(result.path, measured);
    } catch (err) {
      setReplaceStatus(`Upload failed: ${err.message || err}`, 'error');
    }
  }

  async function handleFile(file) {
    if (!file) return;
    const parts = getSlugParts();
    if (!parts) {
      setReplaceStatus(missingFieldsMessage(kind), 'error');
      return;
    }
    let sourceFile = file;
    if (kind === 'staff') {
      const cropped = await openCropDialog(file);
      if (!cropped) return; // cancelled — leave the existing photo alone
      sourceFile = cropped;
    }
    await uploadSourceFile(sourceFile, parts);
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

// --- Ministry photos (multi-photo manager) ----------------------------------
// A ministry can have several photos; unlike the single-photo staff/legacy
// widget above, each upload here adds a new file rather than replacing one
// (see worker/routes/upload.js's kind==='city' branch). currentMinistryPhotos
// is the ordered list of filenames for whichever ministry the dialog is
// currently open on — first entry is the "main" photo shown on the public
// map popup; the rest are only visible in that popup's photo carousel.

let currentMinistryPhotos = [];
// filename -> local blob URL, for photos uploaded earlier in this same
// dialog session. GitHub's Contents API has a brief read-after-write lag,
// so fetching a just-uploaded file straight from its repo URL can 404 for
// a few seconds — showing the blob we already have instead avoids that
// broken-thumbnail flash. Existing photos loaded from a saved ministry
// have no blob here and fall back to the repo URL, which is fine since
// they've been committed for a while.
let ministryPhotoBlobUrls = {};

function ministryPhotoUrl(filename) {
  return `../${CONFIG.IMAGES_DIR}${filename}`;
}

function renderMinistryPhotos() {
  const container = $('ministry-photos');
  container.innerHTML = '';
  if (currentMinistryPhotos.length === 0) {
    container.innerHTML = '<div class="ministry-photo-empty">No photos yet.</div>';
    return;
  }

  currentMinistryPhotos.forEach((filename, index) => {
    const item = document.createElement('div');
    item.className = 'ministry-photo-item';

    const img = document.createElement('img');
    img.src = ministryPhotoBlobUrls[filename] || ministryPhotoUrl(filename);
    img.alt = '';

    const infoCol = document.createElement('div');
    infoCol.className = 'photo-col-info';
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'ministry-photo-main-badge';
      badge.textContent = 'Main photo';
      infoCol.appendChild(badge);
    }

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn secondary btn-small';
    upBtn.textContent = '↑';
    upBtn.title = 'Move earlier';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      [currentMinistryPhotos[index - 1], currentMinistryPhotos[index]] =
        [currentMinistryPhotos[index], currentMinistryPhotos[index - 1]];
      renderMinistryPhotos();
      markDialogDirty();
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn secondary btn-small';
    downBtn.textContent = '↓';
    downBtn.title = 'Move later';
    downBtn.disabled = index === currentMinistryPhotos.length - 1;
    downBtn.addEventListener('click', () => {
      [currentMinistryPhotos[index + 1], currentMinistryPhotos[index]] =
        [currentMinistryPhotos[index], currentMinistryPhotos[index + 1]];
      renderMinistryPhotos();
      markDialogDirty();
    });

    const reorderRow = document.createElement('div');
    reorderRow.className = 'ministry-photo-reorder';
    reorderRow.append(upBtn, downBtn);

    const actionsCol = document.createElement('div');
    actionsCol.className = 'ministry-photo-actions';
    actionsCol.appendChild(reorderRow);
    // Removal happens immediately (unlike a staff/university row) because
    // the photo is already a committed file on disk the moment it's
    // uploaded — there's no pending/discardable draft state for it, same
    // as the Images tab's Remove action.
    actionsCol.appendChild(makeRemoveButton({
      danger: true,
      confirmMessage: 'Remove this photo? This deletes it from the live site.',
      onRemove: async () => {
        try {
          const result = await apiFetch(`/photos/${encodeURIComponent(filename.replace(/\.[^.]+$/, ''))}`, { method: 'DELETE' });
          trackDeployVersion(result.deployVersion);
          if (ministryPhotoBlobUrls[filename]) {
            URL.revokeObjectURL(ministryPhotoBlobUrls[filename]);
            delete ministryPhotoBlobUrls[filename];
          }
          currentMinistryPhotos.splice(index, 1);
          renderMinistryPhotos();
        } catch (err) {
          handleWriteError(err, loadMinistries);
        }
      },
    }));

    item.append(img, infoCol, actionsCol);
    container.appendChild(item);
  });
}

// Uploads are sequential (awaited one at a time), not parallel — each
// upload adds a new numbered file (slug-1, slug-2, ...) computed
// server-side from what's already on disk at request time, so firing them
// concurrently risks two uploads racing to the same number. A failure
// partway through still keeps whatever uploaded before it rather than
// losing the whole batch.
async function handleAddMinistryPhotos(files) {
  if (!files || !files.length) return;
  const city = $('field-city').value.trim();
  const country = $('field-country').value.trim();
  if (!city || !country) {
    showBanner('error', 'Fill in the City and Country first, then add a photo.');
    return;
  }
  const addBtn = $('add-ministry-photo-btn');
  addBtn.disabled = true;
  try {
    for (let i = 0; i < files.length; i++) {
      addBtn.textContent = files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…';
      try {
        const jpeg = await reencodeImage(files[i], 'city');
        const imageBase64 = await blobToBase64(jpeg);
        const result = await apiFetch('/upload', {
          method: 'POST',
          body: JSON.stringify({ kind: 'city', city, country, imageBase64 }),
        });
        trackDeployVersion(result.deployVersion);
        ministryPhotoBlobUrls[result.filename] = URL.createObjectURL(jpeg);
        currentMinistryPhotos.push(result.filename);
        renderMinistryPhotos();
        markDialogDirty();
      } catch (err) {
        showBanner('error', `Upload failed (${files[i].name}): ${err.message || err}`);
      }
    }
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = '+ Add Photo(s)';
    $('ministry-photo-input').value = '';
  }
}

function wireMinistryPhotoAdd() {
  const dropzone = $('ministry-photos-dropzone');
  $('add-ministry-photo-btn').addEventListener('click', () => $('ministry-photo-input').click());
  $('ministry-photo-input').addEventListener('change', (e) => handleAddMinistryPhotos(Array.from(e.target.files)));
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    handleAddMinistryPhotos(Array.from(e.dataTransfer.files));
  });
}

// --- Video link --------------------------------------------------------

// Tracks whether the label field holds a real custom choice rather than
// the auto-generated default — set from openDialog() when loading a row,
// and updated live as the user types into the label field itself.
let videoLabelManuallyEdited = false;

function defaultVideoLabel() {
  return `Watch a ${$('field-city').value.trim()} Story`;
}

function updateVideoLabelVisibility() {
  $('video-label-row').hidden = !$('field-video-url').value.trim();
}

function wireVideoLinkFields() {
  const urlInput = $('field-video-url');
  const labelInput = $('field-video-label');

  urlInput.addEventListener('input', () => {
    updateVideoLabelVisibility();
    if (!videoLabelManuallyEdited) labelInput.value = defaultVideoLabel();
  });

  // Keeps "Watch a {City} Story" following a city rename, same as the
  // auto-fill above, as long as the label hasn't been hand-edited away
  // from it.
  $('field-city').addEventListener('input', () => {
    if (!videoLabelManuallyEdited && urlInput.value.trim()) labelInput.value = defaultVideoLabel();
  });

  // Clearing the field back to empty is treated as "give the default
  // back," not as a custom empty choice — there's no reasonable saved
  // state that means "a video with a blank link label."
  labelInput.addEventListener('input', () => {
    const value = labelInput.value.trim();
    videoLabelManuallyEdited = value !== '' && value !== defaultVideoLabel();
  });

  $('video-preview-btn').addEventListener('click', () => {
    const parsed = parseVideoEmbedUrl(urlInput.value.trim());
    if (!parsed) {
      validateVideoUrlInForm();
      return;
    }
    $('video-preview-embed').innerHTML = `<iframe src="${escapeHtml(parsed.embedUrl)}" title="Video preview" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    $('video-preview-dialog').showModal();
  });

  // Clearing the iframe (not just closing the dialog) stops playback —
  // an <iframe> keeps running in the background otherwise.
  $('video-preview-close-btn').addEventListener('click', () => {
    $('video-preview-embed').innerHTML = '';
    $('video-preview-dialog').close();
  });
}

// --- Ministries tab: table -------------------------------------------------

let ministriesSearch = '';

// City/country/staff-name substring match, case-insensitive — the same
// three fields the toolbar's placeholder advertises. Staff is checked by
// name only (not role), since role isn't what anyone searching for a
// specific ministry would type.
function matchesMinistriesSearch(row, query) {
  if (!query) return true;
  const haystack = [row.city, row.country, ...row.staff.map((s) => s.name)]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function wireMinistriesSearch() {
  const input = $('ministries-search');
  const clearBtn = $('ministries-search-clear');
  input.addEventListener('input', (e) => {
    ministriesSearch = e.target.value.trim().toLowerCase();
    clearBtn.hidden = !e.target.value;
    renderMinistriesTable();
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    ministriesSearch = '';
    clearBtn.hidden = true;
    input.focus();
    renderMinistriesTable();
  });
}

const RECENT_MS = 24 * 60 * 60 * 1000;

// updated_at is stamped server-side (rowFromBody) on every real write to a
// ministry row, including the target side of a staff Move, so this always
// reflects an actual edit rather than e.g. when the admin happened to load
// the page.
function isRecent(row) {
  if (!row.updated_at) return false;
  const editedMsAgo = Date.now() - new Date(row.updated_at).getTime();
  return editedMsAgo >= 0 && editedMsAgo < RECENT_MS;
}

// Each key narrows the list when on; all active filters combine with AND
// (e.g. Recent + No Staff shows only ministries that are both). Off by
// default so the list starts unfiltered.
let ministriesFilter = { recent: false, developing: false, noStaff: false, noUniversities: false, noMinistryPhoto: false, noBlurb: false };

function matchesMinistriesFilter(row) {
  if (ministriesFilter.recent && !isRecent(row)) return false;
  if (ministriesFilter.developing && !row.is_developing) return false;
  if (ministriesFilter.noStaff && row.staff.length !== 0) return false;
  if (ministriesFilter.noUniversities && row.universities.length !== 0) return false;
  if (ministriesFilter.noMinistryPhoto && row.photos.length !== 0) return false;
  if (ministriesFilter.noBlurb && row.blurb.trim() !== '') return false;
  return true;
}

function wireMinistriesFilterBar() {
  const bar = $('ministries-filter-bar');
  const defs = [
    { key: 'recent', status: 'recent', label: 'Recent' },
    { key: 'noStaff', status: 'no-staff', label: 'No Staff' },
    { key: 'noUniversities', status: 'no-universities', label: 'No Universities' },
    { key: 'noMinistryPhoto', status: 'no-ministry-photo', label: 'No Ministry Photo' },
    { key: 'noBlurb', status: 'no-blurb', label: 'No Blurb' },
    { key: 'developing', status: 'developing', label: 'Developing' },
  ];
  bar.innerHTML = defs.map((d) => `<button type="button" class="filter-toggle status-${d.status} ${ministriesFilter[d.key] ? 'on' : ''}" data-key="${d.key}">${d.label}</button>`).join('');
  bar.querySelectorAll('.filter-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      ministriesFilter[key] = !ministriesFilter[key];
      btn.classList.toggle('on', ministriesFilter[key]);
      renderMinistriesTable();
    });
  });
}

function renderMinistriesTable() {
  const container = $('ministries-report');
  container.innerHTML = '';

  const visibleRows = state.rows.filter((row) => matchesMinistriesSearch(row, ministriesSearch) && matchesMinistriesFilter(row));

  // Group by division (same key used to color the public map) so ministries
  // read the same way the Images tab already does. Rows whose country isn't
  // in country-divisions.csv still need to be reachable to fix, so they get
  // their own uncolored group rather than being silently dropped.
  const byDivision = new Map();
  const other = [];
  for (const row of visibleRows) {
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
    const sorted = group.rows.slice().sort((a, b) =>
      a.country.localeCompare(b.country) || a.city.localeCompare(b.city));
    const rowsHtml = sorted.map((row) => `
      <tr>
        <td>${escapeHtml(row.country)}</td>
        <td>${escapeHtml(row.city)}</td>
        <td>${row.staff.map((s) => escapeHtml(s.name)).join(', ') || '—'}</td>
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
          <tr><th>Country</th><th>City / Area</th><th>Staff</th><th></th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
    container.appendChild(section);
  }

  const filtered = Boolean(ministriesSearch) || Object.values(ministriesFilter).some(Boolean);

  if (filtered && !groups.length) {
    container.innerHTML = '<p class="status-text">No ministries match that search/filter.</p>';
  }

  $('ministries-count').textContent = filtered
    ? `${visibleRows.length} of ${state.rows.length} ministr${state.rows.length === 1 ? 'y' : 'ies'}`
    : `${state.rows.length} ministr${state.rows.length === 1 ? 'y' : 'ies'}`;

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
    trackDeployVersion(result.deployVersion);
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

// Shared by staff/university rows. Unlike the ministry photo carousel's
// reorder (which shuffles a plain array, currentMinistryPhotos), these
// swap actual DOM position — collectRepeatable() reads order straight
// from the live .repeatable-item children, so moving the element IS the
// reorder. No "main" badge here (unlike the first ministry photo) since
// neither list has a row that's meaningfully "the main one."
function makeReorderButtons(group, item) {
  const upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'btn secondary btn-small';
  upBtn.textContent = '↑';
  upBtn.title = 'Move earlier';
  upBtn.addEventListener('click', () => {
    const prev = item.previousElementSibling;
    if (!prev) return;
    group.insertBefore(item, prev);
    updateReorderButtonStates(group);
    markDialogDirty();
  });

  const downBtn = document.createElement('button');
  downBtn.type = 'button';
  downBtn.className = 'btn secondary btn-small';
  downBtn.textContent = '↓';
  downBtn.title = 'Move later';
  downBtn.addEventListener('click', () => {
    const next = item.nextElementSibling;
    if (!next) return;
    group.insertBefore(next, item);
    updateReorderButtonStates(group);
    markDialogDirty();
  });

  const row = document.createElement('div');
  row.className = 'repeatable-reorder';
  row.append(upBtn, downBtn);
  return row;
}

// Called after every add/remove/reorder — disables ↑ on whichever row is
// currently first and ↓ on whichever is currently last, recomputed fresh
// each time since a swap or removal changes who's at either end.
function updateReorderButtonStates(group) {
  const items = group.querySelectorAll('.repeatable-item');
  items.forEach((item, index) => {
    const buttons = item.querySelectorAll('.repeatable-reorder button');
    if (buttons[0]) buttons[0].disabled = index === 0;
    if (buttons[1]) buttons[1].disabled = index === items.length - 1;
  });
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
    markDialogDirty();
  });
  return btn;
}

function addStaffRow(prefill = {}) {
  const item = repeatableRow($('staff-group'), {
    nameLabel: 'Name', metaLabel: 'Role', metaPlaceholder: 'e.g. College Coordinator',
    name: prefill.name, meta: prefill.role,
  });
  const nameInput = item.querySelector('.row-name');
  const metaInput = item.querySelector('.row-meta');
  const photoWidget = document.createElement('div');
  photoWidget.className = 'photo-widget';
  item.appendChild(photoWidget);

  const moveBtn = document.createElement('button');
  moveBtn.type = 'button';
  moveBtn.className = 'btn secondary btn-small';
  moveBtn.textContent = 'Move…';
  moveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      showBanner('error', 'Fill in the staff member’s name before moving them.');
      return;
    }
    openMoveStaffDialog(name, metaInput.value.trim(), item);
  });

  const staffGroup = $('staff-group');
  item.appendChild(makeReorderButtons(staffGroup, item));

  const actionsRow = document.createElement('div');
  actionsRow.className = 'staff-row-actions';
  actionsRow.append(moveBtn, makeRemoveButton({
    danger: true,
    confirmMessage: 'Remove this staff member? This can’t be undone after you save the ministry.',
    onRemove: () => {
      item.remove();
      updateReorderButtonStates(staffGroup);
    },
  }));
  item.appendChild(actionsRow);
  updateReorderButtonStates(staffGroup);

  const slug = prefill.name ? slugify(prefill.name) : null;
  const wireWidget = (initialUrl) => createPhotoWidget(photoWidget, {
    kind: 'staff',
    getSlugParts: () => (nameInput.value.trim() ? { kind: 'staff', name: nameInput.value.trim() } : null),
    initialUrl,
    initialSlug: slug,
    onUploaded: markDialogDirty,
  });
  if (slug) {
    findExistingImageUrl(slug).then(wireWidget);
  } else {
    wireWidget(null);
  }
}

// --- Move staff to another ministry -----------------------------------

// { name, role, item } for whichever staff row's Move… was clicked —
// item is the DOM row so confirmMoveStaff can remove it once the target
// ministry's write succeeds.
let moveStaffContext = null;

function openMoveStaffDialog(name, role, item) {
  moveStaffContext = { name, role, item };
  const search = $('move-staff-search');
  search.value = '';
  renderMoveStaffList('');
  $('move-staff-dialog').showModal();
  search.focus();
}

function renderMoveStaffList(query) {
  const list = $('move-staff-list');
  const q = query.trim().toLowerCase();
  // The ministry currently open in the edit dialog isn't a valid move
  // target — moving a staff member "to" the ministry they're already on
  // doesn't mean anything.
  const candidates = state.rows
    .filter((r) => r.id !== state.editingId)
    .filter((r) => !q || `${r.city} ${r.country}`.toLowerCase().includes(q))
    .sort((a, b) => a.city.localeCompare(b.city));

  list.innerHTML = candidates.length
    ? candidates.map((r) => `<button type="button" class="move-staff-option" data-id="${escapeHtml(r.id)}">${escapeHtml(r.city)}, ${escapeHtml(r.country)}</button>`).join('')
    : '<p class="status-text">No ministries match that search.</p>';

  list.querySelectorAll('[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => confirmMoveStaff(btn.dataset.id));
  });
}

// Writes straight to the target ministry's last-known-saved data
// (state.rows), not the currently open form's draft — moving a staff
// member is its own self-contained action and shouldn't also commit
// whatever unrelated field edits happen to be sitting in the open dialog.
async function confirmMoveStaff(targetId) {
  const target = state.rows.find((r) => r.id === targetId);
  if (!target || !moveStaffContext) return;
  const { name, role, item } = moveStaffContext;
  if (!window.confirm(`Move ${name} to ${target.city}, ${target.country}?`)) return;

  $('move-staff-dialog').close();
  const newStaff = [...target.staff, { name, role }];
  const body = {
    sha: state.sha,
    city: target.city,
    country: target.country,
    lat: target.lat,
    lng: target.lng,
    date_opened: target.date_opened,
    is_developing: target.is_developing,
    blurb: target.blurb,
    staff: newStaff,
    universities: target.universities,
    photos: target.photos,
    video_url: target.video_url,
    video_label: target.video_label,
  };

  try {
    const result = await apiFetch(`/ministries/${encodeURIComponent(targetId)}`, { method: 'PUT', body: JSON.stringify(body) });
    state.sha = result.sha;
    trackDeployVersion(result.deployVersion);
    const targetIndex = state.rows.findIndex((r) => r.id === targetId);
    state.rows[targetIndex] = { ...target, staff: newStaff };
    item.remove();
    markDialogDirty();
  } catch (err) {
    handleWriteError(err, loadMinistries);
  } finally {
    moveStaffContext = null;
  }
}

function wireMoveStaffDialog() {
  $('move-staff-search').addEventListener('input', (e) => renderMoveStaffList(e.target.value));
  $('move-staff-cancel-btn').addEventListener('click', () => {
    moveStaffContext = null;
    $('move-staff-dialog').close();
  });
}

function addUniversityRow(prefill = {}) {
  const universitiesGroup = $('universities-group');
  const item = repeatableRow(universitiesGroup, {
    nameLabel: 'University', metaLabel: 'Year', metaPlaceholder: 'e.g. 2025',
    name: prefill.name, meta: prefill.year,
  });
  item.appendChild(makeReorderButtons(universitiesGroup, item));
  item.appendChild(makeRemoveButton({
    danger: true,
    confirmMessage: 'Remove this university? This can’t be undone after you save the ministry.',
    onRemove: () => {
      item.remove();
      updateReorderButtonStates(universitiesGroup);
    },
  }));
  updateReorderButtonStates(universitiesGroup);
}

function clearFieldErrors() {
  document.querySelectorAll('#ministry-dialog .field-error').forEach((el) => { el.hidden = true; el.textContent = ''; });
  $('country-error').hidden = true;
}

// Adding a new ministry keeps its unconditional Save/Cancel choice — there's
// no prior saved state to fall back to either way, so a single
// always-saving button would be ambiguous, and Cancel is always safe since
// nothing about a not-yet-created ministry has been saved.
// Editing an existing ministry instead starts on Cancel (untouched, so
// there's nothing to save) and switches to Update — permanently, for the
// rest of this dialog session — the moment anything changes. This also
// covers photo add/remove/reorder: those already commit to the repo the
// instant they happen (see the photo manager below), so once one has
// happened Cancel would otherwise leave the saved ministry row's photos
// list out of sync with what's actually on disk — flipping to Update
// closes that gap by making a save (which is what a photo action needs
// anyway) the only remaining way to leave the dialog.
function updateDialogButtons() {
  if (!state.editingId) {
    $('dialog-close-btn').hidden = false;
    $('dialog-close-btn').textContent = 'Save';
    $('dialog-cancel-btn').hidden = false;
    return;
  }
  const dirty = state.dialogDirty;
  $('dialog-close-btn').hidden = !dirty;
  $('dialog-close-btn').textContent = 'Update';
  $('dialog-cancel-btn').hidden = dirty;
}

function markDialogDirty() {
  if (state.dialogDirty) return;
  state.dialogDirty = true;
  updateDialogButtons();
}

function openDialog(row) {
  clearFieldErrors();
  state.editingId = row ? row.id : null;
  $('dialog-title').textContent = row ? `Edit ${row.city}, ${row.country}` : 'Add Ministry';

  $('field-city').value = row ? row.city : '';
  $('field-country').value = row ? row.country : '';
  updateCityCountryMatchNote();
  $('field-lat').value = row ? row.lat : '';
  $('field-lng').value = row ? row.lng : '';
  $('field-blurb').value = row ? row.blurb : '';
  $('field-is-developing').checked = row ? !!row.is_developing : false;
  $('field-video-url').value = row ? row.video_url : '';
  $('field-video-label').value = row ? row.video_label : '';
  // A loaded label that doesn't match what auto-fill would generate for
  // this city is a real custom choice (or came from a different city
  // before a rename) — either way, don't let city/URL edits silently
  // overwrite it going forward.
  videoLabelManuallyEdited = !!(row && row.video_label && row.video_label !== defaultVideoLabel());
  updateVideoLabelVisibility();
  setLatLngLookupStatus('');
  closePinPlacementMap();
  updatePinPlacementVisibility();

  state.dialogDirty = false;
  updateDialogButtons();
  updateSaveButtonState();

  $('staff-group').innerHTML = '';
  $('universities-group').innerHTML = '';
  if (row) {
    row.staff.forEach((s) => addStaffRow(s));
    row.universities.forEach((u) => addUniversityRow(u));
  }

  currentMinistryPhotos = row ? row.photos.slice() : [];
  // Deliberately not reset here (unlike currentMinistryPhotos) — it's a
  // session-lifetime cache keyed by filename, not per-dialog state. A photo
  // uploaded earlier this session still renders from its local blob
  // instead of the live site's path, which may not have redeployed the
  // new commit yet — without this, reopening a just-saved ministry showed
  // broken images until that deploy caught up (usually ~30s).
  renderMinistryPhotos();

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
// This is purely a display field now — the "Developing" checkbox is what
// actually drives the map's dot-vs-star marker shape, not this date.
function deriveDateOpened(universities) {
  const years = universities
    .map((u) => parseInt(u.year, 10))
    .filter((y) => Number.isInteger(y) && y > 1900 && y < 2200);
  return years.length ? String(Math.min(...years)) : '';
}

// Mirrors the server's assertNoParens rule for instant feedback — the
// Function re-validates regardless, this is just so a mistake shows up
// immediately instead of after a round-trip. Staff only: university
// name/year get parens silently stripped instead (see saveMinistry), not
// blocked, so there's nothing to flag here for those.
function validateNoParensInForm() {
  let ok = true;
  document.querySelectorAll('#staff-group .repeatable-item').forEach((item) => {
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

// Strips parens from a university name/year rather than blocking the save
// on them — mirrors worker/lib/text.js's stripParens so state.rows (updated
// from this same body after save, not re-fetched) matches what the server
// actually wrote instead of the raw typed value.
function stripParens(value) {
  return (value || '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

// Mirrors the server's own rejection (rowFromBody) for instant feedback —
// an empty field is fine (no video), a non-empty one has to actually parse.
function validateVideoUrlInForm() {
  const url = $('field-video-url').value.trim();
  const bad = url && !parseVideoEmbedUrl(url);
  $('video-url-error').hidden = !bad;
  $('video-url-error').textContent = bad ? 'Must be a YouTube or Vimeo link' : '';
  return !bad;
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
  const jpeg = await reencodeImage(sourceBlob, parts.kind);
  const imageBase64 = await blobToBase64(jpeg);
  await apiFetch('/upload', { method: 'POST', body: JSON.stringify({ ...parts, imageBase64 }) });
  await apiFetch(`/photos/${encodeURIComponent(oldSlug)}`, { method: 'DELETE' });
  widget.setPhotoSlug(newSlug);
}

// Same idea as reconcilePhotoWidget, but for the ministry's whole photo
// list: each filename embeds the slug it was uploaded under
// (slug-1.webp, slug-2.webp, ...), so a city/country edit can leave any of
// them stale. Checked (and fixed) individually rather than all-or-nothing,
// since photos added earlier in this same edit may already be current.
async function reconcileMinistryPhotos(city, country) {
  const newSlug = slugFromParts({ kind: 'city', city, country });
  for (let i = 0; i < currentMinistryPhotos.length; i++) {
    const filename = currentMinistryPhotos[i];
    const match = filename.match(/^(.*)-(\d+)\.[^.]+$/);
    const oldSlug = match ? match[1] : null;
    if (!oldSlug || oldSlug === newSlug) continue;
    const sourceBlob = await (await fetch(ministryPhotoUrl(filename), { cache: 'no-store' })).blob();
    const jpeg = await reencodeImage(sourceBlob, 'city');
    const imageBase64 = await blobToBase64(jpeg);
    const result = await apiFetch('/upload', { method: 'POST', body: JSON.stringify({ kind: 'city', city, country, imageBase64 }) });
    await apiFetch(`/photos/${encodeURIComponent(filename.replace(/\.[^.]+$/, ''))}`, { method: 'DELETE' });
    // Without this, a renamed photo has no cache entry at all (unlike a
    // freshly-uploaded one via handleAddMinistryPhotos) — reopening the
    // dialog would fall straight to the network path below and hit the
    // same deploy-lag broken-image window this whole change is about.
    ministryPhotoBlobUrls[result.filename] = URL.createObjectURL(jpeg);
    currentMinistryPhotos[i] = result.filename;
  }
}

async function reconcileAllPhotos() {
  for (const item of document.querySelectorAll('#staff-group .repeatable-item')) {
    const name = item.querySelector('.row-name').value.trim();
    if (!name) continue;
    await reconcilePhotoWidget(item.querySelector('.photo-widget')?.photoHandle, { kind: 'staff', name });
  }
  const city = $('field-city').value.trim();
  const country = $('field-country').value.trim();
  if (city && country && currentMinistryPhotos.length) {
    await reconcileMinistryPhotos(city, country);
  }
}

async function saveMinistry() {
  if (!validateNoParensInForm()) return;
  if (!validateVideoUrlInForm()) return;

  const universities = collectRepeatable($('universities-group'), 'name', 'year')
    .map(({ name, year }) => ({ name: stripParens(name), year: stripParens(year) }));
  const videoUrl = $('field-video-url').value.trim();
  const body = {
    sha: state.sha,
    city: $('field-city').value.trim(),
    country: $('field-country').value.trim(),
    lat: $('field-lat').value.trim(),
    lng: $('field-lng').value.trim(),
    date_opened: deriveDateOpened(universities),
    is_developing: $('field-is-developing').checked,
    blurb: $('field-blurb').value.trim(),
    video_url: videoUrl,
    // Same fallback the server applies — mirrored here (via
    // defaultVideoLabel, not a re-typed template) so state.rows (updated
    // from this body after save, not re-fetched) matches what actually
    // got written, same reasoning as stripParens above.
    video_label: videoUrl ? ($('field-video-label').value.trim() || defaultVideoLabel()) : '',
    staff: collectRepeatable($('staff-group'), 'name', 'role'),
    universities,
    // Reference, not a copy — reconcileAllPhotos() (called below, before
    // this body is stringified) may rewrite entries in place if the
    // city/country changed, and this needs to pick up that final state.
    photos: currentMinistryPhotos,
  };

  if (body.country && !state.divisionByCountry.has(body.country)) {
    $('country-error').hidden = false;
    $('country-error').textContent = `"${body.country}" isn't in country-divisions.csv — it won't be colored on the map. Check the spelling, or ask for it to be added.`;
    return;
  }

  const { sha: _staleSha, ...rowFields } = body;
  // Mirrors rowFromBody's server-side stamp (worker/lib/ministries.js) so
  // the locally-patched state.rows entry (updated from this request body,
  // not re-fetched) matches what the server actually wrote — otherwise
  // the new/edited row has no updated_at until the next full reload, and
  // silently drops out of the Recent filter until then.
  rowFields.updated_at = new Date().toISOString();

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
      trackDeployVersion(result.deployVersion);
    } else {
      const result = await apiFetch('/ministries', { method: 'POST', body: JSON.stringify(body) });
      state.rows.push({ id: result.id, ...rowFields });
      state.sha = result.sha;
      trackDeployVersion(result.deployVersion);
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
// Runs the lookup automatically every time City is blurred with both City
// and Country filled in — no button anymore, so there's no separate
// "deliberate re-run" trigger; a re-blur (typo fix, tabbing back through
// the field, picking a city suggestion) always re-runs it and overwrites
// lat/lng, including over a pin fine-tuned via Adjust Pin Placement.
function autoLookupLatLngOnBlur() {
  if (!$('field-city').value.trim() || !$('field-country').value.trim()) return;
  lookupLatLng();
}

async function lookupLatLng() {
  const city = $('field-city').value.trim();
  const country = $('field-country').value.trim();
  if (!city || !country) {
    setLatLngLookupStatus('Fill in City and Country first.', 'error');
    return;
  }
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
    setLatLngLookupStatus(
      approximate
        ? `No exact match for "${city}" — placed at the approximate center of ${country}. Use Adjust Pin Placement to fine-tune.`
        : `Found: ${result.display_name}`,
      approximate ? 'approximate' : 'match',
    );
    updateSaveButtonState();
    updatePinPlacementVisibility();
    markDialogDirty();
  } catch (err) {
    setLatLngLookupStatus(`Lookup failed: ${err.message || err}`, 'error');
  }
}

// City typed into the datalist doesn't have to be picked, it's just a
// suggestion — same "suggest, don't gate" philosophy as lookupLatLng's
// country-only fallback below. Scoped (strictly — see fetchCitySuggestions)
// to Country when it's already filled in, both for relevance (a bare
// "Springfield" query is otherwise a coin flip) and because that's the
// order user testing showed people naturally reach for; the query stays
// unscoped only if Country is empty or the city field gets filled in first.
//
// This uses Photon (photon.komoot.io, Komoot's free geocoder built on the
// same OSM data as Nominatim) rather than Nominatim itself — Nominatim's
// search requires a near-complete match and returns nothing for a partial
// prefix like "Bogo", which defeats live suggestions while typing. Photon
// is built for prefix/fuzzy search and handles it (and even tolerates a
// misspelled country, e.g. "Columbia" -> Colombia). lookupLatLng below
// stays on Nominatim since that's a discrete "look it up now" click on a
// (usually) complete city name, not live typing, where Nominatim works
// fine.
let citySuggestAbort = null;
let citySuggestTimer = null;

function wireCitySuggestions() {
  $('field-city').addEventListener('input', () => {
    clearTimeout(citySuggestTimer);
    const query = $('field-city').value.trim();
    if (query.length < 2) {
      $('city-list').innerHTML = '';
      return;
    }
    citySuggestTimer = setTimeout(() => fetchCitySuggestions(query), 350);
  });

  // Picking an option from the datalist fires 'change' but doesn't blur
  // the field on its own, so the dropdown (and the cursor sitting in it)
  // can linger until the admin clicks elsewhere. Blur it explicitly so
  // picking a suggestion visibly closes the popup.
  $('field-city').addEventListener('change', () => {
    clearTimeout(citySuggestTimer);
    $('field-city').blur();
  });
}

async function fetchCitySuggestions(query) {
  // Cancel any still-in-flight request from a prior keystroke — without
  // this, a slow early response can land after a faster later one and
  // clobber the datalist with stale suggestions.
  if (citySuggestAbort) citySuggestAbort.abort();
  citySuggestAbort = new AbortController();

  const country = $('field-country').value.trim();
  // Country is applied as a client-side filter, not folded into the query
  // text — appending it to `q` (e.g. "Bogo, Colombia") confused Photon's
  // relevance ranking on short/partial prefixes and dropped the actual
  // match (Bogotá) from the results entirely.
  //
  // osm_tag is repeated (not just 'place') to pin results to actual
  // populated-place levels — a bare 'place' tag also matches Photon's
  // state- and country-level entities (e.g. typing "Texas" or "Ukraine"
  // surfaced the state/country itself as a suggestion), which isn't ever
  // a valid City / Area value.
  const params = new URLSearchParams({ q: query, limit: '10', lang: 'en' });
  ['city', 'town', 'village', 'hamlet', 'locality', 'district', 'suburb']
    .forEach((t) => params.append('osm_tag', `place:${t}`));

  try {
    const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal: citySuggestAbort.signal });
    if (!res.ok) return;
    const data = await res.json();
    let results = (data.features || [])
      .map((f) => ({ name: f.properties?.name, country: f.properties?.country }))
      .filter((r) => r.name);

    if (country) {
      // Substring match, not equality — our country list uses formal
      // names ("United Republic of Tanzania", "The Bahamas") that don't
      // always match Photon's shorter ones ("Tanzania", "The Bahamas")
      // exactly. No fallback to the unfiltered list on a miss (there used
      // to be one) — that was letting other countries' cities leak into
      // the suggestions whenever the match failed, which defeats the
      // point of scoping to Country in the first place.
      const lower = country.toLowerCase();
      results = results.filter((r) => r.country
        && (lower.includes(r.country.toLowerCase()) || r.country.toLowerCase().includes(lower)));
    }

    const names = Array.from(new Set(results.map((r) => r.name))).slice(0, 6);
    $('city-list').innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">`).join('');
  } catch (err) {
    // Rate-limited/offline/aborted — the field still works for manual
    // typing either way, so this is silent aside from the console note.
    if (err.name !== 'AbortError') console.warn('City suggestion lookup failed:', err);
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
  $('pin-placement-btn').textContent = 'Adjust Pin Placement';
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
    markDialogDirty();
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

// Mirrors the exact-match check buildPopupHtml uses on the public site
// (row.city === row.country, no case-folding) — trimmed here only
// because these are live, still-being-typed-in field values rather than
// the already-trimmed values rowFromBody saves to the CSV.
function updateCityCountryMatchNote() {
  const city = $('field-city').value.trim();
  const country = $('field-country').value.trim();
  const matches = Boolean(city) && city === country;
  const note = $('city-country-match-note');
  note.hidden = !matches;
  if (matches) note.textContent = `City / Area and Country match exactly, so the public map will display as "${city}"`;
}

function wireDialog() {
  $('add-ministry-btn').addEventListener('click', () => openDialog(null));
  $('add-staff-btn').addEventListener('click', () => { addStaffRow(); markDialogDirty(); });
  $('add-university-btn').addEventListener('click', () => { addUniversityRow(); markDialogDirty(); });
  wireMinistryPhotoAdd();
  wireVideoLinkFields();
  $('field-city').addEventListener('blur', autoLookupLatLngOnBlur);
  $('pin-placement-btn').addEventListener('click', togglePinPlacementMap);
  $('dialog-close-btn').addEventListener('click', saveMinistry);
  $('dialog-cancel-btn').addEventListener('click', () => $('ministry-dialog').close());
  // Delegated rather than wired per-field: covers every text/number/
  // checkbox input, including staff/university rows added after the
  // dialog opened, without needing its own listener on each one.
  $('ministry-form').addEventListener('input', markDialogDirty);
  $('ministry-form').addEventListener('change', markDialogDirty);
  ['field-city', 'field-country', 'field-lat', 'field-lng'].forEach((id) => {
    $(id).addEventListener('input', updateSaveButtonState);
  });
  ['field-city', 'field-country'].forEach((id) => {
    $(id).addEventListener('input', updateCityCountryMatchNote);
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

// One entry per ministry area, not per photo — a ministry can have several
// photos (the Ministries tab's own photo manager is where those are
// actually added/removed/reordered, still true), but this tab's job is
// just to surface whether each area has a healthy one, so "0 photos" or
// "a referenced file that no longer resolves" (the exact class of bug
// that once hung report-pdf.js — see worker/routes/photo.js) both need to
// show up as Missing here, in the same good/low/missing filter as staff.
async function buildImagesData() {
  // division -> country -> { staff: [...], cities: [...] } — same shape
  // admin/imagecheck.html used to build from the ministries rows.
  const structure = new Map();
  for (const row of state.rows) {
    const divisionKey = state.divisionByCountry.get(row.country);
    if (!divisionKey) continue;
    if (!structure.has(divisionKey)) structure.set(divisionKey, new Map());
    const countryMap = structure.get(divisionKey);
    if (!countryMap.has(row.country)) countryMap.set(row.country, { staff: [], cities: [] });
    const bucket = countryMap.get(row.country);

    for (const s of row.staff) {
      bucket.staff.push({ kind: 'staff', label: s.name, role: s.role, city: row.city, name: s.name, slug: slugify(s.name) });
    }
    bucket.cities.push({
      kind: 'city',
      label: row.city,
      city: row.city,
      country: row.country,
      slug: slugify(`${row.city}-${row.country}`),
      photos: row.photos,
    });
  }

  const checks = [];
  for (const [, countryMap] of structure) {
    for (const [, bucket] of countryMap) {
      for (const entry of bucket.staff) {
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
      for (const entry of bucket.cities) {
        checks.push((async () => {
          if (!entry.photos.length) {
            entry.dims = null;
            entry.status = 'missing';
            return;
          }
          const measurements = await Promise.all(
            entry.photos.map((filename) => measureImage(`../${CONFIG.IMAGES_DIR}${encodeURIComponent(filename)}`))
          );
          // A referenced file that fails to load (deleted/renamed on disk
          // but still listed in the photos column) makes the whole area
          // Missing, same as having no photo at all — not just "one of
          // several is fine", since it's exactly the stale-reference case
          // this check exists to catch.
          if (measurements.some((m) => !m)) {
            entry.dims = null;
            entry.status = 'missing';
            return;
          }
          // The smallest photo stands in for the group, for both the
          // status and the dims shown/previewed — whichever one would
          // actually get flagged is the one worth looking at.
          entry.dims = measurements.reduce((worst, m) => (m.width * m.height < worst.width * worst.height ? m : worst));
          entry.status = classify(entry.kind, entry.dims);
        })());
      }
    }
  }
  await Promise.all(checks);
  return structure;
}

function renderGuidance() {
  $('images-guidance').innerHTML = `<strong>${escapeHtml(PHOTO_MINIMUMS.staff.label)}:</strong> ${escapeHtml(PHOTO_MINIMUMS.staff.detail)} `
    + `&nbsp;·&nbsp; <strong>${escapeHtml(PHOTO_MINIMUMS.city.label)}:</strong> ${escapeHtml(PHOTO_MINIMUMS.city.detail)} `
    + `&nbsp;·&nbsp; Ministry photos are added/removed from each ministry's own Edit dialog, not here.`;
}

function renderFilterBar() {
  const bar = $('images-filter-bar');
  const defs = [
    { key: 'good', label: 'Good' },
    { key: 'low', label: 'Low Resolution' },
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
  // A country (or whole division) whose every entry just got filtered out
  // above would otherwise still show its heading with nothing under it —
  // cascade the same hide up to each group once its own entries/countries
  // are known.
  document.querySelectorAll('#images-report .country-group').forEach((countryEl) => {
    const hasVisible = !!countryEl.querySelector('.entry:not(.hide-status)');
    countryEl.classList.toggle('hide-status', !hasVisible);
  });
  document.querySelectorAll('#images-report .division-group').forEach((divisionEl) => {
    const hasVisible = !!divisionEl.querySelector('.country-group:not(.hide-status)');
    divisionEl.classList.toggle('hide-status', !hasVisible);
  });
}

function imageEntryRow(entry) {
  const roleText = entry.kind === 'staff'
    ? (entry.role ? `${entry.role}, ${entry.city}` : entry.city)
    : entry.country;
  const dimsText = entry.dims ? `${entry.dims.width}×${entry.dims.height}` : '';
  const li = document.createElement('li');
  li.className = 'entry';
  li.dataset.status = entry.status;
  li.dataset.slug = entry.slug;
  // City entries are informational only here — actually adding/removing/
  // reordering a ministry's (possibly several) photos already has its own
  // proper UI in the Ministries tab's own photo manager; duplicating a
  // single-photo add/remove control here would just fight with it.
  const actionsHtml = entry.kind !== 'staff' ? '' : (
    entry.status === 'missing'
      ? `<button type="button" class="btn secondary btn-small" data-add>Add Photo</button>`
      : `<button type="button" class="btn danger btn-small" data-remove="${escapeHtml(entry.slug)}">Remove</button>`
  );
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
  }
  if (entry.kind === 'staff') {
    if (entry.status !== 'missing') {
      li.querySelector('[data-remove]').addEventListener('click', () => removePhoto(entry, li));
    } else {
      li.querySelector('[data-add]').addEventListener('click', () => openAddPhotoWidget(entry, li));
    }
  }

  return li;
}

// Only reachable for a missing entry — to change an existing photo,
// Remove it first and a fresh Add photo button takes its place.
function openAddPhotoWidget(entry, li) {
  const replaceWidget = li.querySelector('.replace-widget');
  replaceWidget.hidden = false;
  // Unlike the Ministries dialog's staff rows (see addStaffRow), this
  // container never got the .photo-widget class that actually draws the
  // dashed drop-zone box — createPhotoWidget fills it with content but
  // doesn't apply that class itself, so without this the widget rendered
  // with no visible box to drop a file onto.
  replaceWidget.classList.add('photo-widget');
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
    const result = await apiFetch(`/photos/${encodeURIComponent(entry.slug)}`, { method: 'DELETE' });
    trackDeployVersion(result.deployVersion);
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
    divisionEl.className = 'division-group';
    const divisionColor = DIVISIONS[divisionKey].pin;
    divisionEl.innerHTML = `<h2 class="division" style="color: ${divisionColor}; border-bottom-color: ${divisionColor};">${escapeHtml(DIVISIONS[divisionKey].label)}</h2>`;

    for (const country of countryNames) {
      const bucket = countryMap.get(country);
      const citiesSorted = bucket.cities.slice().sort((a, b) => a.city.localeCompare(b.city));
      const staffSorted = bucket.staff.slice().sort((a, b) => lastNameOf(a.name).localeCompare(lastNameOf(b.name)));
      const countryEl = document.createElement('div');
      countryEl.className = 'country-group';
      countryEl.innerHTML = `<h3 class="country">${escapeHtml(country)}</h3>`;
      const ul = document.createElement('ul');
      ul.className = 'entry-list';
      // City (area) photo first, its staff underneath — the area photo
      // represents the ministry itself, staff are individuals within it.
      for (const entry of [...citiesSorted, ...staffSorted]) {
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

function wireSignOut() {
  $('sign-out-btn').addEventListener('click', async () => {
    if (!window.confirm('Sign out?')) return;
    try {
      await fetch(`${API_BASE}/logout`, { method: 'POST' });
    } catch {
      // Nothing more useful to do client-side with a failed request here
      // — still send the user to the login page either way.
    }
    window.location.href = 'login.html';
  });
}

// --- init --------------------------------------------------------------

wireTabs();
wireDialog();
wireMinistriesSearch();
wireMinistriesFilterBar();
wireCitySuggestions();
wireDeployToast();
wireMoveStaffDialog();
wireSignOut();
loadMinistries();
