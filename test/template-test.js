// Checks that templates/Shopify-Product-Template.xlsx works end to end in the browser app:
// the page's own auto-fill maps every column, and check / preview / upload succeed against a simulated Shopify.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { startMock } from './mock-shopify.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tpl = path.join(root, 'templates', 'Shopify-Product-Template.xlsx');
let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log('Template tests');
const wb = XLSX.readFile(tpl);
await t('tabs: Products first, then Example, Guide, Image Naming, Metafields', () =>
  assert.deepEqual(wb.SheetNames, ['Products', 'Example', 'Guide', 'Image Naming', 'Metafields']));
const prodHeaders = XLSX.utils.sheet_to_json(wb.Sheets.Products, { header: 1 })[0];
const exRows = XLSX.utils.sheet_to_json(wb.Sheets.Example, { header: 1, defval: '', blankrows: false });
await t('Products tab has headers only, Example has the same headers and 4 rows', () => {
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets.Products, { header: 1, blankrows: false }).length, 1);
  assert.deepEqual(exRows[0], prodHeaders);
  assert.equal(exRows.length, 5);
});

// Run the page's own auto-fill code on the template headers
const html = fs.readFileSync(path.join(root, 'src', 'web', 'index.html'), 'utf8');
const FIELDS = new Function(`${html.match(/const FIELDS = \[[\s\S]*?\n\];/)[0]}; return FIELDS;`)();
const guessBody = html.match(/\$\('#btnGuess'\)\.onclick = \(\) => \{([\s\S]*?)\n\};/)[1].replace('save(); renderColumns();', '');
const ruleHelpers = [/const RULE_FIELDS = .*\n/, /const RULE_GUESS = .*\n/, /function defaultRules\(\) \{[\s\S]*?\n\}\n/].map((re) => html.match(re)[0]).join('');
const S = { columns: { options: [] }, metafields: [], match: { rules: [] } };
new Function('S', 'headers', 'FIELDS', `${ruleHelpers}\n${guessBody}`)(S, prodHeaders, FIELDS);
await t('auto-fill sets up finding products by SKU, then Handle, then Title', () =>
  assert.deepEqual(S.match.rules, [
    { field: 'sku', column: 'SKU' },
    { field: 'barcode', column: 'Barcode' },
    { field: 'handle', column: 'Handle' },
    { field: 'title', column: 'Product Title' },
  ]));
await t('auto-fill maps every template column', () => {
  const mapped = new Set([...Object.values(S.columns).flat().filter((v) => typeof v === 'string' && v), ...S.metafields.map((m) => m.column)]);
  const unmapped = prodHeaders.filter((h) => !mapped.has(h));
  assert.deepEqual(unmapped, []);
  assert.equal(S.columns.seo_title, 'Meta Title');
  assert.equal(S.columns.seo_description, 'Meta Description');
  assert.equal(S.columns.image_key, 'Meta Name');
  assert.equal(S.columns.title, 'Product Title');
  assert.equal(S.columns.description, 'Description');
  assert.equal(S.columns.image_alt, 'Image Alt Text');
  assert.deepEqual(S.columns.options, ['Colour', 'Size']);
  const types = Object.fromEntries(S.metafields.map((m) => [`${m.namespace}.${m.key}`, m.type]));
  assert.deepEqual(types, {
    'custom.material': 'single_line_text_field',
    'custom.dimensions': 'single_line_text_field',
    'custom.warranty_years': 'number_integer',
    'custom.assembly_required': 'boolean',
    'custom.care_instructions': 'single_line_text_field',
    'custom.delivery_time': 'single_line_text_field',
  });
});

// Full run through the browser app's server
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploader-tpl-'));
const mock = await startMock();
const PORT = 39000 + Math.floor(Math.random() * 500);
const srv = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), NO_BROWSER: '1', UPLOADER_DATA_DIR: dataDir, SHOPIFY_ENDPOINT_OVERRIDE: `http://127.0.0.1:${mock.server.address().port}/graphql` },
});
let srvOut = '';
srv.stdout.on('data', (d) => (srvOut += d));
srv.stderr.on('data', (d) => (srvOut += d));
for (let i = 0; i < 50 && !srvOut.includes('is running'); i++) await new Promise((r) => setTimeout(r, 100));
const base = `http://127.0.0.1:${PORT}`;
const j = async (p, opts) => {
  const r = await fetch(base + p, opts);
  const b = await r.json();
  if (!r.ok) throw new Error(`${p}: ${b.error}`);
  return b;
};
const postJson = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const runAndWait = async (cmd) => {
  await postJson('/api/run', { cmd });
  for (;;) {
    const { job } = await j('/api/job');
    if (!job.running) return job;
    await new Promise((r) => setTimeout(r, 150));
  }
};

try {
  await j('/api/upload/sheet?name=Shopify-Product-Template.xlsx', { method: 'PUT', body: fs.readFileSync(tpl) });
  const png = fs.readFileSync(path.join(root, 'sample', 'images', 'Aria King Bed.png'));
  for (const name of ['Oslo 3 Seater Sofa.jpg', 'oslo-3-seater-sofa_2.jpg', 'Aria King Bed (1).png', 'Nordic Coffee Table.webp']) {
    await j(`/api/upload/image?path=${encodeURIComponent(name)}`, { method: 'PUT', body: png });
  }
  const st = await j('/api/state');
  await t('app lists all 5 tabs and reads the Example tab', async () => {
    assert.deepEqual(st.sheet.worksheets, ['Products', 'Example', 'Guide', 'Image Naming', 'Metafields']);
    const s = st.settings;
    s.sheet.worksheet = 'Example';
    Object.assign(s.columns, S.columns);
    s.metafields = S.metafields;
    s.shopify = { ...s.shopify, store: 'mock-store', access_token: 'test' };
    s.match.create_missing = true;
    s.match.rules = S.match.rules;
    s.images = { source: 'local', drive_folder: '', mode: 'append' };
    await postJson('/api/settings', s);
    const st2 = await j('/api/state');
    assert.equal(st2.sheet.rowCount, 4);
    assert.equal(st2.sheet.headerRow, 1);
  });
  await t('check: every example product finds its images', async () => {
    const job = await runAndWait('check');
    assert.equal(job.error, null, job.error);
    assert.deepEqual(job.result.report.map((r) => [r.product_key, r.images_found]), [['AMC-SOFA-001', 2], ['AMC-BED-014', 1], ['AMC-TBL-007', 1]]);
  });
  await t('preview: no errors', async () => {
    const job = await runAndWait('plan');
    assert.equal(job.error, null, job.error);
    assert.ok(job.result.report.every((r) => r.action !== 'Error'), JSON.stringify(job.result.report));
  });
  await t('upload: SEO, metafields, variants, status and images all sent', async () => {
    const job = await runAndWait('apply');
    assert.equal(job.error, null, job.error);
    assert.ok(job.result.report.every((r) => /Updated|Created/.test(r.action)), JSON.stringify(job.result.report.map((r) => `${r.action} ${r.error}`)));
    const sets = mock.calls.filter((c) => /productSet/.test(c.query)).map((c) => c.variables.input);
    const oslo = sets.find((s) => s.id === 'gid://shopify/Product/1');
    assert.equal(oslo.seo.title, 'Oslo 3 Seater Fabric Sofa | Solid Oak Frame | AMC Furniture');
    assert.match(oslo.seo.description, /^Shop the Oslo 3 seater/);
    assert.match(oslo.descriptionHtml, /^<p>A deep, comfortable/);
    assert.equal(oslo.variants.length, 2);
    const nordic = sets.find((s) => s.title === 'Nordic Oak Coffee Table');
    assert.equal(nordic.handle, 'nordic-oak-coffee-table');
    assert.equal(nordic.status, 'DRAFT');
    assert.equal(Number(nordic.variants[0].price), 199);
    assert.equal(Number(nordic.variants[0].compareAtPrice), 249);
    const mfs = mock.calls.filter((c) => /metafieldsSet/.test(c.query)).flatMap((c) => c.variables.m);
    const aria = mfs.filter((m) => m.ownerId === 'gid://shopify/Product/2');
    assert.deepEqual(Object.fromEntries(aria.map((m) => [m.key, m.value])), {
      material: 'Velvet, engineered wood',
      dimensions: 'W 166 x L 212 x H 120 cm',
      warranty_years: '3',
      assembly_required: 'true',
      care_instructions: 'Brush velvet gently in one direction.',
      delivery_time: '7-10 working days',
    });
    const media = mock.calls.filter((c) => /productUpdate/.test(c.query)).flatMap((c) => c.variables.media);
    assert.ok(media.some((m) => m.alt === 'Oslo 3 seater fabric sofa in grey with oak legs'));
  });
  console.log(`\nTemplate: all ${passed} tests passed.`);
} catch (e) {
  console.error('FAIL:', e.message, '\n--- server log ---\n', srvOut);
  process.exitCode = 1;
} finally {
  srv.kill();
  mock.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
