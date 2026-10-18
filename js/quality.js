// Data quality for the hourly energy snapshots: corrections, gaps, coverage.
// Pure functions only, copied into apps-script/Engine.gs like billing.js.
//
// The PZEM energy counter keeps counting while the logger is offline, so a gap never loses
// units: the first reading after it includes everything used during it. Gaps only decide
// *which hours/days* those units are shown on.

const HOUR = 3600 * 1000;

export const QUALITY_DEFAULTS = {
  expectedPerHour: 60,    // the logger writes about once a minute
  completeShare: 0.75,    // an hour with at least 75% of the expected rows is "complete"
  maxFillHours: 6,        // gaps up to this long are spread evenly; longer ones are "outage"
};

/**
 * Applies admin corrections to snapshots without changing the input (raw data is never edited).
 * - exclude {from, to}: snapshots in the range are ignored (treated as a gap)
 * - adjust  {from, to?, value}: value kWh used in the period that the logger missed (or, negative,
 *   counted wrongly). It is spread evenly from `from` to `to` and stays in every later snapshot,
 *   so it changes the totals. Without `to` the whole value applies from `from`.
 * Inactive corrections are skipped, so switching one off restores the exact previous result.
 */
export function applyCorrections(points, corrections) {
  const active = (corrections || []).filter(c => c.active !== false);
  if (!active.length) return points.map(p => Object.assign({}, p));
  const out = [];
  points.forEach(p => {
    const t = +p.ts;
    if (active.some(c => c.kind === 'exclude' && t >= c.from && t <= (c.to == null ? Infinity : c.to))) return;
    const add = active.filter(c => c.kind === 'adjust').reduce((s, c) => s + adjustAt(c, t), 0);
    out.push(Object.assign({}, p, { energy: p.energy + add }));
  });
  return out;
}

/** kWh an adjust correction adds between two times (e.g. a bill cycle); 0 for other kinds. */
export function adjustBetween(c, fromMs, toMs) {
  return c.kind === 'adjust' && c.active !== false ? adjustAt(c, toMs) - adjustAt(c, fromMs) : 0;
}

/** How much of an adjust correction has accrued at time t: 0 before, a share during, all after. */
function adjustAt(c, t) {
  if (t < c.from) return 0;
  if (c.to == null || t >= c.to) return Number(c.value);
  return Number(c.value) * (t - c.from) / (c.to - c.from);
}

/** Sorted by time, one snapshot per timestamp (the later row wins), energy never decreasing. */
export function cleanPoints(points) {
  const byTs = new Map();
  points.forEach(p => { if (Number.isFinite(p.energy) && Number.isFinite(+p.ts)) byTs.set(+p.ts, p); });
  const sorted = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  let max = -Infinity;
  return sorted.map(p => {
    max = Math.max(max, p.energy);
    return p.energy === max ? p : Object.assign({}, p, { energy: max });
  });
}

/** Gaps of more than `minHours` between snapshots: [{from, to, hours, units, kind}]. */
export function findGaps(points, opts) {
  const o = Object.assign({}, QUALITY_DEFAULTS, opts);
  const minHours = o.minHours == null ? 1.5 : o.minHours;
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const hours = (b.ts - a.ts) / HOUR;
    if (hours > minHours) {
      gaps.push({ from: +a.ts, to: +b.ts, hours, units: b.energy - a.energy, kind: hours <= o.maxFillHours ? 'filled' : 'outage' });
    }
  }
  return gaps;
}

/**
 * Spreads the units of short gaps evenly over the missing hours (marked filled: true), so a
 * one-hour logger drop doesn't put two hours of use on one day. Outages (longer gaps) are left
 * as they are: their units land when the logger comes back. Totals never change.
 */
export function fillGaps(points, opts) {
  const o = Object.assign({}, QUALITY_DEFAULTS, opts);
  const out = [];
  points.forEach((b, i) => {
    const a = points[i - 1];
    if (a) {
      const hours = (b.ts - a.ts) / HOUR;
      if (hours > 1.5 && hours <= o.maxFillHours) {
        const steps = Math.ceil(hours) - 1;
        for (let k = 1; k <= steps; k++) {
          const ts = +a.ts + (b.ts - a.ts) * k / (steps + 1);
          out.push({ ts: a.ts instanceof Date ? new Date(ts) : ts, energy: a.energy + (b.energy - a.energy) * k / (steps + 1), filled: true });
        }
      }
    }
    out.push(b);
  });
  return out;
}

/**
 * Coverage of a period by hour: complete (enough logger rows), partial, missing.
 * `hours` = [{ts, rows}] where rows is the number of logger rows that hour (any load).
 */
export function coverage(hours, fromMs, toMs, opts) {
  const o = Object.assign({}, QUALITY_DEFAULTS, opts);
  const total = Math.max(0, Math.round((toMs - fromMs) / HOUR));
  const seen = new Map();
  hours.forEach(h => {
    const t = +h.ts;
    if (t < fromMs || t >= toMs) return;
    const k = Math.floor(t / HOUR);
    seen.set(k, (seen.get(k) || 0) + (Number(h.rows) || 0));
  });
  let complete = 0, partial = 0;
  seen.forEach(rows => { if (rows >= o.expectedPerHour * o.completeShare) complete++; else partial++; });
  const withData = Math.min(complete + partial, total);
  return { total, complete, partial, missing: total - withData, share: total ? withData / total : 0 };
}
