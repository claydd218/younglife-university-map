// Dependency-free RFC 4180 CSV parser/writer for the admin Functions.
//
// Not a regex split — regex-splitting CSV breaks on quoted fields that
// contain the delimiter, which is exactly the class of bug this project is
// trying to get away from (see the nested-parens/unquoted-comma incidents
// from hand-editing data/ministries.csv). This is a small hand-written state
// machine instead.

// text -> { header: string[], rows: Record<string,string>[] }
// Handles quoted fields, embedded commas/newlines inside quotes, doubled ""
// for a literal quote, and \r\n / \n / bare \r line endings.
export function parseCsv(text) {
  const rawRows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function pushField() {
    row.push(field);
    field = '';
  }
  function pushRow() {
    pushField();
    rawRows.push(row);
    row = [];
  }

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
      i++;
      continue;
    }
    if (c === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // A file ending in a single trailing newline already emitted its last row
  // via the loop above (field/row are empty at this point) — only flush here
  // for content with no trailing newline at all.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  if (rawRows.length === 0) return { header: [], rows: [] };
  const header = rawRows[0];
  const rows = rawRows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] !== undefined ? r[idx] : '';
    });
    return obj;
  });
  return { header, rows };
}

function needsQuoting(field) {
  return /[",\r\n]/.test(field);
}

function quoteField(field) {
  return needsQuoting(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

// (header: string[], rows: Record<string,string>[]) -> string
// Always LF line endings, single trailing newline, quotes only where needed.
export function stringifyCsv(header, rows) {
  const lines = [header.map(quoteField).join(',')];
  for (const row of rows) {
    lines.push(
      header.map((h) => quoteField(row[h] != null ? String(row[h]) : '')).join(','),
    );
  }
  return lines.join('\n') + '\n';
}
