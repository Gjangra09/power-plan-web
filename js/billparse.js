// Reads the figures of a DHBVN e-bill from its text (as pdf.js extracts it, one line per row).
// Pure: no DOM, no network; tested on the 6 real bills (tests/fixtures/bill-text, anonymised).
// Only bill figures are read; name, address, account and mobile number are never picked up.

const NUM = '(-?[\\d.]+)';
const money = s => (s == null ? null : Number(s));
const parts = s => (s == null ? [] : s.replace(/\s+/g, '').split('/').filter(x => x !== '').map(Number));
const iso = (d, m, y) => `${y}-${m}-${d}`;

/** {fields, missing: [field names not found]}. Amounts in ₹, dates "YYYY-MM-DD". */
export function parseDhbvnBill(text) {
  const t = String(text).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
  const g = re => { const m = t.match(re); return m ? m[1] : null; };
  const meter = t.match(/^\S+ (\d\d)\/(\d\d)\/(\d{4}) (\d\d)\/(\d\d)\/(\d{4}) (\d+) ([\d.]+) \(KW\) kWh ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) (\w+)/m);
  const slabText = t.slice(Math.max(0, t.indexOf('Slab Calculation')));
  const end = slabText.indexOf('Total (Energy Charges)');
  const slabs = [...(end > 0 ? slabText.slice(0, end) : '').matchAll(/^([\d.]+) ([\d.]+) ([\d.]+)$/gm)]
    .map(x => ({ units: Number(x[1]), rate: Number(x[2]), amount: Number(x[3]) }));
  const due = t.match(/Due Date: ?(\d\d)\/(\d\d)\/(\d{4})/);
  const fields = {
    periodFrom: meter && iso(meter[1], meter[2], meter[3]),
    periodTo: meter && iso(meter[4], meter[5], meter[6]),
    days: meter && Number(meter[7]),
    mdiKw: meter && Number(meter[8]),
    readingOld: meter && Number(meter[9]),
    readingNew: meter && Number(meter[10]),
    mf: meter && Number(meter[11]),
    units: meter && Number(meter[13]),
    basis: meter && meter[14],
    slabs,
    arrears: money(g(new RegExp(`Arrears Outstanding\\( ?\\) ?${NUM}`))),
    energy: money(g(new RegExp(`Energy Charges ${NUM}`))),
    fixed: parts(g(/Recon FC ([\d.\/-]+)/))[0] ?? null,
    fppas: money(g(new RegExp(`FPPAS@ ?\\d+ Paisa\\/Unit ${NUM}`))),
    tax: money(g(new RegExp(`\\[1\\+2\\+3\\] ${NUM}`))),
    duty: money(g(new RegExp(`Duty @ ?\\d+ Paisa\\/Unit ${NUM}`))),
    security: parts(g(/NE Charges ([\d.\/-]+)/))[0] ?? null,
    subsidy: parts(g(/Prepaid Rebate ([\d.\/-]+)/))[0] ?? null,
    total: money(g(new RegExp(`\\[1 To 7 \\] ${NUM}`))),
    sundry: parts(g(/Ebill Rebate\s+([\d.\/\s-]+?)\s*\n?Total Payable/)),
    payable: money(g(new RegExp(`Total Payable Amount \\[A\\+B\\+C\\] ${NUM}`))),
    dueDate: due && iso(due[1], due[2], due[3]),
  };
  const required = ['periodFrom', 'periodTo', 'days', 'units', 'arrears', 'energy', 'fixed', 'fppas', 'tax', 'duty', 'total', 'payable'];
  const missing = required.filter(k => fields[k] == null || Number.isNaN(fields[k]));
  if (!slabs.length) missing.push('slabs');
  return { fields, missing };
}
