// A small fake of the Apps Script services the backend uses, so the real apps-script/*.gs files can
// run in Node: Sheets (with the "yyyy-MM-dd HH:00" → date auto-conversion), Script Properties,
// locks, triggers, UrlFetch (Telegram) and ContentService. Synthetic data only.
import fs from 'node:fs';
import vm from 'node:vm';

const pad = n => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOUR_TEXT = /^(\d{4})-(\d\d)-(\d\d) (\d\d):00$/;

class Formula {
  constructor(text) { this.text = text; }
  toString() { return '#ERROR!'; }
}

class Sheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows; this.textA = false; this.failNextSetValues = 0; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  appendRow(r) { this.rows.push(r.map((v, j) => this.store(v, j))); }
  deleteRow(i) { this.rows.splice(i - 1, 1); }
  deleteRows(i, n) { this.rows.splice(i - 1, n); }
  setFrozenRows() {}
  getDataRange() { return this.getRange(1, 1, this.rows.length, this.getLastColumn()); }
  // Sheets turns hour text into a date unless column A is formatted as text, and text starting
  // with = + - @ into a formula (#ERROR! when it isn't one); a leading apostrophe keeps text as text
  store(v, col) {
    if (typeof v === 'string' && v.startsWith("'")) return v.slice(1);
    if (typeof v === 'string' && /^[=+\-@]/.test(v)) return new Formula(v.startsWith('=') ? v : '=' + v);
    const m = col === 0 && !this.textA && typeof v === 'string' && HOUR_TEXT.exec(v);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4]) : v;
  }
  getRange(a, c, n = 1, w = 1) {
    const sheet = this;
    if (a === 'A:A') return { setNumberFormat: f => { sheet.textA = f === '@'; } };
    const read = () => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const row = sheet.rows[a - 1 + i] || [];
        const vals = [];
        for (let j = 0; j < w; j++) { const v = row[c - 1 + j]; vals.push(v === undefined || v === null ? '' : v instanceof Formula ? '#ERROR!' : v); }
        out.push(vals);
      }
      return out;
    };
    return {
      getValues: read,
      getFormulas: () => read().map((r, i) => r.map((v, j) => { const x = (sheet.rows[a - 1 + i] || [])[c - 1 + j]; return x instanceof Formula ? x.text : ''; })),
      getDisplayValues: () => read().map(r => r.map(String)),
      rawFormula: () => sheet.rows[a - 1] && sheet.rows[a - 1][c - 1],
      getValue: () => read()[0][0],
      getDisplayValue: () => String(read()[0][0]),
      setValue: v => { const row = sheet.rows[a - 1] || (sheet.rows[a - 1] = []); row[c - 1] = sheet.store(v, c - 1); },
      setValues: vals => {
        if (sheet.failNextSetValues > 0 && --sheet.failNextSetValues === 0) throw new Error('Simulated: run stopped (time limit)');
        vals.forEach((v, i) => {
          const row = sheet.rows[a - 1 + i] || (sheet.rows[a - 1 + i] = []);
          v.forEach((x, j) => { row[c - 1 + j] = sheet.store(x, c - 1 + j); });
        });
      },
      clearContent: () => { for (let i = 0; i < n; i++) { const row = sheet.rows[a - 1 + i]; if (row) for (let j = 0; j < w; j++) row[c - 1 + j] = ''; } },
      setNumberFormat: () => {},
    };
  }
}

class Spreadsheet {
  constructor(id) { this.id = id; this.sheets = [new Sheet('Sheet1')]; }
  getId() { return this.id; }
  getUrl() { return 'https://example.invalid/' + this.id; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
}

/** "M/D/YYYY H:MM:SS" like the logger sheet (India time; tests run with TZ=Asia/Kolkata). */
export function loggerTs(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${d.getHours()}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Loads Config.gs, Engine.gs, Summary.gs, Monitor.gs and Api.gs into a fresh context.
 * Returns { ctx, source (logger sheet), app (spreadsheet), props, triggers, sent (Telegram), setNow }.
 */
export function loadBackend({ env = 'uat', telegram = true } = {}) {
  const props = new Map(Object.entries({ ENV: env, GOOGLE_CLIENT_ID: 'test-client', SOURCE_ID: 'src', INVERTER_ID: 'inv' }));
  if (telegram) { props.set('TELEGRAM_BOT_TOKEN', 'test-token'); props.set('TELEGRAM_CHAT_ID', '42'); }
  const books = { src: new Spreadsheet('src') };
  const source = books.src.sheets[0];
  source.rows.push(['Timestamp', 'Voltage', 'Current', 'Power', 'Energy']);
  let triggers = [];
  // Drive: folders and files in memory
  const drive = { folders: {}, files: {}, n: 0 };
  const makeFile = (blob) => { const id = 'file' + (++drive.n); const f = { id, blob, trashed: false, getId: () => id, getName: () => blob.getName(), getBlob: () => blob, setTrashed: v => { f.trashed = v; } }; drive.files[id] = f; return f; };
  const makeBlob = (bytes, type, name) => ({ getBytes: () => bytes, getContentType: () => type, getName: () => name });
  const sent = [];
  let uuid = 0;
  const ctx = {
    console: { log() {}, error() {}, warn() {} }, JSON, Math, Date, Number, String, Object, Array, Error, Infinity, isFinite,
    Logger: { log() {} },
    Session: { getScriptTimeZone: () => 'Asia/Kolkata', getEffectiveUser: () => ({ getEmail: () => 'admin@example.com' }) },
    Utilities: {
      formatDate(d, tz, f) {
        if (f === 'yyyy-MM-dd HH:00') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
        if (f === 'dd MMM yyyy HH:mm') return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        throw new Error('format not faked: ' + f);
      },
      getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
      base64Decode: s => [...Buffer.from(s, 'base64')],
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
      newBlob: (bytes, type, name) => makeBlob(bytes, type, name),
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => { props.set(k, String(v)); },
      deleteProperty: k => { props.delete(k); },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }), getUserLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ScriptApp: {
      newTrigger: handler => {
        const t = { handler, getHandlerFunction: () => handler };
        const b = { timeBased: () => b, after: ms => { t.after = ms; return b; }, everyMinutes: m => { t.every = m * 60; return b; }, everyHours: h => { t.every = h * 3600; return b; }, create: () => { triggers.push(t); return t; } };
        return b;
      },
      getProjectTriggers: () => [...triggers],
      deleteTrigger: t => { triggers = triggers.filter(x => x !== t); },
    },
    SpreadsheetApp: {
      openById: id => { if (!books[id]) throw new Error('No sheet ' + id); return books[id]; },
      create: name => { const id = 'app-' + name; books[id] = new Spreadsheet(id); return books[id]; },
    },
    // Telegram: getMe accepts tokens ending "Valid…"; sendMessage refuses chat "999" (not found)
    UrlFetchApp: { fetch: (url, opts = {}) => {
      const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
      if (url.endsWith('/getMe')) return /Valid\w*\/getMe$/.test(url) ? reply(200, { ok: true, result: { username: 'pp_test_bot' } }) : reply(401, { ok: false, description: 'Unauthorized' });
      if (opts.payload && opts.payload.chat_id === '999') return reply(400, { ok: false, description: 'Bad Request: chat not found' });
      sent.push({ url, text: opts.payload.text, chat: opts.payload.chat_id });
      return reply(200, { ok: true });
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    DriveApp: {
      createFolder: name => { const id = 'folder' + (++drive.n); const folder = { id, name, getId: () => id, createFile: blob => makeFile(blob) }; drive.folders[id] = folder; return folder; },
      getFolderById: id => drive.folders[id],
      getFileById: id => { if (!drive.files[id]) throw new Error('No file ' + id); return drive.files[id]; },
    },
  };
  vm.createContext(ctx);
  // Every file, alphabetically (Access, Api, … Summary): a file must not need another one loaded first
  const dir = new URL('../../apps-script/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(new URL(`../../apps-script/${f}`, import.meta.url), 'utf8'), ctx, { filename: f });
  }
  return {
    ctx, source, props, sent, drive,
    /** Evaluates an expression inside the backend (top-level const/let aren't properties of ctx). */
    run: code => vm.runInContext(code, ctx),
    get triggers() { return triggers; },
    app: () => books[props.get('APP_SHEET_ID')],
    tab: name => books[props.get('APP_SHEET_ID')].getSheetByName(name),
    /** Runs every one-off "after" trigger for handler (as Apps Script would, a minute later) until none is left. */
    drain(handler, max = 50) {
      for (let i = 0; i < max; i++) {
        const t = triggers.find(x => x.handler === handler && x.after);
        if (!t) return i;
        ctx[handler]();
      }
      throw new Error('drain: ' + handler + ' never finished');
    },
  };
}

/**
 * Synthetic logger rows (1 per minute, India time) from startMs for `hours` hours: evening peak,
 * zero-load stretches (inverter), optional gaps, duplicate and out-of-order rows, one glitch.
 */
export function loggerRows(startMs, hours, { gaps = [], energy0 = 1000 } = {}) {
  const rows = [];
  let e = energy0;
  for (let m = 0; m < hours * 60; m++) {
    const ts = startMs + m * 60e3;
    const h = m / 60;
    if (gaps.some(([a, b]) => h >= a && h < b)) { e += 0.004; continue; }   // logger off, meter keeps counting
    const hourOfDay = new Date(ts).getHours();
    const zero = hourOfDay === 3;                                           // grid off 03:00–04:00
    const watts = zero ? 0 : hourOfDay >= 18 ? 900 : 300;
    e += watts / 60000;
    rows.push([loggerTs(ts), 230, zero ? 0 : watts / 230, zero ? 0 : watts, Math.round(e * 1000) / 1000]);
  }
  // a duplicate row, an out-of-order row and a one-off glitch (energy dips)
  if (rows.length > 300) {
    rows.splice(100, 0, rows[100].slice());
    const [late] = rows.splice(200, 1); rows.splice(205, 0, late);
    rows[250] = [rows[250][0], 230, 1, 230, rows[250][4] - 5];
  }
  return { rows, energyEnd: e };
}
