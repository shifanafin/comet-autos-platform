/**
 * Integration tests for attendance.
 *
 * The rules that matter: one record per employee per day, a day that cannot
 * run backwards, and a technician's repeated tap on a patchy connection
 * never producing two records or quietly moving their clock-in time.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { localDateString, toLocalDateTimeInput } from '@/lib/format';
import {
  clockIn,
  clockOut,
  formatWorked,
  getAttendanceDay,
  getEmployeeAttendance,
  markAttendance,
  minutesWorked,
} from '@/lib/hr/attendance';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let b: TestOrg;
let tech: string;
let mate: string;

const today = () => localDateString();
/** A past calendar date, so corrections can be tested without waiting. */
const daysAgo = (n: number) => localDateString(new Date(Date.now() - n * 86_400_000));
/** A datetime-local string n hours before now. */
const hoursAgo = (n: number) => toLocalDateTimeInput(new Date(Date.now() - n * 3_600_000));

before(async () => {
  a = await createTestOrg('AttA');
  b = await createTestOrg('AttB');
  [tech, mate] = a.technicianIds;
});

after(async () => {
  await prisma.$disconnect();
});

describe('the day', () => {
  test('the roster lists the whole team, with nothing recorded yet', async () => {
    const day = await getAttendanceDay(a.owner);
    assert.equal(day.date, today());
    assert.equal(day.isToday, true);
    assert.ok(day.totals.team >= 2, 'the test workshop has technicians');
    assert.equal(day.totals.recorded, 0);
    assert.ok(day.rows.every((row) => row.record === null));
    assert.ok(day.rows.every((row) => row.next === 'IN'), 'everyone starts needing a clock-in');
    assert.ok(day.rows.every((row) => row.workedLabel === '—'));
  });

  test('a future date is refused', async () => {
    const tomorrow = localDateString(new Date(Date.now() + 86_400_000));
    await expectDomainError(getAttendanceDay(a.owner, tomorrow), /future date/i);
    await expectDomainError(
      clockIn(a.owner, tech, { date: tomorrow, requestKey: `att-future-${RUN}` }),
      /future date/i,
    );
    await expectDomainError(getAttendanceDay(a.owner, 'not-a-date'), /valid date/i);
  });
});

describe('clocking in and out', () => {
  test('clocking in starts the day and marks the person present', async () => {
    const record = await clockIn(a.owner, tech, { requestKey: `att-in-${RUN}` });
    assert.ok(record.clockInAt, 'the time is stamped');
    assert.equal(record.clockOutAt, null);
    assert.equal(record.status, 'PRESENT');

    const day = await getAttendanceDay(a.owner);
    const row = day.rows.find((r) => r.employee.id === tech);
    assert.equal(row?.next, 'OUT', 'the one button now says clock out');
    assert.equal(row?.workedLabel, '—', 'no hours until the day is closed');
    assert.equal(day.totals.stillIn, 1);
    assert.equal(day.totals.present, 1);
    assert.equal(day.totals.recorded, 1);

    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: record.id, action: 'attendance.clocked_in' },
      }),
      'the stamp is audited',
    );
  });

  test('a second tap does not move the time, and never makes a second row', async () => {
    const first = await prisma.attendance.findFirstOrThrow({
      where: { employeeId: tech },
      select: { id: true, clockInAt: true },
    });
    await expectDomainError(
      clockIn(a.owner, tech, { requestKey: `att-in-again-${RUN}` }),
      /already clocked in/i,
    );
    const after = await prisma.attendance.findMany({ where: { employeeId: tech } });
    assert.equal(after.length, 1, 'still one row for the day');
    assert.equal(
      after[0].clockInAt?.getTime(),
      first.clockInAt?.getTime(),
      'and the original time is untouched',
    );
  });

  test('clocking out closes the day and the hours follow from the stamps', async () => {
    // Re-stamp the clock-in to a known time so the total is checkable.
    await prisma.attendance.updateMany({
      where: { employeeId: tech },
      data: { clockInAt: new Date(Date.now() - 8 * 3_600_000 - 30 * 60_000) },
    });
    const record = await clockOut(a.owner, tech, { requestKey: `att-out-${RUN}` });
    assert.ok(record.clockOutAt);

    const day = await getAttendanceDay(a.owner);
    const row = day.rows.find((r) => r.employee.id === tech);
    assert.equal(row?.next, 'DONE');
    assert.equal(row?.workedLabel, '8h 30m');
    assert.equal(day.totals.stillIn, 0);
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: record.id, action: 'attendance.clocked_out' },
      }),
    );
  });

  test('a day cannot run backwards, or be closed twice', async () => {
    await expectDomainError(
      clockOut(a.owner, tech, { requestKey: `att-out-again-${RUN}` }),
      /already clocked out/i,
    );
    await expectDomainError(
      clockOut(a.owner, mate, { requestKey: `att-out-first-${RUN}` }),
      /has not clocked in/i,
    );

    // Clock the mate in an hour ago, then try to close the day before that.
    await clockIn(a.owner, mate, { at: hoursAgo(1), requestKey: `att-in-mate-${RUN}` });
    await expectDomainError(
      clockOut(a.owner, mate, { at: hoursAgo(3), requestKey: `att-out-early-${RUN}` }),
      /before the clock-in/i,
    );
    await expectDomainError(
      clockIn(a.owner, mate, {
        date: daysAgo(1),
        at: toLocalDateTimeInput(new Date(Date.now() + 3 * 86_400_000)),
        requestKey: `att-in-futuretime-${RUN}`,
      }),
      /can’t be in the future/i,
    );
  });

  test('the same submission twice records once', async () => {
    const input = { date: daysAgo(3), at: hoursAgo(72), requestKey: `att-double-${RUN}` };
    const results = await Promise.allSettled([
      clockIn(a.owner, tech, input),
      clockIn(a.owner, tech, input),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      await prisma.attendance.count({
        where: { employeeId: tech, attendanceDate: new Date(`${daysAgo(3)}T00:00:00Z`) },
      }),
      1,
    );
  });

  test('exact arithmetic: a minute is a minute', () => {
    const at = (iso: string) => new Date(iso);
    assert.equal(
      minutesWorked({ clockInAt: at('2026-09-22T05:00:00Z'), clockOutAt: at('2026-09-22T13:45:00Z') }),
      525,
    );
    assert.equal(formatWorked(525), '8h 45m');
    assert.equal(formatWorked(5), '0h 05m');
    assert.equal(minutesWorked({ clockInAt: at('2026-09-22T05:00:00Z'), clockOutAt: null }), null);
    assert.equal(formatWorked(null), '—');
  });
});

describe('recording a day directly', () => {
  test('absent, on leave and holiday are recorded with a reason', async () => {
    const record = await markAttendance(a.owner, mate, {
      status: 'ABSENT',
      date: daysAgo(2),
      notes: 'Called in sick',
      requestKey: `att-absent-${RUN}`,
    });
    assert.equal(record.status, 'ABSENT');
    assert.equal(record.notes, 'Called in sick');

    const day = await getAttendanceDay(a.owner, daysAgo(2));
    assert.equal(day.totals.absent, 1);
    assert.equal(day.isToday, false);
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: record.id, action: 'attendance.marked' },
      }),
    );
  });

  test('a day someone was not here has no hours on it', async () => {
    // The mate is clocked in today; marking them on leave clears the stamps.
    const before = await prisma.attendance.findFirstOrThrow({
      where: { employeeId: mate, attendanceDate: new Date(`${today()}T00:00:00Z`) },
      select: { clockInAt: true },
    });
    assert.ok(before.clockInAt, 'they were clocked in');

    const record = await markAttendance(a.owner, mate, {
      status: 'ON_LEAVE',
      notes: 'Annual leave',
      requestKey: `att-leave-${RUN}`,
    });
    assert.equal(record.status, 'ON_LEAVE');
    assert.equal(record.clockInAt, null, 'the stamps are cleared');
    assert.equal(record.clockOutAt, null);

    const day = await getAttendanceDay(a.owner);
    const row = day.rows.find((r) => r.employee.id === mate);
    assert.equal(row?.workedLabel, '—');
    assert.equal(day.totals.onLeave, 1);
  });

  test('a correction back to present keeps one row for the day', async () => {
    await markAttendance(a.owner, mate, {
      status: 'PRESENT',
      notes: 'Came in after all',
      requestKey: `att-correct-${RUN}`,
    });
    const rows = await prisma.attendance.count({
      where: { employeeId: mate, attendanceDate: new Date(`${today()}T00:00:00Z`) },
    });
    assert.equal(rows, 1, 'corrected, not duplicated');
    const audits = await prisma.auditLog.count({
      where: { entityType: 'Attendance', action: 'attendance.marked' },
    });
    assert.ok(audits >= 2, 'and every correction is on record');
  });

  test('an unknown status is refused', async () => {
    await expectDomainError(
      markAttendance(a.owner, mate, { status: 'SLEEPING', requestKey: `att-bad-${RUN}` }),
      /what to record/i,
    );
  });
});

describe('the month', () => {
  test('one employee’s month totals what was recorded', async () => {
    const month = await getEmployeeAttendance(a.owner, tech);
    assert.equal(month.month, today().slice(0, 7));
    assert.ok(month.days.length >= 1);
    assert.ok(month.totals.minutes >= 510, 'the 8h 30m day is counted');
    assert.equal(month.employee.id, tech);
    assert.ok(month.days.every((day) => typeof day.workedLabel === 'string'));

    await expectDomainError(
      getEmployeeAttendance(a.owner, tech, '2026-13'),
      /valid month/i,
    );
  });
});

describe('security', () => {
  test('reading needs payroll.view; recording needs payroll.create', async () => {
    await assert.rejects(getAttendanceDay(a.viewer), (e: unknown) => e instanceof AuthError);
    await assert.rejects(
      getEmployeeAttendance(a.viewer, tech),
      (e: unknown) => e instanceof AuthError,
    );

    // Someone who may see the team but not record against it.
    const readOnly = { ...a.owner, orgWidePermissions: new Set(['payroll.view']) };
    assert.ok(await getAttendanceDay(readOnly));
    for (const call of [
      () => clockIn(readOnly, tech, { date: daysAgo(5), requestKey: `att-noperm-in-${RUN}` }),
      () => clockOut(readOnly, tech, { date: daysAgo(5), requestKey: `att-noperm-out-${RUN}` }),
      () =>
        markAttendance(readOnly, tech, {
          status: 'ABSENT',
          date: daysAgo(5),
          requestKey: `att-noperm-mark-${RUN}`,
        }),
    ]) {
      await assert.rejects(call(), (e: unknown) => e instanceof AuthError);
    }
  });

  test('one workshop cannot see or record another’s team', async () => {
    await assert.rejects(
      getEmployeeAttendance(b.owner, tech),
      (e: unknown) => e instanceof NotFoundError,
      'another workshop gets "not found", never the employee',
    );
    for (const call of [
      () => clockIn(b.owner, tech, { date: daysAgo(4), requestKey: `att-crossorg-in-${RUN}` }),
      () =>
        markAttendance(b.owner, tech, {
          status: 'ABSENT',
          date: daysAgo(4),
          requestKey: `att-crossorg-mark-${RUN}`,
        }),
    ]) {
      await assert.rejects(call(), (e: unknown) => e instanceof NotFoundError);
    }

    const theirs = await getAttendanceDay(b.owner);
    assert.ok(
      !theirs.rows.some((row) => row.employee.id === tech),
      'and nobody of ours appears on their roster',
    );
  });

  test('a branch-scoped user only sees and records their own branch', async () => {
    const otherBranch = await prisma.branch.create({
      data: { organizationId: a.organizationId, code: `AT${RUN.slice(-3)}`, name: 'Second bay' },
      select: { id: true },
    });
    const elsewhere = { ...a.owner, primaryBranchId: otherBranch.id };

    const day = await getAttendanceDay(elsewhere);
    assert.equal(day.totals.team, 0, 'another branch’s team is not theirs to see');
    await assert.rejects(
      clockIn(elsewhere, tech, { date: daysAgo(6), requestKey: `att-crossbranch-${RUN}` }),
      (e: unknown) => e instanceof NotFoundError,
    );
    await assert.rejects(
      getEmployeeAttendance(elsewhere, tech),
      (e: unknown) => e instanceof NotFoundError,
    );
  });

  test('an inactive employee cannot be clocked in', async () => {
    const leaver = await prisma.employee.create({
      data: {
        organizationId: a.organizationId,
        branchId: a.branchId,
        employeeCode: `LEFT-${RUN}`,
        firstName: 'Former',
        lastName: 'Staff',
        hireDate: new Date('2024-01-01T00:00:00Z'),
        isActive: false,
      },
      select: { id: true },
    });
    await expectDomainError(
      clockIn(a.owner, leaver.id, { requestKey: `att-inactive-${RUN}` }),
      /no longer active/i,
    );
    const day = await getAttendanceDay(a.owner);
    assert.ok(
      !day.rows.some((row) => row.employee.id === leaver.id),
      'and they are off the roster',
    );
  });
});
