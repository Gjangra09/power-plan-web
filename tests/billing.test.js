import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billFor, avgCycleDays, cycleSummary, energyAt, DEFAULT_TARIFF } from '../js/billing.js';

// Real DHBVN bills, from 'Actual Bills.tmdl' (entered from the PDFs in Power Plan Report\Bills)
const BILLS = [
  { days: 50, units: 181.4, energy: 535.13, fppas: 0, tax: 10.70, duty: 18.14, total: 563.97 },
  { days: 64, units: 317.2, energy: 935.74, fppas: 0, tax: 18.71, duty: 31.72, total: 986.17 },
  { days: 70, units: 279.7, energy: 825.12, fppas: 0, tax: 16.50, duty: 27.97, total: 869.59 },
  { days: 55, units: 192.7, energy: 568.47, fppas: 0, tax: 11.37, duty: 19.27, total: 599.11 },
  { days: 56, units: 311.1, energy: 989.28, fppas: 0, tax: 19.79, duty: 31.11, total: 1040.18 },
  { days: 63, units: 496.6, energy: 1882.65, fppas: 233.40, tax: 42.32, duty: 49.66, total: 2208.03 },
];

for (const b of BILLS) {
  test(`reproduces the ${b.days}-day bill of ${b.units} units (₹${b.total})`, () => {
    const r = billFor(b.units, b.days);
    assert.ok(Math.abs(r.energy - b.energy) < 0.05, `energy ${r.energy}`);
    assert.ok(Math.abs(r.fppas - b.fppas) < 0.05, `fppas ${r.fppas}`);
    assert.ok(Math.abs(r.municipalTax - b.tax) < 0.05, `tax ${r.municipalTax}`);
    assert.ok(Math.abs(r.duty - b.duty) < 0.05, `duty ${r.duty}`);
    assert.ok(Math.abs(r.total - b.total) < 1, `total ${r.total}`);
  });
}

test('band A below 3.33 units/day, band B above', () => {
  assert.equal(billFor(3.3 * 60, 60).band, 'A');
  assert.equal(billFor(3.34 * 60, 60).band, 'B');
});

test('FPPAS starts exactly at 200 units per 30 days', () => {
  assert.equal(billFor(199.9, 30).fppas, 0);
  assert.ok(billFor(200, 30).fppas > 0);
});

test('zero days or no units gives an empty bill', () => {
  assert.equal(billFor(10, 0).total, 0);
  assert.equal(billFor(0, 10).total, 0);
});

test('average cycle length from the 7 DHBVN bill dates is about 60 days', () => {
  const dates = ['2025-09-25', '2025-11-14', '2026-01-17', '2026-03-28', '2026-05-22', '2026-07-17', '2026-09-18']
    .map(s => new Date(s + 'T00:00:00'));
  assert.ok(Math.abs(avgCycleDays(dates) - 358 / 6) < 1e-9);
});

test('energyAt interpolates between snapshots', () => {
  const pts = [{ ts: new Date('2026-09-18T10:00:00'), energy: 100 }, { ts: new Date('2026-09-18T12:00:00'), energy: 102 }];
  assert.equal(energyAt(new Date('2026-09-18T11:00:00'), pts), 101);
  assert.equal(energyAt(new Date('2026-09-18T09:00:00'), pts), 100);
  assert.equal(energyAt(new Date('2026-09-18T13:00:00'), pts), 102);
});

test('cycle summary: steady 5 units/day for 10 days of a 60-day cycle', () => {
  const start = new Date('2026-09-18T10:00:00');
  const points = [];
  for (let h = 1; h <= 240; h++) points.push({ ts: new Date(start.getTime() + h * 3600e3), energy: 1000 + 5 * h / 24 });
  const s = cycleSummary({
    cycleStart: start, startEnergy: 1000, cycleEnd: new Date(start.getTime() + 60 * 86400e3),
    points, now: new Date(start.getTime() + 240 * 3600e3), tariff: { ...DEFAULT_TARIFF, meterFactor: 1 },
  });
  assert.ok(Math.abs(s.unitsSoFar - 50) < 1e-9);
  assert.ok(Math.abs(s.daysElapsed - 10) < 1e-9);
  assert.ok(Math.abs(s.growingAvg - 5) < 1e-9);
  assert.ok(Math.abs(s.projectedUnits - 300) < 1e-9);
  assert.ok(Math.abs(s.projectedBill.total - billFor(300, 60).total) < 1e-9);
  assert.equal(s.projectedBill.band, 'B');
  assert.ok(s.bandB.projectedOver);    // 300 > 3.33 × 60 = 199.8
  assert.ok(!s.fppas.projectedOver);   // 300 < 200 / 30 × 60 = 400
  assert.ok(Math.abs(s.fppas.safePerDay - (400 - 50) / 50) < 1e-9);
  assert.ok(Math.abs(s.days.reduce((a, d) => a + d.units, 0) - 50) < 1e-9);
  const last = s.projection[s.projection.length - 1];
  assert.ok(Math.abs(last.cumUnits - 300) < 1e-6);
});

test('meter factor scales logged units like Power BI Summary[Diff] (× 1.02)', () => {
  const start = new Date('2026-09-18T00:00:00');
  const points = [1, 2].map(d => ({ ts: new Date(start.getTime() + d * 86400e3 - 60e3), energy: 1000 + 5 * d }));
  const s = cycleSummary({ cycleStart: start, startEnergy: 1000, cycleEnd: new Date(start.getTime() + 60 * 86400e3), points, now: points[1].ts });
  assert.ok(Math.abs(s.unitsSoFar - 10.2) < 1e-9);
  assert.deepEqual(s.days.map(d => Math.round(d.units * 100) / 100), [5.1, 5.1]);
});
