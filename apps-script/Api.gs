/**
 * JSON API for the GitHub Pages frontend.
 *
 * The frontend POSTs text/plain JSON {action, token, ...}. `token` is a Google Sign-In ID token;
 * it is verified with Google and the email must be listed in the Users tab.
 * Roles: viewer (read) and admin (read + write).
 */

const ACTIONS = {
  me:            { role: 'viewer', fn: (req, user) => ({ me: user }) },
  summary:       { role: 'viewer', fn: summary_ },
  saveBilling:   { role: 'admin',  fn: saveBilling_ },
  deleteLatestBill: { role: 'admin', fn: deleteLatestBill_ },
  listUsers:     { role: 'admin',  fn: () => ({ users: readTab_('Users') }) },
  saveUser:      { role: 'admin',  fn: saveUser_ },
  removeUser:    { role: 'admin',  fn: removeUser_ },
};

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 400, error: 'Bad request' });
  }
  try {
    const action = ACTIONS[req.action];
    if (!action) return json_({ ok: false, code: 400, error: 'Unknown action' });
    const email = verifyToken_(req.token);
    const role = roleOf_(email);
    if (!role) return json_({ ok: false, code: 403, error: `${email} is not allowed. Ask the admin to add you.` });
    if (action.role === 'admin' && role !== 'admin') return json_({ ok: false, code: 403, error: 'Admin only' });
    const result = action.fn(req, { email, role });
    return json_(Object.assign({ ok: true }, result));
  } catch (err) {
    const code = err.code || 500;
    if (code === 500) console.error(err);
    return json_({ ok: false, code, error: code === 500 ? 'Server error' : err.message });
  }
}

function doGet() {
  return json_({ ok: true, service: 'power-plan', time: new Date().toISOString() });
}

// ---------- actions ----------

function summary_(req, user) {
  const bills = billsSorted_();
  const latest = bills[bills.length - 1] || null;
  const since = latest ? latest.ts - APP.LEAD_HOURS * 3600e3 : Date.now() - 7 * 86400e3;
  const points = hourlyPoints_(since);
  const tariff = configValue_('tariff');
  return {
    me: user,
    bills: bills.map(b => ({ ts: b.ts, startEnergy: b.startEnergy, expectedNextTs: b.expectedNextTs, note: b.note })),
    points,
    tariff: tariff ? JSON.parse(tariff) : null,
    serverTime: Date.now(),
  };
}

function saveBilling_(req, user) {
  const ts = Number(req.ts);
  if (!Number.isFinite(ts) || ts > Date.now() + 5 * 60e3) throw httpError_(400, 'Billing time must be a valid time, not in the future.');
  const bills = billsSorted_();
  const prev = bills[bills.length - 1];
  if (prev && ts <= prev.ts) throw httpError_(400, `Billing time must be after the previous bill (${fmt_(prev.ts)}).`);
  const expectedNext = req.expectedNextTs ? Number(req.expectedNextTs) : '';
  if (expectedNext !== '' && !(expectedNext > ts)) throw httpError_(400, 'Expected next reading must be after the billing time.');

  const startEnergy = energyAt_(ts, hourlyPoints_(ts - 3 * 3600e3));
  if (startEnergy === '') throw httpError_(400, 'No logger readings around that time, so the starting meter energy cannot be found.');
  const note = String(req.note || '').slice(0, 200);
  withLock_(() => {
    appSheet_().getSheetByName('Bills').appendRow([ts, fmt_(ts), startEnergy, expectedNext, note, user.email, new Date()]);
  });
  return { saved: { ts, startEnergy, expectedNextTs: expectedNext || null } };
}

function deleteLatestBill_() {
  const sh = appSheet_().getSheetByName('Bills');
  const bills = billsSorted_();
  if (bills.length <= 1) throw httpError_(400, 'Keep at least one bill.');
  const latest = bills[bills.length - 1];
  withLock_(() => sh.deleteRow(latest.row));
  return { deleted: latest.ts };
}

function saveUser_(req, user) {
  const email = String(req.email || '').trim().toLowerCase();
  const role = req.role === 'admin' ? 'admin' : 'viewer';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError_(400, 'Enter a valid email address.');
  if (email === user.email && role !== 'admin') throw httpError_(400, 'You cannot remove your own admin role.');
  const sh = appSheet_().getSheetByName('Users');
  const rows = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  const i = rows.findIndex((r, k) => k > 0 && String(r[0]).toLowerCase() === email);
  if (i > 0) sh.getRange(i + 1, 2).setValue(role);
  else sh.appendRow([email, role]);
  return { users: readTab_('Users') };
}

function removeUser_(req, user) {
  const email = String(req.email || '').trim().toLowerCase();
  if (email === user.email) throw httpError_(400, 'You cannot remove yourself.');
  const sh = appSheet_().getSheetByName('Users');
  const rows = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  const i = rows.findIndex((r, k) => k > 0 && String(r[0]).toLowerCase() === email);
  if (i > 0) sh.deleteRow(i + 1);
  return { users: readTab_('Users') };
}

// ---------- auth ----------

function verifyToken_(token) {
  if (!token || typeof token !== 'string') throw httpError_(401, 'Please sign in.');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  const key = 'tok_' + Utilities.base64EncodeWebSafe(digest);
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) return hit;

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw httpError_(401, 'Sign-in expired. Please sign in again.');
  const info = JSON.parse(res.getContentText());
  const expMs = Number(info.exp) * 1000;
  const issOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (info.aud !== APP.GOOGLE_CLIENT_ID || !issOk || String(info.email_verified) !== 'true' || !(expMs > Date.now())) {
    throw httpError_(401, 'Sign-in could not be verified. Please sign in again.');
  }
  const email = String(info.email).toLowerCase();
  cache.put(key, email, Math.max(1, Math.min(300, Math.floor((expMs - Date.now()) / 1000))));
  return email;
}

function roleOf_(email) {
  const u = readTab_('Users').find(r => String(r.Email).toLowerCase() === email);
  return u ? (u.Role === 'admin' ? 'admin' : 'viewer') : null;
}

// ---------- helpers ----------

function billsSorted_() {
  const sh = appSheet_().getSheetByName('Bills');
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, TABS.Bills.length).getValues()
    .map((r, i) => ({
      row: i + 2, ts: Number(r[0]),
      startEnergy: r[2] === '' ? null : Number(r[2]),
      expectedNextTs: r[3] === '' ? null : Number(r[3]),
      note: r[4],
    }))
    .filter(b => Number.isFinite(b.ts) && b.ts > 0)
    .sort((a, b) => a.ts - b.ts);
}

function readTab_(name) {
  const sh = appSheet_().getSheetByName(name);
  const values = sh.getDataRange().getValues();
  const head = values.shift();
  return values.filter(r => r[0] !== '').map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function configValue_(key) {
  const row = readTab_('Config').find(r => r.Key === key);
  return row ? String(row.Value) : null;
}

function httpError_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
