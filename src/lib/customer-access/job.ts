import type { JobCardStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { getCustomerAccess, type CustomerAccess } from '@/lib/customer-access/access';
import { resolveAccessToken } from '@/lib/customer-access/tokens';
import { normalizeStatus } from '@/lib/workshop/stages';

/*
 * A job card as its customer sees it on a secure link: the job, the car,
 * what they asked for, where the job is now, and the work they approved
 * with its total. Never costs, staff, notes or anything internal.
 */

/** The customer's view of the steps a job goes through. */
export const CUSTOMER_STEPS = [
  'Received',
  'Checking',
  'Quotation',
  'Repair',
  'Ready',
  'Delivered',
] as const;

/** Where the job is, in the customer's words, and which step that is (-1: off the path). */
export function customerStage(status: JobCardStatus): { label: string; step: number } {
  switch (normalizeStatus(status)) {
    case 'ARRIVED':
      return { label: 'Received', step: 0 };
    case 'INSPECTION':
    case 'DIAGNOSIS':
      return { label: 'Checking your vehicle', step: 1 };
    case 'ESTIMATE':
      return { label: 'Preparing your quotation', step: 2 };
    case 'WAITING_APPROVAL':
      return { label: 'Waiting for your approval', step: 2 };
    case 'APPROVED':
    case 'REPAIR':
      return { label: 'Being repaired', step: 3 };
    case 'QUALITY_CHECK':
      return { label: 'Final checks', step: 3 };
    case 'READY':
    case 'INVOICED':
    case 'PAID':
      return { label: 'Ready for collection', step: 4 };
    case 'DELIVERED':
      return { label: 'Delivered', step: 5 };
    case 'REJECTED':
      return { label: 'Quotation declined', step: -1 };
    case 'ON_HOLD':
      return { label: 'On hold', step: -1 };
    case 'CANCELLED':
      return { label: 'Cancelled', step: -1 };
    default:
      return { label: 'In the workshop', step: -1 };
  }
}

export function getJobAccess(rawToken: string): Promise<CustomerAccess> {
  return getCustomerAccess(rawToken, 'JOB_CARD');
}

/** The job card as the customer sees it. Call only after getJobAccess returned "open". */
export async function loadCustomerJob(rawToken: string) {
  const resolved = await resolveAccessToken(rawToken, 'JOB_CARD');
  if (resolved.state !== 'valid' || !resolved.token) return null;
  const { organizationId, resourceId } = resolved.token;

  const job = await prisma.jobCard.findFirst({
    where: { id: resourceId, organizationId },
    select: {
      jobNumber: true,
      status: true,
      openedAt: true,
      deliveredAt: true,
      customerComplaint: true,
      customer: { select: { name: true } },
      vehicle: { select: { plateNumber: true, make: true, model: true, year: true } },
      // The work the customer said yes to: the approved quotation, and any
      // additional work they approved since.
      estimates: {
        where: { status: 'APPROVED' },
        orderBy: { createdAt: 'asc' },
        select: {
          estimateNumber: true,
          kind: true,
          totalAmount: true,
          items: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { itemType: true, description: true, quantity: true, lineTotal: true },
          },
        },
      },
    },
  });
  if (!job) return null;
  const total = job.estimates.reduce((sum, estimate) => sum + Number(estimate.totalAmount), 0);
  return { ...job, stage: customerStage(job.status), approvedTotal: total.toFixed(2) };
}
