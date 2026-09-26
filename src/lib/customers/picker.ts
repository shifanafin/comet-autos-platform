import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { findMatchingIds } from '@/lib/customers/search';
import { OPEN_JOB_STATUSES } from '@/lib/workshop/check-in';

/**
 * Customers with their vehicles and open job cards, for the document
 * screens where the customer is required and the vehicle is not. The
 * vehicle-first lookup (lib/vehicles/summary.ts) stays as it is for
 * check-in, where a car is always what arrives.
 */

export interface PickerVehicle {
  id: string;
  plateNumber: string;
  make: string;
  model: string;
  year: number | null;
}

export interface PickerJobCard {
  id: string;
  jobNumber: string;
}

export interface CustomerOption {
  id: string;
  name: string;
  phone: string;
  vehicles: PickerVehicle[];
  /** Job cards still in the workshop, so a document can be filed against one. */
  openJobCards: PickerJobCard[];
}

export async function searchCustomerOptions(
  user: AuthenticatedUser,
  query: string,
  limit = 8,
): Promise<CustomerOption[]> {
  requirePermission(user, 'customer.view');
  const { customerIds } = await findMatchingIds(user.organizationId, query, limit);
  if (customerIds.length === 0) return [];
  return getCustomerOptions(user, customerIds);
}

/** The same shape by id — used to re-show a choice the form already holds. */
export async function getCustomerOptions(
  user: AuthenticatedUser,
  customerIds: string[],
): Promise<CustomerOption[]> {
  if (customerIds.length === 0) return [];
  requirePermission(user, 'customer.view');
  const customers = await prisma.customer.findMany({
    where: { organizationId: user.organizationId, id: { in: customerIds }, isActive: true },
    select: {
      id: true,
      name: true,
      phone: true,
      vehicles: {
        where: { isActive: true },
        orderBy: { plateNumber: 'asc' },
        select: { id: true, plateNumber: true, make: true, model: true, year: true },
      },
      jobCards: {
        where: { status: { in: OPEN_JOB_STATUSES } },
        orderBy: { openedAt: 'desc' },
        select: { id: true, jobNumber: true },
      },
    },
  });
  const byId = new Map(customers.map((customer) => [customer.id, customer]));
  return customerIds
    .map((id) => byId.get(id))
    .filter((customer) => customer !== undefined)
    .map((customer) => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      vehicles: customer.vehicles,
      openJobCards: customer.jobCards,
    }));
}
