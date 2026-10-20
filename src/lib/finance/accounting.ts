import { z } from 'zod';
import type { AccountType, InvoiceStatus, PaymentMethod } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { fixedSubLedger, subLedgerOf } from '@/lib/accounting/sub-ledger';
import { parseInput } from '@/lib/form-data';
import { filsToString, toFils } from '@/lib/money';
import { parseCalendarDate } from '@/lib/format';
import { resolvePeriod, type ResolvedPeriod } from '@/lib/finance/dashboard';
import { supplierPaidFils } from '@/lib/finance/supplier-balance';
import { withNetQuantities } from '@/lib/inventory/stock';

/*
 * The workshop's books, read from the records it already keeps.
 *
 * No journal is posted — every figure here is derived, on request, from
 * invoices, payments, parts fitted, expenses, supplier payments and payroll,
 * so it can never disagree with them. The rules, once:
 *
 * PROFIT & LOSS (accrual — when the work is billed, not when it is paid)
 *   Sales          tax invoices issued in the period, net of VAT, split into
 *                  parts, labour and other by their lines (a bill discount
 *                  spread over the lines). Pro-forma is not a sale.
 *   Cost of parts  what the parts fitted on those same invoiced jobs cost,
 *                  after any taken back — matched to the sale, not to the
 *                  day the part left the shelf.
 *   Expenses       recorded expenses dated in the period, by category, net
 *                  of VAT (VAT is recovered, not a cost).
 *   Salaries       approved and paid payroll runs for months ending in the
 *                  period, at net pay.
 *
 * CASH (when money actually moved)
 *   In    customer payments that count (not a reversal, not reversed).
 *   Out   supplier payments that count, expenses marked as paid (with their
 *         VAT — that is what left the account), and payroll paid out.
 *
 * VAT itself is on the VAT screen; balances owed are on Outstanding.
 */

const SALE_STATUSES: InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID', 'PAID'];

const fils = (value: { toString(): string } | null | undefined) =>
  value ? toFils(value.toString()) : 0;

/** Half-up rounding of a non-negative integer ratio. */
const divRound = (numerator: number, denominator: number) =>
  Math.floor((numerator * 2 + denominator) / (denominator * 2));

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  CHEQUE: 'Cheque',
  ONLINE: 'Online',
};

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  REVENUE: 'Income',
  EXPENSE: 'Expenses',
};

export interface PeriodInput {
  period?: string;
  from?: string;
  to?: string;
}

function scope(user: AuthenticatedUser) {
  return user.primaryBranchId ? { branchId: user.primaryBranchId } : {};
}

// ─── Profit & loss ──────────────────────────────────────────────────────────

export async function getProfitAndLoss(user: AuthenticatedUser, input: PeriodInput = {}) {
  requirePermission(user, 'reports.view');
  const period: ResolvedPeriod = resolvePeriod(input);
  const organizationId = user.organizationId;
  const branch = scope(user);
  const dates = { gte: parseCalendarDate(period.from)!, lte: parseCalendarDate(period.to)! };
  const saleWhere = {
    organizationId,
    ...branch,
    invoiceType: 'TAX_INVOICE' as const,
    status: { in: SALE_STATUSES },
    issueDate: dates,
  };

  const [invoices, usages, expenseGroups, payrolls] = await Promise.all([
    prisma.invoice.findMany({
      where: saleWhere,
      select: { subtotal: true, items: { select: { itemType: true, lineTotal: true } } },
    }),
    prisma.partUsage.findMany({
      where: { organizationId, jobCard: { invoices: { some: saleWhere } } },
      select: { id: true, quantity: true, unitCost: true },
    }),
    prisma.expense.groupBy({
      by: ['chartOfAccountId'],
      where: { organizationId, ...branch, status: 'RECORDED', expenseDate: dates },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.payroll.findMany({
      where: { organizationId, status: { in: ['APPROVED', 'PAID'] }, periodEnd: dates },
      select: { periodStart: true, status: true, items: { select: { netPay: true } } },
    }),
  ]);

  // Sales, split by line type. A bill discount is spread over the lines, and
  // whatever rounding leaves over lands in "other", so the three always add
  // up to the invoices' own subtotals.
  let partsFils = 0;
  let labourFils = 0;
  let salesFils = 0;
  for (const invoice of invoices) {
    const subtotal = fils(invoice.subtotal);
    salesFils += subtotal;
    const lines = invoice.items.reduce((sum, item) => sum + fils(item.lineTotal), 0);
    if (lines <= 0) continue;
    const share = (type: string) =>
      divRound(
        invoice.items
          .filter((item) => item.itemType === type)
          .reduce((sum, item) => sum + fils(item.lineTotal), 0) * subtotal,
        lines,
      );
    partsFils += share('PART');
    labourFils += share('LABOUR');
  }
  const otherFils = salesFils - partsFils - labourFils;

  // Parts fitted on the invoiced jobs, at cost, after anything taken back.
  const net = await withNetQuantities(prisma, organizationId, usages);
  const partsCostFils = net.reduce(
    (sum, usage) => sum + Math.max(0, divRound(usage.netMilli * fils(usage.unitCost), 1000)),
    0,
  );

  const accounts = await prisma.chartOfAccount.findMany({
    where: {
      organizationId,
      id: { in: expenseGroups.map((row) => row.chartOfAccountId).filter(Boolean) as string[] },
    },
    select: { id: true, accountCode: true, accountName: true },
  });
  const accountOf = new Map(accounts.map((account) => [account.id, account]));
  const expenseRows = expenseGroups
    .map((row) => {
      const account = row.chartOfAccountId ? accountOf.get(row.chartOfAccountId) : undefined;
      return {
        id: row.chartOfAccountId,
        code: account?.accountCode ?? null,
        name: account?.accountName ?? 'Uncategorised',
        amountFils: fils(row._sum.amount),
        count: row._count._all,
      };
    })
    .sort((a, b) => b.amountFils - a.amountFils);
  const expensesFils = expenseRows.reduce((sum, row) => sum + row.amountFils, 0);

  const payrollFils = payrolls.reduce(
    (sum, run) => sum + run.items.reduce((inner, item) => inner + fils(item.netPay), 0),
    0,
  );

  const grossFils = salesFils - partsCostFils;
  const profitFils = grossFils - expensesFils - payrollFils;

  return {
    period,
    sales: {
      parts: filsToString(partsFils),
      labour: filsToString(labourFils),
      other: filsToString(otherFils),
      total: filsToString(salesFils),
      invoices: invoices.length,
    },
    partsCost: filsToString(partsCostFils),
    grossProfit: filsToString(grossFils),
    /** Gross profit as a percentage of sales, one decimal; null with no sales. */
    grossMargin: salesFils > 0 ? Math.round((grossFils * 1000) / salesFils) / 10 : null,
    expenses: {
      rows: expenseRows.map((row) => ({ ...row, amount: filsToString(row.amountFils) })),
      total: filsToString(expensesFils),
    },
    payroll: { total: filsToString(payrollFils), runs: payrolls.length },
    operatingCosts: filsToString(expensesFils + payrollFils),
    netProfit: filsToString(profitFils),
    netProfitFils: profitFils,
  };
}

export type ProfitAndLoss = Awaited<ReturnType<typeof getProfitAndLoss>>;

// ─── Cash ───────────────────────────────────────────────────────────────────

export async function getCashSummary(user: AuthenticatedUser, input: PeriodInput = {}) {
  requirePermission(user, 'reports.view');
  const period: ResolvedPeriod = resolvePeriod(input);
  const organizationId = user.organizationId;
  const branch = scope(user);
  const window = { gte: period.start, lt: period.end };
  const dates = { gte: parseCalendarDate(period.from)!, lte: parseCalendarDate(period.to)! };

  const [payments, supplierPayments, expenses, payrolls] = await Promise.all([
    // A payment reversed at any time never counts, even if the reversal
    // itself falls in a later period.
    prisma.payment.findMany({
      where: { organizationId, invoice: { organizationId, ...branch }, receivedAt: window },
      select: {
        id: true,
        amount: true,
        method: true,
        status: true,
        reversalOfPaymentId: true,
        reversals: { select: { id: true } },
      },
    }),
    prisma.supplierPayment.findMany({
      where: { organizationId, purchase: { ...branch }, paidAt: window },
      select: {
        id: true,
        amount: true,
        method: true,
        status: true,
        reversalOfSupplierPaymentId: true,
        reversals: { select: { id: true } },
      },
    }),
    prisma.expense.findMany({
      where: {
        organizationId,
        ...branch,
        status: 'RECORDED',
        expenseDate: dates,
        paymentMethod: { not: null },
      },
      select: { amount: true, taxAmount: true, paymentMethod: true },
    }),
    prisma.payroll.findMany({
      where: { organizationId, status: 'PAID', paidAt: window },
      select: { items: { select: { netPay: true } } },
    }),
  ]);

  const inByMethod = new Map<PaymentMethod, number>();
  for (const payment of payments) {
    // Counts only if it is an original and was never reversed.
    if (payment.reversalOfPaymentId || payment.status !== 'COMPLETED') continue;
    if (payment.reversals.length > 0) continue;
    inByMethod.set(payment.method, (inByMethod.get(payment.method) ?? 0) + fils(payment.amount));
  }

  const outRows: { label: string; detail: string; fils: number }[] = [];
  const supplierByMethod = new Map<PaymentMethod, number>();
  for (const payment of supplierPayments) {
    if (payment.reversals.length > 0) continue;
    const paid = supplierPaidFils([payment]);
    if (paid) {
      supplierByMethod.set(payment.method, (supplierByMethod.get(payment.method) ?? 0) + paid);
    }
  }
  const supplierFils = [...supplierByMethod.values()].reduce((a, b) => a + b, 0);
  outRows.push({
    label: 'Suppliers',
    detail: describe(supplierByMethod),
    fils: supplierFils,
  });

  const expenseByMethod = new Map<PaymentMethod, number>();
  for (const expense of expenses) {
    const method = expense.paymentMethod!;
    expenseByMethod.set(
      method,
      (expenseByMethod.get(method) ?? 0) + fils(expense.amount) + fils(expense.taxAmount),
    );
  }
  const expenseFils = [...expenseByMethod.values()].reduce((a, b) => a + b, 0);
  outRows.push({ label: 'Expenses paid', detail: describe(expenseByMethod), fils: expenseFils });

  const payrollFils = payrolls.reduce(
    (sum, run) => sum + run.items.reduce((inner, item) => inner + fils(item.netPay), 0),
    0,
  );
  outRows.push({
    label: 'Payroll',
    detail: `${payrolls.length} run${payrolls.length === 1 ? '' : 's'} paid`,
    fils: payrollFils,
  });

  const inFils = [...inByMethod.values()].reduce((a, b) => a + b, 0);
  const outFils = outRows.reduce((sum, row) => sum + row.fils, 0);

  return {
    period,
    in: {
      rows: [...inByMethod.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([method, amount]) => ({ label: METHOD_LABEL[method], amount: filsToString(amount) })),
      total: filsToString(inFils),
    },
    out: {
      rows: outRows.map((row) => ({ ...row, amount: filsToString(row.fils) })),
      total: filsToString(outFils),
    },
    net: filsToString(inFils - outFils),
    netFils: inFils - outFils,
  };
}

function describe(byMethod: Map<PaymentMethod, number>) {
  if (byMethod.size === 0) return 'Nothing paid';
  return [...byMethod.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([method]) => METHOD_LABEL[method])
    .join(', ');
}

export type CashSummary = Awaited<ReturnType<typeof getCashSummary>>;

// ─── Chart of accounts ──────────────────────────────────────────────────────

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;

const accountSchema = z.object({
  accountCode: z
    .string({ error: 'Enter an account code.' })
    .trim()
    .min(1, 'Enter an account code.')
    .max(20, 'Keep the code under 20 characters.')
    .regex(/^[A-Za-z0-9.-]+$/, 'Use letters, digits, dots and dashes only.'),
  accountName: z.string({ error: 'Enter a name.' }).trim().min(2, 'Enter a name.').max(120),
  accountType: z.enum(ACCOUNT_TYPES, { error: 'Choose the kind of account.' }).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  /** Cash, bank and card accounts money can go into or come out of. */
  isPaymentAccount: z
    .union([z.enum(['true', 'false']), z.array(z.enum(['true', 'false']))])
    .optional(),
  /** Kept per customer or per supplier (an asset or liability only); blank for neither. */
  subLedger: z.enum(['', 'CUSTOMER', 'SUPPLIER']).optional(),
  requestKey: z.string().optional(),
});

/** Who an account may be kept by: only balance-sheet accounts that are owed or owing. */
function readSubLedger(
  value: '' | 'CUSTOMER' | 'SUPPLIER' | undefined,
  accountType: string,
): 'CUSTOMER' | 'SUPPLIER' | null | undefined {
  if (value === undefined) return undefined;
  if (value === '') return null;
  if (accountType !== 'ASSET' && accountType !== 'LIABILITY') {
    throw new DomainError(
      'Only an asset or a liability can be kept per customer or supplier.',
      'subLedger',
    );
  }
  return value;
}

/** The last value of a checkbox sent with its hidden "false" companion. */
const checked = (value: 'true' | 'false' | ('true' | 'false')[] | undefined) =>
  value === undefined ? undefined : (Array.isArray(value) ? value.at(-1) : value) === 'true';

/**
 * Every account — or those whose code or name matches a search — grouped by
 * type in the usual order, with how often each is used.
 */
export async function listAccounts(user: AuthenticatedUser, filters: { q?: string } = {}) {
  requirePermission(user, 'accounting.view');
  // A search matches the account's code or name, however it is typed.
  const q = filters.q?.trim();
  const accounts = await prisma.chartOfAccount.findMany({
    where: {
      organizationId: user.organizationId,
      ...(q
        ? {
            OR: [
              { accountCode: { contains: q, mode: 'insensitive' } },
              { accountName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: [{ accountCode: 'asc' }],
    select: {
      id: true,
      accountCode: true,
      accountName: true,
      accountType: true,
      isActive: true,
      role: true,
      isPaymentAccount: true,
      subLedger: true,
      _count: { select: { expenses: true, journalEntryLines: true } },
    },
  });
  return ACCOUNT_TYPES.map((type) => ({
    type,
    label: ACCOUNT_TYPE_LABEL[type],
    accounts: accounts.filter((account) => account.accountType === type),
  }));
}

export type AccountGroups = Awaited<ReturnType<typeof listAccounts>>;

async function assertCodeFree(organizationId: string, code: string, exceptId?: string) {
  const clash = await prisma.chartOfAccount.findFirst({
    where: {
      organizationId,
      accountCode: { equals: code, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { accountName: true },
  });
  if (clash) {
    throw new DomainError(`That code is already used by “${clash.accountName}”.`, 'accountCode');
  }
}

export async function createAccount(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(accountSchema, rawInput);
  requirePermission(user, 'accounting.create');
  if (!input.accountType) throw new DomainError('Choose the kind of account.', 'accountType');
  const code = input.accountCode.toUpperCase();
  await assertCodeFree(user.organizationId, code);

  return prisma.$transaction(async (tx) => {
    const account = await tx.chartOfAccount.create({
      data: {
        organizationId: user.organizationId,
        accountCode: code,
        accountName: input.accountName.replace(/\s+/g, ' '),
        accountType: input.accountType!,
        isPaymentAccount: input.accountType === 'ASSET' && checked(input.isPaymentAccount) === true,
        subLedger: readSubLedger(input.subLedger, input.accountType!) ?? null,
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'account.created',
      entityType: 'ChartOfAccount',
      entityId: account.id,
      afterData: {
        accountCode: code,
        accountName: account.accountName,
        accountType: account.accountType,
        subLedger: account.subLedger,
      },
    });
    return account;
  });
}

/**
 * Renames, recodes or (de)activates an account. The kind of account is fixed
 * once created — an expense category can't quietly become income. A retired
 * account keeps every expense filed under it; it just isn't offered for new ones.
 */
export async function updateAccount(user: AuthenticatedUser, accountId: string, rawInput: unknown) {
  const input = parseInput(accountSchema, rawInput);
  requirePermission(user, 'accounting.edit');
  const before = await prisma.chartOfAccount.findFirst({
    where: { id: accountId, organizationId: user.organizationId },
  });
  if (!before) throw new NotFoundError('account');
  const code = input.accountCode.toUpperCase();
  await assertCodeFree(user.organizationId, code, before.id);
  // Automatic bookings go to system accounts, so they can't be retired.
  if (before.role && input.isActive === 'false') {
    throw new DomainError(
      'This account is used by automatic bookings, so it stays in use. It can be renamed or renumbered.',
      'isActive',
    );
  }
  const paymentAccount = checked(input.isPaymentAccount);
  const subLedger = readSubLedger(input.subLedger, before.accountType);
  // Against what the account is kept as — trade receivables and payables are
  // per party by their role even with nothing stored.
  const subLedgerChanges = subLedger !== undefined && subLedger !== subLedgerOf(before);
  if (subLedgerChanges && fixedSubLedger(before.role)) {
    throw new DomainError(
      'Trade receivables and trade payables are always kept per customer and per supplier.',
      'subLedger',
    );
  }
  if (subLedgerChanges) {
    const used = await prisma.journalEntryLine.count({
      where: { organizationId: user.organizationId, chartOfAccountId: before.id },
    });
    if (used > 0) {
      throw new DomainError(
        'Entries are already booked to this account, so whether it is kept per customer or supplier can no longer change — its history would stop adding up. Open a new account for that instead.',
        'subLedger',
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const account = await tx.chartOfAccount.update({
      where: { id: before.id },
      data: {
        accountCode: code,
        accountName: input.accountName.replace(/\s+/g, ' '),
        isActive: before.role ? true : input.isActive ? input.isActive === 'true' : before.isActive,
        ...(before.accountType === 'ASSET' && paymentAccount !== undefined
          ? { isPaymentAccount: paymentAccount }
          : {}),
        ...(subLedgerChanges ? { subLedger } : {}),
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'account.updated',
      entityType: 'ChartOfAccount',
      entityId: account.id,
      beforeData: {
        accountCode: before.accountCode,
        accountName: before.accountName,
        isActive: before.isActive,
        subLedger: before.subLedger,
      },
      afterData: {
        accountCode: account.accountCode,
        accountName: account.accountName,
        isActive: account.isActive,
        subLedger: account.subLedger,
      },
    });
    return account;
  });
}
