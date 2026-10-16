import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { CustomerAdvanceStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { filsToString, toFils } from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { emptyToNull } from '@/lib/normalize';
import { allocateDocumentNumber } from '@/lib/numbering';
import { syncPosting } from '@/lib/accounting/journal';
import { checkMoneyAccount, refuseCardSettlementAccount } from '@/lib/accounting/chart';
import { resolveInventoryBranch } from '@/lib/inventory/stock';
import { dueFils, paidFils, settlementStatus } from '@/lib/billing/invoice';
import { applyJobStatusChange, normalizeStatus } from '@/lib/workshop/job-status';
import { getVatSettings } from '@/lib/tax';
import { vatIncluded } from '@/lib/billing/advance-vat';

/*
 * Customer advances — money a customer pays before their invoice exists:
 * "AED 2,000 towards the Patrol's repair", taken when the job card is
 * opened, applied when the job is invoiced.
 *
 *   Receive (ADV-)    Dr the cash, bank or card account / Cr Customer
 *                     advances (2030, a liability: owed to the customer in
 *                     work, or back)
 *   Apply             Dr Customer advances / Cr Trade receivables. The
 *                     invoice is settled by that much, like a payment —
 *                     without being one. Its revenue, taxable amount and
 *                     VAT do not change.
 *   Refund            Dr Customer advances / Cr the account paid from
 *   Cancel            only while none of it is used: its entry is reversed
 *
 * Nothing is deleted or edited. An application or refund is undone (its
 * entry reversed) and stays on record. Payment.invoiceId stays required: an
 * advance is its own record, never a payment without an invoice.
 *
 * Partial and multiple: one advance can be applied to several invoices, and
 * one invoice can take several advances. What is left on an advance =
 * amount − applications standing − refunds standing, worked out, never
 * stored; a database check keeps it from going below zero, and keeps each
 * invoice's `advanceAppliedAmount` equal to the applications against it.
 *
 * A credit note that leaves an invoice over-settled gives money back to the
 * customer's advances first — a negative application, dated on the credit
 * note — and only the rest is refunded in cash. Voiding the credit note
 * reverses that return.
 *
 * VAT, confirmed by the accountant (16 Oct 2026): in the UAE an advance is
 * taxable the day it is received (the date of supply is the earlier of the
 * work, the invoice or the payment). A VAT-registered workshop records each
 * new advance VAT_ON_RECEIPT: the VAT included in it is booked to output VAT
 * when received, and released as it is applied or refunded, so the invoice's
 * VAT is never counted twice (lib/billing/advance-vat.ts). A workshop not
 * registered records VAT_ON_INVOICE (no VAT on the advance). Advances taken
 * before, recorded PENDING_ACCOUNTANT_CONFIRMATION, keep their booking.
 */

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;

/** Fils from a stored amount that may be below zero (a return to the advance). */
const signedFils = (value: { toString(): string }) => {
  const text = value.toString();
  return text.startsWith('-') ? -toFils(text.slice(1)) : toFils(text);
};

const AMOUNT = z
  .string({ error: 'Enter the amount.' })
  .trim()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter the amount like 500.00.');

const DATE = (message: string) =>
  z
    .string({ error: message })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, message);

const METHOD = z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'], {
  error: 'Choose how the money was paid.',
});

const REASON = z
  .string({ error: 'Say why.' })
  .trim()
  .min(3, 'Say why, in a few words.')
  .max(300, 'Keep the reason under 300 characters.');

/** A calendar date given on a form: valid, and not in the future. */
function readDay(value: string | undefined, field: string, what: string) {
  const day = value?.trim() || localDateString();
  const date = parseCalendarDate(day);
  if (!date) throw new DomainError(`Enter the date ${what}.`, field);
  if (day > localDateString()) {
    throw new DomainError(`The date ${what} cannot be in the future.`, field);
  }
  return { day, date };
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

// ─── Figures ────────────────────────────────────────────────────────────────

/** An advance's status from what is applied and refunded. */
export function advanceStatusFor(
  amountFils: number,
  appliedFils: number,
  refundedFils: number,
): Exclude<CustomerAdvanceStatus, 'CANCELLED'> {
  const left = amountFils - appliedFils - refundedFils;
  if (appliedFils === 0 && refundedFils === 0) return 'OPEN';
  if (left > 0) return 'PARTIALLY_APPLIED';
  return refundedFils > 0 ? 'REFUNDED' : 'FULLY_APPLIED';
}

interface AdvanceRows {
  amount: { toString(): string };
  allocations: { amount: { toString(): string }; reversedAt: Date | null }[];
  refunds: { amount: { toString(): string }; reversedAt: Date | null }[];
}

/** Received, applied (less any returned), refunded and left, in fils. */
export function advanceFigures(advance: AdvanceRows) {
  const amount = toFils(advance.amount.toString());
  const applied = advance.allocations
    .filter((row) => !row.reversedAt)
    .reduce((sum, row) => sum + signedFils(row.amount), 0);
  const refunded = advance.refunds
    .filter((row) => !row.reversedAt)
    .reduce((sum, row) => sum + toFils(row.amount.toString()), 0);
  return { amount, applied, refunded, left: amount - applied - refunded };
}

const STANDING_ROWS = {
  allocations: { where: { reversedAt: null }, select: { amount: true, reversedAt: true } },
  refunds: { where: { reversedAt: null }, select: { amount: true, reversedAt: true } },
} satisfies Prisma.CustomerAdvanceInclude;

/**
 * Books every application and refund of an advance again. The VAT each one
 * releases depends on the ones before it (lib/billing/advance-vat.ts), so
 * when one is added or undone, the rest are put in step too. Unchanged
 * entries are left as they are.
 */
async function syncAdvanceMovements(
  tx: Tx,
  organizationId: string,
  advanceId: string,
  userId: string,
) {
  const [allocations, refunds] = await Promise.all([
    tx.customerAdvanceAllocation.findMany({
      where: { organizationId, advanceId },
      orderBy: [{ allocatedOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    tx.customerAdvanceRefund.findMany({
      where: { organizationId, advanceId },
      orderBy: [{ refundedOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
  ]);
  for (const row of allocations) {
    await syncPosting(tx, organizationId, 'CUSTOMER_ADVANCE_ALLOCATION', row.id, userId);
  }
  for (const row of refunds) {
    await syncPosting(tx, organizationId, 'CUSTOMER_ADVANCE_REFUND', row.id, userId);
  }
}

/** Puts an advance's status in step with what is applied and refunded. */
async function refreshAdvanceStatus(tx: Tx, advanceId: string) {
  const advance = await tx.customerAdvance.findUniqueOrThrow({
    where: { id: advanceId },
    include: STANDING_ROWS,
  });
  if (advance.status === 'CANCELLED') return advance.status;
  const figures = advanceFigures(advance);
  const status = advanceStatusFor(figures.amount, figures.applied, figures.refunded);
  if (status !== advance.status) {
    await tx.customerAdvance.update({ where: { id: advance.id }, data: { status } });
  }
  return status;
}

/** What a customer has paid in advance and not yet had applied or refunded, in fils. */
export async function customerAdvanceHeld(
  client: Client,
  organizationId: string,
  customerId: string,
) {
  const advances = await client.customerAdvance.findMany({
    where: { organizationId, customerId, status: { not: 'CANCELLED' } },
    include: STANDING_ROWS,
  });
  return advances.reduce((sum, advance) => sum + advanceFigures(advance).left, 0);
}

// ─── Locks ──────────────────────────────────────────────────────────────────

/**
 * Locks an invoice for a change to what settles it — its job card first, as
 * everything that changes an invoice does, so two paths never take the pair
 * in opposite orders. Advances are always locked after their invoice.
 */
async function lockInvoice(tx: Tx, organizationId: string, invoiceId: string) {
  const target = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: { id: true, jobCardId: true },
  });
  if (!target) throw new NotFoundError('invoice');
  if (target.jobCardId) {
    await tx.$executeRaw`SELECT id FROM job_cards WHERE id = ${target.jobCardId}::uuid FOR UPDATE`;
  }
  await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${target.id}::uuid FOR UPDATE`;
  return tx.invoice.findUniqueOrThrow({
    where: { id: target.id },
    include: {
      payments: { select: { id: true, amount: true, status: true, reversalOfPaymentId: true } },
      jobCard: { select: { id: true, status: true } },
    },
  });
}

async function lockAdvance(tx: Tx, organizationId: string, advanceId: string) {
  await tx.$executeRaw`SELECT id FROM customer_advances WHERE id = ${advanceId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const advance = await tx.customerAdvance.findFirst({
    where: { id: advanceId, organizationId },
    include: STANDING_ROWS,
  });
  if (!advance) throw new NotFoundError('customer advance');
  return advance;
}

// ─── Receive ────────────────────────────────────────────────────────────────

const receiveSchema = z.object({
  customerId: z.uuid({ error: 'Choose the customer.' }),
  vehicleId: z.union([z.literal(''), z.uuid()]).optional(),
  /** Required: an advance is always held for a job, and applied to its invoice. */
  jobCardId: z.uuid({ error: 'Choose the job card this advance is for.' }),
  amount: AMOUNT,
  receivedOn: DATE('Enter the date it was received.'),
  method: METHOD,
  /** The cash, bank or card account it went into; blank for the method's default. */
  accountId: z.union([z.literal(''), z.uuid()]).optional(),
  reference: z.string().trim().max(100, 'Keep the reference under 100 characters.').optional(),
  notes: z.string().trim().max(500, 'Keep the notes under 500 characters.').optional(),
  requestKey: z.string().optional(),
});

/**
 * Records money a customer paid in advance towards one of their job cards
 * (and so its vehicle), and books it to Customer advances.
 */
export async function receiveCustomerAdvance(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(receiveSchema, rawInput);
  const amount = toFils(input.amount);
  if (amount <= 0) throw new DomainError('Enter an amount above zero.', 'amount');
  const received = readDay(input.receivedOn, 'receivedOn', 'it was received');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'advance.receive');
    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, organizationId: user.organizationId },
      select: { id: true, name: true },
    });
    if (!customer) throw new DomainError('Choose the customer.', 'customerId');

    let vehicleId = emptyToNull(input.vehicleId);
    const jobCardId = emptyToNull(input.jobCardId);
    let branchId: string | null = null;
    if (jobCardId) {
      const job = await tx.jobCard.findFirst({
        where: { id: jobCardId, organizationId: user.organizationId },
        select: { customerId: true, vehicleId: true, branchId: true, status: true },
      });
      if (!job || job.customerId !== customer.id) {
        throw new DomainError('Choose one of this customer’s job cards.', 'jobCardId');
      }
      if (job.status === 'CANCELLED') {
        throw new DomainError('That job card is cancelled.', 'jobCardId');
      }
      if (vehicleId && vehicleId !== job.vehicleId) {
        throw new DomainError('That job card is for a different vehicle.', 'vehicleId');
      }
      vehicleId = job.vehicleId;
      branchId = job.branchId;
    } else if (vehicleId) {
      const vehicle = await tx.vehicle.findFirst({
        where: { id: vehicleId, organizationId: user.organizationId },
        select: { customerId: true },
      });
      if (!vehicle || vehicle.customerId !== customer.id) {
        throw new DomainError('Choose one of this customer’s vehicles.', 'vehicleId');
      }
    }
    branchId ??= (await resolveInventoryBranch(user, tx)).id;
    requirePermission(user, 'customer_advance.create', { branchId });
    const accountId = await checkMoneyAccount(tx, user.organizationId, input.accountId);

    const advanceNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      branchId,
      'CUSTOMER_ADVANCE',
    );
    // VAT is due the day it is received, on the VAT included in it.
    const vatSettings = await getVatSettings(user.organizationId, tx);
    const onReceipt = vatSettings.isVatRegistered;
    const vatFils = onReceipt ? vatIncluded(amount, vatSettings.vatRate) : 0;
    const vatTreatment = onReceipt ? ('VAT_ON_RECEIPT' as const) : ('VAT_ON_INVOICE' as const);
    const advance = await tx.customerAdvance.create({
      data: {
        organizationId: user.organizationId,
        branchId,
        customerId: customer.id,
        vehicleId,
        jobCardId,
        advanceNumber,
        amount: filsToString(amount),
        receivedOn: received.date,
        method: input.method,
        accountId,
        reference: emptyToNull(input.reference),
        notes: emptyToNull(input.notes),
        vatTreatment,
        vatRate: onReceipt ? vatSettings.vatRate : null,
        vatAmount: filsToString(vatFils),
        receivedByUserId: user.id,
      },
      select: { id: true, advanceNumber: true },
    });
    await syncPosting(tx, user.organizationId, 'CUSTOMER_ADVANCE', advance.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId,
      actorUserId: user.id,
      action: 'customer_advance.received',
      entityType: 'CustomerAdvance',
      entityId: advance.id,
      afterData: {
        advanceNumber,
        customerId: customer.id,
        vehicleId,
        jobCardId,
        amount: filsToString(amount),
        receivedOn: received.day,
        method: input.method,
        accountId,
        reference: emptyToNull(input.reference),
        vatTreatment,
        vatAmount: filsToString(vatFils),
      },
    });
    await settleRequestKey(tx, user, rawInput, advance.id);
    return advance;
  });
}

// ─── Apply to an invoice ────────────────────────────────────────────────────

const applySchema = z.object({
  invoiceId: z.uuid({ error: 'Choose the invoice.' }),
  amount: AMOUNT,
  allocatedOn: z.string().trim().optional(),
  requestKey: z.string().optional(),
});

/**
 * Applies part or all of an advance to one of the same customer's invoices:
 * never more than is left on the advance, never more than is due on the
 * invoice. The invoice settles as with a payment (PARTIALLY_PAID / PAID) and
 * a job card it fully settles moves from Invoiced to Paid.
 */
export async function applyCustomerAdvance(
  user: AuthenticatedUser,
  advanceId: string,
  rawInput: unknown,
) {
  const input = parseInput(applySchema, rawInput);
  const amount = toFils(input.amount);
  if (amount <= 0) throw new DomainError('Enter an amount above zero.', 'amount');
  const applied = readDay(input.allocatedOn, 'allocatedOn', 'it is applied');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'advance.apply');
    const result = await applyAdvanceInTransaction(tx, user, {
      advanceId,
      invoiceId: input.invoiceId,
      amountFils: amount,
      applied,
    });
    await settleRequestKey(tx, user, rawInput, result.allocationId);
    return result;
  });
}

/**
 * The rules of applying an advance, inside a transaction the caller holds —
 * shared by applying one from the advance or invoice screens and applying
 * the customer's advances as a new invoice is issued, so both follow exactly
 * the same rules.
 */
async function applyAdvanceInTransaction(
  tx: Tx,
  user: AuthenticatedUser,
  input: {
    advanceId: string;
    invoiceId: string;
    amountFils: number;
    applied: { day: string; date: Date };
  },
) {
  const { advanceId, applied } = input;
  const amount = input.amountFils;
  const invoice = await lockInvoice(tx, user.organizationId, input.invoiceId);
  requirePermission(user, 'customer_advance.edit', { branchId: invoice.branchId });
  const advance = await lockAdvance(tx, user.organizationId, advanceId);

  if (advance.status === 'CANCELLED') throw new DomainError('This advance is cancelled.');
  if (invoice.customerId !== advance.customerId) {
    throw new DomainError('That invoice is for a different customer.', 'invoiceId');
  }
  if (invoice.invoiceType === 'PROFORMA') {
    throw new DomainError(
      'A pro-forma invoice is not owed. Apply it to the tax invoice.',
      'invoiceId',
    );
  }
  if (invoice.status === 'PAID')
    throw new DomainError('That invoice is already fully paid.', 'invoiceId');
  if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIALLY_PAID') {
    throw new DomainError('That invoice cannot be settled.', 'invoiceId');
  }
  const left = advanceFigures(advance).left;
  if (amount > left) {
    throw new DomainError(`Only ${filsToString(left)} is left on this advance.`, 'amount');
  }
  const paid = paidFils(invoice.payments);
  const due = dueFils(invoice, paid);
  if (amount > due) {
    throw new DomainError(
      `Only ${filsToString(due)} is due on ${invoice.invoiceNumber}.`,
      'amount',
    );
  }
  if (applied.day < dayOf(advance.receivedOn)) {
    throw new DomainError('It cannot be applied before the advance was received.', 'allocatedOn');
  }
  if (applied.day < dayOf(invoice.issueDate)) {
    throw new DomainError('It cannot be applied before the invoice was issued.', 'allocatedOn');
  }

  const allocation = await tx.customerAdvanceAllocation.create({
    data: {
      organizationId: user.organizationId,
      advanceId: advance.id,
      invoiceId: invoice.id,
      amount: filsToString(amount),
      allocatedOn: applied.date,
      createdByUserId: user.id,
    },
    select: { id: true },
  });
  const advanceAppliedAmount = filsToString(
    toFils(invoice.advanceAppliedAmount.toString()) + amount,
  );
  const status = settlementStatus({ ...invoice, advanceAppliedAmount }, paid);
  await tx.invoice.update({ where: { id: invoice.id }, data: { advanceAppliedAmount, status } });
  await syncAdvanceMovements(tx, user.organizationId, advance.id, user.id);
  const advanceStatus = await refreshAdvanceStatus(tx, advance.id);

  if (
    status === 'PAID' &&
    invoice.jobCard &&
    normalizeStatus(invoice.jobCard.status) === 'INVOICED'
  ) {
    await applyJobStatusChange(tx, {
      organizationId: user.organizationId,
      jobCardId: invoice.jobCard.id,
      toStatus: 'PAID',
      actor: { userId: user.id },
      source: 'workflow',
      metadata: { invoiceId: invoice.id, advanceId: advance.id },
    });
  }
  await writeAuditLog(tx, {
    organizationId: user.organizationId,
    branchId: invoice.branchId,
    actorUserId: user.id,
    action: 'customer_advance.applied',
    entityType: 'CustomerAdvanceAllocation',
    entityId: allocation.id,
    afterData: {
      advanceNumber: advance.advanceNumber,
      invoiceNumber: invoice.invoiceNumber,
      amount: filsToString(amount),
      allocatedOn: applied.day,
      invoiceStatus: status,
      invoiceBalanceAfter: filsToString(due - amount),
      advanceLeftAfter: filsToString(left - amount),
      advanceStatus,
    },
    metadata: { advanceId: advance.id, invoiceId: invoice.id },
  });
  return { allocationId: allocation.id, invoiceId: invoice.id, advanceId: advance.id };
}

/**
 * As a new invoice is issued, in its transaction: applies up to `amountFils`
 * of the customer's advances to it, oldest advance first, each by the usual
 * rules. Returns how much was applied (no more than is held or due).
 */
export async function applyHeldAdvances(
  tx: Tx,
  user: AuthenticatedUser,
  invoice: { id: string; customerId: string },
  amountFils: number,
) {
  if (amountFils <= 0) return 0;
  const advances = await tx.customerAdvance.findMany({
    where: {
      organizationId: user.organizationId,
      customerId: invoice.customerId,
      status: { in: ['OPEN', 'PARTIALLY_APPLIED'] },
    },
    orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
    include: STANDING_ROWS,
  });
  const held = advances.reduce((sum, advance) => sum + advanceFigures(advance).left, 0);
  if (amountFils > held) {
    throw new DomainError(
      `Only ${filsToString(held)} is held for this customer in advances.`,
      'advanceAmount',
    );
  }
  const today = localDateString();
  let left = amountFils;
  for (const advance of advances) {
    if (left === 0) break;
    const take = Math.min(advanceFigures(advance).left, left);
    if (take <= 0) continue;
    await applyAdvanceInTransaction(tx, user, {
      advanceId: advance.id,
      invoiceId: invoice.id,
      amountFils: take,
      applied: { day: today, date: parseCalendarDate(today)! },
    });
    left -= take;
  }
  return amountFils - left;
}

/**
 * The customer's advances with money left, for a new invoice's form — or
 * null when the user may not see advances.
 */
export async function getHeldAdvances(user: AuthenticatedUser, customerId: string) {
  if (!hasPermission(user, 'customer_advance.view')) return null;
  const advances = await prisma.customerAdvance.findMany({
    where: {
      organizationId: user.organizationId,
      customerId,
      status: { in: ['OPEN', 'PARTIALLY_APPLIED'] },
    },
    orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
    include: { ...STANDING_ROWS, jobCard: { select: { jobNumber: true } } },
  });
  const rows = advances
    .map((advance) => ({
      advanceNumber: advance.advanceNumber,
      jobNumber: advance.jobCard?.jobNumber ?? null,
      left: advanceFigures(advance).left,
    }))
    .filter((row) => row.left > 0);
  return {
    advances: rows.map((row) => ({ ...row, left: filsToString(row.left) })),
    total: filsToString(rows.reduce((sum, row) => sum + row.left, 0)),
    canApply: hasPermission(user, 'customer_advance.edit'),
  };
}

export type HeldAdvances = NonNullable<Awaited<ReturnType<typeof getHeldAdvances>>>;

const reasonSchema = z.object({ reason: REASON, requestKey: z.string().optional() });

/**
 * Undoes an application entered in error: kept on record, its entry
 * reversed, the money back on the advance and owed again on the invoice. A
 * paid job card not yet handed back returns to Invoiced.
 */
export async function undoAdvanceApplication(
  user: AuthenticatedUser,
  allocationId: string,
  rawInput: unknown,
) {
  const input = parseInput(reasonSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'advance.unapply');
    const found = await tx.customerAdvanceAllocation.findFirst({
      where: { id: allocationId, organizationId: user.organizationId },
      select: { id: true, invoiceId: true, advanceId: true },
    });
    if (!found) throw new NotFoundError('advance application');
    const invoice = await lockInvoice(tx, user.organizationId, found.invoiceId);
    requirePermission(user, 'customer_advance.edit', { branchId: invoice.branchId });
    const advance = await lockAdvance(tx, user.organizationId, found.advanceId);
    const allocation = await tx.customerAdvanceAllocation.findUniqueOrThrow({
      where: { id: found.id },
    });

    if (allocation.reversedAt) throw new DomainError('This application has already been undone.');
    if (allocation.creditNoteId) {
      throw new DomainError(
        'Money returned to the advance by a credit note stands until that credit note is voided.',
      );
    }
    if (invoice.status === 'VOID' || invoice.status === 'CANCELLED') {
      throw new DomainError('That invoice is void.');
    }
    // A credit note worked out what to return, or refund, from what was applied.
    const returned = await tx.customerAdvanceAllocation.findFirst({
      where: {
        organizationId: user.organizationId,
        invoiceId: invoice.id,
        reversedAt: null,
        creditNoteId: { not: null },
      },
      select: { creditNote: { select: { creditNoteNumber: true } } },
    });
    if (returned) {
      throw new DomainError(
        `Credit note ${returned.creditNote?.creditNoteNumber} returned part of the advances on this invoice. Void the credit note first.`,
      );
    }
    const refunding = await tx.creditNote.findFirst({
      where: {
        organizationId: user.organizationId,
        invoiceId: invoice.id,
        status: 'ISSUED',
        refundAmount: { gt: 0 },
      },
      select: { creditNoteNumber: true },
    });
    if (refunding) {
      throw new DomainError(
        `Credit note ${refunding.creditNoteNumber} owes the customer a refund worked out from what was applied. Void the credit note first.`,
      );
    }

    const amount = toFils(allocation.amount.toString());
    await tx.customerAdvanceAllocation.update({
      where: { id: allocation.id },
      data: { reversedAt: new Date(), reversalReason: input.reason, reversedByUserId: user.id },
    });
    const advanceAppliedAmount = filsToString(
      toFils(invoice.advanceAppliedAmount.toString()) - amount,
    );
    const paid = paidFils(invoice.payments);
    const status = settlementStatus({ ...invoice, advanceAppliedAmount }, paid);
    await tx.invoice.update({ where: { id: invoice.id }, data: { advanceAppliedAmount, status } });
    await syncAdvanceMovements(tx, user.organizationId, advance.id, user.id);
    const advanceStatus = await refreshAdvanceStatus(tx, advance.id);

    let jobReopened = false;
    if (
      invoice.jobCard &&
      status !== 'PAID' &&
      normalizeStatus(invoice.jobCard.status) === 'PAID'
    ) {
      await applyJobStatusChange(tx, {
        organizationId: user.organizationId,
        jobCardId: invoice.jobCard.id,
        toStatus: 'INVOICED',
        actor: { userId: user.id },
        source: 'workflow',
        reopen: true,
        metadata: {
          invoiceId: invoice.id,
          allocationId: allocation.id,
          reason: 'advance_unapplied',
        },
      });
      jobReopened = true;
    }
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'customer_advance_application.reversed',
      entityType: 'CustomerAdvanceAllocation',
      entityId: allocation.id,
      beforeData: { invoiceStatus: invoice.status },
      afterData: {
        advanceNumber: advance.advanceNumber,
        invoiceNumber: invoice.invoiceNumber,
        amount: filsToString(amount),
        invoiceStatus: status,
        invoiceBalanceAfter: filsToString(dueFils({ ...invoice, advanceAppliedAmount }, paid)),
        advanceStatus,
        reason: input.reason,
      },
      metadata: { advanceId: advance.id, invoiceId: invoice.id, jobReopened },
    });
    await settleRequestKey(tx, user, rawInput, allocation.id);
    return { invoiceId: invoice.id, advanceId: advance.id };
  });
}

// ─── Credit notes ───────────────────────────────────────────────────────────

/**
 * Inside a credit note's transaction, with its invoice locked: gives up to
 * `fils` of what the invoice took from advances back to them — newest
 * application first — as negative applications dated on the credit note.
 * Returns how much was given back; the caller lowers the invoice's
 * `advanceAppliedAmount` by it.
 */
export async function returnToAdvances(
  tx: Tx,
  user: AuthenticatedUser,
  credit: {
    invoiceId: string;
    invoiceNumber: string;
    branchId: string;
    creditNoteId: string;
    creditNoteNumber: string;
    issueDate: Date;
    fils: number;
  },
) {
  if (credit.fils <= 0) return 0;
  const rows = await tx.customerAdvanceAllocation.findMany({
    where: { organizationId: user.organizationId, invoiceId: credit.invoiceId, reversedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { advanceId: true, amount: true },
  });
  // What each advance still has applied to this invoice, newest first.
  const net = new Map<string, number>();
  for (const row of rows)
    net.set(row.advanceId, (net.get(row.advanceId) ?? 0) + signedFils(row.amount));

  let left = credit.fils;
  for (const [advanceId, applied] of net) {
    if (left === 0) break;
    const take = Math.min(applied, left);
    if (take <= 0) continue;
    const advance = await lockAdvance(tx, user.organizationId, advanceId);
    const allocation = await tx.customerAdvanceAllocation.create({
      data: {
        organizationId: user.organizationId,
        advanceId,
        invoiceId: credit.invoiceId,
        // Below zero: money back on the advance, off the invoice.
        amount: filsToString(-take),
        allocatedOn: credit.issueDate,
        creditNoteId: credit.creditNoteId,
        createdByUserId: user.id,
      },
      select: { id: true },
    });
    await syncAdvanceMovements(tx, user.organizationId, advanceId, user.id);
    const advanceStatus = await refreshAdvanceStatus(tx, advanceId);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: credit.branchId,
      actorUserId: user.id,
      action: 'customer_advance.returned',
      entityType: 'CustomerAdvanceAllocation',
      entityId: allocation.id,
      afterData: {
        advanceNumber: advance.advanceNumber,
        invoiceNumber: credit.invoiceNumber,
        creditNoteNumber: credit.creditNoteNumber,
        amount: filsToString(take),
        advanceStatus,
      },
      metadata: { advanceId, invoiceId: credit.invoiceId, creditNoteId: credit.creditNoteId },
    });
    left -= take;
  }
  return credit.fils - left;
}

/**
 * Inside a credit note's void, with its invoice locked: reverses the money
 * the note returned to advances, so it is applied to the invoice again.
 * Refused when that money has since been applied elsewhere or refunded.
 * Returns how much is applied again; the caller raises the invoice's
 * `advanceAppliedAmount` by it.
 */
export async function undoReturnsToAdvances(
  tx: Tx,
  user: AuthenticatedUser,
  creditNoteId: string,
  reason: string,
) {
  const rows = await tx.customerAdvanceAllocation.findMany({
    where: { organizationId: user.organizationId, creditNoteId, reversedAt: null },
    select: { id: true, advanceId: true, amount: true },
  });
  let restored = 0;
  for (const row of rows) {
    const advance = await lockAdvance(tx, user.organizationId, row.advanceId);
    const back = -signedFils(row.amount);
    if (advanceFigures(advance).left < back) {
      throw new DomainError(
        `The money this credit note returned to advance ${advance.advanceNumber} has since been used, so the credit note stands.`,
      );
    }
    await tx.customerAdvanceAllocation.update({
      where: { id: row.id },
      data: { reversedAt: new Date(), reversalReason: reason, reversedByUserId: user.id },
    });
    await syncAdvanceMovements(tx, user.organizationId, row.advanceId, user.id);
    await refreshAdvanceStatus(tx, row.advanceId);
    restored += back;
  }
  return restored;
}

// ─── Refund ─────────────────────────────────────────────────────────────────

const refundSchema = z.object({
  amount: AMOUNT,
  refundedOn: DATE('Enter the date of the refund.'),
  method: METHOD,
  accountId: z.union([z.literal(''), z.uuid()]).optional(),
  reference: z.string().trim().max(100, 'Keep the reference under 100 characters.').optional(),
  notes: z.string().trim().max(500, 'Keep the notes under 500 characters.').optional(),
  requestKey: z.string().optional(),
});

/** Pays part or all of what is left on an advance back to the customer. */
export async function refundCustomerAdvance(
  user: AuthenticatedUser,
  advanceId: string,
  rawInput: unknown,
) {
  const input = parseInput(refundSchema, rawInput);
  const amount = toFils(input.amount);
  if (amount <= 0) throw new DomainError('Enter an amount above zero.', 'amount');
  const refunded = readDay(input.refundedOn, 'refundedOn', 'of the refund');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'advance.refund');
    const advance = await lockAdvance(tx, user.organizationId, advanceId);
    requirePermission(user, 'customer_advance.delete', { branchId: advance.branchId });
    if (advance.status === 'CANCELLED') throw new DomainError('This advance is cancelled.');
    const left = advanceFigures(advance).left;
    if (amount > left) {
      throw new DomainError(`Only ${filsToString(left)} is left on this advance.`, 'amount');
    }
    if (refunded.day < dayOf(advance.receivedOn)) {
      throw new DomainError(
        'A refund cannot be dated before the advance was received.',
        'refundedOn',
      );
    }
    const accountId = await checkMoneyAccount(tx, user.organizationId, input.accountId);
    await refuseCardSettlementAccount(tx, user.organizationId, input.method, accountId, 'method');

    const refund = await tx.customerAdvanceRefund.create({
      data: {
        organizationId: user.organizationId,
        advanceId: advance.id,
        amount: filsToString(amount),
        refundedOn: refunded.date,
        method: input.method,
        accountId,
        reference: emptyToNull(input.reference),
        notes: emptyToNull(input.notes),
        createdByUserId: user.id,
      },
      select: { id: true },
    });
    await syncAdvanceMovements(tx, user.organizationId, advance.id, user.id);
    const advanceStatus = await refreshAdvanceStatus(tx, advance.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: advance.branchId,
      actorUserId: user.id,
      action: 'customer_advance.refunded',
      entityType: 'CustomerAdvanceRefund',
      entityId: refund.id,
      afterData: {
        advanceNumber: advance.advanceNumber,
        amount: filsToString(amount),
        refundedOn: refunded.day,
        method: input.method,
        accountId,
        reference: emptyToNull(input.reference),
        advanceLeftAfter: filsToString(left - amount),
        advanceStatus,
      },
      metadata: { advanceId: advance.id },
    });
    await settleRequestKey(tx, user, rawInput, refund.id);
    return { refundId: refund.id };
  });
}

/** Reverses a refund recorded in error: kept on record, its entry reversed. */
export async function reverseAdvanceRefund(
  user: AuthenticatedUser,
  refundId: string,
  rawInput: unknown,
) {
  const input = parseInput(reasonSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'advance.refund_reverse');
    const found = await tx.customerAdvanceRefund.findFirst({
      where: { id: refundId, organizationId: user.organizationId },
      select: { advanceId: true },
    });
    if (!found) throw new NotFoundError('advance refund');
    const advance = await lockAdvance(tx, user.organizationId, found.advanceId);
    requirePermission(user, 'customer_advance.delete', { branchId: advance.branchId });
    const refund = await tx.customerAdvanceRefund.findUniqueOrThrow({ where: { id: refundId } });
    if (refund.reversedAt) throw new DomainError('This refund has already been reversed.');

    await tx.customerAdvanceRefund.update({
      where: { id: refund.id },
      data: { reversedAt: new Date(), reversalReason: input.reason, reversedByUserId: user.id },
    });
    await syncAdvanceMovements(tx, user.organizationId, advance.id, user.id);
    const advanceStatus = await refreshAdvanceStatus(tx, advance.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: advance.branchId,
      actorUserId: user.id,
      action: 'customer_advance_refund.reversed',
      entityType: 'CustomerAdvanceRefund',
      entityId: refund.id,
      afterData: {
        advanceNumber: advance.advanceNumber,
        amount: refund.amount.toString(),
        advanceStatus,
        reason: input.reason,
      },
      metadata: { advanceId: advance.id },
    });
    await settleRequestKey(tx, user, rawInput, refund.id);
    return { advanceId: advance.id };
  });
}

// ─── Cancel ─────────────────────────────────────────────────────────────────

/** Why an advance can't be cancelled, or null when it can. */
export function advanceCancelBlocker(advance: AdvanceRows & { status: CustomerAdvanceStatus }) {
  if (advance.status === 'CANCELLED') return 'This advance is already cancelled.';
  const figures = advanceFigures(advance);
  const used =
    advance.allocations.some((row) => !row.reversedAt) ||
    advance.refunds.some((row) => !row.reversedAt);
  if (used || figures.left !== figures.amount) {
    return 'Part of it has been applied or refunded. Undo those first, or refund what is left.';
  }
  return null;
}

/** Cancels an advance entered in error, before any of it is used: kept on record, its entry reversed. */
export async function cancelCustomerAdvance(
  user: AuthenticatedUser,
  advanceId: string,
  rawInput: unknown,
) {
  const input = parseInput(reasonSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'advance.cancel');
    const advance = await lockAdvance(tx, user.organizationId, advanceId);
    requirePermission(user, 'customer_advance.delete', { branchId: advance.branchId });
    const blocker = advanceCancelBlocker(advance);
    if (blocker) throw new DomainError(blocker);

    const cancelledAt = new Date();
    await tx.customerAdvance.update({
      where: { id: advance.id },
      data: {
        status: 'CANCELLED',
        cancelledAt,
        cancelReason: input.reason,
        cancelledByUserId: user.id,
      },
    });
    await syncPosting(tx, user.organizationId, 'CUSTOMER_ADVANCE', advance.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: advance.branchId,
      actorUserId: user.id,
      action: 'customer_advance.cancelled',
      entityType: 'CustomerAdvance',
      entityId: advance.id,
      beforeData: { status: advance.status },
      afterData: {
        advanceNumber: advance.advanceNumber,
        status: 'CANCELLED',
        amount: advance.amount.toString(),
        cancelledAt: cancelledAt.toISOString(),
        reason: input.reason,
      },
    });
    await settleRequestKey(tx, user, rawInput, advance.id);
    return { advanceId: advance.id };
  });
}

// ─── Reading ────────────────────────────────────────────────────────────────

export const ADVANCE_STATUS_LABEL: Record<CustomerAdvanceStatus, string> = {
  OPEN: 'Open',
  PARTIALLY_APPLIED: 'Partly used',
  FULLY_APPLIED: 'Fully applied',
  REFUNDED: 'Refunded',
  CANCELLED: 'Cancelled',
};

export const ADVANCE_VAT_LABEL = {
  PENDING_ACCOUNTANT_CONFIRMATION:
    'Taken before VAT on advances was switched on: no VAT on the advance; its VAT is on the invoice.',
  VAT_ON_INVOICE: 'Not VAT-registered when received: no VAT on the advance.',
  VAT_ON_RECEIPT:
    'VAT included, due the day it was received; taken off again as it is applied to the invoice or refunded.',
} as const;

/** One advance: who, what for, where it went, and what can be done with it now. */
export async function getCustomerAdvance(user: AuthenticatedUser, advanceId: string) {
  const advance = await prisma.customerAdvance.findFirst({
    where: { id: advanceId, organizationId: user.organizationId },
    include: {
      customer: { select: { id: true, name: true, phone: true } },
      vehicle: { select: { id: true, plateNumber: true, make: true, model: true } },
      jobCard: { select: { id: true, jobNumber: true, status: true } },
      account: { select: { accountCode: true, accountName: true } },
      receivedBy: { select: { fullName: true } },
      cancelledBy: { select: { fullName: true } },
      allocations: {
        orderBy: [{ allocatedOn: 'asc' }, { createdAt: 'asc' }],
        include: {
          invoice: { select: { id: true, invoiceNumber: true } },
          creditNote: { select: { id: true, creditNoteNumber: true } },
          createdBy: { select: { fullName: true } },
          reversedBy: { select: { fullName: true } },
        },
      },
      refunds: {
        orderBy: [{ refundedOn: 'asc' }, { createdAt: 'asc' }],
        include: {
          account: { select: { accountCode: true, accountName: true } },
          createdBy: { select: { fullName: true } },
          reversedBy: { select: { fullName: true } },
        },
      },
    },
  });
  if (!advance) throw new NotFoundError('customer advance');
  requirePermission(user, 'customer_advance.view', { branchId: advance.branchId });
  const figures = advanceFigures(advance);
  const live = advance.status !== 'CANCELLED';

  // The customer's invoices it could be applied to: owed, issued, not pro-forma.
  const invoices =
    live && figures.left > 0
      ? await prisma.invoice.findMany({
          where: {
            organizationId: user.organizationId,
            customerId: advance.customerId,
            invoiceType: { in: ['TAX_INVOICE', 'OPENING_BALANCE'] },
            status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
          },
          orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            invoiceNumber: true,
            issueDate: true,
            totalAmount: true,
            creditedAmount: true,
            advanceAppliedAmount: true,
            settlementDiscount: true,
            jobCardId: true,
            payments: {
              select: { id: true, amount: true, status: true, reversalOfPaymentId: true },
            },
          },
        })
      : [];
  const openInvoices = invoices
    .map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      /** On this advance's own job card: the obvious one. */
      sameJob: Boolean(advance.jobCardId && invoice.jobCardId === advance.jobCardId),
      due: filsToString(dueFils(invoice, paidFils(invoice.payments))),
    }))
    .filter((invoice) => toFils(invoice.due) > 0);

  return {
    ...advance,
    figures: {
      amount: filsToString(figures.amount),
      applied: filsToString(figures.applied),
      refunded: filsToString(figures.refunded),
      left: filsToString(live ? figures.left : 0),
    },
    openInvoices,
    cancelBlocker: advanceCancelBlocker(advance),
    can: {
      apply: live && figures.left > 0 && hasPermission(user, 'customer_advance.edit'),
      undo: hasPermission(user, 'customer_advance.edit'),
      refund: live && figures.left > 0 && hasPermission(user, 'customer_advance.delete'),
      reverseRefund: hasPermission(user, 'customer_advance.delete'),
      cancel: hasPermission(user, 'customer_advance.delete'),
    },
  };
}

export type CustomerAdvanceDetail = Awaited<ReturnType<typeof getCustomerAdvance>>;

/**
 * For an invoice's screen: the advances applied to it (and any returned by
 * credit notes), and the customer's advances that still have money left.
 * Null when the user may not see advances.
 */
export async function getInvoiceAdvances(
  user: AuthenticatedUser,
  invoice: { id: string; customerId: string },
) {
  if (!hasPermission(user, 'customer_advance.view')) return null;
  const [applications, advances] = await Promise.all([
    prisma.customerAdvanceAllocation.findMany({
      where: { organizationId: user.organizationId, invoiceId: invoice.id },
      orderBy: [{ allocatedOn: 'asc' }, { createdAt: 'asc' }],
      include: {
        advance: { select: { id: true, advanceNumber: true } },
        creditNote: { select: { id: true, creditNoteNumber: true } },
        createdBy: { select: { fullName: true } },
      },
    }),
    prisma.customerAdvance.findMany({
      where: {
        organizationId: user.organizationId,
        customerId: invoice.customerId,
        status: { in: ['OPEN', 'PARTIALLY_APPLIED'] },
      },
      orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
      include: { ...STANDING_ROWS, jobCard: { select: { jobNumber: true } } },
    }),
  ]);
  const available = advances
    .map((advance) => ({
      id: advance.id,
      advanceNumber: advance.advanceNumber,
      receivedOn: advance.receivedOn,
      jobNumber: advance.jobCard?.jobNumber ?? null,
      left: advanceFigures(advance).left,
    }))
    .filter((advance) => advance.left > 0);
  return {
    applications: applications.map((row) => ({
      id: row.id,
      advance: row.advance,
      creditNote: row.creditNote,
      amount: row.amount.toString(),
      allocatedOn: row.allocatedOn,
      reversedAt: row.reversedAt,
      reversalReason: row.reversalReason,
      createdBy: row.createdBy.fullName,
    })),
    available: available.map((advance) => ({ ...advance, left: filsToString(advance.left) })),
    availableTotal: filsToString(available.reduce((sum, advance) => sum + advance.left, 0)),
    canApply: hasPermission(user, 'customer_advance.edit'),
  };
}

export type InvoiceAdvances = NonNullable<Awaited<ReturnType<typeof getInvoiceAdvances>>>;

/**
 * Who a new advance is from, when the form is opened from a quotation or a
 * job card: the customer, and the job card and vehicle it is towards. A
 * quotation without a job card passes its customer and vehicle.
 */
export async function advancePrefill(
  user: AuthenticatedUser,
  prefill: { customerId?: string; jobCardId?: string; vehicleId?: string },
) {
  requirePermission(user, 'customer_advance.create');
  if (prefill.jobCardId) {
    const job = await prisma.jobCard.findFirst({
      where: { id: prefill.jobCardId, organizationId: user.organizationId },
      select: { id: true, customerId: true, vehicleId: true, jobNumber: true },
    });
    if (job) {
      return {
        customerId: job.customerId,
        jobCardId: job.id,
        vehicleId: job.vehicleId,
        jobNumber: job.jobNumber,
      };
    }
  }
  if (prefill.customerId && prefill.vehicleId) {
    // Only the customer's own vehicle is offered.
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: prefill.vehicleId, organizationId: user.organizationId, customerId: prefill.customerId },
      select: { id: true },
    });
    return { customerId: prefill.customerId, jobCardId: '', vehicleId: vehicle?.id ?? '', jobNumber: '' };
  }
  return { customerId: prefill.customerId ?? null, jobCardId: '', vehicleId: '', jobNumber: '' };
}

/** What advances are listed for: a job card, or — for a quotation without one — its customer and vehicle. */
export type AdvanceTarget =
  | { jobCardId: string; branchId: string }
  | { customerId: string; vehicleId: string | null; branchId: string };

/**
 * For a job card's or quotation's screen: the advances taken towards it, and
 * whether another can be taken. Without a job card, those are the customer's
 * advances for that vehicle not tied to any job — the ones its invoice will
 * be able to use.
 */
export async function getAdvancesFor(user: AuthenticatedUser, target: AdvanceTarget) {
  if (!hasPermission(user, 'customer_advance.view', { branchId: target.branchId })) return null;
  const rows = await prisma.customerAdvance.findMany({
    where: {
      organizationId: user.organizationId,
      ...('jobCardId' in target
        ? { jobCardId: target.jobCardId }
        : { customerId: target.customerId, jobCardId: null, vehicleId: target.vehicleId }),
    },
    orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
    include: STANDING_ROWS,
  });
  const advances = rows.map((row) => ({
    id: row.id,
    advanceNumber: row.advanceNumber,
    receivedOn: row.receivedOn,
    status: row.status,
    amount: row.amount.toString(),
    left: filsToString(row.status === 'CANCELLED' ? 0 : advanceFigures(row).left),
  }));
  return {
    advances,
    canReceive: hasPermission(user, 'customer_advance.create', { branchId: target.branchId }),
  };
}

/**
 * Sales → Customer advances: every advance, however it was taken (from a job
 * card, a quotation or this screen), newest first — with what is still held
 * for each customer. `show: 'held'` keeps those with money left.
 */
export async function listCustomerAdvances(
  user: AuthenticatedUser,
  options: { show?: 'held' | 'all' } = {},
) {
  requirePermission(user, 'customer_advance.view');
  const rows = await prisma.customerAdvance.findMany({
    where: { organizationId: user.organizationId },
    orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }],
    include: {
      ...STANDING_ROWS,
      customer: { select: { id: true, name: true } },
      vehicle: { select: { plateNumber: true } },
      jobCard: { select: { id: true, jobNumber: true } },
    },
  });
  const advances = rows.map((row) => {
    const leftFils = row.status === 'CANCELLED' ? 0 : advanceFigures(row).left;
    return {
      id: row.id,
      advanceNumber: row.advanceNumber,
      receivedOn: row.receivedOn,
      status: row.status,
      amount: row.amount.toString(),
      left: filsToString(leftFils),
      leftFils,
      customer: row.customer,
      plate: row.vehicle?.plateNumber ?? null,
      jobCard: row.jobCard,
    };
  });
  const heldFils = advances.reduce((sum, row) => sum + row.leftFils, 0);
  return {
    advances: options.show === 'held' ? advances.filter((row) => row.leftFils > 0) : advances,
    held: filsToString(heldFils),
    heldCount: advances.filter((row) => row.leftFils > 0).length,
    total: advances.length,
    canReceive: hasPermission(user, 'customer_advance.create'),
  };
}

/** For a job card's screen: the advances taken towards it, and whether another can be taken. */
export async function getJobAdvances(
  user: AuthenticatedUser,
  jobCard: { id: string; branchId: string },
) {
  return getAdvancesFor(user, { jobCardId: jobCard.id, branchId: jobCard.branchId });
}
