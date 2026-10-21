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
import { syncPosting } from '@/lib/accounting/journal';
import { checkMoneyAccount, refuseCardSettlementAccount } from '@/lib/accounting/chart';
import { listPersonalPayers, resolvePersonalPayer } from '@/lib/finance/owner-payments';
import { getTaxCodeOptions, resolveTaxCode } from '@/lib/accounting/tax-codes';
import { getPaymentModeOptions } from '@/lib/accounting/payment-modes';
import { getAccountChoices } from '@/lib/accounting/reports';
import { sameVendor } from '@/lib/finance/vendor-names';
import { allocateDocumentNumber } from '@/lib/numbering';
import { listExpenseBills } from '@/lib/finance/expense-bills';
import { listJobChoices } from '@/lib/finance/job-costing';

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
  /** The purchase tax code; when given, its rate is the expense's VAT rate. */
  taxCodeId: z.union([z.literal(''), z.uuid()]).optional(),
  /** Percentage. Empty means the expense carries no VAT. (Imports and older forms.) */
  taxRate: z
    .union([z.literal(''), z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'Enter a VAT rate like 5.')])
    .optional(),
  /**
   * The VAT exactly as printed on the supplier's bill. Blank: worked out from
   * the amount and the rate. A bill's own figure can differ by rounding, and
   * the VAT reclaimed must be what the tax invoice says.
   */
  taxAmount: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter the VAT like 12.50.'),
    ])
    .optional(),
  expenseDate: z
    .string({ error: 'Choose the date.' })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the date.'),
  vendorName: z.string().trim().max(160).optional(),
  /** The supplier's own bill / invoice number. */
  billNumber: z.string().trim().max(60, 'Keep the bill number under 60 characters.').optional(),
  /** The supplier's TRN from their tax invoice: 15 digits. */
  supplierTrn: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || /^\d{15}$/.test(value.replace(/[\s-]/g, '')),
      'A TRN is 15 digits, as printed on the supplier’s tax invoice.',
    ),
  /** A bill not paid yet: when it is due. */
  dueDate: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the due date.'),
    ])
    .optional(),
  /** The transfer, cheque or card-slip number it was paid with. */
  paymentReference: z.string().trim().max(60, 'Keep the reference under 60 characters.').optional(),
  notes: z.string().trim().max(1000, 'Keep the notes under 1000 characters.').optional(),
  /** Set when the form was filled by Scan bill: the fields the reader filled. */
  scannedFields: z.string().trim().max(200).optional(),
  paymentMethod: z.union([z.literal(''), z.enum(PAYMENT_METHODS)]).optional(),
  /** The cash or bank account it was paid from; blank for the method's default. */
  paidFromAccountId: z.union([z.literal(''), z.uuid()]).optional(),
  /** Paid with an owner's own money; never together with paymentMethod. */
  paidByUserId: z.union([z.literal(''), z.uuid()]).optional(),
  categoryId: z.string().trim().optional(),
  /**
   * The job it was a cost of: "card:<job card id>" or "invoice:<invoice id>",
   * blank for none (lib/finance/job-costing.ts).
   */
  forJob: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || /^(card|invoice):[0-9a-f-]{36}$/i.test(value),
      'Choose the job from the list.',
    ),
  requestKey: z.string().optional(),
});

/**
 * The job an expense is a cost of. An invoice that bills a job card files
 * the cost under the job card, so every cost of one job is in one place
 * whether it was entered before or after the invoice.
 */
async function readJob(tx: Prisma.TransactionClient, organizationId: string, forJob?: string) {
  if (!forJob) return { jobCardId: null, invoiceId: null };
  const [kind, id] = forJob.split(':');
  if (kind === 'card') {
    const card = await tx.jobCard.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!card) throw new DomainError('Choose the job from the list.', 'forJob');
    return { jobCardId: card.id, invoiceId: null };
  }
  const invoice = await tx.invoice.findFirst({
    where: { id, organizationId, status: { notIn: ['VOID', 'CANCELLED'] } },
    select: { id: true, jobCardId: true },
  });
  if (!invoice) throw new DomainError('Choose the job from the list.', 'forJob');
  return invoice.jobCardId
    ? { jobCardId: invoice.jobCardId, invoiceId: null }
    : { jobCardId: null, invoiceId: invoice.id };
}

/**
 * The amount entered is net of VAT; the rate adds the tax on top — the same
 * convention estimates and invoices use, so the two are comparable.
 */
/**
 * The VAT rate an expense carries: its tax code's, else the rate typed. A 0%
 * code (zero-rated, exempt, out of scope) carries none to reclaim.
 */
async function readTax(organizationId: string, input: { taxCodeId?: string; taxRate?: string }) {
  if (input.taxCodeId) {
    const code = await resolveTaxCode(prisma, organizationId, input.taxCodeId);
    return { taxCodeId: code.id, taxRate: Number(code.rate) > 0 ? code.rate : null };
  }
  return { taxCodeId: null, taxRate: emptyToNull(input.taxRate) };
}

/**
 * Net, VAT and total. The VAT is worked out from the rate unless it was typed
 * from the bill, in which case the bill's figure stands — but never VAT on a
 * code that carries none, and never more than the amount it is charged on.
 */
function split(amount: string, taxRate: string | null, typedTax?: string) {
  const amounts = calculateLine({ quantity: '1', unitPrice: amount, taxRate: taxRate ?? '0' });
  let taxFils = amounts.taxFils;
  if (typedTax) {
    const typed = toFils(typedTax);
    if (!taxRate && typed > 0) {
      throw new DomainError(
        'This tax code carries no VAT to reclaim. Choose the standard code, or leave the VAT at 0.',
        'taxAmount',
      );
    }
    if (typed > amounts.lineTotalFils) {
      throw new DomainError(
        'The VAT cannot be more than the amount before VAT. Check the figures on the bill.',
        'taxAmount',
      );
    }
    taxFils = typed;
  }
  return {
    net: amounts.lineTotal,
    tax: filsToString(taxFils),
    total: filsToString(amounts.lineTotalFils + taxFils),
    /** The rate's own figure, for the record when the bill's differs. */
    calculatedTax: amounts.taxAmount,
  };
}

/**
 * Who or what paid: a cash or bank account (paymentMethod), an owner with
 * their own money (paidByUserId), or nobody yet — never two of them.
 * Returns the fields to store.
 */
async function readPayer(
  tx: Prisma.TransactionClient,
  organizationId: string,
  input: { paymentMethod?: string; paidFromAccountId?: string; paidByUserId?: string },
) {
  const method = emptyToNull(input.paymentMethod) as (typeof PAYMENT_METHODS)[number] | null;
  const personId = emptyToNull(input.paidByUserId);
  if (method && personId) {
    throw new DomainError(
      'Choose how it was paid, or who paid it personally — not both.',
      'paymentMethod',
    );
  }
  if (personId) {
    const payer = await resolvePersonalPayer(tx, organizationId, personId);
    return {
      paymentMethod: null,
      paidFromAccountId: null,
      paidByUserId: payer.id,
      paidPersonallyBy: payer.fullName,
    };
  }
  const paidFromAccountId = method
    ? await checkMoneyAccount(tx, organizationId, input.paidFromAccountId)
    : null;
  await refuseCardSettlementAccount(tx, organizationId, method, paidFromAccountId);
  return {
    paymentMethod: method,
    paidFromAccountId,
    paidByUserId: null,
    paidPersonallyBy: null,
  };
}

/**
 * The details kept with an expense beyond its money: the supplier's TRN, and
 * either how it was paid (a reference) or, while unpaid, when it is due.
 */
function readDetails(
  input: {
    supplierTrn?: string;
    dueDate?: string;
    paymentReference?: string;
    notes?: string;
    expenseDate: string;
  },
  payer: { paymentMethod: string | null; paidByUserId: string | null },
) {
  const unpaid = !payer.paymentMethod && !payer.paidByUserId;
  const dueDate = unpaid ? emptyToNull(input.dueDate) : null;
  if (dueDate && dueDate < input.expenseDate) {
    throw new DomainError('The due date cannot be before the bill’s date.', 'dueDate');
  }
  return {
    supplierTrn: emptyToNull(input.supplierTrn)?.replace(/[\s-]/g, '') ?? null,
    dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null,
    paymentReference: payer.paymentMethod ? emptyToNull(input.paymentReference) : null,
    notes: emptyToNull(input.notes),
  };
}

/**
 * One bill is entered once: the same vendor's bill number may not be on
 * another live expense, nor on a stock purchase from a supplier of that
 * name. The vendor may be spelt another way the second time ("ENOC" for
 * "ENOC / EPPCO"), and a bill of the same number, date and total is the
 * same bill whoever it is said to be from. Without a vendor or a date and
 * total to compare, the number alone proves nothing.
 */
async function assertBillFree(
  tx: Prisma.TransactionClient,
  organizationId: string,
  vendorName: string | null,
  billNumber: string | null,
  exceptExpenseId?: string,
  bill?: { date: string; total: string },
) {
  if (!billNumber || (!vendorName && !bill)) return;
  const sameNumber = await tx.expense.findMany({
    where: {
      organizationId,
      status: 'RECORDED',
      billNumber: { equals: billNumber, mode: 'insensitive' },
      ...(exceptExpenseId ? { id: { not: exceptExpenseId } } : {}),
    },
    select: {
      expenseNumber: true,
      vendorName: true,
      expenseDate: true,
      amount: true,
      taxAmount: true,
    },
    take: 20,
  });
  const expense = sameNumber.find((other) => {
    if (vendorName && other.vendorName && sameVendor(vendorName, other.vendorName)) return true;
    if (!bill) return false;
    const total = toFils(other.amount.toString()) + toFils(other.taxAmount?.toString() ?? '0');
    return (
      other.expenseDate.toISOString().slice(0, 10) === bill.date && total === toFils(bill.total)
    );
  });
  if (expense) {
    throw new DomainError(
      `Bill ${billNumber}${vendorName ? ` from ${vendorName}` : ''} is already entered as ${expense.expenseNumber ?? 'another expense'}${expense.vendorName ? ` (${expense.vendorName})` : ''}. If it really is another bill, check the bill number.`,
      'billNumber',
    );
  }
  if (!vendorName) return;
  const purchase = await tx.purchase.findFirst({
    where: {
      organizationId,
      status: { not: 'CANCELLED' },
      supplierInvoiceNumber: { equals: billNumber, mode: 'insensitive' },
      supplier: { name: { equals: vendorName, mode: 'insensitive' } },
    },
    select: { purchaseNumber: true },
  });
  if (purchase) {
    throw new DomainError(
      `Bill ${billNumber} from ${vendorName} is already entered as purchase ${purchase.purchaseNumber}.`,
      'billNumber',
    );
  }
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
  return prisma.$transaction((tx) => recordExpenseInTransaction(tx, user, rawInput));
}

/**
 * recordExpense in a transaction the caller already holds — the expense
 * import uses it, so every imported expense follows exactly the form's rules.
 */
export async function recordExpenseInTransaction(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  rawInput: unknown,
) {
  const input = parseInput(expenseSchema, rawInput);
  requirePermission(user, 'expense.create');
  const branch = await resolveInventoryBranch(user, tx);

  if (toFils(input.amount) <= 0)
    throw new DomainError('The amount must be more than zero.', 'amount');
  const { taxRate, taxCodeId } = await readTax(user.organizationId, input);
  const categoryId = emptyToNull(input.categoryId);
  await assertCategory(user.organizationId, categoryId);
  const money = split(input.amount, taxRate, emptyToNull(input.taxAmount) ?? undefined);

  await claimRequestKey(tx, user, rawInput, 'expense.record');
  await assertBillFree(
    tx,
    user.organizationId,
    emptyToNull(input.vendorName),
    emptyToNull(input.billNumber),
    undefined,
    { date: input.expenseDate, total: money.total },
  );
  const { paidPersonallyBy, ...payer } = await readPayer(tx, user.organizationId, input);
  const details = readDetails(input, payer);
  // EXP-000123: the voucher number it is filed and found under.
  const expenseNumber = await allocateDocumentNumber(
    tx,
    user.organizationId,
    branch.id,
    'EXPENSE_VOUCHER',
  );
  const expense = await tx.expense.create({
    data: {
      organizationId: user.organizationId,
      branchId: branch.id,
      expenseNumber,
      ...details,
      chartOfAccountId: categoryId,
      ...(await readJob(tx, user.organizationId, input.forJob)),
      description: input.description.replace(/\s+/g, ' '),
      // `amount` is the net; `taxAmount` the VAT on top, so net + tax is
      // what left the bank. This matches how the invoice stores money.
      amount: money.net,
      taxRate: taxRate,
      taxAmount: taxRate ? money.tax : null,
      taxCodeId,
      expenseDate: new Date(`${input.expenseDate}T00:00:00Z`),
      vendorName: emptyToNull(input.vendorName),
      billNumber: emptyToNull(input.billNumber),
      // Paid from an account, by an owner personally, or not yet.
      ...payer,
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
      ...(money.tax !== money.calculatedTax
        ? { vatAsOnBill: true, calculatedTax: money.calculatedTax }
        : {}),
      expenseDate: input.expenseDate,
      vendorName: expense.vendorName,
      paymentMethod: expense.paymentMethod,
      paidPersonallyBy,
    },
  });
  if (input.scannedFields) {
    // The figures came from reading the bill, then the user's review.
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: branch.id,
      actorUserId: user.id,
      action: 'expense.filled_from_scan',
      entityType: 'Expense',
      entityId: expense.id,
      afterData: {
        filled: input.scannedFields.split(',').filter(Boolean),
        billNumber: expense.billNumber,
        vendorName: expense.vendorName,
        total: money.total,
      },
    });
  }
  await syncPosting(tx, user.organizationId, 'EXPENSE', expense.id, user.id);
  await settleRequestKey(tx, user, rawInput, expense.id);
  return expense;
}

/** What may be filled in on an expense paid by a signed voucher: the tax invoice's details. */
const PAPER_DETAILS = new Set(['supplierTrn', 'billNumber', 'notes']);

/** A stored value and a form's value are the same: dates by instant, numbers by value. */
function sameValue(stored: unknown, next: unknown) {
  const plain = (value: unknown) =>
    value instanceof Date ? value.toISOString() : value == null ? '' : String(value);
  const [a, b] = [plain(stored), plain(next)];
  const numeric = /^-?\d+(\.\d+)?$/;
  return a === b || (numeric.test(a) && numeric.test(b) && Number(a) === Number(b));
}

/**
 * Corrects a recorded expense — a mistyped amount, date, category or payee.
 * Same rules and VAT split as recording one; the audit log keeps what it was.
 * A voided expense stays as it was.
 */
export async function updateExpense(user: AuthenticatedUser, expenseId: string, rawInput: unknown) {
  const input = parseInput(expenseSchema, rawInput);
  requirePermission(user, 'expense.edit');
  if (toFils(input.amount) <= 0)
    throw new DomainError('The amount must be more than zero.', 'amount');
  const { taxRate, taxCodeId } = await readTax(user.organizationId, input);
  const categoryId = emptyToNull(input.categoryId);
  await assertCategory(user.organizationId, categoryId);
  const money = split(input.amount, taxRate, emptyToNull(input.taxAmount) ?? undefined);

  return prisma.$transaction(async (tx) => {
    const before = await tx.expense.findFirst({
      where: { id: expenseId, organizationId: user.organizationId },
    });
    if (!before) throw new NotFoundError('expense');
    if (before.status === 'VOID') throw new DomainError('A voided expense cannot be changed.');
    const voucher = await tx.paymentVoucher.findFirst({
      where: { organizationId: user.organizationId, expenseId: before.id },
      select: { voucherNumber: true },
    });
    await assertBillFree(
      tx,
      user.organizationId,
      emptyToNull(input.vendorName),
      emptyToNull(input.billNumber),
      before.id,
      { date: input.expenseDate, total: money.total },
    );
    const { paidPersonallyBy, ...payer } = await readPayer(tx, user.organizationId, input);

    const data = {
      ...readDetails(input, payer),
      chartOfAccountId: categoryId,
      ...(await readJob(tx, user.organizationId, input.forJob)),
      description: input.description.replace(/\s+/g, ' '),
      amount: money.net,
      taxRate,
      taxAmount: taxRate ? money.tax : null,
      taxCodeId,
      expenseDate: new Date(`${input.expenseDate}T00:00:00Z`),
      vendorName: emptyToNull(input.vendorName),
      billNumber: emptyToNull(input.billNumber),
      ...payer,
    };
    // Paid on a signed payment voucher: the paper and the books must agree.
    // The supplier's tax invoice details may still be filled in when it
    // arrives — they move no money and nothing the payee signed.
    if (voucher) {
      const changed = Object.entries(data).some(
        ([key, value]) =>
          !PAPER_DETAILS.has(key) && !sameValue(before[key as keyof typeof before], value),
      );
      if (changed) {
        throw new DomainError(
          `This was paid on payment voucher ${voucher.voucherNumber}, which the payee signed. Only the supplier’s TRN, the bill number and the notes can be filled in here; to correct anything else, void the voucher and write a new one.`,
        );
      }
    }
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
        paidByUserId: before.paidByUserId,
        chartOfAccountId: before.chartOfAccountId,
      },
      afterData: {
        ...data,
        paidPersonallyBy,
        expenseDate: input.expenseDate,
        total: money.total,
        ...(money.tax !== money.calculatedTax
          ? { vatAsOnBill: true, calculatedTax: money.calculatedTax }
          : {}),
      },
    });
    await syncPosting(tx, user.organizationId, 'EXPENSE', expense.id, user.id);
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
  requirePermission(user, 'expense.delete');
  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, organizationId: user.organizationId },
  });
  if (!expense) throw new NotFoundError('expense');
  if (expense.status === 'VOID') throw new DomainError('This expense is already voided.');
  // Paid on a payment voucher: voided with the voucher, so the two agree.
  const voucher = await prisma.paymentVoucher.findFirst({
    where: { organizationId: user.organizationId, expenseId: expense.id },
    select: { voucherNumber: true },
  });
  if (voucher) {
    throw new DomainError(
      `This was paid on payment voucher ${voucher.voucherNumber}. Void the voucher instead — the expense is voided with it.`,
    );
  }

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
    await syncPosting(tx, user.organizationId, 'EXPENSE', voided.id, user.id);
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
  /**
   * Outside work paid on a payment voucher is listed with the vouchers; it
   * is shown among the expenses (it is booked as one) only when asked for.
   */
  outsideWork?: boolean;
}

function where(organizationId: string, filters: ExpenseFilters): Prisma.ExpenseWhereInput {
  const q = filters.query?.trim();
  return {
    organizationId,
    ...(filters.show === 'all' ? {} : { status: 'RECORDED' }),
    ...(filters.outsideWork ? {} : { paymentVoucher: null }),
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

/**
 * One page of expenses for the filters given, with the totals for every
 * expense the filters match — not only the page shown.
 */
export async function listExpenses(
  user: AuthenticatedUser,
  filters: ExpenseFilters = {},
  limit = 300,
  /** Rows to skip: the pages before the one shown. */
  offset = 0,
) {
  requirePermission(user, 'expense.view');
  const clause = where(user.organizationId, filters);
  const [expenses, total, recorded, categories, outsideWork] = await Promise.all([
    prisma.expense.findMany({
      where: clause,
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
      skip: offset,
      take: limit,
      include: {
        chartOfAccount: { select: { id: true, accountName: true } },
        recordedBy: { select: { fullName: true } },
        branch: { select: { name: true } },
        paidByUser: { select: { id: true, fullName: true } },
        paymentVoucher: { select: { id: true, voucherNumber: true } },
      },
    }),
    prisma.expense.count({ where: clause }),
    // Voided expenses are listed on "All" but never count towards what was spent.
    prisma.expense.aggregate({
      where: { AND: [clause, { status: 'RECORDED' }] },
      _sum: { amount: true, taxAmount: true },
      _count: { _all: true },
    }),
    listExpenseCategories(user),
    // The outside work the same filters would show, kept on the vouchers.
    filters.outsideWork
      ? Promise.resolve(0)
      : prisma.expense.count({
          where: {
            AND: [
              where(user.organizationId, { ...filters, outsideWork: true }),
              { paymentVoucher: { isNot: null } },
            ],
          },
        }),
  ]);

  // Totalled in fils so the figures are exact.
  const netFils = toFils(recorded._sum.amount?.toString() ?? '0');
  const taxFils = toFils(recorded._sum.taxAmount?.toString() ?? '0');

  return {
    /** Every expense the filters match, not only the page shown. */
    total,
    expenses: expenses.map((expense) => ({
      ...expense,
      total: filsToString(
        toFils(expense.amount.toString()) +
          (expense.taxAmount ? toFils(expense.taxAmount.toString()) : 0),
      ),
    })),
    categories,
    /** Outside-work payments left out of this list (they are on the vouchers). */
    outsideWorkHidden: outsideWork,
    totals: {
      net: filsToString(netFils),
      tax: filsToString(taxFils),
      total: filsToString(netFils + taxFils),
      count: recorded._count._all,
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
  if (!hasPermission(user, 'expense.create')) requirePermission(user, 'expense.edit');
  const [categories, accounts] = await Promise.all([
    listExpenseCategories(user),
    getAccountChoices(user),
  ]);
  return {
    categories,
    defaultVatRate: await resolveDefaultVatRate(user.organizationId),
    moneyAccounts: accounts.money,
    taxCodes: await getTaxCodeOptions(user.organizationId, 'purchases'),
    // Card settlements are for customers paying the garage; not offered here.
    modes: await getPaymentModeOptions(user.organizationId, 'spending'),
    /** The jobs a cost can be filed against (lib/finance/job-costing.ts). */
    jobs: await listJobChoices(user),
    /** Who can pay a cost with their own money: "Paid personally by…". */
    people: (await listPersonalPayers(user.organizationId)).map((person) => ({
      id: person.id,
      name: person.fullName,
    })),
  };
}

/**
 * One expense, in full: what it was, what it cost and the VAT reclaimed, who
 * was paid and how, the bill kept with it, how it was booked, and every
 * change made to it since.
 */
export async function getExpenseDetail(user: AuthenticatedUser, expenseId: string) {
  requirePermission(user, 'expense.view');
  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, organizationId: user.organizationId },
    include: {
      chartOfAccount: { select: { id: true, accountCode: true, accountName: true } },
      paidFrom: { select: { accountCode: true, accountName: true } },
      paidByUser: { select: { id: true, fullName: true } },
      recordedBy: { select: { fullName: true } },
      branch: { select: { name: true } },
      taxCode: { select: { code: true, name: true, rate: true, treatment: true } },
      jobCard: { select: { id: true, jobNumber: true } },
      invoice: { select: { id: true, invoiceNumber: true } },
    },
  });
  if (!expense) throw new NotFoundError('expense');
  const [bills, entries, history] = await Promise.all([
    listExpenseBills(user, [expense.id]).then((byExpense) => byExpense.get(expense.id) ?? []),
    // Every entry that has booked it — the standing one and any it replaced.
    prisma.journalEntry.findMany({
      where: { organizationId: user.organizationId, sourceType: 'EXPENSE', sourceId: expense.id },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        id: true,
        entryNumber: true,
        entryDate: true,
        description: true,
        reversalOfJournalEntryId: true,
        _count: { select: { reversals: true } },
        lines: {
          select: {
            debitAmount: true,
            creditAmount: true,
            chartOfAccount: { select: { accountCode: true, accountName: true } },
          },
        },
      },
    }),
    prisma.auditLog.findMany({
      where: { organizationId: user.organizationId, entityType: 'Expense', entityId: expense.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        action: true,
        createdAt: true,
        metadata: true,
        actorUser: { select: { fullName: true } },
      },
    }),
  ]);
  const net = toFils(expense.amount.toString());
  const tax = expense.taxAmount ? toFils(expense.taxAmount.toString()) : 0;
  return {
    ...expense,
    total: filsToString(net + tax),
    bills,
    entries: entries.map((entry) => ({
      ...entry,
      /** Replaced by a correction, or itself the reversal of one. */
      superseded: entry._count.reversals > 0 || Boolean(entry.reversalOfJournalEntryId),
    })),
    history,
    canEdit: expense.status === 'RECORDED' && hasPermission(user, 'expense.edit'),
    canVoid: expense.status === 'RECORDED' && hasPermission(user, 'expense.delete'),
    canAttach: expense.status === 'RECORDED' && hasPermission(user, 'expense.create'),
  };
}

export type ExpenseDetail = Awaited<ReturnType<typeof getExpenseDetail>>;

/** An expense as the form's starting values, for correcting it. */
export function toExpenseDraft(expense: {
  id: string;
  description: string;
  amount: { toString(): string };
  taxRate: { toString(): string } | null;
  taxAmount: { toString(): string } | null;
  taxCodeId: string | null;
  expenseDate: Date;
  vendorName: string | null;
  billNumber: string | null;
  supplierTrn: string | null;
  dueDate: Date | null;
  paymentReference: string | null;
  notes: string | null;
  paymentMethod: string | null;
  paidFromAccountId: string | null;
  paidByUserId: string | null;
  chartOfAccountId: string | null;
  jobCardId?: string | null;
  invoiceId?: string | null;
}) {
  const trim = (value: string) => (value.includes('.') ? value.replace(/\.?0+$/, '') : value);
  return {
    id: expense.id,
    description: expense.description,
    amount: expense.amount.toString(),
    // "5.00" → "5"; a whole number like "10" is left alone.
    taxRate: expense.taxRate ? trim(expense.taxRate.toString()) : '',
    taxAmount: expense.taxAmount ? expense.taxAmount.toString() : '',
    taxCodeId: expense.taxCodeId ?? '',
    expenseDate: expense.expenseDate.toISOString().slice(0, 10),
    vendorName: expense.vendorName ?? '',
    billNumber: expense.billNumber ?? '',
    supplierTrn: expense.supplierTrn ?? '',
    dueDate: expense.dueDate ? expense.dueDate.toISOString().slice(0, 10) : '',
    paymentReference: expense.paymentReference ?? '',
    notes: expense.notes ?? '',
    paymentMethod: expense.paymentMethod ?? '',
    paidFromAccountId: expense.paidFromAccountId ?? '',
    paidByUserId: expense.paidByUserId ?? '',
    categoryId: expense.chartOfAccountId ?? '',
    forJob: expense.jobCardId
      ? `card:${expense.jobCardId}`
      : expense.invoiceId
        ? `invoice:${expense.invoiceId}`
        : '',
  };
}
