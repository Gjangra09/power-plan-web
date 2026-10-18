/**
 * Which pages each person may see. Admins see everything; a viewer sees what the admin ticked in
 * the Users tab's Pages column (comma-separated keys), and always the Summary. The server checks
 * this on every request, so hiding a menu link is never the only protection.
 */

const PAGES = {
  summary: 'Summary',
  past: 'Past cycles',
  breakdown: 'Bill breakdown',
  documents: 'Bill documents',
  health: 'Service health',
};

/** {role, pages} for an email on the Users list, or null. */
function userRecord_(email) {
  const u = readTab_('Users').find(r => String(r.Email).toLowerCase() === email);
  if (!u) return null;
  const role = u.Role === 'admin' ? 'admin' : 'viewer';
  return { role, pages: pagesFor_(role, u.Pages) };
}

/** Page keys from the Pages cell; unknown words are ignored, Summary is always included. */
function pagesFor_(role, cell) {
  if (role === 'admin') return Object.keys(PAGES);
  const ticked = String(cell || '').toLowerCase().split(/[\s,;]+/).filter(p => PAGES[p]);
  return Object.keys(PAGES).filter(p => p === 'summary' || ticked.includes(p));
}

/** An error the request handler turns into "no access to <page>" (403 + need), not a sign-out. */
function noAccess_(page) {
  const e = httpError_(403, `You don't have access to ${PAGES[page]} yet.`);
  e.need = page;
  return e;
}

function requirePage_(user, page) {
  if (!(user.pages || []).includes(page)) throw noAccess_(page);
}

/**
 * A viewer asks the admin for a page. Logged in Activity (type "request") and sent as an alert
 * (Telegram when set up). One request per page per person per day.
 */
function requestAccess_(req, user) {
  const page = String(req.page || '');
  if (!PAGES[page]) throw httpError_(400, 'Unknown page.');
  if ((user.pages || []).includes(page)) throw httpError_(400, `You already have access to ${PAGES[page]}.`);
  const dayAgo = Date.now() - 86400e3;
  const asked = recentActivity_(500).some(a => a.email === user.email && a.type === 'request' && a.ts > dayAgo && a.event === requestEvent_(page));
  if (!asked) notify_('access', 'request', `🔑 ${user.name || user.email} (${user.email}) asks for access to ${PAGES[page]}. Admin → Who can view to approve.`);
  return { page, label: PAGES[page], alreadyAsked: asked };
}

function requestEvent_(page) {
  return `Asked for access to ${PAGES[page]}`;
}

// ---------- Admin → Who can view ----------

/** Ticks a viewer's pages (Summary is always on). Admins always have every page. */
function setPages_(req, user) {
  const email = String(req.email || '').trim().toLowerCase();
  const wanted = (Array.isArray(req.pages) ? req.pages : []).map(String);
  const bad = wanted.filter(p => !PAGES[p]);
  if (bad.length) throw httpError_(400, `Unknown page: ${bad.join(', ')}.`);
  const sh = tab_('Users');
  const rows = sh.getRange(1, 1, sh.getLastRow(), 3).getValues();
  const i = rows.findIndex((r, k) => k > 0 && String(r[0]).toLowerCase() === email);
  if (i < 1) throw httpError_(404, `${email} is not on the list.`);
  if (rows[i][1] === 'admin') throw httpError_(400, 'Admins always see every page.');
  const before = pagesFor_('viewer', rows[i][2]);
  const after = pagesFor_('viewer', wanted.join(','));
  sh.getRange(i + 1, 3).setValue(after.filter(p => p !== 'summary').join(','));
  const label = list => list.map(p => PAGES[p]).join(', ');
  return { users: usersWithLastSeen_(), email, details: `${label(before)} → ${label(after)}` };
}

/** Approves (gives the page) or declines an access request. Either way it leaves the request list. */
function decideRequest_(req, user) {
  const email = String(req.email || '').trim().toLowerCase();
  const page = String(req.page || '');
  if (!PAGES[page]) throw httpError_(400, 'Unknown page.');
  if (req.approve === true) {
    const rec = userRecord_(email);
    if (!rec) throw httpError_(404, `${email} is not on the list any more.`);
    if (rec.role !== 'admin') setPages_({ email, pages: rec.pages.concat([page]) }, user);
  }
  return { users: usersWithLastSeen_(), email, page, approve: req.approve === true };
}

function decisionEvent_(approve, page, email) {
  return `${approve ? 'Approved' : 'Declined'} access to ${PAGES[page]} for ${email}`;
}

/** Open requests: asked (type request) after the last approve/decline of that page for that person, and not granted since. */
function openRequests_(activity, users) {
  const open = {};
  const decided = {};
  activity.forEach(a => {   // newest first
    const m = a.type === 'change' && /^(Approved|Declined) access to (.+) for (\S+)$/.exec(a.event);
    if (m) { const key = m[3] + '|' + m[2]; if (!decided[key]) decided[key] = a.ts; }
  });
  activity.forEach(a => {
    if (a.type !== 'request') return;
    const label = a.event.replace(/^Asked for access to /, '');
    const page = Object.keys(PAGES).find(p => PAGES[p] === label);
    const u = users.find(x => x.email === a.email);
    if (!page || !u || u.pages.includes(page)) return;
    if ((decided[a.email + '|' + label] || 0) >= a.ts) return;
    (open[a.email] = open[a.email] || []).includes(page) || open[a.email].push(page);
  });
  return open;
}

/** How many admins are on the list (for the last-admin guard). */
function adminCount_() {
  return readTab_('Users').filter(r => r.Role === 'admin').length;
}
