// ---------------------------------------------------------------------------
// Shared name/text utilities used by both the map app (js/app.js) and the
// admin tools (admin/*.html). Keep this dependency-free (no DOM, no Leaflet)
// so it can be dropped into any page with a plain <script> tag.
// ---------------------------------------------------------------------------

// Parses the shared "Name (Meta); Name (Meta)" convention used by both the
// staff column ("Jane Doe (Area Director)") and the universities column
// ("University of Nairobi (2003)").
function parseParenList(raw) {
  if (!raw) return [];
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      if (match) {
        return { name: match[1].trim(), meta: match[2].trim() };
      }
      return { name: entry, meta: '' };
    });
}

// "Camila Rodríguez" -> "camila-rodriguez". Used to derive image filenames
// from names/cities so photos can be dropped into IMAGES_DIR by convention
// instead of being wired up per-row in the CSV.
// Combining Diacritical Marks block (U+0300-U+036F), written as escapes
// rather than literal characters to avoid any editor/encoding ambiguity.
const DIACRITIC_MARKS_RE = /[̀-ͯ]/g;

function slugify(str) {
  return (str || '')
    .normalize('NFD')
    .replace(DIACRITIC_MARKS_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function initialsFor(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// Naive "last token is the last name" split — good enough for sorting a
// staff list, not meant to handle every naming convention.
function lastNameOf(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// "PH" -> 🇵🇭. Flag emoji are just two Regional Indicator Symbol characters,
// one per letter (A -> U+1F1E6 ... Z -> U+1F1FF), so any ISO 3166-1 alpha-2
// code converts directly with no per-country lookup table needed.
function flagEmoji(iso2) {
  const code = (iso2 || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  const REGIONAL_INDICATOR_BASE = 0x1f1e6;
  return String.fromCodePoint(
    ...[...code].map((c) => REGIONAL_INDICATOR_BASE + (c.charCodeAt(0) - 65))
  );
}
