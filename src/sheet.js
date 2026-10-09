import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { sheetRef } from './google.js';

function tableFromWorkbook(wb, worksheet) {
  const name = worksheet || wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`The sheet has no tab called "${worksheet}". Tabs: ${wb.SheetNames.join(', ')}`);
  // blankrows: true keeps empty rows so row numbers match the sheet; empty rows are dropped later
  const table = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
  // If the used range does not start at row 1, pad so table index 0 is sheet row 1
  const start = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;
  return [...Array.from({ length: start }, () => []), ...table];
}

const parseCsv = (text) => tableFromWorkbook(XLSX.read(text.replace(/^﻿/, ''), { type: 'string', raw: true }));

async function loadTable(cfg, google) {
  if (cfg.sheet.file) {
    const f = cfg.sheet.file;
    if (!fs.existsSync(f)) throw new Error(`Sheet file not found: ${f}`);
    const ext = path.extname(f).toLowerCase();
    if (ext === '.csv' || ext === '.txt') return parseCsv(fs.readFileSync(f, 'utf8'));
    return tableFromWorkbook(XLSX.readFile(f), cfg.sheet.worksheet);
  }

  const { id, gid } = sheetRef(cfg.sheet.google_sheet);
  if (google.enabled) {
    let title = cfg.sheet.worksheet;
    if (!title) {
      const meta = await google.get(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`);
      const s = gid ? meta.sheets.find((x) => String(x.properties.sheetId) === gid) : meta.sheets[0];
      if (!s) throw new Error('No tab found in the Google Sheet.');
      title = s.properties.title;
    }
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
    const data = await google.get(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
    return data.values || [];
  }

  // Without a Google sign-in: a sheet shared as "Anyone with the link" can be read through the export.
  // A chosen tab is read from the full workbook; otherwise the tab in the link (gid) is read as CSV.
  if (cfg.sheet.worksheet) return tableFromWorkbook(await publicWorkbook(id), cfg.sheet.worksheet);
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`);
  const text = await res.text();
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('Could not read the Google Sheet. Share it as "Anyone with the link can view", or add a Google service account key.');
  }
  return parseCsv(text);
}

// Tab names of an Excel file, or of a Google Sheet
export async function listWorksheets(cfg, google) {
  if (cfg.sheet.file) {
    const ext = path.extname(cfg.sheet.file).toLowerCase();
    if (ext === '.csv' || ext === '.txt') return [];
    return XLSX.readFile(cfg.sheet.file, { bookSheets: true }).SheetNames;
  }
  if (!cfg.sheet.google_sheet) return [];
  const { id } = sheetRef(cfg.sheet.google_sheet);
  if (google.enabled) {
    const meta = await google.get(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`);
    return meta.sheets.map((s) => s.properties.title);
  }
  return (await publicWorkbook(id)).SheetNames;
}

// A Google Sheet shared as "Anyone with the link", downloaded as a whole workbook (all tabs)
async function publicWorkbook(id) {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || buf.subarray(0, 2).toString() !== 'PK') {
    throw new Error('Could not read the Google Sheet. Share it as "Anyone with the link can view", or add a Google service account key.');
  }
  return XLSX.read(buf);
}

// The header row is the first row that looks like column names: it has at least half as many filled
// cells as the fullest row near the top. This skips title or note rows above the real headers.
export function detectHeaderRow(table) {
  const counts = table.slice(0, 20).map((r) => r.filter((v) => String(v ?? '').trim() !== '').length);
  const max = Math.max(0, ...counts);
  const idx = counts.findIndex((n) => n >= Math.max(2, Math.ceil(max * 0.5)));
  return idx < 0 ? 0 : idx;
}

// Returns { headers, rows, headerRow } where each row is { __row: line number in the sheet, "Column": "value" }
export async function loadRows(cfg, google) {
  const table = await loadTable(cfg, google);
  if (!table.length) throw new Error('The sheet is empty.');
  const chosen = Number(cfg.sheet.header_row) || 0;
  const h = chosen > 0 ? chosen - 1 : detectHeaderRow(table);
  if (h >= table.length) throw new Error(`The sheet has no row ${h + 1} to use as the header row.`);
  const headers = (table[h] || []).map((x) => String(x ?? '').trim());
  const dupes = headers.filter((x, i) => x && headers.indexOf(x) !== i);
  const rows = table
    .slice(h + 1)
    .map((r, i) => {
      const o = { __row: h + i + 2 };
      headers.forEach((col, j) => {
        if (col && !(col in o)) o[col] = String(r?.[j] ?? '').trim();
      });
      return o;
    })
    .filter((o) => headers.some((col) => col && o[col] !== ''));
  return { headers, rows, headerRow: h + 1, duplicateHeaders: [...new Set(dupes)] };
}
