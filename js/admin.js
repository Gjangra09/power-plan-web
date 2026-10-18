// Admin page: billing date/time, billing history, viewers.
import { boot, el, num, dateTime, dateOnly, showError } from './ui.js';
import { call } from './api.js';

boot().then(data => {
  if (data.me.role !== 'admin') {
    document.getElementById('main').hidden = true;
    return showError('Only admins can open this page.');
  }
  renderBills(data.bills);
  loadUsers();
  setupBillForm();
  setupUserForm();
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
  const me = document.getElementById('who').textContent.toLowerCase();
  document.getElementById('users').replaceChildren(
    el('tr', {}, el('th', {}, 'Email'), el('th', {}, 'Role'), el('th', {}, '')),
    ...users.map(u => el('tr', {},
      el('td', {}, u.Email),
      el('td', {}, u.Role),
      el('td', {}, String(u.Email).toLowerCase() === me ? '(you)' : el('button', { class: 'btn btn--ghost', onclick: () => removeUser(u.Email) }, 'Remove')),
    )));
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
