/**
 * Uploaded DHBVN bills (Bills page → Uploaded bills).
 *
 * The browser reads the PDF (pdf.js + js/billparse.js) and the admin confirms the figures. The
 * server checks them again (never trusting the page), keeps the PDF in a private Drive folder that
 * is never shared (files are only handed out through this app, to people with "Bill documents"),
 * and the figures in BillDocs. A bill is linked to the billing cycle with the same reading dates.
 */

const BILL_MAX_BYTES = 10 * 1024 * 1024;
const BILL_FIELDS = ['periodFrom', 'periodTo', 'days', 'mdiKw', 'readingOld', 'readingNew', 'mf', 'units', 'basis', 'slabs',
  'arrears', 'energy', 'fixed', 'fppas', 'tax', 'duty', 'security', 'subsidy', 'total', 'sundry', 'payable', 'dueDate'];

/** Confirmed uploads, oldest first: [{id, row, cycleStart, periodFrom, periodTo, fileId, fileName, fields, uploadedBy, uploadedAt}]. */
function billDocs_() {
  const sh = tab_('BillDocs');
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, TABS.BillDocs.length).getValues()
    .map((r, i) => ({
      id: String(r[0]), row: i + 2, cycleStart: r[1] === '' ? null : Number(r[1]),
      periodFrom: isoDay_(r[2]), periodTo: isoDay_(r[3]), fileId: String(r[4]), fileName: String(r[5]),
      fields: JSON.parse(String(r[6] || '{}')), status: String(r[7]),
      uploadedBy: String(r[8]), uploadedAt: r[9] instanceof Date ? r[9].getTime() : null,
    }))
    .filter(d => d.status === 'confirmed')
    .sort((a, b) => a.periodFrom.localeCompare(b.periodFrom));
}

/** Saves a confirmed bill: figures re-checked, PDF to the private folder, row in BillDocs. */
function uploadBill_(req, user) {
  const f = cleanBillFields_(req.fields);
  const check = Billing.checkDhbvnBill(f, tariffAt_(tariffVersions_(), Date.parse(f.periodFrom)));
  if (!check.linesAddUp || !check.payableAddsUp) {
    throw httpError_(400, 'The bill\'s own figures don\'t add up (lines 1–7 should make B, and A + B + C the payable). Check the values against the PDF.');
  }
  const bytes = Utilities.base64Decode(String((req.file && req.file.base64) || ''));
  if (!bytes.length) throw httpError_(400, 'Choose the bill PDF.');
  if (bytes.length > BILL_MAX_BYTES) throw httpError_(400, 'The PDF is larger than 10 MB.');
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== '%PDF') throw httpError_(400, 'That file is not a PDF.');

  const name = `DHBVN bill ${f.periodFrom} to ${f.periodTo}.pdf`;
  const cycleStart = matchCycle_(f);
  const file = billsFolder_().createFile(Utilities.newBlob(bytes, 'application/pdf', name));
  const id = 'D' + Utilities.getUuid().slice(0, 8);
  let replaced = '';
  withLock_(() => {
    const sh = tab_('BillDocs');
    billDocs_().filter(d => d.periodFrom === f.periodFrom && d.periodTo === f.periodTo).forEach(d => {
      sh.getRange(d.row, 8).setValue('replaced');
      trashFile_(d.fileId);
      replaced = ' · replaced the earlier upload';
    });
    addRow_(sh, [id, cycleStart || '', "'" + f.periodFrom, "'" + f.periodTo, file.getId(), name, JSON.stringify(f), 'confirmed', user.email, new Date(), user.email, new Date()]);
  });
  return {
    id, cycleStart,
    details: `${f.periodFrom} → ${f.periodTo}: ${f.units} units, B ₹${f.total}, payable ₹${f.payable}${cycleStart ? '' : ' · no billing record with these reading dates'}${replaced}`,
  };
}

/** Only the known bill fields, as numbers/strings, checked for shape. */
function cleanBillFields_(x) {
  if (!x || typeof x !== 'object') throw httpError_(400, 'No bill figures received.');
  const f = {};
  BILL_FIELDS.forEach(k => { if (x[k] !== undefined && x[k] !== null) f[k] = x[k]; });
  ['periodFrom', 'periodTo'].forEach(k => {
    if (!/^\d{4}-\d\d-\d\d$/.test(String(f[k]))) throw httpError_(400, 'The bill period (reading dates) is missing.');
  });
  if (f.dueDate !== undefined && !/^\d{4}-\d\d-\d\d$/.test(String(f.dueDate))) delete f.dueDate;
  ['days', 'units', 'arrears', 'energy', 'fixed', 'fppas', 'tax', 'duty', 'total', 'payable'].forEach(k => {
    f[k] = Number(f[k]);
    if (!Number.isFinite(f[k])) throw httpError_(400, `The bill figure "${k}" is missing or not a number.`);
  });
  ['mdiKw', 'readingOld', 'readingNew', 'mf', 'security', 'subsidy'].forEach(k => { f[k] = Number.isFinite(Number(f[k])) ? Number(f[k]) : 0; });
  if (!(f.days > 0 && f.units >= 0)) throw httpError_(400, 'Days and units must be positive.');
  f.basis = String(f.basis || '').slice(0, 10);
  f.slabs = (Array.isArray(f.slabs) ? f.slabs : []).slice(0, 10).map(s => ({ units: Number(s.units), rate: Number(s.rate), amount: Number(s.amount) }));
  if (!f.slabs.length || f.slabs.some(s => ![s.units, s.rate, s.amount].every(Number.isFinite))) throw httpError_(400, 'The slab calculation lines are missing.');
  f.sundry = (Array.isArray(f.sundry) ? f.sundry : []).slice(0, 5).map(Number).filter(Number.isFinite);
  return f;
}

/** Start (ms) of the billing cycle whose readings match the bill's dates (±1 day), or null. */
function matchCycle_(f) {
  const bills = billsSorted_();
  const near = (ts, day) => Math.abs(ts - Date.parse(day + 'T00:00:00+05:30')) <= 1.5 * 86400e3;
  for (let i = 0; i + 1 < bills.length; i++) {
    if (near(bills[i].ts, f.periodFrom) && near(bills[i + 1].ts, f.periodTo)) return bills[i].ts;
  }
  return null;
}

/** Bills page → Uploaded bills: each bill with its own checks and, when linked, the app's figures for the cycle. */
function listBillDocs_(req, user) {
  const docs = billDocs_();
  const bills = billsSorted_();
  const corrections = corrections_().filter(c => c.active);
  const versions = tariffVersions_();
  const coverage = {};
  cycles_().forEach(c => { if (!c.current) coverage[c.start] = c.coverage; });
  const raw = docs.length && bills.length ? hourlyPoints_(bills[0].ts - APP.LEAD_HOURS * 3600e3) : [];
  const calib = [];
  const out = docs.map(d => {
    const check = Billing.checkDhbvnBill(d.fields, tariffAt_(versions, Date.parse(d.periodFrom)));
    const i = bills.findIndex(b => b.ts === d.cycleStart);
    let compare = null;
    if (i >= 0 && i + 1 < bills.length) {
      const calc = closedCycleCalc_(bills[i], bills[i + 1], raw, corrections, versions);
      if (calc) {
        compare = Billing.compareWithApp(d.fields, { units: calc.unitsSoFar, bill: calc.chargesSoFar });
        const loggerUnits = calc.unitsSoFar / (calc.tariff.meterFactor || 1);
        calib.push({ periodFrom: d.periodFrom, periodTo: d.periodTo, dhbvnUnits: d.fields.units, loggerUnits, coverage: coverage[d.cycleStart] || 0 });
      }
    }
    return {
      id: d.id, periodFrom: d.periodFrom, periodTo: d.periodTo, cycleStart: d.cycleStart, fields: d.fields,
      check: { linesAddUp: check.linesAddUp, payableAddsUp: check.payableAddsUp, slabsMatch: check.slabsMatch, right: check.right, lines: check.lines },
      compare, uploadedBy: d.uploadedBy, uploadedAt: d.uploadedAt,
    };
  });
  let calibration = null;
  if (user.role === 'admin') {
    const good = calib.filter(c => c.coverage >= 0.8);
    const current = versions.filter(v => v.from <= Date.now()).pop().tariff.meterFactor;
    calibration = { current, suggestion: Billing.meterCalibration(good), cycles: calib };
  }
  return { docs: out.reverse(), calibration };
}

/** The PDF itself, only through the app (no Drive link ever reaches the browser). */
function getBillFile_(req) {
  const d = billDocs_().find(x => x.id === String(req.id || ''));
  if (!d) throw httpError_(404, 'That bill is not there any more.');
  const blob = DriveApp.getFileById(d.fileId).getBlob();
  return { name: d.fileName, mimeType: 'application/pdf', base64: Utilities.base64Encode(blob.getBytes()) };
}

function deleteBillDoc_(req) {
  const d = billDocs_().find(x => x.id === String(req.id || ''));
  if (!d) throw httpError_(404, 'That bill is not there any more.');
  withLock_(() => tab_('BillDocs').getRange(d.row, 8).setValue('deleted'));
  trashFile_(d.fileId);
  return { id: d.id, details: `${d.periodFrom} → ${d.periodTo} (B ₹${d.fields.total}) removed` };
}

/** New tariff version with the calibrated meter factor, from a date (default: the current cycle). */
function applyMeterFactor_(req, user) {
  const factor = Number(req.factor);
  if (!(factor >= 0.9 && factor <= 1.1)) throw httpError_(400, 'The meter factor must be between 0.9 and 1.1.');
  const bills = billsSorted_();
  const from = Number(req.from) || (bills.length ? bills[bills.length - 1].ts : Date.now());
  const versions = tariffVersions_();
  const base = tariffAt_(versions, from);
  const rates = Object.assign({}, base, { meterFactor: factor });
  const id = 'v' + (versions.length + 1);
  addRow_(tab_('TariffVersions'), [id, rates.category, from, fmt_(from), JSON.stringify(rates), `Meter factor from ${req.cycles || 'uploaded'} DHBVN bills`, user.email, new Date()]);
  return { id, details: `meter factor ${base.meterFactor} → ${factor} from ${fmt_(from)} (tariff version ${id})` };
}

/** Arrears (A) and sundry (C) for a cycle from its confirmed DHBVN bill, used by the breakdown. */
function billExtras_(cycle) {
  if (!cycle) return {};
  const d = billDocs_().find(x => x.cycleStart === cycle.start);
  return d ? { arrears: d.fields.arrears, sundry: (d.fields.sundry || []).reduce((s, x) => s + x, 0), dhbvn: d.fields } : {};
}

function tariffAt_(versions, ms) {
  return versions.filter(v => v.from <= ms).pop().tariff;
}

/** The private folder for bill PDFs (created once, never shared). */
function billsFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('BILLS_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const folder = DriveApp.createFolder(`Power Plan bills (${APP.ENV})`);
  props.setProperty('BILLS_FOLDER_ID', folder.getId());
  return folder;
}

function trashFile_(fileId) {
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { console.error('Trash failed: ' + (e && e.message)); }
}

/** "2025-09-25" from a date cell or text (Sheets may have turned the text into a date). */
function isoDay_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v).replace(/^'/, '');
}
