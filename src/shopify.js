import { norm, sleep } from './util.js';

const PRODUCT_FIELDS = `
  id handle title status tags vendor productType descriptionHtml
  seo { title description }
  options { name optionValues { name } }
  variants(first: 250) { nodes { id sku price compareAtPrice barcode selectedOptions { name value } } }
  media(first: 250) { nodes { id alt mediaContentType ... on MediaImage { image { url } } } }
  collections(first: 250) { nodes { id title ruleSet { appliedDisjunctively } } }
`;

const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function flatten(p) {
  if (!p) return null;
  return {
    ...p,
    variants: p.variants?.nodes || [],
    media: p.media?.nodes || [],
    collections: p.collections?.nodes || [],
    options: p.options || [],
  };
}

export class Shopify {
  constructor(cfg) {
    const store = String(cfg.store || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!store) throw new Error('Enter your Shopify store address (for example "your-store.myshopify.com").');
    this.store = store.includes('.') ? store : `${store}.myshopify.com`;
    this.cfg = cfg;
    this.endpoint = process.env.SHOPIFY_ENDPOINT_OVERRIDE || `https://${this.store}/admin/api/${cfg.api_version}/graphql.json`;
  }

  // If a website domain was entered (like www.amcfurniture.co.uk), find the xxx.myshopify.com behind it.
  // The Admin API only works on the myshopify.com address.
  async resolveStore() {
    if (process.env.SHOPIFY_ENDPOINT_OVERRIDE || /\.myshopify\.com$/i.test(this.store)) return;
    let found = '';
    try {
      const res = await fetch(`https://${this.store}/`, {
        headers: { 'user-agent': 'Mozilla/5.0 shopify-bulk-uploader' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const html = await res.text();
      found =
        (html.match(/Shopify\.shop\s*=\s*["']([a-z0-9-]+\.myshopify\.com)["']/i) || [])[1] ||
        (html.match(/"myshopifyDomain"\s*:\s*"([a-z0-9-]+\.myshopify\.com)"/i) || [])[1] ||
        (html.match(/\b([a-z0-9][a-z0-9-]*\.myshopify\.com)\b/i) || [])[1] ||
        '';
    } catch {
      /* handled below */
    }
    if (!found) {
      throw new Error(
        `"${this.store}" is your website domain, not the Shopify admin address. ` +
          'Enter the "xxxx.myshopify.com" address instead. You can find it in Shopify Admin under Settings, then Domains.'
      );
    }
    this.domainNote = `"${this.store}" uses the Shopify address "${found}".`;
    this.store = found.toLowerCase();
    this.endpoint = `https://${this.store}/admin/api/${this.cfg.api_version}/graphql.json`;
  }

  async init() {
    await this.resolveStore();
    if (this.cfg.access_token) {
      this.token = this.cfg.access_token;
    } else if (this.cfg.client_id && this.cfg.client_secret) {
      // Dev Dashboard app: exchange client id + secret for a token
      const url = process.env.SHOPIFY_TOKEN_URL_OVERRIDE || `https://${this.store}/admin/oauth/access_token`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: this.cfg.client_id, client_secret: this.cfg.client_secret, grant_type: 'client_credentials' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.access_token) {
        const why = body.error_description || body.error || body.errors || '';
        throw new Error(
          `Shopify did not issue a token for this Client ID / Secret (${res.status}${why ? `: ${typeof why === 'string' ? why : JSON.stringify(why)}` : ''}). ` +
            'Common causes: (1) it is a Dev Dashboard "Catalogs" API key, which only searches products and cannot edit a store. ' +
            'Create an app under "Apps" in the Dev Dashboard, give it Admin API scopes, and install it on this store. ' +
            '(2) The app is not installed on this store. (3) The secret was copied incorrectly.'
        );
      }
      this.token = body.access_token;
    } else {
      throw new Error('Enter an Admin API access token, or a Client ID and Client Secret.');
    }
    const d = await this.gql(`{ shop { name myshopifyDomain currencyCode } }`);
    this.shop = d.shop;
    this.adminBase = `https://admin.shopify.com/store/${d.shop.myshopifyDomain.replace('.myshopify.com', '')}`;
    return d.shop;
  }

  // Which permissions the token has. Returns null if Shopify does not say.
  async scopes() {
    try {
      const d = await this.gql('{ currentAppInstallation { accessScopes { handle } } }');
      return d.currentAppInstallation.accessScopes.map((s) => s.handle);
    } catch {
      return null;
    }
  }

  adminUrl(gid) {
    return gid ? `${this.adminBase}/products/${String(gid).split('/').pop()}` : '';
  }

  async gql(query, variables = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-shopify-access-token': this.token },
          body: JSON.stringify({ query, variables }),
        });
      } catch (e) {
        if (attempt < 5) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw e;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Shopify refused the request (${res.status}). The access token is wrong, or the app lacks write_products / write_files permission.`);
      }
      if (res.status === 404) throw new Error(`Shopify store or API version not found (404). Check the store address and API version: ${this.endpoint}`);
      const body = await res.json();
      if (body.errors) {
        const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
        if (throttled && attempt < 10) {
          await sleep(2000);
          continue;
        }
        const err = new Error(`Shopify error: ${JSON.stringify(body.errors).slice(0, 600)}`);
        err.graphqlErrors = body.errors;
        throw err;
      }
      // Close to the rate limit: wait a little
      const t = body.extensions?.cost?.throttleStatus;
      if (t && t.currentlyAvailable < 300) await sleep(((300 - t.currentlyAvailable) / (t.restoreRate || 50)) * 1000);
      return body.data;
    }
  }

  async getProduct(id) {
    const d = await this.gql(`query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id });
    return flatten(d.product);
  }

  // by = sku | barcode | handle | title | tag | id. values = values from this product's rows.
  // Matching ignores capital letters and extra spaces/symbols in titles.
  async findProduct(by, values) {
    const wanted = [...new Set(values.filter(Boolean).map((v) => String(v).trim()))];
    if (by === 'sku' || by === 'barcode') {
      for (const v of wanted) {
        const d = await this.gql(
          `query($q: String!) { productVariants(first: 10, query: $q) { nodes { sku barcode product { ${PRODUCT_FIELDS} } } } }`,
          { q: `${by}:${q(v)}` }
        );
        const hits = d.productVariants.nodes.filter((n) => String(n[by] || '').trim().toLowerCase() === v.toLowerCase());
        const ids = [...new Set(hits.map((h) => h.product.id))];
        if (ids.length > 1) return { ambiguous: `${by.toUpperCase()} "${v}" is used by ${ids.length} different products` };
        if (hits.length) return { product: flatten(hits[0].product) };
      }
      return { product: null };
    }
    if (by === 'id') {
      for (const v of wanted) {
        const num = (v.match(/(\d{6,})\s*$/) || v.match(/products\/(\d+)/) || [])[1];
        if (!num) continue;
        const p = await this.getProduct(`gid://shopify/Product/${num}`);
        if (p) return { product: p };
      }
      return { product: null };
    }
    for (const v of wanted) {
      const query = by === 'handle' ? `handle:${q(v)}` : by === 'tag' ? `tag:${q(v)}` : `title:${q(v)}`;
      const d = await this.gql(`query($q: String!) { products(first: 10, query: $q) { nodes { ${PRODUCT_FIELDS} } } }`, { q: query });
      const hits = d.products.nodes.filter((p) =>
        by === 'handle' ? p.handle === v.toLowerCase() : by === 'tag' ? p.tags.some((t) => norm(t) === norm(v)) : norm(p.title) === norm(v)
      );
      if (hits.length > 1) {
        return { ambiguous: by === 'tag' ? `${hits.length} products have the tag "${v}"` : `${hits.length} products are called "${v}"` };
      }
      if (hits.length) return { product: flatten(hits[0]) };
    }
    return { product: null };
  }

  async loadCollections() {
    const map = new Map();
    let after = null;
    do {
      const d = await this.gql(
        `query($after: String) { collections(first: 250, after: $after) {
           pageInfo { hasNextPage endCursor } nodes { id title handle ruleSet { appliedDisjunctively } } } }`,
        { after }
      );
      for (const c of d.collections.nodes) {
        const col = { id: c.id, title: c.title, handle: c.handle, smart: !!c.ruleSet };
        map.set(norm(c.title), col);
        if (!map.has(norm(c.handle))) map.set(norm(c.handle), col);
      }
      after = d.collections.pageInfo.hasNextPage ? d.collections.pageInfo.endCursor : null;
    } while (after);
    return map;
  }

  async createCollection(title) {
    const d = await this.gql(
      `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id title handle } userErrors { field message } } }`,
      { input: { title } }
    );
    const r = d.collectionCreate;
    if (r.userErrors.length) throw new Error(`Could not create collection "${title}": ${r.userErrors.map((e) => e.message).join('; ')}`);
    return { id: r.collection.id, title: r.collection.title, handle: r.collection.handle, smart: false };
  }

  async addToCollection(collectionId, productId) {
    const d = await this.gql(
      `mutation($id: ID!, $p: [ID!]!) { collectionAddProducts(id: $id, productIds: $p) { userErrors { field message } } }`,
      { id: collectionId, p: [productId] }
    );
    const errs = d.collectionAddProducts.userErrors;
    if (errs.length && !errs.every((e) => /already/i.test(e.message))) throw new Error(errs.map((e) => e.message).join('; '));
  }

  // Uploads an image to Shopify's temporary storage and returns its URL (used by productSet / productUpdate)
  async stageImage(buffer, filename, mimeType) {
    const d = await this.gql(
      `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
         stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
      { input: [{ resource: 'IMAGE', filename, mimeType, httpMethod: 'POST', fileSize: String(buffer.length) }] }
    );
    const r = d.stagedUploadsCreate;
    if (r.userErrors.length) throw new Error(`Could not prepare image upload: ${r.userErrors.map((e) => e.message).join('; ')}`);
    const target = r.stagedTargets[0];
    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append('file', new Blob([buffer], { type: mimeType }), filename);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(target.url, { method: 'POST', body: form });
      if (res.ok) break;
      if (attempt < 3 && res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(`Upload of image "${filename}" failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    return target.resourceUrl;
  }

  async productSet(input) {
    const out = `product { id handle title } userErrors { field message code }`;
    let d;
    try {
      d = await this.gql(`mutation($input: ProductSetInput!) { productSet(synchronous: true, input: $input) { ${out} } }`, { input });
    } catch (e) {
      // Newer API versions identify an existing product through the "identifier" argument
      const noIdField = input.id && e.graphqlErrors?.some((x) => /ProductSetInput/.test(x.message) && /\bid\b/.test(x.message));
      if (!noIdField) throw e;
      const { id, ...rest } = input;
      d = await this.gql(
        `mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
           productSet(synchronous: true, input: $input, identifier: $identifier) { ${out} } }`,
        { input: rest, identifier: { id } }
      );
    }
    const r = d.productSet;
    if (r.userErrors.length) {
      throw new Error(`Product not saved: ${r.userErrors.map((e) => `${(e.field || []).join('.')} ${e.message}`).join('; ')}`);
    }
    return r.product;
  }

  // Adds new images to an existing product without touching its current images
  async appendMedia(productId, media) {
    const d = await this.gql(
      `mutation($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
         productUpdate(product: $product, media: $media) { product { id } userErrors { field message } } }`,
      { product: { id: productId }, media }
    );
    const errs = d.productUpdate.userErrors;
    if (errs.length) throw new Error(`Images not added: ${errs.map((e) => e.message).join('; ')}`);
  }

  async metafieldsSet(ownerId, metafields) {
    for (let i = 0; i < metafields.length; i += 25) {
      const chunk = metafields.slice(i, i + 25).map((m) => ({ ownerId, ...m }));
      const d = await this.gql(
        `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { key namespace } userErrors { field message code } } }`,
        { m: chunk }
      );
      const errs = d.metafieldsSet.userErrors;
      if (errs.length) throw new Error(`Metafield not saved: ${errs.map((e) => `${(e.field || []).join('.')} ${e.message}`).join('; ')}`);
    }
  }
}
