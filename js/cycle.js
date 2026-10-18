// The bill-cycle picker: which cycle the page shows, kept in the address (?cycle=<start ms>) so
// it stays the same when moving between pages and after a refresh. Shown to people with
// "Past cycles"; the server refuses other cycles to everyone else.
import { el, num, inr } from './ui.js';

const SHORT = { day: '2-digit', month: 'short' };
const LONG = { day: '2-digit', month: 'short', year: 'numeric' };
const date = (ms, o) => new Date(ms).toLocaleDateString('en-IN', o);

/** The cycle asked for in the address, or null for the current one. */
export function cycleParam() {
  const v = new URLSearchParams(location.search).get('cycle');
  return v && /^\d+$/.test(v) ? Number(v) : null;
}

/** href with this page's ?cycle (and ?demo) carried over. */
export function withCycle(href) {
  const here = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  ['cycle', 'demo'].forEach(k => { if (here.has(k)) keep.set(k, here.get(k)); });
  const q = keep.toString();
  return q ? `${href}${href.includes('?') ? '&' : '?'}${q}` : href;
}

function go(start, current) {
  const q = new URLSearchParams(location.search);
  if (current) q.delete('cycle'); else q.set('cycle', String(start));
  const s = q.toString();
  location.search = s ? '?' + s : '';
}

export function cycleLabel(c) {
  if (c.current) return `Current cycle · since ${date(c.start, LONG)}`;
  const span = `${date(c.start, SHORT)} – ${date(c.end, LONG)}`;
  const facts = c.units == null ? 'no logger data' : `${num(c.units, 1)} units · ${inr(c.appTotal)}`;
  return `${span} · ${Math.round(c.days)} days · ${facts}`;
}

/** Fills #cyclebar: ◀ [cycle ▾] ▶ and "Current" when looking at a past cycle. */
export function renderCycleBar(cycles, shown) {
  const bar = document.getElementById('cyclebar');
  if (!bar || !cycles || !cycles.length) return;
  const list = [...cycles].reverse();   // newest first
  const i = list.findIndex(c => c.start === shown.start);
  const older = list[i + 1], newer = list[i - 1];
  const select = el('select', { 'aria-label': 'Bill cycle', onchange: e => { const c = list[e.target.selectedIndex]; go(c.start, c.current); } },
    ...list.map(c => el('option', { value: String(c.start), selected: c.start === shown.start ? 'selected' : null }, cycleLabel(c))));
  bar.replaceChildren(
    el('button', { class: 'cyclebar__step', type: 'button', title: 'Older cycle', 'aria-label': 'Older cycle', disabled: !older, onclick: () => go(older.start, false) }, '◀'),
    el('label', { class: 'cyclebar__pick' }, el('span', { class: 'cyclebar__label' }, 'Bill cycle'), select),
    el('button', { class: 'cyclebar__step', type: 'button', title: 'Newer cycle', 'aria-label': 'Newer cycle', disabled: !newer, onclick: () => go(newer.start, newer.current) }, '▶'),
    shown.current ? el('span', { class: 'chip cyclebar__live' }, '● Live') : el('button', { class: 'btn btn--small', type: 'button', onclick: () => go(0, true) }, 'Back to current'),
  );
  bar.hidden = false;
}

/** The cycle before the one shown (for "vs previous cycle"), or null. */
export function previousCycle(cycles, shown) {
  if (!cycles) return null;
  const i = cycles.findIndex(c => c.start === shown.start);
  return i > 0 ? cycles[i - 1] : null;
}
