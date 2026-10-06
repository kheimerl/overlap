// Pure helpers shared by the browser app and the Node tests. No DOM access here.
//
// Everything the server stores is derived from a 16-byte event key that only
// ever lives in the URL fragment:
//   id        = HKDF(key, "id")      -> row key on the server
//   token     = HKDF(key, "write")   -> proves knowledge of the link; server keeps SHA-256(token)
//   aes       = HKDF(key, "enc")     -> AES-GCM key for the event details and every response
//   psecret   = HKDF(key, "participant" + name + password)
//   pid       = SHA-256(psecret)     -> computed by the server, so only the secret holder can edit a row

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const MAX_DATES = 60;
export const MAX_NAME = 60;
export const STEPS = [15, 30, 60];

// ---- encoding ----

export function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export async function sha256B64(text) {
  return toB64url(new Uint8Array(await subtle.digest('SHA-256', enc.encode(text))));
}

// ---- keys ----

export function newEventKey() {
  return toB64url(crypto.getRandomValues(new Uint8Array(16)));
}

async function hkdf(base, info, length) {
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('overlap/v1/' + info) },
    base, length * 8);
  return new Uint8Array(bits);
}

export async function deriveEvent(key) {
  const raw = fromB64url(key);
  if (raw.length !== 16) throw new Error('bad event key');
  const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  const id = toB64url(await hkdf(base, 'id', 16));
  const token = toB64url(await hkdf(base, 'write', 32));
  const aes = await subtle.importKey('raw', await hkdf(base, 'enc', 16), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, id, token, tokenHash: await sha256B64(token), aes, base };
}

export function normalizeName(name) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function participantSecret(ev, name, password) {
  return toB64url(await hkdf(ev.base, `participant\0${normalizeName(name)}\0${password || ''}`, 32));
}

export async function pidFor(secret) {
  return (await sha256B64(secret)).slice(0, 22);
}

// ---- encryption ----

// `kind` is bound as associated data so a response blob can never be passed off as event details.
export async function encryptJSON(ev, kind, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(kind) }, ev.aes, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64url(out);
}

export async function decryptJSON(ev, kind, blob) {
  const bytes = fromB64url(blob);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(kind) }, ev.aes, bytes.slice(12));
  return JSON.parse(dec.decode(pt));
}

// ---- event details and responses ----

export function validateMeta(m) {
  const ok = m && typeof m.title === 'string' && m.title.length <= 200
    && Array.isArray(m.dates) && m.dates.length >= 1 && m.dates.length <= MAX_DATES
    && m.dates.every(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    && STEPS.includes(m.step)
    && Number.isInteger(m.start) && Number.isInteger(m.end)
    && m.start >= 0 && m.start < m.end && m.end <= 1440 && (m.end - m.start) % m.step === 0
    && typeof m.tz === 'string' && isTimeZone(m.tz);
  if (!ok) throw new Error('invalid event details');
  return m;
}

export const slotsPerDay = m => (m.end - m.start) / m.step;
export const slotCount = m => m.dates.length * slotsPerDay(m);

// Per-slot states in decoded responses.
export const NO = 0, YES = 1, IF_NEEDED = 2;

// Responses carry one bitset for "available" and one for "if needed";
// older responses without `maybe` decode as available/unavailable only.
export function encodeAvail(states) {
  return { avail: packBits(states.map(v => v === YES)), maybe: packBits(states.map(v => v === IF_NEEDED)) };
}

export function validateResponse(r, meta) {
  if (!r || typeof r.name !== 'string' || !r.name.trim() || r.name.length > MAX_NAME) throw new Error('bad name');
  const n = slotCount(meta);
  const yes = unpackBits(r.avail, n);
  const maybe = r.maybe === undefined ? null : unpackBits(r.maybe, n);
  return { name: r.name.trim(), avail: yes.map((v, i) => v ? YES : maybe?.[i] ? IF_NEEDED : NO) };
}

// Slots are indexed day-major: index = dayIndex * slotsPerDay + slotIndex.
export function packBits(bits) {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return toB64url(out);
}

export function unpackBits(str, n) {
  const bytes = fromB64url(str);
  if (bytes.length !== Math.ceil(n / 8)) throw new Error('availability size mismatch');
  return Array.from({ length: n }, (_, i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1);
}

// ---- anti-spam proof of work for event creation ----

export function leadingZeroBits(bytes) {
  let n = 0;
  for (const b of bytes) {
    if (b !== 0) return n + Math.clz32(b) - 24;
    n += 8;
  }
  return n;
}

export async function proofOfWork(id, bits, batch = 512) {
  for (let nonce = 0; ; nonce += batch) {
    const hashes = await Promise.all(Array.from({ length: batch },
      (_, k) => subtle.digest('SHA-256', enc.encode(`${id}:${nonce + k}`))));
    const hit = hashes.findIndex(h => leadingZeroBits(new Uint8Array(h)) >= bits);
    if (hit >= 0) return nonce + hit;
  }
}

// ---- time ----

export function isTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function tzOffsetMinutes(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map(x => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - utcMs) / 60000);
}

// Wall-clock time `minutes` after midnight on `date` in `tz`, as a UTC timestamp.
export function zonedToUtc(date, minutes, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, 0, minutes);
  const guess = wall - tzOffsetMinutes(wall, tz) * 60000;
  return wall - tzOffsetMinutes(guess, tz) * 60000;  // second pass settles DST transitions
}

export function formatMinutes(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  const h12 = h % 12 || 12, ampm = h < 12 ? 'AM' : 'PM';
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`;
}

export function formatDate(date, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const [y, mo, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(Date.UTC(y, mo - 1, d));
}
