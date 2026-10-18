// Tariff + projection engine for a DHBVN domestic (Category II) bill cycle.
// Pure functions only: no DOM, no network. Ported from the Power BI measures in
// Summary.tmdl ('Projected Cycle Bill', 'Estimated Cycle Charges') and the Charges table.

const DAY_MS = 24 * 3600 * 1000;

export const DEFAULT_TARIFF = {
  // Band B applies when the cycle averages more than this many units per day (100 units/month)
  bandBAbovePerDay: 3.33,
  // Slab boundaries are in units per day; the bill charges each slab for every day of the cycle
  slabs: {
    A: [
      { from: 0, to: 5 / 3, rate: 2.20 },
      { from: 5 / 3, to: 10 / 3, rate: 2.70 },
    ],
    B: [
      { from: 0, to: 5, rate: 2.95 },
      { from: 5, to: 10, rate: 5.25 },
      { from: 10, to: 16.67, rate: 6.45 },
      { from: 16.67, to: Infinity, rate: 7.10 },
    ],
  },
  fppasPerUnit: 0.47,      // only charged when usage is at or above fppasFromMonthly
  fppasFromMonthly: 200,   // units per 30 days
  municipalTaxPct: 0.02,   // of (energy + FPPAS)
  dutyPerUnit: 0.10,
  // The logger reads about 2% under the DHBVN meter; same adjustment as Power BI's Summary[Diff]
  meterFactor: 1.02,
};

/** Bill for `units` used over `days` days, using the same rules as the DHBVN bill. */
export function billFor(units, days, tariff = DEFAULT_TARIFF) {
  if (!(days > 0) || !(units >= 0)) {
    return { units: 0, days: 0, avgDaily: 0, band: 'A', energy: 0, fppas: 0, municipalTax: 0, duty: 0, total: 0 };
  }
  const avgDaily = units / days;
  const band = avgDaily > tariff.bandBAbovePerDay ? 'B' : 'A';
  const energyPerDay = tariff.slabs[band].reduce(
    (sum, s) => sum + Math.max(0, Math.min(avgDaily, s.to) - s.from) * s.rate, 0);
  const energy = energyPerDay * days;
  const fppas = avgDaily * 30 >= tariff.fppasFromMonthly ? tariff.fppasPerUnit * units : 0;
  const municipalTax = tariff.municipalTaxPct * (energy + fppas);
  const duty = tariff.dutyPerUnit * units;
  return { units, days, avgDaily, band, energy, fppas, municipalTax, duty, total: energy + fppas + municipalTax + duty };
}

/** Average length in days between consecutive bill dates (Date objects, any order). */
export function avgCycleDays(billDates) {
  const t = billDates.map(d => d.getTime()).sort((a, b) => a - b);
  if (t.length < 2) return 60;
  return (t[t.length - 1] - t[0]) / DAY_MS / (t.length - 1);
}

/** Local calendar date key "YYYY-MM-DD". */
export function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Everything the Summary page shows for the open cycle.
 *
 * @param {object} p
 * @param {Date}   p.cycleStart     billing date/time (meter reading)
 * @param {number} p.startEnergy    cleaned meter energy (kWh) at cycleStart
 * @param {Date}   p.cycleEnd       expected next reading
 * @param {Array<{ts: Date, energy: number}>} p.points  cleaned energy snapshots (e.g. hourly), any order
 * @param {Date}   [p.now]
 * @param {object} [p.tariff]
 */
export function cycleSummary({ cycleStart, startEnergy, cycleEnd, points, now = new Date(), tariff = DEFAULT_TARIFF }) {
  // Scale logged usage to what the DHBVN meter would show
  const factor = tariff.meterFactor ?? 1;
  const pts = points
    .filter(p => p.ts >= cycleStart && p.ts <= now && Number.isFinite(p.energy))
    .map(p => ({ ts: p.ts, energy: startEnergy + (p.energy - startEnergy) * factor }))
    .sort((a, b) => a.ts - b.ts);
  const latest = pts.length ? pts[pts.length - 1] : { ts: cycleStart, energy: startEnergy };

  const unitsSoFar = Math.max(0, latest.energy - startEnergy);
  const daysElapsed = Math.max((latest.ts - cycleStart) / DAY_MS, 0);
  const cycleDays = Math.max((cycleEnd - cycleStart) / DAY_MS, daysElapsed);
  const daysLeft = Math.max(cycleDays - daysElapsed, 0);

  // Daily series: units per calendar day, growing average and 7-day rolling average
  const endByDay = new Map();
  pts.forEach(p => endByDay.set(dayKey(p.ts), p));
  const days = [];
  let prevEnergy = startEnergy;
  for (let d = startOfDay(cycleStart); d <= latest.ts; d = new Date(d.getTime() + DAY_MS)) {
    const key = dayKey(d);
    const end = endByDay.get(key);
    const energy = end ? end.energy : prevEnergy;
    const units = Math.max(0, energy - prevEnergy);
    prevEnergy = energy;
    const asOf = end ? end.ts : new Date(Math.min(d.getTime() + DAY_MS, latest.ts.getTime()));
    const elapsed = Math.max((asOf - cycleStart) / DAY_MS, 1e-9);
    const cum = Math.max(0, energy - startEnergy);
    const bill = billFor(cum, Math.max(elapsed, 1), tariff);
    days.push({ date: key, units, cumUnits: cum, growingAvg: cum / Math.max(elapsed, 1), chargesSoFar: bill.total, band: bill.band, fppasOn: bill.fppas > 0 });
  }
  days.forEach((row, i) => {
    const win = days.slice(Math.max(0, i - 6), i + 1);
    row.avg7 = win.reduce((s, r) => s + r.units, 0) / win.length;
  });

  // Growing average uses at least one day so the first hours of a cycle don't explode the rate
  const growingAvg = unitsSoFar / Math.max(daysElapsed, 1);
  // 7-day pace: last 7 complete days (falls back to what exists)
  const complete = days.slice(0, -1);
  const last7 = (complete.length ? complete : days).slice(-7);
  const avg7 = last7.length ? last7.reduce((s, r) => s + r.units, 0) / last7.length : growingAvg;

  const projectedUnits = unitsSoFar + growingAvg * daysLeft;
  const projectedUnits7 = unitsSoFar + avg7 * daysLeft;
  const chargesSoFar = billFor(unitsSoFar, Math.max(daysElapsed, 1), tariff);
  const projectedBill = billFor(projectedUnits, cycleDays, tariff);
  const projectedBill7 = billFor(projectedUnits7, cycleDays, tariff);

  // Thresholds over the whole cycle
  const bandBLimit = tariff.bandBAbovePerDay * cycleDays;
  const fppasLimit = tariff.fppasFromMonthly / 30 * cycleDays;
  const headroom = limit => ({
    limit,
    unitsLeft: limit - unitsSoFar,
    safePerDay: daysLeft > 0 ? Math.max(limit - unitsSoFar, 0) / daysLeft : 0,
    projectedOver: projectedUnits > limit,
  });

  // Projection path from the latest reading to the cycle end, one point per day
  const projection = [];
  for (let d = startOfDay(latest.ts); d <= cycleEnd; d = new Date(d.getTime() + DAY_MS)) {
    const t = d.getTime() === startOfDay(latest.ts).getTime() ? latest.ts : new Date(Math.min(d.getTime() + DAY_MS, cycleEnd.getTime()));
    const elapsed = Math.max((t - cycleStart) / DAY_MS, 1);
    const units = unitsSoFar + growingAvg * Math.max((t - latest.ts) / DAY_MS, 0);
    const bill = billFor(units, elapsed, tariff);
    projection.push({ date: dayKey(d), cumUnits: units, charges: bill.total, band: bill.band, fppasOn: bill.fppas > 0 });
  }

  return {
    cycleStart, cycleEnd, latestTs: latest.ts,
    unitsSoFar, daysElapsed, cycleDays, daysLeft,
    growingAvg, avg7,
    chargesSoFar, projectedUnits, projectedBill, projectedUnits7, projectedBill7,
    bandB: headroom(bandBLimit), fppas: headroom(fppasLimit),
    days, projection,
  };
}

/** Linear interpolation of energy at time `ts` from snapshots sorted by ts. */
export function energyAt(ts, points) {
  const pts = [...points].sort((a, b) => a.ts - b.ts);
  if (!pts.length) return null;
  if (ts <= pts[0].ts) return pts[0].energy;
  for (let i = 1; i < pts.length; i++) {
    if (ts <= pts[i].ts) {
      const a = pts[i - 1], b = pts[i];
      return a.energy + (b.energy - a.energy) * (ts - a.ts) / (b.ts - a.ts);
    }
  }
  return pts[pts.length - 1].energy;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
