// ---------------------------------------------------------------------------
// YoungLife International Ministries — site configuration
//
// This is the only file you should need to edit for day-to-day changes.
// ---------------------------------------------------------------------------

const CONFIG = {

  // Set this to your Google Sheet's "publish to web" CSV link once ready.
  // Google Sheets: File > Share > Publish to web > select the Ministries
  // sheet/tab > CSV > Publish, then paste the generated link below.
  // Leave as-is to keep using the local sample data in /data.
  MINISTRIES_CSV_URL: 'data/ministries.csv',

  // Same idea, for the country -> division lookup table below. Most sites
  // will never need to change this from the bundled file, but it can also
  // point at a published Google Sheet tab if you'd rather edit it there.
  COUNTRY_DIVISIONS_CSV_URL: 'data/country-divisions.csv',

  COUNTRIES_GEOJSON_URL: 'data/world-countries.geojson',

  // Staff and city photos are looked up by filename, not stored in the CSV.
  // A staff member "Joe Smith" resolves to images/joe-smith.png (accents
  // and punctuation stripped, lowercased, spaces become hyphens). A city
  // photo for "Bogotá, Colombia" resolves to images/bogota-colombia.png.
  // Each extension below is tried in order; if none exist, a generated
  // initial-letter placeholder is shown instead.
  IMAGES_DIR: 'images/',
  IMAGE_EXTENSIONS: ['png', 'jpg', 'jpeg', 'webp'],

  // Initial map view.
  MAP_CENTER: [15, 25],
  MAP_ZOOM: 2.5,
  MIN_ZOOM: 2,
  MAX_ZOOM: 10,

  // Country name labels (added for countries with a ministry site) only
  // show once zoomed in this far — countries are close enough together
  // that even medium zoom had labels overrunning their neighbors.
  COUNTRY_LABEL_MIN_ZOOM: 7,
};

// Decorative ocean name labels, styled in a script font like an antique atlas.
const OCEAN_LABELS = [
  { name: 'North Atlantic\nOcean', lat: 28, lng: -40 },
  { name: 'South Atlantic\nOcean', lat: -25, lng: -15 },
  { name: 'Pacific\nOcean', lat: 0, lng: -150 },
  { name: 'Indian\nOcean', lat: -20, lng: 75 },
  { name: 'Arctic\nOcean', lat: 78, lng: 5 },
  { name: 'Southern\nOcean', lat: -60, lng: 0 },
];

// Division metadata: label, muted country-highlight color, bright pin color.
// The `key` values here must match the `division` column in
// data/country-divisions.csv exactly.
const DIVISIONS = {
  latin_america_caribbean: {
    label: 'Latin America & Caribbean',
    country: '#9bb4ce',
    pin: '#2a78d6',
  },
  europe: {
    label: 'Europe',
    country: '#a99aba',
    pin: '#4a3aa7',
  },
  africa: {
    label: 'Africa',
    country: '#edc674',
    pin: '#c98500',
  },
  middle_east_central_asia: {
    label: 'Middle East & Central Asia',
    country: '#e9a192',
    pin: '#c73a39',
  },
  asia: {
    label: 'Asia Pacific',
    country: '#95cba7',
    pin: '#158f63',
  },
};

// Ministry stage: shown as marker shape (independent of division color).
// A ministry counts as "developing" when it opened less than STAGE_CUTOFF_YEARS
// ago; this is a placeholder rule until real stage data is available.
const STAGE_CUTOFF_YEARS = 2;
const STAGES = {
  developing: {
    label: 'Developing',
    shape: 'dot',
  },
  established: {
    label: 'Established',
    shape: 'star',
  },
};
