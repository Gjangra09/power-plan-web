// Google Sign-In + calls to the Apps Script backend.
//
// Google's ID token lasts an hour, so it is used once: the backend's `login` action checks it and
// returns an app session (30 days, renewed while the app is used). The session is kept in this
// browser per environment, so prod and UAT sign-ins don't overwrite each other.
import { CONFIG } from './config.js';
import { mockCall } from './mock.js';

const MOCK = !CONFIG.apiUrl || new URLSearchParams(location.search).has('demo');
const KEY = `pp_session_${CONFIG.env}`;
let saved = loadSession();

export const isDemo = () => MOCK;

/** The signed-in person ({email, name, picture, role}) and when the sign-in ends. */
export const currentSession = () => saved;

/**
 * Resolves once the viewer is signed in: at once in demo mode or with a saved session,
 * otherwise after Google sign-in. `ui` shows the sign-in screen and its messages.
 */
export async function signIn(ui) {
  if (MOCK || saved) return;
  ui.show();
  await waitForGsi();
  return new Promise(resolve => {
    google.accounts.id.initialize({
      client_id: CONFIG.clientId,
      auto_select: true,
      callback: async r => {
        ui.message('Signing you in…', 'info');
        try {
          const data = await call('login', { token: r.credential });
          store({ session: data.session, exp: data.sessionExp, me: data.me });
          ui.hide();
          resolve();
        } catch (err) {
          google.accounts.id.disableAutoSelect();
          ui.message(err.code === 403
            ? `${err.message.split(' is not allowed')[0]} isn't on the family list yet. Ask the admin to add you, or use another account.`
            : err.message, 'error');
        }
      },
    });
    google.accounts.id.renderButton(ui.button, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 280 });
    google.accounts.id.prompt();
  });
}

export async function signOut() {
  if (!MOCK && saved) {
    // Log the sign-out, but never wait long for it
    await Promise.race([call('logout').catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
  }
  clearSession();
  if (window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
  location.reload();
}

export function clearSession() {
  saved = null;
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

export async function call(action, params = {}) {
  if (MOCK) return mockCall(action, params);
  const res = await fetch(CONFIG.apiUrl, {
    method: 'POST',
    // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, session: saved?.session, client: deviceLabel(), ...params }),
  });
  const data = await res.json();
  if (!data.ok) {
    if (data.code === 401) clearSession();
    const err = new Error(data.error || 'Request failed');
    err.code = data.code;
    throw err;
  }
  // The backend renews a session that is getting old
  if (data.session && saved && action !== 'login') store({ ...saved, session: data.session, exp: data.sessionExp });
  if (data.me && saved) store({ ...saved, me: data.me });
  return data;
}

function store(s) {
  saved = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: signed in for this page only */ }
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    return s && s.session && s.exp > Date.now() + 60e3 ? s : null;
  } catch {
    return null;
  }
}

/** "Chrome on Android" – shown in the admin's activity log. */
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${browser} on ${os}` : os;
}

function waitForGsi() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      if (window.google?.accounts?.id) resolve();
      else if (Date.now() - started > 10000) reject(new Error('Google Sign-In did not load. Check your connection.'));
      else setTimeout(poll, 100);
    })();
  });
}
