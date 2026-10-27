import type { JobCardStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { getCustomerAccess, type CustomerAccess } from '@/lib/customer-access/access';
import { resolveAccessToken } from '@/lib/customer-access/tokens';
import { normalizeStatus } from '@/lib/workshop/stages';
import type { CustomerTone } from '@/components/customer/customer-shell';

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

export interface CustomerStage {
  label: string;
  /** One reassuring line under the label. */
  note: string;
  /** Which of CUSTOMER_STEPS it is; -1: off the path. */
  step: number;
  tone: CustomerTone;
}

/** Where the job is, in the customer's words. */
export function customerStage(status: JobCardStatus): CustomerStage {
  switch (normalizeStatus(status)) {
    case 'ARRIVED':
      return {
        label: 'Received',
        note: 'Your vehicle is with us. We will check it shortly.',
        step: 0,
        tone: 'moving',
      };
    case 'INSPECTION':
    case 'DIAGNOSIS':
      return {
        label: 'Checking your vehicle',
        note: 'Our technician is looking at your vehicle.',
        step: 1,
        tone: 'moving',
      };
    case 'ESTIMATE':
      return {
        label: 'Preparing your quotation',
        note: 'We will send it to you for approval.',
        step: 2,
        tone: 'moving',
      };
    case 'WAITING_APPROVAL':
      return {
        label: 'Waiting for your approval',
        note: 'Your quotation is ready. Let us know and we will start the work.',
        step: 2,
        tone: 'waiting',
      };
    case 'APPROVED':
    case 'REPAIR':
      return {
        label: 'Being repaired',
        note: 'The work you approved is under way.',
        step: 3,
        tone: 'moving',
      };
    case 'QUALITY_CHECK':
      return {
        label: 'Final checks',
        note: 'The work is done. We are checking everything before handing it back.',
        step: 3,
        tone: 'moving',
      };
    case 'READY':
    case 'INVOICED':
    case 'PAID':
      return {
        label: 'Ready for collection',
        note: 'Your vehicle is ready. Come and collect it any time during working hours.',
        step: 4,
        tone: 'done',
      };
    case 'DELIVERED':
      return {
        label: 'Delivered',
        note: 'Your vehicle has been handed back. Thank you for choosing us.',
        step: 5,
        tone: 'done',
      };
    case 'REJECTED':
      return {
        label: 'Quotation declined',
        note: 'Contact us if you would like other options.',
        step: -1,
        tone: 'stopped',
      };
    case 'ON_HOLD':
      return {
        label: 'On hold',
        note: 'Work is paused for now. We will update you.',
        step: -1,
        tone: 'stopped',
      };
    case 'CANCELLED':
      return { label: 'Cancelled', note: 'This job was cancelled.', step: -1, tone: 'stopped' };
    default:
      return {
        label: 'In the workshop',
        note: 'Your vehicle is with us.',
        step: -1,
        tone: 'moving',
      };
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
