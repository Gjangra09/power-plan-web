// Public settings for the frontend. Neither value is a secret: the backend checks every
// request's Google sign-in and only answers emails listed in its Users tab.
export const CONFIG = {
  // OAuth 2.0 Web client ID (same value as APP.GOOGLE_CLIENT_ID in apps-script/Config.gs)
  clientId: '577448013716-eh1r244qd5komkq5kck6qrv9f9rln09p.apps.googleusercontent.com',
  // Apps Script web app URL ending in /exec. Leave empty to run with demo data.
  apiUrl: 'https://script.google.com/macros/s/AKfycbzWSZxafaBZRwIWoZ3ZQNjTLcUEQlQGrB8Cb60GAW-laVJTw8pNqABVQQG4DO8GUhjv_g/exec',
};
