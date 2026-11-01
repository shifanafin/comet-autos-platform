import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { allocateDocumentNumber } from '@/lib/numbering';
import { filsToString, toFils } from '@/lib/money';
import { parseLocalDateTime, localDateString } from '@/lib/format';
import { resolveDefaultVatRate } from '@/lib/tax';
import { syncPosting } from '@/lib/accounting/journal';
import { checkMoneyAccount, refuseCardSettlementAccount } from '@/lib/accounting/chart';
import {
  PURCHASE_BALANCE_SELECT,
  RECEIVED_PURCHASE_STATUSES,
  purchaseBalance,
  payableAge,
  supplierPaidFils,
} from '@/lib/finance/supplier-balance';

/*
 * Paying suppliers.
 *
 * The schema already had everything this needs: a SupplierPayment carries an
 * amount, a method, a reference, who paid it and when, a COMPLETED/REVERSED
 * status and a self-reference for a reversal. It just had no way in from the
 * application. This module is that way in, and nothing more — the balance it
 * reads and the balance the screens show come from the same
 * `lib/finance/supplier-balance`, so a payment can never be recorded against
 * a figure the workshop was not looking at.
 *
 * One payment settles one purchase. That is the schema's shape
 * (`SupplierPayment.purchaseId` is required, not nullable), and it is the
 * honest one for a workshop that pays supplier invoices as they come. A
 * single payment spread across several purchases would need an allocation
 * table that does not exist — see PROJECT-STATUS for that decision.
 *
 * What is refused, and why:
 *   - zero or negative       — not a payment;
 *   - more than is owed      — overpayment has no home in this design, the
 *                              same rule as customer payments;
 *   - a future date          — you cannot have paid tomorrow;
 *   - a date before receipt  — you cannot have paid for goods not yet had;
 *   - another organization's — scoped out of every query;
 *   - another branch's       — when the user is tied to one branch.
 */

/** How many rows a screen may pull at once. */
const PAGE = 50;

const paymentSchema = z.object({
  amount: z
    .string({ error: 'Enter the amount paid.' })
    .trim()
    .refine(
      (value) => /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0,
      'Enter an amount like 250 or 250.50.',
    ),
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'], {
    error: 'Choose how the supplier was paid.',
  }),
  paidAt: z
    .string({ error: 'Enter when the payment was made.' })
    .min(1, 'Enter when the payment was made.'),
  referenceNumber: z.string().trim().max(100).optional(),
  /** The cash or bank account it was paid from; blank for the method's default. */
  accountId: z.union([z.literal(''), z.uuid()]).optional(),
  requestKey: z.string().optional(),
});

const reversalSchema = z.object({
  reason: z
    .string({ error: 'Say why the payment is being reversed.' })
    .trim()
    .min(3, 'Say why the payment is being reversed.')
    .max(300),
  requestKey: z.string().optional(),
});

/** A user tied to one branch only ever sees and pays that branch's purchases. */
const branchScope = (user: AuthenticatedUser) =>
  user.primaryBranchId ? { branchId: user.primaryBranchId } : {};

// ─── Reading ────────────────────────────────────────────────────────────────

export interface PayableFilters {
  /** Supplier name, purchase number or the supplier's own invoice number. */
  q?: string;
  supplierId?: string;
  /** Only balances older than this many days. */
  olderThanDays?: string | number;
}

/**
 * The payables overview: what is owed, to whom, and what has been paid
 * lately. Three independent reads run together; nothing is fetched per row.
 */
export async function getPayables(user: AuthenticatedUser, filters: PayableFilters = {}) {
  requirePermission(user, 'supplier_payment.view');
  const q = filters.q?.trim();
  const olderThan = Number(filters.olderThanDays) || 0;

  const where: Prisma.PurchaseWhereInput = {
    organizationId: user.organizationId,
    ...branchScope(user),
    status: { in: [...RECEIVED_PURCHASE_STATUSES] },
    ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
    ...(q
      ? {
          OR: [
            { purchaseNumber: { contains: q, mode: 'insensitive' } },
            { supplierInvoiceNumber: { contains: q, mode: 'insensitive' } },
            { supplier: { name: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [purchases, recentPayments, defaultVat] = await Promise.all([
    prisma.purchase.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }],
      take: 500,
      select: {
        id: true,
        purchaseNumber: true,
        supplierInvoiceNumber: true,
        supplierInvoiceDate: true,
        dueDate: true,
        createdAt: true,
        branchId: true,
        supplier: { select: { id: true, name: true, phone: true } },
        ...PURCHASE_BALANCE_SELECT,
      },
    }),
    listSupplierPayments(user, { limit: 8 }),
    resolveDefaultVatRate(user.organizationId),
  ]);

  const rows = purchases
    .map((purchase) => {
      const money = purchaseBalance(purchase, defaultVat);
      const date = purchase.supplierInvoiceDate ?? purchase.createdAt;
      return {
        id: purchase.id,
        number: purchase.purchaseNumber,
        supplierInvoiceNumber: purchase.supplierInvoiceNumber,
        date,
        supplier: purchase.supplier,
        ...money,
        ...payableAge(date, purchase.dueDate),
      };
    })
    .filter((row) => row.balanceFils > 0)
    .filter((row) => !olderThan || row.ageDays >= olderThan)
    // Oldest first: the bills that need paying are at the top.
    .sort((a, b) => b.ageDays - a.ageDays);

  const bySupplier = new Map<
    string,
    { id: string; name: string; balanceFils: number; count: number }
  >();
  for (const row of rows) {
    const entry = bySupplier.get(row.supplier.id) ?? {
      id: row.supplier.id,
      name: row.supplier.name,
      balanceFils: 0,
      count: 0,
    };
    entry.balanceFils += row.balanceFils;
    entry.count += 1;
    bySupplier.set(row.supplier.id, entry);
  }

  const bucket = (from: number, to?: number) =>
    rows
      .filter((row) => row.ageDays >= from && (to === undefined || row.ageDays <= to))
      .reduce((sum, row) => sum + row.balanceFils, 0);

  const totalFils = rows.reduce((sum, row) => sum + row.balanceFils, 0);
  // Without a due date, "overdue" means older than 30 days (stated on the
  // screen); with one, past it (payableAge).
  const overdueFils = bucket(31);

  return {
    rows,
    suppliers: [...bySupplier.values()]
      .map((entry) => ({ ...entry, balance: filsToString(entry.balanceFils) }))
      .sort((a, b) => b.balanceFils - a.balanceFils),
    recentPayments,
    totals: {
      balance: filsToString(totalFils),
      balanceFils: totalFils,
      purchases: rows.length,
      suppliers: bySupplier.size,
      overdue: filsToString(overdueFils),
      overdueCount: rows.filter((row) => row.ageDays >= 31).length,
      ageing: {
        current: filsToString(bucket(0, 30)),
        thirty: filsToString(bucket(31, 60)),
        sixty: filsToString(bucket(61, 90)),
        ninety: filsToString(bucket(91)),
      },
    },
  };
}

export type Payables = Awaited<ReturnType<typeof getPayables>>;
export type PayableRow = Payables['rows'][number];

/**
 * A supplier's money in one place: what has been bought, what has been paid,
 * and what is still owed — with the purchases making up that balance.
 */
export async function getSupplierPayables(user: AuthenticatedUser, supplierId: string) {
  requirePermission(user, 'supplier_payment.view');
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, organizationId: user.organizationId },
    select: {
      id: true,
      name: true,
      contactName: true,
      phone: true,
      email: true,
      address: true,
      isActive: true,
    },
  });
  if (!supplier) throw new NotFoundError('supplier');

  const [purchases, payments, defaultVat] = await Promise.all([
    prisma.purchase.findMany({
      where: {
        organizationId: user.organizationId,
        ...branchScope(user),
        supplierId: supplier.id,
        status: { in: [...RECEIVED_PURCHASE_STATUSES] },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: PAGE,
      select: {
        id: true,
        purchaseNumber: true,
        supplierInvoiceNumber: true,
        supplierInvoiceDate: true,
        dueDate: true,
        createdAt: true,
        // status comes with the balance select.
        ...PURCHASE_BALANCE_SELECT,
      },
    }),
    listSupplierPayments(user, { supplierId: supplier.id, limit: PAGE }),
    resolveDefaultVatRate(user.organizationId),
  ]);

  const rows = purchases.map((purchase) => {
    const money = purchaseBalance(purchase, defaultVat);
    const date = purchase.supplierInvoiceDate ?? purchase.createdAt;
    return {
      id: purchase.id,
      number: purchase.purchaseNumber,
      supplierInvoiceNumber: purchase.supplierInvoiceNumber,
      date,
      status: purchase.status,
      ...money,
      ...payableAge(date, purchase.dueDate),
    };
  });

  const receivedFils = rows.reduce((sum, row) => sum + row.receivedFils, 0);
  const paidFils = rows.reduce((sum, row) => sum + row.paidFils, 0);

  return {
    supplier,
    purchases: rows.sort((a, b) => b.date.getTime() - a.date.getTime()),
    /** Only the purchases that still owe something, oldest first. */
    owing: rows.filter((row) => row.balanceFils > 0).sort((a, b) => b.ageDays - a.ageDays),
    payments,
    totals: {
      received: filsToString(receivedFils),
      paid: filsToString(paidFils),
      balance: filsToString(Math.max(receivedFils - paidFils, 0)),
      balanceFils: Math.max(receivedFils - paidFils, 0),
      purchaseCount: rows.length,
    },
  };
}

export type SupplierPayables = Awaited<ReturnType<typeof getSupplierPayables>>;

/** Payment history. Reversals and what they reversed both stay on record. */
export async function listSupplierPayments(
  user: AuthenticatedUser,
  filters: { supplierId?: string; purchaseId?: string; q?: string; limit?: number } = {},
) {
  requirePermission(user, 'supplier_payment.view');
  const q = filters.q?.trim();
  const payments = await prisma.supplierPayment.findMany({
    where: {
      organizationId: user.organizationId,
      purchase: {
        ...branchScope(user),
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
      },
      ...(filters.purchaseId ? { purchaseId: filters.purchaseId } : {}),
      ...(q
        ? {
            OR: [
              { supplierPaymentNumber: { contains: q, mode: 'insensitive' } },
              { referenceNumber: { contains: q, mode: 'insensitive' } },
              { purchase: { purchaseNumber: { contains: q, mode: 'insensitive' } } },
              { purchase: { supplier: { name: { contains: q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    },
    orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
    take: Math.min(filters.limit ?? PAGE, 200),
    select: {
      id: true,
      supplierPaymentNumber: true,
      amount: true,
      method: true,
      status: true,
      referenceNumber: true,
      paidAt: true,
      reversalOfSupplierPaymentId: true,
      paidBy: { select: { fullName: true } },
      reversals: { select: { id: true } },
      purchase: {
        select: {
          id: true,
          purchaseNumber: true,
          supplier: { select: { id: true, name: true } },
        },
      },
    },
  });

  return payments.map((payment) => ({
    ...payment,
    amount: payment.amount.toString(),
    isReversal: payment.reversalOfSupplierPaymentId !== null,
    /** A payment that has been reversed no longer counts towards the balance. */
    wasReversed: payment.reversals.length > 0,
  }));
}

export type SupplierPaymentRow = Awaited<ReturnType<typeof listSupplierPayments>>[number];

/**
 * Everything the payment form needs: the purchase, the supplier, and the
 * balance as it stands right now. Read through the same rule the write
 * checks against, so the number on the screen is the number enforced.
 */
export async function getPurchaseForPayment(user: AuthenticatedUser, purchaseId: string) {
  requirePermission(user, 'supplier_payment.view');
  const defaultVat = await resolveDefaultVatRate(user.organizationId);
  const purchase = await prisma.purchase.findFirst({
    where: {
      id: purchaseId,
      organizationId: user.organizationId,
      ...branchScope(user),
      status: { in: [...RECEIVED_PURCHASE_STATUSES] },
    },
    select: {
      id: true,
      purchaseNumber: true,
      supplierInvoiceNumber: true,
      supplierInvoiceDate: true,
      receivedAt: true,
      createdAt: true,
      branchId: true,
      supplier: { select: { id: true, name: true } },
      ...PURCHASE_BALANCE_SELECT,
    },
  });
  if (!purchase) throw new NotFoundError('purchase');
  return {
    id: purchase.id,
    number: purchase.purchaseNumber,
    supplierInvoiceNumber: purchase.supplierInvoiceNumber,
    supplier: purchase.supplier,
    receivedAt: purchase.receivedAt,
    date: purchase.supplierInvoiceDate ?? purchase.createdAt,
    ...purchaseBalance(purchase, defaultVat),
  };
}

// ─── Writing ────────────────────────────────────────────────────────────────

/**
 * Records money paid to a supplier against one received purchase.
 *
 * The purchase row is locked for the length of the transaction, so two
 * payments racing each other are serialised and the second sees the first's
 * effect on the balance — a double-click cannot get past the overpayment
 * check by reading a stale figure. The request key stops the same submission
 * being counted twice at all.
 */
export async function recordSupplierPayment(
  user: AuthenticatedUser,
  purchaseId: string,
  rawInput: unknown,
) {
  const input = parseInput(paymentSchema, rawInput);
  requirePermission(user, 'supplier_payment.create');

  const paidAt = parseLocalDateTime(input.paidAt);
  if (!paidAt) throw new DomainError('Enter a valid date and time.', 'paidAt');
  if (paidAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new DomainError('A payment can’t be dated in the future.', 'paidAt');
  }
  const amount = toFils(input.amount);
  if (amount <= 0) throw new DomainError('Enter an amount greater than zero.', 'amount');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'supplier_payment.record');
    const result = await takeSupplierPayment(tx, user, purchaseId, {
      amountFils: amount,
      method: input.method,
      accountId: input.accountId,
      referenceNumber: input.referenceNumber,
      paidAt,
    });
    await settleRequestKey(tx, user, rawInput, result.id);
    return result;
  });
}

export interface SupplierPaymentInput {
  /** Fils; null pays everything still owed on the purchase. */
  amountFils: number | null;
  method: (typeof paymentSchema.shape.method.options)[number];
  accountId?: string | null;
  referenceNumber?: string | null;
  paidAt: Date;
}

/**
 * The supplier payment rules themselves, inside a transaction the caller
 * holds — shared by a payment made on its own and one made as the goods are
 * received ("paid now"), so both follow exactly the same rules: a received
 * purchase, never more than is owed, never from card settlements, a payment
 * number, its posting and an audit entry.
 */
export async function takeSupplierPayment(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  purchaseId: string,
  input: SupplierPaymentInput,
) {
  requirePermission(user, 'supplier_payment.create');
  const { paidAt } = input;
  const defaultVat = await resolveDefaultVatRate(user.organizationId, tx);

  const purchase = await tx.purchase.findFirst({
    where: { id: purchaseId, organizationId: user.organizationId },
    select: {
      id: true,
      purchaseNumber: true,
      branchId: true,
      status: true,
      receivedAt: true,
      supplier: { select: { id: true, name: true } },
    },
  });
  // Another organization's purchase is not found, never forbidden.
  if (!purchase) throw new NotFoundError('purchase');
  // A branch-scoped user pays only their own branch's bills.
  if (user.primaryBranchId && purchase.branchId !== user.primaryBranchId) {
    throw new NotFoundError('purchase');
  }
  if (!RECEIVED_PURCHASE_STATUSES.includes(purchase.status as 'RECEIVED')) {
    throw new DomainError(
      'Only a purchase that has been received can be paid. Receive the delivery first.',
    );
  }
  // By the day: goods dated by their purchase date are stamped midday, and a
  // payment that morning is not before them.
  if (purchase.receivedAt && localDateString(paidAt) < localDateString(purchase.receivedAt)) {
    throw new DomainError('A payment can’t be dated before the goods were received.', 'paidAt');
  }

  // Serialise concurrent payments on this purchase.
  await tx.$executeRaw`SELECT id FROM purchases WHERE id = ${purchase.id}::uuid FOR UPDATE`;

  const fresh = await tx.purchase.findUniqueOrThrow({
    where: { id: purchase.id },
    select: PURCHASE_BALANCE_SELECT,
  });
  const money = purchaseBalance(fresh, defaultVat);
  if (money.balanceFils === 0) {
    throw new DomainError('This purchase is already fully paid.');
  }
  const amount = input.amountFils ?? money.balanceFils;
  if (amount <= 0) throw new DomainError('Enter an amount greater than zero.', 'amount');
  if (amount > money.balanceFils) {
    throw new DomainError(
      `That is more than the ${money.balance} still owed on this purchase.`,
      'amount',
    );
  }

  const supplierPaymentNumber = await allocateDocumentNumber(
    tx,
    user.organizationId,
    purchase.branchId,
    'SUPPLIER_PAYMENT',
  );
  await refuseCardSettlementAccount(
    tx,
    user.organizationId,
    input.method,
    input.accountId || null,
    'method',
  );
  const payment = await tx.supplierPayment.create({
    data: {
      organizationId: user.organizationId,
      purchaseId: purchase.id,
      supplierPaymentNumber,
      amount: filsToString(amount),
      method: input.method,
      accountId: await checkMoneyAccount(tx, user.organizationId, input.accountId),
      status: 'COMPLETED',
      referenceNumber: emptyToNull(input.referenceNumber),
      paidAt,
      paidByUserId: user.id,
    },
    select: { id: true, supplierPaymentNumber: true, amount: true },
  });
  await syncPosting(tx, user.organizationId, 'SUPPLIER_PAYMENT', payment.id, user.id);

  const balanceAfter = money.balanceFils - amount;
  await writeAuditLog(tx, {
    organizationId: user.organizationId,
    branchId: purchase.branchId,
    actorUserId: user.id,
    action: 'supplier_payment.recorded',
    entityType: 'SupplierPayment',
    entityId: payment.id,
    afterData: {
      supplierPaymentNumber,
      purchaseId: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      supplierId: purchase.supplier.id,
      supplierName: purchase.supplier.name,
      amount: filsToString(amount),
      method: input.method,
      balanceBefore: money.balance,
      balanceAfter: filsToString(balanceAfter),
    },
  });

  return {
    id: payment.id,
    supplierPaymentNumber,
    amount: filsToString(amount),
    purchaseId: purchase.id,
    supplierId: purchase.supplier.id,
    balanceAfter: filsToString(balanceAfter),
    fullySettled: balanceAfter === 0,
  };
}

/**
 * Reverses a payment that should not have been made.
 *
 * Nothing is deleted: the original keeps its row and is marked REVERSED, and
 * a matching reversal row is written against the same purchase. Both drop
 * out of the balance (see `supplierPaidFils`), so the money comes back onto
 * the bill and the history still shows what happened and why.
 */
export async function reverseSupplierPayment(
  user: AuthenticatedUser,
  paymentId: string,
  rawInput: unknown,
) {
  const input = parseInput(reversalSchema, rawInput);
  requirePermission(user, 'supplier_payment.delete');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'supplier_payment.reversal');

    const payment = await tx.supplierPayment.findFirst({
      where: { id: paymentId, organizationId: user.organizationId },
      select: {
        id: true,
        amount: true,
        method: true,
        status: true,
        supplierPaymentNumber: true,
        reversalOfSupplierPaymentId: true,
        reversals: { select: { id: true } },
        purchase: {
          select: {
            id: true,
            purchaseNumber: true,
            branchId: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!payment) throw new NotFoundError('payment');
    if (user.primaryBranchId && payment.purchase.branchId !== user.primaryBranchId) {
      throw new NotFoundError('payment');
    }
    if (payment.reversalOfSupplierPaymentId) {
      throw new DomainError('That row is itself a reversal.');
    }
    if (payment.status === 'REVERSED' || payment.reversals.length > 0) {
      throw new DomainError('This payment has already been reversed.');
    }

    await tx.$executeRaw`SELECT id FROM purchases WHERE id = ${payment.purchase.id}::uuid FOR UPDATE`;

    const reversalNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      payment.purchase.branchId,
      'SUPPLIER_PAYMENT',
    );
    const reversal = await tx.supplierPayment.create({
      data: {
        organizationId: user.organizationId,
        purchaseId: payment.purchase.id,
        supplierPaymentNumber: reversalNumber,
        // The reversal carries the same amount; it is identified as a
        // reversal by its link, not by a negative number.
        amount: payment.amount.toString(),
        method: payment.method,
        status: 'REVERSED',
        referenceNumber: `Reversal of ${payment.supplierPaymentNumber ?? payment.id}`,
        reversalOfSupplierPaymentId: payment.id,
        paidAt: new Date(),
        paidByUserId: user.id,
      },
      select: { id: true, supplierPaymentNumber: true },
    });
    await tx.supplierPayment.update({
      where: { id: payment.id },
      data: { status: 'REVERSED' },
    });
    await syncPosting(tx, user.organizationId, 'SUPPLIER_PAYMENT', reversal.id, user.id);

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: payment.purchase.branchId,
      actorUserId: user.id,
      action: 'supplier_payment.reversed',
      entityType: 'SupplierPayment',
      entityId: payment.id,
      beforeData: { status: payment.status, amount: payment.amount.toString() },
      afterData: { status: 'REVERSED', reversalId: reversal.id, reversalNumber },
      metadata: {
        reason: input.reason,
        purchaseId: payment.purchase.id,
        purchaseNumber: payment.purchase.purchaseNumber,
        supplierName: payment.purchase.supplier.name,
      },
    });
    await settleRequestKey(tx, user, rawInput, reversal.id);

    return {
      id: reversal.id,
      reversedPaymentId: payment.id,
      supplierId: payment.purchase.supplier.id,
    };
  });
}

/** Unused-export guard for the shared rule, kept importable from one place. */
export { supplierPaidFils };
