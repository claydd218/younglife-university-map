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

// A pasted YouTube/Vimeo page URL -> { provider, embedUrl } for an <iframe>
// src, or null if it's not a recognized link from either. Used both by the
// admin's Preview button and the public site's video overlay, so the
// stored video_url (the original pasted link, not a canonicalized embed
// URL) always resolves to a player the same way in both places.
function parseVideoEmbedUrl(url) {
  const trimmed = (url || '').trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\.|^m\./, '');
  const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = parsed.searchParams.get('v');
    if (!id) {
      const match = parsed.pathname.match(/^\/(?:embed|shorts)\/([a-zA-Z0-9_-]{11})/);
      if (match) id = match[1];
    }
    return id && YOUTUBE_ID_RE.test(id)
      ? { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${id}` }
      : null;
  }
  if (host === 'youtu.be') {
    const id = parsed.pathname.slice(1).split('/')[0];
    return id && YOUTUBE_ID_RE.test(id)
      ? { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${id}` }
      : null;
  }
  if (host === 'vimeo.com') {
    const match = parsed.pathname.match(/^\/(\d+)/);
    return match ? { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${match[1]}` } : null;
  }
  if (host === 'player.vimeo.com') {
    const match = parsed.pathname.match(/^\/video\/(\d+)/);
    return match ? { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${match[1]}` } : null;
  }
  return null;
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
