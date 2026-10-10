import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { filsToString, toFils } from '@/lib/money';
import { emptyToNull } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { getLedgerProfitAndLoss } from '@/lib/accounting/reports';
import { gratuityEarnedFils } from '@/lib/hr/gratuity';
import {
  addDays,
  corporateTaxDue,
  corporateTaxEstimateFils,
  daysBetween,
  financialYearOf,
  lastDayOfMonth,
  lastEndedYear,
  smallBusinessReliefPossible,
  vatPeriods,
  type FinancialYear,
  type FinancialYearRule,
} from '@/lib/compliance/rules';

/*
 * The tax & accounting calendar: what the company has to do, and by when —
 * its VAT returns, its corporate tax, the month's routine (salaries, the
 * bank, depreciation, closing the month), and anything still to set up.
 *
 * Each item reads the books for whether it is done, so the list is never a
 * to-do the workshop keeps by hand: file the return here and it shows filed.
 *
 * The dates it works from are the company's own — its financial year, its
 * VAT periods from the FTA certificate, its licence — entered once on the
 * calendar itself (`saveCompanyDates`).
 */

const day = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const optionalDate = z
  .string()
  .trim()
  .optional()
  .refine((value) => !value || (DATE.test(value) && parseCalendarDate(value)), 'Choose a date.');

const datesSchema = z.object({
  financialYearEndMonth: z
    .string()
    .trim()
    .optional()
    .refine((value) => !value || /^(?:[1-9]|1[0-2])$/.test(value), 'Choose a month.'),
  firstFinancialYearEnd: optionalDate,
  vatFirstPeriodStart: optionalDate,
  vatFirstPeriodEnd: optionalDate,
  vatPeriodMonths: z
    .string()
    .trim()
    .optional()
    .refine((value) => !value || value === '1' || value === '3', 'Choose monthly or quarterly.'),
  corporateTaxNumber: z
    .string()
    .trim()
    .max(30)
    .optional()
    .refine(
      (value) => !value || /^\d{15}$/.test(value.replace(/[\s-]/g, '')),
      'A corporate tax TRN is 15 digits. Enter digits only.',
    ),
  tradeLicenceNumber: z.string().trim().max(40).optional(),
  tradeLicenceExpiry: optionalDate,
  mohreEstablishmentId: z
    .string()
    .trim()
    .max(30)
    .optional()
    .refine(
      (value) => !value || /^\d{13}$/.test(value.replace(/[\s-]/g, '')),
      'The MOHRE establishment number is 13 digits.',
    ),
  wpsRoutingCode: z
    .string()
    .trim()
    .max(20)
    .optional()
    .refine(
      (value) => !value || /^\d{9}$/.test(value.replace(/[\s-]/g, '')),
      'A routing code is 9 digits — the bank gives it.',
    ),
  requestKey: z.string().optional(),
});

const DATE_FIELDS = {
  financialYearEndMonth: true,
  firstFinancialYearEnd: true,
  vatFirstPeriodStart: true,
  vatFirstPeriodEnd: true,
  vatPeriodMonths: true,
  corporateTaxNumber: true,
  tradeLicenceNumber: true,
  tradeLicenceExpiry: true,
  mohreEstablishmentId: true,
  wpsRoutingCode: true,
} as const;

/** The company's dates, as the form shows them. */
export async function getCompanyDates(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.view');
  return readCompanyDates(user.organizationId);
}

/** The company's dates for the calendar and the reminder job. No permission check: callers check. */
export async function readCompanyDates(organizationId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      ...DATE_FIELDS,
      taxNumber: true,
      isVatRegistered: true,
      openingBalanceDate: true,
      booksClosedThrough: true,
    },
  });
  if (!org) throw new NotFoundError('workshop');
  return {
    financialYearEndMonth: org.financialYearEndMonth,
    firstFinancialYearEnd: day(org.firstFinancialYearEnd),
    vatFirstPeriodStart: day(org.vatFirstPeriodStart),
    vatFirstPeriodEnd: day(org.vatFirstPeriodEnd),
    vatPeriodMonths: org.vatPeriodMonths,
    corporateTaxNumber: org.corporateTaxNumber,
    tradeLicenceNumber: org.tradeLicenceNumber,
    tradeLicenceExpiry: day(org.tradeLicenceExpiry),
    mohreEstablishmentId: org.mohreEstablishmentId,
    wpsRoutingCode: org.wpsRoutingCode,
    taxNumber: org.taxNumber,
    isVatRegistered: org.isVatRegistered,
    booksStart: day(org.openingBalanceDate),
    booksClosedThrough: day(org.booksClosedThrough),
  };
}

export type CompanyDates = Awaited<ReturnType<typeof readCompanyDates>>;

/** Saves the company's dates. Nothing already booked changes. */
export async function saveCompanyDates(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(datesSchema, rawInput);
  requirePermission(user, 'settings.edit');

  const vatStart = emptyToNull(input.vatFirstPeriodStart);
  const vatEnd = emptyToNull(input.vatFirstPeriodEnd);
  if (Boolean(vatStart) !== Boolean(vatEnd)) {
    throw new DomainError(
      'Enter both the first day and the last day of the first VAT period.',
      vatStart ? 'vatFirstPeriodEnd' : 'vatFirstPeriodStart',
    );
  }
  if (vatStart && vatEnd && vatEnd < vatStart) {
    throw new DomainError('The period ends before it starts.', 'vatFirstPeriodEnd');
  }
  if (vatStart && vatEnd && daysBetween(vatStart, vatEnd) > 366) {
    throw new DomainError(
      'A VAT period is at most a few months. Check the dates on the certificate.',
      'vatFirstPeriodEnd',
    );
  }
  const months = input.vatPeriodMonths ? Number(input.vatPeriodMonths) : null;
  if (vatStart && !months) {
    throw new DomainError('Say whether returns are quarterly or monthly.', 'vatPeriodMonths');
  }
  const endMonth = input.financialYearEndMonth ? Number(input.financialYearEndMonth) : null;
  const firstYearEnd = emptyToNull(input.firstFinancialYearEnd);
  if (firstYearEnd && !endMonth) {
    throw new DomainError('Choose the month the financial year ends.', 'financialYearEndMonth');
  }
  if (firstYearEnd && endMonth && Number(firstYearEnd.slice(5, 7)) !== endMonth) {
    throw new DomainError(
      'The first year should end in the same month as every later year.',
      'firstFinancialYearEnd',
    );
  }
  if (
    firstYearEnd &&
    firstYearEnd !==
      lastDayOfMonth(Number(firstYearEnd.slice(0, 4)), Number(firstYearEnd.slice(5, 7)))
  ) {
    throw new DomainError(
      'A financial year ends on the last day of a month.',
      'firstFinancialYearEnd',
    );
  }

  const asDate = (value: string | null) => (value ? new Date(`${value}T00:00:00Z`) : null);
  const data = {
    financialYearEndMonth: endMonth,
    firstFinancialYearEnd: asDate(firstYearEnd),
    vatFirstPeriodStart: asDate(vatStart),
    vatFirstPeriodEnd: asDate(vatEnd),
    vatPeriodMonths: months,
    corporateTaxNumber: emptyToNull(input.corporateTaxNumber)?.replace(/[\s-]/g, '') ?? null,
    tradeLicenceNumber: emptyToNull(input.tradeLicenceNumber),
    tradeLicenceExpiry: asDate(emptyToNull(input.tradeLicenceExpiry)),
    mohreEstablishmentId: emptyToNull(input.mohreEstablishmentId)?.replace(/[\s-]/g, '') ?? null,
    wpsRoutingCode: emptyToNull(input.wpsRoutingCode)?.replace(/[\s-]/g, '') ?? null,
  };

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'organization.company_dates');
    const before = await tx.organization.findUnique({
      where: { id: user.organizationId },
      select: DATE_FIELDS,
    });
    if (!before) throw new NotFoundError('workshop');
    await tx.organization.update({ where: { id: user.organizationId }, data });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'organization.company_dates_updated',
      entityType: 'Organization',
      entityId: user.organizationId,
      beforeData: before,
      afterData: data,
    });
    await settleRequestKey(tx, user, rawInput, user.organizationId);
    return { id: user.organizationId };
  });
}

// ── The calendar ─────────────────────────────────────────────────────────

/** done · to do now · late · coming up · nothing to do · information missing. */
export type ItemState = 'done' | 'todo' | 'late' | 'upcoming' | 'none' | 'missing';

export interface CalendarItem {
  key: string;
  title: string;
  /** In plain words: what it is and what to do. */
  detail: string;
  state: ItemState;
  /** The deadline, when there is one. */
  due?: string | null;
  href?: string;
  action?: string;
}

export interface VatPeriodRow {
  from: string;
  to: string;
  due: string;
  state: ItemState;
  /** What stands: "Filed — VAT paid", "Return due in 12 days"… */
  status: string;
  netVat: string | null;
  href: string;
  /** Ends before these books began: filed (or not) outside the app. */
  beforeBooks: boolean;
}

const vatHref = (from: string, to: string) => `/finance/vat?period=custom&from=${from}&to=${to}`;

const inDays = (today: string, due: string) => {
  const days = daysBetween(today, due);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return `in ${days} days`;
  return `${-days} day${days === -1 ? '' : 's'} ago`;
};

/** The calendar as the person sees it — with the year's profit if they may see reports. */
export async function getComplianceCalendar(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.view');
  const canSeeProfit = hasPermission(user, 'reports.view');
  return buildCompliance(
    user.organizationId,
    localDateString(),
    canSeeProfit
      ? (from, to) => getLedgerProfitAndLoss(user, { period: 'custom', from, to })
      : null,
  );
}

type ProfitOf = (
  from: string,
  to: string,
) => Promise<{ income: { total: string }; netProfit: string; netProfitFils: number }>;

/**
 * Everything the calendar and the reminders work from, for one workshop on
 * one day. `profitOf` adds each year's figures; the reminder job leaves it out.
 */
export async function buildCompliance(
  organizationId: string,
  today: string,
  profitOf: ProfitOf | null = null,
) {
  const dates = await readCompanyDates(organizationId);
  const [year, month] = today.split('-').map(Number);
  // The last month that has ended: its routine is what is due now.
  const lastMonthEnd = lastDayOfMonth(year, month - 1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
  const lastMonthLabel = new Date(`${lastMonthStart}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const org = organizationId;

  const [
    filings,
    reconciled,
    payroll,
    activeEmployees,
    paidEmployees,
    team,
    assets,
    depreciated,
    bankAccounts,
    priorMonths,
  ] = await Promise.all([
    prisma.vatFiling.findMany({
      where: { organizationId: org },
      orderBy: { periodTo: 'asc' },
      select: {
        periodFrom: true,
        periodTo: true,
        netVat: true,
        filedOn: true,
        settledOn: true,
        outsideBooks: true,
      },
    }),
    prisma.bankReconciliation.findFirst({
      where: { organizationId: org, status: 'COMPLETED' },
      orderBy: { statementDate: 'desc' },
      select: { statementDate: true },
    }),
    prisma.payroll.findFirst({
      where: {
        organizationId: org,
        status: { not: 'CANCELLED' },
        periodEnd: { gte: new Date(`${lastMonthStart}T00:00:00Z`) },
      },
      orderBy: { periodEnd: 'asc' },
      select: { status: true, periodEnd: true, id: true },
    }),
    prisma.employee.count({ where: { organizationId: org, isActive: true } }),
    prisma.employee.count({
      where: {
        organizationId: org,
        isActive: true,
        salaries: {
          some: {
            effectiveFrom: { lte: new Date(`${today}T00:00:00Z`) },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(`${today}T00:00:00Z`) } }],
          },
        },
      },
    }),
    prisma.employee.findMany({
      where: { organizationId: org, isActive: true },
      select: {
        hireDate: true,
        wpsPersonCode: true,
        wpsAgentCode: true,
        salaryIban: true,
        salaries: { orderBy: { effectiveFrom: 'desc' }, take: 1, select: { basicSalary: true } },
      },
    }),
    prisma.fixedAsset.count({ where: { organizationId: org, status: 'ACTIVE' } }),
    prisma.assetDepreciation.findFirst({
      where: { organizationId: org },
      orderBy: { periodEnd: 'desc' },
      select: { periodEnd: true },
    }),
    prisma.chartOfAccount.count({
      where: { organizationId: org, isActive: true, role: 'BANK' },
    }),
    // Months before the books, entered as totals.
    prisma.priorPeriodSummary.findMany({
      where: { organizationId: org },
      orderBy: { periodFrom: 'asc' },
      select: { periodFrom: true, periodTo: true },
    }),
  ]);
  const priorRanges = priorMonths.map((row) => ({
    from: day(row.periodFrom)!,
    to: day(row.periodTo)!,
  }));
  /** Whether every day from `from` to `to` is in a month entered as totals. */
  const priorCovers = (from: string, to: string) => {
    let covered = 0;
    for (const range of priorRanges) {
      const start = range.from > from ? range.from : from;
      const end = range.to < to ? range.to : to;
      if (end >= start) covered += daysBetween(start, end) + 1;
    }
    return covered >= daysBetween(from, to) + 1;
  };
  // The first day the books know about: the earliest month entered, or the opening date.
  const knownFrom =
    priorRanges[0] && (!dates.booksStart || priorRanges[0].from < dates.booksStart)
      ? priorRanges[0].from
      : dates.booksStart;

  // ── VAT ──
  const vatSet = Boolean(
    dates.vatFirstPeriodStart && dates.vatFirstPeriodEnd && dates.vatPeriodMonths,
  );
  const filingFor = (to: string) => filings.find((f) => day(f.periodTo) === to);
  const vat: VatPeriodRow[] = !vatSet
    ? []
    : vatPeriods(
        {
          firstStart: dates.vatFirstPeriodStart!,
          firstEnd: dates.vatFirstPeriodEnd!,
          months: dates.vatPeriodMonths!,
        },
        today,
      ).map((period) => {
        const filing = filingFor(period.to);
        const href = vatHref(period.from, period.to);
        const booksStart = dates.booksStart;
        const beforeBooks = Boolean(booksStart && period.to < booksStart);
        // Part of the period is before the books: those weeks must be added first.
        const partBefore =
          booksStart &&
          period.from < booksStart &&
          period.to >= booksStart &&
          !priorCovers(period.from, addDays(booksStart, -1))
            ? ` Sales and purchases from ${period.from} to ${addDays(booksStart, -1)} are before these books began — add them before filing.`
            : '';
        if (filing) {
          const net = filing.netVat.toString();
          const owed = !net.startsWith('-') && toFils(net) > 0;
          const settled = Boolean(filing.settledOn);
          return {
            ...period,
            href,
            netVat: net,
            beforeBooks,
            state: !owed || settled ? 'done' : today > period.due ? 'late' : 'todo',
            status:
              (filing.outsideBooks ? 'Filed in EmaraTax before these books — ' : '') +
              (!owed
                ? settled
                  ? 'Filed — refund received'
                  : net.startsWith('-')
                    ? 'Filed — refund due from the FTA'
                    : 'Filed — nothing to pay'
                : settled
                  ? 'Filed and paid'
                  : today > period.due
                    ? `Filed — payment was due ${inDays(today, period.due)}`
                    : `Filed — pay by the due date (${inDays(today, period.due)})`),
          } satisfies VatPeriodRow;
        }
        if (period.from > today) {
          return {
            ...period,
            href,
            netVat: null,
            beforeBooks,
            state: 'upcoming',
            status: 'Not started yet',
          } satisfies VatPeriodRow;
        }
        if (period.to >= today) {
          return {
            ...period,
            href,
            netVat: null,
            beforeBooks,
            state: 'upcoming',
            status: `Running now — file after ${period.to}.${partBefore}`,
          } satisfies VatPeriodRow;
        }
        return {
          ...period,
          href,
          netVat: null,
          beforeBooks,
          state: today > period.due ? 'late' : 'todo',
          status: beforeBooks
            ? `Before these books began, so the app can't tell whether it was filed. Check EmaraTax (VAT → VAT Returns): if it shows Submitted, record it here; if not, file it now — it was due ${inDays(today, period.due)}.`
            : (today > period.due
                ? `Not filed — was due ${inDays(today, period.due)}.`
                : `Return due ${inDays(today, period.due)}.`) + partBefore,
        } satisfies VatPeriodRow;
      });

  // ── Financial year & corporate tax ──
  const rule: FinancialYearRule | null = dates.financialYearEndMonth
    ? {
        endMonth: dates.financialYearEndMonth,
        firstYearEnd: dates.firstFinancialYearEnd,
        booksStart: knownFrom,
      }
    : null;
  const currentYear: FinancialYear | null = rule ? financialYearOf(today, rule) : null;
  const endedYear: FinancialYear | null = rule ? lastEndedYear(today, rule) : null;
  const canSeeProfit = profitOf !== null;
  const yearFigures = async (fy: FinancialYear | null) => {
    if (!fy || !profitOf) return null;
    const from = fy.start ?? dates.booksStart ?? `${fy.end.slice(0, 4)}-01-01`;
    const to = fy.end < today ? fy.end : today;
    const pl = await profitOf(from, to);
    const revenueFils = toFils(pl.income.total.replace('-', ''));
    return {
      from,
      to,
      revenue: pl.income.total,
      profit: pl.netProfit,
      estimate: filsToString(corporateTaxEstimateFils(pl.netProfitFils)),
      reliefPossible: smallBusinessReliefPossible(fy.end, revenueFils),
    };
  };
  const [currentFigures, endedFigures] = await Promise.all([
    yearFigures(currentYear),
    yearFigures(endedYear),
  ]);
  const corporateTax = currentYear
    ? {
        registered: Boolean(dates.corporateTaxNumber),
        current: { ...currentYear, due: corporateTaxDue(currentYear.end), figures: currentFigures },
        ended: endedYear
          ? { ...endedYear, due: corporateTaxDue(endedYear.end), figures: endedFigures }
          : null,
      }
    : null;

  // ── This month's routine ──
  const monthly: CalendarItem[] = [];
  if (activeEmployees > 0) {
    const paid = payroll && day(payroll.periodEnd)! <= lastMonthEnd && payroll.status === 'PAID';
    monthly.push({
      key: 'payroll',
      title: `Salaries for ${lastMonthLabel}`,
      detail: paid
        ? 'Run, approved and paid — the salary cost is in the books.'
        : payroll && day(payroll.periodEnd)! <= lastMonthEnd
          ? `The payroll is ${payroll.status.toLowerCase()} but not yet marked paid. Pay the team (through WPS) and record the payment.`
          : 'Run the payroll for the month, approve it and record the payment. UAE salaries are paid through WPS and are late 15 days after they fall due.',
      state: paid ? 'done' : 'todo',
      href: payroll ? `/hr/payroll/${payroll.id}` : '/hr/payroll',
      action: paid ? 'Open payroll' : 'Run payroll',
    });
  }
  const reconciledTo = day(reconciled?.statementDate);
  monthly.push({
    key: 'bank',
    title: `Check the bank for ${lastMonthLabel}`,
    detail:
      bankAccounts === 0
        ? 'No bank account is set up in the chart of accounts.'
        : reconciledTo && reconciledTo >= lastMonthEnd
          ? `Matched against the bank statement up to ${reconciledTo}.`
          : 'Download the bank statement for the month and tick off each line against the books. Anything the bank shows that the books do not (bank charges, a customer transfer) gets recorded.',
    state: reconciledTo && reconciledTo >= lastMonthEnd ? 'done' : 'todo',
    href: '/finance/bank-reconciliation',
    action: 'Reconcile',
  });
  const depreciatedTo = day(depreciated?.periodEnd);
  monthly.push({
    key: 'depreciation',
    title: `Depreciation for ${lastMonthLabel}`,
    detail:
      assets === 0
        ? 'No equipment is recorded. If the workshop owns lifts, machines, tools, computers or a vehicle, add them as fixed assets so their cost is spread over the years they are used.'
        : depreciatedTo && depreciatedTo >= lastMonthEnd
          ? `Booked up to ${depreciatedTo}.`
          : 'Run depreciation for the month — one click; it spreads the cost of the equipment over its life.',
    state: assets === 0 ? 'none' : depreciatedTo && depreciatedTo >= lastMonthEnd ? 'done' : 'todo',
    href: '/finance/fixed-assets',
    action: assets === 0 ? 'Add equipment' : 'Run depreciation',
  });
  const closedTo = dates.booksClosedThrough;
  monthly.push({
    key: 'close',
    title: `Close ${lastMonthLabel}`,
    detail:
      closedTo && closedTo >= lastMonthEnd
        ? `The books are closed through ${closedTo}: nothing can be changed in that time by mistake.`
        : 'Once the salaries, the bank and depreciation are done, close the month so nothing in it changes by mistake. A closed month can be reopened with a reason.',
    state: closedTo && closedTo >= lastMonthEnd ? 'done' : 'todo',
    href: '/finance/accounting?view=journal',
    action: 'Close the month',
  });

  // ── Set-up ──
  const setup: CalendarItem[] = [
    {
      key: 'trn',
      title: 'VAT registration number (TRN)',
      detail: dates.taxNumber
        ? `Recorded — printed on every tax invoice.`
        : 'Printed on every tax invoice. It is on the VAT registration certificate in EmaraTax.',
      state: dates.taxNumber ? 'done' : 'missing',
      href: '/settings',
      action: 'Settings',
    },
    {
      key: 'vat-periods',
      title: 'VAT return periods',
      detail: vatSet
        ? `First period ${dates.vatFirstPeriodStart} to ${dates.vatFirstPeriodEnd}, then every ${dates.vatPeriodMonths === 1 ? 'month' : 'three months'}.`
        : 'The FTA decides your VAT periods. In EmaraTax open VAT → your VAT registration certificate: it shows the first tax period and whether returns are quarterly. Enter them below.',
      state: vatSet ? 'done' : 'missing',
    },
    {
      key: 'year',
      title: 'Financial year',
      detail: currentYear
        ? `This year ends ${currentYear.end}.`
        : 'The 12 months the company reports its profit for. It is written in the Memorandum of Association, and on the corporate tax registration in EmaraTax. Most UAE companies use 1 January to 31 December.',
      state: currentYear ? 'done' : 'missing',
    },
    {
      key: 'ct',
      title: 'Corporate tax registration',
      detail: dates.corporateTaxNumber
        ? 'Recorded.'
        : 'Every UAE company must register for corporate tax in EmaraTax, even when no tax is due — there is a fine for registering late. Once registered, enter the number below.',
      state: dates.corporateTaxNumber ? 'done' : 'missing',
    },
    {
      key: 'licence',
      title: 'Trade licence',
      detail: dates.tradeLicenceExpiry
        ? daysBetween(today, dates.tradeLicenceExpiry) < 0
          ? `Expired on ${dates.tradeLicenceExpiry} — renew it with the DED (Dubai Economy and Tourism).`
          : `Valid until ${dates.tradeLicenceExpiry}.`
        : 'Enter the licence number and its expiry date so the renewal shows here a month ahead.',
      state: !dates.tradeLicenceExpiry
        ? 'missing'
        : daysBetween(today, dates.tradeLicenceExpiry) < 0
          ? 'late'
          : daysBetween(today, dates.tradeLicenceExpiry) <= 30
            ? 'todo'
            : 'done',
      due: dates.tradeLicenceExpiry,
    },
    {
      key: 'opening',
      title: 'Opening balances',
      detail: dates.booksStart
        ? `The books start on ${dates.booksStart}: what was in the bank and the cash box, owed and owing, on that day.`
        : 'What the business had and owed on the day these books start — the cash, the bank, stock, customers who owed, suppliers owed.',
      state: dates.booksStart ? 'done' : 'missing',
      href: '/finance/accounting/opening-balances',
      action: 'Opening balances',
    },
  ];
  // VAT quarters that began before the books need those months' totals.
  if (dates.booksStart && vatSet && dates.vatFirstPeriodStart! < dates.booksStart) {
    const dayBefore = addDays(dates.booksStart, -1);
    const done = priorCovers(dates.vatFirstPeriodStart!, dayBefore);
    setup.push({
      key: 'prior-months',
      title: 'Months before these books',
      detail: done
        ? `Totals entered from ${priorRanges[0]?.from} to ${dayBefore}: the VAT returns and the year's profit include them.`
        : `VAT began on ${dates.vatFirstPeriodStart} but these books on ${dates.booksStart}. Enter each month's totals from then (and from the first month of your first tax year) — the VAT returns and the corporate tax return need them.`,
      state: done ? 'done' : 'missing',
      href: '/finance/accounting/prior-periods',
      action: 'Enter the months',
    });
  }
  if (activeEmployees > 0) {
    setup.push({
      key: 'salaries',
      title: 'Salaries',
      detail:
        paidEmployees === activeEmployees
          ? 'Every active employee has a salary set.'
          : `${activeEmployees - paidEmployees} of ${activeEmployees} active employee${activeEmployees === 1 ? ' has' : 's have'} no salary set, so the payroll cannot pay them.`,
      state: paidEmployees === activeEmployees ? 'done' : 'missing',
      href: '/hr/employees',
      action: 'Employees',
    });
    const noBank = team.filter((e) => !e.wpsPersonCode || !e.wpsAgentCode || !e.salaryIban).length;
    const companyWps = Boolean(dates.mohreEstablishmentId && dates.wpsRoutingCode);
    setup.push({
      key: 'wps',
      title: 'Salary payment details (WPS)',
      detail:
        companyWps && noBank === 0
          ? 'The company and every employee have their WPS details: the salary file can be made each month.'
          : [
              companyWps
                ? null
                : 'Enter the MOHRE establishment number and the paying bank’s routing code below.',
              noBank
                ? `${noBank} employee${noBank === 1 ? '' : 's'} still need${noBank === 1 ? 's' : ''} a MOHRE person code, routing code and IBAN (on their page, beside the salary).`
                : null,
            ]
              .filter(Boolean)
              .join(' '),
      state: companyWps && noBank === 0 ? 'done' : 'missing',
      href: '/hr/employees',
      action: 'Employees',
    });
    // Gratuity earned before these books began belongs in the opening balances.
    if (dates.booksStart) {
      const dayBefore = addDays(dates.booksStart, -1);
      const earnedFils = team.reduce((sum, e) => {
        const hired = day(e.hireDate)!;
        const basic = e.salaries[0] ? toFils(e.salaries[0].basicSalary.toString()) : 0;
        return hired <= dayBefore ? sum + gratuityEarnedFils(hired, dayBefore, basic) : sum;
      }, 0);
      if (earnedFils > 0) {
        setup.push({
          key: 'gratuity-opening',
          title: 'End-of-service owed when the books began',
          detail: `The team had already earned about ${filsToString(earnedFils)} AED in gratuity by ${dayBefore}. Enter it in opening balances as "Provision for end-of-service benefits" — payroll adds each month's part from then on.`,
          state: 'todo',
          href: '/finance/accounting/opening-balances',
          action: 'Opening balances',
        });
      }
    }
  }

  // ── Deadlines, soonest first ──
  const deadlines: CalendarItem[] = [];
  for (const period of vat) {
    if (period.state === 'todo' || period.state === 'late') {
      deadlines.push({
        key: `vat-${period.to}`,
        title: `VAT return ${period.from} – ${period.to}`,
        detail: period.status,
        state: period.state,
        due: period.due,
        href: period.href,
        action: 'Open the return',
      });
    } else if (period.state === 'upcoming' && period.from <= today) {
      deadlines.push({
        key: `vat-${period.to}`,
        title: `VAT return ${period.from} – ${period.to}`,
        detail: `The period ends ${period.to}; file and pay from ${addDays(period.to, 1)}.`,
        state: 'upcoming',
        due: period.due,
        href: period.href,
        action: 'See it so far',
      });
    }
  }
  if (corporateTax?.ended && corporateTax.ended.end < today) {
    deadlines.push({
      key: 'ct-ended',
      title: `Corporate tax return for the year ended ${corporateTax.ended.end}`,
      detail:
        'File the return and pay any tax in EmaraTax. Close the year here first, so the profit is final.',
      state: daysBetween(today, corporateTax.ended.due) < 0 ? 'late' : 'todo',
      due: corporateTax.ended.due,
      href: '/finance/accounting/year-end',
      action: 'Year-end closing',
    });
  }
  if (corporateTax) {
    deadlines.push({
      key: 'ct-current',
      title: `Financial year ends ${corporateTax.current.end}`,
      detail: `Close the year after it ends. Its corporate tax return is due by ${corporateTax.current.due}.`,
      state: 'upcoming',
      due: corporateTax.current.end,
    });
  }
  if (dates.tradeLicenceExpiry && daysBetween(today, dates.tradeLicenceExpiry) <= 60) {
    deadlines.push({
      key: 'licence',
      title: 'Trade licence renewal',
      detail: 'Renew with Dubai Economy and Tourism before it expires.',
      state: daysBetween(today, dates.tradeLicenceExpiry) < 0 ? 'late' : 'todo',
      due: dates.tradeLicenceExpiry,
    });
  }
  deadlines.sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));

  return {
    today,
    dates,
    vat: { configured: vatSet, periods: vat },
    corporateTax,
    canSeeProfit,
    monthly,
    setup,
    deadlines,
    lastMonthLabel,
  };
}

export type ComplianceCalendar = Awaited<ReturnType<typeof getComplianceCalendar>>;
