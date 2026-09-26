import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { localDateString } from '@/lib/format';

/*
 * Reading quotations as documents in their own right — by customer and
 * vehicle, whether or not a job card stands behind them. The lifecycle
 * itself (create, price, send, revise, decide) is lib/workshop/estimates.ts;
 * nothing here writes.
 */

/** A quotation is out of time when it was sent and its validity date has passed. */
export function quotationExpired(estimate: {
  status: string;
  validUntil: Date | null;
}): boolean {
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
      _count: { select: { nextVersions: true } },
    },
  });
  if (!estimate) throw new NotFoundError('quotation');
  requirePermission(user, 'job_card.view', { branchId: estimate.branchId });

  // Every version of this quotation, newest first. A quotation on a work
  // order groups its chain by that job card; a standalone one walks back
  // through previousVersionId.
  const versions = estimate.jobCardId
    ? await prisma.estimate.findMany({
        where: {
          organizationId: user.organizationId,
          jobCardId: estimate.jobCardId,
          kind: estimate.kind,
        },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, status: true, totalAmount: true, validUntil: true },
      })
    : await standaloneChain(user.organizationId, estimate.id);

  return {
    ...estimate,
    expired: quotationExpired(estimate),
    isLatest: estimate._count.nextVersions === 0,
    versions,
  };
}

export type Quotation = Awaited<ReturnType<typeof getQuotation>>;

/** The whole revision chain of a standalone quotation, newest version first. */
async function standaloneChain(organizationId: string, estimateId: string) {
  const chain: {
    id: string;
    version: number;
    status: string;
    totalAmount: { toString(): string };
    validUntil: Date | null;
  }[] = [];
  const select = {
    id: true,
    version: true,
    status: true,
    totalAmount: true,
    validUntil: true,
    previousVersionId: true,
  } as const;

  // Forward to the newest version, then back through the chain.
  let head = await prisma.estimate.findFirstOrThrow({
    where: { id: estimateId, organizationId },
    select,
  });
  for (let step = 0; step < 100; step += 1) {
    const next = await prisma.estimate.findFirst({
      where: { organizationId, previousVersionId: head.id },
      select,
    });
    if (!next) break;
    head = next;
  }
  let cursor: typeof head | null = head;
  for (let step = 0; step < 100 && cursor; step += 1) {
    chain.push(cursor);
    cursor = cursor.previousVersionId
      ? await prisma.estimate.findFirst({
          where: { id: cursor.previousVersionId, organizationId },
          select,
        })
      : null;
  }
  return chain;
}

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
) {
  requirePermission(user, 'job_card.view');
  const q = filters.q?.trim();
  const status = (
    ['draft', 'awaiting', 'approved'].includes(filters.status ?? '') ? filters.status : ''
  ) as QuotationFilter;

  const estimates = await prisma.estimate.findMany({
    where: {
      organizationId: user.organizationId,
      kind: 'ORIGINAL',
      nextVersions: { none: {} },
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
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
  });

  return {
    status,
    quotations: estimates.map((estimate) => ({
      ...estimate,
      expired: quotationExpired(estimate),
    })),
  };
}

export type QuotationListItem = Awaited<ReturnType<typeof listQuotations>>['quotations'][number];
