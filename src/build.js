// Turns sheet rows into products and works out what to send to Shopify.
import { isBlank, norm, parseMoney, splitList, toHtml, uniqueCi } from './util.js';

const STATUSES = ['ACTIVE', 'DRAFT', 'ARCHIVED'];
const DEFAULT_OPT = [{ optionName: 'Title', name: 'Default Title' }];

export const firstVal = (rows, col) => {
  if (!col) return '';
  for (const r of rows) if (!isBlank(r[col])) return r[col];
  return '';
};
export const allVals = (rows, col) => (col ? rows.map((r) => r[col]).filter((v) => !isBlank(v)) : []);

// Rows with the same product_key form one product (each row can be a variant)
// The product key is optional. Without it, a row is grouped by the first "find product" column that has a value.
export function groupRows(rows, cfg) {
  const keyCols = [cfg.columns.product_key, ...cfg.match.rules.map((r) => r.column)].filter(Boolean);
  const map = new Map();
  const skipped = [];
  for (const r of rows) {
    const col = keyCols.find((c) => !isBlank(r[c]));
    if (!col) {
      skipped.push(r.__row);
      continue;
    }
    const k = `${col}\u0000${String(r[col]).trim().toLowerCase()}`;
    if (!map.has(k)) map.set(k, { key: String(r[col]).trim(), rows: [] });
    map.get(k).rows.push(r);
  }
  return { groups: [...map.values()], skipped };
}

// Values to search Shopify with for one rule. SKU and barcode are per variant, so every row counts.
export function lookupValues(group, rule) {
  return rule.field === 'sku' || rule.field === 'barcode'
    ? uniqueCi(allVals(group.rows, rule.column))
    : [firstVal(group.rows, rule.column)].filter(Boolean);
}

function scalar(type, s) {
  switch (type) {
    case 'boolean': {
      const t = s.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(t)) return 'true';
      if (['false', 'no', 'n', '0'].includes(t)) return 'false';
      throw new Error(`"${s}" is not true/false`);
    }
    case 'number_integer': {
      const n = s.replace(/,/g, '');
      if (!/^-?\d+$/.test(n)) throw new Error(`"${s}" is not a whole number`);
      return n;
    }
    case 'number_decimal': {
      const n = s.replace(/,/g, '');
      if (n === '' || isNaN(Number(n))) throw new Error(`"${s}" is not a number`);
      return n;
    }
    case 'rich_text_field':
      if (s.startsWith('{')) return s;
      return JSON.stringify({
        type: 'root',
        children: s.split(/\n\s*\n/).map((p) => ({ type: 'paragraph', children: [{ type: 'text', value: p.trim() }] })),
      });
    default:
      return s;
  }
}

export function formatMetafield(type, v) {
  const s = String(v).trim();
  if (type.startsWith('list.')) {
    if (s.startsWith('[')) return s;
    const inner = type.slice(5);
    const items = splitList(s).map((x) => {
      const val = scalar(inner, x);
      return inner.startsWith('number_') ? Number(val) : val;
    });
    return JSON.stringify(items);
  }
  return scalar(type, s);
}

const optKey = (opts) =>
  opts
    .map((o) => `${norm(o.optionName)}=${norm(o.name)}`)
    .sort()
    .join('|');

function variantFields(row, c, warnings) {
  const f = {};
  for (const [field, col] of [['price', c.price], ['compareAtPrice', c.compare_at_price]]) {
    if (!col) continue;
    const m = parseMoney(row[col]);
    if (m === undefined) warnings.push(`Row ${row.__row}: "${row[col]}" does not look like a price, skipped`);
    else if (m !== null) f[field] = m;
  }
  if (c.sku && !isBlank(row[c.sku])) f.sku = row[c.sku];
  if (c.barcode && !isBlank(row[c.barcode])) f.barcode = row[c.barcode];
  return f;
}

const sameMoney = (a, b) => (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));

// Variants: each sheet row is matched to an existing variant (by SKU first, then by options).
// No match and options filled in = a new variant. Existing variants missing from the sheet are kept (default).
function buildVariants(group, existing, cfg, warnings) {
  const c = cfg.columns;
  const rows = group.rows;
  const optCols = c.options;
  const rowOpts = (r) => optCols.filter((o) => !isBlank(r[o.column])).map((o) => ({ optionName: o.name, name: r[o.column] }));
  const fieldCols = [c.price, c.compare_at_price, c.sku, c.barcode].filter(Boolean);
  const hasData = rows.some((r) => rowOpts(r).length || fieldCols.some((col) => !isBlank(r[col])));
  if (!hasData) return null;

  const rowsHaveOptions = rows.some((r) => rowOpts(r).length);
  const ev = existing?.variants || [];
  const defaultOnly = ev.length === 1 && ev[0].selectedOptions.length === 1 && ev[0].selectedOptions[0].value === 'Default Title';

  // Existing product only has the "Default Title" variant and the sheet has options -> sheet variants replace the default
  const list =
    existing && !(rowsHaveOptions && defaultOnly)
      ? ev.map((v) => ({
          id: v.id,
          optionValues: v.selectedOptions.map((s) => ({ optionName: s.name, name: s.value })),
          _orig: v,
          _touched: false,
        }))
      : [];
  const replacedDefault = existing && rowsHaveOptions && defaultOnly;

  for (const r of rows) {
    const fields = variantFields(r, c, warnings);
    const opts = rowOpts(r);
    let target = null;
    if (fields.sku) target = list.find((v) => v._orig && String(v._orig.sku || '').toLowerCase() === fields.sku.toLowerCase());
    if (!target && opts.length) target = list.find((v) => optKey(v.optionValues) === optKey(opts));
    if (!target && !opts.length && list.length === 1) target = list[0];

    if (target) {
      if (target._touched) warnings.push(`Row ${r.__row}: this variant was already updated by another row`);
      Object.assign(target, fields);
      if (opts.length && optKey(opts) !== optKey(target.optionValues) && opts.length === target.optionValues.length) target.optionValues = opts;
      target._touched = true;
    } else if (opts.length) {
      list.push({ optionValues: opts, ...fields, _touched: true, _row: r.__row });
    } else if (!rowsHaveOptions && list.length === 0) {
      list.push({ optionValues: DEFAULT_OPT, ...fields, _touched: true, _row: r.__row });
    } else {
      warnings.push(`Row ${r.__row}: no matching variant (option columns are empty and the product has ${list.length} variants), skipped`);
    }
  }

  let dropped = 0;
  let final = list;
  if (!cfg.options.keep_unlisted_variants) {
    final = list.filter((v) => v._touched);
    dropped = list.length - final.length;
  }

  // Every variant needs a value for every option, and no combination may appear twice
  const names = [];
  for (const o of existing && !replacedDefault ? existing.options.map((o) => o.name) : []) names.push(o);
  for (const v of final) for (const o of v.optionValues) if (!names.some((n) => norm(n) === norm(o.optionName))) names.push(o.optionName);
  const seen = new Set();
  const ok = [];
  for (const v of final) {
    if (v.optionValues.length !== names.length) {
      warnings.push(
        `Row ${v._row ?? '?'}: variant is missing options (needs: ${names.join(', ')}). ` +
          `Variants of this product were not changed.`
      );
      return { error: true };
    }
    const k = optKey(v.optionValues);
    if (seen.has(k)) {
      warnings.push(`Row ${v._row ?? '?'}: the same option combination appears twice (${v.optionValues.map((o) => o.name).join(' / ')}), skipped`);
      continue;
    }
    seen.add(k);
    ok.push(v);
  }

  const created = ok.filter((v) => !v.id).length;
  const updated = ok.filter((v) => {
    if (!v.id || !v._touched) return false;
    const o = v._orig;
    return (
      ('price' in v && !sameMoney(v.price, o.price)) ||
      ('compareAtPrice' in v && !sameMoney(v.compareAtPrice, o.compareAtPrice)) ||
      ('sku' in v && v.sku !== (o.sku || '')) ||
      ('barcode' in v && v.barcode !== (o.barcode || '')) ||
      optKey(v.optionValues) !== optKey(o.selectedOptions.map((s) => ({ optionName: s.name, name: s.value })))
    );
  }).length;
  if (!created && !updated && !dropped && !replacedDefault) return { unchanged: true };

  const productOptions = names.map((n) => {
    const vals = [];
    for (const v of ok) {
      const ov = v.optionValues.find((o) => norm(o.optionName) === norm(n));
      if (ov && !vals.some((x) => norm(x) === norm(ov.name))) vals.push(ov.name);
    }
    return { name: n, values: vals.map((name) => ({ name })) };
  });
  const variants = ok.map(({ _orig, _touched, _row, ...v }) => ({
    ...v,
    optionValues: v.optionValues.map((o) => ({ optionName: names.find((n) => norm(n) === norm(o.optionName)), name: o.name })),
  }));
  const parts = [];
  if (updated) parts.push(`${updated} updated`);
  if (created) parts.push(`${created} new`);
  if (dropped) parts.push(`${dropped} removed`);
  if (replacedDefault) parts.push('default variant replaced');
  return { productOptions, variants, summary: parts.join(', ') };
}

export function buildProduct(group, existing, cfg) {
  const c = cfg.columns;
  const rows = group.rows;
  const warnings = [];
  const changes = [];
  const input = {};
  if (existing) input.id = existing.id;

  // If the Title column is also what the product was found by, it identifies the product and is not
  // written back (otherwise a different capitalisation in the sheet would rename the product).
  const titleIsKey = existing?.foundBy?.field === 'title' && existing.foundBy.column === c.title;
  const title = titleIsKey ? '' : firstVal(rows, c.title);
  if (title && title !== existing?.title) {
    input.title = title;
    changes.push('title');
  }
  if (!existing) {
    if (!input.title) input.title = group.key;
    const handle = firstVal(rows, c.handle);
    if (handle) input.handle = handle;
  }

  const desc = firstVal(rows, c.description);
  if (desc) {
    const html = toHtml(desc);
    if (html !== existing?.descriptionHtml) {
      input.descriptionHtml = html;
      changes.push('description');
    }
  }
  const vendor = firstVal(rows, c.vendor);
  if (vendor && vendor !== existing?.vendor) {
    input.vendor = vendor;
    changes.push('vendor');
  }
  const ptype = firstVal(rows, c.product_type);
  if (ptype && ptype !== existing?.productType) {
    input.productType = ptype;
    changes.push('type');
  }
  const status = firstVal(rows, c.status).toUpperCase();
  if (status && !STATUSES.includes(status)) warnings.push(`Status "${status}" is not valid (use ACTIVE, DRAFT or ARCHIVED)`);
  else if (status && status !== existing?.status) {
    input.status = status;
    changes.push('status');
  } else if (!existing && !status) input.status = String(cfg.match.new_product_status).toUpperCase();

  // SEO: the meta title and meta description Google shows in search results
  const seoTitle = firstVal(rows, c.seo_title);
  const seoDesc = firstVal(rows, c.seo_description);
  if (seoTitle || seoDesc) {
    const seo = {};
    if (seoTitle && seoTitle !== (existing?.seo?.title || '')) seo.title = seoTitle;
    if (seoDesc && seoDesc !== (existing?.seo?.description || '')) seo.description = seoDesc;
    if (Object.keys(seo).length) {
      // Keep the other SEO field as it is in Shopify when only one of them changes
      if (!seo.title && existing?.seo?.title) seo.title = existing.seo.title;
      if (!seo.description && existing?.seo?.description) seo.description = existing.seo.description;
      input.seo = seo;
      changes.push('meta title/description');
    }
    if (seoTitle.length > 70) warnings.push(`Meta title is ${seoTitle.length} characters; Google usually shows about 60`);
    if (seoDesc.length > 160) warnings.push(`Meta description is ${seoDesc.length} characters; Google usually shows about 155`);
  }

  // Tags
  const sheetTags = uniqueCi(allVals(rows, c.tags).flatMap(splitList));
  const existingTags = existing?.tags || [];
  const has = (list, t) => list.some((e) => e.toLowerCase() === t.toLowerCase());
  const tagsAdded = sheetTags.filter((t) => !has(existingTags, t));
  if (sheetTags.length) {
    if (cfg.options.tags_mode === 'replace') {
      const tagsRemoved = existingTags.filter((t) => !has(sheetTags, t));
      if (tagsAdded.length || tagsRemoved.length) {
        input.tags = sheetTags;
        changes.push('tags');
      }
    } else if (tagsAdded.length) {
      input.tags = uniqueCi([...existingTags, ...sheetTags]);
      changes.push('tags');
    }
  }

  // Variants
  let variantSummary = '';
  const vb = buildVariants(group, existing, cfg, warnings);
  if (vb && !vb.error && !vb.unchanged) {
    input.productOptions = vb.productOptions;
    input.variants = vb.variants;
    variantSummary = vb.summary;
    changes.push('variants');
  } else if (!existing) {
    // New product without variant data: one default variant
    input.productOptions = [{ name: 'Title', values: [{ name: 'Default Title' }] }];
    input.variants = [{ optionValues: DEFAULT_OPT }];
  }

  // Metafields
  const metafields = [];
  for (const m of cfg.metafields) {
    const v = firstVal(rows, m.column);
    if (isBlank(v)) continue;
    try {
      metafields.push({ namespace: m.namespace, key: m.key, type: m.type, value: formatMetafield(m.type, v) });
    } catch (e) {
      warnings.push(`Metafield ${m.namespace}.${m.key}: ${e.message}`);
    }
  }

  const collectionTitles = uniqueCi(allVals(rows, c.collections).flatMap(splitList));
  return { input, changes, warnings, tagsAdded, variantSummary, metafields, collectionTitles };
}
