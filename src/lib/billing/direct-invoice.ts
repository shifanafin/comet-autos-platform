import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { EstimateItemType, JobCardStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { allocateDocumentNumber } from '@/lib/numbering';
import { DomainError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { calculateLine, calculateTotals, toFils, type LineAmounts } from '@/lib/money';
import { resolveDefaultVatRate } from '@/lib/tax';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { emptyToNull } from '@/lib/normalize';
import { applyJobStatusChange, normalizeStatus } from '@/lib/workshop/job-status';
import { CLOSED_JOB_STATUSES } from '@/lib/workshop/stages';

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
 */

export const lineSchema = z.object({
  /** Parts or labour — printed in the invoice's TYPE column. */
  itemType: z.enum(['PART', 'LABOUR'], { error: 'Choose parts or labour for every line.' }),
  description: z
    .string({ error: 'Every line needs a description.' })
    .trim()
    .min(1, 'Every line needs a description.')
    .max(300, 'Keep a line description under 300 characters.'),
  quantity: z.string().trim().min(1, 'Enter a quantity.'),
  unitPrice: z.string().trim().min(1, 'Enter a price.'),
  taxRate: z.string().trim().optional(),
});

const directInvoiceSchema = z.object({
  customerId: z.uuid({ error: 'Choose the customer this invoice is for.' }),
  /** Optional: not every invoice is about a car the workshop has on file. */
  vehicleId: z.union([z.literal(''), z.uuid()]).optional(),
  /** Optional: bills an open job card, which then counts as invoiced. */
  jobCardId: z.union([z.literal(''), z.uuid()]).optional(),
  /** Optional: copies the quotation's lines instead of typing them. */
  estimateId: z.union([z.literal(''), z.uuid()]).optional(),
  items: z.array(lineSchema).max(100, 'An invoice can have at most 100 lines.').optional(),
  notes: z.string().trim().max(1000, 'Keep the notes under 1000 characters.').optional(),
  requestKey: z.string().optional(),
});

export type DirectInvoiceInput = z.input<typeof directInvoiceSchema>;

/** Prices typed lines through the shared money rules — never a second formula. */
export function priceLines(items: z.infer<typeof lineSchema>[], defaultVatRate: string) {
  return items.map((item, index) => {
    try {
      return {
        itemType: item.itemType as EstimateItemType,
        description: item.description,
        amounts: calculateLine({
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          taxRate: item.taxRate || defaultVatRate,
        }),
      };
    } catch (error) {
      throw new DomainError(
        `Line ${index + 1}: ${error instanceof Error ? error.message : 'invalid amount.'}`,
        `items.${index}`,
      );
    }
  });
}

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
    include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  if (!estimate) throw new DomainError('That quotation was not found.', 'estimateId');
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
    lines: estimate.items.map((item) => {
      const lineTotal = item.lineTotal.toString();
      const taxAmount = (item.taxAmount ?? 0).toString();
      return {
        itemType: item.itemType,
        description: item.description,
        amounts: {
          quantity: item.quantity.toString(),
          unitPrice: item.unitPrice.toString(),
          lineTotal,
          taxRate: (item.taxRate ?? 0).toString(),
          taxAmount,
          // Derived from the stored figures, so the invoice totals to
          // exactly what the customer was quoted.
          lineTotalFils: toFils(lineTotal),
          taxFils: toFils(taxAmount),
        } satisfies LineAmounts,
      };
    }),
  };
}

export interface DirectInvoiceResult {
  invoiceId: string;
  invoiceNumber: string;
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
    let jobCard: { id: string; branchId: string; status: JobCardStatus; vehicleId: string } | null = null;
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
        throw new DomainError(`That job card is already invoiced (${live.invoiceNumber}).`, 'jobCardId');
      }
      jobCard = { id: found.id, branchId: found.branchId, status: found.status, vehicleId: found.vehicleId };
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
        if (live) throw new DomainError(`That quotation's job card is already invoiced (${live.invoiceNumber}).`);
        requirePermission(user, 'invoice.create', { branchId: found.branchId });
        jobCard = found;
        branchId = found.branchId;
        vehicleId = vehicleId ?? found.vehicleId;
      }
    }

    const lines = source ? source.lines : priceLines(input.items ?? [], defaultVatRate);
    const totals = calculateTotals(lines.map((line) => line.amounts));

    const organization = await tx.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
    const today = parseCalendarDate(localDateString())!;
    const invoiceNumber = await allocateDocumentNumber(tx, user.organizationId, branchId, 'TAX_INVOICE');
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
        dueDate: today,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.totalAmount,
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
          quantity: line.amounts.quantity,
          unitPrice: line.amounts.unitPrice,
          lineTotal: line.amounts.lineTotal,
          taxRate: line.amounts.taxRate,
          taxAmount: line.amounts.taxAmount,
        },
      });
    }

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
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.totalAmount,
      },
      metadata: {
        origin: source ? 'quotation' : 'direct',
        estimateId: source?.estimate.id ?? null,
        estimateNumber: source?.estimate.estimateNumber ?? null,
        standalone: jobCard === null,
      },
    });

    await settleRequestKey(tx, user, rawInput, invoice.id);
    return { invoiceId: invoice.id, invoiceNumber };
  });
}
