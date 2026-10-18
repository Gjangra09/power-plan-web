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
};

const TABS = {
  Hourly: ['Hour', 'LastTsMs', 'Energy', 'Readings', 'AvgPowerW'],
  Bills: ['BillTsMs', 'BillTime', 'StartEnergy', 'ExpectedNextMs', 'Note', 'CreatedBy', 'CreatedAt'],
  Config: ['Key', 'Value'],
  Users: ['Email', 'Role'],
  Activity: ['Time', 'Email', 'Name', 'Role', 'Type', 'Event', 'Device'],
};

/** Run from the editor: shows which environment this project is and whether every setting is filled. */
function checkConfig() {
  const props = PropertiesService.getScriptProperties();
  REQUIRED_PROPS.forEach(k => {
    const v = props.getProperty(k);
    Logger.log(`${k}: ${v ? (k === 'ENV' ? v : v.slice(0, 6) + '…') : 'MISSING'}`);
  });
  Logger.log(`APP_SHEET_ID: ${props.getProperty('APP_SHEET_ID') || '(created by setup)'}`);
  requiredProp_('ENV');
}

function requiredProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error(`Script Property ${key} is not set (Project Settings → Script Properties).`);
  if (key === 'ENV' && v !== 'prod' && v !== 'uat') throw new Error(`ENV must be prod or uat, not "${v}".`);
  return v;
}
