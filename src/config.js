import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const IMAGE_MODES = ['append', 'replace', 'skip_if_has_images'];
// Shopify fields a product can be found by. Tried in the order the user lists them.
export const MATCH_FIELDS = ['sku', 'barcode', 'handle', 'title', 'tag', 'id'];

// Fills values like "${SHOPIFY_TOKEN}" from environment variables
function envSub(v) {
  if (typeof v === 'string') return v.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? '');
  if (Array.isArray(v)) return v.map(envSub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, envSub(x)]));
  return v;
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}\nCopy "config.example.yaml" to "config.yaml" and fill in your details.`);
  }
  const raw = envSub(YAML.parse(fs.readFileSync(abs, 'utf8')) || {});
  return normalizeConfig(raw, path.dirname(abs));
}

// Turns a settings object (from the YAML file or the browser app) into a complete, validated config
export function normalizeConfig(raw, base) {
  const rel = (p) => (p ? (path.isAbsolute(p) ? p : path.resolve(base, p)) : '');

  const c = {
    shopify: { store: '', access_token: '', client_id: '', client_secret: '', api_version: '2026-07', ...raw.shopify },
    google: { service_account_file: '', api_key: '', ...raw.google },
    sheet: { file: '', google_sheet: '', worksheet: '', ...raw.sheet },
    images: {
      source: 'local',
      local_folder: '',
      drive_folder: '',
      mode: 'append',
      extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      ...raw.images,
    },
    match: { find_by: 'sku', rules: [], create_missing: false, new_product_status: 'DRAFT', ...raw.match },
    columns: { ...raw.columns },
    options: { tags_mode: 'append', create_missing_collections: false, keep_unlisted_variants: true, concurrency: 4, ...raw.options },
    metafields: raw.metafields || [],
    output: { folder: './output', ...raw.output },
  };

  c.google.service_account_file = rel(c.google.service_account_file);
  c.sheet.file = rel(c.sheet.file);
  c.images.local_folder = rel(c.images.local_folder);
  c.output.folder = rel(c.output.folder);
  c.options.concurrency = Math.min(8, Math.max(1, Number(c.options.concurrency) || 4));

  // Drop half-filled metafield rows (e.g. added in the browser app but left empty)
  c.metafields = c.metafields.filter((m) => m && (m.column || m.key));
  // options can be ["Colour"] or [{column: "Colour", name: "Color"}]
  c.columns.options = (c.columns.options || []).filter(Boolean).map((o) =>
    typeof o === 'string' ? { column: o, name: o } : { column: o.column, name: o.name || o.column }
  );

  // How to find each product in Shopify: an ordered list of { field, column }. The first rule that finds
  // exactly one product wins. Older settings only had find_by; turn that into rules, then add the
  // other identifier columns as fallbacks so a product can still be found if one of them is empty.
  let rules = (c.match.rules || []).filter((r) => r && MATCH_FIELDS.includes(r.field) && r.column);
  if (!rules.length) {
    const order = [c.match.find_by, 'sku', 'handle', 'title'].filter((f, i, a) => MATCH_FIELDS.includes(f) && a.indexOf(f) === i);
    rules = order.filter((f) => c.columns[f]).map((f) => ({ field: f, column: c.columns[f] }));
  }
  c.match.rules = rules.filter((r, i) => rules.findIndex((x) => x.field === r.field && x.column === r.column) === i);

  // No image folder given = simply do not touch images
  c.images.skippedReason = '';
  if (c.images.source === 'drive' && !c.images.drive_folder) {
    c.images.source = 'none';
    c.images.skippedReason = 'Images are set to Google Drive but no folder link was given, so images are skipped.';
  }
  if (c.images.source === 'local' && !c.images.local_folder) c.images.source = 'none';

  const errors = [];
  if (!c.sheet.file && !c.sheet.google_sheet) errors.push('Add a product sheet (a file or a Google Sheet link).');
  if (!c.match.rules.length) {
    errors.push('Choose at least one column to find products in Shopify with (for example SKU, Handle or Title) in "Find products in Shopify".');
  }
  if (!IMAGE_MODES.includes(c.images.mode)) errors.push(`images.mode must be one of: ${IMAGE_MODES.join(', ')}`);
  if (!['local', 'drive', 'none'].includes(c.images.source)) errors.push('images.source must be "local", "drive" or "none".');
  if (!['append', 'replace'].includes(c.options.tags_mode)) errors.push('options.tags_mode must be "append" or "replace".');
  for (const [i, m] of c.metafields.entries()) {
    if (!m.column || !m.namespace || !m.key || !m.type) errors.push(`Metafield ${i + 1} needs a column, namespace, key and type.`);
  }
  if (errors.length) throw new Error('Settings need attention:\n - ' + errors.join('\n - '));
  return c;
}

// Every sheet column the config refers to (used to check they exist in the sheet)
export function mappedColumns(c) {
  const cols = new Set();
  for (const [k, v] of Object.entries(c.columns)) {
    if (k === 'options') continue;
    if (v) cols.add(v);
  }
  c.columns.options.forEach((o) => cols.add(o.column));
  c.metafields.forEach((m) => cols.add(m.column));
  c.match.rules.forEach((r) => cols.add(r.column));
  return [...cols];
}
