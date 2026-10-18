// Tariff + projection engine for a DHBVN domestic (Category II) bill cycle.
// Pure functions only: no DOM, no network. Ported from the Power BI measures in
// Summary.tmdl ('Projected Cycle Bill', 'Estimated Cycle Charges') and the Charges table.
//
// This file is the one bill calculator. scripts/build-gs.mjs copies it into
// apps-script/Engine.gs so the server runs exactly the same code (tests/engine-sync.test.js).

const DAY_MS = 24 * 3600 * 1000;
// Days and cycles follow India time wherever the code runs (server or any viewer's phone)
const IST_OFFSET_MS = 330 * 60 * 1000;

export const DEFAULT_TARIFF = {
  category: 'Domestic DS – Category II',
  // Band B applies when the cycle averages more than this many units per day (100 units/month)
  bandBAbovePerDay: 3.33,
  // Slab boundaries are in units per day; the bill charges each slab for every day of the cycle
  // (0–150 / 151–300 / 301–500 / 500+ units a month on the DHBVN tariff table)
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
  // Fixed charge per kW of sanctioned load per month, only in the 301+ units/month slabs
  fixedPerKwMonth: 50,
  fixedAboveMonthly: 300,
  loadKw: 2,
  fppasPerUnit: 0.47,      // only charged when usage is at or above fppasFromMonthly
  fppasFromMonthly: 200,   // units per 30 days
  municipalTaxPct: 0.02,   // of (energy + fixed + FPPAS)
  dutyPerUnit: 0.10,
  // The logger reads about 2% under the DHBVN meter; same adjustment as Power BI's Summary[Diff]
  meterFactor: 1.02,
};

/** Fills missing settings from DEFAULT_TARIFF; JSON turns Infinity into null, so null slab ends mean "no limit". */
export function normalizeTariff(t) {
  const out = Object.assign({}, DEFAULT_TARIFF, t || {});
  const slabs = Object.assign({}, DEFAULT_TARIFF.slabs, (t && t.slabs) || {});
  out.slabs = {};
  Object.keys(slabs).forEach(band => {
    out.slabs[band] = slabs[band].map(s => ({ from: Number(s.from), to: s.to == null ? Infinity : Number(s.to), rate: Number(s.rate) }));
  });
  return out;
}

/** Rounds to the paisa like the DHBVN bill (163.275 → 163.28, despite binary floating point). */
export function paisa(x) {
  return Math.round(x * 100 + (x >= 0 ? 1e-6 : -1e-6)) / 100;
}

/**
 * Bill for `units` used over `days` days, line by line as printed on the DHBVN bill:
 * each slab line, energy (1), fixed (2), FPPAS (3), municipal tax (4), duty (5) and their total (B).
 */
export function billFor(units, days, tariff = DEFAULT_TARIFF) {
  if (!(days > 0) || !(units >= 0)) {
    return { units: 0, days: 0, avgDaily: 0, band: 'A', slabLines: [], energy: 0, fixed: 0, fppas: 0, municipalTax: 0, duty: 0, total: 0 };
  }
  const avgDaily = units / days;
  const band = avgDaily > tariff.bandBAbovePerDay ? 'B' : 'A';
  // Each slab holds (width per day × days) units; the last slab takes what is left
  const slabLines = [];
  let left = units;
  for (const s of tariff.slabs[band]) {
    if (left <= 1e-9) break;
    const u = Math.min(left, (s.to - s.from) * days);
    slabLines.push({ units: u, rate: s.rate, amount: paisa(u * s.rate) });
    left -= u;
  }
  const energy = paisa(slabLines.reduce((sum, l) => sum + l.amount, 0));
  const fixed = avgDaily * 30 > tariff.fixedAboveMonthly ? paisa(tariff.fixedPerKwMonth * tariff.loadKw * days / 30) : 0;
  const fppas = avgDaily * 30 >= tariff.fppasFromMonthly ? paisa(tariff.fppasPerUnit * units) : 0;
  const municipalTax = paisa(tariff.municipalTaxPct * (energy + fixed + fppas));
  const duty = paisa(tariff.dutyPerUnit * units);
  return { units, days, avgDaily, band, slabLines, energy, fixed, fppas, municipalTax, duty, total: paisa(energy + fixed + fppas + municipalTax + duty) };
}

/**
 * Bill for a period that spans tariff versions. Units are shared out by days (assumption:
 * DHBVN's own split rule is not on any bill yet), each part is billed with its own tariff.
 * `parts` = [{days, tariff}].
 */
export function billForParts(units, parts) {
  if (parts.length === 1) return billFor(units, parts[0].days, parts[0].tariff);
  const days = parts.reduce((s, p) => s + p.days, 0);
  const bills = parts.map(p => billFor(days > 0 ? units * p.days / days : 0, p.days, p.tariff));
  const sum = key => paisa(bills.reduce((s, b) => s + b[key], 0));
  const out = { units, days, avgDaily: days > 0 ? units / days : 0, band: bills[bills.length - 1].band, slabLines: [].concat(...bills.map(b => b.slabLines)) };
  ['energy', 'fixed', 'fppas', 'municipalTax', 'duty'].forEach(k => { out[k] = sum(k); });
  out.total = paisa(out.energy + out.fixed + out.fppas + out.municipalTax + out.duty);
  return out;
}

/** The tariff versions ([{from: ms, tariff}], any order) in force between start and end, as bill parts. */
export function tariffParts(startMs, endMs, versions) {
  const sorted = [...versions].sort((a, b) => a.from - b.from);
  const parts = [];
  sorted.forEach((v, i) => {
    const from = Math.max(startMs, i === 0 ? -Infinity : v.from);
    const to = Math.min(endMs, i + 1 < sorted.length ? sorted[i + 1].from : Infinity);
    if (to > from) parts.push({ days: (to - from) / DAY_MS, tariff: v.tariff });
  });
  return parts.length ? parts : [{ days: (endMs - startMs) / DAY_MS, tariff: sorted[sorted.length - 1].tariff }];
}

/**
 * Amount to pay: arrears (A) + current charges (B) + sundry (C), rounded to the rupee.
 * The paisa left over is carried to the next bill's arrears (seen on all 6 DHBVN bills).
 */
export function payableFor(total, arrears = 0, sundry = 0) {
  const gross = paisa(arrears + total + sundry);
  const payable = Math.round(gross);
  return { gross, payable, carry: paisa(gross - payable) };
}

/**
 * What would change a bill of `units` over `days`: units left in the current slab, before band B,
 * the FPPAS line and the fixed charge (≤ 0 = already crossed), and what one more unit adds (₹).
 */
export function whatIf(units, days, tariff = DEFAULT_TARIFF) {
  if (!(days > 0)) return null;
  const bill = billFor(units, days, tariff);
  const avg = units / days;
  const slabs = tariff.slabs[bill.band];
  const i = Math.max(0, slabs.findIndex(s => avg < s.to));
  const slab = slabs[i], next = slabs[i + 1];
  return {
    band: bill.band, avgDaily: avg,
    slab: { rate: slab.rate, unitsLeft: Number.isFinite(slab.to) ? slab.to * days - units : null, nextRate: next ? next.rate : null },
    bandB: bill.band === 'A' ? tariff.bandBAbovePerDay * days - units : null,
    fppas: tariff.fppasFromMonthly / 30 * days - units,
    fixed: tariff.fixedAboveMonthly / 30 * days - units,
    nextUnit: paisa(billFor(units + 1, days, tariff).total - bill.total),
  };
}

/**
 * The Bills page breakdown of a cycleSummary result: for the current cycle "so far" and
 * "projected", for a closed cycle "final". Each has the bill (slab lines + components), the
 * statement (arrears A + bill B + sundry C → payable) and whatIf. Arrears and sundry come from
 * the uploaded DHBVN bill when there is one, else 0.
 */
export function cycleBreakdown(s, current, extras = {}) {
  const arrears = extras.arrears || 0, sundry = extras.sundry || 0;
  const part = (bill, units, days) => ({
    bill, units, days,
    statement: Object.assign({ arrears, total: bill.total, sundry }, payableFor(bill.total, arrears, sundry)),
    whatIf: whatIf(units, days, s.tariff),
  });
  return current
    ? { soFar: part(s.chargesSoFar, s.unitsSoFar, Math.max(s.daysElapsed, 1)), projected: part(s.projectedBill, s.projectedUnits, s.cycleDays) }
    : { final: part(s.chargesSoFar, s.unitsSoFar, s.daysElapsed) };
}

/** Average length in days between consecutive bill dates (Date objects, any order). */
export function avgCycleDays(billDates) {
  const t = billDates.map(d => d.getTime()).sort((a, b) => a - b);
  if (t.length < 2) return 60;
  return (t[t.length - 1] - t[0]) / DAY_MS / (t.length - 1);
}

/** India calendar date key "YYYY-MM-DD". */
export function dayKey(d) {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
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
 * @param {object} [p.tariff]       one tariff for the whole cycle, or
 * @param {Array<{from: number, tariff: object}>} [p.tariffs]  versions with start times (ms)
 */
export function cycleSummary({ cycleStart, startEnergy, cycleEnd, points, now = new Date(), tariff = DEFAULT_TARIFF, tariffs }) {
  const versions = tariffs && tariffs.length ? tariffs : [{ from: -Infinity, tariff }];
  const current = [...versions].sort((a, b) => a.from - b.from).filter(v => v.from <= cycleStart.getTime()).pop() || versions[0];
  const main = current.tariff;
  // Bill for units used from the cycle start to `end` (at least one day, like before)
  const billTo = (units, end) => {
    const endMs = Math.max(end.getTime(), cycleStart.getTime() + DAY_MS);
    return billForParts(units, tariffParts(cycleStart.getTime(), endMs, versions));
  };

  // Scale logged usage to what the DHBVN meter would show
  const factor = main.meterFactor ?? 1;
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
    const bill = billTo(cum, asOf);
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
  const chargesSoFar = billTo(unitsSoFar, latest.ts);
  const projectedBill = billTo(projectedUnits, cycleEnd);
  const projectedBill7 = billTo(projectedUnits7, cycleEnd);

  // Thresholds over the whole cycle
  const bandBLimit = main.bandBAbovePerDay * cycleDays;
  const fppasLimit = main.fppasFromMonthly / 30 * cycleDays;
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
    const units = unitsSoFar + growingAvg * Math.max((t - latest.ts) / DAY_MS, 0);
    const bill = billTo(units, t);
    projection.push({ date: dayKey(d), cumUnits: units, charges: bill.total, band: bill.band, fppasOn: bill.fppas > 0 });
  }

  return {
    cycleStart, cycleEnd, latestTs: latest.ts,
    unitsSoFar, daysElapsed, cycleDays, daysLeft,
    growingAvg, avg7,
    chargesSoFar, projectedUnits, projectedBill, projectedUnits7, projectedBill7,
    bandB: headroom(bandBLimit), fppas: headroom(fppasLimit),
    tariff: main,
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

/** Midnight India time of the day containing d. */
function startOfDay(d) {
  const t = d.getTime() + IST_OFFSET_MS;
  return new Date(t - (((t % DAY_MS) + DAY_MS) % DAY_MS) - IST_OFFSET_MS);
}
