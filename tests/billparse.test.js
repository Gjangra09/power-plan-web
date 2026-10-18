// G1: the bill reader gets every field of the 6 real DHBVN e-bills right.
// The texts are the bill-figures part of what pdf.js extracts from the real PDFs (anonymised:
// no name, address, account, mobile or meter number). The real PDFs stay off the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDhbvnBill } from '../js/billparse.js';

const dir = new URL('./fixtures/bill-text/', import.meta.url);
const { bills } = JSON.parse(fs.readFileSync(new URL('./fixtures/dhbvn-bills.json', import.meta.url), 'utf8'));

for (const b of bills) {
  const from = b.period.slice(0, 10);
  test(`G1 reads every field of the ${b.period} bill`, () => {
    const { fields, missing } = parseDhbvnBill(fs.readFileSync(new URL(`${from}.txt`, dir), 'utf8'));
    assert.deepEqual(missing, []);
    assert.equal(`${fields.periodFrom} to ${fields.periodTo}`, b.period);
    for (const k of ['days', 'units', 'basis', 'arrears', 'energy', 'fixed', 'fppas', 'tax', 'duty', 'total', 'payable']) {
      assert.equal(fields[k], b[k], k);
    }
    assert.deepEqual(fields.slabs, b.slabs);
    assert.deepEqual(fields.sundry, b.sundry);
    assert.ok(fields.readingNew > fields.readingOld && fields.mf === 1);
    assert.match(fields.dueDate, /^\d{4}-\d\d-\d\d$/);
  });
}

test('G1 the reader never picks up personal details, and says what is missing in a non-bill', () => {
  const r = parseDhbvnBill('Name: SOMEONE Account No: 1234567890\nAddress: SOMEWHERE\nhello');
  assert.ok(!JSON.stringify(r.fields).includes('SOMEONE') && !JSON.stringify(r.fields).includes('1234567890'));
  assert.ok(r.missing.includes('units') && r.missing.includes('payable') && r.missing.includes('slabs'));
});
