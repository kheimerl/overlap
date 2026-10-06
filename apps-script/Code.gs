/**
 * Overlap backend: a Google Sheet that stores encrypted, opaque blobs.
 *
 * Deploy: Deploy > New deployment > Web app, Execute as "Me", Who has access "Anyone".
 * Run setup() once (creates the sheets and the daily cleanup trigger) and selfTest()
 * once (checks that Sheets stores our values verbatim).
 *
 * The browser encrypts everything before sending it, so this script never sees
 * event titles, names, or availability. See README.md for the full protocol.
 *
 * @OnlyCurrentDoc
 */

const CONFIG = {
  POW_BITS: 16,                // must match js/config.js
  MAX_META: 6000,              // chars of encrypted event details
  MAX_BLOB: 4000,              // chars of one encrypted response
  MAX_PARTICIPANTS: 100,       // per event
  MAX_EVENTS: 5000,            // storage-wide caps; past these the service goes read-only
  MAX_RESPONSES: 20000,
  CREATES_PER_MINUTE: 30,      // new events, across everything
  WRITES_PER_MINUTE: 300,      // responses, across everything
  EVENT_WRITES_PER_MINUTE: 90, // responses, per event
  RETENTION_DAYS: 90,          // since last activity
};

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const BLOB_RE = /^[A-Za-z0-9_-]+$/;
const NONCE_RE = /^[0-9]{1,12}$/;

// events:    event | tokenHash | meta | created | updated
// responses: event | pid       | blob | updated
// The first three columns of each sheet are written as plain text so Sheets
// never turns an ID like "1e5..." or "-AB..." into a number or formula.
const TEXT_COLS = 3;

function doGet(e) {
  return reply_(() => {
    const id = e.parameter.event;
    check_(ID_RE.test(id), 'bad event id');
    const ev = findEvent_(id);
    check_(ev, 'event not found');
    return { meta: ev.values[2], responses: readResponses_(id) };
  });
}

function doPost(e) {
  return reply_(() => {
    const req = JSON.parse(e.postData.contents);
    if (req.action === 'create') return create_(req);
    if (req.action === 'respond') return saveResponse_(req);
    throw new Error('unknown action');
  });
}

function create_(req) {
  check_(ID_RE.test(req.event) && TOKEN_RE.test(req.tokenHash), 'bad request');
  check_(BLOB_RE.test(req.meta) && req.meta.length <= CONFIG.MAX_META, 'bad event details');
  check_(NONCE_RE.test(String(req.nonce)), 'bad nonce');
  check_(leadingZeroBits_(digest_(req.event + ':' + req.nonce)) >= CONFIG.POW_BITS, 'proof of work failed');
  return withLock_(() => {
    rateLimit_('create', CONFIG.CREATES_PER_MINUTE);
    const events = sheet_('events');
    check_(events.getLastRow() - 1 < CONFIG.MAX_EVENTS, 'storage is full');
    check_(!findEvent_(req.event), 'event already exists');
    const now = Date.now();
    writeRow_(events, events.getLastRow() + 1, [req.event, req.tokenHash, req.meta, now, now]);
    return {};
  });
}

function saveResponse_(req) {
  check_(ID_RE.test(req.event) && TOKEN_RE.test(req.token) && TOKEN_RE.test(req.psecret), 'bad request');
  check_(BLOB_RE.test(req.blob) && req.blob.length <= CONFIG.MAX_BLOB, 'bad response');
  const tokenHash = b64_(digest_(req.token));
  const pid = b64_(digest_(req.psecret)).slice(0, 22);
  // Reject requests without the link before taking the lock or charging a rate limit,
  // so strangers cannot use up the write budget for everyone else.
  const known = findEvent_(req.event);
  check_(known && known.values[1] === tokenHash, 'event not found');
  return withLock_(() => {
    rateLimit_('all', CONFIG.WRITES_PER_MINUTE);
    rateLimit_(req.event, CONFIG.EVENT_WRITES_PER_MINUTE);
    const ev = findEvent_(req.event);  // again under the lock: cleanup may have moved or removed it
    check_(ev, 'event not found');
    const responses = sheet_('responses');
    const mine = responseRows_(responses, req.event);
    const existing = mine.find(r => r.pid === pid);
    const now = Date.now();
    if (existing) {
      writeRow_(responses, existing.row, [req.event, pid, req.blob, now]);
    } else {
      check_(mine.length < CONFIG.MAX_PARTICIPANTS, 'this event is full');
      check_(responses.getLastRow() - 1 < CONFIG.MAX_RESPONSES, 'storage is full');
      writeRow_(responses, responses.getLastRow() + 1, [req.event, pid, req.blob, now]);
    }
    sheet_('events').getRange(ev.row, 5).setValue(now);
    return { pid };
  });
}

// ---- storage helpers ----

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  check_(sh, 'backend not set up: run setup()');
  return sh;
}

function column_(sh, col) {
  const n = sh.getLastRow() - 1;
  return n < 1 ? [] : sh.getRange(2, col, n, 1).getValues().map(r => r[0]);
}

function findEvent_(id) {
  const sh = sheet_('events');
  const i = column_(sh, 1).indexOf(id);
  return i < 0 ? null : { row: i + 2, values: sh.getRange(i + 2, 1, 1, 5).getValues()[0] };
}

function responseRows_(sh, id) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const out = [];
  sh.getRange(2, 1, n, 2).getValues().forEach((r, i) => {
    if (r[0] === id) out.push({ row: i + 2, pid: r[1] });
  });
  return out;
}

function readResponses_(id) {
  const sh = sheet_('responses');
  const rows = responseRows_(sh, id);
  if (!rows.length) return [];
  // Responses to one event are usually written close together, so read only the span covering them.
  const first = rows[0].row, last = rows[rows.length - 1].row;
  const blobs = sh.getRange(first, 3, last - first + 1, 1).getValues();
  return rows.map(r => ({ pid: r.pid, blob: blobs[r.row - first][0] }));
}

function writeRow_(sh, row, values) {
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 500);
  sh.getRange(row, 1, 1, TEXT_COLS).setNumberFormat('@');
  sh.getRange(row, 1, 1, values.length).setValues([values]);
}

// ---- guards ----

function check_(cond, message) {
  if (!cond) throw new Error(message);
}

function withLock_(fn, waitMs) {
  const lock = LockService.getScriptLock();
  check_(lock.tryLock(waitMs || 5000), 'server busy, try again');
  try {
    const out = fn();
    SpreadsheetApp.flush();  // commit buffered writes so the next lock holder sees them
    return out;
  } finally {
    lock.releaseLock();
  }
}

// Fixed-window counter; only called while holding the script lock, so get+put is atomic.
function rateLimit_(key, max) {
  const cache = CacheService.getScriptCache();
  const k = 'rl:' + key + ':' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(k) || 0) + 1;
  check_(n <= max, 'too many requests, try again in a minute');
  cache.put(k, String(n), 120);
}

function digest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
}

function b64_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

// computeDigest returns signed bytes (-128..127).
function leadingZeroBits_(bytes) {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] & 0xff;
    if (b !== 0) return n + Math.clz32(b) - 24;
    n += 8;
  }
  return n;
}

function reply_(fn) {
  let out;
  try {
    out = Object.assign({ ok: true }, fn());
  } catch (err) {
    out = { ok: false, error: err.message || String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ---- maintenance: run these from the Apps Script editor ----

function setup() {
  const ss = SpreadsheetApp.getActive();
  [['events', ['event', 'tokenHash', 'meta', 'created', 'updated']],
   ['responses', ['event', 'pid', 'blob', 'updated']]].forEach(([name, headers]) => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  });
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'cleanup')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(3).create();
  Logger.log('setup complete');
}

// Deletes events with no activity in RETENTION_DAYS, plus their responses.
function cleanup() {
  withLock_(() => {
    const cutoff = Date.now() - CONFIG.RETENTION_DAYS * 864e5;
    const events = sheet_('events'), responses = sheet_('responses');
    const keep = dataRows_(events).filter(r => Number(r[4]) >= cutoff);
    const live = new Set(keep.map(r => r[0]));
    rewrite_(events, keep);
    rewrite_(responses, dataRows_(responses).filter(r => live.has(r[0])));
  }, 30000);
}

function dataRows_(sh) {
  const n = sh.getLastRow() - 1;
  return n < 1 ? [] : sh.getRange(2, 1, n, sh.getLastColumn()).getValues();
}

function rewrite_(sh, rows) {
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, sh.getLastColumn()).clearContent();
  if (!rows.length) return;
  sh.getRange(2, 1, rows.length, TEXT_COLS).setNumberFormat('@');
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

// Checks the assumptions this script makes about Sheets and Utilities. Run once after setup().
function selfTest() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.insertSheet('selftest_' + Date.now());
  try {
    const tricky = ['-AbC', '0012', '1e5', 'TRUE', 'false', '2026-10-05', '12-25', 'x'.repeat(CONFIG.MAX_META)];
    tricky.forEach((v, i) => writeRow_(sh, i + 1, [v, 'ok', 'ok', 1759700000000]));
    const back = sh.getRange(1, 1, tricky.length, 4).getValues();
    tricky.forEach((v, i) => {
      check_(back[i][0] === v, 'Sheets changed "' + v.slice(0, 20) + '" into ' + JSON.stringify(back[i][0]).slice(0, 40));
      check_(back[i][3] === 1759700000000, 'timestamp came back as ' + JSON.stringify(back[i][3]));
    });
    check_(b64_(digest_('abc')) === 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0', 'SHA-256 mismatch');
    check_(leadingZeroBits_(digest_('abc')) === 0, 'leadingZeroBits mismatch');
    Logger.log('selfTest passed');
  } finally {
    ss.deleteSheet(sh);
  }
}
