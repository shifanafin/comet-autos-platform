'use server';

import { prisma } from '@/lib/prisma';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import type { JobCardStatus } from '@/generated/prisma/enums';

export interface GlobalSearchResults {
  customers: { id: string; name: string; phone: string }[];
  vehicles: {
    id: string;
    plateNumber: string;
    make: string;
    model: string;
    customerName: string;
    latestJobCardId: string | null;
  }[];
  jobCards: {
    id: string;
    jobNumber: string;
    status: JobCardStatus;
    plateNumber: string;
    customerName: string;
  }[];
}

const EMPTY_RESULTS: GlobalSearchResults = { customers: [], vehicles: [], jobCards: [] };

// Powers the Cmd+K / "/" global search (section 8): customer name/mobile,
// vehicle plate/VIN, job number — the identifiers staff actually search by.
// Estimate/invoice number search will join in once those modules exist.
export async function globalSearch(query: string): Promise<GlobalSearchResults> {
  const user = await requireUser();
  const trimmed = query.trim();
  if (trimmed.length < 2) return EMPTY_RESULTS;

  // Each group only for those allowed to see it — the same rules as its own screen.
  const branch = user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined;
  const canCustomers = hasPermission(user, 'customer.view', branch);
  const canVehicles = hasPermission(user, 'vehicle.view', branch);
  const jobsOrgWide = hasPermission(user, 'job_card.view');
  const canJobs = jobsOrgWide || hasPermission(user, 'job_card.view', branch);

  const [customers, vehicles, jobCards] = await Promise.all([
    !canCustomers
      ? []
      : prisma.customer.findMany({
          where: {
            organizationId: user.organizationId,
            isActive: true,
            OR: [
              { name: { contains: trimmed, mode: 'insensitive' } },
              { phone: { contains: trimmed } },
            ],
          },
          select: { id: true, name: true, phone: true },
          take: 5,
        }),
    !canVehicles
      ? []
      : prisma.vehicle.findMany({
          where: {
            organizationId: user.organizationId,
            isActive: true,
            OR: [
              { plateNumber: { contains: trimmed, mode: 'insensitive' } },
              { vin: { contains: trimmed, mode: 'insensitive' } },
            ],
          },
          include: {
            customer: { select: { name: true } },
            jobCards: { orderBy: { openedAt: 'desc' }, take: 1, select: { id: true } },
          },
          take: 5,
        }),
    !canJobs
      ? []
      : prisma.jobCard.findMany({
          where: {
            organizationId: user.organizationId,
            // A branch-only permission sees that branch's jobs only.
            ...(jobsOrgWide ? {} : { branchId: user.primaryBranchId ?? undefined }),
            jobNumber: { contains: trimmed, mode: 'insensitive' },
          },
          include: { customer: true, vehicle: true },
          take: 5,
        }),
  ]);

  return {
    customers: customers.map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
    vehicles: vehicles.map((v) => ({
      id: v.id,
      plateNumber: v.plateNumber,
      make: v.make,
      model: v.model,
      customerName: v.customer.name,
      latestJobCardId: v.jobCards[0]?.id ?? null,
    })),
    jobCards: jobCards.map((jc) => ({
      id: jc.id,
      jobNumber: jc.jobNumber,
      status: jc.status,
      plateNumber: jc.vehicle.plateNumber,
      customerName: jc.customer.name,
    })),
  };
}
