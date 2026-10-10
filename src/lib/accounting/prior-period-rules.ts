/*
 * How one month's totals from before the books are booked — pure rules, no
 * database. Money in fils.
 *
 *   Cr Sales                         the month's sales
 *   Dr Cost of sales — spare parts   the parts bought
 *   Dr Miscellaneous expenses        the other costs, with and without VAT
 *   Dr Salaries & wages              the salaries
 *   Dr Opening balance equity        the month's profit (Cr, for a loss)
 *
 * The profit goes to opening balance equity, not the bank: the opening
 * balances already hold what those months left behind (cash, stock,
 * customers owing). So the books gain the months' income and costs, for the
 * year's profit and loss, without counting any money twice.
 *
 * Parts still on the shelf when the books began were bought but not yet
 * used: the latest month carries that stock off the cost of parts (never
 * more than the parts bought in all the months). The VAT is not booked here
 * — it goes into the VAT return boxes, and VAT not yet filed when the books
 * began belongs in the opening balances.
 */

export interface PriorTotals {
  salesFils: number;
  partsFils: number;
  costsWithVatFils: number;
  costsWithoutVatFils: number;
  salariesFils: number;
}

export interface PriorPostingAmounts {
  sales: number;
  costOfParts: number;
  otherExpenses: number;
  salaries: number;
  /** Debit to opening balance equity: the profit (negative for a loss). */
  openingEquity: number;
}

/** The ledger amounts for one month; `stockFils` only on the latest month. */
export function priorPostingAmounts(totals: PriorTotals, stockFils = 0): PriorPostingAmounts {
  const costOfParts = totals.partsFils - stockFils;
  const otherExpenses = totals.costsWithVatFils + totals.costsWithoutVatFils;
  return {
    sales: totals.salesFils,
    costOfParts,
    otherExpenses,
    salaries: totals.salariesFils,
    openingEquity: totals.salesFils - costOfParts - otherExpenses - totals.salariesFils,
  };
}

/** The stock carried off the cost of parts: what was on hand, never more than was bought. */
export function stockCarried(stockOnHandFils: number, partsBoughtAllMonthsFils: number) {
  return Math.max(0, Math.min(stockOnHandFils, partsBoughtAllMonthsFils));
}
