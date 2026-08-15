// Server-side (Workers/ES module) copies of the name/text helpers from
// js/utils.js, plus the write-side helpers the admin Functions need.
//
// This is a deliberate *duplication*, not an import: js/utils.js is a plain
// classic <script> with no `export`, by explicit design ("dependency-free...
// dropped into any page with a plain <script> tag"), used directly by
// index.html and the admin UI. Pages Functions run as ES modules and can't
// load a non-module script. Keep slugify/parseParenList here byte-for-byte
// in sync with js/utils.js if either changes.

const DIACRITIC_MARKS_RE = /[̀-ͯ]/g;

// "Camila Rodríguez" -> "camila-rodriguez" — byte-for-byte copy of
// js/utils.js's slugify().
export function slugify(str) {
  return (str || '')
    .normalize('NFD')
    .replace(DIACRITIC_MARKS_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Parses the shared "Name (Meta); Name (Meta)" convention — byte-for-byte
// copy of js/utils.js's parseParenList(). Used here only to pre-fill the
// edit form from existing CSV data; a still-malformed legacy entry falls
// back to { name: entry, meta: '' } exactly as it does on the public site,
// so it's visibly wrong in the form (obvious to fix by hand) rather than
// silently mangled. Once re-saved through this tool it's clean going
// forward, since joinParenList()/assertNoParens() below never let a new
// nested-parens case get written again.
export function parseParenList(raw) {
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

// The inverse of parseParenList — builds the "Name (Meta); Name (Meta)"
// string from clean discrete fields. Entries with no meta (e.g. a
// university with no listed year) are joined as a bare name, not
// "Name ()" — confirmed against real data that this case exists.
export function joinParenList(entries) {
  return (entries || [])
    .filter((e) => e && e.name && e.name.trim())
    .map((e) => {
      const name = e.name.trim();
      const meta = (e.meta || '').trim();
      return meta ? `${name} (${meta})` : name;
    })
    .join('; ');
}

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

// The actual fix for the nested-parens bug class: reject ambiguous input
// before it's ever written, rather than trying to make the read-side regex
// (parseParenList, used unchanged by the public site) smarter about parsing
// it. Call on every name/role/year field before joinParenList().
export function assertNoParens(value, fieldLabel) {
  if (value && /[()]/.test(value)) {
    throw new ValidationError(`${fieldLabel} can't contain parentheses`, fieldLabel);
  }
}
