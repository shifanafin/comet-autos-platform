/*
 * An account month by month: what it held when each month began, what went
 * in and out in it, and what it held when it ended — the opening and closing
 * balances an accountant reads at every month end. Worked out from the
 * movements, never stored: each month opens on the last one's close.
 *
 * Pure: the cash and bank pages and the ledger use it alike.
 */

export interface Movement {
  /** YYYY-MM-DD. */
  date: string;
  /** The two columns shown — money in and out, or debit and credit — in fils. */
  a: number;
  b: number;
  /** What it does to the balance, in fils (+ raises it). */
  delta: number;
}

export interface MonthTotals {
  /** YYYY-MM. */
  month: string;
  /** The part of the month inside the period. */
  from: string;
  to: string;
  opening: number;
  a: number;
  b: number;
  closing: number;
}

const monthEnd = (month: string) => {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
};
const nextMonth = (month: string) => {
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * Every month from `from` to `to`, even one with nothing in it (it opens and
 * closes on the same figure). The first and last are cut to the period.
 */
export function monthByMonth(
  openingFils: number,
  movements: Movement[],
  from: string,
  to: string,
): MonthTotals[] {
  if (from > to) return [];
  const months: MonthTotals[] = [];
  let balance = openingFils;
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); month = nextMonth(month)) {
    const start = month === from.slice(0, 7) ? from : `${month}-01`;
    const end = month === to.slice(0, 7) ? to : monthEnd(month);
    const inMonth = movements.filter((m) => m.date >= start && m.date <= end);
    const a = inMonth.reduce((sum, m) => sum + m.a, 0);
    const b = inMonth.reduce((sum, m) => sum + m.b, 0);
    const closing = balance + inMonth.reduce((sum, m) => sum + m.delta, 0);
    months.push({ month, from: start, to: end, opening: balance, a, b, closing });
    balance = closing;
  }
  return months;
}
