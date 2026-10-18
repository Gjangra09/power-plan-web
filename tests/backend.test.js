// Backend gates on the real apps-script/*.gs files in a fake Apps Script (tests/helpers/gas.js):
// D3 corrections end to end, D4 hourly data, D5 monitoring, D6 recovery.
process.env.TZ = 'Asia/Kolkata';   // Apps Script runs in the script's time zone
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackend, loggerRows } from './helpers/gas.js';

const H = 3600e3;
// Logger history: 4 days up to 30 minutes ago, with a 3-hour gap and an 8-hour outage
const END = Math.floor(Date.now() / 60e3) * 60e3 - 30 * 60e3;
const START = END - 96 * H;
const DATA = loggerRows(START, 96, { gaps: [[20, 23], [50, 58]] });

/** A backend set up with the logger history and a bill 3 days ago. */
function ready(opts) {
  const b = loadBackend(opts);
  b.source.rows.push(...DATA.rows.map(r => r.slice()));
  b.ctx.setup();
  b.drain('continueSetup');
  const bills = b.tab('Bills');
  bills.rows.length = 1;   // replace the seeded DHBVN dates with one bill inside the logged range
  const billTs = START + 24 * H;
  bills.appendRow([billTs, 'x', b.ctx.energyAt_(billTs, b.ctx.hourlyPoints_(0)), '', 'test', 'test', new Date()]);
  return b;
}
const hourly = b => b.tab('Hourly').rows.slice(1).map(r => r.map(v => (v instanceof Date ? 'DATE' : v)));
const jobs = (b, name) => b.tab('Jobs').rows.slice(1).filter(r => r[1] === name).map(r => r[2]);

// ---------- D4: hourly data ----------

test('D4 backfill: one row per hour, energy never decreases, every logger row counted once', () => {
  const b = ready();
  const rows = b.tab('Hourly').rows.slice(1);
  const keys = rows.map(r => String(r[0]));
  assert.equal(new Set(keys).size, keys.length, 'no duplicate hours');
  assert.ok(keys.every(k => /^\d{4}-\d\d-\d\d \d\d:00$/.test(k)), 'hour keys stay text');
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i][2] >= rows[i - 1][2], 'monotonic energy');
  const loggerRowsCounted = rows.reduce((s, r) => s + r[5], 0);
  // Rows are sorted within a read, so the out-of-order row still counts; only the duplicate is dropped
  assert.equal(loggerRowsCounted, DATA.rows.length - 1, 'every row once (the duplicate dropped)');
  assert.ok(rows.some(r => r[3] === 0 && r[5] > 0), 'grid-off hour: logger alive, no load readings');
});

test('D4 an old sheet (fewer columns, hour dates) upgrades itself and keeps working', () => {
  const b = ready();
  const sh = b.tab('Hourly');
  // Turn the tab into the old 5-column layout with Sheets-converted dates
  sh.rows = sh.rows.map((r, i) => (i === 0 ? ['Hour', 'LastTsMs', 'Energy', 'Readings', 'AvgPowerW'] : [sh.store(String(r[0]), 0), ...r.slice(1, 5)]));
  sh.textA = false;
  b.ctx.clearTabCache_();   // a new Apps Script run
  const before = sh.rows.length;
  b.ctx.updateHourly();
  assert.deepEqual(sh.rows[0], ['Hour', 'LastTsMs', 'Energy', 'Readings', 'AvgPowerW', 'LoggerRows', 'LastRowTsMs']);
  assert.equal(sh.rows.length, before, 'no hour appended twice');
  assert.equal(jobs(b, 'updateHourly').pop(), 'ok');
});

test('D4 duplicate hour rows (old date/text mix-up) are merged by the health check', () => {
  const b = ready();
  const sh = b.tab('Hourly');
  const r = sh.rows[10].slice();   // the repair rewrites rows in place
  sh.rows.splice(11, 0, [new Date(String(r[0]).replace(' ', 'T') + ':00'), r[1] + 60e3, r[2] + 0.01, 3, 100, 3, r[1] + 60e3]);
  b.ctx.healthCheck();
  const keys = sh.rows.slice(1).map(x => b.ctx.hourKey_(x[0]));
  assert.equal(new Set(keys).size, keys.length);
  const merged = sh.rows.find(x => x[0] === r[0]);
  assert.equal(merged[2], r[2] + 0.01, 'latest snapshot kept');
  assert.equal(merged[3], r[3] + 3, 'readings added up');
});

// ---------- D6: recovery ----------

test('D6 a backfill cut off after writing (before saving its place) finishes with the same result', () => {
  const clean = hourly(ready());
  const b = loadBackend();
  b.source.rows.push(...DATA.rows.map(r => r.slice()));
  const save = b.ctx.saveState_;
  let fail = true;
  b.ctx.saveState_ = s => { if (fail && s.lastTs > 0) { fail = false; throw new Error('Simulated: run stopped (time limit)'); } return save(s); };
  b.ctx.setup();
  assert.equal(jobs(b, 'backfillStep')[0], 'error');
  b.drain('continueSetup');
  assert.deepEqual(hourly(b), clean);
});

test('D6 an update cut off in the middle of writing hours gives the same result when repeated', () => {
  // 2.5 h of new rows always spans at least 3 hours, so there is a second hour write to cut off
  const extra = loggerRows(END, 2.5, { energy0: DATA.energyEnd }).rows;
  const clean = ready();
  clean.source.rows.push(...extra.map(r => r.slice()));
  clean.ctx.updateHourly();

  const b = ready();
  b.source.rows.push(...extra.map(r => r.slice()));
  b.tab('Hourly').failNextSetValues = 2;           // the second hour write fails
  b.ctx.updateHourly();
  assert.equal(jobs(b, 'updateHourly').pop(), 'error');
  assert.ok(b.triggers.some(t => t.handler === 'retryUpdateHourly'), 'retry scheduled');
  b.drain('retryUpdateHourly');
  assert.deepEqual(hourly(b), hourly(clean));
  assert.equal(jobs(b, 'updateHourly').pop(), 'ok');
});

test('D6 a failed update is retried and succeeds: no alert, retry state cleared', () => {
  const b = ready();
  const src = b.ctx.sourceSheet_;
  let fails = 1;
  b.ctx.sourceSheet_ = () => { if (fails-- > 0) throw new Error('Service Spreadsheets timed out'); return src(); };
  b.ctx.updateHourly();
  const retry = b.triggers.find(t => t.handler === 'retryUpdateHourly');
  assert.equal(retry.after, 2 * 60e3, 'first retry after 2 minutes');
  b.drain('retryUpdateHourly');
  assert.deepEqual(jobs(b, 'updateHourly').slice(-2), ['error', 'ok']);
  assert.equal(b.props.get('RETRY_updateHourly'), undefined);
  assert.equal(b.sent.length, 0, 'a fixed failure is not alerted');
  assert.equal(b.tab('Errors').rows.length, 2, 'the failure is in Errors');
});

test('D6 the site keeps answering while the update job is failing', () => {
  const b = ready();
  const before = b.ctx.summary_({}, { email: 'a@example.com' }).calc.unitsSoFar;
  b.ctx.sourceSheet_ = () => { throw new Error('down'); };
  b.ctx.updateHourly();
  assert.equal(b.ctx.summary_({}, { email: 'a@example.com' }).calc.unitsSoFar, before);
});

// ---------- D5: monitoring ----------

test('D5 a job failing past its retries sends exactly one alert, and one when it works again', () => {
  const b = ready();
  const src = b.ctx.sourceSheet_;
  b.ctx.sourceSheet_ = () => { throw new Error('Service Spreadsheets failed'); };
  b.ctx.updateHourly();
  b.drain('retryUpdateHourly');                     // retries after 2, 4, 8 minutes
  b.ctx.updateHourly(); b.ctx.updateHourly();       // the regular trigger keeps failing
  assert.deepEqual(jobs(b, 'updateHourly'), ['error', 'error', 'error', 'error', 'error', 'error']);
  assert.equal(b.sent.length, 1, 'one alert');
  assert.match(b.sent[0].text, /^\[Power Plan UAT\] ⚠️ updateHourly has failed 4 times/);
  b.ctx.sourceSheet_ = src;
  b.ctx.updateHourly();
  b.ctx.updateHourly();
  assert.equal(b.sent.length, 2, 'one "back to normal"');
  assert.match(b.sent[1].text, /✅ Back to normal/);
  assert.deepEqual(b.tab('Alerts').rows.slice(1).map(r => [r[1], r[2], r[4]]), [['job:updateHourly', 'open', 'sent'], ['job:updateHourly', 'closed', 'sent']]);
});

test('D5 logger data stopping sends one alert however often the check runs, and one recovery', () => {
  const b = ready();
  b.source.rows.length = b.source.rows.length - 4 * 60;   // last reading now 4.5 h ago (> 3 h)
  b.ctx.healthCheck(); b.ctx.healthCheck(); b.ctx.healthCheck();
  assert.equal(b.sent.length, 1);
  assert.match(b.sent[0].text, /No new logger data for 4\.\d h/);
  b.source.rows.push(...loggerRows(END, 0.4, { energy0: DATA.energyEnd }).rows);
  b.ctx.healthCheck(); b.ctx.healthCheck();
  assert.equal(b.sent.length, 2);
  assert.match(b.sent[1].text, /Back to normal: logger data is arriving again/);
});

test('D5 the alert threshold follows the Config row staleAlertHours', () => {
  const b = ready();
  b.tab('Config').appendRow(['staleAlertHours', 6]);
  b.source.rows.length = b.source.rows.length - 4 * 60;   // 4.5 h: under 6 h
  b.ctx.healthCheck();
  assert.equal(b.sent.length, 0);
});

test('D5 without Telegram set up, alerts are still recorded in the Alerts tab', () => {
  const b = ready({ telegram: false });
  b.source.rows.length = b.source.rows.length - 4 * 60;
  b.ctx.healthCheck();
  assert.equal(b.sent.length, 0);
  assert.equal(b.tab('Alerts').rows[1][4], 'not set up');
});

test('D5 API errors are logged with the action; refused requests are not errors', () => {
  const b = ready();
  b.ctx.authenticate_ = () => ({ email: 'admin@example.com', via: 'session', exp: Date.now() + 30 * 86400e3 });
  b.ctx.hourlyPoints_ = () => { throw new Error('boom'); };
  const res = JSON.parse(b.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'summary' }) } }).text);
  assert.equal(res.code, 500);
  const err = b.tab('Errors').rows.at(-1);
  assert.deepEqual([err[1], err[3], err[5]], ['api', 'boom', 'summary']);
  const errors = b.tab('Errors').rows.length;
  JSON.parse(b.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'nope' }) } }).text);
  assert.equal(b.tab('Errors').rows.length, errors);
});

test('D5 every job run is logged in Jobs with its status and duration', () => {
  const b = ready();
  b.ctx.updateHourly();
  b.ctx.healthCheck();
  const rows = b.tab('Jobs').rows.slice(1);
  assert.ok(rows.some(r => r[1] === 'backfillStep' && r[2] === 'ok'));
  assert.ok(rows.some(r => r[1] === 'updateHourly' && r[2] === 'ok' && r[4] > 0));
  assert.ok(rows.some(r => r[1] === 'healthCheck' && r[2] === 'ok' && /data age/.test(r[5])));
  assert.ok(rows.every(r => r[3] >= 0));
});

// ---------- D3: corrections through the API ----------

test('D3 a correction changes the server bill by exactly its amount, is logged before → after, and switching it off restores it', () => {
  const b = ready();
  const user = { email: 'admin@example.com', role: 'admin' };
  const base = b.ctx.summary_({}, user).calc;
  const r = b.ctx.saveCorrection_({ kind: 'adjust', from: END - 10 * H, value: -2, reason: 'test glitch' }, user);
  const on = b.ctx.summary_({}, user).calc;
  assert.ok(Math.abs(on.unitsSoFar - (base.unitsSoFar - 2 * 1.02)) < 1e-9, 'units − 2 kWh × meter factor');
  assert.match(r.details, /^-2 kWh at .*, counted from then on · reason: test glitch · current cycle [\d.]+ units → [\d.]+ units/);
  const off = b.ctx.setCorrectionActive_({ id: r.saved.id, active: false }, user);
  assert.match(off.details, /on → off/);
  assert.deepEqual(JSON.parse(JSON.stringify(b.ctx.summary_({}, user).calc)), JSON.parse(JSON.stringify(base)));
  assert.equal(b.tab('Hourly').rows.length > 1, true, 'raw data untouched');
});

test('D3 the activity log keeps "−2 kWh …" and typed "=…" text as text (Sheets would make them formulas)', () => {
  const b = ready();
  const user = { email: 'admin@example.com', name: 'Admin', role: 'admin' };
  const r = b.ctx.saveCorrection_({ kind: 'adjust', from: END - 10 * H, value: -2, reason: '=IMPORTDATA("x")' }, user);
  b.ctx.logActivity_(user, {}, ['change', 'Added data correction ' + r.saved.id, r.details]);
  const last = b.ctx.recentActivity_(1)[0];
  assert.match(last.details, /^-2 kWh at /);
  assert.equal(b.ctx.corrections_()[0].reason, '=IMPORTDATA("x")');
  assert.ok(b.tab('Activity').rows.slice(1).every(row => row.every(v => String(v) !== '#ERROR!')));
});

test('D3 cells already turned into #ERROR! by Sheets are repaired back to their text', () => {
  const b = ready();
  b.tab('Activity').appendRow([new Date(), 'a@example.com', 'A', 'admin', 'change', 'Added data correction C1', 'Chrome on Windows', '-2 kWh from 18 Oct 2026 10:00 · reason: test']);
  assert.equal(b.ctx.recentActivity_(1)[0].details, '#ERROR!');
  assert.equal(b.ctx.repairTextCells_(), 1);
  assert.equal(b.ctx.recentActivity_(1)[0].details, '-2 kWh from 18 Oct 2026 10:00 · reason: test');
  assert.equal(b.ctx.repairTextCells_(), 0, 'nothing left to repair');
});

test('D3 units added for a past period (From–To) raise the server\'s cycle total by exactly that much × meter factor', () => {
  const b = ready();
  const user = { email: 'admin@example.com', role: 'admin' };
  const base = b.ctx.summary_({}, user).calc;
  b.ctx.saveCorrection_({ kind: 'adjust', from: END - 30 * H, to: END - 26 * H, value: 3, reason: 'logger missed these' }, user);
  const after = b.ctx.summary_({}, user).calc;
  assert.ok(Math.abs(after.unitsSoFar - (base.unitsSoFar + 3 * 1.02)) < 1e-9);
  assert.ok(after.chargesSoFar.total > base.chargesSoFar.total);
});

test('D3 corrections are checked: no reason, no end for "exclude", zero change → refused', () => {
  const b = ready();
  const user = { email: 'admin@example.com' };
  assert.throws(() => b.ctx.saveCorrection_({ kind: 'adjust', from: END, value: 1, reason: '' }, user), /reason/);
  assert.throws(() => b.ctx.saveCorrection_({ kind: 'exclude', from: END, reason: 'x y z' }, user), /end time/);
  assert.throws(() => b.ctx.saveCorrection_({ kind: 'adjust', from: END, value: 0, reason: 'x y z' }, user), /not zero/);
  assert.throws(() => b.ctx.saveCorrection_({ kind: 'delete', from: END, reason: 'x y z' }, user), /Choose/);
});

test('D3 ignoring a range of readings leaves the cycle total unchanged (the meter still counted those units)', () => {
  const b = ready();
  const user = { email: 'admin@example.com' };
  const base = b.ctx.summary_({}, user).calc;
  b.ctx.saveCorrection_({ kind: 'exclude', from: END - 30 * H, to: END - 28 * H, reason: 'bad readings' }, user);
  const after = b.ctx.summary_({}, user).calc;
  assert.ok(Math.abs(after.unitsSoFar - base.unitsSoFar) < 1e-9);
});

// ---------- server = engine ----------

test('the server sends its own calculation; the tariff is the seeded DHBVN version', () => {
  const b = ready();
  const out = JSON.parse(b.ctx.json_(b.ctx.summary_({}, { email: 'a@example.com' })).text);
  assert.ok(out.calc && out.calc.unitsSoFar > 0);
  assert.equal(out.tariff.slabs.B[3].to, 1e9, 'Infinity is sent as a large number, not null');
  assert.ok(out.quality.share > 0.8 && out.quality.outages === 1, 'one outage this cycle');
  assert.equal(b.tab('TariffVersions').rows.length, 2);
  assert.equal(b.tab('Devices').rows.length, 2);
});
