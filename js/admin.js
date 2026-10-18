// Admin page: billing date/time, billing history, viewers, activity log.
import { boot, el, num, dateTime, dateOnly, showError } from './ui.js';
import { call } from './api.js';

let me = '';

boot().then(data => {
  if (data.me.role !== 'admin') {
    document.getElementById('main').hidden = true;
    return showError('Only admins can open this page.');
  }
  me = data.me.email;
  renderBills(data.bills);
  loadUsers();
  setupBillForm();
  setupUserForm();
  setupTelegram();
  setupAlerts();
  setupCorrections();
  setupActivity();
}).catch(() => { /* error already shown */ });

function setupBillForm() {
  const form = document.getElementById('billForm');
  const msg = document.getElementById('billMsg');
  const input = document.getElementById('billTs');
  input.max = toLocalInput(new Date());
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const ts = new Date(input.value).getTime();
    const next = document.getElementById('nextDate').value;
    const expectedNextTs = next ? new Date(next + 'T00:00:00').getTime() : null;
    await busy(form, msg, async () => {
      const r = await call('saveBilling', { ts, expectedNextTs, note: document.getElementById('note').value });
      setMsg(msg, `Saved. Meter energy at ${dateTime(r.saved.ts)}: ${num(r.saved.startEnergy, 3)} kWh.`, true);
      form.reset();
      renderBills((await call('summary')).bills);
    });
  });
}

function renderBills(bills) {
  const table = document.getElementById('bills');
  const sorted = [...bills].sort((a, b) => b.ts - a.ts);
  table.replaceChildren(
    el('tr', {}, el('th', {}, 'Billing time'), el('th', {}, 'Energy at billing'), el('th', {}, 'Expected next'), el('th', {}, 'Note'), el('th', {}, '')),
    ...sorted.map((b, i) => billRow(b, i === 0, sorted.length)));
}

function billRow(b, newest, count) {
  const row = el('tr', {},
    el('td', {}, dateTime(b.ts), newest ? el('div', { class: 'muted-sm' }, 'current cycle starts here') : ''),
    el('td', {}, b.startEnergy == null ? '— (before logger)' : `${num(b.startEnergy, 3)} kWh`),
    el('td', {}, b.expectedNextTs ? dateOnly(b.expectedNextTs) : 'auto'),
    el('td', {}, b.note || ''),
    el('td', { class: 'row-actions' },
      el('button', { class: 'btn btn--small', type: 'button', onclick: () => row.replaceWith(billEditor(b)) }, 'Edit'),
      count > 1 ? el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => deleteBill(b, newest) }, 'Delete') : ''));
  return row;
}

/** The row turned into a small form: time, expected next reading, note. */
function billEditor(b) {
  const time = el('input', { type: 'datetime-local', value: toLocalInput(new Date(b.ts)), max: toLocalInput(new Date()), required: 'required' });
  const next = el('input', { type: 'date', value: b.expectedNextTs ? toLocalInput(new Date(b.expectedNextTs)).slice(0, 10) : '' });
  const note = el('input', { type: 'text', maxlength: '200', value: b.note || '' });
  const msg = document.getElementById('billMsg');
  const save = async () => {
    try {
      const r = await call('updateBilling', {
        ts: b.ts, newTs: new Date(time.value).getTime(),
        expectedNextTs: next.value ? new Date(next.value + 'T00:00:00').getTime() : null,
        note: note.value,
      });
      renderBills((await call('summary')).bills);
      setMsg(msg, `Saved: ${r.details}.`, true);
      loadActivity();
    } catch (err) { setMsg(msg, err.message, false); }
  };
  return el('tr', { class: 'editing' },
    el('td', {}, time, el('div', { class: 'muted-sm' }, 'A new time looks up the energy again')),
    el('td', { class: 'muted' }, 'from the logger'),
    el('td', {}, next),
    el('td', {}, note),
    el('td', { class: 'row-actions' },
      el('button', { class: 'btn btn--small', type: 'button', onclick: save }, 'Save'),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: async () => renderBills((await call('summary')).bills) }, 'Cancel')));
}

async function deleteBill(b, newest) {
  const effect = newest ? 'The reading before it becomes the start of the current cycle.' : 'The cycles before and after it become one cycle.';
  if (!confirm(`Delete the billing of ${dateTime(b.ts)}? ${effect}`)) return;
  const msg = document.getElementById('billMsg');
  try {
    await call('deleteBilling', { ts: b.ts });
    renderBills((await call('summary')).bills);
    setMsg(msg, `Deleted the billing of ${dateTime(b.ts)}.`, true);
    loadActivity();
  } catch (err) {
    setMsg(msg, err.message, false);
  }
}

async function loadUsers() {
  try {
    renderUsers((await call('listUsers')).users);
  } catch (err) {
    setMsg(document.getElementById('userMsg'), err.message, false);
  }
}

// Pages a viewer can be given (Summary is always on); same keys as the server (Access.gs)
const PAGES = { past: 'Past cycles', breakdown: 'Bill breakdown', documents: 'Bill documents', health: 'Service health' };
const PRESETS = { summary: [], noDocs: ['past', 'breakdown', 'health'], all: Object.keys(PAGES) };

function renderUsers(users) {
  renderRequests(users);
  document.getElementById('users').replaceChildren(
    el('tr', {}, el('th', {}, 'Person'), el('th', {}, 'Role'), el('th', {}, 'Pages they can open'), el('th', {}, '')),
    ...users.map(u => {
      const mine = u.email === me;
      const status = u.status === 'invited'
        ? el('span', { class: 'tag tag--request' }, 'Invited – not signed in yet')
        : el('span', { class: 'muted-sm' }, `last seen ${dateTime(u.LastSeen)}`);
      return el('tr', {},
        el('td', {}, el('div', {}, u.Email), status),
        el('td', {}, u.role),
        el('td', {}, u.role === 'admin' ? el('span', { class: 'muted' }, 'All pages (admin)') : pageTicks(u)),
        el('td', { class: 'row-actions' }, mine ? '(you)' : [
          el('button', { class: 'btn btn--small', type: 'button', onclick: () => copyInvite(u.Email) }, 'Copy invite'),
          el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => removeUser(u.Email) }, 'Remove'),
        ]));
    }));
  const pick = document.getElementById('actEmail');
  const chosen = pick.value;
  pick.replaceChildren(el('option', { value: '' }, 'Everyone'),
    ...users.map(u => el('option', { value: String(u.Email).toLowerCase() }, u.Email)));
  pick.value = chosen;
}

/** Tick boxes for a viewer's pages, saved on change, plus quick presets. */
function pageTicks(u) {
  const boxes = Object.keys(PAGES).map(p => el('input', { type: 'checkbox', value: p, checked: u.pages.includes(p) ? 'checked' : null }));
  const save = async pages => {
    const msg = document.getElementById('userMsg');
    try {
      const r = await call('setPages', { email: u.email, pages });
      renderUsers(r.users);
      setMsg(msg, `${u.email}: ${r.details}`, true);
      loadActivity();
    } catch (err) {
      setMsg(msg, err.message, false);
      renderUsers((await call('listUsers')).users);
    }
  };
  boxes.forEach(b => b.addEventListener('change', () => save(boxes.filter(x => x.checked).map(x => x.value))));
  const preset = el('select', { class: 'preset', 'aria-label': `Preset for ${u.email}`, onchange: e => { if (e.target.value) save(PRESETS[e.target.value]); } },
    el('option', { value: '' }, 'Preset…'), el('option', { value: 'summary' }, 'Summary only'),
    el('option', { value: 'noDocs' }, 'All except bill documents'), el('option', { value: 'all' }, 'Everything'));
  return el('div', { class: 'ticks' },
    el('label', { class: 'tick tick--fixed' }, el('input', { type: 'checkbox', checked: 'checked', disabled: 'disabled' }), 'Summary'),
    ...Object.keys(PAGES).map((p, i) => el('label', { class: 'tick' }, boxes[i], PAGES[p])),
    preset);
}

/** Open access requests, with Approve / Decline. */
function renderRequests(users) {
  const open = users.flatMap(u => (u.requests || []).map(p => ({ email: u.email, page: p })));
  document.getElementById('usersTitle').textContent = open.length ? `Who can view · ${open.length} access request${open.length > 1 ? 's' : ''}` : 'Who can view';
  document.getElementById('requests').replaceChildren(...open.map(r => el('div', { class: 'request' },
    el('span', {}, '🔑 ', el('strong', {}, r.email), ` asks for ${PAGES[r.page] || r.page}`),
    el('span', { class: 'row' },
      el('button', { class: 'btn btn--small', type: 'button', onclick: () => decide(r, true) }, 'Approve'),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => decide(r, false) }, 'Decline')))));
}

async function decide(r, approve) {
  const msg = document.getElementById('userMsg');
  try {
    renderUsers((await call('decideRequest', { email: r.email, page: r.page, approve })).users);
    setMsg(msg, `${approve ? 'Approved' : 'Declined'}: ${PAGES[r.page]} for ${r.email}.`, true);
    loadActivity();
  } catch (err) { setMsg(msg, err.message, false); }
}

/** Puts a ready invite message on the clipboard (paste it into WhatsApp); no email is sent. */
async function copyInvite(email) {
  const url = location.origin + location.pathname.replace(/admin\.html$/, '');
  const text = `Hi! I have added you to Power Plan, our home electricity dashboard. Open ${url} and sign in with your Google account (${email}).`;
  const msg = document.getElementById('userMsg');
  try {
    await navigator.clipboard.writeText(text);
    setMsg(msg, 'Invite copied – paste it into WhatsApp or a message.', true);
  } catch {
    window.prompt('Copy this invite:', text);
  }
}

function setupUserForm() {
  const form = document.getElementById('userForm');
  const msg = document.getElementById('userMsg');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    await busy(form, msg, async () => {
      const r = await call('saveUser', { email: document.getElementById('userEmail').value, role: document.getElementById('userRole').value });
      renderUsers(r.users);
      setMsg(msg, 'Saved.', true);
      form.reset();
    });
  });
}

async function removeUser(email) {
  if (!confirm(`Remove ${email}? They will no longer be able to open the app.`)) return;
  const msg = document.getElementById('userMsg');
  try {
    renderUsers((await call('removeUser', { email })).users);
    setMsg(msg, 'Removed.', true);
  } catch (err) {
    setMsg(msg, err.message, false);
  }
}

// ---------- Telegram ----------

function setupTelegram() {
  const form = document.getElementById('tgForm');
  const msg = document.getElementById('tgMsg');
  const token = document.getElementById('tgToken');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    await busy(form, msg, async () => {
      const r = await call('saveTelegram', { token: token.value.trim(), chatId: document.getElementById('tgChat').value.trim() });
      token.value = '';
      renderTelegram(r);
      setMsg(msg, 'Saved. Use "Send test" to check a message arrives.', true);
      loadActivity();
    });
  });
  document.getElementById('tgTest').addEventListener('click', async () => {
    setMsg(msg, 'Sending…', true);
    try {
      const { delivery } = await call('testTelegram');
      setMsg(msg, delivery === 'sent' ? 'Test message sent – check the chat.' : `Telegram did not deliver it: ${delivery}`, delivery === 'sent');
      loadAlerts();
      loadActivity();
    } catch (err) { setMsg(msg, err.message, false); }
  });
  document.getElementById('tgRemove').addEventListener('click', async () => {
    if (!confirm('Stop sending alerts to Telegram? They will only be listed on this page.')) return;
    try {
      renderTelegram(await call('removeTelegram'));
      setMsg(msg, 'Removed.', true);
      loadActivity();
    } catch (err) { setMsg(msg, err.message, false); }
  });
  call('getTelegram').then(renderTelegram).catch(err => setMsg(msg, err.message, false));
}

function renderTelegram(s) {
  setMsg(document.getElementById('tgStatus'), s.configured
    ? `Connected: alerts go to chat ${s.chatId} through ${s.botName || 'the bot'}.`
    : 'Not set up: alerts are only listed in the Alerts section below.', s.configured);
  document.getElementById('tgChat').value = s.chatId || '';
  const token = document.getElementById('tgToken');
  token.required = !s.tokenSet;
  token.placeholder = s.tokenSet ? 'Saved – leave empty to keep it' : '123456789:ABC…';
  document.getElementById('tgTest').disabled = !s.configured;
  document.getElementById('tgRemove').disabled = !s.tokenSet && !s.chatId;
}

// ---------- alerts ----------

const ALERT_STATE = { open: 'Alert', reminder: 'Reminder', closed: 'Back', test: 'Test' };

function setupAlerts() {
  const form = document.getElementById('alertForm');
  const msg = document.getElementById('alertMsg');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    await busy(form, msg, async () => {
      const r = await call('saveAlertSettings', {
        alertMinutes: Number(document.getElementById('alertAfter').value),
        remindMinutes: Number(document.getElementById('alertRemind').value),
      });
      renderAlerts(r);
      setMsg(msg, 'Saved. The next check uses the new settings.', true);
      loadActivity();
    });
  });
  loadAlerts();
}

async function loadAlerts() {
  try {
    renderAlerts(await call('getAlertSettings'));
  } catch (err) {
    setMsg(document.getElementById('alertMsg'), err.message, false);
  }
}

function renderAlerts(s) {
  document.getElementById('alertAfter').value = s.alertMinutes;
  document.getElementById('alertRemind').value = s.remindMinutes;
  const w = s.week;
  const perDay = (w.alerts + w.reminders + w.back) / 7;
  setMsg(document.getElementById('alertStatus'),
    `${s.downSince ? `⚠️ No logger data since ${dateTime(s.downSince)}. ` : ''}Last 7 days: ${w.alerts} alerts, ${w.reminders} reminders, ${w.back} "back" messages – about ${num(perDay, 1)} messages a day.${s.telegram ? '' : ' Telegram is not set up, so they are only listed here.'}`,
    !s.downSince);
  document.getElementById('alertNote').textContent = s.alertMinutes < s.watchMinutes
    ? `Data is checked every ${s.watchMinutes} min here, so an alert can come up to ${s.watchMinutes} min later than set.`
    : `Data is checked every ${s.watchMinutes} min.`;
  const table = document.getElementById('alerts');
  if (!s.recent.length) return table.replaceChildren(el('tr', {}, el('td', { class: 'muted' }, 'No alerts sent yet.')));
  table.replaceChildren(
    el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Type'), el('th', {}, 'Message'), el('th', {}, 'Telegram')),
    ...s.recent.map(a => el('tr', {},
      el('td', {}, dateTime(a.ts)),
      el('td', {}, el('span', { class: `tag ${a.state === 'closed' ? 'tag--sign-in' : a.state === 'test' ? 'tag--view' : 'tag--denied'}` }, ALERT_STATE[a.state] || a.state)),
      el('td', {}, a.message),
      el('td', {}, a.delivery),
    )));
}

// ---------- data corrections ----------

function setupCorrections() {
  const form = document.getElementById('corrForm');
  const msg = document.getElementById('corrMsg');
  const kind = document.getElementById('corrKind');
  const showFields = () => {
    const adjust = kind.value === 'adjust';
    document.getElementById('corrValueBox').hidden = !adjust;
    document.getElementById('corrValue').required = adjust;
    document.getElementById('corrTo').required = !adjust;
    document.getElementById('corrToHint').textContent = adjust ? '(optional – units are spread From → To; empty = all at From)' : '(required)';
    document.getElementById('corrTip').hidden = !adjust;
  };
  kind.addEventListener('change', showFields);
  showFields();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const to = document.getElementById('corrTo').value;
    await busy(form, msg, async () => {
      const r = await call('saveCorrection', {
        kind: kind.value,
        from: new Date(document.getElementById('corrFrom').value).getTime(),
        to: to ? new Date(to).getTime() : null,
        value: Number(document.getElementById('corrValue').value),
        reason: document.getElementById('corrReason').value,
      });
      renderCorrections(r.corrections);
      setMsg(msg, 'Added. The Activity log shows its effect on this cycle.', true);
      form.reset();
      showFields();
      loadActivity();
    });
  });
  loadCorrections();
}

async function loadCorrections() {
  try {
    renderCorrections((await call('listCorrections')).corrections);
  } catch (err) {
    setMsg(document.getElementById('corrMsg'), err.message, false);
  }
}

/** Where a correction's units land, cycle by cycle (a spread over a meter reading is split). */
function effectText(c) {
  if (c.kind !== 'adjust') return el('span', { class: 'muted-sm' }, 'no units moved (the meter still counted them)');
  if (!c.effects || !c.effects.length) return el('span', { class: 'muted-sm' }, 'outside all bill cycles');
  const span = e => e.current ? 'current cycle' : `${dateOnly(e.start)} → ${dateOnly(e.end)}`;
  return el('div', {}, ...c.effects.map(e => el('div', { class: 'muted-sm' }, `${span(e)}: ${e.kwh > 0 ? '+' : '−'}${num(Math.abs(e.kwh), 2)} kWh`)));
}

function renderCorrections(list) {
  const table = document.getElementById('corrections');
  if (!list.length) return table.replaceChildren(el('tr', {}, el('td', { class: 'muted' }, 'No corrections – all logger data is used as recorded.')));
  table.replaceChildren(
    el('tr', {}, el('th', {}, 'What'), el('th', {}, 'Period'), el('th', {}, 'Effect per bill cycle'), el('th', {}, 'Reason'), el('th', {}, 'By'), el('th', {}, 'Status'), el('th', {}, '')),
    ...[...list].reverse().map(c => el('tr', {},
      el('td', {}, c.kind === 'adjust' ? `${c.value > 0 ? '+' : ''}${num(c.value, 3)} units` : 'Ignore readings'),
      el('td', {}, c.to ? `${dateTime(c.from)} – ${dateTime(c.to)}` : `from ${dateTime(c.from)}`),
      el('td', {}, effectText(c)),
      el('td', {}, c.reason),
      el('td', {}, c.createdBy),
      el('td', {}, el('span', { class: `tag ${c.active ? 'tag--change' : 'tag--sign-out'}` }, c.active ? 'On' : 'Off')),
      el('td', { class: 'row-actions' },
        el('button', { class: 'btn btn--small', type: 'button', onclick: e => e.target.closest('tr').replaceWith(correctionEditor(c)) }, 'Edit'),
        el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => toggleCorrection(c) }, c.active ? 'Turn off' : 'Turn on')),
    )));
}

/** The correction row as a small form: From, To, kWh (add/subtract only) and reason. */
function correctionEditor(c) {
  const adjust = c.kind === 'adjust';
  const from = el('input', { type: 'datetime-local', value: toLocalInput(new Date(c.from)), required: 'required' });
  const to = el('input', { type: 'datetime-local', value: c.to ? toLocalInput(new Date(c.to)) : '' });
  const value = el('input', { type: 'number', step: '0.001', value: String(c.value), required: 'required' });
  const reason = el('input', { type: 'text', maxlength: '200', value: c.reason });
  const msg = document.getElementById('corrMsg');
  const save = async () => {
    try {
      const r = await call('updateCorrection', {
        id: c.id, from: new Date(from.value).getTime(), to: to.value ? new Date(to.value).getTime() : null,
        value: adjust ? Number(value.value) : 0, reason: reason.value,
      });
      renderCorrections(r.corrections);
      setMsg(msg, `Saved: ${r.details}.`, true);
      loadActivity();
    } catch (err) { setMsg(msg, err.message, false); }
  };
  // One cell across the whole row, so the date fields have room
  return el('tr', { class: 'editing' }, el('td', { colspan: '7' },
    el('p', { class: 'muted-sm' }, `Editing ${adjust ? 'add / subtract units' : 'ignore readings'} · ${c.id} · the effect per bill cycle updates after saving`),
    el('div', { class: 'edit-grid' },
      adjust ? el('label', {}, 'kWh (negative to subtract)', value) : '',
      el('label', {}, 'From', from),
      el('label', {}, adjust ? 'To (empty = all at From)' : 'To', to),
      el('label', { class: 'edit-grid__wide' }, 'Reason', reason),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn--small', type: 'button', onclick: save }, 'Save'),
        el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: loadCorrections }, 'Cancel')))));
}

async function toggleCorrection(c) {
  const msg = document.getElementById('corrMsg');
  try {
    renderCorrections((await call('setCorrectionActive', { id: c.id, active: !c.active })).corrections);
    setMsg(msg, c.active ? 'Turned off: the numbers are back to how they were without it.' : 'Turned on.', true);
    loadActivity();
  } catch (err) {
    setMsg(msg, err.message, false);
  }
}

// ---------- activity ----------

const TYPE_LABEL = { 'sign-in': 'Signed in', 'sign-out': 'Signed out', view: 'Opened', change: 'Change', denied: 'Blocked', request: 'Request' };

// Activity period: last 7 days (default) or everything kept (the newest 5,000 entries)
let actDays = 7;

function setupActivity() {
  const periods = [{ days: 7, label: 'Last 7 days' }, { days: 0, label: 'All logs' }];
  const buttons = periods.map(p => el('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(p.days === actDays), onclick: () => {
    actDays = p.days;
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(periods[i].days === actDays)));
    loadActivity();
  } }, p.label));
  document.getElementById('actPeriod').replaceChildren(...buttons);
  const form = document.getElementById('actFilter');
  form.addEventListener('submit', e => { e.preventDefault(); loadActivity(); });
  form.addEventListener('change', loadActivity);
  loadActivity();
}

async function loadActivity() {
  const msg = document.getElementById('actMsg');
  setMsg(msg, 'Loading…', true);
  try {
    const { activity, total } = await call('listActivity', {
      email: document.getElementById('actEmail').value,
      type: document.getElementById('actType').value,
      days: actDays,
    });
    document.getElementById('activity').replaceChildren(
      el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Who'), el('th', {}, 'Type'), el('th', {}, 'What'), el('th', {}, 'Device')),
      ...activity.map(a => el('tr', {},
        el('td', {}, dateTime(a.ts)),
        el('td', {}, a.name ? `${a.name} (${a.email})` : a.email),
        el('td', {}, el('span', { class: `tag tag--${a.type}` }, TYPE_LABEL[a.type] || a.type)),
        el('td', {}, a.event, a.details ? el('div', { class: 'muted-sm' }, a.details) : ''),
        el('td', {}, a.device || ''),
      )));
    const period = actDays ? `in the last ${actDays} days` : 'in all logs';
    setMsg(msg, activity.length
      ? `${total} entries ${period}${total > activity.length ? ` – showing the latest ${activity.length}` : ''}.`
      : `Nothing ${period}.`, true);
  } catch (err) {
    setMsg(msg, err.message, false);
  }
}

async function busy(form, msg, fn) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  setMsg(msg, 'Saving…', true);
  try { await fn(); } catch (err) { setMsg(msg, err.message, false); } finally { btn.disabled = false; }
}

function setMsg(node, text, ok) {
  node.textContent = text;
  node.className = 'msg ' + (ok ? 'msg--ok' : 'msg--error');
}

function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
