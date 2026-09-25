import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { endOfLocalDay, localDateString } from '@/lib/format';
import { invoiceBalance, receiptBalances } from '@/lib/billing/invoice';
import { issueAccessToken } from '@/lib/customer-access/tokens';
import {
  invoiceMessage,
  quotationMessage,
  receiptMessage,
  whatsAppUrl,
} from '@/lib/sharing/whatsapp';

/*
 * Sharing a customer document from the staff app. Raw link tokens are never
 * stored (only their hash), so an earlier link can't be shown again; sharing
 * issues a fresh secure link for the same document instead. Unlike
 * "reissue", earlier links are NOT revoked — the customer may already have
 * one open. All links still expire, and every one is revoked when the
 * quotation is revised.
 *
 * Receipts are shared through the invoice's link: the customer invoice page
 * lists every receipt of that invoice.
 */

const INVOICE_LINK_DAYS = 90;
const DECIDED_QUOTATION_LINK_DAYS = 30;

export const shareTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quotation'), id: z.uuid() }),
  z.object({ kind: z.literal('invoice'), id: z.uuid() }),
  z.object({ kind: z.literal('receipt'), id: z.uuid() }),
]);
export type ShareTarget = z.infer<typeof shareTargetSchema>;

export interface SharedDocument {
  /** Path of the customer page, e.g. /customer/quote/<token>. */
  path: string;
  /** Customer-facing message without the link's origin filled in. */
  buildMessage: (link: string) => string;
  phone: string;
}

const vehicleLabel = (v: { make: string; model: string }) => `${v.make} ${v.model}`.trim();

/** Issues a new secure link for the document and returns what the WhatsApp message needs. */
export async function createShareLink(
  user: AuthenticatedUser,
  rawTarget: unknown,
): Promise<SharedDocument> {
  const target = parseInput(shareTargetSchema, rawTarget);
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: user.organizationId },
    select: { name: true },
  });
  return target.kind === 'quotation'
    ? shareQuotation(user, target.id, organization.name)
    : shareInvoice(user, target, organization.name);
}

async function shareQuotation(
  user: AuthenticatedUser,
  estimateId: string,
  workshopName: string,
): Promise<SharedDocument> {
  return prisma.$transaction(async (tx) => {
    const estimate = await tx.estimate.findFirst({
      where: { id: estimateId, organizationId: user.organizationId },
      include: {
        _count: { select: { nextVersions: true } },
        customer: { select: { name: true, phone: true } },
        vehicle: { select: { plateNumber: true, make: true, model: true } },
      },
    });
    if (!estimate) throw new NotFoundError('quotation');
    requirePermission(user, 'job_card.edit', { branchId: estimate.branchId });
    if (estimate.status === 'DRAFT')
      throw new DomainError('Send the quotation first — a draft can’t be shared.');
    if (estimate._count.nextVersions > 0)
      throw new DomainError('A newer version of this quotation exists. Share that one instead.');

    let expiresAt: Date;
    if (estimate.status === 'SENT') {
      if (
        !estimate.validUntil ||
        estimate.validUntil.toISOString().slice(0, 10) < localDateString()
      ) {
        throw new DomainError('This quotation has expired. Revise it to send a new one.');
      }
      expiresAt = endOfLocalDay(estimate.validUntil);
    } else {
      // A decided quotation stays viewable (read-only) for a while.
      expiresAt = new Date(Date.now() + DECIDED_QUOTATION_LINK_DAYS * 86_400_000);
    }

    const { rawToken, tokenId } = await issueAccessToken(tx, {
      organizationId: user.organizationId,
      resourceType: 'ESTIMATE',
      resourceId: estimate.id,
      createdByUserId: user.id,
      expiresAt,
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: estimate.branchId,
      actorUserId: user.id,
      action: 'customer_access.link_shared',
      entityType: 'Estimate',
      entityId: estimate.id,
      metadata: {
        customerAccessTokenId: tokenId,
        document: 'quotation',
        expiresAt: expiresAt.toISOString(),
      },
    });
    return {
      path: `/customer/quote/${rawToken}`,
      phone: estimate.customer.phone,
      buildMessage: (link) => quotationText(estimate, workshopName, link),
    };
  });
}

type QuotationForMessage = {
  estimateNumber: string;
  status: string;
  totalAmount: { toString(): string };
  customer: { name: string; phone: string };
  vehicle: { plateNumber: string; make: string; model: string } | null;
};

function quotationText(estimate: QuotationForMessage, workshopName: string, link: string) {
  const { vehicle } = estimate;
  return quotationMessage({
    customerName: estimate.customer.name,
    workshopName,
    vehicle: vehicle ? vehicleLabel(vehicle) : null,
    plateNumber: vehicle?.plateNumber ?? null,
    number: estimate.estimateNumber,
    total: estimate.totalAmount.toString(),
    awaitingDecision: estimate.status === 'SENT',
    link,
  });
}

/** The WhatsApp message for a quotation link that was just issued by sending or reissuing it. */
export async function quotationWhatsApp(user: AuthenticatedUser, estimateId: string, link: string) {
  const estimate = await prisma.estimate.findFirst({
    where: { id: estimateId, organizationId: user.organizationId },
    select: {
      estimateNumber: true,
      status: true,
      totalAmount: true,
      customer: { select: { name: true, phone: true } },
      vehicle: { select: { plateNumber: true, make: true, model: true } },
      organization: { select: { name: true } },
    },
  });
  if (!estimate) throw new NotFoundError('quotation');
  return whatsAppUrl(
    estimate.customer.phone,
    quotationText(estimate, estimate.organization.name, link),
  );
}

async function shareInvoice(
  user: AuthenticatedUser,
  target: ShareTarget,
  workshopName: string,
): Promise<SharedDocument> {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: {
        organizationId: user.organizationId,
        status: { notIn: ['VOID', 'CANCELLED'] },
        ...(target.kind === 'invoice'
          ? { id: target.id }
          : { payments: { some: { id: target.id } } }),
      },
      include: {
        payments: true,
        customer: { select: { name: true, phone: true } },
        vehicle: { select: { plateNumber: true, make: true, model: true } },
      },
    });
    if (!invoice) throw new NotFoundError(target.kind === 'invoice' ? 'invoice' : 'receipt');
    requirePermission(user, 'invoice.view', { branchId: invoice.branchId });

    const expiresAt = new Date(Date.now() + INVOICE_LINK_DAYS * 86_400_000);
    const { rawToken, tokenId } = await issueAccessToken(tx, {
      organizationId: user.organizationId,
      resourceType: 'INVOICE',
      resourceId: invoice.id,
      createdByUserId: user.id,
      expiresAt,
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: invoice.branchId,
      actorUserId: user.id,
      action: 'customer_access.link_shared',
      entityType: target.kind === 'invoice' ? 'Invoice' : 'Payment',
      entityId: target.id,
      metadata: {
        customerAccessTokenId: tokenId,
        document: target.kind,
        invoiceId: invoice.id,
        expiresAt: expiresAt.toISOString(),
      },
    });

    const { vehicle } = invoice;
    const common = {
      customerName: invoice.customer.name,
      workshopName,
      vehicle: vehicle ? vehicleLabel(vehicle) : null,
      plateNumber: vehicle?.plateNumber ?? null,
    };
    const path = `/customer/invoice/${rawToken}`;
    if (target.kind === 'invoice') {
      const balance = invoiceBalance(invoice);
      return {
        path,
        phone: invoice.customer.phone,
        buildMessage: (link) =>
          invoiceMessage({
            ...common,
            link,
            number: invoice.invoiceNumber,
            total: balance.total,
            paid: balance.paid,
            balance: balance.balance,
          }),
      };
    }
    const payment = invoice.payments.find((p) => p.id === target.id)!;
    const { remainingBalance } = receiptBalances(invoice, payment.id);
    return {
      path,
      phone: invoice.customer.phone,
      buildMessage: (link) =>
        receiptMessage({
          ...common,
          link,
          number: payment.paymentNumber ?? invoice.invoiceNumber,
          invoiceNumber: invoice.invoiceNumber,
          amount: payment.amount.toString(),
          balance: remainingBalance,
        }),
    };
  });
}

/** The link, message and WhatsApp URL for a shared document, given the app's public origin. */
export function shareResult(shared: SharedDocument, origin: string) {
  const link = `${origin}${shared.path}`;
  const message = shared.buildMessage(link);
  return { link, message, whatsappUrl: whatsAppUrl(shared.phone, message) };
}
