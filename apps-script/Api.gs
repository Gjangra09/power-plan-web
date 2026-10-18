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
  listCorrections:     { role: 'admin', fn: () => ({ corrections: corrections_() }) },
  saveCorrection:      { role: 'admin', fn: saveCorrection_ },
  setCorrectionActive: { role: 'admin', fn: setCorrectionActive_ },
  getAlertSettings:    { role: 'admin', fn: alertSettings_ },
  saveAlertSettings:   { role: 'admin', fn: saveAlertSettings_ },
};

// What goes into the Activity tab for each action: [type, event, details (before → after)], or null to skip
const ACTIVITY = {
  login:            () => ['sign-in', 'Signed in'],
  logout:           () => ['sign-out', 'Signed out'],
  summary:          req => (req.page ? ['view', `Opened ${req.page === 'admin' ? 'Admin' : 'Summary'}`] : null),
  saveBilling:      (req, r) => ['change', `Saved billing ${fmt_(r.saved.ts)}`, `start energy ${r.saved.startEnergy} kWh`],
  deleteLatestBill: (req, r) => ['change', `Deleted billing ${fmt_(r.deleted)}`, r.details],
  saveUser:         (req, r) => ['change', `Added/updated ${String(req.email).trim().toLowerCase()} as ${req.role === 'admin' ? 'admin' : 'viewer'}`, r.details],
  removeUser:       (req, r) => ['change', `Removed ${String(req.email).trim().toLowerCase()}`, r.details],
  saveCorrection:      (req, r) => ['change', `Added data correction ${r.saved.id}`, r.details],
  setCorrectionActive: (req, r) => ['change', `Turned data correction ${r.id} ${r.active ? 'on' : 'off'}`, r.details],
  saveAlertSettings:   (req, r) => ['change', 'Changed alert settings', r.details],
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
    if (code === 500) {
      console.error(err);
      logError_('api', err, '', req && req.action);
    }
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

/**
 * The current cycle as the server calculates it (calc): corrections applied, duplicate and
 * out-of-order snapshots removed, short gaps filled, tariff versions in force. The page only
 * displays calc; points and tariff are still sent for older pages.
 */
function summary_(req, user) {
  const now = Date.now();
  const bills = billsSorted_();
  const latest = bills[bills.length - 1] || null;
  const since = latest ? latest.ts - APP.LEAD_HOURS * 3600e3 : now - 7 * 86400e3;
  const raw = hourlyPoints_(since);
  const corrections = corrections_().filter(c => c.active);
  const kept = Quality.cleanPoints(Quality.applyCorrections(raw, corrections));
  const points = Quality.fillGaps(kept);
  const versions = tariffVersions_();
  const out = {
    me: user,
    bills: bills.map(b => ({ ts: b.ts, startEnergy: b.startEnergy, expectedNextTs: b.expectedNextTs, note: b.note })),
    points: points.map(p => ({ ts: p.ts, energy: p.energy })),
    tariff: versions.filter(v => v.from <= now).pop().tariff,
    serverTime: now,
  };
  if (latest && latest.startEnergy != null) {
    const typicalDays = Math.round(Billing.avgCycleDays(bills.map(b => new Date(b.ts))));
    out.typicalDays = typicalDays;
    out.calc = cycleCalc_(latest, points, corrections, versions, now, typicalDays);
    const gaps = Quality.findGaps(kept.filter(p => p.ts >= latest.ts));
    out.quality = Object.assign(Quality.coverage(raw, latest.ts, now), {
      filledGaps: gaps.filter(g => g.kind === 'filled').length,
      outages: gaps.filter(g => g.kind === 'outage').length,
      corrections: corrections.length,
    });
  }
  return out;
}

/** cycleSummary for the cycle that starts at bill, its start energy corrected like the readings. */
function cycleCalc_(bill, points, corrections, versions, now, typicalDays) {
  const start = Quality.applyCorrections([{ ts: bill.ts, energy: bill.startEnergy }], corrections.filter(c => c.kind === 'adjust'))[0].energy;
  return Billing.cycleSummary({
    cycleStart: new Date(bill.ts), startEnergy: start,
    cycleEnd: new Date(bill.expectedNextTs || bill.ts + typicalDays * 86400e3),
    points: points.map(p => ({ ts: new Date(p.ts), energy: p.energy })),
    now: new Date(now),
    tariffs: versions.map(v => ({ from: v.from, tariff: v.tariff })),
  });
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
    addRow_(tab_('Bills'), [ts, fmt_(ts), startEnergy, expectedNext, note, user.email, new Date()]);
  });
  return { saved: { ts, startEnergy, expectedNextTs: expectedNext || null } };
}

function deleteLatestBill_() {
  const sh = tab_('Bills');
  const bills = billsSorted_();
  if (bills.length <= 1) throw httpError_(400, 'Keep at least one bill.');
  const latest = bills[bills.length - 1];
  withLock_(() => sh.deleteRow(latest.row));
  return { deleted: latest.ts, details: `was: start energy ${latest.startEnergy} kWh, note "${latest.note || ''}"` };
}

function saveUser_(req, user) {
  const email = String(req.email || '').trim().toLowerCase();
  const role = req.role === 'admin' ? 'admin' : 'viewer';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError_(400, 'Enter a valid email address.');
  if (email === user.email && role !== 'admin') throw httpError_(400, 'You cannot remove your own admin role.');
  const sh = tab_('Users');
  const rows = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  const i = rows.findIndex((r, k) => k > 0 && String(r[0]).toLowerCase() === email);
  const before = i > 0 ? String(rows[i][1]) : 'no access';
  if (i > 0) sh.getRange(i + 1, 2).setValue(role);
  else addRow_(sh, [email, role, '']);
  return { users: usersWithLastSeen_(), details: `${before} → ${role}` };
}

function removeUser_(req, user) {
  const email = String(req.email || '').trim().toLowerCase();
  if (email === user.email) throw httpError_(400, 'You cannot remove yourself.');
  const sh = tab_('Users');
  const rows = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  const i = rows.findIndex((r, k) => k > 0 && String(r[0]).toLowerCase() === email);
  if (i > 0) sh.deleteRow(i + 1);
  return { users: usersWithLastSeen_(), details: `${i > 0 ? rows[i][1] : 'not listed'} → no access` };
}

// ---------- data corrections ----------

/** Corrections [{id, kind, from, to, value, reason, active, ...}], oldest first. */
function corrections_() {
  return readTab_('Corrections').map(r => ({
    id: String(r.Id), kind: String(r.Kind), from: Number(r.FromMs), to: r.ToMs === '' ? null : Number(r.ToMs),
    value: r.Value === '' ? 0 : Number(r.Value), reason: String(r.Reason),
    active: r.Active === true || String(r.Active).toUpperCase() === 'TRUE',
    createdBy: String(r.CreatedBy), createdAt: r.CreatedAt instanceof Date ? r.CreatedAt.getTime() : null,
  }));
}

/** Adds a correction; the activity log shows what it did to the current cycle (before → after). */
function saveCorrection_(req, user) {
  const kind = req.kind === 'adjust' ? 'adjust' : req.kind === 'exclude' ? 'exclude' : '';
  const from = Number(req.from), to = req.to == null || req.to === '' ? null : Number(req.to);
  const value = kind === 'adjust' ? Number(req.value) : 0;
  const reason = String(req.reason || '').trim().slice(0, 200);
  if (!kind) throw httpError_(400, 'Choose what the correction does: ignore readings or adjust energy.');
  if (!Number.isFinite(from) || from <= 0) throw httpError_(400, 'Enter when the correction starts.');
  if (to !== null && !(to > from)) throw httpError_(400, 'The end must be after the start.');
  if (kind === 'exclude' && to === null) throw httpError_(400, 'Ignoring readings needs an end time.');
  if (kind === 'adjust' && !(Number.isFinite(value) && value !== 0 && Math.abs(value) < 100000)) throw httpError_(400, 'Enter the energy change in kWh (not zero).');
  if (reason.length < 3) throw httpError_(400, 'Write a short reason, so the change can be understood later.');

  const before = currentUnits_();
  const id = 'C' + Utilities.getUuid().slice(0, 8);
  withLock_(() => addRow_(tab_('Corrections'), [id, kind, from, to === null ? '' : to, kind === 'adjust' ? value : '', reason, true, user.email, new Date(), '', '']));
  const after = currentUnits_();
  const what = kind === 'adjust'
    ? `${value > 0 ? '+' : ''}${value} kWh ${to ? `used ${fmt_(from)} – ${fmt_(to)} (spread evenly)` : 'at ' + fmt_(from)}, counted from then on`
    : `readings ${fmt_(from)} – ${fmt_(to)} ignored`;
  return { saved: { id }, corrections: corrections_(), details: `${what} · reason: ${reason} · current cycle ${unitsText_(before)} → ${unitsText_(after)}` };
}

function setCorrectionActive_(req, user) {
  const id = String(req.id || '');
  const active = req.active === true;
  const sh = tab_('Corrections');
  const ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0])) : [];
  const i = ids.indexOf(id);
  if (i < 0) throw httpError_(404, 'That correction does not exist.');
  const before = currentUnits_();
  withLock_(() => {
    sh.getRange(i + 2, 7).setValue(active);
    sh.getRange(i + 2, 10, 1, 2).setValues([[user.email, new Date()]]);
  });
  const after = currentUnits_();
  return { id, active, corrections: corrections_(), details: `${active ? 'off → on' : 'on → off'} · current cycle ${unitsText_(before)} → ${unitsText_(after)}` };
}

/** Units so far in the current cycle (for before → after in the activity log), or null. */
function currentUnits_() {
  const s = summary_({}, {});
  return s.calc ? s.calc.unitsSoFar : null;
}

function unitsText_(u) {
  return u === null ? 'n/a' : `${round_(u, 2)} units`;
}

// ---------- tariff versions ----------

/** Tariff versions [{id, from, tariff}], oldest first; the first one applies from the start. */
function tariffVersions_() {
  if (tab_('TariffVersions').getLastRow() < 2) seedDefaults_();
  const rows = readTab_('TariffVersions')
    .map(r => ({ id: String(r.Id), from: Number(r.EffectiveFromMs) || 0, tariff: Billing.normalizeTariff(JSON.parse(String(r.RatesJson))) }))
    .sort((a, b) => a.from - b.from);
  rows[0].from = -Infinity;
  return rows;
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
    addRow_(sh, [new Date(), user.email, user.name || '', user.role || '', entry[0], entry[1], String(req.client || '').slice(0, 60), String(entry[2] || '').slice(0, 500)]);
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
      type: String(r[4]), event: String(r[5]), device: String(r[6]), details: String(r[7] || ''),
    }))
    .reverse();
}

function activitySheet_() {
  return tab_('Activity');
}

// ---------- helpers ----------

function billsSorted_() {
  const sh = tab_('Bills');
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
  const sh = tab_(name);
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

// JSON has no Infinity (the last slab has no upper limit): send a large number instead of null
function json_(obj) {
  const text = JSON.stringify(obj, (k, v) => (v === Infinity ? 1e9 : v === -Infinity ? -1e9 : v));
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}
