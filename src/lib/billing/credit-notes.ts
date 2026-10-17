import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { filsToString, shareFils, toFils } from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { allocateDocumentNumber } from '@/lib/numbering';
import { dueFils, paidFils, settlementStatus } from '@/lib/billing/invoice';
import { syncPosting } from '@/lib/accounting/journal';
import { syncCreditNoteStock } from '@/lib/inventory/credit-note-stock';
import { checkMoneyAccount } from '@/lib/accounting/chart';
import { emptyToNull } from '@/lib/normalize';
import { returnToAdvances, undoReturnsToAdvances } from '@/lib/billing/advances';
import { applyJobStatusChange, normalizeStatus } from '@/lib/workshop/job-status';

/*
 * Tax credit notes — the only way an issued tax invoice is reduced once it
 * has been paid, or once its VAT period may have been reported. The invoice
 * itself is never changed: the credit note is a document of its own, with
 * its own number (CN-), date and reason, that takes part or all of the
 * invoice back.
 *
 *   The invoice          stays exactly as issued; its `creditedAmount` grows
 *                        by the note's total, so what is due becomes
 *                        total − credited − paid − advance applied
 *                        (lib/billing/invoice.ts).
 *   VAT                  the note reduces the supplies and output VAT of the
 *                        period it is issued in (lib/finance/vat.ts).
 *   The books            Dr income and VAT, Cr trade receivables — the
 *                        invoice's own entry, in part, undone
 *                        (lib/accounting/postings.ts).
 *   Money already paid   beyond what is now due is owed back to the customer.
 *                        What was settled from customer advances goes back
 *                        to those advances first (lib/billing/advances.ts);
 *                        only the rest is a cash refund, which the note
 *                        records when it is paid out.
 *
 * Each note credits invoice lines by amount (before VAT). A line can never
 * be credited beyond what it was sold for, across all notes; a line credited
 * in full comes back to the fil — its own VAT and its share of any bill
 * discount exactly — so crediting a whole invoice mirrors it exactly.
 *
 * A note is voided, never deleted, and only while no refund has been paid
 * under it.
 *
 * An invoice's round-off (outside VAT) is taken back by the note that
 * credits the last of its lines, so a fully credited invoice owes nothing.
 *
 * createDiscountCreditNote is a credit note too (no screen offers it: a
 * discount is given on the invoice form, or off the total afterwards —
 * lib/billing/invoice-changes.ts discountInvoice): a
 * discount agreed after the invoice — the customer paying 154.00 less —
 * lowers the sale and its VAT, which only a tax credit note may do. The
 * amount, VAT included, is spread across the lines in proportion, exactly to
 * the fil, and issued by the same rules as any other note.
 */

const REASON = z
  .string({ error: 'Say why the invoice is being credited.' })
  .trim()
  .min(3, 'Say why the invoice is being credited, in a few words.')
  .max(500, 'Keep the reason under 500 characters.');

const AMOUNT = /^\d+(\.\d{1,2})?$/;

const creditSchema = z.object({
  issueDate: z.string().trim().optional(),
  reason: REASON,
  lines: z
    .array(
      z.object({
        invoiceItemId: z.uuid(),
        /** Before VAT, after the line's share of any bill discount. Blank or 0 skips it. */
        amount: z
          .string()
          .trim()
          .refine((value) => !value || AMOUNT.test(value), 'Enter an amount like 250 or 250.50.'),
        /** How many of the line's units come back (the document's quantity). */
        quantity: z.string().trim().optional(),
        /** "1": those units came back into stock (a part sold from stock). */
        restock: z.string().optional(),
      }),
    )
    .max(100),
  requestKey: z.string().optional(),
});

/** Signed: a round-off (an invoice rounded down, the credit taking it back) is below zero. */
const fils = (value: { toString(): string } | null | undefined) => {
  if (!value) return 0;
  const text = value.toString().trim();
  return text.startsWith('-') ? -toFils(text.slice(1)) : toFils(text);
};

const milli = (value: { toString(): string }) => Math.round(Number(value.toString()) * 1000);

/** Half-up rounding of a non-negative integer ratio. */
const divRound = (numerator: bigint, denominator: bigint) =>
  Number((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)));

type Tx = Prisma.TransactionClient;

interface InvoiceLine {
  id: string;
  itemType: Prisma.InvoiceItemGetPayload<object>['itemType'];
  description: string;
  quantity: { toString(): string };
  unitPrice: { toString(): string };
  lineTotal: { toString(): string };
  taxRate: { toString(): string } | null;
  taxAmount: { toString(): string } | null;
  vatTreatment: Prisma.InvoiceItemGetPayload<object>['vatTreatment'];
  accountId: string | null;
  partId?: string | null;
  partUsageId?: string | null;
  unitCost?: { toString(): string } | null;
}

interface CreditedSoFar {
  gross: number;
  share: number;
  tax: number;
}

/**
 * What is left to credit on each line of an invoice: its value after its
 * share of the bill discount, less every issued credit note against it.
 */
export function creditableLines(
  invoice: { discountAmount: { toString(): string }; items: InvoiceLine[] },
  credited: Map<string, CreditedSoFar>,
) {
  const shares = shareFils(
    fils(invoice.discountAmount),
    invoice.items.map((item) => fils(item.lineTotal)),
  );
  return invoice.items.map((item, index) => {
    const gross = fils(item.lineTotal);
    const share = shares[index];
    const tax = fils(item.taxAmount);
    const before = credited.get(item.id) ?? { gross: 0, share: 0, tax: 0 };
    return {
      item,
      gross,
      share,
      tax,
      before,
      /** Net of the bill discount, before VAT. */
      net: gross - share,
      remaining: gross - share - (before.gross - before.share),
      remainingTax: tax - before.tax,
    };
  });
}

type Creditable = ReturnType<typeof creditableLines>[number];

/** The part of a line a credit of `amount` fils (before VAT) takes back. */
function creditPart(line: Creditable, amount: number) {
  if (amount === line.remaining) {
    // The rest of the line: exactly what is left, so nothing is ever off by a fil.
    return {
      gross: line.gross - line.before.gross,
      share: line.share - line.before.share,
      tax: line.remainingTax,
    };
  }
  let gross = line.net > 0 ? divRound(BigInt(amount) * BigInt(line.gross), BigInt(line.net)) : 0;
  gross = Math.min(Math.max(gross, amount), line.gross - line.before.gross);
  let share = gross - amount;
  if (share > line.share - line.before.share) {
    share = line.share - line.before.share;
    gross = amount + share;
  }
  const rateHundredths = Math.round(Number((line.item.taxRate ?? 0).toString()) * 100);
  const tax = Math.min(
    divRound(BigInt(amount) * BigInt(rateHundredths), BigInt(10000)),
    line.remainingTax,
  );
  return { gross, share, tax };
}

async function creditedSoFar(tx: Tx | typeof prisma, organizationId: string, invoiceId: string) {
  const rows = await tx.creditNoteItem.findMany({
    where: {
      organizationId,
      invoiceItemId: { not: null },
      creditNote: { invoiceId, status: 'ISSUED' },
    },
    select: { invoiceItemId: true, lineTotal: true, discountAmount: true, taxAmount: true },
  });
  const byLine = new Map<string, CreditedSoFar>();
  for (const row of rows) {
    const entry = byLine.get(row.invoiceItemId!) ?? { gross: 0, share: 0, tax: 0 };
    entry.gross += fils(row.lineTotal);
    entry.share += fils(row.discountAmount);
    entry.tax += fils(row.taxAmount);
    byLine.set(row.invoiceItemId!, entry);
  }
  return byLine;
}

/** A line that sold a part from stock at a known cost: it can come back into stock. */
const restockable = (item: {
  partId?: string | null;
  partUsageId?: string | null;
  unitCost?: { toString(): string } | null;
}) => Boolean(item.partId && !item.partUsageId && item.unitCost);

/** How many of each invoice line already came back into stock, in thousandths. */
async function returnedSoFar(tx: Tx | typeof prisma, organizationId: string, invoiceId: string) {
  const rows = await tx.creditNoteItem.findMany({
    where: {
      organizationId,
      invoiceItemId: { not: null },
      returnedQuantity: { not: null },
      creditNote: { invoiceId, status: 'ISSUED' },
    },
    select: { invoiceItemId: true, returnedQuantity: true },
  });
  const byLine = new Map<string, number>();
  for (const row of rows) {
    byLine.set(
      row.invoiceItemId!,
      (byLine.get(row.invoiceItemId!) ?? 0) + milli(row.returnedQuantity!),
    );
  }
  return byLine;
}

const INVOICE_LINES = {
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  select: {
    id: true,
    itemType: true,
    description: true,
    quantity: true,
    unitPrice: true,
    lineTotal: true,
    taxRate: true,
    taxAmount: true,
    vatTreatment: true,
    accountId: true,
    partId: true,
    partUsageId: true,
    unitCost: true,
  },
};

/**
 * Job cards are locked before invoices, everywhere: lock the invoice's job
 * card (if it has one) before the invoice itself.
 */
async function lockInvoiceJob(tx: Tx, organizationId: string, invoiceId: string) {
  const target = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: { jobCardId: true },
  });
  if (target?.jobCardId) {
    await tx.$executeRaw`SELECT id FROM job_cards WHERE id = ${target.jobCardId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  }
}

/**
 * Keeps an invoice's job card in step with what is owed on it, as a payment
 * does: once nothing is due (a credit note or discount settling it), an
 * Invoiced job becomes Paid; once something is owed again (the credit note
 * voided), a Paid job goes back to Invoiced. A delivered job stays delivered.
 * Through the job's own status change, so it is in its history and audit.
 * Returns the status the job moved to, or null when it was left alone.
 */
export async function syncJobWithInvoice(
  tx: Tx,
  organizationId: string,
  invoiceId: string,
  actorUserId: string,
  metadata: Record<string, unknown>,
) {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: { status: true, jobCard: { select: { id: true, status: true } } },
  });
  if (!invoice?.jobCard) return null;
  const job = normalizeStatus(invoice.jobCard.status);
  if (invoice.status === 'PAID' && job === 'INVOICED') {
    await applyJobStatusChange(tx, {
      organizationId,
      jobCardId: invoice.jobCard.id,
      toStatus: 'PAID',
      actor: { userId: actorUserId },
      source: 'workflow',
      metadata: { invoiceId, ...metadata },
    });
    return 'PAID' as const;
  }
  if (invoice.status !== 'PAID' && job === 'PAID') {
    await applyJobStatusChange(tx, {
      organizationId,
      jobCardId: invoice.jobCard.id,
      toStatus: 'INVOICED',
      actor: { userId: actorUserId },
      source: 'workflow',
      reopen: true,
      metadata: { invoiceId, ...metadata },
    });
    return 'INVOICED' as const;
  }
  return null;
}

/** Why an invoice can't be credited, or null when it can. Shared with the screens. */
export function creditBlocker(invoice: {
  invoiceType: string;
  status: string;
  totalAmount: { toString(): string };
  creditedAmount: { toString(): string };
  settlementDiscount: { toString(): string };
}): string | null {
  if (invoice.invoiceType !== 'TAX_INVOICE') {
    return 'A pro-forma invoice is not a supply. Edit or void it instead.';
  }
  if (invoice.status === 'VOID' || invoice.status === 'CANCELLED') return 'This invoice is void.';
  if (invoice.status === 'DRAFT') return 'A draft invoice has not been issued. Edit it instead.';
  if (fils(invoice.creditedAmount) >= fils(invoice.totalAmount)) {
    return 'This invoice has been credited in full.';
  }
  // The two would both come off the same total.
  if (fils(invoice.settlementDiscount) > 0) {
    return 'A discount was given on this invoice after it. Take the discount off first to issue a credit note.';
  }
  return null;
}

/** The credit note screen: each invoice line with what is left to credit on it. */
export async function getCreditableInvoice(user: AuthenticatedUser, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId: user.organizationId },
    select: {
      id: true,
      branchId: true,
      invoiceNumber: true,
      invoiceType: true,
      status: true,
      issueDate: true,
      customerName: true,
      discountAmount: true,
      subtotal: true,
      taxAmount: true,
      totalAmount: true,
      creditedAmount: true,
      advanceAppliedAmount: true,
      settlementDiscount: true,
      jobCardId: true,
      customer: { select: { name: true } },
      items: INVOICE_LINES,
      payments: { select: { id: true, amount: true, status: true, reversalOfPaymentId: true } },
    },
  });
  if (!invoice) throw new NotFoundError('invoice');
  requirePermission(user, 'credit_note.create', { branchId: invoice.branchId });
  const credited = await creditedSoFar(prisma, user.organizationId, invoice.id);
  const returned = await returnedSoFar(prisma, user.organizationId, invoice.id);
  const lines = creditableLines(invoice, credited).map((line) => ({
    id: line.item.id,
    itemType: line.item.itemType,
    description: line.item.description,
    quantity: line.item.quantity.toString(),
    vatTreatment: line.item.vatTreatment,
    taxRate: (line.item.taxRate ?? 0).toString(),
    /** After its share of the bill discount, before VAT. */
    net: filsToString(line.net),
    remaining: filsToString(line.remaining),
    remainingTax: filsToString(line.remainingTax),
    /** A part sold from stock: what is credited can go back on the shelf. */
    stocked: restockable(line.item),
    /** How many of it can still come back. */
    returnable: (
      Math.max(milli(line.item.quantity) - (returned.get(line.item.id) ?? 0), 0) / 1000
    ).toString(),
  }));
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    customerName: invoice.customerName ?? invoice.customer.name,
    jobCardId: invoice.jobCardId,
    totalAmount: invoice.totalAmount.toString(),
    creditedAmount: invoice.creditedAmount.toString(),
    paid: filsToString(paidFils(invoice.payments)),
    advanceApplied: invoice.advanceAppliedAmount.toString(),
    blocker: creditBlocker(invoice),
    lines,
  };
}

/**
 * Issues a tax credit note against an invoice. Returns the note, with the
 * refund now owed to the customer (the money paid beyond what is due).
 */
export async function createCreditNote(
  user: AuthenticatedUser,
  invoiceId: string,
  rawInput: unknown,
) {
  const input = parseInput(creditSchema, rawInput);
  const issueDay = input.issueDate || localDateString();
  const issueDate = parseCalendarDate(issueDay);
  if (!issueDate) throw new DomainError('Enter the credit note date.', 'issueDate');
  if (issueDay > localDateString()) {
    throw new DomainError('A credit note cannot be dated in the future.', 'issueDate');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'credit_note.create');
    await lockInvoiceJob(tx, user.organizationId, invoiceId);
    await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId: user.organizationId },
      select: {
        id: true,
        branchId: true,
        customerId: true,
        invoiceNumber: true,
        invoiceType: true,
        status: true,
        issueDate: true,
        discountAmount: true,
        totalAmount: true,
        creditedAmount: true,
        advanceAppliedAmount: true,
        settlementDiscount: true,
        roundingAdjustment: true,
        items: INVOICE_LINES,
        payments: { select: { id: true, amount: true, status: true, reversalOfPaymentId: true } },
      },
    });
    if (!invoice) throw new NotFoundError('invoice');
    requirePermission(user, 'credit_note.create', { branchId: invoice.branchId });
    const blocker = creditBlocker(invoice);
    if (blocker) throw new DomainError(blocker);
    if (issueDate < invoice.issueDate) {
      throw new DomainError('A credit note cannot be dated before its invoice.', 'issueDate');
    }

    const lines = creditableLines(
      invoice,
      await creditedSoFar(tx, user.organizationId, invoice.id),
    );
    const returnedBefore = await returnedSoFar(tx, user.organizationId, invoice.id);
    const items: Prisma.CreditNoteItemCreateManyInput[] = [];
    let grossTotal = 0;
    let shareTotal = 0;
    let taxTotal = 0;
    input.lines.forEach((entry, index) => {
      const amount = entry.amount ? toFils(entry.amount) : 0;
      if (amount === 0) return;
      const line = lines.find((candidate) => candidate.item.id === entry.invoiceItemId);
      if (!line) throw new DomainError('That line is not on this invoice.', `lines.${index}`);
      if (amount > line.remaining) {
        throw new DomainError(
          `"${line.item.description}": only ${filsToString(line.remaining)} is left to credit.`,
          `lines.${index}.amount`,
        );
      }
      const part = creditPart(line, amount);
      const whole = part.gross === line.gross;
      const quantityMilli = whole
        ? milli(line.item.quantity)
        : entry.quantity && Number(entry.quantity) > 0
          ? Math.min(Math.round(Number(entry.quantity) * 1000), milli(line.item.quantity))
          : 1000;
      // Back on the shelf: never more than was sold, less what came back before.
      const restock = entry.restock === '1' || entry.restock === 'on';
      if (restock) {
        if (!restockable(line.item)) {
          throw new DomainError(
            `"${line.item.description}" was not sold from stock, so it can't go back into it.`,
            `lines.${index}`,
          );
        }
        const left = milli(line.item.quantity) - (returnedBefore.get(line.item.id) ?? 0);
        if (quantityMilli > left) {
          throw new DomainError(
            `"${line.item.description}": only ${Math.max(left, 0) / 1000} can still come back.`,
            `lines.${index}`,
          );
        }
      }
      grossTotal += part.gross;
      shareTotal += part.share;
      taxTotal += part.tax;
      items.push({
        organizationId: user.organizationId,
        creditNoteId: '',
        invoiceItemId: line.item.id,
        itemType: line.item.itemType,
        description: line.item.description,
        quantity: (quantityMilli / 1000).toFixed(3),
        unitPrice: whole
          ? line.item.unitPrice.toString()
          : filsToString(divRound(BigInt(part.gross) * BigInt(1000), BigInt(quantityMilli))),
        lineTotal: filsToString(part.gross),
        discountAmount: filsToString(part.share),
        vatTreatment: line.item.vatTreatment,
        taxRate: (line.item.taxRate ?? 0).toString(),
        taxAmount: filsToString(part.tax),
        accountId: line.item.accountId,
        partId: line.item.partId ?? null,
        returnedQuantity: restock ? (quantityMilli / 1000).toFixed(3) : null,
        unitCost: restock ? (line.item.unitCost?.toString() ?? null) : null,
      });
    });
    if (items.length === 0) {
      throw new DomainError('Enter the amount to credit on at least one line.', 'lines');
    }

    const subtotal = grossTotal - shareTotal;
    // The note that credits the last of the lines takes the round-off back too.
    const creditedNow = new Map(items.map((item) => [item.invoiceItemId, item]));
    const clearsEveryLine = lines.every(
      (line) =>
        line.remaining === 0 ||
        fils(creditedNow.get(line.item.id)?.lineTotal) -
          fils(creditedNow.get(line.item.id)?.discountAmount) ===
          line.remaining,
    );
    const roundingTaken = await tx.creditNote.aggregate({
      where: { organizationId: user.organizationId, invoiceId: invoice.id, status: 'ISSUED' },
      _sum: { roundingAmount: true },
    });
    const rounding = clearsEveryLine
      ? fils(invoice.roundingAdjustment) - fils(roundingTaken._sum.roundingAmount)
      : 0;
    const total = subtotal + taxTotal + rounding;
    if (total < 0) {
      throw new DomainError(
        'This credit is smaller than the invoice’s round-off. Credit more of the invoice in one note.',
      );
    }
    const creditedBefore = fils(invoice.creditedAmount);
    const invoiceTotal = fils(invoice.totalAmount);
    if (creditedBefore + total > invoiceTotal) {
      throw new DomainError('That would credit more than the invoice was for.');
    }
    const paid = paidFils(invoice.payments);
    const appliedBefore = fils(invoice.advanceAppliedAmount);
    // What was settled beyond what is now due goes back to the customer: to
    // their advances first, as far as advances settled it, and the rest as a
    // cash refund.
    const excess = Math.min(
      Math.max(paid + appliedBefore - (invoiceTotal - creditedBefore - total), 0),
      total,
    );
    const toAdvances = Math.min(excess, appliedBefore);
    const refund = excess - toAdvances;

    const creditNoteNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      invoice.branchId,
      'CREDIT_NOTE',
    );
    const note = await tx.creditNote.create({
      data: {
        organizationId: user.organizationId,
        branchId: invoice.branchId,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        creditNoteNumber,
        issueDate,
        reason: input.reason,
        discountAmount: filsToString(shareTotal),
        subtotal: filsToString(subtotal),
        taxAmount: filsToString(taxTotal),
        roundingAmount: filsToString(rounding),
        totalAmount: filsToString(total),
        refundAmount: filsToString(refund),
        createdByUserId: user.id,
      },
      select: { id: true },
    });
    await tx.creditNoteItem.createMany({
      data: items.map((item) => ({ ...item, creditNoteId: note.id })),
    });
    // Parts the customer brought back are in stock again; their cost comes
    // off cost of sales on the note's entry.
    await syncCreditNoteStock(tx, {
      organizationId: user.organizationId,
      creditNoteId: note.id,
      userId: user.id,
    });
    const returned = await returnToAdvances(tx, user, {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      branchId: invoice.branchId,
      creditNoteId: note.id,
      creditNoteNumber,
      issueDate,
      fils: toAdvances,
    });

    const invoiceAfter = {
      totalAmount: invoice.totalAmount,
      creditedAmount: filsToString(creditedBefore + total),
      advanceAppliedAmount: filsToString(appliedBefore - returned),
      settlementDiscount: invoice.settlementDiscount,
    };
    const status = settlementStatus(invoiceAfter, paid);
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        creditedAmount: invoiceAfter.creditedAmount,
        advanceAppliedAmount: invoiceAfter.advanceAppliedAmount,
        status,
      },
    });
    await syncPosting(tx, user.organizationId, 'CREDIT_NOTE', note.id, user.id);
    // Settled by the credit note (with what was paid): the job card is paid too.
    await syncJobWithInvoice(tx, user.organizationId, invoice.id, user.id, {
      creditNoteId: note.id,
      reason: 'credit_note_issued',
    });

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'credit_note.issued',
      entityType: 'CreditNote',
      entityId: note.id,
      afterData: {
        creditNoteNumber,
        issueDate: issueDay,
        reason: input.reason,
        subtotal: filsToString(subtotal),
        taxAmount: filsToString(taxTotal),
        ...(rounding ? { roundingAmount: filsToString(rounding) } : {}),
        totalAmount: filsToString(total),
        refundAmount: filsToString(refund),
        returnedToAdvances: filsToString(returned),
        lines: items.map((item) => ({
          invoiceItemId: item.invoiceItemId,
          lineTotal: item.lineTotal,
          discountAmount: item.discountAmount,
          taxAmount: item.taxAmount,
        })),
      },
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceStatusBefore: invoice.status,
        invoiceStatusAfter: status,
      },
    });
    await settleRequestKey(tx, user, rawInput, note.id);
    return {
      creditNoteId: note.id,
      creditNoteNumber,
      totalAmount: filsToString(total),
      refundAmount: filsToString(refund),
      returnedToAdvances: filsToString(returned),
    };
  });
}

// ---------------------------------------------------------------------------
// Give discount: a credit note for an amount, VAT included
// ---------------------------------------------------------------------------

const discountSchema = z.object({
  /** The discount, VAT included — what the customer pays less. */
  amount: z
    .string({ error: 'Enter the discount.' })
    .trim()
    .refine(
      (value) => AMOUNT.test(value) && toFils(value) > 0,
      'Enter the discount like 154 or 154.00.',
    ),
  reason: z.string().trim().max(500).optional(),
  issueDate: z.string().trim().optional(),
  requestKey: z.string().optional(),
});

/**
 * How a discount of `target` fils, VAT included, falls across an invoice's
 * lines: in proportion to what is left on each (with its VAT), each line's
 * amount before VAT chosen so that it and its VAT make its share. VAT is
 * rounded per line, so some totals can't be made on one line alone (at 5%,
 * 84.29 + 4.21 = 88.50 and 84.30 + 4.22 = 88.52 — never 88.51); the fil or
 * two left over is then made up by moving one or two lines a few fils. Null
 * only when no such mix makes the amount exactly.
 */
export function splitDiscount(lines: Creditable[], target: number) {
  const open = lines.filter((line) => line.remaining > 0);
  const values = open.map((line) => line.remaining + line.remainingTax);
  const everything = values.reduce((sum, value) => sum + value, 0);
  if (target >= everything) {
    // The whole of what is left: every line in full.
    return open.map((line) => ({ line, amount: line.remaining }));
  }
  /** A line's amount before VAT, and that amount with its VAT. */
  const withVat = (line: Creditable, amount: number) =>
    amount <= 0 ? 0 : amount + creditPart(line, amount).tax;
  const shares = shareFils(target, values);
  const amounts = open.map((line, index) => {
    const rate = Math.round(Number((line.item.taxRate ?? 0).toString()) * 100);
    const guess = Math.round((shares[index] * 10000) / (10000 + rate));
    // The largest amount whose total with VAT does not pass the line's share.
    let best = 0;
    for (
      let amount = Math.max(guess - 3, 0);
      amount <= Math.min(guess + 3, line.remaining);
      amount++
    ) {
      if (withVat(line, amount) <= shares[index]) best = amount;
    }
    return best;
  });
  const reached = () => open.reduce((sum, line, index) => sum + withVat(line, amounts[index]), 0);
  const fits = (index: number, amount: number) => amount >= 0 && amount <= open[index].remaining;

  // Make up the difference: one line moved a few fils, else two.
  const STEPS = [-4, -3, -2, -1, 1, 2, 3, 4];
  let gap = target - reached();
  for (let i = 0; gap !== 0 && i < open.length; i++) {
    for (const step of STEPS) {
      const moved = amounts[i] + step;
      if (!fits(i, moved)) continue;
      if (withVat(open[i], moved) - withVat(open[i], amounts[i]) === gap) {
        amounts[i] = moved;
        gap = 0;
        break;
      }
    }
  }
  for (let i = 0; gap !== 0 && i < open.length; i++) {
    for (let j = i + 1; gap !== 0 && j < open.length; j++) {
      for (const a of STEPS) {
        if (gap === 0) break;
        for (const b of STEPS) {
          const ai = amounts[i] + a;
          const bj = amounts[j] + b;
          if (!fits(i, ai) || !fits(j, bj)) continue;
          const change =
            withVat(open[i], ai) -
            withVat(open[i], amounts[i]) +
            withVat(open[j], bj) -
            withVat(open[j], amounts[j]);
          if (change === gap) {
            amounts[i] = ai;
            amounts[j] = bj;
            gap = 0;
            break;
          }
        }
      }
    }
  }
  if (gap !== 0) return null;
  return open
    .map((line, index) => ({ line, amount: amounts[index] }))
    .filter((entry) => entry.amount > 0);
}

/**
 * Gives a customer a discount on an issued invoice after the fact — the
 * customer paid less, and the difference is a discount, not a debt. Issued
 * as a tax credit note (so the sale and output VAT come down), never more
 * than is still due on the invoice, so no refund ever arises from it.
 */
export async function createDiscountCreditNote(
  user: AuthenticatedUser,
  invoiceId: string,
  rawInput: unknown,
) {
  const input = parseInput(discountSchema, rawInput);
  const target = toFils(input.amount);
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId: user.organizationId },
    select: {
      id: true,
      branchId: true,
      invoiceType: true,
      status: true,
      discountAmount: true,
      totalAmount: true,
      creditedAmount: true,
      advanceAppliedAmount: true,
      settlementDiscount: true,
      items: INVOICE_LINES,
      payments: { select: { id: true, amount: true, status: true, reversalOfPaymentId: true } },
    },
  });
  if (!invoice) throw new NotFoundError('invoice');
  requirePermission(user, 'credit_note.create', { branchId: invoice.branchId });
  const blocker = creditBlocker(invoice);
  if (blocker) throw new DomainError(blocker);
  const due = dueFils(invoice, paidFils(invoice.payments));
  if (target > due) {
    throw new DomainError(
      `Only ${filsToString(due)} is still due on this invoice. To give back money already paid, issue a credit note.`,
      'amount',
    );
  }
  const lines = creditableLines(
    invoice,
    await creditedSoFar(prisma, user.organizationId, invoice.id),
  );
  const split = splitDiscount(lines, target);
  if (!split || split.length === 0) {
    throw new DomainError(
      `A discount of exactly ${filsToString(target)} can't be split across the lines to the fil. Try a fil more or less.`,
      'amount',
    );
  }
  return createCreditNote(user, invoice.id, {
    issueDate: input.issueDate,
    reason: input.reason?.trim() || 'Discount given at payment',
    lines: split.map(({ line, amount }) => ({
      invoiceItemId: line.item.id,
      amount: filsToString(amount),
    })),
    requestKey: input.requestKey,
  });
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

const refundSchema = z.object({
  refundedOn: z
    .string({ error: 'Enter the date of the refund.' })
    .trim()
    .min(1, 'Enter the date of the refund.'),
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'], {
    error: 'Choose how the money was paid back.',
  }),
  accountId: z.union([z.literal(''), z.uuid()]).optional(),
  reference: z.string().trim().max(100).optional(),
  requestKey: z.string().optional(),
});

/** Records the refund owed under a credit note as paid out to the customer. */
export async function recordCreditNoteRefund(
  user: AuthenticatedUser,
  creditNoteId: string,
  rawInput: unknown,
) {
  const input = parseInput(refundSchema, rawInput);
  const refundedOn = parseCalendarDate(input.refundedOn);
  if (!refundedOn) throw new DomainError('Enter the date of the refund.', 'refundedOn');
  if (input.refundedOn > localDateString()) {
    throw new DomainError('A refund cannot be dated in the future.', 'refundedOn');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'credit_note.refund');
    await tx.$executeRaw`SELECT id FROM credit_notes WHERE id = ${creditNoteId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
    const note = await tx.creditNote.findFirst({
      where: { id: creditNoteId, organizationId: user.organizationId },
      select: {
        id: true,
        branchId: true,
        status: true,
        issueDate: true,
        creditNoteNumber: true,
        refundAmount: true,
        refundedOn: true,
      },
    });
    if (!note) throw new NotFoundError('credit note');
    requirePermission(user, 'payment.delete', { branchId: note.branchId });
    if (note.status !== 'ISSUED') throw new DomainError('This credit note is void.');
    if (fils(note.refundAmount) === 0) {
      throw new DomainError('Nothing is owed back to the customer under this credit note.');
    }
    if (note.refundedOn) throw new DomainError('The refund has already been recorded.');
    if (refundedOn < note.issueDate) {
      throw new DomainError('A refund cannot be dated before its credit note.', 'refundedOn');
    }
    const accountId = await checkMoneyAccount(tx, user.organizationId, input.accountId);

    await tx.creditNote.update({
      where: { id: note.id },
      data: {
        refundedOn,
        refundMethod: input.method,
        refundAccountId: accountId,
        refundReference: emptyToNull(input.reference),
      },
    });
    await syncPosting(tx, user.organizationId, 'CREDIT_NOTE_REFUND', note.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: note.branchId,
      actorUserId: user.id,
      action: 'credit_note.refunded',
      entityType: 'CreditNote',
      entityId: note.id,
      afterData: {
        refundedOn: input.refundedOn,
        method: input.method,
        accountId,
        reference: emptyToNull(input.reference),
        amount: note.refundAmount.toString(),
      },
      metadata: { creditNoteNumber: note.creditNoteNumber },
    });
    await settleRequestKey(tx, user, rawInput, note.id);
    return { creditNoteId: note.id };
  });
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

const voidSchema = z.object({
  reason: z
    .string({ error: 'Say why.' })
    .trim()
    .min(3, 'Say why, in a few words.')
    .max(500, 'Keep the reason under 500 characters.'),
  requestKey: z.string().optional(),
});

/** Why a credit note can't be voided, or null when it can. */
export function creditNoteVoidBlocker(note: { status: string; refundedOn: Date | null }) {
  if (note.status !== 'ISSUED') return 'This credit note is already void.';
  if (note.refundedOn) {
    return 'A refund has been paid under this credit note, so it stands. Issue a new invoice if the customer is to be charged again.';
  }
  return null;
}

/**
 * Withdraws a credit note issued in error: the invoice is owed again in
 * full and the note's entry is reversed. Its number is never reused.
 */
export async function voidCreditNote(
  user: AuthenticatedUser,
  creditNoteId: string,
  rawInput: unknown,
) {
  const input = parseInput(voidSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'credit_note.void');
    const found = await tx.creditNote.findFirst({
      where: { id: creditNoteId, organizationId: user.organizationId },
      select: { id: true, invoiceId: true },
    });
    if (!found) throw new NotFoundError('credit note');
    // Its job card, then the invoice, as everything that changes them does.
    await lockInvoiceJob(tx, user.organizationId, found.invoiceId);
    await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${found.invoiceId}::uuid FOR UPDATE`;
    await tx.$executeRaw`SELECT id FROM credit_notes WHERE id = ${found.id}::uuid FOR UPDATE`;
    const note = await tx.creditNote.findFirstOrThrow({
      where: { id: found.id },
      select: {
        id: true,
        branchId: true,
        status: true,
        refundedOn: true,
        creditNoteNumber: true,
        totalAmount: true,
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            totalAmount: true,
            creditedAmount: true,
            advanceAppliedAmount: true,
            settlementDiscount: true,
            payments: {
              select: { id: true, amount: true, status: true, reversalOfPaymentId: true },
            },
          },
        },
      },
    });
    requirePermission(user, 'credit_note.delete', { branchId: note.branchId });
    const blocker = creditNoteVoidBlocker(note);
    if (blocker) throw new DomainError(blocker);

    const invoice = note.invoice;
    // Money the note gave back to advances is applied to the invoice again.
    const restored = await undoReturnsToAdvances(
      tx,
      user,
      note.id,
      `Credit note ${note.creditNoteNumber} voided: ${input.reason}`,
    );
    const creditedAmount = filsToString(
      Math.max(fils(invoice.creditedAmount) - fils(note.totalAmount), 0),
    );
    const advanceAppliedAmount = filsToString(fils(invoice.advanceAppliedAmount) + restored);
    const status = settlementStatus(
      {
        totalAmount: invoice.totalAmount,
        creditedAmount,
        advanceAppliedAmount,
        settlementDiscount: invoice.settlementDiscount,
      },
      paidFils(invoice.payments),
    );
    const voidedAt = new Date();
    await tx.creditNote.update({
      where: { id: note.id },
      data: { status: 'VOID', voidedAt, voidReason: input.reason },
    });
    // Parts it returned to stock leave it again.
    await syncCreditNoteStock(tx, {
      organizationId: user.organizationId,
      creditNoteId: note.id,
      userId: user.id,
    });
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { creditedAmount, advanceAppliedAmount, status },
    });
    await syncPosting(tx, user.organizationId, 'CREDIT_NOTE', note.id, user.id);
    // Owed again: a paid job card goes back to invoiced.
    await syncJobWithInvoice(tx, user.organizationId, invoice.id, user.id, {
      creditNoteId: note.id,
      reason: 'credit_note_voided',
    });

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: note.branchId,
      actorUserId: user.id,
      action: 'credit_note.voided',
      entityType: 'CreditNote',
      entityId: note.id,
      beforeData: { status: 'ISSUED' },
      afterData: { status: 'VOID', voidedAt: voidedAt.toISOString(), reason: input.reason },
      metadata: {
        creditNoteNumber: note.creditNoteNumber,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceStatusAfter: status,
        reappliedFromAdvances: filsToString(restored),
      },
    });
    await settleRequestKey(tx, user, rawInput, note.id);
    return { creditNoteId: note.id, invoiceId: invoice.id };
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** One credit note, for its page and its printed copy. */
export async function getCreditNote(user: AuthenticatedUser, creditNoteId: string) {
  const note = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, organizationId: user.organizationId },
    include: {
      items: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { account: { select: { accountCode: true, accountName: true } } },
      },
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          issueDate: true,
          totalAmount: true,
          creditedAmount: true,
          customerName: true,
          customerTaxNumber: true,
          jobCardId: true,
        },
      },
      customer: { select: { id: true, name: true, phone: true, taxNumber: true } },
      branch: { select: { name: true } },
      refundAccount: { select: { accountCode: true, accountName: true } },
      createdBy: { select: { fullName: true } },
    },
  });
  if (!note) throw new NotFoundError('credit note');
  requirePermission(user, 'credit_note.view', { branchId: note.branchId });
  return note;
}

export type CreditNoteDetail = Awaited<ReturnType<typeof getCreditNote>>;

/** The credit notes against one invoice, newest first. */
export async function listInvoiceCreditNotes(user: AuthenticatedUser, invoiceId: string) {
  requirePermission(user, 'credit_note.view');
  return prisma.creditNote.findMany({
    where: { organizationId: user.organizationId, invoiceId },
    orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      creditNoteNumber: true,
      status: true,
      issueDate: true,
      reason: true,
      totalAmount: true,
      refundAmount: true,
      refundedOn: true,
    },
  });
}

/** One page of credit notes, newest first, for the finance list — with the count and total of every match. */
export async function listCreditNotes(
  user: AuthenticatedUser,
  filters: { q?: string; status?: 'ISSUED' | 'VOID' | 'REFUND_DUE' } = {},
  limit = 200,
  /** Rows to skip: the pages before the one shown. */
  offset = 0,
) {
  requirePermission(user, 'credit_note.view');
  const q = filters.q?.trim();
  const where: Prisma.CreditNoteWhereInput = {
    organizationId: user.organizationId,
    ...(filters.status === 'VOID'
      ? { status: 'VOID' }
      : filters.status === 'REFUND_DUE'
        ? { status: 'ISSUED', refundAmount: { gt: 0 }, refundedOn: null }
        : filters.status === 'ISSUED'
          ? { status: 'ISSUED' }
          : {}),
    ...(q
      ? {
          OR: [
            { creditNoteNumber: { contains: q, mode: 'insensitive' } },
            { reason: { contains: q, mode: 'insensitive' } },
            { invoice: { invoiceNumber: { contains: q, mode: 'insensitive' } } },
            { customer: { name: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const [notes, total, sum] = await Promise.all([
    prisma.creditNote.findMany({
      where,
      orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
      skip: offset,
      take: limit,
      select: {
        id: true,
        creditNoteNumber: true,
        status: true,
        issueDate: true,
        reason: true,
        subtotal: true,
        taxAmount: true,
        totalAmount: true,
        refundAmount: true,
        refundedOn: true,
        invoice: { select: { id: true, invoiceNumber: true, customerName: true } },
        customer: { select: { name: true } },
      },
    }),
    prisma.creditNote.count({ where }),
    prisma.creditNote.aggregate({ where, _sum: { totalAmount: true } }),
  ]);
  return {
    notes,
    /** Every credit note the search and view match, not only the page shown. */
    total,
    totalAmount: sum._sum.totalAmount?.toString() ?? '0',
  };
}
