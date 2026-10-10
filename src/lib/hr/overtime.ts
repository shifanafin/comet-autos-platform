import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { OvertimeKind, OvertimeStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { suggestOvertime } from '@/lib/hr/leave-rules';

/*
 * Overtime (Labour Law Art. 17-19, 28): hours beyond the normal day are paid
 * at +25%; between 22:00 and 04:00, on the weekly rest day or a public
 * holiday at +50%. At most 2 hours a day beyond the normal day, except in
 * emergencies — the screen flags more.
 *
 * When someone checks out, the app suggests the overtime the day shows
 * (lib/hr/leave-rules.ts suggestOvertime) as PENDING. A manager approves,
 * changes or rejects each; payroll pays only approved hours. An entry in a
 * month whose payroll is approved can no longer change.
 */

export const OVERTIME_KIND_LABEL: Record<OvertimeKind, string> = {
  NORMAL: 'Working day (+25%)',
  NIGHT: 'Night, 22:00–04:00 (+50%)',
  REST_DAY: 'Rest day (+50%)',
  HOLIDAY: 'Public holiday (+50%)',
};

export const OVERTIME_STATUS_LABEL: Record<OvertimeStatus, string> = {
  PENDING: 'Waiting for approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

/** Overtime beyond this many hours a day is allowed only in emergencies (Art. 19). */
export const DAILY_OVERTIME_LIMIT = 2;

const day = (date: Date) => date.toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00Z`);

/** Refuses changing overtime in a month whose payroll is approved or paid. */
async function assertMonthOpen(
  tx: Prisma.TransactionClient,
  organizationId: string,
  workDate: Date,
) {
  const run = await tx.payroll.findFirst({
    where: {
      organizationId,
      status: { in: ['APPROVED', 'PAID'] },
      periodStart: { lte: workDate },
      periodEnd: { gte: workDate },
    },
    select: { id: true },
  });
  if (run) {
    throw new DomainError('That month’s payroll is approved: its overtime can no longer change.');
  }
}

/**
 * Suggests the overtime a checked-out day shows. Replaces earlier suggestions
 * for that day that nobody has decided; never touches approved, rejected or
 * hand-entered hours.
 */
export async function suggestOvertimeForDay(
  tx: Prisma.TransactionClient,
  organizationId: string,
  attendanceId: string,
) {
  const record = await tx.attendance.findFirst({
    where: { id: attendanceId, organizationId },
    select: {
      employeeId: true,
      attendanceDate: true,
      clockInAt: true,
      clockOutAt: true,
      employee: { select: { normalHoursPerDay: true } },
    },
  });
  if (!record?.clockInAt || !record.clockOutAt) return [];
  const date = day(record.attendanceDate);
  const [organization, holiday] = await Promise.all([
    tx.organization.findUnique({ where: { id: organizationId }, select: { weeklyRestDay: true } }),
    tx.publicHoliday.findFirst({
      where: { organizationId, holidayDate: record.attendanceDate },
      select: { id: true },
    }),
  ]);
  const restDay =
    organization?.weeklyRestDay !== null &&
    organization?.weeklyRestDay !== undefined &&
    record.attendanceDate.getUTCDay() === organization.weeklyRestDay;
  const suggested = suggestOvertime({
    clockIn: record.clockInAt,
    clockOut: record.clockOutAt,
    normalHoursPerDay: Number(record.employee.normalHoursPerDay.toString()),
    restDay,
    holiday: Boolean(holiday),
  });

  // Earlier undecided suggestions for the day give way to the new ones.
  await tx.overtimeEntry.deleteMany({
    where: {
      organizationId,
      employeeId: record.employeeId,
      workDate: asDate(date),
      source: 'AUTO',
      status: 'PENDING',
    },
  });
  for (const entry of suggested) {
    const taken = await tx.overtimeEntry.findFirst({
      where: {
        organizationId,
        employeeId: record.employeeId,
        workDate: asDate(date),
        kind: entry.kind,
      },
      select: { id: true },
    });
    if (taken) continue; // decided or hand-entered: left alone
    await tx.overtimeEntry.create({
      data: {
        organizationId,
        employeeId: record.employeeId,
        workDate: asDate(date),
        kind: entry.kind,
        hours: entry.hours.toFixed(2),
        source: 'AUTO',
        note:
          entry.hours > DAILY_OVERTIME_LIMIT && entry.kind === 'NORMAL'
            ? `More than ${DAILY_OVERTIME_LIMIT} hours: allowed only in an emergency.`
            : null,
      },
    });
  }
  return suggested;
}

const decideSchema = z.object({
  hours: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^\d{1,2}(\.\d{1,2})?$/.test(v), 'Enter hours like 1.5.'),
  note: z.string().trim().max(300).optional(),
  requestKey: z.string().optional(),
});

/** Approves (optionally with corrected hours) or rejects an overtime entry. */
export async function decideOvertime(
  user: AuthenticatedUser,
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  rawInput: unknown = {},
) {
  const input = parseInput(decideSchema, rawInput);
  requirePermission(user, 'payroll.edit');
  return prisma.$transaction(async (tx) => {
    const entry = await tx.overtimeEntry.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { employee: { select: { branchId: true } } },
    });
    if (!entry) throw new NotFoundError('overtime');
    await assertMonthOpen(tx, user.organizationId, entry.workDate);
    const hours = input.hours ? Number(input.hours) : Number(entry.hours.toString());
    if (decision === 'APPROVED' && (hours <= 0 || hours > 24)) {
      throw new DomainError('Enter the hours worked, more than 0.', 'hours');
    }
    const updated = await tx.overtimeEntry.update({
      where: { id: entry.id },
      data: {
        status: decision,
        hours: hours.toFixed(2),
        note: emptyToNull(input.note) ?? entry.note,
        decidedByUserId: user.id,
        decidedAt: new Date(),
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: entry.employee.branchId,
      actorUserId: user.id,
      action: decision === 'APPROVED' ? 'overtime.approved' : 'overtime.rejected',
      entityType: 'OvertimeEntry',
      entityId: entry.id,
      beforeData: { status: entry.status, hours: entry.hours.toString() },
      afterData: { status: decision, hours: updated.hours.toString() },
    });
    return updated;
  });
}

const addSchema = z.object({
  employeeId: z.string({ error: 'Choose who worked it.' }).trim().min(1, 'Choose who worked it.'),
  workDate: z
    .string({ error: 'Choose the day.' })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the day.'),
  kind: z.enum(['NORMAL', 'NIGHT', 'REST_DAY', 'HOLIDAY'], { error: 'Choose the kind.' }),
  hours: z
    .string({ error: 'Enter the hours.' })
    .trim()
    .regex(/^\d{1,2}(\.\d{1,2})?$/, 'Enter hours like 1.5.'),
  note: z.string().trim().max(300).optional(),
  requestKey: z.string().optional(),
});

/** Records overtime by hand — approved, since the manager entering it agreed it. */
export async function addOvertime(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(addSchema, rawInput);
  requirePermission(user, 'payroll.edit');
  const workDate = parseCalendarDate(input.workDate);
  if (!workDate) throw new DomainError('Choose the day.', 'workDate');
  if (input.workDate > localDateString())
    throw new DomainError('That day hasn’t come yet.', 'workDate');
  const hours = Number(input.hours);
  if (hours <= 0 || hours > 24)
    throw new DomainError('Enter the hours worked, more than 0.', 'hours');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'overtime.add');
    const employee = await tx.employee.findFirst({
      where: { id: input.employeeId, organizationId: user.organizationId },
      select: { id: true, branchId: true },
    });
    if (!employee) throw new NotFoundError('employee');
    await assertMonthOpen(tx, user.organizationId, workDate);
    const clash = await tx.overtimeEntry.findFirst({
      where: {
        organizationId: user.organizationId,
        employeeId: employee.id,
        workDate,
        kind: input.kind,
      },
      select: { id: true, status: true, source: true },
    });
    if (clash && !(clash.source === 'AUTO' && clash.status === 'PENDING')) {
      throw new DomainError(
        'That day already has overtime of this kind. Change that one instead.',
        'workDate',
      );
    }
    if (clash) await tx.overtimeEntry.delete({ where: { id: clash.id } });
    const entry = await tx.overtimeEntry.create({
      data: {
        organizationId: user.organizationId,
        employeeId: employee.id,
        workDate,
        kind: input.kind,
        hours: hours.toFixed(2),
        status: 'APPROVED',
        source: 'MANUAL',
        note: emptyToNull(input.note),
        decidedByUserId: user.id,
        decidedAt: new Date(),
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: employee.branchId,
      actorUserId: user.id,
      action: 'overtime.added',
      entityType: 'OvertimeEntry',
      entityId: entry.id,
      afterData: { employeeId: employee.id, workDate: input.workDate, kind: input.kind, hours },
    });
    await settleRequestKey(tx, user, rawInput, entry.id);
    return entry;
  });
}

/** Overtime for a month (default: this one), pending first, with the people and the rest-day setting. */
export async function listOvertime(user: AuthenticatedUser, month?: string) {
  requirePermission(user, 'payroll.view');
  const target = month && /^\d{4}-\d{2}$/.test(month) ? month : localDateString().slice(0, 7);
  const [year, monthIndex] = target.split('-').map(Number);
  const start = new Date(Date.UTC(year, monthIndex - 1, 1));
  const end = new Date(Date.UTC(year, monthIndex, 0));
  const [entries, employees, organization, holidays] = await Promise.all([
    prisma.overtimeEntry.findMany({
      where: { organizationId: user.organizationId, workDate: { gte: start, lte: end } },
      orderBy: [{ status: 'asc' }, { workDate: 'asc' }],
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        decidedBy: { select: { fullName: true } },
      },
    }),
    prisma.employee.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, employeeCode: true },
    }),
    prisma.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
      select: { weeklyRestDay: true },
    }),
    prisma.publicHoliday.findMany({
      where: {
        organizationId: user.organizationId,
        holidayDate: { gte: new Date(Date.UTC(year, 0, 1)) },
      },
      orderBy: { holidayDate: 'asc' },
      select: { id: true, holidayDate: true, name: true },
    }),
  ]);
  return { month: target, entries, employees, weeklyRestDay: organization.weeklyRestDay, holidays };
}

// ─── Rest day and public holidays ───────────────────────────────────────────

const restDaySchema = z.object({
  weeklyRestDay: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[0-6]$/.test(v), 'Choose a day.'),
  requestKey: z.string().optional(),
});

/** The weekly rest day: overtime that day is paid at the rest-day rate. */
export async function setWeeklyRestDay(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(restDaySchema, rawInput);
  requirePermission(user, 'settings.edit');
  const value = input.weeklyRestDay ? Number(input.weeklyRestDay) : null;
  await prisma.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: user.organizationId },
      data: { weeklyRestDay: value },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'organization.rest_day_set',
      entityType: 'Organization',
      entityId: user.organizationId,
      afterData: { weeklyRestDay: value },
    });
  });
}

const holidaySchema = z.object({
  holidayDate: z
    .string({ error: 'Choose the date.' })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the date.'),
  name: z.string({ error: 'Name the holiday.' }).trim().min(2, 'Name the holiday.').max(80),
  requestKey: z.string().optional(),
});

/** Adds a public holiday (Eid al-Fitr, National Day…): paid; work on it is holiday overtime. */
export async function addPublicHoliday(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(holidaySchema, rawInput);
  requirePermission(user, 'settings.edit');
  const holidayDate = parseCalendarDate(input.holidayDate)!;
  return prisma.$transaction(async (tx) => {
    const taken = await tx.publicHoliday.findFirst({
      where: { organizationId: user.organizationId, holidayDate },
      select: { id: true },
    });
    if (taken) throw new DomainError('That day is already a holiday.', 'holidayDate');
    const holiday = await tx.publicHoliday.create({
      data: { organizationId: user.organizationId, holidayDate, name: input.name },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'holiday.added',
      entityType: 'PublicHoliday',
      entityId: holiday.id,
      afterData: { holidayDate: input.holidayDate, name: input.name },
    });
    return holiday;
  });
}

export async function removePublicHoliday(user: AuthenticatedUser, id: string) {
  requirePermission(user, 'settings.edit');
  return prisma.$transaction(async (tx) => {
    const holiday = await tx.publicHoliday.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!holiday) throw new NotFoundError('holiday');
    await tx.publicHoliday.delete({ where: { id: holiday.id } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'holiday.removed',
      entityType: 'PublicHoliday',
      entityId: holiday.id,
      beforeData: { holidayDate: day(holiday.holidayDate), name: holiday.name },
    });
    return { id: holiday.id };
  });
}

/** Overtime waiting for a decision, before a month's payroll — for reminders. */
export async function pendingOvertimeCount(organizationId: string) {
  return prisma.overtimeEntry.count({ where: { organizationId, status: 'PENDING' } });
}
