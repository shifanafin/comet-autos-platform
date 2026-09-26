import type { Prisma } from '@/generated/prisma/client';
import type { JobCardStatus } from '@/generated/prisma/enums';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import {
  CLOSED_JOB_STATUSES,
  JOB_STATUS_LABEL,
  WORKFLOW_STAGES,
  getEffectiveStageStatus,
  getResumeTarget,
  normalizeStatus,
  type WorkflowStage,
  type WorkflowStatus,
} from '@/lib/workshop/stages';

export {
  WORKFLOW_STAGES,
  JOB_STATUS_LABEL,
  CLOSED_JOB_STATUSES,
  getEffectiveStageStatus,
  normalizeStatus,
};
export type { WorkflowStage, WorkflowStatus };

/**
 * The job card state machine.
 *
 * The full path, used when the workshop works a job stage by stage:
 *
 *   ARRIVED → INSPECTION → DIAGNOSIS → ESTIMATE → WAITING_APPROVAL
 *     → APPROVED → REPAIR → QUALITY_CHECK → READY → INVOICED → PAID → DELIVERED
 *     → REJECTED → ESTIMATE (revise) …
 *   QUALITY_CHECK → REPAIR (failed check)
 *   WAITING_APPROVAL → ESTIMATE (revise before the customer answers)
 *   any open stage → ON_HOLD → back to where it paused; → CANCELLED
 *
 * The short path, for a one-person workshop that only wants the documents:
 *
 *   ARRIVED → ESTIMATE  (quote a job card without inspecting or diagnosing)
 *   any open stage → INVOICED  (bill a job card without passing through QC)
 *
 * The short path skips stages; it never invents them. A job that jumps from
 * ARRIVED to INVOICED has no inspection, diagnosis or quality check, and its
 * history says so. Both are only ever taken by recording a real document —
 * see WORKFLOW_OWNED below, which keeps every one of these targets off the
 * manual status buttons.
 *
 * Legacy statuses (RECEIVED, INSPECTING, …) are never written; a job still
 * carrying one is treated as its workflow equivalent.
 */
const ALLOWED_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  ARRIVED: ['INSPECTION', 'ESTIMATE', 'INVOICED', 'ON_HOLD', 'CANCELLED'],
  INSPECTION: ['DIAGNOSIS', 'ESTIMATE', 'INVOICED', 'ON_HOLD', 'CANCELLED'],
  DIAGNOSIS: ['ESTIMATE', 'INVOICED', 'ON_HOLD', 'CANCELLED'],
  ESTIMATE: ['WAITING_APPROVAL', 'INVOICED', 'ON_HOLD', 'CANCELLED'],
  WAITING_APPROVAL: ['APPROVED', 'REJECTED', 'ESTIMATE', 'INVOICED', 'ON_HOLD', 'CANCELLED'],
  REJECTED: ['ESTIMATE', 'ON_HOLD', 'CANCELLED'],
  APPROVED: ['REPAIR', 'INVOICED', 'ON_HOLD', 'CANCELLED'],
  REPAIR: ['QUALITY_CHECK', 'INVOICED', 'ON_HOLD', 'CANCELLED'],
  QUALITY_CHECK: ['READY', 'REPAIR', 'INVOICED', 'ON_HOLD', 'CANCELLED'],
  READY: ['INVOICED', 'ON_HOLD'],
  INVOICED: ['PAID'],
  PAID: ['DELIVERED'],
  DELIVERED: [],
  ON_HOLD: [
    'ARRIVED',
    'INSPECTION',
    'DIAGNOSIS',
    'ESTIMATE',
    'WAITING_APPROVAL',
    'REJECTED',
    'APPROVED',
    'REPAIR',
    'QUALITY_CHECK',
    'READY',
    'CANCELLED',
  ],
  CANCELLED: [],
};

/**
 * Transitions that only happen as the result of recording workflow evidence
 * — never by clicking a status button: the job enters inspection when an
 * inspection is started, diagnosis when a diagnosis is recorded, and so on.
 */
const WORKFLOW_OWNED: Partial<Record<WorkflowStatus, string>> = {
  INSPECTION: 'Start the inspection to move this job into inspection.',
  DIAGNOSIS: 'Record the diagnosis to move this job forward.',
  ESTIMATE: 'Create or revise the estimate to move this job forward.',
  WAITING_APPROVAL: 'Send the estimate to the customer to move this job forward.',
  APPROVED: 'Record the customer approval to move this job forward.',
  REJECTED: "Record the customer's rejection to move this job forward.",
  REPAIR: 'Start the repair from the approved work.',
  QUALITY_CHECK: 'Record the quality check to move this job forward.',
  READY: 'A job is only ready once it passes the quality check.',
  INVOICED: 'Create the invoice to move this job forward.',
  PAID: 'A job is paid once its invoice is fully settled.',
  DELIVERED: 'Record the delivery to hand the vehicle back.',
};

const EXCEPTION_STATUSES: WorkflowStatus[] = ['ON_HOLD', 'CANCELLED'];

/**
 * The only backward moves: undoing billing. A voided invoice sends the job
 * back to where it was billed from; a reversed payment sends a paid job back
 * to invoiced. Only ever taken by voidInvoice / reverseInvoicePayment
 * (lib/billing/invoice-changes.ts) with `reopen: true` — never by a button.
 */
const REOPEN_TRANSITIONS: Partial<Record<WorkflowStatus, WorkflowStatus[]>> = {
  INVOICED: [
    'ARRIVED',
    'INSPECTION',
    'DIAGNOSIS',
    'ESTIMATE',
    'WAITING_APPROVAL',
    'APPROVED',
    'REPAIR',
    'QUALITY_CHECK',
    'READY',
  ],
  PAID: ['INVOICED'],
};

export class InvalidJobStatusTransitionError extends DomainError {}

export function getAllowedNextStatuses(status: JobCardStatus): WorkflowStatus[] {
  return ALLOWED_TRANSITIONS[normalizeStatus(status)];
}

export function canTransition(from: JobCardStatus, to: WorkflowStatus): boolean {
  return getAllowedNextStatuses(from).includes(to);
}

/** The forward step a user may apply with a button (post-approval stages until they get their own screens). */
export function getManualForwardStatus(status: JobCardStatus): WorkflowStatus | null {
  const forward = getAllowedNextStatuses(status).find((s) => !EXCEPTION_STATUSES.includes(s));
  if (!forward || WORKFLOW_OWNED[forward]) return null;
  return forward;
}

export function getSecondaryNextStatuses(status: JobCardStatus): WorkflowStatus[] {
  return getAllowedNextStatuses(status).filter((s) => EXCEPTION_STATUSES.includes(s));
}

export type TransitionSource = 'manual' | 'workflow';

/**
 * Who caused a status change. A staff user for everything done inside the
 * workshop app; the customer when their own online decision on the secure
 * quotation link moved the job. Never both — enforced by a CHECK constraint.
 */
export type StatusActor = { userId: string } | { customerId: string };

/**
 * Applies a status change with its history row and audit entry, in the
 * caller's transaction. Locks the job card row first, so two concurrent
 * changes can't both read the same "from" status.
 */
export async function applyJobStatusChange(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    jobCardId: string;
    toStatus: WorkflowStatus;
    actor: StatusActor;
    source: TransitionSource;
    metadata?: Record<string, unknown>;
    /** Undoing billing — see REOPEN_TRANSITIONS. Workflow source only. */
    reopen?: boolean;
  },
): Promise<{ fromStatus: JobCardStatus }> {
  await tx.$executeRaw`SELECT id FROM job_cards WHERE id = ${params.jobCardId}::uuid AND organization_id = ${params.organizationId}::uuid FOR UPDATE`;
  const jobCard = await tx.jobCard.findFirst({
    where: { id: params.jobCardId, organizationId: params.organizationId },
    select: { id: true, status: true, branchId: true },
  });
  if (!jobCard) throw new NotFoundError('job card');

  const { toStatus } = params;
  const from = normalizeStatus(jobCard.status);
  const reopening =
    params.reopen === true &&
    params.source === 'workflow' &&
    (REOPEN_TRANSITIONS[from] ?? []).includes(toStatus);
  if (!reopening && !canTransition(from, toStatus)) {
    throw new InvalidJobStatusTransitionError(
      `A job that is "${JOB_STATUS_LABEL[from]}" can't move to "${JOB_STATUS_LABEL[toStatus]}".`,
    );
  }
  if (params.source === 'manual' && from !== 'ON_HOLD' && WORKFLOW_OWNED[toStatus]) {
    throw new InvalidJobStatusTransitionError(WORKFLOW_OWNED[toStatus]!);
  }
  if (params.source === 'manual' && from === 'ON_HOLD' && toStatus !== 'CANCELLED') {
    const history = await tx.jobStatusHistory.findMany({
      where: { organizationId: params.organizationId, jobCardId: jobCard.id },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      select: { toStatus: true },
    });
    const resumeTo = getResumeTarget(history);
    if (toStatus !== resumeTo) {
      throw new InvalidJobStatusTransitionError(
        `This job was paused at "${JOB_STATUS_LABEL[resumeTo]}" and can only resume there.`,
      );
    }
  }

  const actorUserId = 'userId' in params.actor ? params.actor.userId : null;
  const actorCustomerId = 'customerId' in params.actor ? params.actor.customerId : null;

  await tx.jobCard.update({
    where: { id: jobCard.id },
    data: { status: toStatus, closedAt: toStatus === 'DELIVERED' ? new Date() : undefined },
  });
  await tx.jobStatusHistory.create({
    data: {
      organizationId: params.organizationId,
      jobCardId: jobCard.id,
      fromStatus: jobCard.status,
      toStatus,
      changedByUserId: actorUserId,
      changedByCustomerId: actorCustomerId,
    },
  });
  await writeAuditLog(tx, {
    organizationId: params.organizationId,
    branchId: jobCard.branchId,
    actorUserId,
    action: 'job_card.status_changed',
    entityType: 'JobCard',
    entityId: jobCard.id,
    beforeData: { status: jobCard.status },
    afterData: { status: toStatus },
    metadata: {
      source: params.source,
      ...(actorCustomerId ? { decidedBy: 'customer', customerId: actorCustomerId } : {}),
      ...params.metadata,
    },
  });
  return { fromStatus: jobCard.status };
}

/** Staff-initiated status change (hold, resume, cancel, and post-approval stages). */
export async function transitionJobStatus(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  jobCardId: string,
  toStatus: WorkflowStatus,
): Promise<void> {
  const jobCard = await tx.jobCard.findFirst({
    where: { id: jobCardId, organizationId: user.organizationId },
    select: { branchId: true },
  });
  if (!jobCard) throw new NotFoundError('job card');
  requirePermission(user, toStatus === 'DELIVERED' ? 'job_card.close' : 'job_card.edit', {
    branchId: jobCard.branchId,
  });
  await applyJobStatusChange(tx, {
    organizationId: user.organizationId,
    jobCardId,
    toStatus,
    actor: { userId: user.id },
    source: 'manual',
  });
}

export function isOpenJobStatus(status: JobCardStatus): boolean {
  return !CLOSED_JOB_STATUSES.includes(status);
}
