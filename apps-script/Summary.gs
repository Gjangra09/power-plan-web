/**
 * Hourly energy snapshots for the dashboard.
 *
 * Every 15 minutes (30 in UAT) the tail of the logger sheet is cleaned with the same rules as Power BI
 * (Sheet1.tmdl): zero-load rows dropped, glitches hold the last good value, counter resets
 * carry the old total forward. The cleaned, never-decreasing energy at the last reading of
 * each hour is kept in the Hourly tab, which survives the archive script deleting old rows.
 *
 * Writing an hour is idempotent: each hour remembers the last logger row it counted
 * (LastRowTsMs), so a run that is cut off and repeated never counts a row twice.
 */

// The full backfill reads the whole logger sheet, which takes longer than one Apps Script run
// (6 min). It is done in steps: each stops after BACKFILL_BUDGET_MS, saves where it got to, and
// schedules the next step a minute later.
const BACKFILL_CHUNK = 10000;   // ~30 s per read, so a step never runs far past the budget
const BACKFILL_BUDGET_MS = 4 * 60 * 1000;
const HOUR_MS = 3600 * 1000;

/** One-time setup: creates the app spreadsheet, seeds users, then backfills history (in steps) and finishes. */
function setup() {
  REQUIRED_PROPS.forEach(requiredProp_);
  const ss = appSheet_(true);
  Object.keys(TABS).forEach(tab_);
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);

  const users = tab_('Users');
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  if (users.getLastRow() < 2) addRow_(users, [me, 'admin', '']);
  seedDefaults_();

  // Safe to run again: an existing history is kept (backfillHourly() rebuilds it on purpose)
  if (!PropertiesService.getScriptProperties().getProperty('BACKFILL_NEXT_ROW')) {
    if (loadState_()) Logger.log('History already built – keeping it. Run backfillHourly() to rebuild it.');
    else startBackfill_();
  }
  continueSetup();
}

/** Runs one backfill step; schedules itself again until the history is complete, then finishes setup. */
function continueSetup() {
  deleteTriggers_('continueSetup');
  const step = runJob_('backfillStep', () => {
    const done = backfillStep_();
    return done === undefined ? undefined : { done, message: done ? 'history complete' : 'continues' };
  });
  if (!step || !step.done) {
    ScriptApp.newTrigger('continueSetup').timeBased().after(60 * 1000).create();
    Logger.log('Backfill continues automatically in about a minute (see Executions).');
    return;
  }
  const bills = tab_('Bills');
  if (bills.getLastRow() < 2) {
    const points = hourlyPoints_(0);
    const rows = APP.SEED_BILL_DATES.map(s => {
      const [y, m, d] = s.split('-').map(Number);
      const ts = new Date(y, m - 1, d).getTime();
      return [ts, fmt_(ts), energyAt_(ts, points), '', 'From DHBVN bills (time unknown)', 'setup', new Date()];
    });
    bills.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
  installTriggers_();
  Logger.log(`Setup done (${APP.ENV}). App sheet: ${appSheet_().getUrl()}`);
}

/** The regular jobs: data update every APP.UPDATE_MINUTES and the hourly health check. Safe to run again. */
function installTriggers_() {
  deleteTriggers_('updateHourly');
  ScriptApp.newTrigger('updateHourly').timeBased().everyMinutes(APP.UPDATE_MINUTES).create();
  deleteTriggers_('healthCheck');
  ScriptApp.newTrigger('healthCheck').timeBased().everyHours(1).create();
}

/** Default rows for new tabs: the tariff in force today and the logger. Never overwrites. */
function seedDefaults_() {
  const tv = tab_('TariffVersions');
  if (tv.getLastRow() < 2) {
    // An older Config row "tariff" (JSON) wins over the built-in tariff
    const old = readTab_('Config').find(r => r.Key === 'tariff');
    const rates = Billing.normalizeTariff(old ? JSON.parse(String(old.Value)) : Billing.DEFAULT_TARIFF);
    addRow_(tv, ['v1', rates.category, 0, 'from the start', JSON.stringify(rates), 'DHBVN tariff on the 2025–26 bills', 'setup', new Date()]);
  }
  const dev = tab_('Devices');
  if (dev.getLastRow() < 2) addRow_(dev, ['pzem-grid', 'PZEM logger (ESP)', 'Grid supply: V, A, W, kWh', 'Home', '2025-10-07', 'Logger sheet PZEM_Data']);
}

/** Rebuilds the Hourly tab from every row currently in the logger sheet (runs in steps, like setup). */
function backfillHourly() {
  startBackfill_();
  continueSetup();
}

function startBackfill_() {
  withLock_(() => {
    const sh = tab_('Hourly');
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, TABS.Hourly.length).clearContent();
    sh.getRange('A:A').setNumberFormat('@'); // keep Hour as text
    saveState_({ lastTs: 0, ref: null, offset: 0, clean: null });
    PropertiesService.getScriptProperties().setProperty('BACKFILL_NEXT_ROW', '2');
  });
}

/** Processes logger rows from the saved position until done or out of time. Returns true when complete. */
function backfillStep_() {
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  return withLock_(() => {
    let next = Number(props.getProperty('BACKFILL_NEXT_ROW'));
    if (!next) return true;
    const src = sourceSheet_();
    const last = src.getLastRow();
    const state = loadState_();
    while (next <= last && Date.now() - started < BACKFILL_BUDGET_MS) {
      const n = Math.min(BACKFILL_CHUNK, last - next + 1);
      upsertHours_(readRows_(src, next, n), state);
      next += n;
      saveState_(state);
      props.setProperty('BACKFILL_NEXT_ROW', String(next));
    }
    Logger.log(`Backfill: ${next - 2} of ${last - 1} logger rows done.`);
    if (next <= last) return false;
    props.deleteProperty('BACKFILL_NEXT_ROW');
    return true;
  });
}

/** Time-trigger entry point (every APP.UPDATE_MINUTES minutes). Logged in Jobs; retried on failure. */
function updateHourly() {
  return runJob_('updateHourly', () => withLock_(() => {
    const state = loadState_();
    if (!state) throw new Error('Run setup() first.');
    if (PropertiesService.getScriptProperties().getProperty('BACKFILL_NEXT_ROW')) return { rows: 0, message: 'setup still running' };
    const src = sourceSheet_();
    const last = src.getLastRow();
    if (last < 2) return { rows: 0 };
    const start = Math.max(2, last - APP.TAIL_ROWS + 1);
    const rows = readRows_(src, start, last - start + 1);
    const hours = upsertHours_(rows, state);
    saveState_(state);
    return { rows: rows.length, message: `${hours} hours written` };
  }));
}

/** Cleans rows into hour snapshots and writes them to the Hourly tab. Returns how many hours were written. */
function upsertHours_(rows, state) {
  const sh = tab_('Hourly');
  const lastRow = sh.getLastRow();
  // Load the existing hours these rows can touch: normally the last 72, more when a step is repeated
  let keep = Math.min(72, Math.max(lastRow - 1, 0));
  if (keep && rows.length) {
    const lastTs = Number(sh.getRange(lastRow, 2).getValue()) || 0;
    const firstTs = rows.reduce((m, r) => Math.min(m, r.ts), Infinity);
    keep = Math.min(lastRow - 1, Math.max(keep, Math.ceil((lastTs - firstTs) / HOUR_MS) + 3));
  }
  const existing = keep ? sh.getRange(lastRow - keep + 1, 1, keep, TABS.Hourly.length).getValues() : [];
  const rowOf = {};
  const hours = {};
  existing.forEach((r, i) => {
    const key = hourKey_(r[0]);
    rowOf[key] = lastRow - keep + 1 + i;
    const n = Number(r[3]) || 0;
    hours[key] = {
      lastTs: Number(r[1]) || 0, energy: r[2] === '' ? null : Number(r[2]), n, powerSum: Number(r[4]) * n,
      rows: r[5] === '' ? n : Number(r[5]), lastRowTs: r[6] === '' ? Number(r[1]) || 0 : Number(r[6]),
    };
  });

  const touched = cleanIntoHours_(rows, state, hours, true);
  const append = [];
  Object.keys(touched).sort().forEach(k => {
    const row = hourRow_(k, touched[k]);
    if (rowOf[k]) sh.getRange(rowOf[k], 1, 1, row.length).setValues([row]);
    else append.push(row);
  });
  if (append.length) sh.getRange(sh.getLastRow() + 1, 1, append.length, append[0].length).setValues(append);
  return Object.keys(touched).length;
}

/** Sheets may have turned the "yyyy-MM-dd HH:00" text into a date; turn it back into the key. */
function hourKey_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:00');
  }
  return String(v);
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/**
 * Applies the cleaning rules to rows (sorted here) and accumulates hour snapshots.
 * Every logger row counts towards its hour's LoggerRows (the logger was alive), but only rows with
 * grid load move the energy. A row already counted for its hour (ts <= lastRowTs) is never counted
 * again, so repeating a run after a crash gives the same hours.
 * Returns the hours touched (all hours when onlyTouched is false).
 */
function cleanIntoHours_(rows, state, hours, onlyTouched) {
  rows.sort((a, b) => a.ts - b.ts);
  const touched = {};
  rows.forEach(r => {
    const key = Utilities.formatDate(new Date(r.ts), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:00');
    const h = hours[key] || { lastTs: 0, energy: null, n: 0, powerSum: 0, rows: 0, lastRowTs: 0 };
    const fresh = r.ts > h.lastRowTs;                 // not yet counted for this hour
    if (fresh) { h.rows += 1; h.lastRowTs = r.ts; }

    const load = r.e > 0 && !(r.i === 0 && r.p === 0);  // zero-load: running on the inverter
    if (load && r.ts > state.lastTs) {                  // already processed (or out of order) otherwise
      if (state.ref === null) {
        state.ref = r.e; state.offset = 0; state.clean = r.e;
      } else {
        const isReset = r.e < state.ref - 1 && r.e < state.ref * 0.5;
        const isGlitch = !isReset && r.e < state.ref;
        if (isReset) state.offset += state.ref;
        if (!isGlitch) { state.ref = r.e; state.clean = r.e + state.offset; }
      }
      state.lastTs = r.ts;
      if (fresh) { h.n += 1; h.powerSum += r.p; }
    }
    // The snapshot: energy at the latest row of the hour (unchanged while on the inverter). Only
    // while no later row has been processed: state.clean is "energy now", not at an older row.
    if (fresh && state.clean !== null && r.ts >= state.lastTs && r.ts >= h.lastTs) { h.lastTs = r.ts; h.energy = state.clean; }
    if (fresh) { hours[key] = h; touched[key] = h; }
  });
  return onlyTouched ? touched : hours;
}

function hourRow_(key, h) {
  return [key, h.lastTs || '', h.energy === null ? '' : round_(h.energy, 3), h.n, round_(h.n ? h.powerSum / h.n : 0, 1), h.rows, h.lastRowTs];
}

/** Hour snapshots [{ts, energy, rows}] with lastTs >= sinceMs, oldest first (rows = logger rows that hour). */
function hourlyPoints_(sinceMs) {
  const sh = tab_('Hourly');
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 2, n, 5).getValues()
    .filter(r => r[0] !== '' && r[1] !== '')
    .map(r => ({ ts: Number(r[0]), energy: Number(r[1]), rows: r[4] === '' ? Number(r[2]) || 0 : Number(r[4]) }))
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
  if (!create) throw httpError_(503, 'The app is still being set up. Try again in a few minutes.');
  const ss = SpreadsheetApp.create(APP.APP_SHEET_NAME);
  props.setProperty('APP_SHEET_ID', ss.getId());
  return ss;
}

// Tabs already checked in this run (Apps Script starts every run with fresh globals)
const tabCache_ = {};

/**
 * A tab of the app sheet. A missing tab is created with its header; header columns added in a
 * newer version (TABS in Config.gs) are appended, so older sheets upgrade themselves on first use.
 */
function tab_(name) {
  if (tabCache_[name]) return tabCache_[name];
  const ss = appSheet_();
  const head = TABS[name];
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(head);
    sh.setFrozenRows(1);
    if (name === 'Hourly') sh.getRange('A:A').setNumberFormat('@');
  } else if (head) {
    const width = Math.max(sh.getLastColumn(), 1);
    const have = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
    const used = have.reduce((n, h, i) => (h ? i + 1 : n), 0);
    const missing = head.filter(h => !have.includes(h));
    if (missing.length) sh.getRange(1, used + 1, 1, missing.length).setValues([missing]);
  }
  tabCache_[name] = sh;
  return sh;
}

/**
 * Appends a row with every text kept as text. Sheets reads text starting with = + - @ as a
 * formula ("-2 kWh from …" became #ERROR!, and typed text could run a formula), so such text
 * gets a leading apostrophe, which Sheets hides and drops when the value is read.
 */
function addRow_(sh, values) {
  sh.appendRow(values.map(cellText_));
}

function cellText_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

/**
 * Turns cells that Sheets made into formulas back into the text that was meant (from before
 * addRow_ existed). Only formulas that start with + or - and aren't valid are touched. Returns
 * how many cells were fixed.
 */
function repairTextCells_() {
  let fixed = 0;
  [['Activity', 'Details'], ['Activity', 'Event'], ['Corrections', 'Reason'], ['Bills', 'Note'], ['Errors', 'Message']].forEach(([name, col]) => {
    const sh = tab_(name);
    const n = sh.getLastRow() - 1;
    const c = TABS[name].indexOf(col) + 1;
    if (n < 1 || c < 1) return;
    const range = sh.getRange(2, c, n, 1);
    const values = range.getValues(), formulas = range.getFormulas();
    formulas.forEach((f, i) => {
      if (/^=[+\-]/.test(f[0]) && /^#(ERROR|NAME|VALUE)/.test(String(values[i][0]))) {
        sh.getRange(i + 2, c).setValue("'" + f[0].slice(1));
        fixed++;
      }
    });
  });
  return fixed;
}

/** Forgets the tabs checked in this run (after a tab is deleted or replaced). */
function clearTabCache_() {
  Object.keys(tabCache_).forEach(k => delete tabCache_[k]);
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
