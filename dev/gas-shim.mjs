// Minimal in-memory stand-ins for the Apps Script services Code.gs uses, so the
// real backend code runs under Node for local development and tests.
// Quirks we depend on are reproduced deliberately:
//   - computeDigest returns signed bytes; base64EncodeWebSafe keeps '=' padding
//   - cells not formatted as plain text ("@") get Sheets-style coercion on write
//   - getRange past getMaxRows() throws
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function coerce(value, format) {
  if (typeof value !== 'string' || format === '@') return format === '@' ? String(value) : value;
  if (value.startsWith('=')) return '#ERROR!';
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (value.trim() !== '' && !isNaN(Number(value))) return Number(value);
  return value;
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.cells = [];  // cells[r][c] = { v, f }
    this.maxRows = 1000;
  }
  cell(r, c) {
    const row = (this.cells[r] ??= []);
    return (row[c] ??= { v: '', f: '' });
  }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.cells.length - 1; r >= 0; r--) {
      if (this.cells[r]?.some(x => x && x.v !== '')) return r + 1;
    }
    return 0;
  }
  getLastColumn() {
    return Math.max(0, ...this.cells.map(row => {
      if (!row) return 0;
      for (let c = row.length - 1; c >= 0; c--) if (row[c] && row[c].v !== '') return c + 1;
      return 0;
    }));
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; return this; }
  setFrozenRows() { return this; }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1 || row + numRows - 1 > this.maxRows) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    return new Range(this, row - 1, col - 1, numRows, numCols);
  }
}

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  each(fn) {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.sheet.cell(this.r + i, this.c + j), i, j);
  }
  getRow() { return this.r + 1; }
  getValues() {
    const out = Array.from({ length: this.nr }, () => new Array(this.nc));
    this.each((cell, i, j) => { out[i][j] = cell.v; });
    return out;
  }
  setValues(values) {
    if (values.length !== this.nr || values.some(row => row.length !== this.nc)) {
      throw new Error('The number of rows or columns in the data does not match the range.');
    }
    this.each((cell, i, j) => { cell.v = coerce(values[i][j], cell.f); });
    return this;
  }
  setValue(v) { return this.setValues(Array.from({ length: this.nr }, () => new Array(this.nc).fill(v))); }
  setNumberFormat(f) { this.each(cell => { cell.f = f; }); return this; }
  clearContent() { this.each(cell => { cell.v = ''; }); return this; }
}

export function createGasContext() {
  const sheets = new Map();
  const cache = new Map();
  const triggers = [];
  const spreadsheet = {
    getSheetByName: name => sheets.get(name) ?? null,
    insertSheet: name => { const s = new Sheet(name); sheets.set(name, s); return s; },
    deleteSheet: s => { sheets.delete(s.name); },
  };
  const trigger = handler => ({ getHandlerFunction: () => handler });
  const ctx = {
    SpreadsheetApp: { getActive: () => spreadsheet, flush() {} },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => Array.from(new Int8Array(createHash(alg).update(text, 'utf8').digest())),
      base64EncodeWebSafe: bytes => Buffer.from(Uint8Array.from(bytes, b => b & 0xff)).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_'),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: content => ({ content, mime: 'text/plain', setMimeType(m) { this.mime = m; return this; }, getContent() { return this.content; } }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    CacheService: {
      getScriptCache: () => ({
        get: k => { const e = cache.get(k); return e && e.exp > Date.now() ? e.v : null; },
        put: (k, v, ttl = 600) => { cache.set(k, { v: String(v), exp: Date.now() + ttl * 1000 }); },
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: handler => {
        const b = { timeBased: () => b, everyDays: () => b, atHour: () => b, create: () => { const t = trigger(handler); triggers.push(t); return t; } };
        return b;
      },
    },
    Logger: { log: (...a) => console.log('[gas]', ...a) },
    console,
  };
  return { ctx, sheets, cache, triggers };
}

// Loads Code.gs into a fresh sandbox and returns its globals (doGet, doPost, setup, ...).
export function loadBackend(codePath = new URL('../apps-script/Code.gs', import.meta.url)) {
  const gas = createGasContext();
  const context = vm.createContext(gas.ctx);
  vm.runInContext(readFileSync(codePath, 'utf8'), context, { filename: 'Code.gs' });
  return { gas, global: context };
}
