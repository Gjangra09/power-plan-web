/**
 * Power Plan – nightly archive + clean for the PZEM logger sheets.
 *
 * What it does, for each sheet in ARCHIVE.sheets:
 *   1. Rows older than KEEP_DAYS are appended to monthly CSV files in Drive
 *      (My Drive/Power Plan Archive/<name>/<name>_YYYY-MM.csv) and then deleted
 *      from the live sheet. Zero rows are not written to the archive.
 *   2. Zero rows (Current = 0 and Power = 0, i.e. load running on the inverter)
 *      are deleted from the remaining live rows.
 *
 * Safe with the logger still appending: rows are only ever deleted above the
 * last row that existed when the run started, and the archive is written
 * (de-duplicated) before anything is deleted, so a failed run never loses data.
 *
 * Part of the Power Plan Apps Script project. Run setup() (Summary.gs) first so the
 * Hourly tab holds the full history, then archiveDryRun(), then installArchiveTrigger().
 */

const ARCHIVE = {
  KEEP_DAYS: 60,
  ARCHIVE_ROOT: 'Power Plan Archive',
  TAB_NAME: 'Sheet1',
  TIME_BUDGET_MS: 5 * 60 * 1000, // Apps Script hard limit is 6 min
  sheets: [
    { name: 'PZEM_Data', id: APP.SOURCE_ID },
    { name: 'Invertor',  id: APP.INVERTER_ID },
  ],
};

function archiveRun()    { archiveMain_(false); }
function archiveDryRun() { archiveMain_(true); }

/** Creates the nightly trigger (02:00 in the script's time zone). Run once. */
function installArchiveTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'archiveRun')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('archiveRun').timeBased().everyDays(1).atHour(2).create();
  Logger.log('Nightly trigger installed for archiveRun().');
}

function archiveMain_(dry) {
  // Capture the newest readings in the Hourly tab before any logger rows are deleted
  if (!dry) {
    if (!loadState_()) throw new Error('Run setup() first so the Hourly history is complete.');
    updateHourly();
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) { Logger.log('Another run is in progress, skipping.'); return; }
  const started = Date.now();
  try {
    const cutoff = new Date(Date.now() - ARCHIVE.KEEP_DAYS * 24 * 3600 * 1000);
    Logger.log(`Cutoff: ${cutoff}  (dry run: ${dry})`);
    ARCHIVE.sheets.forEach(cfg => archiveSheet_(cfg, cutoff, dry, started));
  } finally {
    lock.releaseLock();
  }
}

function archiveSheet_(cfg, cutoff, dry, started) {
  const ss = SpreadsheetApp.openById(cfg.id);
  const sh = ss.getSheetByName(ARCHIVE.TAB_NAME) || ss.getSheets()[0];
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return;

  // Display values keep the exact text the sheet shows (same as the CSV export).
  const all = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  const header = all[0];
  const data = all.slice(1);
  const col = name => {
    const i = header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
    if (i < 0) throw new Error(`${cfg.name}: column "${name}" not found in ${header}`);
    return i;
  };
  const cTs = col('Timestamp'), cCur = col('Current'), cPow = col('Power');
  const isZero = r => Number(r[cCur]) === 0 && Number(r[cPow]) === 0 && r[cCur] !== '' && r[cPow] !== '';

  // 1. Leading block of rows older than the cutoff (data is appended in time order).
  let nOld = 0;
  while (nOld < data.length) {
    const ts = archiveParseTs_(data[nOld][cTs]);
    if (!ts || ts >= cutoff) break;
    nOld++;
  }
  const oldRows = data.slice(0, nOld);
  const toArchive = oldRows.filter(r => !isZero(r));

  // 2. Zero rows among the rows that stay live.
  const zeroIdx = [];
  for (let i = nOld; i < data.length; i++) if (isZero(data[i])) zeroIdx.push(i);

  Logger.log(`${cfg.name}: ${data.length} rows | archive ${toArchive.length} ` +
             `(+${nOld - toArchive.length} zero rows dropped) | zero rows in live part: ${zeroIdx.length}`);
  if (dry) return;

  // Write the archive first; only then delete from the live sheet.
  if (toArchive.length) appendToMonthlyCsv_(cfg.name, header, toArchive, cTs);

  // Delete bottom-up so earlier row numbers stay valid; zero runs first, then the old block.
  const runs = archiveRuns_(zeroIdx);
  let deleted = 0;
  for (let k = runs.length - 1; k >= 0; k--) {
    if (Date.now() - started > ARCHIVE.TIME_BUDGET_MS) {
      Logger.log(`${cfg.name}: time budget reached, ${k + 1} zero runs left for the next run.`);
      break;
    }
    const [start, len] = runs[k];
    sh.deleteRows(start + 2, len); // +2: header row + 1-based rows
    deleted += len;
  }
  if (nOld) sh.deleteRows(2, nOld);
  SpreadsheetApp.flush();
  Logger.log(`${cfg.name}: deleted ${nOld} archived rows and ${deleted} zero rows.`);
}

/** Groups sorted indexes into [start, length] runs of consecutive rows. */
function archiveRuns_(idx) {
  const runs = [];
  idx.forEach(i => {
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === i) last[1]++;
    else runs.push([i, 1]);
  });
  return runs;
}

function appendToMonthlyCsv_(name, header, rows, cTs) {
  const folder = archiveFolder_([ARCHIVE.ARCHIVE_ROOT, name]);
  const byMonth = {};
  rows.forEach(r => {
    const ts = archiveParseTs_(r[cTs]);
    const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}`;
    (byMonth[key] = byMonth[key] || []).push(r);
  });

  Object.keys(byMonth).sort().forEach(month => {
    const fileName = `${name}_${month}.csv`;
    const it = folder.getFilesByName(fileName);
    const file = it.hasNext() ? it.next() : null;
    const existing = file ? file.getBlob().getDataAsString() : '';
    const seen = new Set(existing.split(/\r?\n/));
    const fresh = byMonth[month].map(archiveCsvLine_).filter(l => !seen.has(l));
    if (!fresh.length) return;
    const body = (existing ? existing.replace(/\s*$/, '\n') : archiveCsvLine_(header) + '\n') + fresh.join('\n') + '\n';
    if (file) file.setContent(body);
    else folder.createFile(fileName, body, MimeType.CSV);
    Logger.log(`  ${fileName}: +${fresh.length} rows`);
  });
}

function archiveCsvLine_(r) {
  return r.map(v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',');
}

/** Parses "M/D/YYYY H:MM:SS" (the sheets' display format). Returns null if unparsable. */
function archiveParseTs_(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s).trim());
  if (!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +(m[6] || 0));
}

function archiveFolder_(path) {
  let folder = DriveApp.getRootFolder();
  path.forEach(p => {
    const it = folder.getFoldersByName(p);
    folder = it.hasNext() ? it.next() : folder.createFolder(p);
  });
  return folder;
}
