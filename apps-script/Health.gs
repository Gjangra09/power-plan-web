/**
 * Service health page (needs "Service health"): is data arriving, are the jobs keeping up, what
 * failed in the last 24 h, which alerts are open, are the timers there, how full is the sheet,
 * which backend version runs. Each check is ok / warn / bad.
 */

const SHEET_CELL_LIMIT = 10000000;   // Google Sheets limit per spreadsheet
const EXPECTED_TRIGGERS = ['updateHourly', 'healthCheck', 'watchData'];

function health_() {
  const now = Date.now();
  const props = PropertiesService.getScriptProperties();
  const checks = [];
  const add = (key, label, status, value, detail) => checks.push({ key, label, status, value, detail: detail || '' });
  const ago = ms => duration_(now - ms) + ' ago';

  // Data arriving from the logger
  const watch = JSON.parse(props.getProperty('WATCH') || '{}');
  const lastLogger = lastLoggerTs_();
  const age = lastLogger ? (now - lastLogger) / 60e3 : Infinity;
  add('data', 'Logger data', watch.openSince || age > 60 ? 'bad' : age > 10 ? 'warn' : 'ok',
    lastLogger ? `last reading ${ago(lastLogger)}` : 'no readings',
    watch.openSince ? `No new readings since ${fmt_(watch.downFrom || lastLogger)} – the ESP may be offline` : lastLogger ? fmt_(lastLogger) : '');

  // The app taking the data in
  const jobs = recentJobs_(400);
  const last = name => jobs.find(j => j.job === name);
  const lastOk = name => jobs.find(j => j.job === name && j.status === 'ok');
  const upd = lastOk('updateHourly');
  const updMin = upd ? (now - upd.ts) / 60e3 : Infinity;
  const pts = tab_('Hourly').getLastRow() > 1 ? hourlyPoints_(now - 3 * 86400e3) : [];
  const lagH = lastLogger && pts.length ? (lastLogger - pts[pts.length - 1].ts) / 3600e3 : 0;
  add('sync', 'Last successful sync', updMin > 4 * APP.UPDATE_MINUTES || lagH > 2 ? 'bad' : updMin > 2 * APP.UPDATE_MINUTES ? 'warn' : 'ok',
    upd ? ago(upd.ts) : 'never', `updates every ${APP.UPDATE_MINUTES} min${upd ? ` · ${upd.rows} rows read, ${upd.message}` : ''}${lagH > 0.5 ? ` · ${lagH.toFixed(1)} h behind the logger` : ''}`);

  // Failures in the last 24 h
  const day = now - 86400e3;
  const failed = jobs.filter(j => j.ts > day && j.status === 'error');
  const retries = Number(props.getProperty('RETRY_updateHourly') || 0);
  add('jobs', 'Background jobs (24 h)', failed.length > 3 ? 'bad' : failed.length || retries ? 'warn' : 'ok',
    `${failed.length} failed`, retries ? `update retrying (${retries} failure${retries > 1 ? 's' : ''} in a row)` : failed.length ? `last: ${failed[0].job} – ${failed[0].message}` : 'all runs ok');
  const errors = recentErrors_(50).filter(e => e.ts > day);
  add('errors', 'Server errors (24 h)', errors.length > 3 ? 'bad' : errors.length ? 'warn' : 'ok', `${errors.length}`, errors.length ? `last: ${errors[0].where} – ${errors[0].message}` : '');

  // Timers, backfill, sheet size
  const triggers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  const missing = EXPECTED_TRIGGERS.filter(t => !triggers.includes(t));
  add('triggers', 'Timers', missing.length ? 'bad' : 'ok', missing.length ? `${missing.length} missing` : 'all running',
    missing.length ? `Missing: ${missing.join(', ')} – run phase0Check in the editor` : triggers.filter(t => EXPECTED_TRIGGERS.includes(t)).join(', '));
  const next = Number(props.getProperty('BACKFILL_NEXT_ROW') || 0);
  if (next) {
    const total = sourceSheet_().getLastRow();
    add('backfill', 'History rebuild', 'warn', `${Math.round(next / total * 100)}%`, `${next - 2} of ${total - 1} logger rows done`);
  }
  const cells = appSheet_().getSheets().reduce((s, sh) => s + sh.getLastRow() * sh.getLastColumn(), 0);
  const share = cells / SHEET_CELL_LIMIT;
  add('sheet', 'App sheet size', share > 0.8 ? 'bad' : share > 0.5 ? 'warn' : 'ok', `${(share * 100).toFixed(1)}% of Google's limit`,
    `${cells.toLocaleString('en-IN')} cells · Hourly ${tab_('Hourly').getLastRow() - 1} rows · Activity ${tab_('Activity').getLastRow() - 1} rows`);

  const alerts = JSON.parse(props.getProperty('ALERT_STATE') || '{}');
  const open = Object.keys(alerts).map(k => ({ key: k, since: alerts[k].since }));
  if (watch.openSince) open.unshift({ key: 'stale', since: watch.openSince });

  return {
    checks,
    status: checks.some(c => c.status === 'bad') ? 'bad' : checks.some(c => c.status === 'warn') ? 'warn' : 'ok',
    jobs: jobs.slice(0, 15),
    errors: errors.slice(0, 10),
    alerts: open,
    build: typeof BUILD === 'undefined' ? null : BUILD,
    env: APP.ENV,
    serverTime: now,
  };
}

/** Newest first: [{ts, job, status, ms, rows, message}]. */
function recentJobs_(n) {
  const sh = tab_('Jobs');
  const count = Math.min(n, sh.getLastRow() - 1);
  if (count < 1) return [];
  return sh.getRange(sh.getLastRow() - count + 1, 1, count, 6).getValues()
    .map(r => ({ ts: r[0] instanceof Date ? r[0].getTime() : Number(r[0]), job: String(r[1]), status: String(r[2]), ms: Number(r[3]) || 0, rows: r[4] === '' ? '' : Number(r[4]), message: String(r[5]) }))
    .reverse();
}

/** Newest first: [{ts, where, code, message, action}]. */
function recentErrors_(n) {
  const sh = tab_('Errors');
  const count = Math.min(n, sh.getLastRow() - 1);
  if (count < 1) return [];
  return sh.getRange(sh.getLastRow() - count + 1, 1, count, 6).getValues()
    .map(r => ({ ts: r[0] instanceof Date ? r[0].getTime() : Number(r[0]), where: String(r[1]), code: Number(r[2]), message: String(r[3]), action: String(r[5]) }))
    .reverse();
}
