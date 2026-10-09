#!/usr/bin/env node
// Browser app: node src/server.js  ->  http://localhost:3789
// Runs only on this computer (127.0.0.1). Nobody else on the network can open it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { normalizeConfig } from './config.js';
import { Google } from './google.js';
import { runJob } from './runner.js';
import { listWorksheets, loadRows } from './sheet.js';
import { Shopify } from './shopify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.UPLOADER_DATA_DIR || path.join(ROOT, 'web-data');
const SHEET_DIR = path.join(DATA, 'sheet');
const IMG_DIR = path.join(DATA, 'images');
const KEY_FILE = path.join(DATA, 'google-key.json');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const OUT_DIR = path.join(DATA, 'output');
const PORT = Number(process.env.PORT || 3789);
const NEEDED_SCOPES = ['read_products', 'write_products', 'write_files'];
for (const d of [DATA, SHEET_DIR, IMG_DIR, OUT_DIR]) fs.mkdirSync(d, { recursive: true });

const DEFAULT_SETTINGS = {
  shopify: { store: '', access_token: '', client_id: '', client_secret: '', api_version: '2026-07' },
  google: { api_key: '' },
  sheet: { mode: 'file', google_sheet: '', worksheet: '', header_row: 0 },
  images: { source: 'none', drive_folder: '', mode: 'append' },
  match: { find_by: 'sku', rules: [], create_missing: false, new_product_status: 'DRAFT' },
  columns: { options: [] },
  options: { tags_mode: 'append', create_missing_collections: false, keep_unlisted_variants: true, concurrency: 4 },
  metafields: [],
};

const readSettings = () => {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const out = structuredClone(DEFAULT_SETTINGS);
    for (const k of Object.keys(s)) out[k] = Array.isArray(s[k]) ? s[k] : { ...(out[k] || {}), ...s[k] };
    return out;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
};
const writeSettings = (s) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));

const sheetFile = () => fs.readdirSync(SHEET_DIR).map((f) => path.join(SHEET_DIR, f))[0] || '';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Browser settings -> tool config
function buildConfig(s, { requireAll = true } = {}) {
  const raw = structuredClone(s);
  raw.google = { ...raw.google, service_account_file: fs.existsSync(KEY_FILE) ? KEY_FILE : '' };
  const hr = Number(raw.sheet.header_row) || 0;
  if (raw.sheet.mode === 'google') raw.sheet = { google_sheet: raw.sheet.google_sheet, worksheet: raw.sheet.worksheet, header_row: hr };
  else raw.sheet = { file: sheetFile(), worksheet: raw.sheet.worksheet, header_row: hr };
  raw.images = { ...raw.images, local_folder: IMG_DIR };
  raw.output = { folder: OUT_DIR };
  // An empty dropdown means "do not use this column"
  for (const [k, v] of Object.entries(raw.columns)) if (v === '' || v == null) delete raw.columns[k];
  if (!requireAll) return raw;
  return normalizeConfig(raw, ROOT);
}

async function sheetInfo(s) {
  const raw = buildConfig(s, { requireAll: false });
  if (!raw.sheet.file && !raw.sheet.google_sheet) return null;
  const google = new Google({ service_account_file: raw.google.service_account_file, api_key: raw.google.api_key });
  const sheetCfg = {
    sheet: { file: raw.sheet.file || '', google_sheet: raw.sheet.google_sheet || '', worksheet: raw.sheet.worksheet || '', header_row: raw.sheet.header_row || 0 },
  };
  const { headers, rows, headerRow } = await loadRows(sheetCfg, google);
  let worksheets = [];
  try {
    worksheets = await listWorksheets(sheetCfg, google);
  } catch {
    /* tab list is optional */
  }
  return {
    name: raw.sheet.file ? path.basename(raw.sheet.file) : 'Google Sheet',
    worksheets,
    headers: headers.filter(Boolean),
    headerRow,
    rowCount: rows.length,
    preview: rows.slice(0, 5),
  };
}

// ---- Job (one at a time) ----
let job = null;
function startJob(cmd, body) {
  const s = readSettings();
  const cfg = buildConfig(s);
  job = { id: Date.now(), cmd, running: true, logs: [], progress: { done: 0, total: 0 }, result: null, error: null, stop: false, startedAt: Date.now() };
  const j = job;
  const log = (m) => j.logs.push(String(m));
  runJob(cfg, cmd, {
    log,
    progress: (p) => (j.progress = p),
    shouldStop: () => j.stop,
    only: body.only || undefined,
    limit: body.limit || undefined,
    force: !!body.force,
  })
    .then((r) => (j.result = { ...r, reportFile: r.reportFile ? path.basename(r.reportFile) : '', logFile: r.logFile ? path.basename(r.logFile) : '' }))
    .catch((e) => {
      j.error = e.message;
      log(`ERROR: ${e.message}`);
    })
    .finally(() => {
      j.running = false;
      j.finishedAt = Date.now();
    });
}

// ---- HTTP ----
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString('utf8');
  return t ? JSON.parse(t) : {};
};
// Cleans an uploaded file path (removes ../ and characters Windows does not allow)
const safeRel = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((x) => x && x !== '.' && x !== '..')
    .map((x) => x.replace(/[<>:"|?*\x00-\x1f]/g, '_'))
    .join('/');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'src', 'web', 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/api/state') {
      const s = readSettings();
      let sheet = null;
      let sheetError = '';
      try {
        sheet = await sheetInfo(s);
      } catch (e) {
        sheetError = e.message;
      }
      return send(res, 200, {
        settings: s,
        sheet,
        sheetError,
        images: walk(IMG_DIR).length,
        googleKey: fs.existsSync(KEY_FILE) ? JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).client_email || 'uploaded' : '',
        running: !!job?.running,
      });
    }
    if (req.method === 'POST' && p === '/api/settings') {
      const body = await readBody(req);
      writeSettings({ ...readSettings(), ...body });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && p === '/api/upload/sheet') {
      const name = path.basename(safeRel(url.searchParams.get('name')) || 'sheet.xlsx');
      if (!/\.(xlsx|xls|csv)$/i.test(name)) return send(res, 400, { error: 'Only .xlsx, .xls or .csv files are supported' });
      for (const f of fs.readdirSync(SHEET_DIR)) fs.rmSync(path.join(SHEET_DIR, f));
      await pipeline(req, fs.createWriteStream(path.join(SHEET_DIR, name)));
      const s = readSettings();
      s.sheet = { ...s.sheet, mode: 'file', worksheet: '' };
      writeSettings(s);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && p === '/api/upload/image') {
      if (job?.running) return send(res, 409, { error: 'A job is running. Wait for it to finish.' });
      const rel = safeRel(url.searchParams.get('path'));
      if (!rel) return send(res, 400, { error: 'Missing file name' });
      const dest = path.join(IMG_DIR, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(req, fs.createWriteStream(dest));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && p === '/api/images') {
      if (job?.running) return send(res, 409, { error: 'A job is running. Wait for it to finish.' });
      fs.rmSync(IMG_DIR, { recursive: true, force: true });
      fs.mkdirSync(IMG_DIR, { recursive: true });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && p === '/api/upload/google-key') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const txt = Buffer.concat(chunks).toString('utf8');
      let j;
      try {
        j = JSON.parse(txt);
      } catch {
        return send(res, 400, { error: 'This is not a JSON file' });
      }
      if (!j.client_email || !j.private_key) return send(res, 400, { error: 'This does not look like a Google service account key file' });
      fs.writeFileSync(KEY_FILE, txt);
      return send(res, 200, { ok: true, email: j.client_email });
    }
    if (req.method === 'DELETE' && p === '/api/google-key') {
      fs.rmSync(KEY_FILE, { force: true });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/test-shopify') {
      const s = readSettings();
      const shop = new Shopify(s.shopify);
      const info = await shop.init();
      const scopes = await shop.scopes();
      const missingScopes = scopes ? NEEDED_SCOPES.filter((x) => !scopes.includes(x)) : [];
      return send(res, 200, { ok: true, shop: info, note: shop.domainNote || '', missingScopes });
    }
    if (req.method === 'POST' && p === '/api/run') {
      if (job?.running) return send(res, 409, { error: 'Another job is still running' });
      const body = await readBody(req);
      if (!['check', 'plan', 'apply'].includes(body.cmd)) return send(res, 400, { error: 'Unknown command' });
      startJob(body.cmd, body); // settings errors are thrown here and returned as 400 below
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/stop') {
      if (job) job.stop = true;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/job') {
      if (!job) return send(res, 200, { job: null });
      const since = Number(url.searchParams.get('since') || 0);
      const { stop, ...j } = job;
      return send(res, 200, { job: { ...j, stopping: stop, logs: job.logs.slice(since), logCount: job.logs.length } });
    }
    if (req.method === 'GET' && p.startsWith('/img/')) {
      const rel = safeRel(decodeURIComponent(p.slice(5)));
      const f = path.join(IMG_DIR, rel);
      if (!rel || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'max-age=60' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/download') {
      const name = path.basename(url.searchParams.get('file') || '');
      const f = path.join(OUT_DIR, name);
      if (!/\.(csv|txt)$/.test(name) || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'content-type': name.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/template') {
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="Shopify-Product-Template.xlsx"',
      });
      return fs.createReadStream(path.join(ROOT, 'templates', 'Shopify-Product-Template.xlsx')).pipe(res);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  console.log(`\nShopify Bulk Uploader is running: ${link}`);
  console.log('Your browser will open automatically. Keep this window open while you work; close it to stop the app.\n');
  if (!process.env.NO_BROWSER) exec(process.platform === 'win32' ? `start "" "${link}"` : `open "${link}" || xdg-open "${link}"`);
});
// Never let an unexpected error close the app
process.on('uncaughtException', (e) => console.error('Error (app still running):', e.message));
process.on('unhandledRejection', (e) => console.error('Error (app still running):', e?.message || e));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. The app may already be open: http://localhost:${PORT}`);
  else console.error(e);
  process.exitCode = 1;
});
