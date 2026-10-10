import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { calculateDocument, calculateLine, filsToString, readDiscount, toFils } from '@/lib/money';
import { emptyToNull } from '@/lib/normalize';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { resolveDefaultVatRate } from '@/lib/tax';
import {
  applyJobStatusChange,
  normalizeStatus,
  type WorkflowStatus,
} from '@/lib/workshop/job-status';
import { dueFils, paidFils, settlementStatus, takePayment } from '@/lib/billing/invoice';
import { readDueDate } from '@/lib/billing/direct-invoice';
import { syncPosting } from '@/lib/accounting/journal';
import { syncInvoiceStock } from '@/lib/inventory/invoice-stock';
import {
  assertNotFitted,
  partsFittedOnJob,
  resolvePartLines,
  unlinkedAllowed,
} from '@/lib/billing/part-lines';
import {
  assertIncomeAccounts,
  discountFields,
  lineData,
  lineSchema,
  priceDocument,
  roundingField,
  storedLineAmounts,
  totalsData,
  withRounding,
  MAX_ROUNDING_FILS,
} from '@/lib/billing/document-lines';
import { resolveTaxCodes } from '@/lib/accounting/tax-codes';
import { syncJobWithInvoice } from '@/lib/billing/credit-notes';

/*
 * Correcting billing after the fact. Four doors, each narrow on purpose:
 *
 *   updateInvoice          fix the lines of an invoice nobody has paid yet.
 *                          The number and issue date stay; the audit log
 *                          keeps the lines as they were.
 *   voidInvoice            withdraw an unpaid invoice altogether. It stays on
 *                          record as VOID with its number (never reused) and
 *                          the reason; its job card goes back to where it
 *                          was billed from, ready to be invoiced again.
 *   reverseInvoicePayment  undo a payment recorded in error. The payment is
 *                          never edited or deleted — a reversal row cancels
 *                          it (the Payment model's rule) — and the invoice
 *                          and job card step back to match.
 *   discountInvoice        a discount given after the invoice, out of what
 *                          is still due ("the customer paid 154.00 less"):
 *                          the lines stay, the discount goes on the bill and
 *                          VAT comes down with it. removeInvoiceDiscount
 *                          takes it off again.
 *
 * Money already received is never silently rewritten: an invoice with a
 * payment on it must have that payment reversed before its lines can change.
 */

const REASON = z
  .string({ error: 'Say why.' })
  .trim()
  .min(3, 'Say why, in a few words.')
  .max(500, 'Keep the reason under 500 characters.');

/** Locks the invoice's job card (always before the invoice), then the invoice. */
async function lockInvoice(
  tx: Prisma.TransactionClient,
  organizationId: string,
  invoiceId: string,
) {
  const target = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: { id: true, jobCardId: true },
  });
  if (!target) throw new NotFoundError('invoice');
  if (target.jobCardId) {
    await tx.$executeRaw`SELECT id FROM job_cards WHERE id = ${target.jobCardId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  }
  await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${target.id}::uuid FOR UPDATE`;
  const invoice = await tx.invoice.findFirstOrThrow({
    where: { id: target.id, organizationId },
    include: {
      items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      payments: { select: { id: true, amount: true, status: true, reversalOfPaymentId: true } },
      jobCard: { select: { id: true, status: true, jobNumber: true } },
    },
  });
  return invoice;
}

function lineSnapshot(
  items: {
    itemType: string | null;
    description: string;
    quantity: { toString(): string };
    unitPrice: { toString(): string };
    taxRate: { toString(): string } | null;
    discountAmount: { toString(): string };
    lineTotal: { toString(): string };
  }[],
) {
  return items.map((item) => ({
    itemType: item.itemType,
    description: item.description,
    quantity: item.quantity.toString(),
    unitPrice: item.unitPrice.toString(),
    taxRate: item.taxRate?.toString() ?? '0',
    discountAmount: item.discountAmount.toString(),
    lineTotal: item.lineTotal.toString(),
  }));
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  items: z
    .array(lineSchema)
    .min(1, 'An invoice needs at least one line.')
    .max(100, 'An invoice can have at most 100 lines.'),
  ...discountFields,
  /** A round-off after VAT, outside VAT: "-0.50", "0.25" or blank. */
  roundingAdjustment: roundingField,
  dueDate: z.string().trim().optional(),
  customerReference: z
    .string()
    .trim()
    .max(60, "Keep the customer's order number under 60 characters.")
    .optional(),
  notes: z.string().trim().max(1000, 'Keep the notes under 1000 characters.').optional(),
  requestKey: z.string().optional(),
});

const CREDITED =
  'A credit note has been issued against this invoice, so it stands as issued. Correct it with a credit note instead.';

export const isCredited = (invoice: { creditedAmount?: { toString(): string } }) =>
  invoice.creditedAmount !== undefined && toFils(invoice.creditedAmount.toString()) > 0;

/** Settled in part from a customer advance (lib/billing/advances.ts). */
const hasAdvanceApplied = (invoice: { advanceAppliedAmount?: { toString(): string } }) =>
  invoice.advanceAppliedAmount !== undefined && toFils(invoice.advanceAppliedAmount.toString()) > 0;

/** A discount given after the invoice (discountInvoice). */
const hasSettlementDiscount = (invoice: { settlementDiscount?: { toString(): string } }) =>
  invoice.settlementDiscount !== undefined && toFils(invoice.settlementDiscount.toString()) > 0;

const SETTLEMENT_DISCOUNT = (to: string) =>
  `A discount was given on this invoice after it. Take the discount off first to ${to}.`;

const ADVANCE_APPLIED = (to: string) =>
  `A customer advance has been applied to this invoice. Undo it on the invoice first to ${to}.`;

/** Why an invoice can't be edited, or null when it can. Shared with the screens. */
export function invoiceEditBlocker(invoice: {
  status: string;
  invoiceType?: string;
  paidAmount?: string;
  creditedAmount?: { toString(): string };
  advanceAppliedAmount?: { toString(): string };
  settlementDiscount?: { toString(): string };
  items: { labourId: string | null; partUsageId: string | null }[];
}): string | null {
  if (invoice.status === 'VOID' || invoice.status === 'CANCELLED') return 'This invoice is void.';
  if (invoice.invoiceType === 'OPENING_BALANCE') {
    return 'An opening balance is changed on the Opening balances screen.';
  }
  // A credit note was worked out from the invoice as issued; changing it now
  // would leave the credit note pointing at figures that no longer exist.
  if (isCredited(invoice)) return CREDITED;
  // Paid, part-paid, settled from an advance or discounted after issue: still
  // editable — updateInvoice keeps the total at or above what was received,
  // and lines billed from the repair records keep their links.
  if (!EDITABLE_STATUSES.includes(invoice.status)) return 'This invoice can’t be changed.';
  return null;
}

const EDITABLE_STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'PAID'];

/**
 * What has already settled the invoice and must stay covered by its total:
 * payments that count, advances applied and a discount given after issue.
 */
export function settledFils(invoice: {
  paidFils: number;
  advanceAppliedAmount: { toString(): string };
  settlementDiscount: { toString(): string };
}) {
  return (
    invoice.paidFils +
    toFils(invoice.advanceAppliedAmount.toString()) +
    toFils(invoice.settlementDiscount.toString())
  );
}

/**
 * Replaces the lines, discounts, due date, order number and notes of an
 * invoice. Priced by the same rules as a new one; the number, issue date,
 * customer and vehicle don't change, but the seller and customer details are
 * refreshed to the current ones.
 *
 * On an invoice already paid (in part or in full, or from an advance) the
 * payments stay exactly as they are: the new total may not fall below what
 * was received, and the invoice's paid/unpaid state — and its job card —
 * follow the new total. A line billed from the repair records keeps its link
 * to the labour or part it bills, so the job never looks unbilled.
 */
export async function updateInvoice(user: AuthenticatedUser, invoiceId: string, rawInput: unknown) {
  const input = parseInput(updateSchema, rawInput);
  const defaultVatRate = await resolveDefaultVatRate(user.organizationId);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.update');
    const invoice = await lockInvoice(tx, user.organizationId, invoiceId);
    requirePermission(user, 'invoice.edit', { branchId: invoice.branchId });
    const blocker = invoiceEditBlocker({
      status: invoice.status,
      invoiceType: invoice.invoiceType,
      paidAmount: filsToString(paidFils(invoice.payments)),
      creditedAmount: invoice.creditedAmount,
      advanceAppliedAmount: invoice.advanceAppliedAmount,
      settlementDiscount: invoice.settlementDiscount,
      items: invoice.items,
    });
    if (blocker) throw new DomainError(blocker);

    const priced = priceDocument(
      input.items,
      defaultVatRate,
      input,
      await resolveTaxCodes(tx, user.organizationId, input.items),
    );
    const { totals } = priced;
    // Parts lines name their part and cost, as on a new invoice — but a line
    // billed from the repair records, or kept from before parts were tied to
    // stock, may stay as it was.
    const fitted = await partsFittedOnJob(tx, user.organizationId, invoice.jobCardId);
    const free = unlinkedAllowed(invoice.items);
    const lines = await resolvePartLines(tx, user.organizationId, priced.lines, {
      required: (_line, index) => fitted.size === 0 && !free(input.items[index]),
      keep: new Set(invoice.items.flatMap((item) => (item.partId ? [item.partId] : []))),
    });
    assertNotFitted(lines, fitted);
    await assertIncomeAccounts(tx, user.organizationId, lines);
    const dueDate = readDueDate(input.dueDate, invoice.issueDate);
    const rounded = withRounding(totals, input.roundingAdjustment);
    const paid = paidFils(invoice.payments);
    const settled = settledFils({ ...invoice, paidFils: paid });
    if (toFils(rounded.totalAmount) < settled) {
      throw new DomainError(
        `The new total (AED ${rounded.totalAmount}) is less than the AED ${filsToString(settled)} already received for this invoice. Keep the total at AED ${filsToString(settled)} or more — or refund the difference first.`,
      );
    }
    // Lines that came from the repair records keep their link to the labour
    // or part they bill.
    const links = new Map(
      invoice.items.map((item) => [
        item.id,
        { labourId: item.labourId, partUsageId: item.partUsageId },
      ]),
    );

    await tx.invoiceItem.deleteMany({
      where: { organizationId: user.organizationId, invoiceId: invoice.id },
    });
    for (const [index, line] of lines.entries()) {
      const sourceId = input.items[index].sourceId;
      const link = sourceId ? links.get(sourceId) : undefined;
      await tx.invoiceItem.create({
        data: {
          organizationId: user.organizationId,
          invoiceId: invoice.id,
          labourId: link?.labourId ?? null,
          partUsageId: link?.partUsageId ?? null,
          itemType: line.itemType,
          description: line.description,
          accountId: line.accountId ?? null,
          vatTreatment: line.vatTreatment,
          taxCodeId: line.taxCodeId ?? null,
          // A line billing a fitted part left stock with the job, not here.
          partId: link?.partUsageId ? null : (line.partId ?? null),
          unitCost: link?.partUsageId ? null : (line.unitCost ?? null),
          ...lineData(line.amounts),
        },
      });
    }
    // A corrected invoice is re-issued under the same number, so it carries
    // the workshop's and customer's details as they are now — not whatever
    // was on file when the first draft went out.
    const [organization, customer] = await Promise.all([
      tx.organization.findUniqueOrThrow({
        where: { id: user.organizationId },
        select: { name: true, legalName: true, taxNumber: true, address: true },
      }),
      tx.customer.findFirstOrThrow({
        where: { id: invoice.customerId, organizationId: user.organizationId },
        select: { name: true, taxNumber: true, address: true },
      }),
    ]);
    const parties = {
      sellerLegalName: organization.legalName ?? organization.name,
      sellerTaxNumber: organization.taxNumber,
      sellerAddress: organization.address,
      customerName: customer.name,
      customerTaxNumber: customer.taxNumber,
      customerAddress: customer.address,
    };

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        ...totalsData(totals),
        ...rounded,
        dueDate,
        customerReference: emptyToNull(input.customerReference),
        notes: emptyToNull(input.notes),
        ...parties,
      },
    });
    // Stock follows the corrected lines: only the difference moves.
    await syncInvoiceStock(tx, {
      organizationId: user.organizationId,
      invoiceId: invoice.id,
      userId: user.id,
    });
    // The corrected figures replace the old ones in the books: the old entry
    // is reversed and the new one booked, on the invoice's own date.
    await syncPosting(tx, user.organizationId, 'INVOICE', invoice.id, user.id);
    const status = settlementStatus(
      {
        totalAmount: rounded.totalAmount,
        creditedAmount: invoice.creditedAmount,
        advanceAppliedAmount: invoice.advanceAppliedAmount,
        settlementDiscount: invoice.settlementDiscount,
      },
      paid,
    );
    if (status !== invoice.status) {
      await tx.invoice.update({ where: { id: invoice.id }, data: { status } });
      await syncJobWithInvoice(tx, user.organizationId, invoice.id, user.id, {
        reason: 'invoice.updated',
      });
    }

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'invoice.updated',
      entityType: 'Invoice',
      entityId: invoice.id,
      beforeData: {
        lines: lineSnapshot(invoice.items),
        discountAmount: invoice.discountAmount.toString(),
        subtotal: invoice.subtotal.toString(),
        taxAmount: invoice.taxAmount.toString(),
        totalAmount: invoice.totalAmount.toString(),
        roundingAdjustment: invoice.roundingAdjustment.toString(),
        dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null,
        customerReference: invoice.customerReference,
        notes: invoice.notes,
        sellerLegalName: invoice.sellerLegalName,
        sellerTaxNumber: invoice.sellerTaxNumber,
        sellerAddress: invoice.sellerAddress,
        customerName: invoice.customerName,
        customerTaxNumber: invoice.customerTaxNumber,
        customerAddress: invoice.customerAddress,
      },
      afterData: {
        lines: lines.map((line) => ({
          itemType: line.itemType,
          description: line.description,
          quantity: line.amounts.quantity,
          unitPrice: line.amounts.unitPrice,
          taxRate: line.amounts.taxRate,
          discountAmount: line.amounts.discountAmount,
          lineTotal: line.amounts.lineTotal,
        })),
        discountAmount: totals.discountAmount,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: rounded.totalAmount,
        roundingAdjustment: rounded.roundingAdjustment,
        dueDate: dueDate.toISOString().slice(0, 10),
        customerReference: emptyToNull(input.customerReference),
        notes: emptyToNull(input.notes),
        ...parties,
      },
      metadata: { invoiceNumber: invoice.invoiceNumber },
    });
    await settleRequestKey(tx, user, rawInput, invoice.id);
    return { invoiceId: invoice.id };
  });
}

// ---------------------------------------------------------------------------
// A discount after the invoice
// ---------------------------------------------------------------------------

const discountSchema = z.object({
  amount: z
    .string({ error: 'Enter the discount.' })
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Enter the discount like 154 or 154.50.'),
  /** The day it was given; today when left out. */
  givenOn: z.string().trim().optional(),
  reason: z.string().trim().max(500, 'Keep the reason under 500 characters.').optional(),
  requestKey: z.string().optional(),
});

const removeDiscountSchema = z.object({ reason: REASON, requestKey: z.string().optional() });

/** Why a discount can't be given on an invoice now, or null when it can. */
export function invoiceDiscountBlocker(invoice: {
  status: string;
  invoiceType: string;
  creditedAmount: { toString(): string };
  settlementDiscount: { toString(): string };
}): string | null {
  if (invoice.status === 'VOID' || invoice.status === 'CANCELLED') return 'This invoice is void.';
  if (invoice.invoiceType !== 'TAX_INVOICE') return 'A discount is given on a tax invoice.';
  if (invoice.status === 'DRAFT') return 'Issue the invoice first.';
  // Before "paid": an invoice a credit note settled says what is in the way.
  if (isCredited(invoice)) {
    return 'A credit note stands against this invoice. Void it first to give the discount instead.';
  }
  if (toFils(invoice.settlementDiscount.toString()) > 0) {
    return 'A discount has already been given on this invoice. Take it off first to give a different one.';
  }
  if (invoice.status === 'PAID') return 'This invoice is already fully paid.';
  return null;
}

/** What the audit log keeps of an invoice's settlement, before and after. */
function settlementSnapshot(invoice: {
  totalAmount: { toString(): string };
  taxAmount: { toString(): string };
  settlementDiscount: { toString(): string };
  settlementDiscountOn: Date | null;
  status: string;
}) {
  return {
    totalAmount: invoice.totalAmount.toString(),
    taxAmount: invoice.taxAmount.toString(),
    settlementDiscount: invoice.settlementDiscount.toString(),
    settlementDiscountOn: invoice.settlementDiscountOn?.toISOString().slice(0, 10) ?? null,
    status: invoice.status,
  };
}

/**
 * Gives a discount after the invoice, off its total: "the invoice is 3,654,
 * the customer paid 3,500, the 154 is a discount". Out of what is still due.
 * No credit note: the invoice keeps its total, lines and VAT exactly as
 * issued (only a tax credit note reduces VAT) — the discount comes off what
 * is owed. Booked as its own entry on the day given: Dr Sales discounts, Cr
 * receivables. Once nothing is due, the invoice — and its job card — are paid.
 */
export async function discountInvoice(
  user: AuthenticatedUser,
  invoiceId: string,
  rawInput: unknown,
) {
  const input = parseInput(discountSchema, rawInput);
  const amount = toFils(input.amount, 'Discount');
  if (amount <= 0) throw new DomainError('Enter the discount.', 'amount');
  const givenOnDay = input.givenOn || localDateString();
  const givenOn = parseCalendarDate(givenOnDay);
  if (!givenOn) throw new DomainError('Enter the date the discount was given.', 'givenOn');
  if (givenOnDay > localDateString()) {
    throw new DomainError('The discount cannot be dated in the future.', 'givenOn');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.discount');
    const invoice = await lockInvoice(tx, user.organizationId, invoiceId);
    requirePermission(user, 'invoice.edit', { branchId: invoice.branchId });
    const blocker = invoiceDiscountBlocker(invoice);
    if (blocker) throw new DomainError(blocker);
    if (givenOn < invoice.issueDate) {
      throw new DomainError('The discount cannot be dated before the invoice.', 'givenOn');
    }
    const paid = paidFils(invoice.payments);
    const due = dueFils(invoice, paid);
    if (amount > due) {
      throw new DomainError(`Only ${filsToString(due)} is still due on this invoice.`, 'amount');
    }

    const settlementDiscount = filsToString(amount);
    const status = settlementStatus({ ...invoice, settlementDiscount }, paid);
    const after = await tx.invoice.update({
      where: { id: invoice.id },
      data: { settlementDiscount, settlementDiscountOn: givenOn, status },
    });
    await syncPosting(tx, user.organizationId, 'INVOICE_DISCOUNT', invoice.id, user.id);
    await syncJobWithInvoice(tx, user.organizationId, invoice.id, user.id, {
      reason: 'invoice_discounted',
    });

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'invoice.discount_given',
      entityType: 'Invoice',
      entityId: invoice.id,
      beforeData: settlementSnapshot(invoice),
      afterData: settlementSnapshot(after),
      metadata: {
        invoiceNumber: invoice.invoiceNumber,
        dueBefore: filsToString(due),
        dueAfter: filsToString(due - amount),
        reason: emptyToNull(input.reason),
      },
    });
    await settleRequestKey(tx, user, rawInput, invoice.id);
    return { invoiceId: invoice.id, settlementDiscount, status };
  });
}

/**
 * Takes a discount given after the invoice off again (given in error): its
 * entry is reversed, and whatever was paid stands, so the invoice is owed
 * the discount again — and a paid job card goes back to invoiced.
 */
export async function removeInvoiceDiscount(
  user: AuthenticatedUser,
  invoiceId: string,
  rawInput: unknown,
) {
  const input = parseInput(removeDiscountSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.discount_remove');
    const invoice = await lockInvoice(tx, user.organizationId, invoiceId);
    requirePermission(user, 'invoice.edit', { branchId: invoice.branchId });
    if (invoice.status === 'VOID' || invoice.status === 'CANCELLED') {
      throw new DomainError('This invoice is void.');
    }
    if (toFils(invoice.settlementDiscount.toString()) === 0) {
      throw new DomainError('No discount has been given on this invoice.');
    }
    const status = settlementStatus(
      { ...invoice, settlementDiscount: '0' },
      paidFils(invoice.payments),
    );
    const after = await tx.invoice.update({
      where: { id: invoice.id },
      data: { settlementDiscount: '0', settlementDiscountOn: null, status },
    });
    await syncPosting(tx, user.organizationId, 'INVOICE_DISCOUNT', invoice.id, user.id);
    await syncJobWithInvoice(tx, user.organizationId, invoice.id, user.id, {
      reason: 'invoice_discount_removed',
    });

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'invoice.discount_removed',
      entityType: 'Invoice',
      entityId: invoice.id,
      beforeData: settlementSnapshot(invoice),
      afterData: settlementSnapshot(after),
      metadata: { invoiceNumber: invoice.invoiceNumber, reason: input.reason },
    });
    await settleRequestKey(tx, user, rawInput, invoice.id);
    return { invoiceId: invoice.id, status };
  });
}

/**
 * Takes a discount on the bill (before VAT, part of the invoice's own
 * pricing) off an invoice that already has money on it: the lines priced as
 * they were without it, VAT back to its full amount, the round-off cleared,
 * the invoice's entry corrected. Whatever was paid stands, so the invoice is
 * owed the difference again — and a paid job card goes back to invoiced.
 * (An unpaid invoice is simply edited.)
 */
export async function removeBillDiscount(
  user: AuthenticatedUser,
  invoiceId: string,
  rawInput: unknown,
) {
  const input = parseInput(removeDiscountSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.bill_discount_remove');
    const invoice = await lockInvoice(tx, user.organizationId, invoiceId);
    requirePermission(user, 'invoice.edit', { branchId: invoice.branchId });
    if (invoice.status === 'VOID' || invoice.status === 'CANCELLED') {
      throw new DomainError('This invoice is void.');
    }
    if (toFils(invoice.discountAmount.toString()) === 0) {
      throw new DomainError('This invoice has no discount on the bill.');
    }
    if (isCredited(invoice)) throw new DomainError(CREDITED);
    if (toFils(invoice.settlementDiscount.toString()) > 0) {
      throw new DomainError('Take off the discount given after the invoice first.');
    }

    // Each line priced as it was issued: its own discount, its own VAT.
    const lines = invoice.items.map((item) => {
      const line = calculateLine({
        quantity: item.quantity.toString(),
        unitPrice: item.unitPrice.toString(),
        taxRate: (item.taxRate ?? 0).toString(),
        discount: readDiscount(item.discountType, item.discountValue),
      });
      if (line.lineTotalFils !== toFils(item.lineTotal.toString())) {
        throw new DomainError('This invoice’s lines don’t price as stored. Correct it instead.');
      }
      return line;
    });
    const priced = calculateDocument(lines, null);
    for (const [index, item] of invoice.items.entries()) {
      await tx.invoiceItem.update({
        where: { id: item.id },
        data: { taxAmount: priced.lines[index].taxAmount },
      });
    }
    const totalAmount = priced.totals.totalAmount;
    const status = settlementStatus({ ...invoice, totalAmount }, paidFils(invoice.payments));
    const after = await tx.invoice.update({
      where: { id: invoice.id },
      data: { ...totalsData(priced.totals), roundingAdjustment: '0', status },
    });
    await syncPosting(tx, user.organizationId, 'INVOICE', invoice.id, user.id);
    await syncJobWithInvoice(tx, user.organizationId, invoice.id, user.id, {
      reason: 'bill_discount_removed',
    });

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'invoice.bill_discount_removed',
      entityType: 'Invoice',
      entityId: invoice.id,
      beforeData: {
        discountAmount: invoice.discountAmount.toString(),
        subtotal: invoice.subtotal.toString(),
        taxAmount: invoice.taxAmount.toString(),
        totalAmount: invoice.totalAmount.toString(),
        roundingAdjustment: invoice.roundingAdjustment.toString(),
        status: invoice.status,
      },
      afterData: {
        discountAmount: after.discountAmount.toString(),
        subtotal: after.subtotal.toString(),
        taxAmount: after.taxAmount.toString(),
        totalAmount: after.totalAmount.toString(),
        roundingAdjustment: after.roundingAdjustment.toString(),
        status: after.status,
      },
      metadata: { invoiceNumber: invoice.invoiceNumber, reason: input.reason },
    });
    await settleRequestKey(tx, user, rawInput, invoice.id);
    return { invoiceId: invoice.id, totalAmount, status };
  });
}

const billDiscountSchema = z.object({
  /** Before VAT, as on the invoice form's discount. */
  discount: z
    .string({ error: 'Enter the discount.' })
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Enter the discount like 146.68.'),
  reason: REASON,
  requestKey: z.string().optional(),
});

/**
 * Puts a discount on the bill of an invoice that already has money on it,
 * as if it had been on the invoice when it was made: before VAT, shared
 * across the lines, each line's VAT worked out on what is left — the same
 * pricing as the invoice form — so VAT comes down with it and no credit note
 * is needed. The lines stay; the invoice's entry is corrected. Never below
 * what is already paid or applied. (An unpaid invoice is simply edited.)
 */
export async function addBillDiscount(
  user: AuthenticatedUser,
  invoiceId: string,
  rawInput: unknown,
) {
  const input = parseInput(billDiscountSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.bill_discount_add');
    const invoice = await lockInvoice(tx, user.organizationId, invoiceId);
    requirePermission(user, 'invoice.edit', { branchId: invoice.branchId });
    if (invoice.status === 'VOID' || invoice.status === 'CANCELLED') {
      throw new DomainError('This invoice is void.');
    }
    if (invoice.invoiceType !== 'TAX_INVOICE') {
      throw new DomainError('A discount on the bill is given on a tax invoice.');
    }
    if (invoice.status === 'DRAFT') throw new DomainError('Edit the draft instead.');
    if (toFils(invoice.discountAmount.toString()) > 0) {
      throw new DomainError('This invoice already has a discount on the bill. Take it off first.');
    }
    if (isCredited(invoice)) throw new DomainError(CREDITED);
    if (hasSettlementDiscount(invoice)) {
      throw new DomainError(SETTLEMENT_DISCOUNT('put a discount on the bill'));
    }
    if (toFils(invoice.roundingAdjustment.toString().replace('-', '')) > 0) {
      throw new DomainError('This invoice has a round-off. Correct it as a credit note instead.');
    }

    let priced: ReturnType<typeof calculateDocument>;
    try {
      priced = calculateDocument(
        invoice.items.map(storedLineAmounts),
        readDiscount('AMOUNT', input.discount),
      );
    } catch (error) {
      throw new DomainError(
        error instanceof Error ? error.message : 'Check the discount.',
        'discount',
      );
    }
    const totalAmount = priced.totals.totalAmount;
    const paid = paidFils(invoice.payments);
    const settled = paid + toFils(invoice.advanceAppliedAmount.toString());
    if (toFils(totalAmount) < settled) {
      throw new DomainError(
        `That would take the invoice to ${totalAmount}, below the ${filsToString(settled)} already paid.`,
        'discount',
      );
    }

    for (const [index, item] of invoice.items.entries()) {
      await tx.invoiceItem.update({
        where: { id: item.id },
        data: { taxAmount: priced.lines[index].taxAmount },
      });
    }
    const status = settlementStatus({ ...invoice, totalAmount }, paid);
    const after = await tx.invoice.update({
      where: { id: invoice.id },
      data: { ...totalsData(priced.totals), roundingAdjustment: '0', status },
    });
    // The invoice's entry is corrected: the old one reversed, the new one
    // booked on the invoice's own date, with the discount in it.
    await syncPosting(tx, user.organizationId, 'INVOICE', invoice.id, user.id);
    await syncJobWithInvoice(tx, user.organizationId, invoice.id, user.id, {
      reason: 'bill_discount_added',
    });

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'invoice.bill_discount_added',
      entityType: 'Invoice',
      entityId: invoice.id,
      beforeData: {
        discountAmount: invoice.discountAmount.toString(),
        subtotal: invoice.subtotal.toString(),
        taxAmount: invoice.taxAmount.toString(),
        totalAmount: invoice.totalAmount.toString(),
        status: invoice.status,
      },
      afterData: {
        discountAmount: after.discountAmount.toString(),
        subtotal: after.subtotal.toString(),
        taxAmount: after.taxAmount.toString(),
        totalAmount: after.totalAmount.toString(),
        status: after.status,
      },
      metadata: { invoiceNumber: invoice.invoiceNumber, reason: input.reason },
    });
    await settleRequestKey(tx, user, rawInput, invoice.id);
    return {
      invoiceId: invoice.id,
      discountAmount: priced.totals.discountAmount,
      taxAmount: priced.totals.taxAmount,
      totalAmount,
      status,
    };
  });
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

const voidSchema = z.object({ reason: REASON, requestKey: z.string().optional() });

/** Why an invoice can't be voided, or null when it can. Shared with the screens. */
export function invoiceVoidBlocker(invoice: {
  status: string;
  paidAmount?: string;
  creditedAmount?: { toString(): string };
  advanceAppliedAmount?: { toString(): string };
  settlementDiscount?: { toString(): string };
  jobCard: { status: string } | null;
}): string | null {
  if (invoice.status === 'VOID' || invoice.status === 'CANCELLED')
    return 'This invoice is already void.';
  if (isCredited(invoice)) return CREDITED;
  if (hasAdvanceApplied(invoice)) return ADVANCE_APPLIED('void the invoice');
  if (hasSettlementDiscount(invoice)) return SETTLEMENT_DISCOUNT('void the invoice');
  if (
    invoice.status !== 'ISSUED' ||
    (invoice.paidAmount !== undefined && toFils(invoice.paidAmount) > 0)
  ) {
    return 'A payment has been recorded. Reverse the payment first to void the invoice.';
  }
  if (invoice.jobCard?.status === 'DELIVERED') {
    return 'The vehicle was already handed back on this invoice. Edit the invoice instead.';
  }
  return null;
}

/**
 * Voids an unpaid invoice. Its job card goes back to the stage it was
 * billed from, so it can be invoiced again.
 */
export async function voidInvoice(user: AuthenticatedUser, invoiceId: string, rawInput: unknown) {
  const input = parseInput(voidSchema, rawInput);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.void');
    const invoice = await lockInvoice(tx, user.organizationId, invoiceId);
    requirePermission(user, 'invoice.delete', { branchId: invoice.branchId });
    const blocker = invoiceVoidBlocker({
      status: invoice.status,
      paidAmount: filsToString(paidFils(invoice.payments)),
      creditedAmount: invoice.creditedAmount,
      advanceAppliedAmount: invoice.advanceAppliedAmount,
      settlementDiscount: invoice.settlementDiscount,
      jobCard: invoice.jobCard,
    });
    if (blocker) throw new DomainError(blocker);

    const voidedAt = new Date();
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'VOID', voidedAt, voidReason: input.reason },
    });
    // A void invoice was never a sale: its parts go back to stock, and its
    // entry is reversed.
    await syncInvoiceStock(tx, {
      organizationId: user.organizationId,
      invoiceId: invoice.id,
      userId: user.id,
    });
    await syncPosting(tx, user.organizationId, 'INVOICE', invoice.id, user.id);

    let reopenedTo: WorkflowStatus | null = null;
    if (invoice.jobCard && normalizeStatus(invoice.jobCard.status) === 'INVOICED') {
      // Back to where it was billed from: the stage before its latest move to INVOICED.
      const billed = await tx.jobStatusHistory.findFirst({
        where: {
          organizationId: user.organizationId,
          jobCardId: invoice.jobCard.id,
          toStatus: 'INVOICED',
        },
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
        select: { fromStatus: true },
      });
      const previous = billed?.fromStatus ? normalizeStatus(billed.fromStatus) : 'ARRIVED';
      reopenedTo = ['ON_HOLD', 'CANCELLED', 'REJECTED', 'INVOICED', 'PAID', 'DELIVERED'].includes(
        previous,
      )
        ? 'ARRIVED'
        : previous;
      await applyJobStatusChange(tx, {
        organizationId: user.organizationId,
        jobCardId: invoice.jobCard.id,
        toStatus: reopenedTo,
        actor: { userId: user.id },
        source: 'workflow',
        reopen: true,
        metadata: { invoiceId: invoice.id, reason: 'invoice_voided' },
      });
    }

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'invoice.voided',
      entityType: 'Invoice',
      entityId: invoice.id,
      beforeData: { status: invoice.status },
      afterData: { status: 'VOID', voidedAt: voidedAt.toISOString(), reason: input.reason },
      metadata: {
        invoiceNumber: invoice.invoiceNumber,
        totalAmount: invoice.totalAmount.toString(),
        jobCardId: invoice.jobCard?.id ?? null,
        jobReopenedTo: reopenedTo,
      },
    });
    await settleRequestKey(tx, user, rawInput, invoice.id);
    return { invoiceId: invoice.id, jobCardId: invoice.jobCard?.id ?? null };
  });
}

// ---------------------------------------------------------------------------
// Reverse a payment
// ---------------------------------------------------------------------------

const reversalSchema = z.object({ reason: REASON, requestKey: z.string().optional() });

/**
 * Cancels a customer payment recorded in error with a reversal row. The
 * invoice's balance reopens by that amount; a paid job card that was not
 * yet handed back returns to Invoiced.
 */
export async function reverseInvoicePayment(
  user: AuthenticatedUser,
  paymentId: string,
  rawInput: unknown,
) {
  const input = parseInput(reversalSchema, rawInput);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'payment.reversal');
    const found = await tx.payment.findFirst({
      where: { id: paymentId, organizationId: user.organizationId },
      select: { id: true, invoiceId: true },
    });
    if (!found) throw new NotFoundError('payment');
    const invoice = await lockInvoice(tx, user.organizationId, found.invoiceId);
    requirePermission(user, 'payment.delete', { branchId: invoice.branchId });

    const payment = await tx.payment.findFirstOrThrow({
      where: { id: found.id, organizationId: user.organizationId },
      include: { reversals: { select: { id: true } } },
    });
    if (payment.reversalOfPaymentId) throw new DomainError('That row is itself a reversal.');
    if (payment.status !== 'COMPLETED' || payment.reversals.length > 0) {
      throw new DomainError('This payment has already been reversed.');
    }
    if (invoice.status === 'VOID' || invoice.status === 'CANCELLED') {
      throw new DomainError('This invoice is void.');
    }
    // Money owed back under a credit note was worked out from what was paid.
    const refunding = await tx.creditNote.findFirst({
      where: {
        organizationId: user.organizationId,
        invoiceId: invoice.id,
        status: 'ISSUED',
        refundAmount: { gt: 0 },
      },
      select: { creditNoteNumber: true, refundedOn: true },
    });
    if (refunding) {
      throw new DomainError(
        refunding.refundedOn
          ? `Money was refunded to the customer under credit note ${refunding.creditNoteNumber}, so the payments on this invoice stand.`
          : `Credit note ${refunding.creditNoteNumber} owes the customer a refund out of this payment. Void the credit note first.`,
      );
    }

    const reversal = await tx.payment.create({
      data: {
        organizationId: user.organizationId,
        invoiceId: invoice.id,
        // Same positive amount; a reversal is identified by its link, not a sign.
        amount: payment.amount.toString(),
        method: payment.method,
        status: 'REVERSED',
        referenceNumber: `Reversal of ${payment.paymentNumber ?? payment.id}`,
        notes: input.reason,
        reversalOfPaymentId: payment.id,
        receivedAt: new Date(),
        receivedByUserId: user.id,
      },
      select: { id: true },
    });
    // The reversal is booked as its own entry, the original's opposite.
    await syncPosting(tx, user.organizationId, 'PAYMENT', reversal.id, user.id);

    const payments = [
      ...invoice.payments,
      {
        id: reversal.id,
        amount: payment.amount,
        status: 'REVERSED',
        reversalOfPaymentId: payment.id,
      },
    ];
    const paid = paidFils(payments);
    const status = settlementStatus(invoice, paid);
    await tx.invoice.update({ where: { id: invoice.id }, data: { status } });

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
        metadata: { invoiceId: invoice.id, paymentId: payment.id, reason: 'payment_reversed' },
      });
      jobReopened = true;
    }

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'payment.reversed',
      entityType: 'Payment',
      entityId: payment.id,
      beforeData: { invoiceStatus: invoice.status },
      afterData: {
        reversalId: reversal.id,
        invoiceStatus: status,
        balanceAfter: filsToString(dueFils(invoice, paid)),
        reason: input.reason,
      },
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        paymentNumber: payment.paymentNumber,
        amount: payment.amount.toString(),
        jobReopened,
      },
    });
    await settleRequestKey(tx, user, rawInput, reversal.id);
    return { invoiceId: invoice.id, jobCardId: invoice.jobCard?.id ?? null };
  });
}

// ─── The customer paid a little less than was recorded ──────────────────────

const shortPaymentSchema = z.object({
  /** What the customer actually handed over for this invoice, in all. */
  received: z
    .string({ error: 'Enter what was actually received.' })
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount like 2600 or 2600.00.'),
  reason: REASON,
  requestKey: z.string().optional(),
});

/**
 * A paid invoice whose customer actually paid a little less — 2,600.00 handed
 * over on a bill of 2,600.85, recorded as 2,600.85. Done the way an
 * accountant would, in one step, so the books never sit half-corrected:
 *
 *   1. the last payment is reversed (it stays on record, marked reversed);
 *   2. the invoice is rounded off by the difference — a round-off after VAT,
 *      so the VAT charged stays exactly as issued;
 *   3. the payment is recorded again for what really came in, on its
 *      original date, into the same account, with a new receipt number.
 *
 * The invoice stays paid, its job card where it was. Only a difference up to
 * the round-off limit (AED 5.00) is settled this way; anything larger is a
 * discount or a credit note.
 */
export async function settleShortPayment(
  user: AuthenticatedUser,
  invoiceId: string,
  rawInput: unknown,
) {
  const input = parseInput(shortPaymentSchema, rawInput);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.short_payment');
    const invoice = await lockInvoice(tx, user.organizationId, invoiceId);
    requirePermission(user, 'invoice.edit', { branchId: invoice.branchId });
    requirePermission(user, 'payment.delete', { branchId: invoice.branchId });
    requirePermission(user, 'payment.create', { branchId: invoice.branchId });
    if (invoice.status !== 'PAID') {
      throw new DomainError('Only a paid invoice can be corrected this way.');
    }
    if (isCredited(invoice)) throw new DomainError(CREDITED);

    const paid = paidFils(invoice.payments);
    const received = toFils(input.received);
    const difference = paid - received;
    if (difference <= 0) {
      throw new DomainError(
        `Enter less than the AED ${filsToString(paid)} recorded — what the customer actually paid.`,
        'received',
      );
    }
    const newRounding = signedFils(invoice.roundingAdjustment) - difference;
    if (Math.abs(newRounding) > MAX_ROUNDING_FILS) {
      throw new DomainError(
        `A difference of AED ${filsToString(difference)} is more than a round-off (at most AED ${filsToString(MAX_ROUNDING_FILS)}). Give a discount or a credit note instead.`,
        'received',
      );
    }

    // The payment that took the difference: the latest one still counting.
    const counting = await tx.payment.findMany({
      where: {
        organizationId: user.organizationId,
        invoiceId: invoice.id,
        status: 'COMPLETED',
        reversalOfPaymentId: null,
        reversals: { none: {} },
      },
      orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const last = counting[0];
    if (!last || toFils(last.amount.toString()) <= difference) {
      throw new DomainError(
        'The last payment is smaller than the difference, so it can’t simply be corrected. Reverse the payments and record them again instead.',
      );
    }

    // 1. Reverse the payment as recorded.
    const reversal = await tx.payment.create({
      data: {
        organizationId: user.organizationId,
        invoiceId: invoice.id,
        amount: last.amount.toString(),
        method: last.method,
        accountId: last.accountId,
        status: 'REVERSED',
        referenceNumber: `Reversal of ${last.paymentNumber ?? last.id}`,
        notes: input.reason,
        reversalOfPaymentId: last.id,
        // On the original payment's day: that day's takings net to the
        // corrected amount, and no period shows both receipts.
        receivedAt: last.receivedAt,
        receivedByUserId: user.id,
      },
      select: { id: true },
    });
    await syncPosting(tx, user.organizationId, 'PAYMENT', reversal.id, user.id);

    // 2. Round the invoice off by the difference; VAT as issued.
    const newTotal = toFils(invoice.totalAmount.toString()) - difference;
    const afterReversal = paid - toFils(last.amount.toString());
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        roundingAdjustment: signedText(newRounding),
        totalAmount: filsToString(newTotal),
        status: settlementStatus(
          {
            totalAmount: filsToString(newTotal),
            creditedAmount: invoice.creditedAmount,
            advanceAppliedAmount: invoice.advanceAppliedAmount,
            settlementDiscount: invoice.settlementDiscount,
          },
          afterReversal,
        ),
      },
    });
    await syncPosting(tx, user.organizationId, 'INVOICE', invoice.id, user.id);

    // 3. Record what really came in, as the original: same date, method, account.
    const corrected = await takePayment(
      tx,
      user,
      invoice.id,
      invoice.jobCard,
      {
        amount: filsToString(toFils(last.amount.toString()) - difference),
        method: last.method,
        accountId: last.accountId ?? '',
        referenceNumber: last.referenceNumber ?? '',
        notes: `Corrected from ${last.paymentNumber ?? 'the earlier receipt'}: ${input.reason}`,
      },
      last.receivedAt,
    );

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'invoice.short_payment_settled',
      entityType: 'Invoice',
      entityId: invoice.id,
      beforeData: {
        totalAmount: invoice.totalAmount.toString(),
        roundingAdjustment: invoice.roundingAdjustment.toString(),
        paid: filsToString(paid),
        paymentNumber: last.paymentNumber,
      },
      afterData: {
        totalAmount: filsToString(newTotal),
        received: filsToString(received),
        difference: filsToString(difference),
        reversalId: reversal.id,
        correctedPaymentId: corrected.id,
      },
      metadata: { reason: input.reason, invoiceNumber: invoice.invoiceNumber },
    });
    await settleRequestKey(tx, user, rawInput, invoice.id);
    return { invoiceNumber: invoice.invoiceNumber, paymentNumber: corrected.paymentNumber };
  });
}

/** A signed decimal ("-0.85") in fils. */
const signedFils = (value: { toString(): string }) => {
  const text = value.toString();
  return text.startsWith('-') ? -toFils(text.slice(1)) : toFils(text);
};
const signedText = (fils: number) => (fils < 0 ? `-${filsToString(-fils)}` : filsToString(fils));
