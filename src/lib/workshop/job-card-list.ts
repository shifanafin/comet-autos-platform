import type { JobCardStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';

/*
 * The job-card list, in one place, so the screen and its export always
 * show the same rows for the same search and status.
 */

export interface JobCardFilters {
  q?: string;
  status?: string;
}

export function jobCardWhere(user: AuthenticatedUser, filters: JobCardFilters) {
  const query = filters.q?.trim() ?? '';
  return {
    organizationId: user.organizationId,
    ...(filters.status ? { status: filters.status as JobCardStatus } : {}),
    ...(query
      ? {
          OR: [
            { jobNumber: { contains: query, mode: 'insensitive' as const } },
            { vehicle: { plateNumber: { contains: query, mode: 'insensitive' as const } } },
            { customer: { name: { contains: query, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
}

/** Job cards, newest first. `skip` pages the screen; `limit` bounds an export. */
export async function listJobCards(
  user: AuthenticatedUser,
  filters: JobCardFilters,
  limit = 25,
  skip = 0,
) {
  requirePermission(user, 'job_card.view');
  return prisma.jobCard.findMany({
    where: jobCardWhere(user, filters),
    include: { customer: true, vehicle: true },
    orderBy: { openedAt: 'desc' },
    skip,
    take: limit,
  });
}

export async function countJobCards(user: AuthenticatedUser, filters: JobCardFilters) {
  requirePermission(user, 'job_card.view');
  return prisma.jobCard.count({ where: jobCardWhere(user, filters) });
}
