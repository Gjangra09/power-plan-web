// Public settings for the frontend. Neither value is a secret: the backend checks every
// request's Google sign-in and only answers emails listed in its Users tab.
//
// This file is identical on the main and uat branches. The environment comes from the page
// address (…/uat/… = UAT), so merging uat into main can never point prod at the UAT backend.
export const BACKENDS = {
  // Apps Script web app URLs ending in /exec. Empty = demo data.
  prod: 'https://script.google.com/macros/s/AKfycbzWSZxafaBZRwIWoZ3ZQNjTLcUEQlQGrB8Cb60GAW-laVJTw8pNqABVQQG4DO8GUhjv_g/exec',
  uat: '',
};

export const envFromPath = path => (/\/uat(\/|$)/.test(path) ? 'uat' : 'prod');

const env = envFromPath(globalThis.location?.pathname ?? '/');

export const CONFIG = {
  env,
  // OAuth 2.0 Web client ID (same value as the GOOGLE_CLIENT_ID Script Property in both Apps Script projects)
  clientId: '577448013716-eh1r244qd5komkq5kck6qrv9f9rln09p.apps.googleusercontent.com',
  apiUrl: BACKENDS[env],
};
