// Builds templates/Shopify-Product-Template.xlsx.
// Only needed to change the template. Run from this folder:
//   npm install --no-save exceljs@4
//   node build-template.cjs Shopify-Product-Template.xlsx
const ExcelJS = require('exceljs');
const out = process.argv[2];

const FONT = 'Arial';
const GROUPS = {
  id: { name: 'Identity (required)', fill: '1F6F5C' },
  basic: { name: 'Basic details', fill: '2F5597' },
  content: { name: 'Content', fill: '6B3FA0' },
  seo: { name: 'SEO', fill: 'C55A11' },
  images: { name: 'Images', fill: '0E7C86' },
  variants: { name: 'Variants and pricing', fill: '7F6000' },
  meta: { name: 'Metafields', fill: '595959' },
};

// header, group, width, required, what it does, where it shows, format / rules, example, app field
const COLS = [
  ['AMC Name', 'id', 18, 'Yes', 'Your own product code. Every row with the same AMC Name is one product; each row is one variant of it.', 'Not shown to customers. Used by the app to group rows.', 'Unique per product. Repeat it on every variant row.', 'AMC-SOFA-001', 'Product key'],
  ['SKU', 'id', 16, 'Yes, if matching by SKU', 'Stock code of this variant. The app uses it to find the product that already exists in Shopify.', 'Product admin, orders, packing slips.', 'Unique per variant. One SKU per row.', 'OSLO-3S-GRY', 'SKU'],
  ['Meta Name', 'images', 26, 'For images', 'The name your image files are saved under. The app finds images whose file name matches this value.', 'Not shown. Used only to match image files.', 'Same on every row of a product. Files: "Meta Name.jpg", "Meta Name_1.jpg", "Meta Name (2).png".', 'Oslo 3 Seater Sofa', 'Image name'],
  ['Product Title', 'basic', 34, 'For new products', 'The product name.', 'Product page heading, collection pages, cart, Google Shopping.', 'Clear and descriptive. Fill on the first row of each product only.', 'Oslo 3 Seater Fabric Sofa', 'Title'],
  ['Handle', 'basic', 26, 'No', 'The product URL, e.g. /products/oslo-3-seater-sofa.', 'Address bar and links.', 'Lowercase words joined by "-". Used for NEW products only; an existing product URL is never changed.', 'oslo-3-seater-fabric-sofa', 'Handle'],
  ['Vendor', 'basic', 20, 'No', 'Supplier or brand.', 'Product page (theme dependent), admin filters.', 'Plain text.', 'Urban Wood Co', 'Vendor / Supplier'],
  ['Product Type', 'basic', 18, 'No', 'Category of the product.', 'Admin filters, smart collection rules.', 'Keep the same spelling for every product of a type.', 'Sofa', 'Product type / Category'],
  ['Status', 'basic', 12, 'No', 'Whether the product is live.', 'ACTIVE = live on the store. DRAFT = hidden. ARCHIVED = hidden and filed away.', 'ACTIVE, DRAFT or ARCHIVED (pick from the list). Empty: new products follow the app setting (Draft by default).', 'DRAFT', 'Status'],
  ['Description', 'content', 50, 'No', 'The main product description.', 'Product page body.', 'Plain text (blank line = new paragraph) or HTML. Fill on the first row of each product only.', '<p>Solid oak frame...</p>', 'Description'],
  ['Tags', 'content', 26, 'No', 'Keywords used for filtering and smart collections.', 'Store filters, search, smart collection rules.', 'Comma separated. Existing tags are kept unless the app is set to "Keep only the sheet\'s tags".', 'sofa, living room, fabric', 'Tags'],
  ['Collections', 'content', 24, 'No', 'Manual collections the product should be added to.', 'Collection pages and menus.', 'Collection titles, comma separated, spelled exactly as in Shopify. Automated (smart) collections fill themselves.', 'Sofas, Living Room', 'Collections'],
  ['Meta Title', 'seo', 40, 'Recommended', 'The page title search engines show.', 'Blue link in Google results and the browser tab.', 'Up to 60 characters. The cell turns orange when it is longer. Include the main keyword and brand.', 'Oslo 3 Seater Fabric Sofa | AMC Furniture', 'Meta title (SEO)'],
  ['Meta Description', 'seo', 55, 'Recommended', 'The summary search engines show under the title.', 'Grey text under the link in Google results.', 'Up to 155 characters. The cell turns orange when it is longer. Describe the benefit and add a reason to click.', 'Shop the Oslo 3 seater sofa...', 'Meta description (SEO)'],
  ['Image Alt Text', 'images', 34, 'Recommended', 'Describes the images for screen readers and Google Images.', 'Not visible; read by screen readers and search engines.', 'Short, factual description. Empty: the product title is used.', 'Grey Oslo 3 seater fabric sofa', 'Image alt text'],
  ['Colour', 'variants', 14, 'For variants', 'First variant option.', 'Option picker on the product page.', 'The column name must match the option name in Shopify ("Colour" vs "Color"). Leave empty for products without variants.', 'Grey', 'Variant option'],
  ['Size', 'variants', 14, 'For variants', 'Second variant option.', 'Option picker on the product page.', 'As above. Add more option columns (e.g. Finish) if needed, and tick them in the app.', '3 Seater', 'Variant option'],
  ['Price', 'variants', 11, 'Yes, for new products', 'Selling price of this variant.', 'Product page, cart, checkout.', 'Number. £ signs and commas are removed automatically.', '1299', 'Price'],
  ['Compare At Price', 'variants', 13, 'No', 'The original price, shown crossed out when on sale.', 'Product page next to the price.', 'Higher than Price. Leave empty when not on sale.', '1499', 'Compare-at price'],
  ['Barcode', 'variants', 16, 'No', 'EAN, UPC or GTIN of this variant.', 'Admin, Google Shopping feed.', 'Digits only. Format the column as text so leading zeros stay.', '5012345678900', 'Barcode'],
  ['Material (custom.material)', 'meta', 22, 'No', 'Metafield: main material.', 'Product page, if your theme shows this metafield.', 'Text.', 'Solid oak, linen fabric', 'Metafield (auto-detected)'],
  ['Dimensions (custom.dimensions)', 'meta', 26, 'No', 'Metafield: size of the product.', 'Product page, if your theme shows this metafield.', 'Text, e.g. W 210 x D 92 x H 85 cm.', 'W 210 x D 92 x H 85 cm', 'Metafield (auto-detected)'],
  ['Warranty Years (custom.warranty_years)', 'meta', 18, 'No', 'Metafield: warranty length.', 'Product page, if your theme shows this metafield.', 'Whole number.', '5', 'Metafield (auto-detected)'],
  ['Assembly Required Yes/No (custom.assembly_required)', 'meta', 20, 'No', 'Metafield: whether the customer must assemble it.', 'Product page, if your theme shows this metafield.', 'Yes or No (pick from the list).', 'No', 'Metafield (auto-detected)'],
  ['Care Instructions (custom.care_instructions)', 'meta', 34, 'No', 'Metafield: cleaning and care.', 'Product page, if your theme shows this metafield.', 'Text.', 'Vacuum regularly. Spot clean only.', 'Metafield (auto-detected)'],
  ['Delivery Time (custom.delivery_time)', 'meta', 20, 'No', 'Metafield: expected delivery.', 'Product page, if your theme shows this metafield.', 'Text.', '5-7 working days', 'Metafield (auto-detected)'],
];

const EXAMPLES = [
  ['AMC-SOFA-001', 'OSLO-3S-GRY', 'Oslo 3 Seater Sofa', 'Oslo 3 Seater Fabric Sofa', 'oslo-3-seater-fabric-sofa', 'Urban Wood Co', 'Sofa', 'ACTIVE',
    'A deep, comfortable 3 seater sofa on a solid oak frame, finished in hard-wearing linen-blend fabric.\n\nThe reversible seat cushions keep their shape, and the removable covers make it easy to keep fresh.',
    'sofa, living room, fabric, 3 seater', 'Sofas, Living Room',
    'Oslo 3 Seater Fabric Sofa | Solid Oak Frame | AMC Furniture',
    'Shop the Oslo 3 seater fabric sofa with a solid oak frame and removable, washable covers. Delivered across the UK by AMC Furniture.',
    'Oslo 3 seater fabric sofa in grey with oak legs', 'Grey', '3 Seater', 1299, 1499, '5012345678900',
    'Solid oak, linen-blend fabric', 'W 210 x D 92 x H 85 cm', 5, 'No', 'Vacuum regularly. Spot clean with a damp cloth.', '5-7 working days'],
  ['AMC-SOFA-001', 'OSLO-3S-BLU', 'Oslo 3 Seater Sofa', '', '', '', '', '', '', '', '', '', '', '', 'Blue', '3 Seater', 1299, 1499, '5012345678917', '', '', '', '', '', ''],
  ['AMC-BED-014', 'ARIA-KB', 'Aria King Bed', 'Aria King Size Ottoman Storage Bed', 'aria-king-size-ottoman-bed', 'Sleepwell Supplies', 'Bed', 'ACTIVE',
    '<p>The Aria king size bed lifts on gas pistons to reveal a full-length storage space underneath.</p><p>Upholstered headboard, sprung slatted base.</p>',
    'bed, bedroom, storage, king size', 'Beds, Bedroom',
    'Aria King Size Ottoman Storage Bed | AMC Furniture',
    'Make space with the Aria king size ottoman bed: full-length storage, upholstered headboard and a sprung slatted base. Order online today.',
    'Aria king size ottoman bed with the base lifted to show storage', '', '', 849, '', '',
    'Velvet, engineered wood', 'W 166 x L 212 x H 120 cm', 3, 'Yes', 'Brush velvet gently in one direction.', '7-10 working days'],
  ['AMC-TBL-007', 'NORD-CT', 'Nordic Coffee Table', 'Nordic Oak Coffee Table', 'nordic-oak-coffee-table', 'Urban Wood Co', 'Table', 'DRAFT',
    'A minimal coffee table in solid oak with a lower shelf for books and magazines.',
    'table, living room, oak', 'Tables',
    'Nordic Solid Oak Coffee Table with Shelf | AMC Furniture',
    'A minimal solid oak coffee table with a handy lower shelf. Scandinavian style for any living room, delivered across the UK.',
    'Nordic solid oak coffee table with lower shelf', '', '', 199, 249, '',
    'Solid oak', 'W 110 x D 60 x H 45 cm', 2, 'Yes', 'Wipe with a dry cloth. Use coasters.', '3-5 working days'],
];

const wb = new ExcelJS.Workbook();
wb.creator = 'Shopify Bulk Uploader';
const font = (o = {}) => ({ name: FONT, size: 10, ...o });
const colLetter = (i) => {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};
const idx = (h) => COLS.findIndex((c) => c[0] === h);
const L = (h) => colLetter(idx(h));
const ROWS = 3000;

function productSheet(ws, withExamples) {
  ws.columns = COLS.map((c) => ({ header: c[0], key: c[0], width: c[2] }));
  const head = ws.getRow(1);
  head.height = 42;
  COLS.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.font = font({ bold: true, color: { argb: 'FFFFFFFF' } });
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + GROUPS[c[1]].fill } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.note = { texts: [{ text: `${GROUPS[c[1]].name}\nRequired: ${c[3]}\n\n${c[4]}\n\nFormat: ${c[6]}\n\nExample: ${c[7]}` }] };
  });
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: `${colLetter(COLS.length - 1)}1` };

  if (withExamples) EXAMPLES.forEach((r) => ws.addRow(r));

  // Formats and validation for the fill-in area
  const last = ROWS + 1;
  for (const h of ['SKU', 'Barcode', 'AMC Name', 'Handle']) ws.getColumn(idx(h) + 1).numFmt = '@';
  for (const h of ['Price', 'Compare At Price']) ws.getColumn(idx(h) + 1).numFmt = '#,##0.00';
  for (let r = 2; r <= last; r++) {
    const row = ws.getRow(r);
    row.font = font();
    row.alignment = { vertical: 'top', wrapText: false };
    row.getCell(idx('Description') + 1).alignment = { vertical: 'top', wrapText: true };
  }
  ws.dataValidations.add(`${L('Status')}2:${L('Status')}${last}`, {
    type: 'list', allowBlank: true, formulae: ['"ACTIVE,DRAFT,ARCHIVED"'],
    showErrorMessage: true, errorTitle: 'Status', error: 'Choose ACTIVE, DRAFT or ARCHIVED.',
  });
  const yn = COLS.find((c) => /Yes\/No/.test(c[0]))[0];
  ws.dataValidations.add(`${L(yn)}2:${L(yn)}${last}`, {
    type: 'list', allowBlank: true, formulae: ['"Yes,No"'], showErrorMessage: true, errorTitle: 'Yes or No', error: 'Choose Yes or No.',
  });
  for (const h of ['Price', 'Compare At Price']) {
    ws.dataValidations.add(`${L(h)}2:${L(h)}${last}`, {
      type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0],
      showErrorMessage: true, errorTitle: h, error: 'Enter a number, for example 1299 or 1299.99.',
    });
  }
  const wy = COLS.find((c) => /warranty_years/.test(c[0]))[0];
  ws.dataValidations.add(`${L(wy)}2:${L(wy)}${last}`, {
    type: 'whole', operator: 'between', allowBlank: true, formulae: [0, 50], showErrorMessage: true, errorTitle: 'Warranty', error: 'Enter a whole number of years.',
  });

  const orange = { type: 'expression', priority: 1, style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFF8CBAD' } } } };
  const red = { style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC7CE' } } } };
  ws.addConditionalFormatting({ ref: `${L('Meta Title')}2:${L('Meta Title')}${last}`, rules: [{ ...orange, formulae: [`LEN(${L('Meta Title')}2)>60`] }] });
  ws.addConditionalFormatting({ ref: `${L('Meta Description')}2:${L('Meta Description')}${last}`, rules: [{ ...orange, formulae: [`LEN(${L('Meta Description')}2)>155`] }] });
  ws.addConditionalFormatting({
    ref: `A2:A${last}`,
    rules: [{ type: 'expression', priority: 2, ...red, formulae: [`AND(A2="",COUNTA(B2:${colLetter(COLS.length - 1)}2)>0)`] }],
  });
  ws.addConditionalFormatting({
    ref: `${L('Compare At Price')}2:${L('Compare At Price')}${last}`,
    rules: [{ type: 'expression', priority: 3, ...red, formulae: [`AND(${L('Compare At Price')}2<>"",${L('Compare At Price')}2<=${L('Price')}2)`] }],
  });
}

// ---- Products (first tab: the app reads the first tab by default) ----
productSheet(wb.addWorksheet('Products', { properties: { tabColor: { argb: 'FF1F6F5C' } } }), false);
// ---- Example ----
const ex = wb.addWorksheet('Example', { properties: { tabColor: { argb: 'FFC55A11' } } });
productSheet(ex, true);
for (let r = 2; r <= EXAMPLES.length + 1; r++) {
  const row = ex.getRow(r);
  row.height = r === 3 ? 18 : 92;
  row.eachCell({ includeEmpty: true }, (c) => (c.alignment = { vertical: 'top', wrapText: true }));
}

// ---- Guide ----
const g = wb.addWorksheet('Guide', { properties: { tabColor: { argb: 'FF2F5597' } } });
g.columns = [{ width: 4 }, { width: 30 }, { width: 18 }, { width: 18 }, { width: 46 }, { width: 38 }, { width: 52 }, { width: 30 }, { width: 24 }];
const title = (ws, r, text, size = 16) => {
  const c = ws.getCell(`B${r}`);
  c.value = text;
  c.font = font({ size, bold: true });
};
const para = (ws, r, text, opts = {}) => {
  ws.mergeCells(`B${r}:${opts.to || 'H'}${r}`);
  const c = ws.getCell(`B${r}`);
  c.value = text;
  c.font = font(opts.font || {});
  c.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(r).height = opts.h || 15;
};
title(g, 2, 'Shopify product template: how to fill it in');
para(g, 3, 'Fill the "Products" tab, one row per product (one row per variant for products with options), then load this file in Shopify Bulk Uploader. The "Example" tab shows three finished products.', { h: 28, font: { color: { argb: 'FF5D6876' } } });

title(g, 5, 'Steps', 12);
const steps = [
  '1. Fill the "Products" tab. Leave the header row exactly as it is. Hover over any header to see what goes in it.',
  '2. Products with variants: one row per variant. Repeat the same AMC Name and Meta Name; fill Title, Description, SEO and metafields on the first row only.',
  '3. Save your images in one folder, named after the Meta Name (see the "Image Naming" tab).',
  '4. Open the app (Open-App.bat). Step 2: drop in this file. Step 3: click "Auto-fill from column names"; every column below maps itself, including metafields.',
  '5. Step 4: drop in the images folder. Step 6: run "Check image matches", then "Preview changes" with 5 products, then "Upload to Shopify".',
  '6. Before uploading, delete any example rows you copied in, and check that metafield types match the definitions in Shopify (see the "Metafields" tab).',
];
steps.forEach((s, i) => para(g, 6 + i, s, { h: 28 }));

title(g, 13, 'Colour key', 12);
let r = 14;
for (const k of Object.keys(GROUPS)) {
  const c = g.getCell(`B${r}`);
  c.value = GROUPS[k].name;
  c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } });
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + GROUPS[k].fill } };
  r++;
}
const keyNotes = [
  ['Orange cell', 'Meta title longer than 60 characters, or meta description longer than 155. Google will cut it off.', 'FFF8CBAD'],
  ['Red cell', 'A row has data but no AMC Name (it will be skipped), or Compare At Price is not higher than Price.', 'FFFFC7CE'],
];
for (const [k, v, fill] of keyNotes) {
  g.getCell(`B${r}`).value = k;
  g.getCell(`B${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  g.getCell(`B${r}`).font = font({ bold: true });
  g.mergeCells(`C${r}:H${r}`);
  g.getCell(`C${r}`).value = v;
  g.getCell(`C${r}`).font = font();
  r++;
}

r += 1;
title(g, r, 'Every column explained', 12);
r++;
const gh = ['Column', 'Group', 'Required?', 'What it does', 'Where it shows', 'Format and rules', 'Example', 'App field it maps to'];
gh.forEach((h, i) => {
  const c = g.getRow(r).getCell(i + 2);
  c.value = h;
  c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } });
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1E23' } };
  c.alignment = { vertical: 'middle', wrapText: true };
});
const guideHeaderRow = r;
r++;
for (const c of COLS) {
  const row = g.getRow(r);
  [c[0], GROUPS[c[1]].name, c[3], c[4], c[5], c[6], c[7], c[8]].forEach((v, i) => {
    const cell = row.getCell(i + 2);
    cell.value = v;
    cell.font = font(i === 0 ? { bold: true } : {});
    cell.alignment = { wrapText: true, vertical: 'top' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFE1E5EA' } } };
  });
  row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + GROUPS[c[1]].fill } };
  row.getCell(2).font = font({ bold: true, color: { argb: 'FFFFFFFF' } });
  row.height = 54;
  r++;
}
g.views = [{ state: 'frozen', ySplit: guideHeaderRow, showGridLines: false }];

r += 1;
title(g, r, 'Good to know', 12);
r++;
[
  'Empty cells never erase data in Shopify. To keep a field as it is, leave it empty.',
  'Existing products are found by SKU (or by Handle or Title, if you change "Find products by" in the app). Products that are not found are only created if you tick "Create products that are not in Shopify".',
  'Existing product URLs (handles) are never changed, so search rankings are safe.',
  'Re-running the same sheet does not duplicate anything: unchanged rows are skipped and images already on a product are not uploaded again.',
  'Not supported by the template: a separate image per variant, inventory quantities, and metafields that point to other objects (metaobjects, products).',
].forEach((s) => para(g, r++, '• ' + s, { h: 28 }));

// ---- Image Naming ----
const im = wb.addWorksheet('Image Naming', { properties: { tabColor: { argb: 'FF0E7C86' } } });
im.columns = [{ width: 4 }, { width: 30 }, { width: 44 }, { width: 40 }];
im.views = [{ showGridLines: false }];
title(im, 2, 'How images are matched to products');
para(im, 3, 'The app reads each file name, ignores capital letters, spaces, "-" and "_", and matches it to the Meta Name column. A number at the end sets the order.', { to: 'D', h: 28, font: { color: { argb: 'FF5D6876' } } });
const ih = ['Meta Name in the sheet', 'File name', 'Result'];
ih.forEach((h, i) => {
  const c = im.getRow(5).getCell(i + 2);
  c.value = h;
  c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } });
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E7C86' } };
});
const ir = [
  ['Oslo 3 Seater Sofa', 'Oslo 3 Seater Sofa.jpg', 'Matched, image 1 (main image)', 'ok'],
  ['Oslo 3 Seater Sofa', 'oslo-3-seater-sofa_1.jpg', 'Matched, image 1', 'ok'],
  ['Oslo 3 Seater Sofa', 'Oslo 3 Seater Sofa (2).png', 'Matched, image 2', 'ok'],
  ['Oslo 3 Seater Sofa', 'OSLO_3_SEATER_SOFA-3.webp', 'Matched, image 3', 'ok'],
  ['Oslo 3 Seater Sofa', 'Oslo 3 Seater Sofa Bed.jpg', 'Not matched: this is a different product name', 'no'],
  ['Oslo 3 Seater Sofa', 'Oslo Sofa 3 Seater.jpg', 'Not matched: words are in a different order', 'no'],
  ['Oslo 3 Seater Sofa', 'Oslo 3 Seater Sofa1.jpg', 'Not matched: put "_", "-" or a space before the number', 'no'],
];
ir.forEach((row, i) => {
  const rr = im.getRow(6 + i);
  row.slice(0, 3).forEach((v, j) => {
    const c = rr.getCell(j + 2);
    c.value = v;
    c.font = font(j === 2 ? { color: { argb: row[3] === 'ok' ? 'FF1D7637' : 'FFB42318' }, bold: true } : {});
    c.border = { bottom: { style: 'thin', color: { argb: 'FFE1E5EA' } } };
  });
});
title(im, 15, 'Image tips', 12);
[
  'Formats: JPG, PNG, WEBP or GIF. Each file must be under 20 MB.',
  'Size: 2048 x 2048 pixels, square, is ideal for Shopify. Larger images slow the store down.',
  'Put every image in one folder (sub-folders are fine). Drag that folder into step 4 of the app, or use a Google Drive folder link.',
  'The first image (no number, or number 1) becomes the main product image.',
  'Fill "Image Alt Text" in the sheet: it helps Google Images and screen readers.',
  'After "Check image matches", the app lists products without images and image files that match no product, so you can fix names.',
].forEach((s, i) => para(im, 16 + i, '• ' + s, { to: 'D', h: 28 }));

// ---- Metafields ----
const mf = wb.addWorksheet('Metafields', { properties: { tabColor: { argb: 'FF595959' } } });
mf.columns = [{ width: 4 }, { width: 44 }, { width: 30 }, { width: 26 }, { width: 30 }];
mf.views = [{ showGridLines: false }];
title(mf, 2, 'Metafields: extra product details');
para(mf, 3, 'Metafields store details Shopify has no standard field for, such as material or dimensions. Your theme decides where they show on the product page.', { to: 'E', h: 28, font: { color: { argb: 'FF5D6876' } } });
title(mf, 5, 'Set up once in Shopify', 12);
[
  '1. Shopify Admin, then Settings, then Custom data, then Products, then "Add definition".',
  '2. Give it a name, and check the namespace and key (for example custom.material). Choose the type to match the table below.',
  '3. To show it on the product page: Online Store, then Themes, then Customize, then a product template, then add a block and connect it to the metafield.',
].forEach((s, i) => para(mf, 6 + i, s, { to: 'E', h: 28 }));
title(mf, 10, 'Metafields in this template', 12);
['Column header', 'Namespace.key', 'Type to choose in Shopify', 'Type the app sets'].forEach((h, i) => {
  const c = mf.getRow(11).getCell(i + 2);
  c.value = h;
  c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } });
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF595959' } };
});
const mfRows = COLS.filter((c) => c[1] === 'meta').map((c) => {
  const key = c[0].match(/\(([^)]+)\)/)[1];
  const type = /Yes\/No/.test(c[0]) ? ['True or false', 'boolean'] : /Years/.test(c[0]) ? ['Integer', 'number_integer'] : ['Single line text', 'single_line_text_field'];
  return [c[0], key, ...type];
});
mfRows.forEach((row, i) => {
  row.forEach((v, j) => {
    const c = mf.getRow(12 + i).getCell(j + 2);
    c.value = v;
    c.font = font(j === 0 ? { bold: true } : {});
    c.border = { bottom: { style: 'thin', color: { argb: 'FFE1E5EA' } } };
  });
});
const after = 12 + mfRows.length + 1;
title(mf, after, 'Adding your own metafield column', 12);
[
  'Add a column to the Products tab with the header "Label (namespace.key)", for example "Fabric Code (custom.fabric_code)".',
  'In the app, "Auto-fill from column names" turns it into a metafield. Headers containing "Yes/No" become true/false, and headers containing "Years", "Qty" or "Number" become whole numbers. Everything else is single line text.',
  'Check the type in step 3 of the app. It must match the definition in Shopify, otherwise that product will show an error and the rest continue.',
  'Not used: delete the column, or leave its cells empty. Empty cells are skipped.',
].forEach((s, i) => para(mf, after + 1 + i, '• ' + s, { to: 'E', h: 30 }));

wb.worksheets.forEach((ws) => ws.eachRow((row) => row.eachCell((c) => { if (!c.font || c.font.name !== FONT) c.font = { ...(c.font || {}), name: FONT, size: c.font?.size || 10 }; })));
wb.xlsx.writeFile(out).then(() => console.log('written', out));
