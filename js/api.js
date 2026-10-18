// Google Sign-In + calls to the Apps Script backend.
import { CONFIG } from './config.js';
import { mockCall } from './mock.js';

const MOCK = !CONFIG.apiUrl || new URLSearchParams(location.search).has('demo');
const KEY = 'pp_id_token';
let token = loadToken();

export const isDemo = () => MOCK;

/** Resolves once the viewer is signed in (immediately in demo mode or with a saved token). */
export async function signIn(buttonEl) {
  if (MOCK || token) return;
  await waitForGsi();
  return new Promise(resolve => {
    google.accounts.id.initialize({
      client_id: CONFIG.clientId,
      auto_select: true,
      callback: r => {
        token = r.credential;
        try { sessionStorage.setItem(KEY, token); } catch { /* storage unavailable */ }
        buttonEl.hidden = true;
        resolve();
      },
    });
    buttonEl.hidden = false;
    google.accounts.id.renderButton(buttonEl, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with' });
    google.accounts.id.prompt();
  });
}

export function signOut() {
  token = null;
  try { sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  if (window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
  location.reload();
}

export async function call(action, params = {}) {
  if (MOCK) return mockCall(action, params);
  const res = await fetch(CONFIG.apiUrl, {
    method: 'POST',
    // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token, ...params }),
  });
  const data = await res.json();
  if (!data.ok) {
    if (data.code === 401) {
      token = null;
      try { sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
    }
    const err = new Error(data.error || 'Request failed');
    err.code = data.code;
    throw err;
  }
  return data;
}

function loadToken() {
  try {
    const t = sessionStorage.getItem(KEY);
    return t && !expiresSoon(t) ? t : null;
  } catch {
    return null;
  }
}

function expiresSoon(jwt) {
  try {
    const body = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return body.exp * 1000 < Date.now() + 60e3;
  } catch {
    return true;
  }
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
