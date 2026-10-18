// Demo backend used when CONFIG.apiUrl is empty or the URL has ?demo.
// Synthetic numbers only: no real readings are ever committed to this public repo.

const DAY = 86400e3;
const now = Date.now();
const cycleStart = new Date(new Date(now - 29 * DAY).setHours(10, 30, 0, 0)).getTime();

const bills = [
  { ts: cycleStart - 63 * DAY, startEnergy: 1000, expectedNextTs: null, note: 'Demo' },
  { ts: cycleStart, startEnergy: 1500, expectedNextTs: null, note: 'Demo' },
];
const users = [
  { Email: 'you@example.com', Role: 'admin' },
  { Email: 'family@example.com', Role: 'viewer' },
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
  const me = { email: 'you@example.com', role: 'admin' };
  switch (action) {
    case 'me': return { ok: true, me };
    case 'summary': return { ok: true, me, bills: [...bills], points: points(), tariff: null, serverTime: Date.now() };
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
    default: throw new Error('Unknown action');
  }
}
