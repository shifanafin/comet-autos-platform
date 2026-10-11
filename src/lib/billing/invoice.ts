import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type {
  EstimateItemType,
  EstimateKind,
  InvoiceStatus,
  JobCardStatus,
  VatTreatment,
} from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { allocateDocumentNumber } from '@/lib/numbering';
import { DomainError, NotFoundError } from '@/lib/errors';
import { claimRequestKey } from '@/lib/request-keys';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import {
  calculateLine,
  filsToString,
  formatMilli,
  milliToString,
  prorateFils,
  signedToMilli,
  toFils,
  type Discount,
  type LineAmounts,
} from '@/lib/money';
import { lineData, totalsData, withBillDiscount } from '@/lib/billing/document-lines';
import { checkMoneyAccount } from '@/lib/accounting/chart';
import { syncPosting } from '@/lib/accounting/journal';
import { withNetQuantities } from '@/lib/inventory/stock';
import { prepareSignature, recordSignature } from '@/lib/media/signatures';
import { resolveDefaultVatRate } from '@/lib/tax';
import { localDateString, parseCalendarDate, parseLocalDateTime } from '@/lib/format';
import { applyJobStatusChange, normalizeStatus } from '@/lib/workshop/job-status';

/*
 * Billing rules (V1)
 *
 * The invoice is built from the ACTUAL work records (Labour, PartUsage — the
 * schema's billable sources, linked from InvoiceItem.labourId/partUsageId),
 * but only where they fulfil an APPROVED estimate line
 * (Labour/PartUsage.estimateItemId → EstimateItem of an APPROVED estimate).
 *
 *  - Price and VAT rate come from the approved estimate line — the customer
 *    is billed what they approved, never a silently changed catalog price or
 *    a different labour rate.
 *  - Quantity is what was actually fitted / worked, capped at the approved
 *    quantity. Anything above the approved quantity is not billed.
 *  - Records not linked to an approved line (unapproved additional work) are
 *    never billed.
 * Every difference between the approved line and the actual record is
 * reported, so staff can see exactly what was not billed and why.
 */

export type BillingSource =
  { labourId: string; partUsageId?: undefined } | { partUsageId: string; labourId?: undefined };

export interface BillableLine {
  source: BillingSource;
  itemType: EstimateItemType;
  vatTreatment: VatTreatment;
  /** The quotation line's tax code, carried onto the invoice line. */
  taxCodeId: string | null;
  estimateKind: EstimateKind;
  estimateNumber: string;
  description: string;
  amounts: LineAmounts;
}

export interface BillingNote {
  kind: 'EXCLUDED' | 'PRICE_DIFFERS' | 'QUANTITY_ABOVE_APPROVED' | 'QUANTITY_BELOW_APPROVED';
  message: string;
}

async function loadBillingSources(
  client: Prisma.TransactionClient,
  organizationId: string,
  jobCardId: string,
) {
  const [lines, labours, usages] = await Promise.all([
    client.estimateItem.findMany({
      // A replaced version's approval stays on record but is never billed.
      where: {
        organizationId,
        estimate: { jobCardId, organizationId, status: 'APPROVED', isCurrent: true },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        estimate: {
          select: {
            id: true,
            kind: true,
            estimateNumber: true,
            discountType: true,
            discountValue: true,
            discountAmount: true,
            subtotal: true,
          },
        },
      },
    }),
    client.labour.findMany({
      where: { organizationId, jobCardId },
      orderBy: [{ performedAt: 'asc' }, { id: 'asc' }],
    }),
    client.partUsage.findMany({
      where: { organizationId, jobCardId },
      orderBy: [{ usedAt: 'asc' }, { id: 'asc' }],
      include: { part: { select: { name: true, sku: true } } },
    }),
  ]);
  // Parts are billed on their net quantity: fitted minus anything taken back into stock.
  const netUsages = (await withNetQuantities(client, organizationId, usages)).filter(
    (u) => u.netMilli > 0,
  );
  return { lines, labours, usages: netUsages };
}

/** What would be billed for this job, and every approved-vs-actual difference. Pure calculation — writes nothing. */
export async function buildBilling(
  client: Prisma.TransactionClient,
  organizationId: string,
  jobCardId: string,
) {
  const { lines, labours, usages } = await loadBillingSources(client, organizationId, jobCardId);
  const defaultVat = await resolveDefaultVatRate(organizationId, client);
  const billable: BillableLine[] = [];
  const notes: BillingNote[] = [];
  /** Per approved quotation: its lines' total as approved, and as billed. */
  const quoted = new Map<
    string,
    { estimate: (typeof lines)[number]['estimate']; billedFils: number }
  >();

  for (const line of lines) {
    const approvedMilli = signedToMilli(line.quantity);
    const approvedPrice = line.unitPrice.toString();
    const taxRate = line.taxRate?.toString() ?? defaultVat;
    let remaining = approvedMilli;
    /**
     * The discount the customer approved on this line, for the part of it
     * billed: a percentage as it stands, a fixed amount scaled to the
     * quantity billed.
     */
    const lineDiscount = (billedMilli: number): Discount | null => {
      if (!line.discountType || !line.discountValue) return null;
      if (line.discountType === 'PERCENT') {
        return { type: 'PERCENT', value: line.discountValue.toString() };
      }
      const fils = prorateFils(toFils(line.discountAmount.toString()), billedMilli, approvedMilli);
      return fils ? { type: 'AMOUNT', value: filsToString(fils) } : null;
    };

    const records =
      line.itemType === 'LABOUR'
        ? labours
            .filter((l) => l.estimateItemId === line.id)
            .map((l) => ({
              source: { labourId: l.id } as BillingSource,
              qty: signedToMilli(l.hours),
              actualPrice: l.rate.toString(),
              label: l.description,
            }))
        : usages
            .filter((u) => u.estimateItemId === line.id)
            .map((u) => ({
              source: { partUsageId: u.id } as BillingSource,
              qty: u.netMilli,
              actualPrice: u.unitPrice.toString(),
              label: `${u.part.name} (${u.part.sku})`,
            }));

    let done = 0;
    for (const record of records) {
      const billedMilli = Math.min(record.qty, remaining);
      remaining -= billedMilli;
      done += record.qty;
      if (toFils(record.actualPrice) !== toFils(approvedPrice)) {
        notes.push({
          kind: 'PRICE_DIFFERS',
          message: `${record.label}: ${line.itemType === 'LABOUR' ? 'rate recorded' : 'catalog price when fitted'} ${filsToString(toFils(record.actualPrice))}, approved ${filsToString(toFils(approvedPrice))} — billed at the approved price.`,
        });
      }
      if (billedMilli > 0) {
        const amounts = calculateLine({
          quantity: milliToString(billedMilli),
          unitPrice: approvedPrice,
          taxRate,
          discount: lineDiscount(billedMilli),
        });
        billable.push({
          source: record.source,
          itemType: line.itemType,
          vatTreatment: line.vatTreatment,
          taxCodeId: line.taxCodeId,
          estimateKind: line.estimate.kind,
          estimateNumber: line.estimate.estimateNumber,
          description:
            line.itemType === 'LABOUR' ? line.description : `${line.description} — ${record.label}`,
          amounts,
        });
        const entry = quoted.get(line.estimate.id) ?? { estimate: line.estimate, billedFils: 0 };
        entry.billedFils += amounts.lineTotalFils;
        quoted.set(line.estimate.id, entry);
      }
    }
    if (done > approvedMilli) {
      notes.push({
        kind: 'QUANTITY_ABOVE_APPROVED',
        message: `${line.description}: ${formatMilli(done)} recorded, ${formatMilli(approvedMilli)} approved — the extra is not billed.`,
      });
    } else if (done < approvedMilli) {
      notes.push({
        kind: 'QUANTITY_BELOW_APPROVED',
        message: `${line.description}: ${formatMilli(done)} of ${formatMilli(approvedMilli)} approved was recorded — only what was done is billed.`,
      });
    }
  }

  for (const labour of labours.filter((l) => !l.estimateItemId)) {
    notes.push({
      kind: 'EXCLUDED',
      message: `Labour "${labour.description}" (${labour.hours} h) is not approved work — not billed.`,
    });
  }
  for (const usage of usages.filter((u) => !u.estimateItemId)) {
    notes.push({
      kind: 'EXCLUDED',
      message: `Part ${usage.part.name} × ${formatMilli(usage.netMilli)} is not approved work — not billed.`,
    });
  }

  const { lines: priced, totals } = withBillDiscount(
    billable,
    quotationDiscount([...quoted.values()]),
  );
  return { billable: priced, notes, totals };
}

/**
 * The discount the customer approved on the quotations as a whole, for the
 * work billed. The same percentage on every quotation carries over as that
 * percentage; otherwise each quotation's discount is scaled to how much of
 * it is billed, and the amounts are added up.
 */
function quotationDiscount(
  quotations: {
    estimate: {
      discountType: Discount['type'] | null;
      discountValue: { toString(): string } | null;
      discountAmount: { toString(): string };
      subtotal: { toString(): string };
    };
    billedFils: number;
  }[],
): Discount | null {
  const discounted = quotations.filter(({ estimate }) => estimate.discountType);
  if (discounted.length === 0) return null;
  const [first] = discounted;
  const samePercent =
    discounted.length === quotations.length &&
    discounted.every(
      ({ estimate }) =>
        estimate.discountType === 'PERCENT' &&
        estimate.discountValue?.toString() === first.estimate.discountValue?.toString(),
    );
  if (samePercent) return { type: 'PERCENT', value: first.estimate.discountValue!.toString() };

  const fils = discounted.reduce((sum, { estimate, billedFils }) => {
    const discountFils = toFils(estimate.discountAmount.toString());
    // The quotation's lines total: its taxable subtotal plus its discount.
    const linesFils = toFils(estimate.subtotal.toString()) + discountFils;
    return sum + prorateFils(discountFils, billedFils, linesFils);
  }, 0);
  return fils ? { type: 'AMOUNT', value: filsToString(fils) } : null;
}

/** Amount actually paid: completed payments not reversed (Payment model rule). */
export function paidFils(
  payments: {
    id: string;
    amount: { toString(): string };
    status: string;
    reversalOfPaymentId: string | null;
  }[],
) {
  const reversed = new Set(
    payments.filter((p) => p.reversalOfPaymentId).map((p) => p.reversalOfPaymentId),
  );
  return payments
    .filter((p) => p.status === 'COMPLETED' && !reversed.has(p.id))
    .reduce((sum, p) => sum + toFils(p.amount.toString()), 0);
}

export type PaymentState = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

export function paymentState(status: InvoiceStatus): PaymentState {
  return status === 'PAID' ? 'PAID' : status === 'PARTIALLY_PAID' ? 'PARTIALLY_PAID' : 'UNPAID';
}

type PaymentLike = {
  id: string;
  amount: { toString(): string };
  status: string;
  reversalOfPaymentId: string | null;
  receivedAt: Date;
};

/**
 * What settles an invoice besides its payments. Every reader of a balance
 * must load both — they are required, so the compiler finds any that don't.
 */
export interface InvoiceSettlement {
  totalAmount: { toString(): string };
  /** Taken back by tax credit notes. */
  creditedAmount: { toString(): string };
  /** Settled from customer advances (lib/billing/advances.ts). */
  advanceAppliedAmount: { toString(): string };
  /** A discount given after the invoice, off its total (VAT unchanged). */
  settlementDiscount: { toString(): string };
}

/**
 * Paid, credited, advance applied, balance and state of an invoice — the one
 * rule the staff screens, customer pages and documents share:
 *
 *   due = total − credited (tax credit notes) − discount given after the
 *         invoice − paid − advance applied
 *
 * never below zero; anything paid beyond it is returned to the customer's
 * advance, or refunded, under the credit note that caused it. An advance
 * applied settles the invoice without changing its revenue or VAT.
 */
export function invoiceBalance(
  invoice: InvoiceSettlement & { status: InvoiceStatus; payments: PaymentLike[] },
) {
  const paid = paidFils(invoice.payments);
  const total = toFils(invoice.totalAmount.toString());
  const credited = toFils(invoice.creditedAmount.toString());
  const advanceApplied = toFils(invoice.advanceAppliedAmount.toString());
  const discount = toFils(invoice.settlementDiscount.toString());
  return {
    total: filsToString(total),
    credited: filsToString(credited),
    discount: filsToString(discount),
    paid: filsToString(paid),
    advanceApplied: filsToString(advanceApplied),
    balance: filsToString(Math.max(total - credited - discount - advanceApplied - paid, 0)),
    state: paymentState(invoice.status),
  };
}

/**
 * An issued invoice's status from what has been paid, credited and applied
 * from advances: settled (PAID) once nothing is due, PARTIALLY_PAID once
 * anything is paid or applied.
 */
export function settlementStatus(invoice: InvoiceSettlement, paid: number): InvoiceStatus {
  if (dueFils(invoice, paid) === 0) return 'PAID';
  return paid > 0 || toFils(invoice.advanceAppliedAmount.toString()) > 0
    ? 'PARTIALLY_PAID'
    : 'ISSUED';
}

/**
 * What is still due on an invoice, in fils: total − credited − discount −
 * advance applied − paid, never below zero.
 */
export function dueFils(invoice: InvoiceSettlement, paid: number) {
  return Math.max(
    toFils(invoice.totalAmount.toString()) -
      toFils(invoice.creditedAmount.toString()) -
      toFils(invoice.settlementDiscount.toString()) -
      toFils(invoice.advanceAppliedAmount.toString()) -
      paid,
    0,
  );
}

/**
 * The balance just before and just after one payment, for its receipt:
 * payments that count (completed, not reversed) received before it, in
 * order, are deducted first.
 */
export function receiptBalances(
  invoice: InvoiceSettlement & { payments: PaymentLike[] },
  paymentId: string,
) {
  const ordered = [...invoice.payments].sort(
    (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id),
  );
  const index = ordered.findIndex((p) => p.id === paymentId);
  if (index < 0) throw new NotFoundError('payment');
  // Credit notes, a discount and advances applied come off the invoice before any payment is counted.
  const total =
    toFils(invoice.totalAmount.toString()) -
    toFils(invoice.creditedAmount.toString()) -
    toFils(invoice.settlementDiscount.toString()) -
    toFils(invoice.advanceAppliedAmount.toString());
  const paidBefore = paidFils(ordered.slice(0, index));
  const paidThrough = paidFils(ordered.slice(0, index + 1));
  return {
    previousBalance: filsToString(Math.max(total - paidBefore, 0)),
    remainingBalance: filsToString(Math.max(total - paidThrough, 0)),
    paidToDate: filsToString(paidThrough),
  };
}

async function lockJob(tx: Prisma.TransactionClient, organizationId: string, jobCardId: string) {
  await tx.$executeRaw`SELECT id FROM job_cards WHERE id = ${jobCardId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const jobCard = await tx.jobCard.findFirst({
    where: { id: jobCardId, organizationId },
    // The job's own customer — who brought the vehicle in — not whoever owns it today.
    include: { customer: true, vehicle: true },
  });
  if (!jobCard) throw new NotFoundError('job card');
  return jobCard;
}

/**
 * READY → INVOICED: issues the tax invoice for the completed job. Lines and
 * totals are computed here from the approved work — nothing from the browser.
 * Seller and customer details are snapshotted onto the invoice.
 */
export async function createInvoice(user: AuthenticatedUser, jobCardId: string) {
  return prisma.$transaction(async (tx) => {
    const jobCard = await lockJob(tx, user.organizationId, jobCardId);
    requirePermission(user, 'invoice.create', { branchId: jobCard.branchId });
    if (normalizeStatus(jobCard.status) !== 'READY') {
      throw new DomainError(
        'An invoice can only be created once the job has passed its quality check and is ready.',
      );
    }
    const existing = await tx.invoice.findFirst({
      where: {
        organizationId: user.organizationId,
        jobCardId: jobCard.id,
        status: { notIn: ['VOID', 'CANCELLED'] },
      },
      select: { invoiceNumber: true },
    });
    if (existing)
      throw new DomainError(`This job is already invoiced (${existing.invoiceNumber}).`);

    const billing = await buildBilling(tx, user.organizationId, jobCard.id);
    if (billing.billable.length === 0)
      throw new DomainError('There is no approved, completed work to bill.');

    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
    });
    const customer = jobCard.customer;
    const today = parseCalendarDate(localDateString())!;
    const invoiceNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      jobCard.branchId,
      'TAX_INVOICE',
    );
    const now = new Date();

    const invoice = await tx.invoice.create({
      data: {
        organizationId: user.organizationId,
        branchId: jobCard.branchId,
        jobCardId: jobCard.id,
        customerId: customer.id,
        vehicleId: jobCard.vehicleId,
        invoiceType: 'TAX_INVOICE',
        invoiceNumber,
        status: 'ISSUED',
        issueDate: today,
        supplyDate: today,
        dueDate: today,
        ...totalsData(billing.totals),
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
    for (const line of billing.billable) {
      await tx.invoiceItem.create({
        data: {
          organizationId: user.organizationId,
          invoiceId: invoice.id,
          itemType: line.source.labourId ? 'LABOUR' : 'PART',
          description: line.description,
          vatTreatment: line.vatTreatment,
          taxCodeId: line.taxCodeId,
          ...lineData(line.amounts),
          labourId: line.source.labourId ?? null,
          partUsageId: line.source.partUsageId ?? null,
        },
      });
    }
    await syncPosting(tx, user.organizationId, 'INVOICE', invoice.id, user.id);

    await applyJobStatusChange(tx, {
      organizationId: user.organizationId,
      jobCardId: jobCard.id,
      toStatus: 'INVOICED',
      actor: { userId: user.id },
      source: 'workflow',
      metadata: { invoiceId: invoice.id },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: jobCard.branchId,
      actorUserId: user.id,
      action: 'invoice.issued',
      entityType: 'Invoice',
      entityId: invoice.id,
      afterData: {
        invoiceNumber,
        jobCardId: jobCard.id,
        lines: billing.billable.length,
        discountAmount: billing.totals.discountAmount,
        subtotal: billing.totals.subtotal,
        taxAmount: billing.totals.taxAmount,
        totalAmount: billing.totals.totalAmount,
      },
      metadata: { billingNotes: billing.notes.map((n) => n.message) },
    });
    return invoice;
  });
}

/** One shape for an invoice with everything a billing screen shows. */
const invoiceDetail = {
  items: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      labour: {
        select: {
          hours: true,
          rate: true,
          estimateItem: { select: { estimate: { select: { kind: true, estimateNumber: true } } } },
        },
      },
      partUsage: {
        select: {
          quantity: true,
          unitPrice: true,
          estimateItem: { select: { estimate: { select: { kind: true, estimateNumber: true } } } },
        },
      },
    },
  },
  payments: {
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    include: { receivedBy: { select: { fullName: true } } },
  },
  issuedBy: { select: { fullName: true } },
} satisfies Prisma.InvoiceInclude;

/** The job's live invoice with lines, payments and computed balance — or null. */
export async function getJobInvoice(user: AuthenticatedUser, jobCardId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: {
      organizationId: user.organizationId,
      jobCardId,
      status: { notIn: ['VOID', 'CANCELLED'] },
    },
    include: invoiceDetail,
  });
  if (!invoice) return null;
  requirePermission(user, 'invoice.view', { branchId: invoice.branchId });
  const balance = invoiceBalance(invoice);
  return {
    ...invoice,
    paidAmount: balance.paid,
    advanceApplied: balance.advanceApplied,
    balanceDue: balance.balance,
    paymentState: balance.state,
  };
}

/**
 * One invoice by its own id, with lines, payments and balance — the invoice
 * screen's read, for an invoice with a job card behind it or without one.
 */
export async function getInvoiceDetail(user: AuthenticatedUser, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    // A void invoice still opens — as a record, marked void.
    where: { id: invoiceId, organizationId: user.organizationId, status: { not: 'CANCELLED' } },
    include: {
      ...invoiceDetail,
      customer: { select: { id: true, name: true, phone: true, email: true } },
      vehicle: { select: { id: true, plateNumber: true, make: true, model: true, year: true } },
      jobCard: { select: { id: true, jobNumber: true, status: true } },
    },
  });
  if (!invoice) throw new NotFoundError('invoice');
  requirePermission(user, 'invoice.view', { branchId: invoice.branchId });
  const balance = invoiceBalance(invoice);
  return {
    ...invoice,
    paidAmount: balance.paid,
    advanceApplied: balance.advanceApplied,
    balanceDue: balance.balance,
    paymentState: balance.state,
  };
}

export type JobInvoice = NonNullable<Awaited<ReturnType<typeof getJobInvoice>>>;
export type InvoiceDetail = Awaited<ReturnType<typeof getInvoiceDetail>>;

const paymentSchema = z.object({
  amount: z
    .string({ error: 'Enter the amount received.' })
    .trim()
    .refine(
      (value) => /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0,
      'Enter an amount like 250 or 250.50.',
    ),
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'], {
    error: 'Choose how the customer paid.',
  }),
  receivedAt: z
    .string({ error: 'Enter when the payment was received.' })
    .min(1, 'Enter when the payment was received.'),
  referenceNumber: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
  /** The cash, bank or card account it went into; blank for the method's default. */
  accountId: z.union([z.literal(''), z.uuid()]).optional(),
});

/**
 * Records money received against an invoice — the one place a payment is
 * ever created. Never more than the outstanding balance (overpayments are
 * not part of the financial design). Moves the invoice to PARTIALLY_PAID /
 * PAID and, when the invoice belongs to a job card and is fully settled,
 * that job card from INVOICED to PAID.
 *
 * An invoice raised without a job card settles exactly the same way; there
 * is simply no job to move.
 */
export async function recordInvoicePayment(
  user: AuthenticatedUser,
  invoiceId: string,
  rawInput: unknown,
) {
  const input = parseInput(paymentSchema, rawInput);
  const receivedAt = parseLocalDateTime(input.receivedAt);
  if (!receivedAt) throw new DomainError('Enter a valid date and time.', 'receivedAt');
  if (receivedAt.getTime() > Date.now() + 5 * 60 * 1000)
    throw new DomainError("A payment can't be dated in the future.", 'receivedAt');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'payment.record');
    // Which job to lock, read before any lock is taken: job cards are
    // always locked before invoices, everywhere, so two paths can never take
    // the pair in opposite orders.
    const target = await tx.invoice.findFirst({
      where: {
        id: invoiceId,
        organizationId: user.organizationId,
        status: { notIn: ['VOID', 'CANCELLED'] },
      },
      select: { id: true, jobCardId: true },
    });
    if (!target) throw new NotFoundError('invoice');
    const jobCard = target.jobCardId
      ? await lockJob(tx, user.organizationId, target.jobCardId)
      : null;

    await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${target.id}::uuid FOR UPDATE`;
    return takePayment(tx, user, target.id, jobCard, input, receivedAt);
  });
}

export type PaymentInput = Pick<
  z.infer<typeof paymentSchema>,
  'amount' | 'method' | 'referenceNumber' | 'notes' | 'accountId'
>;

/**
 * The payment rules themselves, inside a transaction that already holds the
 * invoice (and its job card, locked first). Shared by a payment taken on its
 * own and a sale paid on the spot, so both follow exactly the same rules:
 * a tax invoice, no more than the balance, a receipt number, the invoice and
 * job card moved on, an audit entry.
 */
export async function takePayment(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  invoiceId: string,
  jobCard: { id: string; status: JobCardStatus } | null,
  input: PaymentInput,
  receivedAt: Date,
) {
  const invoice = await tx.invoice.findFirstOrThrow({
    where: { id: invoiceId, organizationId: user.organizationId },
  });
  requirePermission(user, 'payment.create', { branchId: invoice.branchId });
  const accountId = await checkMoneyAccount(tx, user.organizationId, input.accountId);
  if (invoice.invoiceType === 'PROFORMA')
    throw new DomainError('Payments can only be recorded against a tax invoice or an opening balance.');
  if (invoice.status === 'PAID') throw new DomainError('This invoice is already fully paid.');
  if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIALLY_PAID') {
    throw new DomainError('This invoice cannot take payments.');
  }
  // The form's time is minute-precision, so compare against the minute of issue.
  if (receivedAt.getTime() < Math.floor(invoice.issuedAt!.getTime() / 60000) * 60000)
    throw new DomainError("A payment can't be dated before the invoice was issued.", 'receivedAt');

  const payments = await tx.payment.findMany({
    where: { organizationId: user.organizationId, invoiceId: invoice.id },
    select: { id: true, amount: true, status: true, reversalOfPaymentId: true },
  });
  const balance = dueFils(invoice, paidFils(payments));
  const amount = toFils(input.amount);
  if (amount > balance) {
    throw new DomainError(
      `That is more than the balance due (${filsToString(balance)}).`,
      'amount',
    );
  }

  const paymentNumber = await allocateDocumentNumber(
    tx,
    user.organizationId,
    invoice.branchId,
    'PAYMENT_RECEIPT',
  );
  const payment = await tx.payment.create({
    data: {
      organizationId: user.organizationId,
      invoiceId: invoice.id,
      paymentNumber,
      amount: filsToString(amount),
      method: input.method,
      accountId,
      status: 'COMPLETED',
      referenceNumber: emptyToNull(input.referenceNumber),
      notes: emptyToNull(input.notes),
      receivedAt,
      receivedByUserId: user.id,
    },
  });
  const newBalance = balance - amount;
  const newStatus = settlementStatus(invoice, paidFils(payments) + amount);
  await tx.invoice.update({ where: { id: invoice.id }, data: { status: newStatus } });
  await syncPosting(tx, user.organizationId, 'PAYMENT', payment.id, user.id);

  if (newStatus === 'PAID' && jobCard && normalizeStatus(jobCard.status) === 'INVOICED') {
    await applyJobStatusChange(tx, {
      organizationId: user.organizationId,
      jobCardId: jobCard.id,
      toStatus: 'PAID',
      actor: { userId: user.id },
      source: 'workflow',
      metadata: { invoiceId: invoice.id, paymentId: payment.id },
    });
  }
  await writeAuditLog(tx, {
    organizationId: user.organizationId,
    branchId: invoice.branchId,
    actorUserId: user.id,
    action: 'payment.recorded',
    entityType: 'Payment',
    entityId: payment.id,
    afterData: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      paymentNumber,
      amount: filsToString(amount),
      method: input.method,
      balanceAfter: filsToString(newBalance),
      invoiceStatus: newStatus,
    },
    metadata: { jobCardId: invoice.jobCardId },
  });
  return payment;
}

/**
 * Records a payment against the job card's live invoice — the workflow
 * billing screen's entry point. Finds the invoice, then hands over to
 * recordInvoicePayment, so there is one set of payment rules, not two.
 */
export async function recordPayment(user: AuthenticatedUser, jobCardId: string, rawInput: unknown) {
  const jobCard = await prisma.jobCard.findFirst({
    where: { id: jobCardId, organizationId: user.organizationId },
    select: { id: true, branchId: true },
  });
  if (!jobCard) throw new NotFoundError('job card');
  requirePermission(user, 'payment.create', { branchId: jobCard.branchId });
  const invoice = await prisma.invoice.findFirst({
    where: {
      organizationId: user.organizationId,
      jobCardId: jobCard.id,
      status: { notIn: ['VOID', 'CANCELLED'] },
    },
    select: { id: true },
  });
  if (!invoice) throw new DomainError('Create the invoice before recording a payment.');
  return recordInvoicePayment(user, invoice.id, rawInput);
}

const deliverySchema = z.object({
  notes: z.string().trim().max(2000).optional(),
  /** "true" to hand over with a balance still owed — delivery on credit. */
  onCredit: z.string().optional(),
  /** Optional handover signature (PNG data URL from the signature pad) and who signed. */
  signature: z.string().max(2_000_000).optional(),
  signerName: z.string().trim().max(120).optional(),
});

/**
 * INVOICED or PAID → DELIVERED: hands the vehicle back. A job must be
 * invoiced first; it need not be paid — with a balance owed, the handover is
 * on credit, which the staff member confirms, and the balance stays on the
 * invoice to be paid later. Records who, when, and what was owed.
 */
export async function deliverVehicle(
  user: AuthenticatedUser,
  jobCardId: string,
  rawInput: unknown,
) {
  const input = parseInput(deliverySchema, rawInput);
  const signature = await prepareSignature(input.signature);
  return prisma.$transaction(async (tx) => {
    const jobCard = await lockJob(tx, user.organizationId, jobCardId);
    requirePermission(user, 'job_card.approve', { branchId: jobCard.branchId });
    const invoice = await tx.invoice.findFirst({
      where: {
        organizationId: user.organizationId,
        jobCardId: jobCard.id,
        status: { notIn: ['VOID', 'CANCELLED'] },
      },
      include: {
        payments: { select: { id: true, amount: true, status: true, reversalOfPaymentId: true } },
      },
    });
    if (!invoice) {
      throw new DomainError(
        'Create the invoice before handing the vehicle over — it can stay unpaid.',
      );
    }
    const status = normalizeStatus(jobCard.status);
    if (status === 'DELIVERED') throw new DomainError('The vehicle has already been delivered.');
    if (status !== 'INVOICED' && status !== 'PAID') {
      throw new DomainError('Only an invoiced job can be delivered.');
    }
    const balance = dueFils(invoice, paidFils(invoice.payments));
    if (balance > 0 && input.onCredit !== 'true') {
      throw new DomainError(
        `${filsToString(balance)} is still owed on ${invoice.invoiceNumber}. Tick "deliver on credit" to hand the vehicle over before it is paid.`,
        'onCredit',
      );
    }

    const deliveredAt = new Date();
    await tx.jobCard.update({
      where: { id: jobCard.id },
      data: { deliveredAt, deliveredByUserId: user.id, deliveryNotes: emptyToNull(input.notes) },
    });
    await applyJobStatusChange(tx, {
      organizationId: user.organizationId,
      jobCardId: jobCard.id,
      toStatus: 'DELIVERED',
      actor: { userId: user.id },
      source: 'workflow',
      metadata: { invoiceId: invoice.id, balanceDue: filsToString(balance), onCredit: balance > 0 },
    });
    if (signature) {
      await recordSignature(tx, {
        prepared: signature,
        organizationId: user.organizationId,
        branchId: jobCard.branchId,
        jobCardId: jobCard.id,
        context: 'DELIVERY_HANDOVER',
        signerType: 'CUSTOMER',
        signerName: input.signerName || jobCard.customer.name,
        customerId: jobCard.customer.id,
        capturedByUserId: user.id,
        fileOwnerUserId: user.id,
        auditActorUserId: user.id,
      });
    }
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: jobCard.branchId,
      actorUserId: user.id,
      action: 'job_card.delivered',
      entityType: 'JobCard',
      entityId: jobCard.id,
      afterData: {
        deliveredAt: deliveredAt.toISOString(),
        deliveredByUserId: user.id,
        notes: emptyToNull(input.notes),
        handoverSigned: Boolean(signature),
        balanceDue: filsToString(balance),
        onCredit: balance > 0,
      },
    });
  });
}

/** Billing preview for the READY screen (read-only). */
export async function getBillingPreview(user: AuthenticatedUser, jobCardId: string) {
  const jobCard = await prisma.jobCard.findFirst({
    where: { id: jobCardId, organizationId: user.organizationId },
    select: { branchId: true },
  });
  if (!jobCard) throw new NotFoundError('job card');
  requirePermission(user, 'invoice.view', { branchId: jobCard.branchId });
  return buildBilling(prisma, user.organizationId, jobCardId);
}
