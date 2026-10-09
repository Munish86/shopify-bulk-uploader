import crypto from 'node:crypto';
import fs from 'node:fs';
import { sleep } from './util.js';

const b64url = (s) => Buffer.from(s).toString('base64url');
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly';

// Reads Google Drive / Sheets with a service account (JSON key) or an API key. Read-only access.
export class Google {
  constructor(cfg) {
    this.apiKey = cfg.api_key || '';
    this.sa = null;
    if (cfg.service_account_file) {
      if (!fs.existsSync(cfg.service_account_file)) throw new Error(`Google service account file not found: ${cfg.service_account_file}`);
      this.sa = JSON.parse(fs.readFileSync(cfg.service_account_file, 'utf8'));
    }
    this._tok = null;
  }

  get enabled() {
    return !!(this.sa || this.apiKey);
  }

  async token() {
    if (!this.sa) return null;
    if (this._tok && this._tok.exp > Date.now() + 60_000) return this._tok.value;
    const aud = this.sa.token_uri || 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({ iss: this.sa.client_email, scope: SCOPES, aud, iat: now, exp: now + 3600 }));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${head}.${claim}`);
    const sig = signer.sign(this.sa.private_key).toString('base64url');
    const res = await fetch(aud, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Google sign-in failed: ${JSON.stringify(body)}`);
    this._tok = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
    return this._tok.value;
  }

  async get(url, { asBuffer = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const u = new URL(url);
      const headers = {};
      const t = await this.token();
      if (t) headers.authorization = `Bearer ${t}`;
      else if (this.apiKey) u.searchParams.set('key', this.apiKey);
      const res = await fetch(u, { headers });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 400);
        let hint = '';
        if (res.status === 403 || res.status === 404) {
          hint = this.sa
            ? `\nHave you shared the Drive folder / Sheet with this email? ${this.sa.client_email}`
            : '\nThe folder / Sheet must be shared as "Anyone with the link".';
        }
        throw new Error(`Google API error ${res.status}: ${text}${hint}`);
      }
      return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.json();
    }
  }
}

// Accepts a full link or a bare ID
export function driveFolderId(ref) {
  const m = String(ref).match(/folders\/([\w-]+)/) || String(ref).match(/[?&]id=([\w-]+)/);
  return m ? m[1] : String(ref).trim();
}

export function sheetRef(ref) {
  const s = String(ref);
  const id = (s.match(/\/d\/([\w-]+)/) || [])[1] || s.trim();
  const gid = (s.match(/[#&?]gid=(\d+)/) || [])[1] || '';
  return { id, gid };
}
