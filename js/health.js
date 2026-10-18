// Service health page: the server's checks (ok / warn / bad), recent jobs, open alerts, errors and
// which backend version runs. Refreshes itself every minute; the API time is measured here.
import { boot, el, dateTime, showNoAccess } from './ui.js';
import { call } from './api.js';

const DOT = { ok: '●', warn: '●', bad: '●' };
const WORD = { ok: 'All good', warn: 'Needs a look', bad: 'Something is wrong' };
const ALERT = { stale: 'Logger data stopped', lag: 'App not taking in data', 'job:updateHourly': 'Data update failing', 'job:healthCheck': 'Health check failing', access: 'Access request' };

boot('health').then(me => {
  const m = me.me;
  if (m.role !== 'admin' && !(m.pages || []).includes('health')) return showNoAccess('health', 'Service health');
  document.getElementById('refresh').addEventListener('click', load);
  load();
  setInterval(load, 60e3);
}).catch(() => { /* error already shown */ });

async function load() {
  const t0 = performance.now();
  try {
    const h = await call('health');
    render(h, Math.round(performance.now() - t0));
  } catch (err) {
    if (err.need) return showNoAccess(err.need, 'Service health');
    document.getElementById('checked').textContent = `Could not reach the server: ${err.message}`;
  }
}

function render(h, apiMs) {
  const overall = document.getElementById('overall');
  overall.textContent = `Service health · ${WORD[h.status]}`;
  overall.className = `health-title health-title--${h.status}`;
  document.getElementById('checked').textContent = `Checked ${dateTime(h.serverTime)}`;
  const api = { key: 'api', label: 'Server (API)', status: apiMs > 8000 ? 'bad' : apiMs > 3000 ? 'warn' : 'ok', value: `answered in ${(apiMs / 1000).toFixed(1)} s`, detail: `${h.env === 'uat' ? 'UAT' : 'Prod'} backend` };
  document.getElementById('checks').replaceChildren(...[api, ...h.checks].map(c => el('article', { class: `hcheck hcheck--${c.status}` },
    el('div', { class: 'hcheck__head' }, el('span', { class: 'hcheck__dot', 'aria-hidden': 'true' }, DOT[c.status]), el('h3', {}, c.label)),
    el('p', { class: 'hcheck__value' }, c.value),
    c.detail ? el('p', { class: 'muted-sm' }, c.detail) : '')));

  document.getElementById('jobs').replaceChildren(
    el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Job'), el('th', {}, 'Result'), el('th', { class: 'num' }, 'Time'))),
    el('tbody', {}, ...(h.jobs.length ? h.jobs.map(j => el('tr', {},
      el('td', {}, dateTime(j.ts)), el('td', {}, j.job),
      el('td', {}, el('span', { class: `tag ${j.status === 'ok' ? 'tag--sign-in' : j.status === 'error' ? 'tag--denied' : 'tag--sign-out'}` }, j.status), j.message ? el('div', { class: 'muted-sm' }, j.message) : ''),
      el('td', { class: 'num' }, `${(j.ms / 1000).toFixed(1)} s`))) : [el('tr', {}, el('td', { colspan: '4', class: 'muted' }, 'No runs logged yet.'))])));

  document.getElementById('alerts').replaceChildren(...(h.alerts.length
    ? h.alerts.map(a => el('li', {}, `${ALERT[a.key] || a.key} – since ${dateTime(a.since)}`))
    : [el('li', { class: 'muted' }, 'No open alerts.')]));
  document.getElementById('errors').replaceChildren(...(h.errors.length ? [
    el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Where'), el('th', {}, 'Message'))),
    el('tbody', {}, ...h.errors.map(e => el('tr', {}, el('td', {}, dateTime(e.ts)), el('td', {}, e.action ? `${e.where} · ${e.action}` : e.where), el('td', {}, e.message)))),
  ] : [el('tbody', {}, el('tr', {}, el('td', { class: 'muted' }, 'No server errors in the last 24 hours.')))]));

  document.getElementById('build').textContent = h.build
    ? `Backend ${h.build.env} · code ${h.build.commit}${h.build.dirty ? ' + local changes' : ''} · deployed ${dateTime(Date.parse(h.build.deployedAt))}`
    : 'Backend version: not stamped (deployed by hand).';
}
