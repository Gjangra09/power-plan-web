/**
 * JSON API for the GitHub Pages frontend.
 *
 * The frontend POSTs text/plain JSON {action, session | token, ...}.
 * - `login` takes a Google Sign-In ID token (`token`), verified with Google, and returns an app
 *   session signed by this script, valid APP.SESSION_DAYS and renewed while the app is used
 *   (Google ID tokens expire after an hour).
 * - Every other action takes that `session` (a Google `token` is still accepted).
 * The email must be listed in the Users tab on every request, so removing someone takes effect
 * at once. Roles: viewer (read) and admin (read + write). Sign-ins, page opens, changes and
 * refused attempts are written to the Activity tab.
 */

const ACTIONS = {
  login:         { role: 'viewer', fn: login_ },
  logout:        { role: 'viewer', fn: () => ({}) },
  me:            { role: 'viewer', fn: (req, user) => ({ me: user }) },
  summary:       { role: 'viewer', fn: summary_ },
  saveBilling:   { role: 'admin',  fn: saveBilling_ },
  deleteLatestBill: { role: 'admin', fn: deleteLatestBill_ },
  listUsers:     { role: 'admin',  fn: () => ({ users: usersWithLastSeen_() }) },
  saveUser:      { role: 'admin',  fn: saveUser_ },
  removeUser:    { role: 'admin',  fn: removeUser_ },
  listActivity:  { role: 'admin',  fn: listActivity_ },
};

// What goes into the Activity tab for each action: [type, event], or null to skip
const ACTIVITY = {
  login:            () => ['sign-in', 'Signed in'],
  logout:           () => ['sign-out', 'Signed out'],
  summary:          req => (req.page ? ['view', `Opened ${req.page === 'admin' ? 'Admin' : 'Summary'}`] : null),
  saveBilling:      (req, r) => ['change', `Saved billing ${fmt_(r.saved.ts)}`],
  deleteLatestBill: (req, r) => ['change', `Deleted billing ${fmt_(r.deleted)}`],
  saveUser:         req => ['change', `Added/updated ${String(req.email).trim().toLowerCase()} as ${req.role === 'admin' ? 'admin' : 'viewer'}`],
  removeUser:       req => ['change', `Removed ${String(req.email).trim().toLowerCase()}`],
};

const SESSION_RENEW_MS = 15 * 86400e3; // renew when less than this is left

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
    const who = req.action === 'login' ? verifyToken_(req.token) : authenticate_(req);
    const role = roleOf_(who.email);
    const user = { email: who.email, name: who.name || '', picture: who.picture || '', role: role || '' };
    if (!role) {
      logActivity_(user, req, ['denied', 'Not on the users list']);
      return json_({ ok: false, code: 403, error: `${who.email} is not allowed. Ask the admin to add you.` });
    }
    if (action.role === 'admin' && role !== 'admin') {
      logActivity_(user, req, ['denied', `Tried admin action "${req.action}"`]);
      return json_({ ok: false, code: 403, error: 'Admin only' });
    }
    const result = action.fn(req, user, who);
    const entry = ACTIVITY[req.action] && ACTIVITY[req.action](req, result);
    if (entry) logActivity_(user, req, entry);
    const out = Object.assign({ ok: true }, result);
    if (who.via === 'session' && who.exp - Date.now() < SESSION_RENEW_MS) Object.assign(out, issueSession_(who));
    return json_(out);
  } catch (err) {
    const code = err.code || 500;
    if (code === 500) console.error(err);
    return json_({ ok: false, code, error: code === 500 ? 'Server error' : err.message });
  }
}

/**
 * Run from the editor to check the sign-in verification. A fake token must log code=401;
 * anything else is the real error. Running it also prompts for any missing permission.
 */
function selfTest() {
  try {
    verifyToken_('abc.def.ghi');
    Logger.log('Unexpected: fake token accepted');
  } catch (e) {
    Logger.log(`code=${e.code || 500} message=${e.message}`);
  }
}

function doGet() {
  return json_({ ok: true, service: 'power-plan', env: APP.ENV, time: new Date().toISOString() });
}

// ---------- actions ----------

function login_(req, user, who) {
  return Object.assign({ me: user }, issueSession_(who));
}

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
  return { users: usersWithLastSeen_() };
}

function removeUser_(req, user) {
  const email = String(req.email || '').trim().toLowerCase();
  if (email === user.email) throw httpError_(400, 'You cannot remove yourself.');
  const sh = appSheet_().getSheetByName('Users');
  const rows = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  const i = rows.findIndex((r, k) => k > 0 && String(r[0]).toLowerCase() === email);
  if (i > 0) sh.deleteRow(i + 1);
  return { users: usersWithLastSeen_() };
}

/** Newest activity first, optionally for one email and/or one type. */
function listActivity_(req) {
  const email = String(req.email || '').toLowerCase();
  const type = String(req.type || '');
  const rows = recentActivity_(3000)
    .filter(a => (!email || a.email === email) && (!type || a.type === type))
    .slice(0, Math.min(Number(req.limit) || 300, 1000));
  return { activity: rows };
}

function usersWithLastSeen_() {
  const lastSeen = {};
  recentActivity_(3000).forEach(a => { if (a.type !== 'denied' && !lastSeen[a.email]) lastSeen[a.email] = a.ts; });
  return readTab_('Users').map(u => Object.assign({}, u, { LastSeen: lastSeen[String(u.Email).toLowerCase()] || null }));
}

// ---------- auth ----------

/** Who is calling: an app session, or (older frontends) a Google ID token. */
function authenticate_(req) {
  if (req.session) return verifySession_(req.session);
  return verifyToken_(req.token);
}

/** Google ID token → {email, name, picture}. Verified with Google, cached 5 min. */
function verifyToken_(token) {
  if (!token || typeof token !== 'string') throw httpError_(401, 'Please sign in.');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  const key = 'tok_' + Utilities.base64EncodeWebSafe(digest);
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { return { email: hit, via: 'google' }; }
  }

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw httpError_(401, 'Sign-in expired. Please sign in again.');
  const info = JSON.parse(res.getContentText());
  const expMs = Number(info.exp) * 1000;
  const issOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (info.aud !== APP.GOOGLE_CLIENT_ID || !issOk || String(info.email_verified) !== 'true' || !(expMs > Date.now())) {
    throw httpError_(401, 'Sign-in could not be verified. Please sign in again.');
  }
  const who = { email: String(info.email).toLowerCase(), name: String(info.name || ''), picture: String(info.picture || ''), via: 'google' };
  cache.put(key, JSON.stringify(who), Math.max(1, Math.min(300, Math.floor((expMs - Date.now()) / 1000))));
  return who;
}

/** Signs {email, name, picture, exp} with this project's secret. */
function issueSession_(who) {
  const exp = Date.now() + APP.SESSION_DAYS * 86400e3;
  const body = Utilities.base64EncodeWebSafe(JSON.stringify({ e: who.email, n: who.name || '', p: who.picture || '', exp }), Utilities.Charset.UTF_8);
  return { session: body + '.' + sign_(body), sessionExp: exp };
}

function verifySession_(session) {
  const parts = String(session).split('.');
  if (parts.length !== 2 || parts[1] !== sign_(parts[0])) throw httpError_(401, 'Please sign in again.');
  const p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString('UTF-8'));
  if (!(p.exp > Date.now())) throw httpError_(401, 'Your sign-in has ended. Please sign in again.');
  return { email: String(p.e).toLowerCase(), name: p.n, picture: p.p, exp: p.exp, via: 'session' };
}

function sign_(body) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, sessionSecret_()));
}

/** Per-project random secret, created on first use. Delete the property to sign everyone out. */
function sessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function roleOf_(email) {
  const u = readTab_('Users').find(r => String(r.Email).toLowerCase() === email);
  return u ? (u.Role === 'admin' ? 'admin' : 'viewer') : null;
}

// ---------- activity log ----------

/** Appends one row; never lets a logging problem break the request. */
function logActivity_(user, req, entry) {
  try {
    const sh = activitySheet_();
    sh.appendRow([new Date(), user.email, user.name || '', user.role || '', entry[0], entry[1], String(req.client || '').slice(0, 60)]);
    if (sh.getLastRow() > APP.ACTIVITY_MAX_ROWS + 500) sh.deleteRows(2, 500);
  } catch (err) {
    console.error('Activity log failed: ' + err);
  }
}

/** Newest first: [{ts, email, name, role, type, event, device}] from the last n rows. */
function recentActivity_(n) {
  const sh = activitySheet_();
  const count = Math.min(n, sh.getLastRow() - 1);
  if (count < 1) return [];
  return sh.getRange(sh.getLastRow() - count + 1, 1, count, TABS.Activity.length).getValues()
    .map(r => ({
      ts: r[0] instanceof Date ? r[0].getTime() : Number(r[0]),
      email: String(r[1]).toLowerCase(), name: String(r[2]), role: String(r[3]),
      type: String(r[4]), event: String(r[5]), device: String(r[6]),
    }))
    .reverse();
}

function activitySheet_() {
  const ss = appSheet_();
  let sh = ss.getSheetByName('Activity');
  if (!sh) {
    sh = ss.insertSheet('Activity');
    sh.appendRow(TABS.Activity);
    sh.setFrozenRows(1);
  }
  return sh;
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
