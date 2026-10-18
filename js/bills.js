// Bills page. Breakdown tab: the cycle's bill laid out like the DHBVN bill (slab calculation and
// bill components A, 1–7, B, C, payable), all calculated by the server (data.breakdown).
import { boot, el, inr, num, dateTime, dateOnly, showNoAccess } from './ui.js';
import { normalizeTariff } from './billing.js';
import { cycleParam, renderCycleBar } from './cycle.js';

const rs = x => '₹' + Number(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const can = (me, page) => me.role === 'admin' || (me.pages || []).includes(page);

boot('bills', cycleParam() ? { cycle: cycleParam() } : {}).then(render).catch(() => { /* error already shown */ });

function render(data) {
  const me = data.me;
  if (!can(me, 'breakdown') && !can(me, 'documents')) return showNoAccess('breakdown', 'Bill breakdown');
  if (data.cycles && data.cycle) renderCycleBar(data.cycles, data.cycle);

  const tabs = [];
  if (can(me, 'breakdown')) tabs.push({ id: 'tabBreakdown', label: 'Breakdown', show: () => renderBreakdown(data) });
  tabs.forEach((t, i) => { if (i === 0) t.show(); });
  const bar = document.getElementById('billTabs');
  bar.hidden = tabs.length < 2;
  bar.replaceChildren(...tabs.map((t, i) => el('button', { class: 'seg__btn', type: 'button', role: 'tab', 'aria-pressed': String(i === 0),
    onclick: e => {
      tabs.forEach(x => { document.getElementById(x.id).hidden = x !== t; });
      bar.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      t.show();
    } }, t.label)));
  document.getElementById(tabs[0].id).hidden = false;
  document.getElementById('print').addEventListener('click', () => window.print());
}

// ---------- Breakdown ----------

function renderBreakdown(data) {
  const box = document.getElementById('tabBreakdown');
  if (!data.calc || !data.breakdown) {
    box.replaceChildren(el('section', { class: 'panel' }, el('p', { class: 'muted' },
      data.cycle && !data.cycle.current
        ? 'The logger has no readings for this cycle, so the app can\'t work out its bill. Upload its DHBVN bill to see it here.'
        : 'No bill to show yet: an admin needs to set the last billing date.')));
    return;
  }
  const current = data.cycle.current;
  const tariff = normalizeTariff(data.calc.tariff);
  const views = current
    ? [{ value: 'soFar', label: 'So far' }, { value: 'projected', label: 'Projected at next reading' }]
    : [{ value: 'final', label: 'Final' }];
  const seg = document.getElementById('bdView');
  const pick = value => {
    seg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(views[i].value === value)));
    showPart(data, value, tariff);
  };
  seg.replaceChildren(...views.map(v => el('button', { class: 'seg__btn', type: 'button', onclick: () => pick(v.value) }, v.label)));
  seg.hidden = views.length < 2;
  pick(views[0].value);
}

function showPart(data, key, tariff) {
  const part = data.breakdown[key];
  const bill = part.bill, st = part.statement, w = part.whatIf;
  const s = data.calc;
  const start = new Date(s.cycleStart), end = new Date(s.cycleEnd);
  const title = { soFar: 'Bill so far', projected: 'Projected bill at the next reading', final: 'Final bill for this cycle' }[key];
  document.getElementById('bdTitle').textContent = title;
  document.getElementById('bdNote').textContent = {
    soFar: `As if the meter were read now (${dateTime(s.latestTs)}).`,
    projected: `If use continues at the cycle's average until the expected reading on ${dateOnly(end)}.`,
    final: `From the reading on ${dateTime(start)} to the next on ${dateTime(end)}.`,
  }[key];

  const avg = part.units / part.days;
  const fact = (k, v, hint) => [el('dt', {}, k), el('dd', {}, v, hint ? el('span', { class: 'muted-sm' }, ' · ' + hint) : '')];
  document.getElementById('bdFacts').replaceChildren(
    ...fact('Cycle', `${dateOnly(start)} → ${key === 'soFar' ? 'now' : dateOnly(end)}`),
    ...fact('Units', `${num(part.units, 1)} kWh`, `logger reading × ${tariff.meterFactor} (meter adjustment)`),
    ...fact('Days', num(part.days, 1)),
    ...fact('Average', `${num(avg, 2)} units/day`, `≈ ${num(avg * 30, 0)} units/month`),
    ...fact('Band', bill.band, `${bill.band === 'B' ? 'above' : 'at or below'} ${tariff.bandBAbovePerDay} units/day`),
    ...fact('FPPAS', bill.fppas > 0 ? 'charged' : 'not charged', `${num(avg * 30, 0)} units/month ${bill.fppas > 0 ? '≥' : '<'} ${tariff.fppasFromMonthly}`),
  );

  // Slab calculation, as on the DHBVN bill
  const slabs = document.getElementById('slabs');
  slabs.replaceChildren(
    el('thead', {}, el('tr', {}, el('th', {}, 'Units'), el('th', { class: 'num' }, 'Rate'), el('th', { class: 'num' }, 'Amount (₹)'))),
    el('tbody', {}, ...bill.slabLines.map(l => el('tr', {},
      el('td', {}, num(l.units, 1)), el('td', { class: 'num' }, l.rate.toFixed(3)), el('td', { class: 'num' }, num(l.amount, 2))))),
    el('tfoot', {}, el('tr', {}, el('td', { colspan: '2' }, 'Total (Energy charges)'), el('td', { class: 'num' }, num(bill.energy, 2)))));
  document.getElementById('slabNote').textContent = `Each slab holds its daily width × ${num(part.days, 1)} days (e.g. 5 units/day × days in the first band-B slab); the last slab takes the rest. Each line is rounded to the paisa, like the bill.`;

  // Bill component wise details
  const row = (sr, label, amount, cls) => el('tr', { class: cls || '' }, el('td', {}, sr), el('td', {}, label), el('td', { class: 'num' }, typeof amount === 'number' ? num(amount, 2) : amount));
  const paisa = Math.round(tariff.fppasPerUnit * 100), duty = Math.round(tariff.dutyPerUnit * 100);
  document.getElementById('components').replaceChildren(
    el('thead', {}, el('tr', {}, el('th', {}, 'Sr'), el('th', {}, 'Description'), el('th', { class: 'num' }, 'Amount (₹)'))),
    el('tbody', {},
      row('A', 'Arrears outstanding', st.arrears),
      row('1', 'Energy charges', bill.energy),
      row('2', 'Fixed charges', bill.fixed),
      row('3', `FPPAS @ ${paisa} paisa/unit`, bill.fppas),
      row('4', `Municipal tax @ ${num(tariff.municipalTaxPct * 100, 0)}% [1+2+3]`, bill.municipalTax),
      row('5', `Electricity duty @ ${duty} paisa/unit`, bill.duty),
      row('6', 'Security review charges', 0),
      row('7', 'Govt. subsidy / rebate', 0),
      row('B', 'Total current cycle charges [1 to 7]', bill.total, 'bill-table__total'),
      row('C', 'Sundry charges / allowances', st.sundry)),
    el('tfoot', {}, row('', 'Total payable [A+B+C]', rs(st.payable).replace(/\.00$/, '.00'))));
  document.getElementById('payNote').textContent = st.arrears || st.sundry
    ? `A + B + C = ${rs(st.gross)}, rounded to the rupee; the ${rs(Math.abs(st.carry))} difference goes to the next bill's arrears.`
    : `Arrears (A) and sundry (C) come from the DHBVN bill once it is uploaded; 0 until then. ${rs(st.gross)} rounded to the rupee = ${rs(st.payable)}.`;

  // What would change the bill
  document.getElementById('wiTitle').textContent = key === 'final' ? 'How close this cycle was' : 'What would change the bill';
  const items = [];
  if (w.slab.unitsLeft != null && w.slab.unitsLeft > 0) {
    items.push(`${num(w.slab.unitsLeft, 0)} units left in the ₹${w.slab.rate.toFixed(2)} slab${w.slab.nextRate ? `; after that ₹${w.slab.nextRate.toFixed(2)}/unit` : ''}.`);
  }
  if (w.bandB != null) items.push(w.bandB > 0 ? `${num(w.bandB, 0)} units before band B (every slab is then priced at band-B rates).` : 'Band B applies.');
  items.push(w.fppas > 0 ? `${num(w.fppas, 0)} units before the FPPAS line (${paisa} paisa on every unit once crossed).` : `FPPAS applies: ${num(-w.fppas, 0)} units over the line.`);
  items.push(w.fixed > 0 ? `${num(w.fixed, 0)} units before the fixed charge (₹${tariff.fixedPerKwMonth}/kW/month above ${tariff.fixedAboveMonthly} units/month).` : 'The fixed charge applies (above 300 units/month).');
  items.push(`One more unit ${key === 'final' ? 'would have added' : 'adds'} ${rs(w.nextUnit)} to this bill (rate + FPPAS + tax + duty).`);
  document.getElementById('whatIf').replaceChildren(...items.map(t => el('li', {}, t)));
}
