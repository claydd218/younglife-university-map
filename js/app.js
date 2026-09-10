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
  coastalGlowRenderer: null, // the glow pane's own SVG renderer — see its own comment
  clusterGroups: {}, // division key -> L.markerClusterGroup
  markersByCountry: new Map(), // country name -> [{ marker, row }]
  openCountryTooltipLayer: null, // the one country layer whose tooltip is open, if any
  // name -> {meta: role}, for whichever ministry row lists them as home
  // staff — lets a popup resolve someone assigned there from elsewhere
  // (row.assigned_staff, just names) without a search per popup. See
  // buildPopupHtml and worker/lib/ministries.js's comment on why a name
  // is the only link between an assignment and where its role/photo
  // actually live.
  staffHomeByName: new Map(),
  worldMetrics: null, // [{label, num}, ...], computed once ministry data loads
  metricsByDivision: new Map(), // division key -> [{label, num}, ...]
  metricsByCountry: new Map(), // normalized country name -> [{label, num}, ...]
  currentNavView: 'world', // 'world' or a DIVISIONS key — which nav-menu item is active
  overlayDismissed: false, // has the metrics overlay been faded out by user interaction
  // True only while a nav-menu selection's own programmatic setView/fitBounds
  // is in flight, so that move doesn't immediately re-trigger the same
  // dismiss-on-interaction logic it was called to override — see wireNavMenu.
  suppressOverlayDismiss: false,
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
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control directory-control');
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
// True only while one of a few specific scripted moves is in flight —
// zoomToShowMarker (the search directory's per-area pick, revealing a
// clustered pin) and tourFlyToAndWait (the ?tour=NAME tour's own legs),
// both far below. Those are real culprits behind a genuine bug: each is a
// live, animated pan/zoom that can transiently swing the view across
// SOUTH_LIMIT_LAT/the north edge mid-flight even when its own FINAL
// resting position is fine (e.g. zooming in on a clustered pin near the
// south of a country whose own bounds are already close to the limit) —
// and since clampSouth/clampNorth react to every single 'move' tick, not
// just the settled end state, that mid-flight crossing was enough to
// trigger a correction *during* the animation, which read as the view
// overshooting south and then visibly snapping back. Confirmed live.
// Suppressing the correction while one of these moves is animating, then
// re-enabling it and running one explicit check once that move has
// actually settled (see each one's own code), fixes the final resting
// position exactly the same way without any of the mid-flight fighting.
// Deliberately NOT used for goToWorld/goToDivision or a real country-
// polygon click — those are also how a real visitor moves the map (nav
// menu, clicking a country), where per-frame correction during a drag is
// the actual intended behavior (see this function's own header comment
// below).
let suppressMapClamp = false;

const SOUTH_LIMIT_LAT = -71;
function clampSouth() {
  if (suppressMapClamp) return;
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
  if (suppressMapClamp) return;
  const trueEdgePt = map.latLngToContainerPoint([85.0511, map.getCenter().lng]);
  if (trueEdgePt.y > NORTH_LIMIT_PX) {
    map.panBy([0, trueEdgePt.y - NORTH_LIMIT_PX], { animate: false });
  }
}
map.on('move', clampNorth);

// Closes whichever country name tooltip is currently open (state.
// openCountryTooltipLayer, set in the country layer's own click handler in
// init()) — top-level, not nested in init(), so the legend, search
// directory, and nav menu can all call it too when they open, alongside
// init()'s own map click/dragstart handlers.
function closeOpenCountryTooltip() {
  if (state.openCountryTooltipLayer) {
    state.openCountryTooltipLayer.closeTooltip();
    state.openCountryTooltipLayer = null;
  }
}

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

// A thumbtack silhouette — round head, and the "pin" itself is just a thin
// line (not a filled triangle, which read as an ice cream cone). Defined
// straight down from the circle's own true bottom point (12,14) — tangent,
// no kink — then the head+needle are rotated together as one rigid group,
// 30° left of vertical, around the circle's own center. Rotating as a
// group (rather than just drawing the line at an angle from a fixed head)
// is what keeps the needle meeting the head cleanly at every angle instead
// of looking like it sprouts from an arbitrary point on the circle's edge.
// The needle is always the same ink-colored line regardless of stage (see
// its CSS) — only the head's fill differs between established/developing.
// fillColor is the developing head's fill (the division's own muted
// country color, so an "open" head reads as filled-but-not-solid-yet
// rather than a literal hole showing the map underneath) — unused for the
// established/filled variant, which always fills solid with `color`.
function shapeMarkup(shape, color, fillColor) {
  return `<svg class="pin-shape pin-${shape}" viewBox="0 0 24 24" style="--pin-color:${color}; --pin-fill:${fillColor}">
    <g transform="rotate(30 12 8)">
      <line x1="12" y1="14" x2="12" y2="24"/>
      <circle cx="12" cy="8" r="6"/>
    </g>
  </svg>`;
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
    html: shapeMarkup(stage.shape, div.pin, div.country),
    // Anchored at the needle's tip — (12,24) rotated 30° around the
    // circle's center (12,8) lands at (4, 21.86) in the 24x24 viewBox,
    // scaled to this icon box — where the tack actually marks a location,
    // not the icon's center or top-left. popupAnchor is relative to that
    // same off-center anchor, with an offsetting positive X to land the
    // popup back over the round head's center instead of the head's own
    // left edge.
    iconSize: [22, 28],
    iconAnchor: [4, 26],
    popupAnchor: [7, -17],
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

// Fires a plain background fetch for `url` so it's already sitting in the
// browser's HTTP cache by the time something actually needs to display
// it — a `new Image()` never gets attached to the DOM, so this has no
// visible effect on its own, it just warms the cache. Used below so every
// ministry's own popup-thumbnail photo (the same URL buildPopupHtml's own
// <img> will request) starts downloading the moment the map loads,
// instead of only starting once a visitor actually opens that popup.
//
// The Image object itself is pushed into preloadedImagePool rather than
// left to fall out of scope — with hundreds of these firing at once on
// page load, an unreferenced one is eligible for GC before its request
// actually finishes, which can silently abort the very fetch this
// function exists to start. Never drained — held for the life of the
// page, same as the DOM would hold it if it were a real <img>.
const preloadedImagePool = [];

function preloadImage(url) {
  const img = new Image();
  img.src = url;
  preloadedImagePool.push(img);
}

// Same cache-warming idea as preloadImage above, but for a staff photo,
// whose filename (unlike a ministry's own photos, named explicitly in
// ministries.csv) is only ever a guess — slug + whichever of
// CONFIG.IMAGE_EXTENSIONS actually exists, the same cascade photoTag's
// own onerror chain (window.__imgFallback) runs the first time a real
// <img> for this staff member is displayed. Replays that same cascade
// here, silently, via a detached Image() with no DOM attachment, so
// whichever extension actually exists is already cached by the time a
// popup needs to show it — same reasoning as preloadImage, just with the
// extension unknown upfront instead of given.
// The same staff member can appear across multiple ministries (their own
// home entry, plus wherever else they're assigned) — each of those rows'
// own buildPopupHtml call would otherwise kick off the same cascade
// again. Deduped here rather than at each call site.
const staffPhotoPreloadStarted = new Set();

function preloadStaffPhoto(slug, extIdx = 0) {
  if (extIdx === 0) {
    if (staffPhotoPreloadStarted.has(slug)) return;
    staffPhotoPreloadStarted.add(slug);
  }
  if (extIdx >= CONFIG.IMAGE_EXTENSIONS.length) return;
  const img = new Image();
  img.onerror = () => preloadStaffPhoto(slug, extIdx + 1);
  img.src = `${CONFIG.IMAGES_DIR}${slug}.${CONFIG.IMAGE_EXTENSIONS[extIdx]}`;
  preloadedImagePool.push(img);
}

function buildPopupHtml(row, divisionKey) {
  const div = DIVISIONS[divisionKey];
  const flag = flagEmoji(state.countryIsoByName.get(normalizeCountryName(row.country)));

  const ownStaff = parseParenList(row.staff);
  const ownStaffNames = new Set(ownStaff.map((s) => s.name));

  // Staff assigned here from elsewhere (a name only — role/photo resolve
  // through their home entry, state.staffHomeByName) render first, ahead
  // of this ministry's own staff — they're effectively the on-site lead.
  // A name with no resolvable home (a dangling reference) is skipped
  // rather than shown with no role at all. Also skips a name that's
  // already this same ministry's own staff — a mistaken self-assignment
  // (someone assigned to their own home ministry, confirmed live as real
  // stored data, not just a hypothetical) would otherwise render them
  // twice back to back.
  const assignedStaff = (row.assigned_staff || '').split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((name) => !ownStaffNames.has(name))
    .map((name) => {
      const home = state.staffHomeByName.get(name);
      return home ? { name, meta: home.meta } : null;
    })
    .filter(Boolean);
  const staff = [...assignedStaff, ...ownStaff];
  const staffHtml = staff.length
    ? `<ul class="popup-staff">${staff
        .map((s) => {
          preloadStaffPhoto(slugify(s.name));
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
  if (photos.length) preloadImage(CONFIG.IMAGES_DIR + photos[0]);
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
  const stageList = document.getElementById('legend-stages');
  stageList.innerHTML = '';
  for (const stage of Object.values(STAGES)) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="legend-stage-row">
        ${shapeMarkup(stage.shape, 'var(--ink)', 'var(--card-bg)')}
        <span class="legend-label">${escapeHtml(stage.label)}</span>
      </span>
    `;
    stageList.appendChild(li);
  }
}

// "1 Ministry Area" not "1 Ministry Areas" — every metric label goes
// through this, singular form only when the count is exactly 1.
function pluralizeLabel(num, singular, plural) {
  return num === 1 ? singular : plural;
}

// Mirrors bigtime/report/report.js's own computeMetrics, which drives the
// same four numbers on the PDF report — kept in sync by eye since one runs
// against parsed row objects (staff/universities already arrays) and this
// one runs against the raw CSV rows this page loads (staff/universities
// still semicolon-delimited strings, hence parseParenList here).
// includeCountries: false drops the "Countries" box entirely — used for a
// single-country view (see the country click handler in init()), where
// that count is always exactly 1 and just restates the label above it.
function computeMetrics(rowsSubset, { includeCountries = true } = {}) {
  const metrics = [];
  if (includeCountries) {
    const countries = new Set(rowsSubset.map((r) => normalizeCountryName(r.country)).filter(Boolean));
    metrics.push({ label: pluralizeLabel(countries.size, 'Country', 'Countries'), num: countries.size });
  }
  const ministryAreaCount = rowsSubset.length;
  const staffCount = rowsSubset.reduce((sum, r) => sum + parseParenList(r.staff).length, 0);
  const universityCount = rowsSubset.reduce((sum, r) => sum + parseParenList(r.universities).length, 0);
  metrics.push(
    { label: pluralizeLabel(ministryAreaCount, 'Ministry Area', 'Ministry Areas'), num: ministryAreaCount },
    // "Staff" reads the same singular or plural (a collective noun,
    // unlike the other three) — routed through pluralizeLabel anyway so
    // every label follows the same pattern, not because the word itself
    // changes.
    { label: pluralizeLabel(staffCount, 'Staff', 'Staff'), num: staffCount },
    { label: pluralizeLabel(universityCount, 'University', 'Universities'), num: universityCount },
  );
  return metrics;
}

// Counts `el`'s displayed number up from 0 to `target` over
// METRIC_COUNT_UP_MS — eased out (fast start, settles into the final
// value) rather than linear, so it reads as a quick flourish rather than
// a visible ticking clock. Each call's rAF loop writes to the specific
// `el` it closed over, so an old, still-running animation from a metric
// box that's since been replaced (renderMetrics rebuilds .metrics-boxes'
// whole innerHTML on every call) just harmlessly finishes writing to a
// detached node — nothing to cancel, nothing left visible.
const METRIC_COUNT_UP_MS = 950;

function animateCountUp(el, target) {
  if (!target) {
    el.textContent = '0';
    return;
  }
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / METRIC_COUNT_UP_MS);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = String(Math.round(eased * target));
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderMetrics(metrics, accentColor) {
  const container = document.getElementById('metrics-boxes');
  const boxStyle = accentColor ? ` style="border-color:${accentColor}"` : '';
  const textStyle = accentColor ? ` style="color:${accentColor}"` : '';
  container.innerHTML = metrics.map(({ label, num }) => `
    <div class="metric-box"${boxStyle}>
      <div class="metric-box-label"${textStyle}>${escapeHtml(label).replace(' ', '<br>')}</div>
      <div class="metric-box-num"${textStyle}>0</div>
    </div>
  `).join('');
  const numEls = container.querySelectorAll('.metric-box-num');
  metrics.forEach((m, i) => animateCountUp(numEls[i], m.num));
}

// labelHtml identifies *what* the metrics below it describe — a division
// name, or a country name with its flag — shown above the boxes for every
// view except World (world metrics are the default/ambient state, not a
// selection that needs naming). Trusted pre-built HTML, not plain text:
// callers that include a country/division name are responsible for
// escaping it themselves (see the two call sites in init()), same
// division-of-labor as buildPopupHtml's own callers.
//
// map's 'popupopen' listener calls this (via showCountryMetricsOverlay)
// every time ANY popup opens, including a second pin clicked in the same
// country whose metrics are already up — without the check below, that
// re-ran renderMetrics with the exact same numbers, restarting the
// count-up animation from 0 for no visible reason. Skipped only when the
// overlay is already showing (not mid-hide/re-reveal, which should still
// animate) and the content is byte-for-byte the same as what's already
// there.
let lastMetricsSignature = null;

function showMetricsOverlay(metrics, accentColor, labelHtml) {
  const signature = JSON.stringify([metrics, accentColor, labelHtml]);
  const alreadyShowing = !state.overlayDismissed && signature === lastMetricsSignature;
  if (!alreadyShowing) {
    renderMetrics(metrics, accentColor);
    lastMetricsSignature = signature;
  }
  const labelEl = document.getElementById('metrics-label');
  if (labelHtml) {
    labelEl.innerHTML = labelHtml;
    labelEl.hidden = false;
  } else {
    labelEl.hidden = true;
  }
  const overlay = document.getElementById('metrics-overlay');
  overlay.classList.remove('metrics-hidden');
  overlay.setAttribute('aria-hidden', 'false');
  state.overlayDismissed = false;
}

// Shows `name`'s own metrics + flag/name label, with no camera move of its
// own — shared by the country-polygon click handler (which also flies the
// map there) and, below, opening any ministry's popup. A pin click no
// longer dismisses the overlay (see wireMetricsOverlayDismiss), but on its
// own that just leaves whatever was already showing up — e.g. clicking a
// Costa Rica pin while Nicaragua's metrics/label were still up from an
// earlier country click left Nicaragua showing, which is exactly what this
// closes: every popup open re-syncs the overlay to that ministry's own
// country, so it always describes what's actually in focus. A no-op for a
// country somehow not in countriesWithVisiblePins (shouldn't happen for a
// real ministry's own country, but the map click handler already guards
// the same lookup, so this mirrors that rather than assuming).
function showCountryMetricsOverlay(name) {
  const present = state.countriesWithVisiblePins.get(name);
  if (!present || !present.size) return;
  // A country can only ever belong to one division in practice (see the
  // country click handler's own identical comment on this) — picking the
  // first is a reasonable fallback rather than a real ambiguity to resolve.
  const divisionKey = present.values().next().value;
  const flag = flagEmoji(state.countryIsoByName.get(name));
  showMetricsOverlay(
    state.metricsByCountry.get(name) || [],
    DIVISIONS[divisionKey].pin,
    `${flag ? `${flag} ` : ''}${escapeHtml(name)}`,
  );
}

function hideMetricsOverlay() {
  if (state.overlayDismissed) return;
  state.overlayDismissed = true;
  const overlay = document.getElementById('metrics-overlay');
  overlay.classList.add('metrics-hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

// A real, user-driven map interaction dismisses the overlay: dragging
// ('dragstart') or zooming by hand — scroll wheel, pinch, double-click, the
// +/- control ('zoomstart', covers all of those) — or a plain click that
// doesn't move the map at all (an empty-area or country click — see the
// country click handler in init()). Suppressed while a nav-menu selection's
// own setView/fitBounds is playing out, so picking "World" or a division
// doesn't immediately re-hide the overlay it just asked to show.
//
// Deliberately NOT the generic 'movestart' (which used to be the trigger
// here) — that fires for every programmatic view change too, not just
// real user drags/zooms, and there's a real one that isn't obviously a
// "leave this selection" moment: opening a ministry popup near a screen
// edge triggers this file's own header/edge-clearance auto-pan
// (map.panBy, below), which used to immediately dismiss the overlay right
// after a pin click that's otherwise exempt from dismissing it at all —
// confirmed live as the cause of a pin click still closing the country
// overlay via that pan. 'dragstart'/'zoomstart' only ever fire for the
// user's own hand on the map (Leaflet's Drag/Zoom input handlers), never
// for a plain panBy/setView/flyTo call made from code, so every
// programmatic move in this file (that popup auto-pan included) is
// naturally exempt without needing its own suppression.
//
// Clicking a ministry pin or a cluster badge is exempt from the click
// trigger — browsing individual ministries (opening a popup) or zooming
// into a cluster is still "looking at the same selection," not leaving
// it, so neither should dismiss the overlay; the cluster-click zoom
// handler below wraps its own setView in withSuppressedDismiss the same
// way a nav-menu move does (mainly for the *bubbled click* on the cluster
// icon, since its zoom is a 'zoomstart' either way and — per above —
// wouldn't have dismissed on its own regardless). What remains to guard
// against for clicks is just the click itself bubbling up to this
// map-level listener — inspecting the real DOM target (not Leaflet's
// synthetic event propagation, which historically shifted across marker/
// cluster-plugin versions) is the most robust way to tell "this click
// landed on a pin/cluster icon" apart from blank map or country-polygon
// clicks, which should still dismiss as before.
function wireMetricsOverlayDismiss() {
  function maybeHide() {
    if (state.suppressOverlayDismiss) return;
    hideMetricsOverlay();
  }
  map.on('dragstart zoomstart', maybeHide);
  map.on('click', (e) => {
    if (e.originalEvent && e.originalEvent.target && e.originalEvent.target.closest('.ministry-marker, .ministry-cluster')) return;
    maybeHide();
  });
  // The overlay itself now has pointer-events:auto (see .metrics-overlay in
  // css/style.css) specifically so a tap on it never falls through to
  // whatever country/marker is underneath — which also means that tap
  // never reaches the map's own 'click' event above, so it needs its own
  // listener here to still dismiss the overlay.
  document.getElementById('metrics-overlay').addEventListener('click', maybeHide);
}

// Upper-right hamburger menu: "World" re-centers on the default view and
// shows the world metrics; each division pans/zooms to that division's
// bounds (same __divisionBounds the PDF/report maps use) and shows its
// metrics in its own color. Deliberately does NOT call __isolateDivision —
// this is just a camera move, every division stays colored the way it
// always does on the live map.
// Exposed so the title easter egg (wireTitleEasterEgg) can trigger the
// exact same "World" reset — including the movestart-dismiss suppression
// goToWorld already handles — without duplicating that logic. goToDivisionFn
// is the same idea, for runQueryStringTour's own scripted tour below.
let goToWorldFn = null;
let goToDivisionFn = null;

// Module-level (not a fresh closure per call) specifically so two calls in
// quick succession — e.g. picking a division right before the title easter
// egg fires its own goToWorld — share one suppression window instead of
// racing. Each call used to set up its own independent moveend listener/
// debounce/hard-ceiling closure, all driving the same shared
// state.suppressOverlayDismiss flag — so an earlier call's own debounced
// clear() could flip that flag back to false while a *later* call's move
// was still animating, letting the overlay dismiss itself mid-transition
// (confirmed live: triggering the easter egg shortly after a division
// click left the metrics overlay hidden and the map never reaching the
// world view). Starting a new call here now always cancels whatever
// listener/timers a previous call left pending first, so only the latest
// call's own settling can ever actually clear the flag.
let suppressDismissMoveEndListener = null;
let suppressDismissDebounceTimer = null;
let suppressDismissHardTimer = null;

// The nav-menu's own move is what's suppressing dismiss here, so it needs
// to un-suppress itself once that move actually settles. A big zoom
// change (world -> a division) doesn't animate as one single pan/zoom —
// Leaflet plays it as several legs (e.g. an animated pan, then a instant
// zoom step), each firing its own movestart/moveend, and marker-cluster
// re-clustering on top of that can fire more of the same — confirmed live
// by the overlay dismissing itself mid-transition when this only waited
// for the first moveend. So: debounce on every moveend seen and only
// actually clear once none has fired for a bit, with a hard ceiling in
// case moveend never fires cleanly at all (e.g. fitBounds silently no-ops
// when the map's already sitting at the requested view).
function withSuppressedDismiss(moveFn) {
  state.suppressOverlayDismiss = true;
  if (suppressDismissMoveEndListener) map.off('moveend', suppressDismissMoveEndListener);
  clearTimeout(suppressDismissDebounceTimer);
  clearTimeout(suppressDismissHardTimer);

  const clear = () => {
    state.suppressOverlayDismiss = false;
    if (suppressDismissMoveEndListener) {
      map.off('moveend', suppressDismissMoveEndListener);
      suppressDismissMoveEndListener = null;
    }
    clearTimeout(suppressDismissDebounceTimer);
    clearTimeout(suppressDismissHardTimer);
  };
  suppressDismissMoveEndListener = () => {
    clearTimeout(suppressDismissDebounceTimer);
    suppressDismissDebounceTimer = setTimeout(clear, 300);
  };
  map.on('moveend', suppressDismissMoveEndListener);
  suppressDismissHardTimer = setTimeout(clear, 3000);
  moveFn();
}

function wireNavMenu() {
  const toggle = document.getElementById('nav-menu-toggle');
  const menu = document.getElementById('nav-menu');
  const list = document.getElementById('nav-menu-list');

  function closeMenu() {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    closeOpenCountryTooltip();
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }

  list.innerHTML = `<li><button type="button" class="nav-menu-item active" data-nav="world">
        <img class="nav-menu-icon" src="images/favicon.svg" alt="">
        <span>World</span>
      </button></li>`
    + Object.entries(DIVISIONS).map(([key, div]) => `
      <li><button type="button" class="nav-menu-item" data-nav="${escapeHtml(key)}">
        <span class="color-swatch" style="background:${div.pin}"></span>
        <span>${escapeHtml(div.label)}</span>
      </button></li>
    `).join('');

  function setActive(navKey) {
    list.querySelectorAll('.nav-menu-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.nav === navKey);
    });
  }

  function goToWorld() {
    state.currentNavView = 'world';
    setActive('world');
    map.closePopup();
    withSuppressedDismiss(() => {
      // flyTo, not setView — a plain animated setView only actually
      // animates when the zoom-level change is under Leaflet's own
      // zoomAnimationThreshold (4 by default); past that it silently
      // skips the animation and jumps straight to the target instead,
      // which is exactly what a big move (e.g. zoomed into one country
      // and choosing World) was doing despite animate:true. flyTo has no
      // such cutoff — it always plays its own zoom-out/pan/zoom-in curve,
      // which is also just a more dynamic transition in general.
      flyToWithRedrawWatch(() => map.flyTo(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM));
    });
    showMetricsOverlay(state.worldMetrics, null);
  }
  goToWorldFn = goToWorld;

  function goToDivision(key) {
    const bounds = window.__divisionBounds(key);
    if (!bounds) return;
    state.currentNavView = key;
    setActive(key);
    map.closePopup();
    withSuppressedDismiss(() => {
      // Extra top padding clears the header/metrics overlay; the rest is
      // just breathing room, same spirit as mapCapture.js's DIVISION_PADDING.
      // flyToBounds — see goToWorld's comment on why flyTo(Bounds) over a
      // plain animated fitBounds/setView.
      flyToWithRedrawWatch(() => map.flyToBounds(bounds, {
        paddingTopLeft: [40, 170],
        paddingBottomRight: [40, 40],
      }));
    });
    showMetricsOverlay(state.metricsByDivision.get(key) || [], DIVISIONS[key].pin, escapeHtml(DIVISIONS[key].label));
  }
  goToDivisionFn = goToDivision;

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-menu-item');
    if (!btn) return;
    closeMenu();
    if (btn.dataset.nav === 'world') goToWorld();
    else goToDivision(btn.dataset.nav);
  });

  toggle.addEventListener('click', () => {
    if (menu.hidden) openMenu(); else closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (toggle.contains(e.target) || menu.contains(e.target)) return;
    closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      closeMenu();
      toggle.focus();
    }
  });
}

// One entry per ministry area, keyed by array index — directoryAreas[i]
// backs the i-th .directory-area-link's data-key, since the marker/row
// objects themselves can't round-trip through a data-* attribute. Rebuilt
// fresh each time buildDirectory runs.
let directoryAreas = [];

function buildDirectory() {
  directoryAreas = [];
  const container = document.getElementById('directory-list');
  container.innerHTML = '';

  for (const [divisionKey, div] of Object.entries(DIVISIONS)) {
    // Every country in this division that actually has a ministry pin,
    // each carrying its own {marker, row} entries — same source
    // flyToArea below flies to, per its own comment on why (the one true
    // marker, not a world-copy ghost twin).
    const countriesInThisDivision = [];
    for (const [countryName, entries] of state.markersByCountry) {
      if (entries.length && state.countryDivisionByName.get(countryName) === divisionKey) {
        countriesInThisDivision.push(countryName);
      }
    }
    if (!countriesInThisDivision.length) continue;
    countriesInThisDivision.sort((a, b) => a.localeCompare(b));

    const group = document.createElement('div');
    group.className = 'directory-group';
    group.innerHTML = `<h3 style="color:${div.pin}">${escapeHtml(div.label)}</h3>`;

    for (const countryName of countriesInThisDivision) {
      const entries = state.markersByCountry.get(countryName)
        .slice()
        .sort((a, b) => a.row.city.localeCompare(b.row.city));
      const flag = flagEmoji(state.countryIsoByName.get(countryName));

      const block = document.createElement('div');
      block.className = 'directory-country-block';
      block.dataset.country = countryName.toLowerCase();
      block.innerHTML = `<button type="button" class="directory-link directory-country-link" data-country="${escapeHtml(countryName)}">${flag ? `${flag} ` : ''}${escapeHtml(countryName)} <span class="directory-count">${entries.length}</span></button>`;

      const ul = document.createElement('ul');
      ul.className = 'directory-area-list';
      for (const { marker, row } of entries) {
        // Same three fields the admin's own ministries-search matches
        // (city/country/staff — see bigtime/admin.js's
        // matchesMinistriesSearch), plus university, since a visitor is
        // just as likely to search for a school as a staffer.
        const staffNames = parseParenList(row.staff).map((s) => s.name);
        const universityNames = parseParenList(row.universities).map((u) => u.name);
        const haystack = [row.city, row.country, ...staffNames, ...universityNames].join(' ').toLowerCase();

        const key = directoryAreas.length;
        directoryAreas.push({ marker, countryName, divisionKey });

        const li = document.createElement('li');
        li.className = 'directory-area-item';
        li.dataset.search = haystack;
        li.innerHTML = `<button type="button" class="directory-area-link" data-key="${key}">${escapeHtml(row.city)}</button>`;
        ul.appendChild(li);
      }
      block.appendChild(ul);
      group.appendChild(block);
    }
    container.appendChild(group);
  }

  container.addEventListener('click', (e) => {
    const areaBtn = e.target.closest('.directory-area-link');
    const countryBtn = e.target.closest('.directory-country-link');
    if (!areaBtn && !countryBtn) return;
    closeDirectory();
    // On mobile, the on-screen keyboard (from the search input) is often
    // still open here, shrinking the visible viewport. Flying immediately
    // would size the zoom/bounds for that shrunk viewport, leaving the map
    // looking over-zoomed once the keyboard actually dismisses. Waiting
    // for it to close, then re-measuring the map container, keeps the
    // zoom correct for the real, full viewport.
    setTimeout(() => {
      map.invalidateSize();
      if (areaBtn) {
        const { marker, countryName, divisionKey } = directoryAreas[Number(areaBtn.dataset.key)];
        flyToArea(countryName, marker, divisionKey);
      } else {
        flyToCountry(countryBtn.dataset.country);
      }
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

// Flies to `countryName`'s own bounds and shows its metrics overlay — the
// same two things the country-polygon click handler in init() does for a
// "present" country; this is the directory/search version of the same
// idea, kept separate rather than sharing code with the ?tour=NAME tour's
// own tourGoToCountry (far below), whose flyTo duration is deliberately
// tuned to the tour's own pacing, not the snappier feel a real visitor's
// search result deserves. Returns false (no metrics shown, nothing flown
// to) if countryName's polygon can't be found.
function flyToCountryBounds(countryName) {
  let countryLayer;
  state.geoLayer.eachLayer((layer) => {
    if (normalizeCountryName(layer.feature.properties.name) === countryName) countryLayer = layer;
  });
  if (!countryLayer) return false;
  const bounds = computeMainLandBounds(countryLayer.feature);
  // flyTo, not setView — see goToWorld's own comment on why (no
  // zoomAnimationThreshold cutoff, so a distant search result still
  // animates instead of jumping).
  withSuppressedDismiss(() => {
    flyToWithRedrawWatch(() => map.flyTo(bounds.getCenter(), map.getBoundsZoom(bounds) - 0.5));
  });
  showCountryMetricsOverlay(countryName);
  return true;
}

function flyToCountry(countryName) {
  const entries = state.markersByCountry.get(countryName);
  if (!entries || !entries.length) return;
  if (!flyToCountryBounds(countryName)) return;

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

// The directory's per-area pick — flies/shows metrics same as
// flyToCountry, but always ends with `marker`'s own popup open, forcing
// it out of a cluster if needed (zoomToShowMarker, same mechanism the
// ?tour=NAME tour uses to reveal a clustered pin) rather than
// flyToCountry's own single-ministry convenience case above, which only
// opens the popup if it's already visible at the plain country zoom — an
// explicit area pick from search should always land on that exact one.
// A pin still bundled inside an unopened cluster icon isn't actually on
// the map (Leaflet.markercluster hides individual markers and shows the
// cluster badge in their place until the view is zoomed in enough, or the
// cluster is spiderfied at max zoom) — marker.openPopup() silently no-ops
// on one in that state. group.zoomToShowLayer is Leaflet.markercluster's
// own built-in fix for exactly this: pans/zooms (spiderfying at max zoom
// if that's what it takes) until `marker` is genuinely visible, then
// calls back — a no-op, synchronously-resolved callback if it already
// was. Wrapped in withSuppressedDismiss since the zoom side of this (not
// the plain-pan case) fires 'zoomstart' internally same as flyTo does,
// which would otherwise dismiss the very country/area metrics overlay
// this is happening underneath. Also wrapped in suppressMapClamp (see its
// own comment above, next to clampSouth) — a zoom deep enough to reveal a
// clustered pin can transiently cross the map's own south/north viewing
// limits mid-flight even when its settled end state is fine.
function zoomToShowMarker(marker, divisionKey) {
  const group = state.clusterGroups[divisionKey];
  return new Promise((resolve) => {
    suppressMapClamp = true;
    withSuppressedDismiss(() => {
      group.zoomToShowLayer(marker, () => {
        suppressMapClamp = false;
        clampSouth();
        clampNorth();
        resolve();
      });
    });
  });
}

// The directory's per-area pick — flies/shows metrics same as
// flyToCountry, but always ends with `marker`'s own popup open, forcing
// it out of a cluster if needed (zoomToShowMarker above) rather than
// flyToCountry's own single-ministry convenience case, which only opens
// the popup if it's already visible at the plain country zoom — an
// explicit area pick from search should always land on that exact one.
function flyToArea(countryName, marker, divisionKey) {
  if (!flyToCountryBounds(countryName)) return;
  zoomToShowMarker(marker, divisionKey).then(() => marker.openPopup());
}

function openDirectory() {
  closeOpenCountryTooltip();
  map.closePopup();
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
    let anyVisibleInGroup = false;
    group.querySelectorAll('.directory-country-block').forEach((block) => {
      // A query matching the country's own name shows every area under
      // it (same as before this searched anything finer); otherwise each
      // area is judged on its own city/staff/university text, so e.g.
      // searching a staffer's name surfaces just their one area, not
      // their whole country.
      const countryMatches = !q || block.dataset.country.includes(q);
      let anyAreaVisible = false;
      block.querySelectorAll('.directory-area-item').forEach((item) => {
        const areaMatches = countryMatches || item.dataset.search.includes(q);
        item.hidden = !areaMatches;
        if (areaMatches) anyAreaVisible = true;
      });
      block.hidden = !anyAreaVisible;
      if (anyAreaVisible) anyVisibleInGroup = true;
    });
    group.hidden = !anyVisibleInGroup;
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
    // A tap/swipe here (the handle, title, or toggle button) never touches
    // the map itself, so none of the map's own tooltip-dismiss handlers
    // fire — do it here instead, covering both an expand and a collapse.
    closeOpenCountryTooltip();
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
// Navigation is iOS Photos-style dots instead of a "1 / 3" counter, plus
// arrows and arrow keys. Two alternating slides (data-slide="a"/"b")
// crossfade between photos rather than sliding a shared box — see
// .lightbox-viewport's own comment in style.css for why (no box means no
// letterboxing around a photo that doesn't match the others' shape). The
// tradeoff: no drag-swipe gesture between photos, since that needs every
// slide to share one box to slide together.
function wireMinistryPhotoCarousel() {
  const lightbox = document.getElementById('ministry-lightbox');
  const content = lightbox.querySelector('.lightbox-content');
  const viewport = lightbox.querySelector('.lightbox-viewport');
  const slideA = lightbox.querySelector('[data-slide="a"]');
  const slideB = lightbox.querySelector('[data-slide="b"]');
  const dotsEl = lightbox.querySelector('.lightbox-dots');
  const prevBtn = lightbox.querySelector('.lightbox-prev');
  const nextBtn = lightbox.querySelector('.lightbox-next');
  const FADE_MS = 500;
  const HIDE_MS = 120; // matches .lightbox-close/.lightbox-nav/.lightbox-dots's own opacity transition in style.css

  let photos = [];
  let index = 0;
  let activeImg = null; // the popup <img> currently open, for click-to-toggle
  let activeSlide = slideA; // whichever of slideA/slideB is on screen right now
  let transitioning = false;

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

  function otherSlide() { return activeSlide === slideA ? slideB : slideA; }

  // Pure calculation, no DOM writes — the size `img` would render at
  // within the 92vw/85vh bounds, computed from its own real aspect ratio.
  // Split out from applySlideSize below so showIndex can compare an
  // incoming photo's target size against the current one *before*
  // deciding whether the arrows/close need to hide for the transition at
  // all (see that comment for why).
  function computeSlideSize(img) {
    const maxW = window.innerWidth * 0.92;
    const maxH = window.innerHeight * 0.85;
    const ratio = img.naturalWidth / img.naturalHeight;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    return { w, h };
  }

  // Sizes and centers `slide` to `size` (from computeSlideSize) —
  // independently of the OTHER slide, which is left completely untouched:
  // left/top are computed against the window directly (slide is
  // position:fixed), not against .lightbox-viewport or any other shared
  // element, so resizing this one slide can never shift or resize the
  // other one that's still mid-fade (see .lightbox-slide's own comment in
  // style.css for the two different ways that went wrong before landing
  // here). Also sizes .lightbox-viewport to match, purely so the arrows/
  // close (positioned relative to .lightbox-content, which wraps it)
  // anchor to whichever photo is actually active — that box holds no
  // visual content of its own now, just a size for those buttons to key
  // off of. No transition on any of this — it's instant, so there's
  // nothing to read as a box visibly growing.
  function applySlideSize(slide, size) {
    slide.style.width = `${size.w}px`;
    slide.style.height = `${size.h}px`;
    slide.style.left = `${(window.innerWidth - size.w) / 2}px`;
    slide.style.top = `${(window.innerHeight - size.h) / 2}px`;
    viewport.style.width = `${size.w}px`;
    viewport.style.height = `${size.h}px`;
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
        showIndex(i);
      });
      dotsEl.appendChild(dot);
    });
  }

  // Crossfades from whichever slide is currently active to photo `i` —
  // loaded into the other (currently hidden, opacity:0) slide first, so
  // nothing is ever visible mid-decode, then swaps which one carries the
  // .active (opacity:1) class. No shared box/track to move between
  // photos of different shapes — see .lightbox-viewport's own comment for
  // why that's deliberate. Every navigation path (arrows, dots, keyboard)
  // goes through this one function, unlike the old adjacent-vs-far
  // distinction the swipe-track version needed.
  async function showIndex(i) {
    if (transitioning || i === index || !photos.length) return;
    transitioning = true;
    index = i;
    resetPinch(); // a fresh photo starts unzoomed, no matter how the last one was left
    const incoming = otherSlide();
    incoming.src = urlFor(index);
    await whenLoaded(incoming);
    const size = computeSlideSize(incoming);
    // Hidden for the transition's duration (see .lightbox-content's own
    // comment in style.css) — but only when the box is actually about to
    // resize. Two photos can easily share the same shape (most of a
    // given ministry's photos usually do), and hiding/showing the
    // controls for a resize that was never going to happen is just
    // needless flicker.
    const sizeChanged = Math.round(size.w) !== Math.round(parseFloat(viewport.style.width))
      || Math.round(size.h) !== Math.round(parseFloat(viewport.style.height));
    if (sizeChanged) {
      content.classList.add('transitioning');
      // Actually wait for the controls to fade out (matches
      // .lightbox-close/.lightbox-nav/.lightbox-dots's own 120ms opacity
      // transition in style.css) before resizing anything below —
      // without this, the resize ran in the very same tick as adding the
      // class, so the browser painted at least one frame with the
      // controls already moved to their new position but still fully
      // visible, reading as "jump, then fade" instead of "fade, then
      // jump out of sight."
      await new Promise((resolve) => setTimeout(resolve, HIDE_MS));
    }
    applySlideSize(incoming, size);
    incoming.classList.add('active');
    activeSlide.classList.remove('active');
    activeSlide = incoming;
    renderDots();
    setTimeout(() => {
      transitioning = false;
      if (sizeChanged) content.classList.remove('transitioning');
    }, FADE_MS);
  }

  async function open(photoList) {
    photos = photoList;
    index = 0;
    activeSlide = slideA;
    slideB.classList.remove('active');
    slideB.removeAttribute('src');
    resetPinch();
    slideA.src = urlFor(0);
    await whenLoaded(slideA);
    applySlideSize(slideA, computeSlideSize(slideA));
    slideA.classList.add('active');
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

  function showNext() { showIndex((index + 1) % photos.length); }
  function showPrev() { showIndex((index - 1 + photos.length) % photos.length); }

  // Exposed so runQueryStringTour's own scripted tour can drive this
  // carousel the same way a real viewer's clicks/arrow keys do, without
  // reaching into (or duplicating) this closure's own open/showNext/close.
  // Same window.__ convention this file already uses for other internal
  // hooks (__divisionBounds, __isolateDivision, __mapReady, ...).
  window.__ministryLightbox = { open, showNext, close, isVisible: () => lightbox.classList.contains('visible') };

  prevBtn.addEventListener('click', (e) => { e.stopPropagation(); showPrev(); });
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); showNext(); });
  lightbox.querySelector('.lightbox-close').addEventListener('click', close);
  lightbox.querySelector('.lightbox-backdrop').addEventListener('click', close);

  // Only while this lightbox is actually open — otherwise every arrow key
  // press on the page (scrolling, editing a field elsewhere) would get
  // eaten by a listener with nothing open to act on.
  //
  // Capture phase, not the usual bubbling one, and both prevented *and*
  // stopped — Leaflet's own keyboard handler (map.options.keyboard,
  // on by default) is bound directly to the map container and also
  // reacts to arrow keys by panning the map, which fires 'movestart' —
  // and this very carousel closes itself on 'movestart' a few lines up,
  // to dismiss when the user interacts with the map underneath. Left as
  // a normal bubbling listener, that pan (and the close it triggers) was
  // happening before this handler ever ran, so every arrow press just
  // closed the lightbox instead of navigating it. Capturing on document
  // intercepts the key before it ever reaches the map container.
  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('visible')) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'ArrowLeft') showPrev();
    else showNext();
  }, true);

  // Two-finger pinch on the current photo — scales it up live and pans as
  // the fingers' midpoint moves, then always springs back to 1x/centered
  // on release rather than staying zoomed; there's no persistent pan-
  // while-zoomed mode to keep in bounds (or clamp panning within), so
  // this is just a transform tied directly to the two touches plus a CSS
  // transition back. (Single-finger swipe-to-navigate was removed along
  // with the shared sliding box it depended on — see .lightbox-viewport's
  // own comment — so this is the only touch gesture left here; arrows/
  // dots/keyboard cover navigation instead.)
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
    activeSlide.style.transition = '';
    activeSlide.style.transform = '';
  }

  content.addEventListener('touchstart', (e) => {
    if (transitioning || e.touches.length !== 2) return;
    pinching = true;
    pinchStartDist = touchDistance(e.touches);
    const mid = touchMidpoint(e.touches);
    pinchStartMidX = mid.x;
    pinchStartMidY = mid.y;
    const rect = activeSlide.getBoundingClientRect();
    activeSlide.style.transformOrigin = `${mid.x - rect.left}px ${mid.y - rect.top}px`;
    activeSlide.style.transition = 'none';
  }, { passive: true });

  content.addEventListener('touchmove', (e) => {
    if (!pinching || e.touches.length < 2) return;
    e.preventDefault(); // also keeps the browser's own page-pinch-zoom from firing alongside this
    const scale = Math.min(PINCH_MAX_SCALE, Math.max(1, touchDistance(e.touches) / pinchStartDist));
    const mid = touchMidpoint(e.touches);
    const dx = mid.x - pinchStartMidX;
    const dy = mid.y - pinchStartMidY;
    activeSlide.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  }, { passive: false });

  content.addEventListener('touchend', (e) => {
    if (!pinching || e.touches.length > 0) return; // wait for every finger to lift
    activeSlide.style.transition = `transform ${FADE_MS}ms ease`;
    // Forces the browser to commit the transition before the transform
    // below changes — without it, some engines coalesce the two style
    // writes and jump straight to the end instead of animating the
    // spring-back.
    void activeSlide.offsetWidth;
    activeSlide.style.transform = 'scale(1)';
    pinching = false;
  });

  // iOS fires touchcancel instead of touchend whenever the system steals a
  // gesture mid-stream — the edge-swipe-back gesture, a Control Center
  // pull, an incoming call, etc. Without this, pinching above would stay
  // stuck true forever (nothing else ever resets it), which silently
  // breaks all further touch input on this lightbox until the page is
  // reloaded — no fancy springback needed here, just snap back
  // immediately since the gesture genuinely didn't finish.
  content.addEventListener('touchcancel', () => {
    if (!pinching) return;
    activeSlide.style.transition = '';
    activeSlide.style.transform = '';
    pinching = false;
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

// Easter egg: triple-clicking/tapping the page title swaps it for a joke
// variant, and swaps back on the next triple-click. Triple-click (not
// single/double) so it's not something a visitor stumbles into by accident.
function wireTitleEasterEgg() {
  const titleEl = document.getElementById('site-title');
  if (!titleEl) return;
  // Saved as markup, not just text — the title's real content is two
  // nowrap <span>s (see index.html/the .title-part rule in style.css) so
  // it only breaks at the "University / International" joint when it
  // doesn't fit on one line; restoring via innerHTML (not textContent)
  // preserves that back after the first toggle.
  const originalHtml = titleEl.innerHTML;
  // Two .title-part spans, exactly like the real title's own two halves —
  // not a bare <br>, which (combined with .site-header h1's flex-column
  // layout at this breakpoint) made every text run and the <br> itself
  // its own flex item, breaking far more than once. Each span is nowrap,
  // so this is a single clean break between "on" and "the", and never
  // lands mid-word inside "Brett-ish".
  const jokeHtml = '<span class="title-part">The sun never sets on</span> <span class="title-part">the Brett-ish Empire</span>';
  let showingJoke = false;
  // Counts clicks/taps within a short window rather than trusting the
  // native event's own click-count (e.detail) — iOS Safari's synthetic
  // click events from tapping never increment e.detail past 1, so a
  // triple-tap never fired this on mobile even though triple-click always
  // worked fine on desktop.
  let tapCount = 0;
  let tapTimer = null;
  titleEl.addEventListener('click', () => {
    tapCount += 1;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { tapCount = 0; }, 500);
    if (tapCount < 3) return;
    tapCount = 0;
    showingJoke = !showingJoke;
    titleEl.innerHTML = showingJoke ? jokeHtml : originalHtml;
    // Both directions reset to the same "World" view + world metrics.
    if (goToWorldFn) goToWorldFn();
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
  let pushed = false;
  // True only for the span of resetMapView's own goToWorldFn() call below —
  // NOT the same thing as state.suppressOverlayDismiss, which is also true
  // during a plain nav-menu click and would (confirmed live) wrongly
  // suppress arming the trap for that legitimate, separate view change too.
  let suppressArm = false;

  function armTrap() {
    if (pushed || suppressArm) return;
    pushed = true;
    history.pushState({ ylMapView: true }, '', location.href);
  }

  function resetMapView() {
    suppressArm = true;
    map.closePopup();
    if (goToWorldFn) goToWorldFn();
    // goToWorldFn's own move is animated and multi-leg (see
    // withSuppressedDismiss), so a fixed timeout can't safely bound it —
    // piggyback on the same settling signal it already clears
    // (state.suppressOverlayDismiss) instead of duplicating that logic.
    (function waitForSettle() {
      if (!state.suppressOverlayDismiss) { suppressArm = false; return; }
      requestAnimationFrame(waitForSettle);
    })();
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
    const [countryGeo, divisionRows, { rows: ministryRows }] = await Promise.all([
      fetchJson(CONFIG.COUNTRIES_GEOJSON_URL),
      fetchCsv(CONFIG.COUNTRY_DIVISIONS_CSV_URL),
      fetchJson(CONFIG.MINISTRIES_API_URL),
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
        // otherwise zoom to an empty country with nothing to see, so an
        // empty country instead just gets its name tooltip (see the
        // present/else branch below) — the only way to identify it at all,
        // since a country *with* pins gets its name from the metrics
        // overlay's own label instead, not this tooltip.
        layer.on('click', (e) => {
          // A click on a country turns out to ALSO fire the map's own
          // 'click' (see the map.on('click', ...) below) in the same
          // event — without this flag, that would immediately close the
          // tooltip this same click just opened.
          suppressNextMapClickClose = true;
          if (state.openCountryTooltipLayer && state.openCountryTooltipLayer !== layer) {
            state.openCountryTooltipLayer.closeTooltip();
          }

          const name = normalizeCountryName(feature.properties.name);
          const present = state.countriesWithVisiblePins.get(name);

          // The metrics overlay's own label above the boxes already names
          // this country (with its flag — see showMetricsOverlay below)
          // once a country with ministry data is clicked, so the
          // plain-text map tooltip would just be a redundant second label
          // for the same click — skipped entirely here. An *empty*
          // country (the else branch below) still gets it: with nothing
          // to zoom to or show metrics for, the tooltip is the only way
          // to identify it at all.
          if (!(present && present.size)) {
            // If this were ever undefined, Leaflet's Tooltip._prepareOpen
            // silently falls back to the country's own center instead of
            // the click position — computing it ourselves guarantees that
            // never happens, regardless of why e.latlng could come back
            // empty.
            const clickLatLng = e.latlng || map.mouseEventToLatLng(e.originalEvent);
            layer.openTooltip(clickLatLng);
            state.openCountryTooltipLayer = layer;
          } else {
            state.openCountryTooltipLayer = null;
            // A touch out from a tight fit, so the country reads with a
            // little breathing room and its neighbors are visible for
            // context, without backing off as far as a full zoom level.
            const bounds = computeMainLandBounds(feature);
            const targetZoom = map.getBoundsZoom(bounds) - 0.5;
            // Zooms in OR out to this fit, every time — e.g. clicking a
            // small country while zoomed in on a big one now zooms back
            // out to bring the small one into view, rather than staying
            // zoomed in past it. flyTo, not setView — a neighbor-to-
            // neighbor click (e.g. Ukraine, then Poland) is exactly the
            // kind of move whose zoom-level change routinely exceeds
            // Leaflet's zoomAnimationThreshold, where a plain animated
            // setView silently skips its own animation and just jumps;
            // flyTo has no such cutoff (see goToWorld's own comment on
            // this) and reads as a real, continuous move between the two.
            // Suppressed the same way the nav menu's own World/division
            // moves are (withSuppressedDismiss) — without it, this same
            // flyTo's own 'movestart', and the map 'click' this layer
            // click is about to bubble into, would each immediately hide
            // the metrics overlay this click is showing.
            withSuppressedDismiss(() => {
              flyToWithRedrawWatch(() => map.flyTo(bounds.getCenter(), targetZoom));
            });
            showCountryMetricsOverlay(name);
          }
        });
      },
    };

    // Clicking a different country already closes the previous tooltip
    // (see the click handler above). This covers the other two ways it
    // should go away on the map itself: clicking blank map area (a click
    // that lands on no interactive layer at all only ever reaches the map
    // itself, never a country click, so this can't double-close the one
    // just opened), and starting a drag — 'dragstart' specifically, not
    // 'movestart', so the pan/zoom our own click handler triggers for a
    // ministry country doesn't immediately close the tooltip that same
    // click just opened. closeOpenCountryTooltip itself is top-level (see
    // above showStatus) — the legend/directory/nav-menu also call it when
    // they open, since none of those clicks land on the map itself.
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

    // Coastal glow — a soft lighter-blue "shallow water" halo just outside
    // every coastline, faked from these same country polygons rather than
    // real bathymetry data (Leaflet has no ocean-depth layer of its own,
    // and a realistic bathymetric tile basemap would clash hard with this
    // site's illustrated antique-atlas style anyway). A dedicated pane
    // lets one CSS blur cover the whole thing cheaply, instead of a
    // separate blur filter per polygon; z-index sits just under
    // overlayPane (400, where the real crisp country layer below renders)
    // so the blur's inward half is hidden under real land and only the
    // outward half shows over open ocean. interactive:false so clicks/
    // hover pass straight through to the real layer beneath.
    map.createPane('coastalGlowPane');
    map.getPane('coastalGlowPane').style.zIndex = 380;
    map.getPane('coastalGlowPane').style.filter = 'blur(7px)';
    map.getPane('coastalGlowPane').style.pointerEvents = 'none';
    // Kept as a handle (state.coastalGlowRenderer) so the tour's mid-flight
    // redraw watcher (see watchFlightForRedraw) can reach it directly,
    // same as map.options.renderer for the main country layer — Leaflet otherwise
    // auto-creates one renderer per distinct pane with no way to get a
    // reference back to it.
    state.coastalGlowRenderer = L.svg({ pane: 'coastalGlowPane', padding: 1.5 });
    const coastalGlowOptions = {
      pane: 'coastalGlowPane',
      renderer: state.coastalGlowRenderer,
      interactive: false,
      style: () => ({ fillColor: '#bedced', fillOpacity: 1, color: '#bedced', weight: 8, opacity: 1 }),
    };
    L.geoJSON(countryGeo, coastalGlowOptions).addTo(map);
    for (const offsetDeg of [-360, 360]) {
      L.geoJSON(shiftGeoJSONLng(countryGeo, offsetDeg), coastalGlowOptions).addTo(map);
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
        // Leaflet.markercluster's default (true) only renders markers
        // within the current viewport at add time, then waits for the
        // next 'moveend' to add newly-visible ones. The tour re-adds
        // these groups WHILE still zoomed into a single country, right
        // before flying back out — with the default on, only pins near
        // that country show immediately and the rest of the division only
        // pops in once the zoom-out's own 'moveend' fires (i.e. right at
        // the end of the tour). Our marker counts are small enough that
        // this perf optimization isn't worth that correctness bug.
        removeOutsideVisibleBounds: false,
      });
    }

    for (const row of ministryRows) {
      for (const s of parseParenList(row.staff)) {
        state.staffHomeByName.set(s.name, { meta: s.meta });
      }
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
      // Read back by the map-level 'popupopen' listener below (via
      // e.popup._source) to re-sync the metrics overlay to this
      // ministry's own country whenever its popup opens.
      marker.ministryCountry = countryName;
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
        ghostMarker.ministryCountry = countryName;
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
    // slider, first landing on 3, then 2, then down to just 1 — still felt
    // like too much of a jump per tap even at 2, at least once already
    // fairly zoomed in). spiderfyOnMaxZoom above still fans out any pins
    // that stay clustered after hitting the cap, so nothing's ever
    // unreachable — it may just take a couple more taps.
    //
    // Dynamic rather than one flat step: zoomed pretty far out (world/
    // division-ish), a cluster's members are still spread across a wide
    // area, so a single extra level barely moves toward separating them —
    // 2 covers more of that ground in one tap. Already fairly zoomed in
    // (country-ish or tighter), the same 2 levels reads as too big a jump
    // given how much closer everything already is, so it drops to 1.
    const CLUSTER_CLICK_ZOOM_STEP_THRESHOLD = 6; // below this current zoom = "pretty far out"
    const CLUSTER_CLICK_MAX_ZOOM_STEP_FAR = 2;
    const CLUSTER_CLICK_MAX_ZOOM_STEP_NEAR = 1;
    // Was implicitly 0.25s (Leaflet's own default zoom-animation speed,
    // via plain setView) — slowed down and made explicit.
    const CLUSTER_CLICK_ZOOM_DURATION = 0.6;
    for (const group of Object.values(state.clusterGroups)) {
      group.on('clusterclick', (e) => {
        const cluster = e.layer;
        const idealZoom = map.getBoundsZoom(cluster.getBounds());
        const step = map.getZoom() < CLUSTER_CLICK_ZOOM_STEP_THRESHOLD
          ? CLUSTER_CLICK_MAX_ZOOM_STEP_FAR
          : CLUSTER_CLICK_MAX_ZOOM_STEP_NEAR;
        const cap = map.getZoom() + step;
        // Suppressed like a nav-menu move — zooming into a cluster is
        // still browsing the same selection, not leaving it, so it
        // shouldn't dismiss the metrics overlay (see
        // wireMetricsOverlayDismiss's own comment on this).
        //
        // flyTo with an explicit duration, not setView — setView's own
        // zoom animation has no tunable speed of its own, it just plays
        // Leaflet's fixed 0.25s CSS transition (leaflet.css's
        // .leaflet-zoom-anim .leaflet-zoom-animated rule) every time,
        // however big or small the step. CLUSTER_CLICK_ZOOM_DURATION
        // makes it an actual, adjustable value instead.
        //
        // Only when there's still somewhere left to zoom: Leaflet.
        // markercluster's own internal 'clusterclick' listener (wired
        // because spiderfyOnMaxZoom is on, regardless of our
        // zoomToBoundsOnClick:false) fires on this exact same event, and
        // spiderfies a cluster whose members can only ever be separated
        // at the map's own max zoom — already-at-max-zoom case. Matches
        // the reported symptom (a spiderfy briefly appears, then
        // collapses back to the cluster icon) exactly: our own flyTo
        // firing right after, even to an effectively unchanged position,
        // still dispatches real movement events on top of it. Skipping
        // our flight in this case leaves it entirely to Leaflet's own
        // listener instead of fighting it a moment later.
        if (map.getZoom() < map.getMaxZoom()) {
          withSuppressedDismiss(() => {
            flyToWithRedrawWatch(() => map.flyTo(
              cluster.getLatLng(),
              Math.min(idealZoom, cap, map.getMaxZoom()),
              { duration: CLUSTER_CLICK_ZOOM_DURATION },
            ));
          });
        }
        // Same re-sync a pin's own popup does (see the map-level
        // 'popupopen' listener below init()) — a cluster click has no
        // popup to hang that off of, so it needs its own trigger here.
        // A cluster can in principle span two countries (maxClusterRadius
        // groups by screen proximity, not by border) — its first child is
        // a reasonable fallback rather than a real ambiguity to resolve,
        // same reasoning as the country-polygon click handler's own
        // identical fallback for a country spanning divisions.
        const children = cluster.getAllChildMarkers();
        if (children.length && children[0].ministryCountry) {
          showCountryMetricsOverlay(children[0].ministryCountry);
        }
      });
    }

    recomputeCountriesWithVisiblePins(ministryRows);
    refreshCountryStyles();
    buildLegend();
    wireLegendToggle();
    buildDirectory();
    wireDirectoryControls();

    state.worldMetrics = computeMetrics(ministryRows);
    for (const key of Object.keys(DIVISIONS)) {
      const divisionRows = ministryRows.filter(
        (row) => state.countryDivisionByName.get(normalizeCountryName(row.country)) === key
      );
      state.metricsByDivision.set(key, computeMetrics(divisionRows));
    }
    // Same idea, one level narrower — computed for every country that has
    // at least one ministry row, not just ones with a visible pin (a
    // country's own click handler below only ever looks this up for a
    // country that's already confirmed to have visible pins, but computing
    // the full set here up front is simpler than special-casing that).
    const rowsByCountry = new Map();
    for (const row of ministryRows) {
      const name = normalizeCountryName(row.country);
      if (!rowsByCountry.has(name)) rowsByCountry.set(name, []);
      rowsByCountry.get(name).push(row);
    }
    for (const [name, rows] of rowsByCountry) {
      state.metricsByCountry.set(name, computeMetrics(rows, { includeCountries: false }));
    }
    showMetricsOverlay(state.worldMetrics, null);
    wireMetricsOverlayDismiss();
    wireNavMenu();

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

    // Capture-only, experimental: swaps every division's clustered marker
    // group for a plain (unclustered) L.layerGroup holding the exact same
    // marker instances, so every individual pin renders instead of a
    // cluster badge with a count. Only ever called from
    // worker/lib/mapCapture.js's Puppeteer session — never wired into the
    // normal page load, so regular site visitors always see the real
    // clustered map. Replaces state.clusterGroups[key] in place, so
    // __isolateDivision's existing add/removeLayer logic (which just
    // iterates that same object) keeps working unchanged on the plain
    // groups.
    window.__disableClusteringForCapture = function () {
      for (const key of Object.keys(state.clusterGroups)) {
        const clusterGroup = state.clusterGroups[key];
        const onMap = map.hasLayer(clusterGroup);
        const markers = clusterGroup.getLayers();
        if (onMap) map.removeLayer(clusterGroup);
        const plainGroup = L.layerGroup(markers);
        state.clusterGroups[key] = plainGroup;
        if (onMap) plainGroup.addTo(map);
      }
    };

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

      // "containsOwnMarker" (a marker literally inside THIS piece) is
      // deliberately precise per-piece, not per-country — see the comment
      // above — but that precision has a real cost for a country whose
      // core territory is itself split into a couple of comparably-sized
      // major pieces with only one of them holding a marker: New Zealand's
      // South Island, with every ministry on the North Island, was getting
      // left out of Asia Pacific's frame entirely (confirmed live — it
      // rendered partially cut off at the frame's edge). This first pass
      // finds, per country, the largest piece that already qualifies on
      // its own — used just below so a same-country sibling piece at least
      // a quarter that size also earns a spot, the same way
      // computeMainLandBounds folds in Mindanao next to Luzon. A country's
      // actually-remote possession (Svalbard next to mainland Norway, a
      // Russian Arctic island) stays excluded — nowhere near a quarter the
      // size of the piece that does hold the marker.
      const verifiedPieceAreaByCountry = new Map();
      for (const p of pieces) {
        const centerLng = (p.west + p.east) / 2;
        const shift = Math.round((anchorCenterLng - centerLng) / 360) * 360;
        const shiftedWest = p.west + shift, shiftedEast = p.east + shift;
        const containsOwnMarker = markerPoints.some(
          (m) => m.countryName === p.countryName && m.lng >= shiftedWest && m.lng <= shiftedEast && m.lat >= p.south && m.lat <= p.north
        );
        if (p !== anchor && !containsOwnMarker) continue;
        const prevArea = verifiedPieceAreaByCountry.get(p.countryName) || 0;
        if (p.area > prevArea) verifiedPieceAreaByCountry.set(p.countryName, p.area);
      }
      const SIBLING_SIZE_FRACTION = 0.25;

      let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
      // Proximity alone (nearMarker) pulls in whichever direction the
      // nearest neighboring countries happen to sit, which isn't always
      // where the map should actually extend — Middle East & Central
      // Asia's markers (Russia, Kazakhstan, Uzbekistan, Kyrgyzstan) are
      // roughly as close to Turkey (worth keeping) as to Iran/Iraq/
      // Afghanistan (not, once they pull the frame's south edge that far
      // down). coreMinLat tracks how far south the anchor/own-marker/
      // verified-sibling pieces alone would reach, and clamps the final
      // south edge to that — proximity can still extend north/east/west,
      // just not drag the bottom of the frame down toward a cluster of
      // markerless countries.
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
        const verifiedSiblingArea = verifiedPieceAreaByCountry.get(p.countryName);
        const siblingOfVerified = !containsOwnMarker && verifiedSiblingArea != null && p.area >= verifiedSiblingArea * SIBLING_SIZE_FRACTION;
        if (p !== anchor && !containsOwnMarker && !nearMarker && !siblingOfVerified) continue;
        if (shiftedWest < minLng) minLng = shiftedWest;
        if (shiftedEast > maxLng) maxLng = shiftedEast;
        if (p.south < minLat) minLat = p.south;
        if (p.north > maxLat) maxLat = p.north;
        if (p === anchor || containsOwnMarker || siblingOfVerified) {
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

// Chained with .then, not the bare fire-and-forget call this used to be —
// runQueryStringTour (bottom of file) needs everything init() sets up
// (state.markersByCountry, goToWorldFn/goToDivisionFn, the photo lightbox's
// window.__ministryLightbox) to actually exist before it can start, which
// only happens once the whole async function body — not just the
// synchronous call to it — has finished.
init().then(() => {
  if (window.__mapReady) runQueryStringTour();
});

// Keeps the metrics overlay honest about whatever ministry is actually in
// focus: a pin/cluster click no longer dismisses the overlay (see
// wireMetricsOverlayDismiss), but left alone that just leaves whatever was
// already showing up — e.g. a Costa Rica pin clicked while Nicaragua's
// metrics/label were still up from an earlier country click left Nicaragua
// showing, next to a Costa Rica popup. Every real marker/ghost marker
// carries its own country (marker.ministryCountry, set in init()) so any
// popup opening — a direct pin click, or a programmatic one like
// flyToCountry's own single-ministry bonus popup — re-syncs the overlay to
// that country via the same showCountryMetricsOverlay the country-polygon
// click handler itself uses, without moving the map.
// Ministry popups fade in and out. Leaflet's own built-in way to do this
// (the map's fadeAnimation option) is deliberately off — see that option's
// own comment in the map init above: it broke the header-clearance pan
// measurement further down on iOS. This reimplements just the pure-opacity
// fade Leaflet's own Popup.onAdd/onRemove would otherwise do, entirely
// independent of that option and the map's zoom-animation machinery, so it
// can only ever touch opacity — never layout/position — which
// getBoundingClientRect() (used by that same pan measurement) is
// unaffected by either way.
const POPUP_FADE_MS = 220;
const originalPopupOnRemove = L.Popup.prototype.onRemove;
L.Popup.prototype.onRemove = function popupOnRemoveWithFade(map) {
  const container = this._container;
  if (!container) {
    originalPopupOnRemove.call(this, map);
    return;
  }
  container.style.transition = `opacity ${POPUP_FADE_MS}ms ease`;
  container.style.opacity = '0';
  // Same instance property Leaflet's own (unpatched) onAdd already clears
  // via clearTimeout(this._removeTimeout) on reopen — reusing that name
  // means a marker clicked again mid-fade-out correctly cancels this
  // delayed removal instead of yanking the just-reopened popup back out
  // of the DOM once this timeout eventually fires.
  this._removeTimeout = setTimeout(() => originalPopupOnRemove.call(this, map), POPUP_FADE_MS);
};

map.on('popupopen', (e) => {
  const container = e.popup._container;
  if (container) {
    container.style.transition = 'none';
    container.style.opacity = '0';
    void container.offsetHeight; // force a reflow so opacity:0 actually applies before the transition below starts
    container.style.transition = `opacity ${POPUP_FADE_MS}ms ease`;
    container.style.opacity = '1';
  }

  const country = e.popup._source && e.popup._source.ministryCountry;
  if (country) showCountryMetricsOverlay(country);
});

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
//
// invalidateSize() on its own asks Leaflet to also *pan* by half the old/
// new size delta to try to keep the same center visible — a reasonable
// guess for a small change (an address bar collapsing a few dozen
// pixels), but confirmed broken for a large, asymmetric one: rotating an
// iPhone (portrait ~370x900 to landscape ~830x430) left the map centered
// on 68°N, -37° (open ocean near Greenland) instead of the real [35, 0]
// — not a small drift, a completely different part of the world. Capturing
// the actual current center/zoom first, disabling invalidateSize's own
// pan guess (pan: false), and explicitly re-applying exactly what was
// already showing is a correct fix instead of a heuristic: the map ends
// up back where it genuinely was, not wherever Leaflet's delta math
// guessed, whether that's the default view on first load or wherever the
// user had already navigated to.
function refreshMapSize() {
  const center = map.getCenter();
  const zoom = map.getZoom();
  map.invalidateSize({ pan: false });
  map.setView(center, zoom, { animate: false });
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


// ---------------------------------------------------------------------
// ?tour=NAME — step 1 of the real tour feature (replaces the earlier
// ?animate=NAME prototype entirely; nothing here is a continuation of
// that code). For now this is still query-string-only and hardcoded to
// one division (LAC) — the eventual version starts from wherever the
// visitor already is (world/division/country) and is driven by the same
// tour-controls bar that's always present once a metrics view is
// showing, per the actual plan. Also doesn't touch any ministry pins
// yet — each leg just flies to a division/country and shows its
// metrics, nothing more.
// ---------------------------------------------------------------------

// Orders arbitrary lat/lng points (countries, pins, whatever) as a real
// greedy nearest-neighbor proximity chain — start at the northwesternmost
// point, then repeatedly hop to whichever remaining point is physically
// closest to the current one. An earlier version (country-ordering only,
// before this was pulled out into a shared helper) used a single blended
// NW/SE diagonal score (north-south and west-east weighted equally into
// one number), but that's a synthetic "read the page" axis, not actual
// proximity — for a division shaped like LAC (a north-south chain of
// mainland with islands off to one side), it mixed up Caribbean/mainland
// order in a way that didn't match the geography (confirmed live). This
// deliberately isn't a true shortest-path/TSP solve (per the original
// direction — "it can be fuzzy") — just chaining to the nearest unvisited
// neighbor each step. Returns the input objects themselves, reordered —
// each just needs a `lat`/`lng`.
function orderByProximity(points) {
  if (!points.length) return [];
  const sqDist = (a, b) => {
    const dLat = a.lat - b.lat;
    const dLng = a.lng - b.lng;
    return dLat * dLat + dLng * dLng;
  };
  let startIdx = 0;
  let bestStartScore = Infinity;
  points.forEach((p, i) => {
    const score = -p.lat + p.lng; // north first, west first
    if (score < bestStartScore) {
      bestStartScore = score;
      startIdx = i;
    }
  });
  const remaining = points.slice();
  const [start] = remaining.splice(startIdx, 1);
  const ordered = [start];
  let current = start;
  while (remaining.length) {
    let nearestIdx = 0;
    let nearestDist = Infinity;
    remaining.forEach((p, i) => {
      const d = sqDist(current, p);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    });
    [current] = remaining.splice(nearestIdx, 1);
    ordered.push(current);
  }
  return ordered;
}

// Every country in `divisionKey` that actually has a ministry pin, ordered
// by orderByProximity above.
function countriesInDivisionByProximity(divisionKey) {
  const names = [];
  for (const [countryName, entries] of state.markersByCountry) {
    if (entries.length && state.countryDivisionByName.get(countryName) === divisionKey) {
      names.push(countryName);
    }
  }
  const points = names.map((name) => {
    let countryLayer;
    state.geoLayer.eachLayer((layer) => {
      if (normalizeCountryName(layer.feature.properties.name) === name) countryLayer = layer;
    });
    const center = computeMainLandBounds(countryLayer.feature).getCenter();
    return { name, lat: center.lat, lng: center.lng };
  });
  return orderByProximity(points).map((p) => p.name);
}

// Every division that actually has at least one ministry pin, ordered by
// orderByProximity above (same NW-start nearest-neighbor chain used for
// countries within a division) — used for a "World Tour" that sweeps
// through every division in turn instead of just one.
function divisionsByProximity() {
  const keys = Object.keys(DIVISIONS).filter((key) => {
    for (const countryName of state.markersByCountry.keys()) {
      if (state.markersByCountry.get(countryName).length && state.countryDivisionByName.get(countryName) === key) return true;
    }
    return false;
  });
  const points = keys.map((key) => {
    const rawBounds = window.__divisionBounds(key);
    const center = rawBounds ? L.latLngBounds(rawBounds).getCenter() : L.latLng(0, 0);
    return { key, lat: center.lat, lng: center.lng };
  });
  return orderByProximity(points).map((p) => p.key);
}

// Each leg's duration scales with how far it actually moves ON SCREEN,
// not real-world km — the same km distance can be a tiny nudge or a huge
// sweep depending on zoom level (confirmed live: had to watch it to see
// why distance-based timing felt wrong — e.g. the world-to-LAC leg covers
// enormous km but only modest screen space, while hopping between two
// adjacent small countries at high zoom can sweep across most of the
// viewport). This reimplements the exact pixel+zoom "flight duration" unit
// Leaflet's own flyTo computes internally (see vendor/leaflet/leaflet.js's
// flyTo — this is its van Wijk zoom/pan formula) so our clamped, scaled
// duration is grounded in the same math Leaflet uses when it picks a
// natural duration on its own (there, the unscaled unit times 0.8 becomes
// the ms duration). Clamped on both ends: a very short hop still reads as
// a deliberate move rather than a jump-cut, and a very long one doesn't
// drag on forever.
const TOUR_SPEED_SCALE = 4; // ~5x slower than Leaflet's own natural pixel-based pace (0.8 * 5 ≈ 4)
const TOUR_MIN_LEG_SECONDS = 2.5;
const TOUR_MAX_LEG_SECONDS = 8;

function tourFlightPixelUnits(targetLatLng, targetZoom) {
  const size = map.getSize();
  const w0 = Math.max(size.x, size.y);
  const currentZoom = map.getZoom();
  const zoom = targetZoom === undefined ? currentZoom : targetZoom;
  const w1 = w0 * map.getZoomScale(currentZoom, zoom);
  const from = map.project(map.getCenter());
  const to = map.project(targetLatLng);
  const u1 = from.distanceTo(to) || 1;
  const rho = 1.42;
  const rho2 = rho * rho;
  function r(i) {
    const s1 = i ? -1 : 1;
    const s2 = i ? w1 : w0;
    const t1 = w1 * w1 - w0 * w0 + s1 * rho2 * rho2 * u1 * u1;
    const b = t1 / (2 * s2 * rho2 * u1);
    const sq = Math.sqrt(b * b + 1) - b;
    return sq < 1e-9 ? -18 : Math.log(sq);
  }
  return (r(1) - r(0)) / rho;
}

function tourLegDuration(targetLatLng, targetZoom) {
  const units = tourFlightPixelUnits(targetLatLng, targetZoom);
  return Math.min(TOUR_MAX_LEG_SECONDS, Math.max(TOUR_MIN_LEG_SECONDS, units * TOUR_SPEED_SCALE));
}

// Pin-to-pin hops are much shorter than any other leg (within one already-
// zoomed-in country), so reusing tourLegDuration's own MIN/MAX clamp meant
// almost every pin hop bottomed out at the general 2s floor — slower than
// it needed to feel for what's meant to be a brisk sweep through a
// country's pins, not a deliberate cross-country flight. Its own, faster
// scale and tighter clamp instead.
const TOUR_PIN_SPEED_SCALE = 1.5;
const TOUR_PIN_MIN_LEG_SECONDS = 1;
const TOUR_PIN_MAX_LEG_SECONDS = 2.5;

function tourPinLegDuration(targetLatLng, targetZoom) {
  const units = tourFlightPixelUnits(targetLatLng, targetZoom);
  return Math.min(TOUR_PIN_MAX_LEG_SECONDS, Math.max(TOUR_PIN_MIN_LEG_SECONDS, units * TOUR_PIN_SPEED_SCALE));
}

// Country-to-country and division-level hops, sped up from the original
// World/Division pace (confirmed live, twice — first pass at 2.5/1.5s/6s
// still felt slow once pins made the rest of the tour brisker by
// comparison, especially division legs which hadn't been touched at all
// yet) — own faster scale and tighter clamp, same pattern as the
// pin-specific one above. World legs (tourGoToWorld) still use the
// original tourLegDuration/TOUR_SPEED_SCALE — only country/division use
// this one.
const TOUR_COUNTRY_SPEED_SCALE = 1.8;
const TOUR_COUNTRY_MIN_LEG_SECONDS = 1.4;
const TOUR_COUNTRY_MAX_LEG_SECONDS = 4.5;

function tourCountryLegDuration(targetLatLng, targetZoom) {
  const units = tourFlightPixelUnits(targetLatLng, targetZoom);
  return Math.min(TOUR_COUNTRY_MAX_LEG_SECONDS, Math.max(TOUR_COUNTRY_MIN_LEG_SECONDS, units * TOUR_COUNTRY_SPEED_SCALE));
}

// Flies via `flyFn` (a zero-arg closure that calls the real map.flyTo/
// flyToBounds using `duration` — done this way so each leg below can
// supply its own target/duration) and resolves once the flight has
// genuinely settled ('moveend'). Each caller shows its own metrics
// *before* calling this, as the flight departs rather than once it
// arrives — confirmed live as the better feel: showing them on arrival
// instead read as a step behind, since the camera was already moving
// toward (and had just reached) the destination while the old label was
// still up describing where it left from. Suppressed against both the
// metrics-overlay auto-dismiss (flyTo always fires 'zoomstart'
// internally) and the south/north per-frame clamp (a flight this fast
// can transiently cross those limits mid-flight even though its final
// resting position is fine) — the same two safety patterns proven out on
// the ?animate=NAME prototype this replaces.
// Leaflet's SVG renderer animates a big zoom change by taking the vector
// rendering as it stood at the START of the flight and stretching the
// whole thing via a CSS transform — fine for a normal single-level zoom
// (~2x stretch), but a tour leg can span 4+ zoom levels in one flight,
// needing a stretch upwards of 16x+ (confirmed live: caught it mid-flight
// with the browser's own computed `transform: scale(16.43)`), which is
// exactly what makes borders look blocky/staircased and the coastal glow
// vanish entirely. Periodically calling the renderer's own `_reset()` —
// the exact method Leaflet itself calls on a full view reset: recompute
// the buffer, reset the CSS transform to identity relative to the
// now-current zoom, and reproject every path — keeps that stretch factor
// small the whole flight instead of letting it balloon (measured live:
// with a reset every 400ms, zoom drift between resets stays ~0.2-0.3
// levels, i.e. under 1.3x, instead of 16x+ with no resets at all).
//
// An earlier attempt at this exact idea broke the tour (jerky zoom, wrong
// landing spot) because it only replicated HALF of `_reset()` — it called
// `_update()` and fired the 'update' event (which redraws paths) but never
// reset the container's own CSS transform, so the stale transform from
// before kept compounding on top of freshly-reprojected paths. Calling
// the renderer's real, complete `_reset()` avoids that: it's the same
// method Leaflet's own code already calls, not a hand-assembled partial
// version of it. Confirmed live: correct landing position, no jerkiness.
//
// A flat 400ms timer (the first working version of this) resets on a
// fixed schedule regardless of whether the stretch factor actually needs
// it yet — flyTo's own easing is slow at the start and end of a leg and
// fast in the middle, so a fixed interval resets more than necessary
// during the slow parts (each a ~35-65ms hitch) while being the right
// cadence only for the fast middle. Checking the actual drift every
// animation frame (cheap — just a getZoom() comparison) and only paying
// for the expensive _reset() once drift crosses a threshold cuts the
// total number of resets for the same worst-case stretch factor, since
// it stops resetting during the parts of the flight that don't need it.
// requestAnimationFrame does stop firing in a backgrounded tab/window,
// but unlike the fixed-timer version that's not a real downside here — a
// user who isn't looking at the tab doesn't notice missed resets, and
// rAF resumes and catches up as soon as they refocus.
const ZOOM_DRIFT_THRESHOLD = 1; // zoom levels ≈ 2x stretch before it's worth paying for a reset
// The glow pane is already blurred, so a somewhat larger stretch on it is
// much less noticeable than the same stretch on the crisp border layer —
// giving it a looser threshold measurably cuts total reset cost (it's
// roughly half the ~35-65ms combined cost) for a "touch more" smoothness,
// confirmed as still worth asking for even after the switch off a flat
// timer.
const GLOW_DRIFT_THRESHOLD = 2;

// Zoom drift alone missed a real case: a pin-to-pin hop starts and ends at
// the exact same zoom (both CONFIG.MAX_ZOOM), so the zoom-drift check
// above never fires even once during the whole flight — but at zoom 10, a
// modest real-world distance between two pins can still span many
// viewport-widths in screen pixels, outrunning the renderer's pre-
// rendered buffer just from panning, with no zoom change involved at all
// (confirmed live — "the map does refresh at extreme zooms, notably when
// the pin distance is great and high zoomed"). This is the exact same
// buffer-outrun failure the padding:1.5 renderer option was originally
// there to prevent for manual drags — just large enough here that a fixed
// padding alone isn't enough either. Tracking pan distance from each
// renderer's own last-reset center (projected at the current zoom) and
// resetting once it crosses a fraction of the viewport size catches this
// independently of whatever the zoom-drift check is doing.
const PAN_DRIFT_FRACTION = 0.75; // fraction of the smaller viewport dimension

function renderRendererDriftPx(renderer, zoom) {
  if (!renderer || !renderer._center) return 0;
  const currentPoint = map.project(map.getCenter(), zoom);
  const refPoint = map.project(renderer._center, zoom);
  return currentPoint.distanceTo(refPoint);
}

function watchFlightForRedraw() {
  const renderer = map.options.renderer;
  const glowRenderer = state.coastalGlowRenderer;
  let running = true;
  function tick() {
    if (!running) return;
    const zoom = map.getZoom();
    const panThreshold = Math.min(map.getSize().x, map.getSize().y) * PAN_DRIFT_FRACTION;
    // Each renderer's own drift, checked and reset independently — the
    // glow pane resets on its own, looser cadence (see
    // GLOW_DRIFT_THRESHOLD's comment), not tied to the main layer's.
    if (renderer && renderer._reset) {
      const zoomDrift = Math.abs(zoom - renderer._zoom);
      const panDrift = renderRendererDriftPx(renderer, zoom);
      if (zoomDrift > ZOOM_DRIFT_THRESHOLD || panDrift > panThreshold) renderer._reset();
    }
    if (glowRenderer) {
      const zoomDrift = Math.abs(zoom - glowRenderer._zoom);
      const panDrift = renderRendererDriftPx(glowRenderer, zoom);
      if (zoomDrift > GLOW_DRIFT_THRESHOLD || panDrift > panThreshold) glowRenderer._reset();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return () => { running = false; };
}

// Same buffer-staleness problem watchFlightForRedraw exists to fix, but
// for the site's own regular flyTo/flyToBounds calls (World/Division nav,
// a country polygon or directory/search pick) — none of those are
// tour legs and none of them await anything today, so this doesn't
// return a promise the way tourFlyToAndWait does; it just attaches the
// watcher for the duration of the flight and detaches it once the flight
// settles. Flying from a deep pin-level zoom straight out to World or a
// division (e.g. the tour's own Stop button, or a visitor doing the same
// thing by hand) went through these plain calls, which never had the
// watcher wired in — same pop-in-on-arrival symptom already fixed for
// tour legs specifically, just never generalized past them until now.
function flyToWithRedrawWatch(flyFn) {
  const stopRedrawWatcher = watchFlightForRedraw();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    stopRedrawWatcher();
  };
  flyFn();
  map.once('moveend', finish);
  // Safety net in case 'moveend' never fires (e.g. a no-op flight to an
  // already-current view) — same reasoning as tourFlyToAndWait's own
  // hard ceiling below, just a fixed generous duration since these
  // callers don't already compute one of their own the way tour legs do.
  setTimeout(finish, 8000);
}

function tourFlyToAndWait(flyFn, duration) {
  return new Promise((resolve) => {
    let done = false;
    const stopRedrawWatcher = watchFlightForRedraw();
    const finish = () => {
      if (done) return;
      done = true;
      stopRedrawWatcher();
      suppressMapClamp = false;
      clampSouth();
      clampNorth();
      resolve();
    };
    suppressMapClamp = true;
    withSuppressedDismiss(flyFn);
    map.once('moveend', finish);
    // Hard ceiling in case 'moveend' never fires cleanly — e.g. the very
    // first tourGoToWorld() call, if the map already happens to be sitting
    // exactly at the world view: flyTo to an unchanged target may not
    // actually move anything, and it's not guaranteed Leaflet still fires
    // 'moveend' for that no-op case. Without this, that single case would
    // hang the whole tour forever on a promise that never resolves — same
    // reasoning as withSuppressedDismiss's own hard-ceiling timer above.
    setTimeout(finish, duration * 1000 + 300);
  });
}

// Experimental: since the tour will eventually visit individual pins
// within a country, clustering them first (only to immediately explode
// back apart) seemed pointless — and clusters not visibly expanding/
// collapsing mid-flight was the original complaint anyway. So at country
// zoom during a tour, skip clustering entirely and hide every OTHER pin
// worldwide too — not just this division's — confirmed live as the better
// feel: show only the target country's markers, plain, on their own
// layer. World/division views still cluster normally, everywhere.
let tourCountryLayer = null;

function showTourCountryPinsOnly(countryName) {
  restoreTourClustering();
  for (const group of Object.values(state.clusterGroups)) {
    if (map.hasLayer(group)) map.removeLayer(group);
  }
  const entries = state.markersByCountry.get(countryName) || [];
  tourCountryLayer = L.layerGroup(entries.map((e) => e.marker));
  tourCountryLayer.addTo(map);
}

function restoreTourClustering() {
  if (tourCountryLayer) {
    map.removeLayer(tourCountryLayer);
    tourCountryLayer = null;
  }
  for (const group of Object.values(state.clusterGroups)) {
    if (!map.hasLayer(group)) group.addTo(map);
  }
}

async function tourGoToWorld() {
  restoreTourClustering();
  // Hidden as this flight departs (leaving the division/last country
  // behind) rather than swapping straight to world metrics — confirmed
  // live as reading better with a beat of nothing showing while actually
  // in transit, same reasoning as tourGoToCountry's own hide-on-departure.
  hideMetricsOverlay();
  const target = L.latLng(CONFIG.MAP_CENTER);
  const duration = tourLegDuration(target, CONFIG.MAP_ZOOM);
  await tourFlyToAndWait(() => map.flyTo(target, CONFIG.MAP_ZOOM, { duration }), duration);
  showMetricsOverlay(state.worldMetrics, null);
}

// __divisionBounds returns a plain [[south,west],[north,east]] array, not
// a real L.LatLngBounds (see its own comment — that's so it survives the
// Puppeteer page.evaluate() serialization boundary for the PDF report,
// its original caller). map.flyToBounds happily normalizes that array on
// its own, but .getCenter() needs an actual LatLngBounds instance.
// Shared by tourGoToDivision and tourGoToDivisionOverview.
// Returns { promise, duration } rather than just the promise — callers
// that want to reveal something partway through the flight (see
// TOUR_LABEL_REVEAL_FRACTION, used by tourGoToDivisionOverview below)
// need the computed duration too, not just something to await.
function tourFlyToDivisionBounds(divisionKey) {
  const rawBounds = window.__divisionBounds(divisionKey);
  if (!rawBounds) return null;
  const bounds = L.latLngBounds(rawBounds);
  const target = bounds.getCenter();
  // Approximate — flyToBounds below computes its own fitted zoom (with
  // padding) internally; this is only close enough to feed the pixel-based
  // duration estimate, not meant to match flyToBounds' actual result.
  const duration = tourCountryLegDuration(target, map.getBoundsZoom(bounds));
  const promise = tourFlyToAndWait(() => map.flyToBounds(bounds, {
    paddingTopLeft: [40, 170],
    paddingBottomRight: [40, 40],
    duration,
  }), duration);
  return { promise, duration };
}

// Reveals at TOUR_LABEL_REVEAL_FRACTION of the flight, same as every
// other arrival label (tourGoToCountry, tourGoToDivisionOverview) — this
// used to show immediately on departure instead, the one inconsistent
// one of the three, left over from before the other two got this same
// early-reveal treatment.
async function tourGoToDivision(divisionKey) {
  restoreTourClustering();
  hideMetricsOverlay();
  const reveal = () => showMetricsOverlay(state.metricsByDivision.get(divisionKey) || [], DIVISIONS[divisionKey].pin, escapeHtml(DIVISIONS[divisionKey].label));
  const flight = tourFlyToDivisionBounds(divisionKey);
  if (flight) {
    setTimeout(reveal, flight.duration * TOUR_LABEL_REVEAL_FRACTION * 1000);
    await flight.promise;
  } else {
    reveal();
  }
}

// After the division's last country (pins + country overview) is done,
// zoom back out to the WHOLE division before leaving for World — same
// shape as tourGoToCountryOverview one level up. Unlike that one, this
// does switch the label eventually (to the division's own metrics) — the
// point of this step is showing everything the tour just covered
// together, not lingering on the last country specifically — but not
// until arrival: showing "division" metrics while the camera's still
// tightly zoomed into that last country would be the same label/view
// mismatch already confirmed to read badly for country labels. So the
// last country's own label/metrics hide (fade out) as this flight
// departs, same as every other hide-on-departure leg, then the
// division's fade back in on arrival — #metrics-overlay's own opacity
// transition (css/style.css) handles both fades, this just needs to
// actually toggle metrics-hidden off then on instead of swapping the
// label's content while it sits at full opacity the whole flight. Every
// pin (not just the last country's) is un-hidden right away, though —
// explicitly asked to happen before this zoom-out, not gated to arrival.
// The division label itself reveals at TOUR_LABEL_REVEAL_FRACTION of the
// flight, same early-reveal timing as a country's own label (see that
// constant's comment) rather than waiting for full arrival.
async function tourGoToDivisionOverview(divisionKey) {
  restoreTourClustering();
  hideMetricsOverlay();
  const reveal = () => showMetricsOverlay(state.metricsByDivision.get(divisionKey) || [], DIVISIONS[divisionKey].pin, escapeHtml(DIVISIONS[divisionKey].label));
  const flight = tourFlyToDivisionBounds(divisionKey);
  if (flight) {
    setTimeout(reveal, flight.duration * TOUR_LABEL_REVEAL_FRACTION * 1000);
    await flight.promise;
  } else {
    reveal();
  }
}

// Shared bounds/zoom lookup for a country — used both when first arriving
// (tourGoToCountry) and when zooming back out to the same country's
// overview after visiting its pins (tourGoToCountryOverview).
function countryBoundsAndZoom(name) {
  let countryLayer;
  state.geoLayer.eachLayer((layer) => {
    if (normalizeCountryName(layer.feature.properties.name) === name) countryLayer = layer;
  });
  if (!countryLayer) return null;
  const bounds = computeMainLandBounds(countryLayer.feature);
  const targetZoom = map.getBoundsZoom(bounds) - 0.5;
  return { targetZoom, target: bounds.getCenter() };
}

// Fraction of a leg's duration at which its arrival label appears — not
// on departure (labeled a place the camera hadn't even started toward)
// and not gated to full arrival either (read as a step behind once pins
// made the rest of the tour brisker). flyTo's own easing is fastest in
// the middle and decelerates into the back third or so of a flight, so
// timing the reveal there lines the name up with roughly when the
// destination visibly starts "arriving" rather than with departure or
// the final stop. Shared by a country's own label (tourGoToCountry) and
// the division's, on the final zoom-out (tourGoToDivisionOverview).
const TOUR_LABEL_REVEAL_FRACTION = 0.65;

async function tourGoToCountry(name) {
  showTourCountryPinsOnly(name);
  // Hidden as this flight departs — leaving the division's own metrics
  // (the first country in a division) or the previous country's overview
  // (every country after) behind, same reasoning as tourGoToWorld's own
  // hide-on-departure.
  hideMetricsOverlay();
  const info = countryBoundsAndZoom(name);
  if (!info) return;
  const duration = tourCountryLegDuration(info.target, info.targetZoom);
  setTimeout(() => showCountryMetricsOverlay(name), duration * TOUR_LABEL_REVEAL_FRACTION * 1000);
  await tourFlyToAndWait(() => map.flyTo(info.target, info.targetZoom, { duration }), duration);
}

// After visiting all of a country's pins, zoom back out to that same
// country's own overview before moving on to the next one, instead of
// jumping straight from the last pin to the next country — confirmed
// live as the better flow. Metrics/label aren't touched at all here:
// still the same country the pins just came from, so whatever's already
// showing just stays up throughout.
async function tourGoToCountryOverview(name) {
  const info = countryBoundsAndZoom(name);
  if (!info) return;
  const duration = tourCountryLegDuration(info.target, info.targetZoom);
  await tourFlyToAndWait(() => map.flyTo(info.target, info.targetZoom, { duration }), duration);
}

// Every ministry pin in `countryName`, ordered by the same orderByProximity
// nearest-neighbor chain used for countries within a division — pins
// aren't clustered during a tour's country leg (see showTourCountryPinsOnly),
// so this is exactly what the visitor sees on screen to sweep through.
function pinsInCountryByProximity(countryName) {
  const entries = state.markersByCountry.get(countryName) || [];
  const points = entries.map((entry) => {
    const latLng = entry.marker.getLatLng();
    return { entry, lat: latLng.lat, lng: latLng.lng };
  });
  return orderByProximity(points).map((p) => p.entry);
}

// Flies to one pin, but stays at the country's own zoom (targetZoom,
// passed down from countryBoundsAndZoom — the same one tourGoToCountry
// itself lands at) rather than zooming in further to CONFIG.MAX_ZOOM —
// pin-to-pin hops within a country now read as a pan across a view that
// still shows the country's outline, not a tight zoom-in per pin. Pins
// aren't clustered during this phase (see showTourCountryPinsOnly), so
// two close together can end up visually tight at this wider zoom —
// accepted tradeoff for keeping the country's shape in view throughout.
// Then opens that pin's own popup. If it has photos, steps through all of them once in
// the fullscreen lightbox (window.__ministryLightbox — exposed by
// wireMinistryPhotoCarousel specifically for this) at TOUR_PHOTO_DWELL_
// SECONDS each, then closes the lightbox and holds on the popup/pin view
// alone for the shorter TOUR_PIN_DWELL_SECONDS before closing the popup
// and moving on — content to actually read/see, not a pause before
// continuing straight through like every other dwell in the tour.
// Country metrics stay up underneath throughout.
// Landing spot for a pin visit isn't the pin's own lat/lng — that would
// center it in the middle of the screen, right where a future info card
// popping up over it would want to sit. Instead, fly to a point shifted
// far enough north (at the target zoom) that the pin itself ends up
// low-center on screen, just above the tour-controls bar, leaving the
// rest of the viewport free for that card. Computed via
// project/unproject at the target zoom rather than a fixed lat/lng
// offset, since the same screen-pixel gap means a different real-world
// distance depending on zoom.
function tourPinLandingLatLng(target, targetZoom) {
  const mapSize = map.getSize();
  const controlsRect = document.getElementById('tour-controls').getBoundingClientRect();
  const desiredScreenY = controlsRect.top - 24; // 24px clearance above the controls bar
  const targetPoint = map.project(target, targetZoom);
  const centerPoint = targetPoint.add([0, mapSize.y / 2 - desiredScreenY]);
  return map.unproject(centerPoint, targetZoom);
}

async function tourGoToPin(entry, targetZoom) {
  const target = entry.marker.getLatLng();
  const duration = tourPinLegDuration(target, targetZoom);
  await tourFlyToAndWait(() => {
    const landing = tourPinLandingLatLng(target, targetZoom);
    map.flyTo(landing, targetZoom, { duration });
  }, duration);
  entry.marker.openPopup();

  const photos = (entry.row.photos || '').split(';').map((s) => s.trim()).filter(Boolean);
  if (photos.length && window.__ministryLightbox) {
    await tourDwell(TOUR_PIN_DWELL_SECONDS);
    await window.__ministryLightbox.open(photos);
    await tourDwell(TOUR_PHOTO_DWELL_SECONDS);
    for (let i = 1; i < photos.length; i++) {
      window.__ministryLightbox.showNext();
      await tourDwell(TOUR_PHOTO_DWELL_SECONDS);
    }
    window.__ministryLightbox.close();
    await tourDwell(TOUR_PIN_DWELL_SECONDS);
  } else {
    // No photos means no lightbox detour, so the two TOUR_PIN_DWELL_
    // SECONDS beats either side of it would otherwise just stack into a
    // single, needlessly-doubled pause — one flat dwell instead, its own
    // tunable length.
    await tourDwell(TOUR_PIN_NO_PHOTO_DWELL_SECONDS);
  }

  entry.marker.closePopup();
}

class TourStopSignal extends Error {}

const tourController = { state: 'stopped', loop: false };

// Every await point in the tour is (indirectly) a call to this — blocks
// in place while paused, and throws to unwind the whole runTour call back
// to playTour's own catch once stopped. Only checked between legs, not
// mid-flight — Pause/Close take effect once the current leg settles, not
// instantly; fine for a ~1s leg.
async function tourCheckpoint() {
  while (tourController.state === 'paused') {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (tourController.state === 'stopped') throw new TourStopSignal();
}

// A deliberate held dwell — everywhere else in the tour, legs chain
// straight into each other with no pause (decel into arrival, immediately
// accel back out). This is the one exception: a beat to actually read the
// division's metrics before the camera starts moving toward its first
// country. Not itself pause/stop-aware mid-dwell — same granularity as
// every other checkpoint, which only ever takes effect between legs, not
// instantly.
async function tourDwell(seconds) {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// Shared pause length for every tourDwell() call in the tour — one place
// to retune the pacing.
const TOUR_DWELL_SECONDS = 1;

// How long each of a ministry's photos stays up in the fullscreen
// lightbox during a pin visit (tourGoToPin) — its own constant since
// there's actual content (a photo) to look at, unlike the division/
// country arrival dwells above.
const TOUR_PHOTO_DWELL_SECONDS = 2;

// How long tourGoToPin holds on the plain popup/pin view — once right
// after the popup opens (before any photos), and again once the photo
// lightbox has already closed — a beat to actually see the pin/popup on
// its own both before and after the photos, not just a single dwell
// tacked on one side. Only used when there are photos, i.e. both beats
// actually happen — see TOUR_PIN_NO_PHOTO_DWELL_SECONDS for the case
// where there's no lightbox detour to bookend at all.
const TOUR_PIN_DWELL_SECONDS = 1.5;

// A pin with no photos skips the lightbox entirely, so it gets one flat
// dwell instead of the two TOUR_PIN_DWELL_SECONDS beats that would
// otherwise stack into a needlessly-doubled pause (3s) for a plain popup
// with nothing to show but text. Its own tunable value rather than reused
// so the two cases (photos vs no photos) can be paced independently.
const TOUR_PIN_NO_PHOTO_DWELL_SECONDS = 2;

// Every pass ends back at World — the same place it started — rather
// than stopping wherever the last country happened to leave off. Doing
// that unconditionally (loop on or off) is what makes looping trivial:
// the next pass just continues on from Division again with no special
// jump-back case, and a non-repeating tour gets a clean, deliberate
// landing spot instead of trailing off at an arbitrary country.
// TESTING ONLY — see its one use in runTour below.
const TOUR_TESTING_MAX_COUNTRIES = 2;

// divisionKeys is an array, not a single key — a "World Tour" (every
// division) and a single-division tour are the exact same code, just a
// different-length list. Divisions flow straight from one to the next
// (no forced return to World in between), same as countries flow
// straight to the next country within a division — World only bookends
// the whole run (once at the very start, once per loop pass at the end).
async function runTour(divisionKeys) {
  // World only bookends a real World Tour (more than one division) — a
  // single division picked from the menu goes straight there (wherever
  // the map happens to be starting from) and, if looping, just repeats
  // within that division, never detouring through World at all.
  const isWorldTour = divisionKeys.length > 1;
  await tourCheckpoint();
  if (isWorldTour) await tourGoToWorld();
  for (;;) {
    for (const divisionKey of divisionKeys) {
      await tourCheckpoint();
      await tourGoToDivision(divisionKey);
      await tourDwell(TOUR_DWELL_SECONDS);

      // TESTING ONLY — caps each division to its first few countries so a
      // full run (especially a World Tour) is fast to iterate on. Remove
      // this slice (or raise/lower TOUR_TESTING_MAX_COUNTRIES) once the
      // tour's actually ready to cover every country for real.
      const countries = countriesInDivisionByProximity(divisionKey).slice(0, TOUR_TESTING_MAX_COUNTRIES);
      for (const countryName of countries) {
        await tourCheckpoint();
        await tourGoToCountry(countryName);
        await tourDwell(TOUR_DWELL_SECONDS);
        // Same zoom tourGoToCountry itself just landed at — pin-to-pin
        // hops stay there instead of zooming in further (see
        // tourGoToPin's own comment on why).
        const countryInfo = countryBoundsAndZoom(countryName);
        const pinZoom = countryInfo ? countryInfo.targetZoom : CONFIG.MAX_ZOOM;
        for (const pinEntry of pinsInCountryByProximity(countryName)) {
          await tourCheckpoint();
          await tourGoToPin(pinEntry, pinZoom);
        }
        await tourCheckpoint();
        await tourGoToCountryOverview(countryName);
      }

      await tourCheckpoint();
      await tourGoToDivisionOverview(divisionKey);
    }

    if (isWorldTour) {
      await tourCheckpoint();
      await tourGoToWorld();
    }

    if (!tourController.loop) break;
  }
  // Reaching the end of a non-looping run is its own kind of stop, but not
  // a full stopTour() — the leg that just ran (tourGoToDivisionOverview/
  // tourGoToWorld) already landed exactly here and already restored
  // clustering, so only the state/controls cleanup half is needed; see
  // endTourInPlace's own comment for why the navigate-away half is
  // deliberately skipped here.
  endTourInPlace();
}

let tourRunPromise = null;
let currentTourDivisionKeys = null; // array of division keys — see runTour

function updateTourControlsUI() {
  const playing = tourController.state === 'playing';
  document.getElementById('tour-play-btn').disabled = playing;
  document.getElementById('tour-pause-btn').disabled = !playing;
  const loopBtn = document.getElementById('tour-loop-btn');
  loopBtn.classList.toggle('active', tourController.loop);
  loopBtn.setAttribute('aria-pressed', String(tourController.loop));
}

// "A couple of seconds" of no interaction fades the controls out during
// active playback, so they're not sitting over the view for the whole
// tour — brought back by any mouse movement (see the listener in
// runQueryStringTour) or once the tour actually stops (paused or
// finished), so they're never hidden while there's something to press.
const TOUR_CONTROLS_IDLE_MS = 2000;
let tourControlsIdleTimer = null;

function showTourControlsNow() {
  clearTimeout(tourControlsIdleTimer);
  document.getElementById('tour-controls').classList.remove('idle-hidden');
}

function scheduleTourControlsHide() {
  clearTimeout(tourControlsIdleTimer);
  tourControlsIdleTimer = setTimeout(() => {
    document.getElementById('tour-controls').classList.add('idle-hidden');
  }, TOUR_CONTROLS_IDLE_MS);
}

function playTour() {
  if (tourController.state === 'paused') {
    tourController.state = 'playing';
    document.body.classList.add('tour-active');
    updateTourControlsUI();
    scheduleTourControlsHide();
    return;
  }
  if (tourRunPromise || !currentTourDivisionKeys || !currentTourDivisionKeys.length) return;
  tourController.state = 'playing';
  document.body.classList.add('tour-active');
  updateTourControlsUI();
  scheduleTourControlsHide();
  tourRunPromise = runTour(currentTourDivisionKeys)
    .catch((err) => {
      if (!(err instanceof TourStopSignal)) console.error(err);
    })
    .finally(() => {
      tourRunPromise = null;
      // Belt-and-suspenders alongside the restoreTourClustering() calls
      // already in tourGoToWorld/tourGoToDivision/stopTour — this one
      // covers the case those don't: an actual error (not a normal
      // TourStopSignal) partway through a country leg, which would
      // otherwise skip past all of them and leave clustering hidden with
      // no tour left running to ever fix it.
      restoreTourClustering();
    });
}

function pauseTour() {
  if (tourController.state !== 'playing') return;
  tourController.state = 'paused';
  document.body.classList.remove('tour-active');
  updateTourControlsUI();
  showTourControlsNow(); // stay visible while paused — nothing to auto-hide toward
}

function toggleTourLoop() {
  tourController.loop = !tourController.loop;
  updateTourControlsUI();
}

// Hides the controls, un-hides every pin/cluster (in case this fires
// mid-country-leg, when clustering is swapped out for just that one
// country's plain pins — otherwise stopping there would leave the rest
// of the division's pins invisible for good), and zooms out to a clean
// landing spot: the division being toured, or World for a multi-division
// World Tour — reusing the exact same goToDivisionFn/goToWorldFn the
// site's own nav-menu uses, so this ends up in exactly the state a
// regular visitor would if they'd navigated there normally (same
// metrics shown, same animated flyTo/flyToBounds).
function stopTour() {
  endTourInPlace();
  if (currentTourDivisionKeys && currentTourDivisionKeys.length === 1) {
    if (goToDivisionFn) goToDivisionFn(currentTourDivisionKeys[0]);
  } else if (goToWorldFn) {
    goToWorldFn();
  }
}

// Shared by stopTour (the Stop button, which can interrupt an arbitrary
// mid-flight moment and so genuinely needs the navigate-away step above)
// and runTour's own natural, non-looping end (below) — which does NOT:
// the leg that just ran (tourGoToDivisionOverview/tourGoToWorld) already
// landed exactly here, with clustering already restored, a moment ago.
// Re-firing goToDivisionFn/goToWorldFn on top of that was a second,
// redundant flyTo starting from (and animating a "no-op" move around)
// an already-correct view — harmless in theory, but the more likely
// explanation for pins occasionally not all showing after a tour ends
// than anything in the leg that actually got us there correctly.
function endTourInPlace() {
  tourController.state = 'stopped';
  document.body.classList.remove('tour-active');
  clearTimeout(tourControlsIdleTimer);
  document.getElementById('tour-controls').hidden = true;
  updateTourControlsUI();
  restoreTourClustering();
  // A pin's popup — and, mid-photo-dwell, the fullscreen lightbox on top
  // of it — is still open and waiting out its own dwell timer when Stop
  // interrupts tourGoToPin. Neither timer is checkpoint-aware mid-dwell
  // (same as every other tour dwell), so without this they'd sit open
  // until they happen to elapse on their own instead of closing the
  // instant Stop is pressed.
  if (window.__ministryLightbox && window.__ministryLightbox.isVisible()) window.__ministryLightbox.close();
  map.closePopup();
}

// Switches to a different tour (a single division, or every division for
// a World Tour) from the tour-picker menu, whether or not one's already
// playing. If one is, this stops it and waits for its own runTour promise
// to actually settle (same checkpoint-based unwind stopTour uses — takes
// effect once the current leg finishes, not instantly) before starting
// the new selection; playTour's own tourRunPromise guard would otherwise
// silently no-op a call made while the old run is still unwinding.
async function selectTour(divisionKeys) {
  if (tourRunPromise) {
    tourController.state = 'stopped';
    await tourRunPromise;
  }
  currentTourDivisionKeys = divisionKeys;
  tourController.state = 'stopped';
  document.getElementById('tour-controls').hidden = false;
  updateTourControlsUI();
  playTour();
}

function wireTourControls() {
  document.getElementById('tour-play-btn').addEventListener('click', playTour);
  document.getElementById('tour-pause-btn').addEventListener('click', pauseTour);
  document.getElementById('tour-loop-btn').addEventListener('click', toggleTourLoop);
  document.getElementById('tour-stop-btn').addEventListener('click', stopTour);
  document.addEventListener('mousemove', () => {
    showTourControlsNow();
    if (tourController.state === 'playing') scheduleTourControlsHide();
  });
}

// Separate from the site's own #nav-menu-toggle (which picks what the
// map is currently showing) — this picks which tour to run, without
// having to edit the ?tour= query string each time. Only ever wired/
// shown alongside the rest of this prototype (see runQueryStringTour).
function wireTourMenu() {
  const toggle = document.getElementById('tour-menu-toggle');
  const menu = document.getElementById('tour-menu');
  const list = document.getElementById('tour-menu-list');

  function closeMenu() {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }

  const divisionKeys = divisionsByProximity();
  list.innerHTML = `<li><button type="button" class="nav-menu-item" data-tour="all">
        <img class="nav-menu-icon" src="images/favicon.svg" alt="">
        <span>World Tour (All Divisions)</span>
      </button></li>`
    + divisionKeys.map((key) => `
      <li><button type="button" class="nav-menu-item" data-tour="${escapeHtml(key)}">
        <span class="color-swatch" style="background:${DIVISIONS[key].pin}"></span>
        <span>${escapeHtml(DIVISIONS[key].label)}</span>
      </button></li>
    `).join('');

  list.querySelectorAll('.nav-menu-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tour;
      closeMenu();
      selectTour(key === 'all' ? divisionsByProximity() : [key]);
    });
  });

  toggle.addEventListener('click', () => {
    if (menu.hidden) openMenu();
    else closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !toggle.contains(e.target)) closeMenu();
  });
}

function runQueryStringTour() {
  const name = new URLSearchParams(location.search).get('tour');
  if (!name) return;

  document.getElementById('tour-controls').hidden = false;
  document.getElementById('tour-menu-toggle').hidden = false;
  wireTourControls();
  wireTourMenu();
  updateTourControlsUI();

  // 'lac' kept as a shorthand for the division this prototype started
  // with; 'all'/'world' runs every division in one sweep (a "World
  // Tour"); anything else needs to be an exact division key. An
  // unrecognized value still leaves the controls/menu up (rather than
  // bailing entirely) so a mistyped query string can just be corrected
  // by picking a real option from the new menu instead of editing the URL.
  let divisionKeys;
  if (name === 'all' || name === 'world') {
    divisionKeys = divisionsByProximity();
  } else if (name === 'lac') {
    divisionKeys = ['latin_america_caribbean'];
  } else if (DIVISIONS[name]) {
    divisionKeys = [name];
  } else {
    console.warn(`?tour=${name} — no such tour. Known: all, world, lac, or a division key (${Object.keys(DIVISIONS).join(', ')}). Pick one from the new tour menu instead.`);
    return;
  }
  // Preselected (so Play works right away, or the menu can just pick
  // something else) but not auto-started — press Play, or pick a tour
  // from the new menu, rather than immediately flying off on load.
  currentTourDivisionKeys = divisionKeys;
}
