import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { LeaveStatus, LeaveType } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { leavePosition, proposeSplit } from '@/lib/hr/leave-ledger';

/*
 * Time off.
 *
 * A leave record is a request with a decision: PENDING until someone who may
 * approve payroll says yes or no, then APPROVED or REJECTED. Either side can
 * be withdrawn later as CANCELLED — the row is never deleted, so "why was
 * Ravi off in March" always has an answer.
 *
 * Two rules the database cannot express, enforced here:
 *
 *   - An employee cannot hold two live (pending or approved) leaves that
 *     overlap. Approving is re-checked too, since two pending requests can
 *     overlap each other until one of them is decided.
 *   - Days are counted inclusively in calendar days — 3 to 5 March is three
 *     days. Payroll reads approved UNPAID days from here, so the count is
 *     one function, not two.
 *
 * Nothing here writes attendance. Leave is the plan; attendance is what
 * happened on the day.
 */

export const LEAVE_TYPES: { value: LeaveType; label: string; detail: string }[] = [
  {
    value: 'ANNUAL',
    label: 'Annual',
    detail:
      'Paid from the leave balance (30 days a year after the first year). Days beyond it are unpaid.',
  },
  {
    value: 'SICK',
    label: 'Sick',
    detail: 'After probation: 15 days a year on full pay, 30 on half pay, then unpaid.',
  },
  { value: 'UNPAID', label: 'Unpaid', detail: 'Not paid, and not counted as service.' },
  { value: 'MATERNITY', label: 'Maternity', detail: '45 days on full pay, then 15 on half pay.' },
  {
    value: 'PARENTAL',
    label: 'Parental',
    detail: 'Up to 5 days on full pay, within 6 months of a birth.',
  },
  {
    value: 'BEREAVEMENT',
    label: 'Bereavement',
    detail: 'Up to 5 days on full pay (spouse) or 3 (parent, child, sibling).',
  },
  {
    value: 'STUDY',
    label: 'Study',
    detail: '10 days a year on full pay, after 2 years of service.',
  },
  {
    value: 'OTHER',
    label: 'Other (paid)',
    detail: 'Paid leave the workshop agrees — say why in the reason.',
  },
];

export const LEAVE_TYPE_LABEL = Object.fromEntries(
  LEAVE_TYPES.map((type) => [type.value, type.label]),
) as Record<LeaveType, string>;

export const LEAVE_STATUS_LABEL: Record<LeaveStatus, string> = {
  PENDING: 'Waiting for approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

/** The statuses that still take the employee out of the workshop. */
const LIVE: LeaveStatus[] = ['PENDING', 'APPROVED'];

/** "7 paid · 3 unpaid" — how a leave's days are paid. */
export function payWords(leave: { fullPayDays: number; halfPayDays: number; unpaidDays: number }) {
  return [
    leave.fullPayDays ? `${leave.fullPayDays} paid` : null,
    leave.halfPayDays ? `${leave.halfPayDays} half pay` : null,
    leave.unpaidDays ? `${leave.unpaidDays} unpaid` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The longest single leave the form accepts. Longer is a data-entry slip. */
const MAX_DAYS = 366;

const DAY_MS = 86_400_000;

/** Calendar days from start to end, both included. */
export function leaveDays(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

/**
 * How many days of [start, end] fall inside [from, to], both inclusive —
 * zero when they don't meet.
 */
export function overlapDays(start: Date, end: Date, from: Date, to: Date): number {
  const first = Math.max(start.getTime(), from.getTime());
  const last = Math.min(end.getTime(), to.getTime());
  return last < first ? 0 : Math.round((last - first) / DAY_MS) + 1;
}

const date = (message: string) =>
  z
    .string({ error: message })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, message);

const requestSchema = z.object({
  employeeId: z
    .string({ error: 'Choose who is taking the leave.' })
    .trim()
    .min(1, 'Choose who is taking the leave.'),
  leaveType: z.enum(
    ['ANNUAL', 'SICK', 'UNPAID', 'OTHER', 'MATERNITY', 'PARENTAL', 'BEREAVEMENT', 'STUDY'],
    { error: 'Choose the kind of leave.' },
  ),
  startDate: date('Choose the first day of leave.'),
  endDate: date('Choose the last day of leave.'),
  reason: z.string().trim().max(500, 'Keep the reason under 500 characters.').optional(),
  /** Record and approve in one step — only honoured for someone who may approve. */
  approveNow: z.enum(['on', 'true', 'false', '']).optional(),
  requestKey: z.string().optional(),
});

const reasonSchema = z.object({
  reason: z.string().trim().max(500, 'Keep the reason under 500 characters.').optional(),
  requestKey: z.string().optional(),
});

/** A user tied to one branch only sees and records that branch's team. */
const branchScope = (user: AuthenticatedUser): Prisma.EmployeeWhereInput =>
  user.primaryBranchId ? { branchId: user.primaryBranchId } : {};

const name = (employee: { firstName: string; lastName: string }) =>
  `${employee.firstName} ${employee.lastName}`.trim();

/** Refuses a leave that overlaps another live one for the same person. */
async function assertNoOverlap(
  tx: Prisma.TransactionClient,
  organizationId: string,
  employeeId: string,
  start: Date,
  end: Date,
  statuses: LeaveStatus[],
  exceptId?: string,
) {
  const clash = await tx.leave.findFirst({
    where: {
      organizationId,
      employeeId,
      status: { in: statuses },
      startDate: { lte: end },
      endDate: { gte: start },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { startDate: true, endDate: true, status: true },
  });
  if (clash) {
    const when =
      clash.startDate.getTime() === clash.endDate.getTime()
        ? clash.startDate.toISOString().slice(0, 10)
        : `${clash.startDate.toISOString().slice(0, 10)} to ${clash.endDate.toISOString().slice(0, 10)}`;
    throw new DomainError(
      `This overlaps ${clash.status === 'APPROVED' ? 'approved' : 'requested'} leave (${when}). Change the dates or cancel that one first.`,
      'startDate',
    );
  }
}

async function audit(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  branchId: string,
  action: string,
  leaveId: string,
  afterData: Record<string, unknown>,
  beforeData?: Record<string, unknown>,
  metadata?: Record<string, unknown>,
) {
  await writeAuditLog(tx, {
    organizationId: user.organizationId,
    branchId,
    actorUserId: user.id,
    action,
    entityType: 'Leave',
    entityId: leaveId,
    beforeData,
    afterData,
    metadata,
  });
}

// ─── Writing ────────────────────────────────────────────────────────────────

/**
 * Records a leave request. Someone who may approve payroll can approve it in
 * the same step — the common case in a small workshop, where the manager
 * entering the leave is the one who agreed to it.
 */
export async function requestLeave(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(requestSchema, rawInput);
  requirePermission(user, 'leave.create');
  const start = parseCalendarDate(input.startDate);
  const end = parseCalendarDate(input.endDate);
  if (!start) throw new DomainError('Choose the first day of leave.', 'startDate');
  if (!end) throw new DomainError('Choose the last day of leave.', 'endDate');
  if (end < start) throw new DomainError('The last day is before the first day.', 'endDate');
  if (leaveDays(start, end) > MAX_DAYS) {
    throw new DomainError('A single leave can be at most a year. Split it up.', 'endDate');
  }
  const approveNow =
    (input.approveNow === 'on' || input.approveNow === 'true') &&
    hasPermission(user, 'leave.approve');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'leave.request');
    const employee = await tx.employee.findFirst({
      where: { id: input.employeeId, organizationId: user.organizationId, ...branchScope(user) },
      select: {
        id: true,
        branchId: true,
        firstName: true,
        lastName: true,
        isActive: true,
        hireDate: true,
        probationEndDate: true,
        leaveOpeningDays: true,
        leaveOpeningAsOf: true,
      },
    });
    if (!employee) throw new NotFoundError('employee');
    if (!employee.isActive) {
      throw new DomainError(`${name(employee)} is no longer active.`, 'employeeId');
    }
    await assertNoOverlap(tx, user.organizationId, employee.id, start, end, LIVE);
    // How the days are paid — full, half, unpaid — under the leave rules.
    const split = await proposeSplit(
      tx,
      user.organizationId,
      employee.id,
      employee,
      input.leaveType,
      input.startDate,
      input.endDate,
    );

    const leave = await tx.leave.create({
      data: {
        organizationId: user.organizationId,
        employeeId: employee.id,
        leaveType: input.leaveType,
        startDate: start,
        endDate: end,
        reason: emptyToNull(input.reason),
        fullPayDays: split.full,
        halfPayDays: split.half,
        unpaidDays: split.unpaid,
        status: approveNow ? 'APPROVED' : 'PENDING',
        approvedByUserId: approveNow ? user.id : null,
        approvedAt: approveNow ? new Date() : null,
      },
    });
    await audit(tx, user, employee.branchId, 'leave.requested', leave.id, {
      employeeId: employee.id,
      leaveType: leave.leaveType,
      startDate: input.startDate,
      endDate: input.endDate,
      days: leaveDays(start, end),
      fullPayDays: split.full,
      halfPayDays: split.half,
      unpaidDays: split.unpaid,
      status: leave.status,
      reason: leave.reason,
    });
    await settleRequestKey(tx, user, rawInput, leave.id);
    return { ...leave, payNote: split.note };
  });
}

/** Approves or rejects a pending request. The decider is recorded either way. */
export async function decideLeave(
  user: AuthenticatedUser,
  leaveId: string,
  decision: 'APPROVED' | 'REJECTED',
  rawInput: unknown = {},
) {
  const input = parseInput(reasonSchema, rawInput);
  requirePermission(user, 'leave.approve');

  return prisma.$transaction(async (tx) => {
    const leave = await tx.leave.findFirst({
      where: { id: leaveId, organizationId: user.organizationId, employee: branchScope(user) },
      include: {
        employee: {
          select: {
            branchId: true,
            hireDate: true,
            probationEndDate: true,
            leaveOpeningDays: true,
            leaveOpeningAsOf: true,
          },
        },
      },
    });
    if (!leave) throw new NotFoundError('leave');
    if (leave.status !== 'PENDING') {
      throw new DomainError(
        `This leave is already ${LEAVE_STATUS_LABEL[leave.status].toLowerCase()}.`,
      );
    }
    if (decision === 'APPROVED') {
      // Two pending requests may overlap; only one of them can be approved.
      await assertNoOverlap(
        tx,
        user.organizationId,
        leave.employeeId,
        leave.startDate,
        leave.endDate,
        ['APPROVED'],
        leave.id,
      );
    }
    // Approving re-decides how the days are paid: the balance may have
    // changed since the request.
    const split =
      decision === 'APPROVED'
        ? await proposeSplit(
            tx,
            user.organizationId,
            leave.employeeId,
            leave.employee,
            leave.leaveType,
            leave.startDate.toISOString().slice(0, 10),
            leave.endDate.toISOString().slice(0, 10),
            { exceptLeaveId: leave.id },
          )
        : null;
    // Guarded on the status it was read with, so two managers deciding at
    // once cannot both win.
    const updated = await tx.leave.updateMany({
      where: { id: leave.id, status: 'PENDING' },
      data: {
        status: decision,
        approvedByUserId: user.id,
        approvedAt: new Date(),
        ...(split
          ? { fullPayDays: split.full, halfPayDays: split.half, unpaidDays: split.unpaid }
          : {}),
      },
    });
    if (updated.count === 0) throw new DomainError('Someone else decided this leave just now.');
    await audit(
      tx,
      user,
      leave.employee.branchId,
      decision === 'APPROVED' ? 'leave.approved' : 'leave.rejected',
      leave.id,
      split
        ? {
            status: decision,
            fullPayDays: split.full,
            halfPayDays: split.half,
            unpaidDays: split.unpaid,
          }
        : { status: decision },
      { status: leave.status },
      input.reason ? { reason: input.reason } : undefined,
    );
    return { id: leave.id, status: decision };
  });
}

/**
 * Withdraws a pending or approved leave. Cancelling approved leave needs the
 * same authority that approved it; a pending request can be withdrawn by
 * whoever may record leave.
 */
export async function cancelLeave(
  user: AuthenticatedUser,
  leaveId: string,
  rawInput: unknown = {},
) {
  const input = parseInput(reasonSchema, rawInput);
  requirePermission(user, 'leave.delete');

  return prisma.$transaction(async (tx) => {
    const leave = await tx.leave.findFirst({
      where: { id: leaveId, organizationId: user.organizationId, employee: branchScope(user) },
      include: { employee: { select: { branchId: true } } },
    });
    if (!leave) throw new NotFoundError('leave');
    if (!LIVE.includes(leave.status)) {
      throw new DomainError(
        `This leave is already ${LEAVE_STATUS_LABEL[leave.status].toLowerCase()}.`,
      );
    }
    if (leave.status === 'APPROVED') requirePermission(user, 'leave.approve');

    const updated = await tx.leave.updateMany({
      where: { id: leave.id, status: leave.status },
      data: { status: 'CANCELLED' },
    });
    if (updated.count === 0) throw new DomainError('Someone else changed this leave just now.');
    await audit(
      tx,
      user,
      leave.employee.branchId,
      'leave.cancelled',
      leave.id,
      { status: 'CANCELLED' },
      { status: leave.status },
      input.reason ? { reason: input.reason } : undefined,
    );
    return { id: leave.id, status: 'CANCELLED' as const };
  });
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface LeaveFilters {
  status?: string;
  type?: string;
  employeeId?: string;
  query?: string;
}

/** Leave for the filters given, newest first, with the figures the page opens on. */
export async function listLeave(user: AuthenticatedUser, filters: LeaveFilters = {}) {
  requirePermission(user, 'leave.view');
  const organizationId = user.organizationId;
  const today = parseCalendarDate(localDateString())!;
  const in30 = new Date(today.getTime() + 30 * DAY_MS);
  const status = isStatus(filters.status) ? filters.status : undefined;
  const type = isType(filters.type) ? filters.type : undefined;
  const q = filters.query?.trim();
  const employeeScope: Prisma.EmployeeWhereInput = {
    ...branchScope(user),
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { employeeCode: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, pending, offToday, upcoming] = await Promise.all([
    prisma.leave.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
        ...(type ? { leaveType: type } : {}),
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
        employee: employeeScope,
      },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
      take: 300,
      include: {
        employee: {
          select: { id: true, firstName: true, lastName: true, employeeCode: true, jobTitle: true },
        },
        approvedBy: { select: { fullName: true } },
      },
    }),
    prisma.leave.count({
      where: { organizationId, status: 'PENDING', employee: branchScope(user) },
    }),
    prisma.leave.findMany({
      where: {
        organizationId,
        status: 'APPROVED',
        startDate: { lte: today },
        endDate: { gte: today },
        employee: branchScope(user),
      },
      select: { employee: { select: { firstName: true, lastName: true } } },
    }),
    prisma.leave.count({
      where: {
        organizationId,
        status: 'APPROVED',
        startDate: { gt: today, lte: in30 },
        employee: branchScope(user),
      },
    }),
  ]);

  return {
    rows: rows.map((leave) => ({
      ...leave,
      employeeName: name(leave.employee),
      days: leaveDays(leave.startDate, leave.endDate),
      /** How the days are paid, in words — "7 paid · 3 unpaid". */
      pay: payWords(leave),
      /** Today falls inside an approved leave. */
      isCurrent: leave.status === 'APPROVED' && leave.startDate <= today && leave.endDate >= today,
    })),
    totals: {
      pending,
      offToday: offToday.length,
      offTodayNames: offToday.map((leave) => name(leave.employee)),
      upcoming,
    },
  };
}

export type LeaveRow = Awaited<ReturnType<typeof listLeave>>['rows'][number];

function isStatus(value: string | undefined): value is LeaveStatus {
  return (
    value === 'PENDING' || value === 'APPROVED' || value === 'REJECTED' || value === 'CANCELLED'
  );
}

function isType(value: string | undefined): value is LeaveType {
  return LEAVE_TYPES.some((type) => type.value === value);
}

/** Active employees this user may record leave for. */
export async function getLeaveFormOptions(user: AuthenticatedUser) {
  requirePermission(user, 'leave.create');
  const employees = await prisma.employee.findMany({
    where: { organizationId: user.organizationId, isActive: true, ...branchScope(user) },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    select: { id: true, firstName: true, lastName: true, employeeCode: true },
  });
  return {
    employees: employees.map((employee) => ({
      id: employee.id,
      name: name(employee),
      code: employee.employeeCode,
    })),
    canApprove: hasPermission(user, 'leave.approve'),
  };
}

/**
 * Approved leave days per employee and type inside [from, to] — what a
 * payroll run needs. One query for the whole team. With `employed`, each
 * person's days are counted only while they were employed: unpaid leave
 * running past a leaving date is not deducted from the last wages.
 */
export async function approvedLeaveDays(
  client: Prisma.TransactionClient,
  organizationId: string,
  employeeIds: string[],
  from: Date,
  to: Date,
  employed?: Map<string, { from: Date; to: Date }>,
) {
  const leaves = await client.leave.findMany({
    where: {
      organizationId,
      employeeId: { in: employeeIds },
      status: 'APPROVED',
      startDate: { lte: to },
      endDate: { gte: from },
    },
    select: { employeeId: true, leaveType: true, startDate: true, endDate: true },
  });
  const result = new Map<string, Record<LeaveType, number>>();
  for (const leave of leaves) {
    const window = employed?.get(leave.employeeId);
    const windowFrom = window && window.from > from ? window.from : from;
    const windowTo = window && window.to < to ? window.to : to;
    const days =
      windowTo < windowFrom ? 0 : overlapDays(leave.startDate, leave.endDate, windowFrom, windowTo);
    const entry =
      result.get(leave.employeeId) ??
      (Object.fromEntries(LEAVE_TYPES.map((type) => [type.value, 0])) as Record<LeaveType, number>);
    entry[leave.leaveType] += days;
    result.set(leave.employeeId, entry);
  }
  return result;
}

/**
 * One employee's annual leave and service as of today (or their leaving
 * day): earned, taken, left, what is still building up in the first six
 * months, and the paid sick days used this year.
 */
export async function getEmployeeLeaveSummary(user: AuthenticatedUser, employeeId: string) {
  requirePermission(user, 'leave.view');
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, organizationId: user.organizationId },
    select: {
      id: true,
      hireDate: true,
      terminationDate: true,
      probationEndDate: true,
      leaveOpeningDays: true,
      leaveOpeningAsOf: true,
    },
  });
  if (!employee) throw new NotFoundError('employee');
  const today = localDateString();
  const asOf =
    employee.terminationDate && employee.terminationDate.toISOString().slice(0, 10) < today
      ? employee.terminationDate.toISOString().slice(0, 10)
      : today;
  const position = await prisma.$transaction((tx) =>
    leavePosition(tx, user.organizationId, employee.id, employee, asOf),
  );
  const sick = position.usedOf('SICK');
  return {
    asOf,
    serviceDays: position.serviceDays,
    calendarDays:
      Math.round((parseCalendarDate(asOf)!.getTime() - employee.hireDate.getTime()) / DAY_MS) + 1,
    inProbation: position.inProbation,
    probationEnd: position.probationEnd,
    annual: position.annual,
    sickFullUsed: sick.full,
    sickHalfUsed: sick.half,
  };
}
