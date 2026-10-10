/*
 * UAE leave, overtime and final-settlement rules — pure functions, no
 * database. Every payroll figure comes from here, so the rules can be read,
 * tested and changed in one place. Money in fils, days as numbers, dates as
 * "YYYY-MM-DD" (calendar days, UAE time). The full write-up, with the legal
 * basis, is docs/hr/payroll-and-leave.md.
 *
 * Federal Decree-Law 33 of 2021 (Labour Law) and Cabinet Resolution 1 of 2022.
 *
 *   A day's wage          monthly ÷ 30 (the MOHRE convention), for unpaid days,
 *                         half-pay days, overtime, unused leave and gratuity.
 *   Service               calendar days employed, less unpaid leave and
 *                         unexcused absence — they earn neither leave nor
 *                         gratuity (Art. 29, 51).
 *   Annual leave          none usable in the first 6 months; then 2 days per
 *                         month of service; from 1 year, 30 days a year,
 *                         earned day by day (Art. 29). Days beyond the
 *                         balance are unpaid.
 *   Sick leave            after probation, 90 days a year: 15 full pay, 30
 *                         half pay, 45 unpaid; unpaid during probation (Art. 31).
 *   Maternity             45 days full pay, 15 half (Art. 30).
 *   Parental              5 days full pay (Art. 32).
 *   Bereavement           up to 5 days full pay (Art. 32).
 *   Study                 10 days a year full pay after 2 years (Art. 32).
 *   Overtime              hours beyond the normal day: +25%; 22:00–04:00, the
 *                         rest day or a public holiday: +50% (Art. 19, 28).
 *   Deductions            a hand deduction (advance, penalty) at most 50% of
 *                         the month's wage (Art. 25).
 *   Gratuity on leaving   21 days' basic a year for 5 years, 30 after, at most
 *                         two years' basic; nothing under 1 year (Art. 51).
 *   Unused leave          paid on leaving at basic pay (Art. 29).
 */

export const DAY_DIVISOR = 30;
const DAY_MS = 86_400_000;
const YEAR = 365;
const MONTH = YEAR / 12;

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
const daysBetween = (from: string, to: string) =>
  Math.round((asDate(to).getTime() - asDate(from).getTime()) / DAY_MS);
const round2 = (value: number) => Math.round(value * 100) / 100;

// ─── Service ────────────────────────────────────────────────────────────────

/** Days of service from the first day of work to `asOf`, both counted, less days that don't count. */
export function countedServiceDays(hireDate: string, asOf: string, excludedDays = 0): number {
  const calendar = daysBetween(hireDate, asOf) + 1;
  return Math.max(0, calendar - excludedDays);
}

// ─── Annual leave ───────────────────────────────────────────────────────────

/** Months of service after which annual leave can be taken. */
export const ANNUAL_LEAVE_AFTER_DAYS = Math.ceil(MONTH * 6);

/** Annual leave days earned by `serviceDays` of counted service (Art. 29). */
export function annualLeaveEarned(serviceDays: number): number {
  if (serviceDays < ANNUAL_LEAVE_AFTER_DAYS) return 0;
  if (serviceDays < YEAR) return round2((2 * serviceDays) / MONTH);
  return round2((30 * serviceDays) / YEAR);
}

/** What has built up but can't be taken yet — the first 6 months. */
export function annualLeaveAccruing(serviceDays: number): number {
  return serviceDays < ANNUAL_LEAVE_AFTER_DAYS ? round2((2 * serviceDays) / MONTH) : 0;
}

export interface LeaveBalanceInput {
  /** Counted service to the day asked about. */
  serviceDays: number;
  /** A balance carried in on a date, and the counted service on that date. */
  opening?: { days: number; serviceDays: number } | null;
  /** Annual leave days taken on full pay (since the opening, if any). */
  takenDays: number;
}

/** Annual leave earned, taken, and what is left — never below zero once taken beyond. */
export function annualLeaveBalance(input: LeaveBalanceInput) {
  const earned = input.opening
    ? input.opening.days +
      annualLeaveEarned(input.serviceDays) -
      annualLeaveEarned(input.opening.serviceDays)
    : annualLeaveEarned(input.serviceDays);
  const balance = round2(earned - input.takenDays);
  return {
    earned: round2(earned),
    taken: round2(input.takenDays),
    balance,
    accruing: annualLeaveAccruing(input.serviceDays),
  };
}

// ─── How a leave is paid ────────────────────────────────────────────────────

export type LeaveKind =
  'ANNUAL' | 'SICK' | 'UNPAID' | 'OTHER' | 'MATERNITY' | 'PARENTAL' | 'BEREAVEMENT' | 'STUDY';

export interface LeaveSplitContext {
  type: LeaveKind;
  days: number;
  /** Counted service on the first day of the leave. */
  serviceDays: number;
  inProbation: boolean;
  /** Annual leave balance before this leave (may be negative). */
  annualBalance: number;
  /** Paid days of this type already taken in the 12 months before the leave. */
  usedFull: number;
  usedHalf: number;
}

export interface LeaveSplit {
  full: number;
  half: number;
  unpaid: number;
  /** Why some days are unpaid or half paid, in words — or null. */
  note: string | null;
}

/** How many full-pay and half-pay days each type gives a year. */
const ALLOWANCE: Record<LeaveKind, { full: number; half: number }> = {
  ANNUAL: { full: 0, half: 0 }, // from the balance instead
  SICK: { full: 15, half: 30 },
  MATERNITY: { full: 45, half: 15 },
  PARENTAL: { full: 5, half: 0 },
  BEREAVEMENT: { full: 5, half: 0 },
  STUDY: { full: 10, half: 0 },
  UNPAID: { full: 0, half: 0 },
  OTHER: { full: Number.POSITIVE_INFINITY, half: 0 }, // paid at the company's discretion
};

/** Splits a leave's days into full pay, half pay and unpaid, in that order. */
export function splitLeave(ctx: LeaveSplitContext): LeaveSplit {
  const days = Math.max(0, Math.floor(ctx.days));
  const take = (full: number, half: number, note: string | null): LeaveSplit => {
    const f = Math.max(0, Math.min(days, Math.floor(full)));
    const h = Math.max(0, Math.min(days - f, Math.floor(half)));
    const unpaid = days - f - h;
    return { full: f, half: h, unpaid, note: unpaid || h ? note : null };
  };

  switch (ctx.type) {
    case 'UNPAID':
      return {
        full: 0,
        half: 0,
        unpaid: days,
        note: 'Unpaid leave: not paid, and not counted as service.',
      };
    case 'OTHER':
      return take(days, 0, null);
    case 'ANNUAL':
      if (ctx.serviceDays < ANNUAL_LEAVE_AFTER_DAYS) {
        return take(
          0,
          0,
          'Annual leave can be taken after 6 months of service: these days are unpaid.',
        );
      }
      return take(
        Math.max(0, ctx.annualBalance),
        0,
        `Only ${Math.max(0, Math.floor(ctx.annualBalance))} day(s) of annual leave are left: the rest is unpaid.`,
      );
    case 'SICK':
      if (ctx.inProbation) {
        return take(0, 0, 'Sick leave during probation is unpaid.');
      }
      return take(
        ALLOWANCE.SICK.full - ctx.usedFull,
        ALLOWANCE.SICK.half - ctx.usedHalf,
        'Sick leave: 15 days a year on full pay, then 30 on half pay, then unpaid.',
      );
    case 'STUDY':
      if (ctx.serviceDays < 2 * YEAR) {
        return take(0, 0, 'Study leave is paid after 2 years of service: these days are unpaid.');
      }
      return take(
        ALLOWANCE.STUDY.full - ctx.usedFull,
        0,
        'Study leave: 10 days a year on full pay.',
      );
    default: {
      const allowance = ALLOWANCE[ctx.type];
      return take(
        allowance.full - ctx.usedFull,
        allowance.half - ctx.usedHalf,
        ctx.type === 'MATERNITY'
          ? 'Maternity leave: 45 days on full pay, then 15 on half pay, then unpaid.'
          : `${ctx.type === 'PARENTAL' ? 'Parental' : 'Bereavement'} leave: up to 5 days on full pay.`,
      );
    }
  }
}

/**
 * The leave's full, half and unpaid days that fall in [from, to]. Days are
 * paid in order from the first: full pay, then half pay, then unpaid.
 */
export function splitWithin(
  leaveStart: string,
  split: { full: number; half: number; unpaid: number },
  from: string,
  to: string,
) {
  const total = split.full + split.half + split.unpaid;
  const a = Math.max(0, daysBetween(leaveStart, from));
  const b = Math.min(total - 1, daysBetween(leaveStart, to));
  const overlap = (start: number, end: number) =>
    Math.max(0, Math.min(end, b) - Math.max(start, a) + 1);
  if (b < a) return { full: 0, half: 0, unpaid: 0 };
  return {
    full: overlap(0, split.full - 1),
    half: overlap(split.full, split.full + split.half - 1),
    unpaid: overlap(split.full + split.half, total - 1),
  };
}

// ─── Pay ────────────────────────────────────────────────────────────────────

/** A day's wage: monthly ÷ 30. */
export const dailyWageFils = (monthlyFils: number) => monthlyFils / DAY_DIVISOR;

/** What unpaid and half-pay days take off the month's pay (basic + allowances). */
export function leaveDeductionFils(
  monthlyGrossFils: number,
  unpaidDays: number,
  halfPayDays: number,
) {
  return Math.round(dailyWageFils(monthlyGrossFils) * (unpaidDays + halfPayDays / 2));
}

export type OvertimeRateKind = 'NORMAL' | 'NIGHT' | 'REST_DAY' | 'HOLIDAY';

/** +25% on a working day; +50% at night, on the rest day or a public holiday. */
export const overtimeRate = (kind: OvertimeRateKind) => (kind === 'NORMAL' ? 1.25 : 1.5);

/** Overtime pay: hours × (basic ÷ 30 ÷ normal hours) × the rate. */
export function overtimePayFils(
  hours: number,
  basicMonthlyFils: number,
  normalHoursPerDay: number,
  kind: OvertimeRateKind,
) {
  const hourly = dailyWageFils(basicMonthlyFils) / normalHoursPerDay;
  return Math.round(hours * hourly * overtimeRate(kind));
}

/** The most a hand-entered deduction may take: half the month's wage (Art. 25). */
export const maxOtherDeductionFils = (monthWageFils: number) => Math.floor(monthWageFils / 2);

// ─── Overtime from attendance ───────────────────────────────────────────────

const UAE_OFFSET_MS = 4 * 60 * 60 * 1000;
const NIGHT_FROM = 22 * 60;
const NIGHT_TO = 4 * 60;

/** Minutes of [start, end) that fall between 22:00 and 04:00 UAE time. */
export function nightMinutes(start: Date, end: Date): number {
  let minutes = 0;
  for (let t = start.getTime(); t < end.getTime(); t += 60_000) {
    const local = new Date(t + UAE_OFFSET_MS);
    const minuteOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (minuteOfDay >= NIGHT_FROM || minuteOfDay < NIGHT_TO) minutes += 1;
  }
  return minutes;
}

/** Rounded down to the quarter hour; under 15 minutes is nothing. */
const quarterHours = (minutes: number) => Math.floor(minutes / 15) / 4;

/**
 * Overtime a day's check-in and check-out suggest, by kind. On the rest day
 * or a holiday every hour worked is overtime; otherwise the hours beyond the
 * normal day, the night part of them at the night rate. A manager approves
 * (and may change) each before it is paid.
 */
export function suggestOvertime(input: {
  clockIn: Date;
  clockOut: Date;
  normalHoursPerDay: number;
  restDay: boolean;
  holiday: boolean;
}): { kind: OvertimeRateKind; hours: number }[] {
  const worked = Math.max(0, (input.clockOut.getTime() - input.clockIn.getTime()) / 60_000);
  if (input.holiday || input.restDay) {
    const hours = quarterHours(worked);
    return hours > 0 ? [{ kind: input.holiday ? 'HOLIDAY' : 'REST_DAY', hours }] : [];
  }
  const extra = worked - input.normalHoursPerDay * 60;
  if (extra < 15) return [];
  const night = Math.min(extra, nightMinutes(input.clockIn, input.clockOut));
  const out: { kind: OvertimeRateKind; hours: number }[] = [];
  const normalHours = quarterHours(extra - night);
  const nightHours = quarterHours(night);
  if (normalHours > 0) out.push({ kind: 'NORMAL', hours: normalHours });
  if (nightHours > 0) out.push({ kind: 'NIGHT', hours: nightHours });
  return out;
}

// ─── Leaving ────────────────────────────────────────────────────────────────

/** End-of-service gratuity on leaving: nothing under a year of counted service (Art. 51). */
export function gratuityOnLeavingFils(serviceDays: number, basicMonthlyFils: number): number {
  if (serviceDays < YEAR || basicMonthlyFils <= 0) return 0;
  const years = serviceDays / YEAR;
  const days = years <= 5 ? 21 * years : 21 * 5 + 30 * (years - 5);
  return Math.min(Math.round((basicMonthlyFils * days) / DAY_DIVISOR), basicMonthlyFils * 24);
}

/** Unused annual leave paid on leaving, at basic pay (Art. 29). */
export function leaveEncashmentFils(balanceDays: number, basicMonthlyFils: number): number {
  return balanceDays > 0 ? Math.round(dailyWageFils(basicMonthlyFils) * balanceDays) : 0;
}

/** The value of unused leave, for the provision: the same as paying it out today. */
export const leaveLiabilityFils = leaveEncashmentFils;
