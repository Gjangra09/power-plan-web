// Summary page: current bill cycle, averages, charges and projection.
import { boot, el, inr, num, dateTime, dateOnly, shortDate, showError } from './ui.js';
import { cycleSummary, avgCycleDays, DEFAULT_TARIFF } from './billing.js';

const DAY = 86400e3;
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

boot().then(render).catch(() => { /* error already shown */ });

function render(data) {
  const bills = data.bills;
  const bill = bills[bills.length - 1];
  if (!bill) return showError('No billing date yet. An admin can add one on the Admin page.');
  if (bill.startEnergy == null) {
    return showError(`The last billing time (${dateTime(bill.ts)}) is outside the logged readings, so units since billing cannot be measured. Set a newer billing time on the Admin page.`);
  }

  const tariff = data.tariff || DEFAULT_TARIFF;
  const typicalDays = Math.round(avgCycleDays(bills.map(b => new Date(b.ts))));
  const cycleStart = new Date(bill.ts);
  const cycleEnd = new Date(bill.expectedNextTs || bill.ts + typicalDays * DAY);
  const s = cycleSummary({
    cycleStart, cycleEnd, startEnergy: bill.startEnergy, tariff,
    points: data.points.map(p => ({ ts: new Date(p.ts), energy: p.energy })),
    now: new Date(data.serverTime),
  });

  setupChartDefaults();
  renderHero(s, bill, typicalDays, data.serverTime);
  renderKpis(s, tariff);
  renderLimits(s);
  renderUsage(s);
  renderCharges(s);
}

// ---------- hero ----------

function renderHero(s, bill, typicalDays, now) {
  document.getElementById('heroEnd').textContent = `≈ ${dateOnly(s.cycleEnd)}`;
  countUp(document.getElementById('heroBill'), s.projectedBill.total, inr);
  document.getElementById('heroSub').textContent =
    `About ${num(s.projectedUnits, 0)} units this cycle · ${inr(s.projectedBill7.total)} if the last 7 days' pace continues`;

  document.getElementById('chipSoFar').replaceChildren(el('strong', {}, inr(s.chargesSoFar.total)), ' so far');
  document.getElementById('chipUnits').replaceChildren(el('strong', {}, `${num(s.unitsSoFar, 1)} kWh`), ' used');

  const ageMin = (now - s.latestTs) / 60e3;
  const health = document.getElementById('health');
  health.className = 'chip health ' + (ageMin > 120 ? 'health--bad' : ageMin > 30 ? 'health--warn' : 'health--ok');
  health.textContent = ageMin > 120
    ? `No logger data for ${num(ageMin / 60, 1)} h`
    : `Live · ${ageMin < 1 ? 'just now' : Math.round(ageMin) + ' min ago'}`;
  health.title = `Last reading ${dateTime(s.latestTs)}`;

  renderRing(s);

  const endNote = bill.expectedNextTs ? 'set by admin' : `typical ${typicalDays}-day cycle`;
  document.getElementById('cycle').textContent =
    `Cycle started ${dateTime(bill.ts)} · next reading ≈ ${dateOnly(s.cycleEnd)} (${endNote}) · last reading ${dateTime(s.latestTs)}`;
}

// Progress ring: how far through the bill cycle we are
function renderRing(s) {
  const r = 70, c = 2 * Math.PI * r;
  const share = Math.min(s.daysElapsed / s.cycleDays, 1);
  const ring = document.getElementById('ring');
  ring.setAttribute('aria-label', `Day ${Math.floor(s.daysElapsed)} of ${Math.round(s.cycleDays)} in this bill cycle`);
  ring.innerHTML = `
    <svg viewBox="0 0 168 168" aria-hidden="true">
      <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2DD4BF"/><stop offset="1" stop-color="#A78BFA"/>
      </linearGradient></defs>
      <circle class="ring__track" cx="84" cy="84" r="${r}"/>
      <circle class="ring__bar" cx="84" cy="84" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c}"/>
    </svg>
    <div class="ring__label">
      <div class="ring__big">${Math.round(s.daysLeft)}</div>
      <div class="ring__small">days left<br>day ${Math.floor(s.daysElapsed) + 1} of ${Math.round(s.cycleDays)}</div>
    </div>`;
  const bar = ring.querySelector('.ring__bar');
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.strokeDashoffset = String(c * (1 - share)); }));
}

// ---------- KPI cards ----------

const ICONS = {
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="14.5" r="1.2"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/>',
};
const icon = name => {
  const span = el('span', { class: 'kpi__icon', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
  return span;
};

function renderKpis(s, tariff) {
  const faster = s.avg7 > s.growingAvg * 1.05, slower = s.avg7 < s.growingAvg * 0.95;
  const f = s.fppas;
  const fppas = f.unitsLeft <= 0
    ? { value: num(-f.unitsLeft, 0), unit: 'units over', sub: `FPPAS applies – the line was ${num(f.limit, 0)} units`, tone: 'bad', icon: 'alert', accent: '--red' }
    : f.projectedOver
      ? { value: num(f.unitsLeft, 0), unit: 'units left', sub: `On pace to cross – keep under ${num(f.safePerDay, 2)}/day`, tone: 'warn', icon: 'alert', accent: '--amber' }
      : { value: num(f.unitsLeft, 0), unit: 'units left', sub: `Safe – keep under ${num(f.safePerDay, 2)} units/day`, tone: 'ok', icon: 'shield', accent: '--green' };

  const cards = [
    { label: 'Units since last bill', n: s.unitsSoFar, fmt: v => num(v, 1), unit: 'kWh', sub: `since ${dateTime(s.cycleStart)}`, icon: 'bolt', accent: '--amber' },
    { label: 'Growing average', n: s.growingAvg, fmt: v => num(v, 2), unit: 'units/day', sub: `≈ ${num(s.growingAvg * 30, 0)} units/month`, icon: 'trend', accent: '--teal' },
    { label: 'Last 7 days', n: s.avg7, fmt: v => num(v, 2), unit: 'units/day',
      sub: faster ? '▲ faster than the cycle average' : slower ? '▼ slower than the cycle average' : '≈ in line with the cycle average',
      tone: faster ? 'warn' : 'ok', icon: 'pulse', accent: '--violet' },
    { label: 'Charges so far', n: s.chargesSoFar.total, fmt: inr, sub: `if the meter were read today${s.chargesSoFar.fppas > 0 ? ' (incl. FPPAS)' : ''}`, icon: 'wallet', accent: '--coral' },
    { label: `FPPAS line · ${tariff.fppasFromMonthly}/month`, ...fppas },
  ];

  const grid = document.getElementById('kpis');
  grid.replaceChildren(...cards.map((c, i) => {
    const value = el('span', {}, c.n != null ? c.fmt(0) : c.value);
    const card = el('article', { class: `kpi${c.tone ? ' kpi--' + c.tone : ''}`, style: `--accent: var(${c.accent}); --glow: var(${c.accent}); animation-delay: ${i * 60}ms` },
      el('div', { class: 'kpi__top' }, icon(c.icon), el('h3', {}, c.label)),
      el('p', { class: 'kpi__value' }, value, c.unit ? el('span', { class: 'kpi__unit' }, c.unit) : ''),
      el('p', { class: 'kpi__sub' }, c.sub));
    if (c.n != null) countUp(value, c.n, c.fmt);
    return card;
  }));
}

// Numbers count up from zero on load (instant when reduced motion is preferred)
function countUp(node, target, fmt, ms = 1100) {
  if (reducedMotion || !Number.isFinite(target)) { node.textContent = fmt(target); return; }
  const t0 = performance.now();
  const step = t => {
    const p = Math.min((t - t0) / ms, 1);
    node.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- FPPAS meter ----------

// Units used and projected for the whole cycle against the FPPAS line
// (band B is left out: every cycle crosses 100 units/month)
function renderLimits(s) {
  const max = Math.max(s.fppas.limit, s.projectedUnits) * 1.08;
  const pct = x => `${Math.min(x / max, 1) * 100}%`;
  const used = el('div', { class: 'meter__used', style: 'width:0' });
  const proj = el('div', { class: 'meter__proj', style: 'width:0' });
  document.getElementById('meter').replaceChildren(
    el('div', { class: 'meter__track' }, proj, used,
      el('div', { class: 'meter__mark meter__mark--f', style: `left:${pct(s.fppas.limit)}` }, el('span', {}, `FPPAS ${num(s.fppas.limit, 0)}`))),
    el('div', { class: 'meter__legend' },
      el('span', { class: 'swatch swatch--used' }, `Used ${num(s.unitsSoFar, 0)} units`),
      el('span', { class: 'swatch swatch--proj' }, `Projected ${num(s.projectedUnits, 0)} by ${dateOnly(s.cycleEnd)}`)));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    proj.style.width = pct(s.projectedUnits);
    used.style.width = pct(s.unitsSoFar);
  }));
}

// ---------- charts ----------

function setupChartDefaults() {
  Chart.defaults.font.family = css('--font') || 'Inter, sans-serif';
  Chart.defaults.color = css('--text-muted');
  Chart.defaults.animation.duration = reducedMotion ? 0 : 900;
}

function baseOptions(yTitle, money) {
  const text = css('--text-muted'), grid = css('--grid');
  return {
    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', labels: { color: text, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', padding: 16 } },
      tooltip: {
        backgroundColor: 'rgba(12, 17, 33, 0.95)', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1,
        titleColor: css('--text'), bodyColor: css('--text'), padding: 10, cornerRadius: 10, boxPadding: 4, usePointStyle: true,
        callbacks: { label: c => c.raw == null ? null : `${c.dataset.label}: ${money ? inr(c.raw) : num(c.raw, 2)}` },
      },
    },
    scales: {
      x: { ticks: { color: text, maxRotation: 0, autoSkipPadding: 14 }, grid: { display: false }, border: { display: false } },
      y: { beginAtZero: true, title: { display: !money, text: yTitle, color: text }, ticks: { color: text, callback: v => money ? inr(v) : v }, grid: { color: grid }, border: { display: false } },
    },
  };
}

// Vertical gradient fill for bars and areas, from `top` colour to `bottom`
function vGradient(top, bottom) {
  return ({ chart }) => {
    const { ctx, chartArea } = chart;
    if (!chartArea) return top;
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  };
}

// Segmented switch; remembers each viewer's choice on this device
function toggle(id, options, onChange) {
  let current = options[0].value;
  try { current = localStorage.getItem('pp_' + id) || current; } catch { /* storage unavailable */ }
  if (!options.some(o => o.value === current)) current = options[0].value;
  const buttons = options.map(o => el('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(o.value === current), onclick: () => select(o.value) }, o.label));
  document.getElementById(id).replaceChildren(...buttons);
  function select(value) {
    current = value;
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].value === value)));
    try { localStorage.setItem('pp_' + id, value); } catch { /* storage unavailable */ }
    onChange(value);
  }
  onChange(current);
}

// Units per day: chart or table
function renderUsage(s) {
  const chartBox = document.getElementById('usageChartBox');
  const tableBox = document.getElementById('usageTableBox');
  renderDailyTable(s);
  let chart = null;
  toggle('usageView', [{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }], view => {
    chartBox.hidden = view !== 'chart';
    tableBox.hidden = view !== 'table';
    document.getElementById('usageNote').textContent = view === 'chart'
      ? 'Bars: units used each day. Line: average per day since the bill.'
      : 'Every day of this cycle, newest first. Charge = units × this cycle\'s projected average rate.';
    if (view === 'chart' && !chart) chart = renderUsageChart(s);   // Chart.js needs a visible canvas to size itself
  });
}

function renderUsageChart(s) {
  const today = s.days.length - 1;
  const full = vGradient('rgba(255, 209, 102, 0.95)', 'rgba(255, 138, 61, 0.35)');
  return new Chart(document.getElementById('usageChart'), {
    data: {
      labels: s.days.map((d, i) => i === today ? 'Today' : shortDate(d.date)),
      datasets: [
        {
          type: 'bar', label: 'Units used that day', data: s.days.map(d => d.units), order: 2,
          backgroundColor: ctx => ctx.dataIndex === today ? css('--amber-faint') : full(ctx),
          borderRadius: 6, borderSkipped: false, maxBarThickness: 26,
        },
        {
          type: 'line', label: 'Growing average', data: s.days.map(d => d.growingAvg), order: 1,
          borderColor: css('--teal'), backgroundColor: css('--teal'), pointRadius: 0, pointHoverRadius: 5, borderWidth: 3, tension: 0.35,
        },
      ],
    },
    options: baseOptions('units', false),
  });
}

// Every day of the cycle, newest first, with that day's share of the bill
function renderDailyTable(s) {
  const rate = cycleRate(s);
  const rows = [...s.days].reverse();
  document.getElementById('daily').replaceChildren(
    el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', { class: 'num' }, 'Units'), el('th', { class: 'num' }, 'Growing avg'), el('th', { class: 'num' }, 'Charge'))),
    el('tbody', {}, ...rows.map((d, i) => el('tr', {},
      el('td', {}, i === 0 ? `${shortDate(d.date)} (so far)` : shortDate(d.date)),
      el('td', { class: 'num' }, num(d.units, 2)),
      el('td', { class: 'num' }, num(d.growingAvg, 2)),
      el('td', { class: 'num' }, inr(d.units * rate))))));
}

// Average ₹ per unit for the projected cycle. Sharing the cycle bill by units, like
// Power BI's 'Daily Electricity Charge', makes the daily charges add up to the bill.
function cycleRate(s) {
  return s.projectedUnits > 0 ? s.projectedBill.total / s.projectedUnits : 0;
}

// Bill: cumulative or day by day
function renderCharges(s) {
  const note = document.getElementById('chargesNote');
  let chart = null;
  toggle('chargesView', [{ value: 'cumulative', label: 'Cumulative' }, { value: 'daily', label: 'Day by day' }], view => {
    if (chart) chart.destroy();
    if (view === 'daily') {
      const rate = cycleRate(s);
      note.textContent = `Each day's units × ₹${num(rate, 2)}/unit (this cycle's projected average rate). Faded bars are projected days.`;
      chart = dailyChargesChart(s, rate);
    } else {
      note.textContent = `${inr(s.chargesSoFar.total)} so far → about ${inr(s.projectedBill.total)} at the ${dateOnly(s.cycleEnd)} reading.`;
      chart = cumulativeChargesChart(s);
    }
  });
}

function cycleKeys(s) {
  const actualKeys = s.days.map(d => d.date);
  return { actualKeys, keys: [...actualKeys, ...s.projection.map(p => p.date).filter(k => !actualKeys.includes(k))] };
}

function cumulativeChargesChart(s) {
  const { keys } = cycleKeys(s);
  const actual = keys.map(k => s.days.find(d => d.date === k)?.chargesSoFar ?? null);
  const projected = keys.map(k => s.projection.find(p => p.date === k)?.charges ?? null);
  return new Chart(document.getElementById('chargesChart'), {
    type: 'line',
    data: {
      labels: keys.map(shortDate),
      datasets: [
        { label: 'Bill so far', data: actual, borderColor: css('--coral'), backgroundColor: vGradient('rgba(255, 122, 89, 0.45)', 'rgba(255, 122, 89, 0)'), fill: true, pointRadius: 0, pointHoverRadius: 5, borderWidth: 3, tension: 0.3 },
        { label: 'Projected', data: projected, borderColor: css('--amber'), backgroundColor: css('--amber'), borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 5, borderWidth: 2, tension: 0.3 },
      ],
    },
    options: baseOptions('₹', true),
  });
}

function dailyChargesChart(s, rate) {
  const { actualKeys, keys } = cycleKeys(s);
  const today = actualKeys.length - 1;
  const actual = keys.map((k, i) => i < actualKeys.length ? s.days[i].units * rate : null);
  const projected = keys.map((k, i) => i < actualKeys.length ? null : s.growingAvg * rate);
  const full = vGradient('rgba(255, 122, 89, 0.95)', 'rgba(255, 92, 122, 0.35)');
  return new Chart(document.getElementById('chargesChart'), {
    type: 'bar',
    data: {
      labels: keys.map((k, i) => i === today ? 'Today' : shortDate(k)),
      datasets: [
        { label: 'Charge that day', data: actual, backgroundColor: ctx => ctx.dataIndex === today ? css('--coral-faint') : full(ctx), borderRadius: 5, borderSkipped: false, maxBarThickness: 26, grouped: false },
        { label: 'Projected', data: projected, backgroundColor: css('--coral-ghost'), borderColor: css('--coral-faint'), borderWidth: 1, borderRadius: 5, borderSkipped: false, maxBarThickness: 26, grouped: false },
      ],
    },
    options: baseOptions('₹', true),
  });
}
