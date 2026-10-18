// Shared page chrome and formatting.
import { signIn, signOut, clearSession, currentSession, call, isDemo } from './api.js';
import { CONFIG } from './config.js';
import { withCycle } from './cycle.js';

// UAT pages carry a ribbon and a title prefix so a test version is never mistaken for prod
if (CONFIG.env === 'uat') {
  document.title = 'UAT · ' + document.title;
  document.body.classList.add('env-uat');
  document.querySelector('.brand')?.after(el('span', { class: 'env-badge', title: 'Test version – changes here do not affect the live app' }, 'UAT'));
}

export const inr = x => '₹' + Math.round(x).toLocaleString('en-IN');
export const num = (x, d = 1) => Number(x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
export const dateTime = ms => new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
export const dateOnly = ms => new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
export const shortDate = key => new Date(key + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  });
  children.flat().forEach(c => node.append(c instanceof Node ? c : document.createTextNode(String(c))));
  return node;
}

export function showError(message) {
  const box = document.getElementById('status');
  box.hidden = false;
  box.className = 'status status--error';
  box.textContent = message;
}

// Fixed icon markup (never user data)
const ICON = {
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  meter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 4-6"/></svg>',
  rupee: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h12M6 9h12M14 20 7 13h2a5 5 0 0 0 0-9"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

function icon(name, cls = 'icon') {
  const span = el('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = ICON[name];
  return span;
}

/** Full-page sign-in card, built into #signin. */
function loginUi() {
  const root = document.getElementById('signin');
  const button = el('div', { class: 'login__button' });
  const msg = el('p', { class: 'login__msg', role: 'status' });
  const point = (name, text) => el('li', {}, icon(name, 'login__point-icon'), text);
  root.className = 'login';
  root.replaceChildren(
    el('div', { class: 'login__card' },
      icon('bolt', 'login__logo'),
      el('h1', { class: 'login__title' }, 'Power Plan'),
      el('p', { class: 'login__tag' }, 'Know your electricity bill before the meter reader does.'),
      el('ul', { class: 'login__points' },
        point('meter', 'Live units since your last meter reading'),
        point('rupee', 'Projected bill for the whole cycle'),
        point('chart', 'Daily usage and how it is trending'),
      ),
      button,
      msg,
      el('p', { class: 'login__foot' }, icon('lock', 'login__foot-icon'), 'Private. Only family members the admin has added can sign in.'),
    ),
  );
  return {
    button,
    show() { root.hidden = false; document.body.classList.add('signed-out'); },
    hide() { root.hidden = true; document.body.classList.remove('signed-out'); },
    message(text, kind) { msg.textContent = text; msg.className = `login__msg login__msg--${kind}`; },
  };
}

/** Avatar + name + role in the header, with a menu: details, Admin link, sign out. */
function renderProfile(me, exp) {
  const box = document.getElementById('who');
  const initials = (me.name || me.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const avatar = big => {
    const a = el('span', { class: big ? 'avatar avatar--big' : 'avatar' }, initials);
    if (me.picture) {
      const img = el('img', { src: me.picture, alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove());
      a.append(img);
    }
    return a;
  };
  const pill = () => el('span', { class: `role-pill role-pill--${me.role}` }, me.role === 'admin' ? 'Admin' : 'Viewer');
  const menu = el('div', { class: 'profile__menu', role: 'menu', hidden: true },
    el('div', { class: 'profile__head' }, avatar(true),
      el('div', { class: 'profile__id' },
        el('strong', {}, me.name || me.email.split('@')[0]),
        el('span', { class: 'profile__email' }, me.email),
        pill())),
    el('p', { class: 'profile__meta' }, icon('clock', 'profile__meta-icon'),
      isDemo() ? 'Demo mode – nothing is saved.'
        : `Signed in on this device until ${dateOnly(exp)}. Using the app keeps you signed in.`),
    me.role === 'admin' ? el('a', { class: 'profile__item', href: 'admin.html', role: 'menuitem' }, icon('shield', 'profile__item-icon'), 'Admin portal') : '',
    el('button', { class: 'profile__item profile__item--out', role: 'menuitem', onclick: signOut, disabled: isDemo() }, icon('logout', 'profile__item-icon'), 'Sign out'),
  );
  const btn = el('button', { class: 'profile__btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: me.email },
    avatar(false), el('span', { class: 'profile__name' }, me.name || me.email), pill(), icon('chevron', 'profile__chevron'));
  const toggleMenu = open => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', e => { e.stopPropagation(); toggleMenu(menu.hidden); });
  document.addEventListener('click', e => { if (!box.contains(e.target)) toggleMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleMenu(false); });
  box.className = 'who profile';
  box.replaceChildren(btn, menu);
}

// The menu: each page and who may open it (the server enforces the same rules)
const can = (me, page) => me.role === 'admin' || (me.pages || []).includes(page);
const NAV = [
  { key: 'summary', href: './', label: 'Summary', allowed: () => true },
  { key: 'bills', href: 'bills.html', label: 'Bills', allowed: me => can(me, 'breakdown') || can(me, 'documents') },
  { key: 'admin', href: 'admin.html', label: 'Admin', allowed: me => me.role === 'admin' },
];

/** The menu with only the pages this person may open; the current page is marked. */
export function renderNav(me, current) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.replaceChildren(...NAV.filter(p => p.allowed(me)).map(p =>
    el('a', { href: withCycle(p.href), 'aria-current': p.key === current ? 'page' : null }, p.label)));
}

/**
 * Signed in, but this page (or part of it) isn't ticked for them: say so and offer to ask the
 * admin. Never a sign-out.
 */
export function showNoAccess(need, label) {
  const main = document.getElementById('main');
  main.hidden = true;
  const msg = el('p', { class: 'msg', role: 'status' });
  const btn = el('button', { class: 'btn', type: 'button', onclick: async () => {
    btn.disabled = true;
    try {
      const r = await call('requestAccess', { page: need });
      msg.textContent = r.alreadyAsked ? 'You already asked today – the admin has been told.' : 'Request sent. You can open it once the admin approves.';
      msg.className = 'msg msg--ok';
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg msg--error';
      btn.disabled = false;
    }
  } }, 'Request access');
  const box = el('section', { class: 'panel noaccess' },
    icon('lock', 'noaccess__icon'),
    el('h1', {}, `You don't have access to ${label || 'this page'} yet`),
    el('p', { class: 'muted' }, 'The admin decides which pages each family member can see. Ask, and you can open it as soon as they approve.'),
    el('div', { class: 'row' }, btn, el('a', { class: 'btn btn--ghost', href: './' }, 'Back to Summary')),
    msg);
  main.before(box);
}

/**
 * Signs in, fills the header and menu, and resolves with the summary payload.
 * page: which page this is ('summary', 'admin', …), for the menu and the activity log;
 * params: extra summary parameters (e.g. a cycle).
 */
export async function boot(page = location.pathname.endsWith('admin.html') ? 'admin' : 'summary', params = {}) {
  const main = document.getElementById('main');
  if (isDemo()) document.getElementById('demo').hidden = false;
  try {
    await signIn(loginUi());
    const data = await call('summary', Object.assign({ page }, params));
    const s = currentSession();
    const me = Object.assign({}, s?.me, data.me);
    renderProfile(me, s?.exp);
    renderNav(me, page);
    main.hidden = false;
    return data;
  } catch (err) {
    if (err.code === 403 && err.need) {
      // Listed, but this page isn't ticked for them: offer to ask, keep them signed in
      const s = currentSession();
      if (s?.me) { renderProfile(s.me, s.exp); renderNav(s.me, page); }
      showNoAccess(err.need, err.message.replace(/^You don't have access to (.*) yet\.$/, '$1'));
    } else if (err.code === 401 || err.code === 403) {
      // Sign-in ended, or access was removed: back to the sign-in screen
      clearSession();
      showError(err.code === 401 ? 'Your sign-in has ended. Reloading…' : `${err.message} Reloading…`);
      setTimeout(() => location.reload(), 1500);
    } else {
      showError(err.message);
    }
    throw err;
  }
}
