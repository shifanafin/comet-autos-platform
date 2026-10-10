import type { Prisma } from '@/generated/prisma/client';
import type { AccountRole, AccountType, JournalSource } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { subLedgerOf } from '@/lib/accounting/sub-ledger';
import { filsToString, toFils } from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { resolvePeriod, type ResolvedPeriod } from '@/lib/finance/dashboard';
import { ensureChart, isCostOfSales } from '@/lib/accounting/chart';

/*
 * The statements, read from the general ledger — every figure the sum of
 * journal lines, so the trial balance, the ledger of each account, the
 * profit and loss and the balance sheet always agree with one another.
 *
 * Signs follow each account's normal side: assets and expenses are
 * positive when debited, liabilities, equity and income when credited. A
 * contra account (discounts given, under income) simply shows negative.
 *
 * The books are one set for the whole workshop, across its branches.
 */

export interface PeriodInput {
  period?: string;
  from?: string;
  to?: string;
}

const DEBIT_NORMAL: Record<AccountType, boolean> = {
  ASSET: true,
  EXPENSE: true,
  LIABILITY: false,
  EQUITY: false,
  REVENUE: false,
};

/**
 * Expense accounts that are the cost of what was sold, above gross profit:
 * those coded 5000–5099, and the system's own cost accounts wherever they
 * have been renumbered to.
 */
const COST_ROLES: AccountRole[] = ['COST_OF_PARTS', 'STOCK_ADJUSTMENTS'];
const costOfSales = (account: { type: AccountType; code: string; role: AccountRole | null }) =>
  account.type === 'EXPENSE' &&
  ((account.role !== null && COST_ROLES.includes(account.role)) || isCostOfSales(account));

const day = (value: string) => parseCalendarDate(value)!;

interface AccountTotals {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  role: AccountRole | null;
  isActive: boolean;
  debitFils: number;
  creditFils: number;
}

/** Each account's debits and credits between two dates (inclusive). */
async function accountTotals(
  organizationId: string,
  /**
   * `excludeClosing` leaves out year-end closing entries: a profit and loss
   * reports what was earned, not the entry that later moved it to retained
   * earnings.
   */
  range: { from?: Date; to: Date; excludeClosing?: boolean },
): Promise<AccountTotals[]> {
  const [accounts, sums] = await Promise.all([
    prisma.chartOfAccount.findMany({
      where: { organizationId },
      orderBy: { accountCode: 'asc' },
      select: {
        id: true,
        accountCode: true,
        accountName: true,
        accountType: true,
        role: true,
        isActive: true,
      },
    }),
    prisma.journalEntryLine.groupBy({
      by: ['chartOfAccountId'],
      where: {
        organizationId,
        journalEntry: {
          entryDate: { ...(range.from ? { gte: range.from } : {}), lte: range.to },
          ...(range.excludeClosing ? { sourceType: { not: 'YEAR_END_CLOSE' } } : {}),
        },
      },
      _sum: { debitAmount: true, creditAmount: true },
    }),
  ]);
  const byAccount = new Map(sums.map((row) => [row.chartOfAccountId, row._sum]));
  return accounts.map((account) => {
    const sum = byAccount.get(account.id);
    return {
      id: account.id,
      code: account.accountCode,
      name: account.accountName,
      type: account.accountType,
      role: account.role,
      isActive: account.isActive,
      debitFils: toFils(sum?.debitAmount?.toString() ?? '0'),
      creditFils: toFils(sum?.creditAmount?.toString() ?? '0'),
    };
  });
}

/** An account's balance on its normal side. */
const balanceOf = (account: Pick<AccountTotals, 'type' | 'debitFils' | 'creditFils'>) =>
  DEBIT_NORMAL[account.type]
    ? account.debitFils - account.creditFils
    : account.creditFils - account.debitFils;

const row = (account: AccountTotals, fils: number) => ({
  id: account.id,
  code: account.code,
  name: account.name,
  role: account.role,
  amount: filsToString(fils),
  fils,
});

// ─── Trial balance ──────────────────────────────────────────────────────────

export async function getTrialBalance(user: AuthenticatedUser, input: { asOf?: string } = {}) {
  requirePermission(user, 'reports.view');
  const asOf = input.asOf && parseCalendarDate(input.asOf) ? input.asOf : localDateString();
  const totals = await accountTotals(user.organizationId, { to: day(asOf) });
  const rows = totals
    .filter((account) => account.debitFils !== 0 || account.creditFils !== 0)
    .map((account) => {
      const net = account.debitFils - account.creditFils;
      return {
        id: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        debit: filsToString(Math.max(net, 0)),
        credit: filsToString(Math.max(-net, 0)),
      };
    });
  const debitFils = totals.reduce((sum, a) => sum + Math.max(a.debitFils - a.creditFils, 0), 0);
  const creditFils = totals.reduce((sum, a) => sum + Math.max(a.creditFils - a.debitFils, 0), 0);
  return {
    asOf,
    rows,
    totalDebit: filsToString(debitFils),
    totalCredit: filsToString(creditFils),
    balanced: debitFils === creditFils,
  };
}

export type TrialBalance = Awaited<ReturnType<typeof getTrialBalance>>;

// ─── Profit and loss ────────────────────────────────────────────────────────

export async function getLedgerProfitAndLoss(user: AuthenticatedUser, input: PeriodInput = {}) {
  requirePermission(user, 'reports.view');
  const period: ResolvedPeriod = resolvePeriod(input);
  const totals = await accountTotals(user.organizationId, {
    from: day(period.from),
    to: day(period.to),
    excludeClosing: true,
  });
  const moved = (account: AccountTotals) => account.debitFils !== 0 || account.creditFils !== 0;

  const income = totals
    .filter((a) => a.type === 'REVENUE' && moved(a))
    .map((a) => row(a, balanceOf(a)));
  const costRows = totals
    .filter((a) => costOfSales(a) && moved(a))
    .map((a) => row(a, balanceOf(a)));
  const expenses = totals
    .filter((a) => a.type === 'EXPENSE' && !costOfSales(a) && moved(a))
    .map((a) => row(a, balanceOf(a)))
    .sort((a, b) => b.fils - a.fils);

  const sum = (rows: { fils: number }[]) => rows.reduce((total, r) => total + r.fils, 0);
  const incomeFils = sum(income);
  const costFils = sum(costRows);
  const expenseFils = sum(expenses);
  const grossFils = incomeFils - costFils;
  const netFils = grossFils - expenseFils;
  return {
    period,
    income: { rows: income, total: filsToString(incomeFils) },
    costOfSales: { rows: costRows, total: filsToString(costFils) },
    grossProfit: filsToString(grossFils),
    expenses: { rows: expenses, total: filsToString(expenseFils) },
    netProfit: filsToString(netFils),
    netProfitFils: netFils,
  };
}

export type LedgerProfitAndLoss = Awaited<ReturnType<typeof getLedgerProfitAndLoss>>;

// ─── Balance sheet ──────────────────────────────────────────────────────────

export async function getBalanceSheet(user: AuthenticatedUser, input: { asOf?: string } = {}) {
  requirePermission(user, 'reports.view');
  const asOf = input.asOf && parseCalendarDate(input.asOf) ? input.asOf : localDateString();
  const totals = await accountTotals(user.organizationId, { to: day(asOf) });
  const pick = (type: AccountType) =>
    totals
      .filter((a) => a.type === type && (a.debitFils !== 0 || a.creditFils !== 0))
      .map((a) => row(a, balanceOf(a)));
  const assets = pick('ASSET');
  const liabilities = pick('LIABILITY');
  const equity = pick('EQUITY');
  // Profit not yet moved into retained earnings by a closing entry: all
  // income less all expenses to date.
  const earningsFils = totals.reduce(
    (sum, a) =>
      a.type === 'REVENUE' ? sum + balanceOf(a) : a.type === 'EXPENSE' ? sum - balanceOf(a) : sum,
    0,
  );
  const sum = (rows: { fils: number }[]) => rows.reduce((total, r) => total + r.fils, 0);
  const assetFils = sum(assets);
  const liabilityFils = sum(liabilities);
  const equityFils = sum(equity) + earningsFils;
  return {
    asOf,
    assets: { rows: assets, total: filsToString(assetFils) },
    liabilities: { rows: liabilities, total: filsToString(liabilityFils) },
    equity: {
      rows: equity,
      earnings: filsToString(earningsFils),
      total: filsToString(equityFils),
    },
    liabilitiesAndEquity: filsToString(liabilityFils + equityFils),
    balanced: assetFils === liabilityFils + equityFils,
  };
}

export type BalanceSheet = Awaited<ReturnType<typeof getBalanceSheet>>;

// ─── One account's ledger ───────────────────────────────────────────────────

/** Where a journal entry came from, for linking back to it. */
export interface EntrySource {
  type: JournalSource;
  id: string | null;
  /** The screen that shows the record. */
  href: string | null;
}

/** The screen behind each entry's record, for linking from the ledger and money pages. */
export async function sourceLinks(
  organizationId: string,
  entries: { sourceType: JournalSource; sourceId: string | null }[],
) {
  const paymentIds = entries
    .filter((e) => e.sourceType === 'PAYMENT' && e.sourceId)
    .map((e) => e.sourceId!);
  const payments = paymentIds.length
    ? await prisma.payment.findMany({
        where: { organizationId, id: { in: paymentIds } },
        select: { id: true, invoiceId: true },
      })
    : [];
  const invoiceOfPayment = new Map(payments.map((p) => [p.id, p.invoiceId]));
  // An application or refund of an advance opens the advance it belongs to.
  const [allocations, refunds] = await Promise.all(
    (['CUSTOMER_ADVANCE_ALLOCATION', 'CUSTOMER_ADVANCE_REFUND'] as const).map((type) => {
      const ids = entries
        .filter((e) => e.sourceType === type && e.sourceId)
        .map((e) => e.sourceId!);
      if (!ids.length) return Promise.resolve([] as { id: string; advanceId: string }[]);
      const where = { organizationId, id: { in: ids } };
      const select = { id: true, advanceId: true };
      return type === 'CUSTOMER_ADVANCE_ALLOCATION'
        ? prisma.customerAdvanceAllocation.findMany({ where, select })
        : prisma.customerAdvanceRefund.findMany({ where, select });
    }),
  );
  const advanceOf = new Map([...allocations, ...refunds].map((row) => [row.id, row.advanceId]));
  return (source: JournalSource, id: string | null): EntrySource => {
    const href = !id
      ? null
      : source === 'INVOICE' || source === 'INVOICE_DISCOUNT'
        ? `/finance/invoices/${id}`
        : source === 'PAYMENT'
          ? invoiceOfPayment.get(id)
            ? `/finance/invoices/${invoiceOfPayment.get(id)}`
            : null
          : source === 'EXPENSE'
            ? '/finance/expenses'
            : source === 'SUPPLIER_PAYMENT' || source === 'OWNER_REIMBURSEMENT'
              ? '/finance/payables'
              : source === 'STOCK_MOVEMENT'
                ? '/inventory/movements'
                : source === 'PURCHASE_ROUNDING' || source === 'PURCHASE_BILL'
                  ? `/inventory/purchases/${id}`
                  : source === 'CREDIT_NOTE' || source === 'CREDIT_NOTE_REFUND'
                    ? `/finance/credit-notes/${id}`
                    : source === 'FIXED_ASSET' || source === 'ASSET_DISPOSAL'
                      ? `/finance/fixed-assets/${id}`
                      : source === 'DEPRECIATION'
                        ? '/finance/fixed-assets'
                        : source === 'VAT_FILING' || source === 'VAT_PAYMENT'
                          ? '/finance/vat'
                          : source === 'PRIOR_PERIOD'
                            ? '/finance/accounting/prior-periods'
                            : source === 'FINAL_SETTLEMENT' || source === 'FINAL_SETTLEMENT_PAYMENT'
                              ? `/hr/settlements/${id}`
                              : source === 'CARD_COLLECTION' || source === 'PAYMENT_VOUCHER'
                                ? `/finance/payment-vouchers/${id}`
                                : source === 'MONEY_TRANSFER'
                                  ? '/finance/money/transfers'
                                  : source === 'OWNER_MONEY'
                                    ? '/finance/money/owner'
                                    : source === 'CUSTOMER_ADVANCE'
                                      ? `/finance/advances/${id}`
                                      : (source === 'CUSTOMER_ADVANCE_ALLOCATION' ||
                                            source === 'CUSTOMER_ADVANCE_REFUND') &&
                                          advanceOf.get(id)
                                        ? `/finance/advances/${advanceOf.get(id)}`
                                        : null;
    return { type: source, id, href };
  };
}

export async function getAccountLedger(
  user: AuthenticatedUser,
  accountId: string,
  input: PeriodInput = {},
) {
  requirePermission(user, 'accounting.view');
  const period = resolvePeriod(input);
  const account = await prisma.chartOfAccount.findFirst({
    where: { id: accountId, organizationId: user.organizationId },
    select: { id: true, accountCode: true, accountName: true, accountType: true, role: true },
  });
  if (!account) throw new NotFoundError('account');
  const from = day(period.from);
  const to = day(period.to);

  const [before, lines] = await Promise.all([
    prisma.journalEntryLine.aggregate({
      where: {
        organizationId: user.organizationId,
        chartOfAccountId: account.id,
        journalEntry: { entryDate: { lt: from } },
      },
      _sum: { debitAmount: true, creditAmount: true },
    }),
    prisma.journalEntryLine.findMany({
      where: {
        organizationId: user.organizationId,
        chartOfAccountId: account.id,
        journalEntry: { entryDate: { gte: from, lte: to } },
      },
      orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { createdAt: 'asc' } }],
      select: {
        id: true,
        debitAmount: true,
        creditAmount: true,
        description: true,
        journalEntry: {
          select: {
            id: true,
            entryNumber: true,
            entryDate: true,
            description: true,
            sourceType: true,
            sourceId: true,
            reversalOfJournalEntryId: true,
          },
        },
      },
    }),
  ]);
  const normal = DEBIT_NORMAL[account.accountType];
  const signed = (debit: number, credit: number) => (normal ? debit - credit : credit - debit);
  const openingFils = signed(
    toFils(before._sum.debitAmount?.toString() ?? '0'),
    toFils(before._sum.creditAmount?.toString() ?? '0'),
  );
  const link = await sourceLinks(
    user.organizationId,
    lines.map((line) => line.journalEntry),
  );

  let running = openingFils;
  const rows = lines.map((line) => {
    const debit = toFils(line.debitAmount.toString());
    const credit = toFils(line.creditAmount.toString());
    running += signed(debit, credit);
    return {
      id: line.id,
      entryId: line.journalEntry.id,
      entryNumber: line.journalEntry.entryNumber,
      date: line.journalEntry.entryDate,
      description: line.description ?? line.journalEntry.description ?? '',
      reversal: line.journalEntry.reversalOfJournalEntryId !== null,
      source: link(line.journalEntry.sourceType, line.journalEntry.sourceId),
      debit: debit ? filsToString(debit) : null,
      credit: credit ? filsToString(credit) : null,
      balance: filsToString(running),
    };
  });
  return {
    period,
    account: {
      id: account.id,
      code: account.accountCode,
      name: account.accountName,
      type: account.accountType,
      role: account.role,
    },
    opening: filsToString(openingFils),
    closing: filsToString(running),
    rows,
  };
}

export type AccountLedger = Awaited<ReturnType<typeof getAccountLedger>>;

// ─── The journal ────────────────────────────────────────────────────────────

export async function listJournal(
  user: AuthenticatedUser,
  input: PeriodInput & { source?: string; q?: string } = {},
  limit = 200,
  /** Rows to skip: the pages before the one shown. */
  offset = 0,
) {
  requirePermission(user, 'accounting.view');
  const period = resolvePeriod(input);
  const q = input.q?.trim();
  const source = (
    ['INVOICE', 'PAYMENT', 'EXPENSE', 'STOCK_MOVEMENT', 'SUPPLIER_PAYMENT', 'MANUAL'] as const
  ).find((value) => value === input.source);
  const where: Prisma.JournalEntryWhereInput = {
    organizationId: user.organizationId,
    entryDate: { gte: day(period.from), lte: day(period.to) },
    ...(source ? { sourceType: source } : {}),
    ...(q
      ? {
          OR: [
            { entryNumber: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [entries, total] = await Promise.all([
    prisma.journalEntry.findMany({
      where,
      orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
      skip: offset,
      take: limit,
      select: {
        id: true,
        entryNumber: true,
        entryDate: true,
        description: true,
        sourceType: true,
        sourceId: true,
        reversalOfJournalEntryId: true,
        reversalOf: { select: { entryNumber: true } },
        reversals: { select: { entryNumber: true } },
        createdBy: { select: { fullName: true } },
        lines: {
          orderBy: [{ debitAmount: 'desc' }],
          select: {
            id: true,
            debitAmount: true,
            creditAmount: true,
            description: true,
            customer: { select: { name: true } },
            supplier: { select: { name: true } },
            chartOfAccount: { select: { id: true, accountCode: true, accountName: true } },
          },
        },
      },
    }),
    prisma.journalEntry.count({ where }),
  ]);
  const link = await sourceLinks(user.organizationId, entries);
  return {
    /** Every row the search and filters match, not only the page shown. */
    total,
    period,
    entries: entries.map((entry) => ({
      ...entry,
      source: link(entry.sourceType, entry.sourceId),
      total: filsToString(
        entry.lines.reduce((sum, line) => sum + toFils(line.debitAmount.toString()), 0),
      ),
    })),
  };
}

export type JournalList = Awaited<ReturnType<typeof listJournal>>;

// ─── Accounts to choose from ────────────────────────────────────────────────

export interface AccountChoice {
  id: string;
  code: string;
  name: string;
}

/**
 * The accounts forms offer, making sure the system accounts exist first:
 *   income   where an invoice line's amount goes (discounts given excluded);
 *   money    the cash, bank and card accounts payments go into or come from;
 *   all      every active account, for entries made by hand.
 */
export async function getAccountChoices(user: AuthenticatedUser) {
  await prisma.$transaction((tx) => ensureChart(tx, user.organizationId));
  const accounts = await prisma.chartOfAccount.findMany({
    where: { organizationId: user.organizationId, isActive: true },
    orderBy: { accountCode: 'asc' },
    select: {
      id: true,
      accountCode: true,
      accountName: true,
      accountType: true,
      role: true,
      isPaymentAccount: true,
      subLedger: true,
    },
  });
  const choice = (a: (typeof accounts)[number]): AccountChoice => ({
    id: a.id,
    code: a.accountCode,
    name: a.accountName,
  });
  return {
    income: accounts
      .filter((a) => a.accountType === 'REVENUE' && a.role !== 'SALES_DISCOUNTS')
      .map(choice),
    money: accounts.filter((a) => a.isPaymentAccount).map(choice),
    all: accounts.map((a) => ({ ...choice(a), type: a.accountType, party: subLedgerOf(a) })),
  };
}

export type AccountChoices = Awaited<ReturnType<typeof getAccountChoices>>;

// ─── Monthly profit (the dashboard's trend) ─────────────────────────────────

/**
 * Revenue, cost of sales, expenses and net profit for each of the twelve
 * calendar months ending with `endMonth` ("2026-10"), from the journal — the
 * same accounts and rules as the profit and loss, so the trend never disagrees
 * with the statement.
 */
export async function getMonthlyProfit(
  user: AuthenticatedUser,
  endMonth = localDateString().slice(0, 7),
) {
  requirePermission(user, 'reports.view');
  const [endYear, endMonthNumber] = endMonth.split('-').map(Number);
  const months = Array.from({ length: 12 }, (_, index) =>
    new Date(Date.UTC(endYear, endMonthNumber - 12 + index, 1)).toISOString().slice(0, 7),
  );
  const from = day(`${months[0]}-01`);
  const to = new Date(Date.UTC(endYear, endMonthNumber, 0));

  const [accounts, lines] = await Promise.all([
    prisma.chartOfAccount.findMany({
      where: { organizationId: user.organizationId, accountType: { in: ['REVENUE', 'EXPENSE'] } },
      select: { id: true, accountCode: true, accountType: true, role: true },
    }),
    prisma.journalEntryLine.findMany({
      where: {
        organizationId: user.organizationId,
        chartOfAccount: { accountType: { in: ['REVENUE', 'EXPENSE'] } },
        journalEntry: { entryDate: { gte: from, lte: to }, sourceType: { not: 'YEAR_END_CLOSE' } },
      },
      select: {
        chartOfAccountId: true,
        debitAmount: true,
        creditAmount: true,
        journalEntry: { select: { entryDate: true } },
      },
    }),
  ]);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const buckets = new Map(months.map((month) => [month, { revenue: 0, cost: 0, expense: 0 }]));
  for (const line of lines) {
    const account = byId.get(line.chartOfAccountId);
    const bucket = buckets.get(line.journalEntry.entryDate.toISOString().slice(0, 7));
    if (!account || !bucket) continue;
    const debit = toFils(line.debitAmount.toString());
    const credit = toFils(line.creditAmount.toString());
    if (account.accountType === 'REVENUE') bucket.revenue += credit - debit;
    else if (
      costOfSales({ type: account.accountType, code: account.accountCode, role: account.role })
    )
      bucket.cost += debit - credit;
    else bucket.expense += debit - credit;
  }
  return months.map((month) => {
    const bucket = buckets.get(month)!;
    const net = bucket.revenue - bucket.cost - bucket.expense;
    return {
      month,
      label: new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-AE', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      revenueFils: bucket.revenue,
      costsFils: bucket.cost + bucket.expense,
      netFils: net,
      revenue: filsToString(bucket.revenue),
      costs: filsToString(bucket.cost + bucket.expense),
      net: filsToString(net),
    };
  });
}

export type MonthlyProfit = Awaited<ReturnType<typeof getMonthlyProfit>>;
