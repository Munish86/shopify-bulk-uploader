import fs from 'node:fs';
import path from 'node:path';
import { driveFolderId } from './google.js';
import { norm } from './util.js';

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heic: 'image/heic',
};

function describe(name, extra) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const stem = path.basename(name, path.extname(name));
  return { name, stem, ext, mime: MIME[ext] || 'application/octet-stream', ...extra };
}

function walkLocal(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkLocal(full, out);
    else out.push(describe(e.name, { source: 'local', ref: full, uid: `local:${full}`, size: fs.statSync(full).size, where: full }));
  }
  return out;
}

async function walkDrive(google, folderId, where, out = []) {
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,shortcutDetails)');
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const body = await google.get(url);
    for (const f of body.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        await walkDrive(google, f.id, `${where}/${f.name}`, out);
      } else {
        out.push(describe(f.name, { source: 'drive', ref: f.id, uid: `drive:${f.id}`, size: Number(f.size || 0), where: `${where}/${f.name}` }));
      }
    }
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function listImages(cfg, google) {
  const exts = new Set(cfg.images.extensions.map((e) => String(e).toLowerCase().replace(/^\./, '')));
  let files = [];
  if (cfg.images.source === 'local') {
    if (!fs.existsSync(cfg.images.local_folder)) throw new Error(`Images folder not found: ${cfg.images.local_folder}`);
    files = walkLocal(cfg.images.local_folder);
  } else if (cfg.images.source === 'drive') {
    if (!google.enabled) throw new Error('To read images from Google Drive, add a Google service account key or API key.');
    files = await walkDrive(google, driveFolderId(cfg.images.drive_folder), 'Drive');
  }
  return files.filter((f) => exts.has(f.ext));
}

// Builds a lookup from file names.
//  "Meta Name.jpg"      -> exact "meta name"
//  "Meta Name_1.jpg", "Meta Name-2.png", "Meta Name (3).jpg" -> image number 1, 2, 3 of "meta name"
export function buildIndex(files) {
  const exact = new Map();
  const numbered = new Map();
  const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
  for (const f of files) {
    const n = norm(f.stem);
    if (!n) continue;
    push(exact, n, { f, num: 0 });
    const m = n.match(/^(.*\S)\s(\d{1,3})$/);
    if (m) push(numbered, m[1], { f, num: Number(m[2]) });
  }
  return { exact, numbered };
}

export function findImages(index, key) {
  const n = norm(key);
  if (!n) return [];
  const hits = [...(index.exact.get(n) || []), ...(index.numbered.get(n) || [])];
  const seen = new Set();
  return hits
    .sort((a, b) => a.num - b.num || a.f.name.localeCompare(b.f.name, undefined, { numeric: true }))
    .filter(({ f }) => (seen.has(f.uid) ? false : seen.add(f.uid)))
    .map(({ f }) => f);
}

export async function readImage(file, google) {
  if (file.source === 'local') return fs.readFileSync(file.ref);
  return google.get(`https://www.googleapis.com/drive/v3/files/${file.ref}?alt=media&supportsAllDrives=true`, { asBuffer: true });
}

// Is an image with this file name already on the product?
// Shopify sometimes appends "_<uuid>" to the file name, which is recognised too.
export function alreadyOnProduct(file, existingUrls) {
  const want = norm(file.stem);
  return existingUrls.some((u) => {
    const base = decodeURIComponent(String(u).split('?')[0].split('/').pop() || '');
    const have = norm(base.replace(/\.[a-z0-9]+$/i, ''));
    if (have === want) return true;
    if (!have.startsWith(want + ' ')) return false;
    return /^[0-9a-f]{8}\b/.test(have.slice(want.length + 1));
  });
}
