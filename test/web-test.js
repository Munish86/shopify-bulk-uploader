// Browser app server tests: the same API calls the page makes, against a simulated Shopify store
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-shopify.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploader-web-'));
const mock = await startMock();
const PORT = 38000 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), NO_BROWSER: '1', UPLOADER_DATA_DIR: dataDir, SHOPIFY_ENDPOINT_OVERRIDE: `http://127.0.0.1:${mock.server.address().port}/graphql` },
});
let srvOut = '';
srv.stdout.on('data', (d) => (srvOut += d));
srv.stderr.on('data', (d) => (srvOut += d));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50 && !srvOut.includes('is running'); i++) await new Promise((r) => setTimeout(r, 100));

const j = async (p, opts) => {
  const r = await fetch(base + p, opts);
  const b = await r.json();
  if (!r.ok) throw new Error(`${p}: ${b.error}`);
  return b;
};
const postJson = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log('Browser app tests (simulated Shopify)');
try {
  await t('page loads in English', async () => {
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /Connect to Shopify/);
    assert.match(html, /lang="en"/);
  });
  await t('product template can be downloaded', async () => {
    const r = await fetch(base + '/api/template');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /Shopify-Product-Template\.xlsx/);
    assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  });
  await t('sheet upload shows rows and columns', async () => {
    await j('/api/upload/sheet?name=products.csv', { method: 'PUT', body: fs.readFileSync(path.join(root, 'sample/products-sample.csv')) });
    const st = await j('/api/state');
    assert.equal(st.sheet.rowCount, 4);
    assert.ok(st.sheet.headers.includes('Meta Name'));
  });
  await t('folder upload keeps sub-folders and blocks paths outside the app', async () => {
    for (const f of fs.readdirSync(path.join(root, 'sample/images'))) {
      await j(`/api/upload/image?path=${encodeURIComponent('My Photos/' + f)}`, { method: 'PUT', body: fs.readFileSync(path.join(root, 'sample/images', f)) });
    }
    await j(`/api/upload/image?path=${encodeURIComponent('../../evil.png')}`, { method: 'PUT', body: 'x' });
    assert.ok(!fs.existsSync(path.join(dataDir, '..', 'evil.png')), 'must not write outside the data folder');
    assert.equal((await j('/api/state')).images, 7);
  });

  const st = await j('/api/state');
  const s = st.settings;
  s.shopify.store = 'mock-store';
  s.shopify.access_token = 'test';
  s.match.create_missing = true;
  s.images = { source: 'local', drive_folder: '', mode: 'append' };
  s.columns = {
    product_key: 'AMC Name', image_key: 'Meta Name', image_alt: 'Product Name', title: 'Product Name', description: 'Description',
    vendor: 'Supplier', product_type: 'Category', tags: 'Tags', collections: 'Collections', price: 'Price',
    compare_at_price: 'Compare Price', sku: 'SKU', barcode: '', handle: '', status: '', options: ['Colour', 'Size'],
  };
  s.metafields = [{ column: 'Material', namespace: 'custom', key: 'material', type: 'single_line_text_field' }, { column: '', namespace: 'custom', key: '', type: 'boolean' }];
  await postJson('/api/settings', s);

  await t('header row detected as row 1', async () => {
    assert.equal((await j('/api/state')).sheet.headerRow, 1);
  });
  await t('test connection reports the store and missing permissions', async () => {
    const r = await j('/api/test-shopify', { method: 'POST' });
    assert.equal(r.shop.name, 'Mock Store');
    assert.deepEqual(r.missingScopes, ['write_files']);
  });

  const runAndWait = async (cmd) => {
    await postJson('/api/run', { cmd });
    for (;;) {
      const { job } = await j('/api/job');
      if (!job.running) return job;
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  await t('image check: thumbnails, unmatched images, report and log downloads', async () => {
    const job = await runAndWait('check');
    assert.equal(job.error, null, job.error);
    assert.equal(job.result.details['AMC-SOFA-001'].length, 3);
    assert.equal(job.result.unmatched.length, 2); // old-banner.png + evil.png
    const img = await fetch(base + '/img/' + job.result.details['AMC-SOFA-001'][0].rel.split('/').map(encodeURIComponent).join('/'));
    assert.equal(img.status, 200);
    assert.equal((await fetch(base + '/api/download?file=' + encodeURIComponent(job.result.reportFile))).status, 200);
    assert.equal((await fetch(base + '/api/download?file=' + encodeURIComponent(job.result.logFile))).status, 200);
  });
  await t('preview', async () => {
    const job = await runAndWait('plan');
    assert.equal(job.error, null, job.error);
    const acts = Object.fromEntries(job.result.report.map((r) => [r.product_key, r.action]));
    assert.deepEqual(acts, { 'AMC-SOFA-001': 'Will update', 'AMC-BED-014': 'Will update', 'AMC-TBL-007': 'Will create' });
    assert.equal(job.progress.done, 3);
  });
  await t('upload', async () => {
    const job = await runAndWait('apply');
    assert.equal(job.error, null, job.error);
    assert.ok(job.result.report.every((r) => /Updated|Created/.test(r.action)), JSON.stringify(job.result.report.map((r) => r.action + ' ' + r.error)));
    assert.equal(mock.uploads.length, 4);
  });
  await t('no way to find products returns a clear message', async () => {
    const bad = await j('/api/state');
    bad.settings.match.rules = [];
    for (const k of ['sku', 'handle', 'title']) bad.settings.columns[k] = '';
    await postJson('/api/settings', bad.settings);
    const r = await fetch(base + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'check' }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /find products/);
  });

  // The real-world case: notes above the headers, only title + meta columns, no AMC Name, no images,
  // Drive chosen but no folder link, products found by title (with different capitalisation).
  await t('title + meta only sheet: no AMC Name, no images, found by title', async () => {
    const csv = [
      'BATCH 3 - live products whose description exists but is missing sections. Budget 20-30 minutes each.,,',
      'Product Title,Meta Title,Meta Description',
      'OSLO 3 SEATER SOFA,Oslo 3 Seater Sofa | AMC Furniture,Buy the Oslo 3 seater sofa at AMC Furniture.',
      'Aria King Size Bed,,Only the meta description changes here.',
      'A Product That Does Not Exist,Some title,',
    ].join('\n');
    await j('/api/upload/sheet?name=batch3.csv', { method: 'PUT', body: csv });
    const st = await j('/api/state');
    assert.equal(st.sheet.headerRow, 2);
    assert.deepEqual(st.sheet.headers, ['Product Title', 'Meta Title', 'Meta Description']);
    const s = st.settings;
    s.columns = { options: [], title: 'Product Title', seo_title: 'Meta Title', seo_description: 'Meta Description', image_key: 'Meta Name' }; // stale image_key on purpose
    s.match = { ...s.match, find_by: 'title', rules: [{ field: 'title', column: 'Product Title' }], create_missing: false };
    s.images = { source: 'drive', drive_folder: '', mode: 'skip_if_has_images' };
    s.metafields = [];
    s.columns.image_key = '';
    await postJson('/api/settings', s);
    const before = mock.calls.length;
    const job = await runAndWait('apply');
    assert.equal(job.error, null, job.error);
    const byKey = Object.fromEntries(job.result.report.map((r) => [r.product_key, r]));
    assert.equal(byKey['OSLO 3 SEATER SOFA'].action, 'Updated');
    assert.equal(byKey['OSLO 3 SEATER SOFA'].found_by, 'Found by TITLE');
    assert.equal(byKey['Aria King Size Bed'].action, 'Updated');
    assert.equal(byKey['A Product That Does Not Exist'].action, 'Not found in Shopify');
    const sets = mock.calls.slice(before).filter((c) => /productSet/.test(c.query)).map((c) => c.variables.input);
    const oslo = sets.find((x) => x.id === 'gid://shopify/Product/1');
    assert.deepEqual(Object.keys(oslo).sort(), ['id', 'seo']);
    assert.equal(oslo.seo.title, 'Oslo 3 Seater Sofa | AMC Furniture');
    const aria = sets.find((x) => x.id === 'gid://shopify/Product/2');
    assert.deepEqual(aria.seo, { description: 'Only the meta description changes here.' });
    assert.ok(job.logs.some((l) => /no folder link was given, so images are skipped/.test(l)));
  });

  await t('falls back to the next rule when the first column is empty, and can rename by SKU', async () => {
    const csv = ['SKU,Product Title,New Title', ',Nordic Coffee Table,', 'ARIA-KB,,Aria Bed (Renamed)'].join('\n');
    await j('/api/upload/sheet?name=rename.csv', { method: 'PUT', body: csv });
    const st = await j('/api/state');
    const s = st.settings;
    s.columns = { options: [], title: 'New Title' };
    s.match = { ...s.match, rules: [{ field: 'sku', column: 'SKU' }, { field: 'title', column: 'Product Title' }] };
    s.images = { source: 'none', mode: 'append' };
    await postJson('/api/settings', s);
    const before = mock.calls.length;
    const job = await runAndWait('plan');
    assert.equal(job.error, null, job.error);
    const r = Object.fromEntries(job.result.report.map((x) => [x.product_key, x]));
    assert.equal(r['Nordic Coffee Table'].found_by, 'Found by TITLE');
    assert.equal(r['ARIA-KB'].found_by, 'Found by SKU');
    assert.equal(r['ARIA-KB'].changes, 'title');
    assert.ok(!mock.calls.slice(before).some((c) => /mutation/.test(c.query)), 'preview must not save');
  });
  console.log(`\nBrowser app: all ${passed} tests passed.`);
} catch (e) {
  console.error('FAIL:', e.message, '\n--- server log ---\n', srvOut);
  process.exitCode = 1;
} finally {
  srv.kill();
  mock.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
