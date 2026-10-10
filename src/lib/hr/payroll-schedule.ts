/*
 * When payroll runs by itself — pure rules, no database.
 *
 * From the 1st of each month the app calculates the month just ended, so
 * every day's attendance and leave is in. Only months that start on or
 * after the books' first day: the days before belong to the months entered
 * as totals (lib/accounting/prior-periods.ts), and a run for them would
 * count those salaries twice. Never an older month: a month the workshop
 * skipped is its own decision, not the app's.
 */

/** "YYYY-MM": the month to calculate today, or null when there is none. */
export function automaticPayrollMonth(today: string, booksStart: string | null): string | null {
  if (!booksStart) return null;
  const [year, month] = today.split('-').map(Number);
  const last = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
  return last >= booksStart ? last.slice(0, 7) : null;
}
