import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../js/core.js';

test('base64url round-trips and rejects junk', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    assert.deepEqual(core.fromB64url(core.toB64url(bytes)), bytes);
  }
  assert.throws(() => core.fromB64url('ab+c'));
  assert.throws(() => core.fromB64url('=x'));
});

test('bitsets round-trip and enforce grid size', () => {
  const bits = Array.from({ length: 77 }, () => Math.random() < 0.5 ? 1 : 0);
  assert.deepEqual(core.unpackBits(core.packBits(bits), 77), bits);
  assert.throws(() => core.unpackBits(core.packBits(bits), 200), /size mismatch/);
});

test('derived values have the lengths the server expects', async () => {
  const ev = await core.deriveEvent(core.newEventKey());
  assert.match(ev.id, /^[A-Za-z0-9_-]{22}$/);
  assert.match(ev.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(ev.tokenHash, /^[A-Za-z0-9_-]{43}$/);
  const s = await core.participantSecret(ev, '  Ada   Lovelace ', '');
  assert.equal(s, await core.participantSecret(ev, 'ada lovelace', ''));
  assert.notEqual(s, await core.participantSecret(ev, 'ada lovelace', 'pw'));
  assert.match(s, /^[A-Za-z0-9_-]{43}$/);
});

test('encryption binds the blob kind', async () => {
  const ev = await core.deriveEvent(core.newEventKey());
  const blob = await core.encryptJSON(ev, 'response', { a: 1 });
  assert.deepEqual(await core.decryptJSON(ev, 'response', blob), { a: 1 });
  await assert.rejects(core.decryptJSON(ev, 'meta', blob));
  const other = await core.deriveEvent(core.newEventKey());
  await assert.rejects(core.decryptJSON(other, 'response', blob));
});

test('zonedToUtc handles DST and half-hour zones', () => {
  const iso = ms => new Date(ms).toISOString().slice(0, 16);
  assert.equal(iso(core.zonedToUtc('2026-03-07', 540, 'America/Los_Angeles')), '2026-03-07T17:00');
  assert.equal(iso(core.zonedToUtc('2026-03-08', 540, 'America/Los_Angeles')), '2026-03-08T16:00');
  assert.equal(iso(core.zonedToUtc('2026-11-01', 540, 'America/Los_Angeles')), '2026-11-01T17:00');
  assert.equal(iso(core.zonedToUtc('2026-10-05', 0, 'Asia/Kolkata')), '2026-10-04T18:30');
  assert.equal(iso(core.zonedToUtc('2026-10-05', 1440, 'UTC')), '2026-10-06T00:00');
});

test('meta validation', () => {
  const ok = { title: 't', dates: ['2026-10-05'], start: 540, end: 1020, step: 30, tz: 'America/Los_Angeles' };
  assert.equal(core.validateMeta(ok), ok);
  assert.equal(core.slotCount(ok), 16);
  for (const bad of [{ ...ok, step: 7 }, { ...ok, end: 530 }, { ...ok, tz: 'Mars/Base' }, { ...ok, dates: [] }, { ...ok, start: 545 }]) {
    assert.throws(() => core.validateMeta(bad));
  }
});

test('formatting', () => {
  assert.equal(core.formatMinutes(0), '12 AM');
  assert.equal(core.formatMinutes(570), '9:30 AM');
  assert.equal(core.formatMinutes(720), '12 PM');
  assert.equal(core.formatMinutes(1440), '12 AM');
  assert.equal(core.formatDate('2026-10-05'), 'Mon, Oct 5');
});
