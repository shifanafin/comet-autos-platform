import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { localDateString } from '@/lib/format';
import { isOpenVersion, versionsOf } from '@/lib/workshop/estimates';

/*
 * Reading quotations as documents in their own right — by customer and
 * vehicle, whether or not a job card stands behind them. The lifecycle
 * itself (create, price, send, revise, decide) is lib/workshop/estimates.ts;
 * nothing here writes.
 */

/** A quotation is out of time when it was sent and its validity date has passed. */
export function quotationExpired(estimate: { status: string; validUntil: Date | null }): boolean {
  return (
    estimate.status === 'SENT' &&
    estimate.validUntil !== null &&
    estimate.validUntil.toISOString().slice(0, 10) < localDateString()
  );
}

/**
 * One quotation with everything its screen shows: lines, the decision, the
 * versions in its chain, and the job card behind it when there is one.
 */
export async function getQuotation(user: AuthenticatedUser, estimateId: string) {
  const estimate = await prisma.estimate.findFirst({
    where: { id: estimateId, organizationId: user.organizationId },
    include: {
      items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      approvals: {
        orderBy: { decidedAt: 'desc' },
        include: {
          recordedBy: { select: { fullName: true } },
          customer: { select: { name: true } },
        },
      },
      preparedBy: { select: { fullName: true } },
      sentBy: { select: { fullName: true } },
      customer: { select: { id: true, name: true, phone: true, email: true } },
      vehicle: { select: { id: true, plateNumber: true, make: true, model: true, year: true } },
      jobCard: {
        select: {
          id: true,
          jobNumber: true,
          status: true,
          customerComplaint: true,
          diagnoses: {
            orderBy: { diagnosedAt: 'desc' },
            take: 1,
            select: { recommendedAction: true },
          },
        },
      },
    },
  });
  if (!estimate) throw new NotFoundError('quotation');
  requirePermission(user, 'quotation.view', { branchId: estimate.branchId });

  // Every version of this quotation, newest first.
  const versions = await versionsOf(prisma, user.organizationId, estimate);

  return {
    ...estimate,
    expired: quotationExpired(estimate),
    /** The version that counts (lib/workshop/estimates.ts). */
    isLatest: estimate.isCurrent,
    /** An older version left open as an option: the customer may still choose it. */
    isOpenOption: !estimate.isCurrent && isOpenVersion(estimate),
    versions,
  };
}

export type Quotation = Awaited<ReturnType<typeof getQuotation>>;

export type QuotationFilter = '' | 'draft' | 'awaiting' | 'approved';

/**
 * The quotations list. One place to see what has been quoted, what the
 * customer has not answered yet, and what they said yes to — job cards or
 * not. Only the current version of each chain is listed; superseded
 * versions are reached from the quotation itself.
 */
export async function listQuotations(
  user: AuthenticatedUser,
  filters: { q?: string; status?: string } = {},
  /** Rows to return. The screen shows a page; an export asks for everything. */
  limit = 200,
  /** Rows to skip: the pages before the one shown. */
  offset = 0,
) {
  requirePermission(user, 'quotation.view');
  const q = filters.q?.trim();
  const status = (
    ['draft', 'awaiting', 'approved'].includes(filters.status ?? '') ? filters.status : ''
  ) as QuotationFilter;

  const where: Prisma.EstimateWhereInput = {
    organizationId: user.organizationId,
    kind: 'ORIGINAL',
    isCurrent: true,
    ...(status === 'draft'
      ? { status: 'DRAFT' }
      : status === 'awaiting'
        ? { status: 'SENT' }
        : status === 'approved'
          ? { status: { in: ['APPROVED', 'PARTIALLY_APPROVED'] } }
          : {}),
    ...(q
      ? {
          OR: [
            { estimateNumber: { contains: q, mode: 'insensitive' } },
            { customer: { name: { contains: q, mode: 'insensitive' } } },
            { customer: { phone: { contains: q, mode: 'insensitive' } } },
            { vehicle: { plateNumber: { contains: q, mode: 'insensitive' } } },
            { jobCard: { jobNumber: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const [estimates, total] = await Promise.all([
    prisma.estimate.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
      select: {
        id: true,
        estimateNumber: true,
        version: true,
        status: true,
        kind: true,
        totalAmount: true,
        validUntil: true,
        sentAt: true,
        createdAt: true,
        updatedAt: true,
        customer: { select: { name: true, phone: true } },
        vehicle: { select: { plateNumber: true, make: true, model: true } },
        jobCard: { select: { id: true, jobNumber: true } },
      },
    }),
    prisma.estimate.count({ where }),
  ]);

  return {
    /** Every row the search and filters match, not only the page shown. */
    total,
    status,
    quotations: estimates.map((estimate) => ({
      ...estimate,
      expired: quotationExpired(estimate),
    })),
  };
}

export type QuotationListItem = Awaited<ReturnType<typeof listQuotations>>['quotations'][number];
