// Thin client for the Apps Script web app. Requests are kept "simple" in CORS
// terms (GET, or POST with a text/plain body and no custom headers) because
// Apps Script cannot answer a preflight.
import * as core from './core.js';

export function createApi(baseUrl) {
  async function call(promise) {
    const res = await promise;
    if (!res.ok) throw new Error(`server error (${res.status})`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'request failed');
    return data;
  }

  const post = body => call(fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  }));

  return {
    // Returns { meta, responses: [{ pid, blob }] }, still encrypted.
    load: ev => call(fetch(`${baseUrl}?event=${ev.id}`, { cache: 'no-store' })),

    async create(ev, meta, powBits) {
      const nonce = await core.proofOfWork(ev.id, powBits);
      const blob = await core.encryptJSON(ev, 'meta', meta);
      return post({ action: 'create', event: ev.id, tokenHash: ev.tokenHash, meta: blob, nonce });
    },

    async respond(ev, psecret, response) {
      const blob = await core.encryptJSON(ev, 'response', response);
      return post({ action: 'respond', event: ev.id, token: ev.token, psecret, blob });
    },
  };
}

// Decrypts a load() result. Rows that fail to decrypt or validate are skipped
// so one bad row cannot break the page.
export async function openEvent(ev, data) {
  const meta = core.validateMeta(await core.decryptJSON(ev, 'meta', data.meta));
  const responses = [];
  for (const row of data.responses) {
    try {
      const r = core.validateResponse(await core.decryptJSON(ev, 'response', row.blob), meta);
      responses.push({ pid: row.pid, ...r });
    } catch (err) {
      console.warn('skipping unreadable response', row.pid, err.message);
    }
  }
  return { meta, responses };
}
