// D2: the server (apps-script/Engine.gs) runs exactly the browser engine (js/billing.js, js/quality.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildEngine, OUTPUT } from '../scripts/build-gs.mjs';
import * as Billing from '../js/billing.js';
import * as Quality from '../js/quality.js';

const server = vm.createContext({});
vm.runInContext(fs.readFileSync(OUTPUT, 'utf8'), server, { filename: 'Engine.gs' });
const S = server.Billing, Q = server.Quality;
// Results cross the vm boundary; compare their JSON (Infinity/Dates as Apps Script would send them)
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

// Small repeatable random numbers
let seed = 20261018;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test('D2 Engine.gs is generated from the current js/ files', () => {
  assert.equal(fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n'), buildEngine(), 'run: node scripts/build-gs.mjs');
});

test('D2 server and browser agree on the 6 real bills', () => {
  for (const b of server.ENGINE_FIXTURE.bills) same(S.billFor(b.units, b.days), Billing.billFor(b.units, b.days), b.period);
});

test('D2 server and browser agree on 1,000 random bills', () => {
  for (let i = 0; i < 1000; i++) {
    const days = 1 + Math.floor(rnd() * 90), units = Math.round(rnd() * 25 * days * 10) / 10;
    same(S.billFor(units, days), Billing.billFor(units, days), `${units} units / ${days} days`);
    same(S.payableFor(units, -0.4, 0.4), Billing.payableFor(units, -0.4, 0.4));
  }
});

test('D2 server and browser agree on 50 random cycles (with gaps, corrections, tariff changes)', () => {
  for (let i = 0; i < 50; i++) {
    const start = Date.parse('2026-01-01T00:00:00+05:30') + Math.floor(rnd() * 300) * 86400e3 + Math.floor(rnd() * 24) * 3600e3;
    const hours = 24 + Math.floor(rnd() * 24 * 60);
    const raw = [];
    let e = 1000;
    for (let h = 1; h <= hours; h++) { e += rnd() * 0.6; if (rnd() > 0.1) raw.push({ ts: start + h * 3600e3, energy: e, rows: Math.floor(rnd() * 61) }); }
    const corrections = [{ kind: 'adjust', from: start + 5 * 3600e3, value: -rnd() }, { kind: 'exclude', from: start + 30 * 3600e3, to: start + 33 * 3600e3 }];
    const prep = (B, Qx) => {
      const pts = Qx.fillGaps(Qx.cleanPoints(Qx.applyCorrections(raw, corrections))).map(p => ({ ts: new Date(p.ts), energy: p.energy }));
      return B.cycleSummary({
        cycleStart: new Date(start), startEnergy: 1000, cycleEnd: new Date(start + 60 * 86400e3), points: pts, now: new Date(start + hours * 3600e3),
        tariffs: [{ from: -Infinity, tariff: B.DEFAULT_TARIFF }, { from: start + 40 * 86400e3, tariff: B.normalizeTariff({ dutyPerUnit: 0.2 }) }],
      });
    };
    same(prep(S, Q), prep(Billing, Quality), `cycle ${i}`);
    same(Q.coverage(raw, start, start + hours * 3600e3), Quality.coverage(raw, start, start + hours * 3600e3));
    same(Q.findGaps(raw), Quality.findGaps(raw));
  }
});
