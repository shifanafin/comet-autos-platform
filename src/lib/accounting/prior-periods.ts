import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { filsToString, toFils } from '@/lib/money';
import { emptyToNull } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { syncPosting } from '@/lib/accounting/journal';
import { addDays, lastDayOfMonth, vatPeriods } from '@/lib/compliance/rules';

/*
 * Months before these books began, as totals — one row a month, read off
 * the invoice book, the supplier bills and the bank statement.
 *
 * The books start on the opening balance date, but the first tax year and
 * the VAT quarters began earlier. With these rows the year's profit and loss
 * (for the corporate tax return) and the VAT returns covering those months
 * are complete. Each row is booked as one summary entry
 * (lib/accounting/prior-period-rules.ts): its income and costs, balanced
 * against opening balance equity, never the bank.
 *
 * A month containing the books' first day covers only the days before it.
 * A row is changed by removing it (its entry is reversed) and entering it again.
 */

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const money = z
  .string()
  .trim()
  .optional()
  .refine((value) => !value || MONEY.test(value), 'Enter an amount like 1250.00.');

const summarySchema = z.object({
  month: z
    .string({ error: 'Choose the month.' })
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose the month.'),
  sales: money,
  salesVat: money,
  partsBought: money,
  costsWithVat: money,
  purchasesVat: money,
  costsWithoutVat: money,
  salaries: money,
  note: z.string().trim().max(300).optional(),
  requestKey: z.string().optional(),
});

const removeSchema = z.object({
  reason: z
    .string({ error: 'Say why it is being removed.' })
    .trim()
    .min(3, 'Say why it is being removed.')
    .max(300),
  requestKey: z.string().optional(),
});

const fils = (value: { toString(): string } | null | undefined) =>
  value ? toFils(value.toString()) : 0;
const amount = (value: string | undefined) => (value ? toFils(value) : 0);
const day = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00Z`);

/** VAT can't be more than 5% of what it was charged on (one dirham of rounding allowed). */
const vatTooHigh = (vatFils: number, baseFils: number) =>
  vatFils > Math.round(baseFils * 0.05) + 100;

/** Re-books every month: the latest carries the stock left when the books began. */
async function rebookAll(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
  const rows = await tx.priorPeriodSummary.findMany({
    where: { organizationId },
    orderBy: { periodFrom: 'asc' },
    select: { id: true },
  });
  for (const row of rows) await syncPosting(tx, organizationId, 'PRIOR_PERIOD', row.id, userId);
}

/** The months entered, their totals, and how they sit with the opening VAT. */
export async function getPriorPeriods(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.view');
  const organizationId = user.organizationId;
  const [organization, rows, vatAccounts] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: {
        openingBalanceDate: true,
        vatFirstPeriodStart: true,
        vatFirstPeriodEnd: true,
        vatPeriodMonths: true,
      },
    }),
    prisma.priorPeriodSummary.findMany({
      where: { organizationId },
      orderBy: { periodFrom: 'asc' },
      include: { recordedBy: { select: { fullName: true } } },
    }),
    prisma.chartOfAccount.findMany({
      where: { organizationId, role: { in: ['VAT_OUTPUT', 'VAT_INPUT'] } },
      select: { id: true, role: true },
    }),
  ]);
  const booksStart = day(organization.openingBalanceDate);

  const months = rows.map((row) => {
    const sales = fils(row.sales);
    const costs =
      fils(row.partsBought) +
      fils(row.costsWithVat) +
      fils(row.costsWithoutVat) +
      fils(row.salaries);
    return {
      id: row.id,
      from: day(row.periodFrom)!,
      to: day(row.periodTo)!,
      sales: filsToString(sales),
      salesVat: filsToString(fils(row.salesVat)),
      partsBought: filsToString(fils(row.partsBought)),
      costsWithVat: filsToString(fils(row.costsWithVat)),
      purchasesVat: filsToString(fils(row.purchasesVat)),
      costsWithoutVat: filsToString(fils(row.costsWithoutVat)),
      salaries: filsToString(fils(row.salaries)),
      profit: sales - costs < 0 ? `-${filsToString(costs - sales)}` : filsToString(sales - costs),
      note: row.note,
      recordedBy: row.recordedBy.fullName,
    };
  });
  const sum = (
    key:
      | 'sales'
      | 'salesVat'
      | 'partsBought'
      | 'costsWithVat'
      | 'purchasesVat'
      | 'costsWithoutVat'
      | 'salaries',
  ) => filsToString(rows.reduce((total, row) => total + fils(row[key]), 0));

  // The VAT period open when the books began: its VAT so far belongs in the
  // opening balances (Output VAT payable, Input VAT recoverable).
  let openingVat: null | {
    periodFrom: string;
    periodTo: string;
    expectedOutput: string;
    expectedInput: string;
    openingOutput: string;
    openingInput: string;
    matches: boolean;
  } = null;
  if (
    booksStart &&
    organization.vatFirstPeriodStart &&
    organization.vatFirstPeriodEnd &&
    organization.vatPeriodMonths
  ) {
    const dayBefore = addDays(booksStart, -1);
    const open = vatPeriods(
      {
        firstStart: day(organization.vatFirstPeriodStart)!,
        firstEnd: day(organization.vatFirstPeriodEnd)!,
        months: organization.vatPeriodMonths,
      },
      booksStart,
    ).find((period) => period.from <= dayBefore && period.to >= booksStart);
    if (open) {
      const inOpen = rows.filter((row) => day(row.periodFrom)! >= open.from);
      const expectedOutput = inOpen.reduce((total, row) => total + fils(row.salesVat), 0);
      const expectedInput = inOpen.reduce((total, row) => total + fils(row.purchasesVat), 0);
      const balance = async (role: 'VAT_OUTPUT' | 'VAT_INPUT') => {
        const account = vatAccounts.find((a) => a.role === role);
        if (!account) return 0;
        const sums = await prisma.journalEntryLine.aggregate({
          where: {
            organizationId,
            chartOfAccountId: account.id,
            journalEntry: { sourceType: 'OPENING_BALANCE' },
          },
          _sum: { debitAmount: true, creditAmount: true },
        });
        return fils(sums._sum.debitAmount) - fils(sums._sum.creditAmount);
      };
      const [outputDebit, inputDebit] = await Promise.all([
        balance('VAT_OUTPUT'),
        balance('VAT_INPUT'),
      ]);
      // Output VAT payable is a credit balance; input VAT recoverable a debit.
      const openingOutput = -outputDebit;
      const openingInput = inputDebit;
      openingVat = {
        periodFrom: open.from,
        periodTo: open.to,
        expectedOutput: filsToString(expectedOutput),
        expectedInput: filsToString(expectedInput),
        openingOutput:
          openingOutput < 0 ? `-${filsToString(-openingOutput)}` : filsToString(openingOutput),
        openingInput:
          openingInput < 0 ? `-${filsToString(-openingInput)}` : filsToString(openingInput),
        matches: openingOutput === expectedOutput && openingInput === expectedInput,
      };
    }
  }

  return {
    booksStart,
    vatStart: day(organization.vatFirstPeriodStart),
    months,
    totals: {
      sales: sum('sales'),
      salesVat: sum('salesVat'),
      partsBought: sum('partsBought'),
      costsWithVat: sum('costsWithVat'),
      purchasesVat: sum('purchasesVat'),
      costsWithoutVat: sum('costsWithoutVat'),
      salaries: sum('salaries'),
    },
    openingVat,
  };
}

export type PriorPeriods = Awaited<ReturnType<typeof getPriorPeriods>>;

/** Enters one month's totals and books them. */
export async function savePriorPeriod(user: AuthenticatedUser, rawInput: unknown) {
  requirePermission(user, 'accounting.create');
  const input = parseInput(summarySchema, rawInput);
  const [year, month] = input.month.split('-').map(Number);
  const values = {
    sales: amount(input.sales),
    salesVat: amount(input.salesVat),
    partsBought: amount(input.partsBought),
    costsWithVat: amount(input.costsWithVat),
    purchasesVat: amount(input.purchasesVat),
    costsWithoutVat: amount(input.costsWithoutVat),
    salaries: amount(input.salaries),
  };
  if (Object.values(values).every((value) => value === 0)) {
    throw new DomainError('Enter at least one amount for the month.', 'sales');
  }
  if (vatTooHigh(values.salesVat, values.sales)) {
    throw new DomainError('VAT on sales is 5% of them at most. Check the figure.', 'salesVat');
  }
  if (vatTooHigh(values.purchasesVat, values.partsBought + values.costsWithVat)) {
    throw new DomainError(
      'The VAT paid is 5% of the parts and costs with VAT at most. Check the figure.',
      'purchasesVat',
    );
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'prior_period.save');
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
      select: { openingBalanceDate: true, vatFirstPeriodStart: true },
    });
    const booksStart = day(organization.openingBalanceDate);
    if (!booksStart) {
      throw new DomainError(
        'Set the opening balances first: these are the months before them.',
        'month',
      );
    }
    const from = `${input.month}-01`;
    const monthEnd = lastDayOfMonth(year, month);
    const to = monthEnd < booksStart ? monthEnd : addDays(booksStart, -1);
    if (from >= booksStart) {
      throw new DomainError(
        `The books begin on ${booksStart}: this month is already in them. Record its invoices and expenses as usual.`,
        'month',
      );
    }
    const vatStart = day(organization.vatFirstPeriodStart);
    if ((values.salesVat || values.purchasesVat) && vatStart && to < vatStart) {
      throw new DomainError(
        `VAT registration began on ${vatStart}: there is no VAT before then. Enter the amounts with VAT 0.`,
        values.salesVat ? 'salesVat' : 'purchasesVat',
      );
    }
    const data = {
      sales: filsToString(values.sales),
      salesVat: filsToString(values.salesVat),
      partsBought: filsToString(values.partsBought),
      costsWithVat: filsToString(values.costsWithVat),
      purchasesVat: filsToString(values.purchasesVat),
      costsWithoutVat: filsToString(values.costsWithoutVat),
      salaries: filsToString(values.salaries),
    };
    let row;
    try {
      row = await tx.priorPeriodSummary.create({
        data: {
          organizationId: user.organizationId,
          periodFrom: asDate(from),
          periodTo: asDate(to),
          ...data,
          note: emptyToNull(input.note),
          recordedByUserId: user.id,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainError(
          'This month is already entered. Remove it first to enter it again.',
          'month',
        );
      }
      throw error;
    }
    await rebookAll(tx, user.organizationId, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'prior_period.recorded',
      entityType: 'PriorPeriodSummary',
      entityId: row.id,
      afterData: { periodFrom: from, periodTo: to, ...data, note: row.note },
    });
    await settleRequestKey(tx, user, rawInput, row.id);
    return { id: row.id };
  });
}

/** Removes a month's totals and reverses their entry. */
export async function removePriorPeriod(user: AuthenticatedUser, id: string, rawInput: unknown) {
  requirePermission(user, 'accounting.delete');
  const input = parseInput(removeSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'prior_period.remove');
    const row = await tx.priorPeriodSummary.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!row) throw new NotFoundError('month');
    await tx.priorPeriodSummary.delete({ where: { id: row.id } });
    // Its entry no longer counts: reversed. The rest re-booked (stock moves to the new latest).
    await syncPosting(tx, user.organizationId, 'PRIOR_PERIOD', row.id, user.id);
    await rebookAll(tx, user.organizationId, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'prior_period.removed',
      entityType: 'PriorPeriodSummary',
      entityId: row.id,
      beforeData: {
        periodFrom: day(row.periodFrom),
        periodTo: day(row.periodTo),
        sales: row.sales.toString(),
        salesVat: row.salesVat.toString(),
        partsBought: row.partsBought.toString(),
        costsWithVat: row.costsWithVat.toString(),
        purchasesVat: row.purchasesVat.toString(),
        costsWithoutVat: row.costsWithoutVat.toString(),
        salaries: row.salaries.toString(),
      },
      metadata: { reason: input.reason },
    });
    await settleRequestKey(tx, user, rawInput, row.id);
    return { id: row.id };
  });
}

/**
 * The months' totals that fall inside a VAT return period, for its boxes.
 * Each month sits in one VAT period, so a row counts when it lies wholly
 * inside the period asked for.
 */
export async function priorPeriodsWithin(organizationId: string, from: string, to: string) {
  const rows = await prisma.priorPeriodSummary.findMany({
    where: { organizationId, periodFrom: { gte: asDate(from) }, periodTo: { lte: asDate(to) } },
    orderBy: { periodFrom: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    from: day(row.periodFrom)!,
    to: day(row.periodTo)!,
    salesFils: fils(row.sales),
    salesVatFils: fils(row.salesVat),
    expensesFils: fils(row.partsBought) + fils(row.costsWithVat),
    purchasesVatFils: fils(row.purchasesVat),
  }));
}
