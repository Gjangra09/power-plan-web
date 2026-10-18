/**
 * Bill cycles for the cycle picker. A cycle runs from one meter reading (Bills row) to the next;
 * the last one is the current cycle. A closed cycle's units are the logger energy between the two
 * readings, calculated by the same engine as the current cycle.
 *
 * Closed cycles never change unless their inputs do, so their results are kept in the Cycles tab
 * and rebuilt only when bills, corrections or tariff versions change (a hash of them is stored).
 */

/** Cycles oldest first: [{start, end, current, days, units, avgPerDay, band, appTotal, dhbvnTotal, coverage}]. */
function cycles_() {
  const bills = billsSorted_();
  const corrections = corrections_().filter(c => c.active);
  const versions = tariffVersions_();
  const key = cyclesKey_(bills, corrections, versions);
  const props = PropertiesService.getScriptProperties();
  let closed;
  if (props.getProperty('CYCLES_KEY') === key) {
    closed = readTab_('Cycles').map(r => ({
      start: Number(r.StartMs), end: Number(r.EndMs), days: Number(r.Days),
      units: r.Units === '' ? null : Number(r.Units), avgPerDay: r.AvgPerDay === '' ? null : Number(r.AvgPerDay),
      band: String(r.Band), appTotal: r.AppTotal === '' ? null : Number(r.AppTotal),
      dhbvnTotal: r.DhbvnTotal === '' ? null : Number(r.DhbvnTotal), coverage: Number(r.CoveragePct) / 100,
    }));
  } else {
    closed = buildCycles_(bills, corrections, versions);
    const sh = tab_('Cycles');
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
    const now = new Date();
    if (closed.length) {
      sh.getRange(2, 1, closed.length, TABS.Cycles.length).setValues(closed.map(c => [
        // full precision: a stored cycle must equal the same cycle calculated live
        c.start, c.end, c.days, c.units === null ? '' : c.units, c.avgPerDay === null ? '' : c.avgPerDay,
        c.band, c.appTotal === null ? '' : c.appTotal, c.dhbvnTotal === null ? '' : c.dhbvnTotal, round_(c.coverage * 100, 1), now,
      ]));
    }
    props.setProperty('CYCLES_KEY', key);
  }
  const latest = bills[bills.length - 1];
  const out = closed.map(c => Object.assign(c, { current: false }));
  if (latest) out.push({ start: latest.ts, end: latest.expectedNextTs || null, current: true });
  return out;
}

/** Closed cycles calculated from the Hourly history. */
function buildCycles_(bills, corrections, versions) {
  if (bills.length < 2) return [];
  const raw = hourlyPoints_(bills[0].ts - APP.LEAD_HOURS * 3600e3);
  const out = [];
  for (let i = 0; i + 1 < bills.length; i++) {
    const bill = bills[i], next = bills[i + 1];
    const days = (next.ts - bill.ts) / 86400e3;
    const inside = raw.filter(p => p.ts >= bill.ts && p.ts < next.ts);
    const coverage = Quality.coverage(inside, bill.ts, next.ts).share;
    const calc = closedCycleCalc_(bill, next, raw, corrections, versions);
    out.push({
      start: bill.ts, end: next.ts, days,
      units: calc ? calc.unitsSoFar : null,
      avgPerDay: calc ? calc.unitsSoFar / days : null,
      band: calc ? calc.chargesSoFar.band : '',
      appTotal: calc ? calc.chargesSoFar.total : null,
      dhbvnTotal: null,   // filled from confirmed uploaded bills (BillDocs) in Phase 1C
      coverage,
    });
  }
  return out;
}

/**
 * The final figures of a closed cycle, or null when the logger has no reading at either end.
 * The cycle ends exactly at the next reading: its corrected start energy is added as the last point.
 */
function closedCycleCalc_(bill, next, raw, corrections, versions) {
  if (bill.startEnergy == null || next.startEnergy == null) return null;
  const adjust = corrections.filter(c => c.kind === 'adjust');
  const at = (ts, energy) => Quality.applyCorrections([{ ts, energy }], adjust)[0].energy;
  const points = Quality.fillGaps(Quality.cleanPoints(
    Quality.applyCorrections(raw.filter(p => p.ts > bill.ts - APP.LEAD_HOURS * 3600e3 && p.ts < next.ts), corrections)
      .concat([{ ts: next.ts, energy: at(next.ts, next.startEnergy) }])));
  return Billing.cycleSummary({
    cycleStart: new Date(bill.ts), startEnergy: at(bill.ts, bill.startEnergy),
    cycleEnd: new Date(next.ts),
    points: points.map(p => ({ ts: new Date(p.ts), energy: p.energy })),
    now: new Date(next.ts),
    tariffs: versions.map(v => ({ from: v.from, tariff: v.tariff })),
  });
}

/** Changes whenever anything a closed cycle depends on changes. */
function cyclesKey_(bills, corrections, versions) {
  return 'v1:' + hash_(JSON.stringify([
    bills.map(b => [b.ts, b.startEnergy]),
    corrections.map(c => [c.id, c.kind, c.from, c.to, c.value]),
    versions.map(v => [v.id, v.from, v.tariff]),
  ]));
}

/** Short FNV-1a hash of a string (no secrets involved; only detects change). */
function hash_(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + ':' + s.length;
}

/** Forgets the stored cycles (run after editing Hourly or Bills directly in the sheet). */
function rebuildCycles() {
  PropertiesService.getScriptProperties().deleteProperty('CYCLES_KEY');
  Logger.log(`Cycles rebuilt: ${cycles_().filter(c => !c.current).length} closed cycles.`);
}
