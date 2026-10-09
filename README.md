# Shopify Bulk Uploader

Bulk-updates or creates Shopify products from a product sheet (Excel, CSV or Google Sheet) and a folder of images (your computer or Google Drive).

In one run it can set:

- Images, matched to products by file name
- Title, description, vendor, product type and status
- Meta title and meta description (SEO)
- Tags and collections
- Variants (Colour, Size and so on) with price, compare-at price, SKU and barcode
- Metafields

---

## Quick start: the browser app

1. Double-click **Open-App.bat**. The first time, it installs what it needs. This requires Node.js, which is already on this computer.
2. Your browser opens `http://localhost:3789`. Keep the black window open while you work. Closing it stops the app.
3. Work down the page:
   1. **Connect to Shopify.** Enter your store address and access token, then click "Test connection". The app warns you if the token is missing a permission.
   2. **Product sheet.** Drop in your Excel or CSV file, or paste a Google Sheet link. A sample sheet is linked on the page.
   3. **Map your columns.** Click "Auto-fill from column names", then correct anything wrong. At the top, choose how each product is found in Shopify (see below). Only map what you want to change; nothing else is required.
   4. **Images.** Leave on "No images" to keep product images as they are. Otherwise drop your images folder in, or give a Google Drive folder link.
   5. **Update rules.** Choose how images, tags and new products are handled, and how fast to run.
   6. **Run.** The checklist shows what is still missing. Then run the three steps in order: check image matches, preview changes, upload to Shopify.
4. The results table shows each product's image thumbnails, what changes, any warnings and a link to the product in Shopify. Use the filters, search box and pages to work through large catalogues. Images that match no product are listed underneath.

The app only runs on your computer. Nobody else on the network can open it. Your settings, sheet and images are kept in the `web-data` folder, so everything is still there the next time you open the app. Reports, logs and backups go to `web-data/output`.

**First real run:** type `5` in "Only the first N products" and run Preview, then Upload. Check those 5 products in Shopify before running the whole sheet.

## Shopify access

You need either an Admin API access token or a Dev Dashboard app.

- **Access token (simplest).** In Shopify Admin, go to Settings, then Apps and sales channels, then Develop apps. Create an app, grant the Admin API scopes `read_products`, `write_products`, `read_files` and `write_files`, install it, and copy the token (`shpat_...`).
- **Dev Dashboard app.** Create the app under **Apps**, not Catalogs. A Catalogs API key can only search products and cannot edit a store. Give the app the same scopes, install it on your store, and use its Client ID and Client Secret.

For the store address, use `your-store.myshopify.com`. If you enter your website domain instead, the app looks up the myshopify address for you.

## Product template

`templates/Shopify-Product-Template.xlsx` (also linked in step 2 of the app) has a column for every field the app can upload: identity, basic details, description, tags, collections, meta title, meta description, image name and alt text, variants and prices, and six example metafields.

- **Products** tab: fill this in. The app reads the first tab.
- **Example** tab: three finished products to copy from.
- **Guide** tab: what every column does, where it shows in Shopify, and its format.
- **Image Naming** and **Metafields** tabs: naming rules and metafield setup.

"Auto-fill from column names" in the app maps every template column by itself. Metafield columns are written as `Label (namespace.key)`, so you can add your own the same way.

## Finding products in Shopify

In step 3 you list one or more ways to find each product, for example "SKU equals the SKU column", then "Title equals the Product Title column". They are tried from top to bottom, and the first one that finds exactly one product is used. The results show which one found each product.

You can find products by SKU, Barcode, Handle, Title, Tag, or Shopify product ID (an admin link works too). Title matching ignores capital letters and extra spaces. Vendor cannot identify a product on its own, because many products share a vendor.

If a product is found by its title, that title column is not written back, so a different capitalisation in the sheet cannot rename it. To rename products, find them by SKU or handle and put the new title in the Title column.

## Updating only a few fields

Every column is optional. A sheet with just Product Title, Meta Title and Meta Description works: map those three, find products by Title, leave images on "No images", and only the meta title and description change. A product key such as AMC Name is only needed to group several variant rows into one product.

If the sheet has a title or notes above the column names, the app finds the real header row by itself. You can also type the row number in step 2.

## How the sheet should look

The first row holds the column names. A product with several variants has one row per variant, all with the same product key.

| AMC Name | Meta Name | Product Name | Supplier | Tags | Collections | Colour | Size | Price | SKU | Material |
|---|---|---|---|---|---|---|---|---|---|---|
| AMC-SOFA-001 | Oslo 3 Seater Sofa | Oslo 3 Seater Sofa | Urban Wood Co | sofa, living room | Sofas | Grey | 3 Seater | 1299 | OSLO-3S-GRY | Teak |
| AMC-SOFA-001 | Oslo 3 Seater Sofa | | | | | Blue | 3 Seater | 1299 | OSLO-3S-BLU | |

Product details such as title, description and tags come from the first row that has them, so later rows can leave them empty. Your column names can be anything; you map them in the app. A full example is in `sample/products-sample.csv`.

## How images are matched

An image belongs to a product when its file name matches the product's "Image name" column, for example "Meta Name". Upper and lower case, spaces, `-` and `_` do not matter.

| Image name in the sheet | Matching files | Order |
|---|---|---|
| Oslo 3 Seater Sofa | `Oslo 3 Seater Sofa.jpg` | first |
| | `oslo-3-seater-sofa_1.jpg`, `Oslo 3 Seater Sofa (2).png`, `Oslo 3 Seater Sofa-3.webp` | by number |

`Oslo 3 Seater Sofa Bed.jpg` does **not** match, because it is a different product. Sub-folders are searched too.

## Safety

- **Preview first.** "Check image matches" and "Preview changes" never save anything to Shopify.
- **Backups.** Before an existing product is changed, its current data is saved to `output/backups/`.
- **No duplicates on re-runs.** Products whose sheet rows have not changed are skipped, and images already on a product are not uploaded again. Tick "Re-send products that were already uploaded" to force it.
- **New products are created as Draft** unless you choose otherwise.
- **Product URLs (handles) are never changed** on existing products, so search rankings are not affected.
- **Empty cells never erase anything.** If the description cell is empty, Shopify keeps its current description.
- **Existing variants are kept** unless you untick "Keep existing variants that are not in the sheet".
- **Stop at any time.** The products already in progress finish, and the rest are left untouched.
- "Replace all existing images" removes every current image (and video) from the product. Use it with care.

## Not supported yet

- A separate image per variant. All images are added to the product.
- Adding products to automated (smart) collections. Shopify adds them through the collection's rules.
- Metafields that reference other objects, such as metaobjects or products.
- Inventory quantities.

## Common messages

| Message | What it means |
|---|---|
| `columns were not found in the sheet` | A mapped column name does not match the sheet. Check spelling and spaces. |
| `Not found in Shopify` | No product has that SKU, handle or title. Check "Find products by", or tick "Create products that are not in Shopify". |
| `Shopify refused the request (401/403)` | The token is wrong, or the app is missing `write_products` / `write_files`. |
| `is your website domain, not the Shopify admin address` | Enter the `xxxx.myshopify.com` address from Settings, then Domains. |
| `Google API error 403/404` | The Drive folder or sheet is not shared with the service account email. |
| `Could not pick one product` | The same SKU or title is used by two products. Fix it in Shopify. |
| `The app is not running` | The black window was closed. Start Open-App.bat again and refresh the page. |

## Command line

Everything the app does is also available from the command line, using `config.yaml` (copy it from `config.example.yaml`).

```
node src/index.js check
node src/index.js plan --limit 5
node src/index.js apply --only "AMC-SOFA-001"
```

The `command-line` folder has double-click shortcuts for these. Run `npm test` to run the automated tests against a simulated Shopify store; they never touch a real store.
