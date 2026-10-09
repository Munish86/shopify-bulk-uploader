// Tests: image matching unit tests + the full check/plan/apply flow against a simulated Shopify store
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, findImages, alreadyOnProduct } from '../src/images.js';
import { formatMetafield, buildProduct } from '../src/build.js';
import { parseMoney, toHtml, pool } from '../src/util.js';
import { startMock } from './mock-shopify.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log('Unit tests');
const f = (name) => ({ name, stem: name.replace(/\.[^.]+$/, ''), uid: name });
const idx = buildIndex(['Oslo Sofa.jpg', 'Oslo Sofa_2.jpg', 'oslo-sofa (1).png', 'Oslo Sofa_10.jpg', 'Oslo Sofa Bed.jpg', 'AMC-1234.jpg'].map(f));
await t('numbered images come back in order', () =>
  assert.deepEqual(findImages(idx, 'OSLO SOFA').map((x) => x.name), ['Oslo Sofa.jpg', 'oslo-sofa (1).png', 'Oslo Sofa_2.jpg', 'Oslo Sofa_10.jpg']));
await t('a similarly named product does not match', () => assert.ok(!findImages(idx, 'Oslo Sofa').some((x) => x.name === 'Oslo Sofa Bed.jpg')));
await t('a 4-digit number in a name is not treated as an image number', () => assert.deepEqual(findImages(idx, 'AMC').length, 0));
await t('recognises an image already on the product', () => {
  assert.ok(alreadyOnProduct(f('Oslo Sofa_2.jpg'), ['https://cdn/files/Oslo_Sofa_2_3f2a9c1e-aaaa-bbbb.jpg?v=1']));
  assert.ok(!alreadyOnProduct(f('Oslo Sofa_1.jpg'), ['https://cdn/files/Oslo_Sofa_10.jpg?v=1']));
});
await t('prices are cleaned', () => {
  assert.equal(parseMoney('£1,299'), '1299');
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('abc'), undefined);
});
await t('metafield formats', () => {
  assert.equal(formatMetafield('list.single_line_text_field', 'a, b'), '["a","b"]');
  assert.equal(formatMetafield('boolean', 'Yes'), 'true');
  assert.equal(formatMetafield('list.number_integer', '1,2'), '[1,2]');
  assert.throws(() => formatMetafield('number_integer', '3.5'));
});
await t('meta title and description are sent, unchanged ones are not', () => {
  const cfg = { columns: { product_key: 'K', seo_title: 'MT', seo_description: 'MD', options: [] }, options: { tags_mode: 'append' }, match: { rules: [] }, metafields: [] };
  const g = { key: 'A', rows: [{ __row: 2, K: 'A', MT: 'Oslo Sofa | AMC Furniture', MD: 'x'.repeat(170) }] };
  const existing = { id: 'P1', title: 'Oslo', tags: [], variants: [], options: [], seo: { title: 'Old title', description: 'x'.repeat(170) } };
  const out = buildProduct(g, existing, cfg);
  assert.deepEqual(out.input.seo, { title: 'Oslo Sofa | AMC Furniture', description: 'x'.repeat(170) });
  assert.ok(out.warnings.some((w) => /Meta description is 170/.test(w)));
  const same = buildProduct(g, { ...existing, seo: { title: 'Oslo Sofa | AMC Furniture', description: 'x'.repeat(170) } }, cfg);
  assert.equal(same.input.seo, undefined);
});
await t('description becomes HTML', () => assert.equal(toHtml('a\nb\n\nc'), '<p>a<br>b</p>\n<p>c</p>'));
await t('worker pool respects the limit and visits every item once', async () => {
  let running = 0;
  let peak = 0;
  const seen = [];
  await pool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(x);
    running--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
});
await t('worker pool stops picking new items when asked', async () => {
  let n = 0;
  await pool([1, 2, 3, 4, 5], 1, async () => n++, () => n >= 2);
  assert.equal(n, 2);
});

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['src/index.js', ...args], { cwd: root, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}
const readReport = (out) => {
  const file = out.match(/Full report: (.+\.csv)/)[1].trim();
  const [head, ...lines] = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split('\r\n');
  const cols = head.split(',');
  return lines.map((l) => {
    const vals = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q && ch === '"' && l[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = !q;
      else if (ch === ',' && !q) vals.push(cur), (cur = '');
      else cur += ch;
    }
    vals.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
  });
};

console.log('\nFlow test (simulated Shopify)');
const mock = await startMock();
const testDir = path.join(root, 'output', 'test');
fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });
const cfgText = fs
  .readFileSync(path.join(root, 'config.example.yaml'), 'utf8')
  .replace('store: "your-store.myshopify.com"', 'store: "mock-store"')
  .replace('access_token: ""', 'access_token: "test"')
  .replace('create_missing: false', 'create_missing: true')
  .replace('file: "./sample/', 'file: "../../sample/')
  .replace('local_folder: "./sample/images"', 'local_folder: "../../sample/images"')
  .replace('folder: "./output"', 'folder: "."');
const cfgFile = path.join(testDir, 'config.yaml');
fs.writeFileSync(cfgFile, cfgText);
const env = { SHOPIFY_ENDPOINT_OVERRIDE: `http://127.0.0.1:${mock.server.address().port}/graphql` };

const check = await run(['check', '--config', cfgFile], env);
assert.equal(check.code, 0, check.out);
await t('check: every sample product has images, Shopify not contacted', () => {
  const rr = readReport(check.out);
  assert.ok(rr.every((r) => r.action === 'Images found'), JSON.stringify(rr.map((r) => r.action)));
  assert.equal(mock.calls.length, 0);
});

const plan = await run(['plan', '--config', cfgFile], env);
assert.equal(plan.code, 0, plan.out);
const pr = Object.fromEntries(readReport(plan.out).map((r) => [r.product_key, r]));
await t('plan: Oslo will update with 3 new images and 1 new variant', () => {
  assert.equal(pr['AMC-SOFA-001'].action, 'Will update');
  assert.equal(pr['AMC-SOFA-001'].images_new, '3');
  assert.match(pr['AMC-SOFA-001'].variants, /1 updated, 1 new/);
  assert.equal(pr['AMC-SOFA-001'].tags_added, 'living room');
});
await t('plan: the Aria image is already on the product, so it is not re-uploaded', () => {
  assert.equal(pr['AMC-BED-014'].images_new, '0');
  assert.equal(pr['AMC-BED-014'].collections, 'Beds');
  assert.match(pr['AMC-BED-014'].warnings, /smart/);
});
await t('plan: Nordic will be created, with a missing-collection warning', () => {
  assert.equal(pr['AMC-TBL-007'].action, 'Will create');
  assert.match(pr['AMC-TBL-007'].warnings, /Tables/);
});
await t('plan saved nothing', () => assert.ok(!mock.calls.some((c) => /mutation/.test(c.query))));
await t('plan wrote a log file', () => assert.ok(fs.readdirSync(testDir).some((n) => /^log-plan-.*\.txt$/.test(n))));

const apply = await run(['apply', '--yes', '--config', cfgFile], env);
assert.equal(apply.code, 0, apply.out);
const ar = readReport(apply.out);
await t('apply: no errors, report keeps sheet order', () => {
  assert.ok(ar.every((r) => r.action !== 'Error'), JSON.stringify(ar.filter((r) => r.error)));
  assert.deepEqual(ar.map((r) => r.product_key), ['AMC-SOFA-001', 'AMC-BED-014', 'AMC-TBL-007']);
});
const sets = mock.calls.filter((c) => /productSet/.test(c.query)).map((c) => c.variables.input);
await t('apply: Oslo variants and options sent correctly', () => {
  const oslo = sets.find((s) => s.id === 'gid://shopify/Product/1');
  assert.deepEqual(oslo.productOptions, [
    { name: 'Colour', values: [{ name: 'Grey' }, { name: 'Blue' }] },
    { name: 'Size', values: [{ name: '3 Seater' }] },
  ]);
  assert.equal(oslo.variants.length, 2);
  assert.equal(oslo.variants[0].id, 'gid://shopify/ProductVariant/11');
  assert.equal(oslo.variants[0].compareAtPrice, '1499');
  assert.equal(oslo.variants[1].sku, 'OSLO-3S-BLU');
  assert.ok(!oslo.files, 'in append mode, images for an existing product are not sent through productSet');
});
await t('apply: 3 Oslo images added with productUpdate', () => {
  const up = mock.calls.find((c) => /productUpdate/.test(c.query));
  assert.equal(up.variables.media.length, 3);
  assert.equal(up.variables.media[0].alt, 'Oslo 3 Seater Sofa');
});
await t('apply: new Nordic product created as Draft with its image', () => {
  const nordic = sets.find((s) => !s.id);
  assert.equal(nordic.title, 'Nordic Coffee Table');
  assert.equal(nordic.status, 'DRAFT');
  assert.equal(nordic.files.length, 1);
  assert.deepEqual(nordic.variants[0].optionValues, [{ optionName: 'Title', name: 'Default Title' }]);
  assert.equal(nordic.variants[0].price, '199');
});
await t('apply: metafields and collections', () => {
  const mfs = mock.calls.filter((c) => /metafieldsSet/.test(c.query)).flatMap((c) => c.variables.m);
  assert.ok(mfs.some((m) => m.key === 'warranty_years' && m.value === '5'));
  assert.equal(mock.calls.filter((c) => /collectionAddProducts/.test(c.query)).length, 2);
});
await t('apply: 4 images uploaded and a backup written', () => {
  assert.equal(mock.uploads.length, 4);
  assert.ok(fs.readdirSync(path.join(testDir, 'backups')).length);
});

const again = await run(['apply', '--yes', '--config', cfgFile], env);
await t('second apply: everything "Already done", nothing duplicated', () => {
  const rr = readReport(again.out);
  assert.ok(rr.every((r) => r.action === 'Already done'), JSON.stringify(rr.map((r) => r.action)));
  assert.equal(mock.uploads.length, 4);
});

mock.server.close();
console.log(`\nAll ${passed} tests passed.`);
