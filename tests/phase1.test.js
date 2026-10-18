// Phase 1 gates on the real apps-script/*.gs files in the fake Apps Script:
// G3 cycles (closed cycles, the picker list, stored results), G4 page access.
process.env.TZ = 'Asia/Kolkata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackend, loggerRows } from './helpers/gas.js';

const H = 3600e3;
const END = Math.floor(Date.now() / 60e3) * 60e3 - 30 * 60e3;
const START = END - 96 * H;
const DATA = loggerRows(START, 96, { gaps: [[20, 23], [50, 58]] });
const B1 = START + 24 * H, B2 = START + 72 * H;   // two meter readings: one closed cycle + the current one

/** Backend with the logger history, two bills, and users with different pages. */
function ready(opts) {
  const b = loadBackend(opts);
  b.source.rows.push(...DATA.rows.map(r => r.slice()));
  b.ctx.setup();
  b.drain('continueSetup');
  const bills = b.tab('Bills');
  bills.rows.length = 1;
  const pts = b.ctx.hourlyPoints_(0);
  for (const ts of [B1, B2]) bills.appendRow([ts, 'x', b.ctx.energyAt_(ts, pts), '', 'test', 'test', new Date()]);
  const users = b.tab('Users');
  users.appendRow(['viewer@example.com', 'viewer', '']);
  users.appendRow(['past@example.com', 'viewer', 'past, breakdown, nonsense']);
  return b;
}
const as = (b, email) => Object.assign({ email }, b.ctx.userRecord_(email));
const json = x => JSON.parse(JSON.stringify(x));
// A signed-in request through doPost (sign-in itself is tested elsewhere)
function post(b, email, body) {
  b.ctx.authenticate_ = () => ({ email, via: 'session', exp: Date.now() + 30 * 86400e3 });
  return JSON.parse(b.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
}

// ---------- G4: page access ----------

test('G4 pages: admins have all, viewers Summary + what is ticked (unknown words ignored), not on the list = none', () => {
  const b = ready();
  assert.deepEqual(json(as(b, 'admin@example.com').pages), ['summary', 'past', 'breakdown', 'documents', 'health']);
  assert.deepEqual(json(as(b, 'viewer@example.com').pages), ['summary']);
  assert.deepEqual(json(as(b, 'past@example.com').pages), ['summary', 'past', 'breakdown']);
  assert.equal(b.ctx.userRecord_('stranger@example.com'), null);
});

test('G4 a viewer with Summary only: current cycle yes; past cycle, cycle list and slab lines no', () => {
  const b = ready();
  const cur = post(b, 'viewer@example.com', { action: 'summary' });
  assert.equal(cur.ok, true);
  assert.equal(cur.cycle.start, B2);
  assert.equal(cur.cycles, undefined, 'no cycle list without Past cycles');
  assert.ok(!JSON.stringify(cur.calc).includes('slabLines'), 'no slab lines without Bill breakdown');
  const past = post(b, 'viewer@example.com', { action: 'summary', cycle: B1 });
  assert.deepEqual([past.ok, past.code, past.need], [false, 403, 'past']);
  assert.match(past.error, /don't have access to Past cycles/);
  const list = post(b, 'viewer@example.com', { action: 'cycles' });
  assert.deepEqual([list.code, list.need], [403, 'past']);
  const denied = b.ctx.recentActivity_(5).filter(a => a.type === 'denied').map(a => a.event);
  assert.deepEqual(denied, ['No access to Past cycles', 'No access to Past cycles']);
});

test('G4 a viewer with Past cycles + Breakdown gets both; admins are never limited; admin actions stay admin-only', () => {
  const b = ready();
  const past = post(b, 'past@example.com', { action: 'summary', cycle: B1 });
  assert.equal(past.ok, true);
  assert.equal(past.cycle.current, false);
  assert.ok(JSON.stringify(past.calc).includes('slabLines'));
  assert.equal(past.cycles.length, 2);
  assert.equal(post(b, 'admin@example.com', { action: 'summary', cycle: B1 }).ok, true);
  const admin = post(b, 'past@example.com', { action: 'listUsers' });
  assert.deepEqual([admin.code, admin.error, admin.need], [403, 'Admin only', undefined]);
});

test('G4 a page refusal is not a sign-out: same session works again for allowed pages', () => {
  const b = ready();
  assert.equal(post(b, 'viewer@example.com', { action: 'summary', cycle: B1 }).code, 403);
  assert.equal(post(b, 'viewer@example.com', { action: 'summary' }).ok, true);
});

test('G4 ticking a page in the Users tab gives access on the next request; unticking removes it', () => {
  const b = ready();
  const users = b.tab('Users');
  const row = users.rows.find(r => r[0] === 'viewer@example.com');
  row[2] = 'past';
  assert.equal(post(b, 'viewer@example.com', { action: 'summary', cycle: B1 }).ok, true);
  row[2] = '';
  assert.equal(post(b, 'viewer@example.com', { action: 'summary', cycle: B1 }).code, 403);
});

test('G4 Request access: logged once a day, the admin is alerted, nonsense or already-allowed pages refused', () => {
  const b = ready();
  const r1 = post(b, 'viewer@example.com', { action: 'requestAccess', page: 'past' });
  assert.deepEqual([r1.ok, r1.label, r1.alreadyAsked], [true, 'Past cycles', false]);
  assert.match(b.sent.at(-1).text, /🔑 viewer@example.com \(viewer@example.com\) asks for access to Past cycles/);
  const r2 = post(b, 'viewer@example.com', { action: 'requestAccess', page: 'past' });
  assert.equal(r2.alreadyAsked, true);
  assert.equal(b.sent.filter(m => /asks for access/.test(m.text)).length, 1, 'one alert per page per day');
  assert.equal(b.ctx.recentActivity_(10).filter(a => a.type === 'request').length, 1);
  assert.equal(post(b, 'viewer@example.com', { action: 'requestAccess', page: 'root' }).code, 400);
  assert.match(post(b, 'viewer@example.com', { action: 'requestAccess', page: 'summary' }).error, /already have access/);
});

test('G4 the action table needs no particular file load order (functions looked up when called)', () => {
  const b = ready();
  for (const [name, a] of Object.entries(b.run('ACTIONS'))) {
    if (typeof a.fn === 'string') assert.equal(typeof b.ctx[a.fn], 'function', `${name} → ${a.fn}`);
  }
});

// ---------- G3: cycles ----------

test('G3 a closed cycle ends exactly at the next reading: units = energy difference × meter factor, final bill by the engine', () => {
  const b = ready();
  const bills = b.ctx.billsSorted_();
  const s = post(b, 'admin@example.com', { action: 'summary', cycle: B1 });
  const units = (bills[1].startEnergy - bills[0].startEnergy) * 1.02;
  assert.ok(Math.abs(s.calc.unitsSoFar - units) < 1e-9);
  assert.ok(Math.abs(s.calc.daysElapsed - 2) < 1e-9);
  assert.equal(s.calc.daysLeft, 0);
  assert.equal(s.calc.chargesSoFar.total, b.ctx.Billing.billFor(s.calc.unitsSoFar, 2).total);
  assert.deepEqual([s.cycle.start, s.cycle.end, s.cycle.current], [B1, B2, false]);
  assert.ok(Math.abs(s.calc.days.reduce((t, d) => t + d.units, 0) - units) < 1e-9, 'daily units add up');
});

test('G3 the current cycle is exactly what it was before Phase 1 (no regression)', () => {
  const b = ready();
  const now = b.ctx.summary_({}, { email: 'admin@example.com', pages: ['summary', 'past', 'breakdown', 'documents', 'health'] });
  const bills = b.ctx.billsSorted_();
  const raw = b.ctx.hourlyPoints_(bills[1].ts - 24 * H);
  const pts = b.ctx.Quality.fillGaps(b.ctx.Quality.cleanPoints(raw));
  const before = b.ctx.cycleCalc_(bills[1], pts, [], b.ctx.tariffVersions_(), now.serverTime, now.typicalDays);
  assert.equal(JSON.stringify(now.calc), JSON.stringify(before));
  assert.equal(now.cycle.current, true);
});

test('G3 the cycle list: closed cycles with stored results + the current one; rebuilt only when inputs change', () => {
  const b = ready();
  const c1 = b.ctx.cycles_();
  assert.deepEqual(json(c1.map(c => [c.start, c.current])), [[B1, false], [B2, true]]);
  assert.ok(c1[0].units > 0 && c1[0].appTotal > 0 && c1[0].coverage > 0.5);
  assert.equal(b.tab('Cycles').rows.length, 2, 'one stored closed cycle');
  const key = b.props.get('CYCLES_KEY');
  b.tab('Cycles').rows[1][3] = 999;                               // stored result is used while inputs are unchanged
  assert.equal(b.ctx.cycles_()[0].units, 999);
  b.ctx.saveCorrection_({ kind: 'adjust', from: B1 + 10 * H, to: B1 + 12 * H, value: 2, reason: 'test add' }, { email: 'admin@example.com' });
  const c2 = b.ctx.cycles_();
  assert.notEqual(b.props.get('CYCLES_KEY'), key, 'a correction changes the key');
  assert.ok(Math.abs(c2[0].units - (c1[0].units + 2 * 1.02)) < 1e-9, 'rebuilt with the correction');
});

test('G3 a cycle that starts before the logger existed has no logger units (null) and almost no coverage', () => {
  const b = ready();
  b.tab('Bills').appendRow([START - 30 * 86400e3, 'x', '', '', 'before logger', 'setup', new Date()]);
  const first = b.ctx.cycles_()[0];
  assert.deepEqual([first.units, first.appTotal], [null, null]);
  assert.ok(first.coverage < 0.05, 'only the first logger day overlaps this cycle');
});

test('G3 an unknown cycle is refused', () => {
  const b = ready();
  const r = post(b, 'admin@example.com', { action: 'summary', cycle: 12345 });
  assert.deepEqual([r.code, r.error], [404, 'That bill cycle does not exist.']);
});

// ---------- G2: Bills → Breakdown (server) ----------

test('G2 the breakdown comes only with Bill breakdown; current = so far + projected, past = final', () => {
  const b = ready();
  assert.equal(post(b, 'viewer@example.com', { action: 'summary' }).breakdown, undefined);
  const cur = post(b, 'past@example.com', { action: 'summary' });
  assert.deepEqual(Object.keys(cur.breakdown), ['soFar', 'projected']);
  assert.equal(cur.breakdown.soFar.bill.total, cur.calc.chargesSoFar.total);
  assert.equal(cur.breakdown.projected.bill.total, cur.calc.projectedBill.total);
  const past = post(b, 'past@example.com', { action: 'summary', cycle: B1 });
  assert.deepEqual(Object.keys(past.breakdown), ['final']);
  const f = past.breakdown.final;
  assert.equal(f.bill.total, b.ctx.Billing.billFor(f.units, f.days).total, 'final bill = engine on the cycle\'s units and days');
  assert.equal(f.statement.payable, Math.round(f.bill.total), 'no arrears/sundry until the DHBVN bill is uploaded');
  assert.ok(f.bill.slabLines.length >= 1 && f.whatIf.nextUnit > 0);
});
