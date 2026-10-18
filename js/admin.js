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
    ...sorted.map((b, i) => el('tr', {},
      el('td', {}, dateTime(b.ts)),
      el('td', {}, b.startEnergy == null ? '— (before logger)' : `${num(b.startEnergy, 3)} kWh`),
      el('td', {}, b.expectedNextTs ? dateOnly(b.expectedNextTs) : 'auto'),
      el('td', {}, b.note || ''),
      el('td', {}, i === 0 && sorted.length > 1
        ? el('button', { class: 'btn btn--ghost', onclick: () => deleteLatest(b) }, 'Delete')
        : ''),
    )));
}

async function deleteLatest(b) {
  if (!confirm(`Delete the billing of ${dateTime(b.ts)}? The previous billing becomes the current cycle.`)) return;
  const msg = document.getElementById('billMsg');
  try {
    await call('deleteLatestBill');
    renderBills((await call('summary')).bills);
    setMsg(msg, 'Deleted.', true);
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

function renderUsers(users) {
  document.getElementById('users').replaceChildren(
    el('tr', {}, el('th', {}, 'Email'), el('th', {}, 'Role'), el('th', {}, 'Last seen'), el('th', {}, '')),
    ...users.map(u => el('tr', {},
      el('td', {}, u.Email),
      el('td', {}, u.Role),
      el('td', {}, u.LastSeen ? dateTime(u.LastSeen) : 'never'),
      el('td', {}, String(u.Email).toLowerCase() === me ? '(you)' : el('button', { class: 'btn btn--ghost', onclick: () => removeUser(u.Email) }, 'Remove')),
    )));
  const pick = document.getElementById('actEmail');
  const chosen = pick.value;
  pick.replaceChildren(el('option', { value: '' }, 'Everyone'),
    ...users.map(u => el('option', { value: String(u.Email).toLowerCase() }, u.Email)));
  pick.value = chosen;
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

function renderCorrections(list) {
  const table = document.getElementById('corrections');
  if (!list.length) return table.replaceChildren(el('tr', {}, el('td', { class: 'muted' }, 'No corrections – all logger data is used as recorded.')));
  table.replaceChildren(
    el('tr', {}, el('th', {}, 'What'), el('th', {}, 'Period'), el('th', {}, 'Reason'), el('th', {}, 'By'), el('th', {}, 'Status'), el('th', {}, '')),
    ...[...list].reverse().map(c => el('tr', {},
      el('td', {}, c.kind === 'adjust' ? `${c.value > 0 ? '+' : ''}${num(c.value, 3)} units` : 'Ignore readings'),
      el('td', {}, c.to ? `${dateTime(c.from)} – ${dateTime(c.to)}` : `from ${dateTime(c.from)}`),
      el('td', {}, c.reason),
      el('td', {}, c.createdBy),
      el('td', {}, el('span', { class: `tag ${c.active ? 'tag--change' : 'tag--sign-out'}` }, c.active ? 'On' : 'Off')),
      el('td', {}, el('button', { class: 'btn btn--ghost', onclick: () => toggleCorrection(c) }, c.active ? 'Turn off' : 'Turn on')),
    )));
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

const TYPE_LABEL = { 'sign-in': 'Signed in', 'sign-out': 'Signed out', view: 'Opened', change: 'Change', denied: 'Blocked' };

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
