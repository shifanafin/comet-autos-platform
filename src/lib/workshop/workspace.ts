import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { localDateString } from '@/lib/format';
import {
  getEffectiveStageStatus,
  getResumeTarget,
  JOB_STATUS_LABEL,
  normalizeStatus,
  type WorkflowStatus,
} from '@/lib/workshop/stages';
import { getManualForwardStatus } from '@/lib/workshop/job-status';

/** Everything the Job Card workspace and its sub-pages show. One query shape, used everywhere. */
export async function getJobWorkspace(user: AuthenticatedUser, jobCardId: string) {
  const jobCard = await prisma.jobCard.findFirst({
    where: { id: jobCardId, organizationId: user.organizationId },
    include: {
      branch: { select: { name: true } },
      createdBy: { select: { fullName: true } },
      deliveredBy: { select: { fullName: true } },
      appointment: { select: { scheduledAt: true, notes: true } },
      // The job's own customer. The vehicle's current owner may be someone
      // else by now; anything about this job reads jobCard.customer.
      customer: true,
      vehicle: true,
      statusHistory: {
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
        include: {
          changedBy: { select: { fullName: true } },
          changedByCustomer: { select: { name: true } },
        },
      },
      assignments: {
        where: { unassignedAt: null },
        include: { employee: { select: { id: true, firstName: true, lastName: true, jobTitle: true } } },
      },
      inspections: {
        orderBy: { createdAt: 'desc' },
        include: {
          inspectedByEmployee: { select: { id: true, firstName: true, lastName: true } },
          items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
      },
      diagnoses: {
        orderBy: { diagnosedAt: 'desc' },
        include: { diagnosedByEmployee: { select: { id: true, firstName: true, lastName: true } } },
      },
      // The original quotation chain only; additional-work requests are
      // shown by the repair sections (lib/workshop/repair.ts).
      estimates: {
        where: { kind: 'ORIGINAL' },
        orderBy: { version: 'desc' },
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
        },
      },
    },
  });
  // Same response for "doesn't exist" and "not yours" (authorization.md).
  if (!jobCard) throw new NotFoundError('job card');
  requirePermission(user, 'job_card.view', { branchId: jobCard.branchId });

  const primary = jobCard.assignments.find((a) => a.assignmentRole === 'PRIMARY') ?? null;
  const inspection = jobCard.inspections[0] ?? null;
  const diagnosis = jobCard.diagnoses[0] ?? null;
  const estimate = jobCard.estimates[0] ?? null;
  const status = normalizeStatus(jobCard.status);
  const effectiveStatus = getEffectiveStageStatus(jobCard.status, jobCard.statusHistory);
  const resumeStatus = getResumeTarget(jobCard.statusHistory);
  const estimateExpired =
    estimate?.status === 'SENT' &&
    estimate.validUntil !== null &&
    estimate.validUntil.toISOString().slice(0, 10) < localDateString();

  return {
    jobCard,
    status,
    primaryTechnician: primary?.employee ?? null,
    inspection,
    diagnosis,
    estimate,
    estimateExpired,
    effectiveStatus,
    resumeStatus,
  };
}

export type JobWorkspace = Awaited<ReturnType<typeof getJobWorkspace>>;

export type NextActionTone = 'action' | 'waiting' | 'warning' | 'done';

export interface NextAction {
  tone: NextActionTone;
  title: string;
  description: string;
  /** Primary call to action: a page to go to, or a manual status change. */
  href?: string;
  label?: string;
  manualStatus?: WorkflowStatus;
  /** A workflow step the panel performs itself (with confirmation). */
  workflowAction?: 'START_REPAIR';
}

const MANUAL_TITLES: Partial<Record<WorkflowStatus, string>> = {};

/** "What do I do next?" — derived from the job status plus the workflow records, never stored. */
export function getNextAction(workspace: JobWorkspace): NextAction {
  const { jobCard, status, primaryTechnician, inspection, estimate, estimateExpired } = workspace;
  const base = `/job-cards/${jobCard.id}`;

  switch (status) {
    case 'CANCELLED':
      return { tone: 'done', title: 'Job cancelled', description: 'No further work will be done on this job.' };
    case 'DELIVERED':
      return { tone: 'done', title: 'Vehicle delivered', description: 'The job is complete and the vehicle has been handed back.' };
    case 'ON_HOLD':
      return {
        tone: 'warning',
        title: 'Job is on hold',
        description: `Paused at “${JOB_STATUS_LABEL[workspace.resumeStatus]}”. Resume when the blocker is cleared.`,
        manualStatus: workspace.resumeStatus,
        label: 'Resume job',
      };
    case 'ARRIVED':
      if (!primaryTechnician) {
        return {
          tone: 'action',
          title: 'Assign a technician',
          description: 'The vehicle has arrived. Choose who will inspect and work on it.',
          href: `${base}#technician`,
          label: 'Assign technician',
        };
      }
      return {
        tone: 'action',
        title: 'Inspect the vehicle',
        description: `${primaryTechnician.firstName} is assigned. Start the inspection checklist.`,
        href: `${base}/inspection`,
        label: 'Start inspection',
      };
    case 'INSPECTION':
      if (inspection?.status === 'COMPLETED') {
        return {
          tone: 'action',
          title: 'Record the diagnosis',
          description: 'The inspection is complete. Record what is wrong and the recommended work.',
          href: `${base}/diagnosis`,
          label: 'Record diagnosis',
        };
      }
      return {
        tone: 'action',
        title: 'Finish the inspection',
        description: 'Work through the checklist, then mark the inspection complete.',
        href: `${base}/inspection`,
        label: 'Continue inspection',
      };
    case 'DIAGNOSIS':
      return {
        tone: 'action',
        title: 'Create the estimate',
        description: 'Price the recommended work so the customer can approve it.',
        href: `${base}/estimate`,
        label: 'Create estimate',
      };
    case 'ESTIMATE':
      return {
        tone: 'action',
        title: estimate && estimate.version > 1 ? 'Send the revised estimate' : 'Finish and send the estimate',
        description: 'Add the labour and parts, check the total, then send it to the customer.',
        href: `${base}/estimate`,
        label: 'Open estimate',
      };
    case 'WAITING_APPROVAL':
      if (estimateExpired) {
        return {
          tone: 'warning',
          title: 'Quotation expired',
          description: 'The customer did not respond before the validity date. Revise and resend.',
          href: `${base}/estimate`,
          label: 'Revise estimate',
        };
      }
      return {
        tone: 'waiting',
        title: 'Waiting for customer approval',
        description: 'The quotation has been sent. Record the decision if the customer calls or visits.',
        href: `${base}/estimate`,
        label: 'View estimate',
      };
    case 'APPROVED':
      return {
        tone: 'action',
        title: 'Start the repair',
        description: 'The customer approved the work. Starting the repair lets the team record parts and labour.',
        workflowAction: 'START_REPAIR',
        label: 'Start repair',
      };
    case 'REPAIR':
      return {
        tone: 'action',
        title: 'Repair in progress',
        description: 'Record the parts and labour against the approved work, then do the quality check.',
        href: `${base}#quality-check`,
        label: 'Go to quality check',
      };
    case 'QUALITY_CHECK':
      return {
        tone: 'action',
        title: 'Record the quality check',
        description: 'Check the finished work, then pass it or send it back to the technician.',
        href: `${base}#quality-check`,
        label: 'Quality check',
      };
    case 'READY':
      return {
        tone: 'action',
        title: 'Create the invoice',
        description: 'Quality check passed. Bill the approved work, then take payment before handing the vehicle back.',
        href: `${base}#invoice`,
        label: 'Review invoice',
      };
    case 'INVOICED':
      return {
        tone: 'waiting',
        title: 'Waiting for payment',
        description: 'The invoice is issued. Record payments as the customer pays.',
        href: `${base}#payments`,
        label: 'Record payment',
      };
    case 'PAID':
      return {
        tone: 'action',
        title: 'Deliver the vehicle',
        description: 'The invoice is fully paid. Hand the vehicle back and record the delivery.',
        href: `${base}#delivery`,
        label: 'Deliver vehicle',
      };
    case 'REJECTED':
      return {
        tone: 'warning',
        title: 'Customer rejected the estimate',
        description: 'Revise the quotation and send it again, or cancel the job.',
        href: `${base}/estimate`,
        label: 'Revise estimate',
      };
    default: {
      // Post-approval stages: manual buttons until repair / QC / invoicing get their own screens.
      const forward = getManualForwardStatus(status);
      return {
        tone: 'action',
        title: MANUAL_TITLES[status] ?? 'Continue',
        description:
          status === 'READY'
            ? 'Quality check passed. The vehicle can be collected. Invoicing and handover arrive in later phases.'
            : 'Invoicing, payment and delivery screens arrive in later phases.',
        manualStatus: forward ?? undefined,
        label: forward ? `Mark ${JOB_STATUS_LABEL[forward].toLowerCase()}` : undefined,
      };
    }
  }
}

/** Work queues for the Inspections / Estimates / Approvals screens. */
export async function getWorkQueues(user: AuthenticatedUser) {
  requirePermission(user, 'job_card.view');
  const org = user.organizationId;
  const jobSelect = {
    id: true,
    jobNumber: true,
    status: true,
    openedAt: true,
    customerComplaint: true,
    customer: { select: { name: true, phone: true } },
    vehicle: { select: { plateNumber: true, make: true, model: true } },
    assignments: {
      where: { unassignedAt: null, assignmentRole: 'PRIMARY' as const },
      select: { employee: { select: { firstName: true, lastName: true } } },
    },
  };

  const [awaitingInspection, inInspection, awaitingDiagnosis, needsEstimate, estimates] = await Promise.all([
    prisma.jobCard.findMany({
      where: { organizationId: org, status: { in: ['ARRIVED', 'RECEIVED'] } },
      orderBy: { openedAt: 'asc' },
      select: jobSelect,
    }),
    prisma.jobCard.findMany({
      where: { organizationId: org, status: { in: ['INSPECTION', 'INSPECTING'] }, inspections: { some: { status: 'IN_PROGRESS' } } },
      orderBy: { openedAt: 'asc' },
      select: jobSelect,
    }),
    prisma.jobCard.findMany({
      where: { organizationId: org, status: { in: ['INSPECTION', 'INSPECTING'] }, inspections: { none: { status: 'IN_PROGRESS' } } },
      orderBy: { openedAt: 'asc' },
      select: jobSelect,
    }),
    prisma.jobCard.findMany({
      where: { organizationId: org, status: { in: ['DIAGNOSIS', 'DIAGNOSED'] } },
      orderBy: { openedAt: 'asc' },
      select: jobSelect,
    }),
    prisma.estimate.findMany({
      where: { organizationId: org, nextVersions: { none: {} } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        estimateNumber: true,
        version: true,
        status: true,
        totalAmount: true,
        validUntil: true,
        sentAt: true,
        updatedAt: true,
        kind: true,
        approvals: { orderBy: { decidedAt: 'desc' }, take: 1, select: { approvalMethod: true, decidedAt: true } },
        // The quotation's own parties, so one raised without a job card
        // still shows who and what it is for.
        customer: { select: { name: true, phone: true } },
        vehicle: { select: { plateNumber: true, make: true, model: true } },
        jobCard: { select: jobSelect },
      },
    }),
  ]);

  return { awaitingInspection, inInspection, awaitingDiagnosis, needsEstimate, estimates };
}
