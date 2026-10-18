// Shared page chrome and formatting.
import { signIn, signOut, call, isDemo } from './api.js';

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

/** Signs in, fills the header, and resolves with the summary payload. */
export async function boot() {
  const signInBox = document.getElementById('signin');
  const main = document.getElementById('main');
  if (isDemo()) document.getElementById('demo').hidden = false;
  try {
    await signIn(signInBox);
    const data = await call('summary');
    document.getElementById('who').textContent = data.me.email;
    document.getElementById('signout').hidden = isDemo();
    document.getElementById('signout').addEventListener('click', signOut);
    document.querySelectorAll('[data-admin]').forEach(n => { n.hidden = data.me.role !== 'admin'; });
    main.hidden = false;
    return data;
  } catch (err) {
    if (err.code === 401) {
      showError('Your sign-in expired. Reloading…');
      setTimeout(() => location.reload(), 1500);
    } else {
      showError(err.message);
    }
    throw err;
  }
}
