/**
 * Unit tests for VAT on customer advances (lib/billing/advance-vat.ts):
 *
 *  - the VAT included in an amount paid, at 5%;
 *  - the VAT each application or refund releases adds up to exactly the
 *    advance's VAT once it is used up, whatever the rounding on the way;
 *  - money returned to the advance by a credit note puts its VAT back;
 *  - order is by date, then when recorded.
 *
 *   npx tsx --test tests/advance-vat-units.test.ts
 */
import './unit-env';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { vatIncluded, vatReleases } from '@/lib/billing/advance-vat';
import { toFils } from '@/lib/money';

const day = (d: number) => new Date(Date.UTC(2026, 9, d));
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, s));
const move = (id: string, amount: string, d = 1, s = 0) => ({
  id,
  fils: amount.startsWith('-') ? -toFils(amount.slice(1)) : toFils(amount),
  on: day(d),
  createdAt: at(s),
});
const total = (released: Map<string, number>) =>
  [...released.values()].reduce((sum, value) => sum + value, 0);

describe('the VAT included in an advance', () => {
  test('AED 3,000 at 5% is 2,857.14 + 142.86', () => {
    assert.equal(vatIncluded(toFils('3000'), '5.00'), toFils('142.86'));
  });
  test('AED 1,050 at 5% is 1,000 + 50', () => {
    assert.equal(vatIncluded(toFils('1050'), '5.00'), toFils('50.00'));
  });
  test('nothing at 0%, nothing on nothing', () => {
    assert.equal(vatIncluded(toFils('3000'), '0.00'), 0);
    assert.equal(vatIncluded(0, '5.00'), 0);
  });
});

describe('VAT released as the advance is used', () => {
  const advance = { amountFils: toFils('3000'), vatFils: toFils('142.86') };

  test('used up in three parts: the releases add up to exactly the VAT', () => {
    const released = vatReleases(advance, [
      move('a', '1000', 1, 1),
      move('b', '1000', 2, 2),
      move('c', '1000', 3, 3),
    ]);
    assert.equal(total(released), toFils('142.86'));
    // 47.62 · 47.62 · 47.62 = 142.86
    assert.deepEqual([...released.values()], [toFils('47.62'), toFils('47.62'), toFils('47.62')]);
  });

  test('part applied leaves the rest of the VAT on the advance', () => {
    const released = vatReleases(advance, [move('a', '1050')]);
    assert.equal(released.get('a'), toFils('50.00'));
  });

  test('money returned by a credit note puts its VAT back', () => {
    const released = vatReleases(advance, [move('a', '3000', 1, 1), move('b', '-1050', 2, 2)]);
    assert.equal(released.get('a'), toFils('142.86'));
    assert.equal(released.get('b'), -toFils('50.00'));
    assert.equal(total(released), toFils('92.86'), 'the VAT on the 1,950 still used');
  });

  test('in the order they happened, whatever order they are given in', () => {
    const forwards = vatReleases(advance, [move('a', '1000', 1), move('b', '2000', 2)]);
    const backwards = vatReleases(advance, [move('b', '2000', 2), move('a', '1000', 1)]);
    assert.deepEqual(forwards, backwards);
    assert.equal(total(forwards), toFils('142.86'));
  });

  test('an advance with no VAT releases none', () => {
    const released = vatReleases({ amountFils: toFils('500'), vatFils: 0 }, [move('a', '500')]);
    assert.equal(released.get('a'), 0);
  });
});
