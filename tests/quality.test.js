import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCorrections, cleanPoints, findGaps, fillGaps, coverage } from '../js/quality.js';
import { cycleSummary, DEFAULT_TARIFF } from '../js/billing.js';

const H = 3600e3;
const T0 = Date.parse('2026-09-18T10:00:00+05:30');

// Hourly snapshots at 0.5 kWh/hour with the given hours missing
function series(hours, missing = []) {
  const out = [];
  for (let h = 0; h <= hours; h++) if (!missing.includes(h)) out.push({ ts: T0 + h * H, energy: 1000 + 0.5 * h, rows: 60 });
  return out;
}
const summary = pts => cycleSummary({
  cycleStart: new Date(T0), startEnergy: 1000, cycleEnd: new Date(T0 + 60 * 24 * H),
  points: pts.map(p => ({ ts: new Date(p.ts), energy: p.energy })), now: new Date(T0 + 96 * H),
  tariff: { ...DEFAULT_TARIFF, meterFactor: 1 },
});

// ---------- D3: corrections are predictable ----------

test('D3 an "adjust" correction changes only the snapshots it covers', () => {
  const pts = series(48);
  const out = applyCorrections(pts, [{ kind: 'adjust', from: T0 + 30 * H, value: -2 }]);
  out.forEach((p, i) => assert.equal(p.energy, pts[i].energy + (p.ts >= T0 + 30 * H ? -2 : 0)));
  assert.deepEqual(pts, series(48), 'input untouched');
});

test('D3 an "exclude" correction removes only its range (treated as a gap)', () => {
  const pts = series(48);
  const out = applyCorrections(pts, [{ kind: 'exclude', from: T0 + 10 * H, to: T0 + 12 * H }]);
  assert.deepEqual(out.map(p => (p.ts - T0) / H), pts.map(p => (p.ts - T0) / H).filter(h => h < 10 || h > 12));
});

test('D3 switching a correction off restores the exact previous result', () => {
  const pts = series(96);
  const before = summary(applyCorrections(pts, []));
  const on = summary(applyCorrections(pts, [{ kind: 'adjust', from: T0 + 50 * H, value: -3, active: true }]));
  const off = summary(applyCorrections(pts, [{ kind: 'adjust', from: T0 + 50 * H, value: -3, active: false }]));
  assert.notDeepEqual(on, before);
  assert.deepEqual(off, before);
  assert.ok(Math.abs(on.unitsSoFar - (before.unitsSoFar - 3)) < 1e-9, 'total changes by exactly the correction');
});

test('D3 applying corrections is idempotent: same input, same output, every time', () => {
  const pts = series(96, [20, 21]);
  const corr = [{ kind: 'adjust', from: T0 + 5 * H, to: T0 + 9 * H, value: 1 }, { kind: 'exclude', from: T0 + 40 * H, to: T0 + 41 * H }];
  const a = summary(fillGaps(cleanPoints(applyCorrections(pts, corr))));
  const b = summary(fillGaps(cleanPoints(applyCorrections(pts, corr))));
  assert.deepEqual(a, b);
});

test('D3 units added for a period are spread over it and count in every later reading (the total goes up)', () => {
  const pts = series(96);
  const corr = [{ kind: 'adjust', from: T0 + 10 * H, to: T0 + 14 * H, value: 4 }];
  const out = applyCorrections(pts, corr);
  const added = out.map((p, i) => Math.round((p.energy - pts[i].energy) * 1e9) / 1e9);
  assert.deepEqual(added.slice(8, 17), [0, 0, 0, 1, 2, 3, 4, 4, 4], 'before 0, during 1 kWh/hour, after all 4');
  assert.equal(added[added.length - 1], 4);
  const before = summary(pts), after = summary(out);
  assert.ok(Math.abs(after.unitsSoFar - before.unitsSoFar - 4) < 1e-9, 'cycle total + 4 units');
  assert.ok(Math.abs(after.days.reduce((s, d) => s + d.units, 0) - before.days.reduce((s, d) => s + d.units, 0) - 4) < 1e-9, 'daily units add up to it');
});

test('D3 subtracting more than was used in a period never shows negative use, and the total drops by exactly that much', () => {
  const pts = series(96);
  const out = cleanPoints(applyCorrections(pts, [{ kind: 'adjust', from: T0 + 4 * H, to: T0 + 5 * H, value: -3 }]));
  for (let i = 1; i < out.length; i++) assert.ok(out[i].energy >= out[i - 1].energy);
  assert.ok(Math.abs(out[out.length - 1].energy - (pts[pts.length - 1].energy - 3)) < 1e-9);
});

// ---------- D4: data quality ----------

test('D4 duplicate timestamps keep one snapshot (the later row) and the series is sorted', () => {
  const pts = [{ ts: T0 + 2 * H, energy: 3 }, { ts: T0, energy: 1 }, { ts: T0 + H, energy: 2 }, { ts: T0 + H, energy: 2.1 }];
  assert.deepEqual(cleanPoints(pts).map(p => [p.ts - T0, p.energy]), [[0, 1], [H, 2.1], [2 * H, 3]]);
});

test('D4 gaps are classed: short ones filled, long ones outage', () => {
  const pts = series(30, [3, 4, 10, 11, 12, 13, 14, 15, 16, 17]);
  const gaps = findGaps(pts);
  assert.deepEqual(gaps.map(g => [g.hours, g.kind]), [[3, 'filled'], [9, 'outage']]);
  assert.ok(Math.abs(gaps[1].units - 4.5) < 1e-9, 'outage units = counter jump');
});

test('D4 filling a short gap spreads its units evenly and never changes the total', () => {
  const pts = series(10, [3, 4]);
  const filled = fillGaps(pts);
  assert.deepEqual(filled.filter(p => p.filled).map(p => (p.ts - T0) / H), [3, 4]);
  assert.deepEqual(filled.filter(p => p.filled).map(p => p.energy), [1001.5, 1002]);
  assert.equal(filled[filled.length - 1].energy, pts[pts.length - 1].energy);
  assert.equal(findGaps(filled).length, 0);
});

test('D4 an outage is not filled: its units land when the logger is back, totals unchanged', () => {
  const pts = series(96, [...Array(20).keys()].map(k => 30 + k));   // 21-hour outage
  const s1 = summary(pts), s2 = summary(fillGaps(pts));
  assert.equal(fillGaps(pts).length, pts.length);
  assert.equal(s2.unitsSoFar, s1.unitsSoFar);
});

test('D4 a daily split moves across days when a gap is filled, but the cycle total stays the same', () => {
  // 4-hour gap across India midnight: hours 13–16 after 10:00 → 23:00–02:00
  const pts = series(48, [13, 14, 15]);
  const raw = summary(pts), filled = summary(fillGaps(pts));
  assert.ok(Math.abs(raw.unitsSoFar - filled.unitsSoFar) < 1e-9);
  assert.notDeepEqual(raw.days.map(d => d.units), filled.days.map(d => d.units));
  // A day ends at its last snapshot: 22:00 without filling, the filled 23:00 point with it
  assert.ok(Math.abs(raw.days[0].units - 6) < 1e-9, 'unfilled day 1 = 12 hours × 0.5');
  assert.ok(Math.abs(filled.days[0].units - 6.5) < 1e-9, 'filled day 1 = 13 hours × 0.5');
  assert.ok(Math.abs(raw.days[1].units - filled.days[1].units - 0.5) < 1e-9, 'the 0.5 moved from day 2 to day 1');
});

test('D4 coverage: complete, partial and missing hours', () => {
  const hours = [
    { ts: T0, rows: 60 }, { ts: T0 + H, rows: 59 }, { ts: T0 + 2 * H, rows: 20 },
    { ts: T0 + 4 * H, rows: 45 }, { ts: T0 + 4 * H + 60e3, rows: 1 },   // same hour, two rows → 46
  ];
  assert.deepEqual(coverage(hours, T0, T0 + 6 * H), { total: 6, complete: 3, partial: 1, missing: 2, share: 4 / 6 });
});

import { adjustBetween } from '../js/quality.js';

test('adjustBetween: the part of a spread correction inside a period; a one-off counts fully after it', () => {
  const c = { kind: 'adjust', from: T0, to: T0 + 10 * H, value: -10 };
  assert.ok(Math.abs(adjustBetween(c, T0 - H, T0 + 2 * H) + 2) < 1e-9, '2 of 10 hours → −2');
  assert.ok(Math.abs(adjustBetween(c, T0 + 2 * H, T0 + 20 * H) + 8) < 1e-9, 'the rest → −8');
  assert.equal(adjustBetween({ kind: 'adjust', from: T0, value: 3 }, T0 - H, T0 + H), 3);
  assert.equal(adjustBetween({ kind: 'exclude', from: T0, to: T0 + H }, T0 - H, T0 + 2 * H), 0);
  assert.equal(adjustBetween({ ...c, active: false }, T0 - H, T0 + 20 * H), 0);
});
