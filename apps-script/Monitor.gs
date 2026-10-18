/**
 * Monitoring: every background run is logged in Jobs, errors in Errors, and problems are sent
 * once to Telegram (the same chat the ESP uses) with one "back to normal" message when they clear.
 *
 * Optional Script Properties: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Without them alerts are
 * only written to the Alerts tab. The app never repeats the ESP's own alerts: it only reports
 * what the ESP cannot (data not reaching the sheet, jobs failing).
 */

/**
 * Runs a background job and logs it. fn returns {rows, message} (undefined = skipped, busy).
 * On failure: logged in Jobs + Errors, retried after 2, 4, 8 minutes, and alerted once
 * when the retries are used up. Returns fn's result, or null after a failure.
 */
function runJob_(name, fn) {
  const started = Date.now();
  try {
    const r = fn();
    logJob_(started, name, r === undefined ? 'skipped' : 'ok', r && r.rows, r && r.message);
    if (r !== undefined) {
      clearRetry_(name);
      setAlert_('job:' + name, false);
    }
    return r;
  } catch (err) {
    logJob_(started, name, 'error', '', String(err && err.message || err));
    logError_(name, err);
    const tries = scheduleRetry_(name);
    if (tries > APP.RETRY_LIMIT) setAlert_('job:' + name, true, `${name} has failed ${tries} times in a row: ${err && err.message || err}`);
    return null;
  }
}

/** One-off retry trigger target for updateHourly. */
function retryUpdateHourly() {
  deleteTriggers_('retryUpdateHourly');
  updateHourly();
}

const RETRY_HANDLERS = { updateHourly: 'retryUpdateHourly' };

/** Counts consecutive failures; schedules a retry while under the limit. Returns the failure count. */
function scheduleRetry_(name) {
  const props = PropertiesService.getScriptProperties();
  const tries = Number(props.getProperty('RETRY_' + name) || 0) + 1;
  props.setProperty('RETRY_' + name, String(tries));
  const handler = RETRY_HANDLERS[name];
  if (handler && tries <= APP.RETRY_LIMIT) {
    deleteTriggers_(handler);
    ScriptApp.newTrigger(handler).timeBased().after(Math.pow(2, tries) * 60 * 1000).create();
  }
  return tries;
}

function clearRetry_(name) {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('RETRY_' + name)) return;
  props.deleteProperty('RETRY_' + name);
  if (RETRY_HANDLERS[name]) deleteTriggers_(RETRY_HANDLERS[name]);
}

/**
 * Hourly check (trigger): is logger data still arriving, is the Hourly tab keeping up,
 * any duplicate hour rows? Opens/closes alerts; each alert is sent once.
 */
function healthCheck() {
  return runJob_('healthCheck', () => {
    const now = Date.now();
    const lastLogger = lastLoggerTs_();
    const limitH = configNumber_('staleAlertHours', APP.STALE_ALERT_HOURS);
    const ageH = lastLogger ? (now - lastLogger) / HOUR_MS : Infinity;
    setAlert_('stale', ageH > limitH, lastLogger
      ? `No new logger data for ${ageH.toFixed(1)} h (last reading ${fmt_(lastLogger)}). The ESP may be offline or without Wi-Fi; units used meanwhile are still counted by the meter.`
      : 'The logger sheet has no readable rows.');

    // Data arrives but the Hourly tab is behind: the update job is not doing its work
    const pts = tab_('Hourly').getLastRow() > 1 ? hourlyPoints_(now - 3 * 86400e3) : [];
    const lastHourly = pts.length ? pts[pts.length - 1].ts : 0;
    const backfill = PropertiesService.getScriptProperties().getProperty('BACKFILL_NEXT_ROW');
    const lagH = lastLogger && lastHourly ? (lastLogger - lastHourly) / HOUR_MS : 0;
    setAlert_('lag', !backfill && lagH > 2, `The app has not taken in logger data for ${lagH.toFixed(1)} h although the logger is sending. Check Executions for updateHourly.`);

    const merged = backfill ? 0 : repairHourly_();
    trimLogs_();
    return { rows: merged, message: `data age ${Number.isFinite(ageH) ? ageH.toFixed(2) + ' h' : 'none'}, lag ${lagH.toFixed(2)} h${merged ? `, ${merged} duplicate hour rows merged` : ''}` };
  });
}

/** Timestamp (ms) of the newest readable row in the logger sheet, or 0. */
function lastLoggerTs_() {
  const src = sourceSheet_();
  const last = src.getLastRow();
  if (last < 2) return 0;
  const n = Math.min(20, last - 1);
  const values = src.getRange(last - n + 1, 1, n, 1).getDisplayValues();
  for (let i = values.length - 1; i >= 0; i--) {
    const ts = parsePzemTs_(values[i][0]);
    if (ts !== null) return ts;
  }
  return 0;
}

/**
 * Merges Hourly rows that share an hour (left by the old date/text mix-up) into one, keeping
 * the latest snapshot and adding up the counts. Returns how many rows were removed.
 */
function repairHourly_() {
  const sh = tab_('Hourly');
  const n = sh.getLastRow() - 1;
  if (n < 2) return 0;
  const width = TABS.Hourly.length;
  const values = sh.getRange(2, 1, n, width).getValues();
  const seen = {};
  let dupes = 0;
  values.forEach(r => { const k = hourKey_(r[0]); if (seen[k]) dupes++; seen[k] = true; });
  if (!dupes) return 0;
  return withLock_(() => {
    const byKey = {};
    sh.getRange(2, 1, n, width).getValues().forEach(r => {
      const k = hourKey_(r[0]);
      const cur = byKey[k];
      if (!cur) { byKey[k] = [k].concat(r.slice(1)); return; }
      const later = Number(r[1]) > Number(cur[1]) ? r : cur;
      const nSum = (Number(cur[3]) || 0) + (Number(r[3]) || 0);
      const powerSum = (Number(cur[4]) || 0) * (Number(cur[3]) || 0) + (Number(r[4]) || 0) * (Number(r[3]) || 0);
      byKey[k] = [k, later[1], later[2], nSum, round_(nSum ? powerSum / nSum : 0, 1),
        (Number(cur[5]) || Number(cur[3]) || 0) + (Number(r[5]) || Number(r[3]) || 0), Math.max(Number(cur[6]) || 0, Number(r[6]) || 0, Number(later[1]) || 0)];
    });
    const rows = Object.keys(byKey).sort().map(k => byKey[k]);
    sh.getRange(2, 1, n, width).clearContent();
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange(2, 1, rows.length, width).setValues(rows);
    Logger.log(`Hourly: merged ${n - rows.length} duplicate hour rows.`);
    return n - rows.length;
  }) || 0;
}

// ---------- alerts ----------

/**
 * Opens (open = true) or closes an alert. Sends one message when it opens and one when it
 * closes, however often the check runs in between.
 */
function setAlert_(key, open, message) {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(10 * 1000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const all = JSON.parse(props.getProperty('ALERT_STATE') || '{}');
    const cur = all[key];
    if (open && !cur) {
      all[key] = { since: Date.now() };
      props.setProperty('ALERT_STATE', JSON.stringify(all));
      notify_(key, 'open', '⚠️ ' + message);
    } else if (!open && cur) {
      delete all[key];
      props.setProperty('ALERT_STATE', JSON.stringify(all));
      const h = (Date.now() - cur.since) / HOUR_MS;
      notify_(key, 'closed', `✅ Back to normal: ${ALERT_NAMES[key.split(':')[0]] || key} (after ${h.toFixed(1)} h).`);
    }
  } finally {
    lock.releaseLock();
  }
}

const ALERT_NAMES = { stale: 'logger data is arriving again', lag: 'the app is taking in logger data again', job: 'the background job works again' };

/** Writes the alert to the Alerts tab and sends it to Telegram when set up. Never throws. */
function notify_(key, state, text) {
  let delivery = 'not set up';
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('TELEGRAM_BOT_TOKEN'), chat = props.getProperty('TELEGRAM_CHAT_ID');
    const full = (APP.ENV === 'uat' ? '[Power Plan UAT] ' : '[Power Plan] ') + text;
    if (token && chat) {
      const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post', payload: { chat_id: chat, text: full }, muteHttpExceptions: true,
      });
      delivery = res.getResponseCode() === 200 ? 'sent' : 'failed (HTTP ' + res.getResponseCode() + ')';
    }
    tab_('Alerts').appendRow([new Date(), key, state, full, delivery]);
  } catch (err) {
    console.error('Alert failed: ' + (err && err.message));
  }
  return delivery;
}

/** Run from the editor: sends a test message to the Telegram chat. */
function sendTestAlert() {
  Logger.log('Delivery: ' + notify_('test', 'test', 'Test message: alerts from the app reach this chat.'));
}

// ---------- logs ----------

function logJob_(started, name, status, rows, message) {
  try {
    tab_('Jobs').appendRow([new Date(started), name, status, Date.now() - started, rows === undefined ? '' : rows, String(message || '').slice(0, 300)]);
  } catch (err) {
    console.error('Job log failed: ' + (err && err.message));
  }
}

/** Never lets a logging problem break the request or job. */
function logError_(where, err, email, action) {
  try {
    tab_('Errors').appendRow([new Date(), where, (err && err.code) || 500, String(err && err.message || err).slice(0, 500), email || '', action || '']);
  } catch (e) {
    console.error('Error log failed: ' + (e && e.message));
  }
}

function trimLogs_() {
  [['Jobs', APP.JOBS_MAX_ROWS], ['Errors', APP.ERRORS_MAX_ROWS], ['Alerts', APP.ALERTS_MAX_ROWS]].forEach(([name, max]) => {
    const sh = tab_(name);
    const extra = sh.getLastRow() - 1 - max;
    if (extra > 0) sh.deleteRows(2, extra);
  });
}

function configNumber_(key, fallback) {
  const v = Number(configValue_(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ---------- Phase 0 check ----------

/**
 * Run from the editor after updating the code. Adds missing tabs/columns, makes sure the jobs
 * are scheduled, then checks the server engine against the 6 DHBVN bills and logs the current
 * cycle as the server calculates it. Paste the log back to confirm Phase 0 in UAT.
 */
function phase0Check() {
  Logger.log(`Environment: ${APP.ENV}`);
  Object.keys(TABS).forEach(tab_);
  seedDefaults_();
  Logger.log('Tabs: ' + Object.keys(TABS).join(', ') + ' – all present with their columns.');
  installTriggers_();
  Logger.log('Triggers: ' + ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()).join(', '));

  // D1 on the real Apps Script runtime
  let ok = 0;
  ENGINE_FIXTURE.bills.forEach(b => {
    const r = Billing.billFor(b.units, b.days);
    const pay = Billing.payableFor(r.total, b.arrears, b.sundry.reduce((s, x) => s + x, 0)).payable;
    const same = JSON.stringify(r.slabLines.map(l => [Billing.paisa(l.units), l.rate, l.amount])) === JSON.stringify(b.slabs.map(l => [l.units, l.rate, l.amount]))
      && r.energy === b.energy && r.fixed === b.fixed && r.fppas === b.fppas && r.municipalTax === b.tax && r.duty === b.duty && r.total === b.total && pay === b.payable;
    if (same) ok++;
    else Logger.log(`MISMATCH ${b.period}: app ${JSON.stringify(r)} payable ${pay}`);
  });
  Logger.log(`D1 on the server: ${ok}/${ENGINE_FIXTURE.bills.length} DHBVN bills match to the paisa.`);

  Logger.log('Tariff versions: ' + tariffVersions_().map(v => `${v.id} from ${v.from ? fmt_(v.from) : 'the start'}`).join('; '));
  const s = summary_({}, { email: 'phase0Check' });
  if (s.calc) {
    const c = s.calc;
    Logger.log(`Current cycle (server): ${c.unitsSoFar.toFixed(2)} units in ${c.daysElapsed.toFixed(2)} days · so far ₹${c.chargesSoFar.total} · projected ₹${c.projectedBill.total} for ${c.projectedUnits.toFixed(1)} units`);
    const q = s.quality;
    Logger.log(`Data quality this cycle: ${(q.share * 100).toFixed(1)}% of hours with data (${q.complete} complete, ${q.partial} partial, ${q.missing} missing); ${q.filledGaps} short gaps filled, ${q.outages} outages; corrections active: ${q.corrections}`);
  } else {
    Logger.log('No usable bill for the current cycle yet.');
  }
  const p = PropertiesService.getScriptProperties();
  Logger.log(`Telegram: ${p.getProperty('TELEGRAM_BOT_TOKEN') && p.getProperty('TELEGRAM_CHAT_ID') ? 'set up (run sendTestAlert to try it)' : 'not set up – alerts only go to the Alerts tab'}`);
  Logger.log(`Stale-data alert after ${configNumber_('staleAlertHours', APP.STALE_ALERT_HOURS)} h without logger data.`);
}
