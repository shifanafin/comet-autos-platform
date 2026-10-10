/**
 * Months before the books, entered as totals: how each is booked. Pure
 * rules — no database.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { priorPostingAmounts, stockCarried } from '@/lib/accounting/prior-period-rules';

const month = {
  salesFils: 20_000_00,
  partsFils: 6_000_00,
  costsWithVatFils: 2_000_00,
  costsWithoutVatFils: 500_00,
  salariesFils: 7_000_00,
};

describe('months before the books', () => {
  test('income and costs in full; the profit against opening balance equity, never the bank', () => {
    const amounts = priorPostingAmounts(month);
    assert.deepEqual(amounts, {
      sales: 20_000_00,
      costOfParts: 6_000_00,
      otherExpenses: 2_500_00,
      salaries: 7_000_00,
      openingEquity: 4_500_00,
    });
    // Debits equal credits: sales = costs + profit.
    assert.equal(
      amounts.costOfParts + amounts.otherExpenses + amounts.salaries + amounts.openingEquity,
      amounts.sales,
    );
  });

  test('a loss credits opening balance equity', () => {
    const amounts = priorPostingAmounts({ ...month, salesFils: 10_000_00 });
    assert.equal(amounts.openingEquity, -5_500_00);
  });

  test('parts still in stock when the books began come off the cost of parts', () => {
    const amounts = priorPostingAmounts(month, 1_500_00);
    assert.equal(amounts.costOfParts, 4_500_00);
    assert.equal(
      amounts.openingEquity,
      6_000_00,
      'the stock was not a cost, so the profit is higher',
    );
  });

  test('never more stock carried off than the parts bought in all the months', () => {
    assert.equal(stockCarried(9_000_00, 6_000_00), 6_000_00);
    assert.equal(stockCarried(1_500_00, 6_000_00), 1_500_00);
    assert.equal(stockCarried(-200_00, 6_000_00), 0);
  });
});
