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
