// ---------------------------------------------------------------------------
// Young Life International Ministries — map application
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
  // West/east twin copies of geoLayer (see shiftGeoJSONLng) — restyled
  // alongside it in refreshCountryStyles, otherwise they'd be stuck showing
  // whatever styleCountryFeature returned at creation time, before
  // countriesWithVisiblePins was populated.
  geoLayerGhosts: [],
  clusterGroups: {}, // division key -> L.markerClusterGroup
  markersByCountry: new Map(), // country name -> [{ marker, row }]
  openCountryTooltipLayer: null, // the one country layer whose tooltip is open, if any
};

const map = L.map('map', {
  center: CONFIG.MAP_CENTER,
  zoom: CONFIG.MAP_ZOOM,
  minZoom: CONFIG.MIN_ZOOM,
  maxZoom: CONFIG.MAX_ZOOM,
  zoomSnap: 0.25,
  zoomDelta: 1,
  worldCopyJump: true,
  // Default is true, which lets a pinch-zoom gesture briefly overshoot
  // past minZoom before animating back — a soft bounce corrected only
  // once the gesture ends, not clamped live. Ghost markers (the ±360°
  // world copies of each pin — see the ghostMarker loop below) normally
  // sit far enough apart on screen to never cluster together, but during
  // that overshoot the effective world width can drop enough for them to
  // land within the cluster group's merge radius, inflating a cluster's
  // count (reported live: real counts tripled, matching the three world
  // copies merging into one). False hard-clamps zoom at the limit
  // instead, so it never dips low enough for that to happen.
  bounceAtZoomLimits: false,
  // A fast flick used to leave Leaflet's own momentum animation running
  // for a second or more afterward, firing 'move' on every frame. The
  // south/north clamps below correcting live on each of those frames
  // was fighting that animation in real time, badly enough to cause a
  // real, reproduced freeze (runaway movement, sometimes in a direction
  // that was never actually being panned). No inertia means no animation
  // left for those clamps to fight, so they can safely go back to
  // correcting live on every 'move' too (see clampSouth/clampNorth).
  inertia: false,
  // Leaflet's SVG renderer only pre-draws country paths slightly beyond the
  // viewport (default padding: 0.1, i.e. 10% per side) and only redraws
  // that buffer on 'moveend', not continuously during a drag — a fast or
  // long drag can outrun it, leaving blank space (just the countries —
  // markers are a separate pane, unaffected) until release. This briefly
  // dropped to 0.5 on a guess that it wasn't needed anymore now that real
  // west/east world copies exist (see shiftGeoJSONLng), but that was
  // speculative and wrong — countries actually disappearing mid-drag
  // confirmed the bigger buffer was doing real work. Back to covering a
  // full world's width per side.
  renderer: L.svg({ padding: 1.5 }),
  // No maxBounds here — south panning is clamped manually further down
  // instead (see SOUTH_LIMIT_LAT/clampSouth). maxBounds can't do this:
  // Leaflet computes the pixel restriction it enforces by *projecting*
  // the bound's corners, and SphericalMercator.project() silently clamps
  // any latitude past 85.0511° (Web Mercator's own rendering limit) down
  // to exactly that value — so a maxBounds north value of 90, 150, or
  // 500 all collapse to the identical restriction as 85.0511 itself,
  // permanently capping north panning right at the point that made a
  // high-latitude ministry's popup clip under the header, with no way to
  // configure around it. map.getCenter() goes through unproject(), which
  // has no such clamp, so leaving north unrestricted and panning there
  // via plain map.panBy/panTo works fine — confirmed live, reaching
  // 89.7° with nothing rendered above Greenland but open ocean, same as
  // this map behaved before any north/south limit was added.
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

// Replaces maxBounds' south restriction (see the map options above for
// why maxBounds itself can't be used at all here). Cuts down how much
// empty Antarctic interior is reachable — clamped against the *bottom
// edge* of the visible viewport, not the center point. Clamping the
// center alone let plenty of Antarctica stay visible below it at any
// zoom wide enough for the viewport to extend past the center's own
// limit, which is most of them.
//
// Pixel-based, same reasoning as clampNorth below: this used to correct
// by adding the degrees of overshoot straight to the center's latitude,
// which assumes roughly 1 degree of latitude is a constant number of
// pixels — only true near the equator. Mercator compresses distance
// increasingly the closer you get to a pole, so a large enough overshoot
// made that assumption wrong enough for the correction to not converge.
//
// Runs on every 'move' so dragging past the limit snaps back immediately
// instead of letting you drag arbitrarily far past it and only
// correcting on release. This briefly moved to 'moveend' only, because
// correcting live on every 'move' was fighting Leaflet's own inertia/
// momentum animation frame-by-frame after a fast flick, which caused a
// real, reproduced freeze. inertia: false above (see map options)
// removes that animation entirely, so there's no competing frame-by-
// frame loop left for this to fight — safe to run live again.
const SOUTH_LIMIT_LAT = -71;
function clampSouth() {
  const limitPt = map.latLngToContainerPoint([SOUTH_LIMIT_LAT, map.getCenter().lng]);
  const bottomEdgePx = map.getSize().y;
  if (limitPt.y < bottomEdgePx) {
    map.panBy([0, limitPt.y - bottomEdgePx], { animate: false });
  }
}
map.on('move', clampSouth);

// Caps how much blank ocean is reachable above real content (nothing
// north of 85.0511° renders at all — see the map options above), in
// PIXELS rather than degrees — degrees don't work here. Any target
// latitude at or past 85.0511° is unreachable via setView/panTo: they
// go through map.project(), and SphericalMercator.project() clamps any
// input past that point to the exact same pixel position, so "move to
// 88°" and "already at 89.95°" compute as the identical spot and
// silently no-op (confirmed live). Pixels sidestep the clamp entirely:
// 85.0511° itself projects exactly (it's the clamp boundary, not past
// it), so measuring its current on-screen position and panning back by
// however far past NORTH_LIMIT_PX it's drifted works regardless of how
// far north the camera has gone.
//
// Runs on every 'move', same reasoning as clampSouth above — safe now
// that inertia: false means there's no live animation left to fight.
const NORTH_LIMIT_PX = 700;
function clampNorth() {
  const trueEdgePt = map.latLngToContainerPoint([85.0511, map.getCenter().lng]);
  if (trueEdgePt.y > NORTH_LIMIT_PX) {
    map.panBy([0, trueEdgePt.y - NORTH_LIMIT_PX], { animate: false });
  }
}
map.on('move', clampNorth);

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

// Ministry photos are named explicitly in ministries.csv's photos column
// (not guessed via CONFIG.IMAGE_EXTENSIONS the way staff photos are), so
// there's no extension to retry — a load failure goes straight to the
// initials-style placeholder.
window.__ministryPhotoFallback = function (img) {
  const fallback = document.createElement('div');
  fallback.className = 'popup-photo popup-photo-fallback';
  fallback.style.setProperty('--fallback-color', img.dataset.fallbackColor);
  fallback.innerHTML = `<span>${img.dataset.fallbackText}</span>`;
  // Swap out the whole wrap (img + its enlarge badge), not just the img —
  // otherwise the badge is left dangling over the fallback div behind it.
  (img.closest('.popup-photo-wrap') || img).replaceWith(fallback);
};

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
        .map((u) => `<li>${escapeHtml(u.name)}${u.meta ? ` <span class="university-year">(${escapeHtml(u.meta)})</span>` : ''}</li>`)
        .join('')}</ul>`
    : '';

  const photos = (row.photos || '').split(';').map((s) => s.trim()).filter(Boolean);
  // The enlarge badge is the only hint that a popup photo is tappable (and,
  // for multi-photo ministries, that there's a carousel behind it) — no
  // hover state to lean on here since this has to read on touch too.
  const cityPhoto = photos.length
    ? `<div class="popup-photo-wrap">
        <img
          class="popup-photo"
          src="${escapeHtml(CONFIG.IMAGES_DIR + photos[0])}"
          alt="${escapeHtml(`${row.city} ministry photo`)}"
          data-photos='${escapeHtml(JSON.stringify(photos))}'
          data-fallback-text="${escapeHtml(row.city || '?')}"
          data-fallback-color="${escapeHtml(div.country)}"
          onerror="window.__ministryPhotoFallback(this)"
        >
        <span class="popup-photo-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
          ${photos.length > 1 ? `<span class="popup-photo-badge-count">${photos.length}</span>` : ''}
        </span>
      </div>`
    : `<div class="popup-photo popup-photo-fallback" style="--fallback-color:${escapeHtml(div.country)}"><span>${escapeHtml(row.city || '?')}</span></div>`;

  // Re-parsed from the stored original URL (not a canonicalized embed URL
  // saved separately) so there's one place — parseVideoEmbedUrl — that
  // knows how to turn a link into a player, shared with the admin's
  // Preview button. Malformed/legacy video_url data (hand-edited CSV,
  // pre-validation rows) just silently omits the link rather than
  // rendering something that can't actually play.
  // Placed alongside staffHtml/universitiesHtml (not its own .popup-body)
  // so the .popup-video-link + .popup-staff / + .popup-universities CSS
  // adjacent-sibling rule can add the same separator staff->universities
  // already gets — only when a video link actually precedes it, since
  // that CSS only matches when the two are direct siblings.
  const videoHtml = row.video_url && parseVideoEmbedUrl(row.video_url)
    ? `<a href="#" class="popup-video-link" data-video-url="${escapeHtml(row.video_url)}">
        <svg class="popup-video-play-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="12"/>
          <path d="M9.5 7.5v9l7-4.5z" fill="#fff"/>
        </svg>
        ${escapeHtml(row.video_label || `Watch a ${row.city} Story`)}
      </a>`
    : '';

  return `
    <div class="popup-card">
      <div class="popup-body popup-header-body">
        <h3>${flag ? `${flag} ` : ''}${escapeHtml(row.city)}${row.city === row.country ? '' : `, ${escapeHtml(row.country)}`}</h3>
      </div>
      ${cityPhoto}
      ${row.blurb ? `<div class="popup-body popup-blurb-body"><p class="popup-blurb">${escapeHtml(row.blurb)}</p></div>` : ''}
      <div class="popup-body">
        ${videoHtml}
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

// Leaflet's tile layers repeat automatically as you pan past +/-180deg
// longitude, but vector content (this map's countries, ministry pins, ocean
// labels) only exists once, at its one true coordinate — nothing repeats it
// for you. To make the west/east "extra world" panning feel continuous
// instead of running out into blank ocean, the countries layer, ministry
// markers, and ocean labels are each rendered three times: at their real
// longitude, and shifted +/-360deg for the flanking copies. Recurses to
// whatever depth a geometry's coordinate array needs (Polygon vs
// MultiPolygon, etc.) — a leaf coordinate pair is just two numbers, so that
// case is the recursion's base case.
function shiftGeoJSONLng(geojson, offsetDeg) {
  const shifted = JSON.parse(JSON.stringify(geojson));
  function shiftCoords(coords) {
    if (typeof coords[0] === 'number') {
      coords[0] += offsetDeg;
    } else {
      coords.forEach(shiftCoords);
    }
  }
  for (const feature of shifted.features) {
    // A handful of features carry null geometry (e.g. disputed territories
    // with no polygon in this dataset) — Leaflet's own GeoJSON parser
    // already skips those silently, so just leave them as-is here too.
    if (!feature.geometry) continue;
    shiftCoords(feature.geometry.coordinates);
  }
  return shifted;
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
    for (const offsetDeg of [-360, 0, 360]) {
      L.marker([ocean.lat, ocean.lng + offsetDeg], {
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
}

function refreshCountryStyles() {
  if (!state.geoLayer) return;
  for (const geoJsonLayer of [state.geoLayer, ...state.geoLayerGhosts]) {
    geoJsonLayer.eachLayer((layer) => {
      layer.setStyle(styleCountryFeature(layer.feature));
    });
  }
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

// layer.getBounds() naively spans a MultiPolygon's raw lat/lng min/max
// across every sub-polygon, which breaks in two different ways: a piece
// that wraps past +/-180deg (Russia's mainland stops at 180, a small
// far-eastern island starts back at -180) corrupts the whole box into
// spanning the entire globe's longitude, landing its center near 0deg —
// just west of Norway instead of on Russia. And a genuinely remote piece
// (Ecuador's Galapagos, the US's Hawaii, France's overseas departments)
// drags the box out to cover empty ocean the country doesn't visually
// read as including.
//
// Using only the single largest sub-polygon fixes both, but breaks a
// third case: an archipelago of comparably-sized islands (Indonesia, the
// Philippines) zooms in on just the one biggest island instead of the
// whole country.
//
// So: anchor on the largest piece, then fold in any other piece that's
// either close to it (adjacent territory that only needs its longitude
// unwrapped across the antimeridian, or another major island nearby) or
// big enough to matter on its own (Mindanao next to Luzon) — only
// excluding pieces that are both small and far off.
function computeMainLandBounds(feature) {
  const geom = feature.geometry;
  const polygons = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  const boxes = polygons.map((poly) => {
    const ring = poly[0]; // outer ring; holes don't matter for a bbox
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return { minLng, maxLng, minLat, maxLat, area: (maxLng - minLng) * (maxLat - minLat) };
  });

  let anchor = boxes[0];
  for (const b of boxes) if (b.area > anchor.area) anchor = b;
  const anchorCenterLng = (anchor.minLng + anchor.maxLng) / 2;
  const anchorCenterLat = (anchor.minLat + anchor.maxLat) / 2;
  // A fixed threshold, not scaled to the anchor's own size — that was
  // tried first and broke on countries with an already-large anchor (the
  // US: Alaska, at 45% of the continental bbox's area, correctly gets
  // pulled in by the size rule below regardless of distance, but scaling
  // the distance rule off that same large anchor also pulled in Hawaii
  // and Guam from 40-80deg away). Checked against every country in this
  // file's data: Galapagos sits 11-13deg from mainland Ecuador and needs
  // to be excluded; every major archipelago island (Indonesia, the
  // Philippines) that isn't caught by the size rule below sits within
  // 8-14deg of its country's largest island. 10deg draws the line
  // between those two groups correctly.
  const CLOSE_ENOUGH_DEGREES = 10;

  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const b of boxes) {
    // Shift this piece's longitude by whichever multiple of 360 puts it
    // closest to the anchor — undoes an antimeridian split without
    // needing to know in advance which country crosses it.
    const centerLng = (b.minLng + b.maxLng) / 2;
    const shift = Math.round((anchorCenterLng - centerLng) / 360) * 360;
    const shiftedMinLng = b.minLng + shift;
    const shiftedMaxLng = b.maxLng + shift;
    const dist = Math.hypot((centerLng + shift) - anchorCenterLng, (b.minLat + b.maxLat) / 2 - anchorCenterLat);
    const closeEnough = dist <= CLOSE_ENOUGH_DEGREES;
    const bigEnough = b.area >= anchor.area * 0.1;
    if (b !== anchor && !closeEnough && !bigEnough) continue;
    if (shiftedMinLng < minLng) minLng = shiftedMinLng;
    if (shiftedMaxLng > maxLng) maxLng = shiftedMaxLng;
    if (b.minLat < minLat) minLat = b.minLat;
    if (b.maxLat > maxLat) maxLat = b.maxLat;
  }
  return L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
}

function flyToCountry(countryName) {
  const entries = state.markersByCountry.get(countryName);
  if (!entries || !entries.length) return;

  // Zooms to the country itself now, same fit as clicking it on the map —
  // it used to fit to the ministry pins' own bounds instead, which for a
  // country with all its ministries clustered in one corner (or just one)
  // zoomed in far tighter than the country level this is meant to give.
  let countryLayer;
  state.geoLayer.eachLayer((layer) => {
    if (normalizeCountryName(layer.feature.properties.name) === countryName) countryLayer = layer;
  });
  if (!countryLayer) return;
  const bounds = computeMainLandBounds(countryLayer.feature);
  map.setView(bounds.getCenter(), map.getBoundsZoom(bounds) - 0.5);

  // A single ministry also gets its popup opened as a bonus, but only if
  // it isn't still buried inside an unopened cluster at this (country,
  // not pin) zoom level — openPopup() silently no-ops otherwise.
  if (entries.length === 1) {
    const { marker, row } = entries[0];
    const divisionKey = state.countryDivisionByName.get(normalizeCountryName(row.country));
    const group = state.clusterGroups[divisionKey];
    map.once('moveend', () => {
      const visibleMarker = group && group.getVisibleParent ? group.getVisibleParent(marker) : marker;
      if (visibleMarker === marker) marker.openPopup();
    });
  }
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

const LEGEND_COLLAPSED_COOKIE = 'legend_collapsed';

function readLegendCollapsedCookie() {
  const match = document.cookie.match(new RegExp(`(?:^|; )${LEGEND_COLLAPSED_COOKIE}=([^;]*)`));
  return match ? match[1] === 'true' : null;
}

// A year is long enough to read as "remembered," short enough that an
// abandoned browser profile doesn't pin this forever.
function writeLegendCollapsedCookie(collapsed) {
  document.cookie = `${LEGEND_COLLAPSED_COOKIE}=${collapsed}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

// persist is only true from an actual click/swipe in wireLegendToggle
// below — the call right below this definition applies either a saved
// cookie or the device default, which isn't a real choice yet and
// shouldn't overwrite (or prematurely create) one.
function setLegendCollapsed(collapsed, { persist = false } = {}) {
  const legend = document.getElementById('legend');
  const toggle = document.getElementById('legend-toggle');
  legend.classList.toggle('legend-collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? 'Expand legend' : 'Minimize legend');
  if (persist) writeLegendCollapsedCookie(collapsed);
}

// Applied here, synchronously, rather than inside wireLegendToggle()
// (called later, from inside init(), after it awaits the ministries/
// geojson fetches) — #legend already exists at this point since this
// script tag sits at the end of body, and running this before init()
// ever yields to the network means the legend paints in its final state
// immediately instead of flashing open (the CSS default) and then
// snapping to the real state once data loads.
// A saved cookie always wins — it's a real choice the user already
// made. Otherwise default to open on desktop (there's room for it) and
// collapsed on touch devices, where it'd otherwise cover the map on
// first load — any-pointer:coarse is the same touch signal the
// lightbox arrows use elsewhere for this.
{
  const savedCollapsed = readLegendCollapsedCookie();
  setLegendCollapsed(savedCollapsed !== null ? savedCollapsed : window.matchMedia('(any-pointer: coarse)').matches);
  // Deferred (not via requestAnimationFrame — rAF never fires in a hidden/
  // backgrounded tab, e.g. one opened in the background, so this has to be
  // a macrotask instead) so this initial class application, which the
  // browser still treats as a genuine style change even applied this
  // early, isn't itself what the chevron's transition animates — see the
  // CSS comment on .legend-transitions-ready. By the time this runs the
  // collapsed/expanded state above has already been painted, so enabling
  // the transition here only affects later, real toggles.
  setTimeout(() => {
    document.getElementById('legend').classList.add('legend-transitions-ready');
  }, 0);
}

function wireLegendToggle() {
  const legend = document.getElementById('legend');
  const toggle = document.getElementById('legend-toggle');
  const swipeZone = document.getElementById('legend-swipe-zone');

  toggle.addEventListener('click', () => {
    setLegendCollapsed(!legend.classList.contains('legend-collapsed'), { persist: true });
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
    if (deltaY > SWIPE_THRESHOLD) setLegendCollapsed(true, { persist: true }); // swiped down
    else if (deltaY < -SWIPE_THRESHOLD) setLegendCollapsed(false, { persist: true }); // swiped up
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

  // Touch and mouse get entirely separate, non-overlapping listener sets,
  // decided once here rather than filtered per-event by pointerType. iOS's
  // touch-to-click emulation fires synthetic hover events that (in testing)
  // still reported as pointerType 'mouse', defeating that filtering — so
  // instead a touch-capable device simply never registers a hover listener
  // at all, leaving nothing for the emulation to trigger.
  const isTouch = matchMedia('(hover: none), (pointer: coarse)').matches;

  if (isTouch) {
    // Tap to show, tap again (or tap elsewhere) to dismiss. Press-and-hold
    // was tried first, but holding past iOS's long-press threshold pops up
    // Safari's own "Save Image" callout on top of the preview.
    document.addEventListener('click', (e) => {
      const img = e.target.closest('img.popup-staff-photo');
      if (img) {
        if (activeImg === img) hide();
        else { show(img); activeImg = img; }
        return;
      }
      hide();
    });
  } else {
    document.addEventListener('mouseover', (e) => {
      const img = e.target.closest('img.popup-staff-photo');
      if (img) { show(img); activeImg = img; }
    });
    document.addEventListener('mouseout', (e) => {
      if (e.target.closest('img.popup-staff-photo')) hide();
    });
  }
  map.on('popupclose', hide);
  map.on('movestart', hide);
}

// Fullscreen lightbox carousel for a ministry's photos — every popup-photo
// img carries its ministry's full photo list in data-photos (see
// buildPopupHtml), so this opens with all of them even though only the
// first (main) one is ever shown inline in the popup itself. Click/tap
// opens it, clicking the same photo again (or clicking outside it) closes
// it — same click-to-toggle pattern as wirePhotoPreview above, but on
// click rather than hover on desktop too: hover-triggered popups here read
// as too jarring for a fullscreen overlay.
// Navigation is iOS Photos-style: dots instead of a "1 / 3" counter, and a
// real drag-follow swipe on touch. Unlike a single sliding image, the
// outgoing and incoming photos need to be visible together while they
// move — so this keeps a 3-up "track" (prev/current/next) always loaded
// side by side and slides the whole track by one slide-width; arrows and
// dots animate the same way a swipe does, and the track then resets
// invisibly back to center with fresh neighbors loaded for the new
// position (the standard technique for an apparently-infinite carousel).
function wireMinistryPhotoCarousel() {
  const lightbox = document.getElementById('ministry-lightbox');
  const content = lightbox.querySelector('.lightbox-content');
  const viewport = lightbox.querySelector('.lightbox-viewport');
  const track = lightbox.querySelector('.lightbox-track');
  const slidePrev = track.querySelector('[data-slide="prev"]');
  const slideCurrent = track.querySelector('[data-slide="current"]');
  const slideNext = track.querySelector('[data-slide="next"]');
  const dotsEl = lightbox.querySelector('.lightbox-dots');
  const prevBtn = lightbox.querySelector('.lightbox-prev');
  const nextBtn = lightbox.querySelector('.lightbox-next');
  const SLIDE_MS = 220;
  const SWIPE_FRACTION = 0.18; // of one slide's own width
  const REST_TRANSFORM = 'translateX(-33.3333%)';

  let photos = [];
  let index = 0;
  let activeImg = null; // the img currently open, for click-to-toggle
  let sliding = false;

  function urlFor(i) { return CONFIG.IMAGES_DIR + photos[i]; }

  // Resolves once `img` has actually loaded (or failed to — a broken
  // image is as "settled" as one that decoded, for our purposes here).
  // img.decode() looks like the textbook tool for this but isn't used:
  // it can hang indefinitely on an element inside a currently-opacity:0
  // container (the lightbox is exactly that until open() finishes),
  // apparently a Chromium quirk tying decode scheduling to paint
  // eligibility. The .complete fast path also means this resolves
  // synchronously-ish for anything already cached — the common case,
  // since a photo shown here was almost always already visible inline in
  // the popup a moment earlier.
  function whenLoaded(img) {
    return new Promise((resolve) => {
      if (img.complete && img.naturalWidth) { resolve(); return; }
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
  }

  // Real uploads vary in aspect ratio (not every photo is exactly the
  // recommended 4:3), so the viewport's shape is resized to match
  // whichever photo is current rather than held at one fixed ratio —
  // otherwise most photos would still letterbox one way or another.
  function applyViewportRatio(img) {
    if (img.naturalWidth && img.naturalHeight) {
      viewport.style.setProperty('--ratio', img.naturalWidth / img.naturalHeight);
    }
  }

  // Loads the current-index photo into the middle slide and waits for it
  // to actually be ready before returning — callers only touch the
  // transform once this resolves. As long as every caller only mutates a
  // slide while it's off-screen (see loadNeighbors below), that rules out
  // the reset ever landing on a slide that still shows what it had
  // before, which otherwise flashes the outgoing photo right as the new
  // one should already be in place.
  async function loadCurrentSlide() {
    resetPinch(); // a fresh photo starts unzoomed, no matter how the last one was left
    slideCurrent.src = urlFor(index);
    await whenLoaded(slideCurrent);
    applyViewportRatio(slideCurrent);
  }

  // Prev/next aren't visible at rest, so — unlike the current slide —
  // there's no flash risk in just setting their src and letting them
  // decode in the background. Only meaningful with 2+ photos; the single-
  // photo case never reaches these (swiping/arrows are disabled below
  // whenever photos.length < 2).
  function loadNeighbors() {
    const n = photos.length;
    if (n <= 1) return;
    slidePrev.src = urlFor((index - 1 + n) % n);
    slideNext.src = urlFor((index + 1) % n);
  }

  function renderDots() {
    dotsEl.innerHTML = '';
    const multi = photos.length > 1;
    dotsEl.hidden = !multi;
    if (!multi) return;
    photos.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `lightbox-dot${i === index ? ' active' : ''}`;
      dot.setAttribute('aria-label', `Photo ${i + 1} of ${photos.length}`);
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        goToDot(i);
      });
      dotsEl.appendChild(dot);
    });
  }

  // A dot for the immediate neighbor slides there like a swipe would; any
  // other dot has no adjacent slide already loaded to slide through, so it
  // jumps straight there instead of faking a multi-slide animation. The
  // track never moves for this path (it's already at rest), so the swap
  // just needs the decode-before-showing rule below, same as everywhere
  // else.
  async function goToDot(i) {
    if (i === index || sliding) return;
    const n = photos.length;
    if ((index + 1) % n === i) { showNext(); return; }
    if ((index - 1 + n) % n === i) { showPrev(); return; }
    sliding = true;
    index = i;
    await loadCurrentSlide();
    loadNeighbors();
    renderDots();
    sliding = false;
  }

  async function open(photoList) {
    photos = photoList;
    index = 0;
    track.style.transition = 'none';
    track.style.transform = REST_TRANSFORM;
    await loadCurrentSlide();
    loadNeighbors();
    renderDots();
    const multi = photos.length > 1;
    prevBtn.hidden = !multi;
    nextBtn.hidden = !multi;
    lightbox.classList.add('visible');
  }

  function close() {
    lightbox.classList.remove('visible');
    activeImg = null;
  }

  // Slides the whole track by one slide-width in `dir`'s direction — the
  // photo landing there is already loaded right next to the current one,
  // so both are visible moving together — then snaps the track back to
  // center with transition:none and loads fresh neighbors for the new
  // position, invisibly to the viewer. Reused by the arrows, dots, and a
  // released swipe alike, so every path animates the same way — a swipe
  // that's already partway through this motion just continues from
  // wherever the drag left off, since a CSS transition animates from an
  // element's current rendered position regardless of what put it there.
  function slideTo(newIndex, dir) {
    if (sliding || newIndex === index || photos.length < 2) return;
    sliding = true;
    track.style.transition = `transform ${SLIDE_MS}ms ease`;
    // Forces the browser to commit the transition (and the drag's current
    // position, if this follows a swipe) before the transform below
    // changes — without it, some engines (Safari especially) coalesce the
    // two style writes and jump straight to the end position instead of
    // animating, which read as the photo "flashing" out rather than
    // sliding.
    void track.offsetWidth;
    track.style.transform = dir === 1 ? 'translateX(-66.6667%)' : 'translateX(0%)';

    setTimeout(async () => {
      index = newIndex;
      // The middle slide is off-screen right now (the track is still
      // slid out), so it's safe to load + decode the new current photo
      // into it before anything is visible there — only once that's
      // actually ready does the reset happen, so the middle slide is
      // never shown mid-decode with the previous photo still under it.
      await loadCurrentSlide();
      track.style.transition = 'none';
      track.style.transform = REST_TRANSFORM;
      // The now-adjacent slides are off-screen again post-reset, so this
      // is likewise safe — the reverse would flash them mid-slide, before
      // the reset, while they're still the ones on screen.
      loadNeighbors();
      renderDots();
      sliding = false;
    }, SLIDE_MS);
  }

  function showNext() { slideTo((index + 1) % photos.length, 1); }
  function showPrev() { slideTo((index - 1 + photos.length) % photos.length, -1); }

  prevBtn.addEventListener('click', (e) => { e.stopPropagation(); showPrev(); });
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); showNext(); });
  lightbox.querySelector('.lightbox-close').addEventListener('click', close);
  lightbox.querySelector('.lightbox-backdrop').addEventListener('click', close);

  // Touch drag: axis-locked so an ambiguous or vertical gesture is left
  // alone (nothing to vertically scroll here, but this also matters on
  // iOS specifically — without it, an early horizontal drag can be read as
  // the browser's own edge-swipe-back gesture before preventDefault below
  // gets a chance to claim it).
  let dragging = false;
  let touchStartX = 0;
  let touchStartY = 0;
  let axis = null; // 'x' | 'y' | null

  // Two-finger pinch on the current photo — scales it up live and pans as
  // the fingers' midpoint moves, then always springs back to 1x/centered
  // on release rather than staying zoomed; there's no persistent pan-
  // while-zoomed mode to keep in bounds (or clamp panning within), so
  // this is just a transform tied directly to the two touches plus a CSS
  // transition back. Kept separate from the single-finger drag state
  // above: a touchstart with 2 touches switches straight to pinch mode
  // (cancelling any in-progress swipe rather than fighting it), and
  // touchmove branches on the CURRENT touch count every time rather than
  // on which gesture started the sequence, since a second finger can
  // land mid-swipe.
  let pinching = false;
  let pinchStartDist = 0;
  let pinchStartMidX = 0;
  let pinchStartMidY = 0;
  const PINCH_MAX_SCALE = 2.5;

  function touchDistance(touches) {
    return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  }
  function touchMidpoint(touches) {
    return { x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 };
  }

  function resetPinch() {
    pinching = false;
    slideCurrent.style.transition = '';
    slideCurrent.style.transform = '';
  }

  content.addEventListener('touchstart', (e) => {
    if (sliding) return;
    if (e.touches.length === 2) {
      dragging = false;
      pinching = true;
      pinchStartDist = touchDistance(e.touches);
      const mid = touchMidpoint(e.touches);
      pinchStartMidX = mid.x;
      pinchStartMidY = mid.y;
      const rect = slideCurrent.getBoundingClientRect();
      slideCurrent.style.transformOrigin = `${mid.x - rect.left}px ${mid.y - rect.top}px`;
      slideCurrent.style.transition = 'none';
      return;
    }
    if (photos.length < 2) return;
    dragging = true;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    axis = null;
    track.style.transition = 'none';
  }, { passive: true });

  content.addEventListener('touchmove', (e) => {
    if (pinching) {
      if (e.touches.length < 2) return;
      e.preventDefault(); // also keeps the browser's own page-pinch-zoom from firing alongside this
      const scale = Math.min(PINCH_MAX_SCALE, Math.max(1, touchDistance(e.touches) / pinchStartDist));
      const mid = touchMidpoint(e.touches);
      const dx = mid.x - pinchStartMidX;
      const dy = mid.y - pinchStartMidY;
      slideCurrent.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
      return;
    }
    if (!dragging) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (!axis) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (axis !== 'x') return;
    e.preventDefault();
    track.style.transform = `translateX(calc(-33.3333% + ${dx}px))`;
  }, { passive: false });

  content.addEventListener('touchend', (e) => {
    if (pinching) {
      if (e.touches.length > 0) return; // wait for every finger to lift
      slideCurrent.style.transition = `transform ${SLIDE_MS}ms ease`;
      // Forces the browser to commit the transition before the transform
      // below changes — same reasoning as the identical line in slideTo:
      // without it, writing both in the same tick coalesces into no
      // visible animation on some engines instead of springing back.
      void slideCurrent.offsetWidth;
      slideCurrent.style.transform = 'scale(1)';
      pinching = false;
      return;
    }
    if (!dragging) return;
    if (axis === 'x') {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const width = track.getBoundingClientRect().width / 3 || 1;
      if (Math.abs(dx) > width * SWIPE_FRACTION) {
        dx < 0 ? showNext() : showPrev();
      } else {
        track.style.transition = `transform ${SLIDE_MS}ms ease`;
        void track.offsetWidth;
        track.style.transform = REST_TRANSFORM;
      }
    }
    dragging = false;
    axis = null;
  });

  // iOS fires touchcancel instead of touchend whenever the system steals a
  // gesture mid-stream — the edge-swipe-back gesture, a Control Center
  // pull, an incoming call, etc. Without this, pinching/dragging above
  // would stay stuck true forever (nothing else ever resets them), which
  // silently breaks all further touch input on this lightbox until the
  // page is reloaded — no fancy springback needed here, just snap
  // everything back immediately since the gesture genuinely didn't finish.
  content.addEventListener('touchcancel', () => {
    if (pinching) {
      slideCurrent.style.transition = '';
      slideCurrent.style.transform = '';
      pinching = false;
    }
    if (dragging) {
      track.style.transition = '';
      track.style.transform = REST_TRANSFORM;
      dragging = false;
    }
    axis = null;
  });

  function photosFromImg(img) {
    try {
      const list = JSON.parse(img.dataset.photos);
      return Array.isArray(list) && list.length ? list : null;
    } catch {
      return null;
    }
  }

  document.addEventListener('click', (e) => {
    const img = e.target.closest('img.popup-photo');
    if (img && img.dataset.photos) {
      if (activeImg === img) { close(); return; }
      const photoList = photosFromImg(img);
      if (photoList) { open(photoList); activeImg = img; }
      return;
    }
    if (e.target.closest('.ministry-lightbox')) return;
    close();
  });

  map.on('popupclose', close);
  map.on('movestart', close);
}

// Fullscreen embed for a ministry's video link — separate overlay from
// #ministry-lightbox (see the HTML comment there) since a single video has
// none of the swipe/multi-slide machinery photos need.
function wireVideoLightbox() {
  const lightbox = document.getElementById('video-lightbox');
  const embedWrap = document.getElementById('video-lightbox-embed');

  function open(embedUrl) {
    embedWrap.innerHTML = `<iframe src="${embedUrl}" title="Ministry video" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    lightbox.classList.add('visible');
  }

  // Clearing the iframe (not just hiding the overlay) actually stops
  // playback — an <iframe> left in the DOM keeps running otherwise.
  function close() {
    lightbox.classList.remove('visible');
    embedWrap.innerHTML = '';
  }

  lightbox.querySelector('.lightbox-close').addEventListener('click', close);
  lightbox.querySelector('.lightbox-backdrop').addEventListener('click', close);

  document.addEventListener('click', (e) => {
    const link = e.target.closest('.popup-video-link');
    if (!link) return;
    e.preventDefault();
    const parsed = parseVideoEmbedUrl(link.dataset.videoUrl);
    if (parsed) open(parsed.embedUrl);
  });

  map.on('popupclose', close);
  map.on('movestart', close);
}

// Easter egg: triple-clicking the page title swaps it for a joke variant,
// and swaps back on the next triple-click. Triple-click (not single/double)
// so it's not something a visitor stumbles into by accident.
function wireTitleEasterEgg() {
  const titleEl = document.getElementById('site-title');
  if (!titleEl) return;
  const original = titleEl.textContent;
  const joke = 'The sun never sets on the Brett-ish Empire';
  titleEl.addEventListener('click', (e) => {
    if (e.detail !== 3) return;
    titleEl.textContent = titleEl.textContent === original ? joke : original;
  });
}

// Panning/zooming the map (or opening a popup) doesn't change the URL, so
// the browser's Back button has nothing of ours to step back through — it
// falls straight through to wherever the visitor was before this page,
// which reads as "the map ate my back button" for anyone who'd zoomed in
// first. Pushing one extra history entry the first time the view changes
// gives Back something of ours to consume first: it lands back on this
// same page (no reload, same URL) and fires 'popstate', which resets the
// view instead of the browser navigating away. A second Back press with no
// further interaction then behaves normally and leaves the page, same as
// if the map had never been touched.
function wireBackButtonReset() {
  const initialView = { center: L.latLng(CONFIG.MAP_CENTER), zoom: CONFIG.MAP_ZOOM };
  let pushed = false;
  // Set while resetMapView's own setView call is in flight, so that
  // programmatic move doesn't immediately re-arm the trap it was called to
  // disarm — cleared on the next tick, once Leaflet's synchronous
  // (animate:false) move/zoom events for that call have all fired.
  let suppressArm = false;

  function armTrap() {
    if (pushed || suppressArm) return;
    pushed = true;
    history.pushState({ ylMapView: true }, '', location.href);
  }

  function resetMapView() {
    suppressArm = true;
    map.closePopup();
    map.setView(initialView.center, initialView.zoom, { animate: false });
    setTimeout(() => { suppressArm = false; }, 0);
  }

  map.on('movestart', armTrap);
  window.addEventListener('popstate', () => {
    if (!pushed) return; // not our entry — let the browser navigate normally
    pushed = false;
    resetMapView();
  });
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

    const countryLayerOptions = {
      style: styleCountryFeature,
      onEachFeature: (feature, layer) => {
        layer.bindTooltip(feature.properties.name, { sticky: true, className: 'country-tooltip' });
        // bindTooltip wires up hover (mouseover/mouseout/mousemove) AND
        // click listeners on its own (Leaflet's Layer._initTooltipInteractions).
        // Hover-triggered tooltips are disabled here — click is the only way
        // to open one now, via our own handler below. Because it's a real
        // geo-anchored tooltip, it opens right at the tap point and then
        // naturally tracks/scales along with the pan+zoom triggered by the
        // same click, landing correctly once the animation settles.
        layer.off({
          mouseover: layer._openTooltip,
          mouseout: layer.closeTooltip,
          mousemove: layer._moveTooltip,
          click: layer._openTooltip,
        }, layer);

        // Only countries actually holding a ministry pin are worth zooming
        // into — clicking anywhere else on the (uncolored) landmass would
        // otherwise zoom to an empty country with nothing to see, but every
        // country still gets its name tooltip on click.
        layer.on('click', (e) => {
          // A click on a country turns out to ALSO fire the map's own
          // 'click' (see the map.on('click', ...) below) in the same
          // event — without this flag, that would immediately close the
          // tooltip this same click just opened.
          suppressNextMapClickClose = true;
          if (state.openCountryTooltipLayer && state.openCountryTooltipLayer !== layer) {
            state.openCountryTooltipLayer.closeTooltip();
          }
          // If this were ever undefined, Leaflet's Tooltip._prepareOpen
          // silently falls back to the country's own center instead of the
          // click position — computing it ourselves guarantees that never
          // happens, regardless of why e.latlng could come back empty.
          const clickLatLng = e.latlng || map.mouseEventToLatLng(e.originalEvent);
          layer.openTooltip(clickLatLng);
          state.openCountryTooltipLayer = layer;

          const name = normalizeCountryName(feature.properties.name);
          const present = state.countriesWithVisiblePins.get(name);
          if (present && present.size) {
            // A touch out from a tight fit, so the country reads with a
            // little breathing room and its neighbors are visible for
            // context, without backing off as far as a full zoom level.
            const bounds = computeMainLandBounds(feature);
            const targetZoom = map.getBoundsZoom(bounds) - 0.5;
            // Zooms in OR out to this fit, every time — e.g. clicking a
            // small country while zoomed in on a big one now zooms back
            // out to bring the small one into view, rather than staying
            // zoomed in past it.
            map.setView(bounds.getCenter(), targetZoom);
          }
        });
      },
    };

    // Clicking a different country already closes the previous tooltip
    // (see the click handler above). This covers the other two ways it
    // should go away: clicking blank map area (a click that lands on no
    // interactive layer at all only ever reaches the map itself, never a
    // country click, so this can't double-close the one just opened), and
    // starting a drag — 'dragstart' specifically, not 'movestart', so the
    // pan/zoom our own click handler triggers for a ministry country
    // doesn't immediately close the tooltip that same click just opened.
    function closeOpenCountryTooltip() {
      if (state.openCountryTooltipLayer) {
        state.openCountryTooltipLayer.closeTooltip();
        state.openCountryTooltipLayer = null;
      }
    }
    let suppressNextMapClickClose = false;
    map.on('click', () => {
      if (suppressNextMapClickClose) {
        suppressNextMapClickClose = false;
        return;
      }
      closeOpenCountryTooltip();
    });
    map.on('dragstart', closeOpenCountryTooltip);

    // Leaflet makes every interactive vector layer keyboard-focusable for
    // accessibility, which with ~258 countries turns Tab into a country-by-
    // country crawl. Strip the tab stop but leave hover/click untouched.
    //
    // Also: bindTooltip's own focus listener (Layer._addFocusListenersOnLayer)
    // opens the tooltip with no lat/lng at all when the path gets focused —
    // falling back to the country's own center. Chrome turns out to let an
    // SVG path take focus even with no tabindex, so a real mousedown
    // focuses it *before* the eventual 'click' fires: the tooltip flashes
    // open at the country's center, then jumps to the right spot once our
    // click handler runs on release. preventDefault on mousedown stops the
    // browser from focusing it in the first place, so that never happens.
    // (Layers only get a real _path once actually added to the map, hence
    // this runs here rather than in onEachFeature, same as the tabindex fix.)
    function stripCountryTabIndex(geoJsonLayer) {
      geoJsonLayer.eachLayer((layer) => {
        if (!layer._path) return;
        layer._path.removeAttribute('tabindex');
        layer._path.addEventListener('mousedown', (ev) => ev.preventDefault());
      });
    }

    // state.geoLayer stays the one true (offset 0) copy — it's the only one
    // any other code needs to reference (country search/directory, etc.).
    // The west/east copies are purely visual+interactive twins, built from
    // the same data and never touched again after this.
    state.geoLayer = L.geoJSON(countryGeo, countryLayerOptions).addTo(map);
    stripCountryTabIndex(state.geoLayer);
    for (const offsetDeg of [-360, 360]) {
      const ghostLayer = L.geoJSON(shiftGeoJSONLng(countryGeo, offsetDeg), countryLayerOptions).addTo(map);
      stripCountryTabIndex(ghostLayer);
      state.geoLayerGhosts.push(ghostLayer);
    }

    addOceanLabels();

    for (const key of Object.keys(DIVISIONS)) {
      state.clusterGroups[key] = L.markerClusterGroup({
        iconCreateFunction: clusterIconFactory(key),
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        // Off so the clusterclick handler below can cap the zoom itself —
        // see that handler's comment for why.
        zoomToBoundsOnClick: false,
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

      const stageKey = String(row.is_developing).trim().toLowerCase() === 'true' ? 'developing' : 'established';
      const popupHtml = buildPopupHtml(row, divisionKey);
      const popupOptions = {
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
      };

      const marker = L.marker([lat, lng], { icon: markerIcon(divisionKey, stageKey) });
      marker.bindTooltip(row.city, { direction: 'left', offset: [-10, 0], className: 'marker-tooltip' });
      marker.bindPopup(popupHtml, popupOptions);
      state.clusterGroups[divisionKey].addLayer(marker);

      if (!state.markersByCountry.has(countryName)) state.markersByCountry.set(countryName, []);
      state.markersByCountry.get(countryName).push({ marker, row });

      // West/east twins for the flanking world copies (see
      // shiftGeoJSONLng's comment) — same icon/tooltip/popup, just offset.
      // Not tracked in state.markersByCountry: search/directory should
      // always fly to this one true marker, not one of its twins.
      for (const offsetDeg of [-360, 360]) {
        const ghostMarker = L.marker([lat, lng + offsetDeg], { icon: markerIcon(divisionKey, stageKey) });
        ghostMarker.bindTooltip(row.city, { direction: 'left', offset: [-10, 0], className: 'marker-tooltip' });
        ghostMarker.bindPopup(popupHtml, popupOptions);
        state.clusterGroups[divisionKey].addLayer(ghostMarker);
      }

      placed++;
    }

    for (const group of Object.values(state.clusterGroups)) {
      map.addLayer(group);
    }

    // Leaflet.markercluster's default cluster-click zoom jumps straight to
    // whatever level fully separates that cluster's members — fine for
    // loosely-spaced pins, but a wild, disorienting jump for two ministries
    // right on top of each other (tested interactively with a tunable
    // slider to land on 3). spiderfyOnMaxZoom above still fans out any
    // pins that stay clustered after hitting the cap, so nothing's ever
    // unreachable — it may just take an extra tap.
    const CLUSTER_CLICK_MAX_ZOOM_STEP = 3;
    for (const group of Object.values(state.clusterGroups)) {
      group.on('clusterclick', (e) => {
        const cluster = e.layer;
        const idealZoom = map.getBoundsZoom(cluster.getBounds());
        const cap = map.getZoom() + CLUSTER_CLICK_MAX_ZOOM_STEP;
        map.setView(cluster.getLatLng(), Math.min(idealZoom, cap, map.getMaxZoom()));
      });
    }

    recomputeCountriesWithVisiblePins(ministryRows);
    refreshCountryStyles();
    buildLegend();
    wireLegendToggle();
    buildCountryDirectory(ministryRows);
    wireDirectoryControls();
    wirePhotoPreview();
    wireMinistryPhotoCarousel();
    wireVideoLightbox();
    wireTitleEasterEgg();
    wireBackButtonReset();

    if (unmatchedCountries.size) {
      console.warn(
        `${unmatchedCountries.size} ministry row(s) had a country not found in country-divisions.csv:`,
        Array.from(unmatchedCountries)
      );
    }
    console.info(`Plotted ${placed} of ${ministryRows.length} ministry rows.`);
    hideStatus();
    // Exposed so worker/routes/map-screenshot.js's Puppeteer captures can
    // reframe the view (setView/fitBounds) before screenshotting — the map
    // itself has no other reason to be on window,
    // `map` is otherwise just a module-top-level const.
    window.__reportMap = map;

    // Africa's ministries are sparse relative to its landmass (most of its
    // division-assigned countries have zero ministry rows), but the org
    // wants its map/report to always read as the whole continent anyway —
    // unlike every other division, where a country with no ministries
    // (Norway, China, etc. — see __divisionBounds below) reads better
    // cropped out than left in as empty filler. This is a deliberate
    // per-division exception, not something derivable from the data.
    const FULL_COVERAGE_DIVISIONS = new Set(['africa']);
    // Europe and Asia Pacific each have one or two countries whose sheer
    // landmass (Norway, China) used to pull in a lot of empty territory
    // even after the anchor fix below, because plain proximity to a real
    // marker (the rule every other division still uses) was generous
    // enough to keep them anyway — Norway sits well within 15° of Germany,
    // for instance. These two get a stricter rule: a country counts only
    // if it has its own ministry marker, full stop, no proximity fallback.
    // Middle East & Central Asia and Latin America & Caribbean keep the
    // proximity rule deliberately — most of what makes their maps look
    // right (Turkey/Iran/Saudi Arabia in the former, several Latin
    // American countries in the latter) comes from countries near real
    // markers that don't have any ministries of their own yet.
    const STRICT_MARKER_DIVISIONS = new Set(['europe', 'asia']);

    function divisionMarkerCountries(divisionKey) {
      const result = new Set();
      for (const countryName of state.markersByCountry.keys()) {
        if (state.countryDivisionByName.get(countryName) === divisionKey) result.add(countryName);
      }
      return result;
    }

    // Same anchor-and-shift-outliers trick as computeMainLandBounds, but
    // flattened across every polygon piece of every country in one
    // division at once. Used by map-screenshot.js to fit each division's
    // zoomed-in map; returns a plain [[south,west],[north,east]] array
    // (not an L.LatLngBounds) since that's what survives the Puppeteer
    // page.evaluate() serialization boundary.
    window.__divisionBounds = function (divisionKey) {
      const fullCoverage = FULL_COVERAGE_DIVISIONS.has(divisionKey);
      const markerCountries = divisionMarkerCountries(divisionKey);
      const pieces = [];
      state.geoLayer.eachLayer((layer) => {
        const name = normalizeCountryName(layer.feature.properties.name);
        if (state.countryDivisionByName.get(name) !== divisionKey) return;
        const geom = layer.feature.geometry;
        const polygons = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
        for (const poly of polygons) {
          const ring = poly[0]; // outer ring; holes don't matter for a bbox
          let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
          for (const [lng, lat] of ring) {
            if (lng < west) west = lng;
            if (lng > east) east = lng;
            if (lat < south) south = lat;
            if (lat > north) north = lat;
          }
          pieces.push({ west, east, south, north, area: (east - west) * (north - south), countryName: name });
        }
      });
      if (!pieces.length) return null;

      // A division can itself legitimately span the antimeridian (Asia
      // Pacific's real ministries run from Bangladesh to New Zealand, and
      // the short way around crosses 180°) — every piece and every marker
      // below gets shifted by whichever multiple of 360 lands it closest
      // to the anchor, same trick computeMainLandBounds uses for one
      // country's split multipolygon pieces.
      if (fullCoverage) {
        let anchor = pieces[0];
        for (const p of pieces) if (p.area > anchor.area) anchor = p;
        const anchorCenterLng = (anchor.west + anchor.east) / 2;
        const anchorCenterLat = (anchor.south + anchor.north) / 2;
        // Full coverage still excludes a country's own tiny, far-flung
        // possessions (South Africa's Prince Edward Islands, ~12° south of
        // the mainland) — otherwise one subantarctic speck drags the whole
        // continent's frame down to include a huge stretch of empty ocean
        // for a dot too small to even see. A real landmass (Madagascar,
        // 65° from the mainland anchor but a substantial island) still
        // gets through on size alone.
        const CLOSE_ENOUGH_DEGREES = 25;
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const p of pieces) {
          const centerLng = (p.west + p.east) / 2;
          const centerLat = (p.south + p.north) / 2;
          const shift = Math.round((anchorCenterLng - centerLng) / 360) * 360;
          const shiftedWest = p.west + shift, shiftedEast = p.east + shift;
          const dist = Math.hypot((centerLng + shift) - anchorCenterLng, centerLat - anchorCenterLat);
          const closeEnough = dist <= CLOSE_ENOUGH_DEGREES;
          const bigEnough = p.area >= anchor.area * 0.1;
          if (p !== anchor && !closeEnough && !bigEnough) continue;
          if (shiftedWest < minLng) minLng = shiftedWest;
          if (shiftedEast > maxLng) maxLng = shiftedEast;
          if (p.south < minLat) minLat = p.south;
          if (p.north > maxLat) maxLat = p.north;
        }
        return [[minLat, minLng], [maxLat, maxLng]];
      }

      // The anchor is chosen only from pieces whose country actually has a
      // ministry marker — otherwise the single largest LANDMASS in the
      // whole division (Norway in Europe, China in Asia Pacific — neither
      // has any ministries) always forced its way into frame as "the
      // anchor" regardless of relevance, which is why Europe's map used to
      // include all of Scandinavia and Asia Pacific's included China's
      // full northern border. Falls back to the largest piece overall only
      // if the division genuinely has zero markers anywhere.
      const markerPieces = pieces.filter((p) => markerCountries.has(p.countryName));
      const anchorCandidates = markerPieces.length ? markerPieces : pieces;
      let anchor = anchorCandidates[0];
      for (const p of anchorCandidates) if (p.area > anchor.area) anchor = p;
      const anchorCenterLng = (anchor.west + anchor.east) / 2;

      // A piece earns a spot in frame if it's the anchor, if one of its
      // own country's markers actually falls inside it (not just
      // "somewhere in the same country" — Russia's own markers are all in
      // its mainland, so this correctly excludes a remote Russian Arctic
      // island piece the same way it excludes Norway's Svalbard piece,
      // rather than blanket-including every piece of any marker-owning
      // country), or — for every division except STRICT_MARKER_DIVISIONS —
      // if a real ministry marker from this division just sits near it
      // (data-driven rather than a generic size/distance cutoff).
      const strict = STRICT_MARKER_DIVISIONS.has(divisionKey);
      const markerPoints = [];
      for (const [countryName, entries] of state.markersByCountry) {
        if (state.countryDivisionByName.get(countryName) !== divisionKey) continue;
        for (const { marker } of entries) {
          const ll = marker.getLatLng();
          const shift = Math.round((anchorCenterLng - ll.lng) / 360) * 360;
          markerPoints.push({ lng: ll.lng + shift, lat: ll.lat, countryName });
        }
      }
      const MARKER_PROXIMITY_DEGREES = 15;

      let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
      // Proximity alone (nearMarker) pulls in whichever direction the
      // nearest neighboring countries happen to sit, which isn't always
      // where the map should actually extend — Middle East & Central
      // Asia's markers (Russia, Kazakhstan, Uzbekistan, Kyrgyzstan) are
      // roughly as close to Turkey (worth keeping) as to Iran/Iraq/
      // Afghanistan (not, once they pull the frame's south edge that far
      // down). coreMinLat tracks how far south the anchor/own-marker
      // pieces alone would reach, and clamps the final south edge to that
      // — proximity can still extend north/east/west, just not drag the
      // bottom of the frame down toward a cluster of markerless countries.
      let coreMinLat = Infinity;
      for (const p of pieces) {
        const centerLng = (p.west + p.east) / 2;
        const centerLat = (p.south + p.north) / 2;
        const shift = Math.round((anchorCenterLng - centerLng) / 360) * 360;
        const shiftedWest = p.west + shift, shiftedEast = p.east + shift;
        const shiftedCenterLng = centerLng + shift;
        const containsOwnMarker = markerPoints.some(
          (m) => m.countryName === p.countryName && m.lng >= shiftedWest && m.lng <= shiftedEast && m.lat >= p.south && m.lat <= p.north
        );
        const nearMarker = !strict && markerPoints.some(
          (m) => Math.hypot(m.lng - shiftedCenterLng, m.lat - centerLat) <= MARKER_PROXIMITY_DEGREES
        );
        if (p !== anchor && !containsOwnMarker && !nearMarker) continue;
        if (shiftedWest < minLng) minLng = shiftedWest;
        if (shiftedEast > maxLng) maxLng = shiftedEast;
        if (p.south < minLat) minLat = p.south;
        if (p.north > maxLat) maxLat = p.north;
        if (p === anchor || containsOwnMarker) {
          if (p.south < coreMinLat) coreMinLat = p.south;
        }
      }
      if (coreMinLat !== Infinity) minLat = Math.max(minLat, coreMinLat);
      // A division with zero ministry markers anywhere (shouldn't happen
      // today, but nothing guarantees it never will) would otherwise
      // return an empty/invalid box — fall back to the anchor alone.
      if (minLng === Infinity) return [[anchor.south, anchor.west], [anchor.north, anchor.east]];
      return [[minLat, minLng], [maxLat, maxLng]];
    };

    // Report/map-screenshot-only isolation: colors only divisionKey's own
    // marker-bearing countries with its division color and shows only its
    // own marker clusters, regardless of the normal
    // state.countriesWithVisiblePins-driven styling (which colors a
    // country whenever ANY of its markers are currently un-clustered/
    // visible — at a division-wide zoom that was lighting up neighboring
    // divisions' countries too, since their pins were incidentally visible
    // in the same crop). Unlike __divisionBounds above, coloring has no
    // FULL_COVERAGE_DIVISIONS exception — Africa's map still frames the
    // whole continent, but only paints the countries that actually have
    // ministries; a country being in the frame doesn't mean it should
    // look like it has ministries when it doesn't. Idempotent and
    // self-correcting across repeated calls for different divisions in the
    // same page session — every layer/group is explicitly set on each
    // call, nothing toggled relative to prior state.
    window.__isolateDivision = function (divisionKey) {
      const markerCountries = divisionMarkerCountries(divisionKey);
      for (const [key, group] of Object.entries(state.clusterGroups)) {
        if (key === divisionKey) {
          if (!map.hasLayer(group)) map.addLayer(group);
        } else if (map.hasLayer(group)) {
          map.removeLayer(group);
        }
      }
      for (const geoJsonLayer of [state.geoLayer, ...state.geoLayerGhosts]) {
        geoJsonLayer.eachLayer((layer) => {
          const name = normalizeCountryName(layer.feature.properties.name);
          const shouldColor = markerCountries.has(name);
          if (shouldColor) {
            layer.setStyle({
              fillColor: DIVISIONS[divisionKey].country,
              fillOpacity: 0.85,
              color: HIGHLIGHT_BORDER,
              weight: 0.8,
            });
          } else {
            layer.setStyle({
              fillColor: DEFAULT_LAND_FILL,
              fillOpacity: 0.9,
              color: DEFAULT_LAND_BORDER,
              weight: 0.5,
            });
          }
        });
      }
    };
    // Signal for worker/routes/map-screenshot.js's Puppeteer capture to
    // wait on (page.waitForFunction) — everything above this point is
    // synchronous DOM work, so once it's run the map is visually complete.
    window.__mapReady = true;
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
