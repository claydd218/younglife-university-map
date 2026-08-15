// ---------------------------------------------------------------------------
// YoungLife International Ministries — map application
// See js/config.js to change data sources, divisions, and colors.
// ---------------------------------------------------------------------------

const DEFAULT_LAND_FILL = '#e4d4ae';
const DEFAULT_LAND_BORDER = '#8a7a5e';
const HIGHLIGHT_BORDER = '#3b2a1a';

const state = {
  countryDivisionByName: new Map(),
  countryIsoByName: new Map(), // country name -> ISO 3166-1 alpha-2, for flag emoji
  countriesWithVisiblePins: new Map(), // country name -> Set of divisions present
  geoLayer: null,
  clusterGroups: {}, // division key -> L.markerClusterGroup
  markersByCountry: new Map(), // country name -> [{ marker, row }]
};

const map = L.map('map', {
  center: CONFIG.MAP_CENTER,
  zoom: CONFIG.MAP_ZOOM,
  minZoom: CONFIG.MIN_ZOOM,
  maxZoom: CONFIG.MAX_ZOOM,
  zoomSnap: 0.25,
  zoomDelta: 1,
  worldCopyJump: true,
  zoomControl: false,
  attributionControl: false,
  // Leaflet's legacy touch "tap" shim (built for old browsers with a 300ms
  // click delay) can double-fire on modern iOS Safari — one event opens a
  // popup, a second reads as "tap elsewhere" and immediately closes it.
  // Safari hasn't needed the delay workaround in years, so this is safe
  // to turn off and lets real click/touch events handle taps instead.
  tap: false,
  // Popups normally fade in over a CSS transition. Measuring a popup's
  // position (for the header-clearance pan below) while that transition is
  // still running reads bogus in-progress coordinates, not its final
  // position — a likely source of the wildly-wrong pan distances seen on
  // iOS. Disabling it makes popup positioning immediate and synchronously
  // measurable the moment it opens.
  fadeAnimation: false,
});
const DirectoryControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd: function () {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const link = L.DomUtil.create('a', 'directory-control-link', container);
    link.href = '#';
    link.title = 'Browse countries';
    link.setAttribute('role', 'button');
    link.setAttribute('aria-label', 'Browse countries');
    link.innerHTML = `<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <line x1="10.3" y1="10.3" x2="15" y2="15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(link, 'click', L.DomEvent.stop);
    L.DomEvent.on(link, 'click', () => openDirectory());
    return container;
  },
});
// Leaflet inserts bottom-corner controls at the front of the stack, so the
// control added last ends up on top — add zoom first so ours lands above it.
L.control.zoom({ position: 'bottomright' }).addTo(map);
map.addControl(new DirectoryControl());

function showStatus(message, isError) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.hidden = false;
  el.classList.toggle('status-error', !!isError);
}
function hideStatus() {
  document.getElementById('status').hidden = true;
}

function fetchCsv(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: (err) => reject(err),
    });
  });
}

function fetchJson(url) {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
    return r.json();
  });
}

function normalizeCountryName(name) {
  return (name || '').trim();
}

// parseParenList, slugify, and initialsFor live in js/utils.js, shared with
// the admin tools.

function shapeMarkup(shape, color) {
  return `<span class="pin-shape pin-${shape}" style="--pin-color:${color}"></span>`;
}

// Builds an <img> that tries each of CONFIG.IMAGE_EXTENSIONS in turn (via
// window.__imgFallback, wired through onerror) and swaps itself for a
// generated initials/letter placeholder once every extension has failed.
function photoTag({ slug, altText, fallbackText, fallbackColor, imgClass, fallbackClass }) {
  const firstSrc = `${CONFIG.IMAGES_DIR}${slug}.${CONFIG.IMAGE_EXTENSIONS[0]}`;
  return `<img
    class="${imgClass}"
    src="${escapeHtml(firstSrc)}"
    alt="${escapeHtml(altText)}"
    data-slug="${escapeHtml(slug)}"
    data-ext-idx="0"
    data-fallback-text="${escapeHtml(fallbackText)}"
    data-fallback-color="${escapeHtml(fallbackColor)}"
    data-fallback-class="${escapeHtml(fallbackClass)}"
    onerror="window.__imgFallback(this)"
  >`;
}

window.__imgFallback = function (img) {
  const nextIdx = parseInt(img.dataset.extIdx, 10) + 1;
  if (nextIdx < CONFIG.IMAGE_EXTENSIONS.length) {
    img.dataset.extIdx = String(nextIdx);
    img.src = `${CONFIG.IMAGES_DIR}${img.dataset.slug}.${CONFIG.IMAGE_EXTENSIONS[nextIdx]}`;
    return;
  }
  const fallback = document.createElement('div');
  fallback.className = img.dataset.fallbackClass;
  fallback.style.setProperty('--fallback-color', img.dataset.fallbackColor);
  fallback.innerHTML = `<span>${img.dataset.fallbackText}</span>`;
  img.replaceWith(fallback);
};

// Placeholder rule until real ministry-stage data exists: anything opened
// within the last STAGE_CUTOFF_YEARS counts as "developing".
function computeStage(dateOpenedRaw) {
  const raw = (dateOpenedRaw || '').trim();
  if (!raw) return 'established';
  const parsed = Date.parse(raw);
  const openedDate = !Number.isNaN(parsed) ? new Date(parsed) : new Date(parseInt(raw, 10) || 0, 0, 1);
  if (Number.isNaN(openedDate.getTime())) return 'established';
  const years = (Date.now() - openedDate.getTime()) / (365.25 * 24 * 3600 * 1000);
  return years < STAGE_CUTOFF_YEARS ? 'developing' : 'established';
}

function markerIcon(divisionKey, stageKey) {
  const div = DIVISIONS[divisionKey];
  const stage = STAGES[stageKey];
  return L.divIcon({
    className: 'ministry-marker',
    html: shapeMarkup(stage.shape, div.pin),
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -10],
  });
}

function clusterIconFactory(divisionKey) {
  const div = DIVISIONS[divisionKey];
  return function (cluster) {
    const count = cluster.getChildCount();
    const size = count < 10 ? 34 : count < 50 ? 40 : 48;
    return L.divIcon({
      html: `<div class="cluster-badge" style="--cluster-color:${div.pin}; width:${size}px; height:${size}px;">${count}</div>`,
      className: 'ministry-cluster',
      iconSize: [size, size],
    });
  };
}

function buildPopupHtml(row, divisionKey) {
  const div = DIVISIONS[divisionKey];
  const flag = flagEmoji(state.countryIsoByName.get(normalizeCountryName(row.country)));

  const staff = parseParenList(row.staff);
  const staffHtml = staff.length
    ? `<ul class="popup-staff">${staff
        .map((s) => {
          const photo = photoTag({
            slug: slugify(s.name),
            altText: s.name,
            fallbackText: initialsFor(s.name),
            fallbackColor: div.country,
            imgClass: 'popup-staff-photo',
            fallbackClass: 'popup-staff-photo popup-staff-photo-fallback',
          });
          return `<li class="popup-staff-item">
            ${photo}
            <span class="popup-staff-text">
              <span class="staff-name">${escapeHtml(s.name)}</span>
              ${s.meta ? `<span class="staff-title">${escapeHtml(s.meta)}</span>` : ''}
            </span>
          </li>`;
        })
        .join('')}</ul>`
    : '';

  const universities = parseParenList(row.universities);
  const universitiesHtml = universities.length
    ? `<ul class="popup-universities">${universities
        .map((u) => `<li>${escapeHtml(u.name)}${u.meta ? ` <span class="university-year">— ${escapeHtml(u.meta)}</span>` : ''}</li>`)
        .join('')}</ul>`
    : '';

  const cityPhoto = photoTag({
    slug: `${slugify(row.city)}-${slugify(row.country)}`,
    altText: `${row.city} ministry photo`,
    fallbackText: row.city || '?',
    fallbackColor: div.country,
    imgClass: 'popup-photo',
    fallbackClass: 'popup-photo popup-photo-fallback',
  });

  return `
    <div class="popup-card">
      <div class="popup-body popup-header-body">
        <h3>${flag ? `${flag} ` : ''}${escapeHtml(row.city)}, ${escapeHtml(row.country)}</h3>
      </div>
      ${cityPhoto}
      ${row.blurb ? `<div class="popup-body popup-blurb-body"><p class="popup-blurb">${escapeHtml(row.blurb)}</p></div>` : ''}
      <div class="popup-body">
        ${staffHtml}
        ${universitiesHtml}
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function styleCountryFeature(feature) {
  const name = normalizeCountryName(feature.properties.name);
  const present = state.countriesWithVisiblePins.get(name);
  if (present && present.size) {
    const divisionKey = present.values().next().value;
    return {
      fillColor: DIVISIONS[divisionKey].country,
      fillOpacity: 0.85,
      color: HIGHLIGHT_BORDER,
      weight: 0.8,
    };
  }
  return {
    fillColor: DEFAULT_LAND_FILL,
    fillOpacity: 0.9,
    color: DEFAULT_LAND_BORDER,
    weight: 0.5,
  };
}

function addOceanLabels() {
  for (const ocean of OCEAN_LABELS) {
    const lines = ocean.name.split('\n').map(escapeHtml).join('<br>');
    L.marker([ocean.lat, ocean.lng], {
      icon: L.divIcon({
        className: 'ocean-label',
        html: `<span>${lines}</span>`,
        iconSize: [170, 40],
        iconAnchor: [85, 20],
      }),
      interactive: false,
      keyboard: false,
    }).addTo(map);
  }
}

function refreshCountryStyles() {
  if (!state.geoLayer) return;
  state.geoLayer.eachLayer((layer) => {
    layer.setStyle(styleCountryFeature(layer.feature));
  });
}

function recomputeCountriesWithVisiblePins(rows) {
  const result = new Map();
  for (const row of rows) {
    const countryName = normalizeCountryName(row.country);
    const divisionKey = state.countryDivisionByName.get(countryName);
    if (!divisionKey) continue;
    if (!result.has(countryName)) result.set(countryName, new Set());
    result.get(countryName).add(divisionKey);
  }
  state.countriesWithVisiblePins = result;
}

function buildLegend() {
  const list = document.getElementById('legend-divisions');
  list.innerHTML = '';
  for (const [, div] of Object.entries(DIVISIONS)) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="legend-division-row">
        <span class="color-swatch" style="background:${div.pin}"></span>
        <span class="legend-label">${escapeHtml(div.label)}</span>
      </span>
    `;
    list.appendChild(li);
  }

  const stageList = document.getElementById('legend-stages');
  stageList.innerHTML = '';
  for (const stage of Object.values(STAGES)) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="legend-stage-row">
        ${shapeMarkup(stage.shape, 'var(--ink)')}
        <span class="legend-label">${escapeHtml(stage.label)}</span>
      </span>
    `;
    stageList.appendChild(li);
  }
}

function buildCountryDirectory(ministryRows) {
  const byDivision = new Map(); // division key -> Map(country -> count)
  for (const row of ministryRows) {
    const countryName = normalizeCountryName(row.country);
    const divisionKey = state.countryDivisionByName.get(countryName);
    if (!divisionKey) continue;
    if (!byDivision.has(divisionKey)) byDivision.set(divisionKey, new Map());
    const countryCounts = byDivision.get(divisionKey);
    countryCounts.set(countryName, (countryCounts.get(countryName) || 0) + 1);
  }

  const container = document.getElementById('directory-list');
  container.innerHTML = '';

  for (const [divisionKey, div] of Object.entries(DIVISIONS)) {
    const countryCounts = byDivision.get(divisionKey);
    if (!countryCounts || !countryCounts.size) continue;

    const group = document.createElement('div');
    group.className = 'directory-group';
    group.innerHTML = `<h3 style="color:${div.pin}">${escapeHtml(div.label)}</h3>`;

    const ul = document.createElement('ul');
    const sortedCountries = Array.from(countryCounts.keys()).sort((a, b) => a.localeCompare(b));
    for (const countryName of sortedCountries) {
      const count = countryCounts.get(countryName);
      const flag = flagEmoji(state.countryIsoByName.get(countryName));
      const li = document.createElement('li');
      li.className = 'directory-item';
      li.dataset.country = countryName.toLowerCase();
      li.innerHTML = `<button type="button" class="directory-link" data-country="${escapeHtml(countryName)}">${flag ? `${flag} ` : ''}${escapeHtml(countryName)} <span class="directory-count">${count}</span></button>`;
      ul.appendChild(li);
    }
    group.appendChild(ul);
    container.appendChild(group);
  }

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.directory-link');
    if (!btn) return;
    const country = btn.dataset.country;
    closeDirectory();
    // On mobile, the on-screen keyboard (from the search input) is often
    // still open here, shrinking the visible viewport. Flying to the
    // country immediately would size the zoom/bounds for that shrunk
    // viewport, leaving the map looking over-zoomed once the keyboard
    // actually dismisses. Waiting for it to close, then re-measuring the
    // map container, keeps the zoom correct for the real, full viewport.
    setTimeout(() => {
      map.invalidateSize();
      flyToCountry(country);
    }, 300);
  });
}

function flyToCountry(countryName) {
  const entries = state.markersByCountry.get(countryName);
  if (!entries || !entries.length) return;

  if (entries.length === 1) {
    const { marker, row } = entries[0];
    const divisionKey = state.countryDivisionByName.get(normalizeCountryName(row.country));
    const group = state.clusterGroups[divisionKey];
    // The marker may still be bundled inside an unopened cluster, in which
    // case openPopup() silently no-ops until the group zooms it into view.
    if (group && typeof group.zoomToShowLayer === 'function') {
      group.zoomToShowLayer(marker, () => marker.openPopup());
    } else {
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 6));
      marker.openPopup();
    }
    return;
  }

  const latlngs = entries.map((e) => e.marker.getLatLng());
  map.fitBounds(L.latLngBounds(latlngs), { padding: [60, 60] });
}

function openDirectory() {
  document.getElementById('directory-modal').hidden = false;
  const search = document.getElementById('directory-search');
  search.value = '';
  filterDirectory('');
  search.focus();
}
function closeDirectory() {
  document.getElementById('directory-modal').hidden = true;
  const search = document.getElementById('directory-search');
  if (document.activeElement === search) search.blur();
}

function filterDirectory(query) {
  const q = query.trim().toLowerCase();
  const groups = document.querySelectorAll('#directory-list .directory-group');
  groups.forEach((group) => {
    let anyVisible = false;
    group.querySelectorAll('.directory-item').forEach((item) => {
      const match = !q || item.dataset.country.includes(q);
      item.hidden = !match;
      if (match) anyVisible = true;
    });
    group.hidden = !anyVisible;
  });
}

function wireLegendToggle() {
  const legend = document.getElementById('legend');
  const toggle = document.getElementById('legend-toggle');
  const swipeZone = document.getElementById('legend-swipe-zone');

  function setCollapsed(collapsed) {
    legend.classList.toggle('legend-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand legend' : 'Minimize legend');
  }

  // Start collapsed on every screen size so the legend doesn't cover the
  // map on first load.
  setCollapsed(true);

  toggle.addEventListener('click', () => {
    setCollapsed(!legend.classList.contains('legend-collapsed'));
  });

  const SWIPE_THRESHOLD = 24;
  const CAPTURE_THRESHOLD = 6;
  let startY = null;
  let pointerId = null;
  let captured = false;

  // Capture is deferred until real movement is seen — capturing immediately
  // on pointerdown suppresses the button's native click event even for a
  // simple tap, since the pointerup target gets redirected to this zone.
  swipeZone.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    pointerId = e.pointerId;
    captured = false;
  });
  swipeZone.addEventListener('pointermove', (e) => {
    if (startY == null || captured) return;
    if (Math.abs(e.clientY - startY) > CAPTURE_THRESHOLD) {
      captured = true;
      swipeZone.setPointerCapture(pointerId);
    }
  });
  swipeZone.addEventListener('pointerup', (e) => {
    if (startY == null) return;
    const deltaY = e.clientY - startY;
    if (deltaY > SWIPE_THRESHOLD) setCollapsed(true); // swiped down
    else if (deltaY < -SWIPE_THRESHOLD) setCollapsed(false); // swiped up
    startY = null;
    pointerId = null;
    captured = false;
  });
  swipeZone.addEventListener('pointercancel', () => { startY = null; pointerId = null; captured = false; });
}

function wireDirectoryControls() {
  document.getElementById('directory-close').addEventListener('click', closeDirectory);
  document.getElementById('directory-modal').addEventListener('click', (e) => {
    if (e.target.id === 'directory-modal') closeDirectory();
  });
  document.getElementById('directory-search').addEventListener('input', (e) => filterDirectory(e.target.value));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('directory-modal').hidden) closeDirectory();
  });
}

// Staff photos in popups are tiny (58px); this shows an enlarged version near
// the cursor on hover. Uses delegated listeners on `document` rather than
// binding per-photo, since popup content is created/destroyed by Leaflet on
// the fly. Rendered as one reused fixed-position element (see .photo-preview
// in style.css) instead of expanding the thumbnail in place, because
// .leaflet-popup-content clips overflow and would crop anything larger than
// the popup itself.
function wirePhotoPreview() {
  const preview = document.getElementById('photo-preview');
  const SIZE = 200;
  const GAP = 12;

  function show(img) {
    const rect = img.getBoundingClientRect();
    let left = rect.right + GAP;
    if (left + SIZE > window.innerWidth - 8) left = rect.left - GAP - SIZE;
    left = Math.max(8, Math.min(left, window.innerWidth - SIZE - 8));
    const top = Math.max(8, Math.min(
      rect.top + rect.height / 2 - SIZE / 2,
      window.innerHeight - SIZE - 8,
    ));
    preview.src = img.currentSrc || img.src;
    preview.style.left = `${left}px`;
    preview.style.top = `${top}px`;
    preview.classList.add('visible');
  }

  let activeImg = null;

  function hide() {
    preview.classList.remove('visible');
    activeImg = null;
  }

  document.addEventListener('mouseover', (e) => {
    const img = e.target.closest('img.popup-staff-photo');
    if (img) { show(img); activeImg = img; }
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('img.popup-staff-photo')) hide();
  });
  // iOS/touch has no hover, so a tap toggles the preview instead — show it
  // on first tap of a photo, hide on a second tap of the same photo or a
  // tap anywhere else (including the map underneath, since .photo-preview
  // has pointer-events: none and lets taps pass through to whatever's below).
  document.addEventListener('click', (e) => {
    const img = e.target.closest('img.popup-staff-photo');
    if (img) {
      e.stopPropagation();
      if (activeImg === img) hide();
      else { show(img); activeImg = img; }
      return;
    }
    hide();
  });
  map.on('popupclose', hide);
  map.on('movestart', hide);
}

async function init() {
  showStatus('Loading ministries…');
  try {
    const [countryGeo, divisionRows, ministryRows] = await Promise.all([
      fetchJson(CONFIG.COUNTRIES_GEOJSON_URL),
      fetchCsv(CONFIG.COUNTRY_DIVISIONS_CSV_URL),
      fetchCsv(CONFIG.MINISTRIES_CSV_URL),
    ]);

    for (const row of divisionRows) {
      const name = normalizeCountryName(row.country);
      const division = (row.division || '').trim();
      if (name && division) state.countryDivisionByName.set(name, division);
    }

    for (const feature of countryGeo.features) {
      const name = normalizeCountryName(feature.properties.name);
      const iso2 = feature.properties['ISO3166-1-Alpha-2'];
      if (name && iso2) state.countryIsoByName.set(name, iso2);
    }

    state.geoLayer = L.geoJSON(countryGeo, {
      style: styleCountryFeature,
      onEachFeature: (feature, layer) => {
        layer.bindTooltip(feature.properties.name, { sticky: true, className: 'country-tooltip' });
        layer.on('mouseover', () => layer.setStyle({ weight: 1.6 }));
        layer.on('mouseout', () => layer.setStyle(styleCountryFeature(feature)));
      },
    }).addTo(map);

    // Leaflet makes every interactive vector layer keyboard-focusable for
    // accessibility, which with ~258 countries turns Tab into a country-by-
    // country crawl. Strip the tab stop but leave hover/click untouched.
    state.geoLayer.eachLayer((layer) => {
      if (layer._path) layer._path.removeAttribute('tabindex');
    });

    addOceanLabels();

    for (const key of Object.keys(DIVISIONS)) {
      state.clusterGroups[key] = L.markerClusterGroup({
        iconCreateFunction: clusterIconFactory(key),
        maxClusterRadius: 55,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
      });
    }

    let placed = 0;
    const unmatchedCountries = new Set();

    for (const row of ministryRows) {
      const lat = parseFloat(row.lat);
      const lng = parseFloat(row.lng);
      if (Number.isNaN(lat) || Number.isNaN(lng)) continue;

      const countryName = normalizeCountryName(row.country);
      const divisionKey = state.countryDivisionByName.get(countryName);
      if (!divisionKey) {
        unmatchedCountries.add(countryName);
        continue;
      }

      const stageKey = computeStage(row.date_opened);
      const marker = L.marker([lat, lng], { icon: markerIcon(divisionKey, stageKey) });
      marker.bindPopup(buildPopupHtml(row, divisionKey), {
        maxWidth: 380,
        className: 'vintage-popup-wrapper',
        // Leaflet's autoPan (map.panBy, fired at the moment the popup opens)
        // is the prime suspect for a popup dismissing itself on iOS right
        // after opening — it's the one thing present when a "big" popup
        // needs panning to fit and absent when a "small" one doesn't,
        // which matches the fail/work split seen on-device. Traded away
        // the header-overlap avoidance this provided; a popup opening very
        // near the top can land partly under the header again for now.
        autoPan: false,
      });
      state.clusterGroups[divisionKey].addLayer(marker);

      if (!state.markersByCountry.has(countryName)) state.markersByCountry.set(countryName, []);
      state.markersByCountry.get(countryName).push({ marker, row });

      placed++;
    }

    for (const group of Object.values(state.clusterGroups)) {
      map.addLayer(group);
    }

    recomputeCountriesWithVisiblePins(ministryRows);
    refreshCountryStyles();
    buildLegend();
    wireLegendToggle();
    buildCountryDirectory(ministryRows);
    wireDirectoryControls();
    wirePhotoPreview();

    if (unmatchedCountries.size) {
      console.warn(
        `${unmatchedCountries.size} ministry row(s) had a country not found in country-divisions.csv:`,
        Array.from(unmatchedCountries)
      );
    }
    console.info(`Plotted ${placed} of ${ministryRows.length} ministry rows.`);
    hideStatus();
  } catch (err) {
    console.error(err);
    showStatus('Could not load ministry data. Check the data source in js/config.js.', true);
  }
}

init();

// If a popup opens close enough to any edge that part of it would land
// under the floating header or off the left/right side of the screen, pan
// just enough to bring the whole card into view — no pan at all when it's
// already fully visible. Leaflet has to know the popup's real rendered
// size to position it in the first place, and with fadeAnimation off (see
// map options above) that positioning is final by the time 'popupopen'
// fires, so measuring it here reads its true settled position rather than
// a mid-transition one.
map.on('popupopen', (e) => {
  const popupEl = e.popup._container;
  const marker = e.popup._source;
  if (!popupEl || !marker || typeof marker.getLatLng !== 'function') return;

  const margin = 12;
  const header = document.querySelector('.site-header');
  const safeTop = header.getBoundingClientRect().bottom + margin;
  const rect = popupEl.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Landscape iPhone has a notch/rounded-corner safe area on the sides that
  // window.innerWidth doesn't account for — content can be technically
  // "in bounds" by that number and still be tucked behind it. The vertical
  // check gets this for free (it measures the header's rendered height,
  // which already bakes in env(safe-area-inset-top)); horizontal has no
  // such element to borrow from, so read the inset directly.
  const rootStyle = getComputedStyle(document.documentElement);
  const safeLeft = parseFloat(rootStyle.getPropertyValue('--safe-area-left')) || 0;
  const safeRight = parseFloat(rootStyle.getPropertyValue('--safe-area-right')) || 0;
  const marginLeft = Math.max(margin, safeLeft + margin);
  const marginRight = Math.max(margin, safeRight + margin);

  let panX = 0;
  if (rect.left < marginLeft) {
    panX = rect.left - marginLeft; // negative: shifts content right
  } else if (rect.right > viewportWidth - marginRight) {
    panX = rect.right - (viewportWidth - marginRight); // positive: shifts content left
  }

  let panY = 0;
  if (rect.top < safeTop) {
    panY = rect.top - safeTop; // negative: shifts content down
  }

  if (panX === 0 && panY === 0) return; // already fully visible

  // Safety ceiling on each axis: never pan so far that the marker itself
  // would end up off-screen chasing this.
  const markerPt = map.latLngToContainerPoint(marker.getLatLng());
  const edgeMarginY = 40; // matches the vertical-only version this replaced
  const edgeMarginXLeft = Math.max(40, safeLeft);
  const edgeMarginXRight = Math.max(40, safeRight);

  if (panY < 0) {
    const floor = -Math.max(viewportHeight - edgeMarginY - markerPt.y, 0);
    panY = Math.max(panY, floor);
  }
  if (panX < 0) {
    const floor = -Math.max(viewportWidth - edgeMarginXRight - markerPt.x, 0);
    panX = Math.max(panX, floor);
  } else if (panX > 0) {
    const ceiling = Math.max(markerPt.x - edgeMarginXLeft, 0);
    panX = Math.min(panX, ceiling);
  }

  map.panBy([panX, panY], { animate: true, duration: 0.2 });
});

// Mobile browsers resize the visual viewport after load as the address bar
// collapses, and again on rotation; Leaflet caches its container size and
// won't notice on its own, which is what makes the map look cut off (or,
// after rotating, not full-screen) until you force this. Rotation in
// particular can fire its resize signal before the browser has actually
// finished reflowing to the new dimensions, so this re-checks a few times
// on a couple of different signals rather than trusting a single event.
function refreshMapSize() {
  map.invalidateSize();
}
function refreshMapSizeSoon() {
  refreshMapSize();
  setTimeout(refreshMapSize, 120);
  setTimeout(refreshMapSize, 350);
  setTimeout(refreshMapSize, 600);
}
window.addEventListener('resize', refreshMapSize);
window.addEventListener('orientationchange', refreshMapSizeSoon);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', refreshMapSize);
}
if (window.screen && window.screen.orientation) {
  window.screen.orientation.addEventListener('change', refreshMapSizeSoon);
}
