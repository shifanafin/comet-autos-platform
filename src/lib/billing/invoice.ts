import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { EstimateItemType, EstimateKind, InvoiceStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { allocateDocumentNumber } from '@/lib/numbering';
import { DomainError, NotFoundError } from '@/lib/errors';
import { claimRequestKey } from '@/lib/request-keys';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { calculateLine, calculateTotals, filsToString, formatMilli, milliToString, signedToMilli, toFils, type LineAmounts } from '@/lib/money';
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

export type BillingSource = { labourId: string; partUsageId?: undefined } | { partUsageId: string; labourId?: undefined };

export interface BillableLine {
  source: BillingSource;
  itemType: EstimateItemType;
  estimateKind: EstimateKind;
  estimateNumber: string;
  description: string;
  amounts: LineAmounts;
}

export interface BillingNote {
  kind: 'EXCLUDED' | 'PRICE_DIFFERS' | 'QUANTITY_ABOVE_APPROVED' | 'QUANTITY_BELOW_APPROVED';
  message: string;
}

async function loadBillingSources(client: Prisma.TransactionClient, organizationId: string, jobCardId: string) {
  const [lines, labours, usages] = await Promise.all([
    client.estimateItem.findMany({
      where: { organizationId, estimate: { jobCardId, organizationId, status: 'APPROVED' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { estimate: { select: { kind: true, estimateNumber: true } } },
    }),
    client.labour.findMany({ where: { organizationId, jobCardId }, orderBy: [{ performedAt: 'asc' }, { id: 'asc' }] }),
    client.partUsage.findMany({
      where: { organizationId, jobCardId },
      orderBy: [{ usedAt: 'asc' }, { id: 'asc' }],
      include: { part: { select: { name: true, sku: true } } },
    }),
  ]);
  // Parts are billed on their net quantity: fitted minus anything taken back into stock.
  const netUsages = (await withNetQuantities(client, organizationId, usages)).filter((u) => u.netMilli > 0);
  return { lines, labours, usages: netUsages };
}

/** What would be billed for this job, and every approved-vs-actual difference. Pure calculation — writes nothing. */
export async function buildBilling(client: Prisma.TransactionClient, organizationId: string, jobCardId: string) {
  const { lines, labours, usages } = await loadBillingSources(client, organizationId, jobCardId);
  const defaultVat = await resolveDefaultVatRate(organizationId, client);
  const billable: BillableLine[] = [];
  const notes: BillingNote[] = [];

  for (const line of lines) {
    const approvedMilli = signedToMilli(line.quantity);
    const approvedPrice = line.unitPrice.toString();
    const taxRate = line.taxRate?.toString() ?? defaultVat;
    let remaining = approvedMilli;

    const records =
      line.itemType === 'LABOUR'
        ? labours
            .filter((l) => l.estimateItemId === line.id)
            .map((l) => ({ source: { labourId: l.id } as BillingSource, qty: signedToMilli(l.hours), actualPrice: l.rate.toString(), label: l.description }))
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
        billable.push({
          source: record.source,
          itemType: line.itemType,
          estimateKind: line.estimate.kind,
          estimateNumber: line.estimate.estimateNumber,
          description: line.itemType === 'LABOUR' ? line.description : `${line.description} — ${record.label}`,
          amounts: calculateLine({ quantity: milliToString(billedMilli), unitPrice: approvedPrice, taxRate }),
        });
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
    notes.push({ kind: 'EXCLUDED', message: `Labour "${labour.description}" (${labour.hours} h) is not approved work — not billed.` });
  }
  for (const usage of usages.filter((u) => !u.estimateItemId)) {
    notes.push({ kind: 'EXCLUDED', message: `Part ${usage.part.name} × ${formatMilli(usage.netMilli)} is not approved work — not billed.` });
  }

  return { billable, notes, totals: calculateTotals(billable.map((line) => line.amounts)) };
}

/** Amount actually paid: completed payments not reversed (Payment model rule). */
export function paidFils(payments: { id: string; amount: { toString(): string }; status: string; reversalOfPaymentId: string | null }[]) {
  const reversed = new Set(payments.filter((p) => p.reversalOfPaymentId).map((p) => p.reversalOfPaymentId));
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

/** Paid, balance and state of an invoice — the one rule the staff screens, customer pages and documents share. */
export function invoiceBalance(invoice: { totalAmount: { toString(): string }; status: InvoiceStatus; payments: PaymentLike[] }) {
  const paid = paidFils(invoice.payments);
  const total = toFils(invoice.totalAmount.toString());
  return {
    total: filsToString(total),
    paid: filsToString(paid),
    balance: filsToString(Math.max(total - paid, 0)),
    state: paymentState(invoice.status),
  };
}

/**
 * The balance just before and just after one payment, for its receipt:
 * payments that count (completed, not reversed) received before it, in
 * order, are deducted first.
 */
export function receiptBalances(
  invoice: { totalAmount: { toString(): string }; payments: PaymentLike[] },
  paymentId: string,
) {
  const ordered = [...invoice.payments].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id));
  const index = ordered.findIndex((p) => p.id === paymentId);
  if (index < 0) throw new NotFoundError('payment');
  const total = toFils(invoice.totalAmount.toString());
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
      throw new DomainError('An invoice can only be created once the job has passed its quality check and is ready.');
    }
    const existing = await tx.invoice.findFirst({
      where: { organizationId: user.organizationId, jobCardId: jobCard.id, status: { notIn: ['VOID', 'CANCELLED'] } },
      select: { invoiceNumber: true },
    });
    if (existing) throw new DomainError(`This job is already invoiced (${existing.invoiceNumber}).`);

    const billing = await buildBilling(tx, user.organizationId, jobCard.id);
    if (billing.billable.length === 0) throw new DomainError('There is no approved, completed work to bill.');

    const organization = await tx.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
    const customer = jobCard.customer;
    const today = parseCalendarDate(localDateString())!;
    const invoiceNumber = await allocateDocumentNumber(tx, user.organizationId, jobCard.branchId, 'TAX_INVOICE');
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
        subtotal: billing.totals.subtotal,
        taxAmount: billing.totals.taxAmount,
        totalAmount: billing.totals.totalAmount,
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
          quantity: line.amounts.quantity,
          unitPrice: line.amounts.unitPrice,
          lineTotal: line.amounts.lineTotal,
          taxRate: line.amounts.taxRate,
          taxAmount: line.amounts.taxAmount,
          labourId: line.source.labourId ?? null,
          partUsageId: line.source.partUsageId ?? null,
        },
      });
    }

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
      labour: { select: { hours: true, rate: true, estimateItem: { select: { estimate: { select: { kind: true, estimateNumber: true } } } } } },
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
    where: { organizationId: user.organizationId, jobCardId, status: { notIn: ['VOID', 'CANCELLED'] } },
    include: invoiceDetail,
  });
  if (!invoice) return null;
  requirePermission(user, 'invoice.view', { branchId: invoice.branchId });
  const balance = invoiceBalance(invoice);
  return { ...invoice, paidAmount: balance.paid, balanceDue: balance.balance, paymentState: balance.state };
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
  return { ...invoice, paidAmount: balance.paid, balanceDue: balance.balance, paymentState: balance.state };
}

export type JobInvoice = NonNullable<Awaited<ReturnType<typeof getJobInvoice>>>;
export type InvoiceDetail = Awaited<ReturnType<typeof getInvoiceDetail>>;

const paymentSchema = z.object({
  amount: z
    .string({ error: 'Enter the amount received.' })
    .trim()
    .refine((value) => /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0, 'Enter an amount like 250 or 250.50.'),
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'], { error: 'Choose how the customer paid.' }),
  receivedAt: z.string({ error: 'Enter when the payment was received.' }).min(1, 'Enter when the payment was received.'),
  referenceNumber: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
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
  if (receivedAt.getTime() > Date.now() + 5 * 60 * 1000) throw new DomainError("A payment can't be dated in the future.", 'receivedAt');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'payment.record');
    // Which job to lock, read before any lock is taken: job cards are
    // always locked before invoices, everywhere, so two paths can never take
    // the pair in opposite orders.
    const target = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId: user.organizationId, status: { notIn: ['VOID', 'CANCELLED'] } },
      select: { id: true, jobCardId: true },
    });
    if (!target) throw new NotFoundError('invoice');
    const jobCard = target.jobCardId ? await lockJob(tx, user.organizationId, target.jobCardId) : null;

    await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${target.id}::uuid FOR UPDATE`;
    const invoice = await tx.invoice.findFirstOrThrow({ where: { id: target.id, organizationId: user.organizationId } });
    requirePermission(user, 'payment.create', { branchId: invoice.branchId });
    if (invoice.invoiceType !== 'TAX_INVOICE') throw new DomainError('Payments can only be recorded against a tax invoice.');
    if (invoice.status === 'PAID') throw new DomainError('This invoice is already fully paid.');
    if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIALLY_PAID') {
      throw new DomainError('This invoice cannot take payments.');
    }
    // The form's time is minute-precision, so compare against the minute of issue.
    if (receivedAt.getTime() < Math.floor(invoice.issuedAt!.getTime() / 60000) * 60000) throw new DomainError("A payment can't be dated before the invoice was issued.", 'receivedAt');

    const payments = await tx.payment.findMany({
      where: { organizationId: user.organizationId, invoiceId: invoice.id },
      select: { id: true, amount: true, status: true, reversalOfPaymentId: true },
    });
    const total = toFils(invoice.totalAmount.toString());
    const balance = total - paidFils(payments);
    const amount = toFils(input.amount);
    if (amount > balance) {
      throw new DomainError(`That is more than the balance due (${filsToString(balance)}).`, 'amount');
    }

    const paymentNumber = await allocateDocumentNumber(tx, user.organizationId, invoice.branchId, 'PAYMENT_RECEIPT');
    const payment = await tx.payment.create({
      data: {
        organizationId: user.organizationId,
        invoiceId: invoice.id,
        paymentNumber,
        amount: filsToString(amount),
        method: input.method,
        status: 'COMPLETED',
        referenceNumber: emptyToNull(input.referenceNumber),
        notes: emptyToNull(input.notes),
        receivedAt,
        receivedByUserId: user.id,
      },
    });
    const newBalance = balance - amount;
    const newStatus: InvoiceStatus = newBalance === 0 ? 'PAID' : 'PARTIALLY_PAID';
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: newStatus } });

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
  });
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
    where: { organizationId: user.organizationId, jobCardId: jobCard.id, status: { notIn: ['VOID', 'CANCELLED'] } },
    select: { id: true },
  });
  if (!invoice) throw new DomainError('Create the invoice before recording a payment.');
  return recordInvoicePayment(user, invoice.id, rawInput);
}

const deliverySchema = z.object({
  notes: z.string().trim().max(2000).optional(),
  /** Optional handover signature (PNG data URL from the signature pad) and who signed. */
  signature: z.string().max(2_000_000).optional(),
  signerName: z.string().trim().max(120).optional(),
});

/**
 * PAID → DELIVERED: hands the vehicle back. Only a fully paid job can be
 * delivered — V1 has no delivery-on-credit rule. Records who and when.
 */
export async function deliverVehicle(user: AuthenticatedUser, jobCardId: string, rawInput: unknown) {
  const input = parseInput(deliverySchema, rawInput);
  const signature = await prepareSignature(input.signature, user.organizationId, jobCardId);
  return prisma.$transaction(async (tx) => {
    const jobCard = await lockJob(tx, user.organizationId, jobCardId);
    requirePermission(user, 'job_card.close', { branchId: jobCard.branchId });
    const invoice = await tx.invoice.findFirst({
      where: { organizationId: user.organizationId, jobCardId: jobCard.id, status: { notIn: ['VOID', 'CANCELLED'] } },
      include: { payments: { select: { id: true, amount: true, status: true, reversalOfPaymentId: true } } },
    });
    if (!invoice) throw new DomainError('The job has not been invoiced yet.');
    const balance = toFils(invoice.totalAmount.toString()) - paidFils(invoice.payments);
    if (balance > 0 || invoice.status !== 'PAID') {
      throw new DomainError(`The vehicle can't be delivered with a balance due (${filsToString(Math.max(balance, 0))}).`);
    }
    if (normalizeStatus(jobCard.status) !== 'PAID') {
      throw new DomainError('Only a fully paid job can be delivered.');
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
      metadata: { invoiceId: invoice.id },
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
      afterData: { deliveredAt: deliveredAt.toISOString(), deliveredByUserId: user.id, notes: emptyToNull(input.notes), handoverSigned: Boolean(signature) },
    });
  });
}

/** Billing preview for the READY screen (read-only). */
export async function getBillingPreview(user: AuthenticatedUser, jobCardId: string) {
  const jobCard = await prisma.jobCard.findFirst({ where: { id: jobCardId, organizationId: user.organizationId }, select: { branchId: true } });
  if (!jobCard) throw new NotFoundError('job card');
  requirePermission(user, 'invoice.view', { branchId: jobCard.branchId });
  return buildBilling(prisma, user.organizationId, jobCardId);
}
