// The real work happens here. Both the command line (index.js) and the browser app (server.js) call runJob.
//   check -> match sheet rows to image files only (does not touch Shopify)
//   plan  -> compare with Shopify and report what would change (saves nothing)
//   apply -> save the changes to Shopify
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { groupRows, buildProduct, lookupValues, firstVal } from './build.js';
import { mappedColumns } from './config.js';
import { Google } from './google.js';
import { buildIndex, findImages, listImages, readImage, alreadyOnProduct } from './images.js';
import { loadRows } from './sheet.js';
import { Shopify } from './shopify.js';
import { toCsv, timestamp, norm, pool, formatDuration } from './util.js';

export const ACTIONS = {
  IMAGES_FOUND: 'Images found',
  NO_IMAGES: 'No images found',
  OK: 'OK',
  NOT_FOUND: 'Not found in Shopify',
  DONE_BEFORE: 'Already done',
  NO_CHANGE: 'No changes',
  WILL_UPDATE: 'Will update',
  WILL_CREATE: 'Will create',
  UPDATED: 'Updated',
  CREATED: 'Created',
  ERROR: 'Error',
};

export const REPORT_HEADERS = [
  'sheet_rows', 'product_key', 'title', 'action', 'found_by', 'shopify_link', 'images_found', 'images_new', 'image_files',
  'changes', 'tags_added', 'collections', 'metafields', 'variants', 'warnings', 'error',
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * opts: { log(msg), progress({done, total, elapsedMs, etaMs}), only, limit, force,
 *         confirm(count) => Promise<boolean>, shouldStop() => boolean }
 * returns { report, reportFile, logFile, counts, unmatched, details, stopped, cancelled, store }
 */
export async function runJob(cfg, cmd, opts = {}) {
  const outDir = cfg.output.folder;
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = timestamp();
  const logFile = path.join(outDir, `log-${cmd}-${stamp}.txt`);
  const logOut = opts.log || console.log;
  const log = (m) => {
    logOut(m);
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)}  ${m}\n`);
    } catch {
      /* logging must never stop the run */
    }
  };
  const shouldStop = opts.shouldStop || (() => false);
  if (!['check', 'plan', 'apply'].includes(cmd)) throw new Error(`Unknown command "${cmd}". Use check, plan or apply.`);
  const google = new Google(cfg.google);

  log(`=== ${cmd.toUpperCase()} started ===`);
  if (cmd !== 'apply') log('(This step does not save anything to Shopify)');

  // 1. Sheet
  const { headers, rows, headerRow, duplicateHeaders } = await loadRows(cfg, google);
  log(`Sheet: ${rows.length} rows read (column names taken from row ${headerRow})`);
  if (duplicateHeaders.length) log(`Note: these column names appear twice, the first one is used: ${duplicateHeaders.join(', ')}`);
  const missing = mappedColumns(cfg).filter((c) => !headers.includes(c));
  if (missing.length) {
    throw new Error(`These columns were not found in the sheet: ${missing.join(', ')}\nSheet columns: ${headers.filter(Boolean).join(', ')}`);
  }

  let { groups, skipped } = groupRows(rows, cfg);
  const findWith = cfg.match.rules.map((r) => `${r.field.toUpperCase()} from "${r.column}"`).join(', then ');
  log(`Finding products by ${findWith}`);
  if (skipped.length) {
    const cols = [cfg.columns.product_key, ...cfg.match.rules.map((r) => r.column)].filter(Boolean);
    log(`${skipped.length} rows were skipped because ${cols.map((c) => `"${c}"`).join(' and ')} ${cols.length > 1 ? 'are all' : 'is'} empty (rows ${skipped.slice(0, 15).join(', ')}${skipped.length > 15 ? '...' : ''})`);
  }
  if (opts.only) groups = groups.filter((g) => String(opts.only).split(',').some((o) => norm(o) === norm(g.key)));
  if (opts.limit) groups = groups.slice(0, Number(opts.limit));
  log(`Products: ${groups.length}`);

  // 2. Images
  let files = [];
  if (cfg.images.skippedReason) log(cfg.images.skippedReason);
  else if (cfg.images.source === 'none') log('Images: none added, so product images are not changed');
  if (cfg.images.source !== 'none') {
    files = await listImages(cfg, google);
    log(`Images: ${files.length} files found (${cfg.images.source === 'drive' ? 'Google Drive' : 'uploaded folder'})`);
  }
  const index = buildIndex(files);
  const imageCol = cfg.columns.image_key || cfg.columns.product_key;
  const usedBy = new Map();
  for (const g of groups) {
    const seen = new Set();
    g.images = [];
    for (const r of g.rows) {
      for (const f of findImages(index, r[imageCol])) {
        if (seen.has(f.uid)) continue;
        seen.add(f.uid);
        g.images.push(f);
        (usedBy.get(f.uid) || usedBy.set(f.uid, []).get(f.uid)).push(g.key);
      }
    }
  }
  const relOf = (f) => (f.source === 'local' ? path.relative(cfg.images.local_folder, f.ref).split(path.sep).join('/') : null);
  const unmatched = files.filter((f) => !usedBy.has(f.uid)).map((f) => ({ name: f.name, where: f.where, rel: relOf(f) }));
  const shared = [...usedBy.entries()].filter(([, keys]) => keys.length > 1);
  if (cfg.images.source !== 'none') {
    const noImg = groups.filter((g) => !g.images.length).length;
    log(`${groups.length - noImg} products have images, ${noImg} have none, ${unmatched.length} image files match no product`);
    if (shared.length) log(`Note: ${shared.length} image files match more than one product`);
    fs.writeFileSync(
      path.join(outDir, `unmatched-images-${stamp}.csv`),
      toCsv(unmatched.map((f) => ({ file: f.name, location: f.where })), ['file', 'location'])
    );
  }
  const details = {};
  for (const g of groups) details[g.key] = g.images.map((f) => ({ name: f.name, rel: relOf(f) }));

  const results = new Array(groups.length);
  const base = (g) => ({
    sheet_rows: g.rows.map((r) => r.__row).join(' '),
    product_key: g.key,
    title: firstVal(g.rows, cfg.columns.title),
    images_found: g.images.length,
    image_files: g.images.map((f) => f.name).join(' | '),
  });
  const finish = (extra = {}) => {
    const report = results.filter(Boolean);
    const reportFile = path.join(outDir, `report-${cmd}-${stamp}.csv`);
    fs.writeFileSync(reportFile, toCsv(report, REPORT_HEADERS));
    const counts = {};
    for (const r of report) counts[r.action] = (counts[r.action] || 0) + 1;
    log('--- Summary ---');
    for (const [k, v] of Object.entries(counts)) log(`  ${k}: ${v}`);
    log(`Full report: ${reportFile}`);
    return { report, reportFile, logFile, counts, unmatched, details, ...extra };
  };

  if (cmd === 'check') {
    groups.forEach((g, i) => {
      const sh = g.images.filter((f) => usedBy.get(f.uid).length > 1).map((f) => f.name);
      results[i] = {
        ...base(g),
        action: cfg.images.source === 'none' ? ACTIONS.OK : g.images.length ? ACTIONS.IMAGES_FOUND : ACTIONS.NO_IMAGES,
        warnings: sh.length ? `These images also match other products: ${sh.join(', ')}` : '',
      };
    });
    return finish();
  }

  // 3. Shopify
  const shop = new Shopify(cfg.shopify);
  const info = await shop.init();
  if (shop.domainNote) log(shop.domainNote);
  log(`Shopify store: ${info.name} (${info.myshopifyDomain})`);
  const collections = cfg.columns.collections ? await shop.loadCollections() : new Map();
  const creatingCollections = new Map(); // title -> promise, so parallel workers create a collection once
  const locks = new Map(); // product id -> promise, so one product is never changed by two workers at once

  const stateFile = path.join(outDir, 'state.json');
  const state = readJson(stateFile, { done: {}, uploaded: {} });
  const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const backupDir = path.join(outDir, 'backups', stamp);

  if (cmd === 'apply' && opts.confirm && !(await opts.confirm(groups.length))) {
    log('Cancelled. Nothing was saved.');
    return { report: [], counts: {}, unmatched, details, cancelled: true };
  }

  const total = groups.length;
  const started = Date.now();
  let done = 0;
  const tick = () => {
    done++;
    const elapsedMs = Date.now() - started;
    opts.progress?.({ done, total, elapsedMs, etaMs: done ? (elapsedMs / done) * (total - done) : 0 });
  };
  opts.progress?.({ done: 0, total, elapsedMs: 0, etaMs: 0 });
  const workers = cfg.options.concurrency;
  if (workers > 1) log(`Working on ${workers} products at a time`);

  const getCollection = async (title) => {
    const key = norm(title);
    if (collections.get(key)) return collections.get(key);
    if (!creatingCollections.has(key)) {
      creatingCollections.set(key, shop.createCollection(title).then((col) => (collections.set(key, col), col)));
    }
    return creatingCollections.get(key);
  };

  async function processOne(g, i) {
    const row = base(g);
    const tag = `[${i + 1}/${total}] ${g.key}`;
    const fp = crypto
      .createHash('sha1')
      .update(JSON.stringify({ rows: g.rows.map(({ __row, ...r }) => r), img: g.images.map((f) => f.uid + ':' + f.size), mode: cfg.images.mode }))
      .digest('hex');
    let release = () => {};
    try {
      // Try each "find product" rule in order; the first one that finds a product wins
      let existing = null;
      let foundBy = '';
      const tried = [];
      for (const rule of cfg.match.rules) {
        const values = lookupValues(g, rule);
        if (!values.length) continue;
        tried.push(`${rule.field.toUpperCase()} "${values.join('", "')}"`);
        const found = await shop.findProduct(rule.field, values);
        if (found.ambiguous) throw new Error(`Could not pick one product: ${found.ambiguous}`);
        if (found.product) {
          existing = found.product;
          existing.foundBy = rule;
          foundBy = `Found by ${rule.field.toUpperCase()}`;
          break;
        }
      }
      row.shopify_link = existing ? shop.adminUrl(existing.id) : '';

      if (!existing && !cfg.match.create_missing) {
        results[i] = {
          ...row,
          action: ACTIONS.NOT_FOUND,
          warnings: tried.length ? `Searched by ${tried.join(', then ')}` : 'No value to search with: the "find product" columns are empty on this row',
        };
        log(`${tag}: not found in Shopify`);
        return;
      }

      // Two sheet groups can point at the same product: handle them one after the other
      if (existing) {
        const prev = locks.get(existing.id);
        let open;
        const mine = new Promise((r) => (open = r));
        locks.set(existing.id, (prev || Promise.resolve()).then(() => mine));
        release = open;
        if (prev) {
          await prev;
          const rule = existing.foundBy;
          existing = await shop.getProduct(existing.id);
          existing.foundBy = rule;
        }
      }
      if (cmd === 'apply' && !opts.force && state.done[g.key.toLowerCase()] === fp) {
        results[i] = { ...row, action: ACTIONS.DONE_BEFORE, warnings: 'The sheet row has not changed since the last upload' };
        return;
      }

      const plan = buildProduct(g, existing, cfg);

      // Images: which ones to upload
      const media = (existing?.media || []).filter((m) => m.mediaContentType === 'IMAGE');
      const urls = media.map((m) => m.image?.url).filter(Boolean);
      const uploadedBefore = new Set(existing ? state.uploaded[existing.id] || [] : []);
      let upload = [];
      if (g.images.length) {
        if (cfg.images.mode === 'skip_if_has_images' && media.length) plan.warnings.push(`Product already has ${media.length} images, images skipped`);
        else if (cfg.images.mode === 'replace') upload = g.images;
        else upload = g.images.filter((f) => !uploadedBefore.has(f.uid) && !alreadyOnProduct(f, urls));
      }
      const tooBig = upload.filter((f) => f.size > 20 * 1024 * 1024);
      if (tooBig.length) {
        plan.warnings.push(`Images over 20 MB skipped: ${tooBig.map((f) => f.name).join(', ')}`);
        upload = upload.filter((f) => !tooBig.includes(f));
      }
      if (cfg.images.mode === 'replace' && upload.length && media.length) plan.changes.push(`${media.length} old images removed`);

      // Collections
      const colAdd = [];
      for (const t of plan.collectionTitles) {
        const col = collections.get(norm(t));
        if (col?.smart) plan.warnings.push(`"${t}" is an automated (smart) collection; products join it through its rules`);
        else if (col && existing?.collections.some((x) => x.id === col.id)) continue;
        else if (col) colAdd.push({ title: t, col });
        else if (cfg.options.create_missing_collections) colAdd.push({ title: t, col: null });
        else plan.warnings.push(`Collection "${t}" does not exist in Shopify`);
      }

      const nothing = !plan.changes.length && !upload.length && !plan.metafields.length && !colAdd.length && existing;
      const action = !existing ? ACTIONS.WILL_CREATE : nothing ? ACTIONS.NO_CHANGE : ACTIONS.WILL_UPDATE;
      Object.assign(row, {
        action,
        images_new: upload.length,
        changes: plan.changes.join(', '),
        tags_added: plan.tagsAdded.join(', '),
        collections: colAdd.map((c) => (c.col ? c.title : `${c.title} (new)`)).join(', '),
        metafields: plan.metafields.map((m) => `${m.namespace}.${m.key}`).join(', '),
        variants: plan.variantSummary,
        warnings: plan.warnings.join(' ; '),
        found_by: foundBy,
      });

      if (cmd === 'plan' || nothing) {
        if (cmd === 'apply') state.done[g.key.toLowerCase()] = fp;
        results[i] = row;
        log(`${tag}: ${action}${upload.length ? `, ${upload.length} images` : ''}`);
        return;
      }

      // ---- APPLY ----
      if (existing) {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(path.join(backupDir, `${existing.handle}.json`), JSON.stringify(existing, null, 2));
      }
      const alt = firstVal(g.rows, cfg.columns.image_alt) || plan.input.title || existing?.title || g.key;
      const staged = [];
      for (const f of upload) {
        const buf = await readImage(f, google);
        staged.push({ f, url: await shop.stageImage(buf, f.name, f.mime) });
      }

      const input = { ...plan.input };
      const appendLater = existing && cfg.images.mode !== 'replace';
      if (staged.length && !appendLater) {
        input.files = staged.map(({ f, url }) => ({ originalSource: url, alt, contentType: 'IMAGE', filename: f.name }));
      }
      let productId = existing?.id;
      if (!existing || Object.keys(input).some((k) => k !== 'id')) {
        const saved = await shop.productSet(input);
        productId = saved.id;
      }
      if (staged.length && appendLater) {
        await shop.appendMedia(productId, staged.map(({ url }) => ({ originalSource: url, alt, mediaContentType: 'IMAGE' })));
      }
      if (staged.length) state.uploaded[productId] = [...new Set([...(state.uploaded[productId] || []), ...staged.map((s) => s.f.uid)])];
      if (plan.metafields.length) await shop.metafieldsSet(productId, plan.metafields);
      for (const c of colAdd) {
        const col = c.col || (await getCollection(c.title));
        await shop.addToCollection(col.id, productId);
      }
      state.done[g.key.toLowerCase()] = fp;
      saveState();
      row.shopify_link = shop.adminUrl(productId);
      row.action = existing ? ACTIONS.UPDATED : ACTIONS.CREATED;
      results[i] = row;
      log(`${tag}: ${row.action}${staged.length ? `, ${staged.length} images` : ''}`);
    } catch (e) {
      results[i] = { ...row, action: ACTIONS.ERROR, error: e.message };
      log(`${tag}: ERROR - ${e.message}`);
    } finally {
      release();
    }
  }

  await pool(groups, workers, async (g, i) => {
    await processOne(g, i);
    tick();
  }, shouldStop);

  const stopped = shouldStop() && done < total;
  if (stopped) log(`Stopped. ${total - done} products were not processed.`);
  log(`Time taken: ${formatDuration(Date.now() - started)}`);
  saveState();
  return finish({ stopped, store: info.myshopifyDomain });
}
