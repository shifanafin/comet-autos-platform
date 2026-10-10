/*
 * End-of-service gratuity — UAE Labour Law (Federal Decree-Law 33 of 2021),
 * as pure rules: no database. Money in fils, dates as "YYYY-MM-DD".
 *
 *   21 days' basic salary for each of the first five years of service,
 *   30 days' basic salary for each year after,
 *   parts of a year in proportion, and never more than two years' salary.
 *   A day's basic salary is the monthly basic ÷ 30.
 *
 * Nothing is payable to someone who leaves before a full year. The books
 * still set it aside from the first day — it is earned as the work is done,
 * and almost everyone stays past the year — and an amount set aside for
 * someone who leaves early is released then.
 *
 * Each payroll books the month's increase (lib/hr/payroll.ts), so the
 * provision always stands at what the whole team would be owed if every one
 * of them left at the end of the month.
 */

const DAY_MS = 86_400_000;
const days = (from: string, to: string) =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS,
  );

/** Years of service from the first day of work to `asOf`, both counted. */
export function serviceYears(hireDate: string, asOf: string): number {
  const served = days(hireDate, asOf) + 1;
  return served > 0 ? served / 365 : 0;
}

/** The days of basic salary earned for `years` of service. */
export function gratuityDays(years: number): number {
  if (years <= 0) return 0;
  return years <= 5 ? 21 * years : 21 * 5 + 30 * (years - 5);
}

/** What someone on `basicMonthlyFils` has earned in gratuity by `asOf`. */
export function gratuityEarnedFils(
  hireDate: string,
  asOf: string,
  basicMonthlyFils: number,
): number {
  if (basicMonthlyFils <= 0) return 0;
  const earned = Math.round((basicMonthlyFils * gratuityDays(serviceYears(hireDate, asOf))) / 30);
  return Math.min(earned, basicMonthlyFils * 24);
}

/**
 * The gratuity set aside for `serviceDays` of counted service (unpaid leave
 * and absence excluded, Art. 51) — accrued from the first day, as the
 * provision. Paying it on leaving waits for a full year
 * (lib/hr/leave-rules.ts gratuityOnLeavingFils).
 */
export function gratuityForServiceDaysFils(serviceDays: number, basicMonthlyFils: number): number {
  if (basicMonthlyFils <= 0 || serviceDays <= 0) return 0;
  const earned = Math.round((basicMonthlyFils * gratuityDays(serviceDays / 365)) / 30);
  return Math.min(earned, basicMonthlyFils * 24);
}
