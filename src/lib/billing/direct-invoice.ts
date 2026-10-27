import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { JobCardStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { allocateDocumentNumber } from '@/lib/numbering';
import { DomainError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import {
  assertIncomeAccounts,
  discountFields,
  lineData,
  lineSchema,
  priceDocument,
  roundingField,
  storedLineAmounts,
  storedTotals,
  totalsData,
  withRounding,
} from '@/lib/billing/document-lines';
import { resolveDefaultVatRate } from '@/lib/tax';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { emptyToNull } from '@/lib/normalize';
import { filsToString, toFils } from '@/lib/money';
import { dueFils, takePayment } from '@/lib/billing/invoice';
import { applyHeldAdvances, customerAdvanceHeld } from '@/lib/billing/advances';
import { syncPosting } from '@/lib/accounting/journal';
import { applyJobStatusChange, normalizeStatus } from '@/lib/workshop/job-status';
import { CLOSED_JOB_STATUSES } from '@/lib/workshop/stages';
import { resolveTaxCodes } from '@/lib/accounting/tax-codes';
import { assertNotFitted, partsFittedOnJob, resolvePartLines } from '@/lib/billing/part-lines';
import { syncInvoiceStock } from '@/lib/inventory/invoice-stock';

/*
 * Invoicing without the full repair workflow.
 *
 * lib/billing/invoice.ts bills a finished job: it derives its lines from the
 * approved, completed Labour and PartUsage records and refuses until the
 * quality check has passed. That is the right rule for a job that went
 * through the workshop stage by stage, and it is untouched.
 *
 * This is the other door: the owner typing what he did, or turning a
 * quotation he already priced into the invoice for it. Same VAT rules
 * (lib/tax + lib/money), same numbering (lib/numbering), same payment and
 * balance rules (lib/billing/invoice) — only the source of the lines differs.
 *
 * A quotation is billed exactly as quoted unless its lines are changed on
 * the form; then the lines sent are priced like any typed invoice, and the
 * invoice still records which quotation it came from.
 *
 * The customer's advances can be applied as it is issued (lib/billing/
 * advances.ts, the same rules as applying one later); a sale paid on the
 * spot then takes only what is still due.
 */

const directInvoiceSchema = z.object({
  customerId: z.uuid({ error: 'Choose the customer this invoice is for.' }),
  /** Optional: not every invoice is about a car the workshop has on file. */
  vehicleId: z.union([z.literal(''), z.uuid()]).optional(),
  /** Optional: bills an open job card, which then counts as invoiced. */
  jobCardId: z.union([z.literal(''), z.uuid()]).optional(),
  /**
   * Optional: bills a quotation. With no `items`, its lines are copied as
   * quoted; with `items` (changed on the form), those are billed.
   */
  estimateId: z.union([z.literal(''), z.uuid()]).optional(),
  items: z.array(lineSchema).max(100, 'An invoice can have at most 100 lines.').optional(),
  /** "1": apply the customer's advances as the invoice is issued. */
  applyAdvance: z.string().optional(),
  /** How much of them; blank applies as much as is held, up to the total. */
  advanceAmount: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || /^\d+(\.\d{1,2})?$/.test(value),
      'Enter an amount like 250 or 250.50.',
    ),
  /** A discount on the whole bill, after the lines' own. */
  ...discountFields,
  /** A round-off after VAT, outside VAT: "-0.50", "0.25" or blank. */
  roundingAdjustment: roundingField,
  /** YYYY-MM-DD; blank means due on the day it is issued. */
  dueDate: z.string().trim().optional(),
  customerReference: z
    .string()
    .trim()
    .max(60, "Keep the customer's order number under 60 characters.")
    .optional(),
  notes: z.string().trim().max(1000, 'Keep the notes under 1000 characters.').optional(),
  /**
   * A sale paid on the spot — a sales receipt: the invoice is issued and its
   * whole total recorded as received, in one step.
   */
  payNow: z.string().optional(),
  paymentMethod: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE']).optional(),
  paymentReference: z.string().trim().max(100).optional(),
  /** Where the money went: a cash, bank or card account; blank for the method's default. */
  paymentAccountId: z.union([z.literal(''), z.uuid()]).optional(),
  requestKey: z.string().optional(),
});

const ON = new Set(['1', 'on', 'true']);

/**
 * When an invoice is due: the date chosen, which may not be before it was
 * issued, or — left blank — the day it was issued (due on receipt).
 */
export function readDueDate(value: string | undefined, issueDate: Date): Date {
  if (!value) return issueDate;
  const dueDate = parseCalendarDate(value);
  if (!dueDate) throw new DomainError('Choose a valid due date.', 'dueDate');
  if (dueDate < issueDate) {
    throw new DomainError('The due date cannot be before the invoice date.', 'dueDate');
  }
  return dueDate;
}

export type DirectInvoiceInput = z.input<typeof directInvoiceSchema>;

/**
 * The quotation's own lines, already priced when it was saved. They are
 * copied across as they stand — an invoice must show the customer the
 * figures they approved, not a fresh calculation that could differ.
 */
async function linesFromEstimate(
  tx: Prisma.TransactionClient,
  organizationId: string,
  estimateId: string,
  customerId: string,
) {
  const estimate = await tx.estimate.findFirst({
    where: { id: estimateId, organizationId },
    include: {
      items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!estimate) throw new DomainError('That quotation was not found.', 'estimateId');
  if (!estimate.isCurrent) {
    throw new DomainError(
      'A newer version of this quotation exists. Invoice that one instead.',
      'estimateId',
    );
  }
  if (estimate.customerId !== customerId) {
    throw new DomainError('That quotation belongs to a different customer.', 'estimateId');
  }
  if (estimate.status === 'DRAFT') {
    throw new DomainError('Finish and send the quotation before invoicing it.', 'estimateId');
  }
  if (estimate.status === 'REJECTED') {
    throw new DomainError('That quotation was rejected by the customer.', 'estimateId');
  }
  if (estimate.items.length === 0) {
    throw new DomainError('That quotation has no lines to invoice.', 'estimateId');
  }
  return {
    estimate,
    // The stored figures — discounts included — so the invoice totals to
    // exactly what the customer was quoted.
    lines: estimate.items.map((item) => ({
      itemType: item.itemType,
      description: item.description,
      // Quotations don't choose accounts: the default for each line's type.
      accountId: null,
      vatTreatment: item.vatTreatment,
      taxCodeId: item.taxCodeId,
      // The part quoted, at its current cost (lib/billing/part-lines.ts).
      partId: item.partId,
      unitCost: null,
      amounts: storedLineAmounts(item),
    })),
    totals: storedTotals(estimate),
  };
}

/** What is held for the customer in advances, up to `cap` fils. */
async function heldUpTo(
  tx: Prisma.TransactionClient,
  organizationId: string,
  customerId: string,
  cap: number,
) {
  return Math.min(await customerAdvanceHeld(tx, organizationId, customerId), cap);
}

export interface DirectInvoiceResult {
  invoiceId: string;
  invoiceNumber: string;
  /** Set when the sale was paid on the spot. */
  paymentId: string | null;
}

/**
 * Issues a tax invoice for a customer, optionally for a vehicle, optionally
 * against a job card, with lines either typed or copied from a quotation.
 *
 * Everything an invoice made the long way gets, this one gets too: a
 * branch-scoped sequential number, the seller and customer details
 * snapshotted at issue, an audit entry, and protection against a
 * double-submitted form creating two invoices.
 */
export async function createDirectInvoice(
  user: AuthenticatedUser,
  rawInput: unknown,
): Promise<DirectInvoiceResult> {
  const input = parseInput(directInvoiceSchema, rawInput);
  if (!user.primaryBranchId) {
    throw new DomainError('Your account has no branch assigned. Contact an administrator.');
  }
  requirePermission(user, 'invoice.create', { branchId: user.primaryBranchId });
  if (!input.estimateId && (input.items ?? []).length === 0) {
    throw new DomainError('Add at least one line, or choose a quotation to invoice.', 'items');
  }
  const payNow = ON.has(input.payNow ?? '');
  if (payNow) {
    requirePermission(user, 'payment.create', { branchId: user.primaryBranchId });
    if (!input.paymentMethod) {
      throw new DomainError('Choose how the customer paid.', 'paymentMethod');
    }
  }
  const useAdvance = ON.has(input.applyAdvance ?? '');
  if (useAdvance) {
    requirePermission(user, 'customer_advance.edit', { branchId: user.primaryBranchId });
  }

  const defaultVatRate = await resolveDefaultVatRate(user.organizationId);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'invoice.create_direct');

    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, organizationId: user.organizationId, isActive: true },
      select: { id: true, name: true, address: true, taxNumber: true },
    });
    if (!customer) throw new DomainError('Choose the customer this invoice is for.', 'customerId');

    let vehicleId: string | null = null;
    if (input.vehicleId) {
      const vehicle = await tx.vehicle.findFirst({
        where: { id: input.vehicleId, organizationId: user.organizationId, isActive: true },
        select: { id: true, customerId: true },
      });
      if (!vehicle) throw new DomainError('That vehicle was not found.', 'vehicleId');
      if (vehicle.customerId !== customer.id) {
        throw new DomainError('That vehicle belongs to a different customer.', 'vehicleId');
      }
      vehicleId = vehicle.id;
    }

    // Job cards are locked before invoices, everywhere.
    let branchId = user.primaryBranchId!;
    let jobCard: { id: string; branchId: string; status: JobCardStatus; vehicleId: string } | null =
      null;
    if (input.jobCardId) {
      await tx.$executeRaw`SELECT id FROM job_cards WHERE id = ${input.jobCardId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
      const found = await tx.jobCard.findFirst({
        where: { id: input.jobCardId, organizationId: user.organizationId },
        select: { id: true, branchId: true, status: true, customerId: true, vehicleId: true },
      });
      if (!found) throw new DomainError('That job card was not found.', 'jobCardId');
      if (found.customerId !== customer.id) {
        throw new DomainError('That job card belongs to a different customer.', 'jobCardId');
      }
      requirePermission(user, 'invoice.create', { branchId: found.branchId });
      if (CLOSED_JOB_STATUSES.includes(found.status)) {
        throw new DomainError('That job card is already closed.', 'jobCardId');
      }
      const live = await tx.invoice.findFirst({
        where: {
          organizationId: user.organizationId,
          jobCardId: found.id,
          status: { notIn: ['VOID', 'CANCELLED'] },
        },
        select: { invoiceNumber: true },
      });
      if (live) {
        throw new DomainError(
          `That job card is already invoiced (${live.invoiceNumber}).`,
          'jobCardId',
        );
      }
      jobCard = {
        id: found.id,
        branchId: found.branchId,
        status: found.status,
        vehicleId: found.vehicleId,
      };
      branchId = found.branchId;
      vehicleId = vehicleId ?? found.vehicleId;
    }

    const source = input.estimateId
      ? await linesFromEstimate(tx, user.organizationId, input.estimateId, customer.id)
      : null;
    if (source?.estimate.jobCardId && !jobCard) {
      // Invoicing a quotation that belongs to a job card bills that work
      // order, rather than leaving it open and unbilled beside the invoice.
      await tx.$executeRaw`SELECT id FROM job_cards WHERE id = ${source.estimate.jobCardId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
      const found = await tx.jobCard.findFirst({
        where: { id: source.estimate.jobCardId, organizationId: user.organizationId },
        select: { id: true, branchId: true, status: true, vehicleId: true },
      });
      if (found && !CLOSED_JOB_STATUSES.includes(found.status)) {
        const live = await tx.invoice.findFirst({
          where: {
            organizationId: user.organizationId,
            jobCardId: found.id,
            status: { notIn: ['VOID', 'CANCELLED'] },
          },
          select: { invoiceNumber: true },
        });
        if (live)
          throw new DomainError(
            `That quotation's job card is already invoiced (${live.invoiceNumber}).`,
          );
        requirePermission(user, 'invoice.create', { branchId: found.branchId });
        jobCard = found;
        branchId = found.branchId;
        vehicleId = vehicleId ?? found.vehicleId;
      }
    }

    // A quotation changed on the form is billed as changed.
    const edited = Boolean(source) && (input.items ?? []).length > 0;
    const priced =
      source && !edited
        ? source
        : priceDocument(
            input.items ?? [],
            defaultVatRate,
            input,
            await resolveTaxCodes(tx, user.organizationId, input.items ?? []),
          );
    const { totals } = priced;
    // A Parts line picked from the list carries its part and cost; one typed
    // stays as typed (lib/billing/part-lines.ts).
    const fitted = await partsFittedOnJob(tx, user.organizationId, jobCard?.id ?? null);
    const lines = await resolvePartLines(tx, user.organizationId, priced.lines, {
      required: () => false,
    });
    assertNotFitted(lines, fitted);
    await assertIncomeAccounts(tx, user.organizationId, lines);
    const rounded = withRounding(totals, input.roundingAdjustment);

    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
    });
    const today = parseCalendarDate(localDateString())!;
    const dueDate = readDueDate(input.dueDate, today);
    const invoiceNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      branchId,
      'TAX_INVOICE',
    );
    const now = new Date();

    const invoice = await tx.invoice.create({
      data: {
        organizationId: user.organizationId,
        branchId,
        jobCardId: jobCard?.id ?? null,
        customerId: customer.id,
        vehicleId,
        invoiceType: 'TAX_INVOICE',
        invoiceNumber,
        status: 'ISSUED',
        issueDate: today,
        supplyDate: today,
        dueDate,
        ...totalsData(totals),
        ...rounded,
        customerReference: emptyToNull(input.customerReference),
        notes: emptyToNull(input.notes),
        sellerLegalName: organization.legalName ?? organization.name,
        sellerTaxNumber: organization.taxNumber,
        sellerAddress: organization.address,
        customerName: customer.name,
        customerTaxNumber: customer.taxNumber,
        customerAddress: customer.address,
        createdByUserId: user.id,
        issuedByUserId: user.id,
        issuedAt: now,
      },
    });
    for (const line of lines) {
      await tx.invoiceItem.create({
        data: {
          organizationId: user.organizationId,
          invoiceId: invoice.id,
          itemType: line.itemType,
          description: line.description,
          accountId: line.accountId ?? null,
          vatTreatment: line.vatTreatment,
          taxCodeId: line.taxCodeId ?? null,
          partId: line.partId ?? null,
          unitCost: line.unitCost ?? null,
          ...lineData(line.amounts),
        },
      });
    }
    // Its parts leave stock; their cost is booked on the invoice's entry.
    await syncInvoiceStock(tx, {
      organizationId: user.organizationId,
      invoiceId: invoice.id,
      userId: user.id,
    });
    await syncPosting(tx, user.organizationId, 'INVOICE', invoice.id, user.id);

    if (jobCard) {
      await applyJobStatusChange(tx, {
        organizationId: user.organizationId,
        jobCardId: jobCard.id,
        toStatus: 'INVOICED',
        actor: { userId: user.id },
        source: 'workflow',
        metadata: {
          invoiceId: invoice.id,
          from: normalizeStatus(jobCard.status),
          billedDirectly: true,
        },
      });
    }

    // The customer's advances first: they settle the invoice like a
    // payment, without changing its sales or VAT.
    // The invoice's total, its round-off included.
    const totalFils = toFils(rounded.totalAmount);
    let advanceApplied = 0;
    if (useAdvance && totalFils > 0) {
      const wanted = input.advanceAmount ? toFils(input.advanceAmount) : null;
      if (wanted !== null && wanted > totalFils) {
        throw new DomainError(
          `The advance applied can't be more than the invoice total (${rounded.totalAmount}).`,
          'advanceAmount',
        );
      }
      // Never more than is held: applyHeldAdvances refuses it, and applies oldest first.
      advanceApplied = await applyHeldAdvances(
        tx,
        user,
        { id: invoice.id, customerId: customer.id },
        wanted ?? (await heldUpTo(tx, user.organizationId, customer.id, totalFils)),
      );
    }

    // A sales receipt: what is still due received now, under the same
    // payment rules as any other payment. Nothing to take when nothing is due.
    const settled = await tx.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      select: {
        totalAmount: true,
        creditedAmount: true,
        advanceAppliedAmount: true,
        settlementDiscount: true,
        status: true,
      },
    });
    const stillDue = dueFils(settled, 0);
    const payment =
      payNow && stillDue > 0
        ? await takePayment(
            tx,
            user,
            invoice.id,
            jobCard ? { id: jobCard.id, status: 'INVOICED' } : null,
            {
              amount: filsToString(stillDue),
              method: input.paymentMethod!,
              referenceNumber: input.paymentReference,
              notes: undefined,
              accountId: input.paymentAccountId,
            },
            new Date(),
          )
        : null;

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId,
      actorUserId: user.id,
      action: 'invoice.issued',
      entityType: 'Invoice',
      entityId: invoice.id,
      afterData: {
        invoiceNumber,
        jobCardId: jobCard?.id ?? null,
        customerId: customer.id,
        vehicleId,
        lines: lines.length,
        discountAmount: totals.discountAmount,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: rounded.totalAmount,
        roundingAdjustment: rounded.roundingAdjustment,
      },
      metadata: {
        origin: source ? (edited ? 'quotation_edited' : 'quotation') : 'direct',
        estimateId: source?.estimate.id ?? null,
        estimateNumber: source?.estimate.estimateNumber ?? null,
        standalone: jobCard === null,
        paidOnTheSpot: payment !== null,
        ...(advanceApplied > 0 ? { advanceApplied: filsToString(advanceApplied) } : {}),
      },
    });

    await settleRequestKey(tx, user, rawInput, invoice.id);
    return { invoiceId: invoice.id, invoiceNumber, paymentId: payment?.id ?? null };
  });
}
