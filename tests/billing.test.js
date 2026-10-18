import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  billFor, billForParts, tariffParts, payableFor, paisa, normalizeTariff, whatIf, cycleBreakdown, checkDhbvnBill, compareWithApp, meterCalibration,
  avgCycleDays, cycleSummary, energyAt, dayKey, DEFAULT_TARIFF,
} from '../js/billing.js';

// Six real DHBVN bills (anonymised amounts), Sep 2025 → Sep 2026
const { bills: BILLS } = JSON.parse(fs.readFileSync(new URL('./fixtures/dhbvn-bills.json', import.meta.url), 'utf8'));
const DAY = 86400e3;

// ---------- D1: every bill line to the paisa ----------

for (const b of BILLS) {
  test(`D1 ${b.period}: every line of the DHBVN bill to the paisa (${b.units} units, ${b.days} days)`, () => {
    const r = billFor(b.units, b.days);
    assert.deepEqual(r.slabLines.map(l => [paisa(l.units), l.rate, l.amount]), b.slabs.map(l => [l.units, l.rate, l.amount]), 'slab lines');
    assert.equal(r.energy, b.energy, '1 energy');
    assert.equal(r.fixed, b.fixed, '2 fixed');
    assert.equal(r.fppas, b.fppas, '3 FPPAS');
    assert.equal(r.municipalTax, b.tax, '4 municipal tax');
    assert.equal(r.duty, b.duty, '5 duty');
    assert.equal(r.total, b.total, 'B total');
    const sundry = b.sundry.reduce((s, x) => s + x, 0);
    assert.equal(payableFor(r.total, b.arrears, sundry).payable, b.payable, 'payable [A+B+C]');
  });
}

test('D1 the paisa left by rounding the payable becomes the next bill\'s arrears', () => {
  for (let i = 0; i + 1 < BILLS.length; i++) {
    const b = BILLS[i];
    const { carry } = payableFor(b.total, b.arrears, b.sundry.reduce((s, x) => s + x, 0));
    assert.equal(carry, BILLS[i + 1].arrears, `${b.period} → ${BILLS[i + 1].period}`);
  }
});

test('paisa rounding is half-up despite binary floating point', () => {
  assert.equal(paisa(31.1 * 5.25), 163.28);   // 163.27499999999998 in floating point
  assert.equal(paisa(192.7 * 2.95), 568.47);
  assert.equal(paisa(-0.164), -0.16);
});

// ---------- tariff rules ----------

test('band A below 3.33 units/day, band B above', () => {
  assert.equal(billFor(3.3 * 60, 60).band, 'A');
  assert.equal(billFor(3.34 * 60, 60).band, 'B');
});

test('FPPAS starts exactly at 200 units per 30 days', () => {
  assert.equal(billFor(199.9, 30).fppas, 0);
  assert.ok(billFor(200, 30).fppas > 0);
});

test('fixed charge ₹50/kW/month only above 300 units a month (2 kW load)', () => {
  assert.equal(billFor(300, 30).fixed, 0);
  const heavy = billFor(360, 30);                       // 12 units/day, 360/month
  assert.equal(heavy.fixed, 100);                       // 50 × 2 kW × 1 month
  assert.equal(heavy.municipalTax, paisa(0.02 * (heavy.energy + heavy.fixed + heavy.fppas)));
  assert.equal(billFor(720, 60).fixed, 200);            // two months
  assert.deepEqual(heavy.slabLines.map(l => [l.units, l.rate]), [[150, 2.95], [150, 5.25], [60, 6.45]]);
});

test('zero days or no units gives an empty bill', () => {
  assert.equal(billFor(10, 0).total, 0);
  assert.equal(billFor(0, 10).total, 0);
});

test('tariff saved as JSON (Infinity → null) works the same after normalizeTariff', () => {
  const t = normalizeTariff(JSON.parse(JSON.stringify(DEFAULT_TARIFF)));
  assert.equal(t.slabs.B[3].to, Infinity);
  for (const b of BILLS) assert.deepEqual(billFor(b.units, b.days, t), billFor(b.units, b.days));
  assert.equal(normalizeTariff({ dutyPerUnit: 0.2 }).fppasPerUnit, 0.47);
});

// ---------- tariff versions ----------

test('one tariff version: same bill as billFor', () => {
  const parts = tariffParts(0, 60 * DAY, [{ from: -Infinity, tariff: DEFAULT_TARIFF }]);
  assert.deepEqual(billForParts(300, parts), billFor(300, 60));
});

test('tariff change mid-cycle: units shared by days, each part at its own rates', () => {
  const dearer = normalizeTariff({ dutyPerUnit: 0.20 });
  const start = Date.UTC(2026, 0, 1), change = start + 20 * DAY, end = start + 60 * DAY;
  const parts = tariffParts(start, end, [{ from: change, tariff: dearer }, { from: -Infinity, tariff: DEFAULT_TARIFF }]);
  assert.deepEqual(parts.map(p => p.days), [20, 40]);
  const r = billForParts(300, parts);
  assert.equal(r.duty, paisa(0.10 * 100) + paisa(0.20 * 200));
  assert.equal(r.total, paisa(billFor(100, 20).total + billFor(200, 40, dearer).total));
});

// ---------- cycle summary ----------

test('average cycle length from the 7 DHBVN bill dates is about 60 days', () => {
  const dates = ['2025-09-25', '2025-11-14', '2026-01-17', '2026-03-28', '2026-05-22', '2026-07-17', '2026-09-18']
    .map(s => new Date(s + 'T00:00:00+05:30'));
  assert.ok(Math.abs(avgCycleDays(dates) - 358 / 6) < 1e-9);
});

test('energyAt interpolates between snapshots', () => {
  const pts = [{ ts: new Date('2026-09-18T10:00:00+05:30'), energy: 100 }, { ts: new Date('2026-09-18T12:00:00+05:30'), energy: 102 }];
  assert.equal(energyAt(new Date('2026-09-18T11:00:00+05:30'), pts), 101);
  assert.equal(energyAt(new Date('2026-09-18T09:00:00+05:30'), pts), 100);
  assert.equal(energyAt(new Date('2026-09-18T13:00:00+05:30'), pts), 102);
});

test('days follow India time wherever the code runs', () => {
  assert.equal(dayKey(new Date('2026-09-18T23:59:00+05:30')), '2026-09-18');
  assert.equal(dayKey(new Date('2026-09-19T00:00:00+05:30')), '2026-09-19');
  assert.equal(dayKey(new Date('2026-09-18T18:31:00Z')), '2026-09-19');   // 00:01 IST
});

test('cycle summary: steady 5 units/day for 10 days of a 60-day cycle', () => {
  const start = new Date('2026-09-18T10:00:00+05:30');
  const points = [];
  for (let h = 1; h <= 240; h++) points.push({ ts: new Date(start.getTime() + h * 3600e3), energy: 1000 + 5 * h / 24 });
  const s = cycleSummary({
    cycleStart: start, startEnergy: 1000, cycleEnd: new Date(start.getTime() + 60 * DAY),
    points, now: new Date(start.getTime() + 240 * 3600e3), tariff: { ...DEFAULT_TARIFF, meterFactor: 1 },
  });
  assert.ok(Math.abs(s.unitsSoFar - 50) < 1e-9);
  assert.ok(Math.abs(s.daysElapsed - 10) < 1e-9);
  assert.ok(Math.abs(s.growingAvg - 5) < 1e-9);
  assert.ok(Math.abs(s.projectedUnits - 300) < 1e-9);
  assert.equal(s.projectedBill.total, billFor(300, 60).total);
  assert.equal(s.projectedBill.band, 'B');
  assert.ok(s.bandB.projectedOver);    // 300 > 3.33 × 60 = 199.8
  assert.ok(!s.fppas.projectedOver);   // 300 < 200 / 30 × 60 = 400
  assert.ok(Math.abs(s.fppas.safePerDay - (400 - 50) / 50) < 1e-9);
  assert.ok(Math.abs(s.days.reduce((a, d) => a + d.units, 0) - 50) < 1e-9);
  const last = s.projection[s.projection.length - 1];
  assert.ok(Math.abs(last.cumUnits - 300) < 1e-6);
});

test('cycle summary with a tariff change: charges use both versions', () => {
  const start = new Date('2026-09-18T10:00:00+05:30');
  const points = [];
  for (let h = 1; h <= 240; h++) points.push({ ts: new Date(start.getTime() + h * 3600e3), energy: 1000 + 5 * h / 24 });
  const base = { cycleStart: start, startEnergy: 1000, cycleEnd: new Date(start.getTime() + 60 * DAY), points, now: points[239].ts };
  const one = cycleSummary({ ...base, tariff: { ...DEFAULT_TARIFF, meterFactor: 1 } });
  const two = cycleSummary({ ...base, tariffs: [
    { from: -Infinity, tariff: { ...DEFAULT_TARIFF, meterFactor: 1 } },
    { from: start.getTime() + 30 * DAY, tariff: { ...DEFAULT_TARIFF, meterFactor: 1, dutyPerUnit: 0.2 } },
  ] });
  assert.equal(two.chargesSoFar.total, one.chargesSoFar.total);              // change is still in the future
  assert.ok(two.projectedBill.total > one.projectedBill.total);              // but the projection crosses it
  assert.equal(two.projectedBill.duty, paisa(0.1 * 150) + paisa(0.2 * 150));
});

test('meter factor scales logged units like Power BI Summary[Diff] (× 1.02)', () => {
  const start = new Date('2026-09-18T00:00:00+05:30');
  const points = [1, 2].map(d => ({ ts: new Date(start.getTime() + d * DAY - 60e3), energy: 1000 + 5 * d }));
  const s = cycleSummary({ cycleStart: start, startEnergy: 1000, cycleEnd: new Date(start.getTime() + 60 * DAY), points, now: points[1].ts });
  assert.ok(Math.abs(s.unitsSoFar - 10.2) < 1e-9);
  assert.deepEqual(s.days.map(d => Math.round(d.units * 100) / 100), [5.1, 5.1]);
});

// ---------- Bills page: what would change the bill, statement ----------

test('whatIf: 496.6 units in 63 days – band B, 2nd slab, 133.4 units to the next slab, FPPAS already on', () => {
  const w = whatIf(496.6, 63);
  assert.equal(w.band, 'B');
  assert.deepEqual([w.slab.rate, paisa(w.slab.unitsLeft), w.slab.nextRate], [5.25, 133.4, 6.45]);
  assert.equal(w.bandB, null, 'already band B');
  assert.equal(paisa(w.fppas), -76.6, 'FPPAS line was 420 units');
  assert.equal(paisa(w.fixed), 133.4, 'fixed charge starts above 630 units');
  assert.equal(w.nextUnit, paisa(billFor(497.6, 63).total - billFor(496.6, 63).total));
  assert.ok(w.nextUnit > 5.25 && w.nextUnit < 6.5, 'rate + FPPAS + tax + duty');
});

test('whatIf: band A (2.5 units/day) shows the units left before band B', () => {
  const w = whatIf(150, 60);
  assert.deepEqual([w.band, w.slab.rate], ['A', 2.70]);
  assert.equal(paisa(w.bandB), 49.8);
});

test('cycleBreakdown: a closed cycle gives the final bill and the DHBVN payable with arrears and sundry', () => {
  const s = { tariff: DEFAULT_TARIFF, chargesSoFar: billFor(496.6, 63), unitsSoFar: 496.6, daysElapsed: 63 };
  const b = cycleBreakdown(s, false, { arrears: 0.03, sundry: 0 });
  assert.deepEqual(Object.keys(b), ['final']);
  assert.deepEqual([b.final.statement.total, b.final.statement.gross, b.final.statement.payable], [2208.03, 2208.06, 2208]);
  assert.equal(b.final.bill.slabLines.length, 2);
});

test('cycleBreakdown: the current cycle gives "so far" and "projected"', () => {
  const s = { tariff: DEFAULT_TARIFF, chargesSoFar: billFor(150, 30), unitsSoFar: 150, daysElapsed: 30, projectedBill: billFor(300, 60), projectedUnits: 300, cycleDays: 60 };
  const b = cycleBreakdown(s, true);
  assert.deepEqual(Object.keys(b), ['soFar', 'projected']);
  assert.equal(b.projected.statement.payable, Math.round(billFor(300, 60).total));
  assert.equal(b.soFar.statement.arrears, 0);
});

// ---------- G2: uploaded bills ----------

for (const b of BILLS) {
  test(`G2 "Is DHBVN's bill right?" – ${b.period}: lines add up, payable adds up, tariff gives the same lines`, () => {
    const c = checkDhbvnBill(b);
    assert.deepEqual([c.linesAddUp, c.payableAddsUp, c.slabsMatch, c.right], [true, true, true, true]);
  });
}

test('G2 a bill whose figures do not add up, or whose energy line is off, is flagged', () => {
  const b = { ...BILLS[5], energy: BILLS[5].energy + 10 };
  const c = checkDhbvnBill(b);
  assert.equal(c.linesAddUp, false);
  assert.equal(c.right, false);
  assert.deepEqual(c.lines.filter(l => !l.ok).map(l => l.key), ['energy']);
});

test('G2 comparison with the app: same units → all lines ok; 2% more units → units warn, money follows', () => {
  const b = BILLS[5];
  const same = compareWithApp(b, { units: b.units, bill: billFor(b.units, b.days) });
  assert.ok(same.rows.every(r => r.status === 'ok'), JSON.stringify(same.rows.filter(r => r.status !== 'ok')));
  const more = compareWithApp(b, { units: b.units * 1.02, bill: billFor(b.units * 1.02, b.days) });
  const units = more.rows.find(r => r.key === 'units');
  assert.deepEqual([units.status, units.reason], ['warn', 'logger vs meter (see calibration)']);
  assert.ok(more.rows.filter(r => r.key !== 'units' && r.status !== 'ok').every(r => r.reason === 'follows the unit difference'));
  assert.ok(Math.abs(more.unitsRatio - 1 / 1.02) < 1e-9);
});

test('meter calibration: DHBVN ÷ logger units, weighted by units, over usable cycles', () => {
  assert.deepEqual(meterCalibration([{ dhbvnUnits: 101, loggerUnits: 100 }, { dhbvnUnits: 303, loggerUnits: 300 }, { dhbvnUnits: 50, loggerUnits: 0 }]), { factor: 1.01, cycles: 2 });
  assert.equal(meterCalibration([]), null);
});
