// Bills page → Uploaded bills.
// The admin picks a DHBVN e-bill PDF; pdf.js reads its text here in the browser and
// js/billparse.js picks out the figures. Every field is shown next to the bill for checking;
// only after "Confirm" are the PDF and figures sent (the server checks them again). The list shows
// each bill's own checks ("Is DHBVN's bill right?") and the comparison with the app's cycle.
import { el, num, dateOnly } from './ui.js';
import { call } from './api.js';
import { parseDhbvnBill } from './billparse.js';
import { checkDhbvnBill } from './billing.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/';
const rs = x => '₹' + Number(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ICON = { ok: '✅', warn: '⚠️', bad: '❌' };
let loaded = false;

export function renderUploads(me) {
  if (loaded) return;
  loaded = true;
  const box = document.getElementById('tabUploads');
  const list = el('div', { id: 'docList' });
  const calib = el('div', { id: 'calibration' });
  box.replaceChildren(...(me.role === 'admin' ? [uploadCard(() => loadList(list, calib, me))] : []), list, calib);
  loadList(list, calib, me);
}

// ---------- upload → read → review → confirm ----------

function uploadCard(onSaved) {
  const msg = el('p', { class: 'msg', role: 'status' });
  const review = el('div', { class: 'review', hidden: true });
  const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', 'aria-label': 'DHBVN bill PDF' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return setMsg(msg, 'The PDF is larger than 10 MB.', false);
    setMsg(msg, 'Reading the bill…', true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { text, page } = await readPdf(bytes);
      const { fields, missing } = parseDhbvnBill(text);
      setMsg(msg, missing.length ? `Some figures could not be read (${missing.join(', ')}). Check them against the bill, or use the e-bill PDF from DHBVN.` : 'Read. Check every figure against the bill, then confirm.', !missing.length);
      showReview(review, fields, missing, page, bytes, file.name, async () => {
        input.value = '';
        review.hidden = true;
        setMsg(msg, 'Saved.', true);
        onSaved();
      }, () => { input.value = ''; review.hidden = true; setMsg(msg, '', true); });
    } catch (err) {
      setMsg(msg, `This PDF could not be read (${err.message}). Use the e-bill PDF downloaded from DHBVN.`, false);
    }
  });
  return el('section', { class: 'panel no-print' },
    el('h2', {}, 'Upload a DHBVN bill'),
    el('p', { class: 'muted' }, 'Choose the e-bill PDF from DHBVN. It is read on this device; nothing is sent until you confirm. The PDF is kept in a private Drive folder and shown only through this app.'),
    el('label', { class: 'upload' }, input), msg, review);
}

async function readPdf(bytes) {
  const pdfjs = await import(PDFJS + 'pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;   // a copy: pdf.js takes over the buffer
  const page = await doc.getPage(1);
  const { items } = await page.getTextContent();
  const text = items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
  return { text, page };
}

const FIELD_ROWS = [
  ['periodFrom', 'Reading from (date)', 'text'], ['periodTo', 'Reading to (date)', 'text'], ['days', 'Days', 'num'],
  ['readingOld', 'Meter reading – old', 'num'], ['readingNew', 'Meter reading – new', 'num'], ['units', 'Billed units', 'num'],
  ['arrears', 'A  Arrears', 'num'], ['energy', '1  Energy charges', 'num'], ['fixed', '2  Fixed charges', 'num'], ['fppas', '3  FPPAS', 'num'],
  ['tax', '4  Municipal tax', 'num'], ['duty', '5  Electricity duty', 'num'], ['security', '6  Security review', 'num'], ['subsidy', '7  Govt. subsidy', 'num'],
  ['total', 'B  Total [1 to 7]', 'num'], ['sundry', 'C  Sundry (parts, comma-separated)', 'list'], ['payable', 'Total payable [A+B+C]', 'num'], ['dueDate', 'Due date', 'text'],
];

function showReview(box, fields, missing, page, bytes, fileName, onSaved, onCancel) {
  const f = JSON.parse(JSON.stringify(fields));
  const checks = el('div', { class: 'checks' });
  const save = el('button', { class: 'btn', type: 'button' }, 'Confirm and save');
  const msg = el('p', { class: 'msg', role: 'status' });
  const refresh = () => {
    const ok = FIELD_ROWS.every(([k, , kind]) => kind === 'text' ? /^\d{4}-\d\d-\d\d$/.test(f[k] || '') || k === 'dueDate' : kind === 'list' || Number.isFinite(f[k]));
    const c = ok && f.slabs.length ? checkDhbvnBill(f) : null;
    checks.replaceChildren(
      badge(c && c.linesAddUp, 'Lines 1–7 add up to B'),
      badge(c && c.payableAddsUp, 'A + B + C rounds to the payable'),
      badge(c && c.right, c && c.right ? 'Matches the DHBVN tariff for these units and days' : 'Differs from the tariff for these units and days (see the list after saving)', !c || c.right ? null : 'warn'));
    save.disabled = !(c && c.linesAddUp && c.payableAddsUp);
  };
  const rows = FIELD_ROWS.map(([k, label, kind]) => {
    const value = kind === 'list' ? (f[k] || []).join(', ') : f[k] ?? '';
    const input = el('input', { type: 'text', inputmode: kind === 'num' ? 'decimal' : null, value: String(value), class: missing.includes(k) ? 'field--missing' : '' });
    input.addEventListener('input', () => {
      const v = input.value.trim();
      f[k] = kind === 'num' ? (v === '' ? null : Number(v)) : kind === 'list' ? v.split(',').map(x => Number(x.trim())).filter(Number.isFinite) : v;
      refresh();
    });
    return el('tr', {}, el('th', { scope: 'row' }, label), el('td', {}, input));
  });
  const slabs = el('p', { class: 'muted-sm' }, 'Slab lines read: ', f.slabs.map(s => `${num(s.units, 1)} @ ${s.rate.toFixed(3)} = ${num(s.amount, 2)}`).join(' · ') || 'none');
  const canvas = el('canvas', { class: 'review__preview', 'aria-label': 'Page 1 of the bill' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    setMsg(msg, 'Saving…', true);
    try {
      await call('uploadBill', { fields: f, file: { name: fileName, base64: toBase64(bytes) } });
      onSaved();
    } catch (err) {
      setMsg(msg, err.message, false);
      save.disabled = false;
    }
  });
  box.replaceChildren(
    el('div', { class: 'review__grid' },
      el('div', {}, canvas),
      el('div', {}, el('table', { class: 'bill-table review__fields' }, el('tbody', {}, ...rows)), slabs, checks,
        el('div', { class: 'row' }, save, el('button', { class: 'btn btn--ghost', type: 'button', onclick: onCancel }, 'Cancel')), msg)));
  box.hidden = false;
  refresh();
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1.4, 520 / viewport.width);
  const vp = page.getViewport({ scale });
  canvas.width = vp.width; canvas.height = vp.height;
  page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
}

function badge(ok, text, tone) {
  const t = tone || (ok ? 'ok' : 'bad');
  return el('span', { class: `check check--${t}` }, `${ICON[t]} ${text}`);
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- list + comparison ----------

async function loadList(list, calib, me) {
  list.replaceChildren(el('p', { class: 'muted' }, 'Loading uploaded bills…'));
  try {
    const { docs, calibration } = await call('listBillDocs');
    list.replaceChildren(...(docs.length ? docs.map(d => docCard(d, me, () => loadList(list, calib, me)))
      : [el('section', { class: 'panel' }, el('p', { class: 'muted' }, 'No DHBVN bills uploaded yet.'))]));
    calib.replaceChildren(calibration ? calibrationCard(calibration) : '');
  } catch (err) {
    list.replaceChildren(el('p', { class: 'msg msg--error' }, err.message));
  }
}

function docCard(d, me, reload) {
  const f = d.fields;
  const right = d.check.right;
  const msg = el('p', { class: 'msg', role: 'status' });
  const view = el('button', { class: 'btn btn--small', type: 'button', onclick: async () => {
    setMsg(msg, 'Opening…', true);
    try {
      const file = await call('getBillFile', { id: d.id });
      const blob = new Blob([Uint8Array.from(atob(file.base64), c => c.charCodeAt(0))], { type: 'application/pdf' });
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
      setMsg(msg, '', true);
    } catch (err) { setMsg(msg, err.message, false); }
  } }, 'View PDF');
  const remove = me.role === 'admin' ? el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: async () => {
    if (!confirm(`Remove the uploaded bill ${f.periodFrom} → ${f.periodTo}? The PDF goes to the bin.`)) return;
    try { await call('deleteBillDoc', { id: d.id }); reload(); } catch (err) { setMsg(msg, err.message, false); }
  } }, 'Remove') : '';
  return el('section', { class: 'panel billdoc' },
    el('div', { class: 'panel__head' },
      el('div', {},
        el('h2', {}, `${dateOnly(Date.parse(f.periodFrom))} → ${dateOnly(Date.parse(f.periodTo))}`),
        el('p', { class: 'muted' }, `${num(f.units, 1)} units in ${f.days} days · B ${rs(f.total)} · payable ${rs(f.payable)}${f.dueDate ? ` · due ${dateOnly(Date.parse(f.dueDate))}` : ''}`)),
      el('div', { class: 'row no-print' }, view, remove)),
    el('div', { class: 'checks' },
      badge(d.check.linesAddUp && d.check.payableAddsUp, 'The bill\'s own figures add up'),
      badge(right, right ? 'Is DHBVN\'s bill right? Yes – the tariff gives exactly these lines' : 'Is DHBVN\'s bill right? Some lines differ from the tariff', right ? null : 'bad'),
      d.cycleStart ? badge(true, 'Linked to its billing cycle') : badge(false, 'No billing record with these reading dates (add it on Admin)', 'warn')),
    right ? '' : el('ul', { class: 'whatif' }, ...d.check.lines.filter(l => !l.ok).map(l => el('li', {}, `${l.label}: DHBVN ${rs(l.dhbvn)}, tariff gives ${rs(l.recalc)}`))),
    d.compare ? compareTable(d.compare) : el('p', { class: 'muted-sm' }, 'The app has no logger figures for this cycle to compare with.'),
    msg);
}

function compareTable(c) {
  const fmt = (r, v) => (r.key === 'units' ? num(v, 1) : rs(v));
  return el('div', { class: 'table-wrap' }, el('table', { class: 'bill-table' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Line'), el('th', { class: 'num' }, 'DHBVN bill'), el('th', { class: 'num' }, 'App'), el('th', { class: 'num' }, 'Difference'), el('th', {}, ''))),
    el('tbody', {}, ...c.rows.map(r => el('tr', {},
      el('td', {}, r.label),
      el('td', { class: 'num' }, fmt(r, r.dhbvn)),
      el('td', { class: 'num' }, fmt(r, r.app)),
      el('td', { class: 'num' }, `${r.diff >= 0 ? '+' : '−'}${fmt(r, Math.abs(r.diff))}${r.key === 'units' && r.dhbvn ? ` (${num(r.diff / r.dhbvn * 100, 1)}%)` : ''}`),
      el('td', {}, `${ICON[r.status]} ${r.reason}`))))));
}

function calibrationCard(c) {
  const msg = el('p', { class: 'msg', role: 'status' });
  const s = c.suggestion;
  const apply = s ? el('button', { class: 'btn', type: 'button', disabled: Math.abs(s.factor - c.current) < 0.0005, onclick: async () => {
    if (!confirm(`Use meter factor ${s.factor} (now ${c.current}) from the start of the current cycle? Past cycles keep their factor.`)) return;
    try {
      const r = await call('applyMeterFactor', { factor: s.factor, cycles: s.cycles });
      setMsg(msg, `Done: ${r.details}. Reload to see the new figures.`, true);
    } catch (err) { setMsg(msg, err.message, false); }
  } }, `Use ${s.factor}`) : '';
  return el('section', { class: 'panel no-print' },
    el('h2', {}, 'Meter calibration'),
    el('p', { class: 'muted' }, `The logger reads slightly differently from the DHBVN meter, so its units are multiplied by a meter factor (now ${c.current}). Each confirmed bill shows the real ratio; cycles with at least 80% logger data are used for the suggestion.`),
    el('div', { class: 'table-wrap' }, el('table', { class: 'bill-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Cycle'), el('th', { class: 'num' }, 'DHBVN units'), el('th', { class: 'num' }, 'Logger units'), el('th', { class: 'num' }, 'Ratio'), el('th', { class: 'num' }, 'Logger data'))),
      el('tbody', {}, ...c.cycles.map(x => el('tr', {},
        el('td', {}, `${x.periodFrom} → ${x.periodTo}`),
        el('td', { class: 'num' }, num(x.dhbvnUnits, 1)), el('td', { class: 'num' }, num(x.loggerUnits, 1)),
        el('td', { class: 'num' }, (x.dhbvnUnits / x.loggerUnits).toFixed(4)),
        el('td', { class: 'num' }, `${Math.round(x.coverage * 100)}%${x.coverage < 0.8 ? ' (not used)' : ''}`)))))),
    el('p', {}, s ? `Suggested meter factor: ${s.factor} (from ${s.cycles} cycle${s.cycles > 1 ? 's' : ''}). ` : 'No cycle has enough logger data for a suggestion yet. ', apply),
    msg);
}

function setMsg(node, text, ok) {
  node.textContent = text;
  node.className = 'msg ' + (ok ? 'msg--ok' : 'msg--error');
}
