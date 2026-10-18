// Demo backend used when CONFIG.apiUrl is empty or the URL has ?demo.
// Synthetic numbers only: no real readings are ever committed to this public repo.
import { cycleSummary, cycleBreakdown, avgCycleDays, billFor, payableFor, paisa, checkDhbvnBill, compareWithApp, meterCalibration, DEFAULT_TARIFF } from './billing.js';

const asJson = x => JSON.parse(JSON.stringify(x, (k, v) => (v === Infinity ? 1e9 : v)));

// Like the server: the cycle is calculated here and sent as JSON (Dates become strings).
// Two demo cycles: a closed one (bills[0] → bills[1]) and the current one.
function summary(me, params = {}) {
  const pts = points();
  const serverTime = Date.now();
  const toDates = list => list.map(p => ({ ts: new Date(p.ts), energy: p.energy }));
  const typicalDays = Math.round(avgCycleDays(bills.map(b => new Date(b.ts))));
  const [b0, b1] = bills;
  const closed = cycleSummary({
    cycleStart: new Date(b0.ts), startEnergy: b0.startEnergy, cycleEnd: new Date(b1.ts), now: new Date(b1.ts),
    points: toDates(pts.filter(p => p.ts < b1.ts).concat([{ ts: b1.ts, energy: b1.startEnergy }])),
  });
  const current = cycleSummary({
    cycleStart: new Date(b1.ts), startEnergy: b1.startEnergy, cycleEnd: new Date(b1.ts + typicalDays * DAY),
    points: toDates(pts), now: new Date(serverTime),
  });
  const wanted = params.cycle == null ? b1.ts : Number(params.cycle);
  if (wanted !== b0.ts && wanted !== b1.ts) throw Object.assign(new Error('That bill cycle does not exist.'), { code: 404 });
  const past = wanted === b0.ts;
  const calc = past ? closed : current;
  return {
    ok: true, me, bills: [...bills], points: pts, tariff: DEFAULT_TARIFF, serverTime, typicalDays,
    cycle: past ? { start: b0.ts, end: b1.ts, current: false } : { start: b1.ts, end: calc.cycleEnd.getTime(), current: true },
    cycles: [
      { start: b0.ts, end: b1.ts, current: false, days: closed.cycleDays, units: closed.unitsSoFar, avgPerDay: closed.unitsSoFar / closed.cycleDays,
        band: closed.chargesSoFar.band, appTotal: closed.chargesSoFar.total, dhbvnTotal: null, coverage: 0.94 },
      { start: b1.ts, end: null, current: true },
    ],
    calc: asJson(calc),
    breakdown: asJson(cycleBreakdown(calc, !past)),
    quality: { total: 0, complete: 0, partial: 0, missing: 0, share: past ? 0.94 : 0.97, filledGaps: 3, outages: 0, corrections: 1 },
  };
}

const DAY = 86400e3;
const now = Date.now();
const cycleStart = new Date(new Date(now - 29 * DAY).setHours(10, 30, 0, 0)).getTime();

const bills = [
  { ts: cycleStart - 63 * DAY, startEnergy: 1000, expectedNextTs: null, note: 'Demo' },
  { ts: cycleStart, startEnergy: 1500, expectedNextTs: null, note: 'Demo' },
];
const ALL_PAGES = ['summary', 'past', 'breakdown', 'documents', 'health'];
const users = [
  { Email: 'you@example.com', email: 'you@example.com', Role: 'admin', role: 'admin', pages: ALL_PAGES, LastSeen: now - 2 * 60e3, status: 'active', requests: [] },
  { Email: 'family@example.com', email: 'family@example.com', Role: 'viewer', role: 'viewer', pages: ['summary', 'past'], LastSeen: now - 5 * 3600e3, status: 'active', requests: ['breakdown'] },
  { Email: 'cousin@example.com', email: 'cousin@example.com', Role: 'viewer', role: 'viewer', pages: ['summary'], LastSeen: null, status: 'invited', requests: [] },
];
const activity = [
  { ts: now - 2 * 60e3, email: 'you@example.com', name: 'Demo Admin', role: 'admin', type: 'view', event: 'Opened Summary', device: 'Chrome on Android' },
  { ts: now - 3 * 60e3, email: 'you@example.com', name: 'Demo Admin', role: 'admin', type: 'sign-in', event: 'Signed in', device: 'Chrome on Android' },
  { ts: now - 5 * 3600e3, email: 'family@example.com', name: 'Family Member', role: 'viewer', type: 'view', event: 'Opened Summary', device: 'Safari on iPhone/iPad' },
  { ts: now - 26 * 3600e3, email: 'stranger@example.com', name: 'Someone Else', role: '', type: 'denied', event: 'Not on the users list', device: 'Chrome on Windows' },
  { ts: now - 3 * DAY, email: 'you@example.com', name: 'Demo Admin', role: 'admin', type: 'change', event: 'Added data correction C0', device: 'Edge on Windows', details: 'readings 14 Oct 2026 02:00 – 14 Oct 2026 03:00 ignored · reason: logger glitch after power cut · current cycle 182.4 units → 182.4 units' },
  { ts: now - 29 * DAY, email: 'you@example.com', name: 'Demo Admin', role: 'admin', type: 'change', event: 'Saved billing (demo)', device: 'Edge on Windows', details: 'start energy 1500 kWh' },
];
/** A DHBVN-style bill for the closed demo cycle: 505 units (the app's logger says 510). */
function demoBill() {
  const iso = ms => new Date(ms + 330 * 60e3).toISOString().slice(0, 10);
  const b = billFor(505, 63);
  return { periodFrom: iso(bills[0].ts), periodTo: iso(bills[1].ts), days: 63, units: 505, basis: 'OK', readingOld: 8704, readingNew: 9209, mf: 1, mdiKw: 2.1,
    slabs: b.slabLines.map(l => ({ units: paisa(l.units), rate: l.rate, amount: l.amount })), arrears: -0.12, energy: b.energy, fixed: b.fixed, fppas: b.fppas,
    tax: b.municipalTax, duty: b.duty, security: 0, subsidy: 0, total: b.total, sundry: [0.12, 0, 0], payable: payableFor(b.total, -0.12, 0.12).payable, dueDate: iso(bills[1].ts + 20 * DAY) };
}
const telegramDemo = { configured: true, tokenSet: true, chatId: '123456789', botName: '@demo_power_bot' };
const alertDemo = {
  alertMinutes: 2, remindMinutes: 30, watchMinutes: 1, telegram: true, downSince: null,
  week: { alerts: 51, reminders: 83, back: 51 },
  recent: [
    { ts: now - 2 * 3600e3, key: 'stale', state: 'closed', message: '[Power Plan] ✅ Logger data is back after 6 min without readings (demo)', delivery: 'sent' },
    { ts: now - 2 * 3600e3 - 4 * 60e3, key: 'stale', state: 'open', message: '[Power Plan] ⚠️ No logger data for 2 min (demo)', delivery: 'sent' },
  ],
};
const corrections = [
  { id: 'C0', kind: 'exclude', from: now - 3 * DAY - 3600e3, to: now - 3 * DAY, value: 0, reason: 'Logger glitch after power cut (demo)', active: true, createdBy: 'you@example.com' },
];

// Hourly snapshots over both demo cycles: evening peak, slow overnight, a busier last week.
// The previous cycle is scaled to go from 1000 to exactly 1500 kWh between its two readings.
function points() {
  const raw = [];
  let e = 0;
  for (let t = bills[0].ts - DAY; t <= now - 7 * 60e3; t += 3600e3) {
    const h = new Date(t).getHours();
    // Repeatable day-to-day variation (0.7–1.3×) so days don't all look the same
    const day = Math.floor(t / DAY);
    const busy = (t > now - 7 * DAY ? 1.2 : 1) * (0.7 + 0.6 * (((Math.sin(day * 12.9898) * 43758.5453) % 1 + 1) % 1));
    const base = h >= 18 && h <= 23 ? 0.42 : h >= 9 && h <= 16 ? 0.12 : 0.18;
    e += base * busy * (0.8 + 0.4 * Math.abs(Math.sin(t / 7e6)));
    raw.push({ ts: t, e });
  }
  const at = ts => raw.find(p => p.ts >= ts).e;
  const e0 = at(bills[0].ts), e1 = at(cycleStart);
  return raw.map(p => ({
    ts: p.ts,
    energy: Math.round((p.ts < cycleStart ? 1000 + (p.e - e0) * 500 / (e1 - e0) : 1500 + (p.e - e1)) * 1000) / 1000,
  }));
}

export async function mockCall(action, params) {
  await new Promise(r => setTimeout(r, 150));
  const me = { email: 'you@example.com', name: 'Demo Admin', picture: '', role: 'admin', pages: ['summary', 'past', 'breakdown', 'documents', 'health'] };
  switch (action) {
    case 'login': return { ok: true, me, session: 'demo', sessionExp: now + 30 * DAY };
    case 'logout': return { ok: true };
    case 'listActivity': {
      const since = params.days ? Date.now() - params.days * 86400e3 : 0;
      const rows = activity.filter(a => a.ts >= since && (!params.email || a.email === params.email) && (!params.type || a.type === params.type));
      return { ok: true, activity: rows, total: rows.length };
    }
    case 'getTelegram': return { ok: true, ...telegramDemo };
    case 'saveTelegram':
      if (!/^-?\d+$/.test(params.chatId)) throw Object.assign(new Error('Chat ID is a number (e.g. 123456789, or -100… for a group) or @channelname.'), { code: 400 });
      Object.assign(telegramDemo, { chatId: params.chatId, tokenSet: telegramDemo.tokenSet || !!params.token, botName: '@demo_power_bot' });
      telegramDemo.configured = telegramDemo.tokenSet;
      return { ok: true, ...telegramDemo };
    case 'removeTelegram': Object.assign(telegramDemo, { configured: false, tokenSet: false, chatId: '', botName: '' }); return { ok: true, ...telegramDemo };
    case 'testTelegram': return { ok: true, delivery: 'sent' };
    case 'me': return { ok: true, me };
    case 'summary':
      // ?noaccess previews the "no access" screen
      if (new URLSearchParams(location.search).has('noaccess')) throw Object.assign(new Error("You don't have access to Past cycles yet."), { code: 403, need: 'past' });
      return summary(me, params);
    case 'cycles': return { ok: true, cycles: summary(me).cycles };
    case 'listBillDocs': {
      const f = demoBill();
      const s = summary(me, { cycle: bills[0].ts });
      const c = checkDhbvnBill(f);
      return { ok: true, docs: [{ id: 'D0', periodFrom: f.periodFrom, periodTo: f.periodTo, cycleStart: bills[0].ts, fields: f,
        check: { linesAddUp: c.linesAddUp, payableAddsUp: c.payableAddsUp, slabsMatch: c.slabsMatch, right: c.right, lines: c.lines },
        compare: compareWithApp(f, { units: s.calc.unitsSoFar, bill: s.calc.chargesSoFar }), uploadedBy: 'you@example.com', uploadedAt: now - 2 * DAY }],
        calibration: { current: 1.02, suggestion: meterCalibration([{ dhbvnUnits: f.units, loggerUnits: s.calc.unitsSoFar / 1.02 }]), cycles: [{ periodFrom: f.periodFrom, periodTo: f.periodTo, dhbvnUnits: f.units, loggerUnits: s.calc.unitsSoFar / 1.02, coverage: 0.94 }] } };
    }
    case 'health': return { ok: true, status: 'warn', env: 'prod', serverTime: Date.now(), build: { env: 'prod', commit: 'demo123', dirty: false, deployedAt: new Date(now - 3 * DAY).toISOString() },
      checks: [
        { key: 'data', label: 'Logger data', status: 'ok', value: 'last reading 1 min ago', detail: '' },
        { key: 'sync', label: 'Last successful sync', status: 'ok', value: '6 min ago', detail: 'updates every 15 min · 2000 rows read, 3 hours written' },
        { key: 'jobs', label: 'Background jobs (24 h)', status: 'warn', value: '1 failed', detail: 'last: updateHourly – Service Spreadsheets timed out (demo)' },
        { key: 'errors', label: 'Server errors (24 h)', status: 'ok', value: '0', detail: '' },
        { key: 'triggers', label: 'Timers', status: 'ok', value: 'all running', detail: 'updateHourly, healthCheck, watchData' },
        { key: 'sheet', label: 'App sheet size', status: 'ok', value: '0.9% of Google\'s limit', detail: '91,350 cells · Hourly 7,283 rows · Activity 412 rows' },
      ],
      jobs: [
        { ts: now - 6 * 60e3, job: 'updateHourly', status: 'ok', ms: 7300, rows: 2000, message: '3 hours written' },
        { ts: now - 21 * 60e3, job: 'updateHourly', status: 'ok', ms: 6900, rows: 2000, message: '2 hours written' },
        { ts: now - 40 * 60e3, job: 'healthCheck', status: 'ok', ms: 2100, rows: 0, message: 'data age 0.02 h, lag 0.00 h' },
        { ts: now - 9 * 3600e3, job: 'updateHourly', status: 'error', ms: 30100, rows: '', message: 'Service Spreadsheets timed out (demo)' },
      ],
      alerts: [], errors: [] };
    case 'getBillFile': throw Object.assign(new Error('Demo mode has no real bill PDF.'), { code: 404 });
    case 'uploadBill': return { ok: true, id: 'D1', cycleStart: null, details: 'demo' };
    case 'deleteBillDoc': return { ok: true, id: params.id };
    case 'applyMeterFactor': return { ok: true, details: `meter factor 1.02 → ${params.factor} (demo, not saved)` };
    case 'requestAccess': return { ok: true, page: params.page, label: 'Past cycles', alreadyAsked: false };
    case 'saveBilling': {
      const p = points();
      const energy = p.filter(x => x.ts <= params.ts).pop()?.energy ?? null;
      bills.push({ ts: params.ts, startEnergy: energy, expectedNextTs: params.expectedNextTs || null, note: params.note || '' });
      return { ok: true, saved: { ts: params.ts, startEnergy: energy, expectedNextTs: params.expectedNextTs || null } };
    }
    case 'deleteLatestBill': bills.pop(); return { ok: true };
    case 'updateBilling': {
      const b = bills.find(x => x.ts === params.ts);
      Object.assign(b, { ts: params.newTs || b.ts, expectedNextTs: params.expectedNextTs || null, note: params.note });
      bills.sort((x, y) => x.ts - y.ts);
      return { ok: true, saved: { ts: b.ts, startEnergy: b.startEnergy }, details: 'changed (demo, not saved)' };
    }
    case 'deleteBilling': {
      if (bills.length <= 1) throw Object.assign(new Error('Keep at least one billing: the current cycle starts from it.'), { code: 400 });
      bills.splice(bills.findIndex(x => x.ts === params.ts), 1);
      return { ok: true, deleted: params.ts };
    }
    case 'listUsers': return { ok: true, users: [...users] };
    case 'setPages': {
      const u = users.find(x => x.email === params.email);
      const before = u.pages.join(', ');
      u.pages = ['summary', ...params.pages.filter(p => p !== 'summary')];
      u.requests = u.requests.filter(p => !u.pages.includes(p));
      return { ok: true, users: [...users], email: u.email, details: `${before} → ${u.pages.join(', ')} (demo)` };
    }
    case 'decideRequest': {
      const u = users.find(x => x.email === params.email);
      if (params.approve && !u.pages.includes(params.page)) u.pages.push(params.page);
      u.requests = u.requests.filter(p => p !== params.page);
      return { ok: true, users: [...users] };
    }
    case 'saveUser': {
      const u = users.find(x => x.Email === params.email);
      if (u) { u.Role = u.role = params.role; } else users.push({ Email: params.email, email: params.email, Role: params.role, role: params.role, pages: ['summary'], LastSeen: null, status: 'invited', requests: [] });
      return { ok: true, users: [...users] };
    }
    case 'removeUser': {
      const i = users.findIndex(x => x.Email === params.email);
      if (i >= 0) users.splice(i, 1);
      return { ok: true, users: [...users] };
    }
    case 'listCorrections': return { ok: true, corrections: [...corrections] };
    case 'getAlertSettings': return { ok: true, ...alertDemo };
    case 'saveAlertSettings':
      if (!(params.alertMinutes >= 1 && params.remindMinutes >= 5)) throw Object.assign(new Error('Remind every: a whole number of minutes from 5 to 1440.'), { code: 400 });
      Object.assign(alertDemo, { alertMinutes: params.alertMinutes, remindMinutes: params.remindMinutes });
      return { ok: true, ...alertDemo };
    case 'saveCorrection': {
      if (!params.reason || params.reason.trim().length < 3) throw Object.assign(new Error('Write a short reason, so the change can be understood later.'), { code: 400 });
      corrections.push({ id: 'C' + corrections.length, kind: params.kind, from: params.from, to: params.to, value: params.kind === 'adjust' ? params.value : 0, reason: params.reason, active: true, createdBy: 'you@example.com' });
      return { ok: true, saved: { id: 'C' + (corrections.length - 1) }, corrections: [...corrections] };
    }
    case 'updateCorrection': {
      const c = corrections.find(x => x.id === params.id);
      Object.assign(c, { from: params.from, to: params.to, value: params.value, reason: params.reason });
      return { ok: true, id: c.id, corrections: [...corrections], details: 'changed (demo, not saved)' };
    }
    case 'setCorrectionActive': {
      const c = corrections.find(x => x.id === params.id);
      if (c) c.active = params.active;
      return { ok: true, id: params.id, active: params.active, corrections: [...corrections] };
    }
    default: throw new Error('Unknown action');
  }
}
