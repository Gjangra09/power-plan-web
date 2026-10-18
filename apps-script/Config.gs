/**
 * Settings for the Power Plan backend.
 *
 * The same .gs files run in both Apps Script projects (prod and UAT). What differs is kept in
 * Project Settings → Script Properties, so no IDs are ever in this public repo:
 *   ENV               prod | uat
 *   GOOGLE_CLIENT_ID  OAuth 2.0 Web client ID (same for both)
 *   SOURCE_ID         grid meter sheet ID (PZEM_Data) – the long part of the sheet URL
 *   INVERTER_ID       inverter sheet ID (Pzem_Elec_DayData)
 * Run checkConfig() after setting them.
 */
const REQUIRED_PROPS = ['ENV', 'GOOGLE_CLIENT_ID', 'SOURCE_ID', 'INVERTER_ID'];

// Getters, so Script Properties are read when a function runs (not while files load)
const APP = {
  get ENV() { return requiredProp_('ENV'); },
  get GOOGLE_CLIENT_ID() { return requiredProp_('GOOGLE_CLIENT_ID'); },
  get SOURCE_ID() { return requiredProp_('SOURCE_ID'); },
  get INVERTER_ID() { return requiredProp_('INVERTER_ID'); },
  SOURCE_TAB: 'Sheet1',

  // App data spreadsheet, created by setup() in your Drive
  get APP_SHEET_NAME() { return this.ENV === 'prod' ? 'PowerPlan_App' : 'PowerPlan_App_UAT'; },

  // UAT updates less often: both projects share the account's daily trigger time
  get UPDATE_MINUTES() { return this.ENV === 'prod' ? 15 : 30; },

  // Rows read from the end of the logger sheet on each update (~1.5 days at 1/min)
  TAIL_ROWS: 2000,

  // Hours of history before the cycle start sent to the dashboard
  LEAD_HOURS: 24,

  // App sign-in lasts this long after Google sign-in, and renews while the app is used
  SESSION_DAYS: 30,

  // Activity log rows kept (oldest are trimmed)
  ACTIVITY_MAX_ROWS: 5000,

  // DHBVN meter-reading dates before this app existed (time unknown, stored as 00:00)
  SEED_BILL_DATES: ['2025-09-25', '2025-11-14', '2026-01-17', '2026-03-28', '2026-05-22', '2026-07-17', '2026-09-18'],

  // "Logger data stopped" alert: sent when no new reading has arrived for this many minutes
  // (Google's clock, so a wrong ESP clock doesn't matter), then a reminder every
  // STALE_REMIND_MINUTES until data is back. These are the defaults: Admin → Alerts changes them
  // (kept in Script Properties, so the every-minute check needn't open the sheet).
  // On last year's data 2 min ≈ 8 alerts + 12 reminders a day.
  STALE_ALERT_MINUTES: 2,
  STALE_REMIND_MINUTES: 30,
  // How often watchData runs. Prod and UAT share the account's 90 min/day of trigger time, so
  // only prod checks every minute.
  get WATCH_MINUTES() { return this.ENV === 'prod' ? 1 : 5; },
  RETRY_LIMIT: 3,           // a failed update is retried after 2, 4, 8 minutes
  JOBS_MAX_ROWS: 3000,
  ERRORS_MAX_ROWS: 1000,
  ALERTS_MAX_ROWS: 1000,
};

// Every tab of the app sheet and its columns. Missing tabs and columns are added on first use
// (tab_ in Summary.gs), so a newer version never needs a manual migration step.
const TABS = {
  Hourly: ['Hour', 'LastTsMs', 'Energy', 'Readings', 'AvgPowerW', 'LoggerRows', 'LastRowTsMs'],
  Bills: ['BillTsMs', 'BillTime', 'StartEnergy', 'ExpectedNextMs', 'Note', 'CreatedBy', 'CreatedAt'],
  Config: ['Key', 'Value'],
  Users: ['Email', 'Role', 'Pages'],
  Activity: ['Time', 'Email', 'Name', 'Role', 'Type', 'Event', 'Device', 'Details'],
  // Tariff in force from EffectiveFromMs until the next version starts (RatesJson = engine tariff)
  TariffVersions: ['Id', 'Category', 'EffectiveFromMs', 'EffectiveFrom', 'RatesJson', 'Note', 'CreatedBy', 'CreatedAt'],
  // Admin fixes to logger data, applied when data is read; raw data is never edited
  Corrections: ['Id', 'Kind', 'FromMs', 'ToMs', 'Value', 'Reason', 'Active', 'CreatedBy', 'CreatedAt', 'UpdatedBy', 'UpdatedAt'],
  // Uploaded DHBVN bills and the fields read from them (Phase 1)
  BillDocs: ['Id', 'BillTsMs', 'PeriodFrom', 'PeriodTo', 'FileId', 'FileName', 'FieldsJson', 'Status', 'UploadedBy', 'UploadedAt', 'ConfirmedBy', 'ConfirmedAt'],
  // Stored results of closed cycles (Phase 1 cycle slicer)
  Cycles: ['StartMs', 'EndMs', 'Days', 'Units', 'AvgPerDay', 'Band', 'AppTotal', 'DhbvnTotal', 'CoveragePct', 'BuiltAt'],
  Prefs: ['Email', 'Key', 'Value', 'UpdatedAt'],
  Devices: ['DeviceId', 'Name', 'Measures', 'Location', 'Installed', 'Note'],
  Jobs: ['Started', 'Job', 'Status', 'Ms', 'Rows', 'Message'],
  Errors: ['Time', 'Where', 'Code', 'Message', 'Email', 'Action'],
  Alerts: ['Time', 'Key', 'State', 'Message', 'Delivery'],
};

/** Run from the editor: shows which environment this project is and whether every setting is filled. */
function checkConfig() {
  const props = PropertiesService.getScriptProperties();
  REQUIRED_PROPS.forEach(k => {
    const v = props.getProperty(k);
    Logger.log(`${k}: ${v ? (k === 'ENV' ? v : v.slice(0, 6) + '…') : 'MISSING'}`);
  });
  Logger.log(`APP_SHEET_ID: ${props.getProperty('APP_SHEET_ID') || '(created by setup)'}`);
  // Optional: alerts go to the same Telegram chat as the ESP's (the token itself is never logged)
  ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].forEach(k => Logger.log(`${k}: ${props.getProperty(k) ? 'set' : 'not set (alerts are only written to the Alerts tab)'}`));
  requiredProp_('ENV');
}

function requiredProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error(`Script Property ${key} is not set (Project Settings → Script Properties).`);
  if (key === 'ENV' && v !== 'prod' && v !== 'uat') throw new Error(`ENV must be prod or uat, not "${v}".`);
  return v;
}
