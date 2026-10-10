import { z } from 'zod';
import { suggestOvertimeForDay } from '@/lib/hr/overtime';
import type { Prisma } from '@/generated/prisma/client';
import type { AttendanceStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { localDateString, parseCalendarDate, parseLocalDateTime } from '@/lib/format';

/*
 * Who was in, and when.
 *
 * The workshop's day is a Dubai day — `attendanceDate` is a DATE column, and
 * every "today" here is resolved through `lib/format`, never the server's
 * own clock zone. One row per employee per day is enforced by the database
 * (`@@unique([employeeId, attendanceDate])`), so a technician tapping "Clock
 * in" twice on a patchy connection cannot produce two records.
 *
 * Hours worked are never stored. They are the difference between the two
 * stamps, computed where they are shown — a stored total would be one more
 * thing that can disagree with the times it came from.
 *
 * Nothing here changes how a job card, an invoice or payroll behaves. It
 * records a fact about a day, and that is all.
 */

/** Minutes worked from the two stamps, or null while the day is still open. */
export function minutesWorked(record: {
  clockInAt: Date | null;
  clockOutAt: Date | null;
}): number | null {
  if (!record.clockInAt || !record.clockOutAt) return null;
  return Math.max(0, Math.round((record.clockOutAt.getTime() - record.clockInAt.getTime()) / 60_000));
}

/**
 * A finished day split at the end of the working day (the branch's shift
 * end, Dubai time): hours up to it are normal, hours after it are overtime.
 * Someone who arrived after the shift end worked overtime only. Employees
 * are shown the normal part; overtime is for whoever manages attendance.
 */
export function splitWorked(
  record: { attendanceDate: Date; clockInAt: Date | null; clockOutAt: Date | null },
  shiftEndTime: string,
): { normal: number; overtime: number } | null {
  const total = minutesWorked(record);
  if (total === null || !record.clockInAt || !record.clockOutAt) return null;
  const dateKey = record.attendanceDate.toISOString().slice(0, 10);
  const shiftEnd = new Date(`${dateKey}T${shiftEndTime}:00+04:00`).getTime();
  const overtimeFrom = Math.max(record.clockInAt.getTime(), shiftEnd);
  const overtime = Math.max(0, Math.round((record.clockOutAt.getTime() - overtimeFrom) / 60_000));
  return { normal: Math.max(0, total - overtime), overtime: Math.min(overtime, total) };
}

/** "7h 45m", or "—" for a day that is not finished. */
export function formatWorked(minutes: number | null): string {
  if (minutes === null) return '—';
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export const ATTENDANCE_STATUSES: { value: AttendanceStatus; label: string; detail: string }[] = [
  { value: 'PRESENT', label: 'Present', detail: 'In the workshop for the day.' },
  { value: 'HALF_DAY', label: 'Half day', detail: 'In for part of the day.' },
  { value: 'ABSENT', label: 'Absent', detail: 'Did not come in.' },
  { value: 'ON_LEAVE', label: 'On leave', detail: 'Approved leave.' },
  { value: 'HOLIDAY', label: 'Holiday', detail: 'Workshop closed.' },
];

export const STATUS_LABEL = Object.fromEntries(
  ATTENDANCE_STATUSES.map((s) => [s.value, s.label]),
) as Record<AttendanceStatus, string>;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.')
  .optional();

const markSchema = z.object({
  status: z.enum(['PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'HOLIDAY'], {
    error: 'Choose what to record for the day.',
  }),
  date: dateSchema,
  notes: z.string().trim().max(300, 'Keep the note under 300 characters.').optional(),
  requestKey: z.string().optional(),
});

const clockSchema = z.object({
  date: dateSchema,
  /** Optional override, for a stamp being corrected after the fact. */
  at: z.string().optional(),
  notes: z.string().trim().max(300).optional(),
  requestKey: z.string().optional(),
});

/** A user tied to one branch only ever sees and records that branch's team. */
const branchScope = (user: AuthenticatedUser) =>
  user.primaryBranchId ? { branchId: user.primaryBranchId } : {};

/**
 * The calendar date being worked on. Defaults to today in Dubai, and never
 * accepts a future one — attendance is a record of what happened.
 */
function resolveDate(value: string | undefined): { key: string; date: Date } {
  const key = value ?? localDateString();
  const date = parseCalendarDate(key);
  if (!date) throw new DomainError('Choose a valid date.', 'date');
  if (key > localDateString()) {
    throw new DomainError('Attendance can’t be recorded for a future date.', 'date');
  }
  return { key, date };
}

/** The employee, confirmed as this user's to record against. */
async function loadEmployee(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  employeeId: string,
) {
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, organizationId: user.organizationId, ...branchScope(user) },
    select: {
      id: true,
      branchId: true,
      firstName: true,
      lastName: true,
      isActive: true,
      terminationDate: true,
    },
  });
  // Another organization's or another branch's employee is not found.
  if (!employee) throw new NotFoundError('employee');
  if (!employee.isActive) {
    throw new DomainError('That employee is no longer active. Reactivate them first.');
  }
  return employee;
}

// ─── Reading ────────────────────────────────────────────────────────────────

const recordSelect = {
  id: true,
  employeeId: true,
  attendanceDate: true,
  clockInAt: true,
  clockOutAt: true,
  status: true,
  notes: true,
} satisfies Prisma.AttendanceSelect;

/**
 * One day's roster: every active employee, with their record if one exists.
 *
 * Two queries whatever the size of the team — the employees, and that day's
 * records joined in memory by id. Never a query per person.
 */
export async function getAttendanceDay(user: AuthenticatedUser, dateInput?: string) {
  requirePermission(user, 'attendance.view');
  const { key, date } = resolveDate(dateInput);

  const [employees, records] = await Promise.all([
    prisma.employee.findMany({
      where: { organizationId: user.organizationId, ...branchScope(user), isActive: true },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        branch: { select: { name: true, shiftEndTime: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 500,
    }),
    prisma.attendance.findMany({
      where: { organizationId: user.organizationId, ...branchScope(user), attendanceDate: date },
      select: recordSelect,
    }),
  ]);

  const byEmployee = new Map(records.map((record) => [record.employeeId, record]));
  const rows = employees.map((employee) => {
    const record = byEmployee.get(employee.id) ?? null;
    const worked = record ? minutesWorked(record) : null;
    const split = record ? splitWorked(record, employee.branch.shiftEndTime) : null;
    // Still in after the day ended: overtime so far, for the manager to see.
    const shiftEnd = new Date(`${key}T${employee.branch.shiftEndTime}:00+04:00`).getTime();
    const overtimeSoFar =
      record?.clockInAt && !record.clockOutAt && Date.now() > shiftEnd
        ? Math.round((Date.now() - Math.max(shiftEnd, record.clockInAt.getTime())) / 60_000)
        : 0;
    const overtime = split?.overtime ?? overtimeSoFar;
    return {
      employee: {
        id: employee.id,
        name: `${employee.firstName} ${employee.lastName}`,
        code: employee.employeeCode,
        jobTitle: employee.jobTitle,
        branch: employee.branch.name,
      },
      record,
      worked,
      workedLabel: formatWorked(worked),
      /** Minutes after the end of the working day — managers only. */
      overtime,
      overtimeLabel: overtime > 0 ? formatWorked(overtime) : null,
      shiftEndTime: employee.branch.shiftEndTime,
      /** What the one big button on a phone should do next. */
      next: !record?.clockInAt ? 'IN' : !record.clockOutAt ? 'OUT' : 'DONE',
    } as const;
  });

  const counted = (status: AttendanceStatus) =>
    rows.filter((row) => row.record?.status === status).length;

  return {
    date: key,
    isToday: key === localDateString(),
    rows,
    totals: {
      team: rows.length,
      recorded: rows.filter((row) => row.record).length,
      present: counted('PRESENT') + counted('HALF_DAY'),
      absent: counted('ABSENT'),
      onLeave: counted('ON_LEAVE'),
      stillIn: rows.filter((row) => row.next === 'OUT').length,
      minutes: rows.reduce((sum, row) => sum + (row.worked ?? 0), 0),
      overtime: rows.reduce((sum, row) => sum + row.overtime, 0),
    },
  };
}

export type AttendanceDay = Awaited<ReturnType<typeof getAttendanceDay>>;
export type AttendanceRow = AttendanceDay['rows'][number];

/**
 * One employee's month: every recorded day, with the totals a payroll run
 * will eventually want. Bounded to the month asked for.
 */
export async function getEmployeeAttendance(
  user: AuthenticatedUser,
  employeeId: string,
  month?: string,
) {
  requirePermission(user, 'attendance.view');
  const key = /^\d{4}-\d{2}$/.test(month ?? '') ? month! : localDateString().slice(0, 7);
  const from = parseCalendarDate(`${key}-01`);
  if (!from) throw new DomainError('Choose a valid month.', 'month');
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, organizationId: user.organizationId, ...branchScope(user) },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      jobTitle: true,
      branch: { select: { shiftEndTime: true } },
    },
  });
  if (!employee) throw new NotFoundError('employee');

  const records = await prisma.attendance.findMany({
    where: {
      organizationId: user.organizationId,
      employeeId: employee.id,
      attendanceDate: { gte: from, lte: to },
    },
    select: recordSelect,
    orderBy: { attendanceDate: 'desc' },
  });

  const days = records.map((record) => {
    const worked = minutesWorked(record);
    const overtime = splitWorked(record, employee.branch.shiftEndTime)?.overtime ?? 0;
    return {
      ...record,
      worked,
      workedLabel: formatWorked(worked),
      overtime,
      overtimeLabel: overtime > 0 ? formatWorked(overtime) : null,
    };
  });
  const count = (status: AttendanceStatus) => days.filter((day) => day.status === status).length;

  return {
    employee: {
      id: employee.id,
      firstName: employee.firstName,
      lastName: employee.lastName,
      employeeCode: employee.employeeCode,
      jobTitle: employee.jobTitle,
      name: `${employee.firstName} ${employee.lastName}`,
    },
    shiftEndTime: employee.branch.shiftEndTime,
    month: key,
    days,
    totals: {
      recorded: days.length,
      present: count('PRESENT'),
      halfDay: count('HALF_DAY'),
      absent: count('ABSENT'),
      onLeave: count('ON_LEAVE'),
      holiday: count('HOLIDAY'),
      minutes: days.reduce((sum, day) => sum + (day.worked ?? 0), 0),
      overtime: days.reduce((sum, day) => sum + day.overtime, 0),
    },
  };
}

export type EmployeeAttendance = Awaited<ReturnType<typeof getEmployeeAttendance>>;

// ─── Writing ────────────────────────────────────────────────────────────────

/** The audit trail entry every attendance write shares. */
async function audit(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  employee: { id: string; branchId: string; firstName: string; lastName: string },
  action: string,
  record: { id: string },
  data: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  await writeAuditLog(tx, {
    organizationId: user.organizationId,
    branchId: employee.branchId,
    actorUserId: user.id,
    action,
    entityType: 'Attendance',
    entityId: record.id,
    beforeData: before,
    afterData: { employeeId: employee.id, ...data },
  });
}

/**
 * Starts an employee's day. Idempotent in the way that matters on a phone:
 * an employee already clocked in keeps their original time rather than
 * having it quietly pushed forward by a second tap.
 */
export async function clockIn(user: AuthenticatedUser, employeeId: string, rawInput: unknown = {}) {
  const input = parseInput(clockSchema, rawInput);
  requirePermission(user, 'attendance.create');
  const { key, date } = resolveDate(input.date);
  const at = input.at ? parseLocalDateTime(input.at) : new Date();
  if (!at) throw new DomainError('Enter a valid time.', 'at');
  if (at.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new DomainError('A clock-in can’t be in the future.', 'at');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'attendance.clock_in');
    const employee = await loadEmployee(tx, user, employeeId);

    const existing = await tx.attendance.findUnique({
      where: { employeeId_attendanceDate: { employeeId: employee.id, attendanceDate: date } },
      select: recordSelect,
    });
    if (existing?.clockInAt) {
      throw new DomainError(
        `${employee.firstName} is already clocked in for ${key}.`,
      );
    }

    const record = await tx.attendance.upsert({
      where: { employeeId_attendanceDate: { employeeId: employee.id, attendanceDate: date } },
      update: {
        clockInAt: at,
        status: 'PRESENT',
        clockInMethod: 'STAFF',
        notes: emptyToNull(input.notes) ?? undefined,
      },
      create: {
        organizationId: user.organizationId,
        branchId: employee.branchId,
        employeeId: employee.id,
        attendanceDate: date,
        clockInAt: at,
        status: 'PRESENT',
        clockInMethod: 'STAFF',
        notes: emptyToNull(input.notes),
      },
      select: recordSelect,
    });
    await audit(tx, user, employee, 'attendance.clocked_in', record, {
      date: key,
      clockInAt: at.toISOString(),
    });
    await settleRequestKey(tx, user, rawInput, record.id);
    return record;
  });
}

/**
 * Ends an employee's day. Refused before they have clocked in, and refused
 * if the time is earlier than the clock-in — a negative day is always a
 * mistake, never a fact worth recording.
 */
export async function clockOut(user: AuthenticatedUser, employeeId: string, rawInput: unknown = {}) {
  const input = parseInput(clockSchema, rawInput);
  requirePermission(user, 'attendance.create');
  const { key, date } = resolveDate(input.date);
  const at = input.at ? parseLocalDateTime(input.at) : new Date();
  if (!at) throw new DomainError('Enter a valid time.', 'at');
  if (at.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new DomainError('A clock-out can’t be in the future.', 'at');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'attendance.clock_out');
    const employee = await loadEmployee(tx, user, employeeId);

    const existing = await tx.attendance.findUnique({
      where: { employeeId_attendanceDate: { employeeId: employee.id, attendanceDate: date } },
      select: recordSelect,
    });
    if (!existing?.clockInAt) {
      throw new DomainError(`${employee.firstName} has not clocked in for ${key} yet.`);
    }
    if (existing.clockOutAt) {
      throw new DomainError(`${employee.firstName} has already clocked out for ${key}.`);
    }
    if (at.getTime() < existing.clockInAt.getTime()) {
      throw new DomainError('A clock-out can’t be before the clock-in.', 'at');
    }

    const record = await tx.attendance.update({
      where: { id: existing.id },
      data: {
        clockOutAt: at,
        clockOutMethod: 'STAFF',
        // Closed by someone at the workshop: nothing left to review.
        needsReview: false,
        notes: emptyToNull(input.notes) ?? undefined,
      },
      select: recordSelect,
    });
    await audit(
      tx,
      user,
      employee,
      'attendance.clocked_out',
      record,
      { date: key, clockOutAt: at.toISOString(), minutes: minutesWorked(record) },
      { clockOutAt: null },
    );
    // The day's overtime, suggested for a manager to approve.
    await suggestOvertimeForDay(tx, user.organizationId, record.id);
    await settleRequestKey(tx, user, rawInput, record.id);
    return record;
  });
}

/**
 * Records a day directly — absent, on leave, a holiday, or a correction to
 * what was clocked. Setting a day to anything other than present or half
 * day clears the stamps: a day someone was not here has no hours on it.
 */
export async function markAttendance(
  user: AuthenticatedUser,
  employeeId: string,
  rawInput: unknown,
) {
  const input = parseInput(markSchema, rawInput);
  requirePermission(user, 'attendance.edit');
  const { key, date } = resolveDate(input.date);
  const worked = input.status === 'PRESENT' || input.status === 'HALF_DAY';

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'attendance.mark');
    const employee = await loadEmployee(tx, user, employeeId);

    const before = await tx.attendance.findUnique({
      where: { employeeId_attendanceDate: { employeeId: employee.id, attendanceDate: date } },
      select: recordSelect,
    });

    const record = await tx.attendance.upsert({
      where: { employeeId_attendanceDate: { employeeId: employee.id, attendanceDate: date } },
      update: {
        status: input.status,
        notes: emptyToNull(input.notes),
        // A day recorded by hand is a decision, not something to review.
        needsReview: false,
        reviewedAt: new Date(),
        reviewedByUserId: user.id,
        ...(worked
          ? {}
          : { clockInAt: null, clockOutAt: null, clockInMethod: null, clockOutMethod: null }),
      },
      create: {
        organizationId: user.organizationId,
        branchId: employee.branchId,
        employeeId: employee.id,
        attendanceDate: date,
        status: input.status,
        notes: emptyToNull(input.notes),
      },
      select: recordSelect,
    });
    await audit(
      tx,
      user,
      employee,
      'attendance.marked',
      record,
      { date: key, status: input.status, notes: emptyToNull(input.notes) },
      before ? { status: before.status, notes: before.notes } : undefined,
    );
    await settleRequestKey(tx, user, rawInput, record.id);
    return record;
  });
}
