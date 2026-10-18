/**
 * Settings for the Power Plan backend. Edit GOOGLE_CLIENT_ID before running setup().
 */
const APP = {
  // OAuth 2.0 Web client ID from Google Cloud Console (APIs & Services → Credentials)
  GOOGLE_CLIENT_ID: 'PASTE_YOUR_CLIENT_ID.apps.googleusercontent.com',

  // Logger sheet IDs (the long part of the sheet URL). Fill these in Apps Script only –
  // never commit real IDs: this repo is public.
  SOURCE_ID: 'PASTE_PZEM_DATA_SHEET_ID',        // grid meter (PZEM_Data)
  INVERTER_ID: 'PASTE_INVERTER_SHEET_ID',       // inverter output (Pzem_Elec_DayData)
  SOURCE_TAB: 'Sheet1',

  // App data spreadsheet, created by setup() in your Drive
  APP_SHEET_NAME: 'PowerPlan_App',

  // Rows read from the end of the logger sheet on each 15-minute update (~1.5 days at 1/min)
  TAIL_ROWS: 2000,

  // Hours of history before the cycle start sent to the dashboard
  LEAD_HOURS: 24,

  // DHBVN meter-reading dates before this app existed (time unknown, stored as 00:00)
  SEED_BILL_DATES: ['2025-09-25', '2025-11-14', '2026-01-17', '2026-03-28', '2026-05-22', '2026-07-17', '2026-09-18'],
};

const TABS = {
  Hourly: ['Hour', 'LastTsMs', 'Energy', 'Readings', 'AvgPowerW'],
  Bills: ['BillTsMs', 'BillTime', 'StartEnergy', 'ExpectedNextMs', 'Note', 'CreatedBy', 'CreatedAt'],
  Config: ['Key', 'Value'],
  Users: ['Email', 'Role'],
};
