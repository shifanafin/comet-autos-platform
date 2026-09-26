import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { calculateLine, filsToString, toFils } from '@/lib/money';
import { resolveDefaultVatRate } from '@/lib/tax';
import { resolveInventoryBranch } from '@/lib/inventory/stock';

/*
 * What the workshop spends to keep running — rent, utilities, workshop
 * supplies, transport — as distinct from parts bought for a job, which are
 * purchases and go through stock.
 *
 * An expense is never deleted. A mistake is voided: the record stays with
 * its reason, so the month's spend can always be explained. Money is exact
 * (integer fils via lib/money), never floating point, and the VAT split is
 * the same calculation the estimate and invoice use.
 *
 * Categories are the organization's chart of accounts, filtered to EXPENSE
 * accounts, so an expense is already coded for whenever real bookkeeping
 * arrives. No journal entry is posted yet — that is a later milestone.
 */

const PAYMENT_METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'] as const;

const expenseSchema = z.object({
  description: z
    .string({ error: 'Say what this was for.' })
    .trim()
    .min(2, 'Say what this was for.')
    .max(300),
  amount: z
    .string({ error: 'Enter the amount.' })
    .trim()
    .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter an amount like 250.00.'),
  /** Percentage. Empty means the expense carries no VAT. */
  taxRate: z
    .union([z.literal(''), z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'Enter a VAT rate like 5.')])
    .optional(),
  expenseDate: z
    .string({ error: 'Choose the date.' })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the date.'),
  vendorName: z.string().trim().max(160).optional(),
  paymentMethod: z.union([z.literal(''), z.enum(PAYMENT_METHODS)]).optional(),
  categoryId: z.string().trim().optional(),
  requestKey: z.string().optional(),
});

/**
 * The amount entered is net of VAT; the rate adds the tax on top — the same
 * convention estimates and invoices use, so the two are comparable.
 */
function split(amount: string, taxRate: string | null) {
  const amounts = calculateLine({ quantity: '1', unitPrice: amount, taxRate: taxRate ?? '0' });
  return {
    net: amounts.lineTotal,
    tax: amounts.taxAmount,
    total: filsToString(amounts.lineTotalFils + amounts.taxFils),
  };
}

async function assertCategory(organizationId: string, categoryId: string | null) {
  if (!categoryId) return;
  const account = await prisma.chartOfAccount.findFirst({
    where: { id: categoryId, organizationId, accountType: 'EXPENSE', isActive: true },
    select: { id: true },
  });
  if (!account) throw new DomainError('Choose a category from the list.', 'categoryId');
}

export async function recordExpense(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(expenseSchema, rawInput);
  requirePermission(user, 'accounting.create');
  const branch = await resolveInventoryBranch(user);

  if (toFils(input.amount) <= 0)
    throw new DomainError('The amount must be more than zero.', 'amount');
  const taxRate = emptyToNull(input.taxRate);
  const categoryId = emptyToNull(input.categoryId);
  await assertCategory(user.organizationId, categoryId);
  const money = split(input.amount, taxRate);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'expense.record');
    const expense = await tx.expense.create({
      data: {
        organizationId: user.organizationId,
        branchId: branch.id,
        chartOfAccountId: categoryId,
        description: input.description.replace(/\s+/g, ' '),
        // `amount` is the net; `taxAmount` the VAT on top, so net + tax is
        // what left the bank. This matches how the invoice stores money.
        amount: money.net,
        taxRate: taxRate,
        taxAmount: taxRate ? money.tax : null,
        expenseDate: new Date(`${input.expenseDate}T00:00:00Z`),
        vendorName: emptyToNull(input.vendorName),
        paymentMethod: emptyToNull(input.paymentMethod) as (typeof PAYMENT_METHODS)[number] | null,
        recordedByUserId: user.id,
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: branch.id,
      actorUserId: user.id,
      action: 'expense.recorded',
      entityType: 'Expense',
      entityId: expense.id,
      afterData: {
        description: expense.description,
        amount: money.net,
        taxAmount: money.tax,
        total: money.total,
        expenseDate: input.expenseDate,
        vendorName: expense.vendorName,
        paymentMethod: expense.paymentMethod,
      },
    });
    await settleRequestKey(tx, user, rawInput, expense.id);
    return expense;
  });
}

/**
 * Corrects a recorded expense — a mistyped amount, date, category or payee.
 * Same rules and VAT split as recording one; the audit log keeps what it was.
 * A voided expense stays as it was.
 */
export async function updateExpense(user: AuthenticatedUser, expenseId: string, rawInput: unknown) {
  const input = parseInput(expenseSchema, rawInput);
  requirePermission(user, 'accounting.edit');
  if (toFils(input.amount) <= 0)
    throw new DomainError('The amount must be more than zero.', 'amount');
  const taxRate = emptyToNull(input.taxRate);
  const categoryId = emptyToNull(input.categoryId);
  await assertCategory(user.organizationId, categoryId);
  const money = split(input.amount, taxRate);

  return prisma.$transaction(async (tx) => {
    const before = await tx.expense.findFirst({
      where: { id: expenseId, organizationId: user.organizationId },
    });
    if (!before) throw new NotFoundError('expense');
    if (before.status === 'VOID') throw new DomainError('A voided expense cannot be changed.');

    const data = {
      chartOfAccountId: categoryId,
      description: input.description.replace(/\s+/g, ' '),
      amount: money.net,
      taxRate,
      taxAmount: taxRate ? money.tax : null,
      expenseDate: new Date(`${input.expenseDate}T00:00:00Z`),
      vendorName: emptyToNull(input.vendorName),
      paymentMethod: emptyToNull(input.paymentMethod) as (typeof PAYMENT_METHODS)[number] | null,
    };
    const expense = await tx.expense.update({ where: { id: before.id }, data });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: before.branchId,
      actorUserId: user.id,
      action: 'expense.updated',
      entityType: 'Expense',
      entityId: before.id,
      beforeData: {
        description: before.description,
        amount: before.amount.toString(),
        taxRate: before.taxRate?.toString() ?? null,
        taxAmount: before.taxAmount?.toString() ?? null,
        expenseDate: before.expenseDate.toISOString().slice(0, 10),
        vendorName: before.vendorName,
        paymentMethod: before.paymentMethod,
        chartOfAccountId: before.chartOfAccountId,
      },
      afterData: { ...data, expenseDate: input.expenseDate, total: money.total },
    });
    return expense;
  });
}

const voidSchema = z.object({
  reason: z
    .string({ error: 'Say why this is being voided.' })
    .trim()
    .min(3, 'Say why this is being voided.')
    .max(300),
});

/**
 * Cancels an expense without destroying it. The row stays, marked VOID with
 * the reason in the audit log, so a month's spend can always be explained.
 */
export async function voidExpense(user: AuthenticatedUser, expenseId: string, rawInput: unknown) {
  const input = parseInput(voidSchema, rawInput);
  requirePermission(user, 'accounting.edit');
  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, organizationId: user.organizationId },
  });
  if (!expense) throw new NotFoundError('expense');
  if (expense.status === 'VOID') throw new DomainError('This expense is already voided.');

  return prisma.$transaction(async (tx) => {
    const voided = await tx.expense.update({
      where: { id: expense.id },
      data: { status: 'VOID' },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: expense.branchId,
      actorUserId: user.id,
      action: 'expense.voided',
      entityType: 'Expense',
      entityId: expense.id,
      beforeData: { status: expense.status, amount: expense.amount.toString() },
      afterData: { status: 'VOID' },
      metadata: { reason: input.reason },
    });
    return voided;
  });
}

export interface ExpenseFilters {
  query?: string;
  categoryId?: string;
  from?: string;
  to?: string;
  /** Voided expenses are hidden unless asked for. */
  show?: 'recorded' | 'all';
}

function where(organizationId: string, filters: ExpenseFilters): Prisma.ExpenseWhereInput {
  const q = filters.query?.trim();
  return {
    organizationId,
    ...(filters.show === 'all' ? {} : { status: 'RECORDED' }),
    ...(filters.categoryId ? { chartOfAccountId: filters.categoryId } : {}),
    ...(filters.from || filters.to
      ? {
          expenseDate: {
            ...(filters.from ? { gte: new Date(`${filters.from}T00:00:00Z`) } : {}),
            ...(filters.to ? { lte: new Date(`${filters.to}T00:00:00Z`) } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { description: { contains: q, mode: 'insensitive' } },
            { vendorName: { contains: q, mode: 'insensitive' } },
            { expenseNumber: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

/** Expenses for the filters given, with the totals for exactly that set. */
export async function listExpenses(user: AuthenticatedUser, filters: ExpenseFilters = {}) {
  requirePermission(user, 'accounting.view');
  const clause = where(user.organizationId, filters);
  const [expenses, categories] = await Promise.all([
    prisma.expense.findMany({
      where: clause,
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
      take: 300,
      include: {
        chartOfAccount: { select: { id: true, accountName: true } },
        recordedBy: { select: { fullName: true } },
        branch: { select: { name: true } },
      },
    }),
    listExpenseCategories(user),
  ]);

  // Totalled in fils so the figures are exact.
  let netFils = 0;
  let taxFils = 0;
  for (const expense of expenses) {
    if (expense.status !== 'RECORDED') continue;
    netFils += toFils(expense.amount.toString());
    taxFils += expense.taxAmount ? toFils(expense.taxAmount.toString()) : 0;
  }

  return {
    expenses: expenses.map((expense) => ({
      ...expense,
      total: filsToString(
        toFils(expense.amount.toString()) +
          (expense.taxAmount ? toFils(expense.taxAmount.toString()) : 0),
      ),
    })),
    categories,
    totals: {
      net: filsToString(netFils),
      tax: filsToString(taxFils),
      total: filsToString(netFils + taxFils),
      count: expenses.filter((e) => e.status === 'RECORDED').length,
    },
  };
}

export type ExpenseRow = Awaited<ReturnType<typeof listExpenses>>['expenses'][number];

/** The organization's expense accounts, used as categories. */
export async function listExpenseCategories(user: AuthenticatedUser) {
  return prisma.chartOfAccount.findMany({
    where: { organizationId: user.organizationId, accountType: 'EXPENSE', isActive: true },
    orderBy: { accountName: 'asc' },
    select: { id: true, accountCode: true, accountName: true },
  });
}

/** What the expense form needs: categories, and the default VAT rate to suggest. */
export async function getExpenseFormOptions(user: AuthenticatedUser) {
  // Recording and correcting an expense use the same form.
  if (!hasPermission(user, 'accounting.create')) requirePermission(user, 'accounting.edit');
  const categories = await listExpenseCategories(user);
  return { categories, defaultVatRate: await resolveDefaultVatRate(user.organizationId) };
}
