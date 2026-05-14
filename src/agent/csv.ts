/**
 * Tiny CSV reader/writer for plan-review mode.
 *
 * Writes the Planner's scenarios as a CSV that Excel / Numbers / Sheets open
 * by double-click. Stakeholders set Approve=no to skip a scenario, then the
 * Explorer is started with `--from-plan <file>` and only the approved rows
 * are passed in as the plan.
 *
 * Spec we honour (subset of RFC 4180):
 *   - Comma delimiter, LF line break.
 *   - Fields with commas/quotes/newlines are double-quoted; embedded `"` is `""`.
 *   - First row is the header.
 */

export interface Row {
  [column: string]: string;
}

export function writeCsv(rows: Row[], columns: string[]): string {
  const header = columns.map(escape).join(',');
  const body = rows.map((row) =>
    columns.map((c) => escape(row[c] ?? '')).join(',')
  );
  return [header, ...body].join('\n') + '\n';
}

export function readCsv(text: string): Row[] {
  // Strip BOM and normalise line endings.
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = parseLines(src);
  if (lines.length < 2) return [];
  const header = lines[0]!;
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!;
    if (fields.length === 1 && fields[0] === '') continue; // skip empty lines
    const row: Row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]!] = fields[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function escape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * RFC-4180-ish line/field parser. Each line returns an array of fields.
 * Quoted fields may span multiple lines (we walk char-by-char).
 */
function parseLines(src: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; }
      else if (ch === '"' && field === '') { inQuotes = true; }
      else { field += ch; }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}
