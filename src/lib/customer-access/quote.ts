import { prisma } from '@/lib/prisma';
import { DomainError } from '@/lib/errors';
import { localDateString } from '@/lib/format';
import { applyEstimateDecision, type EstimateDecision } from '@/lib/workshop/estimates';
import { resolveAccessToken } from '@/lib/customer-access/tokens';
import { prepareSignature, recordSignature } from '@/lib/media/signatures';
import {
  getCustomerAccess,
  type CustomerAccess,
  type OrganizationBranding,
} from '@/lib/customer-access/access';

/*
 * Everything the customer-facing quotation page needs, keyed only by the raw
 * token from the link. Nothing here accepts an estimate id, job id or
 * organization id from the browser, so a customer can never reach any
 * resource other than the one their token was issued for.
 */

export type { OrganizationBranding };

export type QuoteAccess = CustomerAccess;

/** Resolves the quotation link: open, expired or invalid. */
export function getQuoteAccess(rawToken: string): Promise<QuoteAccess> {
  return getCustomerAccess(rawToken, 'ESTIMATE');
}

/** The quotation as the customer sees it. Call only after getQuoteAccess returned "open". */
export async function loadCustomerQuote(rawToken: string) {
  const resolved = await resolveAccessToken(rawToken, 'ESTIMATE');
  if (resolved.state !== 'valid' || !resolved.token) return null;
  const { organizationId, resourceId } = resolved.token;

  const estimate = await prisma.estimate.findFirst({
    where: { id: resourceId, organizationId },
    select: {
      estimateNumber: true,
      version: true,
      kind: true,
      notes: true,
      status: true,
      subtotal: true,
      taxAmount: true,
      totalAmount: true,
      validUntil: true,
      sentAt: true,
      items: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          itemType: true,
          description: true,
          quantity: true,
          unitPrice: true,
          lineTotal: true,
          taxRate: true,
          taxAmount: true,
        },
      },
      approvals: {
        orderBy: { decidedAt: 'desc' },
        take: 1,
        select: { status: true, approvedAt: true, decidedAt: true, notes: true },
      },
      // The quotation's own parties, so a quotation raised without a work
      // order still names the customer and the car.
      customer: { select: { name: true } },
      vehicle: { select: { plateNumber: true, make: true, model: true, year: true } },
      jobCard: {
        select: {
          jobNumber: true,
          customerComplaint: true,
          odometerReading: true,
          inspections: {
            where: { status: 'COMPLETED' },
            orderBy: { inspectedAt: 'desc' },
            take: 1,
            select: {
              summary: true,
              items: {
                where: { result: { in: ['ATTENTION_NEEDED', 'FAILED'] } },
                orderBy: [{ result: 'desc' }, { createdAt: 'asc' }],
                select: { category: true, description: true, result: true, notes: true },
              },
            },
          },
          diagnoses: {
            orderBy: { diagnosedAt: 'desc' },
            take: 1,
            select: { findings: true, recommendedAction: true },
          },
        },
      },
    },
  });
  if (!estimate) return null;
  const expired =
    estimate.status === 'SENT' &&
    estimate.validUntil !== null &&
    estimate.validUntil.toISOString().slice(0, 10) < localDateString();
  return { ...estimate, expired };
}

/** Records the customer's own decision made through the secure link. */
export async function decideQuoteAsCustomer(
  rawToken: string,
  decision: EstimateDecision,
  notes: string | null,
  /** Optional signature confirming an approval (PNG data URL); never required. */
  signatureDataUrl: string | null = null,
) {
  const access = await getQuoteAccess(rawToken);
  if (access.state !== 'open') {
    throw new DomainError(
      access.state === 'expired'
        ? 'This quotation link has expired. Please contact the workshop for a new one.'
        : 'This link is no longer valid. Please contact the workshop.',
    );
  }
  const resolved = await resolveAccessToken(rawToken, 'ESTIMATE');
  if (resolved.state !== 'valid' || !resolved.token) {
    throw new DomainError('This link is no longer valid.');
  }
  const token = resolved.token;
  const trimmedNotes = notes?.trim().slice(0, 2000) || null;
  const estimateJob = await prisma.estimate.findFirst({
    where: { id: token.resourceId, organizationId: token.organizationId },
    select: { jobCardId: true, jobCard: { select: { branchId: true } } },
  });
  // The signature file lives with the job card. A quotation raised
  // without one still takes the customer's decision; only the optional
  // signature image has nowhere to be filed.
  const signature =
    decision === 'APPROVED' && estimateJob?.jobCardId
      ? await prepareSignature(signatureDataUrl, token.organizationId, estimateJob.jobCardId)
      : null;

  return prisma.$transaction(async (tx) => {
    // Re-check revocation inside the transaction: a revision may have been created a moment ago.
    const fresh = await resolveAccessToken(rawToken, 'ESTIMATE', tx);
    if (fresh.state !== 'valid') throw new DomainError('This link is no longer valid.');

    const approval = await applyEstimateDecision(tx, {
      organizationId: token.organizationId,
      estimateId: token.resourceId,
      decision,
      // The customer decided themselves on the verified secure link: no staff
      // member records it. The link's sender stays on Estimate.sentByUserId.
      method: 'ONLINE',
      notes: trimmedNotes,
      recordedByUserId: null,
      metadata: {
        customerAccessTokenId: token.id,
        linkIssuedByUserId: token.createdByUserId,
        signed: Boolean(signature),
      },
    });
    if (signature && estimateJob?.jobCardId && estimateJob.jobCard) {
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: approval.customerId },
        select: { name: true },
      });
      await recordSignature(tx, {
        prepared: signature,
        organizationId: token.organizationId,
        branchId: estimateJob.jobCard.branchId,
        jobCardId: estimateJob.jobCardId,
        context: 'QUOTATION_APPROVAL',
        approvalId: approval.id,
        signerType: 'CUSTOMER',
        signerName: customer.name,
        customerId: approval.customerId,
        // Signed on the customer's own phone: no staff device captured it. The
        // stored file is attributed to the staff member who issued the link.
        capturedByUserId: null,
        fileOwnerUserId: token.createdByUserId,
        auditActorUserId: null,
      });
    }
    await tx.customerAccessToken.update({
      where: { id: token.id },
      data: { lastAccessedAt: new Date() },
    });
    return approval;
  });
}
