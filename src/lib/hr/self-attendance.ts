import { z } from 'zod';
import { suggestOvertimeForDay } from '@/lib/hr/overtime';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { formatTime, localDateString, parseCalendarDate } from '@/lib/format';
import { getBranchLocation } from '@/lib/organization/branches';
import { checkFence, dubaiTimeOn, formatDistance, MAX_ACCURACY_M } from '@/lib/team/geo';
import { formatWorked, minutesWorked, splitWorked } from '@/lib/hr/attendance';

/*
 * Checking yourself in and out, on your own phone, at the workshop.
 *
 * The person is whoever is signed in — their Employee row is found through
 * the login (Employee.userId), never taken from the request. The phone sends
 * where it is; the server measures that against the branch's location lock
 * and refuses anything outside it, or anything too imprecise to tell.
 *
 * A forgotten check-out is handled without inventing hours quietly:
 *
 *  - the next time they check in, the open day is closed at the shift end
 *    (or at the check-in, for someone who arrived after it — a zero-hour
 *    day), marked AUTO and flagged for review;
 *  - or, before that, they can say what time they left — from anywhere,
 *    since they are no longer at the workshop. That is marked REPORTED and
 *    flagged for review too;
 *  - someone with attendance.edit then confirms or corrects the time.
 *
 * Checking in needs no permission: everyone with a login and an employee
 * record keeps their own attendance. Recording it for others stays behind
 * attendance.create (lib/hr/attendance.ts).
 */

/**
 * Checking in from the phone, and its morning/evening reminders — off while
 * the workshop has a single employee. Set to true to bring back the top-bar
 * pill and popups, the card on My work, the dashboard tile and the
 * scheduled reminders. Attendance recorded by a manager (HR → Attendance)
 * is not affected.
 */
export const SELF_CHECK_IN = false;

const positionSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(100_000),
  /** Checking in: when they left on the last day they didn't check out of (HH:MM). */
  previousLeftAt: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter the time you left, e.g. 19:30.')
    .optional()
    .or(z.literal('')),
  requestKey: z.string().optional(),
});

const reportSchema = z.object({
  leftAt: z
    .string({ error: 'Enter the time you left.' })
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter the time you left, e.g. 19:30.'),
  notes: z.string().trim().max(300, 'Keep the note under 300 characters.').optional(),
  requestKey: z.string().optional(),
});

const reviewSchema = z.object({
  clockOut: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter the time as HH:MM, e.g. 19:30.')
    .optional()
    .or(z.literal('')),
  notes: z.string().trim().max(300, 'Keep the note under 300 characters.').optional(),
  requestKey: z.string().optional(),
});

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

const recordSelect = {
  id: true,
  attendanceDate: true,
  clockInAt: true,
  clockOutAt: true,
  status: true,
  notes: true,
  clockInMethod: true,
  clockOutMethod: true,
  clockInDistanceM: true,
  clockOutDistanceM: true,
  needsReview: true,
} satisfies Prisma.AttendanceSelect;

/** The signed-in person's employee record, or null if their login has none. */
export async function findMyEmployee(user: AuthenticatedUser) {
  return prisma.employee.findFirst({
    where: { organizationId: user.organizationId, userId: user.id, isActive: true },
    select: { id: true, branchId: true, firstName: true, lastName: true, employeeCode: true, jobTitle: true },
  });
}

async function requireMyEmployee(user: AuthenticatedUser) {
  const employee = await findMyEmployee(user);
  if (!employee) {
    throw new DomainError(
      'Your login isn’t linked to an employee record, so there is no attendance to keep. Ask the workshop owner to link it.',
    );
  }
  return employee;
}

/** A shift end on a given day, never before the person arrived. */
function closingTime(dateKey: string, shiftEndTime: string, clockInAt: Date) {
  const shiftEnd = dubaiTimeOn(dateKey, shiftEndTime);
  return shiftEnd.getTime() > clockInAt.getTime() ? shiftEnd : clockInAt;
}

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * Everything the "My work" check-in card needs: today's record, the lock it
 * will be measured against, and any earlier day still open.
 */
export async function getMyDay(user: AuthenticatedUser) {
  const employee = await findMyEmployee(user);
  if (!employee) return null;
  const todayKey = localDateString();
  const today = parseCalendarDate(todayKey)!;

  const [location, record, openEarlier, awaitingReview] = await Promise.all([
    getBranchLocation(user.organizationId, employee.branchId),
    prisma.attendance.findUnique({
      where: { employeeId_attendanceDate: { employeeId: employee.id, attendanceDate: today } },
      select: recordSelect,
    }),
    prisma.attendance.findFirst({
      where: {
        organizationId: user.organizationId,
        employeeId: employee.id,
        attendanceDate: { lt: today },
        clockInAt: { not: null },
        clockOutAt: null,
      },
      orderBy: { attendanceDate: 'desc' },
      select: recordSelect,
    }),
    prisma.attendance.count({
      where: { organizationId: user.organizationId, employeeId: employee.id, needsReview: true },
    }),
  ]);

  const shiftEnd = location ? dubaiTimeOn(todayKey, location.shiftEndTime) : null;
  const next: 'IN' | 'OUT' | 'DONE' = !record?.clockInAt ? 'IN' : !record.clockOutAt ? 'OUT' : 'DONE';

  return {
    employee: { ...employee, name: `${employee.firstName} ${employee.lastName}` },
    date: todayKey,
    record,
    next,
    // Employees see their normal hours; overtime is for whoever manages attendance.
    workedLabel: record
      ? formatWorked(
          location ? (splitWorked(record, location.shiftEndTime)?.normal ?? null) : minutesWorked(record),
        )
      : '—',
    fence: location?.fence ?? null,
    shiftEndTime: location?.shiftEndTime ?? null,
    /** Still checked in after the shift ended: remind them before they go. */
    pastShiftEnd: next === 'OUT' && shiftEnd !== null && Date.now() > shiftEnd.getTime(),
    /** An earlier day with a check-in and no check-out. */
    openEarlier: openEarlier
      ? {
          id: openEarlier.id,
          date: dayKey(openEarlier.attendanceDate),
          clockInAt: openEarlier.clockInAt!,
          willCloseAt: closingTime(
            dayKey(openEarlier.attendanceDate),
            location?.shiftEndTime ?? '20:00',
            openEarlier.clockInAt!,
          ),
        }
      : null,
    awaitingReview,
  };
}

export type MyDay = NonNullable<Awaited<ReturnType<typeof getMyDay>>>;

// ─── Writing ────────────────────────────────────────────────────────────────

/** Measures the phone against the lock, or explains in plain words why not. */
function measure(
  location: Awaited<ReturnType<typeof getBranchLocation>>,
  position: { latitude: number; longitude: number; accuracy: number },
  direction: 'IN' | 'OUT',
) {
  if (!location?.fence) {
    throw new DomainError(
      'The workshop’s location hasn’t been set yet, so checking in from a phone is switched off. Ask the owner to set it in Settings.',
    );
  }
  const check = checkFence(position, location.fence);
  if (check.ok) return check.distanceM;
  if (check.reason === 'imprecise') {
    throw new DomainError(
      `Your phone can only place you within ${formatDistance(position.accuracy)} right now (it needs to be within ${MAX_ACCURACY_M} m). Turn on precise location, step near a window or outside, and try again.`,
    );
  }
  throw new DomainError(
    `You are ${formatDistance(check.distanceM)} from the workshop. You can only check ${direction === 'IN' ? 'in' : 'out'} within ${formatDistance(location.fence.radiusM)} of it.`,
  );
}

/**
 * Checks the signed-in employee in or out at the workshop. Checking in also
 * closes any earlier day they forgot to check out of.
 */
export async function selfClock(user: AuthenticatedUser, direction: 'IN' | 'OUT', rawInput: unknown) {
  const input = parseInput(positionSchema, rawInput);
  const employee = await requireMyEmployee(user);
  const location = await getBranchLocation(user.organizationId, employee.branchId);
  const distance = measure(location, input, direction);
  const todayKey = localDateString();
  const today = parseCalendarDate(todayKey)!;
  const now = new Date();
  const where = {
    latitude: input.latitude.toFixed(6),
    longitude: input.longitude.toFixed(6),
    accuracy: Math.round(input.accuracy),
    distance,
  };

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, `attendance.self_${direction.toLowerCase()}`);
    const existing = await tx.attendance.findUnique({
      where: { employeeId_attendanceDate: { employeeId: employee.id, attendanceDate: today } },
      select: recordSelect,
    });

    if (direction === 'IN') {
      if (existing?.clockInAt) {
        throw new DomainError(`You already checked in today at ${formatTime(existing.clockInAt)}.`);
      }
      const closed = await closeForgottenDays(
        tx,
        user,
        employee,
        location!.shiftEndTime,
        today,
        input.previousLeftAt || undefined,
      );
      const record = await tx.attendance.upsert({
        where: { employeeId_attendanceDate: { employeeId: employee.id, attendanceDate: today } },
        update: {
          clockInAt: now,
          status: 'PRESENT',
          clockInMethod: 'SELF',
          clockInLatitude: where.latitude,
          clockInLongitude: where.longitude,
          clockInAccuracyM: where.accuracy,
          clockInDistanceM: where.distance,
        },
        create: {
          organizationId: user.organizationId,
          branchId: employee.branchId,
          employeeId: employee.id,
          attendanceDate: today,
          clockInAt: now,
          status: 'PRESENT',
          clockInMethod: 'SELF',
          clockInLatitude: where.latitude,
          clockInLongitude: where.longitude,
          clockInAccuracyM: where.accuracy,
          clockInDistanceM: where.distance,
        },
        select: recordSelect,
      });
      await writeAuditLog(tx, {
        organizationId: user.organizationId,
        branchId: employee.branchId,
        actorUserId: user.id,
        action: 'attendance.self_clocked_in',
        entityType: 'Attendance',
        entityId: record.id,
        afterData: { employeeId: employee.id, date: todayKey, clockInAt: now.toISOString(), ...where },
      });
      await settleRequestKey(tx, user, rawInput, record.id);
      return { record, closed };
    }

    if (!existing?.clockInAt) throw new DomainError('You haven’t checked in today.');
    if (existing.clockOutAt) {
      throw new DomainError(`You already checked out today at ${formatTime(existing.clockOutAt)}.`);
    }
    const record = await tx.attendance.update({
      where: { id: existing.id },
      data: {
        clockOutAt: now,
        clockOutMethod: 'SELF',
        clockOutLatitude: where.latitude,
        clockOutLongitude: where.longitude,
        clockOutAccuracyM: where.accuracy,
        clockOutDistanceM: where.distance,
      },
      select: recordSelect,
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: employee.branchId,
      actorUserId: user.id,
      action: 'attendance.self_clocked_out',
      entityType: 'Attendance',
      entityId: record.id,
      beforeData: { clockOutAt: null },
      afterData: {
        employeeId: employee.id,
        date: todayKey,
        clockOutAt: now.toISOString(),
        minutes: minutesWorked(record),
        ...where,
      },
    });
    // The day's overtime, suggested for a manager to approve.
    await suggestOvertimeForDay(tx, user.organizationId, record.id);
    await settleRequestKey(tx, user, rawInput, record.id);
    return { record, closed: [] as string[] };
  });
}

/**
 * Closes earlier days left open. The most recent one is closed at the time
 * the employee says they left — checking in asks for it, and refuses without
 * it. Any older ones (rare: several days missed) close at the shift end.
 * All are flagged for review.
 */
async function closeForgottenDays(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  employee: { id: string; branchId: string },
  shiftEndTime: string,
  before: Date,
  previousLeftAt?: string,
) {
  const open = await tx.attendance.findMany({
    where: {
      organizationId: user.organizationId,
      employeeId: employee.id,
      attendanceDate: { lt: before },
      clockInAt: { not: null },
      clockOutAt: null,
    },
    select: { id: true, attendanceDate: true, clockInAt: true, notes: true },
    orderBy: { attendanceDate: 'desc' },
  });
  const closed: string[] = [];
  for (const [index, day] of open.entries()) {
    const key = dayKey(day.attendanceDate);
    const reported = index === 0;
    let at: Date;
    if (reported) {
      if (!previousLeftAt) {
        throw new DomainError(
          `You didn't check out on ${key} (in at ${formatTime(day.clockInAt!)}). Enter the time you left, then check in.`,
          'previousLeftAt',
        );
      }
      at = dubaiTimeOn(key, previousLeftAt);
      if (at.getTime() <= day.clockInAt!.getTime()) {
        throw new DomainError(
          `You checked in at ${formatTime(day.clockInAt!)} that day — the time you left must be after that.`,
          'previousLeftAt',
        );
      }
    } else {
      at = closingTime(key, shiftEndTime, day.clockInAt!);
    }
    await tx.attendance.update({
      where: { id: day.id },
      data: {
        clockOutAt: at,
        clockOutMethod: reported ? 'REPORTED' : 'AUTO',
        needsReview: true,
        notes:
          day.notes ??
          (reported
            ? `Forgot to check out — said they left at ${previousLeftAt}.`
            : `No check-out — closed at the shift end (${shiftEndTime}).`),
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: employee.branchId,
      actorUserId: user.id,
      action: reported ? 'attendance.leaving_reported' : 'attendance.auto_closed',
      entityType: 'Attendance',
      entityId: day.id,
      beforeData: { clockOutAt: null },
      afterData: { employeeId: employee.id, date: key, clockOutAt: at.toISOString(), needsReview: true },
    });
    closed.push(key);
  }
  return closed;
}

/**
 * "I forgot to check out — I left at 19:30." For one of the employee's own
 * open days (today included, for someone who has already gone home). No
 * location check: the point is that they are no longer at the workshop.
 */
export async function reportLeftAt(user: AuthenticatedUser, attendanceId: string, rawInput: unknown) {
  const input = parseInput(reportSchema, rawInput);
  const employee = await requireMyEmployee(user);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'attendance.self_report');
    const day = await tx.attendance.findFirst({
      where: { id: attendanceId, organizationId: user.organizationId, employeeId: employee.id },
      select: { id: true, attendanceDate: true, clockInAt: true, clockOutAt: true, clockOutMethod: true },
    });
    if (!day) throw new NotFoundError('day');
    if (!day.clockInAt) throw new DomainError('There is no check-in on that day.');
    // An automatic or self-reported time can still be put right; a real one can't.
    if (day.clockOutAt && day.clockOutMethod !== 'AUTO' && day.clockOutMethod !== 'REPORTED') {
      throw new DomainError(`That day already has a check-out at ${formatTime(day.clockOutAt)}.`);
    }
    const key = dayKey(day.attendanceDate);
    const at = dubaiTimeOn(key, input.leftAt);
    if (at.getTime() <= day.clockInAt.getTime()) {
      throw new DomainError(`You checked in at ${formatTime(day.clockInAt)} — the time you left must be after that.`, 'leftAt');
    }
    if (at.getTime() > Date.now()) throw new DomainError('That time hasn’t happened yet.', 'leftAt');

    const record = await tx.attendance.update({
      where: { id: day.id },
      data: {
        clockOutAt: at,
        clockOutMethod: 'REPORTED',
        needsReview: true,
        reviewedAt: null,
        reviewedByUserId: null,
        notes: emptyToNull(input.notes) ?? `Forgot to check out — reported leaving at ${input.leftAt}.`,
      },
      select: recordSelect,
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: employee.branchId,
      actorUserId: user.id,
      action: 'attendance.leaving_reported',
      entityType: 'Attendance',
      entityId: day.id,
      beforeData: { clockOutAt: day.clockOutAt?.toISOString() ?? null, method: day.clockOutMethod },
      afterData: { employeeId: employee.id, date: key, clockOutAt: at.toISOString(), needsReview: true },
    });
    await settleRequestKey(tx, user, rawInput, record.id);
    return record;
  });
}

// ─── Review (attendance.edit) ───────────────────────────────────────────────

/**
 * Days that need a person to look at them: closed automatically, reported
 * afterwards, or still open from an earlier day. Newest first.
 */
export async function listAttendanceToReview(user: AuthenticatedUser) {
  requirePermission(user, 'attendance.edit');
  const today = parseCalendarDate(localDateString())!;
  const branch = user.primaryBranchId ? { branchId: user.primaryBranchId } : {};
  const rows = await prisma.attendance.findMany({
    where: {
      organizationId: user.organizationId,
      ...branch,
      OR: [
        { needsReview: true },
        { attendanceDate: { lt: today }, clockInAt: { not: null }, clockOutAt: null },
      ],
    },
    orderBy: [{ attendanceDate: 'desc' }],
    take: 100,
    select: {
      ...recordSelect,
      employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
      branch: { select: { shiftEndTime: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    date: dayKey(row.attendanceDate),
    employee: { id: row.employee.id, name: `${row.employee.firstName} ${row.employee.lastName}`, code: row.employee.employeeCode },
    clockInAt: row.clockInAt,
    clockOutAt: row.clockOutAt,
    clockOutMethod: row.clockOutMethod,
    notes: row.notes,
    shiftEndTime: row.branch.shiftEndTime,
    workedLabel: formatWorked(minutesWorked(row)),
    /** Still open: nobody has closed it yet, not even automatically. */
    open: row.clockOutAt === null,
  }));
}

export type AttendanceToReview = Awaited<ReturnType<typeof listAttendanceToReview>>[number];

/**
 * Confirms a flagged day as it stands, or sets the check-out time it should
 * have had. An open day must be given a time.
 */
export async function reviewAttendance(user: AuthenticatedUser, attendanceId: string, rawInput: unknown) {
  const input = parseInput(reviewSchema, rawInput);
  requirePermission(user, 'attendance.edit');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'attendance.review');
    const day = await tx.attendance.findFirst({
      where: {
        id: attendanceId,
        organizationId: user.organizationId,
        ...(user.primaryBranchId ? { branchId: user.primaryBranchId } : {}),
      },
      select: { id: true, branchId: true, employeeId: true, attendanceDate: true, clockInAt: true, clockOutAt: true, clockOutMethod: true, notes: true },
    });
    if (!day) throw new NotFoundError('day');
    const key = dayKey(day.attendanceDate);

    let clockOutAt = day.clockOutAt;
    if (input.clockOut) {
      clockOutAt = dubaiTimeOn(key, input.clockOut);
      if (day.clockInAt && clockOutAt.getTime() <= day.clockInAt.getTime()) {
        throw new DomainError(`They checked in at ${formatTime(day.clockInAt)} — the check-out must be after that.`, 'clockOut');
      }
      if (clockOutAt.getTime() > Date.now()) throw new DomainError('That time hasn’t happened yet.', 'clockOut');
    }
    if (day.clockInAt && !clockOutAt) {
      throw new DomainError('Enter the time they left — this day has no check-out yet.', 'clockOut');
    }
    const changed = clockOutAt?.getTime() !== day.clockOutAt?.getTime();

    await tx.attendance.update({
      where: { id: day.id },
      data: {
        clockOutAt,
        ...(changed ? { clockOutMethod: 'STAFF' as const } : {}),
        needsReview: false,
        reviewedAt: new Date(),
        reviewedByUserId: user.id,
        notes: emptyToNull(input.notes) ?? day.notes,
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: day.branchId,
      actorUserId: user.id,
      action: changed ? 'attendance.corrected' : 'attendance.confirmed',
      entityType: 'Attendance',
      entityId: day.id,
      beforeData: { clockOutAt: day.clockOutAt?.toISOString() ?? null, method: day.clockOutMethod },
      afterData: { employeeId: day.employeeId, date: key, clockOutAt: clockOutAt?.toISOString() ?? null },
    });
    await settleRequestKey(tx, user, rawInput, day.id);
    return { id: day.id };
  });
}
