import type { JobCardStatus } from '@/generated/prisma/enums';

// Pure data/helpers only — no auth/session imports — so Client Components
// can import this without pulling server-only code into the client bundle.
// lib/workshop/job-status.ts re-exports these for server-side callers.

/** Statuses the application writes today. */
export type WorkflowStatus = Exclude<
  JobCardStatus,
  'RECEIVED' | 'INSPECTING' | 'DIAGNOSED' | 'ESTIMATE_SENT' | 'IN_PROGRESS' | 'COMPLETED' | 'CLOSED'
>;

/**
 * Legacy V1 statuses → their workflow equivalent. Live job cards were
 * migrated off these; they only still appear in the append-only
 * JobStatusHistory, which is read through this map.
 */
export const LEGACY_STATUS_MAP: Partial<Record<JobCardStatus, WorkflowStatus>> = {
  RECEIVED: 'ARRIVED',
  INSPECTING: 'INSPECTION',
  DIAGNOSED: 'DIAGNOSIS',
  ESTIMATE_SENT: 'WAITING_APPROVAL',
  IN_PROGRESS: 'REPAIR',
  COMPLETED: 'READY',
  CLOSED: 'DELIVERED',
};

export function normalizeStatus(status: JobCardStatus): WorkflowStatus {
  return LEGACY_STATUS_MAP[status] ?? (status as WorkflowStatus);
}

export interface WorkflowStage {
  key: string;
  label: string;
  status: WorkflowStatus;
}

/**
 * The forward path shown by the stepper and the dashboard pipeline.
 * REJECTED, ON_HOLD and CANCELLED are branches off this path, not steps on it.
 */
export const WORKFLOW_STAGES: WorkflowStage[] = [
  { key: 'arrived', label: 'Arrived', status: 'ARRIVED' },
  { key: 'inspection', label: 'Inspection', status: 'INSPECTION' },
  { key: 'diagnosis', label: 'Diagnosis', status: 'DIAGNOSIS' },
  { key: 'estimate', label: 'Estimate', status: 'ESTIMATE' },
  { key: 'waiting', label: 'Waiting approval', status: 'WAITING_APPROVAL' },
  { key: 'approved', label: 'Approved', status: 'APPROVED' },
  { key: 'repair', label: 'Repair', status: 'REPAIR' },
  { key: 'qc', label: 'Quality check', status: 'QUALITY_CHECK' },
  { key: 'ready', label: 'Ready', status: 'READY' },
  { key: 'invoiced', label: 'Invoiced', status: 'INVOICED' },
  { key: 'paid', label: 'Paid', status: 'PAID' },
  { key: 'delivered', label: 'Delivered', status: 'DELIVERED' },
];

/**
 * The simple job card's path through WORKFLOW_STAGES: in, optionally
 * quoted, billed, paid, handed back. Screens that list stages show only
 * these when the workshop uses the simple job card.
 */
export const SIMPLE_WORKFLOW_STATUSES: WorkflowStatus[] = [
  'ARRIVED',
  'ESTIMATE',
  'WAITING_APPROVAL',
  'APPROVED',
  'INVOICED',
  'PAID',
  'DELIVERED',
];

/**
 * The stages to show for the workshop's job card style. A simple workshop
 * still sees a detailed stage while a job is sitting in it — say, one left
 * over from before it switched — so no job ever drops out of sight.
 */
export function visibleStages<T extends { status: WorkflowStatus; count?: number }>(
  stages: T[],
  detailed: boolean,
): T[] {
  if (detailed) return stages;
  return stages.filter((stage) => SIMPLE_WORKFLOW_STATUSES.includes(stage.status) || (stage.count ?? 0) > 0);
}

const WORKFLOW_LABEL: Record<WorkflowStatus, string> = {
  ARRIVED: 'Arrived',
  INSPECTION: 'In inspection',
  DIAGNOSIS: 'Diagnosed',
  ESTIMATE: 'Estimate in progress',
  WAITING_APPROVAL: 'Waiting approval',
  APPROVED: 'Approved',
  REJECTED: 'Estimate rejected',
  REPAIR: 'In repair',
  QUALITY_CHECK: 'Quality check',
  READY: 'Ready for collection',
  INVOICED: 'Invoiced',
  PAID: 'Paid',
  DELIVERED: 'Delivered',
  ON_HOLD: 'On hold',
  CANCELLED: 'Cancelled',
};

/** Labels for every enum value, legacy ones shown as their workflow equivalent. */
export const JOB_STATUS_LABEL: Record<JobCardStatus, string> = {
  ...WORKFLOW_LABEL,
  RECEIVED: WORKFLOW_LABEL.ARRIVED,
  INSPECTING: WORKFLOW_LABEL.INSPECTION,
  DIAGNOSED: WORKFLOW_LABEL.DIAGNOSIS,
  ESTIMATE_SENT: WORKFLOW_LABEL.WAITING_APPROVAL,
  IN_PROGRESS: WORKFLOW_LABEL.REPAIR,
  COMPLETED: WORKFLOW_LABEL.READY,
  CLOSED: WORKFLOW_LABEL.DELIVERED,
};

/** A job is "in the workshop" until it is delivered or cancelled. */
export const CLOSED_JOB_STATUSES: JobCardStatus[] = ['DELIVERED', 'CANCELLED', 'CLOSED'];

const OFF_PATH: JobCardStatus[] = ['ON_HOLD', 'CANCELLED', 'REJECTED'];

/**
 * The forward-path stage a job "is at" for the stepper. ON_HOLD, CANCELLED
 * and REJECTED have no stepper position, so this walks the status history
 * (most-recent first) to the last on-path stage. Legacy history values are
 * normalized.
 */
export function getEffectiveStageStatus(
  currentStatus: JobCardStatus,
  history: { toStatus: JobCardStatus }[],
): WorkflowStatus {
  const current = normalizeStatus(currentStatus);
  if (current === 'REJECTED') return 'WAITING_APPROVAL';
  if (!OFF_PATH.includes(current)) return current;
  const lastOnPath = history.map((entry) => normalizeStatus(entry.toStatus)).find((s) => !OFF_PATH.includes(s));
  return lastOnPath ?? 'ARRIVED';
}

/** Where an ON_HOLD job resumes: the last status it held before the hold (REJECTED included). */
export function getResumeTarget(history: { toStatus: JobCardStatus }[]): WorkflowStatus {
  const last = history
    .map((entry) => normalizeStatus(entry.toStatus))
    .find((s) => s !== 'ON_HOLD' && s !== 'CANCELLED');
  return last ?? 'ARRIVED';
}
