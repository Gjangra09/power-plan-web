/**
 * Hourly energy snapshots for the dashboard.
 *
 * Every 15 minutes (30 in UAT) the tail of the logger sheet is cleaned with the same rules as Power BI
 * (Sheet1.tmdl): zero-load rows dropped, glitches hold the last good value, counter resets
 * carry the old total forward. The cleaned, never-decreasing energy at the last reading of
 * each hour is kept in the Hourly tab, which survives the archive script deleting old rows.
 */

/** One-time setup: creates the app spreadsheet, seeds users and bills, backfills, installs triggers. */
function setup() {
  REQUIRED_PROPS.forEach(requiredProp_);
  const ss = appSheet_(true);
  Object.keys(TABS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(TABS[name]);
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);

  const users = ss.getSheetByName('Users');
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  if (users.getLastRow() < 2) users.appendRow([me, 'admin']);

  backfillHourly();

  const bills = ss.getSheetByName('Bills');
  if (bills.getLastRow() < 2) {
    const points = hourlyPoints_(0);
    const rows = APP.SEED_BILL_DATES.map(s => {
      const [y, m, d] = s.split('-').map(Number);
      const ts = new Date(y, m - 1, d).getTime();
      return [ts, fmt_(ts), energyAt_(ts, points), '', 'From DHBVN bills (time unknown)', 'setup', new Date()];
    });
    bills.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'updateHourly')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('updateHourly').timeBased().everyMinutes(APP.UPDATE_MINUTES).create();
  Logger.log(`Setup done (${APP.ENV}). App sheet: ${ss.getUrl()}`);
}

/** Rebuilds the Hourly tab from every row currently in the logger sheet. */
function backfillHourly() {
  withLock_(() => {
    const src = sourceSheet_();
    const last = src.getLastRow();
    const rows = [];
    const CHUNK = 50000;
    for (let r = 2; r <= last; r += CHUNK) {
      const n = Math.min(CHUNK, last - r + 1);
      readRows_(src, r, n).forEach(x => rows.push(x));
    }
    const state = { lastTs: 0, ref: null, offset: 0, clean: null };
    const hours = cleanIntoHours_(rows, state, {});
    const sh = appSheet_().getSheetByName('Hourly');
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, TABS.Hourly.length).clearContent();
    const out = Object.keys(hours).sort().map(k => hourRow_(k, hours[k]));
    if (out.length) sh.getRange(2, 1, out.length, out[0].length).setValues(out);
    saveState_(state);
    Logger.log(`Backfill: ${rows.length} logger rows → ${out.length} hours.`);
  });
}

/** Time-trigger entry point (every APP.UPDATE_MINUTES minutes). */
function updateHourly() {
  withLock_(() => {
    const state = loadState_();
    if (!state) throw new Error('Run setup() first.');
    const src = sourceSheet_();
    const last = src.getLastRow();
    if (last < 2) return;
    const start = Math.max(2, last - APP.TAIL_ROWS + 1);
    const rows = readRows_(src, start, last - start + 1);

    // Load the most recent hours so partially filled hours can be continued
    const sh = appSheet_().getSheetByName('Hourly');
    const lastRow = sh.getLastRow();
    const keep = Math.min(72, Math.max(lastRow - 1, 0));
    const existing = keep ? sh.getRange(lastRow - keep + 1, 1, keep, TABS.Hourly.length).getValues() : [];
    const rowOf = {};
    const hours = {};
    existing.forEach((r, i) => {
      rowOf[r[0]] = lastRow - keep + 1 + i;
      hours[r[0]] = { lastTs: Number(r[1]), energy: Number(r[2]), n: Number(r[3]), powerSum: Number(r[4]) * Number(r[3]) };
    });

    const touched = cleanIntoHours_(rows, state, hours, true);
    const keys = Object.keys(touched).sort();
    const append = [];
    keys.forEach(k => {
      const row = hourRow_(k, touched[k]);
      if (rowOf[k]) sh.getRange(rowOf[k], 1, 1, row.length).setValues([row]);
      else append.push(row);
    });
    if (append.length) sh.getRange(sh.getLastRow() + 1, 1, append.length, append[0].length).setValues(append);
    saveState_(state);
  });
}

/**
 * Applies the cleaning rules to rows (sorted here) and accumulates hour snapshots.
 * Returns the hours touched (all hours when onlyTouched is false).
 */
function cleanIntoHours_(rows, state, hours, onlyTouched) {
  rows.sort((a, b) => a.ts - b.ts);
  const touched = {};
  rows.forEach(r => {
    if (r.ts <= state.lastTs) return;                 // already processed (or out of order)
    if (!(r.e > 0)) return;                           // blank / zero energy
    if (r.i === 0 && r.p === 0) return;               // load running on the inverter
    if (state.ref === null) {
      state.ref = r.e; state.offset = 0; state.clean = r.e;
    } else {
      const isReset = r.e < state.ref - 1 && r.e < state.ref * 0.5;
      const isGlitch = !isReset && r.e < state.ref;
      if (isReset) state.offset += state.ref;
      if (!isGlitch) { state.ref = r.e; state.clean = r.e + state.offset; }
    }
    state.lastTs = r.ts;
    const key = Utilities.formatDate(new Date(r.ts), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:00');
    const h = hours[key] || (hours[key] = { lastTs: 0, energy: 0, n: 0, powerSum: 0 });
    h.lastTs = r.ts; h.energy = state.clean; h.n += 1; h.powerSum += r.p;
    touched[key] = h;
  });
  return onlyTouched ? touched : hours;
}

function hourRow_(key, h) {
  return [key, h.lastTs, round_(h.energy, 3), h.n, round_(h.n ? h.powerSum / h.n : 0, 1)];
}

/** Hour snapshots [{ts, energy}] with lastTs >= sinceMs, oldest first. */
function hourlyPoints_(sinceMs) {
  const sh = appSheet_().getSheetByName('Hourly');
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 2, n, 2).getValues()
    .map(r => ({ ts: Number(r[0]), energy: Number(r[1]) }))
    .filter(p => p.ts >= sinceMs)
    .sort((a, b) => a.ts - b.ts);
}

/** Cleaned energy at ts, interpolated between hour snapshots; '' when more than an hour outside the logged range. */
function energyAt_(ts, points) {
  if (!points.length) return '';
  const first = points[0], last = points[points.length - 1];
  if (ts < first.ts - 3600e3 || ts > last.ts + 3600e3) return '';
  if (ts <= first.ts) return first.energy;
  if (ts >= last.ts) return last.energy;
  for (let i = 1; i < points.length; i++) {
    if (ts <= points[i].ts) {
      const a = points[i - 1], b = points[i];
      return round_(a.energy + (b.energy - a.energy) * (ts - a.ts) / (b.ts - a.ts), 3);
    }
  }
  return '';
}

function readRows_(sheet, startRow, n) {
  const values = sheet.getRange(startRow, 1, n, 5).getDisplayValues();   // Timestamp, Voltage, Current, Power, Energy
  const out = [];
  values.forEach(v => {
    const ts = parsePzemTs_(v[0]);
    if (ts === null) return;
    out.push({ ts, v: Number(v[1]), i: Number(v[2]), p: Number(v[3]), e: Number(v[4]) });
  });
  return out;
}

/** "M/D/YYYY H:MM:SS" in the script time zone → epoch ms, or null. */
function parsePzemTs_(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s).trim());
  if (!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +(m[6] || 0)).getTime();
}

function appSheet_(create) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('APP_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  if (!create) throw new Error('Run setup() first.');
  const ss = SpreadsheetApp.create(APP.APP_SHEET_NAME);
  props.setProperty('APP_SHEET_ID', ss.getId());
  return ss;
}

function sourceSheet_() {
  const ss = SpreadsheetApp.openById(APP.SOURCE_ID);
  return ss.getSheetByName(APP.SOURCE_TAB) || ss.getSheets()[0];
}

function loadState_() {
  const s = PropertiesService.getScriptProperties().getProperty('CLEAN_STATE');
  return s ? JSON.parse(s) : null;
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty('CLEAN_STATE', JSON.stringify(state));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) { Logger.log('Busy, skipped.'); return; }
  try { return fn(); } finally { lock.releaseLock(); }
}

function fmt_(ms) {
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'dd MMM yyyy HH:mm');
}

function round_(x, d) {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
}
