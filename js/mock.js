// Demo backend used when CONFIG.apiUrl is empty or the URL has ?demo.
// Synthetic numbers only: no real readings are ever committed to this public repo.
import { cycleSummary, avgCycleDays, DEFAULT_TARIFF } from './billing.js';

// Like the server: the cycle is calculated here and sent as JSON (Dates become strings)
function summary(me) {
  const pts = points();
  const out = { ok: true, me, bills: [...bills], points: pts, tariff: DEFAULT_TARIFF, serverTime: Date.now() };
  const bill = bills[bills.length - 1];
  if (bill && bill.startEnergy != null) {
    out.typicalDays = Math.round(avgCycleDays(bills.map(b => new Date(b.ts))));
    out.calc = JSON.parse(JSON.stringify(cycleSummary({
      cycleStart: new Date(bill.ts), startEnergy: bill.startEnergy,
      cycleEnd: new Date(bill.expectedNextTs || bill.ts + out.typicalDays * DAY),
      points: pts.map(p => ({ ts: new Date(p.ts), energy: p.energy })), now: new Date(out.serverTime),
    }), (k, v) => (v === Infinity ? 1e9 : v)));
  }
  return out;
}

const DAY = 86400e3;
const now = Date.now();
const cycleStart = new Date(new Date(now - 29 * DAY).setHours(10, 30, 0, 0)).getTime();

const bills = [
  { ts: cycleStart - 63 * DAY, startEnergy: 1000, expectedNextTs: null, note: 'Demo' },
  { ts: cycleStart, startEnergy: 1500, expectedNextTs: null, note: 'Demo' },
];
const users = [
  { Email: 'you@example.com', Role: 'admin', LastSeen: now - 2 * 60e3 },
  { Email: 'family@example.com', Role: 'viewer', LastSeen: now - 5 * 3600e3 },
];
const activity = [
  { ts: now - 2 * 60e3, email: 'you@example.com', name: 'Demo Admin', role: 'admin', type: 'view', event: 'Opened Summary', device: 'Chrome on Android' },
  { ts: now - 3 * 60e3, email: 'you@example.com', name: 'Demo Admin', role: 'admin', type: 'sign-in', event: 'Signed in', device: 'Chrome on Android' },
  { ts: now - 5 * 3600e3, email: 'family@example.com', name: 'Family Member', role: 'viewer', type: 'view', event: 'Opened Summary', device: 'Safari on iPhone/iPad' },
  { ts: now - 26 * 3600e3, email: 'stranger@example.com', name: 'Someone Else', role: '', type: 'denied', event: 'Not on the users list', device: 'Chrome on Windows' },
  { ts: now - 3 * DAY, email: 'you@example.com', name: 'Demo Admin', role: 'admin', type: 'change', event: 'Added data correction C0', device: 'Edge on Windows', details: 'readings 14 Oct 2026 02:00 – 14 Oct 2026 03:00 ignored · reason: logger glitch after power cut · current cycle 182.4 units → 182.4 units' },
  { ts: now - 29 * DAY, email: 'you@example.com', name: 'Demo Admin', role: 'admin', type: 'change', event: 'Saved billing (demo)', device: 'Edge on Windows', details: 'start energy 1500 kWh' },
];
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

// Hourly snapshots: evening peak, slow overnight, with a busier last week
function points() {
  const out = [];
  let e = 1500 - 2;
  for (let t = cycleStart - DAY; t <= now - 7 * 60e3; t += 3600e3) {
    const h = new Date(t).getHours();
    // Repeatable day-to-day variation (0.7–1.3×) so days don't all look the same
    const day = Math.floor(t / DAY);
    const busy = (t > now - 7 * DAY ? 1.2 : 1) * (0.7 + 0.6 * (((Math.sin(day * 12.9898) * 43758.5453) % 1 + 1) % 1));
    const base = h >= 18 && h <= 23 ? 0.42 : h >= 9 && h <= 16 ? 0.12 : 0.18;
    e += base * busy * (0.8 + 0.4 * Math.abs(Math.sin(t / 7e6)));
    if (t === cycleStart - (cycleStart % 3600e3)) e = 1500;
    out.push({ ts: t, energy: Math.round(e * 1000) / 1000 });
  }
  return out;
}

export async function mockCall(action, params) {
  await new Promise(r => setTimeout(r, 150));
  const me = { email: 'you@example.com', name: 'Demo Admin', picture: '', role: 'admin' };
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
    case 'summary': return summary(me);
    case 'saveBilling': {
      const p = points();
      const energy = p.filter(x => x.ts <= params.ts).pop()?.energy ?? null;
      bills.push({ ts: params.ts, startEnergy: energy, expectedNextTs: params.expectedNextTs || null, note: params.note || '' });
      return { ok: true, saved: { ts: params.ts, startEnergy: energy, expectedNextTs: params.expectedNextTs || null } };
    }
    case 'deleteLatestBill': bills.pop(); return { ok: true };
    case 'listUsers': return { ok: true, users: [...users] };
    case 'saveUser': {
      const u = users.find(x => x.Email === params.email);
      if (u) u.Role = params.role; else users.push({ Email: params.email, Role: params.role });
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
    case 'setCorrectionActive': {
      const c = corrections.find(x => x.id === params.id);
      if (c) c.active = params.active;
      return { ok: true, id: params.id, active: params.active, corrections: [...corrections] };
    }
    default: throw new Error('Unknown action');
  }
}
